import { Orientation, type Volume } from '../dicom/types';
import type { PaneRect } from './layout';
import { maskColorLut, MASK_LUT_SIZE } from './mask';
import { planeCoordsAt, planeToTex, sliceCountFor } from './reslice';
import { planePointToPane } from './pane-coords';
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

describe('maskColorLut', () => {
  it('maps each ROI id to its colour and leaves background (id 0) transparent', () => {
    const lut = maskColorLut([
      { id: 1, color: [255, 0, 0] },
      { id: 2, color: [0, 128, 255] },
    ]);

    // Texel 0 is the background: fully transparent (and black).
    expect(Array.from(lut.slice(0, 4))).toEqual([0, 0, 0, 0]);
    // Texel 1 = ROI 1's colour, opaque.
    expect(lut[4]).toBeCloseTo(1); // r
    expect(lut[5]).toBe(0); // g
    expect(lut[6]).toBe(0); // b
    expect(lut[7]).toBe(1); // a
    // Texel 2 = ROI 2's colour, opaque.
    expect(lut[8]).toBe(0); // r
    expect(lut[9]).toBeCloseTo(128 / 255); // g
    expect(lut[10]).toBeCloseTo(1); // b
    expect(lut[11]).toBe(1); // a
  });

  it('is MASK_LUT_SIZE texels of RGBA and skips ids outside [1, size)', () => {
    const lut = maskColorLut([
      { id: 0, color: [255, 255, 255] }, // background can't be recoloured
      { id: MASK_LUT_SIZE, color: [255, 255, 255] }, // past the table
      { id: -3, color: [255, 255, 255] }, // not a valid id
    ]);
    expect(lut.length).toBe(MASK_LUT_SIZE * 4);
    // None of the above wrote a colour; the whole LUT stays transparent.
    expect(lut.every((v) => v === 0)).toBe(true);
  });
});

describe('label mask display agrees with the forward map', () => {
  // The mask samples through the SAME base reslice matrix the probe inverts, so a
  // voxel painted at (vx, vy, vz) must draw at the pane pixel planePointToPane maps
  // its plane point to — and probing that pixel returns the very same voxel. This
  // ties the forward (display) and inverse (paint/probe) directions together under
  // pan, zoom, and flip, exactly as the issue's test asks.
  const volume = makeVolume([8, 8, 8]);
  const rect: PaneRect = { x: 0, y: 0, width: 120, height: 90 };

  function projectsToItself(
    orientation: Orientation,
    voxel: [number, number, number],
    zoom: number,
    pan: { x: number; y: number },
    flipX: boolean,
  ): void {
    const [dimX, dimY, dimZ] = volume.dims;
    // The texture coordinate that samples the voxel's centre.
    const coord: [number, number, number] = [
      (voxel[0] + 0.5) / dimX,
      (voxel[1] + 0.5) / dimY,
      (voxel[2] + 0.5) / dimZ,
    ];
    // Forward map: voxel centre → plane point, then plane point → pane pixel.
    const { u, v, slicePos } = planeCoordsAt(planeToTex(volume, orientation), coord);
    const pixel = planePointToPane(volume, orientation, { u, v }, zoom, rect, flipX, pan)!;

    // Probe that pixel on the slice the voxel lies on: it must be the same voxel.
    const count = sliceCountFor(volume, orientation);
    const sliceIndex = Math.round(slicePos * count - 0.5);
    const probe = probeVoxel(
      volume,
      orientation,
      sliceIndex,
      zoom,
      rect,
      pixel.x,
      pixel.y,
      flipX,
      pan,
    )!;
    expect(probe.voxel).toEqual(voxel);
  }

  it('round-trips a painted voxel on every orientation at 1× with no pan/flip', () => {
    projectsToItself(Orientation.Axial, [5, 2, 3], 1, { x: 0, y: 0 }, false);
    projectsToItself(Orientation.Coronal, [1, 6, 4], 1, { x: 0, y: 0 }, false);
    projectsToItself(Orientation.Sagittal, [7, 3, 2], 1, { x: 0, y: 0 }, false);
  });

  it('round-trips under zoom and pan', () => {
    projectsToItself(Orientation.Axial, [4, 4, 5], 2.5, { x: 0.12, y: -0.08 }, false);
    projectsToItself(Orientation.Coronal, [2, 1, 6], 1.8, { x: -0.05, y: 0.1 }, false);
  });

  it('round-trips a flipped sagittal pane', () => {
    // A central voxel stays on-pane under magnification + pan, isolating the flip.
    projectsToItself(Orientation.Sagittal, [4, 4, 4], 2, { x: 0.07, y: -0.04 }, true);
  });
});
