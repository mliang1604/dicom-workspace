import type { Vec3, Volume, VolumeGeometry } from './types';
import { patientToVoxel } from './volume';

/**
 * A mutable 3D label grid aligned to an image {@link Volume}: the canonical
 * voxel representation authored structures are painted into. It shares the image
 * volume's {@link dims}, voxel {@link spacing}, and patient→voxel
 * {@link geometry}, so a patient point maps to the same voxel here as it does in
 * the image (the brush, display, and probe all agree).
 *
 * **Single-occupancy:** each voxel holds one ROI id (a `Uint16` — 65 535
 * distinct structures, plenty for hand authoring), `0` meaning background. This
 * is one texture to display and trivial to sample, at the cost of overlap: a
 * voxel cannot belong to two ROIs at once (the later paint wins). The richer
 * alternative is per-ROI bit-planes (one bit per structure per voxel) which
 * permits overlap but needs N planes and a compositing pass; single-occupancy is
 * the v1 choice and overlap is deferred.
 *
 * **Memory:** dense, 2 bytes/voxel — a 512×512×300 series is ≈ 78 MB. Acceptable
 * for v1; a block-sparse or RLE encoding (see {@link import('./rle')}) is the
 * later optimization for large volumes.
 *
 * Unlike the immutable {@link Volume}, {@link data} is a large buffer mutated in
 * place by {@link paintLabels} / {@link eraseLabels}: cloning 78 MB per brush
 * stroke is untenable, so the store owning a label volume bumps an explicit
 * version counter instead of replacing the array (see `EditableStructuresStore`).
 */
export interface LabelVolume {
  /** Voxel counts along x, y, z — identical to the image {@link Volume.dims}. */
  readonly dims: readonly [number, number, number];
  /** Physical voxel size in mm along x, y, z — identical to {@link Volume.spacing}. */
  readonly spacing: readonly [number, number, number];
  /**
   * Index→patient (LPS) placement, resolved from the image volume so a patient
   * point lands on the same voxel both ways. Always concrete here (never the
   * image volume's optional {@link Volume.geometry}); {@link createLabelVolume}
   * fills the axis-aligned fallback when the image has none.
   */
  readonly geometry: VolumeGeometry;
  /**
   * ROI id per voxel, row-major `[z][y][x]` (the {@link Volume.data} layout),
   * `0` = background. Mutated in place — see {@link LabelVolume}.
   */
  readonly data: Uint16Array;
}

/**
 * The geometry an image {@link Volume} places its voxels with, or the
 * axis-aligned identity derived from its spacing when it records none. Mirrors
 * `resolveGeometry` in `src/render/plane-basis.ts` (kept here to avoid a
 * `dicom → render` dependency), so a label volume built from a metadata-less
 * volume still maps patient points the way the reslice does.
 */
function resolveGeometry(volume: Volume): VolumeGeometry {
  if (volume.geometry) return volume.geometry;
  const [sx, sy, sz] = volume.spacing;
  return { iStep: [sx, 0, 0], jStep: [0, sy, 0], kStep: [0, 0, sz], origin: [0, 0, 0] };
}

/**
 * Allocate a zeroed (all-background) label volume aligned to `volume`: same
 * dims, spacing, and resolved geometry, so the brush and display agree with the
 * image's reslice and probe.
 */
export function createLabelVolume(volume: Volume): LabelVolume {
  const [dimX, dimY, dimZ] = volume.dims;
  return {
    dims: volume.dims,
    spacing: volume.spacing,
    geometry: resolveGeometry(volume),
    data: new Uint16Array(dimX * dimY * dimZ),
  };
}

/** Flat array index of voxel `(x, y, z)` in a label/image grid of `dims`. */
export function labelIndex(
  dims: readonly [number, number, number],
  x: number,
  y: number,
  z: number,
): number {
  const [dimX, dimY] = dims;
  return (z * dimY + y) * dimX + x;
}

/**
 * Map a patient-space point (LPS, mm) to the integer label voxel it falls in, or
 * `null` when it lies outside the grid (or the geometry is singular). Rounds each
 * continuous index to the nearest voxel centre. Shares {@link patientToVoxel}
 * with the image volume, so a point resolves to the same voxel in both grids.
 */
export function labelVoxelAtPatient(
  label: LabelVolume,
  point: Vec3,
): readonly [number, number, number] | null {
  const continuous = patientToVoxel(label.geometry, point);
  if (!continuous) return null;
  const [dimX, dimY, dimZ] = label.dims;
  const x = Math.round(continuous[0]);
  const y = Math.round(continuous[1]);
  const z = Math.round(continuous[2]);
  if (x < 0 || x >= dimX || y < 0 || y >= dimY || z < 0 || z >= dimZ) return null;
  return [x, y, z];
}

/**
 * Paint `roiId` into the given voxels, in place. `voxels` is an iterable of flat
 * indices (see {@link labelIndex}); out-of-range indices are skipped. Pure over
 * its inputs and the buffer it mutates — the brush (#268) decides *which* voxels;
 * this only writes them. Single-occupancy: the painted id overwrites whatever
 * ROI (or background) was there.
 */
export function paintLabels(label: LabelVolume, roiId: number, voxels: Iterable<number>): void {
  const { data } = label;
  for (const i of voxels) {
    if (i >= 0 && i < data.length) data[i] = roiId;
  }
}

/** Erase the given voxels back to background (`0`), in place. See {@link paintLabels}. */
export function eraseLabels(label: LabelVolume, voxels: Iterable<number>): void {
  const { data } = label;
  for (const i of voxels) {
    if (i >= 0 && i < data.length) data[i] = 0;
  }
}

/**
 * Clear every voxel holding `roiId` back to background, returning how many were
 * cleared. Used when a structure is deleted, so its painted voxels don't linger
 * under a later structure that reuses the id.
 */
export function clearLabelId(label: LabelVolume, roiId: number): number {
  const { data } = label;
  let cleared = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === roiId) {
      data[i] = 0;
      cleared++;
    }
  }
  return cleared;
}
