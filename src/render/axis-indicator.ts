import type { Vec3 } from '../dicom/types';
import { dot } from '../dicom/vec3';
import { viewBasis } from './camera';
import type { PaneRect } from './layout';

/**
 * Pure maths for the 3D pane's anatomical orientation indicator.
 *
 * The 3D MIP orbits the patient, which makes it easy to lose track of which way
 * is up. This projects the six DICOM patient axes — R/L, A/P, S/I — onto the
 * orbit camera's screen plane so a small overlay can draw them, rotating live
 * with the view. The geometry is the camera's own screen basis ({@link
 * viewBasis}), so the indicator and the raycast can never drift apart.
 *
 * Conventions match the MPR panes: patient space is DICOM LPS (+x left, +y
 * posterior, +z superior).
 */

/** One patient axis projected onto the 3D pane's screen plane. */
export interface AxisMarker {
  /** Single-letter patient direction: R, L, A, P, S, or I. */
  readonly label: string;
  /** Horizontal position in [-1, 1]; +1 points to the pane's right edge. */
  readonly x: number;
  /** Vertical position in [-1, 1]; +1 points to the pane's top edge. */
  readonly y: number;
  /**
   * Depth toward the viewer in [-1, 1]: +1 points straight out of the screen,
   * −1 straight into it. Lets the overlay fade axes that point away and draw the
   * near ones on top.
   */
  readonly depth: number;
}

/** The six LPS patient axes and their anatomical labels. */
const AXES: readonly { readonly label: string; readonly dir: Vec3 }[] = [
  { label: 'L', dir: [1, 0, 0] }, // +x patient-left
  { label: 'R', dir: [-1, 0, 0] }, // −x patient-right
  { label: 'P', dir: [0, 1, 0] }, // +y posterior
  { label: 'A', dir: [0, -1, 0] }, // −y anterior
  { label: 'S', dir: [0, 0, 1] }, // +z superior
  { label: 'I', dir: [0, 0, -1] }, // −z inferior
];

/**
 * Project the six patient axes onto the orbit camera's screen plane for the
 * given orbit angles. Each marker's (x, y) is the axis direction resolved onto
 * the camera right/up vectors (so +x is screen-right, +y is screen-up), and
 * `depth` is how far it tilts toward the viewer. Because the axes are unit
 * vectors, every component already lies in [-1, 1].
 */
export function axisMarkers(azimuth: number, elevation: number): AxisMarker[] {
  const { right, up, forward } = viewBasis(azimuth, elevation);
  return AXES.map(({ label, dir }) => ({
    label,
    x: dot(dir, right),
    y: dot(dir, up),
    // forward points into the screen, so negate to make +depth toward the viewer.
    depth: -dot(dir, forward),
  }));
}

/** Square size (CSS px) of the 3D pane's orientation indicator widget. */
const AXIS_INDICATOR_SIZE = 72;
/** Length (CSS px) of each axis spoke from the indicator's hub to its label. */
const AXIS_INDICATOR_RADIUS = 24;
/** Inset (CSS px) of the indicator from the 3D pane's top-right corner. */
const AXIS_INDICATOR_MARGIN = 12;

/** One projected patient axis, placed in the indicator widget's local pixels. */
export interface AxisIndicatorMarker {
  /** R, L, A, P, S, or I. */
  readonly label: string;
  /** Label centre in widget-local CSS pixels (origin at the widget's top-left). */
  readonly x: number;
  readonly y: number;
  /** 0–1 opacity: axes pointing toward the viewer are bright, those behind fade. */
  readonly opacity: number;
}

/** The orientation indicator overlaid in a corner of the 3D pane. */
export interface AxisIndicatorOverlay {
  /** Widget top-left in CSS pixels relative to the canvas. */
  readonly left: number;
  readonly top: number;
  /** Square widget size in CSS pixels. */
  readonly size: number;
  /** Widget-local centre (the axis hub) in CSS pixels. */
  readonly center: number;
  /** The six axes, sorted far-to-near so near labels render on top. */
  readonly markers: readonly AxisIndicatorMarker[];
}

/**
 * Lay out the anatomical orientation indicator in the top-right corner of the 3D
 * pane `rect`: project the six patient axes ({@link axisMarkers}) onto the orbit
 * camera's screen plane, place each on a spoke of {@link AXIS_INDICATOR_RADIUS}
 * (widget-local pixels, +y up flipped to CSS down), fade the away-facing axes,
 * and sort far-to-near so near labels draw on top. Pure presentation geometry —
 * keyed only off the camera angles and the pane rectangle — so the viewer can
 * render it as a CSS/SVG overlay without a GPU pass.
 */
export function axisIndicatorGeometry(
  rect: PaneRect,
  azimuth: number,
  elevation: number,
): AxisIndicatorOverlay {
  const size = AXIS_INDICATOR_SIZE;
  const center = size / 2;
  const left = rect.x + rect.width - AXIS_INDICATOR_MARGIN - size;
  const top = rect.y + AXIS_INDICATOR_MARGIN;

  const markers = axisMarkers(azimuth, elevation)
    // Paint far axes first so the near labels (drawn last) sit on top.
    .sort((a, b) => a.depth - b.depth)
    .map((axis) => ({
      label: axis.label,
      // Widget-local pixels: +x is screen-right, +y (up) flips to CSS down.
      x: center + axis.x * AXIS_INDICATOR_RADIUS,
      y: center - axis.y * AXIS_INDICATOR_RADIUS,
      // Fade the away-facing axes; keep the near ones fully opaque.
      opacity: 0.35 + 0.65 * ((axis.depth + 1) / 2),
    }));
  return { left, top, size, center, markers };
}

/**
 * The single-letter patient direction (R/L/A/P/S/I) a vector points most nearly
 * along — the same LPS axis labels the 3D cube draws. Shared with the 2D pane
 * edge labels so both overlays name anatomical directions identically.
 */
export function directionLetter(dir: Vec3): string {
  let best = AXES[0];
  let bestDot = -Infinity;
  for (const axis of AXES) {
    const d = dot(dir, axis.dir);
    if (d > bestDot) {
      bestDot = d;
      best = axis;
    }
  }
  return best.label;
}
