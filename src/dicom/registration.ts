import * as dicomParser from 'dicom-parser';
import {
  IDENTITY_MAT4,
  type DeformationGrid,
  type Mat4,
  type Registration,
  type Vec3,
} from './types';

/** SOP Class UID of a Spatial Registration Storage object (rigid / affine). */
const SPATIAL_REGISTRATION_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.66.1';
/** SOP Class UID of a Deformable Spatial Registration Storage object. */
const DEFORMABLE_REGISTRATION_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.66.3';

/**
 * Parse a DICOM Spatial Registration file into a typed {@link Registration}, or
 * return null for any file that is not a registration object.
 *
 * Registration objects carry no PixelData, so — like RTSTRUCT — they never reach
 * the image {@link import('./loader').parseFile} path. This is the separate entry
 * point: it recognises the rigid (`…66.1`) and deformable (`…66.3`) SOP classes
 * (or Modality `REG`), then reads the transform that maps a *moving* frame of
 * reference onto a *fixed* one. The fixed frame is the object's top-level Frame of
 * Reference UID (0020,0052); the moving frame and its transform come from the
 * Registration Sequence (rigid) or the Deformable Registration Sequence.
 *
 * Returns null when the object carries no usable transform (no matrix, or a
 * deformable grid without vector data), so a malformed file is skipped rather
 * than yielding a degenerate registration.
 */
export function parseRegistration(name: string, buffer: ArrayBuffer): Registration | null {
  let dataSet: dicomParser.DataSet;
  try {
    dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
  } catch {
    return null; // Not a parseable DICOM file.
  }
  if (!isRegistration(dataSet)) return null;

  // Branch on the carried sequence rather than the SOP class alone: a Deformable
  // Registration Sequence (0064,0002) means a displacement field; otherwise a
  // Registration Sequence (0070,0308) means a rigid/affine matrix.
  if (dataSet.elements['x00640002']) return parseDeformable(name, dataSet);
  if (dataSet.elements['x00700308']) return parseRigid(name, dataSet);
  return null;
}

/**
 * A rigid/affine registration: the Registration Sequence (0070,0308) holds one
 * item per frame of reference, each mapping its frame into the common registered
 * coordinate system. The item whose frame is the object's top-level Frame of
 * Reference is the fixed frame (identity matrix); the other carries the moving
 * frame's source→fixed matrix.
 */
function parseRigid(name: string, dataSet: dicomParser.DataSet): Registration | null {
  const targetFrame = frameOfReference(dataSet, 'x00200052');
  const regItems = items(dataSet, 'x00700308').map((item) => ({
    frame: frameOfReference(item, 'x00200052'),
    found: findMatrix(item),
  }));

  // Prefer the moving item (a frame other than the fixed one that carries a
  // matrix); fall back to the first item with any matrix (e.g. a self-registration
  // whose single item shares the target frame).
  const source =
    regItems.find((r) => r.frame !== targetFrame && r.found) ?? regItems.find((r) => r.found);
  if (!source?.found) return null;

  return {
    kind: 'rigid',
    name,
    sourceFrame: source.frame,
    targetFrame,
    matrix: source.found.matrix,
    matrixType: source.found.type,
  };
}

/**
 * A deformable registration: the Deformable Registration Sequence (0064,0002)
 * holds the moving frame (Source Frame of Reference UID, 0064,0003), the
 * displacement grid (0064,0005), and optional pre/post rigid stages (0064,000F /
 * 0064,000A). The fixed frame is the object's top-level Frame of Reference.
 */
function parseDeformable(name: string, dataSet: dicomParser.DataSet): Registration | null {
  const item = items(dataSet, 'x00640002')[0];
  if (!item) return null;

  const gridDs = items(item, 'x00640005')[0];
  const grid = gridDs ? readGrid(gridDs) : null;
  if (!grid) return null;

  return {
    kind: 'deformable',
    name,
    sourceFrame: frameOfReference(item, 'x00640003'),
    targetFrame: frameOfReference(dataSet, 'x00200052'),
    preMatrix: findMatrix(seqItem(item, 'x0064000f'))?.matrix ?? IDENTITY_MAT4,
    postMatrix: findMatrix(seqItem(item, 'x0064000a'))?.matrix ?? IDENTITY_MAT4,
    grid,
  };
}

/** Read a Deformable Registration Grid Sequence item into a {@link DeformationGrid}. */
function readGrid(ds: dicomParser.DataSet): DeformationGrid | null {
  const dims: [number, number, number] = [
    uintAt(ds, 'x00640007', 0),
    uintAt(ds, 'x00640007', 1),
    uintAt(ds, 'x00640007', 2),
  ];
  if (dims.some((d) => !Number.isFinite(d) || d <= 0)) return null;

  const vectors = readVectorGrid(ds, 'x00640009');
  if (!vectors || vectors.length < 3 * dims[0] * dims[1] * dims[2]) return null;

  return {
    origin: vec3At(ds, 'x00200032'),
    orientation: orientationAt(ds, 'x00200037'),
    dims,
    spacing: [
      doubleAt(ds, 'x00640008', 0),
      doubleAt(ds, 'x00640008', 1),
      doubleAt(ds, 'x00640008', 2),
    ],
    vectors,
  };
}

/**
 * Recognise a Spatial Registration object: the SOP Class UID (or its
 * media-storage twin) is the rigid or deformable registration class, or the
 * Modality is `REG`. Either is sufficient.
 */
function isRegistration(dataSet: dicomParser.DataSet): boolean {
  const sopClass = (dataSet.string('x00080016') ?? dataSet.string('x00020002'))?.trim();
  if (
    sopClass === SPATIAL_REGISTRATION_SOP_CLASS ||
    sopClass === DEFORMABLE_REGISTRATION_SOP_CLASS
  ) {
    return true;
  }
  return dataSet.string('x00080060')?.trim().toUpperCase() === 'REG'; // Modality
}

/** A Frame of Reference UID tag, trimmed; null when absent or empty. */
function frameOfReference(dataSet: dicomParser.DataSet, tag: string): string | null {
  return dataSet.string(tag)?.trim() || null;
}

/** The nested data sets of a sequence element, in file order (empty when absent). */
function items(dataSet: dicomParser.DataSet, tag: string): dicomParser.DataSet[] {
  const seq = dataSet.elements[tag]?.items ?? [];
  return seq.map((item) => item.dataSet).filter((ds): ds is dicomParser.DataSet => !!ds);
}

/** The first nested item of a sequence, or undefined when the sequence is absent/empty. */
function seqItem(dataSet: dicomParser.DataSet, tag: string): dicomParser.DataSet | undefined {
  return items(dataSet, tag)[0];
}

/**
 * Find the first Frame of Reference Transformation Matrix (3006,00C6) at or below
 * a data set, with its type (0070,030C). The matrix lives at varying nesting
 * depths — directly, or under a Matrix Registration Sequence (0070,0309) → Matrix
 * Sequence (0070,030A) — so this walks the sub-tree rather than assuming a fixed
 * path. Returns null when no matrix is present (or the data set is undefined).
 */
function findMatrix(dataSet: dicomParser.DataSet | undefined): {
  matrix: Mat4;
  type: string;
} | null {
  if (!dataSet) return null;

  const matrix = readMatrix(dataSet);
  if (matrix) return { matrix, type: dataSet.string('x0070030c')?.trim() ?? '' };

  for (const tag of Object.keys(dataSet.elements)) {
    const element = dataSet.elements[tag];
    if (!element.items) continue;
    for (const item of element.items) {
      const found = findMatrix(item.dataSet);
      if (found) return found;
    }
  }
  return null;
}

/** Read a 16-value decimal-string matrix tag (row-major), or null when malformed. */
function readMatrix(dataSet: dicomParser.DataSet): Mat4 | null {
  const raw = dataSet.string('x300600c6'); // Frame of Reference Transformation Matrix
  if (!raw) return null;
  const values = raw.split('\\').map(Number);
  if (values.length < 16 || values.some((n) => Number.isNaN(n))) return null;
  return values.slice(0, 16);
}

/** Read Vector Grid Data (OF, 32-bit float) into a copied, aligned {@link Float32Array}. */
function readVectorGrid(dataSet: dicomParser.DataSet, tag: string): Float32Array | null {
  const element = dataSet.elements[tag];
  if (!element || element.length === undefined) return null;
  const start = dataSet.byteArray.byteOffset + element.dataOffset;
  const count = Math.floor(element.length / 4);
  // Copy out so the view is 4-byte aligned regardless of the element's file offset;
  // OF is little-endian (explicit VR LE), matching Float32Array on our platforms.
  const bytes = dataSet.byteArray.buffer.slice(start, start + count * 4);
  return new Float32Array(bytes);
}

/** A 3-value DS tag as a {@link Vec3}, missing components defaulting to 0. */
function vec3At(dataSet: dicomParser.DataSet, tag: string): Vec3 {
  return [
    dataSet.floatString(tag, 0) ?? 0,
    dataSet.floatString(tag, 1) ?? 0,
    dataSet.floatString(tag, 2) ?? 0,
  ];
}

/** A 6-value orientation DS tag, or the axis-aligned identity when absent. */
function orientationAt(dataSet: dicomParser.DataSet, tag: string): number[] {
  if (!dataSet.elements[tag]) return [1, 0, 0, 0, 1, 0];
  const identity = [1, 0, 0, 0, 1, 0];
  return identity.map((fallback, i) => dataSet.floatString(tag, i) ?? fallback);
}

/** An unsigned-integer tag value (UL, falling back to an integer string), or 0. */
function uintAt(dataSet: dicomParser.DataSet, tag: string, index: number): number {
  const u = dataSet.uint32(tag, index);
  if (u !== undefined) return u;
  const s = dataSet.intString(tag, index);
  return s ?? 0;
}

/** A double tag value (FD, falling back to a decimal string), defaulting to 1mm. */
function doubleAt(dataSet: dicomParser.DataSet, tag: string, index: number): number {
  const d = dataSet.double(tag, index);
  if (d !== undefined) return d;
  return dataSet.floatString(tag, index) ?? 1;
}
