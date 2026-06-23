import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import { Orientation, type Volume } from '../../dicom/types';
import type { OrbitCamera } from '../../render/camera';
import type { SliceRenderer } from '../../render/slice-renderer';
import { InteractionController, type InteractionInit } from './interaction-controller';
import type { PanePlacement } from './viewer';

/** A minimal volume; only dims/spacing/min/max matter to the interaction maths. */
function makeVolume(): Volume {
  return {
    dims: [4, 4, 4],
    spacing: [1, 1, 1],
    data: new Float32Array(64),
    min: 0,
    max: 100,
    windowCenter: 50,
    windowWidth: 100,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
  };
}

/** An MPR pane (group 0, axial) filling the left half of a 200×100 canvas. */
const MPR_PANE: PanePlacement = {
  kind: 'mpr',
  orientation: Orientation.Axial,
  rect: { x: 0, y: 0, width: 100, height: 100 },
  group: 0,
};
/** The 3D pane filling the right half. */
const MIP_PANE: PanePlacement = { kind: 'mip', rect: { x: 100, y: 0, width: 100, height: 100 } };

function withinRect(rect: PanePlacement['rect'], x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function makeController(): InteractionController {
  TestBed.configureTestingModule({ providers: [InteractionController] });
  return TestBed.inject(InteractionController);
}

interface Harness {
  readonly controller: InteractionController;
  readonly camera: WritableSignal<OrbitCamera>;
  readonly canvas: HTMLCanvasElement;
  readonly setPointerCapture: ReturnType<typeof vi.fn>;
  readonly releasePointerCapture: ReturnType<typeof vi.fn>;
  readonly fns: { [K in keyof InteractionInit]?: ReturnType<typeof vi.fn> };
}

/** Wire a controller to mocked panes/volume/camera with recording stubs. */
function setup(overrides: Partial<InteractionInit> = {}): Harness {
  const controller = makeController();
  const volume = makeVolume();
  const camera = signal<OrbitCamera>({ azimuth: 0, elevation: 0, zoom: 1, panX: 0, panY: 0 });
  const panes: PanePlacement[] = [MPR_PANE, MIP_PANE];

  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  const captured = new Set<number>();
  const canvas = {
    setPointerCapture: (id: number) => {
      captured.add(id);
      setPointerCapture(id);
    },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => {
      captured.delete(id);
      releasePointerCapture(id);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
  } as unknown as HTMLCanvasElement;

  const fns = {
    setMasterPan: vi.fn(),
    setMasterZoom: vi.fn(),
    setMasterSlice: vi.fn(),
    setGroupPan: vi.fn(),
    setGroupZoomPan: vi.fn(),
    setGroupSlice: vi.fn(),
    setLayerWindow: vi.fn(),
    markMipSettling: vi.fn(),
    stopCine: vi.fn(),
    setCursor: vi.fn(),
    setHoveredKey: vi.fn(),
    setActiveCompareGroup: vi.fn(),
    setFocus: vi.fn(),
    setFocusFromMip: vi.fn(),
    placeMeasurePoint: vi.fn(),
  } as const;

  const deps: InteractionInit = {
    isReady: () => true,
    panes: () => panes,
    canvas: () => canvas,
    placementAt: (event) =>
      panes.find((pane) => withinRect(pane.rect, event.clientX, event.clientY)) ?? null,
    paneKey: (pane) => (pane.kind === 'mip' ? 'mip' : `mpr:${pane.group}:${pane.orientation}`),
    volume: () => volume,
    groupVolume: () => volume,
    groupIsIndependent: () => false,
    paneZoom: () => 1,
    panePan: () => ({ x: 0, y: 0 }),
    masterSliceIndex: () => 5,
    groupSliceIndex: () => 5,
    clampZoom: (zoom) => Math.min(20, Math.max(0.5, zoom)),
    layers: () => [],
    isCompare: () => false,
    selectedOverlay: () => null,
    layerWindow: () => ({ center: 50, width: 100 }),
    camera3d: camera,
    renderer: () => ({ sliceCount: () => 16 }) as unknown as SliceRenderer,
    activeTool: () => 'none',
    ...fns,
    ...overrides,
  };

  controller.init(deps);
  return { controller, camera, canvas, setPointerCapture, releasePointerCapture, fns };
}

/** A PointerEvent / WheelEvent stand-in with a no-op preventDefault. */
function pointer(init: {
  button?: number;
  clientX?: number;
  clientY?: number;
  deltaY?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): PointerEvent {
  return {
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    preventDefault: vi.fn(),
    ...init,
  } as unknown as PointerEvent;
}

describe('InteractionController', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('onPointerDown drag-kind dispatch', () => {
    it('starts a zoom drag on a plain right-button press over an MPR pane', () => {
      const { controller } = setup();
      controller.onPointerDown(pointer({ button: 2, clientX: 50, clientY: 50 }));
      expect(controller.drag()).toMatchObject({
        kind: 'zoom',
        orientation: Orientation.Axial,
        group: 0,
      });
    });

    it('starts a camera zoom drag on a plain right-button press over the 3D pane', () => {
      const { controller } = setup();
      controller.onPointerDown(pointer({ button: 2, clientX: 150, clientY: 50 }));
      expect(controller.drag()).toMatchObject({ kind: 'cameraZoom' });
    });

    it('starts a windowLevel drag on an Alt+right-button press', () => {
      const { controller } = setup();
      controller.onPointerDown(pointer({ button: 2, altKey: true, clientX: 50, clientY: 50 }));
      expect(controller.drag()).toMatchObject({ kind: 'windowLevel', layerId: null });
    });

    it('pans an MPR pane on a middle-button press', () => {
      const { controller, setPointerCapture } = setup();
      controller.onPointerDown(pointer({ button: 1, clientX: 50, clientY: 50 }));
      expect(controller.drag()).toMatchObject({ kind: 'pan', orientation: Orientation.Axial });
      expect(setPointerCapture).toHaveBeenCalled();
    });

    it('slides the 3D camera on an Alt+left press over the 3D pane', () => {
      const { controller } = setup();
      controller.onPointerDown(pointer({ button: 0, altKey: true, clientX: 150, clientY: 50 }));
      expect(controller.drag()).toMatchObject({ kind: 'cameraPan' });
    });

    it('orbits on a plain left press over the 3D pane', () => {
      const { controller } = setup();
      controller.onPointerDown(pointer({ button: 0, clientX: 150, clientY: 50 }));
      expect(controller.drag()).toMatchObject({ kind: 'orbit' });
    });

    it('pans on a plain left press over an MPR pane', () => {
      const { controller } = setup();
      controller.onPointerDown(pointer({ button: 0, clientX: 50, clientY: 50 }));
      expect(controller.drag()).toMatchObject({ kind: 'pan', group: 0 });
    });

    it('sets focus instead of dragging on Shift+left over an MPR pane', () => {
      const { controller, fns } = setup();
      controller.onPointerDown(pointer({ button: 0, shiftKey: true, clientX: 50, clientY: 50 }));
      expect(fns.setFocus).toHaveBeenCalledOnce();
      expect(controller.drag()).toBeNull();
    });

    it('ray-casts focus on Shift+left over the 3D pane', () => {
      const { controller, fns } = setup();
      controller.onPointerDown(pointer({ button: 0, shiftKey: true, clientX: 150, clientY: 50 }));
      expect(fns.setFocusFromMip).toHaveBeenCalledOnce();
      expect(controller.drag()).toBeNull();
    });

    it('places a measurement point instead of panning when a tool is active', () => {
      const { controller, fns } = setup({ activeTool: () => 'distance' });
      controller.onPointerDown(pointer({ button: 0, clientX: 50, clientY: 50 }));
      expect(fns.placeMeasurePoint).toHaveBeenCalledOnce();
      expect(controller.drag()).toBeNull();
    });

    it('does nothing before the viewer is ready', () => {
      const { controller } = setup({ isReady: () => false });
      controller.onPointerDown(pointer({ button: 0, clientX: 50, clientY: 50 }));
      expect(controller.drag()).toBeNull();
    });
  });

  describe('onPointerMove dispatch', () => {
    it('accumulates an MPR pan into the master pan and tracks the hover', () => {
      const { controller, fns } = setup();
      controller.onPointerDown(pointer({ button: 0, clientX: 50, clientY: 50 }));
      controller.onPointerMove(pointer({ clientX: 60, clientY: 55 }));
      expect(fns.setMasterPan).toHaveBeenCalledWith(Orientation.Axial, expect.any(Object));
      expect(fns.setCursor).toHaveBeenCalledWith({ x: 60, y: 55 });
      expect(fns.setHoveredKey).toHaveBeenLastCalledWith('mpr:0:0');
      expect(fns.setActiveCompareGroup).toHaveBeenLastCalledWith(0);
    });

    it('turns an orbit drag into camera azimuth/elevation', () => {
      const { controller, camera } = setup();
      controller.onPointerDown(pointer({ button: 0, clientX: 150, clientY: 50 }));
      controller.onPointerMove(pointer({ clientX: 160, clientY: 40 }));
      expect(camera().azimuth).toBeCloseTo(10 * 0.01);
      expect(camera().elevation).toBeCloseTo(10 * 0.01);
    });

    it('maps an Alt+right windowLevel drag onto the target window', () => {
      const { controller, fns } = setup();
      controller.onPointerDown(pointer({ button: 2, altKey: true, clientX: 50, clientY: 50 }));
      controller.onPointerMove(pointer({ clientX: 70, clientY: 30 }));
      expect(fns.setLayerWindow).toHaveBeenCalledOnce();
      expect(fns.markMipSettling).toHaveBeenCalled();
    });

    it('zooms an MPR pane on a right-drag, anchored on the press point', () => {
      const { controller, fns } = setup();
      controller.onPointerDown(pointer({ button: 2, clientX: 50, clientY: 50 }));
      controller.onPointerMove(pointer({ clientX: 50, clientY: 30 })); // drag up: zoom in
      expect(fns.setMasterZoom).toHaveBeenCalledWith(Orientation.Axial, expect.any(Number));
      const [, zoom] = fns.setMasterZoom!.mock.calls.at(-1)!;
      expect(zoom).toBeGreaterThan(1); // dragging up magnifies
      expect(fns.setMasterPan).toHaveBeenCalled();
      expect(fns.setMasterSlice).not.toHaveBeenCalled();
    });

    it('zooms the 3D camera on a right-drag over the 3D pane', () => {
      const { controller, camera } = setup();
      controller.onPointerDown(pointer({ button: 2, clientX: 150, clientY: 50 }));
      controller.onPointerMove(pointer({ clientX: 150, clientY: 30 })); // drag up: zoom in
      expect(camera().zoom).toBeGreaterThan(1);
    });

    it('clears the hover when the pointer is off every pane', () => {
      const { controller, fns } = setup();
      controller.onPointerMove(pointer({ clientX: 300, clientY: 300 }));
      expect(fns.setHoveredKey).toHaveBeenLastCalledWith(null);
    });
  });

  describe('onPointerUp', () => {
    it('releases the capture and clears the drag', () => {
      const { controller, releasePointerCapture } = setup();
      controller.onPointerDown(pointer({ button: 0, clientX: 50, clientY: 50 }));
      controller.onPointerUp(pointer({ clientX: 50, clientY: 50 }));
      expect(controller.drag()).toBeNull();
      expect(releasePointerCapture).toHaveBeenCalledWith(1);
    });
  });

  describe('onWheel', () => {
    it('scrolls the master slice on a plain wheel over an MPR pane', () => {
      const { controller, fns } = setup();
      controller.onWheel(
        pointer({ clientX: 50, clientY: 50, deltaY: 120 }) as unknown as WheelEvent,
      );
      expect(fns.stopCine).toHaveBeenCalledOnce();
      expect(fns.setMasterSlice).toHaveBeenCalledWith(Orientation.Axial, 6);
    });

    it('scrolls (does not zoom) on a Ctrl+wheel over an MPR pane', () => {
      const { controller, fns } = setup();
      controller.onWheel(
        pointer({ clientX: 50, clientY: 50, deltaY: 120, ctrlKey: true }) as unknown as WheelEvent,
      );
      expect(fns.setMasterSlice).toHaveBeenCalledWith(Orientation.Axial, 6);
      expect(fns.setMasterZoom).not.toHaveBeenCalled();
    });

    it('zooms the 3D camera on a wheel over the 3D pane', () => {
      const { controller, camera } = setup();
      controller.onWheel(
        pointer({ clientX: 150, clientY: 50, deltaY: -120 }) as unknown as WheelEvent,
      );
      expect(camera().zoom).toBeCloseTo(1.1);
    });

    it('routes scroll to the independent group when unlinked', () => {
      const { controller, fns } = setup({
        groupIsIndependent: () => true,
        groupSliceIndex: () => 1,
      });
      controller.onWheel(
        pointer({ clientX: 50, clientY: 50, deltaY: 120 }) as unknown as WheelEvent,
      );
      expect(fns.setGroupSlice).toHaveBeenCalledWith(0, Orientation.Axial, 2);
      expect(fns.setMasterSlice).not.toHaveBeenCalled();
    });
  });

  describe('right-drag zoom routing', () => {
    it('routes a right-drag zoom to the independent group when unlinked', () => {
      const { controller, fns } = setup({ groupIsIndependent: () => true });
      controller.onPointerDown(pointer({ button: 2, clientX: 50, clientY: 50 }));
      controller.onPointerMove(pointer({ clientX: 50, clientY: 30 }));
      expect(fns.setGroupZoomPan).toHaveBeenCalledWith(
        0,
        Orientation.Axial,
        expect.any(Number),
        expect.any(Object),
      );
      expect(fns.setMasterZoom).not.toHaveBeenCalled();
    });
  });
});
