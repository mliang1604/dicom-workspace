import { Orientation, type Vec3, type Volume, type VolumeGeometry } from '../dicom/types';
import {
  classifyContour,
  contourOnPlane,
  contourPlaneResult,
  crossSectionOutline,
  decimate,
  patientToPlane,
  projectContour,
  sliceCrossings,
  sliceSegments,
  type CrossSectionRow,
} from './contours';
import type { PlaneCoords } from './reslice';

/** An identity-geometry cube whose patient coordinates equal voxel indices. */
function makeVolume(dim: number, geometry?: VolumeGeometry): Volume {
  const data = new Float32Array(dim * dim * dim);
  return {
    dims: [dim, dim, dim],
    spacing: [1, 1, 1],
    data,
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

describe('patientToPlane', () => {
  it('maps a patient point to the voxel-centre in-plane coordinates', () => {
    const volume = makeVolume(8);
    // Identity geometry: patient (2, 3, 4) is voxel (2, 3, 4); its centre is
    // (index + 0.5) / 8 of the axial plane, slicePos along +z.
    const pc = patientToPlane(volume, Orientation.Axial, [2, 3, 4])!;

    expect(pc.u).toBeCloseTo(2.5 / 8, 6);
    expect(pc.v).toBeCloseTo(3.5 / 8, 6);
    expect(pc.slicePos).toBeCloseTo(4.5 / 8, 6);
  });

  it('reslices the same point onto another orientation', () => {
    const volume = makeVolume(8);
    // Coronal: u follows +x, v follows -z (superior up), slicePos walks +y.
    const pc = patientToPlane(volume, Orientation.Coronal, [2, 3, 4])!;

    expect(pc.u).toBeCloseTo(2.5 / 8, 6);
    expect(pc.v).toBeCloseTo(1 - 4.5 / 8, 6);
    expect(pc.slicePos).toBeCloseTo(3.5 / 8, 6);
  });

  it('returns null for a singular volume geometry', () => {
    const degenerate: VolumeGeometry = {
      iStep: [1, 0, 0],
      jStep: [2, 0, 0], // collinear with iStep → non-invertible
      kStep: [0, 0, 1],
      origin: [0, 0, 0],
    };
    const volume = makeVolume(4, degenerate);

    expect(patientToPlane(volume, Orientation.Axial, [1, 1, 1])).toBeNull();
  });
});

describe('sliceCrossings', () => {
  // A unit square in (u, v, slicePos) standing across the slicePos = 0.5 plane:
  // two edges straddle it, two run parallel.
  const square: PlaneCoords[] = [
    { u: 0.2, v: 0.5, slicePos: 0.2 },
    { u: 0.8, v: 0.5, slicePos: 0.2 },
    { u: 0.8, v: 0.5, slicePos: 0.8 },
    { u: 0.2, v: 0.5, slicePos: 0.8 },
  ];

  it('interpolates one crossing per straddling edge', () => {
    const crossings = sliceCrossings(square, 0.5, true);

    expect(crossings).toHaveLength(2);
    // Each crossing sits at the midpoint of a vertical edge (slicePos 0.2→0.8).
    expect(crossings).toContainEqual({ u: 0.8, v: 0.5 });
    expect(crossings).toContainEqual({ u: 0.2, v: 0.5 });
  });

  it('does not wrap the final edge when the contour is open', () => {
    // Drop the closing edge: only edge 1→2 and 2→3 remain, one of which crosses.
    const open = sliceCrossings(square, 0.5, false);
    expect(open).toHaveLength(1);
  });

  it('returns nothing when the plane misses the polygon', () => {
    expect(sliceCrossings(square, 0.9, true)).toHaveLength(0);
  });

  it('keeps the crossing count even when a vertex lies on the plane', () => {
    const triangle: PlaneCoords[] = [
      { u: 0, v: 0, slicePos: 0.5 }, // exactly on the plane
      { u: 1, v: 0, slicePos: 1 },
      { u: 1, v: 0, slicePos: 0 },
    ];
    // The half-open side test (on-plane counts as "not above") keeps the count
    // even, so the crossings always pair into segments rather than leaving a
    // dangling one at the shared vertex.
    expect(sliceCrossings(triangle, 0.5, true).length % 2).toBe(0);
  });
});

describe('sliceSegments', () => {
  it('pairs collinear crossings into spans along the cut line', () => {
    // A concave shape giving four crossings on one line → two filled spans.
    const coords: PlaneCoords[] = [
      { u: 0.0, v: 0, slicePos: 0 },
      { u: 0.0, v: 0, slicePos: 1 },
      { u: 0.25, v: 0, slicePos: 1 },
      { u: 0.25, v: 0, slicePos: 0 },
      { u: 0.5, v: 0, slicePos: 0 },
      { u: 0.5, v: 0, slicePos: 1 },
      { u: 0.75, v: 0, slicePos: 1 },
      { u: 0.75, v: 0, slicePos: 0 },
    ];
    const segments = sliceSegments(coords, 0.5, true);

    expect(segments).toHaveLength(2);
    expect(segments[0][0].u).toBeCloseTo(0.0, 6);
    expect(segments[0][1].u).toBeCloseTo(0.25, 6);
    expect(segments[1][0].u).toBeCloseTo(0.5, 6);
    expect(segments[1][1].u).toBeCloseTo(0.75, 6);
  });

  it('returns no segment for a single unpaired crossing', () => {
    const coords: PlaneCoords[] = [
      { u: 0, v: 0, slicePos: 0.4 },
      { u: 1, v: 0, slicePos: 0.6 },
    ];
    // The open polyline straddles the plane once; a lone crossing can't form a span.
    expect(sliceSegments(coords, 0.5, false)).toHaveLength(0);
  });
});

describe('contourOnPlane', () => {
  const dim = 8;
  // An axial square loop at z = 4, spanning x,y ∈ [2, 5].
  const loop: Vec3[] = [
    [2, 2, 4],
    [5, 2, 4],
    [5, 5, 4],
    [2, 5, 4],
  ];

  it('projects a coplanar loop onto its own axial slice', () => {
    const volume = makeVolume(dim);
    const result = contourOnPlane(volume, Orientation.Axial, 4, loop, true);

    expect(result).toHaveLength(1);
    expect(result[0].closed).toBe(true);
    expect(result[0].points).toHaveLength(4);
    expect(result[0].points[0].u).toBeCloseTo(2.5 / 8, 6);
    expect(result[0].points[0].v).toBeCloseTo(2.5 / 8, 6);
  });

  it('hides a coplanar loop when scrolled to another slice', () => {
    const volume = makeVolume(dim);
    expect(contourOnPlane(volume, Orientation.Axial, 5, loop, true)).toHaveLength(0);
  });

  it('intersects an axial loop seen edge-on in coronal', () => {
    const volume = makeVolume(dim);
    // Coronal slice 3 (patient y ≈ 3) cuts the loop spanning y ∈ [2, 5].
    const result = contourOnPlane(volume, Orientation.Coronal, 3, loop, true);

    expect(result).toHaveLength(1);
    expect(result[0].closed).toBe(false);
    const [a, b] = result[0].points;
    // A horizontal cross-section at the loop's z (= 4 → v = 1 − 4.5/8).
    expect(a.v).toBeCloseTo(1 - 4.5 / 8, 6);
    expect(b.v).toBeCloseTo(1 - 4.5 / 8, 6);
    expect(Math.min(a.u, b.u)).toBeCloseTo(2.5 / 8, 6);
    expect(Math.max(a.u, b.u)).toBeCloseTo(5.5 / 8, 6);
  });

  it('ignores degenerate contours with fewer than two points', () => {
    const volume = makeVolume(dim);
    expect(contourOnPlane(volume, Orientation.Axial, 4, [[1, 1, 1]], true)).toHaveLength(0);
  });
});

describe('crossSectionOutline', () => {
  it('joins per-slice spans into a closed left/right silhouette', () => {
    // Three stacked rows (slices) with widening then narrowing spans → a closed
    // outline that traces min-u down one side and max-u up the other.
    const rows: CrossSectionRow[] = [
      { v: 0.2, us: [0.4, 0.6] },
      { v: 0.5, us: [0.3, 0.7] },
      { v: 0.8, us: [0.45, 0.55] },
    ];
    const out = crossSectionOutline(rows);
    expect(out).toHaveLength(1);
    expect(out[0].closed).toBe(true);
    // left envelope (v ascending) then right envelope (v descending).
    expect(out[0].points).toEqual([
      { u: 0.4, v: 0.2 },
      { u: 0.3, v: 0.5 },
      { u: 0.45, v: 0.8 },
      { u: 0.55, v: 0.8 },
      { u: 0.7, v: 0.5 },
      { u: 0.6, v: 0.2 },
    ]);
  });

  it('takes the outer envelope when a row has multiple spans (concave)', () => {
    const rows: CrossSectionRow[] = [
      { v: 0.3, us: [0.2, 0.4, 0.6, 0.8] }, // two spans → outer extent 0.2..0.8
      { v: 0.6, us: [0.3, 0.7] },
    ];
    const out = crossSectionOutline(rows);
    expect(out[0].closed).toBe(true);
    expect(out[0].points).toContainEqual({ u: 0.2, v: 0.3 });
    expect(out[0].points).toContainEqual({ u: 0.8, v: 0.3 });
  });

  it('draws a single row as an open span, and nothing for no rows', () => {
    expect(crossSectionOutline([{ v: 0.5, us: [0.2, 0.8] }])).toEqual([
      {
        points: [
          { u: 0.2, v: 0.5 },
          { u: 0.8, v: 0.5 },
        ],
        closed: false,
      },
    ]);
    expect(crossSectionOutline([])).toEqual([]);
  });
});

describe('decimate', () => {
  it('drops near-collinear points but keeps the shape corners', () => {
    const line = [
      { u: 0, v: 0 },
      { u: 0.25, v: 0.001 }, // ~on the line → dropped
      { u: 0.5, v: 0 },
      { u: 0.75, v: 0.001 }, // ~on the line → dropped
      { u: 1, v: 0 },
    ];
    expect(decimate(line, 0.01)).toEqual([
      { u: 0, v: 0 },
      { u: 1, v: 0 },
    ]);
  });

  it('keeps a real corner that exceeds the tolerance', () => {
    const corner = [
      { u: 0, v: 0 },
      { u: 0.5, v: 0.5 }, // far from the 0,0–1,0 line → kept
      { u: 1, v: 0 },
    ];
    expect(decimate(corner, 0.01)).toHaveLength(3);
  });

  it('returns the input unchanged for two or fewer points', () => {
    const pts = [
      { u: 0, v: 0 },
      { u: 1, v: 1 },
    ];
    expect(decimate(pts, 0.1)).toEqual(pts);
  });
});

describe('contourPlaneResult', () => {
  const dim = 8;
  // A square loop in the z = 4 plane, spanning x,y ∈ [2, 5].
  const loop: Vec3[] = [
    [2, 2, 4],
    [5, 2, 4],
    [5, 5, 4],
    [2, 5, 4],
  ];

  it('classifies a coplanar loop on its own axial slice', () => {
    const res = contourPlaneResult(makeVolume(dim), Orientation.Axial, 4, loop, true);
    expect(res?.kind).toBe('loop');
  });

  it('returns null for a coplanar loop scrolled to another slice', () => {
    expect(contourPlaneResult(makeVolume(dim), Orientation.Axial, 6, loop, true)).toBeNull();
  });

  it('returns a constant-v crossing row when cut edge-on in coronal', () => {
    const res = contourPlaneResult(makeVolume(dim), Orientation.Coronal, 3, loop, true);
    expect(res?.kind).toBe('cross');
    if (res?.kind === 'cross') {
      expect(res.row.us.length).toBeGreaterThanOrEqual(2);
      expect(res.row.v).toBeCloseTo(1 - 4.5 / 8, 6);
    }
  });
});

describe('projectContour / classifyContour (cached split)', () => {
  const dim = 8;
  const loop: Vec3[] = [
    [2, 2, 4],
    [5, 2, 4],
    [5, 5, 4],
    [2, 5, 4],
  ];

  it('projects once with a precomputed through-plane span, then classifies per slice', () => {
    const volume = makeVolume(dim);
    const projected = projectContour(volume, Orientation.Axial, loop, true)!;
    expect(projected).not.toBeNull();
    // A flat axial loop: min ≈ max ≈ mean slicePos (z = 4 → 4.5/8).
    expect(projected.minSlicePos).toBeCloseTo(4.5 / 8, 6);
    expect(projected.maxSlicePos).toBeCloseTo(4.5 / 8, 6);
    expect(projected.meanSlicePos).toBeCloseTo(4.5 / 8, 6);

    // Re-classifying against different slices reuses the same projection.
    expect(classifyContour(projected, volume, Orientation.Axial, 4)?.kind).toBe('loop');
    expect(classifyContour(projected, volume, Orientation.Axial, 6)).toBeNull(); // off-slice
  });

  it('matches contourPlaneResult for the crossing (coronal) case', () => {
    const volume = makeVolume(dim);
    const projected = projectContour(volume, Orientation.Coronal, loop, true)!;
    const viaSplit = classifyContour(projected, volume, Orientation.Coronal, 3);
    const direct = contourPlaneResult(volume, Orientation.Coronal, 3, loop, true);
    expect(viaSplit).toEqual(direct);
    expect(viaSplit?.kind).toBe('cross');
  });
});
