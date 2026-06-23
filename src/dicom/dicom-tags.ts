import * as dicomParser from 'dicom-parser';
import { buildPaletteLut, type PaletteLut } from './photometric';

/**
 * Typed readers over a parsed {@link dicomParser.DataSet}: numbers, vectors, the
 * pixel-padding and palette-LUT elements, and the multiframe functional-group
 * lookup. Pure helpers shared by the parse paths in {@link import('./loader')}.
 */

/** Read a DICOM tag of value-representation DS/IS as a number, with a default. */
export function num(dataSet: dicomParser.DataSet, tag: string, fallback: number): number {
  const v = dataSet.floatString(tag);
  return v === undefined || Number.isNaN(v) ? fallback : v;
}

/** Read a DICOM IS tag as an integer, or null when absent/unparseable. */
export function intOrNull(dataSet: dicomParser.DataSet, tag: string): number | null {
  const v = dataSet.intString(tag);
  return v === undefined || Number.isNaN(v) ? null : v;
}

export function readFloats(dataSet: dicomParser.DataSet, tag: string, n: number): number[] | null {
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

export function readPair(
  dataSet: dicomParser.DataSet,
  tag: string,
  fallback: [number, number],
): [number, number] {
  const f = readFloats(dataSet, tag, 2);
  return f ? [f[0], f[1]] : fallback;
}

export function readTriple(
  dataSet: dicomParser.DataSet,
  tag: string,
): [number, number, number] | null {
  const f = readFloats(dataSet, tag, 3);
  return f ? [f[0], f[1], f[2]] : null;
}

export function readFirstFloat(dataSet: dicomParser.DataSet, tag: string): number | null {
  const el = dataSet.elements[tag];
  if (!el || el.length === 0) return null;
  const v = dataSet.floatString(tag, 0);
  return v === undefined || Number.isNaN(v) ? null : v;
}

/**
 * PixelPaddingValue (0028,0120), read in the pixel's representation (US or SS),
 * or null when absent — the stored value marking out-of-FOV background pixels.
 */
export function readPadding(
  dataSet: dicomParser.DataSet,
  pixelRepresentation: number,
): number | null {
  const el = dataSet.elements['x00280120'];
  if (!el || el.length === 0) return null;
  const v = pixelRepresentation === 1 ? dataSet.int16('x00280120') : dataSet.uint16('x00280120');
  return v === undefined ? null : v;
}

/** Assemble the R/G/B Palette Color LUTs of a PALETTE COLOR image, or null. */
export function readPalette(dataSet: dicomParser.DataSet): PaletteLut | null {
  const descriptor = readPaletteDescriptor(dataSet, 'x00281101');
  if (!descriptor) return null;
  const r = readLutData(dataSet, 'x00281201');
  const g = readLutData(dataSet, 'x00281202');
  const b = readLutData(dataSet, 'x00281203');
  if (!r || !g || !b) return null;
  return buildPaletteLut(descriptor, r, g, b);
}

/** Palette Color LUT Descriptor: [numberOfEntries, firstValueMapped, bitsPerEntry]. */
function readPaletteDescriptor(
  dataSet: dicomParser.DataSet,
  tag: string,
): [number, number, number] | null {
  const el = dataSet.elements[tag];
  if (!el || el.length < 6) return null;
  const entries = dataSet.uint16(tag, 0);
  const first = dataSet.uint16(tag, 1);
  const bits = dataSet.uint16(tag, 2);
  if (entries === undefined || first === undefined || bits === undefined) return null;
  return [entries, first, bits];
}

/** Read a Palette Color LUT Data element (0028,120x) as little-endian 16-bit words. */
function readLutData(dataSet: dicomParser.DataSet, tag: string): Uint16Array | null {
  const el = dataSet.elements[tag];
  if (!el || el.length === 0) return null;
  const n = el.length >> 1;
  const bytes = dataSet.byteArray;
  const view = new DataView(bytes.buffer, bytes.byteOffset + el.dataOffset, n * 2);
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

/** The three places a multiframe value may live, in lookup priority order. */
export interface FunctionalGroups {
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
export function readGroupValue<T>(
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
export function firstItem(
  dataSet: dicomParser.DataSet | null,
  seqTag: string,
): dicomParser.DataSet | null {
  return dataSet?.elements[seqTag]?.items?.[0]?.dataSet ?? null;
}
