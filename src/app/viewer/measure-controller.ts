import { Injectable, computed, inject, type Signal, type WritableSignal } from '@angular/core';
import { probeVoxel, sampleVolumeAtPatient } from '../../render/probe';
import { pickProjection } from '../../render/pick';
import { focusSliceIndex } from '../../render/crosshair';
import { paneToPlanePoint, type PlanePoint } from '../../render/pane-coords';
import { type ReferenceLineGeometry } from '../../render/reference-lines';
import { type OrbitCamera } from '../../render/camera';
import { type ProjectionMode } from '../../render/slice-renderer';
import { type PatientPlane } from '../../render/reslice';
import { type TransferFunction } from '../../render/transfer-function';
import { type Vec2, type PaneRect } from '../../render/layout';
import { Orientation, type Volume } from '../../dicom/types';
import { MeasurementStore, type MeasureTool } from './measurement-store';
import { placementAt, type PanePlacement } from './pane-placement';
import { LayersController } from './layers-controller';
import { formatProbe } from './viewer-format';
import {
  buildCrosshairs,
  buildMeasurementOverlay,
  buildObliqueGizmos,
  buildPaneAnnotations,
  buildReferenceLines,
  previewPoint,
  type CrosshairOverlay,
  type MeasurementOverlay,
  type ObliqueGizmo,
  type OverlayView,
  type PaneAnnotation,
  type PerOrientation,
  type PerOrientationOblique,
  type PerOrientationPan,
} from './viewer-overlays';

/** Outline colour of each MPR cut-plane drawn in the 3D pane, indexed by Orientation. */
const SLICE_PLANE_COLORS: readonly [string, string, string] = ['#ff6b6b', '#5ee08a', '#6bb6ff'];

/** Human name for an MPR orientation (for the probe readout). */
function orientationName(orientation: Orientation): string {
  switch (orientation) {
    case Orientation.Axial:
      return 'Axial';
    case Orientation.Coronal:
      return 'Coronal';
    case Orientation.Sagittal:
      return 'Sagittal';
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

/** The active measurement tool, or `none` for the default pan/orbit gestures. */
export type ToolMode = 'none' | MeasureTool;

/** Component state the {@link MeasureController} reads/writes; wired via {@link MeasureController.init}. */
export interface MeasureInit {
  readonly volume: () => Volume | null;
  readonly isReady: () => boolean;
  readonly panes: () => readonly PanePlacement[];
  /** Canvas bounding rect, for client→pane-local coordinates. */
  readonly canvasBounds: () => DOMRect;
  readonly zooms: Signal<PerOrientation>;
  readonly pans: Signal<PerOrientationPan>;
  readonly obliques: Signal<PerOrientationOblique>;
  readonly sliceIndices: WritableSignal<PerOrientation>;
  readonly sagittalFlipped: () => boolean;
  readonly focusVoxel: WritableSignal<readonly [number, number, number] | null>;
  readonly crosshairsEnabled: WritableSignal<boolean>;
  /** Key of the hovered pane, or null when away (drives the oblique gizmo). */
  readonly hoveredKey: () => string | null;
  /** Cursor position in CSS pixels relative to the canvas, or null when away. */
  readonly cursor: () => Vec2 | null;
  readonly activeTool: WritableSignal<ToolMode>;
  /** 3D-pane pick inputs (for a Shift+click locator on the MIP). */
  readonly camera3d: () => OrbitCamera;
  readonly projectionMode: () => ProjectionMode;
  readonly slabThicknessMm: () => number;
  readonly clipToPlanes: () => boolean;
  readonly cutPlane: () => PatientPlane | null;
  readonly transferFunction: () => TransferFunction;
}

/**
 * Owns the measurement-tool gestures (place / drag a distance, angle, ellipse or
 * rectangle) and the Shift+click crosshair-focus picks from both the MPR panes
 * and the 3D MIP locator. The measurement data lives in {@link MeasurementStore}
 * and the focus/slice/tool state in the component's signals; this controller is
 * the pointer + plane-mapping glue, wired once through {@link init}. Provided at
 * the component so its lifetime tracks the viewer.
 */
@Injectable()
export class MeasureController {
  private readonly measure = inject(MeasurementStore);
  private readonly layersCtl = inject(LayersController);
  private deps: MeasureInit | null = null;

  /** Live readout of the voxel under the cursor, or null when none is hovered. */
  readonly probeText = computed<string | null>(() => {
    const d = this.deps!;
    if (!d.isReady()) return null;
    const cursor = d.cursor();
    if (!cursor) return null;

    const pane = placementAt(d.panes(), cursor.x, cursor.y);
    if (!pane || pane.kind !== 'mpr') return null; // no voxel probe over the 3D pane

    const group = pane.group;
    const hoveredVolume = this.layersCtl.groupVolume(group);
    if (!hoveredVolume) return null;
    const orientation = pane.orientation;
    const sample = probeVoxel(
      hoveredVolume,
      orientation,
      this.layersCtl.paneSliceIndex(group, orientation),
      this.layersCtl.paneZoom(group, orientation),
      pane.rect,
      cursor.x,
      cursor.y,
      orientation === Orientation.Sagittal && d.sagittalFlipped(),
      this.layersCtl.panePan(group, orientation),
      d.obliques()[orientation],
    );
    if (!sample) return null;

    // Read every other visible layer at the probed patient point (e.g. dose Gy
    // under the CT HU). A layer that doesn't cover the point is dropped.
    const others = this.layersCtl
      .layers()
      .filter((layer) => layer.visible && layer.volume !== hoveredVolume)
      .flatMap((layer) => {
        const s = sampleVolumeAtPatient(layer.volume, sample.patient);
        return s ? [{ layer, sample: s }] : [];
      });
    return formatProbe(orientationName(orientation), sample, hoveredVolume, others);
  });

  /** Wire the controller to the component's view state. Called once. */
  init(deps: MeasureInit): void {
    this.deps = deps;
  }

  /** The per-orientation view state the overlay builders read, bundled once. */
  private readonly overlayView = computed<OverlayView>(() => {
    const d = this.deps!;
    return {
      panes: d.panes(),
      zooms: d.zooms(),
      pans: d.pans(),
      obliques: d.obliques(),
      sliceIndices: d.sliceIndices(),
      sagittalFlipped: d.sagittalFlipped(),
    };
  });

  /** Linked crosshairs over each MPR pane at the shared focus voxel. */
  readonly crosshairs = computed<CrosshairOverlay[]>(() => {
    const d = this.deps!;
    const voxel = d.focusVoxel();
    const volume = d.volume();
    if (!d.crosshairsEnabled() || !voxel || !volume) return [];
    return buildCrosshairs(volume, voxel, this.overlayView());
  });

  /** Cross-pane reference lines: where every other in-group plane crosses each pane. */
  readonly referenceLines = computed<ReferenceLineGeometry[]>(() => {
    const d = this.deps!;
    const volume = d.volume();
    if (!d.crosshairsEnabled() || !volume) return [];
    return buildReferenceLines(volume, this.overlayView(), SLICE_PLANE_COLORS);
  });

  /** The oblique rotation gizmo for each hovered or already-tilted MPR pane. */
  readonly obliqueGizmos = computed<ObliqueGizmo[]>(() => {
    const d = this.deps!;
    if (!d.crosshairsEnabled() || !d.isReady()) return [];
    return buildObliqueGizmos(this.overlayView(), d.hoveredKey());
  });

  /** Per-MPR-pane 2D overlays: anatomical edge letters and a physical scale bar. */
  readonly paneAnnotations = computed<PaneAnnotation[]>(() => {
    const d = this.deps!;
    const volume = d.volume();
    if (!d.isReady() || !volume) return [];
    return buildPaneAnnotations(volume, this.overlayView());
  });

  /** Cached ROI readout lines (area + HU stats) keyed by measurement id. */
  private readonly measurementStats = computed<ReadonlyMap<number, readonly string[]>>(() =>
    this.measure.statsFor(this.deps!.volume(), this.deps!.obliques()),
  );

  /** Measurements (and the in-progress one) projected into their panes for the SVG overlay. */
  readonly measurementOverlays = computed<MeasurementOverlay[]>(() => {
    const d = this.deps!;
    const volume = d.volume();
    if (!d.isReady() || !volume) return [];
    const view = this.overlayView();
    const stats = this.measurementStats();
    const statsFor = (id: number) => stats.get(id) ?? [];

    const result: MeasurementOverlay[] = [];
    for (const m of this.measure.measurements()) {
      const overlay = buildMeasurementOverlay(volume, view, m, m.points, false, statsFor);
      if (overlay) result.push(overlay);
    }

    // The in-progress measurement, previewed with a provisional point under the
    // cursor so the segment/box is visible as it's drawn.
    const pending = this.measure.pending();
    if (pending) {
      const preview = previewPoint(volume, view, d.cursor(), pending.orientation);
      const points = preview ? [...pending.points, preview] : pending.points;
      const overlay = buildMeasurementOverlay(
        volume,
        view,
        {
          id: -1,
          orientation: pending.orientation,
          sliceIndex: pending.sliceIndex,
          tool: pending.tool,
        },
        points,
        true,
        statsFor,
      );
      if (overlay) result.push(overlay);
    }
    return result;
  });

  /**
   * Set the shared focus voxel from a Shift+click on an MPR pane and scroll every
   * orientation to the slice that contains it.
   */
  setFocus(placement: Extract<PanePlacement, { kind: 'mpr' }>, event: PointerEvent): void {
    const d = this.deps;
    if (!d) return;
    const volume = d.volume();
    if (!volume) return;
    const bounds = d.canvasBounds();
    const sample = probeVoxel(
      volume,
      placement.orientation,
      d.sliceIndices()[placement.orientation],
      d.zooms()[placement.orientation],
      placement.rect,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      placement.orientation === Orientation.Sagittal && d.sagittalFlipped(),
      d.pans()[placement.orientation],
      d.obliques()[placement.orientation],
    );
    if (!sample) return; // clicked the letterbox margin or outside the volume
    this.navigateToVoxel(volume, sample.voxel);
  }

  /**
   * Set the shared focus from a Shift+click on the 3D pane: ray-cast the clicked
   * pixel to the location its projection came from, then navigate every MPR pane
   * there — the 3D view acting as a locator.
   */
  setFocusFromMip(placement: Extract<PanePlacement, { kind: 'mip' }>, event: PointerEvent): void {
    const d = this.deps;
    if (!d) return;
    const volume = d.volume();
    if (!volume) return;
    const bounds = d.canvasBounds();
    const pick = pickProjection(
      volume,
      d.camera3d(),
      d.projectionMode(),
      d.slabThicknessMm(),
      placement.rect,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      {
        clipToPlanes: d.clipToPlanes(),
        sliceIndices: d.sliceIndices(),
        cutPlane: d.cutPlane() ?? undefined,
        transferFunction: d.transferFunction(),
      },
    );
    if (!pick) return; // the ray missed the volume (or, for DVR, hit nothing solid)
    this.navigateToVoxel(volume, pick.voxel);
  }

  /** Make `voxel` the shared focus and scroll every orientation to its slice. */
  private navigateToVoxel(volume: Volume, voxel: readonly [number, number, number]): void {
    const d = this.deps;
    if (!d) return;
    d.focusVoxel.set(voxel);
    d.crosshairsEnabled.set(true); // a fresh pick should always be visible
    const obliques = d.obliques();
    d.sliceIndices.set([
      focusSliceIndex(volume, Orientation.Axial, voxel, obliques[Orientation.Axial]),
      focusSliceIndex(volume, Orientation.Coronal, voxel, obliques[Orientation.Coronal]),
      focusSliceIndex(volume, Orientation.Sagittal, voxel, obliques[Orientation.Sagittal]),
    ]);
  }

  /** Activate a measurement tool, or toggle it off if it's already active. */
  setTool(tool: MeasureTool): void {
    const d = this.deps;
    if (!d) return;
    d.activeTool.update((current) => (current === tool ? 'none' : tool));
    this.measure.cancelPending(); // abandon any half-placed measurement when the tool changes
  }

  /** Remove every placed measurement and any in-progress one. */
  clearMeasurements(): void {
    this.measure.clear();
  }

  /**
   * Add the next point of the active measurement from a click on an MPR pane.
   * Points accumulate on the pane's current slice; once the tool's full set is
   * placed the measurement is committed and the pending state cleared.
   */
  placeMeasurePoint(placement: Extract<PanePlacement, { kind: 'mpr' }>, event: PointerEvent): void {
    const d = this.deps;
    if (!d) return;
    const volume = d.volume();
    const tool = d.activeTool();
    if (!volume || tool === 'none') return;
    const orientation = placement.orientation;
    const point = this.eventPlanePoint(volume, orientation, placement.rect, event);
    if (!point) return; // clicked the letterbox margin outside the image
    this.measure.place(tool, orientation, d.sliceIndices()[orientation], point);
  }

  /** Begin dragging a placed measurement's endpoint or ROI corner. */
  onMeasureHandleDown(id: number, pointIndex: number, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.target as Element;
    target.setPointerCapture?.(event.pointerId);
    this.measure.beginDrag(id, pointIndex);
  }

  /** Move the dragged measurement point to follow the cursor. */
  onMeasureHandleMove(event: PointerEvent): void {
    const d = this.deps;
    if (!d || !this.measure.drag()) return;
    event.preventDefault();
    event.stopPropagation();
    const volume = d.volume();
    if (!volume) return;
    const measurement = this.measure.draggedMeasurement();
    if (!measurement) return;
    const orientation = measurement.orientation;
    const placement = this.mprPlacement(orientation);
    if (!placement) return;
    const point = this.eventPlanePoint(volume, orientation, placement.rect, event);
    if (!point) return;
    this.measure.applyDragPoint(point);
  }

  /** End a measurement-point drag. */
  onMeasureHandleUp(event: PointerEvent): void {
    if (!this.measure.drag()) return;
    event.stopPropagation();
    const target = event.target as Element;
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.measure.endDrag();
  }

  /** Map a pointer event to the in-plane point it covers on a given MPR pane. */
  private eventPlanePoint(
    volume: Volume,
    orientation: Orientation,
    rect: PaneRect,
    event: PointerEvent,
  ): PlanePoint | null {
    const d = this.deps;
    if (!d) return null;
    const bounds = d.canvasBounds();
    return paneToPlanePoint(
      volume,
      orientation,
      d.zooms()[orientation],
      rect,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      orientation === Orientation.Sagittal && d.sagittalFlipped(),
      d.pans()[orientation],
    );
  }

  /** The MPR placement currently showing an orientation, or null when it isn't shown. */
  private mprPlacement(orientation: Orientation): Extract<PanePlacement, { kind: 'mpr' }> | null {
    const d = this.deps;
    if (!d) return null;
    return (
      d
        .panes()
        .find(
          (pane): pane is Extract<PanePlacement, { kind: 'mpr' }> =>
            pane.kind === 'mpr' && pane.orientation === orientation,
        ) ?? null
    );
  }
}
