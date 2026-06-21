import { orderSlicesThroughPlane, throughPlaneNormal } from './slice-order';
import type { Slice } from './types';

/** A minimal slice carrying just the fields slice-ordering reads. */
function slice(overrides: Partial<Slice> = {}): Slice {
  return {
    name: 'slice',
    columns: 2,
    rows: 2,
    pixelSpacing: [1, 1],
    position: null,
    orientation: null,
    instanceNumber: 0,
    seriesUid: 'series-1',
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
    pixels: new Float32Array(4),
    ...overrides,
  };
}

describe('throughPlaneNormal', () => {
  it('is the unit cross product of the row and column direction cosines', () => {
    const normal = throughPlaneNormal([
      slice({ orientation: [1, 0, 0, 0, 1, 0], position: [0, 0, 0] }),
    ]);
    expect(normal).toEqual([0, 0, 1]);
  });

  it('normalizes a non-unit orientation so the projection is a true distance', () => {
    // Doubled cosines: cross has length 4, the unit normal is still +z.
    const normal = throughPlaneNormal([
      slice({ orientation: [2, 0, 0, 0, 2, 0], position: [0, 0, 0] }),
    ]);
    expect(normal![0]).toBeCloseTo(0);
    expect(normal![1]).toBeCloseTo(0);
    expect(normal![2]).toBeCloseTo(1);
  });

  it('is null when the first slice has no orientation', () => {
    expect(throughPlaneNormal([slice({ position: [0, 0, 0] })])).toBeNull();
  });

  it('is null when any slice has no position', () => {
    const slices = [
      slice({ orientation: [1, 0, 0, 0, 1, 0], position: [0, 0, 0] }),
      slice({ orientation: [1, 0, 0, 0, 1, 0], position: null }),
    ];
    expect(throughPlaneNormal(slices)).toBeNull();
  });
});

describe('orderSlicesThroughPlane', () => {
  it('sorts by ImagePositionPatient projected onto the slice normal', () => {
    const ori = [1, 0, 0, 0, 1, 0];
    const slices = [
      slice({ position: [0, 0, 5], orientation: ori, instanceNumber: 1 }),
      slice({ position: [0, 0, -3], orientation: ori, instanceNumber: 2 }),
      slice({ position: [0, 0, 1], orientation: ori, instanceNumber: 3 }),
    ];
    const ordered = orderSlicesThroughPlane(slices);
    expect(ordered.map((s) => s.position![2])).toEqual([-3, 1, 5]);
  });

  it('tie-breaks co-located slices by InstanceNumber', () => {
    const ori = [1, 0, 0, 0, 1, 0];
    const slices = [
      slice({ position: [0, 0, 0], orientation: ori, instanceNumber: 7 }),
      slice({ position: [0, 0, 0], orientation: ori, instanceNumber: 2 }),
      slice({ position: [0, 0, 0], orientation: ori, instanceNumber: 5 }),
    ];
    const ordered = orderSlicesThroughPlane(slices);
    expect(ordered.map((s) => s.instanceNumber)).toEqual([2, 5, 7]);
  });

  it('falls back to InstanceNumber when spatial metadata is missing', () => {
    const slices = [
      slice({ instanceNumber: 3 }),
      slice({ instanceNumber: 1 }),
      slice({ instanceNumber: 2 }),
    ];
    const ordered = orderSlicesThroughPlane(slices);
    expect(ordered.map((s) => s.instanceNumber)).toEqual([1, 2, 3]);
  });

  it('returns a sorted copy, leaving the input untouched', () => {
    const ori = [1, 0, 0, 0, 1, 0];
    const slices = [
      slice({ position: [0, 0, 5], orientation: ori, instanceNumber: 1 }),
      slice({ position: [0, 0, -3], orientation: ori, instanceNumber: 2 }),
    ];
    const before = [...slices];
    orderSlicesThroughPlane(slices);
    expect(slices).toEqual(before);
  });
});
