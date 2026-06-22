import { Injectable, computed, signal } from '@angular/core';
import { modalityUnit, Orientation, type Volume } from '../../dicom/types';
import type { PlanePoint } from '../../render/pane-coords';
import { roiLines, roiStats } from '../../render/measure';
import type { ObliqueRotation } from '../../render/reslice';

/** An interactive measurement tool (the default pan/orbit gesture is handled elsewhere). */
export type MeasureTool = 'distance' | 'angle' | 'ellipse' | 'rectangle';

/** How many points define each tool: a segment, a vertex pair of rays, or a box. */
export const TOOL_POINTS: Readonly<Record<MeasureTool, number>> = {
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
export interface Measurement {
  readonly id: number;
  readonly tool: MeasureTool;
  readonly orientation: Orientation;
  readonly sliceIndex: number;
  readonly points: readonly PlanePoint[];
}

/** A measurement being placed: the same shape, fewer than its full set of points. */
export interface PendingMeasurement {
  readonly tool: MeasureTool;
  readonly orientation: Orientation;
  readonly sliceIndex: number;
  readonly points: readonly PlanePoint[];
}

/** An in-progress drag of one measurement point (an endpoint or an ROI corner). */
export interface MeasureDrag {
  readonly id: number;
  readonly pointIndex: number;
}

/** An oblique tilt per orientation, indexed by the orientation's numeric value. */
type PerOrientationOblique = readonly [ObliqueRotation, ObliqueRotation, ObliqueRotation];

/** Immutably replace the element at `index` of a readonly array. */
function withIndex<T>(values: readonly T[], index: number, value: T): readonly T[] {
  const next = [...values];
  next[index] = value;
  return next;
}

/**
 * Owns the measurement / ROI-tool domain: the placed measurements, the one being
 * placed, and the point currently being dragged — plus the pure logic behind the
 * `onMeasure*` handlers (placing points, committing, editing, clearing) and the
 * memoised ROI HU-stats sweep.
 *
 * The store is DOM-free: the viewer turns pointer events into in-plane
 * {@link PlanePoint}s (and supplies the volume/oblique context for stats) and
 * delegates here. Provided at the component so its lifetime tracks the viewer.
 */
@Injectable()
export class MeasurementStore {
  private readonly _measurements = signal<readonly Measurement[]>([]);
  /** Completed measurements, each pinned to its orientation + slice. */
  readonly measurements = this._measurements.asReadonly();

  private readonly _pending = signal<PendingMeasurement | null>(null);
  /** The measurement currently being placed (awaiting its remaining points), or null. */
  readonly pending = this._pending.asReadonly();

  private readonly _drag = signal<MeasureDrag | null>(null);
  /** The measurement point being dragged (an endpoint or ROI corner), or null. */
  readonly drag = this._drag.asReadonly();

  /** Monotonic id source for new measurements. */
  private nextId = 0;

  /** Whether any measurement (placed or in-progress) exists, for the Clear button. */
  readonly hasMeasurements = computed(
    () => this._measurements().length > 0 || this._pending() !== null,
  );

  /** The measurement currently under a point drag, or null. */
  readonly draggedMeasurement = computed<Measurement | null>(() => {
    const drag = this._drag();
    return drag ? (this._measurements().find((m) => m.id === drag.id) ?? null) : null;
  });

  /**
   * Add the next point of the active measurement, placed on `(orientation,
   * sliceIndex)`. Points accumulate while the pending measurement matches the same
   * tool/pane/slice; once the tool's full set is placed the measurement is
   * committed and the pending state cleared. Anything else (a different tool, pane,
   * or slice) starts a fresh measurement at this point.
   */
  place(tool: MeasureTool, orientation: Orientation, sliceIndex: number, point: PlanePoint): void {
    const pending = this._pending();
    const continuing =
      pending !== null &&
      pending.tool === tool &&
      pending.orientation === orientation &&
      pending.sliceIndex === sliceIndex;
    const points = continuing ? [...pending.points, point] : [point];
    if (points.length >= TOOL_POINTS[tool]) {
      this._measurements.update((list) => [
        ...list,
        { id: this.nextId++, tool, orientation, sliceIndex, points },
      ]);
      this._pending.set(null);
    } else {
      this._pending.set({ tool, orientation, sliceIndex, points });
    }
  }

  /** Begin dragging a placed measurement's endpoint or ROI corner. */
  beginDrag(id: number, pointIndex: number): void {
    this._drag.set({ id, pointIndex });
  }

  /** Move the dragged measurement's point to a new in-plane location. No-op if idle. */
  applyDragPoint(point: PlanePoint): void {
    const drag = this._drag();
    if (!drag) return;
    this._measurements.update((list) =>
      list.map((m) =>
        m.id === drag.id ? { ...m, points: withIndex(m.points, drag.pointIndex, point) } : m,
      ),
    );
  }

  /** End a measurement-point drag. */
  endDrag(): void {
    this._drag.set(null);
  }

  /** Abandon any half-placed measurement (e.g. on tool change or Escape). */
  cancelPending(): void {
    this._pending.set(null);
  }

  /** Remove every placed measurement and any in-progress one. */
  clear(): void {
    this._measurements.set([]);
    this._pending.set(null);
  }

  /**
   * ROI readout lines (area + HU stats) keyed by measurement id. The sweep depends
   * only on the volume, each ROI's points/slice, and the plane obliques — never the
   * pan or zoom — so a caller can memoise this in a `computed` to keep a pan/zoom
   * drag from re-sweeping every region each frame. Non-ROI tools are skipped.
   */
  statsFor(
    volume: Volume | null,
    obliques: PerOrientationOblique,
  ): ReadonlyMap<number, readonly string[]> {
    const stats = new Map<number, readonly string[]>();
    if (!volume) return stats;
    const unit = modalityUnit(volume.modality);
    for (const m of this._measurements()) {
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
  }
}
