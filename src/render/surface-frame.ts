import type { Vec3 } from '../dicom/types';
import { dot } from '../dicom/vec3';
import type { CameraBasis } from './camera';

/** Surface camera uniform bytes: eye, axisU+uu, axisV+vv, light (4 × vec4). */
export const SURFACE_CAMERA_SIZE = 64;
/** Floats in the packed surface camera uniform ({@link SURFACE_CAMERA_SIZE} / 4). */
const SURFACE_CAMERA_FLOATS = SURFACE_CAMERA_SIZE / 4;

/** Per-frame data for the ROI surface pass: depth-sorted indices + packed camera. */
export interface SurfaceFrame {
  /** Triangle vertex indices, back-to-front (painter's order). */
  readonly indices: Uint32Array;
  /** Packed camera uniform: eye, _, axisU, uu, axisV, vv, light, _ (16 floats). */
  readonly camera: Float32Array;
}

/**
 * Reusable scratch for {@link packSurfaceFrame}, grown as the triangle count
 * rises so a steady orbit allocates nothing per frame. `depth`/`order` size with
 * the triangle count; `index` holds three vertex indices per triangle; `camera`
 * is the packed uniform reused each frame. Owned by the caller (the component)
 * and threaded back in so the geometry stays a pure function.
 */
export interface SurfaceSortScratch {
  depth: Float32Array;
  order: Uint32Array;
  index: Uint32Array;
  readonly camera: Float32Array;
  cap: number;
}

/**
 * Grow (and reuse) the per-frame surface depth-sort scratch so it holds at least
 * `n` triangles. Doubles past growth (and floors at 4096) to amortise reallocs
 * across an orbit. Pass the previous scratch back in to reuse it; a fresh
 * `camera` buffer is allocated only on the first call.
 */
export function ensureSurfaceSortScratch(
  prev: SurfaceSortScratch | null,
  n: number,
): SurfaceSortScratch {
  if (prev && prev.cap >= n) return prev;
  const cap = Math.max(n, (prev?.cap ?? 0) * 2, 4096);
  return {
    depth: new Float32Array(cap),
    order: new Uint32Array(cap),
    index: new Uint32Array(cap * 3),
    camera: prev?.camera ?? new Float32Array(SURFACE_CAMERA_FLOATS),
    cap,
  };
}

/**
 * Build the per-frame {@link SurfaceFrame} for the ROI surface pass: depth-sort
 * the `n` triangles back-to-front (painter's order) against the camera and pack
 * the camera uniform to the byte layout `surface-shader.ts` expects (eye, axisU +
 * |axisU|², axisV + |axisV|², light, each on a vec4 boundary). The sort key is
 * each centroid's signed depth along `forward`; the resolved order expands to
 * three consecutive vertex indices per triangle. Pure given the scratch — the GPU
 * upload of the result is the renderer's job ({@link SliceRenderer.renderPanes}).
 *
 * @param centroids Triangle centroids (3 floats each), parallel to triangle order.
 * @param n         Number of triangles to draw.
 * @param basis     Camera basis (eye / image-plane axes / forward) for this frame.
 * @param light     View-forward direction the head-light shade uses.
 * @param scratch   Reusable buffers sized for `n` (see {@link ensureSurfaceSortScratch}).
 */
export function packSurfaceFrame(
  centroids: Float32Array,
  n: number,
  basis: CameraBasis,
  light: Vec3,
  scratch: SurfaceSortScratch,
): SurfaceFrame {
  const { depth, order, index, camera } = scratch;

  const ex = basis.eye[0];
  const ey = basis.eye[1];
  const ez = basis.eye[2];
  const fx = basis.forward[0];
  const fy = basis.forward[1];
  const fz = basis.forward[2];
  for (let i = 0; i < n; i++) {
    const c = i * 3;
    depth[i] =
      (centroids[c] - ex) * fx + (centroids[c + 1] - ey) * fy + (centroids[c + 2] - ez) * fz;
    order[i] = i;
  }
  const ord = order.subarray(0, n);
  ord.sort((a, b) => depth[b] - depth[a]); // far first (painter's order)
  for (let k = 0; k < n; k++) {
    const t = ord[k];
    index[k * 3] = t * 3;
    index[k * 3 + 1] = t * 3 + 1;
    index[k * 3 + 2] = t * 3 + 2;
  }

  camera[0] = ex;
  camera[1] = ey;
  camera[2] = ez;
  camera[4] = basis.axisU[0];
  camera[5] = basis.axisU[1];
  camera[6] = basis.axisU[2];
  camera[7] = dot(basis.axisU, basis.axisU);
  camera[8] = basis.axisV[0];
  camera[9] = basis.axisV[1];
  camera[10] = basis.axisV[2];
  camera[11] = dot(basis.axisV, basis.axisV);
  camera[12] = light[0];
  camera[13] = light[1];
  camera[14] = light[2];
  return { indices: index.subarray(0, n * 3), camera };
}
