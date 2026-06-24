import { Injectable, computed, signal } from '@angular/core';
import {
  clearLabelId,
  createLabelVolume,
  eraseLabels,
  paintLabels,
  type LabelVolume,
} from '../../dicom/label-volume';
import { rasterizeRoiContours, type RasterizeResult } from '../../dicom/contour-raster';
import type { Roi, Volume } from '../../dicom/types';

/**
 * One authored (hand-painted) structure: its identity, colour, and interpreted
 * type, mirroring the read-only RTSTRUCT {@link import('../../dicom/types').Roi}
 * shape so the structures panel can render authored and imported ROIs together.
 * Authored ROIs carry no contour stack — their geometry lives in the
 * {@link LabelVolume} voxels tagged with {@link id} — and always have a concrete
 * colour (imported ROIs may not).
 */
export interface EditableRoi {
  /**
   * The ROI id, doubling as the voxel value tagging this structure in the label
   * volume. Always ≥ 1 (`0` is reserved for background) and unique within a load.
   */
  readonly id: number;
  /** Display name, editable from the panel. */
  readonly name: string;
  /** Display colour as `[r, g, b]` in 0–255. */
  readonly color: readonly [number, number, number];
  /**
   * RT ROI interpreted type (e.g. `ORGAN`, `PTV`), mirroring
   * {@link import('../../dicom/types').Roi.interpretedType}; null when unset.
   */
  readonly interpretedType: string | null;
}

/**
 * Colours assigned to new structures in turn, then cycled. Distinct, saturated
 * hues that read well over greyscale CT/MR.
 */
const ROI_PALETTE: readonly (readonly [number, number, number])[] = [
  [255, 99, 71], // tomato
  [60, 179, 113], // medium sea green
  [65, 105, 225], // royal blue
  [255, 193, 37], // goldenrod
  [186, 85, 211], // medium orchid
  [0, 206, 209], // dark turquoise
  [255, 140, 0], // dark orange
  [199, 21, 133], // medium violet red
];

/**
 * Owns the authored-structures domain: the mutable {@link LabelVolume} the brush
 * paints into and the registry of {@link EditableRoi}s describing what each label
 * id means. The single home for hand-drawn segmentations, provided at the viewer
 * (like `RoiController` / `LayersStore`) so its lifetime tracks the load.
 *
 * **Mutability deviation.** The repo's pattern is immutable signal updates, and
 * the ROI registry follows it (each edit replaces the array). The label volume's
 * voxel buffer does *not*: it is megabytes (≈ 78 MB for a 512³-ish series), so
 * cloning it per brush stroke is untenable. Instead the buffer is mutated in
 * place and {@link version} is bumped — a monotonic counter the display layer
 * (#269) reads to know the texture needs re-uploading. Consumers must treat
 * {@link labelVolume}'s `data` as live and depend on {@link version}, not on the
 * array identity, to react to paints.
 */
@Injectable()
export class EditableStructuresStore {
  /** The label grid aligned to the loaded image volume; null before a load. */
  private readonly _labelVolume = signal<LabelVolume | null>(null);

  /** The authored structures, registry order; mirrors the read-only ROI list. */
  private readonly _rois = signal<readonly EditableRoi[]>([]);

  /**
   * The id the next created structure takes; only ever increases within a load,
   * so a deleted structure's id is never recycled (a new structure can't inherit
   * a stale voxel that a clear somehow missed). Reset per load.
   */
  private nextId = 1;

  /**
   * Monotonic counter bumped on every label-voxel mutation (paint/erase/delete).
   * The display layer watches this — not the buffer identity, which never changes
   * — to re-upload the texture. Registry edits that don't touch voxels don't bump
   * it (the panel reacts to {@link rois} instead).
   */
  private readonly _version = signal(0);

  /** The label grid the brush paints into; null before a load. Read-only handle. */
  readonly labelVolume = this._labelVolume.asReadonly();

  /** The authored structures for the panel. Read-only handle. */
  readonly rois = this._rois.asReadonly();

  /** The label-voxel mutation counter; see {@link _version}. Read-only handle. */
  readonly version = this._version.asReadonly();

  /** Whether any structure has been authored, gating the panel section. */
  readonly hasStructures = computed(() => this._rois().length > 0);

  /**
   * Create a new structure, assigning the next free id and (unless overridden) a
   * palette colour, and return it. Does not touch any voxels.
   */
  createRoi(
    name?: string,
    color?: readonly [number, number, number],
    interpretedType?: string,
  ): EditableRoi {
    const rois = this._rois();
    const id = this.nextId++;
    const roi: EditableRoi = {
      id,
      name: name ?? `Structure ${id}`,
      color: color ?? ROI_PALETTE[(id - 1) % ROI_PALETTE.length],
      interpretedType: interpretedType ?? null,
    };
    this._rois.set([...rois, roi]);
    return roi;
  }

  /**
   * Promote an imported RTSTRUCT {@link Roi} to an editable structure (#271): mint
   * a new {@link EditableRoi} carrying the import's identity (name, ROI Display
   * Color, interpreted type) and rasterize its planar contours into the label
   * volume tagged with the new id, so the brush can edit it and the mask overlay
   * draws it. Returns the created structure and how many voxels were filled (and
   * non-fillable contours skipped), or null before a load.
   *
   * Lossy by design — the contours are sampled onto the voxel grid, so a later
   * marching-squares export won't reproduce the original points. The caller keeps
   * the read-only contours intact (the panel only hides them), making the
   * conversion deliberate. Bumps {@link version} when any voxel was written.
   */
  promoteRoi(roi: Roi): { roi: EditableRoi; result: RasterizeResult } | null {
    const label = this._labelVolume();
    if (!label) return null;
    const created = this.createRoi(
      roi.name || `ROI ${roi.number}`,
      roi.color ?? undefined,
      roi.interpretedType ?? undefined,
    );
    const result = rasterizeRoiContours(label, roi, created.id);
    if (result.filled > 0) this.bump();
    return { roi: created, result };
  }

  /** Rename a structure; no-op when the id is unknown. */
  renameRoi(id: number, name: string): void {
    this._rois.update((rois) => rois.map((r) => (r.id === id ? { ...r, name } : r)));
  }

  /** Recolour a structure; no-op when the id is unknown. */
  recolorRoi(id: number, color: readonly [number, number, number]): void {
    this._rois.update((rois) => rois.map((r) => (r.id === id ? { ...r, color } : r)));
  }

  /**
   * Delete a structure: drop it from the registry and clear every voxel it
   * tagged back to background, so a later structure reusing the id can't inherit
   * stale voxels. Bumps {@link version} when any voxel was cleared.
   */
  deleteRoi(id: number): void {
    this._rois.update((rois) => rois.filter((r) => r.id !== id));
    const label = this._labelVolume();
    if (label && clearLabelId(label, id) > 0) this.bump();
  }

  /**
   * Paint `roiId` into the given voxels (flat indices into the label grid; see
   * {@link import('../../dicom/label-volume').labelIndex}) and bump
   * {@link version}. The brush (#268) supplies the indices; this only writes them.
   */
  paint(roiId: number, voxels: Iterable<number>): void {
    const label = this._labelVolume();
    if (!label) return;
    paintLabels(label, roiId, voxels);
    this.bump();
  }

  /** Erase the given voxels back to background and bump {@link version}. */
  erase(voxels: Iterable<number>): void {
    const label = this._labelVolume();
    if (!label) return;
    eraseLabels(label, voxels);
    this.bump();
  }

  /**
   * Reset for a freshly loaded volume, mirroring `RoiController.resetForLoad` /
   * `LayersStore.reset`: allocate a fresh empty label grid aligned to `volume`
   * (or clear it when nothing loaded), drop all authored structures, and reset
   * the version counter.
   */
  resetForLoad(volume: Volume | null): void {
    this._labelVolume.set(volume ? createLabelVolume(volume) : null);
    this._rois.set([]);
    this._version.set(0);
    this.nextId = 1;
  }

  /** Bump the label-voxel mutation counter so the display re-uploads. */
  private bump(): void {
    this._version.update((v) => v + 1);
  }
}
