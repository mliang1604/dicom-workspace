import { Injectable, inject } from '@angular/core';
import { importKeepsOnePatient } from '../../dicom/catalog';
import type { Series } from '../../dicom/series';
import { VolumeLoader, type LoadResult, type MergedLoad } from '../volume-loader';
import { PatientCatalog } from '../patient-catalog';

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
  /**
   * A plain file import: the batch was catalogued into the history but not shown —
   * the viewport waits for the user to pick a series (#241). `cleared` is true when
   * a confirmed patient switch emptied the catalog, so the viewer also unloads the
   * stale view.
   */
  | { readonly kind: 'imported'; readonly cleared: boolean }
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

/**
 * How a held-modifier merged load maps to an outcome: a series that fused becomes
 * the overlay (⇧ also opening the compare columns), one that couldn't a reject.
 * Only the ⌥/⇧ paths reach here — a plain (primary) load replaces outright.
 */
function outcomeForMerged(merged: MergedLoad, intent: 'overlay' | 'compare'): LoadOutcome {
  if (!merged.added) return { kind: 'reject', message: cantFuseMessage(intent) };
  return { kind: 'overlay', result: merged.result, compare: intent === 'compare' };
}

/** The minimal patient-catalog surface the file-load policy mutates. */
export interface CatalogOps {
  readonly add: (series: readonly Series[]) => void;
  readonly addStructureSets: (sets: LoadResult['allStructureSets']) => void;
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
 * catalog as it goes. A held modifier (⌥/⇧) is an explicit fusion request: it
 * forces the overlay path against the current view, applying only to a
 * same-patient, same-frame series — else a graceful reject. A plain load is
 * ingest-only (#241): it runs the one-patient guard — a different patient prompts
 * the injected confirm (clearing the catalog on a switch, or cancelling) — then
 * catalogues the series into the history *without* displaying anything, leaving
 * the user to pick which series to view. A confirmed switch reports `cleared` so
 * the viewer also unloads the now-stale view of the previous patient.
 */
export function planFileLoad(deps: FileLoadDeps): LoadOutcome {
  const { previous, result, intent, confirm, currentPatientId, keepsOnePatient, merge, catalog } =
    deps;

  if (intent !== 'primary') {
    const samePatient = keepsOnePatient(currentPatientId, result.series);
    const merged = previous && samePatient ? merge(previous, result) : { result, added: false };
    if (!merged.added) return { kind: 'reject', message: cantFuseMessage(intent) };
    catalog.add(result.series);
    catalog.addStructureSets(result.allStructureSets);
    return { kind: 'overlay', result: merged.result, compare: intent === 'compare' };
  }

  let cleared = false;
  if (!keepsOnePatient(currentPatientId, result.series)) {
    if (!confirm()) return { kind: 'cancel' };
    catalog.clear();
    cleared = true;
  }
  catalog.add(result.series);
  // Retain any RTSTRUCTs from this batch so a later history pick of the image
  // they annotate still shows their contours — the ingest-only import (#241)
  // would otherwise drop them with the parsed batch.
  catalog.addStructureSets(result.allStructureSets);
  return { kind: 'imported', cleared };
}

/** Everything the history-panel series-load policy needs. */
export interface SeriesLoadDeps {
  readonly previous: LoadResult | null;
  readonly series: Series;
  readonly intent: DropIntent;
  /**
   * Structure sets retained across this session's imports, so picking the image
   * an RTSTRUCT annotates re-associates its contours even when the parsed batch
   * was catalogued ingest-only (#241) and nothing is currently displayed.
   */
  readonly knownStructureSets: LoadResult['allStructureSets'];
  /** Parse the series into a registry; may throw (the caller handles it). */
  readonly loadSeries: (series: Series, known: LoadResult['allStructureSets']) => LoadResult;
  readonly merge: (current: LoadResult, incoming: LoadResult) => MergedLoad;
}

/**
 * Decide how a history-panel series joins the view. A plain (primary) pick
 * *replaces* the view, unloading every other image so the viewport shows exactly
 * the series the user chose (#241) — re-picking the current base simply reloads
 * it. A held modifier instead fuses: ⌥ overlays and ⇧ overlays-and-compares a
 * same-frame series, while an already-composited series is a no-op (⇧ still opens
 * the compare columns). Unlike a file load it never touches the catalog or
 * prompts — panel series are already known.
 */
export function planSeriesLoad(deps: SeriesLoadDeps): LoadOutcome {
  const { previous, series, intent, knownStructureSets, loadSeries, merge } = deps;
  if (intent !== 'primary' && previous?.layers.some((layer) => layer.id === series.uid)) {
    return { kind: 'noop', compare: intent === 'compare' };
  }
  // The session's retained structure sets (superset of any single displayed
  // load's) so a primary pick re-associates an RTSTRUCT by frame of reference.
  const incoming = loadSeries(series, knownStructureSets);
  if (intent === 'primary') return { kind: 'replace', result: incoming };
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
        addStructureSets: (sets) => this.catalog.addStructureSets(sets),
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
      knownStructureSets: this.catalog.structureSets(),
      loadSeries: (s, known) => this.loader.loadSeries(s, known),
      merge: (current, incoming) => this.loader.merge(current, incoming),
    });
  }
}
