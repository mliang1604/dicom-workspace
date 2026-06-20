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
  oneToOneZoom,
  ProjectionMode,
  rezoomPan,
  SliceRenderer,
  type PaneView,
} from '../../render/slice-renderer';
import {
  addControlPoint,
  moveControlPoint,
  removeControlPoint,
  setControlPointColor,
  transferFunction,
  TRANSFER_FUNCTION_PRESETS,
  TransferFunctionPreset,
  type TransferFunction,
} from '../../render/transfer-function';
import { DEFAULT_DVR_LIGHTING, type DvrLighting } from '../../render/dvr';
import {
  clipLineToUnitSquare,
  NO_OBLIQUE,
  planeExtentMm,
  referenceLine,
  slicePlaneCorners,
  volumeBounds,
  type ObliqueRotation,
  type PatientPlane,
} from '../../render/reslice';
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
import {
  cameraBasis,
  projectToPane,
  rezoomCameraPan,
  viewBasis,
  type OrbitCamera,
} from '../../render/camera';
import { axisMarkers } from '../../render/axis-indicator';
import { pickProjection } from '../../render/pick';
import { probeVoxel, type VoxelProbe } from '../../render/probe';
import { focusPanePoint, focusSliceIndex } from '../../render/crosshair';
import {
  classifyContour,
  crossSectionOutline,
  decimate,
  projectContour,
  type ContourCoords,
  type ContourPolyline,
  type CrossSectionRow,
} from '../../render/contours';
import {
  modalityUnit,
  Orientation,
  type MissingSlices,
  type StructureSet,
  type Vec3,
  type Volume,
} from '../../dicom/types';
import { add, cross, dot, normalize, scale, sub } from '../../dicom/vec3';
import { loftContours, type Triangle } from '../../render/surface';
import type { DicomMetadata, RawTag } from '../../dicom/metadata';
import type { Series } from '../../dicom/series';
import { VolumeLoader, type LoadResult } from '../volume-loader';
import { describeSelection, RecentStore, type RecentEntry } from '../recent-store';
import { PreferencesStore } from '../preferences-store';
import { readDropped } from './drop-files';
import { captureFilename, pickVideoMimeType, rotationAzimuths, timestampSlug } from './capture';

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

/**
 * The interactive cut-plane gizmo drawn in the 3D pane: the plane as a quad
 * outline, a draggable handle at its centre, and a stub along the kept-side
 * normal, all projected through the orbit camera into pane-local CSS pixels.
 */
interface ClipPlaneGizmo {
  /** The 3D pane's rectangle in CSS pixels; the SVG is positioned and clipped to it. */
  readonly rect: PaneRect;
  /** SVG polygon `points` of the plane square, in pane-local CSS pixels. */
  readonly outline: string;
  /** Drag handle centre (the plane centre) in pane-local CSS pixels. */
  readonly handle: { readonly x: number; readonly y: number };
  /** Polyline `points` of the kept-side normal stub, in pane-local CSS pixels. */
  readonly normalLine: string;
  /** CSS pixels the handle moves per mm of offset along the normal: the drag axis. */
  readonly axisX: number;
  readonly axisY: number;
}

/** One ROI contour shape projected into a pane, in pane-local pixels. */
interface ContourShape {
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
interface ContourPaneOverlay {
  /** Key of the pane it belongs to (see {@link Viewer.paneKey}). */
  readonly key: string;
  /** The pane's rectangle in CSS pixels; the SVG is positioned and clipped to it. */
  readonly rect: PaneRect;
  /** The contour shapes drawn on this pane. */
  readonly shapes: readonly ContourShape[];
}

/** One ROI's contour geometry for a pane, in plane `(u, v)` — pan/zoom-independent. */
interface RoiPlaneShapes {
  /** ROI key (see {@link roiKeyOf}); the `@for` track and the per-shape key prefix. */
  readonly key: string;
  readonly color: string;
  readonly opacity: number;
  /** Loops and the cross-section outline, in plane `(u, v)` coordinates. */
  readonly polylines: readonly ContourPolyline[];
}

/** One ROI's contours projected into a pane's plane frame — slice-independent (cached). */
interface RoiContourCoords {
  readonly setIndex: number;
  readonly roiNumber: number;
  /** The ROI's display colour as a CSS colour (overrides applied later). */
  readonly baseColor: string;
  readonly contours: readonly ContourCoords[];
}

/** The three MPR orientations contours are projected for, regardless of layout. */
const MPR_ORIENTATIONS = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal] as const;

/** Decimation tolerance for coplanar loops, in plane `(u, v)` units (~0.15% of a pane). */
const CONTOUR_DECIMATE_UV = 0.0015;
/** Base opacity of an ROI's translucent 3D surface, before its per-ROI opacity. */
const SURFACE_ALPHA = 0.4;

/** One ROI's 3D surface mesh: triangles in patient mm, coloured by the ROI. */
interface RoiSurfaceMesh {
  readonly setIndex: number;
  readonly roiNumber: number;
  /** ROI display colour as [r, g, b] in 0–255, for shading. */
  readonly baseColor: readonly [number, number, number];
  readonly triangles: readonly Triangle[];
}

/** One ROI listed in the structures panel, with its display controls. */
export interface RoiLegendEntry {
  /** Stable key, unique across structure sets (see {@link roiKeyOf}). */
  readonly key: string;
  /** Index of the structure set this ROI belongs to. */
  readonly setIndex: number;
  /** ROI Name, or a fallback when the RTSTRUCT left it blank. */
  readonly name: string;
  /** Interpreted type (ORGAN/PTV/GTV…) as a short upper-case badge, or '' when none. */
  readonly type: string;
  /** Effective display colour (ROI colour or the user's override) as a CSS colour. */
  readonly color: string;
  /** The effective colour as `#rrggbb`, for the colour `<input>`. */
  readonly colorHex: string;
  /** Effective draw opacity as a whole percent `[0, 100]`, for the opacity slider. */
  readonly opacityPercent: number;
  /** Whether the ROI's contours are currently drawn. */
  readonly visible: boolean;
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

/** An oblique tilt per orientation, indexed by the orientation's numeric value. */
type PerOrientationOblique = readonly [ObliqueRotation, ObliqueRotation, ObliqueRotation];

/** A reference line drawn over an MPR pane where another plane crosses it. */
interface ReferenceLineOverlay {
  /** Key of the `into` pane it's drawn on (see {@link Viewer.paneKey}). */
  readonly key: string;
  /** The pane's rectangle in CSS pixels; the overlay is clipped to it. */
  readonly rect: PaneRect;
  /** Endpoints of the line in CSS pixels relative to the canvas. */
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Colour of the crossing plane, matching its 3D cut-plane outline. */
  readonly color: string;
}

/** The oblique rotation gizmo drawn over one MPR pane: a ring and a draggable knob. */
interface ObliqueGizmo {
  /** Key of the pane it controls (see {@link Viewer.paneKey}). */
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

const NO_PAN: Vec2 = { x: 0, y: 0 };
const NO_PANS: PerOrientationPan = [NO_PAN, NO_PAN, NO_PAN];

const NO_OBLIQUES: PerOrientationOblique = [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE];
/** Largest oblique tilt (radians) the rotation knob reaches at the ring's edge. */
const MAX_OBLIQUE_RAD = Math.PI / 3; // 60°
/** Radius (CSS px) of the oblique rotation ring; maps px offset → tilt angle. */
const OBLIQUE_RING_RADIUS = 56;
/** CSS pixels the knob travels per radian of tilt. */
const OBLIQUE_PX_PER_RAD = OBLIQUE_RING_RADIUS / MAX_OBLIQUE_RAD;

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

/** WebM containers tried, most-preferred first, for the 3D rotation capture. */
const VIDEO_MIME_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'] as const;
/** Frames in one full 360° rotation capture (~4 s at the capture frame rate). */
const ROTATION_FRAMES = 120;
/** Frame rate the rotation capture's MediaRecorder samples the canvas at. */
const ROTATION_FPS = 30;

/** Radians of orbit per pixel dragged over the 3D pane. */
const ORBIT_SPEED = 0.01;
/** Cap the elevation just shy of the poles to avoid a degenerate up vector. */
const MAX_ELEVATION = 1.45;
/** Default 3D view: a slight three-quarter orbit, patient superior up. */
const DEFAULT_CAMERA: OrbitCamera = { azimuth: 0.4, elevation: 0.25, zoom: 1, panX: 0, panY: 0 };

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
    // The viewport controls and the help overlay key off characters (digits, '?')
    // that Angular's per-key bindings don't parse cleanly, so route them through
    // one handler that reads event.key itself.
    '(window:keydown)': 'onShortcutKey($event)',
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
  /** The 2D overlay canvas for the 3D ROI surfaces (present only while shown). */
  private readonly surface3dRef = viewChild<ElementRef<HTMLCanvasElement>>('surface3d');

  private readonly renderer = signal<SliceRenderer | null>(null);
  private readonly load = signal<LoadState>({ status: 'idle' });
  private readonly gpuError = signal<string | null>(null);
  /** Canvas size in CSS pixels plus the device-pixel ratio; drives layout + render. */
  private readonly viewport = signal({ width: 0, height: 0, dpr: 1 });

  private readonly sliceIndices = signal<PerOrientation>([0, 0, 0]);
  private readonly zooms = signal<PerOrientation>([1, 1, 1]);
  /** Per-orientation pan offset in screen-uv units; drives shader + probe. */
  private readonly pans = signal<PerOrientationPan>(NO_PANS);
  /**
   * Per-orientation oblique tilt; {@link NO_OBLIQUE} (the default) reslices the
   * orthogonal anatomical plane, a non-zero tilt an arbitrary oblique plane. Set
   * by the rotation knob and read by the reslice, probe, crosshair and reference
   * lines so every pane and overlay shares one tilt.
   */
  private readonly obliques = signal<PerOrientationOblique>(NO_OBLIQUES);
  /** Whether any MPR pane is currently tilted off its orthogonal default. */
  protected readonly hasOblique = computed(() =>
    this.obliques().some((r) => r.tiltU !== 0 || r.tiltV !== 0),
  );
  /** Orbit/zoom state of the 3D MIP pane. */
  private readonly camera3d = signal<OrbitCamera>(DEFAULT_CAMERA);
  /** What the 3D pane renders (MIP / MinIP / Average / DVR). */
  protected readonly projectionMode = signal<ProjectionMode>(this.initialPrefs.projectionMode);
  /**
   * The live DVR transfer function: seeded from a preset and then editable in the
   * TF editor. Held as the full {@link TransferFunction} (not just a preset code)
   * so dragged control points re-bake the LUT immediately.
   */
  protected readonly transferFunction = signal<TransferFunction>(
    transferFunction(TransferFunctionPreset.CtBone),
  );
  /** The preset the editor is currently seeded from, driving the TF selector. */
  protected readonly transferFunctionPreset = computed(() => this.transferFunction().preset);
  /** DVR lighting/shading (Blinn–Phong material + posed headlight). */
  protected readonly dvrLighting = signal<DvrLighting>(DEFAULT_DVR_LIGHTING);
  /** The TF-editor control point being dragged (index), or null. */
  private readonly tfDrag = signal<number | null>(null);
  /** The selected TF control point (for recolour / removal), or null. */
  protected readonly tfSelected = signal<number | null>(null);
  /** When true, clip the 3D pane to the MPR slice planes for a cut-away view. */
  protected readonly clipToPlanes = signal(false);
  /** When true, an arbitrary handle-driven cut-plane clips the 3D pane (independent of {@link clipToPlanes}). */
  protected readonly clipPlaneEnabled = signal(false);
  /** Cut-plane normal in patient space (unit); the kept half is the side it points into. */
  private readonly clipPlaneNormal = signal<Vec3>([0, -1, 0]);
  /** Signed offset (mm) of the cut-plane from the volume centre along its normal. */
  private readonly clipPlaneOffsetMm = signal(0);
  /**
   * The live cut-plane in patient space, or null when the handle is off. Placed
   * at the volume centre shifted along the normal by the dragged offset; shared by
   * the renderer (the march clip) and the 3D pick so a click tracks the cut-away.
   */
  protected readonly cutPlane = computed<PatientPlane | null>(() => {
    const volume = this.volume();
    if (!this.clipPlaneEnabled() || !volume) return null;
    const normal = this.clipPlaneNormal();
    const point = add(volumeBounds(volume).center, scale(normal, this.clipPlaneOffsetMm()));
    return { point, normal };
  });
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
  /**
   * Geometry for the TF editor's SVG: each control point as a `(x, y)` in the
   * editor's 0..100 viewBox (intensity left→right, opacity bottom→top) plus a
   * polyline for the opacity curve and a closed area under it for an opacity fill.
   */
  protected readonly tfEditor = computed(() => {
    const tf = this.transferFunction();
    const [lo, hi] = tf.domain;
    const span = hi - lo || 1;
    const points = tf.controlPoints.map((p, index) => ({
      index,
      x: ((p.intensity - lo) / span) * 100,
      y: (1 - p.opacity) * 100,
      color: rgbToHex(p.color),
      intensity: Math.round(p.intensity),
      isEndpoint: index === 0 || index === tf.controlPoints.length - 1,
    }));
    const line = points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
    return { lo, hi, points, line, area: `0,100 ${line} 100,100` };
  });
  /** Hex colour of the selected TF control point, for the colour input. */
  protected readonly tfSelectedColor = computed(() => {
    const index = this.tfSelected();
    const points = this.transferFunction().controlPoints;
    return index !== null && points[index] ? rgbToHex(points[index].color) : '#ffffff';
  });
  /** Whether the selected TF control point can be removed (interior, ≥ 3 points). */
  protected readonly tfCanRemove = computed(() => {
    const index = this.tfSelected();
    const points = this.transferFunction().controlPoints;
    return index !== null && index > 0 && index < points.length - 1 && points.length > 2;
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
  /**
   * When true, invert the displayed grayscale (white ⇄ black) after windowing.
   * A user-facing toggle, separate from the MONOCHROME1 sense already folded into
   * the volume at load — this flips whatever is shown, in every pane.
   */
  protected readonly invert = signal(false);
  /**
   * The WebM container the browser can record a rotation capture into, chosen
   * once up front, or null when MediaRecorder/WebM isn't available (which hides
   * the spin-capture control). MPR-only layouts still expose the PNG screenshot.
   */
  private readonly recordingMimeType = pickVideoMimeType(
    VIDEO_MIME_TYPES,
    (type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type),
  );
  /** True while a 3D rotation capture is recording; disables the export controls. */
  protected readonly recordingRotation = signal(false);
  /** Whether the 3D rotation capture is available (3D pane shown + WebM support). */
  protected readonly canRecordRotation = computed(
    () => this.isReady() && this.has3dPane() && this.recordingMimeType !== null,
  );

  /** Whether the keyboard-shortcut help overlay is open. */
  protected readonly helpOpen = signal(false);
  /** The modal help panel, so focus can move into it on open. */
  private readonly helpPanelRef = viewChild<ElementRef<HTMLElement>>('helpPanel');
  /** The control focused before the help modal opened, restored when it closes. */
  private helpReturnFocus: HTMLElement | null = null;
  /** The shortcuts listed in the help overlay, in display order. */
  protected readonly shortcuts = [
    { keys: 'X', label: 'Swap the main view to the next orientation' },
    { keys: 'F', label: 'Flip the sagittal view left/right' },
    { keys: 'L', label: 'Cycle the viewport layout' },
    { keys: 'C', label: 'Toggle linked crosshairs & 3D cut-planes' },
    { keys: 'P', label: 'Play / pause cine through the hovered pane' },
    { keys: 'I', label: 'Toggle the metadata / tag inspector' },
    { keys: '0', label: 'Zoom every pane to fit' },
    { keys: '1', label: 'Native voxel scale (1:1)' },
    { keys: 'R', label: 'Reset zoom, pan & window/level' },
    { keys: 'V', label: 'Invert the grayscale' },
    { keys: '?', label: 'Toggle this shortcuts help' },
    { keys: 'Esc', label: 'Cancel a measurement / close overlays' },
    { keys: 'Drag', label: 'Pan an MPR pane · orbit the 3D pane' },
    { keys: 'Scroll', label: 'Change slice (MPR) · zoom (3D)' },
    { keys: 'Ctrl+Scroll', label: 'Zoom an MPR pane about the cursor' },
    { keys: 'Shift+Click', label: 'Link every pane to the clicked point' },
    { keys: 'Knob drag', label: 'Tilt an MPR pane to an oblique plane (double-click resets)' },
    { keys: 'Right-drag', label: 'Adjust window / level' },
  ] as const;
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
  /**
   * Keys of ROIs whose contours are hidden (see {@link roiKeyOf}). Empty by default,
   * so a freshly loaded structure set shows every ROI; the structures legend
   * toggles entries in and out. Reset on each load (stale keys never match).
   */
  private readonly hiddenRois = signal<ReadonlySet<string>>(new Set());
  /**
   * Per-ROI colour overrides keyed by {@link roiKeyOf}, as `#rrggbb`. An ROI
   * absent from the map keeps its RTSTRUCT display colour; the structures panel's
   * colour picker writes an entry here. Reset on each load.
   */
  private readonly roiColorOverrides = signal<ReadonlyMap<string, string>>(new Map());
  /**
   * Per-ROI draw opacity in `[0, 1]` keyed by {@link roiKeyOf}. An ROI absent from
   * the map draws fully opaque (1); the structures panel's opacity slider writes
   * here. Reset on each load.
   */
  private readonly roiOpacities = signal<ReadonlyMap<string, number>>(new Map());
  /**
   * Which structure set the panel and overlays show: an index into
   * {@link structureSets}, or -1 for all of them. Only meaningful when more than
   * one structure set annotates the series; reset to "all" on each load.
   */
  protected readonly selectedSetIndex = signal<number>(-1);
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
    const obliques = this.obliques();
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
        obliques[pane.orientation],
      );
      if (!point || !withinRect(pane.rect, point.x, point.y)) continue;
      result.push({ key: this.paneKey(pane), rect: pane.rect, x: point.x, y: point.y });
    }
    return result;
  });

  /**
   * Cross-pane reference lines: for each MPR pane, where every *other* MPR pane's
   * (possibly oblique) plane crosses it, via {@link referenceLine} →
   * {@link clipLineToUnitSquare} → {@link planePointToPane}. The lines tilt live
   * as a plane is made oblique, so they show the oblique angle on the panes that
   * stay orthogonal. Shares the {@link crosshairsEnabled} toggle with the linked
   * crosshairs and is coloured to match each plane's 3D cut-plane outline.
   */
  protected readonly referenceLines = computed<ReferenceLineOverlay[]>(() => {
    const volume = this.volume();
    if (!this.crosshairsEnabled() || !volume) return [];

    const indices = this.sliceIndices();
    const obliques = this.obliques();
    const zooms = this.zooms();
    const pans = this.pans();
    const flipped = this.sagittalFlipped();
    const mprPanes = this.panes().filter((pane) => pane.kind === 'mpr');
    const result: ReferenceLineOverlay[] = [];
    for (const into of mprPanes) {
      if (into.kind !== 'mpr') continue;
      const intoFlip = into.orientation === Orientation.Sagittal && flipped;
      for (const other of mprPanes) {
        if (other.kind !== 'mpr' || other.orientation === into.orientation) continue;
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
          key: `${into.orientation}-${other.orientation}`,
          rect: into.rect,
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          color: SLICE_PLANE_COLORS[other.orientation],
        });
      }
    }
    return result;
  });

  /**
   * The oblique rotation gizmo for each MPR pane that is hovered or already
   * tilted: a ring centred on the pane and a draggable knob whose offset from the
   * centre encodes the plane's tilt ({@link OBLIQUE_PX_PER_RAD}). Dragging the
   * knob ({@link onObliqueHandleDown}) yaws/pitches the plane; the reference lines
   * on the other panes follow. The orthogonal home is the ring centre, so a knob
   * at rest there means no tilt.
   */
  protected readonly obliqueGizmos = computed<ObliqueGizmo[]>(() => {
    if (!this.crosshairsEnabled() || !this.isReady()) return [];
    const hovered = this.hoveredKey();
    const obliques = this.obliques();
    const result: ObliqueGizmo[] = [];
    for (const pane of this.panes()) {
      if (pane.kind !== 'mpr') continue;
      const key = this.paneKey(pane);
      const tilt = obliques[pane.orientation];
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
   * Per-ROI 3D surface meshes, lofted from each ROI's contour stack
   * ({@link loftContours}) in patient space. The 3D pane draws these as
   * translucent shaded shells (see {@link drawSurfaces}) instead of a busy stack
   * of wireframe rings, so the volume stays visible through them. Camera- and
   * visibility-independent — recomputed only when the structure sets change.
   */
  private readonly surfaceMeshes = computed<RoiSurfaceMesh[]>(() => {
    const sets = this.structureSets();
    if (!this.isReady() || sets.length === 0) return [];
    const meshes: RoiSurfaceMesh[] = [];
    sets.forEach((ss, setIndex) => {
      for (const roi of ss.rois) {
        const loops = roi.contours
          .filter((c) => c.geometricType !== 'OPEN_PLANAR' && c.geometricType !== 'POINT')
          .map((c) => c.points);
        const triangles = loftContours(loops);
        if (triangles.length) {
          const baseColor = roi.color ?? ([200, 200, 200] as const);
          meshes.push({ setIndex, roiNumber: roi.number, baseColor, triangles });
        }
      }
    });
    return meshes;
  });

  /** The 3D pane's rectangle (CSS px) when there are ROI surfaces to draw, else null. */
  protected readonly surface3dRect = computed<PaneRect | null>(() => {
    if (this.surfaceMeshes().length === 0) return null;
    const mip = this.panes().find((pane) => pane.kind === 'mip');
    return mip && mip.rect.width >= 1 && mip.rect.height >= 1 ? mip.rect : null;
  });

  /**
   * The interactive cut-plane gizmo for the 3D pane: the arbitrary clip plane
   * (centre + normal in patient space) projected through the orbit camera into
   * pane-local pixels — a square outline, a draggable handle at its centre, and a
   * stub along the kept-side normal. The handle drag maps a pointer move onto the
   * plane's offset via {@link ClipPlaneGizmo.axisX}/`axisY`, the screen projection
   * of a 1 mm step along the normal. Null unless the handle is enabled.
   */
  protected readonly clipPlaneGizmo = computed<ClipPlaneGizmo | null>(() => {
    const volume = this.volume();
    if (!this.clipPlaneEnabled() || !this.isReady() || !volume) return null;
    const mip = this.panes().find((pane) => pane.kind === 'mip');
    if (!mip) return null;

    const basis = cameraBasis(volume, this.camera3d(), mip.rect.width, mip.rect.height);
    const { center, radius } = volumeBounds(volume);
    const normal = this.clipPlaneNormal();
    const point = add(center, scale(normal, this.clipPlaneOffsetMm()));

    // Two in-plane axes spanning the plane square; pick a reference not parallel
    // to the normal so the cross products stay well-conditioned.
    const ref: Vec3 = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const tangent = normalize(cross(normal, ref));
    const bitangent = normalize(cross(normal, tangent));
    const toPx = (p: Vec3): { x: number; y: number } => {
      const { u, v } = projectToPane(basis, p);
      return { x: u * mip.rect.width, y: v * mip.rect.height };
    };
    const corner = (su: number, sv: number): { x: number; y: number } =>
      toPx(add(point, add(scale(tangent, su * radius), scale(bitangent, sv * radius))));
    const outline = [corner(1, 1), corner(-1, 1), corner(-1, -1), corner(1, -1)]
      .map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(' ');

    const handle = toPx(point);
    const tip = toPx(add(point, scale(normal, radius * 0.3)));
    const normalLine = `${handle.x.toFixed(1)},${handle.y.toFixed(1)} ${tip.x.toFixed(1)},${tip.y.toFixed(1)}`;

    // Screen displacement per mm of offset: where a 1 mm step along the normal
    // lands (orthographic, so this is linear and constant across the pane).
    const step = toPx(add(point, normal));
    return {
      rect: mip.rect,
      outline,
      handle,
      normalLine,
      axisX: step.x - handle.x,
      axisY: step.y - handle.y,
    };
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
    const obliques = this.obliques();
    for (const m of this.measurements()) {
      if ((m.tool !== 'ellipse' && m.tool !== 'rectangle') || m.points.length < 2) continue;
      const res = roiStats(
        volume,
        m.orientation,
        m.sliceIndex,
        m.tool,
        m.points[0],
        m.points[1],
        obliques[m.orientation],
      );
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

  /** Structure sets (RTSTRUCT) annotating the displayed series; empty when none. */
  private readonly structureSets = computed<readonly StructureSet[]>(() => {
    const state = this.load();
    return state.status === 'ready' ? state.result.structureSets : [];
  });

  /** Whether any structure set annotates the displayed series (gates the panel). */
  protected readonly hasStructures = computed(() => this.structureSets().length > 0);

  /**
   * Options for the structure-set selector: an "All structure sets" entry plus one
   * per set (labelled by its Structure Set Label, falling back to the file name).
   * Only surfaced when more than one set is associated (see {@link hasManyStructureSets}).
   */
  protected readonly structureSetChoices = computed<{ value: number; label: string }[]>(() => {
    const sets = this.structureSets();
    return [
      { value: -1, label: 'All structure sets' },
      ...sets.map((ss, index) => ({
        value: index,
        label: ss.label || ss.name || `Structure set ${index + 1}`,
      })),
    ];
  });

  /** Whether more than one structure set is associated, gating the set selector. */
  protected readonly hasManyStructureSets = computed(() => this.structureSets().length > 1);

  /**
   * The ROIs of the shown structure set(s) flattened for the panel: each with a
   * stable key, name, interpreted type, effective colour, opacity and visibility.
   * Filtered by the {@link selectedSetIndex} selector. Recomputed from the
   * structure sets and the visibility / colour / opacity / selection state.
   */
  protected readonly roiLegend = computed<RoiLegendEntry[]>(() =>
    buildRoiLegend(
      this.structureSets(),
      this.hiddenRois(),
      this.roiColorOverrides(),
      this.roiOpacities(),
      this.selectedSetIndex(),
    ),
  );

  /** Whether every listed ROI is visible: drives the master toggle's checked state. */
  protected readonly allRoisVisible = computed(() => this.roiLegend().every((e) => e.visible));

  /**
   * Whether the listed ROIs are a mix of shown and hidden, for the master toggle's
   * indeterminate state. False when they are uniformly all-on or all-off.
   */
  protected readonly someRoisHidden = computed(() => {
    const entries = this.roiLegend();
    return entries.some((e) => e.visible) && entries.some((e) => !e.visible);
  });

  /**
   * The expensive half: every ROI's contours projected into each MPR
   * orientation's plane frame once ({@link projectContour}), with each contour's
   * through-plane span precomputed. Recomputed only when the volume, structure
   * sets or oblique tilt change — never on slice scroll, pan, zoom, flip,
   * window/level, ROI visibility/colour, or the 3D camera. Projects all three
   * MPR orientations regardless of layout so cycling panes needs no re-projection.
   */
  private readonly contourCoords = computed<Map<Orientation, RoiContourCoords[]>>(() => {
    const out = new Map<Orientation, RoiContourCoords[]>();
    const volume = this.volume();
    const sets = this.structureSets();
    if (!this.isReady() || !volume || sets.length === 0) return out;

    const obliques = this.obliques();
    for (const orientation of MPR_ORIENTATIONS) {
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
            rois.push({
              setIndex,
              roiNumber: roi.number,
              baseColor: rgbColor(roi.color),
              contours,
            });
          }
        }
      });
      if (rois.length) out.set(orientation, rois);
    }
    return out;
  });

  /**
   * The cheap, per-slice half: classify the cached {@link contourCoords} against
   * the current slice — coplanar loops on this slice (decimated), crossing
   * contours folded into the cross-section outline — and apply ROI visibility,
   * colour and opacity. Scrolling slices re-runs only this (an O(1) span test
   * skips off-slice contours; no re-projection), and only for the scrolled
   * orientation's pane. Result is still in plane `(u, v)`; pan/zoom map to pixels.
   */
  private readonly contourPlaneGeometry = computed<Map<Orientation, RoiPlaneShapes[]>>(() => {
    const out = new Map<Orientation, RoiPlaneShapes[]>();
    const volume = this.volume();
    const coordsByOrientation = this.contourCoords();
    if (!volume || coordsByOrientation.size === 0) return out;

    const indices = this.sliceIndices();
    const hidden = this.hiddenRois();
    const overrides = this.roiColorOverrides();
    const opacities = this.roiOpacities();
    const selectedSet = this.selectedSetIndex();

    const shown = new Set<Orientation>();
    for (const pane of this.panes()) if (pane.kind === 'mpr') shown.add(pane.orientation);

    for (const [orientation, rois] of coordsByOrientation) {
      if (!shown.has(orientation)) continue;
      const sliceIndex = indices[orientation];
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
            loops.push({ points: decimate(res.points, CONTOUR_DECIMATE_UV), closed: res.closed });
          } else {
            rows.push(res.row);
          }
        }

        const polylines = [...loops, ...crossSectionOutline(rows)];
        if (polylines.length === 0) continue;
        roiShapes.push({
          key,
          color: overrides.get(key) ?? roi.baseColor,
          opacity: opacities.get(key) ?? 1,
          polylines,
        });
      }
      if (roiShapes.length) out.set(orientation, roiShapes);
    }
    return out;
  });

  /**
   * RTSTRUCT ROI contours mapped to each MPR pane's pixels — the cheap half. It
   * takes the cached plane-space geometry ({@link contourPlaneGeometry}) and
   * applies the current pan/zoom/flip with {@link planePointToPane} (the same
   * forward map the measurements and crosshair use), so dragging to pan moves the
   * contours in lockstep with the image without re-projecting any patient points.
   */
  protected readonly contourOverlays = computed<ContourPaneOverlay[]>(() => {
    const volume = this.volume();
    const geometry = this.contourPlaneGeometry();
    if (!volume || geometry.size === 0) return [];

    const zooms = this.zooms();
    const pans = this.pans();
    const flipped = this.sagittalFlipped();

    const result: ContourPaneOverlay[] = [];
    for (const pane of this.panes()) {
      if (pane.kind !== 'mpr') continue;
      const roiShapes = geometry.get(pane.orientation);
      if (!roiShapes) continue;
      const orientation = pane.orientation;
      const rect = pane.rect;
      if (rect.width < 1 || rect.height < 1) continue;
      const flipX = orientation === Orientation.Sagittal && flipped;
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
      if (shapes.length) result.push({ key: this.paneKey(pane), rect, shapes });
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

  /** {@link loadProgress} as a 0–100 whole percent for the progress bar's `aria-valuenow`. */
  protected readonly loadPercent = computed<number>(() => Math.round(this.loadProgress() * 100));

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
      this.obliques()[pane.orientation],
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
  /** Handle of the coalesced viewport-resync frame, or null when none is pending. */
  private resizeHandle: number | null = null;
  /** Handle of the coalesced 3D-surface redraw frame, or null when none is pending. */
  private surfaceHandle: number | null = null;
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
      const views = this.composePaneViews();
      if (!views) return;
      this.pendingViews = views;
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

    // Focus management for the modal shortcut help: move focus into the panel
    // when it opens so keyboard/AT users land inside it, and restore focus to the
    // trigger when it closes. Focus is moved, not trapped — Tab still reaches the
    // chrome behind it and Esc closes (see onEscapeKey), per the a11y brief.
    effect(() => {
      const panel = this.helpPanelRef()?.nativeElement;
      if (this.helpOpen()) {
        // Capture the trigger and move focus in once, on first appearance.
        if (panel && this.helpReturnFocus === null) {
          this.helpReturnFocus = document.activeElement as HTMLElement | null;
          panel.focus();
        }
      } else if (this.helpReturnFocus) {
        this.helpReturnFocus.focus();
        this.helpReturnFocus = null;
      }
    });

    // Redraw the translucent 3D ROI surfaces (a 2D-canvas overlay, drawn
    // imperatively) whenever the meshes, camera, pane, ROI visibility/colour or
    // device-pixel ratio change. Coalesced into one frame so an orbit drag — a
    // stream of camera updates — repaints once per frame.
    effect(() => {
      this.surfaceMeshes();
      this.surface3dRect();
      this.surface3dRef();
      this.camera3d();
      this.hiddenRois();
      this.roiColorOverrides();
      this.roiOpacities();
      this.selectedSetIndex();
      this.viewport();
      this.scheduleSurfaceDraw();
    });

    this.destroyRef.onDestroy(() => {
      if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
      if (this.resizeHandle !== null) cancelAnimationFrame(this.resizeHandle);
      if (this.surfaceHandle !== null) cancelAnimationFrame(this.surfaceHandle);
      if (this.settleHandle !== null) clearTimeout(this.settleHandle);
      if (this.cineHandle !== null) clearInterval(this.cineHandle);
    });
  }

  /** Coalesce surface redraws into a single animation frame. */
  private scheduleSurfaceDraw(): void {
    if (this.surfaceHandle !== null) return;
    this.surfaceHandle = requestAnimationFrame(() => {
      this.surfaceHandle = null;
      this.drawSurfaces();
    });
  }

  /**
   * Paint the visible ROI surfaces onto the 3D overlay canvas: project every
   * triangle through the orbit camera, shade it by its facing to a head-light,
   * sort back-to-front (painter's algorithm) and alpha-fill. Drawn over — not
   * depth-composited with — the volume, so the volume shows through the
   * translucent shells.
   */
  private drawSurfaces(): void {
    const canvas = this.surface3dRef()?.nativeElement;
    const rect = this.surface3dRect();
    const volume = this.volume();
    if (!canvas || !rect || !volume) return;

    const dpr = this.viewport().dpr;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const camera = this.camera3d();
    const basis = cameraBasis(volume, camera, rect.width, rect.height);
    const light = viewBasis(camera.azimuth, camera.elevation).forward; // head-light into screen
    const hidden = this.hiddenRois();
    const overrides = this.roiColorOverrides();
    const opacities = this.roiOpacities();
    const selectedSet = this.selectedSetIndex();

    interface Face {
      readonly depth: number;
      readonly x0: number;
      readonly y0: number;
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly fill: string;
    }
    const faces: Face[] = [];
    for (const mesh of this.surfaceMeshes()) {
      if (!setIsShown(selectedSet, mesh.setIndex)) continue;
      const key = roiKeyOf(mesh.setIndex, mesh.roiNumber);
      if (hidden.has(key)) continue;
      const [r, g, b] = parseHexColor(overrides.get(key)) ?? mesh.baseColor;
      const alpha = (opacities.get(key) ?? 1) * SURFACE_ALPHA;
      if (alpha <= 0) continue;

      for (const tri of mesh.triangles) {
        const p0 = projectToPane(basis, tri[0]);
        const p1 = projectToPane(basis, tri[1]);
        const p2 = projectToPane(basis, tri[2]);
        const normal = normalize(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
        const shade = 0.45 + 0.55 * Math.abs(dot(normal, light));
        faces.push({
          depth: (p0.depth + p1.depth + p2.depth) / 3,
          x0: p0.u * w,
          y0: p0.v * h,
          x1: p1.u * w,
          y1: p1.v * h,
          x2: p2.u * w,
          y2: p2.v * h,
          fill: `rgba(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)},${alpha})`,
        });
      }
    }

    faces.sort((a, b) => b.depth - a.depth); // far first (painter's algorithm)
    for (const f of faces) {
      ctx.beginPath();
      ctx.moveTo(f.x0, f.y0);
      ctx.lineTo(f.x1, f.y1);
      ctx.lineTo(f.x2, f.y2);
      ctx.closePath();
      ctx.fillStyle = f.fill;
      ctx.fill();
    }
  }

  /**
   * Build the pane views to draw from the current state, in device pixels — the
   * single source the render effect and the rotation capture both submit to the
   * renderer. Reading every signal here (not in the effect body) keeps the
   * effect's dependency tracking intact while letting the capture loop re-derive
   * a frame synchronously after nudging the camera. Returns null until the GPU
   * and a volume are ready.
   */
  private composePaneViews(): PaneView[] | null {
    const renderer = this.renderer();
    const volume = this.volume();
    const panes = this.panes();
    const { dpr } = this.viewport();
    const indices = this.sliceIndices();
    const zooms = this.zooms();
    const pans = this.pans();
    const obliques = this.obliques();
    const camera = this.camera3d();
    const projectionMode = this.projectionMode();
    const transferFunction = this.transferFunction();
    const lighting = this.dvrLighting();
    const clipToPlanes = this.clipToPlanes();
    const cutPlane = this.cutPlane();
    const slabThicknessMm = this.slabThicknessMm();
    const windowCenter = this.windowCenter();
    const windowWidth = this.windowWidth();
    const sagittalFlipped = this.sagittalFlipped();
    const invert = this.invert();
    // The MIP renders at reduced quality while it's being orbited, zoomed, or
    // window/levelled, then at full quality once interaction settles.
    const mipInteractive = this.drag()?.kind === 'orbit' || this.mipSettling();
    if (!renderer || !volume) return null;

    return panes.map((pane) =>
      pane.kind === 'mip'
        ? {
            kind: 'mip',
            windowCenter,
            windowWidth,
            camera,
            projectionMode,
            transferFunction,
            lighting,
            clipToPlanes,
            sliceIndices: indices,
            cutPlane: cutPlane ?? undefined,
            slabThicknessMm,
            interactive: mipInteractive,
            invert,
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
            rotation: obliques[pane.orientation],
            flipX: pane.orientation === Orientation.Sagittal && sagittalFlipped,
            invert,
            rect: scaleRect(pane.rect, dpr),
          },
    );
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

  /** Show or hide one ROI's contours, from the structures panel checkbox. */
  protected toggleRoi(key: string): void {
    this.hiddenRois.update((hidden) => {
      const next = new Set(hidden);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /**
   * Show or hide every currently-listed ROI at once, from the master toggle. The
   * listed ROIs are the panel's current set-filtered view, so this never touches
   * ROIs hidden behind the structure-set selector.
   */
  protected setAllRoisVisible(visible: boolean): void {
    const keys = this.roiLegend().map((e) => e.key);
    this.hiddenRois.update((hidden) => {
      const next = new Set(hidden);
      for (const key of keys) {
        if (visible) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  /** Override one ROI's contour colour from the panel's colour picker. */
  protected onRoiColor(key: string, event: Event): void {
    const hex = (event.target as HTMLInputElement).value;
    this.roiColorOverrides.update((map) => new Map(map).set(key, hex));
  }

  /** Set one ROI's contour opacity (whole percent) from the panel's slider. */
  protected onRoiOpacity(key: string, event: Event): void {
    const percent = Number((event.target as HTMLInputElement).value);
    this.roiOpacities.update((map) => new Map(map).set(key, clamp(percent, 0, 100) / 100));
  }

  /** Switch which structure set the panel and overlays show (-1 for all). */
  protected onStructureSetChange(event: Event): void {
    this.selectedSetIndex.set(Number((event.target as HTMLSelectElement).value));
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
   * Zoom-to-fit every MPR pane: the letterbox fit (zoom 1) with no pan. Applied
   * across all orientations at once so the panes stay consistent.
   */
  protected fitView(): void {
    this.zooms.set([1, 1, 1]);
    this.pans.set(NO_PANS);
  }

  /**
   * Show each MPR pane at native voxel scale (1:1): one resampled output voxel
   * per device pixel, centred (pan reset). Computed per orientation from its
   * current pane size, clamped to the zoom range, so every shown pane lands on
   * the same physical scale.
   */
  protected oneToOne(): void {
    const volume = this.volume();
    if (!volume) return;
    const { dpr } = this.viewport();
    let zooms = this.zooms();
    let pans = this.pans();
    for (const pane of this.panes()) {
      if (pane.kind !== 'mpr') continue;
      const rect = scaleRect(pane.rect, dpr);
      if (rect.width < 1 || rect.height < 1) continue;
      const zoom = clamp(
        oneToOneZoom(volume, pane.orientation, rect.width, rect.height),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      zooms = withValue(zooms, pane.orientation, zoom);
      pans = withValue(pans, pane.orientation, NO_PAN);
    }
    this.zooms.set(zooms);
    this.pans.set(pans);
  }

  /**
   * Reset the view to its defaults: fit every pane (zoom/pan), clear the grayscale
   * inversion, and restore the window/level to the volume's own suggested window.
   */
  protected resetView(): void {
    this.fitView();
    this.invert.set(false);
    this.resetOblique();
    const volume = this.volume();
    if (!volume) return;
    this.windowCenter.set(Math.round(volume.windowCenter));
    this.windowWidth.set(Math.max(1, Math.round(volume.windowWidth)));
    this.markMipSettling();
  }

  /** Toggle the display grayscale inversion (white ⇄ black) across every pane. */
  protected toggleInvert(): void {
    this.invert.update((on) => !on);
    this.markMipSettling();
  }

  /** Open/close the keyboard-shortcut help overlay. */
  protected toggleHelp(): void {
    this.helpOpen.update((open) => !open);
  }

  /**
   * Save a PNG of the active pane (the hovered one, else the first/main pane).
   * The canvas is re-rendered and the pane's device-pixel region snapshotted in
   * the same frame — before the next `getCurrentTexture()` recycles the WebGPU
   * drawing buffer — then cropped onto a 2-D canvas and downloaded.
   */
  protected captureScreenshot(): void {
    const renderer = this.renderer();
    if (!renderer || !this.isReady()) return;
    const pane = this.captureTargetPane();
    if (!pane) return;
    const views = this.composePaneViews();
    if (!views) return;
    const canvas = this.canvasRef().nativeElement;
    const rect = scaleRect(pane.rect, this.viewport().dpr);
    const filename = this.captureName(this.paneViewTag(pane), 'png');

    requestAnimationFrame(() => {
      renderer.renderPanes(views);
      const region = cropCanvas(canvas, rect);
      if (!region) return;
      region.toBlob((blob) => {
        if (blob) downloadBlob(blob, filename);
      }, 'image/png');
    });
  }

  /**
   * Record a 360° spin of the 3D pane to a WebM clip. A MediaRecorder samples
   * the canvas via {@link HTMLCanvasElement.captureStream} while the orbit camera
   * steps through one full revolution ({@link rotationAzimuths}); each step is
   * rendered synchronously so the captured frames track the spin. The camera is
   * restored and the clip downloaded when recording stops. No-op (and the control
   * is hidden) unless a 3D pane is shown and the browser supports WebM recording.
   */
  protected captureRotation(): void {
    const renderer = this.renderer();
    const mimeType = this.recordingMimeType;
    if (!renderer || !mimeType || !this.canRecordRotation() || this.recordingRotation()) return;

    const canvas = this.canvasRef().nativeElement;
    const stream = canvas.captureStream(ROTATION_FPS);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    const filename = this.captureName('rotation', 'webm');
    const startAzimuth = this.camera3d().azimuth;
    const azimuths = rotationAzimuths(startAzimuth, ROTATION_FRAMES);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      this.camera3d.update((camera) => ({ ...camera, azimuth: startAzimuth }));
      this.recordingRotation.set(false);
      if (chunks.length > 0) downloadBlob(new Blob(chunks, { type: mimeType }), filename);
    };

    this.recordingRotation.set(true);
    recorder.start();

    let frame = 0;
    const step = () => {
      if (frame >= azimuths.length) {
        recorder.stop();
        return;
      }
      this.camera3d.update((camera) => ({ ...camera, azimuth: azimuths[frame] }));
      const views = this.composePaneViews();
      if (views) {
        this.pendingViews = views;
        renderer.renderPanes(views);
      }
      frame++;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** The pane an export targets: the hovered pane, else the first (main) pane. */
  private captureTargetPane(): PanePlacement | null {
    const panes = this.panes();
    const hovered = this.hoveredKey();
    if (hovered) {
      const found = panes.find((pane) => this.paneKey(pane) === hovered);
      if (found) return found;
    }
    return panes[0] ?? null;
  }

  /** A short view tag for a capture filename: an orientation name, or `3d`. */
  private paneViewTag(pane: PanePlacement): string {
    return pane.kind === 'mip' ? '3d' : this.orientationName(pane.orientation).toLowerCase();
  }

  /** A download filename from the displayed series, a view tag, and the time. */
  private captureName(view: string, extension: string): string {
    const series = this.seriesList().find((s) => s.uid === this.selectedSeriesUid());
    return captureFilename(series ?? null, view, extension, timestampSlug(new Date()));
  }

  /**
   * Viewport-control and help shortcuts that key off raw characters: fit (0),
   * native 1:1 (1), reset (R), invert (V), and the help overlay (?). Routed
   * through one handler because Angular's per-key host bindings don't parse the
   * digit and '?' keys cleanly. Ignored while typing in a field.
   */
  protected onShortcutKey(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
      return;
    }
    if (event.key === '?') {
      if (!this.isReady()) return;
      event.preventDefault();
      this.toggleHelp();
      return;
    }
    if (!this.isReady()) return;
    switch (event.key) {
      case 'r':
      case 'R':
        event.preventDefault();
        this.resetView();
        break;
      case 'v':
      case 'V':
        event.preventDefault();
        this.toggleInvert();
        break;
      case '0':
        if (!this.hasMprPane()) return;
        event.preventDefault();
        this.fitView();
        break;
      case '1':
        if (!this.hasMprPane()) return;
        event.preventDefault();
        this.oneToOne();
        break;
    }
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
      this.obliques()[placement.orientation],
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
        cutPlane: this.cutPlane() ?? undefined,
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
    const obliques = this.obliques();
    this.sliceIndices.set([
      focusSliceIndex(volume, Orientation.Axial, voxel, obliques[Orientation.Axial]),
      focusSliceIndex(volume, Orientation.Coronal, voxel, obliques[Orientation.Coronal]),
      focusSliceIndex(volume, Orientation.Sagittal, voxel, obliques[Orientation.Sagittal]),
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

  /**
   * Escape closes the open overlays (help, then metadata), then cancels an
   * in-progress measurement, then deactivates the tool — most-modal first so one
   * press peels off one layer.
   */
  protected onEscapeKey(event: Event): void {
    if (event.target instanceof HTMLInputElement) return;
    if (this.helpOpen()) {
      this.helpOpen.set(false);
      return;
    }
    if (this.infoPanelOpen()) {
      this.infoPanelOpen.set(false);
      return;
    }
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

  protected onPointerLeave(event: PointerEvent): void {
    // Moving the cursor onto an in-pane overlay handle (the oblique tilt knob, a
    // measurement handle) makes the canvas fire pointerleave even though the
    // pointer hasn't really left the panes. Clearing the hovered pane here would
    // unmount the at-rest oblique knob the instant it's hovered — leaving nothing
    // under the press, so the knob can't be grabbed. Keep the hover in that case.
    const related = event.relatedTarget as Element | null;
    if (related?.closest?.('.oblique-knob, .measure-handle')) return;
    this.cursor.set(null);
    this.hoveredKey.set(null);
  }

  /** Accumulate a pointer move into the 3D camera's orbit angles. */
  private dragOrbit(event: PointerEvent, drag: Extract<Drag, { kind: 'orbit' }>): void {
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    this.drag.set({ ...drag, lastX: event.clientX, lastY: event.clientY });
    this.camera3d.update((cam) => ({
      ...cam,
      azimuth: cam.azimuth + dx * ORBIT_SPEED,
      elevation: clamp(cam.elevation - dy * ORBIT_SPEED, -MAX_ELEVATION, MAX_ELEVATION),
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
      const bounds = this.canvasRef().nativeElement.getBoundingClientRect();
      this.zoomCamera(event.deltaY, placement.rect, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
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

  /**
   * Wheel over the 3D pane magnifies (scroll up) or shrinks the MIP, anchoring
   * the zoom on the cursor: the structure under the pointer stays roughly fixed,
   * matching the MPR panes' Ctrl+wheel zoom. The orbit camera's `zoom` changes and
   * its in-plane pan shifts to hold the cursor's world point in place.
   */
  private zoomCamera(deltaY: number, rect: PaneRect, cursor: Vec2): void {
    if (deltaY === 0) return;
    const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP; // scroll up zooms in
    const volume = this.volume();
    if (!volume || rect.width < 1 || rect.height < 1) return;
    const from = this.camera3d();
    const to = clamp(from.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (to === from.zoom) return;

    // Cursor → centred device coords with +y up, matching the raycaster and pick.
    const ndcX = ((cursor.x - rect.x) / rect.width) * 2 - 1;
    const ndcY = 1 - ((cursor.y - rect.y) / rect.height) * 2;
    const { panX, panY } = rezoomCameraPan(volume, from, rect.width, rect.height, to, ndcX, ndcY);
    this.camera3d.set({ ...from, zoom: to, panX, panY });
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

  /** Re-seed the editable TF from a preset (CT Bone / Soft-tissue / Angio / Lung). */
  protected onTransferFunctionChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    this.transferFunction.set(
      transferFunction(Number(event.target.value) as TransferFunctionPreset),
    );
    this.tfSelected.set(null);
    this.markMipSettling();
  }

  /**
   * Map a pointer event over the TF editor to a `[intensity, opacity]` in the
   * transfer function's domain. The editor's viewBox is 0..100 in each axis, with
   * intensity rising left→right across the domain and opacity rising bottom→top.
   */
  private tfEventValue(event: PointerEvent | MouseEvent): [number, number] {
    const svg = (event.currentTarget ?? event.target) as SVGGraphicsElement;
    const rect = svg.getBoundingClientRect();
    const fx = rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0;
    const fy = rect.height > 0 ? clamp((event.clientY - rect.top) / rect.height, 0, 1) : 0;
    const [lo, hi] = this.transferFunction().domain;
    return [lo + fx * (hi - lo), 1 - fy];
  }

  /** Start dragging the TF control point at `index` (and select it). */
  protected onTfPointerDown(event: PointerEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.tfDrag.set(index);
    this.tfSelected.set(index);
    const svg = (event.target as SVGElement).ownerSVGElement;
    svg?.setPointerCapture(event.pointerId);
  }

  /** Drag the active TF control point to the pointer's intensity/opacity. */
  protected onTfPointerMove(event: PointerEvent): void {
    const index = this.tfDrag();
    if (index === null) return;
    const [intensity, opacity] = this.tfEventValue(event);
    this.transferFunction.update((tf) => moveControlPoint(tf, index, intensity, opacity));
    this.markMipSettling();
  }

  /** Finish a TF control-point drag. */
  protected onTfPointerUp(event: PointerEvent): void {
    if (this.tfDrag() === null) return;
    this.tfDrag.set(null);
    (event.target as SVGElement).ownerSVGElement?.releasePointerCapture(event.pointerId);
  }

  /** Double-click the TF editor background to insert a control point there. */
  protected onTfAddPoint(event: MouseEvent): void {
    const [intensity, opacity] = this.tfEventValue(event);
    this.transferFunction.update((tf) => addControlPoint(tf, intensity, opacity));
    this.tfSelected.set(null);
    this.markMipSettling();
  }

  /** Recolour the selected TF control point from the colour input. */
  protected onTfColorChange(event: Event): void {
    const index = this.tfSelected();
    if (index === null || !(event.target instanceof HTMLInputElement)) return;
    const color = hexToRgb(event.target.value);
    this.transferFunction.update((tf) => setControlPointColor(tf, index, color));
    this.markMipSettling();
  }

  /** Remove the selected TF control point (no-op on an endpoint or the last two). */
  protected onTfRemovePoint(): void {
    const index = this.tfSelected();
    if (index === null) return;
    this.transferFunction.update((tf) => removeControlPoint(tf, index));
    this.tfSelected.set(null);
    this.markMipSettling();
  }

  /** Toggle DVR shading on/off (off renders samples at their flat TF colour). */
  protected toggleShading(): void {
    this.dvrLighting.update((l) => ({ ...l, enabled: !l.enabled }));
    this.markMipSettling();
  }

  /** Update one numeric DVR lighting parameter from a slider. */
  protected onLightingInput(key: keyof DvrLighting, event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    this.dvrLighting.update((l) => ({ ...l, [key]: value }));
    this.markMipSettling();
  }

  /** Toggle the cut-away that clips the 3D pane to the current MPR slice planes. */
  protected toggleClipToPlanes(): void {
    this.clipToPlanes.update((on) => !on);
    this.markMipSettling();
  }

  /** Toggle the arbitrary handle-driven cut-plane, aligning it to the view when enabling. */
  protected toggleClipPlane(): void {
    const enabling = !this.clipPlaneEnabled();
    this.clipPlaneEnabled.set(enabling);
    if (enabling) this.resetClipPlane();
    else this.markMipSettling();
  }

  /** Re-aim the cut-plane to face the current view and recentre it on the volume. */
  protected resetClipPlane(): void {
    const { forward } = viewBasis(this.camera3d().azimuth, this.camera3d().elevation);
    // The kept half is the side the normal points into; forward (eye→volume) keeps
    // the far side, so the plane removes the near half facing the camera.
    this.clipPlaneNormal.set(forward);
    this.clipPlaneOffsetMm.set(0);
    this.markMipSettling();
  }

  /** Begin dragging the cut-plane handle to translate the plane along its normal. */
  protected onClipHandleDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation(); // don't start an orbit under the handle
    const gizmo = this.clipPlaneGizmo();
    const volume = this.volume();
    if (!gizmo || !volume) return;
    const target = event.target as Element;
    target.setPointerCapture?.(event.pointerId);
    this.drag.set({
      kind: 'clipPlane',
      startOffset: this.clipPlaneOffsetMm(),
      startX: event.clientX,
      startY: event.clientY,
      axisX: gizmo.axisX,
      axisY: gizmo.axisY,
      maxOffset: volumeBounds(volume).radius,
    });
  }

  /** Translate the cut-plane to follow the handle drag, clamped within the volume. */
  protected onClipHandleMove(event: PointerEvent): void {
    const drag = this.drag();
    if (drag?.kind !== 'clipPlane') return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    // Project the pointer displacement onto the screen-space normal axis to get
    // the offset change in mm (least-squares onto the gizmo's drag direction).
    const len2 = drag.axisX * drag.axisX + drag.axisY * drag.axisY;
    const delta = len2 > 1e-9 ? (dx * drag.axisX + dy * drag.axisY) / len2 : 0;
    this.clipPlaneOffsetMm.set(clamp(drag.startOffset + delta, -drag.maxOffset, drag.maxOffset));
    this.markMipSettling();
  }

  /** End a cut-plane handle drag. */
  protected onClipHandleUp(event: PointerEvent): void {
    if (this.drag()?.kind !== 'clipPlane') return;
    event.stopPropagation();
    const target = event.target as Element;
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.drag.set(null);
  }

  /** Begin dragging an MPR pane's oblique knob to tilt its reslice plane. */
  protected onObliqueHandleDown(event: PointerEvent, orientation: Orientation): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation(); // don't start a pan under the knob
    const target = event.target as Element;
    target.setPointerCapture?.(event.pointerId);
    const tilt = this.obliques()[orientation];
    this.drag.set({
      kind: 'oblique',
      orientation,
      startX: event.clientX,
      startY: event.clientY,
      startTiltU: tilt.tiltU,
      startTiltV: tilt.tiltV,
    });
  }

  /** Tilt the plane to follow the knob: horizontal yaws (tiltV), vertical pitches (tiltU). */
  protected onObliqueHandleMove(event: PointerEvent): void {
    const drag = this.drag();
    if (drag?.kind !== 'oblique') return;
    event.preventDefault();
    event.stopPropagation();
    const tiltV = clamp(
      drag.startTiltV + (event.clientX - drag.startX) / OBLIQUE_PX_PER_RAD,
      -MAX_OBLIQUE_RAD,
      MAX_OBLIQUE_RAD,
    );
    const tiltU = clamp(
      drag.startTiltU + (event.clientY - drag.startY) / OBLIQUE_PX_PER_RAD,
      -MAX_OBLIQUE_RAD,
      MAX_OBLIQUE_RAD,
    );
    this.obliques.update((obliques) => withValue(obliques, drag.orientation, { tiltU, tiltV }));
  }

  /** End an oblique knob drag. */
  protected onObliqueHandleUp(event: PointerEvent): void {
    if (this.drag()?.kind !== 'oblique') return;
    event.stopPropagation();
    const target = event.target as Element;
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.drag.set(null);
  }

  /** Double-click a knob (or the toolbar button) to restore the orthogonal plane. */
  protected resetOblique(orientation?: Orientation): void {
    if (orientation === undefined) {
      this.obliques.set(NO_OBLIQUES);
      return;
    }
    this.obliques.update((obliques) => withValue(obliques, orientation, NO_OBLIQUE));
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
    this.hiddenRois.set(new Set()); // a fresh structure set starts fully visible
    this.roiColorOverrides.set(new Map()); // and at its RTSTRUCT colours…
    this.roiOpacities.set(new Map()); // …fully opaque
    this.selectedSetIndex.set(-1); // showing every associated structure set
    // Per-volume view state is per-session: always reset to volume-derived defaults.
    this.invert.set(false);
    this.zooms.set([1, 1, 1]);
    this.pans.set(NO_PANS);
    this.obliques.set(NO_OBLIQUES);
    this.camera3d.set(DEFAULT_CAMERA);
    this.transferFunction.set(transferFunction(TransferFunctionPreset.CtBone));
    this.tfSelected.set(null);
    this.dvrLighting.set(DEFAULT_DVR_LIGHTING);
    this.clipToPlanes.set(false);
    this.clipPlaneEnabled.set(false);
    this.clipPlaneOffsetMm.set(0);
    this.sliceIndices.set([
      middleSlice(renderer, Orientation.Axial),
      middleSlice(renderer, Orientation.Coronal),
      middleSlice(renderer, Orientation.Sagittal),
    ]);
    this.load.set({ status: 'ready', result });
  }

  private observeResize(canvas: HTMLCanvasElement): void {
    // Coalesce the burst of notifications during a drag-resize into one sync per
    // frame, so the canvas isn't repeatedly resized (and re-rendered) mid-layout.
    const observer = new ResizeObserver(() => {
      if (this.resizeHandle !== null) return;
      this.resizeHandle = requestAnimationFrame(() => {
        this.resizeHandle = null;
        this.syncViewport(canvas);
      });
    });
    observer.observe(canvas);
    this.destroyRef.onDestroy(() => observer.disconnect());
    this.syncViewport(canvas);
  }

  private syncViewport(canvas: HTMLCanvasElement): void {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    // Round (not floor) to match scaleRect's edge rounding, so the panes tile
    // the backing store exactly with no 1px strip or clamp at the far edges.
    const deviceWidth = Math.max(1, Math.round(width * dpr));
    const deviceHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
      canvas.width = deviceWidth;
      canvas.height = deviceHeight;
    }
    const current = this.viewport();
    if (current.width !== width || current.height !== height || current.dpr !== dpr) {
      this.viewport.set({ width, height, dpr });
    }
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

/**
 * Copy a device-pixel region of the canvas onto a fresh 2-D canvas, for export.
 * Drawing the WebGPU canvas through `drawImage` reads its current contents, so
 * this must run in the same frame the region was rendered. Returns null for a
 * degenerate (sub-pixel) rect or when a 2-D context can't be obtained.
 */
function cropCanvas(source: HTMLCanvasElement, rect: PaneRect): HTMLCanvasElement | null {
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width < 1 || height < 1) return null;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, Math.round(rect.x), Math.round(rect.y), width, height, 0, 0, width, height);
  return out;
}

/** Trigger a browser download of a blob under the given filename. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoke after the click has been dispatched so the download isn't cancelled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
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

/**
 * An ROI Display Color as a CSS `rgb()` string, falling back to a neutral grey
 * when the RTSTRUCT omitted the colour (3006,002A).
 */
function rgbColor(color: readonly [number, number, number] | null): string {
  if (!color) return 'rgb(200, 200, 200)';
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/** Parse a `#rrggbb` colour-input value into [r, g, b] (0–255), or null. */
function parseHexColor(hex: string | undefined): [number, number, number] | null {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
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
function setIsShown(selectedSetIndex: number, setIndex: number): boolean {
  return selectedSetIndex < 0 || selectedSetIndex === setIndex;
}

/**
 * An ROI's effective colour as `#rrggbb` for the colour `<input>`: the user's
 * override when set, else the RTSTRUCT display colour (0–255), else a neutral grey.
 */
function roiColorHex(color: readonly [number, number, number] | null, override?: string): string {
  if (override) return override;
  if (!color) return '#c8c8c8';
  return rgbToHex([color[0] / 255, color[1] / 255, color[2] / 255]);
}

/**
 * Flatten the structure sets into {@link RoiLegendEntry} rows for the structures
 * panel. ROIs with no contours are skipped (nothing to draw or toggle), and the
 * rows are filtered to the selected structure set (or all of them when
 * `selectedSetIndex` is negative). Each row resolves the effective colour and
 * opacity from the override maps so the panel and the overlays stay in lockstep.
 * Pure, so it can be unit-tested without the component.
 */
export function buildRoiLegend(
  structureSets: readonly StructureSet[],
  hidden: ReadonlySet<string>,
  colorOverrides: ReadonlyMap<string, string>,
  opacities: ReadonlyMap<string, number>,
  selectedSetIndex: number,
): RoiLegendEntry[] {
  const entries: RoiLegendEntry[] = [];
  structureSets.forEach((ss, setIndex) => {
    if (!setIsShown(selectedSetIndex, setIndex)) return;
    for (const roi of ss.rois) {
      if (roi.contours.length === 0) continue; // nothing to draw or toggle
      const key = roiKeyOf(setIndex, roi.number);
      const override = colorOverrides.get(key);
      entries.push({
        key,
        setIndex,
        name: roi.name || `ROI ${roi.number}`,
        type: roi.interpretedType ? roi.interpretedType.toUpperCase() : '',
        color: override ?? rgbColor(roi.color),
        colorHex: roiColorHex(roi.color, override),
        opacityPercent: Math.round((opacities.get(key) ?? 1) * 100),
        visible: !hidden.has(key),
      });
    }
  });
  return entries;
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

/** Clamp a pixel offset to a symmetric ±`max` range (the oblique knob's reach). */
function clampPx(value: number, max: number): number {
  return Math.min(max, Math.max(-max, value));
}

/** A linear RGB triple in [0, 1] as a `#rrggbb` hex string for an `<input type=color>`. */
function rgbToHex(color: readonly [number, number, number]): string {
  const hex = (c: number) =>
    Math.round(clamp(c, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(color[0])}${hex(color[1])}${hex(color[2])}`;
}

/** Parse a `#rrggbb` hex string back into a linear RGB triple in [0, 1]. */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
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
