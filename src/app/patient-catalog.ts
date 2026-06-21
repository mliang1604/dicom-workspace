import { Injectable, computed, signal } from '@angular/core';
import { addSeriesToCatalog, type PatientCatalogMap, type PatientRecord } from '../dicom/catalog';
import type { Series } from '../dicom/series';

/**
 * Accumulates every imported series into a persistent, multi-patient catalog —
 * the history that survives switching the active view. Each import {@link add}s
 * its series, deduped by SeriesInstanceUID, building one merged patient → study →
 * series hierarchy rather than replacing the last load (the {@link
 * import('./volume-loader').VolumeLoader}'s job).
 *
 * **Lazy by design**: the catalog retains each series' parsed slices and metadata
 * but builds no {@link import('../dicom/volume').Volume}s — those stay GPU-bound
 * and are assembled on demand at load time. Holding a whole patient's slices is
 * heavy but bounded; the volumes are what we keep out of memory.
 *
 * Signal-based and `root`-provided, mirroring {@link
 * import('./recent-store').RecentStore}; unlike it, the catalog isn't persisted —
 * the retained slices are far too large for `localStorage` and belong to the
 * session.
 */
@Injectable({ providedIn: 'root' })
export class PatientCatalog {
  private readonly catalog = signal<PatientCatalogMap>(new Map());
  private readonly current = signal<string | null>(null);

  /** Every accumulated patient, keyed by PatientID, for the multi-patient catalog. */
  readonly patients = this.catalog.asReadonly();

  /**
   * PatientID the one-patient-at-a-time UI is focused on — the most recently
   * imported patient — or null when the catalog is empty. The empty string keys a
   * patient whose series carry no PatientID.
   */
  readonly currentPatientId = this.current.asReadonly();

  /** The {@link currentPatientId}'s record, or null when none is selected or present. */
  readonly currentPatient = computed<PatientRecord | null>(() => {
    const id = this.current();
    return id === null ? null : (this.catalog().get(id) ?? null);
  });

  /**
   * Merge a freshly imported batch of series into the catalog, deduping by
   * SeriesInstanceUID without dropping what's already there, and focus the UI on
   * the imported patient. A batch with no series is a no-op.
   */
  add(series: readonly Series[]): void {
    if (series.length === 0) return;
    this.catalog.set(addSeriesToCatalog(this.catalog(), series));
    this.current.set(series[0].patientId ?? '');
  }

  /** Empty the catalog and clear the current selection — the one-at-a-time reset. */
  clear(): void {
    this.catalog.set(new Map());
    this.current.set(null);
  }
}
