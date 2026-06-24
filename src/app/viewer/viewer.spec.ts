import {
  allRoiKeys,
  buildRoiLegend,
  groupRoiLegend,
  dropHeadlineText,
  dropIntentOf,
  filterRawTags,
  isEditableTarget,
  loadingText,
  missingSliceWarning,
  nextCineIndex,
  releaseSelectFocus,
} from './viewer';
import { roiKeyOf } from '../../render/roi-overlay';
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

describe('releaseSelectFocus', () => {
  it('blurs a changed select so shortcuts work again', () => {
    const select = document.createElement('select');
    document.body.append(select);
    select.focus();
    expect(document.activeElement).toBe(select);

    releaseSelectFocus(select);

    expect(document.activeElement).not.toBe(select);
    select.remove();
  });

  it('leaves other controls and null untouched', () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.append(checkbox);
    checkbox.focus();

    releaseSelectFocus(checkbox);
    releaseSelectFocus(null);

    expect(document.activeElement).toBe(checkbox);
    checkbox.remove();
  });
});

describe('filterRawTags', () => {
  const tags: RawTag[] = [
    { tag: '(0010,0010)', name: "Patient's Name", vr: 'PN', value: 'Doe, John' },
    { tag: '(0008,0060)', name: 'Modality', vr: 'CS', value: 'CT' },
    { tag: '(0028,0010)', name: 'Rows', vr: 'US', value: '512' },
  ];

  it('returns every tag for a blank query', () => {
    expect(filterRawTags(tags, '   ')).toBe(tags);
  });

  it('matches on the tag id', () => {
    expect(filterRawTags(tags, '0010,0010').map((t) => t.tag)).toEqual(['(0010,0010)']);
  });

  it('matches on the name, case-insensitively', () => {
    expect(filterRawTags(tags, 'patient').map((t) => t.tag)).toEqual(['(0010,0010)']);
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

  it('reads as cataloguing into history for a plain file drop, not a chip (#241)', () => {
    expect(dropHeadlineText('primary', false)).toBe('Drop to add to the history');
    // A held modifier on a file drop still fuses against the current view.
    expect(dropHeadlineText('overlay', false)).toBe('Drop to fuse as an overlay');
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

  it('carries the ROI number and a promotable flag, defaulting to not promoted', () => {
    const legend = buildRoiLegend(
      [
        set([
          roi({ number: 4 }),
          roi({
            number: 5,
            name: 'Line',
            contours: [{ geometricType: 'OPEN_PLANAR', points: [[0, 0, 0]] }],
          }),
        ]),
      ],
      new Set(),
      noOverrides,
      noOpacities,
      -1,
    );

    expect(legend[0]).toMatchObject({ roiNumber: 4, promotable: true, promoted: false });
    expect(legend[1]).toMatchObject({ roiNumber: 5, promotable: false }); // polyline only
  });

  it('marks an ROI promoted when its key is in the promoted set', () => {
    const key = roiKeyOf(0, 1);
    const legend = buildRoiLegend(
      [set([roi({})])],
      new Set(),
      noOverrides,
      noOpacities,
      -1,
      new Set([key]),
    );

    expect(legend[0].promoted).toBe(true);
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

describe('groupRoiLegend', () => {
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

  it('groups the legend rows by structure set, labelled by the set, in order', () => {
    const sets = [
      set([roi({ number: 1 })], { label: 'Plan A' }),
      set([roi({ number: 1, name: 'Liver' }), roi({ number: 2, name: 'Lung' })], {
        label: 'Plan B',
      }),
    ];
    const legend = buildRoiLegend(sets, new Set(), noOverrides, noOpacities, -1);

    const groups = groupRoiLegend(legend, sets);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ setIndex: 0, label: 'Plan A' });
    expect(groups[0].entries.map((e) => e.key)).toEqual(['0:1']);
    expect(groups[1]).toMatchObject({ setIndex: 1, label: 'Plan B' });
    expect(groups[1].entries.map((e) => e.key)).toEqual(['1:1', '1:2']);
  });

  it('falls back to the file name, then a numbered label, when the set label is blank', () => {
    const sets = [
      set([roi({})], { label: null, name: 'rt.dcm' }),
      set([roi({})], { label: null, name: '' }),
    ];
    const legend = buildRoiLegend(sets, new Set(), noOverrides, noOpacities, -1);

    const groups = groupRoiLegend(legend, sets);

    expect(groups.map((g) => g.label)).toEqual(['rt.dcm', 'Structure set 2']);
  });

  it('yields a single group when only one set has drawable ROIs', () => {
    const sets = [set([roi({})], { label: 'Only' })];
    const legend = buildRoiLegend(sets, new Set(), noOverrides, noOpacities, -1);

    const groups = groupRoiLegend(legend, sets);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Only');
  });

  it('is empty when the legend has no rows', () => {
    expect(groupRoiLegend([], [])).toEqual([]);
  });
});

describe('allRoiKeys', () => {
  const oneContour: Contour[] = [{ geometricType: 'CLOSED_PLANAR', points: [[0, 0, 0]] }];

  const roi = (over: Partial<Roi>): Roi => ({
    number: 1,
    name: 'Heart',
    color: [255, 0, 0],
    interpretedType: 'ORGAN',
    contours: oneContour,
    ...over,
  });

  const set = (rois: Roi[]): StructureSet => ({
    name: 'ss.dcm',
    label: 'Plan',
    frameOfReferenceUid: 'for-1',
    referencedSeriesUids: [],
    rois,
  });

  it('collects every drawable ROI key, qualified by structure-set index', () => {
    const keys = allRoiKeys([
      set([roi({ number: 1 }), roi({ number: 2 })]),
      set([roi({ number: 1, name: 'Liver' })]),
    ]);

    expect(keys).toEqual(new Set(['0:1', '0:2', '1:1']));
  });

  it('skips ROIs that carry no contours, matching the legend', () => {
    const keys = allRoiKeys([set([roi({ number: 1 }), roi({ number: 2, contours: [] })])]);

    expect(keys).toEqual(new Set(['0:1']));
  });

  it('is empty when no structure sets are loaded', () => {
    expect(allRoiKeys([])).toEqual(new Set());
  });
});
