import { describe, expect, it } from 'vitest';
import { fillLoops, rasterizeRoiContours, type VoxelLoop } from './contour-raster';
import { createLabelVolume, labelIndex } from './label-volume';
import { buildStructureSet } from './structure-export';
import { voxelToPatient } from './volume';
import type { Contour, Roi, Vec3, Volume, VolumeGeometry } from './types';

/** A scalar volume with the given dims/spacing and an explicit (anisotropic/oblique) geometry. */
function makeVolume(
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number],
  geometry: VolumeGeometry,
): Volume {
  const [dimX, dimY, dimZ] = dims;
  return {
    dims,
    spacing,
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

/** Axis-aligned unit-spacing geometry: a patient point equals its voxel index. */
const UNIT: VolumeGeometry = {
  iStep: [1, 0, 0],
  jStep: [0, 1, 0],
  kStep: [0, 0, 1],
  origin: [0, 0, 0],
};

/** A `CLOSED_PLANAR` contour from voxel-corner points `[x, y]` on slice `z`, mapped to patient space. */
function loopContour(
  geom: VolumeGeometry,
  corners: readonly (readonly [number, number])[],
  z: number,
  geometricType = 'CLOSED_PLANAR',
): Contour {
  const points: Vec3[] = corners.map(([x, y]) => voxelToPatient(geom, [x, y, z]));
  return { geometricType, points };
}

function makeRoi(contours: readonly Contour[], number = 7): Roi {
  return { number, name: 'Heart', color: [255, 0, 0], interpretedType: 'ORGAN', contours };
}

/** Read the label id at voxel (x, y, z). */
function at(label: ReturnType<typeof createLabelVolume>, x: number, y: number, z: number): number {
  return label.data[labelIndex(label.dims, x, y, z)];
}

describe('fillLoops', () => {
  it('fills the pixels whose centres lie inside a square loop', () => {
    // Corners at (1.5,1.5)→(5.5,5.5): pixel centres 2..5 fall inside.
    const square: VoxelLoop = [
      [1.5, 1.5],
      [5.5, 1.5],
      [5.5, 5.5],
      [1.5, 5.5],
    ];
    const filled = new Set<string>();
    fillLoops([square], 8, 8, (x, y) => filled.add(`${x},${y}`));
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const inside = x >= 2 && x <= 5 && y >= 2 && y <= 5;
        expect(filled.has(`${x},${y}`)).toBe(inside);
      }
    }
  });

  it('carves a hole where a second loop nests inside the first (even-odd)', () => {
    const outer: VoxelLoop = [
      [0.5, 0.5],
      [6.5, 0.5],
      [6.5, 6.5],
      [0.5, 6.5],
    ];
    const hole: VoxelLoop = [
      [2.5, 2.5],
      [4.5, 2.5],
      [4.5, 4.5],
      [2.5, 4.5],
    ];
    const filled = new Set<string>();
    fillLoops([outer, hole], 8, 8, (x, y) => filled.add(`${x},${y}`));
    expect(filled.has('1,1')).toBe(true); // in the ring
    expect(filled.has('3,3')).toBe(false); // in the hole
    expect(filled.has('4,4')).toBe(false);
    expect(filled.has('5,5')).toBe(true); // ring again
  });

  it('fills two disjoint loops as separate components', () => {
    const a: VoxelLoop = [
      [0.5, 0.5],
      [1.5, 0.5],
      [1.5, 1.5],
      [0.5, 1.5],
    ];
    const b: VoxelLoop = [
      [5.5, 0.5],
      [6.5, 0.5],
      [6.5, 1.5],
      [5.5, 1.5],
    ];
    const filled = new Set<string>();
    fillLoops([a, b], 8, 8, (x, y) => filled.add(`${x},${y}`));
    expect(filled.has('1,1')).toBe(true);
    expect(filled.has('6,1')).toBe(true);
    expect(filled.has('3,1')).toBe(false); // the gap between them
  });
});

describe('rasterizeRoiContours', () => {
  it('fills a known loop into the right slice with the ROI id', () => {
    const label = createLabelVolume(makeVolume([8, 8, 3], [1, 1, 1], UNIT));
    const roi = makeRoi([
      loopContour(
        UNIT,
        [
          [1.5, 1.5],
          [5.5, 1.5],
          [5.5, 5.5],
          [1.5, 5.5],
        ],
        1,
      ),
    ]);
    const result = rasterizeRoiContours(label, roi, 9);

    expect(result.skipped).toBe(0);
    expect(result.filled).toBe(16); // 4×4 pixels
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const inside = x >= 2 && x <= 5 && y >= 2 && y <= 5;
        expect(at(label, x, y, 1)).toBe(inside ? 9 : 0);
        expect(at(label, x, y, 0)).toBe(0); // only slice 1 is touched
        expect(at(label, x, y, 2)).toBe(0);
      }
    }
  });

  it('respects a nested hole', () => {
    const label = createLabelVolume(makeVolume([8, 8, 1], [1, 1, 1], UNIT));
    const roi = makeRoi([
      loopContour(
        UNIT,
        [
          [0.5, 0.5],
          [6.5, 0.5],
          [6.5, 6.5],
          [0.5, 6.5],
        ],
        0,
      ),
      loopContour(
        UNIT,
        [
          [2.5, 2.5],
          [4.5, 2.5],
          [4.5, 4.5],
          [2.5, 4.5],
        ],
        0,
      ),
    ]);
    rasterizeRoiContours(label, roi, 4);
    expect(at(label, 1, 1, 0)).toBe(4); // ring
    expect(at(label, 3, 3, 0)).toBe(0); // hole
  });

  it('skips OPEN_PLANAR and POINT contours, counting them', () => {
    const label = createLabelVolume(makeVolume([8, 8, 1], [1, 1, 1], UNIT));
    const roi = makeRoi([
      loopContour(
        UNIT,
        [
          [1.5, 1.5],
          [5.5, 1.5],
          [5.5, 5.5],
          [1.5, 5.5],
        ],
        0,
      ),
      loopContour(
        UNIT,
        [
          [1.5, 1.5],
          [5.5, 1.5],
        ],
        0,
        'OPEN_PLANAR',
      ),
      loopContour(UNIT, [[3.5, 3.5]], 0, 'POINT'),
    ]);
    const result = rasterizeRoiContours(label, roi, 2);
    expect(result.skipped).toBe(2);
    expect(result.filled).toBe(16);
  });

  it('handles anisotropic spacing via the shared affine', () => {
    // x:1mm, y:2mm, z:3mm. A patient-space loop the size of pixels 1..4 in y still
    // lands on voxel rows 1..4 because patientToVoxel divides through the spacing.
    const geom: VolumeGeometry = {
      iStep: [1, 0, 0],
      jStep: [0, 2, 0],
      kStep: [0, 0, 3],
      origin: [0, 0, 0],
    };
    const label = createLabelVolume(makeVolume([8, 8, 3], [1, 2, 3], geom));
    const roi = makeRoi([
      loopContour(
        geom,
        [
          [0.5, 0.5],
          [4.5, 0.5],
          [4.5, 4.5],
          [0.5, 4.5],
        ],
        1,
      ),
    ]);
    rasterizeRoiContours(label, roi, 5);
    expect(at(label, 2, 2, 1)).toBe(5);
    expect(at(label, 1, 1, 1)).toBe(5);
    expect(at(label, 2, 2, 0)).toBe(0);
    expect(at(label, 6, 6, 1)).toBe(0);
  });

  it('round-trips a convex ROI through marching-squares export', () => {
    // Rasterize → export to contours → rasterize the export: an axis-aligned
    // region reproduces the same occupancy exactly (the staircase boundary the
    // export traces is the inverse of the even-odd fill).
    const volume = makeVolume([10, 10, 3], [1, 1, 1], UNIT);
    const first = createLabelVolume(volume);
    const roi = makeRoi([
      loopContour(
        UNIT,
        [
          [2.5, 1.5],
          [7.5, 1.5],
          [7.5, 6.5],
          [2.5, 6.5],
        ],
        1,
      ),
    ]);
    rasterizeRoiContours(first, roi, 3);

    const exported = buildStructureSet(first, [
      { id: 3, name: roi.name, color: [255, 0, 0], interpretedType: roi.interpretedType },
    ]);
    const second = createLabelVolume(volume);
    rasterizeRoiContours(second, exported.rois[0], 3);

    expect(Array.from(second.data)).toEqual(Array.from(first.data));
  });
});
