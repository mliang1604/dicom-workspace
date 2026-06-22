import { Injectable, signal } from '@angular/core';
import { Orientation } from '../../dicom/types';
import type { Vec2 } from '../../render/layout';

/** A value per orientation, indexed by the orientation's numeric value. */
type PerOrientation = readonly [number, number, number];
/** A pan offset per orientation, indexed by the orientation's numeric value. */
type PerOrientationPan = readonly [Vec2, Vec2, Vec2];

/** How many side-by-side Compare columns the layout splits into. */
export const COMPARE_GROUPS = 2;

/**
 * Independent navigation state for one Compare group, used only when the groups
 * are unlinked. Each group then scrolls, pans, and zooms on its own; while linked
 * (the default) groups follow the shared master signals and this is ignored. Group
 * 0 always reads the master signals, so its entry here is unused.
 */
export interface GroupNav {
  readonly sliceIndices: PerOrientation;
  readonly zooms: PerOrientation;
  readonly pans: PerOrientationPan;
}

/** Fresh per-group nav (one slot per Compare group) at the view defaults. */
export function defaultGroupNav(): GroupNav[] {
  const noPan: Vec2 = { x: 0, y: 0 };
  return Array.from({ length: COMPARE_GROUPS }, () => ({
    sliceIndices: [0, 0, 0],
    zooms: [1, 1, 1],
    pans: [noPan, noPan, noPan],
  }));
}

/**
 * Owns the Compare-layout linking state: whether the columns navigate together
 * (`linked`) and, when unlinked, each group's independent slice/zoom/pan
 * ({@link groupNav}). Holds the regression-prone linked/unlinked resolution that
 * decides, per pane, whether it reads the shared master view or its own group's.
 *
 * The store is volume-agnostic: the viewer passes the master value and (for the
 * linked-mode cross-grid slice mapping, which needs the volumes) a `computeLinked`
 * callback, so the branch logic is unit-testable without a GPU. Provided at the
 * component so its lifetime tracks the viewer.
 */
@Injectable()
export class CompareStore {
  /** Whether the Compare columns navigate together (the default) or independently. */
  readonly linked = signal(true);

  /** Per-group independent nav, used only while unlinked. */
  readonly groupNav = signal<readonly GroupNav[]>(defaultGroupNav());

  /** Whether a Compare group navigates on its own (unlinked, and not the base group). */
  isIndependent(group: number, isCompare: boolean): boolean {
    return isCompare && !this.linked() && group > 0;
  }

  /**
   * The slice index a pane shows, resolving linked/unlinked Compare navigation: the
   * `master` index outside Compare and for group 0; the group's own index while
   * unlinked; and, while linked, whatever `computeLinked` maps the master plane onto
   * the group's grid (the only branch that needs the volumes). `computeLinked` is a
   * callback so that volume work is skipped unless the linked branch is taken.
   */
  resolveSlice(
    group: number,
    orientation: Orientation,
    isCompare: boolean,
    master: number,
    computeLinked: () => number,
  ): number {
    if (!isCompare || group === 0) return master;
    if (!this.linked()) return this.groupNav()[group]?.sliceIndices[orientation] ?? master;
    return computeLinked();
  }

  /** The zoom a pane uses: the shared `master` while linked, the group's own when unlinked. */
  resolveZoom(group: number, orientation: Orientation, isCompare: boolean, master: number): number {
    if (!this.isIndependent(group, isCompare)) return master;
    return this.groupNav()[group]?.zooms[orientation] ?? master;
  }

  /** The pan a pane uses: the shared `master` while linked, the group's own when unlinked. */
  resolvePan(group: number, orientation: Orientation, isCompare: boolean, master: Vec2): Vec2 {
    if (!this.isIndependent(group, isCompare)) return master;
    return this.groupNav()[group]?.pans[orientation] ?? master;
  }

  /**
   * Snapshot the current per-group view (while still linked) for unlinked editing:
   * each group keeps its resolved slice level (via `resolveSliceFor`) and the shared
   * `zooms`/`pans` so the panes hold still at the moment of unlinking.
   */
  snapshot(
    zooms: PerOrientation,
    pans: PerOrientationPan,
    resolveSliceFor: (group: number, orientation: Orientation) => number,
  ): GroupNav[] {
    return Array.from({ length: COMPARE_GROUPS }, (_, group) => ({
      sliceIndices: [
        resolveSliceFor(group, Orientation.Axial),
        resolveSliceFor(group, Orientation.Coronal),
        resolveSliceFor(group, Orientation.Sagittal),
      ] as PerOrientation,
      zooms,
      pans,
    }));
  }

  /** Replace one field of one group's independent nav (used by the unlinked handlers). */
  updateGroupNav(group: number, patch: Partial<GroupNav>): void {
    this.groupNav.update((navs) =>
      navs.map((nav, i) => (i === group ? { ...nav, ...patch } : nav)),
    );
  }

  /**
   * Link or unlink the Compare groups. Unlinking snapshots each group's current
   * (linked) slice/zoom/pan via `snapshot` so the panes hold still; relinking drops
   * back to the shared master signals.
   */
  toggleLinked(snapshot: () => GroupNav[]): void {
    if (this.linked()) {
      this.groupNav.set(snapshot());
      this.linked.set(false);
    } else {
      this.linked.set(true);
    }
  }

  /** Reset to the default linked state with fresh per-group nav (on a fresh load). */
  reset(): void {
    this.linked.set(true);
    this.groupNav.set(defaultGroupNav());
  }
}
