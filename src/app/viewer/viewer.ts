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
import { mprLayout, scaleRect, type PaneRect, type Vec2 } from '../../render/layout';
import {
  clampPan,
  defaultSlabThicknessMm,
  ProjectionMode,
  rezoomPan,
  SliceRenderer,
  type PaneView,
} from '../../render/slice-renderer';
import { volumeBounds } from '../../render/reslice';
import type { OrbitCamera } from '../../render/camera';
import { probeVoxel, type VoxelProbe } from '../../render/probe';
import { modalityUnit, Orientation, type MissingSlices, type Volume } from '../../dicom/types';
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

/** A value per orientation, indexed by the orientation's numeric value. */
type PerOrientation = readonly [number, number, number];

/** A pan offset per orientation, indexed by the orientation's numeric value. */
type PerOrientationPan = readonly [Vec2, Vec2, Vec2];

/** An in-progress drag: panning an MPR pane, or orbiting the 3D pane. */
type Drag =
  | {
      readonly kind: 'pan';
      readonly orientation: Orientation;
      readonly lastX: number;
      readonly lastY: number;
    }
  | { readonly kind: 'orbit'; readonly lastX: number; readonly lastY: number };

const NO_PAN: Vec2 = { x: 0, y: 0 };
const NO_PANS: PerOrientationPan = [NO_PAN, NO_PAN, NO_PAN];

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
  /** Projection accumulated by the 3D pane (MIP / MinIP / Average). */
  protected readonly projectionMode = signal<ProjectionMode>(ProjectionMode.Max);
  /**
   * Thick-slab thickness (mm) for the 3D pane, centred on the volume along the
   * view direction. Defaults to the volume's full depth (whole-volume projection).
   */
  protected readonly slabThicknessMm = signal(0);
  /** The projection-mode options offered in the toolbar, in display order. */
  protected readonly projectionModes = [
    { value: ProjectionMode.Max, label: 'MIP (max)' },
    { value: ProjectionMode.Min, label: 'MinIP (min)' },
    { value: ProjectionMode.Mean, label: 'Average' },
  ] as const;
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
  /** Key of the hovered pane (see {@link paneKey}), or null when away. */
  protected readonly hoveredKey = signal<string | null>(null);
  /** Cursor position in CSS pixels relative to the canvas, or null when away. */
  private readonly cursor = signal<{ readonly x: number; readonly y: number } | null>(null);
  protected readonly windowCenter = signal(0);
  protected readonly windowWidth = signal(1);

  protected readonly isReady = computed(
    () => this.load().status === 'ready' && this.renderer() !== null,
  );

  /** Pane placements in CSS pixels, for the label overlay. */
  protected readonly panes = computed<PanePlacement[]>(() => {
    const { width, height } = this.viewport();
    return placePanes(mprLayout(width, height), this.mainOrientation());
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

  protected async onFilesSelected(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.files) return;
    const files = Array.from(input.files);
    input.value = ''; // allow re-selecting the same folder
    if (files.length > 0) await this.loadFiles(files);
  }

  /** Begin a click-drag over the pane under the pointer (primary button). */
  protected onPointerDown(event: PointerEvent): void {
    if (!this.isReady() || event.button !== 0) return;
    const placement = this.placementAtEvent(event);
    if (!placement) return;
    event.preventDefault();
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

  protected onPointerMove(event: PointerEvent): void {
    const drag = this.drag();
    if (drag?.kind === 'pan') this.dragPan(event, drag);
    else if (drag?.kind === 'orbit') this.dragOrbit(event, drag);

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

  /** Switch the 3D pane's projection mode (MIP / MinIP / Average). */
  protected onProjectionModeChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const mode = Number(event.target.value) as ProjectionMode;
    this.projectionMode.set(mode);
    // Reset the slab to the mode's default: full-volume for MIP, a moderate band
    // for MinIP/Average (keeps the air margins out). Reversible across switches.
    this.slabThicknessMm.set(Math.round(defaultSlabThicknessMm(mode, this.slabMaxMm())));
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
    this.mainOrientation.set(Orientation.Axial);
    this.sagittalFlipped.set(false);
    this.zooms.set([1, 1, 1]);
    this.pans.set(NO_PANS);
    this.camera3d.set(DEFAULT_CAMERA);
    // Reset the 3D projection to the default MIP over the whole volume, like the camera.
    this.projectionMode.set(ProjectionMode.Max);
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
 * Lay out the four panes of the 2×2 grid: the three MPR orientations fill the
 * top-left (the "main", cycled by swap), top-right and bottom-left cells, and the
 * 3D MIP occupies the bottom-right cell.
 */
function placePanes(layout: ReturnType<typeof mprLayout>, main: Orientation): PanePlacement[] {
  const sides = ORIENTATION_ORDER.filter((orientation) => orientation !== main);
  return [
    { kind: 'mpr', orientation: main, rect: layout.topLeft },
    { kind: 'mpr', orientation: sides[0], rect: layout.topRight },
    { kind: 'mpr', orientation: sides[1], rect: layout.bottomLeft },
    { kind: 'mip', rect: layout.bottomRight },
  ];
}

/** The pane containing CSS-pixel point (x, y), or null. */
function placementAt(panes: readonly PanePlacement[], x: number, y: number): PanePlacement | null {
  for (const pane of panes) {
    const { x: rx, y: ry, width, height } = pane.rect;
    if (x >= rx && x < rx + width && y >= ry && y < ry + height) {
      return pane;
    }
  }
  return null;
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
