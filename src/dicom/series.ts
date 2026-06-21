import type { DicomMetadata } from './metadata';
import type { Slice } from './types';
import { cross } from './vec3';

/**
 * One DICOM series: a set of slices sharing a SeriesInstanceUID, with the
 * descriptive fields a picker needs plus the slices themselves (so a selected
 * series can be assembled into a {@link Volume} without re-reading files).
 */
export interface Series {
  /** SeriesInstanceUID; the empty string for slices that carry no UID. */
  readonly uid: string;
  /** SeriesNumber, used to order the picker; null when absent. */
  readonly seriesNumber: number | null;
  /** SeriesDescription for the label; null when absent. */
  readonly description: string | null;
  /** Modality of the series (taken from its first slice); null when absent. */
  readonly modality: string | null;
  /**
   * StudyInstanceUID shared by the series' slices (taken from its first slice);
   * null when absent. {@link import('./catalog').groupStudies} groups series by
   * this into a {@link import('./catalog').StudyRecord}.
   */
  readonly studyUid: string | null;
  /** StudyDate (raw DICOM `DA`, `YYYYMMDD`) of the first slice; null when absent. */
  readonly studyDate: string | null;
  /** StudyTime (raw DICOM `TM`) of the first slice; null when absent. */
  readonly studyTime: string | null;
  /** StudyDescription of the first slice, labelling the study; null when absent. */
  readonly studyDescription: string | null;
  /**
   * PatientID of the first slice; null when absent.
   * {@link import('./catalog').groupPatients} groups series by this.
   */
  readonly patientId: string | null;
  /** PatientName (raw DICOM `PN`) of the first slice; null when absent. */
  readonly patientName: string | null;
  /**
   * FrameOfReferenceUID shared by the series' slices (taken from its first
   * slice); null when absent. An RTSTRUCT is associated to this series by
   * matching its referenced frame of reference against this value.
   */
  readonly frameOfReferenceUid: string | null;
  /** Number of image slices in the series. */
  readonly imageCount: number;
  /** Representative in-plane dimensions [columns, rows] of the first slice. */
  readonly dims: readonly [number, number];
  /** Captured DICOM metadata of the first slice, for the info panel; null if absent. */
  readonly metadata: DicomMetadata | null;
  /** The slices, in the order encountered; {@link buildVolume} re-sorts them. */
  readonly slices: Slice[];
}

/**
 * Group a flat list of parsed slices into series by SeriesInstanceUID.
 *
 * A folder usually holds several series (different acquisitions, orientations,
 * or reconstructions) that cannot share one volume; this splits them so each
 * can be built and viewed on its own. Slices without a UID fall into a single
 * unnamed group. Series are ordered by SeriesNumber ascending (those without a
 * number sort last), tie-broken by UID, so the picker reads in acquisition order.
 */
export function groupSeries(slices: readonly Slice[]): Series[] {
  const byUid = new Map<string, Slice[]>();
  for (const slice of slices) {
    const uid = slice.seriesUid ?? '';
    const group = byUid.get(uid);
    if (group) group.push(slice);
    else byUid.set(uid, [slice]);
  }

  const series: Series[] = [];
  for (const [uid, group] of byUid) {
    const first = group[0];
    series.push({
      uid,
      seriesNumber: first.seriesNumber,
      description: first.seriesDescription,
      modality: first.modality,
      studyUid: first.studyUid,
      studyDate: first.studyDate,
      studyTime: first.studyTime,
      studyDescription: first.studyDescription,
      patientId: first.patientId,
      patientName: first.patientName,
      frameOfReferenceUid: first.frameOfReferenceUid,
      imageCount: group.length,
      dims: [first.columns, first.rows],
      metadata: first.metadata ?? null,
      slices: group,
    });
  }

  return series.sort(compareSeries);
}

/**
 * The series to show first: the one with the most images (the primary
 * acquisition in a typical mixed folder), tie-broken by the picker order so the
 * choice is deterministic. Throws nothing; callers guarantee a non-empty list.
 */
export function largestSeries(series: readonly Series[]): Series {
  return series.reduce((best, s) =>
    s.imageCount > best.imageCount ||
    (s.imageCount === best.imageCount && compareSeries(s, best) < 0)
      ? s
      : best,
  );
}

/**
 * The middle slice of a series: its spatially central image, the natural
 * representative for a preview thumbnail. Slices are ordered along the
 * through-plane axis by ImagePositionPatient projected onto the slice normal
 * when spatial metadata is present, falling back to InstanceNumber — the same
 * ordering {@link import('./volume').buildVolume} uses — and the central one is
 * returned. Returns null for a series with no slices. The series' own array is
 * left untouched (the ordering is done on a copy).
 */
export function middleSlice(series: Series): Slice | null {
  const { slices } = series;
  if (slices.length === 0) return null;
  const ordered = orderSlices(slices);
  return ordered[Math.floor(ordered.length / 2)];
}

/**
 * Order slices through-plane: by ImagePositionPatient projected onto the slice
 * normal when every slice carries a position and the first carries an
 * orientation, else by InstanceNumber. Mirrors the private ordering in
 * {@link import('./volume').buildVolume} so a thumbnail's middle slice matches
 * the volume's central plane.
 */
function orderSlices(slices: readonly Slice[]): Slice[] {
  const first = slices[0];
  if (first.orientation && slices.every((s) => s.position)) {
    const normal = cross(first.orientation.slice(0, 3), first.orientation.slice(3, 6));
    const proj = (s: Slice) =>
      s.position![0] * normal[0] + s.position![1] * normal[1] + s.position![2] * normal[2];
    return [...slices].sort((a, b) => proj(a) - proj(b));
  }
  return [...slices].sort((a, b) => a.instanceNumber - b.instanceNumber);
}

/** Order series by SeriesNumber (absent last), then by UID for stability. */
function compareSeries(a: Series, b: Series): number {
  const an = a.seriesNumber ?? Infinity;
  const bn = b.seriesNumber ?? Infinity;
  if (an !== bn) return an - bn;
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}
