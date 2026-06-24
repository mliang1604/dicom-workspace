import { Orientation, type Volume } from '../dicom/types';
import type { PaneRect } from './layout';
import { probeVoxel } from './probe';
import {
  cursorVoxel,
  stampVoxels,
  strokeCenters,
  strokeVoxels,
  throughPlaneAxis,
  type VoxelIndex,
} from './brush';

/** A dims[0]×dims[1]×dims[2] volume whose every voxel holds its flat index. */
function makeVolume(dims: [number, number, number]): Volume {
  const [x, y, z] = dims;
  const data = new Float32Array(x * y * z);
  for (let i = 0; i < data.length; i++) data[i] = i;
  return {
    dims,
    spacing: [1, 1, 1],
    data,
    min: 0,
    max: data.length - 1,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
  };
}

/** Decode a flat index back to a voxel triple for readable assertions. */
function unflatten(index: number, dims: VoxelIndex): VoxelIndex {
  const [dimX, dimY] = dims;
  const x = index % dimX;
  const y = Math.floor(index / dimX) % dimY;
  const z = Math.floor(index / (dimX * dimY));
  return [x, y, z];
}

const SQUARE: PaneRect = { x: 0, y: 0, width: 100, height: 100 };

describe('stampVoxels (sphere)', () => {
  it('covers the 6 face-neighbours of an isotropic 1 mm-radius brush', () => {
    const dims: VoxelIndex = [9, 9, 9];
    const voxels = stampVoxels(dims, [1, 1, 1], [4, 4, 4], { shape: 'sphere', radiusMm: 1 });

    // Centre + 6 faces (distance 1) are within 1 mm; corners (√2, √3) are not.
    expect(voxels.length).toBe(7);
    const set = new Set(voxels.map((i) => unflatten(i, dims).join(',')));
    expect(set.has('4,4,4')).toBe(true);
    expect(set.has('3,4,4')).toBe(true);
    expect(set.has('4,5,4')).toBe(true);
    expect(set.has('4,4,5')).toBe(true);
    expect(set.has('3,3,4')).toBe(false); // a √2 corner is excluded
  });

  it('accounts for anisotropic spacing: a thin through-plane axis is not reached', () => {
    const dims: VoxelIndex = [9, 9, 9];
    // 3 mm along z, so a 1.5 mm brush cannot leave the centre z-slice, but it
    // reaches one voxel (and the diagonals) in the fine 1 mm x/y plane.
    const voxels = stampVoxels(dims, [1, 1, 3], [4, 4, 4], { shape: 'sphere', radiusMm: 1.5 });

    const decoded = voxels.map((i) => unflatten(i, dims));
    expect(decoded.every(([, , z]) => z === 4)).toBe(true); // never escapes the slice
    // The 3×3 in-plane block: centre, faces (1 mm) and corners (√2 ≤ 1.5 mm).
    expect(voxels.length).toBe(9);
    const set = new Set(decoded.map((v) => v.join(',')));
    expect(set.has('3,3,4')).toBe(true);
    expect(set.has('5,5,4')).toBe(true);
  });

  it('always covers at least the centre voxel for a sub-voxel radius', () => {
    const dims: VoxelIndex = [4, 4, 4];
    const voxels = stampVoxels(dims, [1, 1, 1], [2, 2, 2], { shape: 'sphere', radiusMm: 0 });
    expect(voxels).toEqual([(2 * 4 + 2) * 4 + 2]);
  });

  it('clips the stamp to the grid bounds at an edge', () => {
    const dims: VoxelIndex = [4, 4, 4];
    const voxels = stampVoxels(dims, [1, 1, 1], [0, 0, 0], { shape: 'sphere', radiusMm: 1 });
    // Only the in-bounds face neighbours survive: centre + (1,0,0),(0,1,0),(0,0,1).
    expect(voxels.length).toBe(4);
  });
});

describe('stampVoxels (disk)', () => {
  it('confines the footprint to the centre slice of its axis', () => {
    const dims: VoxelIndex = [9, 9, 9];
    const sphere = stampVoxels(dims, [1, 1, 1], [4, 4, 4], { shape: 'sphere', radiusMm: 2 });
    const disk = stampVoxels(dims, [1, 1, 1], [4, 4, 4], {
      shape: 'disk',
      radiusMm: 2,
      axis: throughPlaneAxis(Orientation.Axial),
    });

    expect(disk.length).toBeLessThan(sphere.length); // a slice, not a ball
    expect(disk.map((i) => unflatten(i, dims)).every(([, , z]) => z === 4)).toBe(true);
  });
});

describe('strokeCenters', () => {
  it('returns the single centre for a zero-length stroke', () => {
    expect(strokeCenters([2, 3, 4], [2, 3, 4])).toEqual([[2, 3, 4]]);
  });

  it('steps by at most one voxel per axis between consecutive centres', () => {
    const centers = strokeCenters([0, 0, 0], [10, 4, 0]);
    expect(centers[0]).toEqual([0, 0, 0]);
    expect(centers[centers.length - 1]).toEqual([10, 4, 0]);
    for (let i = 1; i < centers.length; i++) {
      const dx = Math.abs(centers[i][0] - centers[i - 1][0]);
      const dy = Math.abs(centers[i][1] - centers[i - 1][1]);
      const dz = Math.abs(centers[i][2] - centers[i - 1][2]);
      expect(Math.max(dx, dy, dz)).toBeLessThanOrEqual(1);
    }
  });
});

describe('strokeVoxels', () => {
  it('fills the gap between two sparse cursor samples', () => {
    const dims: VoxelIndex = [11, 11, 1];
    // A point brush dragged across the row in one big jump: the union must still
    // be a continuous line, including the midpoint a two-endpoint stamp misses.
    const voxels = strokeVoxels(dims, [1, 1, 1], [0, 5, 0], [10, 5, 0], {
      shape: 'sphere',
      radiusMm: 0,
    });
    const xs = new Set(voxels.map((i) => unflatten(i, dims)[0]));
    for (let x = 0; x <= 10; x++) expect(xs.has(x)).toBe(true);
    expect(voxels.length).toBe(11);
  });

  it('de-duplicates voxels shared by overlapping stamps', () => {
    const dims: VoxelIndex = [11, 11, 3];
    const voxels = strokeVoxels(dims, [1, 1, 1], [3, 5, 1], [7, 5, 1], {
      shape: 'sphere',
      radiusMm: 2,
    });
    expect(new Set(voxels).size).toBe(voxels.length); // no index appears twice
  });
});

describe('cursorVoxel', () => {
  it('round-trips: a cursor pixel maps to the same voxel the probe samples there', () => {
    const volume = makeVolume([4, 4, 4]);
    for (const [px, py] of [
      [50, 50],
      [0, 0],
      [99, 99],
      [25, 75],
    ] as const) {
      const probe = probeVoxel(volume, Orientation.Axial, 2, 1, SQUARE, px, py);
      const brush = cursorVoxel(volume, Orientation.Axial, 2, 1, SQUARE, px, py);
      expect(brush).toEqual(probe?.voxel ?? null);
    }
  });

  it('returns null when the cursor is off the pane', () => {
    const volume = makeVolume([4, 4, 4]);
    expect(cursorVoxel(volume, Orientation.Axial, 0, 1, SQUARE, -1, 50)).toBeNull();
  });
});
