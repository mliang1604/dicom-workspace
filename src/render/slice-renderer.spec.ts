import { Orientation, type Vec3, type Volume } from '../dicom/types';
import type { Vec2 } from './layout';
import { patientToTexMatrix } from './reslice';
import {
  clampPan,
  defaultSlabThicknessMm,
  mipStepScale,
  ProjectionMode,
  projectionModeCode,
  projectionWindow,
  rezoomPan,
} from './slice-renderer';

/** A minimal volume; only dims/spacing matter to the pan geometry. */
function makeVolume(
  dims: [number, number, number],
  spacing: [number, number, number] = [1, 1, 1],
): Volume {
  const [x, y, z] = dims;
  return {
    dims,
    spacing,
    data: new Float32Array(x * y * z),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
  };
}

describe('clampPan', () => {
  it('leaves a pan within bounds untouched', () => {
    const volume = makeVolume([4, 4, 4]);

    expect(clampPan(volume, Orientation.Axial, 100, 100, 1, { x: 0.2, y: -0.3 })).toEqual({
      x: 0.2,
      y: -0.3,
    });
  });

  it('bounds the pan to half a pane at 1x zoom for a square fit', () => {
    const volume = makeVolume([4, 4, 4]);

    expect(clampPan(volume, Orientation.Axial, 100, 100, 1, { x: 2, y: -2 })).toEqual({
      x: 0.5,
      y: -0.5,
    });
  });

  it('lets a magnified pane pan proportionally further', () => {
    const volume = makeVolume([4, 4, 4]);

    expect(clampPan(volume, Orientation.Axial, 100, 100, 4, { x: 3, y: 3 })).toEqual({
      x: 2,
      y: 2,
    });
  });

  it('tightens the bound on the letterboxed axis of a non-square pane', () => {
    const volume = makeVolume([4, 4, 4]); // square plane (1 mm voxels)

    // A 2:1 pane letterboxes left/right (scaleX = 2), halving the x bound.
    expect(clampPan(volume, Orientation.Axial, 200, 100, 1, { x: 1, y: 1 })).toEqual({
      x: 0.25,
      y: 0.5,
    });
  });
});

describe('mipStepScale', () => {
  it('crosses one voxel per mm of travel for an isotropic 1 mm volume', () => {
    const volume = makeVolume([4, 4, 4]); // 1 mm voxels
    const m = patientToTexMatrix(volume);

    // Each axis-aligned direction crosses exactly its axis's voxels per mm (= 1).
    expect(mipStepScale(m, [1, 0, 0], volume.dims)).toBeCloseTo(1, 6);
    expect(mipStepScale(m, [0, 1, 0], volume.dims)).toBeCloseTo(1, 6);
    expect(mipStepScale(m, [0, 0, 1], volume.dims)).toBeCloseTo(1, 6);
    // A unit diagonal direction also crosses 1 voxel per mm when isotropic.
    const d = 1 / Math.sqrt(3);
    expect(mipStepScale(m, [d, d, d], volume.dims)).toBeCloseTo(1, 6);
  });

  it('scales by the per-axis spacing for an anisotropic volume', () => {
    // 2 mm slices along z: a z-ray crosses half a voxel per mm of travel.
    const volume = makeVolume([4, 4, 4], [1, 1, 2]);
    const m = patientToTexMatrix(volume);

    expect(mipStepScale(m, [0, 0, 1], volume.dims)).toBeCloseTo(0.5, 6);
    expect(mipStepScale(m, [1, 0, 0], volume.dims)).toBeCloseTo(1, 6);
  });

  it('times a full traversal span back to the voxel count along that axis', () => {
    // The shader multiplies this scale by the ray's tExit−tEntry span. A z-ray
    // through the whole 2 mm-spaced volume spans 8 mm and should resolve 4 voxels.
    const volume = makeVolume([4, 4, 4], [1, 1, 2]);
    const m = patientToTexMatrix(volume);
    const forward: Vec3 = [0, 0, 1];
    const spanMm = 4 * 2; // depth × spacing

    expect(Math.ceil(spanMm * mipStepScale(m, forward, volume.dims))).toBe(4);
  });
});

describe('projectionModeCode', () => {
  it('maps each projection mode to the shader code the WGSL switches on', () => {
    expect(projectionModeCode(ProjectionMode.Max)).toBe(0);
    expect(projectionModeCode(ProjectionMode.Min)).toBe(1);
    expect(projectionModeCode(ProjectionMode.Mean)).toBe(2);
  });

  it('defaults to MIP (max), the historical projection', () => {
    expect(ProjectionMode.Max).toBe(0);
    expect(projectionModeCode(ProjectionMode.Max)).toBe(0);
  });
});

describe('projectionWindow', () => {
  // A CT-like volume whose air margins (≈ −1000 HU) drag the min/mean low.
  const ct: Volume = { ...makeVolume([4, 4, 4]), min: -1000, max: 3000 };

  it('keeps the shared MPR window for MIP so it looks unchanged', () => {
    expect(projectionWindow(ProjectionMode.Max, ct, 40, 400)).toEqual({
      center: 40,
      width: 400,
    });
  });

  it('fits MinIP to the full data range so it stays visible at every angle', () => {
    // center = (min+max)/2, width = max−min — independent of the shared window.
    expect(projectionWindow(ProjectionMode.Min, ct, 40, 400)).toEqual({
      center: 1000,
      width: 4000,
    });
  });

  it('fits Average to the full data range as well', () => {
    expect(projectionWindow(ProjectionMode.Mean, ct, 40, 400)).toEqual({
      center: 1000,
      width: 4000,
    });
  });

  it('floors the auto-fit width at 1 for a flat (constant) volume', () => {
    const flat: Volume = { ...makeVolume([4, 4, 4]), min: 7, max: 7 };
    expect(projectionWindow(ProjectionMode.Mean, flat, 0, 1)).toEqual({
      center: 7,
      width: 1,
    });
  });
});

describe('defaultSlabThicknessMm', () => {
  it('projects the whole volume for MIP', () => {
    expect(defaultSlabThicknessMm(ProjectionMode.Max, 240)).toBe(240);
  });

  it('uses a moderate band for MinIP/Average, capped to keep air margins out', () => {
    // ⅓ of a 240 mm depth is 80 mm, capped to the 50 mm ceiling.
    expect(defaultSlabThicknessMm(ProjectionMode.Min, 240)).toBe(50);
    expect(defaultSlabThicknessMm(ProjectionMode.Mean, 240)).toBe(50);
  });

  it('uses ⅓ of the depth when that is below the cap', () => {
    expect(defaultSlabThicknessMm(ProjectionMode.Mean, 90)).toBe(30);
  });

  it('never exceeds the full depth for a thin volume', () => {
    expect(defaultSlabThicknessMm(ProjectionMode.Min, 6)).toBe(2);
  });
});

describe('rezoomPan', () => {
  it('scales the pan by the zoom ratio so the pane centre stays put', () => {
    // Doubling the zoom doubles the pan: -pan*scale/zoom is then unchanged.
    expect(rezoomPan({ x: 0.25, y: -0.1 }, 1, 2)).toEqual({ x: 0.5, y: -0.2 });
    // Halving the zoom halves the pan.
    expect(rezoomPan({ x: 0.4, y: 0.4 }, 2, 1)).toEqual({ x: 0.2, y: 0.2 });
  });

  it('leaves a centred (zero) pan at the origin', () => {
    expect(rezoomPan({ x: 0, y: 0 }, 1, 4)).toEqual({ x: 0, y: 0 });
  });

  it('treats a non-positive zoom as 1x rather than dividing by zero', () => {
    expect(rezoomPan({ x: 0.3, y: 0.3 }, 0, 2)).toEqual({ x: 0.6, y: 0.6 });
  });

  it('defaults the anchor to the pane centre', () => {
    expect(rezoomPan({ x: 0.25, y: -0.1 }, 1, 2)).toEqual(
      rezoomPan({ x: 0.25, y: -0.1 }, 1, 2, { x: 0.5, y: 0.5 }),
    );
  });

  it('holds the plane point under a non-central anchor fixed across the zoom', () => {
    // With aspectScale 1, the shader maps screen-uv `a` to plane point
    // `(a - 0.5 - pan) / zoom + 0.5`; that point must not move when zooming about a.
    const planeAt = (a: Vec2, pan: Vec2, zoom: number): Vec2 => ({
      x: (a.x - 0.5 - pan.x) / zoom + 0.5,
      y: (a.y - 0.5 - pan.y) / zoom + 0.5,
    });
    const anchor = { x: 1, y: 0 }; // top-right corner of the pane
    const pan = { x: 0.1, y: -0.2 };
    const next = rezoomPan(pan, 1, 2, anchor);
    expect(planeAt(anchor, next, 2)).toEqual(planeAt(anchor, pan, 1));
  });
});
