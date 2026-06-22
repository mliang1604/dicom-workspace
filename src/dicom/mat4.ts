import type { Mat4, Vec3 } from './types';

/**
 * Pure 4×4 affine matrix math, row-major (the {@link Mat4} convention and the
 * DICOM 3006,00C6 layout). Used to compose and apply the patient→patient
 * transforms a Spatial Registration provides; kept separate from {@link vec3} so
 * the registration/alignment code shares one matrix vocabulary.
 *
 * Matrices are treated as affine: the linear part is the top-left 3×3 (rows 0–2,
 * columns 0–2) and the translation the fourth column of rows 0–2. The bottom row
 * is assumed `[0, 0, 0, 1]`.
 */

/**
 * Transpose a row-major {@link Mat4} into the column-major `Float32Array` a WGSL
 * `mat4x4<f32>` uniform expects (matching `texAffineMatrix` in `render/reslice.ts`).
 */
export function toColumnMajor(m: Mat4): Float32Array {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) out[c * 4 + r] = m[r * 4 + c];
  }
  return out;
}

/** Apply a transform to a point (with translation): `(M · [x, y, z, 1]).xyz`. */
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/** Apply a transform's linear part to a direction (no translation). */
export function transformVector(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
  ];
}

/** Matrix product `a · b` (row-major), so `transformPoint(multiply(a, b), p) = transformPoint(a, transformPoint(b, p))`. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] =
        a[r * 4] * b[c] +
        a[r * 4 + 1] * b[4 + c] +
        a[r * 4 + 2] * b[8 + c] +
        a[r * 4 + 3] * b[12 + c];
    }
  }
  return out;
}

/**
 * Inverse of an affine transform (assumes a `[0,0,0,1]` bottom row): inverts the
 * 3×3 linear part via its adjugate and maps the translation through it. Returns
 * null when the linear part is singular (det ≈ 0) — a degenerate registration
 * that can't be applied in reverse.
 */
export function invert(m: Mat4): Mat4 | null {
  // Linear part, row-major: [a b c; d e f; g h i].
  const a = m[0],
    b = m[1],
    c = m[2];
  const d = m[4],
    e = m[5],
    f = m[6];
  const g = m[8],
    h = m[9],
    i = m[10];

  const det = a * (e * i - f * h) + b * (f * g - d * i) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;

  // Inverse linear part (adjugate / det), row-major.
  const l0 = (e * i - f * h) * inv;
  const l1 = (c * h - b * i) * inv;
  const l2 = (b * f - c * e) * inv;
  const l3 = (f * g - d * i) * inv;
  const l4 = (a * i - c * g) * inv;
  const l5 = (c * d - a * f) * inv;
  const l6 = (d * h - e * g) * inv;
  const l7 = (b * g - a * h) * inv;
  const l8 = (a * e - b * d) * inv;

  // Translation: t' = -L⁻¹ · t.
  const tx = m[3],
    ty = m[7],
    tz = m[11];
  const t0 = -(l0 * tx + l1 * ty + l2 * tz);
  const t1 = -(l3 * tx + l4 * ty + l5 * tz);
  const t2 = -(l6 * tx + l7 * ty + l8 * tz);

  return [l0, l1, l2, t0, l3, l4, l5, t1, l6, l7, l8, t2, 0, 0, 0, 1];
}
