import type { Slice, Volume } from './types';

export class VolumeBuildError extends Error {}

/** cross product of two 3-vectors */
function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
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
        `Slices have inconsistent dimensions (${s.columns}×${s.rows} vs ${columns}×${rows}). ` +
          `Multiple series in one folder are not supported yet.`,
      );
    }
  }

  const ordered = sortSlices(slices);
  const depth = ordered.length;

  const sliceVoxels = rows * columns;
  const data = new Float32Array(sliceVoxels * depth);
  let min = Infinity;
  let max = -Infinity;
  for (let z = 0; z < depth; z++) {
    const px = ordered[z].pixels;
    data.set(px, z * sliceVoxels);
    for (let i = 0; i < px.length; i++) {
      const v = px[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  const [sx, sy] = inPlaneSpacing(ordered[0]);
  const sz = throughPlaneSpacing(ordered);

  const { center, width } = defaultWindow(ordered[0], min, max);

  return {
    dims: [columns, rows, depth],
    spacing: [sx, sy, sz],
    data,
    min,
    max,
    windowCenter: center,
    windowWidth: width,
    rescaleSlope: ordered[0].rescaleSlope,
    rescaleIntercept: ordered[0].rescaleIntercept,
    modality: ordered[0].modality,
  };
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

/** Median gap between consecutive slice positions along the normal. */
function throughPlaneSpacing(ordered: Slice[]): number {
  if (ordered.length < 2) return 1;
  const first = ordered[0];
  if (!first.orientation || !ordered.every((s) => s.position)) return 1;

  const rowDir = first.orientation.slice(0, 3);
  const colDir = first.orientation.slice(3, 6);
  const normal = cross(rowDir, colDir);
  const proj = (s: Slice) =>
    s.position![0] * normal[0] + s.position![1] * normal[1] + s.position![2] * normal[2];

  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    gaps.push(Math.abs(proj(ordered[i]) - proj(ordered[i - 1])));
  }
  gaps.sort((a, b) => a - b);
  const mid = gaps[Math.floor(gaps.length / 2)];
  return mid > 0 ? mid : 1;
}

/** Prefer the file's suggested window; otherwise derive one from the data range. */
function defaultWindow(s: Slice, min: number, max: number): { center: number; width: number } {
  if (s.windowCenter !== null && s.windowWidth !== null && s.windowWidth > 0) {
    return { center: s.windowCenter, width: s.windowWidth };
  }
  const width = Math.max(1, max - min);
  return { center: min + width / 2, width };
}
