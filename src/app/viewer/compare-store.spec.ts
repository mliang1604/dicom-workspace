import { Orientation } from '../../dicom/types';
import type { Vec2 } from '../../render/layout';
import { CompareStore, COMPARE_GROUPS, defaultGroupNav } from './compare-store';

const NO_PAN: Vec2 = { x: 0, y: 0 };
const ZOOMS = [1, 1, 1] as const;
const PANS = [NO_PAN, NO_PAN, NO_PAN] as const;

/** A sentinel the linked-mapping callback returns, to spot when that branch runs. */
const LINKED = 999;
const linked = (): number => LINKED;

describe('CompareStore.resolveSlice', () => {
  it('returns the master index outside the Compare layout', () => {
    const store = new CompareStore();
    expect(store.resolveSlice(1, Orientation.Axial, false, 7, linked)).toBe(7);
  });

  it('returns the master index for the base group (0), even in Compare', () => {
    const store = new CompareStore();
    expect(store.resolveSlice(0, Orientation.Axial, true, 7, linked)).toBe(7);
  });

  it('maps through the linked callback for a non-base group while linked', () => {
    const store = new CompareStore(); // linked is the default
    expect(store.resolveSlice(1, Orientation.Axial, true, 7, linked)).toBe(LINKED);
  });

  it('reads the group’s own index for a non-base group while unlinked', () => {
    const store = new CompareStore();
    store.updateGroupNav(1, { sliceIndices: [3, 4, 5] });
    store.linked.set(false);
    expect(store.resolveSlice(1, Orientation.Axial, true, 7, linked)).toBe(3);
    expect(store.resolveSlice(1, Orientation.Coronal, true, 7, linked)).toBe(4);
    // The linked callback must NOT run on the unlinked path.
    expect(store.resolveSlice(1, Orientation.Axial, true, 7, linked)).not.toBe(LINKED);
  });

  it('falls back to master when the unlinked group has no entry', () => {
    const store = new CompareStore();
    store.linked.set(false);
    // Group index beyond the nav array → no entry → master.
    expect(store.resolveSlice(5, Orientation.Axial, true, 7, linked)).toBe(7);
  });
});

describe('CompareStore.isIndependent', () => {
  it('is independent only for a non-base group in unlinked Compare', () => {
    const store = new CompareStore();
    store.linked.set(false);
    expect(store.isIndependent(1, true)).toBe(true);
    expect(store.isIndependent(0, true)).toBe(false); // base group follows master
    expect(store.isIndependent(1, false)).toBe(false); // not Compare
    store.linked.set(true);
    expect(store.isIndependent(1, true)).toBe(false); // linked follows master
  });
});

describe('CompareStore.resolveZoom / resolvePan', () => {
  it('shares the master zoom/pan while linked or for the base group', () => {
    const store = new CompareStore();
    expect(store.resolveZoom(1, Orientation.Axial, true, 2)).toBe(2);
    expect(store.resolvePan(1, Orientation.Axial, true, { x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
  });

  it('uses the group’s own zoom/pan when unlinked', () => {
    const store = new CompareStore();
    store.updateGroupNav(1, {
      zooms: [3, 3, 3],
      pans: [{ x: 8, y: 9 }, NO_PAN, NO_PAN],
    });
    store.linked.set(false);
    expect(store.resolveZoom(1, Orientation.Axial, true, 2)).toBe(3);
    expect(store.resolvePan(1, Orientation.Axial, true, { x: 5, y: 6 })).toEqual({ x: 8, y: 9 });
    // Orientations the group set to zero stay zero (they're populated, not absent).
    expect(store.resolvePan(1, Orientation.Coronal, true, { x: 5, y: 6 })).toEqual(NO_PAN);
  });

  it('falls back to the master zoom/pan when the unlinked group has no entry', () => {
    const store = new CompareStore();
    store.linked.set(false);
    // A group index past the nav array has no entry → master value.
    expect(store.resolveZoom(5, Orientation.Axial, true, 2)).toBe(2);
    expect(store.resolvePan(5, Orientation.Axial, true, { x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
  });
});

describe('CompareStore.snapshot', () => {
  it('captures each group’s resolved slice with the shared zooms/pans', () => {
    const store = new CompareStore();
    // Resolver tags each entry so we can verify per-group, per-orientation capture.
    const navs = store.snapshot(ZOOMS, PANS, (group, orientation) => group * 10 + orientation);
    expect(navs).toHaveLength(COMPARE_GROUPS);
    expect(navs[0].sliceIndices).toEqual([0, 1, 2]); // group 0: 0*10 + ori
    expect(navs[1].sliceIndices).toEqual([10, 11, 12]); // group 1: 1*10 + ori
    expect(navs[1].zooms).toBe(ZOOMS);
    expect(navs[1].pans).toBe(PANS);
  });
});

describe('CompareStore.toggleLinked', () => {
  it('snapshots into the group nav and unlinks on the first toggle', () => {
    const store = new CompareStore();
    const snap = defaultGroupNav();
    snap[1] = { sliceIndices: [2, 2, 2], zooms: [4, 4, 4], pans: PANS };
    store.toggleLinked(() => snap);
    expect(store.linked()).toBe(false);
    expect(store.groupNav()).toBe(snap);
  });

  it('relinks without re-snapshotting on the second toggle', () => {
    const store = new CompareStore();
    let calls = 0;
    const snapshot = (): ReturnType<typeof defaultGroupNav> => {
      calls++;
      return defaultGroupNav();
    };
    store.toggleLinked(snapshot); // unlink (snapshots)
    store.toggleLinked(snapshot); // relink (must not snapshot)
    expect(store.linked()).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('CompareStore.reset', () => {
  it('returns to the linked default with fresh per-group nav', () => {
    const store = new CompareStore();
    store.linked.set(false);
    store.updateGroupNav(1, { zooms: [9, 9, 9] });
    store.reset();
    expect(store.linked()).toBe(true);
    expect(store.groupNav()).toEqual(defaultGroupNav());
  });
});
