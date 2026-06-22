import { Injectable, inject } from '@angular/core';
import { importKeepsOnePatient, importPatientIds } from '../../dicom/catalog';
import type { Series } from '../../dicom/series';
import { VolumeLoader, type LoadResult, type MergedLoad } from '../volume-loader';
import { PatientCatalog } from '../patient-catalog';
import { trace } from '../../diag/trace';

/**
 * What a viewport drop will do, selected by the modifier held while dropping: a
 * plain drop loads as the primary series (smart-auto), ⌥/Alt forces a fusion
 * overlay, and ⇧/Shift adds a side-by-side compare column.
 */
export type DropIntent = 'primary' | 'overlay' | 'compare';

/**
 * The decision a load resolves to, for the viewer to apply. Centralises the load
 * policy so the file-picker, drag-to-load, and history-panel paths share one
 * tested set of branches instead of three diverged copies.
 */
export type LoadOutcome =
  /** Replace the view with a fresh base volume (`applyVolume`). */
  | { readonly kind: 'replace'; readonly result: LoadResult }
  /** Keep the base and add `result`'s overlay layer; `compare` also opens the columns. */
  | { readonly kind: 'overlay'; readonly result: LoadResult; readonly compare: boolean }
  /** A held-modifier drop that can't fuse: restore the prior view and flash `message`. */
  | { readonly kind: 'reject'; readonly message: string }
  /** The patient-switch confirm was declined: restore the prior view, do nothing else. */
  | { readonly kind: 'cancel' }
  /** The series is already shown: nothing to load; `compare` may still open the columns. */
  | { readonly kind: 'noop'; readonly compare: boolean };

/**
 * Feedback when a held-modifier drop can't apply: ⌥ fuse and ⇧ compare both need a
 * series sharing the current scan's frame of reference, so a different study (or
 * nothing loaded to fuse against) degrades to this notice instead of replacing.
 */
export function cantFuseMessage(intent: 'overlay' | 'compare'): string {
  const action = intent === 'overlay' ? 'fuse' : 'compare';
  return `Can’t ${action}: drop a series that shares the current scan’s frame of reference.`;
}

/** How a merged load (already-shown view grown, or not) maps to an outcome for an intent. */
function outcomeForMerged(merged: MergedLoad, intent: DropIntent): LoadOutcome {
  if (intent === 'primary') {
    return merged.added
      ? { kind: 'overlay', result: merged.result, compare: false }
      : { kind: 'replace', result: merged.result };
  }
  // A held modifier forces the overlay path; a series that can't fuse is a no-op.
  if (!merged.added) return { kind: 'reject', message: cantFuseMessage(intent) };
  return { kind: 'overlay', result: merged.result, compare: intent === 'compare' };
}

/** The minimal patient-catalog surface the file-load policy mutates. */
export interface CatalogOps {
  readonly add: (series: readonly Series[]) => void;
  readonly clear: () => void;
}

/** Everything the file-load policy needs, injected so it can be tested without a GPU. */
export interface FileLoadDeps {
  /** The currently-shown registry, or null when nothing is loaded. */
  readonly previous: LoadResult | null;
  /** The freshly parsed batch. */
  readonly result: LoadResult;
  readonly intent: DropIntent;
  /** Confirm a patient switch (injected so the policy never calls `window.confirm`). */
  readonly confirm: () => boolean;
  readonly currentPatientId: string | null;
  readonly keepsOnePatient: (id: string | null, series: readonly Series[]) => boolean;
  readonly merge: (current: LoadResult, incoming: LoadResult) => MergedLoad;
  readonly catalog: CatalogOps;
}

/**
 * Decide how a freshly parsed file batch joins the view, mutating the patient
 * catalog as it goes. A held modifier (⌥/⇧) forces the fusion overlay path,
 * applying only to a same-patient, same-frame series — else a graceful reject. A
 * plain load runs the one-patient guard: a different patient prompts the injected
 * confirm (clearing the catalog on a switch, or cancelling), then fuses a
 * same-frame series of the current patient or replaces the view.
 */
export function planFileLoad(deps: FileLoadDeps): LoadOutcome {
  const { previous, result, intent, confirm, currentPatientId, keepsOnePatient, merge, catalog } =
    deps;
  const t = trace('load');

  if (intent !== 'primary') {
    const samePatient = keepsOnePatient(currentPatientId, result.series);
    const merged = previous && samePatient ? merge(previous, result) : { result, added: false };
    // The patient gate runs before merge, so a cross-patient overlay rejects here —
    // the registration is never consulted. This trace separates that case from a
    // same-patient drop that mergeLoad then declines.
    t?.('held-modifier drop', {
      intent,
      currentPatientId,
      incomingPatients: importPatientIds(result.series),
      hasPrevious: previous !== null,
      samePatient,
      added: merged.added,
    });
    if (!merged.added) return { kind: 'reject', message: cantFuseMessage(intent) };
    catalog.add(result.series);
    return { kind: 'overlay', result: merged.result, compare: intent === 'compare' };
  }

  let switched = false;
  if (!keepsOnePatient(currentPatientId, result.series)) {
    if (!confirm()) {
      t?.('primary drop: patient switch declined', {
        currentPatientId,
        incomingPatients: importPatientIds(result.series),
      });
      return { kind: 'cancel' };
    }
    catalog.clear();
    switched = true;
  }
  catalog.add(result.series);
  // A patient switch starts a fresh view; otherwise a same-frame series stacks atop.
  const merged = previous && !switched ? merge(previous, result) : { result, added: false };
  t?.('primary drop', {
    currentPatientId,
    incomingPatients: importPatientIds(result.series),
    hasPrevious: previous !== null,
    switched,
    added: merged.added,
  });
  return merged.added
    ? { kind: 'overlay', result: merged.result, compare: false }
    : { kind: 'replace', result: merged.result };
}

/** Everything the history-panel series-load policy needs. */
export interface SeriesLoadDeps {
  readonly previous: LoadResult | null;
  readonly series: Series;
  readonly intent: DropIntent;
  /** Parse the series into a registry; may throw (the caller handles it). */
  readonly loadSeries: (series: Series, known: LoadResult['allStructureSets']) => LoadResult;
  readonly merge: (current: LoadResult, incoming: LoadResult) => MergedLoad;
}

/**
 * Decide how a history-panel series joins the view. An already-shown series is a
 * no-op (⇧ still opens the compare columns); otherwise it's parsed and merged onto
 * the current view, then routed by intent exactly like a file load. Unlike a file
 * load it never touches the catalog or prompts — panel series are already known.
 */
export function planSeriesLoad(deps: SeriesLoadDeps): LoadOutcome {
  const { previous, series, intent, loadSeries, merge } = deps;
  if (previous && previous.layers.some((layer) => layer.id === series.uid)) {
    return { kind: 'noop', compare: intent === 'compare' };
  }
  const incoming = loadSeries(series, previous ? previous.allStructureSets : []);
  const merged = previous ? merge(previous, incoming) : { result: incoming, added: false };
  return outcomeForMerged(merged, intent);
}

/**
 * Resolves a load request to a {@link LoadOutcome} at the
 * {@link VolumeLoader} / {@link PatientCatalog} boundary, unifying the three load
 * paths behind one tested policy. The viewer applies the returned outcome (and
 * passes the patient-switch confirm in, so the policy stays `window.confirm`-free
 * and testable). Provided at the component so its lifetime tracks the viewer.
 */
@Injectable()
export class LoadCoordinator {
  private readonly loader = inject(VolumeLoader);
  private readonly catalog = inject(PatientCatalog);

  /** Resolve a freshly parsed file batch (file-picker or drag-to-load). */
  resolveFiles(
    previous: LoadResult | null,
    result: LoadResult,
    intent: DropIntent,
    confirm: () => boolean,
  ): LoadOutcome {
    return planFileLoad({
      previous,
      result,
      intent,
      confirm,
      currentPatientId: this.catalog.currentPatientId(),
      keepsOnePatient: importKeepsOnePatient,
      merge: (current, incoming) => this.loader.merge(current, incoming),
      catalog: {
        add: (series) => this.catalog.add(series),
        clear: () => this.catalog.clear(),
      },
    });
  }

  /** Resolve a history-panel series pick (may throw if the series fails to parse). */
  resolveSeries(previous: LoadResult | null, series: Series, intent: DropIntent): LoadOutcome {
    return planSeriesLoad({
      previous,
      series,
      intent,
      loadSeries: (s, known) => this.loader.loadSeries(s, known),
      merge: (current, incoming) => this.loader.merge(current, incoming),
    });
  }
}
