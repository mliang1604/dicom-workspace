import { DestroyRef, Injectable, inject, type WritableSignal } from '@angular/core';
import { describeSelection, RecentStore, type RecentEntry } from '../recent-store';
import { PatientCatalog } from '../patient-catalog';
import { PreferencesStore } from '../preferences-store';
import { VolumeLoader, type LoadResult } from '../volume-loader';
import { type Series } from '../../dicom/series';
import { volumeBounds, NO_OBLIQUE, type ObliqueRotation } from '../../render/reslice';
import { SliceRenderer } from '../../render/slice-renderer';
import { clamp } from '../../dicom/math';
import { baseLayer, Orientation, type Volume } from '../../dicom/types';
import { SERIES_DND_MIME } from './history-panel/series-chip';
import { readDropped } from './drop-files';
import { Camera3dStore } from './camera3d-store';
import { CineStore } from './cine-store';
import { CompareStore } from './compare-store';
import { LayersController } from './layers-controller';
import { MeasurementStore } from './measurement-store';
import { RoiController } from './roi-controller';
import { EditableStructuresStore } from './editable-structures-store';
import { LoadCoordinator, type DropIntent, type LoadOutcome } from './load-coordinator';
import {
  confirmPatientSwitch,
  dropHeadlineText,
  dropIntentOf,
  hasSeriesDrag,
  isLoadableDrag,
} from './viewer-dom';
import {
  type PerOrientation,
  type PerOrientationOblique,
  type PerOrientationPan,
} from './viewer-overlays';

const NO_PAN = { x: 0, y: 0 } as const;
const NO_PANS: PerOrientationPan = [NO_PAN, NO_PAN, NO_PAN];
const NO_OBLIQUES: PerOrientationOblique = [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE];

function middleSlice(renderer: SliceRenderer, orientation: Orientation): number {
  return Math.floor(renderer.sliceCount(orientation) / 2);
}

/** What the viewer is currently showing, as one-shape-at-a-time state. */
export type LoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly loaded: number; readonly total: number }
  | { readonly status: 'ready'; readonly result: LoadResult }
  | { readonly status: 'error'; readonly message: string };

/** How long a transient drop notice stays up before it auto-clears. */
const NOTICE_MS = 3600;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Component state and view callbacks the {@link LoadController} drives; wired via {@link LoadController.init}. */
export interface LoadInit {
  /** The one-shape-at-a-time load state (read + write). */
  readonly load: WritableSignal<LoadState>;
  /** Transient over-viewport notice (write); auto-cleared after a timeout. */
  readonly notice: WritableSignal<string | null>;
  /** Whether files are being dragged over the viewport (write). */
  readonly isDraggingFiles: WritableSignal<boolean>;
  /** What releasing the current drag will do (write). */
  readonly dropIntent: WritableSignal<DropIntent>;
  /** Whether the in-progress drag is a history-panel series chip (write). */
  readonly draggingSeries: WritableSignal<boolean>;
  /** The GPU renderer, or null until ready. */
  readonly renderer: () => SliceRenderer | null;
  /** Switch into the side-by-side Compare layout. */
  readonly setCompareLayout: () => void;
  // Per-load view-reset signals (mutated by applyVolume / clearView).
  readonly sliceIndices: WritableSignal<PerOrientation>;
  readonly zooms: WritableSignal<PerOrientation>;
  readonly pans: WritableSignal<PerOrientationPan>;
  readonly obliques: WritableSignal<PerOrientationOblique>;
  readonly slabThicknessMm: WritableSignal<number>;
  readonly mainOrientation: WritableSignal<Orientation>;
  readonly invert: WritableSignal<boolean>;
  readonly activeTool: WritableSignal<unknown>;
  readonly focusVoxel: WritableSignal<readonly [number, number, number] | null>;
  readonly activeCompareGroup: WritableSignal<number>;
}

/**
 * Owns the load/import flow: the file/series-chip drop overlay, the file-picker
 * and history-panel entry points, and the resolve→apply pipeline that routes a
 * dropped folder or retained series through the {@link LoadCoordinator}'s
 * smart-auto policy (fuse / compare / replace / import) and reflects the outcome
 * into the view. The branchy DOM + async glue lives here; the view-state reset it
 * triggers stays on the component (wired through {@link init}). Provided at the
 * component so its lifetime tracks the viewer.
 */
@Injectable()
export class LoadController {
  private readonly loader = inject(VolumeLoader);
  private readonly catalog = inject(PatientCatalog);
  private readonly loadCoordinator = inject(LoadCoordinator);
  private readonly recentStore = inject(RecentStore);
  private readonly preferencesStore = inject(PreferencesStore);
  private readonly layersCtl = inject(LayersController);
  private readonly roiCtl = inject(RoiController);
  private readonly editableStructures = inject(EditableStructuresStore);
  private readonly compareStore = inject(CompareStore);
  private readonly cam = inject(Camera3dStore);
  private readonly cine = inject(CineStore);
  private readonly measure = inject(MeasurementStore);

  private deps: LoadInit | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.noticeHandle !== null) clearTimeout(this.noticeHandle);
    });
  }

  /**
   * Nesting depth of drag-enter over the viewport's children. `dragenter`/
   * `dragleave` fire for every descendant, so a counter (not a bare flag) keeps
   * the drop overlay steady as the pointer crosses pane borders.
   */
  private dragDepth = 0;
  /** Pending auto-clear of the notice, so a fresh notice cancels the previous. */
  private noticeHandle: ReturnType<typeof setTimeout> | null = null;

  /** Wire the controller to the component's load state and view callbacks. Called once. */
  init(deps: LoadInit): void {
    this.deps = deps;
  }

  /** The drop-overlay headline for the modifier held and the drag's kind. */
  dropHeadline(intent: DropIntent, isSeriesDrag: boolean): string {
    return dropHeadlineText(intent, isSeriesDrag);
  }

  /** Picker label: description (or a fallback) · modality · slice count. */
  seriesLabel(series: Series): string {
    const name = series.description || series.modality || `Series ${series.seriesNumber ?? '?'}`;
    const modality = series.modality ? ` · ${series.modality}` : '';
    return `${name}${modality} · ${series.imageCount} img`;
  }

  async onFilesSelected(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.files) return;
    const files = Array.from(input.files);
    input.value = ''; // allow re-selecting the same folder
    // Picking files leaves focus on this hidden <input type=file>. Since it's an
    // editable target, every subsequent window keydown is swallowed by
    // isEditableTarget and the viewer's shortcuts go dead until the user clicks
    // the canvas. Release that focus so the keyboard works straight after upload.
    input.blur();
    if (files.length > 0) await this.loadFiles(files, describeSelection(files));
  }

  /** A file/folder drag entered the viewport: raise the drop overlay. */
  onDragEnter(event: DragEvent): void {
    const d = this.deps;
    if (!d || !isLoadableDrag(event)) return;
    this.dragDepth++;
    d.dropIntent.set(dropIntentOf(event));
    d.draggingSeries.set(hasSeriesDrag(event));
    d.isDraggingFiles.set(true);
  }

  /** Allow the drop and show the copy cursor while a loadable drag hovers the viewport. */
  onDragOver(event: DragEvent): void {
    const d = this.deps;
    if (!d || !isLoadableDrag(event)) return;
    event.preventDefault();
    // `dragover` fires continuously with the live modifier state, so the overlay
    // hint follows ⌥/⇧ as they're pressed or released without moving the pointer.
    d.dropIntent.set(dropIntentOf(event));
    d.draggingSeries.set(hasSeriesDrag(event));
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  /** A drag left a child (or the viewport): lower the overlay once fully outside. */
  onDragLeave(event: DragEvent): void {
    const d = this.deps;
    if (!d || !isLoadableDrag(event)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      d.isDraggingFiles.set(false);
      d.dropIntent.set('primary');
      d.draggingSeries.set(false);
    }
  }

  /**
   * Handle a drop on the viewport: the modifier held selects the {@link DropIntent}
   * (⌥ fuse / ⇧ compare / plain primary). A history-panel series chip (its UID
   * payload) loads that retained series; otherwise the dropped folder/files are
   * read, walking dropped directories for their slices.
   */
  async onDrop(event: DragEvent): Promise<void> {
    const d = this.deps;
    if (!d) return;
    event.preventDefault();
    this.dragDepth = 0;
    d.isDraggingFiles.set(false);
    d.dropIntent.set('primary');
    d.draggingSeries.set(false);
    if (!event.dataTransfer) return;
    const intent = dropIntentOf(event);
    const seriesUid = event.dataTransfer.getData(SERIES_DND_MIME);
    if (seriesUid) {
      const series = this.catalog.seriesByUid(seriesUid);
      if (series) this.loadSeriesFromPanel(series, intent);
      return;
    }
    const { files, entry } = await readDropped(event.dataTransfer);
    if (files.length > 0) await this.loadFiles(files, entry, intent);
  }

  /**
   * Load a series picked from the history panel (clicked, key-activated, or
   * dropped onto the viewport). Routed through the same smart-auto merge rule as a
   * file load; the {@link intent} (set by the held modifier on a drop) routes ⌥
   * through the fusion overlay and ⇧ through the compare layout.
   */
  loadSeriesFromPanel(series: Series, intent: DropIntent = 'primary'): void {
    const d = this.deps;
    if (!d || d.renderer() === null) return; // GPU not ready; nothing to draw into yet
    const previous = d.load();
    const previousResult = previous.status === 'ready' ? previous.result : null;
    let outcome: LoadOutcome;
    try {
      outcome = this.loadCoordinator.resolveSeries(previousResult, series, intent);
    } catch (error) {
      d.load.set({ status: 'error', message: messageOf(error) });
      return;
    }
    this.applyOutcome(outcome, previous, null);
  }

  /**
   * Re-pick a recent entry. Browsers can't silently re-read a path, so this just
   * re-opens the matching picker (folder or files) for the user to re-select.
   */
  onRecentPick(event: Event, folderInput: HTMLInputElement, filesInput: HTMLInputElement): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const entry = this.recentStore.entries()[Number(event.target.value)];
    event.target.selectedIndex = 0; // back to the "Recent…" placeholder so re-picking fires
    if (!entry) return;
    (entry.kind === 'folder' ? folderInput : filesInput).click();
  }

  async loadFiles(
    files: readonly File[],
    entry: RecentEntry | null,
    intent: DropIntent = 'primary',
  ): Promise<void> {
    const d = this.deps;
    if (!d) return;
    // The load already showing; a same-frame-of-reference series adds atop it.
    const previous = d.load();
    d.load.set({ status: 'loading', loaded: 0, total: files.length });
    try {
      const result = await this.loader.loadFromFiles(files, (loaded, total) => {
        // Ignore stragglers from a superseded load (a new load already started).
        if (d.load().status === 'loading') d.load.set({ status: 'loading', loaded, total });
      });
      // The coordinator runs the whole load policy — held-modifier fusion, the
      // one-patient guard (prompting through the injected confirm) and catalog
      // mutation — and hands back what to do; the patient-switch confirm is the
      // only browser prompt, injected so the policy stays testable.
      const previousResult = previous.status === 'ready' ? previous.result : null;
      const outcome = this.loadCoordinator.resolveFiles(
        previousResult,
        result,
        intent,
        confirmPatientSwitch,
      );
      this.applyOutcome(outcome, previous, entry);
    } catch (error) {
      d.load.set({ status: 'error', message: messageOf(error) });
    }
  }

  /**
   * Apply a resolved {@link LoadOutcome} to the view: replace the volume or add an
   * overlay (⇧ also opening the compare columns), or restore the prior view on a
   * declined patient switch / a can't-fuse reject (flashing the notice). A file
   * `entry`, when present, is recorded in the recent list.
   */
  private applyOutcome(outcome: LoadOutcome, previous: LoadState, entry: RecentEntry | null): void {
    const d = this.deps;
    if (!d) return;
    switch (outcome.kind) {
      case 'replace':
        this.applyVolume(outcome.result);
        if (entry) this.recentStore.record(entry);
        return;
      case 'overlay':
        this.addLayer(outcome.result);
        if (outcome.compare) d.setCompareLayout();
        if (entry) this.recentStore.record({ ...entry, overlay: true });
        return;
      case 'imported':
        // A plain import is catalogued but not shown (#241): leave the viewport to
        // the user's history pick. A confirmed patient switch unloads the stale view.
        if (outcome.cleared) this.clearView();
        if (entry) this.recentStore.record(entry);
        return;
      case 'reject':
        d.load.set(previous); // leave what was showing untouched
        this.flashNotice(outcome.message);
        return;
      case 'cancel':
        d.load.set(previous); // patient-switch declined
        return;
      case 'noop':
        if (outcome.compare) d.setCompareLayout();
        return;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }

  /** Flash a transient notice over the viewport, replacing any still showing. */
  private flashNotice(message: string): void {
    const d = this.deps;
    if (!d) return;
    d.notice.set(message);
    if (this.noticeHandle !== null) clearTimeout(this.noticeHandle);
    this.noticeHandle = setTimeout(() => {
      d.notice.set(null);
      this.noticeHandle = null;
    }, NOTICE_MS);
  }

  /** Switch the displayed series, rebuilding its volume from the parsed slices. */
  onSeriesChange(event: Event): void {
    const d = this.deps;
    if (!d || !(event.target instanceof HTMLSelectElement)) return;
    const state = d.load();
    if (state.status !== 'ready' || event.target.value === state.result.selectedUid) return;
    this.applyVolume(this.loader.selectSeries(state.result, event.target.value));
  }

  /**
   * Adopt a registry that *added* an overlay layer above the current base. The base
   * layer and its volume are unchanged, so — unlike {@link applyVolume} — the view
   * state is preserved and the renderer's base volume isn't re-uploaded.
   */
  private addLayer(result: LoadResult): void {
    this.deps!.load.set({ status: 'ready', result });
  }

  /**
   * Unload everything from the viewport, returning it to the idle/empty state
   * (#241). The patient catalog and history panel are kept — only the displayed
   * volume, its fusion overlays and the per-view annotations are dropped.
   */
  clearView(): void {
    const d = this.deps;
    if (!d) return;
    this.cine.stop();
    this.measure.clear();
    this.measure.endDrag();
    d.activeTool.set('none');
    d.focusVoxel.set(null);
    this.layersCtl.reset();
    d.load.set({ status: 'idle' });
  }

  private applyVolume(result: LoadResult): void {
    const d = this.deps;
    if (!d) return;
    const renderer = d.renderer();
    if (!renderer) {
      d.load.set({ status: 'error', message: 'GPU is not ready yet — try again.' });
      return;
    }
    // The base layer backs the single-layer view; honour its volume's defaults.
    const volume = baseLayer(result.layers)!.volume;
    this.cine.stop(); // a fresh volume resets the view; don't keep cining the old one
    renderer.setVolume(volume);
    this.resetViewForVolume(renderer, volume, result);
    d.load.set({ status: 'ready', result });
  }

  /**
   * The one grouped reset of every per-load view default, so they live in a single
   * place. The feature stores each reset their own domain — measurements, layers,
   * compare linking, and the 3D camera/TF/DVR/clip — and the remaining per-volume
   * signals are reset here. Persisted view preferences (layout, projection mode,
   * sagittal flip) are deliberately *not* reset; window/level and slab honour a
   * stored preference when present, else the volume default.
   */
  private resetViewForVolume(renderer: SliceRenderer, volume: Volume, result: LoadResult): void {
    const d = this.deps!;
    const prefs = this.preferencesStore.preferences();
    const fullDepthMm = Math.round(2 * volumeBounds(volume).radius);
    this.layersCtl.windowCenter.set(prefs.windowCenter ?? Math.round(volume.windowCenter));
    this.layersCtl.windowWidth.set(
      prefs.windowWidth ?? Math.max(1, Math.round(volume.windowWidth)),
    );
    d.slabThicknessMm.set(
      prefs.slabThicknessMm !== null ? clamp(prefs.slabThicknessMm, 1, fullDepthMm) : fullDepthMm,
    );
    d.mainOrientation.set(Orientation.Axial);
    d.focusVoxel.set(null);
    d.activeTool.set('none');
    this.measure.clear();
    this.measure.endDrag();
    // ROI state (visibility / colours / opacity / set selection) resets per load.
    this.roiCtl.resetForLoad(result.structureSets);
    // Authored structures: a fresh empty label grid aligned to the new volume.
    // Flag whether the series ships imported sets so the first authored set is
    // labelled to read as new rather than mutating any import (#274).
    this.editableStructures.resetForLoad(volume, result.structureSets.length > 0);
    // A fresh base load drops any layers-panel edits (overlays load at their defaults).
    this.layersCtl.reset();
    d.activeCompareGroup.set(0); // window/level controls target the base column
    // Per-volume view state is per-session: always reset to volume-derived defaults.
    d.invert.set(false);
    d.zooms.set([1, 1, 1]);
    d.pans.set(NO_PANS);
    // A fresh base load starts with the Compare groups linked and no per-group nav.
    this.compareStore.reset();
    d.obliques.set(NO_OBLIQUES);
    this.cam.reset(); // camera / TF / DVR lighting / clips back to defaults
    d.sliceIndices.set([
      middleSlice(renderer, Orientation.Axial),
      middleSlice(renderer, Orientation.Coronal),
      middleSlice(renderer, Orientation.Sagittal),
    ]);
  }
}
