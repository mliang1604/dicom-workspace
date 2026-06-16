import type { Slice } from './types';
import { buildVolume, VolumeBuildError } from './volume';

/** A 2×2 axial slice at the given z position, filled with a constant value. */
function axialSlice(z: number, value: number, instanceNumber: number): Slice {
  return {
    name: `slice-${instanceNumber}`,
    columns: 2,
    rows: 2,
    pixelSpacing: [1, 1],
    position: [0, 0, z],
    orientation: [1, 0, 0, 0, 1, 0],
    instanceNumber,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    windowCenter: null,
    windowWidth: null,
    pixels: new Float32Array([value, value, value, value]),
  };
}

describe('buildVolume', () => {
  it('orders slices by position along the slice normal', () => {
    const outOfOrder = [axialSlice(4, 20, 3), axialSlice(0, 0, 1), axialSlice(2, 10, 2)];

    const volume = buildVolume(outOfOrder);

    expect(volume.dims).toEqual([2, 2, 3]);
    expect(volume.data[0]).toBe(0); // first slice
    expect(volume.data[4]).toBe(10); // middle slice
    expect(volume.data[8]).toBe(20); // last slice
  });

  it('derives spacing from pixel spacing and the inter-slice gap', () => {
    const volume = buildVolume([axialSlice(0, 0, 1), axialSlice(2, 0, 2)]);

    expect(volume.spacing).toEqual([1, 1, 2]);
  });

  it('derives a default window from the value range when the file has none', () => {
    const volume = buildVolume([axialSlice(0, 0, 1), axialSlice(2, 20, 2)]);

    expect(volume.min).toBe(0);
    expect(volume.max).toBe(20);
    expect(volume.windowWidth).toBe(20);
    expect(volume.windowCenter).toBe(10);
  });

  it('rejects an empty slice list', () => {
    expect(() => buildVolume([])).toThrow(VolumeBuildError);
  });
});
