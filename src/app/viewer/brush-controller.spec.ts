import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Orientation, type Volume } from '../../dicom/types';
import { labelIndex } from '../../dicom/label-volume';
import type { PaneRect } from '../../render/layout';
import { BrushController, type BrushInit } from './brush-controller';
import { EditableStructuresStore } from './editable-structures-store';
import { type PanePlacement } from './pane-placement';
import {
  type PerOrientation,
  type PerOrientationOblique,
  type PerOrientationPan,
} from './viewer-overlays';
import { NO_OBLIQUE } from '../../render/reslice';

const SQUARE: PaneRect = { x: 0, y: 0, width: 100, height: 100 };

function makeVolume(): Volume {
  const [x, y, z] = [4, 4, 4];
  return {
    dims: [x, y, z],
    spacing: [1, 1, 1],
    data: new Float32Array(x * y * z),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
  };
}

/** A pointer event stand-in at canvas pixel (x, y); the canvas sits at the origin. */
function pointer(x: number, y: number): PointerEvent {
  return { clientX: x, clientY: y, pointerId: 1 } as unknown as PointerEvent;
}

const AXIAL_MID: Extract<PanePlacement, { kind: 'mpr' }> = {
  kind: 'mpr',
  orientation: Orientation.Axial,
  rect: SQUARE,
  group: 0,
};

function setup(): { brush: BrushController; store: EditableStructuresStore } {
  TestBed.configureTestingModule({ providers: [EditableStructuresStore, BrushController] });
  const store = TestBed.inject(EditableStructuresStore);
  store.resetForLoad(makeVolume());
  const brush = TestBed.inject(BrushController);
  const noObliques: PerOrientationOblique = [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE];
  const deps: BrushInit = {
    volume: () => store.labelVolume() && makeVolume(),
    isReady: () => true,
    canvasBounds: () => ({ left: 0, top: 0 }) as DOMRect,
    zooms: signal<PerOrientation>([1, 1, 1]),
    pans: signal<PerOrientationPan>([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]),
    obliques: signal(noObliques),
    sliceIndices: signal<PerOrientation>([2, 2, 2]),
    sagittalFlipped: () => false,
  };
  brush.init(deps);
  return { brush, store };
}

describe('BrushController', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is inactive until a mode is selected, and paint needs an active ROI', () => {
    const { brush, store } = setup();
    expect(brush.isActive()).toBe(false);

    brush.toggleMode('paint'); // auto-creates and selects a structure
    expect(brush.isActive()).toBe(true);
    expect(brush.activeRoiId()).toBe(store.rois()[0].id);
  });

  it('toggling the active mode off returns to the pan gesture', () => {
    const { brush } = setup();
    brush.toggleMode('erase');
    expect(brush.mode()).toBe('erase');
    brush.toggleMode('erase');
    expect(brush.mode()).toBe('off');
    expect(brush.isActive()).toBe(false);
  });

  it('paints the active ROI into the voxel the probe samples under the cursor', () => {
    const { brush, store } = setup();
    const roi = store.createRoi();
    brush.activeRoiId.set(roi.id);
    brush.mode.set('paint');
    brush.radiusMm.set(0); // a single-voxel stamp

    // Pane centre of axial slice 2 is voxel (2, 2, 2) — see probe.spec.
    brush.beginStroke(AXIAL_MID, pointer(50, 50));
    brush.endStroke();

    const label = store.labelVolume()!;
    expect(label.data[labelIndex(label.dims, 2, 2, 2)]).toBe(roi.id);
    expect(store.version()).toBeGreaterThan(0);
  });

  it('erases painted voxels back to background', () => {
    const { brush, store } = setup();
    const roi = store.createRoi();
    const label = store.labelVolume()!;
    const idx = labelIndex(label.dims, 2, 2, 2);
    store.paint(roi.id, [idx]);
    expect(label.data[idx]).toBe(roi.id);

    brush.mode.set('erase');
    brush.radiusMm.set(0);
    brush.beginStroke(AXIAL_MID, pointer(50, 50));
    brush.endStroke();

    expect(label.data[idx]).toBe(0);
  });

  it('fills the gap when a stroke drags across several voxels at once', () => {
    const { brush, store } = setup();
    const roi = store.createRoi();
    brush.activeRoiId.set(roi.id);
    brush.mode.set('paint');
    brush.radiusMm.set(0);

    // Drag from the far left to the far right of the centre row in one move.
    brush.beginStroke(AXIAL_MID, pointer(0, 50));
    brush.extendStroke(AXIAL_MID, pointer(99, 50));
    brush.endStroke();

    const label = store.labelVolume()!;
    // Every column along the painted row carries the ROI — no gaps.
    let painted = 0;
    for (let x = 0; x < label.dims[0]; x++) {
      if (label.data[labelIndex(label.dims, x, 2, 2)] === roi.id) painted++;
    }
    expect(painted).toBe(label.dims[0]);
  });
});
