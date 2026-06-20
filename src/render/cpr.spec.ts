import { describe, expect, it } from 'vitest';
import type { Vec3, Volume, VolumeGeometry } from '../dicom/types';
import {
  buildCenterline,
  catmullRom,
  resampleByArcLength,
  rotationMinimizingFrames,
  sampleVolumeTrilinear,
  straightenedCpr,
  type CenterlineSample,
} from './cpr';

const IDENTITY: VolumeGeometry = {
  iStep: [1, 0, 0],
  jStep: [0, 1, 0],
  kStep: [0, 0, 1],
  origin: [0, 0, 0],
};

/** A volume whose voxel values are `fill(x, y, z)` over a unit-spaced grid. */
function makeVolume(
  dims: [number, number, number],
  fill: (x: number, y: number, z: number) => number,
): Volume {
  const [dx, dy, dz] = dims;
  const data = new Float32Array(dx * dy * dz);
  let min = Infinity;
  let max = -Infinity;
  for (let z = 0; z < dz; z++) {
    for (let y = 0; y < dy; y++) {
      for (let x = 0; x < dx; x++) {
        const v = fill(x, y, z);
        data[(z * dy + y) * dx + x] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  return {
    dims,
    spacing: [1, 1, 1],
    data,
    min,
    max,
    windowCenter: (min + max) / 2,
    windowWidth: Math.max(1, max - min),
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry: IDENTITY,
  };
}

function expectVec(actual: readonly number[], expected: readonly number[], digits = 6): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i], digits);
}

describe('catmullRom', () => {
  const p0: Vec3 = [-1, 0, 0];
  const p1: Vec3 = [0, 0, 0];
  const p2: Vec3 = [1, 1, 0];
  const p3: Vec3 = [2, 0, 0];

  it('passes through the segment endpoints at t=0 and t=1', () => {
    expectVec(catmullRom(p0, p1, p2, p3, 0), p1);
    expectVec(catmullRom(p0, p1, p2, p3, 1), p2);
  });

  it('reduces to linear interpolation on collinear, evenly spaced points', () => {
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [10, 0, 0];
    const c: Vec3 = [20, 0, 0];
    const d: Vec3 = [30, 0, 0];
    expectVec(catmullRom(a, b, c, d, 0.5), [15, 0, 0]);
    expectVec(catmullRom(a, b, c, d, 0.25), [12.5, 0, 0]);
  });

  it('collapses to a straight blend when a knot interval is degenerate', () => {
    const a: Vec3 = [0, 0, 0];
    expectVec(catmullRom(a, a, [1, 0, 0], [2, 0, 0], 0.5), [0.5, 0, 0]);
  });
});

describe('buildCenterline', () => {
  it('returns an empty centreline for fewer than two control points', () => {
    expect(buildCenterline([], { stepMm: 1 }).samples).toEqual([]);
    expect(buildCenterline([[0, 0, 0]], { stepMm: 1 }).samples).toEqual([]);
  });

  it('rejects a non-positive step', () => {
    expect(() =>
      buildCenterline(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        { stepMm: 0 },
      ),
    ).toThrow();
  });

  it('resamples a straight path at a uniform arc-length step', () => {
    const line = buildCenterline(
      [
        [0, 0, 0],
        [0, 0, 10],
      ],
      { stepMm: 2 },
    );
    expect(line.lengthMm).toBeCloseTo(10, 4);
    expect(line.samples).toHaveLength(6); // z = 0, 2, 4, 6, 8, 10
    line.samples.forEach((s, i) => {
      expectVec(s.position, [0, 0, 2 * i], 4);
      expectVec(s.tangent, [0, 0, 1], 4);
    });
  });

  it('keeps spacing uniform through collinear interior control points', () => {
    const line = buildCenterline(
      [
        [0, 0, 0],
        [5, 0, 0],
        [10, 0, 0],
      ],
      { stepMm: 2 },
    );
    expect(line.lengthMm).toBeCloseTo(10, 4);
    expect(line.samples).toHaveLength(6);
    line.samples.forEach((s, i) => expectVec(s.position, [2 * i, 0, 0], 4));
  });

  it('tolerates coincident control points', () => {
    const line = buildCenterline(
      [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 10],
      ],
      { stepMm: 5 },
    );
    expect(line.lengthMm).toBeCloseTo(10, 4);
    expect(line.samples).toHaveLength(3);
  });

  it('measures arc length of a curved path greater than its chord', () => {
    // A path that bows out of the straight line between its ends.
    const pts: Vec3[] = [
      [0, 0, 0],
      [5, 4, 0],
      [10, 0, 0],
    ];
    const line = buildCenterline(pts, { stepMm: 0.5 });
    const chord = 10;
    expect(line.lengthMm).toBeGreaterThan(chord);
  });
});

describe('resampleByArcLength', () => {
  it('walks a polyline at fixed steps with local tangents', () => {
    const dense: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
      [4, 0, 0],
    ];
    const arc = [0, 1, 2, 3, 4];
    const samples = resampleByArcLength(dense, arc, 4, 1.5);
    // targets 0, 1.5, 3 -> floor(4/1.5)+1 = 3 samples
    expect(samples).toHaveLength(3);
    expectVec(samples[0].position, [0, 0, 0], 6);
    expectVec(samples[1].position, [1.5, 0, 0], 6);
    expectVec(samples[2].position, [3, 0, 0], 6);
    for (const s of samples) expectVec(s.tangent, [1, 0, 0], 6);
  });
});

describe('rotationMinimizingFrames', () => {
  it('yields an orthonormal, right-handed frame at each sample', () => {
    const samples: CenterlineSample[] = [
      { position: [0, 0, 0], tangent: [1, 0, 0] },
      { position: [1, 0.2, 0], tangent: [0.98, 0.2, 0] },
      { position: [2, 0.8, 0.3], tangent: [0.9, 0.4, 0.2] },
    ];
    const frames = rotationMinimizingFrames(samples);
    expect(frames).toHaveLength(3);
    frames.forEach((f, i) => {
      const t = normalize(samples[i].tangent);
      expect(dot(f.normal, t)).toBeCloseTo(0, 5); // perpendicular to tangent
      expect(dot(f.binormal, t)).toBeCloseTo(0, 5);
      expect(dot(f.normal, f.binormal)).toBeCloseTo(0, 5);
      expect(length(f.normal)).toBeCloseTo(1, 5);
      expect(length(f.binormal)).toBeCloseTo(1, 5);
      // right-handed: tangent x normal == binormal
      expectVec(cross(t, f.normal), f.binormal, 5);
    });
  });

  it('does not twist along a planar curve (parallel transport)', () => {
    // A quarter-circle in the z=0 plane: the frame must not spin about the path.
    const samples: CenterlineSample[] = [];
    for (let k = 0; k <= 8; k++) {
      const a = (k / 8) * (Math.PI / 2);
      samples.push({
        position: [Math.cos(a), Math.sin(a), 0],
        tangent: [-Math.sin(a), Math.cos(a), 0],
      });
    }
    const frames = rotationMinimizingFrames(samples, [0, 0, 1]);
    for (const f of frames) {
      // Out-of-plane reference stays out of plane; no twist into the curve plane.
      expectVec(f.normal, [0, 0, 1], 4);
    }
  });

  it('honours the initial normal hint, projected perpendicular to the tangent', () => {
    const samples: CenterlineSample[] = [{ position: [0, 0, 0], tangent: [0, 0, 1] }];
    const frames = rotationMinimizingFrames(samples, [1, 0, 0]);
    expectVec(frames[0].normal, [1, 0, 0], 6);
  });

  it('returns an empty array for no samples', () => {
    expect(rotationMinimizingFrames([])).toEqual([]);
  });
});

describe('sampleVolumeTrilinear', () => {
  const vol = makeVolume([3, 3, 3], (x) => x); // value == column index

  it('returns the voxel value at an exact voxel centre', () => {
    expect(sampleVolumeTrilinear(vol, IDENTITY, [1, 1, 1])).toBeCloseTo(1, 6);
    expect(sampleVolumeTrilinear(vol, IDENTITY, [2, 0, 2])).toBeCloseTo(2, 6);
  });

  it('blends linearly between voxels', () => {
    expect(sampleVolumeTrilinear(vol, IDENTITY, [1.5, 0, 0])).toBeCloseTo(1.5, 6);
    expect(sampleVolumeTrilinear(vol, IDENTITY, [0.25, 0, 0])).toBeCloseTo(0.25, 6);
  });

  it('returns NaN outside the voxel grid', () => {
    expect(sampleVolumeTrilinear(vol, IDENTITY, [-1, 0, 0])).toBeNaN();
    expect(sampleVolumeTrilinear(vol, IDENTITY, [0, 0, 2.6])).toBeNaN();
  });
});

describe('straightenedCpr', () => {
  it('reports geometry: row/column spacing and dimensions', () => {
    const vol = makeVolume([11, 11, 11], () => 0);
    const cpr = straightenedCpr(
      vol,
      [
        [5, 5, 0],
        [5, 5, 10],
      ],
      {
        stepMm: 1,
        halfWidthMm: 3,
        acrossStepMm: 1,
      },
    );
    expect(cpr.height).toBe(11); // z = 0..10
    expect(cpr.width).toBe(7); // 2*3 + 1
    expect(cpr.mmPerRow).toBeCloseTo(1, 6);
    expect(cpr.mmPerColumn).toBeCloseTo(1, 6);
    expect(cpr.data).toHaveLength(7 * 11);
  });

  it('produces a coherent reformat with the centre column on the path', () => {
    // value encodes (x, y) so we can see which axis the cut follows.
    const vol = makeVolume([11, 11, 11], (x, y) => x * 100 + y);
    const opts = { stepMm: 1, halfWidthMm: 3, acrossStepMm: 1 } as const;
    const path: Vec3[] = [
      [5, 5, 0],
      [5, 5, 10],
    ];

    const flat = straightenedCpr(vol, path, opts);
    const half = (flat.width - 1) / 2;
    // The centre column samples the path itself: value at (5,5,z) == 505 every row.
    for (let row = 0; row < flat.height; row++) {
      expect(flat.data[row * flat.width + half]).toBeCloseTo(505, 4);
    }
    // Off-centre columns vary smoothly across the cut.
    const r0 = (i: number): number => flat.data[i];
    expect(r0(half + 1)).not.toBeCloseTo(r0(half), 4);
  });

  it('rotating the cutting direction changes which axis the cut follows', () => {
    const vol = makeVolume([11, 11, 11], (x, y) => x * 100 + y);
    const opts = { stepMm: 1, halfWidthMm: 3, acrossStepMm: 1 } as const;
    const path: Vec3[] = [
      [5, 5, 0],
      [5, 5, 10],
    ];

    const flat = straightenedCpr(vol, path, { ...opts, angle: 0 });
    const rot = straightenedCpr(vol, path, { ...opts, angle: Math.PI / 2 });
    const half = (flat.width - 1) / 2;

    // Centre column is the path point in both -> identical.
    expect(rot.data[half]).toBeCloseTo(flat.data[half], 4);
    // An off-centre column samples a different axis after the 90° rotation.
    const col = half + 2;
    expect(rot.data[col]).not.toBeCloseTo(flat.data[col], 2);
  });

  it('fills out-of-volume samples with the background value', () => {
    const vol = makeVolume([11, 11, 11], (x, y) => x * 100 + y);
    const background = -1000;
    const cpr = straightenedCpr(
      vol,
      [
        [5, 5, 0],
        [5, 5, 10],
      ],
      {
        stepMm: 1,
        halfWidthMm: 10, // cut runs well past the volume edges
        acrossStepMm: 1,
        angle: 0,
        background,
      },
    );
    // Edge columns leave the volume in y -> background; centre stays finite.
    const half = (cpr.width - 1) / 2;
    expect(cpr.data[0]).toBe(background);
    expect(cpr.data[cpr.width - 1]).toBe(background);
    expect(cpr.data[half]).not.toBe(background);
  });

  it('keeps a straight bright vessel centred in the reformat', () => {
    // A bright cylinder along z, centred at (x=5, y=5); background 0.
    const vol = makeVolume([11, 11, 11], (x, y) => (Math.hypot(x - 5, y - 5) <= 1.2 ? 1000 : 0));
    const cpr = straightenedCpr(
      vol,
      [
        [5, 5, 0],
        [5, 5, 10],
      ],
      {
        stepMm: 1,
        halfWidthMm: 4,
        acrossStepMm: 1,
      },
    );
    const half = (cpr.width - 1) / 2;
    for (let row = 0; row < cpr.height; row++) {
      // Bright core in the centre, dark at the rim of every reformatted row.
      expect(cpr.data[row * cpr.width + half]).toBeGreaterThan(500);
      expect(cpr.data[row * cpr.width]).toBeLessThan(500);
      expect(cpr.data[row * cpr.width + cpr.width - 1]).toBeLessThan(500);
    }
  });

  it('returns a 1x1 background image for a degenerate path', () => {
    const vol = makeVolume([4, 4, 4], () => 7);
    const cpr = straightenedCpr(vol, [[0, 0, 0]], { stepMm: 1, halfWidthMm: 2 });
    expect(cpr.width).toBe(1);
    expect(cpr.height).toBe(1);
    expect(cpr.data[0]).toBe(vol.min);
  });
});

// --- small vector helpers for the assertions above -------------------------

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : a;
}
