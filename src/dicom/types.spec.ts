import {
  baseImageLayer,
  baseLayer,
  framesMatch,
  modalityUnit,
  overlayImageLayer,
  type Layer,
  type Volume,
} from './types';

describe('framesMatch', () => {
  it('matches two equal, non-null frame of reference UIDs', () => {
    expect(framesMatch('1.2.frame', '1.2.frame')).toBe(true);
  });

  it('does not match differing frames', () => {
    expect(framesMatch('1.2.frame', '9.9.other')).toBe(false);
  });

  it('never matches when either side is null — an absent frame aligns to nothing', () => {
    expect(framesMatch(null, null)).toBe(false);
    expect(framesMatch('1.2.frame', null)).toBe(false);
    expect(framesMatch(null, '1.2.frame')).toBe(false);
  });
});

describe('modalityUnit', () => {
  it('labels CT values as Hounsfield Units', () => {
    expect(modalityUnit('CT')).toBe('HU');
  });

  it('labels RTDOSE values as Gray', () => {
    expect(modalityUnit('RTDOSE')).toBe('Gy');
  });

  it('returns null for modalities without a standard scalar unit', () => {
    expect(modalityUnit('MR')).toBeNull();
    expect(modalityUnit('US')).toBeNull();
  });

  it('returns null when the modality is unknown', () => {
    expect(modalityUnit(null)).toBeNull();
  });
});

/** A minimal volume; only the fields the layer helpers read need realistic values. */
function fakeVolume(modality: string | null): Volume {
  return {
    dims: [1, 1, 1],
    spacing: [1, 1, 1],
    data: new Float32Array(1),
    min: 0,
    max: 1,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality,
  };
}

describe('baseImageLayer', () => {
  it('wraps a volume as an opaque, visible, grayscale base layer', () => {
    const volume = fakeVolume('CT');
    const layer = baseImageLayer('series-1', volume);
    expect(layer).toEqual({
      id: 'series-1',
      volume,
      modality: 'CT',
      role: 'base',
      display: { kind: 'grayscale' },
      opacity: 1,
      visible: true,
    });
  });
});

describe('overlayImageLayer', () => {
  it('wraps a volume as a translucent, visible, grayscale overlay layer', () => {
    const volume = fakeVolume('MR');
    const layer = overlayImageLayer('series-2', volume);
    expect(layer).toEqual({
      id: 'series-2',
      volume,
      modality: 'MR',
      role: 'overlay',
      display: { kind: 'grayscale' },
      opacity: 0.5,
      visible: true,
    });
  });
});

describe('baseLayer', () => {
  const overlay: Layer = {
    id: 'dose',
    volume: fakeVolume('RTDOSE'),
    modality: 'RTDOSE',
    role: 'overlay',
    display: { kind: 'colormap', name: 'jet' },
    opacity: 0.5,
    visible: true,
  };

  it('returns the base-role layer regardless of position', () => {
    const base = baseImageLayer('ct', fakeVolume('CT'));
    expect(baseLayer([overlay, base])).toBe(base);
  });

  it('falls back to the first entry when none is tagged base', () => {
    expect(baseLayer([overlay])).toBe(overlay);
  });

  it('returns undefined for an empty registry', () => {
    expect(baseLayer([])).toBeUndefined();
  });
});
