import type { Vec3 } from './types';

/**
 * Minimal 3-vector helpers for patient-space geometry. Inputs are accepted as
 * `readonly number[]` so raw DICOM tag arrays (e.g. a 3-element slice of
 * ImageOrientationPatient) can be passed without copying; results are typed as
 * the fixed-length {@link Vec3}.
 */

export function add(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: readonly number[], s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: readonly number[]): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: readonly number[]): Vec3 {
  const l = length(a);
  return l > 0 ? scale(a, 1 / l) : [a[0], a[1], a[2]];
}
