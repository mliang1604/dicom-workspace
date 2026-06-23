import { parseRegistration } from './registration';

// --- Minimal Explicit-VR-Little-Endian DICOM P10 writer --------------------
//
// Just enough to build synthetic Spatial Registration fixtures (no PixelData,
// nested sequences, binary OF/UL/FD values). No real patient data; every byte
// here is fabricated. Mirrors the writer in structure-set.spec.ts / loader.spec.ts.

const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';
const SPATIAL_REGISTRATION = '1.2.840.10008.5.1.4.1.1.66.1';
const DEFORMABLE_REGISTRATION = '1.2.840.10008.5.1.4.1.1.66.3';
const CT_IMAGE_STORAGE = '1.2.840.10008.5.1.4.1.1.2';

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

/** Double (FD) values, little-endian. */
function fdValues(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setFloat64(i * 8, v, true));
  return out;
}

/** 32-bit float (OF) values, little-endian. */
function ofValues(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return out;
}

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
function dicomFile(dataSetBody: Uint8Array, sopClass: string): ArrayBuffer {
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

/** A Matrix Registration Sequence (0070,0309) wrapping one matrix + type. */
function matrixRegistration(matrix: readonly number[], type: string): Uint8Array {
  const matrixItem = concat([
    element(0x3006, 0x00c6, 'DS', numbers(matrix)), // Frame of Reference Transformation Matrix
    element(0x0070, 0x030c, 'CS', text(type)), // ... Matrix Type
  ]);
  const matrixSequence = sequence(0x0070, 0x030a, [matrixItem]); // Matrix Sequence
  return sequence(0x0070, 0x0309, [matrixSequence]); // Matrix Registration Sequence
}

/** One Registration Sequence (0070,0308) item: a frame and its matrix. */
function registrationItem(frame: string, matrix: readonly number[], type: string): Uint8Array {
  return concat([
    element(0x0020, 0x0052, 'UI', uid(frame)), // Frame of Reference UID
    matrixRegistration(matrix, type),
  ]);
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A rigid Spatial Registration mapping frame MOVING onto fixed frame FIXED. */
function rigidRegistration(matrix: readonly number[], type = 'RIGID'): ArrayBuffer {
  const body = concat([
    element(0x0008, 0x0016, 'UI', uid(SPATIAL_REGISTRATION)), // SOPClassUID
    element(0x0008, 0x0060, 'CS', text('REG')), // Modality
    element(0x0020, 0x0052, 'UI', uid('FIXED')), // Frame of Reference UID (target)
    sequence(0x0070, 0x0308, [
      registrationItem('FIXED', IDENTITY, 'RIGID'), // the fixed frame: identity
      registrationItem('MOVING', matrix, type), // the moving frame: the transform
    ]),
  ]);
  return dicomFile(body, SPATIAL_REGISTRATION);
}

/** A Deformable Registration Grid Sequence (0064,0005) item. */
function deformationGrid(
  origin: readonly number[],
  dims: readonly number[],
  spacing: readonly number[],
  vectors: readonly number[],
): Uint8Array {
  const gridItem = concat([
    element(0x0020, 0x0032, 'DS', numbers(origin)), // Image Position Patient
    element(0x0020, 0x0037, 'DS', numbers([1, 0, 0, 0, 1, 0])), // Image Orientation Patient
    element(0x0064, 0x0007, 'UL', concat(dims.map(u32le))), // Grid Dimensions
    element(0x0064, 0x0008, 'FD', fdValues(spacing)), // Grid Resolution
    element(0x0064, 0x0009, 'OF', ofValues(vectors)), // Vector Grid Data
  ]);
  return sequence(0x0064, 0x0005, [gridItem]);
}

/** A deformable Spatial Registration, optionally with a pre-deformation matrix. */
function deformableRegistration(options: { preMatrix?: readonly number[] } = {}): ArrayBuffer {
  const dims = [2, 2, 2];
  const vectors = Array.from({ length: 3 * dims[0] * dims[1] * dims[2] }, (_, i) => i + 1);
  const pre = options.preMatrix ? [matrixRegistrationSeq(0x0064, 0x000f, options.preMatrix)] : [];
  const movingItem = concat([
    element(0x0064, 0x0003, 'UI', uid('MOVING')), // Source Frame of Reference UID
    deformationGrid([10, 20, 30], dims, [3, 3, 3], vectors),
    ...pre,
  ]);
  return deformableFromItems([movingItem]);
}

/** A grid-less Deformable Registration Sequence item for the fixed frame (self-registration). */
function fixedSelfItem(): Uint8Array {
  return concat([
    element(0x0064, 0x0003, 'UI', uid('FIXED')), // Source Frame of Reference UID (the fixed frame)
    matrixRegistrationSeq(0x0064, 0x000a, IDENTITY), // Post Deformation Matrix (identity)
  ]);
}

/** Assemble a deformable Spatial Registration from explicit sequence items. */
function deformableFromItems(defItems: Uint8Array[]): ArrayBuffer {
  const body = concat([
    element(0x0008, 0x0016, 'UI', uid(DEFORMABLE_REGISTRATION)), // SOPClassUID
    element(0x0020, 0x0052, 'UI', uid('FIXED')), // Frame of Reference UID (target)
    sequence(0x0064, 0x0002, defItems), // Deformable Registration Sequence
  ]);
  return dicomFile(body, DEFORMABLE_REGISTRATION);
}

/** A moving Deformable Registration Sequence item carrying the displacement grid. */
function movingGridItem(): Uint8Array {
  const dims = [2, 2, 2];
  const vectors = Array.from({ length: 3 * dims[0] * dims[1] * dims[2] }, (_, i) => i + 1);
  return concat([
    element(0x0064, 0x0003, 'UI', uid('MOVING')), // Source Frame of Reference UID
    deformationGrid([10, 20, 30], dims, [3, 3, 3], vectors),
  ]);
}

/** A Deformable Registration Sequence item carrying only a Source Frame of Reference UID. */
function sourceFrameItem(frame: string): Uint8Array {
  return element(0x0064, 0x0003, 'UI', uid(frame)); // Source Frame of Reference UID
}

/** A Deformable Registration Sequence item carrying only the grid (no source frame). */
function gridOnlyItem(): Uint8Array {
  const dims = [2, 2, 2];
  const vectors = Array.from({ length: 3 * dims[0] * dims[1] * dims[2] }, (_, i) => i + 1);
  return deformationGrid([10, 20, 30], dims, [3, 3, 3], vectors);
}

/** A Deformable Registration Sequence item carrying only a Pre Deformation Matrix. */
function preMatrixItem(matrix: readonly number[]): Uint8Array {
  return matrixRegistrationSeq(0x0064, 0x000f, matrix);
}

/** A Deformable Registration Sequence item carrying only a Post Deformation Matrix. */
function postMatrixItem(matrix: readonly number[]): Uint8Array {
  return matrixRegistrationSeq(0x0064, 0x000a, matrix);
}

/** A Pre/Post Deformation Matrix Registration Sequence carrying one matrix. */
function matrixRegistrationSeq(group: number, el: number, matrix: readonly number[]): Uint8Array {
  const item = concat([
    element(0x3006, 0x00c6, 'DS', numbers(matrix)),
    element(0x0070, 0x030c, 'CS', text('RIGID')),
  ]);
  return sequence(group, el, [item]);
}

/** A moving Deformable Registration Sequence item: source frame, grid, pre matrix. */
function movingItemWithPre(preMatrix: readonly number[]): Uint8Array {
  const dims = [2, 2, 2];
  const vectors = Array.from({ length: 3 * dims[0] * dims[1] * dims[2] }, (_, i) => i + 1);
  return concat([
    element(0x0064, 0x0003, 'UI', uid('MOVING')), // Source Frame of Reference UID
    deformationGrid([10, 20, 30], dims, [3, 3, 3], vectors),
    matrixRegistrationSeq(0x0064, 0x000f, preMatrix), // Pre Deformation Matrix
  ]);
}

/** A deformable Spatial Registration carrying a Manufacturer's Model Name (0008,1090). */
function deformableWithModel(model: string, defItems: Uint8Array[]): ArrayBuffer {
  const body = concat([
    element(0x0008, 0x0016, 'UI', uid(DEFORMABLE_REGISTRATION)), // SOPClassUID
    element(0x0008, 0x1090, 'LO', text(model)), // Manufacturer's Model Name
    element(0x0020, 0x0052, 'UI', uid('FIXED')), // Frame of Reference UID (target)
    sequence(0x0064, 0x0002, defItems),
  ]);
  return dicomFile(body, DEFORMABLE_REGISTRATION);
}

// --- Tests ------------------------------------------------------------------

describe('parseRegistration', () => {
  it('returns null for a non-DICOM buffer', () => {
    expect(parseRegistration('junk', ascii('not dicom').buffer as ArrayBuffer)).toBeNull();
  });

  it('returns null for an ordinary image SOP class', () => {
    const body = concat([
      element(0x0008, 0x0016, 'UI', uid(CT_IMAGE_STORAGE)),
      element(0x0008, 0x0060, 'CS', text('CT')),
    ]);
    expect(parseRegistration('ct', dicomFile(body, CT_IMAGE_STORAGE))).toBeNull();
  });

  it('parses a rigid registration: moving→fixed matrix, frames, and type', () => {
    const matrix = [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1];
    const reg = parseRegistration('rigid.dcm', rigidRegistration(matrix, 'RIGID'));

    expect(reg).not.toBeNull();
    expect(reg!.kind).toBe('rigid');
    expect(reg!.name).toBe('rigid.dcm');
    expect(reg!.sourceFrame).toBe('MOVING');
    expect(reg!.targetFrame).toBe('FIXED');
    if (reg!.kind !== 'rigid') throw new Error('expected rigid');
    expect(reg!.matrix).toEqual(matrix);
    expect(reg!.matrixType).toBe('RIGID');
  });

  it('carries an AFFINE matrix type through', () => {
    const reg = parseRegistration('affine.dcm', rigidRegistration(IDENTITY, 'AFFINE'));
    if (reg?.kind !== 'rigid') throw new Error('expected rigid');
    expect(reg.matrixType).toBe('AFFINE');
  });

  it('parses a deformable registration grid (dims, spacing, origin, vectors)', () => {
    const reg = parseRegistration('deform.dcm', deformableRegistration());

    expect(reg).not.toBeNull();
    if (reg?.kind !== 'deformable') throw new Error('expected deformable');
    expect(reg.sourceFrame).toBe('MOVING');
    expect(reg.targetFrame).toBe('FIXED');
    expect(reg.grid.dims).toEqual([2, 2, 2]);
    expect(reg.grid.spacing).toEqual([3, 3, 3]);
    expect(reg.grid.origin).toEqual([10, 20, 30]);
    expect(reg.grid.orientation).toEqual([1, 0, 0, 0, 1, 0]);
    expect(reg.grid.vectors).toHaveLength(24);
    expect(Array.from(reg.grid.vectors.slice(0, 3))).toEqual([1, 2, 3]);
  });

  it('defaults pre/post matrices to identity when absent', () => {
    const reg = parseRegistration('deform.dcm', deformableRegistration());
    if (reg?.kind !== 'deformable') throw new Error('expected deformable');
    expect(reg.preMatrix).toEqual(IDENTITY);
    expect(reg.postMatrix).toEqual(IDENTITY);
  });

  it('reads a pre-deformation rigid matrix when present', () => {
    const preMatrix = [1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 1, 4, 0, 0, 0, 1];
    const reg = parseRegistration('deform.dcm', deformableRegistration({ preMatrix }));
    if (reg?.kind !== 'deformable') throw new Error('expected deformable');
    expect(reg.preMatrix).toEqual(preMatrix);
  });

  it('picks the grid-bearing moving item when a fixed self-registration comes first', () => {
    // Real objects pair a grid-less fixed self-registration with the moving item
    // holding the displacement grid; the fixed item often comes first.
    const reg = parseRegistration(
      'deform.dcm',
      deformableFromItems([fixedSelfItem(), movingGridItem()]),
    );

    expect(reg).not.toBeNull();
    if (reg?.kind !== 'deformable') throw new Error('expected deformable');
    expect(reg.sourceFrame).toBe('MOVING');
    expect(reg.targetFrame).toBe('FIXED');
    expect(reg.grid.dims).toEqual([2, 2, 2]);
    expect(Array.from(reg.grid.vectors.slice(0, 3))).toEqual([1, 2, 3]);
  });

  it('recovers the source frame when it and the grid are in separate sequence items', () => {
    // Some producers split the Deformable Registration Sequence: one item declares
    // the Source Frame of Reference UID, a later item carries the grid. The moving
    // frame must still be recovered, not read off the (source-less) grid item.
    const reg = parseRegistration(
      'split.dcm',
      deformableFromItems([sourceFrameItem('MOVING'), gridOnlyItem()]),
    );

    expect(reg).not.toBeNull();
    if (reg?.kind !== 'deformable') throw new Error('expected deformable');
    expect(reg.sourceFrame).toBe('MOVING');
    expect(reg.targetFrame).toBe('FIXED');
    expect(reg.grid.dims).toEqual([2, 2, 2]);
    expect(Array.from(reg.grid.vectors.slice(0, 3))).toEqual([1, 2, 3]);
  });

  it('recovers source, grid, and pre/post matrices when each is in its own item', () => {
    // The real-world layout that exposed this: 0064,0002 has four items, one
    // element each — [Source FoR][Pre Deformation Matrix][Post Deformation
    // Matrix][Grid] — not one item holding all four. Each must be read from its own
    // item, not off the grid item.
    const pre = [1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 1, 4, 0, 0, 0, 1];
    const post = [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1];
    const reg = parseRegistration(
      'split4.dcm',
      deformableFromItems([
        sourceFrameItem('MOVING'),
        preMatrixItem(pre),
        postMatrixItem(post),
        gridOnlyItem(),
      ]),
    );

    expect(reg).not.toBeNull();
    if (reg?.kind !== 'deformable') throw new Error('expected deformable');
    expect(reg.sourceFrame).toBe('MOVING');
    expect(reg.targetFrame).toBe('FIXED');
    expect(reg.preMatrix).toEqual(pre);
    expect(reg.postMatrix).toEqual(post);
    expect(reg.grid.dims).toEqual([2, 2, 2]);
  });
});

describe('Varian Velocity matrix-scale correction', () => {
  // Velocity exports the matrix's linear + translation scaled by ~0.001 (the 3×3 is
  // a 180°-about-x rotation × 0.001), which is singular and collapses the overlay.
  // prettier-ignore
  const scaledPre = [
    0.001, 0, 0, 0.0006,
    0, -0.001, 0, 0.1534,
    0, 0, -0.001, 0.238,
    0, 0, 0, 1,
  ];

  it('rescales a Velocity 0.001-scaled matrix back to unit scale (×1000)', () => {
    const reg = parseRegistration(
      'velocity.dcm',
      deformableWithModel('Velocity', [movingItemWithPre(scaledPre)]),
    );
    if (reg?.kind !== 'deformable') throw new Error('expected deformable');
    expect(reg.preMatrix[0]).toBeCloseTo(1, 5); // 3×3 → unit rotation
    expect(reg.preMatrix[5]).toBeCloseTo(-1, 5);
    expect(reg.preMatrix[10]).toBeCloseTo(-1, 5);
    expect(reg.preMatrix[3]).toBeCloseTo(0.6, 3); // translation scales up too
    expect(reg.preMatrix[7]).toBeCloseTo(153.4, 1);
    expect(reg.preMatrix[11]).toBeCloseTo(238, 1);
    expect(reg.preMatrix[15]).toBe(1); // homogeneous row untouched
  });

  it('detects Velocity by the Varian SOP Instance UID root when the model tag is absent', () => {
    const body = concat([
      element(0x0008, 0x0016, 'UI', uid(DEFORMABLE_REGISTRATION)),
      element(0x0008, 0x0018, 'UI', uid('1.2.246.352.222.400.123')), // SOP Instance UID
      element(0x0020, 0x0052, 'UI', uid('FIXED')),
      sequence(0x0064, 0x0002, [movingItemWithPre(scaledPre)]),
    ]);
    const reg = parseRegistration('velocity.dcm', dicomFile(body, DEFORMABLE_REGISTRATION));
    if (reg?.kind !== 'deformable') throw new Error('expected deformable');
    expect(reg.preMatrix[0]).toBeCloseTo(1, 5);
  });

  it('leaves the same scaled matrix untouched for a non-Velocity producer', () => {
    const reg = parseRegistration(
      'other.dcm',
      deformableWithModel('OtherTPS', [movingItemWithPre(scaledPre)]),
    );
    if (reg?.kind !== 'deformable') throw new Error('expected deformable');
    expect(reg.preMatrix[0]).toBeCloseTo(0.001, 6); // unchanged
  });

  it('leaves an already unit-scale Velocity matrix untouched', () => {
    const valid = [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1];
    const reg = parseRegistration(
      'velocity.dcm',
      deformableWithModel('Velocity', [movingItemWithPre(valid)]),
    );
    if (reg?.kind !== 'deformable') throw new Error('expected deformable');
    expect(reg.preMatrix).toEqual(valid);
  });
});
