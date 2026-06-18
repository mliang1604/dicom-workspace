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
import { clampPan, SliceRenderer, type PaneView } from '../../render/slice-renderer';
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
interface PanePlacement {
  readonly orientation: Orientation;
  readonly rect: PaneRect;
}

/** A value per orientation, indexed by the orientation's numeric value. */
type PerOrientation = readonly [number, number, number];

/** A pan offset per orientation, indexed by the orientation's numeric value. */
type PerOrientationPan = readonly [Vec2, Vec2, Vec2];

/** A pane being dragged to pan, with the last pointer position in client pixels. */
interface PanDrag {
  readonly orientation: Orientation;
  readonly lastX: number;
  readonly lastY: number;
}

const NO_PAN: Vec2 = { x: 0, y: 0 };
const NO_PANS: PerOrientationPan = [NO_PAN, NO_PAN, NO_PAN];

/** Order the main pane cycles through when swapping. */
const ORIENTATION_ORDER = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal] as const;

const ZOOM_STEP = 1.1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 20;

/**
 * Only warn about interpolation when the widest gap spans more than this
 * multiple of the slice spacing. A gap up to 2× spacing is a single missing
 * slice (or spacing jitter), which interpolates cleanly and isn't worth a
 * banner; wider gaps leave a visible reconstructed region.
 */
const GAP_WARNING_RATIO = 2;

@Component({
  selector: 'app-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './viewer.html',
  styleUrl: './viewer.css',
  host: { '(window:keydown.x)': 'onSwapKey($event)' },
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
  /** The in-progress pan drag, or null when no button is held over a pane. */
  private readonly panDrag = signal<PanDrag | null>(null);
  protected readonly isPanning = computed(() => this.panDrag() !== null);
  protected readonly mainOrientation = signal<Orientation>(Orientation.Axial);
  /** When true, the sagittal view is mirrored so anterior sits on the right. */
  protected readonly sagittalFlipped = signal(false);
  protected readonly hoveredOrientation = signal<Orientation | null>(null);
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

  /** Live readout of the voxel under the cursor, or null when none is hovered. */
  protected readonly probeText = computed<string | null>(() => {
    if (!this.isReady()) return null;
    const cursor = this.cursor();
    const volume = this.volume();
    if (!cursor || !volume) return null;

    const pane = placementAt(this.panes(), cursor.x, cursor.y);
    if (!pane) return null;

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

  constructor() {
    afterNextRender(() => void this.initGpu());

    effect(() => {
      const renderer = this.renderer();
      const volume = this.volume();
      const panes = this.panes();
      const { dpr } = this.viewport();
      const indices = this.sliceIndices();
      const zooms = this.zooms();
      const pans = this.pans();
      const windowCenter = this.windowCenter();
      const windowWidth = this.windowWidth();
      const sagittalFlipped = this.sagittalFlipped();
      if (!renderer || !volume) return;

      const views: PaneView[] = panes.map((pane) => ({
        orientation: pane.orientation,
        sliceIndex: indices[pane.orientation],
        windowCenter,
        windowWidth,
        zoom: zooms[pane.orientation],
        pan: pans[pane.orientation],
        flipX: pane.orientation === Orientation.Sagittal && sagittalFlipped,
        rect: scaleRect(pane.rect, dpr),
      }));
      renderer.renderPanes(views);
    });
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

  protected async onFilesSelected(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.files) return;
    const files = Array.from(input.files);
    input.value = ''; // allow re-selecting the same folder
    if (files.length > 0) await this.loadFiles(files);
  }

  /** Begin a click-drag pan of the pane under the pointer (primary button). */
  protected onPointerDown(event: PointerEvent): void {
    if (!this.isReady() || event.button !== 0) return;
    const orientation = this.paneAtEvent(event);
    if (orientation === null) return;
    event.preventDefault();
    // Capture so the drag keeps tracking even if the pointer leaves the canvas.
    this.canvasRef().nativeElement.setPointerCapture(event.pointerId);
    this.panDrag.set({ orientation, lastX: event.clientX, lastY: event.clientY });
  }

  protected onPointerMove(event: PointerEvent): void {
    const drag = this.panDrag();
    if (drag) this.dragPan(event, drag);

    const bounds = this.canvasRef().nativeElement.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    this.cursor.set({ x, y });
    this.hoveredOrientation.set(findPaneAt(this.panes(), x, y));
  }

  protected onPointerUp(event: PointerEvent): void {
    if (!this.panDrag()) return;
    const canvas = this.canvasRef().nativeElement;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    this.panDrag.set(null);
  }

  protected onPointerLeave(): void {
    this.cursor.set(null);
    this.hoveredOrientation.set(null);
  }

  /** Accumulate a pointer move into the dragged pane's pan, clamped to bounds. */
  private dragPan(event: PointerEvent, drag: PanDrag): void {
    const next: PanDrag = { ...drag, lastX: event.clientX, lastY: event.clientY };
    this.panDrag.set(next);

    const placement = this.panes().find((pane) => pane.orientation === drag.orientation);
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

  /** Re-clamp a pane's pan after its zoom changes, since the bound scales with zoom. */
  private reclampPan(orientation: Orientation): void {
    const placement = this.panes().find((pane) => pane.orientation === orientation);
    const volume = this.volume();
    if (!placement || !volume) return;
    const zoom = this.zooms()[orientation];
    this.pans.update((pans) => {
      const clamped = clampPan(
        volume,
        orientation,
        placement.rect.width,
        placement.rect.height,
        zoom,
        pans[orientation],
      );
      return clamped.x === pans[orientation].x && clamped.y === pans[orientation].y
        ? pans
        : withValue(pans, orientation, clamped);
    });
  }

  /** Wheel over a pane scrolls its slices; Ctrl+wheel zooms it. */
  protected onWheel(event: WheelEvent): void {
    if (!this.isReady()) return;
    const orientation = this.paneAtEvent(event);
    if (orientation === null) return;

    event.preventDefault();
    if (event.ctrlKey) {
      this.zoomPane(orientation, event.deltaY);
    } else {
      this.scrollSlice(orientation, event.deltaY);
    }
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

  private zoomPane(orientation: Orientation, deltaY: number): void {
    if (deltaY === 0) return;
    const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP; // scroll up zooms in
    this.zooms.update((zooms) => {
      const next = clamp(zooms[orientation] * factor, MIN_ZOOM, MAX_ZOOM);
      return next === zooms[orientation] ? zooms : withValue(zooms, orientation, next);
    });
    // Zooming out shrinks the pan bound; pull the offset back inside it.
    this.reclampPan(orientation);
  }

  protected onWindowCenterInput(event: Event): void {
    this.windowCenter.set(intValue(event));
  }

  protected onWindowWidthInput(event: Event): void {
    this.windowWidth.set(Math.max(1, intValue(event)));
  }

  /** Orientation of the pane under a pointer event, or null if outside the panes. */
  private paneAtEvent(event: MouseEvent): Orientation | null {
    const bounds = this.canvasRef().nativeElement.getBoundingClientRect();
    return findPaneAt(this.panes(), event.clientX - bounds.left, event.clientY - bounds.top);
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

/** Assign orientations to the main + two side panes for the current main view. */
function placePanes(layout: ReturnType<typeof mprLayout>, main: Orientation): PanePlacement[] {
  const sides = ORIENTATION_ORDER.filter((orientation) => orientation !== main);
  return [
    { orientation: main, rect: layout.main },
    { orientation: sides[0], rect: layout.topRight },
    { orientation: sides[1], rect: layout.bottomRight },
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

/** The orientation of the pane containing CSS-pixel point (x, y), or null. */
function findPaneAt(panes: readonly PanePlacement[], x: number, y: number): Orientation | null {
  return placementAt(panes, x, y)?.orientation ?? null;
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
