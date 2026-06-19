import type { Volume } from '../dicom/types';
import {
  CT_WINDOW_PRESETS,
  fullRangePreset,
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
