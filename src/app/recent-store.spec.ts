import { addRecent, describeSelection, type RecentEntry } from './recent-store';

/** A stand-in File carrying only the fields {@link describeSelection} reads. */
function file(name: string, webkitRelativePath = ''): File {
  return { name, webkitRelativePath } as File;
}

describe('describeSelection', () => {
  it('uses the folder name from a directory pick', () => {
    const files = [file('a.dcm', 'study1/series/a.dcm'), file('b.dcm', 'study1/series/b.dcm')];
    expect(describeSelection(files)).toEqual({ label: 'study1', kind: 'folder' });
  });

  it('uses the single file name for a one-file pick', () => {
    expect(describeSelection([file('scan.dcm')])).toEqual({ label: 'scan.dcm', kind: 'files' });
  });

  it('counts a multi-file pick', () => {
    expect(describeSelection([file('a.dcm'), file('b.dcm'), file('c.dcm')])).toEqual({
      label: '3 files',
      kind: 'files',
    });
  });
});

describe('addRecent', () => {
  const folder = (label: string): RecentEntry => ({ label, kind: 'folder' });

  it('prepends the newest entry', () => {
    const list = addRecent([folder('a')], folder('b'), 5);
    expect(list.map((e) => e.label)).toEqual(['b', 'a']);
  });

  it('de-duplicates an entry with the same label and kind, moving it to the front', () => {
    const list = addRecent([folder('a'), folder('b')], folder('b'), 5);
    expect(list).toEqual([folder('b'), folder('a')]);
  });

  it('keeps entries that share a label but differ in kind', () => {
    const list = addRecent([{ label: 'a', kind: 'files' }], folder('a'), 5);
    expect(list).toEqual([folder('a'), { label: 'a', kind: 'files' }]);
  });

  it('caps the list at the maximum, dropping the oldest', () => {
    const list = addRecent([folder('c'), folder('b'), folder('a')], folder('d'), 3);
    expect(list.map((e) => e.label)).toEqual(['d', 'c', 'b']);
  });
});
