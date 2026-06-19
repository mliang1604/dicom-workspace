import { Orientation, type Vec3, type Volume, type VolumeGeometry } from '../dicom/types';
import {
  cameraBasis,
  eyeDirection,
  intersectUnitBox,
  projectToPane,
  type OrbitCamera,
} from './camera';
import { add, scale } from '../dicom/vec3';
import { patientToTexMatrix, planeToTex, texCoordAt } from './reslice';

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

/** Apply the column-major patient→texture affine to a patient point. */
function applyPatientToTex(m: Float32Array, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

const LEVEL: OrbitCamera = { azimuth: 0, elevation: 0, zoom: 1 };

describe('eyeDirection', () => {
  it('looks from anterior (LPS −y) with superior up at the default angles', () => {
    expectVec(eyeDirection(0, 0), [0, -1, 0]);
  });

  it('azimuth orbits about the superior axis', () => {
    expectVec(eyeDirection(Math.PI / 2, 0), [1, 0, 0]); // patient-left side
    expectVec(eyeDirection(Math.PI, 0), [0, 1, 0]); // posterior
  });

  it('elevation lifts the eye toward superior', () => {
    expectVec(eyeDirection(0, Math.PI / 2), [0, 0, 1]);
  });
});

describe('cameraBasis', () => {
  it('looks at the volume from anterior with patient-left to the right', () => {
    const volume = makeVolume([4, 4, 4]); // patient box spans [-0.5, 3.5] each axis
    const basis = cameraBasis(volume, LEVEL, 100, 100);

    // Forward points into the screen (anterior → posterior).
    expectVec(basis.forward, [0, 1, 0]);
    // Square pane, zoom 1: image-plane axes are the bounding-sphere radius long.
    const radius = 0.5 * Math.hypot(4, 4, 4);
    expectVec(basis.axisU, [radius, 0, 0]); // +x patient-left → screen right
    expectVec(basis.axisV, [0, 0, radius]); // +z superior → screen up
    // The eye sits on the anterior side of the box centre (1.5, 1.5, 1.5).
    expect(basis.eye[1]).toBeLessThan(1.5);
  });

  it('zoom shrinks the orthographic extent', () => {
    const volume = makeVolume([4, 4, 4]);
    const wide = cameraBasis(volume, LEVEL, 100, 100);
    const zoomed = cameraBasis(volume, { ...LEVEL, zoom: 2 }, 100, 100);

    expect(Math.hypot(...zoomed.axisU)).toBeCloseTo(Math.hypot(...wide.axisU) / 2, 6);
  });

  it('widens the longer pane axis to keep pixels square', () => {
    const volume = makeVolume([4, 4, 4]);
    const basis = cameraBasis(volume, LEVEL, 200, 100); // 2:1 pane

    // The wider axis (U) is twice the height axis (V), so the fit stays square.
    expect(Math.hypot(...basis.axisU)).toBeCloseTo(Math.hypot(...basis.axisV) * 2, 6);
  });
});

describe('projectToPane', () => {
  it('inverts the shader ray construction back to pane-fraction uv', () => {
    const volume = makeVolume([4, 4, 4]);
    const basis = cameraBasis(volume, LEVEL, 100, 100);

    // Build the world point the shader would for ndc (0.3, −0.4), then project back.
    const point = add(add(basis.eye, scale(basis.axisU, 0.3)), scale(basis.axisV, -0.4));
    const projected = projectToPane(basis, point);

    expect(projected.u).toBeCloseTo((0.3 + 1) / 2, 6); // ndc.x = u·2 − 1
    expect(projected.v).toBeCloseTo((1 - -0.4) / 2, 6); // ndc.y = 1 − v·2
  });

  it('ignores the depth along forward when resolving uv', () => {
    const volume = makeVolume([4, 4, 4]);
    const basis = cameraBasis(volume, LEVEL, 100, 100);

    const onPlane = add(basis.eye, scale(basis.axisU, 0.25));
    const pushedIn = add(onPlane, scale(basis.forward, 5)); // 5 mm deeper into the screen
    const a = projectToPane(basis, onPlane);
    const b = projectToPane(basis, pushedIn);

    expect(b.u).toBeCloseTo(a.u, 6);
    expect(b.v).toBeCloseTo(a.v, 6);
    expect(b.depth - a.depth).toBeCloseTo(5, 6);
  });
});

describe('intersectUnitBox', () => {
  it('finds the entry/exit of a ray crossing the box centre', () => {
    const hit = intersectUnitBox([0.5, 0.5, -1], [0, 0, 1]);

    expect(hit.hit).toBe(true);
    expect(hit.tEntry).toBeCloseTo(1, 6); // reaches z=0
    expect(hit.tExit).toBeCloseTo(2, 6); // exits z=1
  });

  it('misses a ray that passes outside the box', () => {
    const hit = intersectUnitBox([2, 2, -1], [0, 0, 1]);

    expect(hit.hit).toBe(false);
  });

  it('misses a ray parallel to and outside a slab', () => {
    // Travelling +x at y = 2 (outside [0,1]) never enters the box.
    expect(intersectUnitBox([-1, 2, 0.5], [1, 0, 0]).hit).toBe(false);
    // The same direction at y = 0.5 (inside) does enter.
    expect(intersectUnitBox([-1, 0.5, 0.5], [1, 0, 0]).hit).toBe(true);
  });

  it('clamps the entry to t ≥ 0 when the origin starts inside the box', () => {
    const hit = intersectUnitBox([0.5, 0.5, 0.5], [0, 0, 1]);

    expect(hit.tEntry).toBe(0);
    expect(hit.tExit).toBeCloseTo(0.5, 6);
  });
});

describe('patientToTexMatrix', () => {
  it('maps the box centre to the texture centre for an identity volume', () => {
    const volume = makeVolume([4, 4, 4]); // centre at patient (1.5, 1.5, 1.5)
    const m = patientToTexMatrix(volume);

    expectVec(applyPatientToTex(m, [1.5, 1.5, 1.5]), [0.5, 0.5, 0.5]);
    // Voxel-centre normalisation: index 0 sits at texcoord 0.5/4.
    expectVec(applyPatientToTex(m, [0, 0, 0]), [0.5 / 4, 0.5 / 4, 0.5 / 4]);
  });

  it('agrees with the plane→texture mapping at a shared point', () => {
    // The patient point under the axial plane centre must land on the same
    // texcoord whether reached via planeToTex or patientToTex.
    const volume = makeVolume([4, 4, 4]);
    const planeCentre = texCoordAt(planeToTex(volume, Orientation.Axial), 0.5, 0.5, 0.5);
    const m = patientToTexMatrix(volume);
    // Axial plane centre is patient (1.5, 1.5, 1.5) for the identity volume.
    expectVec(applyPatientToTex(m, [1.5, 1.5, 1.5]), planeCentre);
  });

  it('inverts a permuted (sagittally-acquired) geometry', () => {
    const geometry: VolumeGeometry = {
      iStep: [0, 1, 0],
      jStep: [0, 0, -1],
      kStep: [1, 0, 0],
      origin: [0, 0, 0],
    };
    const volume = makeVolume([4, 4, 4], geometry);
    const m = patientToTexMatrix(volume);

    // Patient origin voxel (0,0,0) sits at patient [0,0,0]; its texcoord is the
    // voxel-centre normalisation 0.5/4 along each acquisition axis.
    expectVec(applyPatientToTex(m, [0, 0, 0]), [0.5 / 4, 0.5 / 4, 0.5 / 4]);
    // Stepping +1 patient-left (+x = k axis) advances the third texcoord by 1/4.
    expectVec(applyPatientToTex(m, [1, 0, 0]), [0.5 / 4, 0.5 / 4, 1.5 / 4]);
  });
});
