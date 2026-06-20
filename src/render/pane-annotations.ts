import { Orientation } from '../dicom/types';
import { scale } from '../dicom/vec3';
import { directionLetter } from './axis-indicator';
import { planeAxisDirs } from './reslice';

/**
 * Pure maths for the 2D pane overlays: anatomical edge labels and a physical
 * scale bar.
 *
 * The edge labels reuse the reslice's plane axes ({@link planeAxisDirs}) and the
 * 3D cube's letter mapping ({@link directionLetter}), so all three overlays agree
 * on the DICOM LPS conventions. The scale bar derives screen millimetres from the
 * same letterbox/zoom fit the shader and probe use. Keeping the geometry here lets
 * it be unit-tested without a GPU or DOM.
 */

/** Patient-direction letters (R/L/A/P/S/I) at a 2D pane's four edges. */
export interface PaneEdgeLabels {
  readonly top: string;
  readonly bottom: string;
  readonly left: string;
  readonly right: string;
}

/**
 * The anatomical direction letter at each edge of an MPR pane, following the same
 * LPS display convention as the reslice and the 3D cube. `flipX` mirrors the
 * horizontal axis (the sagittal anterior-left/right flip), swapping the left and
 * right letters. Pure and volume-independent: it depends only on the orientation
 * and flip, so it tracks the swap (which pane shows which orientation) and the
 * flip toggle for free.
 */
export function paneEdgeLabels(orientation: Orientation, flipX = false): PaneEdgeLabels {
  const { right, down } = planeAxisDirs(orientation);
  const r = flipX ? scale(right, -1) : right;
  return {
    right: directionLetter(r),
    left: directionLetter(scale(r, -1)),
    bottom: directionLetter(down),
    top: directionLetter(scale(down, -1)),
  };
}

/**
 * Physical millimetres spanned by one CSS pixel in a letterboxed, zoomed MPR
 * pane. The plane is aspect-fit to *contain* the pane, so the limiting (larger) of
 * the two mm-per-pixel ratios sets the isotropic on-screen scale, and the zoom
 * magnifies it — matching {@link aspectScale} in the shader and probe. Returns 0
 * for a degenerate pane.
 */
export function mmPerScreenPixel(
  planeWidthMm: number,
  planeHeightMm: number,
  paneWidthPx: number,
  paneHeightPx: number,
  zoom: number,
): number {
  if (paneWidthPx <= 0 || paneHeightPx <= 0) return 0;
  const z = zoom > 0 ? zoom : 1;
  return Math.max(planeWidthMm / paneWidthPx, planeHeightMm / paneHeightPx) / z;
}

/** A physical scale bar: its on-screen length and rounded mm/cm label. */
export interface ScaleBar {
  /** Bar length in CSS pixels (≤ the requested maximum). */
  readonly lengthPx: number;
  /** Physical length the bar represents, in mm. */
  readonly lengthMm: number;
  /** Human label in nice round units, e.g. "5 cm" or "10 mm". */
  readonly label: string;
}

/**
 * A scale bar no longer than `maxLengthPx`, snapped to a nice round physical
 * length (a 1/2/5 × 10ⁿ step) and labelled in mm or cm. Returns null when the
 * inputs can't yield a positive bar (no volume scale, zero-width pane). Pure, so
 * the rounding and labelling are unit-tested directly.
 */
export function scaleBar(mmPerPixel: number, maxLengthPx: number): ScaleBar | null {
  if (!(mmPerPixel > 0) || !(maxLengthPx > 0)) return null;
  const lengthMm = niceLength(mmPerPixel * maxLengthPx);
  if (!(lengthMm > 0)) return null;
  return { lengthPx: lengthMm / mmPerPixel, lengthMm, label: formatLength(lengthMm) };
}

/** Largest 1/2/5 × 10ⁿ value not exceeding `maxMm` (0 for non-positive input). */
function niceLength(maxMm: number): number {
  if (!(maxMm > 0)) return 0;
  const decade = Math.pow(10, Math.floor(Math.log10(maxMm)));
  for (const step of [5, 2, 1]) {
    if (step * decade <= maxMm) return step * decade;
  }
  return decade; // unreachable: 1×decade ≤ maxMm always holds
}

/** Label a nice length: cm at ≥10 mm, otherwise mm, trimming trailing zeros. */
function formatLength(mm: number): string {
  return mm >= 10 ? `${trim(mm / 10)} cm` : `${trim(mm)} mm`;
}

function trim(value: number): string {
  return Number(value.toFixed(2)).toString();
}
