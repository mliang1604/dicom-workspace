import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { initWebGpu, type GpuContext } from '../../render/device';
import {
  LayoutMode,
  mprLayout,
  scaleRect,
  singleLayout,
  triLayout,
  type PaneRect,
  type Vec2,
} from '../../render/layout';
import {
  clampPan,
  defaultSlabThicknessMm,
  isDvr,
  ProjectionMode,
  rezoomPan,
  SliceRenderer,
  type PaneView,
} from '../../render/slice-renderer';
import { TRANSFER_FUNCTION_PRESETS, TransferFunctionPreset } from '../../render/transfer-function';
import { slicePlaneCorners, volumeBounds } from '../../render/reslice';
import {
  windowLevelDrag,
  windowLevelSensitivity,
  windowPresets,
  type WindowPreset,
} from '../../render/window-level';
import { cameraBasis, projectToPane, type OrbitCamera } from '../../render/camera';
import { axisMarkers } from '../../render/axis-indicator';
import { pickProjection } from '../../render/pick';
import { probeVoxel, type VoxelProbe } from '../../render/probe';
import { focusPanePoint, focusSliceIndex } from '../../render/crosshair';
import { modalityUnit, Orientation, type MissingSlices, type Volume } from '../../dicom/types';
import type { Series } from '../../dicom/series';
import { VolumeLoader, type LoadResult } from '../volume-loader';

/** What the viewer is currently showing, as one-shape-at-a-time state. */
type LoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly result: LoadResult }
  | { readonly status: 'error'; readonly message: string };

/** A pane's placement on screen, in CSS pixels, plus what it shows. */
type PanePlacement =
  | { readonly kind: 'mpr'; readonly orientation: Orientation; readonly rect: PaneRect }
  | { readonly kind: 'mip'; readonly rect: PaneRect };

/** One projected patient axis, placed in the indicator widget's local pixels. */
interface AxisOverlayMarker {
  /** R, L, A, P, S, or I. */
  readonly label: string;
  /** Label centre in widget-local CSS pixels (origin at the widget's top-left). */
  readonly x: number;
  readonly y: number;
  /** 0–1 opacity: axes pointing toward the viewer are bright, those behind fade. */
  readonly opacity: number;
}

/** The orientation indicator overlaid in a corner of the 3D pane. */
interface AxisOverlay {
  /** Widget top-left in CSS pixels relative to the canvas. */
  readonly left: number;
  readonly top: number;
  /** Square widget size in CSS pixels. */
  readonly size: number;
  /** Widget-local centre (the axis hub) in CSS pixels. */
  readonly center: number;
  /** The six axes, sorted far-to-near so near labels render on top. */
  readonly markers: readonly AxisOverlayMarker[];
}

/** One MPR cut-plane outline projected into the 3D pane. */
interface SlicePlaneOverlay {
  readonly orientation: Orientation;
  /** SVG polygon `points` in 3D-pane-local CSS pixels (origin at the pane's top-left). */
  readonly points: string;
  /** Outline colour, matched to the pane's orientation. */
  readonly color: string;
}

/** The three MPR cut-planes drawn inside the 3D pane to show where each slices. */
interface SlicePlanesOverlay {
  /** The 3D pane's rectangle in CSS pixels; the SVG is positioned and clipped to it. */
  readonly rect: PaneRect;
  readonly planes: readonly SlicePlaneOverlay[];
}

/** A linked crosshair drawn over an MPR pane at the shared focus voxel. */
interface CrosshairOverlay {
  /** Key of the pane it belongs to (see {@link Viewer.paneKey}). */
  readonly key: string;
  /** The pane's rectangle in CSS pixels. */
  readonly rect: PaneRect;
  /** Focus point in CSS pixels relative to the canvas. */
  readonly x: number;
  readonly y: number;
}

/** A value per orientation, indexed by the orientation's numeric value. */
type PerOrientation = readonly [number, number, number];

/** A pan offset per orientation, indexed by the orientation's numeric value. */
type PerOrientationPan = readonly [Vec2, Vec2, Vec2];

/**
 * An in-progress drag: panning an MPR pane, orbiting the 3D pane, or adjusting
 * the shared window/level. The window/level drag remembers the window it began
 * from and the pointer's start, so the move maps total displacement (not a
 * per-event delta) onto the new window — see {@link Viewer.dragWindow}.
 */
type Drag =
  | {
      readonly kind: 'pan';
      readonly orientation: Orientation;
      readonly lastX: number;
      readonly lastY: number;
    }
  | { readonly kind: 'orbit'; readonly lastX: number; readonly lastY: number }
  | {
      readonly kind: 'windowLevel';
      readonly startCenter: number;
      readonly startWidth: number;
      readonly startX: number;
      readonly startY: number;
    };

const NO_PAN: Vec2 = { x: 0, y: 0 };
const NO_PANS: PerOrientationPan = [NO_PAN, NO_PAN, NO_PAN];

/** Short 3D-pane tags, indexed by {@link ProjectionMode}, for the pane label. */
const MODE_TAGS: Readonly<Record<ProjectionMode, string>> = {
  [ProjectionMode.Max]: 'MIP',
  [ProjectionMode.Min]: 'MinIP',
  [ProjectionMode.Mean]: 'Average',
  [ProjectionMode.Dvr]: 'DVR',
};

/** Order the main (top-left) pane cycles through when swapping. */
const ORIENTATION_ORDER = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal] as const;

const ZOOM_STEP = 1.1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 20;

/** Radians of orbit per pixel dragged over the 3D pane. */
const ORBIT_SPEED = 0.01;
/** Cap the elevation just shy of the poles to avoid a degenerate up vector. */
const MAX_ELEVATION = 1.45;
/** Default 3D view: a slight three-quarter orbit, patient superior up. */
const DEFAULT_CAMERA: OrbitCamera = { azimuth: 0.4, elevation: 0.25, zoom: 1 };

/**
 * Only warn about interpolation when the widest gap spans more than this
 * multiple of the slice spacing. A gap up to 2× spacing is a single missing
 * slice (or spacing jitter), which interpolates cleanly and isn't worth a
 * banner; wider gaps leave a visible reconstructed region.
 */
const GAP_WARNING_RATIO = 2;

/**
 * Outline colour of each MPR cut-plane drawn in the 3D pane, indexed by the
 * Orientation value — distinct hues so the three planes read apart at a glance.
 */
const SLICE_PLANE_COLORS: readonly [string, string, string] = ['#ff6b6b', '#5ee08a', '#6bb6ff'];

/** Square size (CSS px) of the 3D pane's orientation indicator widget. */
const AXIS_INDICATOR_SIZE = 72;
/** Length (CSS px) of each axis spoke from the indicator's hub to its label. */
const AXIS_INDICATOR_RADIUS = 24;
/** Inset (CSS px) of the indicator from the 3D pane's top-right corner. */
const AXIS_INDICATOR_MARGIN = 12;

/**
 * How long after the last wheel-zoom or window/level change the 3D MIP keeps
 * rendering at reduced quality before snapping back to a full-quality frame.
 * Orbit drags don't need this — pointer-up settles them directly.
 */
const MIP_SETTLE_MS = 200;

@Component({
  selector: 'app-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './viewer.html',
  styleUrl: './viewer.css',
  host: {
    '(window:keydown.x)': 'onSwapKey($event)',
    '(window:keydown.f)': 'onFlipKey($event)',
    '(window:keydown.c)': 'onCrosshairKey($event)',
    '(window:keydown.l)': 'onLayoutKey($event)',
  },
})
export class Viewer {
  private readonly loader = inject(VolumeLoader);
  private readonly destroyRef = inject(DestroyRef);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private readonly renderer = signal<SliceRenderer | null>(null);
  private readonly load = signal<LoadState>({ status: 'idle' });
  private readonly gpuError = signal<string | null>(null);
  /** Canvas size in CSS pixels plus the device-pixel ratio; drives layout + render. */
  private readonly viewport = signal({ width: 0, height: 0, dpr: 1 });

  private readonly sliceIndices = signal<PerOrientation>([0, 0, 0]);
  private readonly zooms = signal<PerOrientation>([1, 1, 1]);
  /** Per-orientation pan offset in screen-uv units; drives shader + probe. */
  private readonly pans = signal<PerOrientationPan>(NO_PANS);
  /** Orbit/zoom state of the 3D MIP pane. */
  private readonly camera3d = signal<OrbitCamera>(DEFAULT_CAMERA);
  /** What the 3D pane renders (MIP / MinIP / Average / DVR). */
  protected readonly projectionMode = signal<ProjectionMode>(ProjectionMode.Max);
  /** Transfer-function preset used when the 3D pane is in DVR mode. */
  protected readonly transferFunction = signal<TransferFunctionPreset>(
    TransferFunctionPreset.CtBone,
  );
  /** When true, clip the 3D pane to the MPR slice planes for a cut-away view. */
  protected readonly clipToPlanes = signal(false);
  /** True when the 3D pane is in direct-volume-rendering mode (drives the UI). */
  protected readonly isDvrMode = computed(() => isDvr(this.projectionMode()));
  /**
   * Thick-slab thickness (mm) for the 3D pane, centred on the volume along the
   * view direction. Defaults to the volume's full depth (whole-volume projection).
   */
  protected readonly slabThicknessMm = signal(0);
  /** The 3D-mode options offered in the toolbar, in display order. */
  protected readonly projectionModes = [
    { value: ProjectionMode.Max, label: 'MIP (max)' },
    { value: ProjectionMode.Min, label: 'MinIP (min)' },
    { value: ProjectionMode.Mean, label: 'Average' },
    { value: ProjectionMode.Dvr, label: 'DVR (volume)' },
  ] as const;
  /** Transfer-function presets offered for DVR, in display order. */
  protected readonly transferFunctions = TRANSFER_FUNCTION_PRESETS;
  /** Short tag for the 3D pane's current mode (with the cut-away state appended). */
  protected readonly mode3dTag = computed(() => {
    const label = MODE_TAGS[this.projectionMode()];
    return this.clipToPlanes() ? `${label} ✂` : label;
  });
  /** The in-progress drag (pan or orbit), or null when no button is held. */
  private readonly drag = signal<Drag | null>(null);
  /**
   * True briefly after a wheel-zoom or window/level change so the MIP renders at
   * reduced quality; cleared by a {@link MIP_SETTLE_MS} timeout for the final
   * full-quality frame. Orbit interaction is read from {@link drag} directly.
   */
  private readonly mipSettling = signal(false);
  protected readonly isPanning = computed(() => this.drag() !== null);
  protected readonly mainOrientation = signal<Orientation>(Orientation.Axial);
  /** When true, the sagittal view is mirrored so anterior sits on the right. */
  protected readonly sagittalFlipped = signal(false);
  /** Shared focus voxel set by Shift+click, navigated to in every pane; null until set. */
  private readonly focusVoxel = signal<readonly [number, number, number] | null>(null);
  /** When true (default), draw the linked crosshair at the focus voxel in each MPR pane. */
  protected readonly crosshairsEnabled = signal(true);
  /** Key of the hovered pane (see {@link paneKey}), or null when away. */
  protected readonly hoveredKey = signal<string | null>(null);
  /** Cursor position in CSS pixels relative to the canvas, or null when away. */
  private readonly cursor = signal<{ readonly x: number; readonly y: number } | null>(null);
  protected readonly windowCenter = signal(0);
  protected readonly windowWidth = signal(1);

  /** Window/level presets offered for the loaded volume (CT windows, or default). */
  protected readonly wlPresets = computed<WindowPreset[]>(() => {
    const volume = this.volume();
    return volume ? windowPresets(volume) : [];
  });

  protected readonly isReady = computed(
    () => this.load().status === 'ready' && this.renderer() !== null,
  );

  /** Series found in the loaded files, for the picker. Empty until a load succeeds. */
  protected readonly seriesList = computed<readonly Series[]>(() => {
    const state = this.load();
    return state.status === 'ready' ? state.result.series : [];
  });
  /** UID of the series currently displayed; '' when nothing is loaded. */
  protected readonly selectedSeriesUid = computed(() => {
    const state = this.load();
    return state.status === 'ready' ? state.result.selectedUid : '';
  });
  /** Only show the picker when a folder held more than one series. */
  protected readonly hasMultipleSeries = computed(() => this.seriesList().length > 1);

  /** The selected viewport layout; defaults to the classic 3-pane MPR (1+2) view. */
  protected readonly layoutMode = signal<LayoutMode>(LayoutMode.TriMpr);
  /** The layout options the cycle button steps through, in display order. */
  protected readonly layoutModes = [
    { value: LayoutMode.TriMpr, label: '3-pane MPR' },
    { value: LayoutMode.Quad, label: '4-pane' },
    { value: LayoutMode.Volume3d, label: '3D only' },
  ] as const;
  /** Human label for the current layout, shown on the cycle button. */
  protected readonly layoutLabel = computed(
    () => this.layoutModes.find((m) => m.value === this.layoutMode())?.label ?? '',
  );

  /** Pane placements in CSS pixels, for the label overlay. */
  protected readonly panes = computed<PanePlacement[]>(() => {
    const { width, height } = this.viewport();
    return placePanes(this.layoutMode(), width, height, this.mainOrientation());
  });

  /** Whether the current layout includes the 3D pane (drives 3D-control enablement). */
  protected readonly has3dPane = computed(() => this.panes().some((pane) => pane.kind === 'mip'));
  /** Whether the current layout includes any MPR pane (drives swap/flip enablement). */
  protected readonly hasMprPane = computed(() => this.panes().some((pane) => pane.kind === 'mpr'));

  /**
   * Linked crosshairs to overlay: the shared focus voxel projected into every MPR
   * pane via {@link focusPanePoint} — the forward map the probe inverts — so each
   * mark tracks pan, zoom, scroll and flip. A pane is dropped when the point falls
   * outside its rect (panned/zoomed off-screen).
   */
  protected readonly crosshairs = computed<CrosshairOverlay[]>(() => {
    const voxel = this.focusVoxel();
    const volume = this.volume();
    if (!this.crosshairsEnabled() || !voxel || !volume) return [];

    const zooms = this.zooms();
    const pans = this.pans();
    const flipped = this.sagittalFlipped();
    const result: CrosshairOverlay[] = [];
    for (const pane of this.panes()) {
      if (pane.kind !== 'mpr') continue;
      const point = focusPanePoint(
        volume,
        pane.orientation,
        voxel,
        zooms[pane.orientation],
        pane.rect,
        pane.orientation === Orientation.Sagittal && flipped,
        pans[pane.orientation],
      );
      if (!point || !withinRect(pane.rect, point.x, point.y)) continue;
      result.push({ key: this.paneKey(pane), rect: pane.rect, x: point.x, y: point.y });
    }
    return result;
  });

  /**
   * The three MPR cut-planes drawn inside the 3D pane: each orientation's slice
   * rectangle ({@link slicePlaneCorners}) projected through the orbit camera with
   * {@link projectToPane} — the forward map the 3D pick inverts — so the outlines
   * track the MPR slice positions and rotate live with the orbit. A pure SVG
   * overlay clipped to the pane, sharing the {@link crosshairsEnabled} toggle with
   * the linked crosshairs. Recomputed only from the camera and slice indices.
   */
  protected readonly slicePlanes = computed<SlicePlanesOverlay | null>(() => {
    const volume = this.volume();
    if (!this.crosshairsEnabled() || !this.isReady() || !volume) return null;
    const mip = this.panes().find((pane) => pane.kind === 'mip');
    if (!mip) return null;

    const basis = cameraBasis(volume, this.camera3d(), mip.rect.width, mip.rect.height);
    const indices = this.sliceIndices();
    const planes = ORIENTATION_ORDER.map((orientation) => {
      const points = slicePlaneCorners(volume, orientation, indices[orientation])
        .map((corner) => {
          const { u, v } = projectToPane(basis, corner);
          return `${(u * mip.rect.width).toFixed(1)},${(v * mip.rect.height).toFixed(1)}`;
        })
        .join(' ');
      return { orientation, points, color: SLICE_PLANE_COLORS[orientation] };
    });
    return { rect: mip.rect, planes };
  });

  /**
   * Anatomical orientation indicator for the 3D pane: the six patient axes
   * projected through the orbit camera ({@link axisMarkers}) and placed in a
   * small widget in the pane's top-right corner, so it rotates live with the
   * orbit. It's a pure-CSS/SVG overlay — no extra GPU pass — keyed only off the
   * camera angles, so panning or scrolling the MPR panes never touches it.
   */
  protected readonly axisIndicator = computed<AxisOverlay | null>(() => {
    if (!this.isReady()) return null;
    const mip = this.panes().find((pane) => pane.kind === 'mip');
    if (!mip) return null;

    const size = AXIS_INDICATOR_SIZE;
    const center = size / 2;
    const left = mip.rect.x + mip.rect.width - AXIS_INDICATOR_MARGIN - size;
    const top = mip.rect.y + AXIS_INDICATOR_MARGIN;

    const camera = this.camera3d();
    const markers = axisMarkers(camera.azimuth, camera.elevation)
      .map((axis) => ({
        label: axis.label,
        // Widget-local pixels: +x is screen-right, +y (up) flips to CSS down.
        x: center + axis.x * AXIS_INDICATOR_RADIUS,
        y: center - axis.y * AXIS_INDICATOR_RADIUS,
        depth: axis.depth,
        // Fade the away-facing axes; keep the near ones fully opaque.
        opacity: 0.35 + 0.65 * ((axis.depth + 1) / 2),
      }))
      // Paint far axes first so the near labels (drawn last) sit on top.
      .sort((a, b) => a.depth - b.depth);
    return { left, top, size, center, markers };
  });

  protected readonly statusIsError = computed(
    () => this.gpuError() !== null || this.load().status === 'error',
  );

  /** Warns that reconstructed planes are interpolated across significant gaps. */
  protected readonly interpolationWarning = computed<string | null>(() => {
    const volume = this.volume();
    return volume ? missingSliceWarning(volume.missingSlices, volume.spacing[2]) : null;
  });

  protected readonly statusText = computed(() => {
    const gpuError = this.gpuError();
    if (gpuError) return gpuError;
    const state = this.load();
    switch (state.status) {
      case 'idle':
        return 'Open a DICOM folder or files to begin.';
      case 'loading':
        return 'Loading…';
      case 'ready':
        return describeVolume(state.result);
      case 'error':
        return state.message;
      default: {
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  });

  private readonly volume = computed<Volume | null>(() => {
    const state = this.load();
    return state.status === 'ready' ? state.result.volume : null;
  });

  /**
   * The volume's full depth (mm): the upper bound and default for the slab
   * thickness control, at which the slab covers the whole volume.
   */
  protected readonly slabMaxMm = computed(() => {
    const volume = this.volume();
    return volume ? Math.round(2 * volumeBounds(volume).radius) : 0;
  });

  /** Live readout of the voxel under the cursor, or null when none is hovered. */
  protected readonly probeText = computed<string | null>(() => {
    if (!this.isReady()) return null;
    const cursor = this.cursor();
    const volume = this.volume();
    if (!cursor || !volume) return null;

    const pane = placementAt(this.panes(), cursor.x, cursor.y);
    if (!pane || pane.kind !== 'mpr') return null; // no voxel probe over the 3D pane

    const sample = probeVoxel(
      volume,
      pane.orientation,
      this.sliceIndices()[pane.orientation],
      this.zooms()[pane.orientation],
      pane.rect,
      cursor.x,
      cursor.y,
      pane.orientation === Orientation.Sagittal && this.sagittalFlipped(),
      this.pans()[pane.orientation],
    );
    if (!sample) return null;
    return formatProbe(this.orientationName(pane.orientation), sample, volume);
  });

  private gpu: GpuContext | null = null;

  /** Views computed by the render effect, awaiting the next animation frame. */
  private pendingViews: PaneView[] | null = null;
  /** Handle of the scheduled animation frame, or null when none is pending. */
  private frameHandle: number | null = null;
  /** Handle of the MIP settle timeout, or null when not settling. */
  private settleHandle: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    afterNextRender(() => void this.initGpu());

    // The effect tracks every signal the frame depends on and computes the
    // views, but defers the actual GPU submission to a single requestAnimationFrame
    // (see scheduleFrame). Multiple signal changes within one frame — e.g. the
    // stream of pointer moves during an orbit drag — collapse into one render.
    effect(() => {
      const renderer = this.renderer();
      const volume = this.volume();
      const panes = this.panes();
      const { dpr } = this.viewport();
      const indices = this.sliceIndices();
      const zooms = this.zooms();
      const pans = this.pans();
      const camera = this.camera3d();
      const projectionMode = this.projectionMode();
      const transferFunction = this.transferFunction();
      const clipToPlanes = this.clipToPlanes();
      const slabThicknessMm = this.slabThicknessMm();
      const windowCenter = this.windowCenter();
      const windowWidth = this.windowWidth();
      const sagittalFlipped = this.sagittalFlipped();
      // The MIP renders at reduced quality while it's being orbited, zoomed, or
      // window/levelled, then at full quality once interaction settles.
      const mipInteractive = this.drag()?.kind === 'orbit' || this.mipSettling();
      if (!renderer || !volume) return;

      this.pendingViews = panes.map((pane) =>
        pane.kind === 'mip'
          ? {
              kind: 'mip',
              windowCenter,
              windowWidth,
              camera,
              projectionMode,
              transferFunction,
              clipToPlanes,
              sliceIndices: indices,
              slabThicknessMm,
              interactive: mipInteractive,
              rect: scaleRect(pane.rect, dpr),
            }
          : {
              kind: 'mpr',
              orientation: pane.orientation,
              sliceIndex: indices[pane.orientation],
              windowCenter,
              windowWidth,
              zoom: zooms[pane.orientation],
              pan: pans[pane.orientation],
              flipX: pane.orientation === Orientation.Sagittal && sagittalFlipped,
              rect: scaleRect(pane.rect, dpr),
            },
      );
      this.scheduleFrame();
    });

    this.destroyRef.onDestroy(() => {
      if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
      if (this.settleHandle !== null) clearTimeout(this.settleHandle);
    });
  }

  /** Submit the latest computed views on the next frame, coalescing rapid updates. */
  private scheduleFrame(): void {
    if (this.frameHandle !== null) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = null;
      const renderer = this.renderer();
      const views = this.pendingViews;
      if (renderer && views) renderer.renderPanes(views);
    });
  }

  /**
   * Mark the MIP as actively changing (wheel-zoom or window/level), keeping it at
   * reduced quality until {@link MIP_SETTLE_MS} of quiet, then a full-quality frame.
   */
  private markMipSettling(): void {
    this.mipSettling.set(true);
    if (this.settleHandle !== null) clearTimeout(this.settleHandle);
    this.settleHandle = setTimeout(() => {
      this.settleHandle = null;
      this.mipSettling.set(false);
    }, MIP_SETTLE_MS);
  }

  protected orientationName(orientation: Orientation): string {
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

  /** Stable identity for a placement, used for `@for` tracking and hover state. */
  protected paneKey(pane: PanePlacement): string {
    return pane.kind === 'mip' ? 'mip' : `mpr-${pane.orientation}`;
  }

  protected paneSliceLabel(orientation: Orientation): string {
    const renderer = this.renderer();
    const count = renderer ? renderer.sliceCount(orientation) : 0;
    return count > 0 ? `${this.sliceIndices()[orientation] + 1} / ${count}` : '–';
  }

  /** Step the viewport to the next layout (3-pane → 4-pane → 3D-only → …). */
  protected cycleLayout(): void {
    this.layoutMode.update((mode) => {
      const i = this.layoutModes.findIndex((m) => m.value === mode);
      return this.layoutModes[(i + 1) % this.layoutModes.length].value;
    });
  }

  protected onLayoutKey(event: Event): void {
    if (event.target instanceof HTMLInputElement || !this.isReady()) return;
    event.preventDefault();
    this.cycleLayout();
  }

  protected swapMain(): void {
    this.mainOrientation.update((current) => {
      const next = (ORIENTATION_ORDER.indexOf(current) + 1) % ORIENTATION_ORDER.length;
      return ORIENTATION_ORDER[next];
    });
  }

  protected toggleSagittalFlip(): void {
    this.sagittalFlipped.update((flipped) => !flipped);
  }

  protected onSwapKey(event: Event): void {
    if (event.target instanceof HTMLInputElement || !this.isReady()) return;
    event.preventDefault();
    this.swapMain();
  }

  protected onFlipKey(event: Event): void {
    if (event.target instanceof HTMLInputElement || !this.isReady()) return;
    event.preventDefault();
    this.toggleSagittalFlip();
  }

  protected toggleCrosshairs(): void {
    this.crosshairsEnabled.update((enabled) => !enabled);
  }

  protected onCrosshairKey(event: Event): void {
    if (event.target instanceof HTMLInputElement || !this.isReady()) return;
    event.preventDefault();
    this.toggleCrosshairs();
  }

  /**
   * Set the shared focus voxel from a Shift+click on an MPR pane and scroll every
   * orientation to the slice that contains it. The clicked pane keeps its slice
   * (the voxel lies on it); the other two move to show the same anatomical point.
   */
  private setFocus(placement: Extract<PanePlacement, { kind: 'mpr' }>, event: PointerEvent): void {
    const volume = this.volume();
    if (!volume) return;
    const bounds = this.canvasRef().nativeElement.getBoundingClientRect();
    const sample = probeVoxel(
      volume,
      placement.orientation,
      this.sliceIndices()[placement.orientation],
      this.zooms()[placement.orientation],
      placement.rect,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      placement.orientation === Orientation.Sagittal && this.sagittalFlipped(),
      this.pans()[placement.orientation],
    );
    if (!sample) return; // clicked the letterbox margin or outside the volume

    this.navigateToVoxel(volume, sample.voxel);
  }

  /**
   * Set the shared focus from a Shift+click on the 3D pane: ray-cast the clicked
   * pixel to the location its projection came from (the brightest sample for MIP),
   * then navigate every MPR pane there — the 3D view acting as a locator. Uses the
   * same camera, projection mode and slab the pane is rendering, so the pick lands
   * on the voxel shown under the cursor.
   */
  private setFocusFromMip(
    placement: Extract<PanePlacement, { kind: 'mip' }>,
    event: PointerEvent,
  ): void {
    const volume = this.volume();
    if (!volume) return;
    const bounds = this.canvasRef().nativeElement.getBoundingClientRect();
    const pick = pickProjection(
      volume,
      this.camera3d(),
      this.projectionMode(),
      this.slabThicknessMm(),
      placement.rect,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      {
        clipToPlanes: this.clipToPlanes(),
        sliceIndices: this.sliceIndices(),
        transferFunction: this.transferFunction(),
      },
    );
    if (!pick) return; // the ray missed the volume (or, for DVR, hit nothing solid)
    this.navigateToVoxel(volume, pick.voxel);
  }

  /** Make `voxel` the shared focus and scroll every orientation to its slice. */
  private navigateToVoxel(volume: Volume, voxel: readonly [number, number, number]): void {
    this.focusVoxel.set(voxel);
    this.crosshairsEnabled.set(true); // a fresh pick should always be visible
    this.sliceIndices.set([
      focusSliceIndex(volume, Orientation.Axial, voxel),
      focusSliceIndex(volume, Orientation.Coronal, voxel),
      focusSliceIndex(volume, Orientation.Sagittal, voxel),
    ]);
  }

  /** Switch the displayed series, rebuilding its volume from the parsed slices. */
  protected onSeriesChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const state = this.load();
    if (state.status !== 'ready' || event.target.value === state.result.selectedUid) return;
    this.applyVolume(this.loader.selectSeries(state.result, event.target.value));
  }

  /** Picker label: description (or a fallback) · modality · slice count. */
  protected seriesLabel(series: Series): string {
    const name = series.description || series.modality || `Series ${series.seriesNumber ?? '?'}`;
    const modality = series.modality ? ` · ${series.modality}` : '';
    return `${name}${modality} · ${series.imageCount} img`;
  }

  protected async onFilesSelected(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.files) return;
    const files = Array.from(input.files);
    input.value = ''; // allow re-selecting the same folder
    if (files.length > 0) await this.loadFiles(files);
  }

  /** Begin a click-drag over the pane under the pointer. */
  protected onPointerDown(event: PointerEvent): void {
    if (!this.isReady()) return;
    const placement = this.placementAtEvent(event);
    if (!placement) return;

    // Right-button drag adjusts the shared window/level over any pane — the
    // standard PACS gesture, picked because it never clashes with the
    // left-button pan/orbit or the Ctrl+wheel zoom. Horizontal moves the centre,
    // vertical the width (see dragWindow). The context menu is suppressed below.
    if (event.button === 2) {
      event.preventDefault();
      this.canvasRef().nativeElement.setPointerCapture(event.pointerId);
      this.drag.set({
        kind: 'windowLevel',
        startCenter: this.windowCenter(),
        startWidth: this.windowWidth(),
        startX: event.clientX,
        startY: event.clientY,
      });
      return;
    }

    if (event.button !== 0) return;
    event.preventDefault();

    // Shift+left-click sets the shared focus voxel and navigates every pane to it,
    // instead of starting a pan/orbit — a modifier that never clashes with the
    // plain left-drag or the right-drag W/L. Over an MPR pane it probes the slice;
    // over the 3D pane it ray-casts the projection to the location it came from.
    if (event.shiftKey) {
      if (placement.kind === 'mpr') this.setFocus(placement, event);
      else this.setFocusFromMip(placement, event);
      return;
    }

    // Capture so the drag keeps tracking even if the pointer leaves the canvas.
    this.canvasRef().nativeElement.setPointerCapture(event.pointerId);
    // The 3D pane orbits; the MPR panes pan.
    this.drag.set(
      placement.kind === 'mip'
        ? { kind: 'orbit', lastX: event.clientX, lastY: event.clientY }
        : {
            kind: 'pan',
            orientation: placement.orientation,
            lastX: event.clientX,
            lastY: event.clientY,
          },
    );
  }

  /** Suppress the browser context menu so right-button W/L drags work. */
  protected onContextMenu(event: Event): void {
    if (this.isReady()) event.preventDefault();
  }

  protected onPointerMove(event: PointerEvent): void {
    const drag = this.drag();
    if (drag?.kind === 'pan') this.dragPan(event, drag);
    else if (drag?.kind === 'orbit') this.dragOrbit(event, drag);
    else if (drag?.kind === 'windowLevel') this.dragWindow(event, drag);

    const bounds = this.canvasRef().nativeElement.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    this.cursor.set({ x, y });
    const hovered = placementAt(this.panes(), x, y);
    this.hoveredKey.set(hovered ? this.paneKey(hovered) : null);
  }

  protected onPointerUp(event: PointerEvent): void {
    if (!this.drag()) return;
    const canvas = this.canvasRef().nativeElement;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    this.drag.set(null);
  }

  protected onPointerLeave(): void {
    this.cursor.set(null);
    this.hoveredKey.set(null);
  }

  /** Accumulate a pointer move into the 3D camera's orbit angles. */
  private dragOrbit(event: PointerEvent, drag: Extract<Drag, { kind: 'orbit' }>): void {
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    this.drag.set({ ...drag, lastX: event.clientX, lastY: event.clientY });
    this.camera3d.update((cam) => ({
      azimuth: cam.azimuth + dx * ORBIT_SPEED,
      elevation: clamp(cam.elevation - dy * ORBIT_SPEED, -MAX_ELEVATION, MAX_ELEVATION),
      zoom: cam.zoom,
    }));
  }

  /** Accumulate a pointer move into the dragged pane's pan, clamped to bounds. */
  private dragPan(event: PointerEvent, drag: Extract<Drag, { kind: 'pan' }>): void {
    this.drag.set({ ...drag, lastX: event.clientX, lastY: event.clientY });

    const placement = this.panes().find(
      (pane) => pane.kind === 'mpr' && pane.orientation === drag.orientation,
    );
    const volume = this.volume();
    if (!placement || !volume || placement.rect.width < 1 || placement.rect.height < 1) return;

    const dx = (event.clientX - drag.lastX) / placement.rect.width;
    const dy = (event.clientY - drag.lastY) / placement.rect.height;
    const zoom = this.zooms()[drag.orientation];
    this.pans.update((pans) => {
      const current = pans[drag.orientation];
      const moved = clampPan(
        volume,
        drag.orientation,
        placement.rect.width,
        placement.rect.height,
        zoom,
        {
          x: current.x + dx,
          y: current.y + dy,
        },
      );
      return withValue(pans, drag.orientation, moved);
    });
  }

  /**
   * Map a window/level drag onto the shared window: horizontal displacement
   * shifts the centre, vertical the width, both measured from where the drag
   * began so the window tracks total movement rather than accumulating jitter.
   */
  private dragWindow(event: PointerEvent, drag: Extract<Drag, { kind: 'windowLevel' }>): void {
    const volume = this.volume();
    if (!volume) return;
    const next = windowLevelDrag(
      { center: drag.startCenter, width: drag.startWidth },
      event.clientX - drag.startX,
      event.clientY - drag.startY,
      windowLevelSensitivity(volume.min, volume.max),
    );
    this.windowCenter.set(next.center);
    this.windowWidth.set(next.width);
    this.markMipSettling();
  }

  /**
   * Wheel over an MPR pane scrolls its slices (Ctrl+wheel zooms it); wheel over
   * the 3D pane zooms the orbit camera.
   */
  protected onWheel(event: WheelEvent): void {
    if (!this.isReady()) return;
    const placement = this.placementAtEvent(event);
    if (!placement) return;

    event.preventDefault();
    if (placement.kind === 'mip') {
      this.zoomCamera(event.deltaY);
    } else if (event.ctrlKey) {
      const bounds = this.canvasRef().nativeElement.getBoundingClientRect();
      this.zoomPane(placement.orientation, event.deltaY, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    } else {
      this.scrollSlice(placement.orientation, event.deltaY);
    }
  }

  /** Wheel over the 3D pane magnifies (scroll up) or shrinks the MIP. */
  private zoomCamera(deltaY: number): void {
    if (deltaY === 0) return;
    const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP; // scroll up zooms in
    this.camera3d.update((cam) => ({
      ...cam,
      zoom: clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM),
    }));
    this.markMipSettling();
  }

  private scrollSlice(orientation: Orientation, deltaY: number): void {
    const renderer = this.renderer();
    const step = Math.sign(deltaY);
    if (!renderer || step === 0) return;

    const max = renderer.sliceCount(orientation) - 1;
    this.sliceIndices.update((indices) => {
      const next = clamp(indices[orientation] + step, 0, max);
      return next === indices[orientation] ? indices : withValue(indices, orientation, next);
    });
  }

  private zoomPane(orientation: Orientation, deltaY: number, cursor: Vec2): void {
    if (deltaY === 0) return;
    const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP; // scroll up zooms in
    const from = this.zooms()[orientation];
    const to = clamp(from * factor, MIN_ZOOM, MAX_ZOOM);
    if (to === from) return;
    this.zooms.update((zooms) => withValue(zooms, orientation, to));

    const placement = this.panes().find(
      (pane) => pane.kind === 'mpr' && pane.orientation === orientation,
    );
    const volume = this.volume();
    if (!placement || !volume) return;
    // Pivot the zoom on the cursor, not the image centre: holding the plane point
    // under the cursor fixed keeps the spot being inspected in place. The anchor
    // is the cursor in screen-uv (pane-fraction) units. Then re-clamp, since the
    // pan bound scales with zoom.
    const anchor: Vec2 = {
      x: (cursor.x - placement.rect.x) / placement.rect.width,
      y: (cursor.y - placement.rect.y) / placement.rect.height,
    };
    this.pans.update((pans) => {
      const anchored = rezoomPan(pans[orientation], from, to, anchor);
      const clamped = clampPan(
        volume,
        orientation,
        placement.rect.width,
        placement.rect.height,
        to,
        anchored,
      );
      return withValue(pans, orientation, clamped);
    });
  }

  protected onWindowCenterInput(event: Event): void {
    this.windowCenter.set(intValue(event));
    this.markMipSettling();
  }

  protected onWindowWidthInput(event: Event): void {
    this.windowWidth.set(Math.max(1, intValue(event)));
    this.markMipSettling();
  }

  /** Apply the chosen window/level preset, then reset the selector to its label. */
  protected onPresetChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const preset = this.wlPresets()[Number(event.target.value)];
    event.target.selectedIndex = 0; // back to the "Preset…" placeholder so re-picking fires
    if (!preset) return;
    this.windowCenter.set(preset.center);
    this.windowWidth.set(preset.width);
    this.markMipSettling();
  }

  /** Switch the 3D pane's mode (MIP / MinIP / Average / DVR). */
  protected onProjectionModeChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const mode = Number(event.target.value) as ProjectionMode;
    this.projectionMode.set(mode);
    // Reset the slab to the mode's default: full-volume for MIP/DVR, a moderate
    // band for MinIP/Average (keeps the air margins out). Reversible across switches.
    this.slabThicknessMm.set(Math.round(defaultSlabThicknessMm(mode, this.slabMaxMm())));
    this.markMipSettling();
  }

  /** Choose the DVR transfer-function preset (CT Bone / Soft-tissue / Angio / Lung). */
  protected onTransferFunctionChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    this.transferFunction.set(Number(event.target.value) as TransferFunctionPreset);
    this.markMipSettling();
  }

  /** Toggle the cut-away that clips the 3D pane to the current MPR slice planes. */
  protected toggleClipToPlanes(): void {
    this.clipToPlanes.update((on) => !on);
    this.markMipSettling();
  }

  /** Set the 3D slab thickness (mm), clamped to [1, full volume depth]. */
  protected onSlabThicknessInput(event: Event): void {
    const max = this.slabMaxMm();
    this.slabThicknessMm.set(clamp(intValue(event), 1, max > 0 ? max : 1));
    this.markMipSettling();
  }

  /** Placement of the pane under a pointer event, or null if outside the panes. */
  private placementAtEvent(event: MouseEvent): PanePlacement | null {
    const bounds = this.canvasRef().nativeElement.getBoundingClientRect();
    return placementAt(this.panes(), event.clientX - bounds.left, event.clientY - bounds.top);
  }

  private async initGpu(): Promise<void> {
    const canvas = this.canvasRef().nativeElement;
    try {
      this.gpu = await initWebGpu(canvas);
      this.renderer.set(new SliceRenderer(this.gpu));
      this.observeResize(canvas);
    } catch (error) {
      this.gpuError.set(messageOf(error));
    }
  }

  private async loadFiles(files: readonly File[]): Promise<void> {
    this.load.set({ status: 'loading' });
    try {
      const result = await this.loader.loadFromFiles(files);
      this.applyVolume(result);
    } catch (error) {
      this.load.set({ status: 'error', message: messageOf(error) });
    }
  }

  private applyVolume(result: LoadResult): void {
    const renderer = this.renderer();
    if (!renderer) {
      this.load.set({ status: 'error', message: 'GPU is not ready yet — try again.' });
      return;
    }
    renderer.setVolume(result.volume);
    this.windowCenter.set(Math.round(result.volume.windowCenter));
    this.windowWidth.set(Math.round(result.volume.windowWidth));
    this.layoutMode.set(LayoutMode.TriMpr);
    this.mainOrientation.set(Orientation.Axial);
    this.sagittalFlipped.set(false);
    this.focusVoxel.set(null);
    this.zooms.set([1, 1, 1]);
    this.pans.set(NO_PANS);
    this.camera3d.set(DEFAULT_CAMERA);
    // Reset the 3D pane to the default MIP over the whole volume, like the camera.
    this.projectionMode.set(ProjectionMode.Max);
    this.transferFunction.set(TransferFunctionPreset.CtBone);
    this.clipToPlanes.set(false);
    this.slabThicknessMm.set(Math.round(2 * volumeBounds(result.volume).radius));
    this.sliceIndices.set([
      middleSlice(renderer, Orientation.Axial),
      middleSlice(renderer, Orientation.Coronal),
      middleSlice(renderer, Orientation.Sagittal),
    ]);
    this.load.set({ status: 'ready', result });
  }

  private observeResize(canvas: HTMLCanvasElement): void {
    const observer = new ResizeObserver(() => this.syncViewport(canvas));
    observer.observe(canvas);
    this.destroyRef.onDestroy(() => observer.disconnect());
    this.syncViewport(canvas);
  }

  private syncViewport(canvas: HTMLCanvasElement): void {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const deviceWidth = Math.max(1, Math.floor(width * dpr));
    const deviceHeight = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
      canvas.width = deviceWidth;
      canvas.height = deviceHeight;
    }
    this.viewport.set({ width, height, dpr });
  }
}

/**
 * Build the pane set for the chosen {@link LayoutMode}, in CSS pixels:
 * - `TriMpr`: the 1+2 arrangement — a tall main MPR pane (cycled by swap) with the
 *   other two orientations stacked on the right; no 3D pane.
 * - `Quad`: the 2×2 grid — the three MPR orientations plus the 3D MIP pane.
 * - `Volume3d`: the 3D MIP pane filling the whole viewport.
 * The two side orientations follow `ORIENTATION_ORDER`, skipping the main one.
 */
function placePanes(
  mode: LayoutMode,
  width: number,
  height: number,
  main: Orientation,
): PanePlacement[] {
  const sides = ORIENTATION_ORDER.filter((orientation) => orientation !== main);
  switch (mode) {
    case LayoutMode.TriMpr: {
      const layout = triLayout(width, height);
      return [
        { kind: 'mpr', orientation: main, rect: layout.main },
        { kind: 'mpr', orientation: sides[0], rect: layout.topRight },
        { kind: 'mpr', orientation: sides[1], rect: layout.bottomRight },
      ];
    }
    case LayoutMode.Quad: {
      const layout = mprLayout(width, height);
      return [
        { kind: 'mpr', orientation: main, rect: layout.topLeft },
        { kind: 'mpr', orientation: sides[0], rect: layout.topRight },
        { kind: 'mpr', orientation: sides[1], rect: layout.bottomLeft },
        { kind: 'mip', rect: layout.bottomRight },
      ];
    }
    case LayoutMode.Volume3d:
      return [{ kind: 'mip', rect: singleLayout(width, height) }];
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/** The pane containing CSS-pixel point (x, y), or null. */
function placementAt(panes: readonly PanePlacement[], x: number, y: number): PanePlacement | null {
  for (const pane of panes) {
    if (withinRect(pane.rect, x, y)) return pane;
  }
  return null;
}

/** Whether CSS-pixel point (x, y) lies within a rectangle. */
function withinRect(rect: PaneRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** One-line readout: orientation, voxel index, and value (plus raw if rescaled). */
function formatProbe(name: string, probe: VoxelProbe, volume: Volume): string {
  const [x, y, z] = probe.voxel;
  const unit = modalityUnit(volume.modality);
  const value = `${formatValue(probe.value)}${unit ? ` ${unit}` : ''}`;
  const trivialLut = volume.rescaleSlope === 1 && volume.rescaleIntercept === 0;
  const stored = trivialLut ? '' : ` · stored ${formatValue(probe.rawValue)}`;
  return `${name} · voxel (${x}, ${y}, ${z}) · value ${value}${stored}`;
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function withValue<T>(
  values: readonly [T, T, T],
  orientation: Orientation,
  value: T,
): readonly [T, T, T] {
  const next: [T, T, T] = [...values];
  next[orientation] = value;
  return next;
}

function middleSlice(renderer: SliceRenderer, orientation: Orientation): number {
  return Math.floor(renderer.sliceCount(orientation) / 2);
}

function describeVolume(result: LoadResult): string {
  const [x, y, z] = result.volume.dims;
  return `Loaded ${result.sliceCount} slice(s) — volume ${x} × ${y} × ${z}.`;
}

function intValue(event: Event): number {
  if (!(event.target instanceof HTMLInputElement)) return 0;
  const parsed = Number(event.target.value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Warning text for an interpolated volume, or null when interpolation is
 * negligible. Only gaps wider than {@link GAP_WARNING_RATIO}× the slice spacing
 * are flagged, so a single missing slice or sub-voxel jitter stays quiet.
 * Exported for direct unit testing of the threshold and wording.
 */
export function missingSliceWarning(
  missing: MissingSlices | undefined,
  spacingMm: number,
): string | null {
  if (!missing || missing.maxGapMm <= GAP_WARNING_RATIO * spacingMm) return null;
  const slices = missing.count === 1 ? 'slice' : 'slices';
  const gap = Math.round(missing.maxGapMm);
  return `${missing.count} missing ${slices} interpolated (largest gap ${gap} mm). Views crossing a gap are reconstructed, not acquired.`;
}
