import * as dicomParser from 'dicom-parser';
import { decodeRleFrame } from './rle';
import type { Slice } from './types';

/** Transfer syntaxes whose PixelData we can read directly (uncompressed, little-endian). */
const UNCOMPRESSED_LE = new Set([
  '1.2.840.10008.1.2', // Implicit VR Little Endian
  '1.2.840.10008.1.2.1', // Explicit VR Little Endian
]);

/**
 * Decodes one encapsulated frame's bytes into raw samples (before the modality
 * LUT). Same shape as {@link readRawPixels}.
 */
type FrameCodec = (
  frame: Uint8Array,
  count: number,
  bitsAllocated: number,
  pixelRepresentation: number,
) => Int16Array | Uint16Array | Uint8Array;

/**
 * Pure-JS frame codecs by transfer syntax UID. Add an entry here to support a
 * further compressed syntax that can be decoded without a third-party library.
 */
const FRAME_CODECS: Record<string, FrameCodec> = {
  '1.2.840.10008.1.2.5': decodeRleFrame, // RLE Lossless
};

export class UnsupportedDicomError extends Error {}

/** Read a DICOM tag of value-representation DS/IS as a number, with a default. */
function num(dataSet: dicomParser.DataSet, tag: string, fallback: number): number {
  const v = dataSet.floatString(tag);
  return v === undefined || Number.isNaN(v) ? fallback : v;
}

/**
 * The fields shared by every frame in a file: image geometry that is fixed by
 * the pixel data layout, plus the byte offset where frame 0's samples begin.
 */
interface FileContext {
  readonly name: string;
  readonly buffer: ArrayBuffer;
  readonly dataSet: dicomParser.DataSet;
  readonly rows: number;
  readonly columns: number;
  readonly bitsAllocated: number;
  readonly pixelRepresentation: number;
  readonly modality: string | null;
  /** The PixelData (7FE0,0010) element — the source of encapsulated frames. */
  readonly pixelElement: dicomParser.Element;
  /** Frame codec for a compressed transfer syntax, or null when uncompressed. */
  readonly codec: FrameCodec | null;
  /** Byte offset of frame 0's first sample within {@link buffer} (uncompressed only). */
  readonly pixelOffset: number;
}

/**
 * Parse a single DICOM P10 file into its image frames.
 *
 * Returns one {@link Slice} per frame: a single slice for a classic
 * single-frame object, or N slices for an enhanced/multiframe object
 * (NumberOfFrames > 1, e.g. Enhanced MR/CT). Returns an empty array for files
 * that carry no grayscale image (DICOMDIR, color secondary capture, non-DICOM).
 */
export function parseFile(name: string, buffer: ArrayBuffer): Slice[] {
  const bytes = new Uint8Array(buffer);
  let dataSet: dicomParser.DataSet;
  try {
    dataSet = dicomParser.parseDicom(bytes);
  } catch {
    return []; // Not a parseable DICOM file.
  }

  const pixelElement = dataSet.elements['x7fe00010'];
  if (!pixelElement) return []; // No image data (e.g. DICOMDIR).

  const transferSyntax = dataSet.string('x00020010') ?? '1.2.840.10008.1.2';
  const codec = FRAME_CODECS[transferSyntax] ?? null;
  if (!codec && !UNCOMPRESSED_LE.has(transferSyntax)) {
    throw new UnsupportedDicomError(
      `Compressed transfer syntax ${transferSyntax} is not supported yet (${name}).`,
    );
  }

  const samplesPerPixel = dataSet.uint16('x00280002') ?? 1;
  if (samplesPerPixel !== 1) {
    return []; // Color image; out of scope for the grayscale volume viewer.
  }

  const rows = dataSet.uint16('x00280010');
  const columns = dataSet.uint16('x00280011');
  if (!rows || !columns) return [];

  const ctx: FileContext = {
    name,
    buffer,
    dataSet,
    rows,
    columns,
    bitsAllocated: dataSet.uint16('x00280100') ?? 16,
    pixelRepresentation: dataSet.uint16('x00280103') ?? 0, // 0 unsigned, 1 signed
    modality: dataSet.string('x00080060')?.trim() || null,
    pixelElement,
    codec,
    pixelOffset: pixelElement.dataOffset,
  };

  const frames = Math.floor(num(dataSet, 'x00280008', 1)); // NumberOfFrames
  return frames > 1 ? parseMultiframe(ctx, frames) : [parseSingleFrame(ctx)];
}

/** Classic single-frame object: all geometry lives in top-level tags. */
function parseSingleFrame(ctx: FileContext): Slice {
  const { dataSet } = ctx;
  const rescaleSlope = num(dataSet, 'x00281053', 1);
  const rescaleIntercept = num(dataSet, 'x00281052', 0);

  return {
    name: ctx.name,
    rows: ctx.rows,
    columns: ctx.columns,
    pixelSpacing: readPair(dataSet, 'x00280030', [1, 1]),
    position: readTriple(dataSet, 'x00200032'),
    orientation: readFloats(dataSet, 'x00200037', 6),
    instanceNumber: num(dataSet, 'x00200013', 0),
    modality: ctx.modality,
    rescaleSlope,
    rescaleIntercept,
    windowCenter: readFirstFloat(dataSet, 'x00281050'),
    windowWidth: readFirstFloat(dataSet, 'x00281051'),
    pixels: readFramePixels(ctx, 0, rescaleSlope, rescaleIntercept),
  };
}

/**
 * Enhanced/multiframe object: one frame per slice, with per-frame geometry in
 * the Per-Frame Functional Groups Sequence (5200,9230), falling back to the
 * Shared Functional Groups Sequence (5200,9229) and then to top-level tags.
 */
function parseMultiframe(ctx: FileContext, frames: number): Slice[] {
  const { dataSet } = ctx;
  const shared = firstItem(dataSet, 'x52009229');
  const perFrameSeq = dataSet.elements['x52009230'];

  const slices: Slice[] = [];
  for (let f = 0; f < frames; f++) {
    const fg = perFrameSeq?.items?.[f]?.dataSet ?? null;
    const groups: FunctionalGroups = { fg, shared, top: dataSet };

    // Pixel Value Transformation Sequence (0028,9145) -> Rescale Slope/Intercept.
    const rescaleSlope =
      readGroupValue(groups, 'x00289145', (ds) => readFirstFloat(ds, 'x00281053')) ?? 1;
    const rescaleIntercept =
      readGroupValue(groups, 'x00289145', (ds) => readFirstFloat(ds, 'x00281052')) ?? 0;

    // Pixel Measures Sequence (0028,9110) -> PixelSpacing (0028,0030).
    const spacing = readGroupValue(groups, 'x00289110', (ds) => readFloats(ds, 'x00280030', 2));

    slices.push({
      name: `${ctx.name}#${f + 1}`,
      rows: ctx.rows,
      columns: ctx.columns,
      pixelSpacing: spacing ? [spacing[0], spacing[1]] : [1, 1],
      // Plane Position Sequence (0020,9113) -> ImagePositionPatient (0020,0032).
      position: readGroupValue(groups, 'x00209113', (ds) => readTriple(ds, 'x00200032')),
      // Plane Orientation Sequence (0020,9116) -> ImageOrientationPatient (0020,0037).
      orientation: readGroupValue(groups, 'x00209116', (ds) => readFloats(ds, 'x00200037', 6)),
      instanceNumber: f + 1,
      modality: ctx.modality,
      rescaleSlope,
      rescaleIntercept,
      // Frame VOI LUT Sequence (0028,9132) -> Window Center/Width.
      windowCenter: readGroupValue(groups, 'x00289132', (ds) => readFirstFloat(ds, 'x00281050')),
      windowWidth: readGroupValue(groups, 'x00289132', (ds) => readFirstFloat(ds, 'x00281051')),
      pixels: readFramePixels(ctx, f, rescaleSlope, rescaleIntercept),
    });
  }
  return slices;
}

/** The three places a multiframe value may live, in lookup priority order. */
interface FunctionalGroups {
  /** This frame's Per-Frame Functional Groups item, if present. */
  readonly fg: dicomParser.DataSet | null;
  /** The single Shared Functional Groups item, if present. */
  readonly shared: dicomParser.DataSet | null;
  /** The top-level data set, where the value tag may sit directly. */
  readonly top: dicomParser.DataSet;
}

/**
 * Resolve a functional-group value: read it from the per-frame group's nested
 * sequence item, then the shared group's, then directly from the top-level data
 * set, returning the first non-null result.
 */
function readGroupValue<T>(
  groups: FunctionalGroups,
  seqTag: string,
  read: (ds: dicomParser.DataSet) => T | null,
): T | null {
  for (const source of [
    firstItem(groups.fg, seqTag),
    firstItem(groups.shared, seqTag),
    groups.top,
  ]) {
    if (!source) continue;
    const v = read(source);
    if (v !== null) return v;
  }
  return null;
}

/** First item's nested data set of a sequence element, or null. */
function firstItem(
  dataSet: dicomParser.DataSet | null,
  seqTag: string,
): dicomParser.DataSet | null {
  return dataSet?.elements[seqTag]?.items?.[0]?.dataSet ?? null;
}

/** Read one frame's samples and apply the modality LUT into real units. */
function readFramePixels(
  ctx: FileContext,
  frameIndex: number,
  rescaleSlope: number,
  rescaleIntercept: number,
): Float32Array {
  const count = ctx.rows * ctx.columns;
  const raw = readFrameSamples(ctx, frameIndex, count);

  const pixels = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pixels[i] = raw[i] * rescaleSlope + rescaleIntercept;
  }
  return pixels;
}

/** Read one frame's raw samples, decoding through the codec when compressed. */
function readFrameSamples(
  ctx: FileContext,
  frameIndex: number,
  count: number,
): Int16Array | Uint16Array | Uint8Array {
  if (ctx.codec) {
    const frame = encapsulatedFrame(ctx.dataSet, ctx.pixelElement, frameIndex);
    return ctx.codec(frame, count, ctx.bitsAllocated, ctx.pixelRepresentation);
  }
  const bytesPerSample = ctx.bitsAllocated <= 8 ? 1 : 2;
  const offset = ctx.pixelOffset + frameIndex * count * bytesPerSample;
  return readRawPixels(ctx.buffer, offset, count, ctx.bitsAllocated, ctx.pixelRepresentation);
}

/**
 * Extract one frame's compressed bytes from an encapsulated PixelData element:
 * via the Basic Offset Table when present, otherwise treating each fragment as
 * one frame (the usual RLE layout).
 */
function encapsulatedFrame(
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

function readRawPixels(
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

function readFloats(dataSet: dicomParser.DataSet, tag: string, n: number): number[] | null {
  const el = dataSet.elements[tag];
  if (!el || el.length === 0) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = dataSet.floatString(tag, i);
    if (v === undefined || Number.isNaN(v)) return null;
    out.push(v);
  }
  return out;
}

function readPair(
  dataSet: dicomParser.DataSet,
  tag: string,
  fallback: [number, number],
): [number, number] {
  const f = readFloats(dataSet, tag, 2);
  return f ? [f[0], f[1]] : fallback;
}

function readTriple(dataSet: dicomParser.DataSet, tag: string): [number, number, number] | null {
  const f = readFloats(dataSet, tag, 3);
  return f ? [f[0], f[1], f[2]] : null;
}

function readFirstFloat(dataSet: dicomParser.DataSet, tag: string): number | null {
  const el = dataSet.elements[tag];
  if (!el || el.length === 0) return null;
  const v = dataSet.floatString(tag, 0);
  return v === undefined || Number.isNaN(v) ? null : v;
}
