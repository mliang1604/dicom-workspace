import {
  clearDirty,
  clearLabelId,
  createLabelVolume,
  eraseLabels,
  labelIndex,
  labelVoxelAtPatient,
  markAllDirty,
  paintLabels,
} from './label-volume';
import { patientToVoxel } from './volume';
import type { Vec3, Volume, VolumeGeometry } from './types';

/** A 4×3×2 volume with an oblique, offset geometry (so axis-aligned shortcuts can't pass by luck). */
function makeVolume(geometry?: VolumeGeometry): Volume {
  const [dimX, dimY, dimZ] = [4, 3, 2];
  return {
    dims: [dimX, dimY, dimZ],
    spacing: [1.5, 2, 3],
    data: new Float32Array(dimX * dimY * dimZ),
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

const OBLIQUE: VolumeGeometry = {
  iStep: [1.5, 0, 0],
  jStep: [0, 2, 0.3],
  kStep: [0, 0.2, 3],
  origin: [10, -5, 20],
};

/** Patient point at the centre of voxel (x, y, z), per the volume's forward placement. */
function voxelCentre(geom: VolumeGeometry, x: number, y: number, z: number): Vec3 {
  return [
    geom.origin[0] + x * geom.iStep[0] + y * geom.jStep[0] + z * geom.kStep[0],
    geom.origin[1] + x * geom.iStep[1] + y * geom.jStep[1] + z * geom.kStep[1],
    geom.origin[2] + x * geom.iStep[2] + y * geom.jStep[2] + z * geom.kStep[2],
  ];
}

describe('createLabelVolume', () => {
  it('aligns dims and spacing to the image volume, zeroed', () => {
    const label = createLabelVolume(makeVolume(OBLIQUE));
    expect(label.dims).toEqual([4, 3, 2]);
    expect(label.spacing).toEqual([1.5, 2, 3]);
    expect(label.data).toHaveLength(4 * 3 * 2);
    expect(Array.from(label.data).every((v) => v === 0)).toBe(true);
  });

  it('carries the image geometry through', () => {
    const label = createLabelVolume(makeVolume(OBLIQUE));
    expect(label.geometry).toEqual(OBLIQUE);
  });

  it('fills the axis-aligned fallback when the image records no geometry', () => {
    const label = createLabelVolume(makeVolume(undefined));
    expect(label.geometry).toEqual({
      iStep: [1.5, 0, 0],
      jStep: [0, 2, 0],
      kStep: [0, 0, 3],
      origin: [0, 0, 0],
    });
  });
});

describe('label ↔ image geometry agreement', () => {
  it('maps a patient point to the same voxel both ways', () => {
    const volume = makeVolume(OBLIQUE);
    const label = createLabelVolume(volume);
    const point = voxelCentre(OBLIQUE, 2, 1, 1);

    // The image volume's own mapping (what the probe/shader use)…
    const viaImage = patientToVoxel(volume.geometry!, point)!;
    // …and the label volume's resolved one must round to the same voxel.
    expect(viaImage.map(Math.round)).toEqual([2, 1, 1]);
    expect(labelVoxelAtPatient(label, point)).toEqual([2, 1, 1]);
  });

  it('returns null for a patient point outside the grid', () => {
    const label = createLabelVolume(makeVolume(OBLIQUE));
    const outside = voxelCentre(OBLIQUE, 99, 0, 0);
    expect(labelVoxelAtPatient(label, outside)).toBeNull();
  });
});

describe('paintLabels / eraseLabels', () => {
  it('paints the given voxels with the roi id and erases back to background', () => {
    const label = createLabelVolume(makeVolume(OBLIQUE));
    const a = labelIndex(label.dims, 1, 0, 0);
    const b = labelIndex(label.dims, 2, 1, 1);

    paintLabels(label, 7, [a, b]);
    expect(label.data[a]).toBe(7);
    expect(label.data[b]).toBe(7);

    eraseLabels(label, [a]);
    expect(label.data[a]).toBe(0);
    expect(label.data[b]).toBe(7);
  });

  it('overwrites an existing id (single-occupancy: last paint wins)', () => {
    const label = createLabelVolume(makeVolume(OBLIQUE));
    const i = labelIndex(label.dims, 0, 0, 0);
    paintLabels(label, 3, [i]);
    paintLabels(label, 9, [i]);
    expect(label.data[i]).toBe(9);
  });

  it('skips out-of-range indices', () => {
    const label = createLabelVolume(makeVolume(OBLIQUE));
    expect(() => paintLabels(label, 1, [-1, label.data.length, 999])).not.toThrow();
    expect(Array.from(label.data).every((v) => v === 0)).toBe(true);
  });
});

describe('clearLabelId', () => {
  it('clears every voxel holding the id and reports the count', () => {
    const label = createLabelVolume(makeVolume(OBLIQUE));
    paintLabels(label, 5, [0, 1, 2]);
    paintLabels(label, 8, [3]);
    expect(clearLabelId(label, 5)).toBe(3);
    expect(label.data[0]).toBe(0);
    expect(label.data[3]).toBe(8); // a different id is untouched
  });
});

describe('dirty tracking', () => {
  it('starts clean', () => {
    expect(createLabelVolume(makeVolume(OBLIQUE)).dirty).toBeNull();
  });

  it('paint grows the box to the tight inclusive bounds of the touched voxels', () => {
    const label = createLabelVolume(makeVolume(OBLIQUE));
    paintLabels(label, 1, [labelIndex(label.dims, 1, 0, 0), labelIndex(label.dims, 2, 1, 1)]);
    expect(label.dirty).toEqual({ minX: 1, minY: 0, minZ: 0, maxX: 2, maxY: 1, maxZ: 1 });
  });

  it('erase extends the existing box; out-of-range writes do not', () => {
    const label = createLabelVolume(makeVolume(OBLIQUE));
    paintLabels(label, 1, [labelIndex(label.dims, 1, 1, 0)]);
    eraseLabels(label, [labelIndex(label.dims, 3, 2, 1), -1, label.data.length]);
    expect(label.dirty).toEqual({ minX: 1, minY: 1, minZ: 0, maxX: 3, maxY: 2, maxZ: 1 });
  });

  it('clearLabelId marks the cleared voxels dirty', () => {
    const label = createLabelVolume(makeVolume(OBLIQUE));
    paintLabels(label, 5, [labelIndex(label.dims, 0, 0, 0), labelIndex(label.dims, 2, 0, 0)]);
    clearDirty(label);
    clearLabelId(label, 5);
    expect(label.dirty).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 0, maxZ: 0 });
  });

  it('clearDirty resets to clean and markAllDirty spans the whole grid', () => {
    const label = createLabelVolume(makeVolume(OBLIQUE));
    paintLabels(label, 1, [0]);
    clearDirty(label);
    expect(label.dirty).toBeNull();
    markAllDirty(label);
    const [dimX, dimY, dimZ] = label.dims;
    expect(label.dirty).toEqual({
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: dimX - 1,
      maxY: dimY - 1,
      maxZ: dimZ - 1,
    });
  });
});
