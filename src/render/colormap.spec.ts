import {
  colormap,
  colormapLut,
  COLORMAPS,
  COLORMAP_ALPHA_RAMP,
  COLORMAP_LUT_SIZE,
  DEFAULT_COLORMAP,
  sampleColormap,
} from './colormap';

describe('sampleColormap', () => {
  const jet = COLORMAPS['jet'];

  it('returns the end stops at and beyond the domain ends', () => {
    expect(sampleColormap(jet, 0)).toEqual([0, 0, 0.5]);
    expect(sampleColormap(jet, 1)).toEqual([0.5, 0, 0]);
    // Clamped beyond [0, 1].
    expect(sampleColormap(jet, -1)).toEqual([0, 0, 0.5]);
    expect(sampleColormap(jet, 2)).toEqual([0.5, 0, 0]);
  });

  it('linearly interpolates between adjacent stops', () => {
    // Midway between stops at 0.625 ([1,1,0]) and 0.875 ([1,0,0]) is 0.75 → [1,0.5,0].
    const [r, g, b] = sampleColormap(jet, 0.75);
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0.5);
    expect(b).toBeCloseTo(0);
  });
});

describe('colormapLut', () => {
  it('bakes a size×4 RGBA LUT with the colour ramp ends', () => {
    const lut = colormapLut(COLORMAPS['hot']);
    expect(lut.length).toBe(COLORMAP_LUT_SIZE * 4);
    // First texel = ramp low end (black), last = high end (white).
    expect(Array.from(lut.slice(0, 3))).toEqual([0, 0, 0]);
    const lastTexel = COLORMAP_LUT_SIZE - 1;
    expect(Array.from(lut.slice(lastTexel * 4, lastTexel * 4 + 3))).toEqual([1, 1, 1]);
  });

  it('ramps alpha from 0 at the low end up to 1 (low/background values transparent)', () => {
    const lut = colormapLut(COLORMAPS['jet']);
    const alphaAt = (i: number): number => lut[i * 4 + 3];
    expect(alphaAt(0)).toBe(0); // background → fully transparent
    expect(alphaAt(COLORMAP_LUT_SIZE - 1)).toBe(1); // high end → fully opaque
    // Alpha reaches 1 by COLORMAP_ALPHA_RAMP of the range and stays there.
    const rampEnd = Math.ceil(COLORMAP_ALPHA_RAMP * (COLORMAP_LUT_SIZE - 1));
    expect(alphaAt(rampEnd)).toBe(1);
    // Monotonic non-decreasing across the ramp.
    for (let i = 1; i <= rampEnd; i++) {
      expect(alphaAt(i)).toBeGreaterThanOrEqual(alphaAt(i - 1));
    }
  });
});

describe('colormap', () => {
  it('resolves a known name and falls back to the default for an unknown one', () => {
    expect(colormap('hot').name).toBe('hot');
    expect(colormap('does-not-exist').name).toBe(DEFAULT_COLORMAP);
  });
});
