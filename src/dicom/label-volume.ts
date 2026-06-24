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
  /**
   * Inclusive voxel-space bounding box of everything mutated since the display
   * last uploaded, or `null` when clean. The mask display uploads only this
   * sub-box instead of re-encoding and re-writing the whole ~78 MB grid on every
   * brush event (a stamp touches ~`(2r)³` voxels). Expanded in place by the
   * mutators alongside {@link data}; the consumer flushes it with
   * {@link clearDirty} after uploading. Not `readonly`: it is reassigned
   * `null` → box → `null`, part of the same mutate-in-place contract as `data`.
   */
  dirty: DirtyBox | null;
}

/** Inclusive voxel-space bounding box of the region touched since the last upload. */
export interface DirtyBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Grow `label.dirty` to include voxel `(x, y, z)` (creating it when clean). */
export function markDirty(label: LabelVolume, x: number, y: number, z: number): void {
  const b = label.dirty;
  if (!b) {
    label.dirty = { minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z };
    return;
  }
  if (x < b.minX) b.minX = x;
  else if (x > b.maxX) b.maxX = x;
  if (y < b.minY) b.minY = y;
  else if (y > b.maxY) b.maxY = y;
  if (z < b.minZ) b.minZ = z;
  else if (z > b.maxZ) b.maxZ = z;
}

/** Mark the whole grid dirty (a full re-upload), e.g. after a bulk clear. */
export function markAllDirty(label: LabelVolume): void {
  const [dimX, dimY, dimZ] = label.dims;
  label.dirty = { minX: 0, minY: 0, minZ: 0, maxX: dimX - 1, maxY: dimY - 1, maxZ: dimZ - 1 };
}

/** Flush the dirty region back to clean, after the consumer has uploaded it. */
export function clearDirty(label: LabelVolume): void {
  label.dirty = null;
}

/** Grow `label.dirty` to include the voxel at flat index `i`. */
function markDirtyIndex(label: LabelVolume, i: number, dimX: number, dimY: number): void {
  const x = i % dimX;
  const y = ((i / dimX) | 0) % dimY;
  const z = (i / (dimX * dimY)) | 0;
  markDirty(label, x, y, z);
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
    dirty: null,
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
  const [dimX, dimY] = label.dims;
  for (const i of voxels) {
    if (i >= 0 && i < data.length) {
      data[i] = roiId;
      markDirtyIndex(label, i, dimX, dimY);
    }
  }
}

/** Erase the given voxels back to background (`0`), in place. See {@link paintLabels}. */
export function eraseLabels(label: LabelVolume, voxels: Iterable<number>): void {
  const { data } = label;
  const [dimX, dimY] = label.dims;
  for (const i of voxels) {
    if (i >= 0 && i < data.length) {
      data[i] = 0;
      markDirtyIndex(label, i, dimX, dimY);
    }
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
  const [dimX, dimY] = label.dims;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === roiId) {
      data[i] = 0;
      markDirtyIndex(label, i, dimX, dimY);
      cleared++;
    }
  }
  return cleared;
}
