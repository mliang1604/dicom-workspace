import { Orientation, type Volume } from '../dicom/types';
import type { PaneRect, Vec2 } from './layout';
import { probeVoxel } from './probe';
import type { ObliqueRotation } from './reslice';

/**
 * Pure brush-stamp geometry for the structures editor (#268): given a centre
 * voxel and a radius in **millimetres**, enumerate the label voxels a single
 * brush stamp covers, and the centres a drag-stroke visits so fast moves don't
 * leave gaps. No GPU or DOM — the {@link import('../app/viewer/brush-controller').BrushController}
 * is just the wiring that feeds these the probed cursor voxel and writes the
 * result into the label volume.
 *
 * The stamp works in voxel-index space but measures distance in patient
 * millimetres via the volume's per-axis {@link Volume.spacing}, so the brush is
 * physically round regardless of anisotropic voxels — a 5 mm brush paints the
 * same physical ball whether the through-plane spacing is 1 mm or 5 mm, and so
 * stays consistent across axial / coronal / sagittal (and oblique) panes.
 */

/** An integer voxel index `(x, y, z)` into the label/image grid. */
export type VoxelIndex = readonly [number, number, number];

/** Brush footprint: a 3D ball, or a 2D disk confined to the painted slice. */
export type BrushShape = 'sphere' | 'disk';

/** A brush stamp: its footprint and physical radius. */
export interface BrushStamp {
  readonly shape: BrushShape;
  /** Radius in patient millimetres (≥ 0). A stamp always covers its centre voxel. */
  readonly radiusMm: number;
  /**
   * For the `'disk'` shape, the volume axis (0 = x, 1 = y, 2 = z) the disk is
   * flattened along — the through-plane axis of the pane being painted, so the
   * disk lies in the visible slice and paints nothing through-plane. Ignored for
   * `'sphere'`. Defaults to the z axis.
   */
  readonly axis?: 0 | 1 | 2;
}

/**
 * The volume axis a pane's orthogonal reslice steps through, so a `'disk'` brush
 * on that pane stays confined to the slice it's drawn on. Exhaustive over the
 * orientations, so adding one fails to compile until handled.
 */
export function throughPlaneAxis(orientation: Orientation): 0 | 1 | 2 {
  switch (orientation) {
    case Orientation.Axial:
      return 2; // axial slices step along z
    case Orientation.Coronal:
      return 1; // coronal slices step along y
    case Orientation.Sagittal:
      return 0; // sagittal slices step along x
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

/**
 * Enumerate the flat label indices a single {@link BrushStamp} covers when
 * centred on `center`, clipped to `dims`. A voxel is included when its centre
 * lies within `radiusMm` of the stamp centre measured in patient millimetres
 * (each axis offset scaled by `spacing`), so the footprint is a physical ball
 * (`'sphere'`) — or, for `'disk'`, that ball intersected with the single slice
 * holding the centre along the stamp's {@link BrushStamp.axis}. The centre voxel
 * is always covered, so even a sub-voxel radius paints one voxel.
 */
export function stampVoxels(
  dims: VoxelIndex,
  spacing: VoxelIndex,
  center: VoxelIndex,
  stamp: BrushStamp,
): number[] {
  const [dimX, dimY, dimZ] = dims;
  const [sx, sy, sz] = spacing;
  const [cx, cy, cz] = [Math.round(center[0]), Math.round(center[1]), Math.round(center[2])];
  const r = Math.max(0, stamp.radiusMm);
  const r2 = r * r;

  // Voxel half-extents the radius reaches along each axis; a flat disk collapses
  // its axis to the centre slice only.
  const disk = stamp.shape === 'disk';
  const axis = stamp.axis ?? 2;
  const extentX = disk && axis === 0 ? 0 : voxelExtent(r, sx);
  const extentY = disk && axis === 1 ? 0 : voxelExtent(r, sy);
  const extentZ = disk && axis === 2 ? 0 : voxelExtent(r, sz);

  const out: number[] = [];
  for (let dz = -extentZ; dz <= extentZ; dz++) {
    const z = cz + dz;
    if (z < 0 || z >= dimZ) continue;
    const mmZ = dz * sz;
    for (let dy = -extentY; dy <= extentY; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= dimY) continue;
      const mmY = dy * sy;
      for (let dx = -extentX; dx <= extentX; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= dimX) continue;
        const mmX = dx * sx;
        if (mmX * mmX + mmY * mmY + mmZ * mmZ <= r2) out.push((z * dimY + y) * dimX + x);
      }
    }
  }
  return out;
}

/** Voxel half-extent a radius reaches along an axis of the given spacing. */
function voxelExtent(radiusMm: number, spacingMm: number): number {
  return spacingMm > 0 ? Math.floor(radiusMm / spacingMm) : 0;
}

/**
 * The stamp centres a stroke from `from` to `to` visits: the integer voxels along
 * the segment, stepped so consecutive centres differ by at most one voxel on each
 * axis. Stamping at each centre therefore paints a gap-free tube even when the
 * pointer jumps several voxels between samples (fast drags). A zero-length stroke
 * (a click) yields the single centre.
 */
export function strokeCenters(from: VoxelIndex, to: VoxelIndex): VoxelIndex[] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) {
    return [[Math.round(from[0]), Math.round(from[1]), Math.round(from[2])]];
  }
  const centers: VoxelIndex[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    centers.push([
      Math.round(from[0] + dx * t),
      Math.round(from[1] + dy * t),
      Math.round(from[2] + dz * t),
    ]);
  }
  return centers;
}

/**
 * The de-duplicated flat label indices a brush stroke from `from` to `to` covers:
 * the union of {@link stampVoxels} over every {@link strokeCenters} centre. Pass
 * the same voxel for both endpoints to stamp a single click.
 */
export function strokeVoxels(
  dims: VoxelIndex,
  spacing: VoxelIndex,
  from: VoxelIndex,
  to: VoxelIndex,
  stamp: BrushStamp,
): number[] {
  const seen = new Set<number>();
  for (const center of strokeCenters(from, to)) {
    for (const index of stampVoxels(dims, spacing, center, stamp)) seen.add(index);
  }
  return [...seen];
}

/**
 * The voxel under the cursor, reusing the probe's exact inverse so the brush
 * agrees with the displayed slice voxel-for-voxel (it does not fork the
 * pan/letterbox/zoom/oblique math from `probe.ts`). Returns `null` when the
 * cursor is off the plane or the volume — the same conditions the probe rejects.
 */
export function cursorVoxel(
  volume: Volume,
  orientation: Orientation,
  sliceIndex: number,
  zoom: number,
  rect: PaneRect,
  cursorX: number,
  cursorY: number,
  flipX = false,
  pan: Vec2 = { x: 0, y: 0 },
  rotation?: ObliqueRotation,
): VoxelIndex | null {
  return (
    probeVoxel(volume, orientation, sliceIndex, zoom, rect, cursorX, cursorY, flipX, pan, rotation)
      ?.voxel ?? null
  );
}
