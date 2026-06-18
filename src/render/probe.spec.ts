import { Orientation, type Volume } from '../dicom/types';
import type { PaneRect } from './layout';
import { probeVoxel } from './probe';
import { rezoomPan } from './slice-renderer';

/** A dims[0]×dims[1]×dims[2] volume whose every voxel holds its flat index. */
function makeVolume(
  dims: [number, number, number],
  rescaleSlope = 1,
  rescaleIntercept = 0,
): Volume {
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
    rescaleSlope,
    rescaleIntercept,
    modality: 'CT',
  };
}

const SQUARE: PaneRect = { x: 0, y: 0, width: 100, height: 100 };

describe('probeVoxel', () => {
  it('maps the pane centre to the centre voxel of an axial slice', () => {
    const volume = makeVolume([4, 4, 4]);

    const probe = probeVoxel(volume, Orientation.Axial, 2, 1, SQUARE, 50, 50);

    expect(probe?.voxel).toEqual([2, 2, 2]);
    expect(probe?.value).toBe((2 * 4 + 2) * 4 + 2);
  });

  it('uses the slice index for the through-plane axis', () => {
    const volume = makeVolume([4, 4, 4]);

    const top = probeVoxel(volume, Orientation.Axial, 0, 1, SQUARE, 0, 0);

    expect(top?.voxel).toEqual([0, 0, 0]);
  });

  it('flips the vertical axis for coronal so superior is up', () => {
    const volume = makeVolume([4, 4, 4]);

    const topOfPane = probeVoxel(volume, Orientation.Coronal, 1, 1, SQUARE, 50, 0);
    const bottomOfPane = probeVoxel(volume, Orientation.Coronal, 1, 1, SQUARE, 50, 99);

    expect(topOfPane?.voxel).toEqual([2, 1, 3]); // top → highest z
    expect(bottomOfPane?.voxel).toEqual([2, 1, 0]); // bottom → lowest z
  });

  it('flips the vertical axis for sagittal as well', () => {
    const volume = makeVolume([4, 4, 4]);

    const probe = probeVoxel(volume, Orientation.Sagittal, 1, 1, SQUARE, 0, 0);

    expect(probe?.voxel).toEqual([1, 0, 3]);
  });

  it('mirrors the horizontal axis for a flipped sagittal view', () => {
    const volume = makeVolume([4, 4, 4]);

    // Top-left of the pane: y unflipped gives the lowest Y voxel...
    const unflipped = probeVoxel(volume, Orientation.Sagittal, 1, 1, SQUARE, 0, 0);
    // ...and flipping the horizontal axis swaps it to the highest Y voxel.
    const flipped = probeVoxel(volume, Orientation.Sagittal, 1, 1, SQUARE, 0, 0, true);

    expect(unflipped?.voxel).toEqual([1, 0, 3]);
    expect(flipped?.voxel).toEqual([1, 3, 3]);
  });

  it('returns null when the cursor is outside the pane', () => {
    const volume = makeVolume([4, 4, 4]);

    expect(probeVoxel(volume, Orientation.Axial, 0, 1, SQUARE, -1, 50)).toBeNull();
    expect(probeVoxel(volume, Orientation.Axial, 0, 1, SQUARE, 50, 101)).toBeNull();
  });

  it('returns null over the letterbox margin of a non-square pane', () => {
    const volume = makeVolume([4, 4, 4]); // square plane (1 mm voxels)
    const wide: PaneRect = { x: 0, y: 0, width: 200, height: 100 };

    // Far left is letterbox once the square plane is centred in a 2:1 pane.
    expect(probeVoxel(volume, Orientation.Axial, 0, 1, wide, 5, 50)).toBeNull();
    // The centre still lands on the plane.
    expect(probeVoxel(volume, Orientation.Axial, 0, 1, wide, 100, 50)).not.toBeNull();
  });

  it('keeps more of the plane visible as the cursor zooms in', () => {
    const volume = makeVolume([4, 4, 4]);

    // Near the left edge, the zoom pulls the sampled column toward the centre.
    expect(probeVoxel(volume, Orientation.Axial, 0, 1, SQUARE, 2, 50)?.voxel).toEqual([0, 2, 0]);
    expect(probeVoxel(volume, Orientation.Axial, 0, 4, SQUARE, 2, 50)?.voxel).toEqual([1, 2, 0]);
  });

  it('shifts the sampled voxel to match a panned pane', () => {
    const volume = makeVolume([4, 4, 4]);

    // Panning the slice right/down (positive pan) brings lower-index voxels
    // under a fixed cursor, mirroring the translation the shader applies.
    const centre = probeVoxel(volume, Orientation.Axial, 2, 1, SQUARE, 50, 50);
    const panned = probeVoxel(volume, Orientation.Axial, 2, 1, SQUARE, 50, 50, false, {
      x: 0.25,
      y: 0.25,
    });

    expect(centre?.voxel).toEqual([2, 2, 2]);
    expect(panned?.voxel).toEqual([1, 1, 2]);
  });

  it('keeps the pane-centre voxel fixed when zoom is anchored to the centre', () => {
    const volume = makeVolume([8, 8, 8]);
    const pan = { x: 0.25, y: 0.25 };

    // The voxel under the pane centre before zooming.
    const before = probeVoxel(volume, Orientation.Axial, 4, 1, SQUARE, 50, 50, false, pan);

    // Rescaling the pan by the zoom ratio (the centre-anchored zoom) keeps the
    // same voxel under the pane centre after zooming in.
    const anchored = probeVoxel(volume, Orientation.Axial, 4, 2, SQUARE, 50, 50, false, {
      ...rezoomPan(pan, 1, 2),
    });
    // Leaving the pan untouched (the old image-centre pivot) drifts off it.
    const naive = probeVoxel(volume, Orientation.Axial, 4, 2, SQUARE, 50, 50, false, pan);

    expect(before?.voxel).toEqual([2, 2, 4]);
    expect(anchored?.voxel).toEqual([2, 2, 4]);
    expect(naive?.voxel).not.toEqual([2, 2, 4]);
  });

  it('recovers the raw stored value through the modality LUT', () => {
    const volume = makeVolume([4, 4, 4], 2, -1024);

    const probe = probeVoxel(volume, Orientation.Axial, 2, 1, SQUARE, 50, 50);
    const stored = (2 * 4 + 2) * 4 + 2;

    expect(probe?.value).toBe(stored);
    expect(probe?.rawValue).toBe((stored + 1024) / 2);
  });
});
