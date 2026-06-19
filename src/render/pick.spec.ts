import { type Volume, type VolumeGeometry } from '../dicom/types';
import { type OrbitCamera } from './camera';
import type { PaneRect } from './layout';
import { pickProjection } from './pick';
import { ProjectionMode } from './slice-renderer';
import { TransferFunctionPreset } from './transfer-function';

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

/** Set a single voxel's value in an identity-indexed volume. */
function setVoxel(volume: Volume, x: number, y: number, z: number, value: number): void {
  const [dx, dy] = volume.dims;
  volume.data[(z * dy + y) * dx + x] = value;
}

/** The default anterior, level, fit-to-volume orbit used across the cases. */
const LEVEL: OrbitCamera = { azimuth: 0, elevation: 0, zoom: 1 };
const PANE: PaneRect = { x: 0, y: 0, width: 100, height: 100 };
/** Centre of the square pane: a ray straight down the volume's middle column. */
const CENTRE = { x: 50, y: 50 };

describe('pickProjection', () => {
  it('locates the brightest voxel along a MIP ray (ray → patient → voxel)', () => {
    // Anterior view: the centre ray travels +y through the column x=2, z=2.
    const volume = makeVolume([4, 4, 4]);
    setVoxel(volume, 2, 1, 2, 100);

    const pick = pickProjection(
      volume,
      LEVEL,
      ProjectionMode.Max,
      Infinity,
      PANE,
      CENTRE.x,
      CENTRE.y,
    );

    expect(pick).not.toBeNull();
    expect(pick!.voxel).toEqual([2, 1, 2]);
    // The picked patient point sits at the bright voxel's depth (y ≈ 1).
    expect(pick!.patient[1]).toBeCloseTo(1, 0);
  });

  it('locates the darkest voxel for a MinIP ray', () => {
    const volume = makeVolume([4, 4, 4]);
    setVoxel(volume, 2, 3, 2, -100); // a dark pit deeper along the ray

    const pick = pickProjection(
      volume,
      LEVEL,
      ProjectionMode.Min,
      Infinity,
      PANE,
      CENTRE.x,
      CENTRE.y,
    );

    expect(pick!.voxel).toEqual([2, 3, 2]);
  });

  it('picks the slab centre for Average, which has no single source', () => {
    // A uniform volume: Average can only resolve to the centre of the marched slab.
    const volume = makeVolume([4, 4, 4]);
    volume.data.fill(10);

    const pick = pickProjection(
      volume,
      LEVEL,
      ProjectionMode.Mean,
      Infinity,
      PANE,
      CENTRE.x,
      CENTRE.y,
    );

    expect(pick!.patient[1]).toBeCloseTo(1.5, 1); // box centre along the view axis
    expect(pick!.voxel).toEqual([2, 2, 2]); // patient 1.5 → tex 0.5 → row 2
  });

  it('returns null when the click lies outside the pane', () => {
    const volume = makeVolume([4, 4, 4]);
    expect(pickProjection(volume, LEVEL, ProjectionMode.Max, Infinity, PANE, -5, 50)).toBeNull();
  });

  it('returns null when the ray misses the volume', () => {
    // The pane corner maps to a ray well outside the bounding box, so it misses.
    const volume = makeVolume([4, 4, 4]);
    expect(pickProjection(volume, LEVEL, ProjectionMode.Max, Infinity, PANE, 0, 0)).toBeNull();
  });

  it('locks a DVR pick onto the first opaque voxel along the ray', () => {
    // CT Bone makes a ~1000 HU voxel opaque (a = 0.6 ≥ the 0.5 surface threshold).
    const volume = makeVolume([4, 4, 4]);
    setVoxel(volume, 2, 1, 2, 1000);

    const pick = pickProjection(
      volume,
      LEVEL,
      ProjectionMode.Dvr,
      Infinity,
      PANE,
      CENTRE.x,
      CENTRE.y,
      {
        transferFunction: TransferFunctionPreset.CtBone,
      },
    );

    expect(pick).not.toBeNull();
    expect(pick!.voxel).toEqual([2, 1, 2]);
  });

  it('returns null for a DVR ray that never accumulates enough opacity', () => {
    // An all-air (0 HU) volume is fully transparent under CT Bone, so nothing is hit.
    const volume = makeVolume([4, 4, 4]);
    expect(
      pickProjection(volume, LEVEL, ProjectionMode.Dvr, Infinity, PANE, CENTRE.x, CENTRE.y),
    ).toBeNull();
  });

  it('hides material behind the cut-away clip planes', () => {
    // Two bright voxels down the centre column; the cut-away keeps the far side of
    // the coronal plane (slice 1), so the near voxel is clipped and the pick falls
    // on the far one instead of the brighter near one.
    const volume = makeVolume([4, 4, 4]);
    setVoxel(volume, 2, 0, 2, 100); // near (anterior) — brightest
    setVoxel(volume, 2, 2, 2, 50); // far (posterior) — behind the clip plane

    const open = pickProjection(
      volume,
      LEVEL,
      ProjectionMode.Max,
      Infinity,
      PANE,
      CENTRE.x,
      CENTRE.y,
    );
    const cut = pickProjection(
      volume,
      LEVEL,
      ProjectionMode.Max,
      Infinity,
      PANE,
      CENTRE.x,
      CENTRE.y,
      {
        clipToPlanes: true,
        sliceIndices: [1, 1, 1],
      },
    );

    expect(open!.voxel).toEqual([2, 0, 2]); // brightest overall when unclipped
    expect(cut!.voxel).toEqual([2, 2, 2]); // near voxel removed by the cut-away
  });

  it('confines the pick to the thick slab', () => {
    // A bright voxel near the front and a brighter one deeper: a thin slab centred
    // on the volume excludes the front one, so the pick is the in-slab maximum.
    const volume = makeVolume([8, 8, 8]);
    setVoxel(volume, 4, 0, 4, 50); // anterior margin, outside a thin central slab
    setVoxel(volume, 4, 4, 4, 100); // volume centre, inside it

    const full = pickProjection(
      volume,
      LEVEL,
      ProjectionMode.Max,
      Infinity,
      PANE,
      CENTRE.x,
      CENTRE.y,
    );
    const thin = pickProjection(volume, LEVEL, ProjectionMode.Max, 2, PANE, CENTRE.x, CENTRE.y);

    expect(full!.voxel).toEqual([4, 4, 4]); // brightest overall
    expect(thin!.voxel[1]).toBeGreaterThan(0); // the front voxel is clipped away
  });
});
