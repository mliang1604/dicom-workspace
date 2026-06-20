import { Injectable, signal } from '@angular/core';

/** localStorage key under which the recent-loads list is persisted. */
const STORAGE_KEY = 'dicom-workspace.recent-loads';
/** How many recent entries to keep — just enough to jog the memory. */
const MAX_RECENT = 5;

/**
 * One remembered load: the label to show and which picker re-opens it. Browsers
 * can't silently re-read a path, so this is a labelled re-pick — clicking an
 * entry re-triggers the matching file/folder picker, not an automatic reload.
 */
export interface RecentEntry {
  /** Display label: the folder name, a single file's name, or an "N files" count. */
  readonly label: string;
  /** Which `<input>` a re-pick should open: the directory picker or the file picker. */
  readonly kind: 'folder' | 'files';
}

/**
 * Remembers the last few loaded folder/file-set *names* so the user has context
 * for what they viewed before. Persisted to `localStorage`, guarded so the
 * service still works where storage is unavailable (private mode, SSR), mirroring
 * {@link DisclaimerStore}.
 */
@Injectable({ providedIn: 'root' })
export class RecentStore {
  private readonly recent = signal<readonly RecentEntry[]>(readStored());

  /** The recent loads, most recent first, for the toolbar's re-pick list. */
  readonly entries = this.recent.asReadonly();

  /** Record a load at the head of the list (de-duplicated) and persist it. */
  record(entry: RecentEntry): void {
    const next = addRecent(this.recent(), entry, MAX_RECENT);
    this.recent.set(next);
    writeStored(next);
  }
}

/**
 * Prepend `entry`, drop any earlier copy of it (same label and kind), and cap the
 * list at `max`. Pure for unit testing the ordering and de-duplication.
 */
export function addRecent(
  existing: readonly RecentEntry[],
  entry: RecentEntry,
  max: number,
): readonly RecentEntry[] {
  const deduped = existing.filter((e) => e.label !== entry.label || e.kind !== entry.kind);
  return [entry, ...deduped].slice(0, max);
}

/**
 * Derive a recent-list label and picker kind from a selected file set. A folder
 * pick exposes the directory name via `webkitRelativePath` (e.g.
 * `study1/series/img.dcm`); plain file picks show a single name or an "N files"
 * count. Pure for unit testing the labelling.
 */
export function describeSelection(files: readonly File[]): RecentEntry {
  const foldered = files.find((f) => f.webkitRelativePath);
  if (foldered) {
    const folder = foldered.webkitRelativePath.split('/')[0];
    return { label: folder || `${files.length} files`, kind: 'folder' };
  }
  return { label: files.length === 1 ? files[0].name : `${files.length} files`, kind: 'files' };
}

function readStored(): readonly RecentEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentEntry).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function writeStored(entries: readonly RecentEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage is unavailable; the in-memory signal still serves this session.
  }
}

/** Type-guard a parsed value as a {@link RecentEntry}, rejecting stale shapes. */
function isRecentEntry(value: unknown): value is RecentEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['label'] === 'string' && (entry['kind'] === 'folder' || entry['kind'] === 'files')
  );
}
