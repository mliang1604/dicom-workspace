import { Injectable, signal } from '@angular/core';
import { clamp } from '../../dicom/math';
import { length } from '../../dicom/vec3';
import { baseLayer, Orientation, type Layer, type Volume } from '../../dicom/types';
import type { PaneRect, Vec2 } from '../../render/layout';
import { cameraBasis, rezoomCameraPan } from '../../render/camera';
import { sliceCountFor } from '../../render/reslice';
import {
  windowLevelDrag,
  windowLevelSensitivity,
  type WindowLevel,
} from '../../render/window-level';
import {
  clampPan,
  cursorZoomPan,
  steppedSliceIndex,
  type SliceRenderer,
} from '../../render/slice-renderer';
import type { PanePlacement } from './viewer';
import { type Drag, type InteractionInit } from './interaction-types';

// Re-exported so existing importers keep resolving these from this module.
export type { Drag, InteractionInit } from './interaction-types';

/** Magnification factor applied per wheel notch when zooming the 3D camera. */
const ZOOM_STEP = 1.1;
/**
 * Magnification per pixel of vertical travel for a right-drag zoom: the factor is
 * `exp(pixelsUp * ZOOM_DRAG_SPEED)`, so dragging up magnifies and down shrinks. A
 * pane-height drag (~500 px) spans roughly the full zoom range.
 */
const ZOOM_DRAG_SPEED = 0.005;
/** Radians of orbit per pixel dragged over the 3D pane. */
const ORBIT_SPEED = 0.01;
/** Cap the elevation just shy of the poles to avoid a degenerate up vector. */
const MAX_ELEVATION = 1.45;

/**
 * Owns the canvas pointer/wheel interaction state machine: the in-progress
 * {@link Drag} and the down/move/up/leave + wheel orchestration that pans/orbits
 * the panes, drives window/level (Alt+right-drag), scrolls slices, and zooms
 * (right-drag on the MPR panes and the 3D camera, plus the 3D wheel). The
 * regression-prone slice-step and cursor-anchored zoom math lives behind tested
 * pure helpers in `src/render`; this stays the branchy glue.
 *
 * The component wires it up once via {@link init} with lazy callbacks and
 * delegates the canvas DOM handlers here. The {@link drag} signal is exposed so
 * the in-pane gizmo handlers (oblique / clip-plane, still on the component) share
 * the same state and the component can derive `isPanning` / MIP interactivity.
 *
 * Provided at the component so its lifetime tracks the viewer.
 */
@Injectable()
export class InteractionController {
  /**
   * The in-progress drag, or null at rest. Public so the component's gizmo
   * handlers (oblique / clip-plane) can drive it and its computed view state can
   * read it; the pointer/wheel orchestration here is its primary owner.
   */
  readonly drag = signal<Drag | null>(null);

  /** Component callbacks, wired by {@link init} before any handler fires. */
  private deps: InteractionInit | null = null;

  /** Wire the controller to the viewer's panes/volumes/camera. Called once. */
  init(deps: InteractionInit): void {
    this.deps = deps;
  }

  /** Begin a click-drag over the pane under the pointer. */
  onPointerDown(event: PointerEvent): void {
    const d = this.deps;
    if (!d || !d.isReady()) return;
    const placement = d.placementAt(event);
    if (!placement) return;

    // Alt+right-drag adjusts window/level over any pane — the standard PACS W/L
    // gesture, moved onto Alt so the plain right-drag is free for zoom. Horizontal
    // moves the centre, vertical the width (see dragWindow). It targets the pane's
    // own column: the overlay layer over a Compare overlay column, the base
    // elsewhere. The context menu is suppressed below.
    if (event.button === 2 && event.altKey) {
      event.preventDefault();
      d.canvas().setPointerCapture(event.pointerId);
      const layer = this.wlTargetForPlacement(placement);
      const start = d.layerWindow(layer);
      this.drag.set({
        kind: 'windowLevel',
        layerId: layer && layer.role !== 'base' ? layer.id : null,
        startCenter: start.center,
        startWidth: start.width,
        startX: event.clientX,
        startY: event.clientY,
      });
      return;
    }

    // Plain right-drag zooms, anchored on the press point so the structure under
    // the cursor stays put — the gesture that replaced the old Ctrl+wheel zoom.
    // Dragging up magnifies, down shrinks (see dragZoom / dragCameraZoom). Over an
    // MPR pane it scales that view's zoom/pan; over the 3D pane it scales the
    // orthographic camera. The context menu is suppressed below.
    if (event.button === 2) {
      event.preventDefault();
      d.canvas().setPointerCapture(event.pointerId);
      const bounds = d.canvas().getBoundingClientRect();
      const anchorX = event.clientX - bounds.left;
      const anchorY = event.clientY - bounds.top;
      if (placement.kind === 'mip') {
        const cam = d.camera3d();
        this.drag.set({
          kind: 'cameraZoom',
          // Press point → centred device coords with +y up, matching the raycaster.
          ndcX: ((anchorX - placement.rect.x) / placement.rect.width) * 2 - 1,
          ndcY: 1 - ((anchorY - placement.rect.y) / placement.rect.height) * 2,
          startY: event.clientY,
          startZoom: cam.zoom,
          startPanX: cam.panX,
          startPanY: cam.panY,
        });
      } else {
        this.drag.set({
          kind: 'zoom',
          orientation: placement.orientation,
          group: placement.group,
          anchorX,
          anchorY,
          startY: event.clientY,
          startZoom: d.paneZoom(placement.group, placement.orientation),
          startPan: d.panePan(placement.group, placement.orientation),
        });
      }
      return;
    }

    // Pan gesture — middle-button drag, or Alt+left-drag for trackpads. Over the
    // 3D pane it slides the orthographic camera (panX/panY), so you can recentre
    // after a cursor-anchored zoom without losing the orbit; over an MPR pane it
    // pans that view like a left-drag.
    if (event.button === 1 || (event.button === 0 && event.altKey)) {
      event.preventDefault();
      d.canvas().setPointerCapture(event.pointerId);
      this.drag.set(
        placement.kind === 'mip'
          ? { kind: 'cameraPan', lastX: event.clientX, lastY: event.clientY }
          : {
              kind: 'pan',
              orientation: placement.orientation,
              group: placement.group,
              lastX: event.clientX,
              lastY: event.clientY,
            },
      );
      return;
    }

    if (event.button !== 0) return;
    event.preventDefault();

    // Shift+left-click sets the shared focus voxel and navigates every pane to it,
    // instead of starting a pan/orbit — a modifier that never clashes with the
    // plain left-drag or the right-drag zoom. Over an MPR pane it probes the slice;
    // over the 3D pane it ray-casts the projection to the location it came from.
    if (event.shiftKey) {
      if (placement.kind === 'mpr') d.setFocus(placement, event);
      else d.setFocusFromMip(placement, event);
      return;
    }

    // With a brush/eraser mode selected, a left-drag over an MPR pane paints the
    // active ROI into the label volume instead of panning. Capture so the stroke
    // keeps tracking past the pane edge; the brush controller does the painting.
    if (d.brushActive() && placement.kind === 'mpr') {
      d.canvas().setPointerCapture(event.pointerId);
      this.drag.set({ kind: 'draw', orientation: placement.orientation, group: placement.group });
      d.beginStroke(placement, event);
      return;
    }

    // With a measurement tool active, a left-click on an MPR pane places the next
    // point instead of starting a pan; the 3D pane keeps its orbit gesture.
    if (d.activeTool() !== 'none' && placement.kind === 'mpr') {
      d.placeMeasurePoint(placement, event);
      return;
    }

    // Capture so the drag keeps tracking even if the pointer leaves the canvas.
    d.canvas().setPointerCapture(event.pointerId);
    // The 3D pane orbits; the MPR panes pan.
    this.drag.set(
      placement.kind === 'mip'
        ? { kind: 'orbit', lastX: event.clientX, lastY: event.clientY }
        : {
            kind: 'pan',
            orientation: placement.orientation,
            group: placement.group,
            lastX: event.clientX,
            lastY: event.clientY,
          },
    );
  }

  /** Suppress the browser context menu so right-button zoom / W/L drags work. */
  onContextMenu(event: Event): void {
    if (this.deps?.isReady()) event.preventDefault();
  }

  onPointerMove(event: PointerEvent): void {
    const d = this.deps;
    if (!d) return;
    const drag = this.drag();
    if (drag?.kind === 'pan') this.dragPan(event, drag);
    else if (drag?.kind === 'draw') this.dragDraw(event, drag);
    else if (drag?.kind === 'orbit') this.dragOrbit(event, drag);
    else if (drag?.kind === 'cameraPan') this.dragCameraPan(event, drag);
    else if (drag?.kind === 'zoom') this.dragZoom(event, drag);
    else if (drag?.kind === 'cameraZoom') this.dragCameraZoom(event, drag);
    else if (drag?.kind === 'windowLevel') this.dragWindow(event, drag);

    const bounds = d.canvas().getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    d.setCursor({ x, y });
    const hovered = this.placementAtPoint(x, y);
    d.setHoveredKey(hovered ? d.paneKey(hovered) : null);
    // Remember the last MPR column hovered so the toolbar window/level controls
    // keep targeting it once the pointer moves off the panes onto the toolbar.
    if (hovered?.kind === 'mpr') d.setActiveCompareGroup(hovered.group);
  }

  onPointerUp(event: PointerEvent): void {
    const d = this.deps;
    if (!d || !this.drag()) return;
    const wasDraw = this.drag()?.kind === 'draw';
    const canvas = d.canvas();
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    this.drag.set(null);
    if (wasDraw) d.endStroke();
  }

  onPointerLeave(event: PointerEvent): void {
    const d = this.deps;
    if (!d) return;
    // Moving the cursor onto an in-pane overlay handle (the oblique tilt knob, a
    // measurement handle) makes the canvas fire pointerleave even though the
    // pointer hasn't really left the panes. Clearing the hovered pane here would
    // unmount the at-rest oblique knob the instant it's hovered — leaving nothing
    // under the press, so the knob can't be grabbed. Keep the hover in that case.
    const related = event.relatedTarget as Element | null;
    if (related?.closest?.('.oblique-knob, .measure-handle')) return;
    d.setCursor(null);
    d.setHoveredKey(null);
  }

  /** Accumulate a pointer move into the 3D camera's orbit angles. */
  private dragOrbit(event: PointerEvent, drag: Extract<Drag, { kind: 'orbit' }>): void {
    const d = this.deps!;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    this.drag.set({ ...drag, lastX: event.clientX, lastY: event.clientY });
    d.camera3d.update((cam) => ({
      ...cam,
      azimuth: cam.azimuth + dx * ORBIT_SPEED,
      elevation: clamp(cam.elevation - dy * ORBIT_SPEED, -MAX_ELEVATION, MAX_ELEVATION),
    }));
  }

  /**
   * Slide the orthographic 3D camera by a pointer move (panX/panY in patient mm).
   * Maps screen pixels to mm via the image-plane half-extents so the volume
   * tracks the cursor 1:1, letting you recentre after a cursor-anchored zoom.
   */
  private dragCameraPan(event: PointerEvent, drag: Extract<Drag, { kind: 'cameraPan' }>): void {
    const d = this.deps!;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    this.drag.set({ ...drag, lastX: event.clientX, lastY: event.clientY });

    const volume = d.volume();
    const mip = d.panes().find((pane) => pane.kind === 'mip');
    if (!volume || !mip || mip.rect.width < 1 || mip.rect.height < 1) return;
    const basis = cameraBasis(volume, d.camera3d(), mip.rect.width, mip.rect.height);
    const mmPerPxX = (2 * length(basis.axisU)) / mip.rect.width;
    const mmPerPxY = (2 * length(basis.axisV)) / mip.rect.height;
    d.camera3d.update((cam) => ({
      ...cam,
      panX: cam.panX - dx * mmPerPxX,
      panY: cam.panY + dy * mmPerPxY,
    }));
  }

  /** Extend the active brush stroke to the cursor, staying on the pane it began on. */
  private dragDraw(event: PointerEvent, drag: Extract<Drag, { kind: 'draw' }>): void {
    const d = this.deps!;
    const placement = d
      .panes()
      .find(
        (pane): pane is Extract<PanePlacement, { kind: 'mpr' }> =>
          pane.kind === 'mpr' && pane.group === drag.group && pane.orientation === drag.orientation,
      );
    if (placement) d.extendStroke(placement, event);
  }

  /** Accumulate a pointer move into the dragged pane's pan, clamped to bounds. */
  private dragPan(event: PointerEvent, drag: Extract<Drag, { kind: 'pan' }>): void {
    const d = this.deps!;
    const { group, orientation } = drag;
    // Read the displacement before overwriting the drag's last position below.
    const dxFraction = event.clientX - drag.lastX;
    const dyFraction = event.clientY - drag.lastY;
    this.drag.set({ ...drag, lastX: event.clientX, lastY: event.clientY });

    const placement = d
      .panes()
      .find(
        (pane) => pane.kind === 'mpr' && pane.group === group && pane.orientation === orientation,
      );
    const independent = d.groupIsIndependent(group);
    const volume = independent ? d.groupVolume(group) : d.volume();
    if (!placement || !volume || placement.rect.width < 1 || placement.rect.height < 1) return;

    const dx = dxFraction / placement.rect.width;
    const dy = dyFraction / placement.rect.height;
    const zoom = d.paneZoom(group, orientation);
    const current = d.panePan(group, orientation);
    const moved = clampPan(volume, orientation, placement.rect.width, placement.rect.height, zoom, {
      x: current.x + dx,
      y: current.y + dy,
    });

    if (independent) d.setGroupPan(group, orientation, moved);
    else d.setMasterPan(orientation, moved);
  }

  /**
   * The layer a window/level gesture over a pane targets: the overlay layer for a
   * Compare overlay column (group ≥ 1), the base otherwise — so Alt+right-dragging
   * the right column windows only that column. Mirrors `activeWlLayer`, but keyed to a
   * specific pane rather than the hovered one.
   */
  private wlTargetForPlacement(placement: PanePlacement): Layer | null {
    const d = this.deps!;
    const base = baseLayer(d.layers()) ?? null;
    if (placement.kind !== 'mpr' || !d.isCompare()) return base;
    const overlay = d.selectedOverlay();
    return placement.group >= 1 && overlay ? overlay : base;
  }

  /**
   * Map a window/level drag onto the target window: horizontal displacement
   * shifts the centre, vertical the width, both measured from where the drag
   * began so the window tracks total movement rather than accumulating jitter.
   */
  private dragWindow(event: PointerEvent, drag: Extract<Drag, { kind: 'windowLevel' }>): void {
    const d = this.deps!;
    const layer = drag.layerId ? (d.layers().find((l) => l.id === drag.layerId) ?? null) : null;
    const volume = layer?.volume ?? d.volume();
    if (!volume) return;
    const next = windowLevelDrag(
      { center: drag.startCenter, width: drag.startWidth },
      event.clientX - drag.startX,
      event.clientY - drag.startY,
      windowLevelSensitivity(volume.min, volume.max),
    );
    d.setLayerWindow(layer, next);
    d.markMipSettling();
  }

  /**
   * Wheel over an MPR pane scrolls its slices; wheel over the 3D pane zooms the
   * orbit camera. MPR zoom now lives on the right-drag gesture (see dragZoom), so
   * the wheel is unmodified slice scroll over the MPR panes.
   */
  onWheel(event: WheelEvent): void {
    const d = this.deps;
    if (!d || !d.isReady()) return;
    const placement = d.placementAt(event);
    if (!placement) return;

    event.preventDefault();
    if (placement.kind === 'mip') {
      const bounds = d.canvas().getBoundingClientRect();
      this.zoomCamera(event.deltaY, placement.rect, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    } else {
      this.scrollSlice(placement, event.deltaY);
    }
  }

  /**
   * Wheel over the 3D pane magnifies (scroll up) or shrinks the MIP, anchoring
   * the zoom on the cursor: the structure under the pointer stays roughly fixed,
   * matching the MPR panes' right-drag zoom. The orbit camera's `zoom` changes and
   * its in-plane pan shifts to hold the cursor's world point in place.
   */
  private zoomCamera(deltaY: number, rect: PaneRect, cursor: Vec2): void {
    const d = this.deps!;
    if (deltaY === 0) return;
    const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP; // scroll up zooms in
    const volume = d.volume();
    if (!volume || rect.width < 1 || rect.height < 1) return;
    const from = d.camera3d();
    const to = d.clampZoom(from.zoom * factor);
    if (to === from.zoom) return;

    // Cursor → centred device coords with +y up, matching the raycaster and pick.
    const ndcX = ((cursor.x - rect.x) / rect.width) * 2 - 1;
    const ndcY = 1 - ((cursor.y - rect.y) / rect.height) * 2;
    const { panX, panY } = rezoomCameraPan(volume, from, rect.width, rect.height, to, ndcX, ndcY);
    d.camera3d.set({ ...from, zoom: to, panX, panY });
    d.markMipSettling();
  }

  private scrollSlice(placement: Extract<PanePlacement, { kind: 'mpr' }>, deltaY: number): void {
    const d = this.deps!;
    const renderer = d.renderer();
    if (!renderer || Math.sign(deltaY) === 0) return;
    d.stopCine(); // a manual scroll takes over from cine playback

    const { group, orientation } = placement;
    // Unlinked non-base group: step its own index against its own grid.
    if (d.groupIsIndependent(group)) {
      const volume = d.groupVolume(group);
      if (!volume) return;
      const max = sliceCountFor(volume, orientation) - 1;
      const current = d.groupSliceIndex(group, orientation);
      const next = steppedSliceIndex(current, deltaY, max);
      if (next !== current) d.setGroupSlice(group, orientation, next);
      return;
    }

    // Linked (or group 0): step the master index; linked groups re-derive their
    // own slice from the shared patient plane, so they follow to the same level.
    const max = renderer.sliceCount(orientation) - 1;
    const current = d.masterSliceIndex(orientation);
    const next = steppedSliceIndex(current, deltaY, max);
    if (next !== current) d.setMasterSlice(orientation, next);
  }

  /**
   * Map a right-drag over an MPR pane onto its zoom: vertical travel from the
   * press sets a cumulative magnification (up zooms in), and the zoom pivots on the
   * fixed press point so the structure under it stays put. Both the magnification
   * and the pan are recomputed from the drag's baseline zoom/pan each move, so the
   * gesture tracks total displacement and never drifts. Then re-clamp the pan,
   * since its bound scales with zoom (see cursorZoomPan).
   */
  private dragZoom(event: PointerEvent, drag: Extract<Drag, { kind: 'zoom' }>): void {
    const d = this.deps!;
    const { group, orientation } = drag;
    const placement = d
      .panes()
      .find(
        (pane) => pane.kind === 'mpr' && pane.group === group && pane.orientation === orientation,
      );
    const independent = d.groupIsIndependent(group);
    const volume = independent ? d.groupVolume(group) : d.volume();
    if (!placement || !volume || placement.rect.width < 1 || placement.rect.height < 1) return;

    const factor = Math.exp((drag.startY - event.clientY) * ZOOM_DRAG_SPEED); // up zooms in
    const to = d.clampZoom(drag.startZoom * factor);
    const pan = cursorZoomPan(
      volume,
      orientation,
      placement.rect,
      drag.startZoom,
      to,
      drag.startPan,
      {
        x: drag.anchorX,
        y: drag.anchorY,
      },
    );

    if (independent) d.setGroupZoomPan(group, orientation, to, pan);
    else {
      d.setMasterZoom(orientation, to);
      d.setMasterPan(orientation, pan);
    }
  }

  /**
   * Map a right-drag over the 3D pane onto the orthographic camera's zoom: vertical
   * travel from the press sets a cumulative magnification (up zooms in), pivoting on
   * the fixed press point so the structure under it stays put. Mirrors the MPR
   * dragZoom but drives the camera; recomputed from the drag's baseline each move.
   */
  private dragCameraZoom(event: PointerEvent, drag: Extract<Drag, { kind: 'cameraZoom' }>): void {
    const d = this.deps!;
    const volume = d.volume();
    const mip = d.panes().find((pane) => pane.kind === 'mip');
    if (!volume || !mip || mip.rect.width < 1 || mip.rect.height < 1) return;

    const factor = Math.exp((drag.startY - event.clientY) * ZOOM_DRAG_SPEED); // up zooms in
    const to = d.clampZoom(drag.startZoom * factor);
    const cam = d.camera3d();
    const from = { ...cam, zoom: drag.startZoom, panX: drag.startPanX, panY: drag.startPanY };
    const { panX, panY } = rezoomCameraPan(
      volume,
      from,
      mip.rect.width,
      mip.rect.height,
      to,
      drag.ndcX,
      drag.ndcY,
    );
    d.camera3d.set({ ...cam, zoom: to, panX, panY });
    d.markMipSettling();
  }

  /** The pane under a canvas-relative point, for hover tracking. */
  private placementAtPoint(x: number, y: number): PanePlacement | null {
    for (const pane of this.deps!.panes()) {
      const { rect } = pane;
      if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) {
        return pane;
      }
    }
    return null;
  }
}
