// Photometric-interpretation handling: the transforms that turn the raw bytes of
// PixelData into the single-channel grayscale values the volume stores, for the
// representations the bare loader would otherwise mishandle — sub-byte BitsStored,
// signed pixels, MONOCHROME1's inverted sense, palette colour, and RGB/YBR.
//
// Everything here is pure (numbers in, numbers out) so it can be unit-tested
// without a DICOM file; the loader wires these helpers to the parsed data set.

/** A frame of stored grayscale samples, before the modality LUT. */
export type StoredFrame = Int16Array | Uint16Array | Uint8Array;

/** True for any YBR_* photometric interpretation (vs RGB). */
export function isYbr(photometric: string): boolean {
  return photometric.startsWith('YBR');
}

/**
 * Constrain raw 8/16-bit samples to their real numeric value, given the DICOM
 * pixel-module attributes:
 *
 * - **BitsStored** (0028,0101): mask off the unused high bits — a 12-bits-stored
 *   sample carried in a 16-bit word must ignore bits 12–15, which may hold
 *   overlay data or be left non-zero.
 * - **PixelRepresentation** (0028,0103): when signed, sign-extend from the stored
 *   sign bit (BitsStored − 1), not from bit 15 — so a 12-bit `0xFFF` reads as −1.
 * - **PixelPaddingValue** (0028,0120): samples equal to the padding value mark
 *   out-of-field-of-view background; they are remapped to the minimum real sample
 *   so they sit at the dark end and don't widen the auto-window.
 *
 * Returns the input unchanged on the common full-width unsigned / signed-16 path
 * with no padding, so MONOCHROME2 studies are untouched.
 */
export function constrainFrame(
  raw: StoredFrame,
  bitsStored: number,
  pixelRepresentation: number,
  padding: number | null,
): StoredFrame {
  const signed = pixelRepresentation === 1;
  const storageBits = raw instanceof Uint8Array ? 8 : 16;
  const bits = bitsStored > 0 && bitsStored <= storageBits ? bitsStored : storageBits;

  // Fast path: nothing to strip and nothing to sign-fix, no padding to remap.
  if (padding === null && bits >= storageBits) {
    if (!signed && !(raw instanceof Int16Array)) return raw;
    if (signed && raw instanceof Int16Array) return raw;
  }

  const mask = (1 << bits) - 1;
  const signBit = 1 << (bits - 1);
  const n = raw.length;
  const out: StoredFrame = signed
    ? new Int16Array(n)
    : storageBits === 8
      ? new Uint8Array(n)
      : new Uint16Array(n);

  for (let i = 0; i < n; i++) {
    const masked = raw[i] & mask;
    out[i] = signed && masked & signBit ? masked - signBit * 2 : masked;
  }

  if (padding !== null) remapPadding(out, padding);
  return out;
}

/** Replace padding-valued samples with the minimum real (non-padding) sample. */
function remapPadding(frame: StoredFrame, padding: number): void {
  let min = Infinity;
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] !== padding && frame[i] < min) min = frame[i];
  }
  if (min === Infinity) return; // every sample is padding; leave as-is
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] === padding) frame[i] = min;
  }
}

/** Rec. 601 luma (BT.601) of an 8-bit RGB triple; the grayscale we display colour as. */
export function rgbToLuma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Identity colour map: a frame already in RGB needs no conversion. */
export function asRgb(r: number, g: number, b: number): [number, number, number] {
  return [r, g, b];
}

/**
 * YBR_FULL (full-range Rec. 601) to RGB, all components 0..255, clamped.
 * PS3.3 C.7.6.3.1.2. Used to recover a displayable luminance from a colour frame.
 */
export function ybrFullToRgb(y: number, cb: number, cr: number): [number, number, number] {
  const r = y + 1.402 * (cr - 128);
  const g = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
  const b = y + 1.772 * (cb - 128);
  return [clamp8(r), clamp8(g), clamp8(b)];
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Reduce a 3-sample colour frame to one luminance value per pixel.
 *
 * `samples` holds `count * 3` components, either interleaved (R,G,B,R,G,B…, the
 * default PlanarConfiguration 0) or planar (RR…GG…BB…, PlanarConfiguration 1).
 * `convert` maps a pixel's three stored components to RGB ({@link asRgb} for an
 * RGB frame, {@link ybrFullToRgb} for YBR), and the result is its Rec. 601 luma.
 */
export function colorFrameToLuma(
  samples: ArrayLike<number>,
  count: number,
  planar: boolean,
  convert: (a: number, b: number, c: number) => [number, number, number],
): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = planar ? samples[i] : samples[3 * i];
    const b = planar ? samples[count + i] : samples[3 * i + 1];
    const c = planar ? samples[2 * count + i] : samples[3 * i + 2];
    const [r, g, bl] = convert(a, b, c);
    out[i] = rgbToLuma(r, g, bl);
  }
  return out;
}

/** R/G/B Palette Color LUTs, normalized to 8-bit entries indexed from `firstMapped`. */
export interface PaletteLut {
  /** Pixel value that maps to entry 0 (Palette LUT Descriptor value 2). */
  readonly firstMapped: number;
  readonly r: Uint8Array;
  readonly g: Uint8Array;
  readonly b: Uint8Array;
}

/**
 * Build a {@link PaletteLut} from the three Palette Color LUT Descriptors'
 * shared shape (0028,1101–1103: [entries, firstMapped, bitsPerEntry]) and the
 * three LUT-data word arrays (0028,1201–1203). 16-bit entries are scaled down to
 * 8 bits; an entry count of 0 in the descriptor means 65536 (PS3.3 C.7.6.3.1.5).
 */
export function buildPaletteLut(
  descriptor: readonly [number, number, number],
  rData: Uint16Array,
  gData: Uint16Array,
  bData: Uint16Array,
): PaletteLut {
  const entries = descriptor[0] === 0 ? 65536 : descriptor[0];
  const firstMapped = descriptor[1];
  const shift = descriptor[2] > 8 ? 8 : 0;
  const n = Math.min(entries, rData.length, gData.length, bData.length);
  const r = new Uint8Array(n);
  const g = new Uint8Array(n);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = (rData[i] >> shift) & 0xff;
    g[i] = (gData[i] >> shift) & 0xff;
    b[i] = (bData[i] >> shift) & 0xff;
  }
  return { firstMapped, r, g, b };
}

/**
 * Map palette-indexed pixels to luminance: look each index up in the R/G/B LUTs
 * (clamped into range, offset by `firstMapped`) and take its Rec. 601 luma.
 */
export function paletteFrameToLuma(
  indices: ArrayLike<number>,
  count: number,
  lut: PaletteLut,
): Float32Array {
  const out = new Float32Array(count);
  const n = lut.r.length;
  for (let i = 0; i < count; i++) {
    let idx = indices[i] - lut.firstMapped;
    idx = idx < 0 ? 0 : idx >= n ? n - 1 : idx;
    out[i] = rgbToLuma(lut.r[idx], lut.g[idx], lut.b[idx]);
  }
  return out;
}
