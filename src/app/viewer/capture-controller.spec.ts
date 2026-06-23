import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import type { OrbitCamera } from '../../render/camera';
import type { PaneView, SliceRenderer } from '../../render/slice-renderer';
import { CaptureController, type CaptureInit } from './capture-controller';

/** Frames the controller spins through; mirrors the controller's ROTATION_FRAMES. */
const ROTATION_FRAMES = 120;

/** A MediaRecorder stand-in: records start/stop and emits one chunk then onstop. */
class MockMediaRecorder {
  static isTypeSupported = vi.fn(() => true);
  static instances: MockMediaRecorder[] = [];

  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn(() => {
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    // The browser fires a final dataavailable then onstop; mirror that order.
    this.ondataavailable?.({ data: { size: 1024 } });
    this.onstop?.();
  });

  constructor(
    public stream: unknown,
    public options: { mimeType: string },
  ) {
    MockMediaRecorder.instances.push(this);
  }
}

/** Scheduled animation-frame callbacks, drained by the helpers below. */
let rafQueue: Array<() => void> = [];

/** Run the next queued frame (each step schedules the following one). */
function runNextFrame(): void {
  const next = rafQueue.shift();
  next?.();
}

/** Drain every queued frame, including the steps they schedule, to completion. */
function runAllFrames(): void {
  let guard = 0;
  while (rafQueue.length > 0 && guard++ < 1000) runNextFrame();
}

function makeController(): CaptureController {
  TestBed.configureTestingModule({ providers: [CaptureController] });
  return TestBed.inject(CaptureController);
}

interface Harness {
  readonly controller: CaptureController;
  readonly camera: WritableSignal<OrbitCamera>;
  readonly download: ReturnType<typeof vi.fn>;
  readonly presentViews: ReturnType<typeof vi.fn>;
  readonly trackStop: ReturnType<typeof vi.fn>;
  readonly renderPanes: ReturnType<typeof vi.fn>;
}

/** Wire a controller to mocked renderer/canvas/camera with sensible defaults. */
function setup(overrides: Partial<CaptureInit> = {}): Harness {
  const controller = makeController();
  const camera = signal<OrbitCamera>({ azimuth: 0.4, elevation: 0.25, zoom: 1, panX: 0, panY: 0 });
  const download = vi.fn();
  const presentViews = vi.fn();
  const trackStop = vi.fn();
  const renderPanes = vi.fn();
  const views: PaneView[] = [];
  const canvas = {
    captureStream: vi.fn(() => ({ getTracks: () => [{ stop: trackStop }] })),
  } as unknown as HTMLCanvasElement;

  controller.init({
    renderer: () => ({ renderPanes }) as unknown as SliceRenderer,
    canvas: () => canvas,
    isReady: () => true,
    screenshotTarget: () => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, tag: 'axial' }),
    canRecordRotation: () => true,
    composeViews: () => views,
    presentViews,
    camera,
    naming: () => ({ modality: 'CT', description: 'Chest', seriesNumber: 3 }),
    now: () => new Date(2026, 5, 20, 9, 5, 3),
    download,
    ...overrides,
  });

  return { controller, camera, download, presentViews, trackStop, renderPanes };
}

describe('CaptureController', () => {
  beforeEach(() => {
    rafQueue = [];
    MockMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(() => cb(0));
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('starts not recording and picks a supported WebM container', () => {
    const { controller } = setup();
    expect(controller.recordingRotation()).toBe(false);
    expect(controller.recordingMimeType).toBe('video/webm;codecs=vp9');
  });

  it('steps the camera through a full turn then restores it, downloading a named clip', () => {
    const { controller, camera, download, presentViews } = setup();
    controller.recordRotation();

    expect(controller.recordingRotation()).toBe(true);
    expect(MockMediaRecorder.instances).toHaveLength(1);
    expect(MockMediaRecorder.instances[0].start).toHaveBeenCalledOnce();

    // The first step renders the start azimuth; the second has advanced off it.
    runNextFrame();
    expect(camera().azimuth).toBeCloseTo(0.4);
    runNextFrame();
    expect(camera().azimuth).toBeCloseTo(0.4 + (2 * Math.PI) / ROTATION_FRAMES);
    expect(presentViews).toHaveBeenCalled();

    // Drive the spin to completion: the recorder stops, the camera snaps back, and
    // the clip downloads under a name built from the series metadata + timestamp.
    runAllFrames();
    expect(controller.recordingRotation()).toBe(false);
    expect(camera().azimuth).toBeCloseTo(0.4);
    expect(download).toHaveBeenCalledOnce();
    expect(download.mock.calls[0][1]).toBe('ct-chest-rotation-20260620-090503.webm');
  });

  it('ignores a second rotation request while one is in flight', () => {
    const { controller } = setup();
    controller.recordRotation();
    controller.recordRotation();
    expect(MockMediaRecorder.instances).toHaveLength(1);
  });

  it('does nothing when rotation capture is unavailable', () => {
    const { controller } = setup({ canRecordRotation: () => false });
    controller.recordRotation();
    expect(controller.recordingRotation()).toBe(false);
    expect(MockMediaRecorder.instances).toHaveLength(0);
  });

  it('stops an in-flight recording on teardown', () => {
    const { controller } = setup();
    controller.recordRotation();
    const recorder = MockMediaRecorder.instances[0];
    expect(recorder.state).toBe('recording');

    TestBed.resetTestingModule(); // destroys the injector, firing DestroyRef
    expect(recorder.stop).toHaveBeenCalled();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(controller.recordingRotation()).toBe(false);
  });

  it('screenshot is a no-op without a renderer', () => {
    const { controller, download } = setup({ renderer: () => null });
    controller.screenshot();
    runAllFrames();
    expect(download).not.toHaveBeenCalled();
  });
});
