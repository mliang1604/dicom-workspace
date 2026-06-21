import type { Vec3 } from '../dicom/types';
import { cross, normalize, sub } from '../dicom/vec3';

/**
 * Loft a stack of planar ROI contours (RTSTRUCT axial loops, in patient mm) into
 * a closed triangle mesh, so the 3D pane can draw each structure as a
 * translucent shaded surface instead of a busy stack of wireframe rings.
 *
 * The loops are resampled to a common point count *by angle around each loop's
 * centroid*, which gives a consistent point correspondence between adjacent
 * slices (index i ↔ same direction) with no manual seam matching — good for the
 * roughly star-convex shapes RTSTRUCT organs/targets usually are. Adjacent
 * resampled loops are joined into a triangle band, and the first/last loops are
 * fanned into end caps so the surface is closed.
 *
 * Lofting ({@link loftContours}), per-face normal generation ({@link loftRoiMesh})
 * and the flat-shaded vertex interleave ({@link flattenSurfaceMeshes}) all live
 * here so the lighting/packing geometry sits in the unit-tested render layer
 * rather than the UI component. Pure geometry, exercised without a GPU.
 * Concavities and per-slice topology changes (holes, branches) are approximated
 * by the angular silhouette — fine for a translucent overlay; a marching-cubes
 * surface would be a separate effort.
 */

/** A triangle as three patient-space vertices. */
export type Triangle = readonly [Vec3, Vec3, Vec3];

/** A planar contour loop and its mean through-plane position, for ordering. */
interface PlacedLoop {
  readonly points: readonly Vec3[];
  readonly z: number;
}

function meanZ(points: readonly Vec3[]): number {
  let s = 0;
  for (const p of points) s += p[2];
  return s / points.length;
}

/** Centroid of a loop in its own plane (x, y); z is taken as the loop's mean z. */
function centroid(points: readonly Vec3[]): { cx: number; cy: number; cz: number } {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p[0];
    cy += p[1];
  }
  return { cx: cx / points.length, cy: cy / points.length, cz: meanZ(points) };
}

/**
 * The loop's boundary point along the ray from its centroid at `theta` (in the
 * x–y plane), i.e. the outermost edge crossing. Returns the centroid if the ray
 * somehow misses (degenerate loop), so sampling always yields a point.
 */
function boundaryAtAngle(
  points: readonly Vec3[],
  cx: number,
  cy: number,
  cz: number,
  theta: number,
): Vec3 {
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);
  let tMax = -1;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    // Solve c + t·d = a + s·e for t (ray param) and s (edge param ∈ [0,1]).
    const det = dx * -ey - -ex * dy;
    if (Math.abs(det) < 1e-9) continue;
    const rx = a[0] - cx;
    const ry = a[1] - cy;
    const t = (rx * -ey - -ex * ry) / det;
    const s = (dx * ry - dy * rx) / det;
    if (s >= 0 && s <= 1 && t > tMax) tMax = t;
  }
  if (tMax <= 0) return [cx, cy, cz];
  return [cx + tMax * dx, cy + tMax * dy, cz];
}

/** Resample a loop to `n` points evenly spaced by angle around its centroid. */
function resampleByAngle(points: readonly Vec3[], n: number): Vec3[] {
  const { cx, cy, cz } = centroid(points);
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    out.push(boundaryAtAngle(points, cx, cy, cz, (i / n) * 2 * Math.PI));
  }
  return out;
}

/** Triangulate a resampled loop as a fan from its centroid (an end cap). */
function cap(loop: readonly Vec3[]): Triangle[] {
  const { cx, cy, cz } = centroid(loop);
  const c: Vec3 = [cx, cy, cz];
  const tris: Triangle[] = [];
  for (let i = 0; i < loop.length; i++) {
    tris.push([c, loop[i], loop[(i + 1) % loop.length]]);
  }
  return tris;
}

/**
 * Loft contour loops into a closed surface mesh.
 *
 * @param loops    Planar contour loops in patient mm (each ≥ 3 points).
 * @param samples  Points each loop is resampled to (the band's circumference).
 * @param maxLoops Cap on the number of slices used; the stack is evenly
 *                 subsampled beyond this to bound the triangle count.
 */
export function loftContours(
  loops: readonly (readonly Vec3[])[],
  samples = 16,
  maxLoops = 40,
): Triangle[] {
  const placed: PlacedLoop[] = loops
    .filter((p) => p.length >= 3)
    .map((points) => ({ points, z: meanZ(points) }))
    .sort((a, b) => a.z - b.z);
  if (placed.length < 2) return [];

  // Evenly subsample the slice stack if it's deeper than maxLoops.
  let used = placed;
  if (placed.length > maxLoops) {
    const step = (placed.length - 1) / (maxLoops - 1);
    used = Array.from({ length: maxLoops }, (_, i) => placed[Math.round(i * step)]);
  }

  const rings = used.map((l) => resampleByAngle(l.points, samples));
  const tris: Triangle[] = [];
  for (let k = 0; k + 1 < rings.length; k++) {
    const a = rings[k];
    const b = rings[k + 1];
    for (let i = 0; i < samples; i++) {
      const j = (i + 1) % samples;
      tris.push([a[i], a[j], b[i]]);
      tris.push([a[j], b[j], b[i]]);
    }
  }
  // Close the ends so the translucent shell reads as a solid.
  tris.push(...cap(rings[0]), ...cap(rings[rings.length - 1]));
  return tris;
}

/** Floats per ROI-surface vertex once interleaved: position (3) + normal (3) + rgba (4). */
export const SURFACE_VERTEX_FLOATS = 10;

/**
 * One ROI's lofted 3D surface, flattened for fast per-frame drawing: triangle
 * vertex positions (9 floats each) and precomputed unit face normals (3 floats
 * each) in patient mm. Built once per structure set; projected/shaded each orbit
 * frame. Tagged with the structure set + ROI it came from so the UI can resolve
 * its visibility / colour / opacity.
 */
export interface RoiSurfaceMesh {
  readonly setIndex: number;
  readonly roiNumber: number;
  /** ROI display colour as [r, g, b] in 0–255, for shading. */
  readonly baseColor: readonly [number, number, number];
  /** Triangle vertices, 9 floats (3 × xyz) per triangle. */
  readonly positions: Float32Array;
  /** Unit face normals, 3 floats per triangle. */
  readonly normals: Float32Array;
  /** Number of triangles (positions.length / 9 = normals.length / 3). */
  readonly count: number;
}

/**
 * Loft an ROI's contour loops into a flattened triangle mesh with per-face
 * normals — the render-layer home for the surface geometry and its lighting
 * normals. Each triangle's flat normal is `normalize(cross(b − a, c − a))`,
 * matching the head-light shade in `surface-shader.ts`. Returns `null` when the
 * loops don't loft to a surface (fewer than two usable loops), so the caller can
 * skip empty ROIs.
 *
 * @param setIndex  Index of the owning structure set (for the stable ROI key).
 * @param roiNumber RTSTRUCT ROI Number within that set.
 * @param baseColor ROI display colour [r, g, b] in 0–255, used for shading.
 * @param loops     Planar contour loops in patient mm (each ≥ 3 points).
 * @param samples   Points each loop is resampled to (see {@link loftContours}).
 * @param maxLoops  Cap on the number of slices used (see {@link loftContours}).
 */
export function loftRoiMesh(
  setIndex: number,
  roiNumber: number,
  baseColor: readonly [number, number, number],
  loops: readonly (readonly Vec3[])[],
  samples = 16,
  maxLoops = 40,
): RoiSurfaceMesh | null {
  const triangles = loftContours(loops, samples, maxLoops);
  if (triangles.length === 0) return null;
  const count = triangles.length;
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 3);
  for (let t = 0; t < count; t++) {
    const [a, b, c] = triangles[t];
    const o = t * 9;
    positions[o] = a[0];
    positions[o + 1] = a[1];
    positions[o + 2] = a[2];
    positions[o + 3] = b[0];
    positions[o + 4] = b[1];
    positions[o + 5] = b[2];
    positions[o + 6] = c[0];
    positions[o + 7] = c[1];
    positions[o + 8] = c[2];
    const nrm = normalize(cross(sub(b, a), sub(c, a)));
    normals[t * 3] = nrm[0];
    normals[t * 3 + 1] = nrm[1];
    normals[t * 3 + 2] = nrm[2];
  }
  return { setIndex, roiNumber, baseColor, positions, normals, count };
}

/** A flattened mesh paired with the resolved RGBA it should be drawn in. */
export interface ColoredSurfaceMesh {
  readonly mesh: RoiSurfaceMesh;
  /** Linear RGBA in 0–1; alpha already folded with the base surface alpha. */
  readonly rgba: readonly [number, number, number, number];
}

/** The interleaved GPU vertex array plus each triangle's centroid, for one frame. */
export interface FlattenedSurface {
  /**
   * Interleaved vertex buffer: per vertex `pos3 + normal3 + rgba4`
   * ({@link SURFACE_VERTEX_FLOATS} floats), three vertices per triangle, in the
   * exact stride/order the surface shader's vertex layout expects.
   */
  readonly vertices: Float32Array;
  /** Triangle centroids (3 floats each), parallel to the triangle order, for depth sorting. */
  readonly centroids: Float32Array;
  /** Triangle count (vertices.length / (3 · stride) = centroids.length / 3). */
  readonly count: number;
}

/**
 * Flatten the visible ROI surface meshes into one interleaved triangle list — the
 * pure, GPU-free packing the surface pipeline draws. Each vertex carries its
 * triangle's position, the shared flat face normal, and the ROI's resolved RGBA,
 * laid out at {@link SURFACE_VERTEX_FLOATS}-float stride (`pos3 + normal3 +
 * rgba4`) so the shader's vertex attributes line up byte-for-byte. The parallel
 * per-triangle centroids feed the per-frame painter's-order depth sort.
 *
 * The component is left only choosing which ROIs are visible and what colour /
 * opacity each gets; the interleave and centroid maths live here where they can
 * be unit-tested without a device.
 */
export function flattenSurfaceMeshes(visible: readonly ColoredSurfaceMesh[]): FlattenedSurface {
  let total = 0;
  for (const { mesh } of visible) total += mesh.count;

  const vertices = new Float32Array(total * 3 * SURFACE_VERTEX_FLOATS);
  const centroids = new Float32Array(total * 3);
  let v = 0;
  let c = 0;
  for (const { mesh, rgba } of visible) {
    const [cr, cg, cb, alpha] = rgba;
    const pos = mesh.positions;
    const nrm = mesh.normals;
    for (let i = 0; i < mesh.count; i++) {
      const p = i * 9;
      const n = i * 3;
      const nx = nrm[n];
      const ny = nrm[n + 1];
      const nz = nrm[n + 2];
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let vtx = 0; vtx < 3; vtx++) {
        const o = p + vtx * 3;
        const px = pos[o];
        const py = pos[o + 1];
        const pz = pos[o + 2];
        vertices[v++] = px;
        vertices[v++] = py;
        vertices[v++] = pz;
        vertices[v++] = nx;
        vertices[v++] = ny;
        vertices[v++] = nz;
        vertices[v++] = cr;
        vertices[v++] = cg;
        vertices[v++] = cb;
        vertices[v++] = alpha;
        sx += px;
        sy += py;
        sz += pz;
      }
      centroids[c++] = sx / 3;
      centroids[c++] = sy / 3;
      centroids[c++] = sz / 3;
    }
  }
  return { vertices, centroids, count: total };
}
