import { labelIndex } from '../../dicom/label-volume';
import type { Volume } from '../../dicom/types';
import { EditableStructuresStore } from './editable-structures-store';

function makeVolume(): Volume {
  const [dimX, dimY, dimZ] = [4, 3, 2];
  return {
    dims: [dimX, dimY, dimZ],
    spacing: [1, 1, 1],
    data: new Float32Array(dimX * dimY * dimZ),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry: undefined,
  };
}

function store(): EditableStructuresStore {
  const s = new EditableStructuresStore();
  s.resetForLoad(makeVolume());
  return s;
}

describe('EditableStructuresStore registry', () => {
  it('starts empty until a structure is created', () => {
    const s = store();
    expect(s.rois()).toEqual([]);
    expect(s.hasStructures()).toBe(false);

    const roi = s.createRoi();
    expect(s.hasStructures()).toBe(true);
    expect(s.rois()).toHaveLength(1);
    expect(roi.id).toBe(1);
    expect(roi.color).toHaveLength(3);
  });

  it('assigns ascending ids that do not recycle after a delete', () => {
    const s = store();
    s.createRoi();
    const second = s.createRoi();
    s.deleteRoi(second.id);
    const third = s.createRoi();
    expect(third.id).toBe(3); // not 2
  });

  it('renames and recolours by id, leaving others untouched', () => {
    const s = store();
    const a = s.createRoi('A');
    const b = s.createRoi('B');
    s.renameRoi(a.id, 'Heart');
    s.recolorRoi(b.id, [1, 2, 3]);
    expect(s.rois().find((r) => r.id === a.id)?.name).toBe('Heart');
    expect(s.rois().find((r) => r.id === b.id)?.color).toEqual([1, 2, 3]);
    expect(s.rois().find((r) => r.id === a.id)?.color).not.toEqual([1, 2, 3]);
  });
});

describe('EditableStructuresStore voxel mutation', () => {
  it('paints occupancy and bumps the version', () => {
    const s = store();
    const roi = s.createRoi();
    const before = s.version();
    const i = labelIndex(s.labelVolume()!.dims, 1, 1, 0);

    s.paint(roi.id, [i]);
    expect(s.labelVolume()!.data[i]).toBe(roi.id);
    expect(s.version()).toBe(before + 1);
  });

  it('erases occupancy and bumps the version', () => {
    const s = store();
    const roi = s.createRoi();
    const i = labelIndex(s.labelVolume()!.dims, 0, 0, 0);
    s.paint(roi.id, [i]);
    const afterPaint = s.version();

    s.erase([i]);
    expect(s.labelVolume()!.data[i]).toBe(0);
    expect(s.version()).toBe(afterPaint + 1);
  });

  it('does not bump the version on a registry-only edit', () => {
    const s = store();
    const roi = s.createRoi();
    const v = s.version();
    s.renameRoi(roi.id, 'x');
    expect(s.version()).toBe(v);
  });

  it('clears painted voxels when its structure is deleted', () => {
    const s = store();
    const roi = s.createRoi();
    const i = labelIndex(s.labelVolume()!.dims, 2, 1, 1);
    s.paint(roi.id, [i]);
    const v = s.version();

    s.deleteRoi(roi.id);
    expect(s.labelVolume()!.data[i]).toBe(0);
    expect(s.version()).toBe(v + 1); // voxels changed → bump
  });

  it('does not bump when deleting a structure with no painted voxels', () => {
    const s = store();
    const roi = s.createRoi();
    const v = s.version();
    s.deleteRoi(roi.id);
    expect(s.version()).toBe(v);
  });
});

describe('EditableStructuresStore resetForLoad', () => {
  it('allocates a fresh empty label grid aligned to the volume', () => {
    const s = store();
    s.createRoi();
    s.paint(1, [0]);

    s.resetForLoad(makeVolume());
    expect(s.rois()).toEqual([]);
    expect(s.version()).toBe(0);
    expect(s.labelVolume()!.dims).toEqual([4, 3, 2]);
    expect(Array.from(s.labelVolume()!.data).every((v) => v === 0)).toBe(true);
  });

  it('clears the label volume when nothing is loaded', () => {
    const s = store();
    s.resetForLoad(null);
    expect(s.labelVolume()).toBeNull();
    // paint/erase are no-ops without a label volume
    expect(() => s.paint(1, [0])).not.toThrow();
    expect(s.version()).toBe(0);
  });
});
