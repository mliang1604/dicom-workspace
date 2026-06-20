import type { Vec3 } from '../dicom/types';

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
 * Pure geometry, unit-tested without a GPU. Concavities and per-slice topology
 * changes (holes, branches) are approximated by the angular silhouette — fine
 * for a translucent overlay; a marching-cubes surface would be a separate effort.
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
  samples = 24,
  maxLoops = 60,
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
