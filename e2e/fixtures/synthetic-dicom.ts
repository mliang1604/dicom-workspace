// A tiny synthetic DICOM series generator for the browser smoke test — enough
// for the loader to build a renderable volume, with a horizontal intensity ramp
// so the rendered panes are visibly non-uniform (never a black square). No real
// patient data; every byte is fabricated. (Mirrors the minimal Explicit-VR-LE
// writer in src/dicom/loader.spec.ts.)

const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';
const LONG_VRS = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

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

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function padEven(bytes: Uint8Array, padByte: number): Uint8Array {
  return bytes.length % 2 === 0 ? bytes : concat([bytes, Uint8Array.of(padByte)]);
}

const text = (s: string): Uint8Array => padEven(ascii(s), 0x20);
const uid = (s: string): Uint8Array => padEven(ascii(s), 0x00);
const numbers = (values: readonly number[]): Uint8Array => text(values.join('\\'));

function u16le(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/** Encode one Explicit-VR-LE data element. */
function element(group: number, el: number, vr: string, value: Uint8Array): Uint8Array {
  const header = new Uint8Array(LONG_VRS.has(vr) ? 12 : 8);
  const view = new DataView(header.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, el, true);
  header[4] = vr.charCodeAt(0);
  header[5] = vr.charCodeAt(1);
  if (LONG_VRS.has(vr)) view.setUint32(8, value.length, true);
  else view.setUint16(6, value.length, true);
  return concat([header, value]);
}

/** 16-bit unsigned PixelData element from raw samples. */
function pixelData(samples: Uint16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setUint16(i * 2, s, true));
  return element(0x7fe0, 0x0010, 'OW', out);
}

/** Assemble a full P10 file (preamble + DICM + meta group + data set). */
function dicomFile(dataSetBody: Uint8Array): ArrayBuffer {
  const metaBody = element(0x0002, 0x0010, 'UI', uid(EXPLICIT_VR_LE)); // TransferSyntaxUID
  const groupLength = element(0x0002, 0x0000, 'UL', u32le(metaBody.length));
  const file = concat([new Uint8Array(128), ascii('DICM'), groupLength, metaBody, dataSetBody]);
  return file.buffer;
}

/** One slice: a horizontal ramp (0..2000) plus a per-slice offset for depth contrast. */
function sliceSamples(rows: number, columns: number, z: number): Uint16Array {
  const out = new Uint16Array(rows * columns);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const ramp = Math.round((2000 * x) / Math.max(1, columns - 1));
      out[y * columns + x] = Math.min(4000, ramp + z * 40);
    }
  }
  return out;
}

export interface SyntheticFile {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

/** Frame of Reference UID shared by the CT and any RTSTRUCT that annotates it. */
export const SYNTHETIC_FRAME_OF_REFERENCE = '1.2.826.0.1.3680043.2.smoke.for.1';

/**
 * Build a single-series CT stack of `count` axial slices (`size`×`size`) as
 * in-memory DICOM files suitable for Playwright's `setInputFiles`.
 */
export function syntheticCtSeries(count = 12, size = 32): SyntheticFile[] {
  const seriesUid = '1.2.826.0.1.3680043.2.smoke.1';
  const files: SyntheticFile[] = [];
  for (let z = 0; z < count; z++) {
    const body = concat([
      element(0x0008, 0x0060, 'CS', text('CT')), // Modality
      element(0x0020, 0x000e, 'UI', uid(seriesUid)), // SeriesInstanceUID
      element(0x0020, 0x0011, 'IS', numbers([1])), // SeriesNumber
      element(0x0020, 0x0013, 'IS', numbers([z + 1])), // InstanceNumber
      element(0x0020, 0x0032, 'DS', numbers([0, 0, z])), // ImagePositionPatient
      element(0x0020, 0x0037, 'DS', numbers([1, 0, 0, 0, 1, 0])), // ImageOrientationPatient
      element(0x0020, 0x0052, 'UI', uid(SYNTHETIC_FRAME_OF_REFERENCE)), // FrameOfReferenceUID
      element(0x0028, 0x0002, 'US', u16le(1)), // SamplesPerPixel
      element(0x0028, 0x0010, 'US', u16le(size)), // Rows
      element(0x0028, 0x0011, 'US', u16le(size)), // Columns
      element(0x0028, 0x0030, 'DS', numbers([1, 1])), // PixelSpacing
      element(0x0028, 0x0100, 'US', u16le(16)), // BitsAllocated
      element(0x0028, 0x0101, 'US', u16le(16)), // BitsStored
      element(0x0028, 0x0102, 'US', u16le(15)), // HighBit
      element(0x0028, 0x0103, 'US', u16le(0)), // PixelRepresentation
      element(0x0028, 0x1050, 'DS', numbers([1000])), // WindowCenter
      element(0x0028, 0x1051, 'DS', numbers([2000])), // WindowWidth
      pixelData(sliceSamples(size, size, z)),
    ]);
    files.push({
      name: `smoke-${String(z + 1).padStart(3, '0')}.dcm`,
      mimeType: 'application/dicom',
      buffer: Buffer.from(dicomFile(body)),
    });
  }
  return files;
}
