import * as dicomParser from 'dicom-parser';
import { tagName } from './tag-dictionary';

/**
 * A curated DICOM field for the info panel: a human label and a formatted value.
 * Only fields actually present in the file are emitted, so the panel never shows
 * empty rows.
 */
export interface CuratedField {
  readonly label: string;
  readonly value: string;
}

/** A titled group of curated fields (Patient, Study, Series, Acquisition). */
export interface CuratedGroup {
  readonly title: string;
  readonly fields: readonly CuratedField[];
}

/**
 * One raw element of the first image, for the searchable tag inspector:
 * `(gggg,eeee)`, its value representation (when the file is explicit-VR), and a
 * display value formatted per VR with long/binary values truncated.
 */
export interface RawTag {
  /** Tag in `(gggg,eeee)` form, e.g. `(0010,0010)`. */
  readonly tag: string;
  /** Human-readable tag name from the data dictionary, or null when unknown. */
  readonly name: string | null;
  /** Value Representation, or null for implicit-VR files that carry none. */
  readonly vr: string | null;
  /** Display value, already formatted and truncated. */
  readonly value: string;
}

/** Captured DICOM metadata for one series: curated highlights plus raw tags. */
export interface DicomMetadata {
  readonly curated: readonly CuratedGroup[];
  readonly rawTags: readonly RawTag[];
}

/** Longest display value kept verbatim; longer ones are truncated with an ellipsis. */
const MAX_VALUE_LENGTH = 80;

/** VRs holding opaque binary data we summarise by byte length rather than print. */
const BINARY_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'UN']);

/** Fixed-width numeric VRs: byte size per value and the accessor that reads one. */
const NUMERIC_VRS: Readonly<
  Record<string, { readonly size: number; readonly read: keyof dicomParser.DataSet }>
> = {
  US: { size: 2, read: 'uint16' },
  SS: { size: 2, read: 'int16' },
  UL: { size: 4, read: 'uint32' },
  SL: { size: 4, read: 'int32' },
  FL: { size: 4, read: 'float' },
  FD: { size: 8, read: 'double' },
};

/**
 * Extract the info-panel metadata for a parsed file: a curated set of
 * study/series/patient highlights plus the full, formatted raw-tag list of the
 * first image. Pure over the {@link dicomParser.DataSet}; the loader runs it once
 * per file and carries the result on the series' first slice.
 */
export function extractMetadata(dataSet: dicomParser.DataSet): DicomMetadata {
  return { curated: curatedGroups(dataSet), rawTags: rawTags(dataSet) };
}

/** A curated field's value, read and formatted from the data set, or null if absent. */
type FieldReader = (dataSet: dicomParser.DataSet) => string | null;

/** The curated field table, grouped and in display order. */
const CURATED: ReadonlyArray<{
  readonly title: string;
  readonly fields: ReadonlyArray<{ readonly label: string; readonly read: FieldReader }>;
}> = [
  {
    title: 'Patient',
    fields: [
      { label: 'Name', read: (ds) => personName(ds, 'x00100010') },
      { label: 'ID', read: (ds) => tagText(ds, 'x00100020') },
      { label: 'Birth date', read: (ds) => date(ds, 'x00100030') },
      { label: 'Sex', read: (ds) => tagText(ds, 'x00100040') },
    ],
  },
  {
    title: 'Study',
    fields: [
      { label: 'Date', read: (ds) => date(ds, 'x00080020') },
      { label: 'Description', read: (ds) => tagText(ds, 'x00081030') },
      { label: 'Accession', read: (ds) => tagText(ds, 'x00080050') },
    ],
  },
  {
    title: 'Series',
    fields: [
      { label: 'Number', read: (ds) => tagText(ds, 'x00200011') },
      { label: 'Description', read: (ds) => tagText(ds, 'x0008103e') },
      { label: 'Modality', read: (ds) => tagText(ds, 'x00080060') },
      { label: 'Body part', read: (ds) => tagText(ds, 'x00180015') },
    ],
  },
  {
    title: 'Acquisition',
    fields: [
      { label: 'KVP', read: (ds) => withUnit(tagText(ds, 'x00180060'), 'kV') },
      { label: 'Tube current', read: (ds) => withUnit(tagText(ds, 'x00181151'), 'mA') },
      { label: 'Slice thickness', read: (ds) => withUnit(tagText(ds, 'x00180050'), 'mm') },
      { label: 'Pixel spacing', read: (ds) => pixelSpacing(ds) },
      { label: 'Dimensions', read: (ds) => dimensions(ds) },
      { label: 'Manufacturer', read: (ds) => tagText(ds, 'x00080070') },
      { label: 'Model', read: (ds) => tagText(ds, 'x00081090') },
    ],
  },
];

/** Build the curated groups, dropping fields and groups with nothing present. */
function curatedGroups(dataSet: dicomParser.DataSet): CuratedGroup[] {
  const groups: CuratedGroup[] = [];
  for (const group of CURATED) {
    const fields: CuratedField[] = [];
    for (const field of group.fields) {
      const value = field.read(dataSet);
      if (value !== null) fields.push({ label: field.label, value });
    }
    if (fields.length > 0) groups.push({ title: group.title, fields });
  }
  return groups;
}

/** The first image's elements as formatted raw tags, ordered by tag. */
function rawTags(dataSet: dicomParser.DataSet): RawTag[] {
  const tags: RawTag[] = [];
  for (const key of Object.keys(dataSet.elements).sort()) {
    const element = dataSet.elements[key];
    tags.push({
      tag: formatTagId(element.tag),
      name: tagName(element.tag),
      vr: element.vr ?? null,
      value: formatRawValue(dataSet, element),
    });
  }
  return tags;
}

/** Format a `xggggeeee` tag key as `(gggg,eeee)`. */
export function formatTagId(tag: string): string {
  const hex = tag.startsWith('x') ? tag.slice(1) : tag;
  return `(${hex.slice(0, 4)},${hex.slice(4, 8)})`;
}

/**
 * Format one element's value for the raw inspector. Sequences and bulk/binary
 * data are summarised rather than printed; string VRs are formatted per VR
 * (dates, times, names); numeric VRs are read and joined; everything is
 * truncated to {@link MAX_VALUE_LENGTH}.
 */
export function formatRawValue(dataSet: dicomParser.DataSet, element: dicomParser.Element): string {
  if (element.items) return `<sequence: ${element.items.length} item(s)>`;
  if (element.tag === 'x7fe00010' || element.encapsulatedPixelData) {
    return `<pixel data: ${element.length} bytes>`;
  }
  if (element.length === 0) return '';

  const vr = element.vr;
  if (vr && BINARY_VRS.has(vr)) return `<binary: ${element.length} bytes>`;

  const numeric = vr ? NUMERIC_VRS[vr] : undefined;
  if (numeric) return truncate(numericValues(dataSet, element, numeric));

  const raw = dataSet.string(element.tag);
  if (raw === undefined || !isPrintable(raw)) return `<binary: ${element.length} bytes>`;
  return truncate(formatStringValue(vr, raw));
}

/** Read a fixed-width numeric element's values and join them like DICOM does. */
function numericValues(
  dataSet: dicomParser.DataSet,
  element: dicomParser.Element,
  numeric: { readonly size: number; readonly read: keyof dicomParser.DataSet },
): string {
  const read = dataSet[numeric.read] as (tag: string, index?: number) => number | undefined;
  const count = Math.floor(element.length / numeric.size);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = read.call(dataSet, element.tag, i);
    if (value === undefined) break;
    values.push(value);
  }
  return values.join('\\');
}

/** Apply VR-specific formatting to a string value (dates, times, names). */
function formatStringValue(vr: string | undefined, raw: string): string {
  switch (vr) {
    case 'DA':
      return formatDicomDate(raw);
    case 'TM':
      return formatDicomTime(raw);
    case 'PN':
      return formatPersonName(raw);
    default:
      return raw.trim();
  }
}

/** Format a DICOM DA date (`YYYYMMDD`) as `YYYY-MM-DD`; pass anything else through. */
export function formatDicomDate(value: string): string {
  const v = value.trim();
  if (!/^\d{8}$/.test(v)) return v;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

/**
 * Format a DICOM TM time (`HHMMSS.FFFFFF`, components optional) as `HH:MM:SS`,
 * dropping fractional seconds; pass an unrecognised value through unchanged.
 */
export function formatDicomTime(value: string): string {
  const v = value.trim();
  const match = /^(\d{2})(\d{2})?(\d{2})?/.exec(v);
  if (!match) return v;
  return [match[1], match[2], match[3]].filter(Boolean).join(':');
}

/**
 * Format a DICOM PN person name (`Family^Given^Middle^Prefix^Suffix`) as
 * `Family, Given Middle`, dropping empty components; pass a name with no caret
 * through trimmed.
 */
export function formatPersonName(value: string): string {
  const [family, given, middle] = value.split('^').map((part) => part.trim());
  const rest = [given, middle].filter(Boolean).join(' ');
  if (!family) return rest;
  return rest ? `${family}, ${rest}` : family;
}

/** Read a string tag, trimmed; null when absent or empty. */
function tagText(dataSet: dicomParser.DataSet, tag: string): string | null {
  const value = dataSet.string(tag)?.trim();
  return value ? value : null;
}

/** Read and format a DA date tag; null when absent. */
function date(dataSet: dicomParser.DataSet, tag: string): string | null {
  const value = tagText(dataSet, tag);
  return value === null ? null : formatDicomDate(value);
}

/** Read and format a PN name tag; null when absent. */
function personName(dataSet: dicomParser.DataSet, tag: string): string | null {
  const value = tagText(dataSet, tag);
  return value === null ? null : formatPersonName(value);
}

/** Append a unit to a present value, or pass through null. */
function withUnit(value: string | null, unit: string): string | null {
  return value === null ? null : `${value} ${unit}`;
}

/** PixelSpacing (0028,0030) as `row × col mm`; null when absent. */
function pixelSpacing(dataSet: dicomParser.DataSet): string | null {
  const row = dataSet.floatString('x00280030', 0);
  const col = dataSet.floatString('x00280030', 1);
  if (row === undefined || col === undefined) return null;
  return `${row} × ${col} mm`;
}

/** Rows × Columns (0028,0010 / 0028,0011) as `cols × rows px`; null when absent. */
function dimensions(dataSet: dicomParser.DataSet): string | null {
  const rows = dataSet.uint16('x00280010');
  const cols = dataSet.uint16('x00280011');
  if (rows === undefined || cols === undefined) return null;
  return `${cols} × ${rows} px`;
}

/** Truncate a display value to {@link MAX_VALUE_LENGTH}, marking the cut with an ellipsis. */
function truncate(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
}

/** Whether a string is safe to print: no control characters beyond whitespace. */
function isPrintable(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    if (!isWhitespace && (code < 0x20 || code === 0x7f)) return false;
  }
  return true;
}
