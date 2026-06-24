/**
 * Rasterize an imported RTSTRUCT ROI's planar contours into a label volume — the
 * import edge of structures editing (#271) and the inverse of the
 * marching-squares export ({@link import('./structure-export').buildStructureSet}).
 *
 * An imported {@link Roi} stores its geometry as stacks of `CLOSED_PLANAR` loops
 * in patient coordinates; the brush edits voxel occupancy. To let a user edit an
 * imported structure, its loops are scan-filled into the {@link LabelVolume} so a
 * point inside a loop becomes a voxel tagged with the ROI id. Each loop is mapped
 * patient → voxel through the same {@link patientToVoxel} affine the brush, probe
 * and reslice share, so anisotropic spacing and oblique geometry need no special
 * handling, and the fill matches the boundary the export traces back out (the
 * raster ⇄ contour round-trip is stable). The maths is pure and integer-friendly,
 * so it unit-tests without a GPU.
 */

import type { LabelVolume } from './label-volume';
import type { Contour, Roi } from './types';
import { patientToVoxel } from './volume';

/** A planar loop in continuous voxel `(x, y)` coordinates, on a single slice. */
export type VoxelLoop = readonly (readonly [number, number])[];

/** Outcome of rasterizing one ROI's contours into a label grid. */
export interface RasterizeResult {
  /** Number of voxels written with the ROI id (the filled occupancy). */
  readonly filled: number;
  /**
   * Contours skipped because their geometric type bounds no fillable area
   * (`OPEN_PLANAR` polylines, `POINT`s) — surfaced so the UI can note what a
   * promotion dropped, matching the loft/export filters.
   */
  readonly skipped: number;
}

/**
 * Whether a contour encloses an area we can scan-fill. Mirrors the loft path
 * (`roi-controller.ts`) and the export: a polyline or single point bounds nothing,
 * everything else (`CLOSED_PLANAR`, and unrecognised closed types like
 * `CLOSED_PLANAR_XOR`) is treated as a closed loop.
 */
function isFillable(contour: Contour): boolean {
  return contour.geometricType !== 'OPEN_PLANAR' && contour.geometricType !== 'POINT';
}

/**
 * Scan-fill a set of coplanar loops (continuous voxel `(x, y)`) into a
 * `width`×`height` pixel grid by the even-odd rule, calling `mark(x, y)` once for
 * each filled pixel (its centre sits at integer voxel index `(x, y)`).
 *
 * Every loop on the slice is folded into one even-odd pass, so a loop nested
 * inside another carves a hole regardless of its winding, and disjoint loops fill
 * as separate components. A pixel centre `(px, py)` is filled when it lies inside
 * an odd number of loops — found by intersecting each scanline `y = py` with every
 * edge, sorting the crossings, and filling the pixels between consecutive pairs.
 * The half-open crossing test (`(ya <= py) !== (yb <= py)`) counts a vertex that
 * lands exactly on the scanline for one of its two edges only, so shared vertices
 * aren't double-counted. This is the discrete inverse of the marching-squares
 * boundary the export traces ({@link import('./marching-squares').traceMaskLoops}),
 * so an axis-aligned region survives the raster ⇄ contour round-trip exactly.
 */
export function fillLoops(
  loops: readonly VoxelLoop[],
  width: number,
  height: number,
  mark: (x: number, y: number) => void,
): void {
  const xs: number[] = [];
  for (let py = 0; py < height; py++) {
    xs.length = 0;
    for (const loop of loops) {
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % n];
        const ya = a[1];
        const yb = b[1];
        if (ya <= py !== yb <= py) {
          xs.push(a[0] + ((py - ya) / (yb - ya)) * (b[0] - a[0]));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const lo = Math.max(0, Math.ceil(xs[i]));
      const hi = Math.min(width - 1, Math.floor(xs[i + 1]));
      for (let px = lo; px <= hi; px++) mark(px, py);
    }
  }
}

/**
 * Rasterize an imported {@link Roi}'s planar contours into `label`, writing
 * `roiId` into the occupancy of every voxel its loops enclose, and return how many
 * voxels were filled (and how many non-fillable contours were skipped).
 *
 * Each fillable contour's points are mapped patient → continuous voxel via
 * {@link patientToVoxel}, the loop assigned to the nearest slice (rounded `k`),
 * and all loops sharing a slice even-odd scan-filled together so nested holes are
 * respected ({@link fillLoops}). Single-occupancy: the written id overwrites
 * whatever ROI (or background) was under it, exactly as the brush does. Loops
 * whose patient points cannot be mapped (singular geometry) or fall outside the
 * grid are skipped silently; `OPEN_PLANAR`/`POINT` contours are counted in
 * {@link RasterizeResult.skipped}.
 *
 * Mutates `label.data` in place — the store owning the label volume bumps its
 * version counter so the mask display re-uploads (see `EditableStructuresStore`).
 */
export function rasterizeRoiContours(label: LabelVolume, roi: Roi, roiId: number): RasterizeResult {
  const [dimX, dimY, dimZ] = label.dims;
  const sliceVoxels = dimX * dimY;

  // Bucket each fillable contour's (x, y) loop under the slice it lies on, so the
  // loops on one slice (outer boundaries and their holes) are filled as a unit.
  const bySlice = new Map<number, VoxelLoop[]>();
  let skipped = 0;
  for (const contour of roi.contours) {
    if (!isFillable(contour)) {
      skipped++;
      continue;
    }
    if (contour.points.length < 3) continue; // bounds no area
    const loop: [number, number][] = [];
    let zSum = 0;
    let mappable = true;
    for (const point of contour.points) {
      const voxel = patientToVoxel(label.geometry, point);
      if (!voxel) {
        mappable = false;
        break;
      }
      loop.push([voxel[0], voxel[1]]);
      zSum += voxel[2];
    }
    if (!mappable) continue;
    const z = Math.round(zSum / contour.points.length);
    if (z < 0 || z >= dimZ) continue;
    const list = bySlice.get(z);
    if (list) list.push(loop);
    else bySlice.set(z, [loop]);
  }

  let filled = 0;
  const { data } = label;
  for (const [z, loops] of bySlice) {
    const base = z * sliceVoxels;
    fillLoops(loops, dimX, dimY, (x, y) => {
      data[base + y * dimX + x] = roiId;
      filled++;
    });
  }
  return { filled, skipped };
}
