import { Orientation, type Volume } from '../dicom/types';
import type { PaneRect } from './layout';
import { paneToPlanePoint, planePointToPane } from './pane-coords';
import { probeVoxel } from './probe';

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

const SQUARE: PaneRect = { x: 0, y: 0, width: 100, height: 100 };

describe('paneToPlanePoint / planePointToPane', () => {
  const volume = makeVolume([8, 8, 8]);

  it('round-trips a pane pixel through the plane and back', () => {
    for (const orientation of [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal]) {
      const point = paneToPlanePoint(volume, orientation, 1, SQUARE, 62, 37)!;
      const back = planePointToPane(volume, orientation, point, 1, SQUARE)!;
      expect(back.x).toBeCloseTo(62, 6);
      expect(back.y).toBeCloseTo(37, 6);
    }
  });

  it('tracks the same point through zoom, pan, and flip', () => {
    const zoom = 2.5;
    const pan = { x: 0.12, y: -0.08 };
    const point = paneToPlanePoint(volume, Orientation.Sagittal, zoom, SQUARE, 70, 55, true, pan)!;
    const back = planePointToPane(volume, Orientation.Sagittal, point, zoom, SQUARE, true, pan)!;
    expect(back.x).toBeCloseTo(70, 6);
    expect(back.y).toBeCloseTo(55, 6);
  });

  it('agrees with the cursor probe: its plane point samples the same voxel', () => {
    // The plane point a cursor maps to must, floored through the texture map,
    // pick the same voxel the probe returns for that cursor.
    const cursor = { x: 30, y: 72 };
    const probe = probeVoxel(volume, Orientation.Axial, 4, 1, SQUARE, cursor.x, cursor.y)!;
    const plane = paneToPlanePoint(volume, Orientation.Axial, 1, SQUARE, cursor.x, cursor.y)!;
    // Re-project the plane point to a pane pixel and probe that: same voxel.
    const back = planePointToPane(volume, Orientation.Axial, plane, 1, SQUARE)!;
    const reprobe = probeVoxel(volume, Orientation.Axial, 4, 1, SQUARE, back.x, back.y)!;
    expect(reprobe.voxel).toEqual(probe.voxel);
  });

  it('returns null for a cursor outside the pane', () => {
    expect(paneToPlanePoint(volume, Orientation.Axial, 1, SQUARE, -5, 50)).toBeNull();
    expect(paneToPlanePoint(volume, Orientation.Axial, 1, SQUARE, 50, 120)).toBeNull();
  });

  it('clamps a cursor over the letterbox margin to the plane edge', () => {
    // A wide pane letterboxes a square plane; the far-left column is margin.
    const wide: PaneRect = { x: 0, y: 0, width: 200, height: 100 };
    const point = paneToPlanePoint(volume, Orientation.Axial, 1, wide, 1, 50)!;
    expect(point.u).toBe(0);
    expect(point.v).toBeCloseTo(0.5, 6);
  });

  it('returns null for a degenerate pane', () => {
    const empty: PaneRect = { x: 0, y: 0, width: 0, height: 0 };
    expect(paneToPlanePoint(volume, Orientation.Axial, 1, empty, 0, 0)).toBeNull();
    expect(planePointToPane(volume, Orientation.Axial, { u: 0.5, v: 0.5 }, 1, empty)).toBeNull();
  });
});
