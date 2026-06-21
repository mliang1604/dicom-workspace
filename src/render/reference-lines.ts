import { Orientation, type Volume } from '../dicom/types';
import type { PaneRect, Vec2 } from './layout';
import { planePointToPane } from './pane-coords';
import { clipLineToUnitSquare, referenceLine, type ObliqueRotation } from './reslice';

/**
 * Cross-pane reference-line geometry for the MPR panes.
 *
 * For each MPR pane this finds where every *other* in-group pane's (possibly
 * oblique) plane crosses it: {@link referenceLine} gives the crossing as an
 * implicit line in the target pane's plane coordinates, {@link clipLineToUnitSquare}
 * trims it to the visible slice, and {@link planePointToPane} projects the two
 * ends through the live pan/letterbox/zoom/flip into pane pixels — the exact same
 * geometry the slice shader and probe use, so the lines land where the planes
 * actually meet and tilt live as a plane is made oblique.
 */

/** One MPR pane the reference lines are drawn over (a subset of the layout pane). */
export interface ReferenceLinePane {
  readonly orientation: Orientation;
  /** The pane's rectangle in CSS pixels. */
  readonly rect: PaneRect;
  /** Compare-group index; only panes in the same group are paired. */
  readonly group: number;
}

/** A reference line drawn over an MPR pane where another plane crosses it. */
export interface ReferenceLineGeometry {
  /** Stable key: the target group and the two orientations it pairs. */
  readonly key: string;
  /** The target pane's rectangle in CSS pixels; the overlay is clipped to it. */
  readonly rect: PaneRect;
  /** Endpoints of the line in CSS pixels relative to the canvas. */
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Colour of the crossing plane, matching its 3D cut-plane outline. */
  readonly color: string;
}

/** A value per orientation, indexed by the orientation's numeric value. */
type PerOrientation = readonly [number, number, number];

/**
 * Build the reference-line overlays for the given MPR `panes`. Each pair of
 * different-orientation panes in the same compare group contributes a line where
 * the `other` plane crosses the `into` pane (cross-column pairs between two
 * layers aren't meaningful and are skipped). Endpoints come from the live
 * `indices`/`obliques`/`zooms`/`pans` and the sagittal `flipped` toggle; each
 * line is coloured by the crossing plane's `colors` entry. Pairs whose planes are
 * parallel, fall outside the slice, or project off a degenerate pane are dropped.
 */
export function referenceLineGeometry(
  volume: Volume,
  panes: readonly ReferenceLinePane[],
  indices: PerOrientation,
  obliques: readonly [ObliqueRotation, ObliqueRotation, ObliqueRotation],
  zooms: PerOrientation,
  pans: readonly [Vec2, Vec2, Vec2],
  flipped: boolean,
  colors: readonly [string, string, string],
): ReferenceLineGeometry[] {
  const result: ReferenceLineGeometry[] = [];
  for (const into of panes) {
    const intoFlip = into.orientation === Orientation.Sagittal && flipped;
    for (const other of panes) {
      // Only pair planes within the same compare group; cross-column reference
      // lines (between two different layers) aren't meaningful.
      if (other.orientation === into.orientation || other.group !== into.group) continue;
      const line = referenceLine(
        volume,
        {
          orientation: into.orientation,
          sliceIndex: indices[into.orientation],
          rotation: obliques[into.orientation],
        },
        {
          orientation: other.orientation,
          sliceIndex: indices[other.orientation],
          rotation: obliques[other.orientation],
        },
      );
      if (!line) continue;
      const ends = clipLineToUnitSquare(line);
      if (!ends) continue;
      const a = planePointToPane(
        volume,
        into.orientation,
        ends[0],
        zooms[into.orientation],
        into.rect,
        intoFlip,
        pans[into.orientation],
      );
      const b = planePointToPane(
        volume,
        into.orientation,
        ends[1],
        zooms[into.orientation],
        into.rect,
        intoFlip,
        pans[into.orientation],
      );
      if (!a || !b) continue;
      result.push({
        key: `${into.group}-${into.orientation}-${other.orientation}`,
        rect: into.rect,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        color: colors[other.orientation],
      });
    }
  }
  return result;
}
