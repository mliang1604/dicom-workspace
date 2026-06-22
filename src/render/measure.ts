import { clamp, clampIndex } from '../dicom/math';
import { Orientation, type Volume } from '../dicom/types';
import type { PlanePoint } from './pane-coords';
import {
  planeExtentMm,
  planePixelDims,
  planeToTex,
  sliceCountFor,
  texCoordAt,
  type ObliqueRotation,
} from './reslice';

/**
 * Pure measurement maths for the MPR overlays: physical length, angle, and
 * region-of-interest area plus voxel statistics.
 *
 * Measurement anchors are {@link PlanePoint}s — in-plane `(u, v)` fractions in
 * `[0, 1]` (see `pane-coords.ts`). A pane's plane spans a known physical extent
 * ({@link planeExtentMm}), so a fraction along each axis converts to millimetres
 * by scaling; the plane's in-plane axes are orthogonal patient directions, so an
 * in-plane Euclidean distance in mm is a true patient distance (axis-aligned and
 * oblique acquisitions alike). Keeping the geometry here lets it be unit-tested
 * without a GPU or DOM; {@link roiStats} additionally walks the slice's resampled
 * voxel grid through the shared reslice geometry.
 */

/** Physical extent (mm) a plane spans along its horizontal (u) and vertical (v) axes. */
export interface PlaneScale {
  readonly widthMm: number;
  readonly heightMm: number;
}

/** A region-of-interest shape, drawn from two opposite bounding-box corners. */
export type RoiShape = 'ellipse' | 'rectangle';

/** The bounding box of an ROI in plane `(u, v)` coordinates, with its centre and radii. */
export interface RoiBounds {
  readonly minU: number;
  readonly maxU: number;
  readonly minV: number;
  readonly maxV: number;
  readonly centerU: number;
  readonly centerV: number;
  readonly radiusU: number;
  readonly radiusV: number;
}

/** Summary statistics over the voxel values enclosed by an ROI. */
export interface HuStats {
  /** Arithmetic mean of the enclosed values, in the volume's modality units. */
  readonly mean: number;
  /** Population standard deviation (divides by the count, not count − 1). */
  readonly sd: number;
  readonly min: number;
  readonly max: number;
  /** Number of voxels enclosed and sampled. */
  readonly count: number;
}

/** An ROI's physical area and the statistics of the voxels it encloses. */
export interface RoiResult {
  /** Enclosed area in mm², from the shape's exact geometry. */
  readonly areaMm2: number;
  /** Voxel statistics, or null when the ROI enclosed no in-volume voxels. */
  readonly stats: HuStats | null;
}

/** Physical distance (mm) between two in-plane points across a plane's extent. */
export function measureDistanceMm(a: PlanePoint, b: PlanePoint, scale: PlaneScale): number {
  const dx = (a.u - b.u) * scale.widthMm;
  const dy = (a.v - b.v) * scale.heightMm;
  return Math.hypot(dx, dy);
}

/**
 * Angle (degrees, 0–180) at `vertex` between the rays to `a` and `b`, measured
 * in physical millimetres so it is correct under anisotropic spacing. Returns 0
 * when either ray has zero length (a degenerate, coincident point).
 */
export function measureAngleDeg(
  a: PlanePoint,
  vertex: PlanePoint,
  b: PlanePoint,
  scale: PlaneScale,
): number {
  const ax = (a.u - vertex.u) * scale.widthMm;
  const ay = (a.v - vertex.v) * scale.heightMm;
  const bx = (b.u - vertex.u) * scale.widthMm;
  const by = (b.v - vertex.v) * scale.heightMm;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return 0;
  const cos = clamp((ax * bx + ay * by) / (la * lb), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

/** The axis-aligned bounding box (centre + radii) of two ROI corner points. */
export function roiBounds(a: PlanePoint, b: PlanePoint): RoiBounds {
  const minU = Math.min(a.u, b.u);
  const maxU = Math.max(a.u, b.u);
  const minV = Math.min(a.v, b.v);
  const maxV = Math.max(a.v, b.v);
  return {
    minU,
    maxU,
    minV,
    maxV,
    centerU: (minU + maxU) / 2,
    centerV: (minV + maxV) / 2,
    radiusU: (maxU - minU) / 2,
    radiusV: (maxV - minV) / 2,
  };
}

/** Whether plane point `(u, v)` lies inside the ROI shape within `bounds`. */
export function roiContains(shape: RoiShape, bounds: RoiBounds, u: number, v: number): boolean {
  switch (shape) {
    case 'rectangle':
      return u >= bounds.minU && u <= bounds.maxU && v >= bounds.minV && v <= bounds.maxV;
    case 'ellipse': {
      if (bounds.radiusU <= 0 || bounds.radiusV <= 0) return false;
      const du = (u - bounds.centerU) / bounds.radiusU;
      const dv = (v - bounds.centerV) / bounds.radiusV;
      return du * du + dv * dv <= 1;
    }
    default: {
      const exhaustive: never = shape;
      return exhaustive;
    }
  }
}

/** Exact physical area (mm²) of an ROI shape, given the plane's mm extent. */
export function roiAreaMm2(shape: RoiShape, bounds: RoiBounds, scale: PlaneScale): number {
  const widthMm = (bounds.maxU - bounds.minU) * scale.widthMm;
  const heightMm = (bounds.maxV - bounds.minV) * scale.heightMm;
  switch (shape) {
    case 'rectangle':
      return widthMm * heightMm;
    case 'ellipse':
      // π·a·b for the half-axes a = widthMm/2, b = heightMm/2.
      return (Math.PI * widthMm * heightMm) / 4;
    default: {
      const exhaustive: never = shape;
      return exhaustive;
    }
  }
}

/**
 * Mean, population standard deviation, min and max of a value list, or null when
 * empty. Two-pass for a numerically stable variance. Exported for direct testing.
 */
export function huStats(values: ArrayLike<number>): HuStats | null {
  const count = values.length;
  if (count === 0) return null;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const value = values[i];
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const mean = sum / count;
  let sumSq = 0;
  for (let i = 0; i < count; i++) {
    const d = values[i] - mean;
    sumSq += d * d;
  }
  return { mean, sd: Math.sqrt(sumSq / count), min, max, count };
}

/**
 * Area and voxel statistics of an ROI on one slice. Walks the slice's resampled
 * voxel grid at its displayed resolution ({@link planePixelDims}), samples each
 * enclosed pixel through the same `planeToTex` affine the shader uses (nearest
 * voxel), and reduces the values with {@link huStats}. The area is the shape's
 * exact geometry, independent of the sampling grid. Iterates only the ROI's
 * bounding-box pixels, so the cost scales with the region, not the whole slice.
 */
export function roiStats(
  volume: Volume,
  orientation: Orientation,
  sliceIndex: number,
  shape: RoiShape,
  a: PlanePoint,
  b: PlanePoint,
  rotation?: ObliqueRotation,
): RoiResult {
  const [widthMm, heightMm] = planeExtentMm(volume, orientation);
  const bounds = roiBounds(a, b);
  const areaMm2 = roiAreaMm2(shape, bounds, { widthMm, heightMm });

  const [nu, nv] = planePixelDims(volume, orientation);
  const count = sliceCountFor(volume, orientation);
  const slicePos = count > 1 ? (sliceIndex + 0.5) / count : 0.5;
  const map = planeToTex(volume, orientation, rotation);
  const [dimX, dimY, dimZ] = volume.dims;

  // Restrict the scan to the ROI's bounding-box pixels of the slice grid.
  const i0 = Math.max(0, Math.floor(bounds.minU * nu));
  const i1 = Math.min(nu - 1, Math.ceil(bounds.maxU * nu));
  const j0 = Math.max(0, Math.floor(bounds.minV * nv));
  const j1 = Math.min(nv - 1, Math.ceil(bounds.maxV * nv));

  const values: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const v = (j + 0.5) / nv;
    for (let i = i0; i <= i1; i++) {
      const u = (i + 0.5) / nu;
      if (!roiContains(shape, bounds, u, v)) continue;
      const coord = texCoordAt(map, u, v, slicePos);
      if (coord.some((c) => c < 0 || c > 1)) continue; // outside the volume
      const vx = clampIndex(Math.floor(coord[0] * dimX), dimX);
      const vy = clampIndex(Math.floor(coord[1] * dimY), dimY);
      const vz = clampIndex(Math.floor(coord[2] * dimZ), dimZ);
      values.push(volume.data[(vz * dimY + vy) * dimX + vx]);
    }
  }
  return { areaMm2, stats: huStats(values) };
}

/** Format a sample value: integers verbatim, otherwise to one decimal place. */
export function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Readout lines for an ROI: its area, then the HU statistics when available. The
 * `unit` (e.g. `HU`) is appended to the mean; `null` omits it. Shared by the
 * measurement overlay and its memoised stats cache.
 */
export function roiLines(areaMm2: number, stats: HuStats | null, unit: string | null): string[] {
  const u = unit ? ` ${unit}` : '';
  const lines = [`${areaMm2.toFixed(0)} mm²`];
  if (stats) {
    lines.push(`mean ${formatValue(stats.mean)}${u}`);
    lines.push(`SD ${formatValue(stats.sd)}`);
    lines.push(`min ${formatValue(stats.min)} · max ${formatValue(stats.max)}`);
  }
  return lines;
}
