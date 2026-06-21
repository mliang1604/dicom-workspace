import { Injectable, signal } from '@angular/core';
import { LayoutMode } from '../render/layout';
import { ProjectionMode } from '../render/slice-renderer';

/**
 * Schema version of the persisted blob. Bump whenever {@link ViewPreferences}
 * changes shape so stale data from an older layout is discarded (not coerced)
 * and the user falls back to defaults instead of a half-read state.
 */
const SCHEMA_VERSION = 3;

/** localStorage key (versioned) under which the view preferences are persisted. */
const STORAGE_KEY = 'dicom-workspace.preferences';

/**
 * Layout of the longitudinal history panel: the default date-ordered `timeline`
 * of study tiles, or a denser collapsible `tree` (Patient ▸ Study ▸ Series) for
 * patients with many studies/series. Both reuse the same series chip.
 */
export type HistoryView = 'timeline' | 'tree';

/**
 * The curated set of *view* preferences remembered across sessions, so reopening
 * the app keeps the user's setup. These are volume-independent (or
 * volume-defaulted) — per-volume state (slice indices, pans, 3D camera) is kept
 * per-session and deliberately not stored here.
 *
 * The window/level and slab thickness depend on the loaded volume, so they're
 * `null` until the user has actually viewed one; a `null` means "use the
 * volume's own default" rather than a fixed value.
 */
export interface ViewPreferences {
  /** Viewport arrangement (3-pane MPR / 4-pane / 3D-only). */
  readonly layoutMode: LayoutMode;
  /** 3D pane projection mode (MIP / MinIP / Average / DVR). */
  readonly projectionMode: ProjectionMode;
  /** Whether the sagittal pane is mirrored by default. */
  readonly sagittalFlipped: boolean;
  /** Last window centre, or null to use the loaded volume's default. */
  readonly windowCenter: number | null;
  /** Last window width (≥ 1), or null to use the loaded volume's default. */
  readonly windowWidth: number | null;
  /** Last 3D slab thickness in mm (≥ 1), or null to use the full-depth default. */
  readonly slabThicknessMm: number | null;
  /** Whether the longitudinal history panel is collapsed to its header bar. */
  readonly historyCollapsed: boolean;
  /** Layout of the history panel: date timeline or Patient ▸ Study ▸ Series tree. */
  readonly historyView: HistoryView;
  /**
   * StudyInstanceUID of the last-opened history study (the single-open accordion),
   * or null when every study is collapsed. Restores the timeline's open tile.
   */
  readonly lastOpenedStudyUid: string | null;
}

/** The preferences applied when nothing valid is stored. */
export const DEFAULT_PREFERENCES: ViewPreferences = {
  layoutMode: LayoutMode.TriMpr,
  projectionMode: ProjectionMode.Max,
  sagittalFlipped: false,
  windowCenter: null,
  windowWidth: null,
  slabThicknessMm: null,
  historyCollapsed: false,
  historyView: 'timeline',
  lastOpenedStudyUid: null,
};

/**
 * Remembers a curated set of view preferences across browser sessions, persisted
 * to `localStorage`. Reads/writes are guarded so the service still works where
 * storage is unavailable (private mode, SSR), mirroring {@link DisclaimerStore}
 * and {@link RecentStore}. Per-volume state is intentionally not stored here.
 */
@Injectable({ providedIn: 'root' })
export class PreferencesStore {
  private readonly prefs = signal<ViewPreferences>(parsePreferences(readRaw()));

  /** The current preferences, restored from storage on construction. */
  readonly preferences = this.prefs.asReadonly();

  /** Merge a partial update into the stored preferences and persist the result. */
  update(patch: Partial<ViewPreferences>): void {
    const next = { ...this.prefs(), ...patch };
    if (samePreferences(next, this.prefs())) return; // skip redundant writes (e.g. drag frames)
    this.prefs.set(next);
    writeRaw(serializePreferences(next));
  }
}

/** Serialize preferences to the versioned JSON written to storage. */
export function serializePreferences(prefs: ViewPreferences): string {
  return JSON.stringify({ version: SCHEMA_VERSION, ...prefs });
}

/**
 * Parse the versioned JSON blob back into preferences, falling back to defaults
 * for anything missing, mistyped, or written under a different schema version.
 * A `null` raw value (nothing stored) or a parse error also yields the defaults.
 * Pure, for unit-testing the restore + versioning behaviour.
 */
export function parsePreferences(raw: string | null): ViewPreferences {
  if (!raw) return DEFAULT_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFERENCES;
  const obj = parsed as Record<string, unknown>;
  if (obj['version'] !== SCHEMA_VERSION) return DEFAULT_PREFERENCES; // schema mismatch → defaults
  return {
    layoutMode: isLayoutMode(obj['layoutMode'])
      ? obj['layoutMode']
      : DEFAULT_PREFERENCES.layoutMode,
    projectionMode: isProjectionMode(obj['projectionMode'])
      ? obj['projectionMode']
      : DEFAULT_PREFERENCES.projectionMode,
    sagittalFlipped:
      typeof obj['sagittalFlipped'] === 'boolean'
        ? obj['sagittalFlipped']
        : DEFAULT_PREFERENCES.sagittalFlipped,
    windowCenter: finiteOrNull(obj['windowCenter']),
    windowWidth: positiveIntOrNull(obj['windowWidth']),
    slabThicknessMm: positiveIntOrNull(obj['slabThicknessMm']),
    historyCollapsed:
      typeof obj['historyCollapsed'] === 'boolean'
        ? obj['historyCollapsed']
        : DEFAULT_PREFERENCES.historyCollapsed,
    historyView: isHistoryView(obj['historyView'])
      ? obj['historyView']
      : DEFAULT_PREFERENCES.historyView,
    lastOpenedStudyUid:
      typeof obj['lastOpenedStudyUid'] === 'string'
        ? obj['lastOpenedStudyUid']
        : DEFAULT_PREFERENCES.lastOpenedStudyUid,
  };
}

/** Shallow-equality of two preference records, to skip redundant persistence. */
function samePreferences(a: ViewPreferences, b: ViewPreferences): boolean {
  return (
    a.layoutMode === b.layoutMode &&
    a.projectionMode === b.projectionMode &&
    a.sagittalFlipped === b.sagittalFlipped &&
    a.windowCenter === b.windowCenter &&
    a.windowWidth === b.windowWidth &&
    a.slabThicknessMm === b.slabThicknessMm &&
    a.historyCollapsed === b.historyCollapsed &&
    a.historyView === b.historyView &&
    a.lastOpenedStudyUid === b.lastOpenedStudyUid
  );
}

/** Type-guard a parsed value as a valid {@link LayoutMode}. */
function isLayoutMode(value: unknown): value is LayoutMode {
  return (
    value === LayoutMode.TriMpr ||
    value === LayoutMode.Quad ||
    value === LayoutMode.Volume3d ||
    value === LayoutMode.Compare
  );
}

/** Type-guard a parsed value as a valid {@link ProjectionMode}. */
function isProjectionMode(value: unknown): value is ProjectionMode {
  return (
    value === ProjectionMode.Max ||
    value === ProjectionMode.Min ||
    value === ProjectionMode.Mean ||
    value === ProjectionMode.Dvr
  );
}

/** Type-guard a parsed value as a valid {@link HistoryView}. */
function isHistoryView(value: unknown): value is HistoryView {
  return value === 'timeline' || value === 'tree';
}

/** Coerce a finite number, else null (a stored centre may legitimately be 0). */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Coerce a positive integer (rounding finite inputs), else null. */
function positiveIntOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null;
  return Math.round(value);
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRaw(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage is unavailable; the in-memory signal still serves this session.
  }
}
