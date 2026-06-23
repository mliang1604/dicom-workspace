import { Orientation, type Volume } from '../../dicom/types';
import type { PaneRect, Vec2 } from '../../render/layout';
import { planeExtentMm, slicePlaneCorners, type ObliqueRotation } from '../../render/reslice';
import {
  mmPerScreenPixel,
  paneEdgeLabels,
  scaleBar,
  type PaneEdgeLabels,
} from '../../render/pane-annotations';
import {
  paneToPlanePoint,
  planePointToPane,
  type PanePoint,
  type PlanePoint,
} from '../../render/pane-coords';
import {
  measureAngleDeg,
  measureDistanceMm,
  roiAreaMm2,
  roiBounds,
  type RoiShape,
} from '../../render/measure';
import { cameraBasis, projectToPane, type OrbitCamera } from '../../render/camera';
import { axisIndicatorGeometry, type AxisIndicatorOverlay } from '../../render/axis-indicator';
import {
  referenceLineGeometry,
  type ReferenceLineGeometry,
  type ReferenceLinePane,
} from '../../render/reference-lines';
import { focusPanePoint } from '../../render/crosshair';

import { TOOL_POINTS, type MeasureTool } from './measurement-store';
import { paneKeyOf, type PanePlacement } from './pane-placement';
import { midpoint, polylineOf } from './viewer-format';

/** A value per orientation, indexed by the orientation's numeric value. */
export type PerOrientation = readonly [number, number, number];

/** A pan offset per orientation, indexed by the orientation's numeric value. */
export type PerOrientationPan = readonly [Vec2, Vec2, Vec2];

/** An oblique tilt per orientation, indexed by the orientation's numeric value. */
export type PerOrientationOblique = readonly [ObliqueRotation, ObliqueRotation, ObliqueRotation];

/** One MPR cut-plane outline projected into the 3D pane. */
export interface SlicePlaneOverlay {
  readonly orientation: Orientation;
  /** SVG polygon `points` in 3D-pane-local CSS pixels (origin at the pane's top-left). */
  readonly points: string;
  /** Outline colour, matched to the pane's orientation. */
  readonly color: string;
}

/** The three MPR cut-planes drawn inside the 3D pane to show where each slices. */
export interface SlicePlanesOverlay {
  /** The 3D pane's rectangle in CSS pixels; the SVG is positioned and clipped to it. */
  readonly rect: PaneRect;
  readonly planes: readonly SlicePlaneOverlay[];
}

/** A linked crosshair drawn over an MPR pane at the shared focus voxel. */
export interface CrosshairOverlay {
  /** Key of the pane it belongs to. */
  readonly key: string;
  /** The pane's rectangle in CSS pixels. */
  readonly rect: PaneRect;
  /** Focus point in CSS pixels relative to the canvas. */
  readonly x: number;
  readonly y: number;
}

/** A scale bar drawn in an MPR pane corner, in CSS pixels. */
export interface ScaleBarOverlay {
  /** Bar length in CSS pixels. */
  readonly lengthPx: number;
  /** Rounded physical label, e.g. "5 cm". */
  readonly label: string;
}

/** Orientation edge letters and a scale bar overlaid on one MPR pane. */
export interface PaneAnnotation {
  /** Key of the pane it belongs to. */
  readonly key: string;
  /** The pane's rectangle in CSS pixels; the overlay is positioned and clipped to it. */
  readonly rect: PaneRect;
  /** Patient-direction letters at the four edges. */
  readonly edges: PaneEdgeLabels;
  /** The physical scale bar, or null when the pane is too small to size one. */
  readonly scale: ScaleBarOverlay | null;
}

/** The oblique rotation gizmo drawn over one MPR pane: a ring and a draggable knob. */
export interface ObliqueGizmo {
  /** Key of the pane it controls. */
  readonly key: string;
  readonly orientation: Orientation;
  /** The pane's rectangle in CSS pixels; the overlay is positioned to it. */
  readonly rect: PaneRect;
  /** Ring centre in pane-local CSS pixels (the orthogonal "home"). */
  readonly cx: number;
  readonly cy: number;
  /** Ring radius in CSS pixels: the largest tilt the knob reaches. */
  readonly radius: number;
  /** Knob centre in pane-local CSS pixels, encoding the current tilt. */
  readonly knobX: number;
  readonly knobY: number;
  /** Whether the pane is currently tilted (drawn emphasised when so). */
  readonly active: boolean;
}

/** A measurement projected into its pane for the SVG overlay, in pane-local pixels. */
export interface MeasurementOverlay {
  readonly key: string;
  readonly id: number;
  readonly tool: MeasureTool;
  readonly rect: PaneRect;
  /** Endpoint/corner handles in pane-local pixels; draggable only when committed. */
  readonly handles: readonly PanePoint[];
  /** Polyline `points` for distance/angle, in pane-local pixels; '' otherwise. */
  readonly polyline: string;
  /** Axis-aligned ellipse for an ellipse ROI, in pane-local pixels; null otherwise. */
  readonly ellipse: {
    readonly cx: number;
    readonly cy: number;
    readonly rx: number;
    readonly ry: number;
  } | null;
  /** Box for a rectangle ROI, in pane-local pixels; null otherwise. */
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  } | null;
  /** Readout lines (length / angle / area + HU stats). */
  readonly lines: readonly string[];
  readonly labelX: number;
  readonly labelY: number;
  /** True while still being placed: rendered dashed, with no drag handles. */
  readonly pending: boolean;
}

/** Order the MPR cut-planes draw in the 3D pane, by orientation value. */
const ORIENTATION_ORDER = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal] as const;

/** Largest oblique tilt (radians) the rotation knob reaches at the ring's edge. */
export const MAX_OBLIQUE_RAD = Math.PI / 3; // 60°
/** Radius (CSS px) of the oblique rotation ring; maps px offset → tilt angle. */
const OBLIQUE_RING_RADIUS = 56;
/** CSS pixels the knob travels per radian of tilt. */
export const OBLIQUE_PX_PER_RAD = OBLIQUE_RING_RADIUS / MAX_OBLIQUE_RAD;

/** Longest an MPR pane's scale bar may grow: a fraction of the pane width… */
const SCALE_BAR_MAX_FRACTION = 0.3;
/** …capped in absolute CSS pixels so it stays a discreet ruler on large panes. */
const SCALE_BAR_MAX_PX = 160;

/** Pixels a measurement readout sits above its anchor point. */
const MEASURE_LABEL_OFFSET = 8;

/** Per-orientation view state the overlay builders read. */
export interface OverlayView {
  readonly panes: readonly PanePlacement[];
  readonly zooms: PerOrientation;
  readonly pans: PerOrientationPan;
  readonly obliques: PerOrientationOblique;
  readonly sliceIndices: PerOrientation;
  readonly sagittalFlipped: boolean;
}

/** Clamp a pixel offset to a symmetric ±`max` range (the oblique knob's reach). */
function clampPx(value: number, max: number): number {
  return Math.max(-max, Math.min(max, value));
}

/** The linked crosshairs over each MPR pane at the shared focus voxel. */
export function buildCrosshairs(
  volume: Volume,
  voxel: readonly [number, number, number],
  view: OverlayView,
): CrosshairOverlay[] {
  const { zooms, pans, obliques, sagittalFlipped: flipped } = view;
  const result: CrosshairOverlay[] = [];
  for (const pane of view.panes) {
    if (pane.kind !== 'mpr') continue;
    const point = focusPanePoint(
      volume,
      pane.orientation,
      voxel,
      zooms[pane.orientation],
      pane.rect,
      pane.orientation === Orientation.Sagittal && flipped,
      pans[pane.orientation],
      obliques[pane.orientation],
    );
    if (!point || !withinRect(pane.rect, point.x, point.y)) continue;
    result.push({ key: paneKeyOf(pane), rect: pane.rect, x: point.x, y: point.y });
  }
  return result;
}

function withinRect(rect: PaneRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** Cross-pane reference lines: where every other in-group plane crosses each pane. */
export function buildReferenceLines(
  volume: Volume,
  view: OverlayView,
  sliceColors: readonly [string, string, string],
): ReferenceLineGeometry[] {
  const mprPanes: ReferenceLinePane[] = view.panes.filter(
    (pane): pane is Extract<PanePlacement, { kind: 'mpr' }> => pane.kind === 'mpr',
  );
  return referenceLineGeometry(
    volume,
    mprPanes,
    view.sliceIndices,
    view.obliques,
    view.zooms,
    view.pans,
    view.sagittalFlipped,
    sliceColors,
  );
}

/** The oblique rotation gizmo for each hovered or already-tilted MPR pane. */
export function buildObliqueGizmos(view: OverlayView, hovered: string | null): ObliqueGizmo[] {
  const result: ObliqueGizmo[] = [];
  for (const pane of view.panes) {
    if (pane.kind !== 'mpr') continue;
    const key = paneKeyOf(pane);
    const tilt = view.obliques[pane.orientation];
    const active = tilt.tiltU !== 0 || tilt.tiltV !== 0;
    // Show the knob only where it's discoverable (hovered pane) or already in use.
    if (key !== hovered && !active) continue;
    const cx = pane.rect.width / 2;
    const cy = pane.rect.height / 2;
    const radius = Math.min(OBLIQUE_RING_RADIUS, Math.min(cx, cy) - 4);
    if (radius < 8) continue;
    const px = OBLIQUE_PX_PER_RAD;
    result.push({
      key,
      orientation: pane.orientation,
      rect: pane.rect,
      cx,
      cy,
      radius,
      knobX: cx + clampPx(tilt.tiltV * px, radius),
      knobY: cy + clampPx(tilt.tiltU * px, radius),
      active,
    });
  }
  return result;
}

/** The three MPR cut-planes drawn inside the 3D pane, projected through the orbit camera. */
export function buildSlicePlanes(
  volume: Volume,
  panes: readonly PanePlacement[],
  camera: OrbitCamera,
  sliceIndices: PerOrientation,
  sliceColors: readonly [string, string, string],
): SlicePlanesOverlay | null {
  const mip = panes.find((pane) => pane.kind === 'mip');
  if (!mip) return null;

  const basis = cameraBasis(volume, camera, mip.rect.width, mip.rect.height);
  const planes = ORIENTATION_ORDER.map((orientation) => {
    const points = slicePlaneCorners(volume, orientation, sliceIndices[orientation])
      .map((corner) => {
        const { u, v } = projectToPane(basis, corner);
        return `${(u * mip.rect.width).toFixed(1)},${(v * mip.rect.height).toFixed(1)}`;
      })
      .join(' ');
    return { orientation, points, color: sliceColors[orientation] };
  });
  return { rect: mip.rect, planes };
}

/** Anatomical orientation indicator for the 3D pane, projected through the orbit camera. */
export function buildAxisIndicator(
  panes: readonly PanePlacement[],
  camera: OrbitCamera,
): AxisIndicatorOverlay | null {
  const mip = panes.find((pane) => pane.kind === 'mip');
  if (!mip) return null;
  return axisIndicatorGeometry(mip.rect, camera.azimuth, camera.elevation);
}

/** Per-MPR-pane 2D overlays: anatomical edge letters and a physical scale bar. */
export function buildPaneAnnotations(volume: Volume, view: OverlayView): PaneAnnotation[] {
  const { zooms, sagittalFlipped: flipped } = view;
  const result: PaneAnnotation[] = [];
  for (const pane of view.panes) {
    if (pane.kind !== 'mpr') continue;
    const flipX = pane.orientation === Orientation.Sagittal && flipped;
    const [planeW, planeH] = planeExtentMm(volume, pane.orientation);
    const mmPerPixel = mmPerScreenPixel(
      planeW,
      planeH,
      pane.rect.width,
      pane.rect.height,
      zooms[pane.orientation],
    );
    const maxLengthPx = Math.min(pane.rect.width * SCALE_BAR_MAX_FRACTION, SCALE_BAR_MAX_PX);
    const bar = scaleBar(mmPerPixel, maxLengthPx);
    result.push({
      key: paneKeyOf(pane),
      rect: pane.rect,
      edges: paneEdgeLabels(pane.orientation, flipX),
      scale: bar ? { lengthPx: bar.lengthPx, label: bar.label } : null,
    });
  }
  return result;
}

/** A measurement (id/tool/orientation/slice + plane points) to project into a pane. */
export interface MeasurementInput {
  readonly id: number;
  readonly tool: MeasureTool;
  readonly orientation: Orientation;
  readonly sliceIndex: number;
}

/** A provisional point under the cursor for previewing the pending measurement. */
export function previewPoint(
  volume: Volume,
  view: OverlayView,
  cursor: Vec2 | null,
  orientation: Orientation,
): PlanePoint | null {
  if (!cursor) return null;
  const placement = view.panes.find(
    (pane): pane is Extract<PanePlacement, { kind: 'mpr' }> =>
      pane.kind === 'mpr' && pane.orientation === orientation,
  );
  if (!placement) return null;
  return paneToPlanePoint(
    volume,
    orientation,
    view.zooms[orientation],
    placement.rect,
    cursor.x,
    cursor.y,
    orientation === Orientation.Sagittal && view.sagittalFlipped,
    view.pans[orientation],
  );
}

/** Project one measurement into its pane, or null if it's hidden (wrong slice/pane). */
export function buildMeasurementOverlay(
  volume: Volume,
  view: OverlayView,
  m: MeasurementInput,
  points: readonly PlanePoint[],
  pending: boolean,
  statsFor: (id: number) => readonly string[],
): MeasurementOverlay | null {
  const orientation = m.orientation;
  const placement = view.panes.find(
    (pane): pane is Extract<PanePlacement, { kind: 'mpr' }> =>
      pane.kind === 'mpr' && pane.orientation === orientation,
  );
  if (!placement) return null;
  if (view.sliceIndices[orientation] !== m.sliceIndex) return null; // scrolled off its slice
  const rect = placement.rect;
  if (rect.width < 1 || rect.height < 1 || points.length === 0) return null;

  const flipX = orientation === Orientation.Sagittal && view.sagittalFlipped;
  const zoom = view.zooms[orientation];
  const pan = view.pans[orientation];
  const local: PanePoint[] = [];
  for (const p of points) {
    const screen = planePointToPane(volume, orientation, p, zoom, rect, flipX, pan);
    if (!screen) return null;
    local.push({ x: screen.x - rect.x, y: screen.y - rect.y });
  }

  const [widthMm, heightMm] = planeExtentMm(volume, orientation);
  const scale = { widthMm, heightMm };
  const full = points.length >= TOOL_POINTS[m.tool];

  let polyline = '';
  let ellipse: MeasurementOverlay['ellipse'] = null;
  let box: MeasurementOverlay['box'] = null;
  let lines: readonly string[] = [];
  let labelX = local[0].x;
  let labelY = local[0].y - MEASURE_LABEL_OFFSET;

  switch (m.tool) {
    case 'distance': {
      polyline = polylineOf(local);
      const mid = midpoint(local);
      labelX = mid.x;
      labelY = mid.y - MEASURE_LABEL_OFFSET;
      if (full) lines = [`${measureDistanceMm(points[0], points[1], scale).toFixed(1)} mm`];
      break;
    }
    case 'angle': {
      polyline = polylineOf(local);
      labelX = local[1].x;
      labelY = local[1].y - MEASURE_LABEL_OFFSET;
      if (full) {
        lines = [`${measureAngleDeg(points[0], points[1], points[2], scale).toFixed(1)}°`];
      }
      break;
    }
    case 'ellipse':
    case 'rectangle': {
      if (local.length >= 2) {
        const [a, b] = local;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const w = Math.abs(a.x - b.x);
        const h = Math.abs(a.y - b.y);
        if (m.tool === 'ellipse') {
          ellipse = { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 };
        } else {
          box = { x, y, w, h };
        }
        labelX = x;
        labelY = y - MEASURE_LABEL_OFFSET;
        const shape: RoiShape = m.tool;
        if (pending) {
          // Live preview shows the area only (cheap); committed ROIs add HU stats
          // from the memoised, pan-independent sweep in measurementStats.
          const area = roiAreaMm2(shape, roiBounds(points[0], points[1]), scale);
          lines = [`${area.toFixed(0)} mm²`];
        } else {
          lines = statsFor(m.id);
        }
      }
      break;
    }
    default: {
      const exhaustive: never = m.tool;
      return exhaustive;
    }
  }

  return {
    key: pending ? 'pending' : `measure-${m.id}`,
    id: m.id,
    tool: m.tool,
    rect,
    handles: local,
    polyline,
    ellipse,
    box,
    lines,
    labelX,
    labelY,
    pending,
  };
}
