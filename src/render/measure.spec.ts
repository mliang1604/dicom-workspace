import { Orientation, type Volume } from '../dicom/types';
import {
  huStats,
  measureAngleDeg,
  measureDistanceMm,
  roiAreaMm2,
  roiBounds,
  roiContains,
  roiStats,
} from './measure';

/** A dims volume whose every voxel holds its flat index ((z·Y+y)·X+x). */
function indexVolume(dims: [number, number, number]): Volume {
  const [x, y, z] = dims;
  const data = new Float32Array(x * y * z);
  for (let i = 0; i < data.length; i++) data[i] = i;
  return baseVolume(dims, data);
}

/** A dims volume whose every voxel holds a constant value. */
function constantVolume(dims: [number, number, number], value: number): Volume {
  const [x, y, z] = dims;
  const data = new Float32Array(x * y * z).fill(value);
  return baseVolume(dims, data, value, value);
}

function baseVolume(
  dims: [number, number, number],
  data: Float32Array,
  min = 0,
  max = data.length - 1,
): Volume {
  return {
    dims,
    spacing: [1, 1, 1],
    data,
    min,
    max,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
  };
}

const SQUARE = { widthMm: 100, heightMm: 100 } as const;

describe('measureDistanceMm', () => {
  it('scales each axis fraction by the plane extent', () => {
    expect(measureDistanceMm({ u: 0, v: 0 }, { u: 1, v: 0 }, SQUARE)).toBeCloseTo(100, 6);
    expect(measureDistanceMm({ u: 0, v: 0 }, { u: 0, v: 1 }, SQUARE)).toBeCloseTo(100, 6);
    expect(measureDistanceMm({ u: 0, v: 0 }, { u: 1, v: 1 }, SQUARE)).toBeCloseTo(
      Math.SQRT2 * 100,
      6,
    );
  });

  it('honours anisotropic plane extents', () => {
    const scale = { widthMm: 300, heightMm: 100 } as const;
    // 0.5 across (150 mm) and 0.5 down (50 mm) → hypot(150, 50).
    expect(measureDistanceMm({ u: 0, v: 0 }, { u: 0.5, v: 0.5 }, scale)).toBeCloseTo(
      Math.hypot(150, 50),
      6,
    );
  });

  it('is symmetric in its endpoints', () => {
    const a = { u: 0.2, v: 0.7 };
    const b = { u: 0.9, v: 0.1 };
    expect(measureDistanceMm(a, b, SQUARE)).toBeCloseTo(measureDistanceMm(b, a, SQUARE), 9);
  });
});

describe('measureAngleDeg', () => {
  it('measures a right angle between perpendicular rays', () => {
    const angle = measureAngleDeg({ u: 1, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 1 }, SQUARE);
    expect(angle).toBeCloseTo(90, 6);
  });

  it('measures a straight angle for opposed rays', () => {
    const angle = measureAngleDeg({ u: 0, v: 0.5 }, { u: 0.5, v: 0.5 }, { u: 1, v: 0.5 }, SQUARE);
    expect(angle).toBeCloseTo(180, 6);
  });

  it('uses physical millimetres, so anisotropy changes the angle', () => {
    // Equal u/v fractions are a 45° screen angle but not 45° in mm when the
    // axes scale differently.
    const scale = { widthMm: 300, heightMm: 100 } as const;
    const angle = measureAngleDeg({ u: 1, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 1 }, scale);
    // Rays (300,0) and (0,100) are still perpendicular → 90°, but a diagonal isn't.
    expect(angle).toBeCloseTo(90, 6);
    const diag = measureAngleDeg({ u: 1, v: 0 }, { u: 0, v: 0 }, { u: 1, v: 1 }, scale);
    expect(diag).toBeCloseTo((Math.atan2(100, 300) * 180) / Math.PI, 6);
  });

  it('returns 0 for a coincident point', () => {
    expect(measureAngleDeg({ u: 0, v: 0 }, { u: 0, v: 0 }, { u: 1, v: 1 }, SQUARE)).toBe(0);
  });
});

describe('roiBounds / roiContains / roiAreaMm2', () => {
  it('normalises corners into a centred bounding box', () => {
    const b = roiBounds({ u: 0.8, v: 0.2 }, { u: 0.2, v: 0.6 });
    expect(b).toMatchObject({ minU: 0.2, maxU: 0.8, minV: 0.2, maxV: 0.6 });
    expect(b.centerU).toBeCloseTo(0.5, 9);
    expect(b.centerV).toBeCloseTo(0.4, 9);
    expect(b.radiusU).toBeCloseTo(0.3, 9);
    expect(b.radiusV).toBeCloseTo(0.2, 9);
  });

  it('tests rectangle membership by the bounding box', () => {
    const b = roiBounds({ u: 0.2, v: 0.2 }, { u: 0.8, v: 0.8 });
    expect(roiContains('rectangle', b, 0.5, 0.5)).toBe(true);
    expect(roiContains('rectangle', b, 0.1, 0.5)).toBe(false);
    expect(roiContains('rectangle', b, 0.2, 0.8)).toBe(true); // on the edge
  });

  it('tests ellipse membership inside the inscribed ellipse', () => {
    const b = roiBounds({ u: 0, v: 0 }, { u: 1, v: 1 });
    expect(roiContains('ellipse', b, 0.5, 0.5)).toBe(true); // centre
    expect(roiContains('ellipse', b, 1, 0.5)).toBe(true); // axis endpoint
    expect(roiContains('ellipse', b, 0.95, 0.95)).toBe(false); // corner, outside
  });

  it('computes exact rectangle and ellipse areas in mm²', () => {
    const b = roiBounds({ u: 0.25, v: 0.25 }, { u: 0.75, v: 0.75 });
    // 0.5 × 0.5 of a 100×100 mm plane → 50 × 50 mm.
    expect(roiAreaMm2('rectangle', b, SQUARE)).toBeCloseTo(2500, 6);
    expect(roiAreaMm2('ellipse', b, SQUARE)).toBeCloseTo((Math.PI * 50 * 50) / 4, 6);
  });
});

describe('huStats', () => {
  it('returns null for an empty list', () => {
    expect(huStats([])).toBeNull();
  });

  it('computes mean, population SD, min and max', () => {
    const stats = huStats([2, 4, 4, 4, 5, 5, 7, 9])!;
    expect(stats.mean).toBeCloseTo(5, 9);
    expect(stats.sd).toBeCloseTo(2, 9); // population SD of this classic set
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(9);
    expect(stats.count).toBe(8);
  });
});

describe('roiStats', () => {
  it('reports a constant region: zero SD, exact area and full count', () => {
    const volume = constantVolume([4, 4, 4], -40);
    // A rectangle covering the whole axial plane (4×4 mm extent, 4×4 voxels).
    const result = roiStats(
      volume,
      Orientation.Axial,
      2,
      'rectangle',
      { u: 0, v: 0 },
      { u: 1, v: 1 },
    );
    expect(result.areaMm2).toBeCloseTo(16, 6);
    expect(result.stats).toMatchObject({ mean: -40, sd: 0, min: -40, max: -40, count: 16 });
  });

  it('samples the enclosed voxels of the current slice', () => {
    const volume = indexVolume([4, 4, 4]);
    // Whole axial slice at z = 2: values (2·4+y)·4+x span 32..47, mean 39.5.
    const result = roiStats(
      volume,
      Orientation.Axial,
      2,
      'rectangle',
      { u: 0, v: 0 },
      { u: 1, v: 1 },
    );
    expect(result.stats).toMatchObject({ min: 32, max: 47, count: 16 });
    expect(result.stats!.mean).toBeCloseTo(39.5, 9);
  });

  it('encloses fewer voxels and a smaller area for an inscribed ellipse', () => {
    const volume = constantVolume([4, 4, 4], 100);
    const result = roiStats(
      volume,
      Orientation.Axial,
      2,
      'ellipse',
      { u: 0, v: 0 },
      { u: 1, v: 1 },
    );
    expect(result.areaMm2).toBeCloseTo((Math.PI * 16) / 4, 6);
    expect(result.stats!.count).toBeLessThan(16);
    expect(result.stats!.mean).toBe(100);
  });

  it('pins statistics to the requested slice', () => {
    const volume = indexVolume([4, 4, 4]);
    const here = roiStats(
      volume,
      Orientation.Axial,
      0,
      'rectangle',
      { u: 0, v: 0 },
      { u: 1, v: 1 },
    );
    const there = roiStats(
      volume,
      Orientation.Axial,
      3,
      'rectangle',
      { u: 0, v: 0 },
      { u: 1, v: 1 },
    );
    // Different slices hold different index values, so the means differ.
    expect(here.stats!.mean).not.toBeCloseTo(there.stats!.mean, 3);
  });
});
