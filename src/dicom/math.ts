/**
 * Scalar math helpers shared across parsing, geometry, and rendering. Kept in the
 * `dicom` layer (the lowest one) so both `src/render` and `src/app` can import a
 * single definition instead of each module redefining its own clamp.
 */

/** Clamp `value` to the closed range `[lo, hi]`. */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Clamp `value` to the unit range `[0, 1]`. */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Clamp a voxel `index` to a valid `[0, dim − 1]` slot for a `dim`-long axis. */
export function clampIndex(index: number, dim: number): number {
  return Math.min(dim - 1, Math.max(0, index));
}
