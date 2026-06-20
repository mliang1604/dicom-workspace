import type { MissingSlices, Slice, Vec3, Volume, VolumeGeometry } from './types';
import { cross, dot, normalize, scale } from './vec3';

export class VolumeBuildError extends Error {}

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

  const ordered = sortSlices(slices);
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
  const ori = first.orientation;
  const hasSpatial = !!ori && ordered.every((s) => s.position);

  if (!hasSpatial || !ori) {
    return {
      data: stackByIndex(ordered, sliceVoxels),
      depth: ordered.length,
      spacingZ: 1,
      geometry: { iStep: [sx, 0, 0], jStep: [0, sy, 0], kStep: [0, 0, 1], origin: [0, 0, 0] },
    };
  }

  const rowDir: Vec3 = [ori[0], ori[1], ori[2]];
  const colDir: Vec3 = [ori[3], ori[4], ori[5]];
  const normal = normalize(cross(rowDir, colDir));
  const proj = ordered.map((s) => dot(s.position!, normal));

  const gaps = consecutiveGaps(proj);
  const sz = median(gaps); // representative spacing, robust to gap outliers

  const { data, depth } = resampleAlongNormal(ordered, proj, sz, sliceVoxels);

  // The grid has one layer per representative-spacing step; any extra layers
  // over the acquired count were synthesized to fill gaps.
  const synthesized = depth - ordered.length;
  const missingSlices =
    synthesized > 0 ? { count: synthesized, maxGapMm: Math.max(...gaps) } : undefined;

  const origin: Vec3 = [first.position![0], first.position![1], first.position![2]];
  const iStep = scale(rowDir, sx);
  const jStep = scale(colDir, sy);
  const kStep = scale(normal, sz);

  // A near-singular map (e.g. parallel cosines, or a collapsed stack) cannot be
  // inverted to reslice; fall back to a clean axis-aligned frame.
  if (Math.abs(dot(iStep, cross(jStep, kStep))) < 1e-6) {
    return {
      data,
      depth,
      spacingZ: sz,
      geometry: { iStep: [sx, 0, 0], jStep: [0, sy, 0], kStep: [0, 0, sz], origin },
      missingSlices,
    };
  }
  return { data, depth, spacingZ: sz, geometry: { iStep, jStep, kStep, origin }, missingSlices };
}

/** Concatenate slice pixels in order, one slice per grid layer. */
function stackByIndex(ordered: Slice[], sliceVoxels: number): Float32Array {
  const data = new Float32Array(sliceVoxels * ordered.length);
  for (let z = 0; z < ordered.length; z++) data.set(ordered[z].pixels, z * sliceVoxels);
  return data;
}

/**
 * Resample the (position-sorted) slices onto a uniform through-plane axis of
 * pitch `sz`, spanning the slices' projection range. Each output layer is the
 * linear blend of the two source slices that bracket its position, so missing
 * slices are interpolated rather than abutted. `proj` is ascending (the sort
 * order), so a single forward cursor finds each layer's bracket.
 */
function resampleAlongNormal(
  ordered: Slice[],
  proj: number[],
  sz: number,
  sliceVoxels: number,
): { data: Float32Array; depth: number } {
  const n = ordered.length;
  const span = proj[n - 1] - proj[0];
  const depth = Math.max(1, Math.round(span / sz) + 1);
  const data = new Float32Array(sliceVoxels * depth);

  let src = 0;
  for (let k = 0; k < depth; k++) {
    const target = proj[0] + k * sz;
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
  return { data, depth };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Sort key: projection of the image position onto the slice normal. */
function sortSlices(slices: Slice[]): Slice[] {
  const first = slices[0];
  if (first.orientation && slices.every((s) => s.position)) {
    const rowDir = first.orientation.slice(0, 3);
    const colDir = first.orientation.slice(3, 6);
    const normal = cross(rowDir, colDir);
    const proj = (s: Slice) =>
      s.position![0] * normal[0] + s.position![1] * normal[1] + s.position![2] * normal[2];
    return [...slices].sort((a, b) => proj(a) - proj(b));
  }
  return [...slices].sort((a, b) => a.instanceNumber - b.instanceNumber);
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
