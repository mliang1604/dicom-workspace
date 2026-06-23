import { Orientation, type Vec3, type Volume, type VolumeGeometry } from '../dicom/types';
import { add, cross, dot, length, normalize, scale, sub } from '../dicom/vec3';

/**
 * Patient-space plane geometry: the bounding box, per-orientation bases, slice
 * counts, and the index↔patient↔texture linear maps that the reslice builds on.
 *
 * Everything here derives from a volume's {@link VolumeGeometry} alone and has no
 * dependency on the reslice's plane→texture mapping, so it forms the leaf layer
 * the rest of `reslice.ts` (and its callers) sample anatomical planes through.
 */

/** Axis-aligned bounding box of the volume in patient (LPS) space, in mm. */
interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** A plane's placement in patient space: where u/v/slice run, in mm. */
export interface PlaneBasis {
  readonly origin: Vec3;
  readonly axisU: Vec3;
  readonly axisV: Vec3;
  readonly axisS: Vec3;
}

/**
 * An oblique tilt of a pane's plane away from its orthogonal anatomical default,
 * as two rotations applied about the plane's *own* in-plane axes (so the tilt is
 * intrinsic to the pane and survives pan/zoom/scroll):
 *   - `tiltU` (radians) rotates about the in-plane horizontal axis (u) — a
 *     pitch that swings the plane's top/bottom out of plane (single oblique);
 *   - `tiltV` (radians) rotates about the in-plane vertical axis (v) — a yaw
 *     that swings its left/right out of plane (the second, double-oblique, axis).
 * `{ tiltU: 0, tiltV: 0 }` (see {@link NO_OBLIQUE}) is the orthogonal default and
 * reproduces the axis-aligned views exactly.
 */
export interface ObliqueRotation {
  readonly tiltU: number;
  readonly tiltV: number;
}

/** The orthogonal (untilted) default: both oblique angles zero. */
export const NO_OBLIQUE: ObliqueRotation = { tiltU: 0, tiltV: 0 };

/** Whether a rotation actually tilts the plane (a non-zero angle on either axis). */
export function isOblique(rotation: ObliqueRotation | undefined): rotation is ObliqueRotation {
  return !!rotation && (rotation.tiltU !== 0 || rotation.tiltV !== 0);
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

/**
 * Unit patient-space (LPS) directions of an orientation's pane axes: where the
 * pane's +u (rightward) and +v (downward, top→bottom) screen axes point in
 * patient space. Shares {@link planeBasis} with the reslice, so the on-screen
 * orientation labels can never drift from the planes the shader samples. The
 * display convention is axis-aligned and volume-independent, so a unit box gives
 * the directions; only their signs matter.
 */
export function planeAxisDirs(orientation: Orientation): { right: Vec3; down: Vec3 } {
  const basis = planeBasis(orientation, { min: [0, 0, 0], max: [1, 1, 1] });
  return { right: normalize(basis.axisU), down: normalize(basis.axisV) };
}

/**
 * In-plane pixel dimensions `[nu, nv]` of an orientation's resliced slice: how
 * many resampled samples span the pane's horizontal (u) and vertical (v) axes.
 * These are the through-plane slice counts of the two *other* orientations,
 * since each orientation's in-plane axes are the through-plane axes of the other
 * two (axial's u=x is sagittal's walk, its v=y is coronal's walk, etc.). Used to
 * iterate the slice's voxel grid for ROI statistics at the displayed resolution.
 */
export function planePixelDims(volume: Volume, orientation: Orientation): [number, number] {
  switch (orientation) {
    case Orientation.Axial:
      return [
        sliceCountFor(volume, Orientation.Sagittal),
        sliceCountFor(volume, Orientation.Coronal),
      ];
    case Orientation.Coronal:
      return [
        sliceCountFor(volume, Orientation.Sagittal),
        sliceCountFor(volume, Orientation.Axial),
      ];
    case Orientation.Sagittal:
      return [sliceCountFor(volume, Orientation.Coronal), sliceCountFor(volume, Orientation.Axial)];
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

/**
 * Tilt a plane basis off its orthogonal default by an {@link ObliqueRotation},
 * pivoting about the plane's centre so the slice rotates in place.
 *
 * The two angles rotate the basis about its own (orthonormal) in-plane axes —
 * `tiltU` about `axisU`, `tiltV` about `axisV` — preserving each axis's length,
 * so the field of view and the through-plane spacing are unchanged and only the
 * plane's orientation tilts. The centre (`origin + ½(axisU+axisV+axisS)`, the
 * volume centre for every orthogonal basis) is held fixed, and the origin is
 * re-derived from the rotated axes. A zero/absent rotation returns the basis
 * untouched, so the orthogonal path is bit-for-bit unchanged.
 */
function obliqueBasis(basis: PlaneBasis, rotation: ObliqueRotation | undefined): PlaneBasis {
  if (!isOblique(rotation)) return basis;
  const uHat = normalize(basis.axisU);
  const vHat = normalize(basis.axisV);
  const sHat = normalize(basis.axisS);
  // Rotate the orthonormal frame about its own u then v axis. Both pivots are the
  // original axes, so the composition is a single rigid rotation of the frame.
  const rot = (v: Vec3): Vec3 =>
    rotateAbout(rotateAbout(v, uHat, rotation.tiltU), vHat, rotation.tiltV);
  const axisU = scale(rot(uHat), length(basis.axisU));
  const axisV = scale(rot(vHat), length(basis.axisV));
  const axisS = scale(rot(sHat), length(basis.axisS));
  const center = add(basis.origin, scale(add(add(basis.axisU, basis.axisV), basis.axisS), 0.5));
  const origin = sub(center, scale(add(add(axisU, axisV), axisS), 0.5));
  return { origin, axisU, axisV, axisS };
}

/** Rotate `v` about unit axis `k` by `angle` (radians) via Rodrigues' formula. */
function rotateAbout(v: Vec3, k: Vec3, angle: number): Vec3 {
  if (angle === 0) return v;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // v·c + (k×v)·s + k·(k·v)·(1−c), with k a unit vector.
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/** Multiply the inverse of the geometry's 3×3 linear map by a patient vector. */
export function invMul(geom: VolumeGeometry, v: Vec3): Vec3 {
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
export function perTexel(index: Vec3, dims: readonly [number, number, number]): Vec3 {
  return [index[0] / dims[0], index[1] / dims[1], index[2] / dims[2]];
}

export { patientBounds, planeBasis, obliqueBasis };
