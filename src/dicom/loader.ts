import * as dicomParser from 'dicom-parser';
import { decodeWasmFrame, isWasmTransferSyntax } from './wasm-codecs';
import {
  asRgb,
  colorFrameToLuma,
  constrainFrame,
  isYbr,
  paletteFrameToLuma,
  type PaletteLut,
  type StoredFrame,
  ybrFullToRgb,
} from './photometric';
import { extractMetadata } from './metadata';
import { add, cross, normalize, scale } from './vec3';
import type { Slice } from './types';
import {
  encapsulatedFrame,
  FRAME_CODECS,
  readRawPixels,
  reinterpretSamples,
  rescale,
  UNCOMPRESSED_LE,
  type FrameCodec,
  type FramePixels,
} from './pixel-data';
import {
  firstItem,
  intOrNull,
  num,
  readFirstFloat,
  readFloats,
  readGroupValue,
  readPadding,
  readPair,
  readPalette,
  readTriple,
  type FunctionalGroups,
} from './dicom-tags';

/** SOP Class UID identifying an RT Dose Storage object. */
const RTDOSE_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.2';

export class UnsupportedDicomError extends Error {}

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
  readonly bitsStored: number;
  readonly pixelRepresentation: number;
  /**
   * How PixelData turns into displayed grayscale: a plain single-sample
   * grayscale image (`mono`), palette-indexed colour reduced to luminance
   * (`palette`), or a multi-sample RGB/YBR frame reduced to luminance (`color`).
   */
  readonly kind: 'mono' | 'palette' | 'color';
  /** Photometric Interpretation (0028,0004), e.g. MONOCHROME1/2, RGB, YBR_FULL. */
  readonly photometric: string;
  /** PlanarConfiguration (0028,0006): 0 interleaved (R,G,B…), 1 planar (RR…GG…BB…). */
  readonly planarConfiguration: number;
  /** True for MONOCHROME1, whose display sense is inverted (minimum = white). */
  readonly invert: boolean;
  /** PixelPaddingValue (0028,0120) in stored units, or null when absent. */
  readonly pixelPadding: number | null;
  /** R/G/B palette LUTs for a PALETTE COLOR image, or null. */
  readonly palette: PaletteLut | null;
  readonly seriesUid: string | null;
  readonly seriesNumber: number | null;
  readonly seriesDescription: string | null;
  readonly frameOfReferenceUid: string | null;
  readonly studyUid: string | null;
  /** StudyDate/StudyTime/PatientName kept raw (DICOM DA/TM/PN); formatting is a UI concern. */
  readonly studyDate: string | null;
  readonly studyTime: string | null;
  readonly studyDescription: string | null;
  readonly patientId: string | null;
  readonly patientName: string | null;
  readonly modality: string | null;
  /** True for an RT Dose object, decoded as a Gy-scaled grid rather than an image. */
  readonly isDose: boolean;
  /** The PixelData (7FE0,0010) element — the source of encapsulated frames. */
  readonly pixelElement: dicomParser.Element;
  /** Sync (pure-JS) frame codec for a compressed transfer syntax, or null. */
  readonly codec: FrameCodec | null;
  /** Transfer syntax UID needing an async wasm codec (JPEG/JPEG-LS/JP2K), or null. */
  readonly wasmTransferSyntax: string | null;
  /** Byte offset of frame 0's first sample within {@link buffer} (uncompressed only). */
  readonly pixelOffset: number;
}

/** What {@link setupFile} resolves from a file: geometry context + frame count. */
interface FileSetup {
  readonly ctx: FileContext;
  readonly frames: number;
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
  const setup = setupFile(name, buffer);
  if (!setup) return [];
  const { ctx, frames } = setup;
  if (ctx.isDose) return parseDose(ctx, frames);
  if (ctx.wasmTransferSyntax) {
    throw new UnsupportedDicomError(
      `Transfer syntax ${ctx.wasmTransferSyntax} requires async decoding; use parseFileAsync (${name}).`,
    );
  }
  const count = ctx.rows * ctx.columns;
  const raw: FramePixels[] = [];
  for (let f = 0; f < frames; f++) raw.push(readFrameSamples(ctx, f, count));
  return assemble(ctx, frames, raw);
}

/**
 * Like {@link parseFile}, but also decodes the compressed transfer syntaxes that
 * need an async wasm codec (JPEG, JPEG-LS, JPEG 2000). Uncompressed and RLE
 * studies take the same synchronous path and never load a wasm module.
 */
export async function parseFileAsync(name: string, buffer: ArrayBuffer): Promise<Slice[]> {
  const setup = setupFile(name, buffer);
  if (!setup) return [];
  const { ctx, frames } = setup;
  if (ctx.isDose) return parseDose(ctx, frames);
  const count = ctx.rows * ctx.columns;
  const raw: FramePixels[] = [];
  for (let f = 0; f < frames; f++) raw.push(await readFrameSamplesAsync(ctx, f, count));
  return assemble(ctx, frames, raw);
}

/**
 * Parse a file's metadata and choose its decode path. Returns null for files
 * that carry no grayscale image; throws {@link UnsupportedDicomError} for a
 * transfer syntax no codec handles.
 */
function setupFile(name: string, buffer: ArrayBuffer): FileSetup | null {
  const bytes = new Uint8Array(buffer);
  let dataSet: dicomParser.DataSet;
  try {
    dataSet = dicomParser.parseDicom(bytes);
  } catch {
    return null; // Not a parseable DICOM file.
  }

  const pixelElement = dataSet.elements['x7fe00010'];
  if (!pixelElement) return null; // No image data (e.g. DICOMDIR).

  const transferSyntax = dataSet.string('x00020010') ?? '1.2.840.10008.1.2';
  const codec = FRAME_CODECS[transferSyntax] ?? null;
  const wasm = isWasmTransferSyntax(transferSyntax);
  if (!codec && !wasm && !UNCOMPRESSED_LE.has(transferSyntax)) {
    throw new UnsupportedDicomError(`Unsupported transfer syntax ${transferSyntax} (${name}).`);
  }

  const rows = dataSet.uint16('x00280010');
  const columns = dataSet.uint16('x00280011');
  if (!rows || !columns) return null;

  const bitsAllocated = dataSet.uint16('x00280100') ?? 16;
  const pixelRepresentation = dataSet.uint16('x00280103') ?? 0; // 0 unsigned, 1 signed
  const samplesPerPixel = dataSet.uint16('x00280002') ?? 1;
  const photometric = dataSet.string('x00280004')?.trim().toUpperCase() || 'MONOCHROME2';
  const palette = photometric === 'PALETTE COLOR' ? readPalette(dataSet) : null;
  // Reduce colour to a single luminance channel: a multi-sample frame (RGB/YBR)
  // or a palette-indexed one. Anything else is plain single-sample grayscale.
  const kind: FileContext['kind'] = samplesPerPixel >= 3 ? 'color' : palette ? 'palette' : 'mono';

  // Detect RT Dose by Modality (uppercased, like the RTSTRUCT path) or SOP class,
  // so a non-canonically-cased dose isn't misdecoded as a 16-bit image.
  const modality = dataSet.string('x00080060')?.trim() || null;
  const isDose =
    modality?.toUpperCase() === 'RTDOSE' ||
    dataSet.string('x00080016')?.trim() === RTDOSE_SOP_CLASS;

  const ctx: FileContext = {
    name,
    buffer,
    dataSet,
    rows,
    columns,
    bitsAllocated,
    bitsStored: dataSet.uint16('x00280101') ?? bitsAllocated, // BitsStored
    pixelRepresentation,
    kind,
    photometric,
    planarConfiguration: dataSet.uint16('x00280006') ?? 0, // PlanarConfiguration
    invert: photometric === 'MONOCHROME1',
    pixelPadding: readPadding(dataSet, pixelRepresentation),
    palette,
    seriesUid: dataSet.string('x0020000e')?.trim() || null, // SeriesInstanceUID
    seriesNumber: intOrNull(dataSet, 'x00200011'), // SeriesNumber
    seriesDescription: dataSet.string('x0008103e')?.trim() || null, // SeriesDescription
    frameOfReferenceUid: dataSet.string('x00200052')?.trim() || null, // FrameOfReferenceUID
    studyUid: dataSet.string('x0020000d')?.trim() || null, // StudyInstanceUID
    studyDate: dataSet.string('x00080020')?.trim() || null, // StudyDate (raw DA)
    studyTime: dataSet.string('x00080030')?.trim() || null, // StudyTime (raw TM)
    studyDescription: dataSet.string('x00081030')?.trim() || null, // StudyDescription
    patientId: dataSet.string('x00100020')?.trim() || null, // PatientID
    patientName: dataSet.string('x00100010')?.trim() || null, // PatientName (raw PN)
    modality,
    isDose,
    pixelElement,
    codec,
    wasmTransferSyntax: wasm ? transferSyntax : null,
    pixelOffset: pixelElement.dataOffset,
  };

  const frames = Math.floor(num(dataSet, 'x00280008', 1)); // NumberOfFrames
  return { ctx, frames };
}

/**
 * Assemble the decoded raw frames into one Slice per frame, capturing the file's
 * DICOM metadata onto the first frame (the series-representative image).
 */
function assemble(ctx: FileContext, frames: number, raw: FramePixels[]): Slice[] {
  const metadata = extractMetadata(ctx.dataSet);
  const slices = frames > 1 ? parseMultiframe(ctx, frames, raw) : [parseSingleFrame(ctx, raw[0])];
  return slices.map((slice, f) => (f === 0 ? { ...slice, metadata } : slice));
}

/**
 * Assemble an RT Dose (Modality RTDOSE) instance into one {@link Slice} per
 * dose-grid plane.
 *
 * A dose grid is multi-frame, but unlike an image stack its through-plane
 * positions come from GridFrameOffsetVector (3004,000C) — per-frame offsets in mm
 * along the slice normal from ImagePositionPatient — and its samples are scaled to
 * absorbed dose in Gray by DoseGridScaling (3004,000E) rather than a modality LUT.
 * Emitting one Gy-valued Slice per plane lets {@link import('./volume').buildVolume}
 * assemble the grid and the existing reslice/probe/overlay machinery treat dose
 * like any other scalar volume; `rescaleSlope = DoseGridScaling` lets the probe
 * recover the stored integer. Frames are unsigned 8/16/32-bit and uncompressed.
 */
function parseDose(ctx: FileContext, frames: number): Slice[] {
  if (ctx.codec || ctx.wasmTransferSyntax) {
    throw new UnsupportedDicomError(`Compressed RT Dose is not supported (${ctx.name}).`);
  }
  const { dataSet } = ctx;
  const scaling = num(dataSet, 'x3004000e', 1); // DoseGridScaling
  const offsets = readFloats(dataSet, 'x3004000c', frames); // GridFrameOffsetVector
  const orientation = readFloats(dataSet, 'x00200037', 6); // ImageOrientationPatient
  const origin = readTriple(dataSet, 'x00200032'); // ImagePositionPatient (frame 0)
  const pixelSpacing = readPair(dataSet, 'x00280030', [1, 1]);
  const normal =
    orientation && origin
      ? normalize(cross(orientation.slice(0, 3), orientation.slice(3, 6)))
      : null;
  const count = ctx.rows * ctx.columns;
  const metadata = extractMetadata(dataSet);

  const slices: Slice[] = [];
  for (let f = 0; f < frames; f++) {
    // Each frame sits offsets[f] mm along the normal from the first frame's origin.
    // A missing GridFrameOffsetVector (malformed multi-frame dose) falls back to
    // unit steps so the frames still stack rather than collapsing onto one plane.
    const offset = offsets ? offsets[f] : f;
    const position = origin && normal ? add(origin, scale(normal, offset)) : origin;
    const slice: Slice = {
      name: frames > 1 ? `${ctx.name}#${f + 1}` : ctx.name,
      rows: ctx.rows,
      columns: ctx.columns,
      pixelSpacing,
      position,
      orientation,
      instanceNumber: f + 1,
      seriesUid: ctx.seriesUid,
      seriesNumber: ctx.seriesNumber,
      seriesDescription: ctx.seriesDescription,
      frameOfReferenceUid: ctx.frameOfReferenceUid,
      studyUid: ctx.studyUid,
      studyDate: ctx.studyDate,
      studyTime: ctx.studyTime,
      studyDescription: ctx.studyDescription,
      patientId: ctx.patientId,
      patientName: ctx.patientName,
      // Canonical modality so the unit lookup yields Gy even for a SOP-class-detected
      // (or non-canonically-cased) dose object.
      modality: 'RTDOSE',
      rescaleSlope: scaling,
      rescaleIntercept: 0,
      windowCenter: null,
      windowWidth: null,
      pixels: readDoseFrame(ctx, f, count, scaling),
    };
    slices.push(f === 0 ? { ...slice, metadata } : slice);
  }
  return slices;
}

/**
 * Read one RT Dose frame's samples (8/16/32-bit, little-endian) directly from
 * uncompressed PixelData, scaled to Gy by `scaling`. Dose grids are commonly
 * 32-bit, which the general {@link readRawPixels} path (8/16-bit) does not cover.
 * Samples are read signed when PixelRepresentation (0028,0103) is 1 — e.g. a
 * difference (signed) dose grid — and unsigned otherwise.
 */
function readDoseFrame(
  ctx: FileContext,
  frameIndex: number,
  count: number,
  scaling: number,
): Float32Array {
  const bytesPerSample = ctx.bitsAllocated <= 8 ? 1 : ctx.bitsAllocated <= 16 ? 2 : 4;
  const offset = ctx.pixelOffset + frameIndex * count * bytesPerSample;
  ensurePixelBytes(ctx, offset, count * bytesPerSample);
  const view = new DataView(ctx.buffer, offset, count * bytesPerSample);
  const signed = ctx.pixelRepresentation === 1;
  const out = new Float32Array(count);
  if (bytesPerSample === 4) {
    for (let i = 0; i < count; i++)
      out[i] = (signed ? view.getInt32(i * 4, true) : view.getUint32(i * 4, true)) * scaling;
  } else if (bytesPerSample === 2) {
    for (let i = 0; i < count; i++)
      out[i] = (signed ? view.getInt16(i * 2, true) : view.getUint16(i * 2, true)) * scaling;
  } else {
    for (let i = 0; i < count; i++)
      out[i] = (signed ? view.getInt8(i) : view.getUint8(i)) * scaling;
  }
  return out;
}

/**
 * Guard a raw pixel read against a header that declares more samples than the
 * file carries. A truncated PixelData element would otherwise build a typed-array
 * view past the end of the buffer and throw an untyped `RangeError` that aborts
 * the whole batch; throwing a typed {@link UnsupportedDicomError} lets the bad
 * file be skipped diagnostically. Checks both the buffer end and the declared
 * PixelData element extent.
 */
function ensurePixelBytes(ctx: FileContext, offset: number, byteCount: number): void {
  const pixelEnd = ctx.pixelOffset + ctx.pixelElement.length;
  if (offset + byteCount > ctx.buffer.byteLength || offset + byteCount > pixelEnd) {
    throw new UnsupportedDicomError(`PixelData truncated (${ctx.name}).`);
  }
}

/** A frame's modality LUT and suggested display window, before photometric folding. */
interface ModalityTransform {
  readonly slope: number;
  readonly intercept: number;
  readonly windowCenter: number | null;
  readonly windowWidth: number | null;
}

/**
 * Fold the photometric interpretation into a frame's modality LUT and window.
 *
 * - **Colour / palette** frames are reduced to luminance at decode time, so they
 *   carry no modality LUT: slope/intercept collapse to 1/0 and any stored
 *   grayscale window is dropped in favour of the data-derived one.
 * - **MONOCHROME1** inverts the display sense (the minimum value is white).
 *   Negating the modality LUT — and the window centre — reflects the values about
 *   zero, which reproduces the inversion through the unchanged MONOCHROME2 shader
 *   and keeps `data = raw·slope + intercept` true, so the voxel probe still
 *   recovers the original stored value.
 */
function photometricTransform(ctx: FileContext, m: ModalityTransform): ModalityTransform {
  if (ctx.kind !== 'mono') {
    return { slope: 1, intercept: 0, windowCenter: null, windowWidth: null };
  }
  if (!ctx.invert) return m;
  return {
    slope: -m.slope,
    intercept: -m.intercept,
    windowCenter: m.windowCenter === null ? null : -m.windowCenter,
    windowWidth: m.windowWidth,
  };
}

/** Classic single-frame object: all geometry lives in top-level tags. */
function parseSingleFrame(ctx: FileContext, raw: FramePixels): Slice {
  const { dataSet } = ctx;
  const m = photometricTransform(ctx, {
    slope: num(dataSet, 'x00281053', 1),
    intercept: num(dataSet, 'x00281052', 0),
    windowCenter: readFirstFloat(dataSet, 'x00281050'),
    windowWidth: readFirstFloat(dataSet, 'x00281051'),
  });

  return {
    name: ctx.name,
    rows: ctx.rows,
    columns: ctx.columns,
    pixelSpacing: readPair(dataSet, 'x00280030', [1, 1]),
    position: readTriple(dataSet, 'x00200032'),
    orientation: readFloats(dataSet, 'x00200037', 6),
    instanceNumber: num(dataSet, 'x00200013', 0),
    seriesUid: ctx.seriesUid,
    seriesNumber: ctx.seriesNumber,
    seriesDescription: ctx.seriesDescription,
    frameOfReferenceUid: ctx.frameOfReferenceUid,
    studyUid: ctx.studyUid,
    studyDate: ctx.studyDate,
    studyTime: ctx.studyTime,
    studyDescription: ctx.studyDescription,
    patientId: ctx.patientId,
    patientName: ctx.patientName,
    modality: ctx.modality,
    rescaleSlope: m.slope,
    rescaleIntercept: m.intercept,
    windowCenter: m.windowCenter,
    windowWidth: m.windowWidth,
    pixels: rescale(raw, m.slope, m.intercept),
  };
}

/**
 * Enhanced/multiframe object: one frame per slice, with per-frame geometry in
 * the Per-Frame Functional Groups Sequence (5200,9230), falling back to the
 * Shared Functional Groups Sequence (5200,9229) and then to top-level tags.
 */
function parseMultiframe(ctx: FileContext, frames: number, raw: FramePixels[]): Slice[] {
  const { dataSet } = ctx;
  const shared = firstItem(dataSet, 'x52009229');
  const perFrameSeq = dataSet.elements['x52009230'];

  const slices: Slice[] = [];
  for (let f = 0; f < frames; f++) {
    const fg = perFrameSeq?.items?.[f]?.dataSet ?? null;
    const groups: FunctionalGroups = { fg, shared, top: dataSet };

    // Pixel Value Transformation Sequence (0028,9145) -> Rescale Slope/Intercept,
    // and Frame VOI LUT Sequence (0028,9132) -> Window Center/Width, folded
    // through the photometric interpretation (MONOCHROME1 invert, colour/palette).
    const m = photometricTransform(ctx, {
      slope: readGroupValue(groups, 'x00289145', (ds) => readFirstFloat(ds, 'x00281053')) ?? 1,
      intercept: readGroupValue(groups, 'x00289145', (ds) => readFirstFloat(ds, 'x00281052')) ?? 0,
      windowCenter: readGroupValue(groups, 'x00289132', (ds) => readFirstFloat(ds, 'x00281050')),
      windowWidth: readGroupValue(groups, 'x00289132', (ds) => readFirstFloat(ds, 'x00281051')),
    });

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
      seriesUid: ctx.seriesUid,
      seriesNumber: ctx.seriesNumber,
      seriesDescription: ctx.seriesDescription,
      frameOfReferenceUid: ctx.frameOfReferenceUid,
      studyUid: ctx.studyUid,
      studyDate: ctx.studyDate,
      studyTime: ctx.studyTime,
      studyDescription: ctx.studyDescription,
      patientId: ctx.patientId,
      patientName: ctx.patientName,
      modality: ctx.modality,
      rescaleSlope: m.slope,
      rescaleIntercept: m.intercept,
      windowCenter: m.windowCenter,
      windowWidth: m.windowWidth,
      pixels: rescale(raw[f], m.slope, m.intercept),
    });
  }
  return slices;
}

/**
 * Reduce one frame's decoded samples to the single-channel pixels the volume
 * stores: stored grayscale values (BitsStored/sign/padding applied) for `mono`,
 * or a per-pixel luminance for `palette`/`color`.
 */
function convertFrame(ctx: FileContext, raw: StoredFrame, count: number): FramePixels {
  switch (ctx.kind) {
    case 'color': {
      const convert = isYbr(ctx.photometric) ? ybrFullToRgb : asRgb;
      return colorFrameToLuma(raw, count, ctx.planarConfiguration === 1, convert);
    }
    case 'palette': {
      const indices = constrainFrame(raw, ctx.bitsStored, 0, ctx.pixelPadding);
      return paletteFrameToLuma(indices, count, ctx.palette!);
    }
    default:
      return constrainFrame(raw, ctx.bitsStored, ctx.pixelRepresentation, ctx.pixelPadding);
  }
}

/** Read one frame's raw samples synchronously (uncompressed or pure-JS codec). */
function readFrameSamples(ctx: FileContext, frameIndex: number, count: number): FramePixels {
  if (ctx.codec) {
    // The pure-JS codecs (RLE) decode grayscale frames only.
    const frame = encapsulatedFrame(ctx.dataSet, ctx.pixelElement, frameIndex);
    return convertFrame(
      ctx,
      ctx.codec(frame, count, ctx.bitsAllocated, ctx.pixelRepresentation),
      count,
    );
  }
  const samplesPerPixel = ctx.kind === 'color' ? 3 : 1;
  const total = count * samplesPerPixel;
  const bytesPerSample = ctx.bitsAllocated <= 8 ? 1 : 2;
  const offset = ctx.pixelOffset + frameIndex * total * bytesPerSample;
  ensurePixelBytes(ctx, offset, total * bytesPerSample);
  const raw = readRawPixels(ctx.buffer, offset, total, ctx.bitsAllocated, ctx.pixelRepresentation);
  return convertFrame(ctx, raw, count);
}

/** Read one frame's raw samples, awaiting a wasm codec for compressed syntaxes. */
async function readFrameSamplesAsync(
  ctx: FileContext,
  frameIndex: number,
  count: number,
): Promise<FramePixels> {
  if (!ctx.wasmTransferSyntax) return readFrameSamples(ctx, frameIndex, count);
  const frame = encapsulatedFrame(ctx.dataSet, ctx.pixelElement, frameIndex);
  const decoded = await decodeWasmFrame(ctx.wasmTransferSyntax, frame);
  // A colour codec output (componentCount ≥ 3) is interleaved 8-bit RGB after the
  // decoder's own colour transform; reduce it to luminance like the colour path.
  if (decoded.componentCount >= 3) {
    return colorFrameToLuma(decoded.bytes, count, false, asRgb);
  }
  const raw = reinterpretSamples(decoded.bytes, ctx.bitsAllocated, ctx.pixelRepresentation);
  return convertFrame(ctx, raw, count);
}
