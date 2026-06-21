import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { StudyRecord } from '../../../dicom/catalog';
import type { Series } from '../../../dicom/series';
import { PatientCatalog } from '../../patient-catalog';
import { PreferencesStore, type HistoryView } from '../../preferences-store';
import { SeriesThumbnailCache, type SeriesThumbnail } from '../series-thumbnail';
import { SeriesChip } from './series-chip';

/**
 * The longitudinal history panel docked below the viewport: the focused
 * patient's studies, shown either as compact tiles along a date axis (oldest →
 * newest) or as a denser Patient ▸ Study ▸ Series tree.
 *
 * **Two views, one chip.** The default `timeline` lays studies out as
 * expand-in-place accordion tiles (date, description, modality badges and series
 * count; clicking unfolds the study's series chips while its neighbours stay
 * collapsed — single-open). The alternate `tree` stacks the same studies as
 * collapsible rows under a patient root for patients with many studies/series.
 * Both reuse {@link SeriesChip} and share the open-study and active-series state,
 * so the header toggle switches layout without reloading or losing selection.
 * The collapsed flag, the chosen view and the last-opened study all persist via
 * {@link PreferencesStore} so the panel restores across sessions.
 *
 * Read-only: it reflects the {@link PatientCatalog} and highlights the chip of
 * the {@link loadedSeriesUid currently-loaded series}. Loading and drag-to-load
 * is #173. The single patient root is shaped so multi-patient catalogs are a
 * natural extension. Hidden entirely when the catalog holds no studies.
 */
@Component({
  selector: 'app-history-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SeriesChip],
  templateUrl: './history-panel.html',
  styleUrl: './history-panel.css',
  host: {
    // No patient, no panel: the host is removed from layout when there's nothing
    // to show (`:host([hidden])` forces display:none over the host's flex).
    '[hidden]': '!hasCatalog()',
  },
})
export class HistoryPanel {
  private readonly catalog = inject(PatientCatalog);
  private readonly preferences = inject(PreferencesStore);
  /** Per-series preview cache; deduped by UID, so stable across imports. */
  private readonly thumbnails = new SeriesThumbnailCache();

  /** UID of the series currently displayed in the viewport, to highlight its chip. */
  readonly loadedSeriesUid = input<string>('');

  /** The focused patient's studies along the timeline (ascending); empty when none. */
  protected readonly studies = computed<readonly StudyRecord[]>(
    () => this.catalog.currentPatient()?.studies ?? [],
  );

  /** Whether there's anything to show; the panel hides entirely otherwise. */
  protected readonly hasCatalog = computed(() => this.studies().length > 0);

  /** A short label for the focused patient (name, else id), shown in the header. */
  protected readonly patientLabel = computed(() => {
    const patient = this.catalog.currentPatient();
    if (!patient) return '';
    return patient.name?.trim() || patient.patientId || 'Unknown patient';
  });

  /** Whether the panel is collapsed to its header bar. Restored from preferences. */
  protected readonly collapsed = signal(this.preferences.preferences().historyCollapsed);

  /** The active layout (`timeline` / `tree`). Restored from preferences. */
  protected readonly view = signal<HistoryView>(this.preferences.preferences().historyView);

  /** Whether the tree's patient root is expanded. Tree-only, session-local. */
  protected readonly patientExpanded = signal(true);

  /**
   * StudyInstanceUID of the single open (accordion) study, or null when all are
   * collapsed. Restored from preferences; a stale UID simply matches no tile.
   */
  protected readonly openStudyUid = signal<string | null>(
    this.preferences.preferences().lastOpenedStudyUid,
  );

  /** Collapse/expand the whole panel, persisting the choice. */
  protected toggleCollapsed(): void {
    const next = !this.collapsed();
    this.collapsed.set(next);
    this.preferences.update({ historyCollapsed: next });
  }

  /** Switch to the given layout (no-op if already active), persisting the choice. */
  protected setView(view: HistoryView): void {
    if (this.view() === view) return;
    this.view.set(view);
    this.preferences.update({ historyView: view });
  }

  /** Expand/collapse the tree's patient root. */
  protected togglePatient(): void {
    this.patientExpanded.update((open) => !open);
  }

  /** Open the clicked study (closing any other), or close it if already open. */
  protected toggleStudy(uid: string): void {
    const next = nextOpenStudy(this.openStudyUid(), uid);
    this.openStudyUid.set(next);
    this.preferences.update({ lastOpenedStudyUid: next });
  }

  /** Whether a given study is the currently-open accordion tile. */
  protected isOpen(study: StudyRecord): boolean {
    return study.studyUid === this.openStudyUid();
  }

  /** The series' cached preview (computed lazily on first reveal). */
  protected thumbnailFor(series: Series): SeriesThumbnail {
    return this.thumbnails.get(series);
  }

  /** Human date for a study tile (e.g. `2024-03-18`), or `Undated`. */
  protected dateLabel(study: StudyRecord): string {
    return formatStudyDate(study.date);
  }

  /** Pluralised series-count summary for a study tile. */
  protected countLabel(study: StudyRecord): string {
    return seriesCountLabel(study.series.length);
  }

  /** Pluralised study-count summary for the tree's patient root. */
  protected studiesLabel(): string {
    return studyCountLabel(this.studies().length);
  }
}

/**
 * The next open-study UID for a single-open accordion: opening a tile closes any
 * other (returns the clicked UID), and clicking the already-open tile closes it
 * (returns null). Pure, for unit-testing the toggle behaviour.
 */
export function nextOpenStudy(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

/**
 * Format a raw DICOM `DA` StudyDate (`YYYYMMDD`) as `YYYY-MM-DD` for a tile.
 * A null or malformed value (not 8 digits) yields `Undated`, since undated
 * studies sort last on the timeline and need a stable, glanceable label.
 */
export function formatStudyDate(date: string | null): string {
  if (date === null || !/^\d{8}$/.test(date)) return 'Undated';
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

/** Pluralised series-count summary, e.g. `1 series` / `4 series`. */
export function seriesCountLabel(count: number): string {
  return `${count} series`;
}

/** Pluralised study-count summary for the tree root, e.g. `1 study` / `3 studies`. */
export function studyCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'study' : 'studies'}`;
}
