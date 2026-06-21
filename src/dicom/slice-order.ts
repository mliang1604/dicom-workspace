import type { Slice, Vec3 } from './types';
import { cross, dot, normalize } from './vec3';

/**
 * The through-plane axis of a slice stack: the unit normal to the image plane,
 * derived as the cross product of the row and column direction cosines from the
 * first slice's ImageOrientationPatient. Returns `null` when the stack lacks the
 * spatial metadata to define one — the first slice carries no orientation, or
 * some slice carries no position — which is the same guard {@link buildVolume}
 * uses to decide whether it can place slices in patient space at all.
 *
 * The normal is normalized so the projection it induces is a true millimetre
 * distance along the axis (used by the volume's through-plane resampling);
 * normalization does not change the *order* of projected positions, only their
 * scale.
 */
export function throughPlaneNormal(slices: readonly Slice[]): Vec3 | null {
  const first = slices[0];
  if (!first?.orientation || !slices.every((s) => s.position)) return null;
  return normalize(cross(first.orientation.slice(0, 3), first.orientation.slice(3, 6)));
}

/**
 * Order a slice stack along its through-plane axis, returning a sorted copy
 * (the input is left untouched).
 *
 * When spatial metadata is present, slices are sorted by their
 * ImagePositionPatient projected onto the slice normal (see
 * {@link throughPlaneNormal}); equal projections — co-located slices — are
 * tie-broken by InstanceNumber so the order is deterministic. Without spatial
 * metadata the slices fall back to InstanceNumber order.
 *
 * This is the single source of truth for slice ordering: {@link buildVolume}
 * stacks the volume in this order and {@link middleSlice} picks a thumbnail from
 * it, so a series' central plane and its preview can never diverge.
 */
export function orderSlicesThroughPlane(slices: readonly Slice[]): Slice[] {
  const normal = throughPlaneNormal(slices);
  if (normal) {
    return [...slices].sort((a, b) => {
      const delta = dot(a.position!, normal) - dot(b.position!, normal);
      return delta !== 0 ? delta : a.instanceNumber - b.instanceNumber;
    });
  }
  return [...slices].sort((a, b) => a.instanceNumber - b.instanceNumber);
}
