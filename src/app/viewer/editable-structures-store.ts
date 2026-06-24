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
   * volume. Always ≥ 1 (`0` is reserved for background) and unique across every
   * authored set within a load (the sets share one label grid, so ids must not
   * collide even though each set is its own registry).
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
 * One authored structure set: a labelled registry of {@link EditableRoi}s the
 * editor owns and can export as its own RTSTRUCT (#270). Mirrors the read-only
 * {@link import('../../dicom/types').StructureSet} shape closely enough that the
 * panel can list authored and imported sets together, but is always mutable —
 * imported sets stay `readonly` and are never folded in here (#274).
 *
 * The ROIs across all authored sets share the store's single {@link LabelVolume}
 * and one global id space, so a set is a grouping/labelling of ids rather than an
 * isolated voxel grid: a voxel still names exactly one ROI regardless of set.
 */
export interface AuthoredStructureSet {
  /** Set id, unique within a load (≥ 1); the active-set selector keys on this. */
  readonly id: number;
  /** Structure Set Label, editable from the panel; the exported set's label. */
  readonly label: string;
  /** The set's authored structures, in creation order. */
  readonly rois: readonly EditableRoi[];
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
 * paints into and a list of authored {@link AuthoredStructureSet}s describing what
 * each label id means and which set owns it. The single home for hand-drawn
 * segmentations, provided at the viewer (like `RoiController` / `LayersStore`) so
 * its lifetime tracks the load.
 *
 * **Multiple sets, one grid (#274).** New structures must never be written into an
 * imported RTSTRUCT (which is `readonly` and owns its export round-trip), so the
 * editor authors only into its own sets, kept entirely separate from the imported
 * ones held by `RoiController`. The first authoring action lazily creates an
 * authored set ({@link ensureActiveSet}); when the loaded series already ships
 * imported sets the auto-created set is labelled to read as new ("New ROIs"). New
 * ROIs and brush strokes target the {@link activeSet}; only authored sets can be
 * active. The sets share one label grid and one global id space so a painted voxel
 * still names exactly one ROI; a "set" groups and labels ids for the panel and for
 * per-set export.
 *
 * **Mutability deviation.** The repo's pattern is immutable signal updates, and
 * the set list follows it (each edit replaces the array). The label volume's voxel
 * buffer does *not*: it is megabytes (≈ 78 MB for a 512³-ish series), so cloning it
 * per brush stroke is untenable. Instead the buffer is mutated in place and
 * {@link version} is bumped — a monotonic counter the display layer (#269) reads to
 * know the texture needs re-uploading. Consumers must treat {@link labelVolume}'s
 * `data` as live and depend on {@link version}, not on the array identity, to react
 * to paints.
 */
@Injectable()
export class EditableStructuresStore {
  /** The label grid aligned to the loaded image volume; null before a load. */
  private readonly _labelVolume = signal<LabelVolume | null>(null);

  /** The authored structure sets, in creation order; the only mutable sets. */
  private readonly _sets = signal<readonly AuthoredStructureSet[]>([]);

  /** Id of the set new ROIs/strokes target; null until the first set is created. */
  private readonly _activeSetId = signal<number | null>(null);

  /**
   * The id the next created structure takes; only ever increases within a load, so
   * a deleted structure's id is never recycled (a new structure can't inherit a
   * stale voxel that a clear somehow missed) and ids stay unique across sets that
   * share the one label grid. Reset per load.
   */
  private nextId = 1;

  /** The id the next created set takes; only ever increases within a load. */
  private nextSetId = 1;

  /**
   * Whether the loaded series ships imported structure sets, so the first
   * auto-created authored set is labelled to read as new. Set per load.
   */
  private hasImportedSets = false;

  /**
   * Monotonic counter bumped on every label-voxel mutation (paint/erase/delete).
   * The display layer watches this — not the buffer identity, which never changes
   * — to re-upload the texture. Registry edits that don't touch voxels don't bump
   * it (the panel reacts to {@link sets} instead).
   */
  private readonly _version = signal(0);

  /** The label grid the brush paints into; null before a load. Read-only handle. */
  readonly labelVolume = this._labelVolume.asReadonly();

  /** The authored structure sets for the panel. Read-only handle. */
  readonly sets = this._sets.asReadonly();

  /** Id of the active authored set (the target for new ROIs/strokes); null when none. */
  readonly activeSetId = this._activeSetId.asReadonly();

  /** The label-voxel mutation counter; see {@link _version}. Read-only handle. */
  readonly version = this._version.asReadonly();

  /**
   * Every authored ROI across all sets, flattened — the id→colour source for the
   * mask LUT (a painted voxel names exactly one ROI regardless of which set owns
   * it). The panel groups by set via {@link sets} instead.
   */
  readonly rois = computed<readonly EditableRoi[]>(() => this._sets().flatMap((s) => s.rois));

  /** The active authored set, or null when none has been created yet. */
  readonly activeSet = computed<AuthoredStructureSet | null>(() => {
    const id = this._activeSetId();
    return id === null ? null : (this._sets().find((s) => s.id === id) ?? null);
  });

  /** The active set's ROIs — what the brush's active-ROI selector lists. */
  readonly activeRois = computed<readonly EditableRoi[]>(() => this.activeSet()?.rois ?? []);

  /** Whether any structure has been authored, gating the panel section. */
  readonly hasStructures = computed(() => this.rois().length > 0);

  /**
   * Create a new, empty authored set and make it active, returning it. The target
   * for {@link createSet}'s "New set" panel action; new ROIs then land here.
   */
  createSet(label?: string): AuthoredStructureSet {
    const id = this.nextSetId++;
    const set: AuthoredStructureSet = { id, label: label ?? this.defaultSetLabel(), rois: [] };
    this._sets.update((sets) => [...sets, set]);
    this._activeSetId.set(id);
    return set;
  }

  /** Make `id` the active set (the target for new ROIs/strokes); no-op when unknown. */
  setActiveSet(id: number): void {
    if (this._sets().some((s) => s.id === id)) this._activeSetId.set(id);
  }

  /** Rename an authored set; no-op when the id is unknown. */
  renameSet(id: number, label: string): void {
    this._sets.update((sets) => sets.map((s) => (s.id === id ? { ...s, label } : s)));
  }

  /**
   * Create a new structure in the {@link activeSet} (creating a first authored set
   * if none is active yet), assigning the next free id and (unless overridden) a
   * palette colour, and return it. Does not touch any voxels.
   */
  createRoi(
    name?: string,
    color?: readonly [number, number, number],
    interpretedType?: string,
  ): EditableRoi {
    const set = this.ensureActiveSet();
    const id = this.nextId++;
    const roi: EditableRoi = {
      id,
      name: name ?? `Structure ${id}`,
      color: color ?? ROI_PALETTE[(id - 1) % ROI_PALETTE.length],
      interpretedType: interpretedType ?? null,
    };
    this._sets.update((sets) =>
      sets.map((s) => (s.id === set.id ? { ...s, rois: [...s.rois, roi] } : s)),
    );
    return roi;
  }

  /**
   * Promote an imported RTSTRUCT {@link Roi} to an editable structure (#271): mint
   * a new {@link EditableRoi} in the active authored set carrying the import's
   * identity (name, ROI Display Color, interpreted type) and rasterize its planar
   * contours into the label volume tagged with the new id, so the brush can edit it
   * and the mask overlay draws it. Returns the created structure and how many
   * voxels were filled (and non-fillable contours skipped), or null before a load.
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
    this._sets.update((sets) =>
      sets.map((s) => ({ ...s, rois: s.rois.map((r) => (r.id === id ? { ...r, name } : r)) })),
    );
  }

  /** Recolour a structure; no-op when the id is unknown. */
  recolorRoi(id: number, color: readonly [number, number, number]): void {
    this._sets.update((sets) =>
      sets.map((s) => ({ ...s, rois: s.rois.map((r) => (r.id === id ? { ...r, color } : r)) })),
    );
  }

  /**
   * Delete a structure: drop it from its set and clear every voxel it tagged back
   * to background, so a later structure reusing the id can't inherit stale voxels
   * (ids never recycle, but the clear keeps the grid honest). Leaves the now-empty
   * set in place. Bumps {@link version} when any voxel was cleared.
   */
  deleteRoi(id: number): void {
    this._sets.update((sets) =>
      sets.map((s) => ({ ...s, rois: s.rois.filter((r) => r.id !== id) })),
    );
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
   * `LayersStore.reset`: allocate a fresh empty label grid aligned to `volume` (or
   * clear it when nothing loaded), drop all authored sets, and reset the version
   * counter. `hasImportedSets` records whether the series ships imported RTSTRUCTs
   * so the first auto-created authored set is labelled to read as new.
   */
  resetForLoad(volume: Volume | null, hasImportedSets = false): void {
    this._labelVolume.set(volume ? createLabelVolume(volume) : null);
    this._sets.set([]);
    this._activeSetId.set(null);
    this._version.set(0);
    this.nextId = 1;
    this.nextSetId = 1;
    this.hasImportedSets = hasImportedSets;
  }

  /** The active set, creating (and activating) a first authored set when none is. */
  private ensureActiveSet(): AuthoredStructureSet {
    return this.activeSet() ?? this.createSet();
  }

  /**
   * A default label for an auto-created set: reads as new ("New ROIs") when the
   * series already ships imported sets to author against, else a plain "Structures"
   * — numbered after the first so multiple authored sets stay distinguishable.
   */
  private defaultSetLabel(): string {
    const base = this.hasImportedSets ? 'New ROIs' : 'Structures';
    const ordinal = this._sets().length + 1;
    return ordinal === 1 ? base : `${base} ${ordinal}`;
  }

  /** Bump the label-voxel mutation counter so the display re-uploads. */
  private bump(): void {
    this._version.update((v) => v + 1);
  }
}
