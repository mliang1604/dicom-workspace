import { Orientation, type Vec3, type Volume, type VolumeGeometry } from '../dicom/types';
import {
  cameraBasis,
  clipPlaneGizmoGeometry,
  eyeDirection,
  intersectUnitBox,
  projectPolyline,
  projectToPane,
  rezoomCameraPan,
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

const LEVEL: OrbitCamera = { azimuth: 0, elevation: 0, zoom: 1, panX: 0, panY: 0 };

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

describe('projectPolyline', () => {
  it('scales each projected point to the pane pixel size, origin at top-left', () => {
    const volume = makeVolume([4, 4, 4]);
    const basis = cameraBasis(volume, LEVEL, 200, 100);

    // Two world points at known ndc; their projected uv scales to pane pixels.
    const a = add(add(basis.eye, scale(basis.axisU, 0.5)), scale(basis.axisV, -0.5));
    const b = basis.eye; // ndc (0, 0) → pane centre
    const pixels = projectPolyline(basis, [a, b], 200, 100);

    const pa = projectToPane(basis, a);
    expect(pixels[0].x).toBeCloseTo(pa.u * 200, 6);
    expect(pixels[0].y).toBeCloseTo(pa.v * 100, 6);
    expect(pixels[1].x).toBeCloseTo(100, 6); // pane centre x
    expect(pixels[1].y).toBeCloseTo(50, 6); // pane centre y
  });

  it('rotates with the orbit camera', () => {
    const volume = makeVolume([4, 4, 4]);
    const point: Vec3 = [3.5, 1.5, 1.5]; // patient-left edge of the box
    const front = projectPolyline(cameraBasis(volume, LEVEL, 100, 100), [point], 100, 100)[0];
    const orbited = projectPolyline(
      cameraBasis(volume, { ...LEVEL, azimuth: Math.PI / 2 }, 100, 100),
      [point],
      100,
      100,
    )[0];

    // A 90° azimuth swings the patient-left edge off its level-view position.
    expect(Math.hypot(orbited.x - front.x, orbited.y - front.y)).toBeGreaterThan(1);
  });
});

describe('rezoomCameraPan', () => {
  // The world point under the cursor before the zoom must still project to the
  // same pane uv after — the 3D twin of the MPR rezoomPan anchoring.
  function projectionUnderCursor(
    camera: OrbitCamera,
    ndcX: number,
    ndcY: number,
    width: number,
    height: number,
  ) {
    const volume = makeVolume([4, 6, 8]); // non-cubic so U and V differ
    const basis = cameraBasis(volume, camera, width, height);
    // The world point the raycaster builds for this cursor ndc on the image plane.
    const point = add(add(basis.eye, scale(basis.axisU, ndcX)), scale(basis.axisV, ndcY));
    return { volume, point };
  }

  it('keeps the cursor world point fixed when zooming in', () => {
    const start: OrbitCamera = { azimuth: 0.4, elevation: 0.25, zoom: 1, panX: 0, panY: 0 };
    const [w, h, ndcX, ndcY] = [200, 100, 0.6, -0.3];
    const { volume, point } = projectionUnderCursor(start, ndcX, ndcY, w, h);
    const before = projectToPane(cameraBasis(volume, start, w, h), point);

    const toZoom = 1.8;
    const { panX, panY } = rezoomCameraPan(volume, start, w, h, toZoom, ndcX, ndcY);
    const zoomed: OrbitCamera = { ...start, zoom: toZoom, panX, panY };
    const after = projectToPane(cameraBasis(volume, zoomed, w, h), point);

    expect(after.u).toBeCloseTo(before.u, 6);
    expect(after.v).toBeCloseTo(before.v, 6);
  });

  it('keeps the cursor world point fixed when zooming out from a panned camera', () => {
    const start: OrbitCamera = { azimuth: 0.4, elevation: 0.25, zoom: 2, panX: 1.5, panY: -0.7 };
    const [w, h, ndcX, ndcY] = [120, 160, -0.5, 0.45];
    const { volume, point } = projectionUnderCursor(start, ndcX, ndcY, w, h);
    const before = projectToPane(cameraBasis(volume, start, w, h), point);

    const toZoom = 1.1;
    const { panX, panY } = rezoomCameraPan(volume, start, w, h, toZoom, ndcX, ndcY);
    const zoomed: OrbitCamera = { ...start, zoom: toZoom, panX, panY };
    const after = projectToPane(cameraBasis(volume, zoomed, w, h), point);

    expect(after.u).toBeCloseTo(before.u, 6);
    expect(after.v).toBeCloseTo(before.v, 6);
  });

  it('leaves the pan unchanged when the cursor is at the pane centre', () => {
    const start: OrbitCamera = { azimuth: 0.4, elevation: 0.25, zoom: 1, panX: 0.3, panY: 0.2 };
    const next = rezoomCameraPan(makeVolume([4, 4, 4]), start, 100, 100, 2, 0, 0);

    expect(next.panX).toBeCloseTo(0.3, 6);
    expect(next.panY).toBeCloseTo(0.2, 6);
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

describe('clipPlaneGizmoGeometry', () => {
  const RECT = { x: 0, y: 0, width: 100, height: 100 };
  // Per-mm screen step at zoom 1: width / (2·radius) for a [4,4,4] box.
  const perMm = 100 / Math.hypot(4, 4, 4);

  /** Parse an SVG `points` string into pixel pairs. */
  function points(s: string): { x: number; y: number }[] {
    return s
      .trim()
      .split(' ')
      .map((p) => {
        const [x, y] = p.split(',').map(Number);
        return { x, y };
      });
  }

  it('centres the handle on the pane and echoes the rect at zero offset', () => {
    const volume = makeVolume([4, 4, 4]); // centre projects to the pane centre
    const g = clipPlaneGizmoGeometry(volume, LEVEL, [1, 0, 0], 0, RECT);
    expect(g.rect).toBe(RECT);
    expect(g.handle.x).toBeCloseTo(50, 6);
    expect(g.handle.y).toBeCloseTo(50, 6);
  });

  it('draws a square outline of four corners centred on the handle', () => {
    const volume = makeVolume([4, 4, 4]);
    const g = clipPlaneGizmoGeometry(volume, LEVEL, [0, 1, 0], 0, RECT);
    const corners = points(g.outline);
    expect(corners).toHaveLength(4);
    const cx = corners.reduce((s, c) => s + c.x, 0) / 4;
    const cy = corners.reduce((s, c) => s + c.y, 0) / 4;
    expect(cx).toBeCloseTo(g.handle.x, 6);
    expect(cy).toBeCloseTo(g.handle.y, 6);
  });

  it('maps a 1 mm normal step to a screen-right drag axis for an x normal', () => {
    const volume = makeVolume([4, 4, 4]);
    const g = clipPlaneGizmoGeometry(volume, LEVEL, [1, 0, 0], 0, RECT);
    // Patient +x is screen-right at the default view; no vertical component.
    expect(g.axisX).toBeCloseTo(perMm, 6);
    expect(g.axisY).toBeCloseTo(0, 6);
  });

  it('maps a superior normal to an upward (negative-y) drag axis', () => {
    const volume = makeVolume([4, 4, 4]);
    const g = clipPlaneGizmoGeometry(volume, LEVEL, [0, 0, 1], 0, RECT);
    // +z superior is screen-up, which is a smaller CSS y.
    expect(g.axisX).toBeCloseTo(0, 6);
    expect(g.axisY).toBeCloseTo(-perMm, 6);
  });

  it('has no on-screen drag axis when the normal points along the view', () => {
    const volume = makeVolume([4, 4, 4]);
    // [0,1,0] is the view forward at the default angles: a step along it only
    // changes depth, so the handle stays put on screen.
    const g = clipPlaneGizmoGeometry(volume, LEVEL, [0, 1, 0], 0, RECT);
    expect(g.axisX).toBeCloseTo(0, 6);
    expect(g.axisY).toBeCloseTo(0, 6);
  });

  it('slides the handle along the drag axis as the offset grows', () => {
    const volume = makeVolume([4, 4, 4]);
    const g = clipPlaneGizmoGeometry(volume, LEVEL, [1, 0, 0], 1, RECT);
    // One mm of offset moves the centre one drag-axis step from the pane centre.
    expect(g.handle.x).toBeCloseTo(50 + perMm, 6);
    expect(g.handle.y).toBeCloseTo(50, 6);
  });
});
