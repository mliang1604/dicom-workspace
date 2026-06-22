import { Orientation, type Volume } from '../../dicom/types';
import type { PlanePoint } from '../../render/pane-coords';
import { NO_OBLIQUE } from '../../render/reslice';
import { MeasurementStore } from './measurement-store';

const OBLIQUES = [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE] as const;

function makeVolume(): Volume {
  return {
    dims: [4, 4, 4],
    spacing: [1, 1, 1],
    data: new Float32Array(64),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry: undefined,
  };
}

const p = (u: number, v: number): PlanePoint => ({ u, v });

describe('MeasurementStore.place', () => {
  it('accumulates points as a pending measurement until the tool is satisfied', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0.1, 0.1));
    // One of two points placed: still pending, nothing committed.
    expect(store.pending()?.points).toHaveLength(1);
    expect(store.measurements()).toHaveLength(0);

    store.place('distance', Orientation.Axial, 0, p(0.9, 0.9));
    // Second point completes the segment: committed, pending cleared.
    expect(store.pending()).toBeNull();
    expect(store.measurements()).toHaveLength(1);
    expect(store.measurements()[0]).toMatchObject({
      id: 0,
      tool: 'distance',
      orientation: Orientation.Axial,
      sliceIndex: 0,
    });
    expect(store.measurements()[0].points).toHaveLength(2);
  });

  it('needs three points for the angle tool', () => {
    const store = new MeasurementStore();
    store.place('angle', Orientation.Coronal, 2, p(0, 0));
    store.place('angle', Orientation.Coronal, 2, p(0.5, 0.5));
    expect(store.measurements()).toHaveLength(0); // still placing
    store.place('angle', Orientation.Coronal, 2, p(1, 0));
    expect(store.measurements()).toHaveLength(1);
    expect(store.measurements()[0].points).toHaveLength(3);
  });

  it('starts a fresh measurement when the slice changes mid-placement', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0.1, 0.1));
    // A click on a different slice abandons the half-placed point and restarts.
    store.place('distance', Orientation.Axial, 5, p(0.2, 0.2));
    expect(store.measurements()).toHaveLength(0);
    expect(store.pending()).toMatchObject({ sliceIndex: 5 });
    expect(store.pending()?.points).toHaveLength(1);
  });

  it('starts a fresh measurement when the orientation or tool changes mid-placement', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0.1, 0.1));
    store.place('distance', Orientation.Sagittal, 0, p(0.2, 0.2)); // different pane
    expect(store.pending()).toMatchObject({ orientation: Orientation.Sagittal });
    expect(store.pending()?.points).toHaveLength(1);

    store.place('angle', Orientation.Sagittal, 0, p(0.3, 0.3)); // different tool
    expect(store.pending()).toMatchObject({ tool: 'angle' });
    expect(store.pending()?.points).toHaveLength(1);
  });

  it('hands out monotonically increasing ids', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0, 0));
    store.place('distance', Orientation.Axial, 0, p(1, 1));
    store.place('distance', Orientation.Axial, 0, p(0, 0));
    store.place('distance', Orientation.Axial, 0, p(1, 1));
    expect(store.measurements().map((m) => m.id)).toEqual([0, 1]);
  });
});

describe('MeasurementStore drag editing', () => {
  function withCommittedDistance(): MeasurementStore {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0.1, 0.1));
    store.place('distance', Orientation.Axial, 0, p(0.9, 0.9));
    return store;
  }

  it('moves only the dragged point of the dragged measurement', () => {
    const store = withCommittedDistance();
    const id = store.measurements()[0].id;
    store.beginDrag(id, 1);
    expect(store.draggedMeasurement()?.id).toBe(id);

    store.applyDragPoint(p(0.5, 0.5));
    const points = store.measurements()[0].points;
    expect(points[0]).toEqual(p(0.1, 0.1)); // untouched
    expect(points[1]).toEqual(p(0.5, 0.5)); // followed the drag

    store.endDrag();
    expect(store.drag()).toBeNull();
    expect(store.draggedMeasurement()).toBeNull();
  });

  it('ignores a drag point when nothing is being dragged', () => {
    const store = withCommittedDistance();
    const before = store.measurements()[0].points;
    store.applyDragPoint(p(0.5, 0.5));
    expect(store.measurements()[0].points).toBe(before); // reference unchanged
  });
});

describe('MeasurementStore lifecycle', () => {
  it('tracks whether any measurement exists for the Clear button', () => {
    const store = new MeasurementStore();
    expect(store.hasMeasurements()).toBe(false);
    store.place('distance', Orientation.Axial, 0, p(0, 0)); // pending counts
    expect(store.hasMeasurements()).toBe(true);
    store.place('distance', Orientation.Axial, 0, p(1, 1)); // now committed
    expect(store.hasMeasurements()).toBe(true);
    store.clear();
    expect(store.hasMeasurements()).toBe(false);
  });

  it('cancelPending drops the half-placed measurement but keeps committed ones', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0, 0));
    store.place('distance', Orientation.Axial, 0, p(1, 1)); // committed
    store.place('distance', Orientation.Axial, 0, p(0.2, 0.2)); // a new pending point
    expect(store.pending()).not.toBeNull();
    store.cancelPending();
    expect(store.pending()).toBeNull();
    expect(store.measurements()).toHaveLength(1);
  });

  it('clear removes both committed and pending measurements', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0, 0));
    store.place('distance', Orientation.Axial, 0, p(1, 1));
    store.place('angle', Orientation.Axial, 0, p(0.5, 0.5)); // leaves a pending
    store.clear();
    expect(store.measurements()).toEqual([]);
    expect(store.pending()).toBeNull();
  });
});

describe('MeasurementStore.statsFor', () => {
  function withEllipse(store: MeasurementStore): number {
    store.place('ellipse', Orientation.Axial, 1, p(0.2, 0.2));
    store.place('ellipse', Orientation.Axial, 1, p(0.8, 0.8));
    return store.measurements()[0].id;
  }

  it('returns area + HU readout lines for ROI tools', () => {
    const store = new MeasurementStore();
    const id = withEllipse(store);
    const stats = store.statsFor(makeVolume(), OBLIQUES);
    const lines = stats.get(id);
    expect(lines).toBeDefined();
    expect(lines![0]).toMatch(/mm²$/);
    expect(lines!.some((l) => l.startsWith('mean'))).toBe(true);
  });

  it('skips non-ROI tools (distance/angle have no area readout)', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0, 0));
    store.place('distance', Orientation.Axial, 0, p(1, 1));
    const id = store.measurements()[0].id;
    expect(store.statsFor(makeVolume(), OBLIQUES).has(id)).toBe(false);
  });

  it('returns an empty map without a volume', () => {
    const store = new MeasurementStore();
    withEllipse(store);
    expect(store.statsFor(null, OBLIQUES).size).toBe(0);
  });

  it('skips a half-placed ROI with fewer than two points', () => {
    const store = new MeasurementStore();
    store.place('ellipse', Orientation.Axial, 1, p(0.2, 0.2)); // only one point (pending)
    // The pending point isn't a committed measurement, so nothing to sweep.
    expect(store.statsFor(makeVolume(), OBLIQUES).size).toBe(0);
  });
});
