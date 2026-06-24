import { clamp01 } from './math';
import { orderSlicesThroughPlane, throughPlaneNormal } from './slice-order';
import type { MissingSlices, Slice, Vec3, Volume, VolumeGeometry } from './types';
import { add, cross, dot, scale, sub } from './vec3';

export class VolumeBuildError extends Error {}

/**
 * Map a patient-space point (LPS, mm) to a continuous voxel index `(i, j, k)` —
 * column, row, slice — in a volume's grid. The inverse of the forward placement
 * `patient = origin + i·iStep + j·jStep + k·kStep` described on
 * {@link VolumeGeometry}: it inverts the 3×3 map whose columns are the steps.
 *
 * This is the bridge that lets an RTSTRUCT's contour points (stored in patient
 * coordinates) be drawn over the resliced planes: a point shared with the image
 * volume's frame of reference resolves to the same voxel the image samples
 * there. Indices are continuous (not rounded) and may fall outside `[0, dim)`
 * for points beyond the volume; callers decide how to clip or interpolate.
 *
 * Returns `null` when the geometry is singular (degenerate steps that cannot be
 * inverted) — the same condition {@link buildVolume} guards when assembling.
 */
export function patientToVoxel(geometry: VolumeGeometry, point: Vec3): Vec3 | null {
  const { iStep, jStep, kStep, origin } = geometry;
  // Columns of the inverse via the adjugate: each output index is the relative
  // point projected onto the reciprocal of the corresponding step pair.
  const det = dot(iStep, cross(jStep, kStep));
  if (Math.abs(det) < 1e-9) return null;
  const rel = sub(point, origin);
  return [
    dot(cross(jStep, kStep), rel) / det,
    dot(cross(kStep, iStep), rel) / det,
    dot(cross(iStep, jStep), rel) / det,
  ];
}

/**
 * Map a continuous voxel index `(i, j, k)` — column, row, slice — back to its
 * patient-space point (LPS, mm). The forward placement
 * `patient = origin + i·iStep + j·jStep + k·kStep` described on
 * {@link VolumeGeometry}, and the exact inverse of {@link patientToVoxel}.
 *
 * Used when authoring leaves the app: a label voxel (or a contour vertex traced
 * over the label grid) is turned into the patient coordinates RTSTRUCT Contour
 * Data is defined in, so an exported structure re-associates with the same image
 * series on import.
 */
export function voxelToPatient(geometry: VolumeGeometry, voxel: Vec3): Vec3 {
  const { iStep, jStep, kStep, origin } = geometry;
  return add(
    add(origin, scale(iStep, voxel[0])),
    add(scale(jStep, voxel[1]), scale(kStep, voxel[2])),
  );
}

/**
 * Assemble a stack of {@link Slice}s into a {@link Volume}.
 *
 * Slices are ordered along the through-plane axis using ImagePositionPatient
 * projected onto the slice normal (from ImageOrientationPatient); InstanceNumber
 * is the fallback when spatial metadata is missing.
 */
export function buildVolume(slices: Slice[]): Volume {
  if (slices.length === 0) throw new VolumeBuildError('No DICOM image slices were found.');

  const { rows, columns } = slices[0];
  for (const s of slices) {
    if (s.rows !== rows || s.columns !== columns) {
      throw new VolumeBuildError(
        `Slices have inconsistent dimensions (${s.columns}×${s.rows} vs ${columns}×${rows}) ` +
          `within one series.`,
      );
    }
  }

  const ordered = orderSlicesThroughPlane(slices);
  const sliceVoxels = rows * columns;
  const [sx, sy] = inPlaneSpacing(ordered[0]);

  const frame = assemble(ordered, sliceVoxels, sx, sy);

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < frame.data.length; i++) {
    const v = frame.data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const { center, width } = defaultWindow(ordered[0], min, max);

  return {
    dims: [columns, rows, frame.depth],
    spacing: [sx, sy, frame.spacingZ],
    data: frame.data,
    min,
    max,
    windowCenter: center,
    windowWidth: width,
    rescaleSlope: ordered[0].rescaleSlope,
    rescaleIntercept: ordered[0].rescaleIntercept,
    modality: ordered[0].modality,
    geometry: frame.geometry,
    missingSlices: frame.missingSlices,
  };
}

/** Voxel data plus the geometry of the regular grid it was assembled onto. */
interface Frame {
  readonly data: Float32Array;
  readonly depth: number;
  /** Through-plane spacing of the assembled grid, in mm. */
  readonly spacingZ: number;
  readonly geometry: VolumeGeometry;
  /** Set when gaps were interpolated to build the uniform grid. */
  readonly missingSlices?: MissingSlices;
}

/**
 * Assemble the ordered slices onto a regular voxel grid.
 *
 * When spatial metadata is present, the slices are resampled onto a uniform
 * through-plane axis at the series' representative spacing, placing every slice
 * at its true ImagePositionPatient and linearly interpolating across missing
 * slices. This keeps cross-plane (coronal/sagittal) reconstructions geometrically
 * correct for series with non-uniform spacing or gaps, instead of smearing them.
 * For an already-uniform series the grid coincides with the acquired slices, so
 * the data is unchanged. Without spatial metadata the slices are stacked by
 * index and the acquisition axes are treated as the patient axes.
 */
function assemble(ordered: Slice[], sliceVoxels: number, sx: number, sy: number): Frame {
  const first = ordered[0];
  const normal = throughPlaneNormal(ordered);

  if (!normal) {
    return {
      data: stackByIndex(ordered, sliceVoxels),
      depth: ordered.length,
      spacingZ: 1,
      geometry: { iStep: [sx, 0, 0], jStep: [0, sy, 0], kStep: [0, 0, 1], origin: [0, 0, 0] },
    };
  }

  const ori = first.orientation!;
  const rowDir: Vec3 = [ori[0], ori[1], ori[2]];
  const colDir: Vec3 = [ori[3], ori[4], ori[5]];
  const proj = ordered.map((s) => dot(s.position!, normal));

  const gaps = consecutiveGaps(proj);
  const sz = median(gaps); // representative spacing, robust to gap outliers

  const { data, depth, spacingZ } = resampleAlongNormal(ordered, proj, sz, sliceVoxels);

  // The grid has one layer per representative-spacing step; any extra layers
  // over the acquired count were synthesized to fill gaps.
  const synthesized = depth - ordered.length;
  const missingSlices =
    synthesized > 0 ? { count: synthesized, maxGapMm: Math.max(...gaps) } : undefined;

  const origin: Vec3 = [first.position![0], first.position![1], first.position![2]];
  const iStep = scale(rowDir, sx);
  const jStep = scale(colDir, sy);
  const kStep = scale(normal, spacingZ);

  // A near-singular map (e.g. parallel cosines, or a collapsed stack) cannot be
  // inverted to reslice; fall back to a clean axis-aligned frame.
  if (Math.abs(dot(iStep, cross(jStep, kStep))) < 1e-6) {
    return {
      data,
      depth,
      spacingZ,
      geometry: { iStep: [sx, 0, 0], jStep: [0, sy, 0], kStep: [0, 0, spacingZ], origin },
      missingSlices,
    };
  }
  return { data, depth, spacingZ, geometry: { iStep, jStep, kStep, origin }, missingSlices };
}

/** Concatenate slice pixels in order, one slice per grid layer. */
function stackByIndex(ordered: Slice[], sliceVoxels: number): Float32Array {
  const data = new Float32Array(sliceVoxels * ordered.length);
  for (let z = 0; z < ordered.length; z++) data.set(ordered[z].pixels, z * sliceVoxels);
  return data;
}

/**
 * Upper bound on the resampled grid depth, as a multiple of the acquired slice
 * count. A pathological geometry — a tiny median gap (gantry jitter, irregular
 * spacing, or a stray ImagePositionPatient) against a large projection span —
 * would otherwise make `round(span / sz)` enormous and allocate hundreds of MB.
 * Capping the depth keeps the allocation bounded; the synthesized-layer count
 * still flags the series through {@link MissingSlices} so the gap is reported
 * rather than hidden.
 */
const MAX_RESAMPLE_DEPTH_FACTOR = 16;

/**
 * Resample the (position-sorted) slices onto a uniform through-plane axis of
 * pitch `sz`, spanning the slices' projection range. Each output layer is the
 * linear blend of the two source slices that bracket its position, so missing
 * slices are interpolated rather than abutted. `proj` is ascending (the sort
 * order), so a single forward cursor finds each layer's bracket.
 *
 * The layer count is capped at {@link MAX_RESAMPLE_DEPTH_FACTOR}× the acquired
 * slice count so a degenerate geometry cannot allocate unboundedly. When the cap
 * binds, the pitch is widened to still span the full range (returned as
 * `spacingZ`), and the inflated synthesized-layer count flags the series via
 * {@link MissingSlices}.
 */
function resampleAlongNormal(
  ordered: Slice[],
  proj: number[],
  sz: number,
  sliceVoxels: number,
): { data: Float32Array; depth: number; spacingZ: number } {
  const n = ordered.length;
  const span = proj[n - 1] - proj[0];
  const cap = n * MAX_RESAMPLE_DEPTH_FACTOR;
  const ideal = Math.max(1, Math.round(span / sz) + 1);
  const depth = Math.min(ideal, cap);
  // Below the cap the pitch is the representative spacing exactly; only a capped
  // grid widens its step to keep covering the full span at fewer layers.
  const step = depth < ideal && depth > 1 ? span / (depth - 1) : sz;
  const data = new Float32Array(sliceVoxels * depth);

  let src = 0;
  for (let k = 0; k < depth; k++) {
    const target = proj[0] + k * step;
    while (src < n - 1 && proj[src + 1] < target) src++;
    const hiIndex = Math.min(src + 1, n - 1);
    const gap = proj[hiIndex] - proj[src];
    const t = clamp01(gap > 1e-6 ? (target - proj[src]) / gap : 0);
    const offset = k * sliceVoxels;

    if (t <= 0) {
      data.set(ordered[src].pixels, offset);
    } else if (t >= 1) {
      data.set(ordered[hiIndex].pixels, offset);
    } else {
      const lo = ordered[src].pixels;
      const hi = ordered[hiIndex].pixels;
      for (let i = 0; i < sliceVoxels; i++) data[offset + i] = lo[i] + (hi[i] - lo[i]) * t;
    }
  }
  return { data, depth, spacingZ: step };
}

/** PixelSpacing is [rowSpacing, colSpacing] -> [x (col), y (row)]. */
function inPlaneSpacing(s: Slice): [number, number] {
  return [s.pixelSpacing[1], s.pixelSpacing[0]];
}

/** Absolute gaps between consecutive (already position-sorted) projections. */
function consecutiveGaps(proj: number[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < proj.length; i++) gaps.push(Math.abs(proj[i] - proj[i - 1]));
  return gaps;
}

/**
 * Median of the gaps — the representative through-plane spacing. The median
 * ignores outlier gaps (missing slices), so a series that is mostly 2.5 mm with
 * a few large gaps resamples at 2.5 mm.
 */
function median(gaps: number[]): number {
  if (gaps.length === 0) return 1;
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return mid > 1e-6 ? mid : 1;
}

/** Prefer the file's suggested window; otherwise derive one from the data range. */
function defaultWindow(s: Slice, min: number, max: number): { center: number; width: number } {
  if (s.windowCenter !== null && s.windowWidth !== null && s.windowWidth > 0) {
    return { center: s.windowCenter, width: s.windowWidth };
  }
  const width = Math.max(1, max - min);
  return { center: min + width / 2, width };
}
