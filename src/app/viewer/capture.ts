/**
 * Pure helpers for the export features: naming a downloaded capture from the
 * series metadata, choosing a video container the browser can record, and the
 * orbit angles of a one-revolution spin. The DOM/WebGPU/MediaRecorder plumbing
 * that uses these lives in the viewer; everything here is side-effect free so it
 * can be unit-tested without a GPU or a browser.
 */

/** The series fields used to name a capture, drawn from the displayed series. */
export interface CaptureNaming {
  /** SeriesDescription, when present. */
  readonly description?: string | null;
  /** Modality (CT, MR, …), when present. */
  readonly modality?: string | null;
  /** SeriesNumber, used as a fallback label when there is no description. */
  readonly seriesNumber?: number | null;
}

/**
 * Lowercase a label into a filesystem-safe slug: runs of non-alphanumeric
 * characters collapse to single hyphens, with leading/trailing hyphens trimmed.
 * Returns '' for a label with nothing usable, so callers can drop it.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A `YYYYMMDD-HHMMSS` stamp from a date, for ordering downloads chronologically.
 * Pure over its argument (the caller supplies `new Date()`), so the format is
 * unit-testable with a fixed instant.
 */
export function timestampSlug(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}`;
}

/**
 * Build a download filename from the series naming, a view tag (e.g. `axial` or
 * `rotation`), the file extension, and a timestamp. Empty parts are dropped and
 * the rest joined with hyphens; a series with no usable name falls back to a
 * fixed base so a file is always produced.
 */
export function captureFilename(
  naming: CaptureNaming | null,
  view: string,
  extension: string,
  timestamp: string,
): string {
  const descriptionSource =
    naming?.description ?? (naming?.seriesNumber != null ? `series ${naming.seriesNumber}` : null);
  const parts = [
    naming?.modality ? slugify(naming.modality) : '',
    descriptionSource ? slugify(descriptionSource) : '',
    slugify(view),
    timestamp,
  ].filter((part) => part.length > 0);
  const base = parts.join('-') || 'dicom-capture';
  return `${base}.${extension}`;
}

/**
 * The azimuth angles (radians) of one full revolution, beginning at `start`:
 * `frames` evenly spaced steps over 2π, stopping one step short of a complete
 * turn so the clip loops seamlessly back to its first frame. `frames` is floored
 * to at least one.
 */
export function rotationAzimuths(start: number, frames: number): number[] {
  const count = Math.max(1, Math.floor(frames));
  const step = (2 * Math.PI) / count;
  return Array.from({ length: count }, (_, i) => start + i * step);
}

/**
 * The pane a capture targets: the hovered pane when one is under the cursor, else
 * the first (main) pane. Generic over the pane shape — the caller supplies its own
 * pane type and key function — so the selection is testable without the component.
 * Returns null when there are no panes.
 */
export function pickCaptureTarget<T>(
  panes: readonly T[],
  hoveredKey: string | null,
  keyOf: (pane: T) => string,
): T | null {
  if (hoveredKey) {
    const found = panes.find((pane) => keyOf(pane) === hoveredKey);
    if (found) return found;
  }
  return panes[0] ?? null;
}

/**
 * The first candidate MIME type the recorder supports, or null when none is.
 * Lets the viewer prefer a modern codec (VP9) and fall back to older containers
 * without hard-coding the probe, which keeps it testable.
 */
export function pickVideoMimeType(
  candidates: readonly string[],
  isSupported: (type: string) => boolean,
): string | null {
  for (const candidate of candidates) {
    if (isSupported(candidate)) return candidate;
  }
  return null;
}
