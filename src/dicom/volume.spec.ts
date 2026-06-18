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
    modality: 'CT',
    rescaleSlope: 1,
    rescaleIntercept: 0,
    windowCenter: null,
    windowWidth: null,
    pixels: new Float32Array([value, value, value, value]),
  };
}

/** A 2×2 sagittal slice at the given x position (columns +y, rows +z). */
function sagittalSlice(x: number, value: number, instanceNumber: number): Slice {
  return {
    name: `slice-${instanceNumber}`,
    columns: 2,
    rows: 2,
    pixelSpacing: [1, 1],
    position: [x, 0, 0],
    orientation: [0, 1, 0, 0, 0, 1],
    instanceNumber,
    modality: 'CT',
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

  it('carries the modality through from the first slice', () => {
    const volume = buildVolume([axialSlice(0, 0, 1), axialSlice(2, 20, 2)]);

    expect(volume.modality).toBe('CT');
  });

  it('records the index→patient geometry from orientation and position', () => {
    const volume = buildVolume([axialSlice(0, 0, 1), axialSlice(2, 0, 2)]);

    expect(volume.geometry).toEqual({
      iStep: [1, 0, 0],
      jStep: [0, 1, 0],
      kStep: [0, 0, 2], // 2 mm inter-slice vector along +z
      origin: [0, 0, 0],
    });
  });

  it('captures permuted axes for a sagittally-acquired stack', () => {
    // Sagittal acquisition: columns run +y (posterior), rows run +z (superior),
    // and the slices step along +x (patient-left).
    const volume = buildVolume([sagittalSlice(0, 0, 1), sagittalSlice(3, 0, 2)]);

    expect(volume.geometry).toEqual({
      iStep: [0, 1, 0],
      jStep: [0, 0, 1],
      kStep: [3, 0, 0],
      origin: [0, 0, 0],
    });
  });

  it('resamples a gapped stack onto a uniform grid, interpolating the gaps', () => {
    // Slices at z = 0, 2, 4, 10: mostly 2 mm apart with a 6 mm gap (missing
    // slices at z = 6 and 8). Each slice is filled with its own z so the
    // interpolation is visible in the data.
    const volume = buildVolume([
      axialSlice(0, 0, 1),
      axialSlice(2, 2, 2),
      axialSlice(4, 4, 3),
      axialSlice(10, 10, 4),
    ]);

    // Median gap is 2 mm; the 10 mm span resamples to 6 uniform layers.
    expect(volume.dims).toEqual([2, 2, 6]);
    expect(volume.spacing[2]).toBe(2);
    expect(volume.geometry?.kStep).toEqual([0, 0, 2]);
    // Layers fall at z = 0,2,4,6,8,10; the two in the gap are interpolated.
    const layerValue = (k: number) => volume.data[k * 4];
    expect([0, 1, 2, 3, 4, 5].map(layerValue)).toEqual([0, 2, 4, 6, 8, 10]);
    // The two synthesized layers are reported, with the largest gap.
    expect(volume.missingSlices).toEqual({ count: 2, maxGapMm: 6 });
  });

  it('reports no missing slices for a uniformly-spaced series', () => {
    const volume = buildVolume([axialSlice(0, 0, 1), axialSlice(2, 10, 2), axialSlice(4, 20, 3)]);

    expect(volume.missingSlices).toBeUndefined();
  });

  it('rejects an empty slice list', () => {
    expect(() => buildVolume([])).toThrow(VolumeBuildError);
  });
});
