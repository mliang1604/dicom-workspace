import { Orientation, type Vec3, type Volume, type VolumeGeometry } from '../dicom/types';
import { add, cross, dot, length, scale, sub } from '../dicom/vec3';

/**
 * Oblique multi-planar reslicing geometry.
 *
 * The volume texture stays in raw acquisition (index) space; these pure
 * functions derive, from a volume's {@link VolumeGeometry}, how to sample true
 * anatomical planes out of it. The key output is {@link planeToTex}: an affine
 * map from a pane's in-plane coordinates to 3D texture coordinates, shared by
 * the shader (forward) and the cursor probe (inverse) so the two never drift.
 *
 * Patient space is DICOM LPS: +x patient-left, +y posterior, +z superior.
 * Display conventions (chosen to match the historical axis-aligned views):
 *   - Axial    — x→right, y(anterior)→top,   slice walks +z (inferior→superior)
 *   - Coronal  — x→right, z(superior)→top,   slice walks +y (anterior→posterior)
 *   - Sagittal — y(anterior)→left, z(sup)→top, slice walks +x (right→left)
 */

/** Affine map from a pane's (u, v, slicePos) to 3D texture coordinates. */
export interface PlaneToTex {
  /** Texture-coord change per unit of the pane's horizontal axis (u, 0→1). */
  readonly dU: Vec3;
  /** Texture-coord change per unit of the pane's vertical axis (v, 0→1 top→bottom). */
  readonly dV: Vec3;
  /** Texture-coord change per unit of the through-plane position (slicePos, 0→1). */
  readonly dS: Vec3;
  /** Texture coordinate at u=v=slicePos=0. */
  readonly origin: Vec3;
}

/** Axis-aligned bounding box of the volume in patient (LPS) space, in mm. */
interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** A plane's placement in patient space: where u/v/slice run, in mm. */
interface PlaneBasis {
  readonly origin: Vec3;
  readonly axisU: Vec3;
  readonly axisV: Vec3;
  readonly axisS: Vec3;
}

/**
 * The volume's geometry, or an axis-aligned identity derived from its spacing
 * when none is recorded. The identity reproduces the legacy behaviour of
 * treating the acquisition axes as the patient axes.
 */
export function resolveGeometry(volume: Volume): VolumeGeometry {
  if (volume.geometry) return volume.geometry;
  const [sx, sy, sz] = volume.spacing;
  return { iStep: [sx, 0, 0], jStep: [0, sy, 0], kStep: [0, 0, sz], origin: [0, 0, 0] };
}

/** Affine plane→texture map for one orientation, shared by shader and probe. */
export function planeToTex(volume: Volume, orientation: Orientation): PlaneToTex {
  const geom = resolveGeometry(volume);
  const dims = volume.dims;
  const basis = planeBasis(orientation, patientBounds(geom, dims));

  const dU = perTexel(invMul(geom, basis.axisU), dims);
  const dV = perTexel(invMul(geom, basis.axisV), dims);
  const dS = perTexel(invMul(geom, basis.axisS), dims);
  // origin maps voxel-centre sampling: texcoord = (index + 0.5) / dim.
  const indexOrigin = invMul(geom, sub(basis.origin, geom.origin));
  const origin = perTexel(add(indexOrigin, [0.5, 0.5, 0.5]), dims);
  return { dU, dV, dS, origin };
}

/** Texture coordinate for a pane point: `origin + u·dU + v·dV + slicePos·dS`. */
export function texCoordAt(map: PlaneToTex, u: number, v: number, slicePos: number): Vec3 {
  return add(add(add(scale(map.dU, u), scale(map.dV, v)), scale(map.dS, slicePos)), map.origin);
}

/** A pane point recovered from a texture coordinate by inverting {@link texCoordAt}. */
export interface PlaneCoords {
  /** In-plane horizontal position (u, matching the shader's post-flip axis). */
  readonly u: number;
  /** In-plane vertical position (v, 0→1 top→bottom). */
  readonly v: number;
  /** Through-plane position (slicePos, 0→1). */
  readonly slicePos: number;
}

/**
 * Inverse of {@link texCoordAt}: solve `origin + u·dU + v·dV + slicePos·dS = coord`
 * for the pane coordinates `(u, v, slicePos)`. Used to project a known voxel back
 * onto each orientation's plane — the forward direction of the cursor probe — so
 * the linked crosshair lands on the same pixel the probe would sample.
 */
export function planeCoordsAt(map: PlaneToTex, coord: Vec3): PlaneCoords {
  // Invert the 3×3 [dU | dV | dS] via Cramer's rule, as in invMul above.
  const rhs = sub(coord, map.origin);
  const r0 = cross(map.dV, map.dS);
  const r1 = cross(map.dS, map.dU);
  const r2 = cross(map.dU, map.dV);
  const det = dot(map.dU, r0);
  const inv = det !== 0 ? 1 / det : 0;
  return { u: dot(r0, rhs) * inv, v: dot(r1, rhs) * inv, slicePos: dot(r2, rhs) * inv };
}

/** Column-major 4×4 of {@link planeToTex} for upload to the shader uniform. */
export function planeToTexMatrix(volume: Volume, orientation: Orientation): Float32Array {
  const { dU, dV, dS, origin } = planeToTex(volume, orientation);
  // texcoord = (M · vec4(u, v, slicePos, 1)).xyz, with M's columns being the
  // three deltas and the origin. WGSL reads mat4x4 column-major.
  // prettier-ignore
  return new Float32Array([
    dU[0], dU[1], dU[2], 0,
    dV[0], dV[1], dV[2], 0,
    dS[0], dS[1], dS[2], 0,
    origin[0], origin[1], origin[2], 1,
  ]);
}

/** The volume's patient-space (LPS) bounding box, plus its centre and radius. */
export interface VolumeBounds {
  /** Minimum corner of the axis-aligned box, in mm. */
  readonly min: Vec3;
  /** Maximum corner of the axis-aligned box, in mm. */
  readonly max: Vec3;
  /** Centre of the box, in mm — a natural orbit target for the 3D view. */
  readonly center: Vec3;
  /** Radius of the box's bounding sphere (half its diagonal), in mm. */
  readonly radius: number;
}

/** Patient-space bounding box of a volume, with centre and bounding radius. */
export function volumeBounds(volume: Volume): VolumeBounds {
  const { min, max } = patientBounds(resolveGeometry(volume), volume.dims);
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = 0.5 * length(sub(max, min));
  return { min, max, center, radius };
}

/**
 * View-direction parameter range `[tLo, tHi]` of a thick slab of `thicknessMm`,
 * centred on the volume centre and perpendicular to the orthographic view, for
 * the 3D raycaster. The camera is orthographic so every ray shares `forward` and
 * the slab is two parallel clip planes; a world point at ray parameter `t` has
 * view-depth `dot(eye − center, forward) + t` (since `forward` is unit and the
 * image-plane axes are perpendicular to it), so the slab `|depth| ≤ thickness/2`
 * is the t-interval returned here, the same parameter the shader marches in.
 *
 * A thickness covering the volume's full depth (`2·radius`, the diameter) yields
 * `[−∞, +∞]`, which leaves the box traversal unclipped — the default, exactly
 * reproducing the whole-volume projection.
 */
export function slabTRange(
  bounds: VolumeBounds,
  eye: Vec3,
  forward: Vec3,
  thicknessMm: number,
): [number, number] {
  if (!(thicknessMm < 2 * bounds.radius)) return [-Infinity, Infinity];
  const depth0 = dot(sub(eye, bounds.center), forward);
  const half = thicknessMm / 2;
  return [-half - depth0, half - depth0];
}

/**
 * Column-major 4×4 affine mapping a patient (LPS) point to 3D texture
 * coordinates `[0,1]^3`, the inverse of the index→patient geometry composed with
 * voxel-centre normalisation: `tex = (M⁻¹·(p − origin) + 0.5) / dims`. The 3D
 * MIP raycaster uses it to march world-space rays through the texture, mirroring
 * how {@link planeToTexMatrix} maps a plane into the same texture for the MPR
 * panes.
 */
export function patientToTexMatrix(volume: Volume): Float32Array {
  const geom = resolveGeometry(volume);
  const [d0, d1, d2] = volume.dims;
  // Rows of the inverse 3×3 (Cramer's rule), matching invMul above.
  const r0 = cross(geom.jStep, geom.kStep);
  const r1 = cross(geom.kStep, geom.iStep);
  const r2 = cross(geom.iStep, geom.jStep);
  const det = dot(geom.iStep, r0);
  const inv = det !== 0 ? 1 / det : 0;
  // a_c is the coefficient of the patient point for texture component c.
  const a0 = scale(r0, inv / d0);
  const a1 = scale(r1, inv / d1);
  const a2 = scale(r2, inv / d2);
  const b0 = 0.5 / d0 - dot(a0, geom.origin);
  const b1 = 0.5 / d1 - dot(a1, geom.origin);
  const b2 = 0.5 / d2 - dot(a2, geom.origin);
  // tex = (M · vec4(p, 1)).xyz; columns are p.x, p.y, p.z, 1. Column-major.
  // prettier-ignore
  return new Float32Array([
    a0[0], a1[0], a2[0], 0,
    a0[1], a1[1], a2[1], 0,
    a0[2], a1[2], a2[2], 0,
    b0,    b1,    b2,    1,
  ]);
}

/**
 * The four patient-space (LPS, mm) corners of an orientation's cut plane at a
 * given slice index, in rectangle order so they form a closed quad outline.
 *
 * The 3D pane projects these to draw where each MPR pane slices the volume, the
 * complement of {@link slabTRange}'s view-direction clip. The through-plane
 * position matches the shader's voxel-centre sampling `(sliceIndex + 0.5) /
 * count`, so the drawn rectangle sits exactly on the slice the MPR pane shows.
 */
export function slicePlaneCorners(
  volume: Volume,
  orientation: Orientation,
  sliceIndex: number,
): readonly [Vec3, Vec3, Vec3, Vec3] {
  const geom = resolveGeometry(volume);
  const basis = planeBasis(orientation, patientBounds(geom, volume.dims));
  const count = sliceCountFor(volume, orientation);
  const slicePos = count > 1 ? (sliceIndex + 0.5) / count : 0.5;
  const base = add(basis.origin, scale(basis.axisS, slicePos));
  const corner = (u: number, v: number): Vec3 =>
    add(add(base, scale(basis.axisU, u)), scale(basis.axisV, v));
  return [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
}

/** Physical width/height (mm) of an orientation's plane, for aspect-fit. */
export function planeExtentMm(volume: Volume, orientation: Orientation): [number, number] {
  const { min, max } = patientBounds(resolveGeometry(volume), volume.dims);
  const [lx, ly, lz] = sub(max, min);
  switch (orientation) {
    case Orientation.Axial:
      return [lx, ly];
    case Orientation.Coronal:
      return [lx, lz];
    case Orientation.Sagittal:
      return [ly, lz];
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

/** Number of output slices walking an orientation's through-plane patient axis. */
export function sliceCountFor(volume: Volume, orientation: Orientation): number {
  const [cx, cy, cz] = sliceCounts(volume);
  switch (orientation) {
    case Orientation.Axial:
      return cz;
    case Orientation.Coronal:
      return cy;
    case Orientation.Sagittal:
      return cx;
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

/** Output slice counts along patient x, y, z, sized to preserve resolution. */
function sliceCounts(volume: Volume): Vec3 {
  const geom = resolveGeometry(volume);
  const { min, max } = patientBounds(geom, volume.dims);
  const [lx, ly, lz] = sub(max, min);
  const [sx, sy, sz] = outputSpacing(geom);
  return [count(lx, sx), count(ly, sy), count(lz, sz)];
}

function count(extent: number, spacing: number): number {
  return Math.max(1, Math.round(extent / spacing));
}

/**
 * Output voxel spacing (mm) along each patient axis: the largest component any
 * source step contributes to that axis. For an axis-aligned acquisition this is
 * exactly the source spacing, so slice counts match the original series; for an
 * oblique one it samples a touch finer, which avoids dropping detail.
 */
function outputSpacing(geom: VolumeGeometry): Vec3 {
  const steps = [geom.iStep, geom.jStep, geom.kStep];
  const out: [number, number, number] = [1, 1, 1];
  for (let c = 0; c < 3; c++) {
    let best = 0;
    for (const step of steps) best = Math.max(best, Math.abs(step[c]));
    out[c] = best > 1e-6 ? best : 1;
  }
  return out;
}

/** Patient-space AABB of the volume, using full voxel coverage (±½ voxel). */
function patientBounds(geom: VolumeGeometry, dims: readonly [number, number, number]): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const i of [-0.5, dims[0] - 0.5]) {
    for (const j of [-0.5, dims[1] - 0.5]) {
      for (const k of [-0.5, dims[2] - 0.5]) {
        const p = add(
          add(add(geom.origin, scale(geom.iStep, i)), scale(geom.jStep, j)),
          scale(geom.kStep, k),
        );
        for (let c = 0; c < 3; c++) {
          if (p[c] < min[c]) min[c] = p[c];
          if (p[c] > max[c]) max[c] = p[c];
        }
      }
    }
  }
  return { min, max };
}

/** Where a plane's u/v/slice axes run in patient space, per display convention. */
function planeBasis(orientation: Orientation, bounds: Bounds): PlaneBasis {
  const { min, max } = bounds;
  const [lx, ly, lz] = sub(max, min);
  switch (orientation) {
    case Orientation.Axial:
      return {
        origin: [min[0], min[1], min[2]],
        axisU: [lx, 0, 0], // x → right
        axisV: [0, ly, 0], // y (anterior) → top
        axisS: [0, 0, lz], // walk +z
      };
    case Orientation.Coronal:
      return {
        origin: [min[0], min[1], max[2]],
        axisU: [lx, 0, 0], // x → right
        axisV: [0, 0, -lz], // z (superior) → top
        axisS: [0, ly, 0], // walk +y
      };
    case Orientation.Sagittal:
      return {
        origin: [min[0], min[1], max[2]],
        axisU: [0, ly, 0], // y (anterior) → left
        axisV: [0, 0, -lz], // z (superior) → top
        axisS: [lx, 0, 0], // walk +x
      };
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

/** Multiply the inverse of the geometry's 3×3 linear map by a patient vector. */
function invMul(geom: VolumeGeometry, v: Vec3): Vec3 {
  // For M = [iStep | jStep | kStep], the inverse rows are the cross products of
  // the opposite columns over the determinant (Cramer's rule).
  const r0 = cross(geom.jStep, geom.kStep);
  const r1 = cross(geom.kStep, geom.iStep);
  const r2 = cross(geom.iStep, geom.jStep);
  const det = dot(geom.iStep, r0);
  const inv = det !== 0 ? 1 / det : 0;
  return [dot(r0, v) * inv, dot(r1, v) * inv, dot(r2, v) * inv];
}

/** Convert a continuous voxel index vector to texture coords: `index / dim`. */
function perTexel(index: Vec3, dims: readonly [number, number, number]): Vec3 {
  return [index[0] / dims[0], index[1] / dims[1], index[2] / dims[2]];
}
