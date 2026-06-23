import type { WritableSignal } from '@angular/core';
import { Orientation, type Layer, type Volume } from '../../dicom/types';
import type { Vec2 } from '../../render/layout';
import type { OrbitCamera } from '../../render/camera';
import type { WindowLevel } from '../../render/window-level';
import type { SliceRenderer } from '../../render/slice-renderer';
import type { PanePlacement } from './viewer';

/**
 * An in-progress pointer drag the controller is tracking. A pan moves one MPR
 * pane; orbit/cameraPan drive the 3D pane; windowLevel adjusts a layer's window.
 * The clipPlane and oblique kinds belong to the in-pane gizmo handlers (still on
 * the component) but share this one signal, so they live in the union too.
 *
 * The windowLevel drag remembers the window it began from and the pointer's start
 * so the move maps total displacement (not a per-event delta) onto the new window
 * — see {@link InteractionController.dragWindow}.
 */
export type Drag =
  | {
      readonly kind: 'pan';
      readonly orientation: Orientation;
      /** Compare-group the panned pane belongs to (0 outside Compare). */
      readonly group: number;
      readonly lastX: number;
      readonly lastY: number;
    }
  | { readonly kind: 'orbit'; readonly lastX: number; readonly lastY: number }
  | { readonly kind: 'cameraPan'; readonly lastX: number; readonly lastY: number }
  | {
      readonly kind: 'zoom';
      readonly orientation: Orientation;
      /** Compare-group the zoomed pane belongs to (0 outside Compare). */
      readonly group: number;
      /** Canvas-relative press point the zoom pivots on (held fixed across the drag). */
      readonly anchorX: number;
      readonly anchorY: number;
      /** Pointer Y when the drag began; vertical travel sets the magnification. */
      readonly startY: number;
      /** Zoom and pan when the drag began — the baseline the pivot re-zooms from. */
      readonly startZoom: number;
      readonly startPan: Vec2;
    }
  | {
      readonly kind: 'cameraZoom';
      /** Centred device coords (+y up) of the press point the 3D zoom pivots on. */
      readonly ndcX: number;
      readonly ndcY: number;
      /** Pointer Y when the drag began; vertical travel sets the magnification. */
      readonly startY: number;
      /** Camera zoom and in-plane pan when the drag began — the pivot baseline. */
      readonly startZoom: number;
      readonly startPanX: number;
      readonly startPanY: number;
    }
  | {
      readonly kind: 'clipPlane';
      /** Cut-plane offset (mm) when the drag began. */
      readonly startOffset: number;
      /** Pointer position when the drag began, in client pixels. */
      readonly startX: number;
      readonly startY: number;
      /** Screen-space drag axis: CSS pixels the handle moves per mm of offset. */
      readonly axisX: number;
      readonly axisY: number;
      /** Largest |offset| (mm) that keeps the plane within the volume. */
      readonly maxOffset: number;
    }
  | {
      readonly kind: 'windowLevel';
      /** The overlay layer's id whose window this drag edits, or null for the base. */
      readonly layerId: string | null;
      readonly startCenter: number;
      readonly startWidth: number;
      readonly startX: number;
      readonly startY: number;
    }
  | {
      readonly kind: 'oblique';
      /** Which MPR pane's plane is being tilted. */
      readonly orientation: Orientation;
      /** Pointer position and tilt angles when the drag began. */
      readonly startX: number;
      readonly startY: number;
      readonly startTiltU: number;
      readonly startTiltV: number;
    };

/**
 * The viewer surface the pointer/wheel state machine drives, supplied once via
 * {@link InteractionController.init} as lazy callbacks so the controller never
 * reaches into the component internals — it reads the panes/volumes/layout and
 * writes the per-orientation view tuples and the 3D camera through these, and so
 * is unit-testable with them mocked.
 */
export interface InteractionInit {
  /** True once a volume is loaded and the GPU is ready. */
  readonly isReady: () => boolean;
  /** The current pane placements, in CSS pixels. */
  readonly panes: () => readonly PanePlacement[];
  /** The WebGPU canvas the gestures happen over (for pointer capture + bounds). */
  readonly canvas: () => HTMLCanvasElement;
  /** The pane under a pointer event (canvas-relative), or null outside the panes. */
  readonly placementAt: (event: MouseEvent) => PanePlacement | null;
  /** Stable key of a pane, for hover tracking. */
  readonly paneKey: (pane: PanePlacement) => string;

  /** The base volume, or null before a load. */
  readonly volume: () => Volume | null;
  /** The volume a Compare group draws (its own when independent, else the base). */
  readonly groupVolume: (group: number) => Volume | null;
  /** Whether a Compare group navigates on its own (unlinked, non-base). */
  readonly groupIsIndependent: (group: number) => boolean;
  /** The zoom a pane uses (shared while linked, the group's own when unlinked). */
  readonly paneZoom: (group: number, orientation: Orientation) => number;
  /** The pan a pane uses (shared while linked, the group's own when unlinked). */
  readonly panePan: (group: number, orientation: Orientation) => Vec2;
  /** The raw master slice index for an orientation (linked / non-Compare scroll). */
  readonly masterSliceIndex: (orientation: Orientation) => number;
  /** An independent group's own slice index for an orientation. */
  readonly groupSliceIndex: (group: number, orientation: Orientation) => number;

  /** Set the shared (linked / non-Compare) pan for an orientation. */
  readonly setMasterPan: (orientation: Orientation, pan: Vec2) => void;
  /** Set the shared zoom for an orientation. */
  readonly setMasterZoom: (orientation: Orientation, zoom: number) => void;
  /** Set the shared slice index for an orientation. */
  readonly setMasterSlice: (orientation: Orientation, index: number) => void;
  /** Set an independent group's pan for an orientation. */
  readonly setGroupPan: (group: number, orientation: Orientation, pan: Vec2) => void;
  /** Set an independent group's zoom and pan for an orientation, in one update. */
  readonly setGroupZoomPan: (
    group: number,
    orientation: Orientation,
    zoom: number,
    pan: Vec2,
  ) => void;
  /** Set an independent group's slice index for an orientation. */
  readonly setGroupSlice: (group: number, orientation: Orientation, index: number) => void;
  /** Clamp a zoom to the viewer's shared zoom bounds. */
  readonly clampZoom: (zoom: number) => number;

  /** The current layers (base + overlays). */
  readonly layers: () => readonly Layer[];
  /** Whether the side-by-side Compare layout is active. */
  readonly isCompare: () => boolean;
  /** The selected fusion overlay layer, or null. */
  readonly selectedOverlay: () => Layer | null;
  /** Read a layer's current window/level (the base reads the shared window). */
  readonly layerWindow: (layer: Layer | null) => WindowLevel;
  /** Write a layer's window/level (the base writes the shared window). */
  readonly setLayerWindow: (layer: Layer | null, next: WindowLevel) => void;

  /** The orbit camera signal; orbit/cameraPan/zoom update it. */
  readonly camera3d: WritableSignal<OrbitCamera>;

  /** The slice renderer, or null before the GPU is ready. */
  readonly renderer: () => SliceRenderer | null;
  /** Stop cine playback (a manual scroll takes over). */
  readonly stopCine: () => void;
  /** Mark the 3D MIP as settling after a zoom / window change. */
  readonly markMipSettling: () => void;

  /** Record the cursor position (canvas-relative CSS pixels), or null when away. */
  readonly setCursor: (point: { readonly x: number; readonly y: number } | null) => void;
  /** Record the hovered pane's key, or null when away. */
  readonly setHoveredKey: (key: string | null) => void;
  /** Remember the last MPR column hovered (so the toolbar WL keeps targeting it). */
  readonly setActiveCompareGroup: (group: number) => void;

  /** Shift+click an MPR pane: set the shared focus voxel there. */
  readonly setFocus: (
    placement: Extract<PanePlacement, { kind: 'mpr' }>,
    event: PointerEvent,
  ) => void;
  /** Shift+click the 3D pane: ray-cast the focus voxel from the projection. */
  readonly setFocusFromMip: (
    placement: Extract<PanePlacement, { kind: 'mip' }>,
    event: PointerEvent,
  ) => void;
  /** The active measurement tool, or `none` for the default pan/orbit gestures. */
  readonly activeTool: () => string;
  /** Place the next measurement point on an MPR pane (with a tool active). */
  readonly placeMeasurePoint: (
    placement: Extract<PanePlacement, { kind: 'mpr' }>,
    event: PointerEvent,
  ) => void;
}
