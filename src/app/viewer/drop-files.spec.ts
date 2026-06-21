import { collectEntry, labelFor } from './drop-files';

/** A File stub carrying only the `name` the labelling/collection reads. */
function file(name: string): File {
  return { name } as File;
}

/** A directory `FileSystemEntry` for the pure {@link labelFor} cases. */
function dirEntry(name: string): FileSystemEntry {
  return { name, isFile: false, isDirectory: true } as FileSystemEntry;
}

/** A file `FileSystemEntry` for the pure {@link labelFor} cases. */
function fileEntry(name: string): FileSystemEntry {
  return { name, isFile: true, isDirectory: false } as FileSystemEntry;
}

describe('labelFor', () => {
  it('uses the folder name when a directory was dropped', () => {
    const entries = [dirEntry('study1')];
    expect(labelFor(entries, [file('a.dcm'), file('b.dcm')])).toEqual({
      label: 'study1',
      kind: 'folder',
    });
  });

  it('uses the single file name for a one-file drop', () => {
    expect(labelFor([fileEntry('scan.dcm')], [file('scan.dcm')])).toEqual({
      label: 'scan.dcm',
      kind: 'files',
    });
  });

  it('counts a multi-file drop', () => {
    const files = [file('a.dcm'), file('b.dcm'), file('c.dcm')];
    expect(labelFor([fileEntry('a.dcm')], files)).toEqual({ label: '3 files', kind: 'files' });
  });

  it('returns null when nothing loadable was dropped', () => {
    expect(labelFor([fileEntry('a.dcm')], [])).toBeNull();
  });
});

/** A readable file entry that resolves to {@link f}. */
function readableFileEntry(name: string, f: File): FileSystemFileEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (resolve: (file: File) => void) => resolve(f),
  } as unknown as FileSystemFileEntry;
}

/** A file entry whose read fails, exercising the skipped-file branch. */
function unreadableFileEntry(name: string): FileSystemFileEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (_resolve: (file: File) => void, reject: () => void) => reject(),
  } as unknown as FileSystemFileEntry;
}

/**
 * A directory entry whose reader yields {@link children} in one batch, then an
 * empty batch to signal the end — matching the `readEntries` contract the walk
 * loops on.
 */
function dirEntryWith(name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let drained = false;
      return {
        readEntries: (success: (entries: FileSystemEntry[]) => void) => {
          if (drained) return success([]);
          drained = true;
          success(children);
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

describe('collectEntry', () => {
  it('walks a nested directory tree, collecting every file in order', async () => {
    const a = file('a.dcm');
    const b = file('b.dcm');
    const c = file('c.dcm');
    const series = dirEntryWith('series', [
      readableFileEntry('b.dcm', b),
      readableFileEntry('c.dcm', c),
    ]);
    const root = dirEntryWith('study', [readableFileEntry('a.dcm', a), series]);

    const out: File[] = [];
    await collectEntry(root, out);

    expect(out).toEqual([a, b, c]);
  });

  it('collects a single file entry', async () => {
    const f = file('scan.dcm');
    const out: File[] = [];
    await collectEntry(readableFileEntry('scan.dcm', f), out);
    expect(out).toEqual([f]);
  });

  it('skips files that cannot be read', async () => {
    const ok = file('ok.dcm');
    const root = dirEntryWith('study', [
      unreadableFileEntry('bad.dcm'),
      readableFileEntry('ok.dcm', ok),
    ]);

    const out: File[] = [];
    await collectEntry(root, out);

    expect(out).toEqual([ok]);
  });
});
