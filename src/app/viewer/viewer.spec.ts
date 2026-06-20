import { filterRawTags, loadingText, missingSliceWarning, nextCineIndex } from './viewer';
import type { RawTag } from '../../dicom/metadata';

describe('loadingText', () => {
  it('falls back to an indeterminate label before the file count is known', () => {
    expect(loadingText(0, 0)).toBe('Loading…');
  });

  it('reports files parsed of the total with a percentage', () => {
    expect(loadingText(0, 200)).toBe('Loading… 0 / 200 files (0%)');
    expect(loadingText(50, 200)).toBe('Loading… 50 / 200 files (25%)');
    expect(loadingText(200, 200)).toBe('Loading… 200 / 200 files (100%)');
  });

  it('rounds the percentage to a whole number', () => {
    expect(loadingText(1, 3)).toBe('Loading… 1 / 3 files (33%)');
  });
});

describe('missingSliceWarning', () => {
  it('is silent when no slices were interpolated', () => {
    expect(missingSliceWarning(undefined, 2.5)).toBeNull();
  });

  it('is silent for a gap within twice the slice spacing', () => {
    // A single missing slice (gap = 2× spacing) interpolates cleanly.
    expect(missingSliceWarning({ count: 1, maxGapMm: 5 }, 2.5)).toBeNull();
  });

  it('warns for a gap wider than twice the slice spacing', () => {
    const warning = missingSliceWarning({ count: 62, maxGapMm: 100 }, 2.5);

    expect(warning).toContain('62 missing slices');
    expect(warning).toContain('100 mm');
    expect(warning).toContain('not acquired');
  });

  it('uses the singular for a single interpolated slice', () => {
    const warning = missingSliceWarning({ count: 1, maxGapMm: 6 }, 2);

    expect(warning).toContain('1 missing slice ');
    expect(warning).not.toContain('slices');
  });
});

describe('nextCineIndex', () => {
  it('advances one slice at a time', () => {
    expect(nextCineIndex(0, 10, 1)).toBe(1);
    expect(nextCineIndex(4, 10, 1)).toBe(5);
  });

  it('loops back to the first slice past the end', () => {
    expect(nextCineIndex(9, 10, 1)).toBe(0);
  });

  it('loops back to the last slice before the start', () => {
    expect(nextCineIndex(0, 10, -1)).toBe(9);
    expect(nextCineIndex(5, 10, -1)).toBe(4);
  });

  it('stays put when there is nothing to cine', () => {
    // A single slice (or none) has nowhere to advance.
    expect(nextCineIndex(0, 1, 1)).toBe(0);
    expect(nextCineIndex(0, 0, 1)).toBe(0);
  });

  it('clamps an out-of-range index for a degenerate stack', () => {
    expect(nextCineIndex(5, 1, 1)).toBe(0);
  });
});

describe('filterRawTags', () => {
  const tags: RawTag[] = [
    { tag: '(0010,0010)', vr: 'PN', value: 'Doe, John' },
    { tag: '(0008,0060)', vr: 'CS', value: 'CT' },
    { tag: '(0028,0010)', vr: 'US', value: '512' },
  ];

  it('returns every tag for a blank query', () => {
    expect(filterRawTags(tags, '   ')).toBe(tags);
  });

  it('matches on the tag id', () => {
    expect(filterRawTags(tags, '0010,0010').map((t) => t.tag)).toEqual(['(0010,0010)']);
  });

  it('matches on the VR, case-insensitively', () => {
    expect(filterRawTags(tags, 'cs').map((t) => t.tag)).toEqual(['(0008,0060)']);
  });

  it('matches on the value', () => {
    expect(filterRawTags(tags, 'doe').map((t) => t.tag)).toEqual(['(0010,0010)']);
  });

  it('returns nothing when there is no match', () => {
    expect(filterRawTags(tags, 'zzz')).toEqual([]);
  });
});
