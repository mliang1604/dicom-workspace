import {
  asRgb,
  buildPaletteLut,
  colorFrameToLuma,
  constrainFrame,
  isYbr,
  paletteFrameToLuma,
  rgbToLuma,
  ybrFullToRgb,
} from './photometric';

describe('constrainFrame — BitsStored / sign / padding', () => {
  it('returns full-width unsigned data unchanged (MONOCHROME2 untouched)', () => {
    const raw = new Uint16Array([0, 1000, 65535]);
    expect(constrainFrame(raw, 16, 0, null)).toBe(raw); // same reference, no copy
  });

  it('returns full-width signed data unchanged', () => {
    const raw = new Int16Array([-1024, 0, 3000]);
    expect(constrainFrame(raw, 16, 1, null)).toBe(raw);
  });

  it('masks unused high bits of a sub-width unsigned sample', () => {
    // 12 bits stored: bits 12–15 are noise to be cleared.
    const raw = new Uint16Array([0xf000 | 0x0123, 0x0fff]);
    expect(Array.from(constrainFrame(raw, 12, 0, null))).toEqual([0x0123, 0x0fff]);
  });

  it('sign-extends from the stored sign bit, not bit 15', () => {
    // 12-bit signed: 0xFFF is −1, 0x800 is the most-negative −2048, 0x7FF is +2047.
    const raw = new Uint16Array([0xfff, 0x800, 0x7ff, 0]);
    expect(Array.from(constrainFrame(raw, 12, 1, null))).toEqual([-1, -2048, 2047, 0]);
  });

  it('sign-extends 8-bit signed samples the readers leave unsigned', () => {
    const raw = new Uint8Array([255, 128, 127, 0]);
    expect(Array.from(constrainFrame(raw, 8, 1, null))).toEqual([-1, -128, 127, 0]);
  });

  it('remaps padding-valued samples to the minimum real sample', () => {
    const raw = new Uint16Array([2000, 5, 2000, 80]);
    // padding 2000 → replaced with 5 (the smallest non-padding value).
    expect(Array.from(constrainFrame(raw, 16, 0, 2000))).toEqual([5, 5, 5, 80]);
  });

  it('leaves an all-padding frame untouched', () => {
    const raw = new Uint16Array([7, 7, 7]);
    expect(Array.from(constrainFrame(raw, 16, 0, 7))).toEqual([7, 7, 7]);
  });
});

describe('rgbToLuma / ybrFullToRgb', () => {
  it('weights RGB by Rec. 601 coefficients', () => {
    expect(rgbToLuma(255, 255, 255)).toBeCloseTo(255);
    expect(rgbToLuma(0, 0, 0)).toBe(0);
    expect(rgbToLuma(255, 0, 0)).toBeCloseTo(76.245);
    expect(rgbToLuma(0, 255, 0)).toBeCloseTo(149.685);
  });

  it('passes neutral gray YBR through to equal RGB', () => {
    expect(ybrFullToRgb(128, 128, 128)).toEqual([128, 128, 128]);
  });

  it('recovers a primary colour from YBR_FULL', () => {
    // Rec. 601 full-range encoding of pure red (R=255): Y≈76, Cb≈85, Cr≈255.
    const [r, g, b] = ybrFullToRgb(76, 85, 255);
    expect(r).toBeGreaterThan(250);
    expect(g).toBeLessThan(10);
    expect(b).toBeLessThan(10);
  });

  it('clamps out-of-gamut results into [0, 255]', () => {
    const [r, g, b] = ybrFullToRgb(255, 255, 255);
    expect(r).toBeLessThanOrEqual(255);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(255);
  });

  it('classifies YBR vs RGB photometrics', () => {
    expect(isYbr('YBR_FULL_422')).toBe(true);
    expect(isYbr('RGB')).toBe(false);
  });
});

describe('colorFrameToLuma', () => {
  it('reduces interleaved RGB to per-pixel luma', () => {
    // Two pixels: white then black, interleaved R,G,B,R,G,B.
    const samples = [255, 255, 255, 0, 0, 0];
    const luma = colorFrameToLuma(samples, 2, false, asRgb);
    expect(luma[0]).toBeCloseTo(255);
    expect(luma[1]).toBe(0);
  });

  it('reads planar (RR…GG…BB…) layout when PlanarConfiguration is 1', () => {
    // Same two pixels (white, black) but planar: [R0,R1, G0,G1, B0,B1].
    const samples = [255, 0, 255, 0, 255, 0];
    const luma = colorFrameToLuma(samples, 2, true, asRgb);
    expect(luma[0]).toBeCloseTo(255);
    expect(luma[1]).toBe(0);
  });

  it('converts YBR before taking luma', () => {
    // Neutral gray YBR (128,128,128) → RGB (128,128,128) → luma 128.
    const luma = colorFrameToLuma([128, 128, 128], 1, false, ybrFullToRgb);
    expect(luma[0]).toBeCloseTo(128);
  });
});

describe('palette LUTs', () => {
  it('scales 16-bit entries down to 8 bits and indexes from firstMapped', () => {
    const lut = buildPaletteLut(
      [3, 10, 16], // 3 entries, first value mapped = 10, 16 bits per entry
      Uint16Array.from([0x0000, 0x8000, 0xffff]),
      Uint16Array.from([0x0000, 0x8000, 0xffff]),
      Uint16Array.from([0x0000, 0x8000, 0xffff]),
    );
    expect(Array.from(lut.r)).toEqual([0, 0x80, 0xff]);
    expect(lut.firstMapped).toBe(10);
  });

  it('treats a descriptor entry count of 0 as 65536', () => {
    const data = Uint16Array.from([1, 2]); // shorter than 65536; LUT clamps to data length
    const lut = buildPaletteLut([0, 0, 16], data, data, data);
    expect(lut.r.length).toBe(2);
  });

  it('maps indices through the LUTs to luma, clamping out-of-range indices', () => {
    // Entry 0 = black, entry 1 = white, first value mapped = 5.
    const lut = buildPaletteLut(
      [2, 5, 8],
      Uint16Array.from([0, 255]),
      Uint16Array.from([0, 255]),
      Uint16Array.from([0, 255]),
    );
    const luma = paletteFrameToLuma([5, 6, 99, 0], 4, lut);
    expect(luma[0]).toBe(0); // index 5 → entry 0 (black)
    expect(luma[1]).toBeCloseTo(255); // index 6 → entry 1 (white)
    expect(luma[2]).toBeCloseTo(255); // index 99 → clamped to last entry
    expect(luma[3]).toBe(0); // index 0 (below firstMapped) → clamped to entry 0
  });
});
