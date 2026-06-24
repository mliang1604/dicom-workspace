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

/** A change/input event whose target is a real DOM control with the given value. */
function controlEvent(tag: 'select' | 'input', value: string): Event {
  const el = document.createElement(tag);
  if (el instanceof HTMLSelectElement) {
    // A <select> only takes a value that matches one of its options.
    const option = document.createElement('option');
    option.value = value;
    el.append(option);
  }
  el.value = value;
  return { target: el } as unknown as Event;
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

  it('targets the active authored set: new structures land there only', () => {
    const { brush, store } = setup();
    brush.newStructure(); // auto-creates set 1 and a structure in it
    const set1 = store.sets()[0].id;
    expect(brush.activeSetId()).toBe(set1);
    expect(store.activeRois()).toHaveLength(1);

    brush.newSet(); // a fresh set becomes the brush target, no active ROI yet
    const set2 = store.sets()[1].id;
    expect(brush.activeSetId()).toBe(set2);
    expect(brush.activeRoiId()).toBeNull();

    brush.newStructure(); // the new structure lands in set 2, not set 1
    expect(store.sets()[0].rois).toHaveLength(1);
    expect(store.sets()[1].rois).toHaveLength(1);
  });

  it('re-scopes the active ROI when switching the active set', () => {
    const { brush, store } = setup();
    const a = store.createRoi('A'); // set 1
    store.createSet();
    store.createRoi('B'); // set 2
    const set1 = store.sets()[0].id;

    brush.onSetSelect(controlEvent('select', String(set1)));
    expect(brush.activeSetId()).toBe(set1);
    expect(brush.activeRoiId()).toBe(a.id); // first ROI of the now-active set
  });

  it('renames the active set from the field', () => {
    const { brush, store } = setup();
    brush.newSet();
    brush.onSetRename(controlEvent('input', 'Liver'));
    expect(store.activeSet()?.label).toBe('Liver');
    expect(brush.activeSetLabel()).toBe('Liver');
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
