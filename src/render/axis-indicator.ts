import type { Vec3 } from '../dicom/types';
import { dot } from '../dicom/vec3';
import { viewBasis } from './camera';

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
