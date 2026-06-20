import { Orientation } from '../dicom/types';
import { mmPerScreenPixel, paneEdgeLabels, scaleBar } from './pane-annotations';

describe('paneEdgeLabels', () => {
  it('labels the axial pane radiologically (R left, A top)', () => {
    expect(paneEdgeLabels(Orientation.Axial)).toEqual({
      top: 'A',
      bottom: 'P',
      left: 'R',
      right: 'L',
    });
  });

  it('labels the coronal pane with superior up and patient-right on the left', () => {
    expect(paneEdgeLabels(Orientation.Coronal)).toEqual({
      top: 'S',
      bottom: 'I',
      left: 'R',
      right: 'L',
    });
  });

  it('labels the sagittal pane with anterior on the left by default', () => {
    expect(paneEdgeLabels(Orientation.Sagittal)).toEqual({
      top: 'S',
      bottom: 'I',
      left: 'A',
      right: 'P',
    });
  });

  it('swaps the sagittal left/right letters when flipped', () => {
    expect(paneEdgeLabels(Orientation.Sagittal, true)).toEqual({
      top: 'S',
      bottom: 'I',
      left: 'P',
      right: 'A',
    });
  });

  it('only flips the horizontal axis, never the vertical', () => {
    for (const orientation of [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal]) {
      const plain = paneEdgeLabels(orientation, false);
      const flipped = paneEdgeLabels(orientation, true);
      expect(flipped.top).toBe(plain.top);
      expect(flipped.bottom).toBe(plain.bottom);
      expect(flipped.left).toBe(plain.right);
      expect(flipped.right).toBe(plain.left);
    }
  });

  it('keeps opposite edges anatomically antipodal', () => {
    const opposite: Record<string, string> = { R: 'L', L: 'R', A: 'P', P: 'A', S: 'I', I: 'S' };
    for (const orientation of [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal]) {
      const { top, bottom, left, right } = paneEdgeLabels(orientation);
      expect(opposite[top]).toBe(bottom);
      expect(opposite[left]).toBe(right);
    }
  });
});

describe('mmPerScreenPixel', () => {
  it('is the plane extent over the pane size when neither is letterboxed', () => {
    // 200 mm plane shown across 100 px, no zoom → 2 mm per pixel.
    expect(mmPerScreenPixel(200, 200, 100, 100, 1)).toBeCloseTo(2, 6);
  });

  it('is set by the limiting (larger-ratio) axis under letterboxing', () => {
    // A square plane in a wide pane fits to height; the height ratio (2) wins.
    expect(mmPerScreenPixel(200, 200, 200, 100, 1)).toBeCloseTo(2, 6);
    // A square plane in a tall pane fits to width; again the larger ratio wins.
    expect(mmPerScreenPixel(200, 200, 100, 200, 1)).toBeCloseTo(2, 6);
  });

  it('shrinks proportionally as the pane zooms in', () => {
    expect(mmPerScreenPixel(200, 200, 100, 100, 2)).toBeCloseTo(1, 6);
    expect(mmPerScreenPixel(200, 200, 100, 100, 4)).toBeCloseTo(0.5, 6);
  });

  it('treats a non-positive zoom as 1×', () => {
    expect(mmPerScreenPixel(200, 200, 100, 100, 0)).toBeCloseTo(2, 6);
  });

  it('returns 0 for a degenerate pane', () => {
    expect(mmPerScreenPixel(200, 200, 0, 100, 1)).toBe(0);
    expect(mmPerScreenPixel(200, 200, 100, 0, 1)).toBe(0);
  });
});

describe('scaleBar', () => {
  it('snaps to the largest 1/2/5 round length that fits', () => {
    // maxMm = 160 → 100 mm (1×10²) is the largest 1/2/5 step ≤ 160.
    const bar = scaleBar(1, 160);
    expect(bar).toEqual({ lengthPx: 100, lengthMm: 100, label: '10 cm' });
  });

  it('labels lengths of 10 mm and above in centimetres', () => {
    expect(scaleBar(0.5, 160)?.label).toBe('5 cm'); // maxMm = 80 → 50 mm
    expect(scaleBar(2, 100)?.label).toBe('20 cm'); // maxMm = 200 → 200 mm
  });

  it('labels sub-centimetre lengths in millimetres', () => {
    expect(scaleBar(0.05, 100)?.label).toBe('5 mm'); // maxMm = 5 → 5 mm
    expect(scaleBar(0.005, 100)?.label).toBe('0.5 mm'); // maxMm = 0.5 → 0.5 mm
  });

  it('never exceeds the requested maximum length', () => {
    for (const mmPerPixel of [0.013, 0.4, 1.7, 9]) {
      const bar = scaleBar(mmPerPixel, 120);
      expect(bar).not.toBeNull();
      expect(bar!.lengthPx).toBeLessThanOrEqual(120 + 1e-9);
      expect(bar!.lengthPx).toBeCloseTo(bar!.lengthMm / mmPerPixel, 6);
    }
  });

  it('returns null when no positive bar is possible', () => {
    expect(scaleBar(0, 120)).toBeNull();
    expect(scaleBar(1, 0)).toBeNull();
    expect(scaleBar(-1, 120)).toBeNull();
  });
});
