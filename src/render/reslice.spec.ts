import { Orientation, type Volume, type VolumeGeometry } from '../dicom/types';
import { planeExtentMm, planeToTex, sliceCountFor, texCoordAt } from './reslice';

function makeVolume(dims: [number, number, number], geometry?: VolumeGeometry): Volume {
  const [x, y, z] = dims;
  return {
    dims,
    spacing: [1, 1, 1],
    data: new Float32Array(x * y * z),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry,
  };
}

function expectVec(actual: readonly number[], expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
}

describe('planeToTex', () => {
  it('reproduces the legacy axis mapping when geometry is identity', () => {
    // No geometry → acquisition axes treated as patient axes (the old behaviour).
    const volume = makeVolume([4, 4, 4]);

    // Axial: coord = (u, v, slicePos).
    expectVec(texCoordAt(planeToTex(volume, Orientation.Axial), 0.2, 0.3, 0.7), [0.2, 0.3, 0.7]);
    // Coronal: coord = (u, slicePos, 1 - v) — superior up.
    expectVec(texCoordAt(planeToTex(volume, Orientation.Coronal), 0.2, 0.3, 0.7), [0.2, 0.7, 0.7]);
    // Sagittal: coord = (slicePos, u, 1 - v).
    expectVec(texCoordAt(planeToTex(volume, Orientation.Sagittal), 0.2, 0.3, 0.7), [0.7, 0.2, 0.7]);
  });

  it('reslices true anatomical planes for a sagittally-acquired volume', () => {
    // Columns run +Y (posterior), rows run -Z (inferior), slices run +X (left):
    // the acquisition axes are a permutation of the patient axes.
    const geometry: VolumeGeometry = {
      iStep: [0, 1, 0],
      jStep: [0, 0, -1],
      kStep: [1, 0, 0],
      origin: [0, 0, 0],
    };
    const volume = makeVolume([4, 4, 4], geometry);
    const axial = planeToTex(volume, Orientation.Axial);

    // The centre of the plane still samples the centre of the volume.
    expectVec(texCoordAt(axial, 0.5, 0.5, 0.5), [0.5, 0.5, 0.5]);
    // Moving right across the axial pane (+X, patient-left) walks the slice
    // axis (k runs +X), not the column axis as the naive mapping assumed.
    expectVec(texCoordAt(axial, 0, 0.5, 0.5), [0.5, 0.5, 0]);
    expectVec(texCoordAt(axial, 1, 0.5, 0.5), [0.5, 0.5, 1]);
    // Increasing slicePos (+Z, superior) walks the row axis (j runs -Z), so a
    // higher slice maps to a lower row coordinate.
    expectVec(texCoordAt(axial, 0.5, 0.5, 0), [0.5, 1, 0.5]);
    expectVec(texCoordAt(axial, 0.5, 0.5, 1), [0.5, 0, 0.5]);
  });
});

describe('sliceCountFor / planeExtentMm', () => {
  it('walks the expected acquisition axis for an identity volume', () => {
    const volume = makeVolume([5, 4, 3]); // x=5, y=4, z=3

    expect(sliceCountFor(volume, Orientation.Axial)).toBe(3); // walks z
    expect(sliceCountFor(volume, Orientation.Coronal)).toBe(4); // walks y
    expect(sliceCountFor(volume, Orientation.Sagittal)).toBe(5); // walks x

    expect(planeExtentMm(volume, Orientation.Axial)).toEqual([5, 4]);
    expect(planeExtentMm(volume, Orientation.Coronal)).toEqual([5, 3]);
    expect(planeExtentMm(volume, Orientation.Sagittal)).toEqual([4, 3]);
  });

  it('counts slices along the patient axis for a permuted volume', () => {
    // Slices run +X, so the *sagittal* view (walks +X) gets the 6 acquired
    // slices, while axial/coronal walk the 4-voxel in-plane axes.
    const geometry: VolumeGeometry = {
      iStep: [0, 1, 0],
      jStep: [0, 0, -1],
      kStep: [1, 0, 0],
      origin: [0, 0, 0],
    };
    const volume = makeVolume([4, 4, 6], geometry); // 6 slices along k (+X)

    expect(sliceCountFor(volume, Orientation.Sagittal)).toBe(6); // walks +X = k
    expect(sliceCountFor(volume, Orientation.Axial)).toBe(4); // walks +Z = -j
    expect(sliceCountFor(volume, Orientation.Coronal)).toBe(4); // walks +Y = i
  });
});
