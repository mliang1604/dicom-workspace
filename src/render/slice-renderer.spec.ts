import { Orientation, type Volume } from '../dicom/types';
import type { Vec2 } from './layout';
import { clampPan, rezoomPan } from './slice-renderer';

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
