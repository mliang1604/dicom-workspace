import { Orientation, type Vec3, type Volume } from '../dicom/types';
import type { Vec2 } from './layout';
import { patientToTexMatrix } from './reslice';
import type { CameraBasis } from './camera';
import {
  clampPan,
  cursorZoomPan,
  defaultSlabThicknessMm,
  ensureSurfaceSortScratch,
  isDvr,
  mipStepScale,
  oneToOneZoom,
  packSliceParams,
  packSurfaceFrame,
  ProjectionMode,
  projectionModeCode,
  projectionWindow,
  rezoomPan,
  steppedSliceIndex,
  type SliceParams,
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

describe('packSliceParams', () => {
  const baseMatrix = Array.from({ length: 16 }, (_, i) => i + 1);
  const base: SliceParams = {
    matrix: baseMatrix,
    scaleX: 1.5,
    scaleY: 2.5,
    pan: { x: 0.1, y: 0.2 },
    windowCenter: 40,
    windowWidth: 400,
    slicePos: 0.5,
    flipX: true,
    invert: false,
    colormapBase: false,
    overlay: null,
  };

  it('packs the base block at the layout the WGSL Params struct expects', () => {
    const floats = new Float32Array(packSliceParams(base));
    const uints = new Uint32Array(packSliceParams(base));

    expect(Array.from(floats.slice(0, 16))).toEqual(baseMatrix); // planeToTex
    expect(floats[16]).toBeCloseTo(1.5); // scaleX
    expect(floats[17]).toBeCloseTo(2.5); // scaleY
    expect(floats[18]).toBeCloseTo(0.1); // pan.x
    expect(floats[19]).toBeCloseTo(0.2); // pan.y
    expect(floats[20]).toBe(40); // windowCenter
    expect(floats[21]).toBe(400); // windowWidth
    expect(floats[22]).toBe(0.5); // slicePos
    expect(uints[23]).toBe(1); // flipX
    expect(uints[24]).toBe(0); // invert
  });

  it('is 192 bytes and leaves overlay opacity 0 when there is no overlay', () => {
    const buffer = packSliceParams(base);
    expect(buffer.byteLength).toBe(192);
    // Overlay opacity lives at float 46; zero means the shader skips the overlay.
    expect(new Float32Array(buffer)[46]).toBe(0);
  });

  it('packs the overlay block at byte 112 (float 28) without disturbing the base', () => {
    const overlayMatrix = Array.from({ length: 16 }, (_, i) => 100 + i);
    const buffer = packSliceParams({
      ...base,
      overlay: {
        matrix: overlayMatrix,
        windowCenter: 1.5,
        windowWidth: 3,
        opacity: 0.4,
        colormap: true,
        checkerboard: true,
        checkerSize: 24,
      },
    });
    const floats = new Float32Array(buffer);
    const uints = new Uint32Array(buffer);

    // Checkerboard flag + size sit in the alignment pad before the overlay block.
    expect(uints[25]).toBe(1); // overlayCheckerboard (u32)
    expect(floats[26]).toBe(24); // checkerSize
    expect(Array.from(floats.slice(28, 44))).toEqual(overlayMatrix); // overlayToTex
    expect(floats[44]).toBeCloseTo(1.5); // overlayWindowCenter
    expect(floats[45]).toBe(3); // overlayWindowWidth
    expect(floats[46]).toBeCloseTo(0.4); // overlayOpacity
    expect(uints[47]).toBe(1); // overlayColormap flag (u32)
    // Base fields are untouched by the overlay block.
    expect(floats[20]).toBe(40);
  });

  it('leaves the colormap and checkerboard flags 0 for a plain blended overlay', () => {
    const buffer = packSliceParams({
      ...base,
      overlay: {
        matrix: base.matrix,
        windowCenter: 0,
        windowWidth: 1,
        opacity: 0.5,
        colormap: false,
        checkerboard: false,
        checkerSize: 24,
      },
    });
    const uints = new Uint32Array(buffer);
    expect(uints[47]).toBe(0); // colormap
    expect(uints[25]).toBe(0); // checkerboard
  });

  it('sets the colormap-the-base flag (float 27) for a standalone colormapped layer', () => {
    expect(new Uint32Array(packSliceParams(base))[27]).toBe(0); // off by default
    const buffer = packSliceParams({ ...base, colormapBase: true });
    expect(new Uint32Array(buffer)[27]).toBe(1);
    // It rides in the pre-overlay pad without disturbing the base window.
    expect(new Float32Array(buffer)[20]).toBe(40); // windowCenter
  });
});

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

describe('oneToOneZoom', () => {
  it('is 1 when the fit already shows one voxel per pixel', () => {
    // A 100³ volume of 1 mm voxels fits a 100×100 pane exactly at native scale.
    const volume = makeVolume([100, 100, 100]);
    expect(oneToOneZoom(volume, Orientation.Axial, 100, 100)).toBeCloseTo(1, 6);
  });

  it('magnifies (>1) when the pane is larger than the voxel grid', () => {
    // 100 voxels across a 200 px pane: the fit shows 2 px/voxel, so native (1
    // px/voxel) is a half-size of the fit — zoom 0.5.
    const volume = makeVolume([100, 100, 100]);
    expect(oneToOneZoom(volume, Orientation.Axial, 200, 200)).toBeCloseTo(0.5, 6);
  });

  it('shrinks (<1) … and the same scale holds for any pane size', () => {
    const volume = makeVolume([100, 100, 100]);
    // 100 voxels across a 50 px pane: the fit shows 0.5 px/voxel, native doubles it.
    expect(oneToOneZoom(volume, Orientation.Axial, 50, 50)).toBeCloseTo(2, 6);
  });

  it('keys off the finer in-plane axis for anisotropic voxels', () => {
    // Coronal plane spans x (1 mm) × z (3 mm). Extent 100 × 30 mm, grid 100 × 10.
    // Fit into 300×300 is limited by the 100 mm width → 3 px/mm. Native holds the
    // finer x axis at 1 px/voxel = 1 px/mm, so zoom = 1 / 3.
    const volume = makeVolume([100, 100, 10], [1, 1, 3]);
    expect(oneToOneZoom(volume, Orientation.Coronal, 300, 300)).toBeCloseTo(1 / 3, 6);
  });

  it('falls back to 1 for a degenerate pane', () => {
    const volume = makeVolume([100, 100, 100]);
    expect(oneToOneZoom(volume, Orientation.Axial, 0, 0)).toBe(1);
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
  it('maps each 3D mode to the shader code the WGSL switches on', () => {
    expect(projectionModeCode(ProjectionMode.Max)).toBe(0);
    expect(projectionModeCode(ProjectionMode.Min)).toBe(1);
    expect(projectionModeCode(ProjectionMode.Mean)).toBe(2);
    expect(projectionModeCode(ProjectionMode.Dvr)).toBe(3);
  });

  it('defaults to MIP (max), the historical projection', () => {
    expect(ProjectionMode.Max).toBe(0);
    expect(projectionModeCode(ProjectionMode.Max)).toBe(0);
  });
});

describe('isDvr', () => {
  it('is true only for the direct-volume-rendering mode', () => {
    expect(isDvr(ProjectionMode.Dvr)).toBe(true);
    expect(isDvr(ProjectionMode.Max)).toBe(false);
    expect(isDvr(ProjectionMode.Min)).toBe(false);
    expect(isDvr(ProjectionMode.Mean)).toBe(false);
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

  it('passes the shared window through for DVR (which ignores the window)', () => {
    expect(projectionWindow(ProjectionMode.Dvr, ct, 40, 400)).toEqual({
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
  it('projects the whole volume for MIP and DVR', () => {
    expect(defaultSlabThicknessMm(ProjectionMode.Max, 240)).toBe(240);
    expect(defaultSlabThicknessMm(ProjectionMode.Dvr, 240)).toBe(240);
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

describe('cursorZoomPan', () => {
  const volume = makeVolume([4, 4, 4]); // square plane (1 mm voxels)
  const rect = { x: 0, y: 0, width: 100, height: 100 };

  it('reduces to scaling the pan by the zoom ratio for a centred cursor', () => {
    // A cursor at the pane centre anchors on (0.5, 0.5), so the result matches
    // rezoomPan's default (within the clamp bounds).
    const centre = { x: 50, y: 50 };
    expect(
      cursorZoomPan(volume, Orientation.Axial, rect, 1, 2, { x: 0.1, y: -0.1 }, centre),
    ).toEqual(rezoomPan({ x: 0.1, y: -0.1 }, 1, 2));
  });

  it('holds the plane point under an off-centre cursor fixed across the zoom', () => {
    // With aspectScale 1, screen-uv `a` maps to plane point `(a - 0.5 - pan)/zoom + 0.5`.
    const planeAt = (a: Vec2, pan: Vec2, zoom: number): Vec2 => ({
      x: (a.x - 0.5 - pan.x) / zoom + 0.5,
      y: (a.y - 0.5 - pan.y) / zoom + 0.5,
    });
    const cursor = { x: 100, y: 0 }; // top-right corner → anchor (1, 0)
    const anchor = { x: 1, y: 0 };
    const pan = { x: 0.1, y: -0.2 };
    const next = cursorZoomPan(volume, Orientation.Axial, rect, 1, 2, pan, cursor);
    expect(planeAt(anchor, next, 2)).toEqual(planeAt(anchor, pan, 1));
  });

  it('re-clamps the anchored pan to the (zoom-scaled) bound', () => {
    // Zooming out to 1x about a corner would push the pan past the half-pane bound;
    // the result is clamped rather than left out of range.
    const cursor = { x: 100, y: 100 };
    const pan = { x: 0.9, y: 0.9 };
    const result = cursorZoomPan(volume, Orientation.Axial, rect, 4, 1, pan, cursor);
    expect(result).toEqual(clampPan(volume, Orientation.Axial, 100, 100, 1, result));
    expect(Math.abs(result.x)).toBeLessThanOrEqual(0.5);
  });

  it('honours a non-zero pane origin when locating the anchor', () => {
    const offset = { x: 200, y: 200, width: 100, height: 100 };
    const cursor = { x: 250, y: 250 }; // centre of the offset pane
    expect(
      cursorZoomPan(volume, Orientation.Axial, offset, 1, 2, { x: 0.1, y: 0 }, cursor),
    ).toEqual(rezoomPan({ x: 0.1, y: 0 }, 1, 2));
  });
});

describe('steppedSliceIndex', () => {
  it('advances by one when scrolling down (positive deltaY)', () => {
    expect(steppedSliceIndex(5, 120, 10)).toBe(6);
  });

  it('retreats by one when scrolling up (negative deltaY)', () => {
    expect(steppedSliceIndex(5, -120, 10)).toBe(4);
  });

  it('clamps at the grid ends rather than stepping past them', () => {
    expect(steppedSliceIndex(10, 1, 10)).toBe(10);
    expect(steppedSliceIndex(0, -1, 10)).toBe(0);
  });

  it('takes the sign of deltaY, not its magnitude', () => {
    expect(steppedSliceIndex(5, 999, 10)).toBe(6);
    expect(steppedSliceIndex(5, -0.5, 10)).toBe(4);
  });
});

describe('ensureSurfaceSortScratch', () => {
  it('allocates buffers that hold at least n triangles', () => {
    const s = ensureSurfaceSortScratch(null, 100);
    expect(s.cap).toBeGreaterThanOrEqual(100);
    expect(s.depth.length).toBe(s.cap);
    expect(s.order.length).toBe(s.cap);
    expect(s.index.length).toBe(s.cap * 3); // three vertex indices per triangle
    expect(s.camera.length).toBe(16); // packed camera uniform (4 × vec4)
  });

  it('reuses the existing scratch (and camera buffer) when it is large enough', () => {
    const first = ensureSurfaceSortScratch(null, 10);
    const again = ensureSurfaceSortScratch(first, 5);
    expect(again).toBe(first);
    expect(again.camera).toBe(first.camera);
  });

  it('grows past doubling and keeps the camera buffer across a regrow', () => {
    const first = ensureSurfaceSortScratch(null, 4096);
    const grown = ensureSurfaceSortScratch(first, 20000);
    expect(grown).not.toBe(first);
    expect(grown.cap).toBeGreaterThanOrEqual(20000);
    expect(grown.camera).toBe(first.camera); // camera buffer reused, not reallocated
  });
});

describe('packSurfaceFrame', () => {
  /** A camera looking down −z from above (forward = +z into the screen). */
  const basis: CameraBasis = {
    eye: [0, 0, 0],
    forward: [0, 0, 1],
    axisU: [2, 0, 0],
    axisV: [0, 3, 0],
  };

  it('packs the camera uniform at the byte layout the WGSL Camera struct expects', () => {
    const scratch = ensureSurfaceSortScratch(null, 1);
    const { camera } = packSurfaceFrame(new Float32Array([0, 0, 1]), 1, basis, [0, 0, 1], scratch);
    // eye at floats 0..2, pad at 3.
    expect(Array.from(camera.slice(0, 3))).toEqual([0, 0, 0]);
    // axisU at 4..6, |axisU|² at 7.
    expect(Array.from(camera.slice(4, 7))).toEqual([2, 0, 0]);
    expect(camera[7]).toBeCloseTo(4); // 2²
    // axisV at 8..10, |axisV|² at 11.
    expect(Array.from(camera.slice(8, 11))).toEqual([0, 3, 0]);
    expect(camera[11]).toBeCloseTo(9); // 3²
    // light at 12..14.
    expect(Array.from(camera.slice(12, 15))).toEqual([0, 0, 1]);
  });

  it("sorts triangles far-to-near along forward (painter's order)", () => {
    // Three centroids at depths z = 1, 5, 3 along forward = +z.
    const centroids = new Float32Array([0, 0, 1, 0, 0, 5, 0, 0, 3]);
    const scratch = ensureSurfaceSortScratch(null, 3);
    const { indices } = packSurfaceFrame(centroids, 3, basis, [0, 0, 1], scratch);
    expect(indices).toHaveLength(9); // three vertex indices per triangle
    // Far first: triangle 1 (z=5), then 2 (z=3), then 0 (z=1).
    expect(Array.from(indices)).toEqual([3, 4, 5, 6, 7, 8, 0, 1, 2]);
  });

  it('expands each sorted triangle to three consecutive vertex indices', () => {
    const centroids = new Float32Array([0, 0, 2, 0, 0, 1]); // already far-to-near
    const scratch = ensureSurfaceSortScratch(null, 2);
    const { indices } = packSurfaceFrame(centroids, 2, basis, [0, 0, 1], scratch);
    expect(Array.from(indices)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
