import { f32ToF16, floatsToHalf } from './half';

describe('f32ToF16', () => {
  it('encodes representative values to IEEE half bit patterns', () => {
    expect(f32ToF16(0)).toBe(0x0000);
    expect(f32ToF16(0.5)).toBe(0x3800);
    expect(f32ToF16(1)).toBe(0x3c00);
    expect(f32ToF16(2)).toBe(0x4000);
    expect(f32ToF16(-2)).toBe(0xc000);
  });

  it('saturates finite values beyond half range to the largest finite half', () => {
    // Above 65504 (half's max) a finite value must clamp to ±65504, never roll
    // over to Inf or — as it once did for a nonzero mantissa — NaN, which made
    // the hottest PET voxels render as transparent (see issue #229).
    expect(f32ToF16(65504)).toBe(0x7bff); // exactly the largest finite half
    expect(f32ToF16(66000)).toBe(0x7bff);
    expect(f32ToF16(150000)).toBe(0x7bff);
    expect(f32ToF16(-150000)).toBe(0xfbff);
    // A round-to-nearest carry that would tip the exponent to Inf also saturates.
    expect(f32ToF16(65520)).toBe(0x7bff);
  });

  it('still maps true infinities and NaN through', () => {
    expect(f32ToF16(Infinity)).toBe(0x7c00);
    expect(f32ToF16(-Infinity)).toBe(0xfc00);
    expect(f32ToF16(NaN) & 0x7e00).toBe(0x7e00); // quiet NaN (exp all ones, mantissa set)
  });
});

describe('floatsToHalf', () => {
  it('packs each float into a 16-bit lane', () => {
    const halves = floatsToHalf(new Float32Array([0, 1, -2]));

    expect(Array.from(halves)).toEqual([0x0000, 0x3c00, 0xc000]);
  });
});
