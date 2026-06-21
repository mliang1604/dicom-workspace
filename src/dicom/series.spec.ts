import { groupSeries, largestSeries, middleSlice } from './series';
import type { Slice } from './types';

/** A minimal slice carrying just the series-grouping fields under test. */
function slice(seriesUid: string | null, overrides: Partial<Slice> = {}): Slice {
  return {
    name: 'slice',
    columns: 4,
    rows: 4,
    pixelSpacing: [1, 1],
    position: null,
    orientation: null,
    instanceNumber: 0,
    seriesUid,
    seriesNumber: null,
    seriesDescription: null,
    frameOfReferenceUid: null,
    studyUid: null,
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    patientId: null,
    patientName: null,
    modality: null,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    windowCenter: null,
    windowWidth: null,
    pixels: new Float32Array(16),
    ...overrides,
  };
}

describe('groupSeries', () => {
  it('splits slices into one group per SeriesInstanceUID', () => {
    const series = groupSeries([slice('a'), slice('b'), slice('a')]);

    expect(series).toHaveLength(2);
    expect(series.map((s) => s.uid).sort()).toEqual(['a', 'b']);
    expect(series.find((s) => s.uid === 'a')?.imageCount).toBe(2);
    expect(series.find((s) => s.uid === 'b')?.imageCount).toBe(1);
  });

  it('takes the descriptor fields and dims from each series first slice', () => {
    const series = groupSeries([
      slice('a', {
        seriesNumber: 3,
        seriesDescription: 'Axial CT',
        modality: 'CT',
        columns: 512,
        rows: 256,
      }),
    ]);

    expect(series[0]).toMatchObject({
      uid: 'a',
      seriesNumber: 3,
      description: 'Axial CT',
      modality: 'CT',
      imageCount: 1,
      dims: [512, 256],
    });
  });

  it('orders series by SeriesNumber ascending, those without a number last', () => {
    const series = groupSeries([
      slice('c', { seriesNumber: null }),
      slice('a', { seriesNumber: 5 }),
      slice('b', { seriesNumber: 2 }),
    ]);

    expect(series.map((s) => s.uid)).toEqual(['b', 'a', 'c']);
  });

  it('groups slices that carry no UID into one unnamed series', () => {
    const series = groupSeries([slice(null), slice(null)]);

    expect(series).toHaveLength(1);
    expect(series[0].uid).toBe('');
    expect(series[0].imageCount).toBe(2);
  });

  it('keeps each series slices in encounter order', () => {
    const a1 = slice('a', { instanceNumber: 1 });
    const a2 = slice('a', { instanceNumber: 2 });
    const series = groupSeries([a2, slice('b'), a1]);

    expect(series.find((s) => s.uid === 'a')?.slices).toEqual([a2, a1]);
  });

  it('returns an empty list for no slices', () => {
    expect(groupSeries([])).toEqual([]);
  });
});

describe('largestSeries', () => {
  it('picks the series with the most images', () => {
    const series = groupSeries([slice('a'), slice('b'), slice('b'), slice('b'), slice('a')]);

    expect(largestSeries(series).uid).toBe('b');
  });

  it('breaks an image-count tie by picker order (lower SeriesNumber)', () => {
    const series = groupSeries([
      slice('hi', { seriesNumber: 9 }),
      slice('lo', { seriesNumber: 1 }),
    ]);

    expect(largestSeries(series).uid).toBe('lo');
  });
});

describe('middleSlice', () => {
  it('returns null for a series with no slices', () => {
    const series = groupSeries([slice('a')]);
    expect(middleSlice({ ...series[0], slices: [] })).toBeNull();
  });

  it('returns the central slice by InstanceNumber when there is no spatial metadata', () => {
    const [series] = groupSeries([
      slice('a', { instanceNumber: 3, name: 'three' }),
      slice('a', { instanceNumber: 1, name: 'one' }),
      slice('a', { instanceNumber: 2, name: 'two' }),
    ]);

    expect(middleSlice(series)?.name).toBe('two');
  });

  it('orders by ImagePositionPatient along the slice normal when present', () => {
    const orientation = [1, 0, 0, 0, 1, 0]; // normal is +z
    const at = (z: number, name: string) => slice('a', { orientation, position: [0, 0, z], name });
    // Encounter order is shuffled; the middle by z is the one at z=5.
    const [series] = groupSeries([at(9, 'top'), at(1, 'bottom'), at(5, 'middle')]);

    expect(middleSlice(series)?.name).toBe('middle');
  });

  it('does not reorder the series own slice array', () => {
    const [series] = groupSeries([
      slice('a', { instanceNumber: 3, name: 'three' }),
      slice('a', { instanceNumber: 1, name: 'one' }),
    ]);
    const before = series.slices.map((s) => s.name);

    middleSlice(series);

    expect(series.slices.map((s) => s.name)).toEqual(before);
  });
});
