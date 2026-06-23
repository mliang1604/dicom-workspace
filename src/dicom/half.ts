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

/** Largest finite half: exponent 0x1e, mantissa 0x3ff (65504). */
const MAX_FINITE_HALF = 0x7bff;

/** Round a single float32 to its float16 bit pattern (round-to-nearest-even). */
export function f32ToF16(value: number): number {
  f32[0] = value;
  const x = u32[0];

  const sign = (x >>> 16) & 0x8000;
  // Biased exponent (0xff marks the source's own Inf/NaN) and mantissa.
  const biased = (x >>> 23) & 0xff;
  const exp = biased - 127 + 15;
  const mantissa = x & 0x7fffff;

  if (biased === 0xff) {
    // The source itself is Inf/NaN -> half infinity, or a quiet NaN if it was NaN.
    return sign | 0x7c00 | (mantissa !== 0 ? 0x200 : 0);
  }
  if (exp >= 0x1f) {
    // A finite value beyond the half range (e.g. high PET counts above 65504).
    // Saturate to the largest finite half rather than overflowing to Inf/NaN: an
    // overflowed voxel reads back as Inf/NaN through the r16float texture and
    // renders as a transparent hole instead of the bright value it should be.
    return sign | MAX_FINITE_HALF;
  }
  if (exp <= 0) {
    // Subnormal or underflow to zero.
    if (exp < -10) return sign;
    const m = (mantissa | 0x800000) >>> (1 - exp);
    // Round to nearest even.
    return sign | ((m + 0x1000) >>> 13);
  }
  // Normal number, round mantissa to nearest even. Rounding the top of the
  // largest exponent band can carry into the Inf pattern (0x7c00); saturate that
  // to the largest finite half for the same reason as the overflow branch above.
  const rounded = sign | (exp << 10) | ((mantissa + 0x1000) >>> 13);
  return (rounded & 0x7fff) >= 0x7c00 ? sign | MAX_FINITE_HALF : rounded;
}
