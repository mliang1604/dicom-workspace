import type { DicomMetadata } from './metadata';
import type { Slice } from './types';

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

/** Order series by SeriesNumber (absent last), then by UID for stability. */
function compareSeries(a: Series, b: Series): number {
  const an = a.seriesNumber ?? Infinity;
  const bn = b.seriesNumber ?? Infinity;
  if (an !== bn) return an - bn;
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}
