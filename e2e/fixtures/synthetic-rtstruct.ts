// A tiny synthetic DICOM RT Structure Set for the browser smoke tests: a couple
// of ROIs whose contours are axial circles stacked through the CT, referencing
// the CT's Frame of Reference so the loader associates them. No real data.
// (Mirrors the minimal Explicit-VR-LE writer in src/dicom/structure-set.spec.ts.)

import { SYNTHETIC_FRAME_OF_REFERENCE, type SyntheticFile } from './synthetic-dicom';

const RTSTRUCT_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.3';
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
const numbers = (v: readonly number[]): Uint8Array => text(v.join('\\'));

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

/** Wrap item data sets into an SQ element with explicit (defined) lengths. */
function sequence(group: number, el: number, items: Uint8Array[]): Uint8Array {
  const body = concat(
    items.map((item) => {
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

function dicomFile(dataSetBody: Uint8Array): ArrayBuffer {
  const metaBody = concat([
    element(0x0002, 0x0002, 'UI', uid(RTSTRUCT_SOP_CLASS)), // MediaStorageSOPClassUID
    element(0x0002, 0x0010, 'UI', uid(EXPLICIT_VR_LE)), // TransferSyntaxUID
  ]);
  const groupLength = element(0x0002, 0x0000, 'UL', u32le(metaBody.length));
  const file = concat([new Uint8Array(128), ascii('DICM'), groupLength, metaBody, dataSetBody]);
  return file.buffer;
}

/** A closed axial circle (CLOSED_PLANAR) at height `z`, as a Contour Sequence item. */
function circleContour(cx: number, cy: number, r: number, z: number, n = 24): Uint8Array {
  const points: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    points.push(cx + r * Math.cos(a), cy + r * Math.sin(a), z);
  }
  return concat([
    element(0x3006, 0x0042, 'CS', text('CLOSED_PLANAR')), // Contour Geometric Type
    element(0x3006, 0x0046, 'IS', numbers([n])), // Number of Contour Points
    element(0x3006, 0x0050, 'DS', numbers(points)), // Contour Data (x\y\z…)
  ]);
}

interface RoiSpec {
  readonly number: number;
  readonly name: string;
  readonly type: string;
  readonly color: readonly [number, number, number];
  readonly contours: Uint8Array[];
}

/**
 * An RTSTRUCT annotating the synthetic CT: two ROIs of stacked axial circles,
 * with deliberately long names to exercise the structure-list layout. Circles
 * span z ∈ [2, count-3] within the 32×32 CT volume.
 */
export function syntheticRtStruct(count = 12): SyntheticFile {
  const zs: number[] = [];
  for (let z = 2; z <= count - 3; z++) zs.push(z);

  const rois: RoiSpec[] = [
    {
      number: 1,
      name: 'Gross Tumour Volume (GTV-1)',
      type: 'GTV',
      color: [255, 80, 80],
      contours: zs.map((z) => circleContour(16, 16, 8, z)),
    },
    {
      number: 2,
      name: 'Planning Target Volume PTV-70',
      type: 'PTV',
      color: [80, 200, 120],
      contours: zs.map((z) => circleContour(13, 18, 4, z)),
    },
  ];

  const body = concat([
    element(0x0008, 0x0016, 'UI', uid(RTSTRUCT_SOP_CLASS)), // SOPClassUID
    element(0x0008, 0x0060, 'CS', text('RTSTRUCT')), // Modality
    element(0x3006, 0x0002, 'SH', text('Smoke Plan')), // Structure Set Label
    // Structure Set ROI Sequence: number, referenced frame of reference, name.
    sequence(
      0x3006,
      0x0020,
      rois.map((roi) =>
        concat([
          element(0x3006, 0x0022, 'IS', numbers([roi.number])),
          element(0x3006, 0x0024, 'UI', uid(SYNTHETIC_FRAME_OF_REFERENCE)),
          element(0x3006, 0x0026, 'LO', text(roi.name)),
        ]),
      ),
    ),
    // ROI Contour Sequence: display colour, contours, referenced ROI number.
    sequence(
      0x3006,
      0x0039,
      rois.map((roi) =>
        concat([
          element(0x3006, 0x002a, 'IS', numbers(roi.color)),
          sequence(0x3006, 0x0040, roi.contours),
          element(0x3006, 0x0084, 'IS', numbers([roi.number])),
        ]),
      ),
    ),
    // RT ROI Observations Sequence: referenced ROI number, interpreted type.
    sequence(
      0x3006,
      0x0080,
      rois.map((roi) =>
        concat([
          element(0x3006, 0x0082, 'IS', numbers([roi.number])),
          element(0x3006, 0x00a4, 'CS', text(roi.type)),
        ]),
      ),
    ),
  ]);

  return {
    name: 'smoke-rtstruct.dcm',
    mimeType: 'application/dicom',
    buffer: Buffer.from(dicomFile(body)),
  };
}
