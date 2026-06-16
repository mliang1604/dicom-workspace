import { f32ToF16, floatsToHalf } from './half';

describe('f32ToF16', () => {
  it('encodes representative values to IEEE half bit patterns', () => {
    expect(f32ToF16(0)).toBe(0x0000);
    expect(f32ToF16(0.5)).toBe(0x3800);
    expect(f32ToF16(1)).toBe(0x3c00);
    expect(f32ToF16(2)).toBe(0x4000);
    expect(f32ToF16(-2)).toBe(0xc000);
  });
});

describe('floatsToHalf', () => {
  it('packs each float into a 16-bit lane', () => {
    const halves = floatsToHalf(new Float32Array([0, 1, -2]));

    expect(Array.from(halves)).toEqual([0x0000, 0x3c00, 0xc000]);
  });
});
