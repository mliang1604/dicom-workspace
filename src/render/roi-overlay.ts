import { Orientation, type StructureSet, type Volume } from '../dicom/types';
import type { PaneRect, Vec2 } from './layout';
import { planePointToPane } from './pane-coords';
import {
  classifyContour,
  crossSectionOutline,
  decimate,
  projectContour,
  type ContourCoords,
  type ContourPolyline,
  type CrossSectionRow,
} from './contours';
import type { ObliqueRotation } from './reslice';

/**
 * The RTSTRUCT ROI contour overlay chain, as pure functions over plain inputs.
 *
 * Drawing the contours over the MPR panes is a three-stage pipeline, split where
 * the cost is so each stage recomputes only when its own inputs change:
 *   1. {@link roiContourCoords} — the expensive, slice-independent projection of
 *      every contour into each orientation's plane frame ({@link projectContour}).
 *      Recompute only on a volume / structure-set / oblique-tilt change.
 *   2. {@link roiPlaneShapes} — the cheap per-slice classification of the cached
 *      coords against the current slice, with ROI visibility / colour / opacity
 *      applied. Recompute on slice scroll or a visibility / colour change.
 *   3. {@link roiScreenShapes} — projecting the plane-space shapes to pane pixels
 *      under the current zoom / pan / flip ({@link planePointToPane}). Recompute on
 *      pan / zoom / flip, never re-projecting any patient point.
 *
 * Splitting the chain this way keeps a window/level or 3D-camera change from
 * re-sweeping the contours, and keeps the geometry unit-testable without a GPU or
 * the component. The leaf maths lives in {@link ./contours} and {@link ./pane-coords};
 * this module is the load-bearing assembly that joins them.
 */

/** One ROI's contours projected into a pane's plane frame — slice-independent (cached). */
export interface RoiContourCoords {
  readonly setIndex: number;
  readonly roiNumber: number;
  /** The ROI's display colour as a CSS colour (overrides applied later). */
  readonly baseColor: string;
  readonly contours: readonly ContourCoords[];
}

/** One ROI's contour geometry for a pane, in plane `(u, v)` — pan/zoom-independent. */
export interface RoiPlaneShapes {
  /** ROI key (see {@link roiKeyOf}); the `@for` track and the per-shape key prefix. */
  readonly key: string;
  readonly color: string;
  readonly opacity: number;
  /** Loops and the cross-section outline, in plane `(u, v)` coordinates. */
  readonly polylines: readonly ContourPolyline[];
}

/** One ROI contour shape projected into a pane, in pane-local pixels. */
export interface ContourShape {
  /** Stable key for the `@for` track (ROI + contour + sub-polyline indices). */
  readonly key: string;
  /** SVG `points` in pane-local pixels (origin at the pane's top-left). */
  readonly points: string;
  /** Whether to close the loop: a coplanar `CLOSED_PLANAR` contour (a `<polygon>`). */
  readonly closed: boolean;
  /** Stroke colour, the ROI's (possibly overridden) display colour as a CSS colour. */
  readonly color: string;
  /** Draw opacity in `[0, 1]`, from the ROI's opacity control. */
  readonly opacity: number;
}

/** All visible ROI contours projected onto one MPR pane, for one SVG overlay. */
export interface ContourPaneOverlay {
  /** Key of the pane it belongs to. */
  readonly key: string;
  /** The pane's rectangle in CSS pixels; the SVG is positioned and clipped to it. */
  readonly rect: PaneRect;
  /** The contour shapes drawn on this pane. */
  readonly shapes: readonly ContourShape[];
}

/** An MPR pane to project contours onto: its identity, orientation and rectangle. */
export interface RoiOverlayPane {
  readonly key: string;
  readonly orientation: Orientation;
  readonly rect: PaneRect;
}

/**
 * An ROI Display Color as a CSS `rgb()` string, falling back to a neutral grey
 * when the RTSTRUCT omitted the colour (3006,002A).
 */
export function rgbColor(color: readonly [number, number, number] | null): string {
  if (!color) return 'rgb(200, 200, 200)';
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/**
 * Stable identity for an ROI across the loaded structure sets, used by the panel
 * and the contour overlays to share one visibility / colour / opacity state.
 * Qualified by the structure set's index so equal ROI Numbers in two sets don't
 * collide.
 */
export function roiKeyOf(setIndex: number, roiNumber: number): string {
  return `${setIndex}:${roiNumber}`;
}

/** Whether a structure set is shown given the panel's selector (-1 means all). */
export function setIsShown(selectedSetIndex: number, setIndex: number): boolean {
  return selectedSetIndex < 0 || selectedSetIndex === setIndex;
}

/**
 * Project every ROI's contours into each MPR orientation's plane frame once — the
 * expensive, slice-independent half ({@link projectContour}, with each contour's
 * through-plane span precomputed). Pure over the volume, structure sets, the
 * orientations to project, and the per-orientation oblique tilt (indexed by the
 * {@link Orientation} value); independent of slice / pan / zoom / flip / window /
 * visibility, so callers cache it across all of those. Orientations with no
 * projectable contours are omitted from the result.
 */
export function roiContourCoords(
  volume: Volume,
  sets: readonly StructureSet[],
  orientations: readonly Orientation[],
  obliques: readonly ObliqueRotation[],
): Map<Orientation, RoiContourCoords[]> {
  const out = new Map<Orientation, RoiContourCoords[]>();
  if (sets.length === 0) return out;

  for (const orientation of orientations) {
    const rotation = obliques[orientation];
    const rois: RoiContourCoords[] = [];
    sets.forEach((ss, setIndex) => {
      for (const roi of ss.rois) {
        const contours: ContourCoords[] = [];
        for (const contour of roi.contours) {
          const closed =
            contour.geometricType !== 'OPEN_PLANAR' && contour.geometricType !== 'POINT';
          const projected = projectContour(volume, orientation, contour.points, closed, rotation);
          if (projected) contours.push(projected);
        }
        if (contours.length) {
          rois.push({ setIndex, roiNumber: roi.number, baseColor: rgbColor(roi.color), contours });
        }
      }
    });
    if (rois.length) out.set(orientation, rois);
  }
  return out;
}

/** Per-slice and ROI-display inputs for {@link roiPlaneShapes}. */
export interface RoiPlaneShapesOptions {
  /** Displayed slice index per orientation, indexed by the {@link Orientation} value. */
  readonly sliceIndices: readonly number[];
  /** Orientations whose panes are shown; others are skipped. */
  readonly shown: ReadonlySet<Orientation>;
  /** Keys ({@link roiKeyOf}) of ROIs hidden from the overlay. */
  readonly hidden: ReadonlySet<string>;
  /** Per-ROI colour overrides (CSS colour) keyed by {@link roiKeyOf}. */
  readonly colorOverrides: ReadonlyMap<string, string>;
  /** Per-ROI draw opacity in `[0, 1]` keyed by {@link roiKeyOf}. */
  readonly opacities: ReadonlyMap<string, number>;
  /** The structure-set selector (-1 shows all sets; see {@link setIsShown}). */
  readonly selectedSet: number;
  /** Ramer–Douglas–Peucker tolerance for coplanar loops, in plane `(u, v)` units. */
  readonly decimateTolerance: number;
}

/**
 * Classify the cached {@link roiContourCoords} against the current slice — the
 * cheap, per-scroll half. For each shown orientation it folds every visible ROI's
 * contours into plane-space loops (coplanar, decimated) and cross-section outlines
 * (crossing), and resolves the ROI's effective colour and opacity. Result is still
 * in plane `(u, v)`; {@link roiScreenShapes} maps it to pixels. Orientations and
 * ROIs that contribute no geometry are omitted.
 */
export function roiPlaneShapes(
  volume: Volume,
  coordsByOrientation: Map<Orientation, RoiContourCoords[]>,
  options: RoiPlaneShapesOptions,
): Map<Orientation, RoiPlaneShapes[]> {
  const out = new Map<Orientation, RoiPlaneShapes[]>();
  if (coordsByOrientation.size === 0) return out;

  const { sliceIndices, shown, hidden, colorOverrides, opacities, selectedSet, decimateTolerance } =
    options;

  for (const [orientation, rois] of coordsByOrientation) {
    if (!shown.has(orientation)) continue;
    const sliceIndex = sliceIndices[orientation];
    const roiShapes: RoiPlaneShapes[] = [];
    for (const roi of rois) {
      if (!setIsShown(selectedSet, roi.setIndex)) continue;
      const key = roiKeyOf(roi.setIndex, roi.roiNumber);
      if (hidden.has(key)) continue;

      const loops: ContourPolyline[] = [];
      const rows: CrossSectionRow[] = [];
      for (const c of roi.contours) {
        const res = classifyContour(c, volume, orientation, sliceIndex);
        if (!res) continue;
        if (res.kind === 'loop') {
          loops.push({ points: decimate(res.points, decimateTolerance), closed: res.closed });
        } else {
          rows.push(res.row);
        }
      }

      const polylines = [...loops, ...crossSectionOutline(rows)];
      if (polylines.length === 0) continue;
      roiShapes.push({
        key,
        color: colorOverrides.get(key) ?? roi.baseColor,
        opacity: opacities.get(key) ?? 1,
        polylines,
      });
    }
    if (roiShapes.length) out.set(orientation, roiShapes);
  }
  return out;
}

/**
 * Project the plane-space {@link roiPlaneShapes} onto each MPR pane's pixels — the
 * final, pan/zoom/flip-dependent half. Applies the current per-orientation zoom and
 * pan (indexed by the {@link Orientation} value) and the sagittal flip with
 * {@link planePointToPane}, the same forward map the measurements and crosshair use,
 * so dragging to pan moves the contours in lockstep without re-projecting any patient
 * point. Degenerate panes, off-pane points and sub-two-point polylines are dropped.
 */
export function roiScreenShapes(
  volume: Volume,
  planeShapes: Map<Orientation, RoiPlaneShapes[]>,
  panes: readonly RoiOverlayPane[],
  zooms: readonly number[],
  pans: readonly Vec2[],
  sagittalFlipped: boolean,
): ContourPaneOverlay[] {
  if (planeShapes.size === 0) return [];

  const result: ContourPaneOverlay[] = [];
  for (const pane of panes) {
    const roiShapes = planeShapes.get(pane.orientation);
    if (!roiShapes) continue;
    const { orientation, rect } = pane;
    if (rect.width < 1 || rect.height < 1) continue;
    const flipX = orientation === Orientation.Sagittal && sagittalFlipped;
    const zoom = zooms[orientation];
    const pan = pans[orientation];

    const shapes: ContourShape[] = [];
    for (const roi of roiShapes) {
      for (let pi = 0; pi < roi.polylines.length; pi++) {
        const polyline = roi.polylines[pi];
        const pixels: string[] = [];
        for (const point of polyline.points) {
          const screen = planePointToPane(volume, orientation, point, zoom, rect, flipX, pan);
          if (!screen) break;
          pixels.push(`${(screen.x - rect.x).toFixed(1)},${(screen.y - rect.y).toFixed(1)}`);
        }
        if (pixels.length < 2) continue;
        shapes.push({
          key: `${roi.key}:${pi}`,
          points: pixels.join(' '),
          closed: polyline.closed,
          color: roi.color,
          opacity: roi.opacity,
        });
      }
    }
    if (shapes.length) result.push({ key: pane.key, rect, shapes });
  }
  return result;
}
