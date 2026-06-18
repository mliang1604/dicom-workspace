import { Orientation, type Vec3, type Volume, type VolumeGeometry } from '../dicom/types';
import { add, cross, dot, scale, sub } from '../dicom/vec3';

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
