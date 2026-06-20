import { loadingText, missingSliceWarning } from './viewer';

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
