import type { Series } from './series';
import { parseStructureSet, structureSetsForSeries } from './structure-set';
import type { StructureSet } from './types';

// --- Minimal Explicit-VR-Little-Endian DICOM P10 writer --------------------
//
// Just enough to build a synthetic RTSTRUCT fixture (no PixelData, nested
// sequences). No real patient data; every byte here is fabricated. Mirrors the
// writer in loader.spec.ts.

const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';
const RTSTRUCT_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.3';

/** VRs that use the 2-reserved-byte + 4-byte-length header form. */
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

/** Pad to even length: text VRs with a trailing space, UIDs with a null. */
function padEven(bytes: Uint8Array, padByte: number): Uint8Array {
  if (bytes.length % 2 === 0) return bytes;
  return concat([bytes, Uint8Array.of(padByte)]);
}

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function text(s: string): Uint8Array {
  return padEven(ascii(s), 0x20);
}

function uid(s: string): Uint8Array {
  return padEven(ascii(s), 0x00);
}

/** Decimal/Integer string value(s), backslash-separated. */
function numbers(values: readonly number[]): Uint8Array {
  return text(values.join('\\'));
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

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/** Assemble a full P10 file (preamble + DICM + meta group + data set). */
function dicomFile(dataSetBody: Uint8Array, sopClass = RTSTRUCT_SOP_CLASS): ArrayBuffer {
  const metaBody = concat([
    element(0x0002, 0x0002, 'UI', uid(sopClass)), // MediaStorageSOPClassUID
    element(0x0002, 0x0010, 'UI', uid(EXPLICIT_VR_LE)), // TransferSyntaxUID
  ]);
  const groupLength = element(0x0002, 0x0000, 'UL', u32le(metaBody.length));

  const file = concat([
    new Uint8Array(128), // preamble
    ascii('DICM'),
    groupLength,
    metaBody,
    dataSetBody,
  ]);
  return file.buffer as ArrayBuffer;
}

// --- Fixtures ---------------------------------------------------------------

/** One Structure Set ROI Sequence item: number, name, frame of reference. */
function roiItem(number: number, name: string): Uint8Array {
  return concat([
    element(0x3006, 0x0022, 'IS', numbers([number])), // ROI Number
    element(0x3006, 0x0024, 'UI', uid('1.2.3.4')), // Referenced Frame of Reference UID
    element(0x3006, 0x0026, 'LO', text(name)), // ROI Name
  ]);
}

/** One Contour Sequence item: geometric type, point count, flat x\y\z data. */
function contourItem(geometricType: string, points: readonly number[][]): Uint8Array {
  return concat([
    element(0x3006, 0x0042, 'CS', text(geometricType)), // Contour Geometric Type
    element(0x3006, 0x0046, 'IS', numbers([points.length])), // Number of Contour Points
    element(0x3006, 0x0050, 'DS', numbers(points.flat())), // Contour Data
  ]);
}

/** One ROI Contour Sequence item: colour, referenced ROI, nested contours. */
function roiContourItem(
  refNumber: number,
  color: readonly number[],
  contours: Uint8Array[],
): Uint8Array {
  return concat([
    element(0x3006, 0x002a, 'IS', numbers(color)), // ROI Display Color
    sequence(0x3006, 0x0040, contours), // Contour Sequence
    element(0x3006, 0x0084, 'IS', numbers([refNumber])), // Referenced ROI Number
  ]);
}

/** One RT ROI Observations Sequence item: referenced ROI, interpreted type. */
function observationItem(refNumber: number, interpretedType: string): Uint8Array {
  return concat([
    element(0x3006, 0x0082, 'IS', numbers([refNumber])), // Referenced ROI Number
    element(0x3006, 0x00a4, 'CS', text(interpretedType)), // RT ROI Interpreted Type
  ]);
}

/**
 * A small RTSTRUCT with two ROIs: "Heart" (ORGAN, red, two contours) and "PTV"
 * (PTV, green, one contour). The sequences are deliberately ordered so the join
 * by ROI Number — not position — is what pairs them up.
 */
function structureSet(): ArrayBuffer {
  const body = concat([
    element(0x0008, 0x0016, 'UI', uid(RTSTRUCT_SOP_CLASS)), // SOPClassUID
    element(0x0008, 0x0060, 'CS', text('RTSTRUCT')), // Modality
    element(0x3006, 0x0002, 'SH', text('Plan A')), // Structure Set Label
    sequence(0x3006, 0x0020, [roiItem(1, 'Heart'), roiItem(2, 'PTV')]),
    // ROI Contour Sequence, ROIs in the opposite order to the ROI sequence.
    sequence(0x3006, 0x0039, [
      roiContourItem(
        2,
        [0, 255, 0],
        [
          contourItem('CLOSED_PLANAR', [
            [1, 2, 3],
            [4, 5, 6],
          ]),
        ],
      ),
      roiContourItem(
        1,
        [255, 0, 0],
        [
          contourItem('CLOSED_PLANAR', [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
          ]),
          contourItem('POINT', [[9, 9, 9]]),
        ],
      ),
    ]),
    sequence(0x3006, 0x0080, [observationItem(1, 'ORGAN'), observationItem(2, 'PTV')]),
  ]);
  return dicomFile(body);
}

/**
 * Referenced Frame of Reference Sequence (3006,0010): a frame of reference UID
 * and, nested through the study/series sequences, the referenced series UIDs.
 */
function referencedFrameOfReference(forUid: string, seriesUids: readonly string[]): Uint8Array {
  const seriesItems = seriesUids.map(
    (s) => element(0x0020, 0x000e, 'UI', uid(s)), // Series Instance UID
  );
  const studyItem = sequence(0x3006, 0x0014, seriesItems); // RT Referenced Series Sequence
  return sequence(0x3006, 0x0010, [
    concat([
      element(0x0020, 0x0052, 'UI', uid(forUid)), // Frame of Reference UID
      sequence(0x3006, 0x0012, [studyItem]), // RT Referenced Study Sequence
    ]),
  ]);
}

/** An RTSTRUCT whose frame of reference and referenced series come from 3006,0010. */
function structureSetWithReferences(forUid: string, seriesUids: readonly string[]): ArrayBuffer {
  const body = concat([
    element(0x0008, 0x0016, 'UI', uid(RTSTRUCT_SOP_CLASS)), // SOPClassUID
    referencedFrameOfReference(forUid, seriesUids),
    sequence(0x3006, 0x0020, [roiItem(1, 'Body')]),
  ]);
  return dicomFile(body);
}

/** A minimal series carrying just the fields association looks at. */
function series(overrides: Partial<Series> = {}): Series {
  return {
    uid: 'series-uid',
    seriesNumber: 1,
    description: null,
    modality: 'CT',
    studyUid: null,
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    patientId: null,
    patientName: null,
    frameOfReferenceUid: null,
    imageCount: 1,
    dims: [4, 4],
    metadata: null,
    slices: [],
    ...overrides,
  };
}

/** An RTSTRUCT recognised only by Modality (no SOP Class UID anywhere). */
function modalityOnlyStructureSet(): ArrayBuffer {
  const body = concat([
    element(0x0008, 0x0060, 'CS', text('RTSTRUCT')), // Modality
    sequence(0x3006, 0x0020, [roiItem(1, 'Body')]),
  ]);
  // Meta group declares a non-RTSTRUCT SOP class; only Modality identifies it.
  return dicomFile(body, '1.2.840.10008.5.1.4.1.1.7');
}

// --- Tests ------------------------------------------------------------------

describe('parseStructureSet', () => {
  it('parses ROIs with names, colours, interpreted types and contours', () => {
    const ss = parseStructureSet('rs.dcm', structureSet());
    expect(ss).not.toBeNull();
    expect(ss!.name).toBe('rs.dcm');
    expect(ss!.label).toBe('Plan A');
    expect(ss!.rois).toHaveLength(2);

    const [heart, ptv] = ss!.rois;
    expect(heart.number).toBe(1);
    expect(heart.name).toBe('Heart');
    expect(heart.color).toEqual([255, 0, 0]);
    expect(heart.interpretedType).toBe('ORGAN');

    expect(ptv.number).toBe(2);
    expect(ptv.name).toBe('PTV');
    expect(ptv.color).toEqual([0, 255, 0]);
    expect(ptv.interpretedType).toBe('PTV');
  });

  it('joins contour and observation sequences by ROI number, not position', () => {
    const ss = parseStructureSet('rs.dcm', structureSet())!;
    // Despite the ROI Contour Sequence listing ROI 2 first, the colour and
    // contours land on the right ROI.
    expect(ss.rois[0].color).toEqual([255, 0, 0]); // Heart (ROI 1)
    expect(ss.rois[1].color).toEqual([0, 255, 0]); // PTV (ROI 2)
  });

  it('reads contour geometry and flat x\\y\\z data into patient-space triplets', () => {
    const ss = parseStructureSet('rs.dcm', structureSet())!;
    const heart = ss.rois[0];
    expect(heart.contours).toHaveLength(2);

    expect(heart.contours[0].geometricType).toBe('CLOSED_PLANAR');
    expect(heart.contours[0].points).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
    ]);

    expect(heart.contours[1].geometricType).toBe('POINT');
    expect(heart.contours[1].points).toEqual([[9, 9, 9]]);

    expect(ss.rois[1].contours[0].points).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('recognises an RTSTRUCT by Modality when the SOP class is absent', () => {
    const ss = parseStructureSet('rs.dcm', modalityOnlyStructureSet());
    expect(ss).not.toBeNull();
    expect(ss!.rois.map((r) => r.name)).toEqual(['Body']);
    expect(ss!.label).toBeNull();
    expect(ss!.rois[0].color).toBeNull();
    expect(ss!.rois[0].interpretedType).toBeNull();
    expect(ss!.rois[0].contours).toEqual([]);
  });

  it('falls back to a ROI Referenced Frame of Reference UID when no reference sequence', () => {
    // The basic fixture carries 3006,0024 on each ROI but no 3006,0010 sequence.
    const ss = parseStructureSet('rs.dcm', structureSet())!;
    expect(ss.frameOfReferenceUid).toBe('1.2.3.4');
    expect(ss.referencedSeriesUids).toEqual([]);
  });

  it('reads the frame of reference and referenced series from the reference sequence', () => {
    const ss = parseStructureSet(
      'rs.dcm',
      structureSetWithReferences('1.2.840.FOR', ['1.2.840.SERIES.A', '1.2.840.SERIES.B']),
    )!;
    expect(ss.frameOfReferenceUid).toBe('1.2.840.FOR');
    expect(ss.referencedSeriesUids).toEqual(['1.2.840.SERIES.A', '1.2.840.SERIES.B']);
  });

  it('returns null for a non-RTSTRUCT DICOM file', () => {
    // A minimal CT-ish data set: parseable, but not a structure set.
    const body = concat([
      element(0x0008, 0x0060, 'CS', text('CT')), // Modality
      element(0x0028, 0x0010, 'US', Uint8Array.of(2, 0)), // Rows
    ]);
    expect(parseStructureSet('ct.dcm', dicomFile(body, '1.2.840.10008.5.1.4.1.1.2'))).toBeNull();
  });

  it('returns null for unparseable bytes', () => {
    expect(parseStructureSet('garbage.bin', new Uint8Array([1, 2, 3, 4]).buffer)).toBeNull();
  });
});

describe('structureSetsForSeries', () => {
  const ss = (overrides: Partial<StructureSet> = {}): StructureSet => ({
    name: 'rs.dcm',
    label: null,
    frameOfReferenceUid: null,
    referencedSeriesUids: [],
    rois: [],
    ...overrides,
  });

  it('associates by matching frame of reference UID', () => {
    const matching = ss({ frameOfReferenceUid: 'for-1' });
    const other = ss({ name: 'rs2.dcm', frameOfReferenceUid: 'for-2' });
    const s = series({ frameOfReferenceUid: 'for-1' });

    expect(structureSetsForSeries([matching, other], s)).toEqual([matching]);
  });

  it('does not associate when frames of reference differ', () => {
    const s = series({ frameOfReferenceUid: 'for-1' });
    expect(structureSetsForSeries([ss({ frameOfReferenceUid: 'for-2' })], s)).toEqual([]);
  });

  it('falls back to a referenced series UID when the frame of reference is absent', () => {
    const bySeries = ss({ referencedSeriesUids: ['series-uid'] });
    const s = series({ uid: 'series-uid', frameOfReferenceUid: null });
    expect(structureSetsForSeries([bySeries], s)).toEqual([bySeries]);
  });

  it('falls back to a referenced series UID when the frames of reference do not match', () => {
    const s = series({ uid: 'series-uid', frameOfReferenceUid: 'for-1' });
    const bySeries = ss({ frameOfReferenceUid: 'for-2', referencedSeriesUids: ['series-uid'] });
    expect(structureSetsForSeries([bySeries], s)).toEqual([bySeries]);
  });

  it('leaves a structure set with no usable reference unassociated', () => {
    const s = series({ uid: 'series-uid', frameOfReferenceUid: 'for-1' });
    expect(structureSetsForSeries([ss()], s)).toEqual([]);
  });

  it('does not match an empty series UID against an empty referenced UID', () => {
    const s = series({ uid: '', frameOfReferenceUid: null });
    expect(structureSetsForSeries([ss({ referencedSeriesUids: [] })], s)).toEqual([]);
  });
});
