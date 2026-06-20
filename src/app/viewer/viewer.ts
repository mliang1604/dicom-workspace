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
import { planeExtentMm, slicePlaneCorners, volumeBounds } from '../../render/reslice';
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
  roiStats,
  type HuStats,
  type RoiShape,
} from '../../render/measure';
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
import type { DicomMetadata, RawTag } from '../../dicom/metadata';
import type { Series } from '../../dicom/series';
import { VolumeLoader, type LoadResult } from '../volume-loader';
import { describeSelection, RecentStore, type RecentEntry } from '../recent-store';
import { PreferencesStore } from '../preferences-store';
import { readDropped } from './drop-files';

/** What the viewer is currently showing, as one-shape-at-a-time state. */
type LoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly loaded: number; readonly total: number }
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

/** A scale bar drawn in an MPR pane corner, in CSS pixels. */
interface ScaleBarOverlay {
  /** Bar length in CSS pixels. */
  readonly lengthPx: number;
  /** Rounded physical label, e.g. "5 cm". */
  readonly label: string;
}

/** Orientation edge letters and a scale bar overlaid on one MPR pane. */
interface PaneAnnotation {
  /** Key of the pane it belongs to (see {@link Viewer.paneKey}). */
  readonly key: string;
  /** The pane's rectangle in CSS pixels; the overlay is positioned and clipped to it. */
  readonly rect: PaneRect;
  /** Patient-direction letters at the four edges. */
  readonly edges: PaneEdgeLabels;
  /** The physical scale bar, or null when the pane is too small to size one. */
  readonly scale: ScaleBarOverlay | null;
}

/** An interactive measurement tool, or `none` for the default pan/orbit gestures. */
type MeasureTool = 'distance' | 'angle' | 'ellipse' | 'rectangle';
type ToolMode = 'none' | MeasureTool;

/** How many points define each tool: a segment, a vertex pair of rays, or a box. */
const TOOL_POINTS: Readonly<Record<MeasureTool, number>> = {
  distance: 2,
  angle: 3,
  ellipse: 2,
  rectangle: 2,
};

/**
 * A completed measurement, pinned to the orientation and slice it was drawn on
 * (so it hides when scrolled off). Points are stored as in-plane
 * {@link PlanePoint}s, which track pan/zoom/flip for free — only the projection
 * to a pane pixel applies the live view transform.
 */
interface Measurement {
  readonly id: number;
  readonly tool: MeasureTool;
  readonly orientation: Orientation;
  readonly sliceIndex: number;
  readonly points: readonly PlanePoint[];
}

/** A measurement being placed: the same shape, fewer than its full set of points. */
interface PendingMeasurement {
  readonly tool: MeasureTool;
  readonly orientation: Orientation;
  readonly sliceIndex: number;
  readonly points: readonly PlanePoint[];
}

/** An in-progress drag of one measurement point (an endpoint or an ROI corner). */
interface MeasureDrag {
  readonly id: number;
  readonly pointIndex: number;
}

/** A measurement projected into its pane for the SVG overlay, in pane-local pixels. */
interface MeasurementOverlay {
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

/** Frames-per-second options offered in the cine speed selector, in display order. */
const CINE_FPS_OPTIONS = [5, 10, 15, 20, 30] as const;
/** Default cine playback speed (fps), used until the user picks another. */
const DEFAULT_CINE_FPS = 15;

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

/** Longest an MPR pane's scale bar may grow: a fraction of the pane width… */
const SCALE_BAR_MAX_FRACTION = 0.3;
/** …capped in absolute CSS pixels so it stays a discreet ruler on large panes. */
const SCALE_BAR_MAX_PX = 160;

/** Pixels a measurement readout sits above its anchor point. */
const MEASURE_LABEL_OFFSET = 8;

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
    '(window:keydown.p)': 'onCineKey($event)',
    '(window:keydown.l)': 'onLayoutKey($event)',
    '(window:keydown.i)': 'onInfoKey($event)',
    '(window:keydown.escape)': 'onEscapeKey($event)',
  },
})
export class Viewer {
  private readonly loader = inject(VolumeLoader);
  private readonly recentStore = inject(RecentStore);
  private readonly preferencesStore = inject(PreferencesStore);
  private readonly destroyRef = inject(DestroyRef);
  /** Preferences restored at startup; seed the view signals and per-load defaults. */
  private readonly initialPrefs = this.preferencesStore.preferences();

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
  protected readonly projectionMode = signal<ProjectionMode>(this.initialPrefs.projectionMode);
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
  protected readonly sagittalFlipped = signal(this.initialPrefs.sagittalFlipped);
  /** Shared focus voxel set by Shift+click, navigated to in every pane; null until set. */
  private readonly focusVoxel = signal<readonly [number, number, number] | null>(null);
  /** When true (default), draw the linked crosshair at the focus voxel in each MPR pane. */
  protected readonly crosshairsEnabled = signal(true);
  /** True while cine playback is auto-advancing slices through a pane. */
  protected readonly cinePlaying = signal(false);
  /** Cine playback speed in frames per second. */
  protected readonly cineFps = signal(DEFAULT_CINE_FPS);
  /** The fps options offered in the cine speed selector, in display order. */
  protected readonly cineFpsOptions = CINE_FPS_OPTIONS;
  /** Orientation whose slices cine is advancing; captured when playback starts. */
  private readonly cineOrientation = signal<Orientation>(Orientation.Axial);
  /** The active measurement tool, or `none` for the default pan/orbit gestures. */
  protected readonly activeTool = signal<ToolMode>('none');
  /** Completed measurements, each pinned to its orientation + slice. */
  private readonly measurements = signal<readonly Measurement[]>([]);
  /** The measurement currently being placed (awaiting its remaining points), or null. */
  private readonly pending = signal<PendingMeasurement | null>(null);
  /** The measurement point being dragged (an endpoint or ROI corner), or null. */
  private readonly measureDrag = signal<MeasureDrag | null>(null);
  /** Monotonic id source for new measurements. */
  private nextMeasureId = 0;
  /** The measurement tools offered in the palette, in display order. */
  protected readonly measureTools = [
    { value: 'distance', label: 'Distance', glyph: '╱' },
    { value: 'angle', label: 'Angle', glyph: '∠' },
    { value: 'ellipse', label: 'Ellipse', glyph: '◯' },
    { value: 'rectangle', label: 'Rectangle', glyph: '▭' },
  ] as const;
  /** Whether any measurement (placed or in-progress) exists, for the Clear button. */
  protected readonly hasMeasurements = computed(
    () => this.measurements().length > 0 || this.pending() !== null,
  );
  /** Key of the hovered pane (see {@link paneKey}), or null when away. */
  protected readonly hoveredKey = signal<string | null>(null);
  /** True while files are being dragged over the viewport, for the drop overlay. */
  protected readonly isDraggingFiles = signal(false);
  /** The recent loads, most recent first, surfaced for the toolbar re-pick list. */
  protected readonly recent = this.recentStore.entries;
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

  /** Whether the metadata / tag inspector panel is open. */
  protected readonly infoPanelOpen = signal(false);
  /** Case-insensitive filter typed into the raw-tag search box. */
  protected readonly rawTagFilter = signal('');

  /** Captured metadata of the displayed series, or null when none is loaded. */
  protected readonly metadata = computed<DicomMetadata | null>(() => {
    const uid = this.selectedSeriesUid();
    return this.seriesList().find((series) => series.uid === uid)?.metadata ?? null;
  });

  /** Raw tags of the displayed series, narrowed by the search box. */
  protected readonly filteredRawTags = computed<readonly RawTag[]>(() => {
    const metadata = this.metadata();
    if (!metadata) return [];
    return filterRawTags(metadata.rawTags, this.rawTagFilter());
  });

  /** The selected viewport layout; defaults to the classic 3-pane MPR (1+2) view. */
  protected readonly layoutMode = signal<LayoutMode>(this.initialPrefs.layoutMode);
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

  /**
   * Per-MPR-pane 2D overlays: anatomical edge letters and a physical scale bar.
   * The letters come from {@link paneEdgeLabels} (orientation + sagittal flip), so
   * they track the swap and flip toggles; the scale bar is sized from the plane's
   * physical extent through the pane's letterbox fit and zoom ({@link
   * mmPerScreenPixel}), so it rescales as the pane zooms. A pure CSS overlay,
   * recomputed only from the panes, zooms and flip — never the window/level or 3D
   * camera.
   */
  protected readonly paneAnnotations = computed<PaneAnnotation[]>(() => {
    const volume = this.volume();
    if (!this.isReady() || !volume) return [];

    const zooms = this.zooms();
    const flipped = this.sagittalFlipped();
    const result: PaneAnnotation[] = [];
    for (const pane of this.panes()) {
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
        key: this.paneKey(pane),
        rect: pane.rect,
        edges: paneEdgeLabels(pane.orientation, flipX),
        scale: bar ? { lengthPx: bar.lengthPx, label: bar.label } : null,
      });
    }
    return result;
  });

  /**
   * Cached ROI readout lines (area + HU stats) keyed by measurement id. ROI stats
   * sweep the slice's voxels, but depend only on the volume and the measurement's
   * own points/slice — never the pan or zoom — so memoising them here keeps a pan
   * or zoom drag from re-sweeping every region each frame. Recomputed only when a
   * measurement is added, edited, or the volume changes.
   */
  private readonly measurementStats = computed<ReadonlyMap<number, readonly string[]>>(() => {
    const volume = this.volume();
    const stats = new Map<number, readonly string[]>();
    if (!volume) return stats;
    const unit = modalityUnit(volume.modality);
    for (const m of this.measurements()) {
      if ((m.tool !== 'ellipse' && m.tool !== 'rectangle') || m.points.length < 2) continue;
      const res = roiStats(volume, m.orientation, m.sliceIndex, m.tool, m.points[0], m.points[1]);
      stats.set(m.id, roiLines(res.areaMm2, res.stats, unit));
    }
    return stats;
  });

  /**
   * Measurements (and the in-progress one) projected into their panes for the SVG
   * overlay. Each is pinned to its orientation and slice: it is dropped when that
   * orientation isn't currently shown, or when the pane has scrolled to another
   * slice. Stored as in-plane points, the screen geometry is re-derived here from
   * the live zoom/pan/flip, so annotations track the view. Recomputed only from
   * the panes, zoom, pan, flip, slice and measurement state — never the
   * window/level or 3D camera.
   */
  protected readonly measurementOverlays = computed<MeasurementOverlay[]>(() => {
    const volume = this.volume();
    if (!this.isReady() || !volume) return [];
    const panes = this.panes();
    const zooms = this.zooms();
    const pans = this.pans();
    const flipped = this.sagittalFlipped();
    const indices = this.sliceIndices();

    const result: MeasurementOverlay[] = [];
    for (const m of this.measurements()) {
      const overlay = this.buildOverlay(
        volume,
        panes,
        zooms,
        pans,
        flipped,
        indices,
        m,
        m.points,
        false,
      );
      if (overlay) result.push(overlay);
    }

    // The in-progress measurement, previewed with a provisional point under the
    // cursor so the segment/box is visible as it's drawn. Reading the cursor only
    // while placing keeps the overlay from recomputing on every idle pointer move.
    const pending = this.pending();
    if (pending) {
      const preview = this.previewPoint(volume, panes, zooms, pans, flipped, pending.orientation);
      const points = preview ? [...pending.points, preview] : pending.points;
      const overlay = this.buildOverlay(
        volume,
        panes,
        zooms,
        pans,
        flipped,
        indices,
        {
          id: -1,
          orientation: pending.orientation,
          sliceIndex: pending.sliceIndex,
          tool: pending.tool,
        },
        points,
        true,
      );
      if (overlay) result.push(overlay);
    }
    return result;
  });

  protected readonly statusIsError = computed(
    () => this.gpuError() !== null || this.load().status === 'error',
  );

  /** True while a load is in flight, gating the progress bar. */
  protected readonly isLoading = computed(() => this.load().status === 'loading');

  /**
   * Progress of an in-flight load as a 0–1 fraction for the progress bar. Reports
   * 0 when not loading or before the file count is known (the bar's empty state).
   */
  protected readonly loadProgress = computed<number>(() => {
    const state = this.load();
    if (state.status !== 'loading' || state.total <= 0) return 0;
    return state.loaded / state.total;
  });

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
        return loadingText(state.loaded, state.total);
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
  /** Handle of the cine playback interval, or null when paused. */
  private cineHandle: ReturnType<typeof setInterval> | null = null;
  /**
   * Nesting depth of drag-enter over the viewport's children. `dragenter`/
   * `dragleave` fire for every descendant, so a counter (not a bare flag) keeps
   * the drop overlay steady as the pointer crosses pane borders.
   */
  private dragDepth = 0;

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

    // Mirror the curated view preferences into persistent storage whenever they
    // change. Gated on a loaded volume so the window/level and slab — which only
    // become meaningful once a volume is shown — never persist their placeholder
    // pre-load values. The store skips redundant writes, so re-running this on an
    // unrelated change (or during a drag that lands on the same values) is cheap.
    effect(() => {
      if (!this.isReady()) return;
      this.preferencesStore.update({
        layoutMode: this.layoutMode(),
        projectionMode: this.projectionMode(),
        sagittalFlipped: this.sagittalFlipped(),
        windowCenter: this.windowCenter(),
        windowWidth: this.windowWidth(),
        slabThicknessMm: this.slabThicknessMm(),
      });
    });

    this.destroyRef.onDestroy(() => {
      if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
      if (this.settleHandle !== null) clearTimeout(this.settleHandle);
      if (this.cineHandle !== null) clearInterval(this.cineHandle);
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
    this.stopCine(); // the cined pane may move or vanish in the new layout
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
    this.stopCine(); // swapping reshuffles the panes, so stop the cined one
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
   * Start or stop cine playback. When starting it cines the hovered MPR pane if
   * one is under the cursor, otherwise the main pane — so you can review whichever
   * stack you're looking at — advancing its slice index on a timer and looping
   * back to the first slice at the end.
   */
  protected toggleCine(): void {
    if (this.cinePlaying()) this.stopCine();
    else this.startCine();
  }

  protected onCineKey(event: Event): void {
    if (event.target instanceof HTMLInputElement || !this.isReady() || !this.hasMprPane()) return;
    event.preventDefault();
    this.toggleCine();
  }

  /** Change the cine speed; re-arm the running timer so the new fps takes effect at once. */
  protected onCineFpsChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const fps = Number(event.target.value);
    if (!Number.isFinite(fps) || fps <= 0) return;
    this.cineFps.set(fps);
    if (this.cinePlaying()) this.restartCineTimer();
  }

  /** Begin auto-advancing the hovered (or main) pane's slices at the current fps. */
  private startCine(): void {
    if (!this.isReady() || !this.hasMprPane()) return;
    this.cineOrientation.set(this.cinePaneOrientation());
    this.cinePlaying.set(true);
    this.restartCineTimer();
  }

  /** Stop cine playback and clear its timer. Idempotent — safe to call any time. */
  private stopCine(): void {
    if (this.cineHandle !== null) {
      clearInterval(this.cineHandle);
      this.cineHandle = null;
    }
    if (this.cinePlaying()) this.cinePlaying.set(false);
  }

  /** (Re)arm the cine interval from the current fps, replacing any running timer. */
  private restartCineTimer(): void {
    if (this.cineHandle !== null) clearInterval(this.cineHandle);
    const fps = clamp(this.cineFps(), 1, 60);
    this.cineHandle = setInterval(() => this.cineTick(), 1000 / fps);
  }

  /** Advance the cined pane by one slice, looping back to the start at the end. */
  private cineTick(): void {
    const renderer = this.renderer();
    if (!renderer) return;
    const orientation = this.cineOrientation();
    const count = renderer.sliceCount(orientation);
    this.sliceIndices.update((indices) =>
      withValue(indices, orientation, nextCineIndex(indices[orientation], count, 1)),
    );
  }

  /** The orientation cine should drive: the hovered MPR pane's, else the main pane's. */
  private cinePaneOrientation(): Orientation {
    const hovered = this.hoveredKey();
    for (const pane of this.panes()) {
      if (pane.kind === 'mpr' && this.paneKey(pane) === hovered) return pane.orientation;
    }
    return this.mainOrientation();
  }

  /** Open/close the metadata & raw-tag inspector panel. */
  protected toggleInfoPanel(): void {
    this.infoPanelOpen.update((open) => !open);
  }

  protected onInfoKey(event: Event): void {
    if (event.target instanceof HTMLInputElement || !this.isReady()) return;
    event.preventDefault();
    this.toggleInfoPanel();
  }

  protected onRawTagFilterInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.rawTagFilter.set(event.target.value);
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

  /** Activate a measurement tool, or toggle it off if it's already active. */
  protected setTool(tool: MeasureTool): void {
    this.activeTool.update((current) => (current === tool ? 'none' : tool));
    this.pending.set(null); // abandon any half-placed measurement when the tool changes
  }

  /** Remove every placed measurement and any in-progress one. */
  protected clearMeasurements(): void {
    this.measurements.set([]);
    this.pending.set(null);
  }

  /** Escape cancels an in-progress measurement, then deactivates the tool. */
  protected onEscapeKey(event: Event): void {
    if (event.target instanceof HTMLInputElement) return;
    if (this.pending()) {
      this.pending.set(null);
      return;
    }
    if (this.activeTool() !== 'none') this.activeTool.set('none');
  }

  /**
   * Add the next point of the active measurement from a click on an MPR pane.
   * Points accumulate on the pane's current slice; once the tool's full set is
   * placed the measurement is committed and the pending state cleared. Clicking a
   * different pane or slice mid-measurement starts a fresh one.
   */
  private placeMeasurePoint(
    placement: Extract<PanePlacement, { kind: 'mpr' }>,
    event: PointerEvent,
  ): void {
    const volume = this.volume();
    const tool = this.activeTool();
    if (!volume || tool === 'none') return;
    const orientation = placement.orientation;
    const point = this.eventPlanePoint(volume, orientation, placement.rect, event);
    if (!point) return; // clicked the letterbox margin outside the image

    const sliceIndex = this.sliceIndices()[orientation];
    const pending = this.pending();
    const continuing =
      pending !== null &&
      pending.tool === tool &&
      pending.orientation === orientation &&
      pending.sliceIndex === sliceIndex;
    const points = continuing ? [...pending.points, point] : [point];
    if (points.length >= TOOL_POINTS[tool]) {
      this.measurements.update((list) => [
        ...list,
        { id: this.nextMeasureId++, tool, orientation, sliceIndex, points },
      ]);
      this.pending.set(null);
    } else {
      this.pending.set({ tool, orientation, sliceIndex, points });
    }
  }

  /** Begin dragging a placed measurement's endpoint or ROI corner. */
  protected onMeasureHandleDown(id: number, pointIndex: number, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.target as Element;
    target.setPointerCapture?.(event.pointerId);
    this.measureDrag.set({ id, pointIndex });
  }

  /** Move the dragged measurement point to follow the cursor. */
  protected onMeasureHandleMove(event: PointerEvent): void {
    const drag = this.measureDrag();
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    const volume = this.volume();
    if (!volume) return;
    const measurement = this.measurements().find((m) => m.id === drag.id);
    if (!measurement) return;
    const orientation = measurement.orientation;
    const placement = this.mprPlacement(orientation);
    if (!placement) return;
    const point = this.eventPlanePoint(volume, orientation, placement.rect, event);
    if (!point) return;
    this.measurements.update((list) =>
      list.map((m) =>
        m.id === drag.id ? { ...m, points: withIndex(m.points, drag.pointIndex, point) } : m,
      ),
    );
  }

  /** End a measurement-point drag. */
  protected onMeasureHandleUp(event: PointerEvent): void {
    if (!this.measureDrag()) return;
    event.stopPropagation();
    const target = event.target as Element;
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.measureDrag.set(null);
  }

  /** Map a pointer event to the in-plane point it covers on a given MPR pane. */
  private eventPlanePoint(
    volume: Volume,
    orientation: Orientation,
    rect: PaneRect,
    event: PointerEvent,
  ): PlanePoint | null {
    const bounds = this.canvasRef().nativeElement.getBoundingClientRect();
    return paneToPlanePoint(
      volume,
      orientation,
      this.zooms()[orientation],
      rect,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      orientation === Orientation.Sagittal && this.sagittalFlipped(),
      this.pans()[orientation],
    );
  }

  /** The MPR placement currently showing an orientation, or null when it isn't shown. */
  private mprPlacement(orientation: Orientation): Extract<PanePlacement, { kind: 'mpr' }> | null {
    return (
      this.panes().find(
        (pane): pane is Extract<PanePlacement, { kind: 'mpr' }> =>
          pane.kind === 'mpr' && pane.orientation === orientation,
      ) ?? null
    );
  }

  /** A provisional point under the cursor for previewing the pending measurement. */
  private previewPoint(
    volume: Volume,
    panes: readonly PanePlacement[],
    zooms: PerOrientation,
    pans: PerOrientationPan,
    flipped: boolean,
    orientation: Orientation,
  ): PlanePoint | null {
    const cursor = this.cursor();
    if (!cursor) return null;
    const placement = panes.find(
      (pane): pane is Extract<PanePlacement, { kind: 'mpr' }> =>
        pane.kind === 'mpr' && pane.orientation === orientation,
    );
    if (!placement) return null;
    return paneToPlanePoint(
      volume,
      orientation,
      zooms[orientation],
      placement.rect,
      cursor.x,
      cursor.y,
      orientation === Orientation.Sagittal && flipped,
      pans[orientation],
    );
  }

  /** Project one measurement into its pane, or null if it's hidden (wrong slice/pane). */
  private buildOverlay(
    volume: Volume,
    panes: readonly PanePlacement[],
    zooms: PerOrientation,
    pans: PerOrientationPan,
    flipped: boolean,
    indices: PerOrientation,
    m: { id: number; tool: MeasureTool; orientation: Orientation; sliceIndex: number },
    points: readonly PlanePoint[],
    pending: boolean,
  ): MeasurementOverlay | null {
    const orientation = m.orientation;
    const placement = panes.find(
      (pane): pane is Extract<PanePlacement, { kind: 'mpr' }> =>
        pane.kind === 'mpr' && pane.orientation === orientation,
    );
    if (!placement) return null;
    if (indices[orientation] !== m.sliceIndex) return null; // scrolled off its slice
    const rect = placement.rect;
    if (rect.width < 1 || rect.height < 1 || points.length === 0) return null;

    const flipX = orientation === Orientation.Sagittal && flipped;
    const zoom = zooms[orientation];
    const pan = pans[orientation];
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
            lines = this.measurementStats().get(m.id) ?? [];
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
    if (files.length > 0) await this.loadFiles(files, describeSelection(files));
  }

  /**
   * A file/folder drag entered the viewport: raise the drop overlay. The depth
   * counter keeps it up while the pointer moves between child elements.
   */
  protected onDragEnter(event: DragEvent): void {
    if (!hasFiles(event)) return;
    this.dragDepth++;
    this.isDraggingFiles.set(true);
  }

  /** Allow the drop and show the copy cursor while a file drag hovers the viewport. */
  protected onDragOver(event: DragEvent): void {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  /** A drag left a child (or the viewport): lower the overlay once fully outside. */
  protected onDragLeave(event: DragEvent): void {
    if (!hasFiles(event)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.isDraggingFiles.set(false);
  }

  /** Load the dropped folder/files, walking dropped directories for their slices. */
  protected async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragDepth = 0;
    this.isDraggingFiles.set(false);
    if (!event.dataTransfer) return;
    const { files, entry } = await readDropped(event.dataTransfer);
    if (files.length > 0) await this.loadFiles(files, entry);
  }

  /**
   * Re-pick a recent entry. Browsers can't silently re-read a path, so this just
   * re-opens the matching picker (folder or files) for the user to re-select.
   */
  protected onRecentPick(
    event: Event,
    folderInput: HTMLInputElement,
    filesInput: HTMLInputElement,
  ): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const entry = this.recent()[Number(event.target.value)];
    event.target.selectedIndex = 0; // back to the "Recent…" placeholder so re-picking fires
    if (!entry) return;
    (entry.kind === 'folder' ? folderInput : filesInput).click();
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

    // With a measurement tool active, a left-click on an MPR pane places the next
    // point instead of starting a pan; the 3D pane keeps its orbit gesture.
    if (this.activeTool() !== 'none' && placement.kind === 'mpr') {
      this.placeMeasurePoint(placement, event);
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
    this.stopCine(); // a manual scroll takes over from cine playback

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

  private async loadFiles(files: readonly File[], entry: RecentEntry | null): Promise<void> {
    this.load.set({ status: 'loading', loaded: 0, total: files.length });
    try {
      const result = await this.loader.loadFromFiles(files, (loaded, total) => {
        // Ignore stragglers from a superseded load (a new load already started).
        if (this.load().status === 'loading') this.load.set({ status: 'loading', loaded, total });
      });
      this.applyVolume(result);
      if (entry) this.recentStore.record(entry); // remember it once it loaded cleanly
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
    this.stopCine(); // a fresh volume resets the view; don't keep cining the old one
    renderer.setVolume(result.volume);
    // Persisted view preferences (layout, projection mode, sagittal flip) are kept
    // across loads, so they aren't reset here — the signals already hold them.
    // Window/level and slab thickness depend on the volume, so honour a stored
    // preference when present, else fall back to the volume's own default.
    const prefs = this.preferencesStore.preferences();
    const fullDepthMm = Math.round(2 * volumeBounds(result.volume).radius);
    this.windowCenter.set(prefs.windowCenter ?? Math.round(result.volume.windowCenter));
    this.windowWidth.set(prefs.windowWidth ?? Math.max(1, Math.round(result.volume.windowWidth)));
    this.slabThicknessMm.set(
      prefs.slabThicknessMm !== null ? clamp(prefs.slabThicknessMm, 1, fullDepthMm) : fullDepthMm,
    );
    this.mainOrientation.set(Orientation.Axial);
    this.focusVoxel.set(null);
    this.activeTool.set('none');
    this.measurements.set([]);
    this.pending.set(null);
    this.measureDrag.set(null);
    // Per-volume view state is per-session: always reset to volume-derived defaults.
    this.zooms.set([1, 1, 1]);
    this.pans.set(NO_PANS);
    this.camera3d.set(DEFAULT_CAMERA);
    this.transferFunction.set(TransferFunctionPreset.CtBone);
    this.clipToPlanes.set(false);
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

/** Whether a drag event carries files (vs. dragged text/elements within the page). */
function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes('Files') : false;
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

/** Join pane-local points into an SVG polyline `points` string. */
function polylineOf(points: readonly PanePoint[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/** Midpoint of a point list's first and last points. */
function midpoint(points: readonly PanePoint[]): PanePoint {
  const a = points[0];
  const b = points[points.length - 1];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Readout lines for an ROI: its area, then the HU statistics when available. */
function roiLines(areaMm2: number, stats: HuStats | null, unit: string | null): string[] {
  const u = unit ? ` ${unit}` : '';
  const lines = [`${areaMm2.toFixed(0)} mm²`];
  if (stats) {
    lines.push(`mean ${formatValue(stats.mean)}${u}`);
    lines.push(`SD ${formatValue(stats.sd)}`);
    lines.push(`min ${formatValue(stats.min)} · max ${formatValue(stats.max)}`);
  }
  return lines;
}

/** Immutably replace the element at `index` of a readonly array. */
function withIndex<T>(values: readonly T[], index: number, value: T): readonly T[] {
  const next = [...values];
  next[index] = value;
  return next;
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

/**
 * The next slice index for cine playback, wrapping at the ends so the loop runs
 * continuously: stepping past the last slice returns to the first, and stepping
 * before the first returns to the last. `step` is the per-tick advance (±1) and
 * `count` the orientation's slice count. A stack of one slice (or none) has
 * nothing to cine, so the index is clamped into range and left there. Exported
 * for unit testing the advance/looping logic.
 */
export function nextCineIndex(current: number, count: number, step: number): number {
  if (count <= 1) return clamp(current, 0, Math.max(0, count - 1));
  return (((current + step) % count) + count) % count;
}

function describeVolume(result: LoadResult): string {
  const [x, y, z] = result.volume.dims;
  return `Loaded ${result.sliceCount} slice(s) — volume ${x} × ${y} × ${z}.`;
}

/**
 * Status line for an in-flight load: files parsed of the total with a percentage
 * once the count is known. Exported for unit testing the wording and rounding.
 */
export function loadingText(loaded: number, total: number): string {
  if (total <= 0) return 'Loading…';
  const percent = Math.round((loaded / total) * 100);
  return `Loading… ${loaded} / ${total} files (${percent}%)`;
}

/**
 * Narrow the raw-tag list to those matching a case-insensitive query against the
 * tag id, VR, or value. An empty/blank query returns the list unchanged.
 * Exported for direct unit testing of the search behaviour.
 */
export function filterRawTags(tags: readonly RawTag[], query: string): readonly RawTag[] {
  const q = query.trim().toLowerCase();
  if (!q) return tags;
  return tags.filter(
    (tag) =>
      tag.tag.toLowerCase().includes(q) ||
      (tag.vr !== null && tag.vr.toLowerCase().includes(q)) ||
      tag.value.toLowerCase().includes(q),
  );
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
