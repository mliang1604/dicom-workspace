import * as dicomParser from 'dicom-parser';
import type { Slice } from './types';

/** Transfer syntaxes whose PixelData we can read directly (uncompressed, little-endian). */
const UNCOMPRESSED_LE = new Set([
  '1.2.840.10008.1.2', // Implicit VR Little Endian
  '1.2.840.10008.1.2.1', // Explicit VR Little Endian
]);

export class UnsupportedDicomError extends Error {}

/** Read a DICOM tag of value-representation DS/IS as a number, with a default. */
function num(dataSet: dicomParser.DataSet, tag: string, fallback: number): number {
  const v = dataSet.floatString(tag);
  return v === undefined || Number.isNaN(v) ? fallback : v;
}

/**
 * Parse a single DICOM P10 file into a {@link Slice}.
 * Returns `null` for files that are not single-frame grayscale images
 * (e.g. DICOMDIR, secondary capture color, or non-DICOM files).
 */
export function parseSlice(name: string, buffer: ArrayBuffer): Slice | null {
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
  if (!UNCOMPRESSED_LE.has(transferSyntax)) {
    throw new UnsupportedDicomError(
      `Compressed transfer syntax ${transferSyntax} is not supported yet (${name}).`,
    );
  }

  const samplesPerPixel = dataSet.uint16('x00280002') ?? 1;
  if (samplesPerPixel !== 1) {
    return null; // Color image; out of scope for the grayscale volume viewer.
  }

  const rows = dataSet.uint16('x00280010');
  const columns = dataSet.uint16('x00280011');
  if (!rows || !columns) return null;

  const modality = dataSet.string('x00080060')?.trim() || null;
  const bitsAllocated = dataSet.uint16('x00280100') ?? 16;
  const pixelRepresentation = dataSet.uint16('x00280103') ?? 0; // 0 unsigned, 1 signed
  const rescaleSlope = num(dataSet, 'x00281053', 1);
  const rescaleIntercept = num(dataSet, 'x00281052', 0);

  const count = rows * columns;
  const raw = readRawPixels(
    buffer,
    pixelElement.dataOffset,
    count,
    bitsAllocated,
    pixelRepresentation,
  );

  // Apply the modality LUT now so the volume is in real units (e.g. Hounsfield).
  const pixels = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pixels[i] = raw[i] * rescaleSlope + rescaleIntercept;
  }

  const pixelSpacing = readPair(dataSet, 'x00280030', [1, 1]);
  const position = readTriple(dataSet, 'x00200032');
  const orientation = readFloats(dataSet, 'x00200037', 6);

  const windowCenter = readFirstFloat(dataSet, 'x00281050');
  const windowWidth = readFirstFloat(dataSet, 'x00281051');

  return {
    name,
    rows,
    columns,
    pixelSpacing,
    position,
    orientation,
    instanceNumber: num(dataSet, 'x00200013', 0),
    modality,
    rescaleSlope,
    rescaleIntercept,
    windowCenter,
    windowWidth,
    pixels,
  };
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
