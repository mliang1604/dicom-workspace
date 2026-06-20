import type { Volume } from '../dicom/types';
import {
  CT_WINDOW_PRESETS,
  fullRangePreset,
  invertGray,
  windowGray,
  windowLevelDrag,
  windowLevelSensitivity,
  windowPresets,
} from './window-level';

function makeVolume(overrides: Partial<Volume> = {}): Volume {
  return {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    data: new Float32Array(8),
    min: -1000,
    max: 1000,
    windowCenter: 50,
    windowWidth: 350,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    ...overrides,
  };
}

describe('windowPresets', () => {
  it('offers the standard CT windows plus Full range for CT', () => {
    const presets = windowPresets(makeVolume({ modality: 'CT', min: -1024, max: 3071 }));

    expect(presets.map((p) => p.label)).toEqual([
      'Soft tissue',
      'Lung',
      'Bone',
      'Brain',
      'Full range',
    ]);
    // The CT entries match the radiology-standard centre/width values verbatim.
    expect(presets.slice(0, 4)).toEqual(CT_WINDOW_PRESETS);
  });

  it('derives Full range from the volume min/max', () => {
    const full = fullRangePreset(makeVolume({ min: -1024, max: 3071 }));

    expect(full).toEqual({ label: 'Full range', center: 1024, width: 4095 });
  });

  it('keeps Full range width at least 1 for a flat volume', () => {
    expect(fullRangePreset(makeVolume({ min: 5, max: 5 })).width).toBe(1);
  });

  it('offers the file default plus Full range for non-CT modalities', () => {
    const presets = windowPresets(
      makeVolume({ modality: 'MR', min: 0, max: 600, windowCenter: 300.4, windowWidth: 500.6 }),
    );

    expect(presets.map((p) => p.label)).toEqual(['File default', 'Full range']);
    expect(presets[0]).toEqual({ label: 'File default', center: 300, width: 501 });
    expect(presets[1]).toEqual({ label: 'Full range', center: 300, width: 600 });
  });
});

describe('windowLevelDrag', () => {
  const start = { center: 40, width: 400 };

  it('returns the starting window for no movement', () => {
    expect(windowLevelDrag(start, 0, 0, 2)).toEqual(start);
  });

  it('raises the centre dragging right, lowers it dragging left', () => {
    expect(windowLevelDrag(start, 30, 0, 2).center).toBe(100);
    expect(windowLevelDrag(start, -30, 0, 2).center).toBe(-20);
  });

  it('widens dragging up, narrows dragging down (screen-y grows downward)', () => {
    expect(windowLevelDrag(start, 0, -50, 2).width).toBe(500);
    expect(windowLevelDrag(start, 0, 50, 2).width).toBe(300);
  });

  it('clamps the width to a minimum of 1', () => {
    expect(windowLevelDrag(start, 0, 1000, 2).width).toBe(1);
  });

  it('moves centre and width independently along each axis', () => {
    expect(windowLevelDrag(start, 10, -20, 3)).toEqual({ center: 70, width: 460 });
  });
});

describe('windowLevelSensitivity', () => {
  it('scales with the value range', () => {
    expect(windowLevelSensitivity(-1024, 3072)).toBeCloseTo(8, 6);
  });

  it('never drops below 1 for a tiny range', () => {
    expect(windowLevelSensitivity(0, 10)).toBe(1);
  });
});

describe('windowGray', () => {
  // PS3.3 C.11.2.1.2: lo = center - 0.5 - (width - 1)/2; gray = (raw - lo)/(width - 1).
  it('maps the window centre to roughly mid-gray', () => {
    // The PS3.3 linear form's −0.5/(width−1) offset lands the centre a hair above
    // 0.5; close enough for display, exact equality isn't expected.
    expect(windowGray(50, 50, 400)).toBeCloseTo(0.5, 2);
  });

  it('clamps samples below the window to black and above to white', () => {
    expect(windowGray(-1000, 50, 400)).toBe(0);
    expect(windowGray(1000, 50, 400)).toBe(1);
  });

  it('places the window edges at black and white', () => {
    // The ramp spans [lo, lo + (width-1)] ≈ [center-width/2, center+width/2].
    expect(windowGray(-150, 50, 400)).toBeCloseTo(0, 2);
    expect(windowGray(250, 50, 400)).toBeCloseTo(1, 2);
  });

  it('floors the divisor at 1 for a degenerate (width ≤ 1) window', () => {
    // width 1 → lo = 49.5, divisor max(0, 1) = 1; the window becomes a near-step.
    expect(windowGray(51, 50, 1)).toBe(1);
    expect(windowGray(49, 50, 1)).toBe(0);
  });
});

describe('invertGray', () => {
  it('flips the gray ends', () => {
    expect(invertGray(0)).toBe(1);
    expect(invertGray(1)).toBe(0);
    expect(invertGray(0.25)).toBeCloseTo(0.75, 6);
  });

  it('is involutive: inverting twice is the identity', () => {
    for (const g of [0, 0.3, 0.5, 0.8, 1]) {
      expect(invertGray(invertGray(g))).toBeCloseTo(g, 6);
    }
  });

  it('inverts a windowed sample to one minus the windowed value', () => {
    const g = windowGray(120, 50, 400);
    expect(invertGray(g)).toBeCloseTo(1 - g, 6);
  });
});
