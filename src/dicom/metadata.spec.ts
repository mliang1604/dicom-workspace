import * as dicomParser from 'dicom-parser';
import {
  extractMetadata,
  formatDicomDate,
  formatDicomTime,
  formatPersonName,
  formatRawValue,
  formatTagId,
} from './metadata';

// --- Minimal Explicit-VR-Little-Endian DICOM P10 writer --------------------
//
// Just enough to parse synthetic fixtures back into a DataSet. No real patient
// data; every byte here is fabricated.

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

/** A text value (CS/LO/DS/IS/DA/TM/PN/SH), space-padded to even length. */
function text(s: string): Uint8Array {
  return padEven(ascii(s), 0x20);
}

/** A UID value, null-padded to even length. */
function uid(s: string): Uint8Array {
  return padEven(ascii(s), 0x00);
}

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
  if (LONG_VRS.has(vr)) {
    view.setUint32(8, value.length, true);
  } else {
    view.setUint16(6, value.length, true);
  }
  return concat([header, value]);
}

/** Assemble a full P10 file (preamble + DICM + meta group + data set). */
function dicomFile(dataSetBody: Uint8Array): dicomParser.DataSet {
  const metaBody = element(0x0002, 0x0010, 'UI', uid(EXPLICIT_VR_LE));
  const groupLength = element(0x0002, 0x0000, 'UL', u32le(metaBody.length));
  const file = concat([new Uint8Array(128), ascii('DICM'), groupLength, metaBody, dataSetBody]);
  return dicomParser.parseDicom(file);
}

/** A representative CT header carrying the curated tags plus a few raw VRs. */
function sampleDataSet(): dicomParser.DataSet {
  return dicomFile(
    concat([
      element(0x0008, 0x0020, 'DA', text('20240115')), // StudyDate
      element(0x0008, 0x0060, 'CS', text('CT')), // Modality
      element(0x0008, 0x0070, 'LO', text('ACME')), // Manufacturer
      element(0x0008, 0x1030, 'LO', text('CHEST')), // StudyDescription
      element(0x0008, 0x103e, 'LO', text('Axial CT')), // SeriesDescription
      element(0x0008, 0x1090, 'LO', text('Scanner X')), // ManufacturerModelName
      element(0x0010, 0x0010, 'PN', text('Doe^John^Q')), // PatientName
      element(0x0010, 0x0020, 'LO', text('PT-42')), // PatientID
      element(0x0018, 0x0050, 'DS', text('1.5')), // SliceThickness
      element(0x0018, 0x0060, 'DS', text('120')), // KVP
      element(0x0018, 0x1151, 'IS', text('200')), // XRayTubeCurrent
      element(0x0020, 0x0011, 'IS', text('4')), // SeriesNumber
      element(0x0028, 0x0010, 'US', u16le(256)), // Rows
      element(0x0028, 0x0011, 'US', u16le(512)), // Columns
      element(0x0028, 0x0030, 'DS', text('0.5\\0.6')), // PixelSpacing
    ]),
  );
}

describe('formatTagId', () => {
  it('renders a xggggeeee key as (gggg,eeee)', () => {
    expect(formatTagId('x00100010')).toBe('(0010,0010)');
    expect(formatTagId('x7fe00010')).toBe('(7fe0,0010)');
  });
});

describe('formatDicomDate', () => {
  it('formats an 8-digit DA as YYYY-MM-DD', () => {
    expect(formatDicomDate('20240115')).toBe('2024-01-15');
  });

  it('passes a non-conforming value through trimmed', () => {
    expect(formatDicomDate('  unknown ')).toBe('unknown');
  });
});

describe('formatDicomTime', () => {
  it('formats HHMMSS, dropping fractional seconds', () => {
    expect(formatDicomTime('143005.250')).toBe('14:30:05');
  });

  it('handles partial times', () => {
    expect(formatDicomTime('1430')).toBe('14:30');
  });
});

describe('formatPersonName', () => {
  it('formats Family^Given^Middle as "Family, Given Middle"', () => {
    expect(formatPersonName('Doe^John^Q')).toBe('Doe, John Q');
  });

  it('uses just the family name when no given name is present', () => {
    expect(formatPersonName('Doe')).toBe('Doe');
  });

  it('drops empty components', () => {
    expect(formatPersonName('Doe^^')).toBe('Doe');
  });
});

describe('formatRawValue', () => {
  it('reads a US element as its numeric value', () => {
    const ds = sampleDataSet();
    expect(formatRawValue(ds, ds.elements['x00280010'])).toBe('256');
  });

  it('joins a multi-valued DS string', () => {
    const ds = sampleDataSet();
    expect(formatRawValue(ds, ds.elements['x00280030'])).toBe('0.5\\0.6');
  });

  it('formats a PN value', () => {
    const ds = sampleDataSet();
    expect(formatRawValue(ds, ds.elements['x00100010'])).toBe('Doe, John Q');
  });

  it('formats a DA value', () => {
    const ds = sampleDataSet();
    expect(formatRawValue(ds, ds.elements['x00080020'])).toBe('2024-01-15');
  });

  it('summarises bulk pixel data rather than printing it', () => {
    const ds = dicomFile(element(0x7fe0, 0x0010, 'OW', new Uint8Array(8)));
    expect(formatRawValue(ds, ds.elements['x7fe00010'])).toBe('<pixel data: 8 bytes>');
  });

  it('summarises opaque binary VRs by byte length', () => {
    const ds = dicomFile(element(0x0008, 0x0070, 'OB', new Uint8Array(6)));
    expect(formatRawValue(ds, ds.elements['x00080070'])).toBe('<binary: 6 bytes>');
  });

  it('truncates an over-long string value', () => {
    const long = 'A'.repeat(200);
    const ds = dicomFile(element(0x0008, 0x1030, 'LO', text(long)));
    const value = formatRawValue(ds, ds.elements['x00081030']);
    expect(value.endsWith('…')).toBe(true);
    expect(value.length).toBeLessThanOrEqual(81);
  });
});

describe('extractMetadata', () => {
  it('groups curated fields, formatting values and adding units', () => {
    const { curated } = extractMetadata(sampleDataSet());
    const byTitle = new Map(curated.map((group) => [group.title, group.fields]));

    const field = (title: string, label: string) =>
      byTitle.get(title)?.find((f) => f.label === label)?.value;

    expect(field('Patient', 'Name')).toBe('Doe, John Q');
    expect(field('Patient', 'ID')).toBe('PT-42');
    expect(field('Study', 'Date')).toBe('2024-01-15');
    expect(field('Study', 'Description')).toBe('CHEST');
    expect(field('Series', 'Modality')).toBe('CT');
    expect(field('Acquisition', 'KVP')).toBe('120 kV');
    expect(field('Acquisition', 'Tube current')).toBe('200 mA');
    expect(field('Acquisition', 'Slice thickness')).toBe('1.5 mm');
    expect(field('Acquisition', 'Pixel spacing')).toBe('0.5 × 0.6 mm');
    expect(field('Acquisition', 'Dimensions')).toBe('512 × 256 px');
    expect(field('Acquisition', 'Model')).toBe('Scanner X');
  });

  it('omits absent fields and empty groups', () => {
    const ds = dicomFile(element(0x0008, 0x0060, 'CS', text('MR'))); // Modality only
    const { curated } = extractMetadata(ds);

    expect(curated.map((group) => group.title)).toEqual(['Series']);
    expect(curated[0].fields).toEqual([{ label: 'Modality', value: 'MR' }]);
  });

  it('lists raw tags sorted by tag id, with VR and value', () => {
    const { rawTags } = extractMetadata(sampleDataSet());

    const ids = rawTags.map((tag) => tag.tag);
    expect([...ids]).toEqual([...ids].sort());

    const name = rawTags.find((tag) => tag.tag === '(0010,0010)');
    expect(name).toEqual({ tag: '(0010,0010)', vr: 'PN', value: 'Doe, John Q' });
  });
});
