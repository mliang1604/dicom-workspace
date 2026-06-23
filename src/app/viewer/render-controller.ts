import {
  DestroyRef,
  effect,
  Injectable,
  inject,
  Injector,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { initWebGpu, type GpuContext } from '../../render/device';
import {
  ensureSurfaceSortScratch,
  packSurfaceFrame,
  SliceRenderer,
  type PaneView,
  type SurfaceFrame,
  type SurfaceSortScratch,
} from '../../render/slice-renderer';
import { cameraBasis, viewBasis, type OrbitCamera } from '../../render/camera';
import {
  flattenSurfaceMeshes,
  type ColoredSurfaceMesh,
  type RoiSurfaceMesh,
} from '../../render/surface';
import { composePaneViews } from '../../render/frame';
import { LayoutMode } from '../../render/layout';
import { roiKeyOf, setIsShown } from '../../render/roi-overlay';
import { type Volume } from '../../dicom/types';
import { LayersController } from './layers-controller';
import { View3dController } from './view3d-controller';
import { RoiController } from './roi-controller';
import { type Drag } from './interaction-controller';
import { type PanePlacement } from './pane-placement';
import { parseHexColor } from './viewer-format';
import {
  type PerOrientation,
  type PerOrientationOblique,
  type PerOrientationPan,
} from './viewer-overlays';

/** Base opacity of an ROI's translucent 3D surface, before its per-ROI opacity. */
const SURFACE_ALPHA = 0.4;

/**
 * How long after the last wheel-zoom or window/level change the 3D MIP keeps
 * rendering at reduced quality before snapping back to a full-quality frame.
 */
const MIP_SETTLE_MS = 200;

/** A snapshot of the per-frame view state the canvas needs (current dpr/size). */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** Component state the {@link RenderController} reads/writes; wired via {@link RenderController.init}. */
export interface RenderInit {
  readonly canvas: () => HTMLCanvasElement;
  readonly volume: () => Volume | null;
  readonly panes: () => readonly PanePlacement[];
  readonly camera3d: () => OrbitCamera;
  /** The renderer slot (written on (re)init / device loss). */
  readonly renderer: WritableSignal<SliceRenderer | null>;
  /** Surface a fatal GPU error (or clear it on a successful init). */
  readonly gpuError: WritableSignal<string | null>;
  /** The viewport size signal (synced on resize). */
  readonly viewport: WritableSignal<Viewport>;
  // Per-frame view state the pane composition reads.
  readonly sliceIndices: Signal<PerOrientation>;
  readonly zooms: Signal<PerOrientation>;
  readonly pans: Signal<PerOrientationPan>;
  readonly obliques: Signal<PerOrientationOblique>;
  readonly invert: () => boolean;
  readonly sagittalFlipped: () => boolean;
  readonly slabThicknessMm: () => number;
  readonly layoutMode: () => LayoutMode;
  readonly drag: () => Drag | null;
  /** Extra component effects (preferences mirror, help-focus) run alongside the GPU ones. */
  readonly auxEffects: readonly (() => void)[];
}

/**
 * Owns the WebGPU lifecycle and the per-frame submission pipeline: device init
 * (and recovery from a device loss), the ResizeObserver → canvas/viewport sync,
 * the coalesced requestAnimationFrame submit, the MIP settle timer, and the ROI
 * surface-mesh build + per-frame depth sort. The view signals that drive a frame
 * stay on the component (read through {@link composeViews}); this owns the
 * imperative GPU glue and its handles. Wired once via {@link init}; provided at
 * the component so its lifetime tracks the viewer.
 */
@Injectable()
export class RenderController {
  private readonly layersCtl = inject(LayersController);
  private readonly view3d = inject(View3dController);
  private readonly roiCtl = inject(RoiController);
  private readonly injector = inject(Injector);
  private deps: RenderInit | null = null;

  private gpu: GpuContext | null = null;
  /** Views computed by the render effect, awaiting the next animation frame. */
  private pendingViews: PaneView[] | null = null;
  private frameHandle: number | null = null;
  private settleHandle: ReturnType<typeof setTimeout> | null = null;
  private resizeHandle: number | null = null;
  /** Triangle centroids (3 floats each) for the visible ROI surface mesh, for depth sorting. */
  private surfaceCentroids: Float32Array | null = null;
  private surfaceTriangleCount = 0;
  private surfaceSort: SurfaceSortScratch | null = null;

  /** True while a wheel-zoom / window-level keeps the MIP at reduced quality. */
  readonly mipSettling = signal(false);

  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
      if (this.resizeHandle !== null) cancelAnimationFrame(this.resizeHandle);
      if (this.settleHandle !== null) clearTimeout(this.settleHandle);
      this.deps?.renderer()?.dispose();
    });
  }

  /** Wire the controller to the component's canvas / view state. Called once. */
  init(deps: RenderInit): void {
    this.deps = deps;
  }

  /**
   * Create the GPU-redraw effects: compose+submit the frame, rebuild the ROI
   * surface buffer, (re)upload the overlay, push the checkerboard uniforms, and
   * mirror the camera pan onto the canvas (a headless-CI test seam). Run once
   * after {@link init}, bound to the component's injector for lifecycle.
   */
  startEffects(): void {
    const d = this.deps!;
    const opts = { injector: this.injector };
    // Compose every frame the view state depends on; the submit is coalesced.
    effect(() => this.renderFrame(), opts);
    // Rebuild the GPU surface vertex buffer on mesh / ROI visibility-colour-opacity
    // change (camera-only changes need just a re-sort, handled per frame).
    effect(() => {
      this.buildSurfaceMesh(
        this.roiCtl.surfaceMeshes(),
        this.roiCtl.hiddenRois(),
        this.roiCtl.roiColorOverrides(),
        this.roiCtl.roiOpacities(),
        this.roiCtl.selectedSetIndex(),
      );
      this.scheduleFrame();
    }, opts);
    // Upload / swap / clear the active fusion overlay whenever it changes.
    effect(() => {
      const renderer = d.renderer();
      const overlay = this.layersCtl.selectedOverlay();
      const opacity = overlay ? overlay.opacity : 0;
      if (renderer) renderer.setOverlay(overlay?.volume ?? null, opacity, overlay?.display);
      this.scheduleFrame();
    }, opts);
    // Checkerboard vs. uniform-blend compositing + cell size (per-frame uniforms).
    effect(() => {
      const renderer = d.renderer();
      if (renderer) {
        renderer.setOverlayCheckerboard(this.layersCtl.checkerboardEnabled());
        renderer.setCheckerCells(this.layersCtl.checkerCells());
      }
      this.scheduleFrame();
    }, opts);
    // Test seam: reflect the 3D-camera pan onto the canvas as data attributes.
    effect(() => {
      const el = d.canvas();
      const camera = d.camera3d();
      el.dataset['cameraPanX'] = camera.panX.toFixed(3);
      el.dataset['cameraPanY'] = camera.panY.toFixed(3);
    }, opts);
    // Component-owned auxiliary effects (preferences mirror, help-focus management).
    for (const fn of d.auxEffects) effect(fn, opts);
  }

  /** (Re)initialise the WebGPU device + renderer for the canvas. */
  async initGpu(): Promise<void> {
    const d = this.deps;
    if (!d) return;
    const canvas = d.canvas();
    // Free any prior renderer's GPU resources before rebuilding (e.g. a retry
    // after a device loss) so a re-init doesn't leak the old buffers/textures.
    d.renderer()?.dispose();
    d.renderer.set(null);
    try {
      this.gpu = await initWebGpu(canvas, {
        onDeviceLost: (info) => this.onDeviceLost(info),
        onUncapturedError: (error) => console.error('WebGPU error:', error.message),
      });
      d.renderer.set(new SliceRenderer(this.gpu));
      d.gpuError.set(null); // a successful (re)init clears any prior GPU error
      this.observeResize(canvas);
    } catch (error) {
      d.gpuError.set(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Surface a runtime device loss as a recoverable error rather than letting the
   * canvas silently stop updating. The lost device and its renderer are dead, so
   * drop them; the component's error state then shows the message.
   */
  private onDeviceLost(info: GPUDeviceLostInfo): void {
    const d = this.deps;
    if (!d) return;
    this.gpu = null;
    d.renderer.set(null);
    const reason = info.message ? ` (${info.message})` : '';
    d.gpuError.set(`The GPU device was lost${reason}. Reload the page to continue.`);
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
    const d = this.deps;
    if (!d) return;
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
    const current = d.viewport();
    if (current.width !== width || current.height !== height || current.dpr !== dpr) {
      d.viewport.set({ width, height, dpr });
    }
  }

  /** Present a ready set of views immediately (the rotation-capture path). */
  present(views: PaneView[]): void {
    this.pendingViews = views;
    this.deps?.renderer()?.renderPanes(views);
  }

  /** Compose the current frame and schedule its submission (the render effect's body). */
  renderFrame(): void {
    const views = this.composeViews();
    if (!views) return;
    this.pendingViews = views;
    this.scheduleFrame();
  }

  /**
   * Build the pane views to draw from the current state, in device pixels — the
   * single source the render effect and the rotation capture both submit to the
   * renderer. Returns null until the GPU and a volume are ready.
   */
  composeViews(): PaneView[] | null {
    const d = this.deps;
    if (!d) return null;
    const renderer = d.renderer();
    const volume = this.layersCtl.volume();
    if (!renderer || !volume) return null;

    // The overlay column windows on its own per-layer window/level, falling back
    // to its volume's default.
    const overlay = this.layersCtl.selectedOverlay();
    return composePaneViews({
      panes: d.panes(),
      dpr: d.viewport().dpr,
      baseVolume: volume,
      overlayVolume: overlay?.volume ?? null,
      sliceIndices: d.sliceIndices(),
      zooms: d.zooms(),
      pans: d.pans(),
      obliques: d.obliques(),
      windowCenter: this.layersCtl.windowCenter(),
      windowWidth: this.layersCtl.windowWidth(),
      overlayWindow: overlay ? this.layersCtl.layerWindow(overlay) : null,
      compareMode: d.layoutMode() === LayoutMode.Compare,
      compareLinked: this.layersCtl.compareLinked(),
      groupNav: this.layersCtl.groupNav(),
      hasOverlay: overlay !== null,
      invert: d.invert(),
      sagittalFlipped: d.sagittalFlipped(),
      // The MIP renders at reduced quality while it's being orbited, zoomed, or
      // window/levelled, then at full quality once interaction settles.
      mipInteractive: d.drag()?.kind === 'orbit' || this.mipSettling(),
      camera: d.camera3d(),
      projectionMode: this.view3d.projectionMode(),
      transferFunction: this.view3d.transferFunction(),
      lighting: this.view3d.dvrLighting(),
      clipToPlanes: this.view3d.clipToPlanes(),
      cutPlane: this.view3d.cutPlane(),
      slabThicknessMm: d.slabThicknessMm(),
    });
  }

  /** Submit the latest computed views on the next frame, coalescing rapid updates. */
  scheduleFrame(): void {
    const d = this.deps;
    if (!d || this.frameHandle !== null) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = null;
      const renderer = d.renderer();
      const views = this.pendingViews;
      // Render the panes and the ROI surfaces in one WebGPU pass/frame, so the
      // structures never present a frame apart from the anatomy (no pan/orbit lag).
      if (renderer && views) renderer.renderPanes(views, this.surfaceFrame());
    });
  }

  /** Mark the MIP as actively changing, keeping it at reduced quality until quiet settles. */
  markMipSettling(): void {
    this.mipSettling.set(true);
    if (this.settleHandle !== null) clearTimeout(this.settleHandle);
    this.settleHandle = setTimeout(() => {
      this.settleHandle = null;
      this.mipSettling.set(false);
    }, MIP_SETTLE_MS);
  }

  /**
   * Build the WebGPU vertex buffer for the visible ROI surfaces and hand it to the
   * renderer. Picks the shown ROIs and resolves each one's RGBA (override colour or
   * the RTSTRUCT display colour, alpha folded with the base surface alpha).
   */
  buildSurfaceMesh(
    meshes: readonly RoiSurfaceMesh[],
    hidden: ReadonlySet<string>,
    overrides: ReadonlyMap<string, string>,
    opacities: ReadonlyMap<string, number>,
    selectedSet: number,
  ): void {
    const d = this.deps;
    const renderer = d?.renderer();
    if (!d || !renderer) return;
    const visible: ColoredSurfaceMesh[] = [];
    for (const mesh of meshes) {
      if (!setIsShown(selectedSet, mesh.setIndex)) continue;
      const key = roiKeyOf(mesh.setIndex, mesh.roiNumber);
      const opacity = opacities.get(key) ?? 1;
      if (hidden.has(key) || opacity <= 0) continue;
      const [r, g, b] = parseHexColor(overrides.get(key)) ?? mesh.baseColor;
      visible.push({ mesh, rgba: [r / 255, g / 255, b / 255, opacity * SURFACE_ALPHA] });
    }

    const { vertices, centroids, count } = flattenSurfaceMeshes(visible);
    this.surfaceTriangleCount = count;
    this.surfaceCentroids = count > 0 ? centroids : null;
    d.canvas().dataset['roiSurfaceTriangles'] = String(count);
    renderer.setSurfaceMesh(vertices);
  }

  /**
   * Per-frame surface data for the WebGPU pass: depth-sort the triangles back-to-
   * front against the current camera and pack the camera uniform. Null when there's
   * no 3D pane or no surface mesh.
   */
  private surfaceFrame(): SurfaceFrame | null {
    const d = this.deps;
    if (!d) return null;
    const volume = d.volume();
    const centroids = this.surfaceCentroids;
    const n = this.surfaceTriangleCount;
    if (!volume || !centroids || n === 0) return null;
    const mip = d.panes().find((pane) => pane.kind === 'mip');
    if (!mip || mip.rect.width < 1 || mip.rect.height < 1) return null;

    const camera = d.camera3d();
    const basis = cameraBasis(volume, camera, mip.rect.width, mip.rect.height);
    const light = viewBasis(camera.azimuth, camera.elevation).forward;
    this.surfaceSort = ensureSurfaceSortScratch(this.surfaceSort, n);
    return packSurfaceFrame(centroids, n, basis, light, this.surfaceSort);
  }
}
