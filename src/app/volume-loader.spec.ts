import { baseImageLayer, type Volume } from '../dicom/types';
import type { Series } from '../dicom/series';
import { mergeLoad, type LoadResult } from './volume-loader';

/** A minimal volume; the merge only reads it through the layer it wraps. */
function fakeVolume(modality: string | null): Volume {
  return {
    dims: [1, 1, 1],
    spacing: [1, 1, 1],
    data: new Float32Array(1),
    min: 0,
    max: 1,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality,
  };
}

/** A minimal series; only the UID and frame of reference drive the merge rule. */
function fakeSeries(uid: string, frameOfReferenceUid: string | null, modality = 'CT'): Series {
  return {
    uid,
    seriesNumber: 1,
    description: null,
    modality,
    frameOfReferenceUid,
    imageCount: 1,
    dims: [1, 1],
    metadata: null,
    slices: [],
  };
}

/** A one-layer load of a single series, as {@link VolumeLoader.loadFromFiles} returns. */
function fakeLoad(uid: string, frameOfReferenceUid: string | null, modality = 'CT'): LoadResult {
  const series = fakeSeries(uid, frameOfReferenceUid, modality);
  return {
    series: [series],
    selectedUid: uid,
    layers: [baseImageLayer(uid, fakeVolume(modality))],
    structureSets: [],
    allStructureSets: [],
    fileCount: 1,
    sliceCount: 1,
  };
}

describe('mergeLoad', () => {
  it('adds the incoming series as an overlay when its frame of reference matches', () => {
    const current = fakeLoad('ct', 'frame-1');
    const incoming = fakeLoad('mr', 'frame-1', 'MR');

    const { result, added } = mergeLoad(current, incoming);

    expect(added).toBe(true);
    expect(result.layers.map((l) => [l.id, l.role])).toEqual([
      ['ct', 'base'],
      ['mr', 'overlay'],
    ]);
    // The base study's fields are kept; only the registry grew.
    expect(result.selectedUid).toBe('ct');
    expect(result.series).toBe(current.series);
  });

  it('replaces when the frames of reference differ (a new study)', () => {
    const current = fakeLoad('ct', 'frame-1');
    const incoming = fakeLoad('ct2', 'frame-2');

    const { result, added } = mergeLoad(current, incoming);

    expect(added).toBe(false);
    expect(result).toBe(incoming);
  });

  it('replaces when either series has no frame of reference', () => {
    expect(mergeLoad(fakeLoad('a', null), fakeLoad('b', null)).added).toBe(false);
    expect(mergeLoad(fakeLoad('a', 'frame-1'), fakeLoad('b', null)).added).toBe(false);
    expect(mergeLoad(fakeLoad('a', null), fakeLoad('b', 'frame-1')).added).toBe(false);
  });

  it('stacks a third same-frame series above the existing overlay', () => {
    const base = fakeLoad('ct', 'frame-1');
    const withOverlay = mergeLoad(base, fakeLoad('mr', 'frame-1', 'MR')).result;

    const { result, added } = mergeLoad(withOverlay, fakeLoad('pet', 'frame-1', 'PT'));

    expect(added).toBe(true);
    expect(result.layers.map((l) => l.id)).toEqual(['ct', 'mr', 'pet']);
  });

  it('keeps overlay ids unique when the same series is added twice', () => {
    const base = fakeLoad('ct', 'frame-1');
    const once = mergeLoad(base, fakeLoad('mr', 'frame-1', 'MR')).result;

    const { result } = mergeLoad(once, fakeLoad('mr', 'frame-1', 'MR'));

    expect(result.layers.map((l) => l.id)).toEqual(['ct', 'mr', 'mr#2']);
  });

  it('does not mutate the current registry', () => {
    const current = fakeLoad('ct', 'frame-1');
    mergeLoad(current, fakeLoad('mr', 'frame-1', 'MR'));
    expect(current.layers.map((l) => l.id)).toEqual(['ct']);
  });
});
