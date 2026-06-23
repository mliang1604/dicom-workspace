import { DestroyRef, inject, Injectable, signal, type WritableSignal } from '@angular/core';
import type { OrbitCamera } from '../../render/camera';
import type { PaneRect } from '../../render/layout';
import type { PaneView, SliceRenderer } from '../../render/slice-renderer';
import {
  captureFilename,
  pickVideoMimeType,
  rotationAzimuths,
  timestampSlug,
  type CaptureNaming,
} from './capture';

/** WebM containers tried, most-preferred first, for the 3D rotation capture. */
const VIDEO_MIME_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'] as const;
/** Frames in one full 360° rotation capture (~4 s at the capture frame rate). */
const ROTATION_FRAMES = 120;
/** Frame rate the rotation capture's MediaRecorder samples the canvas at. */
const ROTATION_FPS = 30;

/** Where a PNG screenshot crops from and how it's named, resolved by the viewer. */
export interface ScreenshotTarget {
  /** The target pane's device-pixel region to crop out of the canvas. */
  readonly rect: PaneRect;
  /** Short view tag for the filename (an orientation name, or `3d`). */
  readonly tag: string;
}

/**
 * The component surface the capture orchestration drives, supplied once via
 * {@link CaptureController.init} as lazy callbacks so the controller never reaches
 * into the component or the GPU directly — it reads the renderer/canvas/camera and
 * composes frames through these, and so is unit-testable with them mocked.
 */
export interface CaptureInit {
  /** The slice renderer, or null before the GPU is ready. */
  readonly renderer: () => SliceRenderer | null;
  /** The WebGPU canvas being captured. */
  readonly canvas: () => HTMLCanvasElement;
  /** True once a volume is loaded and the GPU is ready. */
  readonly isReady: () => boolean;
  /** The screenshot's target pane (device-pixel crop rect + view tag), or null. */
  readonly screenshotTarget: () => ScreenshotTarget | null;
  /** Whether a 3D rotation capture is currently possible (3D pane shown). */
  readonly canRecordRotation: () => boolean;
  /** Recompute the pane views to draw for the current state (null until ready). */
  readonly composeViews: () => PaneView[] | null;
  /** Adopt `views` as the next frame to present, keeping a scheduled render in sync. */
  readonly presentViews: (views: PaneView[]) => void;
  /** The orbit camera signal; the spin steps and then restores its azimuth. */
  readonly camera: WritableSignal<OrbitCamera>;
  /** Series naming for the download filename, or null when nothing is loaded. */
  readonly naming: () => CaptureNaming | null;
  /** Current instant, injected so the filename timestamp is deterministic in tests. */
  readonly now: () => Date;
  /** Trigger a browser download of a finished capture (injected for testability). */
  readonly download: (blob: Blob, filename: string) => void;
}

/**
 * Owns the export domain: a PNG screenshot of the active pane and a 360° spin of
 * the 3D pane recorded to WebM. Holds the {@link recordingRotation} flag, the
 * chosen recorder container, and the recorder / animation-frame handles, and stops
 * an in-flight recording on teardown so neither outlives the viewer. The component
 * wires it up once via {@link init} and delegates its toolbar handlers here.
 *
 * Provided at the component so its lifetime tracks the viewer.
 */
@Injectable()
export class CaptureController {
  /**
   * The WebM container the browser can record a rotation capture into, chosen once
   * up front, or null when MediaRecorder/WebM isn't available (which hides the
   * spin-capture control). MPR-only layouts still expose the PNG screenshot.
   */
  readonly recordingMimeType = pickVideoMimeType(
    VIDEO_MIME_TYPES,
    (type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type),
  );

  private readonly recording = signal(false);
  /** True while a 3D rotation capture is recording; disables the export controls. */
  readonly recordingRotation = this.recording.asReadonly();

  /** Handle of the in-flight rotation-capture animation frame, or null when idle. */
  private handle: number | null = null;
  /** The active rotation-capture recorder, or null when not recording. */
  private recorder: MediaRecorder | null = null;

  /** Component callbacks, wired by {@link init} before any capture runs. */
  private deps: CaptureInit | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Wire the controller to the viewer's renderer/canvas/camera. Called once. */
  init(deps: CaptureInit): void {
    this.deps = deps;
  }

  /**
   * Save a PNG of the active pane (the hovered one, else the main pane). The canvas
   * is re-rendered and the pane's device-pixel region snapshotted in the same frame
   * — before the next `getCurrentTexture()` recycles the WebGPU drawing buffer —
   * then cropped onto a 2-D canvas and downloaded.
   */
  screenshot(): void {
    const deps = this.deps;
    if (!deps) return;
    const renderer = deps.renderer();
    if (!renderer || !deps.isReady()) return;
    const target = deps.screenshotTarget();
    if (!target) return;
    const views = deps.composeViews();
    if (!views) return;
    const canvas = deps.canvas();
    const filename = this.captureName(deps, target.tag, 'png');

    requestAnimationFrame(() => {
      renderer.renderPanes(views);
      const region = cropCanvas(canvas, target.rect);
      if (!region) return;
      region.toBlob((blob) => {
        if (blob) deps.download(blob, filename);
      }, 'image/png');
    });
  }

  /**
   * Record a 360° spin of the 3D pane to a WebM clip. A MediaRecorder samples the
   * canvas via {@link HTMLCanvasElement.captureStream} while the orbit camera steps
   * through one full revolution ({@link rotationAzimuths}); each step is rendered
   * synchronously so the captured frames track the spin. The camera is restored and
   * the clip downloaded when recording stops. No-op (and the control is hidden)
   * unless a 3D pane is shown and the browser supports WebM recording.
   */
  recordRotation(): void {
    const deps = this.deps;
    if (!deps) return;
    const renderer = deps.renderer();
    const mimeType = this.recordingMimeType;
    if (!renderer || !mimeType || !deps.canRecordRotation() || this.recording()) return;

    const canvas = deps.canvas();
    const stream = canvas.captureStream(ROTATION_FPS);
    const recorder = new MediaRecorder(stream, { mimeType });
    this.recorder = recorder;
    const chunks: Blob[] = [];
    const filename = this.captureName(deps, 'rotation', 'webm');
    const startAzimuth = deps.camera().azimuth;
    const azimuths = rotationAzimuths(startAzimuth, ROTATION_FRAMES);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      this.recorder = null;
      deps.camera.update((camera) => ({ ...camera, azimuth: startAzimuth }));
      this.recording.set(false);
      if (chunks.length > 0) deps.download(new Blob(chunks, { type: mimeType }), filename);
    };

    this.recording.set(true);
    recorder.start();

    let frame = 0;
    const step = () => {
      if (frame >= azimuths.length) {
        this.handle = null;
        recorder.stop();
        return;
      }
      deps.camera.update((camera) => ({ ...camera, azimuth: azimuths[frame] }));
      const views = deps.composeViews();
      if (views) deps.presentViews(views);
      frame++;
      this.handle = requestAnimationFrame(step);
    };
    this.handle = requestAnimationFrame(step);
  }

  /**
   * Stop any in-flight rotation capture: cancel its pending frame and stop the
   * recorder (its `onstop` restores the camera and finalises the clip). Idempotent
   * — runs on teardown so the recorder/stream never outlive the viewer.
   */
  stop(): void {
    if (this.handle !== null) {
      cancelAnimationFrame(this.handle);
      this.handle = null;
    }
    if (this.recorder !== null && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
  }

  /** A download filename from the displayed series, a view tag, and the time. */
  private captureName(deps: CaptureInit, view: string, extension: string): string {
    return captureFilename(deps.naming(), view, extension, timestampSlug(deps.now()));
  }
}

/**
 * Copy a device-pixel region of the canvas onto a fresh 2-D canvas, for export.
 * Drawing the WebGPU canvas through `drawImage` reads its current contents, so this
 * must run in the same frame the region was rendered. Returns null for a degenerate
 * (sub-pixel) rect or when a 2-D context can't be obtained.
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
