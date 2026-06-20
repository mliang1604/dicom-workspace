import * as dicomParser from 'dicom-parser';
import type { Series } from './series';
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
  let roiFrameOfReference: string | null = null;
  for (const item of items(dataSet, 'x30060020')) {
    const number = item.intString('x30060022'); // ROI Number
    if (number === undefined) continue;
    // Referenced Frame of Reference UID (3006,0024): the frame the ROI's contour
    // points live in. All ROIs normally share one; keep the first seen as the
    // fallback when the top-level reference sequence is absent.
    roiFrameOfReference ??= item.string('x30060024')?.trim() || null;
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

  const references = readReferences(dataSet);

  return {
    name,
    label: dataSet.string('x30060002')?.trim() || null, // Structure Set Label
    frameOfReferenceUid: references.frameOfReferenceUid ?? roiFrameOfReference,
    referencedSeriesUids: references.referencedSeriesUids,
    rois: order.map((number) => freeze(rois.get(number)!)),
  };
}

/**
 * Walk the Referenced Frame of Reference Sequence (3006,0010) for the frame of
 * reference and the referenced Series Instance UIDs that tie a structure set to
 * its image series. The frame of reference is the primary association key; the
 * series UIDs are the fallback.
 *
 * Nesting: Referenced Frame of Reference Sequence (3006,0010) → Frame of
 * Reference UID (0020,0052), and within it RT Referenced Study Sequence
 * (3006,0012) → RT Referenced Series Sequence (3006,0014) → Series Instance UID
 * (0020,000E).
 */
function readReferences(dataSet: dicomParser.DataSet): {
  frameOfReferenceUid: string | null;
  referencedSeriesUids: string[];
} {
  let frameOfReferenceUid: string | null = null;
  const seriesUids = new Set<string>();
  for (const frameRef of items(dataSet, 'x30060010')) {
    frameOfReferenceUid ??= frameRef.string('x00200052')?.trim() || null; // Frame of Reference UID
    for (const study of items(frameRef, 'x30060012')) {
      for (const series of items(study, 'x30060014')) {
        const uid = series.string('x0020000e')?.trim(); // Series Instance UID
        if (uid) seriesUids.add(uid);
      }
    }
  }
  return { frameOfReferenceUid, referencedSeriesUids: [...seriesUids] };
}

/**
 * Pick the structure sets that annotate a given {@link Series}.
 *
 * Primary match: the structure set's referenced Frame of Reference UID equals
 * the series' (RTSTRUCT 3006,0024 / 3006,0010 vs series 0020,0052) — the
 * spatial frame both share, so the contour points already live in the series'
 * coordinate system. Fallback (when the frame of reference is absent on either
 * side, or doesn't match): the structure set names the series in its RT
 * Referenced Series Sequence (0020,000E). A structure set with no usable
 * reference is left unassociated rather than guessed onto a series.
 */
export function structureSetsForSeries(
  structureSets: readonly StructureSet[],
  series: Series,
): StructureSet[] {
  return structureSets.filter((ss) => associates(ss, series));
}

/** Whether a structure set annotates a series by frame of reference or, failing that, by referenced series UID. */
function associates(ss: StructureSet, series: Series): boolean {
  if (ss.frameOfReferenceUid && series.frameOfReferenceUid) {
    if (ss.frameOfReferenceUid === series.frameOfReferenceUid) return true;
  }
  return series.uid !== '' && ss.referencedSeriesUids.includes(series.uid);
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
