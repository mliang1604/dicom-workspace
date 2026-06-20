import * as dicomParser from 'dicom-parser';
import type { Contour, Roi, StructureSet, Vec3 } from './types';

/** SOP Class UID identifying an RT Structure Set Storage object. */
const RTSTRUCT_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.3';

/**
 * Parse a DICOM RTSTRUCT file into a typed {@link StructureSet}, or return null
 * for any file that is not an RT Structure Set.
 *
 * RTSTRUCT objects carry no PixelData, so they never reach the image
 * {@link import('./loader').parseFile} path (which returns `[]` without pixels).
 * This is the separate entry point: it recognises the RTSTRUCT SOP class /
 * modality, then joins the three top-level sequences that describe each ROI —
 * Structure Set ROI Sequence (identity), ROI Contour Sequence (colour +
 * contours), and RT ROI Observations Sequence (interpreted type) — keyed by ROI
 * Number.
 */
export function parseStructureSet(name: string, buffer: ArrayBuffer): StructureSet | null {
  let dataSet: dicomParser.DataSet;
  try {
    dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
  } catch {
    return null; // Not a parseable DICOM file.
  }
  if (!isStructureSet(dataSet)) return null;

  // Structure Set ROI Sequence (3006,0020): one item per ROI — its number, name
  // and referenced frame of reference. This seeds an ROI keyed by ROI Number.
  const rois = new Map<number, MutableRoi>();
  const order: number[] = [];
  for (const item of items(dataSet, 'x30060020')) {
    const number = item.intString('x30060022'); // ROI Number
    if (number === undefined) continue;
    rois.set(number, {
      number,
      name: item.string('x30060026')?.trim() ?? '', // ROI Name
      color: null,
      interpretedType: null,
      contours: [],
    });
    order.push(number);
  }

  // ROI Contour Sequence (3006,0039): per ROI, the display colour and the
  // Contour Sequence, joined back by Referenced ROI Number (3006,0084).
  for (const item of items(dataSet, 'x30060039')) {
    const number = item.intString('x30060084'); // Referenced ROI Number
    if (number === undefined) continue;
    const roi = rois.get(number);
    if (!roi) continue;
    roi.color = readColor(item, 'x3006002a'); // ROI Display Color
    roi.contours = readContours(item);
  }

  // RT ROI Observations Sequence (3006,0080): the interpreted type per ROI,
  // joined by Referenced ROI Number (3006,0082).
  for (const item of items(dataSet, 'x30060080')) {
    const number = item.intString('x30060082'); // Referenced ROI Number
    if (number === undefined) continue;
    const roi = rois.get(number);
    if (!roi) continue;
    roi.interpretedType = item.string('x300600a4')?.trim() || null; // RT ROI Interpreted Type
  }

  return {
    name,
    label: dataSet.string('x30060002')?.trim() || null, // Structure Set Label
    rois: order.map((number) => freeze(rois.get(number)!)),
  };
}

/** An ROI under construction, before it is frozen into a {@link Roi}. */
interface MutableRoi {
  number: number;
  name: string;
  color: readonly [number, number, number] | null;
  interpretedType: string | null;
  contours: readonly Contour[];
}

function freeze(roi: MutableRoi): Roi {
  return {
    number: roi.number,
    name: roi.name,
    color: roi.color,
    interpretedType: roi.interpretedType,
    contours: roi.contours,
  };
}

/**
 * Recognise an RT Structure Set: the SOP Class UID (or its media-storage twin)
 * is the RTSTRUCT class, or the Modality is `RTSTRUCT`. Either is sufficient.
 */
function isStructureSet(dataSet: dicomParser.DataSet): boolean {
  const sopClass = dataSet.string('x00080016') ?? dataSet.string('x00020002'); // SOPClassUID / MediaStorage
  if (sopClass?.trim() === RTSTRUCT_SOP_CLASS) return true;
  return dataSet.string('x00080060')?.trim().toUpperCase() === 'RTSTRUCT'; // Modality
}

/** The nested data sets of a sequence element, in file order (empty when absent). */
function items(dataSet: dicomParser.DataSet, tag: string): dicomParser.DataSet[] {
  const seq = dataSet.elements[tag]?.items ?? [];
  return seq.map((item) => item.dataSet).filter((ds): ds is dicomParser.DataSet => !!ds);
}

/** Read a 3-value IS colour tag as `[r, g, b]` in 0–255, or null when absent. */
function readColor(
  dataSet: dicomParser.DataSet,
  tag: string,
): readonly [number, number, number] | null {
  if (!dataSet.elements[tag]) return null;
  const r = dataSet.intString(tag, 0);
  const g = dataSet.intString(tag, 1);
  const b = dataSet.intString(tag, 2);
  if (r === undefined || g === undefined || b === undefined) return null;
  return [r, g, b];
}

/** Read the Contour Sequence (3006,0040) of one ROI Contour item. */
function readContours(roiContour: dicomParser.DataSet): Contour[] {
  const contours: Contour[] = [];
  for (const contour of items(roiContour, 'x30060040')) {
    contours.push({
      geometricType: contour.string('x30060042')?.trim() ?? '', // Contour Geometric Type
      points: readContourData(contour, 'x30060050'), // Contour Data
    });
  }
  return contours;
}

/**
 * Read Contour Data (3006,0050) — a backslash-separated `x\y\z…` decimal string
 * — into patient-space triplets, dropping any trailing partial point.
 */
function readContourData(dataSet: dicomParser.DataSet, tag: string): Vec3[] {
  const raw = dataSet.string(tag);
  if (!raw) return [];
  const values = raw.split('\\').map(Number);
  const points: Vec3[] = [];
  for (let i = 0; i + 2 < values.length; i += 3) {
    points.push([values[i], values[i + 1], values[i + 2]]);
  }
  return points;
}
