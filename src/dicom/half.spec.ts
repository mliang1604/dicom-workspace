import { f32ToF16, floatsToHalf } from './half';

describe('f32ToF16', () => {
  it('encodes representative values to IEEE half bit patterns', () => {
    expect(f32ToF16(0)).toBe(0x0000);
    expect(f32ToF16(0.5)).toBe(0x3800);
    expect(f32ToF16(1)).toBe(0x3c00);
    expect(f32ToF16(2)).toBe(0x4000);
    expect(f32ToF16(-2)).toBe(0xc000);
  });

  it('saturates finite values above the half range to the largest finite half', () => {
    // High PET counts that exceed the half range (65504) must clamp to the
    // brightest finite value, not overflow to Inf/NaN (which renders transparent).
    expect(f32ToF16(65504)).toBe(0x7bff); // exactly the max finite half
    expect(f32ToF16(65520)).toBe(0x7bff); // would round up to Inf without the clamp
    expect(f32ToF16(65535)).toBe(0x7bff);
    expect(f32ToF16(70000)).toBe(0x7bff); // would become NaN without the clamp
    expect(f32ToF16(1e9)).toBe(0x7bff);
    expect(f32ToF16(-70000)).toBe(0xfbff); // sign preserved
  });

  it("still propagates the source's own infinity and NaN", () => {
    expect(f32ToF16(Infinity)).toBe(0x7c00);
    expect(f32ToF16(-Infinity)).toBe(0xfc00);
    expect(f32ToF16(NaN) & 0x7e00).toBe(0x7e00); // quiet NaN pattern
  });
});

describe('floatsToHalf', () => {
  it('packs each float into a 16-bit lane', () => {
    const halves = floatsToHalf(new Float32Array([0, 1, -2]));

    expect(Array.from(halves)).toEqual([0x0000, 0x3c00, 0xc000]);
  });
});
