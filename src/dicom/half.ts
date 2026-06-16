/**
 * Convert a Float32Array to IEEE-754 half-precision (float16) bit patterns,
 * returned as a Uint16Array suitable for uploading to an `r16float` texture.
 *
 * WebGPU's only filterable 16-bit format is r16float, and `Float16Array` is
 * not yet universally available, so we pack halves by hand.
 */
export function floatsToHalf(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = f32ToF16(src[i]);
  }
  return out;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Round a single float32 to its float16 bit pattern (round-to-nearest-even). */
export function f32ToF16(value: number): number {
  f32[0] = value;
  const x = u32[0];

  const sign = (x >>> 16) & 0x8000;
  // Unbiased exponent and mantissa of the float32 value.
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mantissa = x & 0x7fffff;

  if (exp >= 0x1f) {
    // Overflow / Inf / NaN -> half infinity, or a quiet NaN if the source was NaN.
    return sign | 0x7c00 | (mantissa !== 0 ? 0x200 : 0);
  }
  if (exp <= 0) {
    // Subnormal or underflow to zero.
    if (exp < -10) return sign;
    const m = (mantissa | 0x800000) >>> (1 - exp);
    // Round to nearest even.
    return sign | ((m + 0x1000) >>> 13);
  }
  // Normal number, round mantissa to nearest even.
  return sign | (exp << 10) | ((mantissa + 0x1000) >>> 13);
}
