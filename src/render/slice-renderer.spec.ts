import { Orientation, type Volume } from '../dicom/types';
import { clampPan } from './slice-renderer';

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
