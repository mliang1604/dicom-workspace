import type { Contour, Roi, StructureSet } from './types';

/**
 * Serialize a {@link StructureSet} into a DICOM RT Structure Set Storage file
 * (Explicit VR Little Endian, Part-10) — the export edge that lets authored
 * structures leave the app as a portable, interoperable object.
 *
 * `dicom-parser` is read-only, so this is a small, self-contained writer: just
 * the Explicit-VR-LE element/sequence encoding the three RTSTRUCT sequences
 * {@link import('./structure-set').parseStructureSet} reads back —
 *   - Structure Set ROI Sequence (3006,0020): identity (number, name, frame),
 *   - ROI Contour Sequence (3006,0039): colour + the Contour Sequence
 *     (3006,0040) of `CLOSED_PLANAR` Contour Data (3006,0050), and
 *   - RT ROI Observations Sequence (3006,0080): interpreted type,
 * plus the Referenced Frame of Reference Sequence (3006,0010) tying it to the
 * active image series so it re-associates on import. The output round-trips:
 * `parseStructureSet(writeStructureSet(ss))` recovers the same ROIs and points.
 *
 * Contour points are written in patient coordinates (LPS, mm) exactly as the
 * parser models them — the {@link import('./structure-export').buildStructureSet}
 * step has already mapped voxels to patient space.
 */
export function writeStructureSet(ss: StructureSet, opts: WriteOptions = {}): ArrayBuffer {
  const sopInstanceUid = opts.sopInstanceUid ?? generateUid();
  const dataSet = concat([
    element(0x0008, 0x0016, 'UI', uid(RTSTRUCT_SOP_CLASS)), // SOPClassUID
    element(0x0008, 0x0018, 'UI', uid(sopInstanceUid)), // SOPInstanceUID
    element(0x0008, 0x0060, 'CS', text('RTSTRUCT')), // Modality
    ...(ss.label ? [element(0x3006, 0x0002, 'SH', text(ss.label))] : []), // Structure Set Label
    ...referencedFrameOfReference(ss),
    structureSetRoiSequence(ss.rois, ss.frameOfReferenceUid),
    roiContourSequence(ss.rois),
    rtRoiObservationsSequence(ss.rois),
  ]);
  return p10File(dataSet, sopInstanceUid);
}

/** Options for {@link writeStructureSet}. */
export interface WriteOptions {
  /** SOP Instance UID for the new object; a fresh UID is generated when omitted. */
  readonly sopInstanceUid?: string;
}

/** SOP Class UID identifying an RT Structure Set Storage object. */
const RTSTRUCT_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.3';
/** Explicit VR Little Endian — the transfer syntax this writer emits. */
const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';

// --- RTSTRUCT sequence assembly --------------------------------------------

/**
 * Referenced Frame of Reference Sequence (3006,0010): the frame of reference
 * and the image series this structure set annotates, so it re-associates on
 * import. Omitted entirely when the structure set carries neither — there is
 * nothing to reference.
 */
function referencedFrameOfReference(ss: StructureSet): Uint8Array[] {
  if (!ss.frameOfReferenceUid && ss.referencedSeriesUids.length === 0) return [];
  const seriesItems = ss.referencedSeriesUids.map((s) => element(0x0020, 0x000e, 'UI', uid(s))); // Series Instance UID
  const studyBody =
    seriesItems.length > 0
      ? [sequence(0x3006, 0x0014, seriesItems)] // RT Referenced Series Sequence — one item per series
      : [];
  const item = concat([
    ...(ss.frameOfReferenceUid
      ? [element(0x0020, 0x0052, 'UI', uid(ss.frameOfReferenceUid))] // Frame of Reference UID
      : []),
    ...(studyBody.length > 0 ? [sequence(0x3006, 0x0012, [concat(studyBody)])] : []), // RT Referenced Study Sequence
  ]);
  return [sequence(0x3006, 0x0010, [item])];
}

/** Structure Set ROI Sequence (3006,0020): one item per ROI's identity. */
function structureSetRoiSequence(
  rois: readonly Roi[],
  frameOfReferenceUid: string | null,
): Uint8Array {
  return sequence(
    0x3006,
    0x0020,
    rois.map((roi) =>
      concat([
        element(0x3006, 0x0022, 'IS', integers([roi.number])), // ROI Number
        // Referenced Frame of Reference UID — the parser's fallback when the
        // top-level 3006,0010 sequence is absent or frame-less.
        ...(frameOfReferenceUid ? [element(0x3006, 0x0024, 'UI', uid(frameOfReferenceUid))] : []),
        element(0x3006, 0x0026, 'LO', text(roi.name)), // ROI Name
      ]),
    ),
  );
}

/** ROI Contour Sequence (3006,0039): per ROI, its colour and contour stack. */
function roiContourSequence(rois: readonly Roi[]): Uint8Array {
  return sequence(
    0x3006,
    0x0039,
    rois.map((roi) =>
      concat([
        ...(roi.color
          ? [element(0x3006, 0x002a, 'IS', integers(roi.color))] // ROI Display Color
          : []),
        sequence(0x3006, 0x0040, roi.contours.map(contourItem)), // Contour Sequence
        element(0x3006, 0x0084, 'IS', integers([roi.number])), // Referenced ROI Number
      ]),
    ),
  );
}

/** One Contour Sequence item: geometric type, point count, flat x\y\z data. */
function contourItem(contour: Contour): Uint8Array {
  const flat = contour.points.flatMap((p) => [p[0], p[1], p[2]]);
  return concat([
    element(0x3006, 0x0042, 'CS', text(contour.geometricType)), // Contour Geometric Type
    element(0x3006, 0x0046, 'IS', integers([contour.points.length])), // Number of Contour Points
    element(0x3006, 0x0050, 'DS', decimals(flat)), // Contour Data
  ]);
}

/**
 * RT ROI Observations Sequence (3006,0080): per ROI, its interpreted type. One
 * item per ROI so every structure carries an observation; the interpreted type
 * element is omitted when unset (the parser reads it back as null).
 */
function rtRoiObservationsSequence(rois: readonly Roi[]): Uint8Array {
  return sequence(
    0x3006,
    0x0080,
    rois.map((roi, i) =>
      concat([
        element(0x3006, 0x0082, 'IS', integers([i + 1])), // Observation Number (parser's join key)
        element(0x3006, 0x0084, 'IS', integers([roi.number])), // Referenced ROI Number (standard join key)
        ...(roi.interpretedType
          ? [element(0x3006, 0x00a4, 'CS', text(roi.interpretedType))] // RT ROI Interpreted Type
          : []),
      ]),
    ),
  );
}

// --- Explicit-VR-LE Part-10 encoding ---------------------------------------

/** VRs that use the 2-reserved-byte + 4-byte-length header form. */
const LONG_VRS = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

/** Assemble a full P10 file: preamble + DICM + file meta group + data set. */
function p10File(dataSet: Uint8Array, sopInstanceUid: string): ArrayBuffer {
  const metaBody = concat([
    element(0x0002, 0x0002, 'UI', uid(RTSTRUCT_SOP_CLASS)), // MediaStorageSOPClassUID
    element(0x0002, 0x0003, 'UI', uid(sopInstanceUid)), // MediaStorageSOPInstanceUID
    element(0x0002, 0x0010, 'UI', uid(EXPLICIT_VR_LE)), // TransferSyntaxUID
  ]);
  const groupLength = element(0x0002, 0x0000, 'UL', u32le(metaBody.length));
  const file = concat([
    new Uint8Array(128), // preamble
    ascii('DICM'),
    groupLength,
    metaBody,
    dataSet,
  ]);
  return file.buffer.slice(0, file.length) as ArrayBuffer;
}

/** Encode one Explicit-VR-LE data element. */
function element(group: number, el: number, vr: string, value: Uint8Array): Uint8Array {
  const header = new Uint8Array(LONG_VRS.has(vr) ? 12 : 8);
  const view = new DataView(header.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, el, true);
  header[4] = vr.charCodeAt(0);
  header[5] = vr.charCodeAt(1);
  if (LONG_VRS.has(vr)) {
    view.setUint32(8, value.length, true); // bytes 6-7 reserved, left zero
  } else {
    view.setUint16(6, value.length, true);
  }
  return concat([header, value]);
}

/** Wrap item data sets into an SQ element with explicit (defined) lengths. */
function sequence(group: number, el: number, itemBodies: Uint8Array[]): Uint8Array {
  const body = concat(
    itemBodies.map((item) => {
      const header = new Uint8Array(8);
      const view = new DataView(header.buffer);
      view.setUint16(0, 0xfffe, true); // Item tag (FFFE,E000)
      view.setUint16(2, 0xe000, true);
      view.setUint32(4, item.length, true);
      return concat([header, item]);
    }),
  );
  return element(group, el, 'SQ', body);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Pad to even length (every DICOM value): text VRs with a space, UIDs with a null. */
function padEven(bytes: Uint8Array, padByte: number): Uint8Array {
  return bytes.length % 2 === 0 ? bytes : concat([bytes, Uint8Array.of(padByte)]);
}

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** A text value (SH/LO/CS/PN…), space-padded to even length. */
function text(s: string): Uint8Array {
  return padEven(ascii(s), 0x20);
}

/** A UID value, null-padded to even length. */
function uid(s: string): Uint8Array {
  return padEven(ascii(s), 0x00);
}

/** An Integer String (IS) value: backslash-separated integers, space-padded. */
function integers(values: readonly number[]): Uint8Array {
  return text(values.map((v) => String(Math.round(v))).join('\\'));
}

/** A Decimal String (DS) value: backslash-separated decimals, space-padded. */
function decimals(values: readonly number[]): Uint8Array {
  return text(values.map(formatDs).join('\\'));
}

/**
 * Format a number as a DICOM Decimal String (DS): plain decimal, no exponent,
 * at most 16 characters. Integers stay integral; fractions are written with
 * enough precision for sub-millimetre contour points and trailing zeros are
 * trimmed.
 */
function formatDs(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  let s = n.toFixed(6);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s.length <= 16) return s;
  // Very large magnitudes: fall back to fewer fractional digits to fit 16 chars.
  const intDigits = Math.trunc(Math.abs(n)).toString().length + (n < 0 ? 1 : 0);
  return n.toFixed(Math.max(0, 15 - intDigits));
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/**
 * Generate a fresh DICOM UID under the standard `2.25` (UUID-derived) root: a
 * run of random decimal digits, kept within the 64-character UID limit. Used for
 * the new object's SOP Instance UID when the caller supplies none.
 */
function generateUid(): string {
  let digits = '';
  while (digits.length < 30) digits += Math.floor(Math.random() * 1e9).toString();
  // No leading zero after the root, and stay under 64 chars.
  return `2.25.${digits.slice(0, 30).replace(/^0+/, '') || '0'}`;
}
