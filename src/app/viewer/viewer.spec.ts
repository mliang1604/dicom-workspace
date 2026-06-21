import {
  buildRoiLegend,
  cantFuseMessage,
  dropHeadlineText,
  dropIntentOf,
  filterRawTags,
  isEditableTarget,
  loadingText,
  missingSliceWarning,
  nextCineIndex,
  roiKeyOf,
} from './viewer';
import type { RawTag } from '../../dicom/metadata';
import type { Contour, Roi, StructureSet } from '../../dicom/types';

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

describe('isEditableTarget', () => {
  it('guards text inputs, selects, and textareas so typing wins over shortcuts', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
  });

  it('guards contenteditable hosts', () => {
    // jsdom doesn't derive isContentEditable from the attribute, so stub the getter
    // the real-browser code path reads.
    const host = document.createElement('div');
    Object.defineProperty(host, 'isContentEditable', { value: true });
    expect(isEditableTarget(host)).toBe(true);
  });

  it('lets shortcuts through for non-editable targets and null', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(document.createElement('canvas'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
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

describe('dropIntentOf', () => {
  it('loads as primary with no modifier held', () => {
    expect(dropIntentOf({ altKey: false, shiftKey: false })).toBe('primary');
  });

  it('forces a fusion overlay when ⌥/Alt is held', () => {
    expect(dropIntentOf({ altKey: true, shiftKey: false })).toBe('overlay');
  });

  it('adds a compare column when ⇧/Shift is held', () => {
    expect(dropIntentOf({ altKey: false, shiftKey: true })).toBe('compare');
  });

  it('lets ⌥ overlay win when both modifiers are held', () => {
    expect(dropIntentOf({ altKey: true, shiftKey: true })).toBe('overlay');
  });
});

describe('dropHeadlineText', () => {
  it('reflects the held modifier in the drop overlay headline', () => {
    expect(dropHeadlineText('primary')).toBe('Drop to load as primary');
    expect(dropHeadlineText('overlay')).toBe('Drop to fuse as an overlay');
    expect(dropHeadlineText('compare')).toBe('Drop to add a compare column');
  });
});

describe('cantFuseMessage', () => {
  it('names the action that could not apply and the frame-of-reference reason', () => {
    expect(cantFuseMessage('overlay')).toContain('fuse');
    expect(cantFuseMessage('compare')).toContain('compare');
    expect(cantFuseMessage('overlay')).toContain('frame of reference');
  });
});

describe('buildRoiLegend', () => {
  const oneContour: Contour[] = [{ geometricType: 'CLOSED_PLANAR', points: [[0, 0, 0]] }];

  const roi = (over: Partial<Roi>): Roi => ({
    number: 1,
    name: 'Heart',
    color: [255, 0, 0],
    interpretedType: 'ORGAN',
    contours: oneContour,
    ...over,
  });

  const set = (rois: Roi[], over: Partial<StructureSet> = {}): StructureSet => ({
    name: 'ss.dcm',
    label: 'Plan',
    frameOfReferenceUid: 'for-1',
    referencedSeriesUids: [],
    rois,
    ...over,
  });

  const noOverrides = new Map<string, string>();
  const noOpacities = new Map<string, number>();

  it('lists each ROI with its name, interpreted type and display colour', () => {
    const legend = buildRoiLegend([set([roi({})])], new Set(), noOverrides, noOpacities, -1);

    expect(legend).toHaveLength(1);
    expect(legend[0]).toMatchObject({
      key: '0:1',
      setIndex: 0,
      name: 'Heart',
      type: 'ORGAN',
      color: 'rgb(255, 0, 0)',
      colorHex: '#ff0000',
      opacityPercent: 100,
      visible: true,
    });
  });

  it('skips ROIs that carry no contours', () => {
    const legend = buildRoiLegend(
      [set([roi({ number: 2, contours: [] })])],
      new Set(),
      noOverrides,
      noOpacities,
      -1,
    );

    expect(legend).toEqual([]);
  });

  it('falls back to a numbered name and uppercases the interpreted type', () => {
    const legend = buildRoiLegend(
      [set([roi({ number: 7, name: '', interpretedType: 'ptv' })])],
      new Set(),
      noOverrides,
      noOpacities,
      -1,
    );

    expect(legend[0].name).toBe('ROI 7');
    expect(legend[0].type).toBe('PTV');
  });

  it('reports a missing colour as a neutral grey', () => {
    const legend = buildRoiLegend(
      [set([roi({ color: null })])],
      new Set(),
      noOverrides,
      noOpacities,
      -1,
    );

    expect(legend[0].color).toBe('rgb(200, 200, 200)');
    expect(legend[0].colorHex).toBe('#c8c8c8');
  });

  it('marks hidden ROIs and applies colour and opacity overrides', () => {
    const key = roiKeyOf(0, 1);
    const legend = buildRoiLegend(
      [set([roi({})])],
      new Set([key]),
      new Map([[key, '#00ff00']]),
      new Map([[key, 0.4]]),
      -1,
    );

    expect(legend[0].visible).toBe(false);
    expect(legend[0].color).toBe('#00ff00');
    expect(legend[0].colorHex).toBe('#00ff00');
    expect(legend[0].opacityPercent).toBe(40);
  });

  it('qualifies the key by structure-set index so equal ROI numbers never collide', () => {
    const legend = buildRoiLegend(
      [set([roi({ number: 1 })]), set([roi({ number: 1, name: 'Liver' })])],
      new Set(),
      noOverrides,
      noOpacities,
      -1,
    );

    expect(legend.map((e) => e.key)).toEqual(['0:1', '1:1']);
  });

  it('filters to a single structure set when one is selected', () => {
    const legend = buildRoiLegend(
      [set([roi({ number: 1 })]), set([roi({ number: 1, name: 'Liver' })])],
      new Set(),
      noOverrides,
      noOpacities,
      1,
    );

    expect(legend).toHaveLength(1);
    expect(legend[0]).toMatchObject({ key: '1:1', name: 'Liver' });
  });
});
