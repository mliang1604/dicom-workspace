import type { Slice, VolumeGeometry } from './types';
import { buildVolume, patientToVoxel, VolumeBuildError } from './volume';

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
    seriesUid: 'series-1',
    seriesNumber: 1,
    frameOfReferenceUid: null,
    seriesDescription: 'Axial',
    studyUid: null,
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    patientId: null,
    patientName: null,
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
    seriesUid: 'series-1',
    seriesNumber: 1,
    frameOfReferenceUid: null,
    seriesDescription: 'Sagittal',
    studyUid: null,
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    patientId: null,
    patientName: null,
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

  it('caps the resample depth for a tiny median gap against a large span', () => {
    // Pathological geometry: four slices clustered 0.1 mm apart with one stray
    // 100 mm away (gantry jitter / a bad ImagePositionPatient). The median gap is
    // 0.1 mm, so an uncapped grid would allocate ~1000 layers to span 100 mm.
    const volume = buildVolume([
      axialSlice(0, 0, 1),
      axialSlice(0.1, 1, 2),
      axialSlice(0.2, 2, 3),
      axialSlice(100, 100, 4),
    ]);

    // Depth is clamped to 16× the acquired slice count instead of ~1000.
    expect(volume.dims[2]).toBe(4 * 16);
    // The pitch widens to still span the full 100 mm range at the capped depth.
    expect(volume.spacing[2]).toBeCloseTo(100 / (4 * 16 - 1), 6);
    expect(volume.geometry?.kStep[2]).toBeCloseTo(100 / (4 * 16 - 1), 6);
    // The clamp is reported through MissingSlices rather than silently allocating.
    expect(volume.missingSlices?.count).toBe(4 * 16 - 4);
    expect(volume.missingSlices?.maxGapMm).toBeCloseTo(99.8, 6);
  });

  it('reports no missing slices for a uniformly-spaced series', () => {
    const volume = buildVolume([axialSlice(0, 0, 1), axialSlice(2, 10, 2), axialSlice(4, 20, 3)]);

    expect(volume.missingSlices).toBeUndefined();
  });

  it('rejects an empty slice list', () => {
    expect(() => buildVolume([])).toThrow(VolumeBuildError);
  });
});

describe('patientToVoxel', () => {
  it('inverts an axis-aligned placement with spacing and origin', () => {
    // 1×2×3 mm voxels, origin at patient (10, 20, 30).
    const geometry: VolumeGeometry = {
      iStep: [1, 0, 0],
      jStep: [0, 2, 0],
      kStep: [0, 0, 3],
      origin: [10, 20, 30],
    };
    expect(patientToVoxel(geometry, [10, 20, 30])).toEqual([0, 0, 0]); // the origin voxel
    expect(patientToVoxel(geometry, [13, 28, 45])).toEqual([3, 4, 5]);
  });

  it('round-trips the forward placement for an oblique geometry', () => {
    // A rotated, anisotropic frame: the inverse of `origin + i·iStep + j·jStep + k·kStep`.
    const geometry: VolumeGeometry = {
      iStep: [0.6, 0.8, 0],
      jStep: [-0.8, 0.6, 0],
      kStep: [0, 0, 2.5],
      origin: [-5, 7, 12],
    };
    const [i, j, k] = [4, 9, 6];
    const patient = [
      geometry.origin[0] + i * geometry.iStep[0] + j * geometry.jStep[0] + k * geometry.kStep[0],
      geometry.origin[1] + i * geometry.iStep[1] + j * geometry.jStep[1] + k * geometry.kStep[1],
      geometry.origin[2] + i * geometry.iStep[2] + j * geometry.jStep[2] + k * geometry.kStep[2],
    ] as const;

    const voxel = patientToVoxel(geometry, patient)!;
    expect(voxel[0]).toBeCloseTo(i, 9);
    expect(voxel[1]).toBeCloseTo(j, 9);
    expect(voxel[2]).toBeCloseTo(k, 9);
  });

  it('agrees with the geometry buildVolume derives for a series', () => {
    // The volume's first voxel sits at its origin; one slice up the normal is k=1.
    const volume = buildVolume([axialSlice(0, 0, 1), axialSlice(2, 10, 2)]);
    const geometry = volume.geometry!;
    expect(patientToVoxel(geometry, geometry.origin)).toEqual([0, 0, 0]);
    expect(patientToVoxel(geometry, [0, 0, 2])![2]).toBeCloseTo(1, 9); // second slice
  });

  it('returns null for a singular geometry', () => {
    const geometry: VolumeGeometry = {
      iStep: [1, 0, 0],
      jStep: [2, 0, 0], // parallel to iStep — collapses the map
      kStep: [0, 0, 1],
      origin: [0, 0, 0],
    };
    expect(patientToVoxel(geometry, [1, 1, 1])).toBeNull();
  });
});
