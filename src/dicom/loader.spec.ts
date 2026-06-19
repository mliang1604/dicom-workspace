import { parseFile, UnsupportedDicomError } from './loader';

// --- Minimal Explicit-VR-Little-Endian DICOM P10 writer --------------------
//
// Just enough to build synthetic in-memory fixtures for the loader. No real
// patient data; every byte here is fabricated.

const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';
const RLE_LOSSLESS = '1.2.840.10008.1.2.5';

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

function u16le(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
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
    view.setUint32(8, value.length, true); // bytes 6-7 reserved, left zero
  } else {
    view.setUint16(6, value.length, true);
  }
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

/** Raw 16-bit unsigned PixelData for `frames` frames of `count` samples each. */
function pixelData(frames: readonly number[][]): Uint8Array {
  const samples = frames.flat();
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setUint16(i * 2, s, true));
  return element(0x7fe0, 0x0010, 'OW', out);
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/** One RLE frame for 16-bit unsigned pixels, each byte-plane a single literal run. */
function rleFrame16(pixels: readonly number[]): Uint8Array {
  const literal = (bytes: number[]): number[] => [bytes.length - 1, ...bytes];
  const seg0 = literal(pixels.map((p) => (p >> 8) & 0xff)); // high bytes
  const seg1 = literal(pixels.map((p) => p & 0xff)); // low bytes

  const header = new Uint8Array(64);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 2, true); // two segments
  hv.setUint32(4, 64, true); // segment 0 offset
  hv.setUint32(8, 64 + seg0.length, true); // segment 1 offset

  return concat([header, Uint8Array.from(seg0), Uint8Array.from(seg1)]);
}

/** A DICOM item (FFFE,E000) wrapping `body`. */
function item(body: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint16(0, 0xfffe, true);
  view.setUint16(2, 0xe000, true);
  view.setUint32(4, body.length, true);
  return concat([header, body]);
}

/** Encapsulated PixelData (undefined length): empty Basic Offset Table + one item per frame. */
function encapsulatedPixelData(frames: Uint8Array[]): Uint8Array {
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint16(0, 0x7fe0, true);
  view.setUint16(2, 0x0010, true);
  header[4] = 'O'.charCodeAt(0);
  header[5] = 'B'.charCodeAt(0);
  view.setUint32(8, 0xffffffff, true); // undefined length marks encapsulation

  const delimiter = new Uint8Array(8);
  const dv = new DataView(delimiter.buffer);
  dv.setUint16(0, 0xfffe, true);
  dv.setUint16(2, 0xe0dd, true); // Sequence Delimitation Item

  return concat([header, item(new Uint8Array(0)), ...frames.map(item), delimiter]);
}

/** Assemble a full P10 file (preamble + DICM + meta group + data set). */
function dicomFile(dataSetBody: Uint8Array, transferSyntax = EXPLICIT_VR_LE): ArrayBuffer {
  const metaBody = element(0x0002, 0x0010, 'UI', uid(transferSyntax)); // TransferSyntaxUID
  const groupLength = element(0x0002, 0x0000, 'UL', u32le(metaBody.length)); // FileMetaInformationGroupLength

  const file = concat([
    new Uint8Array(128), // preamble
    ascii('DICM'),
    groupLength,
    metaBody,
    dataSetBody,
  ]);
  // `concat` always returns a fresh, exactly-sized buffer at offset 0.
  return file.buffer as ArrayBuffer;
}

// --- Fixtures ---------------------------------------------------------------

/** A classic single-frame CT, 2×2, with top-level geometry. */
function singleFrameCt(): ArrayBuffer {
  const body = concat([
    element(0x0008, 0x0060, 'CS', text('CT')), // Modality
    element(0x0020, 0x0013, 'IS', numbers([7])), // InstanceNumber
    element(0x0020, 0x0032, 'DS', numbers([10, 20, 30])), // ImagePositionPatient
    element(0x0020, 0x0037, 'DS', numbers([1, 0, 0, 0, 1, 0])), // ImageOrientationPatient
    element(0x0028, 0x0002, 'US', u16le(1)), // SamplesPerPixel
    element(0x0028, 0x0010, 'US', u16le(2)), // Rows
    element(0x0028, 0x0011, 'US', u16le(2)), // Columns
    element(0x0028, 0x0030, 'DS', numbers([0.5, 0.6])), // PixelSpacing
    element(0x0028, 0x0100, 'US', u16le(16)), // BitsAllocated
    element(0x0028, 0x0103, 'US', u16le(0)), // PixelRepresentation
    element(0x0028, 0x1050, 'DS', numbers([40])), // WindowCenter
    element(0x0028, 0x1051, 'DS', numbers([400])), // WindowWidth
    element(0x0028, 0x1052, 'DS', numbers([-1024])), // RescaleIntercept
    element(0x0028, 0x1053, 'DS', numbers([1])), // RescaleSlope
    pixelData([[1, 2, 3, 4]]),
  ]);
  return dicomFile(body);
}

/**
 * A 3-frame Enhanced MR, 2×2. Orientation, pixel spacing and VOI are shared;
 * each frame carries its own Plane Position. Frame 2 also overrides the shared
 * rescale via a per-frame Pixel Value Transformation Sequence.
 */
function multiframeMr(): ArrayBuffer {
  // Shared Functional Groups: one item with orientation, measures, VOI, rescale.
  const sharedItem = concat([
    sequence(0x0020, 0x9116, [element(0x0020, 0x0037, 'DS', numbers([1, 0, 0, 0, 1, 0]))]),
    sequence(0x0028, 0x9110, [element(0x0028, 0x0030, 'DS', numbers([0.5, 0.6]))]),
    sequence(0x0028, 0x9132, [
      concat([
        element(0x0028, 0x1050, 'DS', numbers([100])),
        element(0x0028, 0x1051, 'DS', numbers([200])),
      ]),
    ]),
    sequence(0x0028, 0x9145, [
      concat([
        element(0x0028, 0x1052, 'DS', numbers([0])),
        element(0x0028, 0x1053, 'DS', numbers([2])),
      ]),
    ]),
  ]);

  // Per-frame items: distinct through-plane positions, deliberately unordered.
  const positions = [
    [0, 0, 4],
    [0, 0, 0],
    [0, 0, 2],
  ];
  const perFrameItems = positions.map((pos, i) => {
    const planePos = sequence(0x0020, 0x9113, [element(0x0020, 0x0032, 'DS', numbers(pos))]);
    if (i === 1) {
      // Frame at z=0 overrides the shared rescale slope (2 -> 3).
      return concat([
        planePos,
        sequence(0x0028, 0x9145, [
          concat([
            element(0x0028, 0x1052, 'DS', numbers([0])),
            element(0x0028, 0x1053, 'DS', numbers([3])),
          ]),
        ]),
      ]);
    }
    return planePos;
  });

  const body = concat([
    element(0x0008, 0x0060, 'CS', text('MR')), // Modality
    element(0x0028, 0x0002, 'US', u16le(1)), // SamplesPerPixel
    element(0x0028, 0x0008, 'IS', numbers([3])), // NumberOfFrames
    element(0x0028, 0x0010, 'US', u16le(2)), // Rows
    element(0x0028, 0x0011, 'US', u16le(2)), // Columns
    element(0x0028, 0x0100, 'US', u16le(16)), // BitsAllocated
    element(0x0028, 0x0103, 'US', u16le(0)), // PixelRepresentation
    sequence(0x5200, 0x9229, [sharedItem]), // Shared Functional Groups
    sequence(0x5200, 0x9230, perFrameItems), // Per-Frame Functional Groups
    // One distinct constant per frame so we can tell them apart after sorting.
    pixelData([
      [10, 10, 10, 10],
      [20, 20, 20, 20],
      [30, 30, 30, 30],
    ]),
  ]);
  return dicomFile(body);
}

/** A classic single-frame CT, 2×2, with RLE Lossless encapsulated PixelData. */
function rleCt(): ArrayBuffer {
  const body = concat([
    element(0x0008, 0x0060, 'CS', text('CT')), // Modality
    element(0x0028, 0x0002, 'US', u16le(1)), // SamplesPerPixel
    element(0x0028, 0x0010, 'US', u16le(2)), // Rows
    element(0x0028, 0x0011, 'US', u16le(2)), // Columns
    element(0x0028, 0x0100, 'US', u16le(16)), // BitsAllocated
    element(0x0028, 0x0103, 'US', u16le(0)), // PixelRepresentation
    encapsulatedPixelData([rleFrame16([0x0102, 0x0304, 0x0506, 0x0708])]),
  ]);
  return dicomFile(body, RLE_LOSSLESS);
}

// --- Tests ------------------------------------------------------------------

describe('parseFile — single frame', () => {
  it('reads one slice with top-level geometry, unaffected by multiframe logic', () => {
    const slices = parseFile('ct.dcm', singleFrameCt());

    expect(slices).toHaveLength(1);
    const s = slices[0];
    expect(s.name).toBe('ct.dcm');
    expect(s.rows).toBe(2);
    expect(s.columns).toBe(2);
    expect(s.modality).toBe('CT');
    expect(s.instanceNumber).toBe(7);
    expect(s.position).toEqual([10, 20, 30]);
    expect(s.orientation).toEqual([1, 0, 0, 0, 1, 0]);
    expect(s.pixelSpacing).toEqual([0.5, 0.6]);
    expect(s.windowCenter).toBe(40);
    expect(s.windowWidth).toBe(400);
    // raw [1,2,3,4] rescaled by slope 1, intercept -1024.
    expect(Array.from(s.pixels)).toEqual([-1023, -1022, -1021, -1020]);
  });
});

describe('parseFile — multiframe', () => {
  it('emits one slice per frame', () => {
    const slices = parseFile('mr.dcm', multiframeMr());
    expect(slices).toHaveLength(3);
    expect(slices.map((s) => s.name)).toEqual(['mr.dcm#1', 'mr.dcm#2', 'mr.dcm#3']);
  });

  it('extracts per-frame ImagePositionPatient in file order', () => {
    const slices = parseFile('mr.dcm', multiframeMr());
    expect(slices.map((s) => s.position)).toEqual([
      [0, 0, 4],
      [0, 0, 0],
      [0, 0, 2],
    ]);
  });

  it('reads each frame from its own PixelData segment', () => {
    const slices = parseFile('mr.dcm', multiframeMr());
    // Frame 1 has shared slope 2 -> 10*2 = 20; frame 2 overrides slope 3 -> 20*3 = 60.
    expect(Array.from(slices[0].pixels)).toEqual([20, 20, 20, 20]);
    expect(Array.from(slices[1].pixels)).toEqual([60, 60, 60, 60]);
    expect(Array.from(slices[2].pixels)).toEqual([60, 60, 60, 60]);
  });

  it('falls back to shared groups for orientation, spacing and VOI', () => {
    const slices = parseFile('mr.dcm', multiframeMr());
    for (const s of slices) {
      expect(s.orientation).toEqual([1, 0, 0, 0, 1, 0]);
      expect(s.pixelSpacing).toEqual([0.5, 0.6]);
      expect(s.windowCenter).toBe(100);
      expect(s.windowWidth).toBe(200);
      expect(s.modality).toBe('MR');
    }
  });

  it('prefers a per-frame value over the shared one', () => {
    const slices = parseFile('mr.dcm', multiframeMr());
    // Frame 2 (z=0) overrode the shared rescale slope.
    expect(slices[0].rescaleSlope).toBe(2);
    expect(slices[1].rescaleSlope).toBe(3);
    expect(slices[2].rescaleSlope).toBe(2);
  });
});

describe('parseFile — RLE compressed', () => {
  it('decodes an RLE Lossless single-frame image into raw samples', () => {
    const slices = parseFile('rle.dcm', rleCt());

    expect(slices).toHaveLength(1);
    const s = slices[0];
    expect(s.rows).toBe(2);
    expect(s.columns).toBe(2);
    // No rescale tags -> slope 1, intercept 0: pixels equal the decoded samples.
    expect(Array.from(s.pixels)).toEqual([0x0102, 0x0304, 0x0506, 0x0708]);
  });
});

describe('parseFile — non-images', () => {
  it('returns an empty array for unparseable bytes', () => {
    expect(parseFile('garbage.bin', new Uint8Array([1, 2, 3, 4]).buffer)).toEqual([]);
  });

  it('throws for a compressed transfer syntax', () => {
    const body = concat([
      element(0x0028, 0x0010, 'US', u16le(2)),
      element(0x0028, 0x0011, 'US', u16le(2)),
      pixelData([[1, 2, 3, 4]]),
    ]);
    // JPEG Baseline transfer syntax — declared in the meta group, but unreadable.
    const buffer = dicomFile(body, '1.2.840.10008.1.2.4.50');

    expect(() => parseFile('jpeg.dcm', buffer)).toThrow(UnsupportedDicomError);
  });
});
