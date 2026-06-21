import { describeSelection, type RecentEntry } from '../recent-store';

/** The files pulled from a drop, plus a recent-list entry describing the source. */
export interface DroppedFiles {
  /** Every file found, with folders walked recursively. */
  readonly files: File[];
  /** Label/kind for the recent list, or null when nothing usable was dropped. */
  readonly entry: RecentEntry | null;
}

/**
 * Collect the files from a drop's {@link DataTransfer}. Folders are walked
 * recursively via the `webkitGetAsEntry` filesystem API so dropping a study
 * directory loads every slice in it; where that API is missing the plain
 * `dataTransfer.files` list is used as a flat fallback (files only, no folders).
 */
export async function readDropped(dataTransfer: DataTransfer): Promise<DroppedFiles> {
  const entries = entriesOf(dataTransfer);
  if (entries.length === 0) {
    const files = dataTransfer.files ? Array.from(dataTransfer.files) : [];
    return { files, entry: files.length ? describeSelection(files) : null };
  }
  const files: File[] = [];
  for (const entry of entries) await collectEntry(entry, files);
  return { files, entry: labelFor(entries, files) };
}

/** The top-level filesystem entries of a drop, or [] when the API is unavailable. */
function entriesOf(dataTransfer: DataTransfer): FileSystemEntry[] {
  const items = dataTransfer.items;
  if (!items) return [];
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Append `entry`'s files to `out`, recursing into directories. */
export async function collectEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await fileOf(entry as FileSystemFileEntry);
    if (file) out.push(file);
  } else if (entry.isDirectory) {
    for (const child of await readDir(entry as FileSystemDirectoryEntry)) {
      await collectEntry(child, out);
    }
  }
}

/** Resolve a file entry's {@link File}, or null if it can't be read. */
function fileOf(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

/**
 * Read every child of a directory entry. `readEntries` yields children in
 * batches and signals the end with an empty batch, so it's called in a loop.
 */
function readDir(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve) => {
    const readBatch = () =>
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) return resolve(all);
          all.push(...batch);
          readBatch();
        },
        () => resolve(all),
      );
    readBatch();
  });
}

/**
 * Label a drop for the recent list: a dropped folder uses its directory name; a
 * flat set of files uses a single name or an "N files" count. Returns null when
 * nothing loadable was dropped.
 */
export function labelFor(
  entries: readonly FileSystemEntry[],
  files: readonly File[],
): RecentEntry | null {
  if (files.length === 0) return null;
  const dir = entries.find((e) => e.isDirectory);
  if (dir) return { label: dir.name, kind: 'folder' };
  if (files.length === 1) return { label: files[0].name, kind: 'files' };
  return { label: `${files.length} files`, kind: 'files' };
}
