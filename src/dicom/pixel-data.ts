import * as dicomParser from 'dicom-parser';
import { decodeRleFrame } from './rle';
import type { StoredFrame } from './photometric';

/**
 * Low-level PixelData decoding: turning a transfer syntax's bytes into raw
 * integer samples, before any photometric or modality transform. Shared by the
 * sync and async decode paths in {@link import('./loader')}.
 */

/** Transfer syntaxes whose PixelData we can read directly (uncompressed, little-endian). */
export const UNCOMPRESSED_LE = new Set([
  '1.2.840.10008.1.2', // Implicit VR Little Endian
  '1.2.840.10008.1.2.1', // Explicit VR Little Endian
]);

/**
 * Decodes one encapsulated frame's bytes into raw samples (before the modality
 * LUT). Same shape as {@link readRawPixels}.
 */
export type FrameCodec = (
  frame: Uint8Array,
  count: number,
  bitsAllocated: number,
  pixelRepresentation: number,
) => Int16Array | Uint16Array | Uint8Array;

/**
 * Pure-JS frame codecs by transfer syntax UID. Add an entry here to support a
 * further compressed syntax that can be decoded without a third-party library.
 */
export const FRAME_CODECS: Record<string, FrameCodec> = {
  '1.2.840.10008.1.2.5': decodeRleFrame, // RLE Lossless
};

/**
 * One frame's decoded pixel values, ready for the modality LUT: stored integer
 * samples for grayscale, or a per-pixel luminance {@link Float32Array} for
 * palette/colour frames (already reduced to a single channel at decode time).
 */
export type FramePixels = StoredFrame | Float32Array;

/** Apply the modality LUT (raw * slope + intercept) into real units. */
export function rescale(
  raw: FramePixels,
  rescaleSlope: number,
  rescaleIntercept: number,
): Float32Array {
  const pixels = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    pixels[i] = raw[i] * rescaleSlope + rescaleIntercept;
  }
  return pixels;
}

/** Interpret wasm-decoded bytes as 8- or 16-bit samples per the DICOM header. */
export function reinterpretSamples(
  bytes: Uint8Array,
  bitsAllocated: number,
  pixelRepresentation: number,
): StoredFrame {
  if (bitsAllocated <= 8) return bytes;
  const count = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (pixelRepresentation === 1) {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
    return out;
  }
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

/**
 * Extract one frame's compressed bytes from an encapsulated PixelData element:
 * via the Basic Offset Table when present, otherwise treating each fragment as
 * one frame (the usual RLE layout).
 */
export function encapsulatedFrame(
  dataSet: dicomParser.DataSet,
  pixelElement: dicomParser.Element,
  frameIndex: number,
): Uint8Array {
  const bot = pixelElement.basicOffsetTable;
  if (bot && bot.length > 0) {
    return dicomParser.readEncapsulatedImageFrame(dataSet, pixelElement, frameIndex);
  }
  return dicomParser.readEncapsulatedPixelDataFromFragments(dataSet, pixelElement, frameIndex);
}

export function readRawPixels(
  buffer: ArrayBuffer,
  offset: number,
  count: number,
  bitsAllocated: number,
  pixelRepresentation: number,
): Int16Array | Uint16Array | Uint8Array {
  if (bitsAllocated <= 8) {
    return new Uint8Array(buffer, offset, count);
  }
  // 16-bit: byte offset may be odd, so copy into an aligned buffer.
  const view = new DataView(buffer, offset, count * 2);
  if (pixelRepresentation === 1) {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
    return out;
  }
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}
