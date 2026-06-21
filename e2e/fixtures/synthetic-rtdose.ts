// A tiny synthetic RTDOSE for the browser smoke tests: a small multi-frame dose
// grid in the CT's Frame of Reference, so the loader promotes it to a fusion
// overlay (a jet colour wash). Mirrors the minimal Explicit-VR-LE writer in
// src/dicom/loader.spec.ts. No real data.

import { SYNTHETIC_FRAME_OF_REFERENCE, type SyntheticFile } from './synthetic-dicom';

const RTDOSE_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.2';
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

function padEven(bytes: Uint8Array, pad: number): Uint8Array {
  return bytes.length % 2 === 0 ? bytes : concat([bytes, Uint8Array.of(pad)]);
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

/** Raw 16-bit unsigned PixelData for the given frames of `count` samples each. */
function pixelData(frames: readonly number[][]): Uint8Array {
  const samples = frames.flat();
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setUint16(i * 2, s, true));
  return element(0x7fe0, 0x0010, 'OW', out);
}

function dicomFile(dataSetBody: Uint8Array): ArrayBuffer {
  const metaBody = element(0x0002, 0x0010, 'UI', uid(EXPLICIT_VR_LE));
  const groupLength = element(0x0002, 0x0000, 'UL', u32le(metaBody.length));
  const file = concat([new Uint8Array(128), ascii('DICM'), groupLength, metaBody, dataSetBody]);
  return file.buffer as ArrayBuffer;
}

/**
 * A `frames`-deep, `size × size` RTDOSE in the CT's frame of reference, placed
 * inside the CT extent. A diagonal ramp per frame gives the wash some range.
 */
export function syntheticRtDose(frames = 6, size = 12): SyntheticFile {
  const offsets = Array.from({ length: frames }, (_, f) => f); // 1 mm apart
  const planes = offsets.map((_, f) =>
    Array.from({ length: size * size }, (_, i) => ((i % size) + Math.floor(i / size) + f) * 4),
  );
  const body = concat([
    element(0x0008, 0x0060, 'CS', text('RTDOSE')), // Modality
    element(0x0008, 0x0016, 'UI', uid(RTDOSE_SOP_CLASS)), // SOPClassUID
    element(0x0020, 0x000e, 'UI', uid('1.2.826.0.1.3680043.2.smoke.dose.1')), // SeriesInstanceUID
    element(0x0020, 0x0052, 'UI', uid(SYNTHETIC_FRAME_OF_REFERENCE)), // FrameOfReferenceUID
    element(0x0020, 0x0032, 'DS', numbers([4, 4, 0])), // ImagePositionPatient (inside the CT)
    element(0x0020, 0x0037, 'DS', numbers([1, 0, 0, 0, 1, 0])), // ImageOrientationPatient
    element(0x0028, 0x0002, 'US', u16le(1)), // SamplesPerPixel
    element(0x0028, 0x0008, 'IS', numbers([frames])), // NumberOfFrames
    element(0x0028, 0x0010, 'US', u16le(size)), // Rows
    element(0x0028, 0x0011, 'US', u16le(size)), // Columns
    element(0x0028, 0x0030, 'DS', numbers([2, 2])), // PixelSpacing
    element(0x0028, 0x0100, 'US', u16le(16)), // BitsAllocated
    element(0x0028, 0x0101, 'US', u16le(16)), // BitsStored
    element(0x0028, 0x0103, 'US', u16le(0)), // PixelRepresentation (unsigned)
    element(0x3004, 0x0002, 'CS', text('GY')), // DoseUnits
    element(0x3004, 0x000c, 'DS', numbers(offsets)), // GridFrameOffsetVector
    element(0x3004, 0x000e, 'DS', numbers([0.1])), // DoseGridScaling
    pixelData(planes),
  ]);
  return {
    name: 'smoke-dose.dcm',
    mimeType: 'application/dicom',
    buffer: Buffer.from(dicomFile(body)),
  };
}
