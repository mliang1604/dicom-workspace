import { Injectable, computed, inject, type Signal } from '@angular/core';
import { type Series } from '../../dicom/series';
import { type DicomMetadata, type RawTag } from '../../dicom/metadata';
import { baseLayer, type Layer, type Volume } from '../../dicom/types';
import { PatientCatalog } from '../patient-catalog';
import { type LoadState } from './load-controller';
import { filterRawTags, loadingText, missingSliceWarning } from './viewer-format';

function describeVolume(layers: readonly Layer[], sliceCount: number): string {
  const [x, y, z] = baseLayer(layers)!.volume.dims;
  return `Loaded ${sliceCount} slice(s) — volume ${x} × ${y} × ${z}.`;
}

/** Component state the {@link StatusController} reads; wired via {@link StatusController.init}. */
export interface StatusInit {
  readonly load: () => LoadState;
  readonly gpuError: () => string | null;
  readonly volume: () => Volume | null;
  /** Case-insensitive filter typed into the raw-tag search box. */
  readonly rawTagFilter: Signal<string>;
}

/**
 * Owns the read-only status / series / metadata derivations: the status banner
 * text and error flag, the in-flight load progress, the interpolation warning,
 * the series picker list and selection, and the metadata + filtered raw-tag
 * inspector feed. All pure projections of the load state (and the catalog), wired
 * once through {@link init}. Provided at the component so its lifetime tracks the
 * viewer.
 */
@Injectable()
export class StatusController {
  private readonly catalog = inject(PatientCatalog);
  private deps: StatusInit | null = null;

  /** Wire the controller to the component's load + filter state. Called once. */
  init(deps: StatusInit): void {
    this.deps = deps;
  }

  /** Whether a GPU error or a load error is showing (gates the error styling). */
  readonly statusIsError = computed(
    () => this.deps!.gpuError() !== null || this.deps!.load().status === 'error',
  );

  /** True while a load is in flight, gating the progress bar. */
  readonly isLoading = computed(() => this.deps!.load().status === 'loading');

  /** Progress of an in-flight load as a 0–1 fraction for the progress bar. */
  readonly loadProgress = computed<number>(() => {
    const state = this.deps!.load();
    if (state.status !== 'loading' || state.total <= 0) return 0;
    return state.loaded / state.total;
  });

  /** {@link loadProgress} as a 0–100 whole percent for the bar's `aria-valuenow`. */
  readonly loadPercent = computed<number>(() => Math.round(this.loadProgress() * 100));

  /** Warns that reconstructed planes are interpolated across significant gaps. */
  readonly interpolationWarning = computed<string | null>(() => {
    const volume = this.deps!.volume();
    return volume ? missingSliceWarning(volume.missingSlices, volume.spacing[2]) : null;
  });

  /** The status banner text: a GPU error, else the load state's message. */
  readonly statusText = computed(() => {
    const gpuError = this.deps!.gpuError();
    if (gpuError) return gpuError;
    const state = this.deps!.load();
    switch (state.status) {
      case 'idle':
        // After an import nothing auto-loads (#241): point the user at the history
        // panel; before any import, prompt them to open files.
        return this.catalog.currentPatient()
          ? 'Pick a series from the history below to view it.'
          : 'Open a DICOM folder or files to begin.';
      case 'loading':
        return loadingText(state.loaded, state.total);
      case 'ready':
        return describeVolume(state.result.layers, state.result.sliceCount);
      case 'error':
        return state.message;
      default: {
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  });

  /** Series found in the loaded files, for the picker. Empty until a load succeeds. */
  readonly seriesList = computed<readonly Series[]>(() => {
    const state = this.deps!.load();
    return state.status === 'ready' ? state.result.series : [];
  });

  /** UID of the series currently displayed; '' when nothing is loaded. */
  readonly selectedSeriesUid = computed(() => {
    const state = this.deps!.load();
    return state.status === 'ready' ? state.result.selectedUid : '';
  });

  /** UIDs of every series currently composited — the base and any fusion overlays. */
  readonly loadedSeriesUids = computed<readonly string[]>(() => {
    const state = this.deps!.load();
    return state.status === 'ready' ? state.result.layers.map((layer) => layer.id) : [];
  });

  /** Only show the picker when a folder held more than one series. */
  readonly hasMultipleSeries = computed(() => this.seriesList().length > 1);

  /** Captured metadata of the displayed series, or null when none is loaded. */
  readonly metadata = computed<DicomMetadata | null>(() => {
    const uid = this.selectedSeriesUid();
    return this.seriesList().find((series) => series.uid === uid)?.metadata ?? null;
  });

  /** Raw tags of the displayed series, narrowed by the search box. */
  readonly filteredRawTags = computed<readonly RawTag[]>(() => {
    const metadata = this.metadata();
    if (!metadata) return [];
    return filterRawTags(metadata.rawTags, this.deps!.rawTagFilter());
  });
}
