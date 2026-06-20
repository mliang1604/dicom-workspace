import { Orientation, type Vec3, type Volume, type VolumeGeometry } from '../dicom/types';
import { dot, sub } from '../dicom/vec3';
import {
  clipPlaneTex,
  clipTRange,
  orientTowardRay,
  planeExtentMm,
  planePixelDims,
  planeToTex,
  patientToTexMatrix,
  slabTRange,
  sliceClipPlaneTex,
  sliceCountFor,
  slicePlaneCorners,
  texCoordAt,
  viewClipHalfSpaces,
  type HalfSpace,
  type PatientPlane,
  type VolumeBounds,
} from './reslice';

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

describe('planePixelDims', () => {
  it('gives each plane the through-plane counts of the other two orientations', () => {
    const volume = makeVolume([5, 4, 3]); // x=5, y=4, z=3
    // Axial spans x (5, sagittal's walk) × y (4, coronal's walk).
    expect(planePixelDims(volume, Orientation.Axial)).toEqual([5, 4]);
    // Coronal spans x (5) × z (3, axial's walk).
    expect(planePixelDims(volume, Orientation.Coronal)).toEqual([5, 3]);
    // Sagittal spans y (4) × z (3).
    expect(planePixelDims(volume, Orientation.Sagittal)).toEqual([4, 3]);
  });
});

describe('slabTRange', () => {
  // Centre at the origin, radius 10 → full depth (diameter) is 20.
  const bounds: VolumeBounds = {
    min: [-10, -10, -10],
    max: [10, 10, 10],
    center: [0, 0, 0],
    radius: 10,
  };
  // Eye 20 mm in front of the centre (depth0 = −20); the centre sits at t = 20.
  const eye: Vec3 = [0, 0, -20];
  const forward: Vec3 = [0, 0, 1];

  it('centres a thin slab on the volume centre along the view direction', () => {
    // 4 mm slab → t ∈ [18, 22], a 4 mm interval bracketing the centre at t = 20.
    expect(slabTRange(bounds, eye, forward, 4)).toEqual([18, 22]);
  });

  it('is unbounded at full thickness, leaving the march unclipped', () => {
    expect(slabTRange(bounds, eye, forward, 20)).toEqual([-Infinity, Infinity]);
    expect(slabTRange(bounds, eye, forward, 1000)).toEqual([-Infinity, Infinity]);
  });

  it('accounts for the eye offset so the slab tracks the actual view depth', () => {
    // Move the eye twice as far; depth0 = −40, so the centre (and slab) shift to t = 40.
    expect(slabTRange(bounds, [0, 0, -40], forward, 6)).toEqual([37, 43]);
  });
});

describe('slicePlaneCorners', () => {
  it('outlines the axial slice as a constant-z rectangle spanning the volume', () => {
    const volume = makeVolume([4, 4, 4]); // patient box [-0.5, 3.5] per axis, 4 slices
    // Slice 2 → slicePos (2 + 0.5) / 4 = 0.625 → z = -0.5 + 0.625·4 = 2.0.
    const corners = slicePlaneCorners(volume, Orientation.Axial, 2);

    expectVec(corners[0], [-0.5, -0.5, 2]);
    expectVec(corners[1], [3.5, -0.5, 2]);
    expectVec(corners[2], [3.5, 3.5, 2]);
    expectVec(corners[3], [-0.5, 3.5, 2]);
  });

  it('walks the sagittal plane along patient +x with the slice index', () => {
    const volume = makeVolume([4, 4, 4]);
    // Sagittal slicePos walks +x; slice 0 → x = -0.5 + 0.125·4 = 0.0.
    const corners = slicePlaneCorners(volume, Orientation.Sagittal, 0);

    for (const corner of corners) expect(corner[0]).toBeCloseTo(0, 6); // all share x
  });
});

describe('sliceClipPlaneTex', () => {
  it('is the signed field slicePos(tex) − slicePos₀ for the axial slice', () => {
    // Identity volume: axial slicePos maps straight to tex.z, so the plane is
    // tex.z − slicePos₀ with slicePos₀ = (2 + 0.5) / 4 = 0.625.
    const volume = makeVolume([4, 4, 4]);
    const plane = sliceClipPlaneTex(volume, Orientation.Axial, 2);

    expectVec(plane.normal, [0, 0, 1]);
    expect(plane.offset).toBeCloseTo(-0.625, 6);
    // Zero on the slice, positive on the +slicePos side, negative below it.
    expect(dot(plane.normal, [0.5, 0.5, 0.625]) + plane.offset).toBeCloseTo(0, 6);
    expect(dot(plane.normal, [0.5, 0.5, 0.8]) + plane.offset).toBeGreaterThan(0);
    expect(dot(plane.normal, [0.5, 0.5, 0.4]) + plane.offset).toBeLessThan(0);
  });

  it('places the sagittal plane along the tex.x (patient +x) axis', () => {
    const volume = makeVolume([4, 4, 4]);
    const plane = sliceClipPlaneTex(volume, Orientation.Sagittal, 1);
    // slicePos₀ = (1 + 0.5) / 4 = 0.375 along +x.
    expectVec(plane.normal, [1, 0, 0]);
    expect(plane.offset).toBeCloseTo(-0.375, 6);
  });
});

describe('clipPlaneTex', () => {
  // A permuted, non-unit geometry so the Bᵀ transform — not just an axis swap —
  // is exercised: a clip plane's coefficients don't transform like a direction.
  const geometry: VolumeGeometry = {
    iStep: [0, 2, 0],
    jStep: [0, 0, -1],
    kStep: [3, 0, 0],
    origin: [5, 6, 7],
  };
  const volume = makeVolume([4, 5, 6], geometry);
  const m = patientToTexMatrix(volume);

  // Texture coordinate of a patient point via the column-major affine.
  const toTex = (p: Vec3): Vec3 => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];

  it('matches the patient-space signed distance dot(normal, p − point) in texture space', () => {
    const plane: PatientPlane = { point: [6, 7, 9], normal: [0.3, -0.5, 0.8] };
    const hs = clipPlaneTex(volume, plane);
    const points: Vec3[] = [
      [5, 6, 7],
      [8, 9, 12],
      [6, 7, 9],
      [10, 4, 8],
    ];
    for (const p of points) {
      const valueTex = dot(hs.normal, toTex(p)) + hs.offset;
      const valuePatient = dot(plane.normal, sub(p, plane.point));
      expect(valueTex).toBeCloseTo(valuePatient, 6);
    }
  });

  it('keeps the half-space the normal points into', () => {
    const plane: PatientPlane = { point: [7, 7, 9], normal: [1, 0, 0] };
    const hs = clipPlaneTex(volume, plane);
    expect(dot(hs.normal, toTex([9, 7, 9])) + hs.offset).toBeGreaterThan(0); // +normal side kept
    expect(dot(hs.normal, toTex([5, 7, 9])) + hs.offset).toBeLessThan(0); // −normal side clipped
  });

  it('clips a march to where the plane cuts the ray, via clipTRange', () => {
    // Identity volume so the t-range is easy to reason about: a ray straight up +z.
    const id = makeVolume([4, 4, 4]);
    const plane: PatientPlane = { point: [1.5, 1.5, 1.5], normal: [0, 0, 1] }; // keep z ≥ 1.5 mm
    const hs = clipPlaneTex(id, plane);
    const ro: Vec3 = [0.5, 0.5, 0]; // tex-space ray up the central column, entering at z = 0
    const rd: Vec3 = [0, 0, 1];
    // The plane sits at tex.z = (1.5 + 0.5) / 4 = 0.5, so the kept entry is t = 0.5.
    const [lo, hi] = clipTRange([hs], ro, rd, 0, 1);
    expect(lo).toBeCloseTo(0.5, 6);
    expect(hi).toBeCloseTo(1, 6);
  });

  it('flips which half is kept when the normal is negated', () => {
    const id = makeVolume([4, 4, 4]);
    const hs = clipPlaneTex(id, { point: [1.5, 1.5, 1.5], normal: [0, 0, -1] }); // keep z ≤ 1.5 mm
    const [lo, hi] = clipTRange([hs], [0.5, 0.5, 0], [0, 0, 1], 0, 1);
    expect(lo).toBeCloseTo(0, 6);
    expect(hi).toBeCloseTo(0.5, 6);
  });
});

describe('orientTowardRay', () => {
  const plane: HalfSpace = { normal: [0, 0, 1], offset: -0.5 };

  it('leaves a plane whose normal already follows the ray', () => {
    expect(orientTowardRay(plane, [0, 0, 1])).toBe(plane);
  });

  it('flips a plane so its kept side is the far (large-t) half of the ray', () => {
    const flipped = orientTowardRay(plane, [0, 0, -1]);
    expectVec(flipped.normal, [0, 0, -1]);
    expect(flipped.offset).toBeCloseTo(0.5, 6);
  });
});

describe('clipTRange', () => {
  const ro: Vec3 = [0, 0, 0];
  const rd: Vec3 = [0, 0, 1];

  it('returns the interval unchanged with no half-spaces', () => {
    expect(clipTRange([], ro, rd, 0, 1)).toEqual([0, 1]);
  });

  it('clamps the entry to a plane that keeps the far side', () => {
    // Keep tex.z ≥ 0.5 → t ≥ 0.5 along this ray.
    expect(clipTRange([{ normal: [0, 0, 1], offset: -0.5 }], ro, rd, 0, 1)).toEqual([0.5, 1]);
  });

  it('intersects two opposing half-spaces into the band between them', () => {
    const planes: HalfSpace[] = [
      { normal: [0, 0, 1], offset: -0.3 }, // tex.z ≥ 0.3
      { normal: [0, 0, -1], offset: 0.7 }, // tex.z ≤ 0.7
    ];
    expect(clipTRange(planes, ro, rd, 0, 1)).toEqual([0.3, 0.7]);
  });

  it('collapses the interval when the ray runs parallel to and outside a plane', () => {
    // Keep tex.x ≥ 0.5, but the ray sits at tex.x = 0 with no x component.
    const [lo, hi] = clipTRange([{ normal: [1, 0, 0], offset: -0.5 }], ro, rd, 0, 1);
    expect(lo).toBeGreaterThan(hi); // empty → the caller reads a fully clipped ray
  });

  it('leaves the interval untouched when parallel and inside a plane', () => {
    // Keep tex.x ≥ −0.5; the ray at tex.x = 0 is inside it for all t.
    expect(clipTRange([{ normal: [1, 0, 0], offset: 0.5 }], ro, rd, 0, 1)).toEqual([0, 1]);
  });
});

describe('viewClipHalfSpaces', () => {
  it('orients all three cut-planes to keep the far side of the view ray', () => {
    const volume = makeVolume([4, 4, 4]);
    const rd: Vec3 = [0.2, -0.3, 1]; // an arbitrary texture-space view direction
    const planes = viewClipHalfSpaces(volume, [2, 2, 2], rd);

    expect(planes).toHaveLength(3);
    // Every kept-side normal points downstream of the ray (kept half is large t).
    for (const plane of planes) expect(dot(plane.normal, rd)).toBeGreaterThanOrEqual(0);
  });
});
