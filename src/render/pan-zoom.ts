import { Orientation, type Vec3, type Volume } from '../dicom/types';
import type { PaneRect, Vec2 } from './layout';
import { planeExtentMm, planePixelDims } from './reslice';

/**
 * Pure pan/zoom/slice geometry shared by the renderer, the cursor probe, and the
 * interaction controller. The shader in `slice-shader.ts` and the inverse in
 * `probe.ts` implement the same letterbox/pan/zoom mapping; these helpers are the
 * single source the three keep in lockstep with.
 */

/**
 * Letterbox scale that fits the plane into a viewport without distortion.
 * Exported so the CPU-side cursor probe can reproduce the exact same fit the
 * shader uses when mapping a pixel back to a voxel.
 */
export function aspectScale(
  volume: Volume,
  orientation: Orientation,
  viewWidth: number,
  viewHeight: number,
): [number, number] {
  const [planeW, planeH] = planeExtentMm(volume, orientation);
  const planeAspect = planeW / planeH;
  const viewAspect = viewWidth / viewHeight;
  if (viewAspect > planeAspect) {
    return [viewAspect / planeAspect, 1];
  }
  return [1, planeAspect / viewAspect];
}

/**
 * Magnification that renders an orientation's slice at its native resolution —
 * one resampled output voxel per device pixel. {@link aspectScale}'s letterbox
 * fit is `zoom = 1` (the slice scaled to just fit the pane); this returns the
 * extra zoom on top of that fit which makes the finer-sampled in-plane axis
 * exactly one voxel per pixel. The coarser axis is then upsampled, so no acquired
 * detail is dropped (for the common square-pixel slice both axes coincide).
 *
 * `viewWidth`/`viewHeight` are the pane's size in the same device-pixel units
 * {@link aspectScale} sees. Returns 1 if the plane has no extent. Apply
 * {@link clampPan} afterwards, since the pan bound grows with zoom.
 */
export function oneToOneZoom(
  volume: Volume,
  orientation: Orientation,
  viewWidth: number,
  viewHeight: number,
): number {
  const [planeW, planeH] = planeExtentMm(volume, orientation);
  const [nU, nV] = planePixelDims(volume, orientation);
  // Device pixels per mm at the letterbox fit (zoom = 1): the plane just fits.
  const fitPxPerMm = Math.min(viewWidth / planeW, viewHeight / planeH);
  // Device pixels per mm at native scale: the finer in-plane sampling sets it,
  // so every voxel covers at least one pixel.
  const nativePxPerMm = Math.max(nU / planeW, nV / planeH);
  const zoom = nativePxPerMm / fitPxPerMm;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * Voxels crossed per unit of ray parameter `t` for the MIP's shared orthographic
 * direction. Multiplying this by a ray's `tExit − tEntry` span gives ≈ one sample
 * per voxel along that ray's real path, so the shader can size its march to the
 * actual traversal instead of the worst-case full diagonal.
 *
 * `forward` is the patient-space ray direction; `patientToTex` is the column-major
 * affine from {@link patientToTexMatrix}. Its linear part maps the direction into
 * texture space (matching `(patientToTex * vec4(forward, 0)).xyz` in the shader),
 * and scaling each texture component by `dims` converts the step to voxel units.
 * The direction is shared by every fragment (orthographic), so this is computed
 * once per frame on the CPU and passed as a uniform.
 */
export function mipStepScale(
  patientToTex: Float32Array,
  forward: Vec3,
  dims: readonly [number, number, number],
): number {
  const [fx, fy, fz] = forward;
  const m = patientToTex;
  // Column-major mat4x4 · vec4(forward, 0): texture component c = m[c] + m[4+c] + m[8+c].
  const rx = m[0] * fx + m[4] * fy + m[8] * fz;
  const ry = m[1] * fx + m[5] * fy + m[9] * fz;
  const rz = m[2] * fx + m[6] * fy + m[10] * fz;
  return Math.hypot(rx * dims[0], ry * dims[1], rz * dims[2]);
}

/**
 * Constrain a pane's pan offset (screen-uv units) so the pane centre always
 * lands on the slice rather than its letterbox margin. The bound grows with
 * zoom, so a magnified pane can be panned proportionally further to reach its
 * edges. Mirrors the pan applied in `slice-shader.ts` and undone in `probe.ts`.
 */
export function clampPan(
  volume: Volume,
  orientation: Orientation,
  viewWidth: number,
  viewHeight: number,
  zoom: number,
  pan: Vec2,
): Vec2 {
  const z = zoom > 0 ? zoom : 1;
  const [scaleX, scaleY] = aspectScale(volume, orientation, viewWidth, viewHeight);
  // Pane centre stays on the plane while |pan * (aspectScale / zoom)| <= 0.5.
  const maxX = (0.5 * z) / scaleX;
  const maxY = (0.5 * z) / scaleY;
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y)),
  };
}

/**
 * Rescale a pan offset so a zoom change pivots about a fixed screen point
 * instead of the image centre. The shader maps a screen-uv point `uv` to the
 * plane point `(uv - 0.5 - pan) * (aspectScale / zoom) + 0.5`; holding the plane
 * point under `anchor` fixed across a zoom change from `fromZoom` to `toZoom`
 * gives `pan' = (anchor - 0.5) * (1 - ratio) + pan * ratio`, with `ratio =
 * toZoom / fromZoom`. `anchor` is in screen-uv (pane-fraction) units and
 * defaults to the pane centre (0.5, 0.5), which reduces to scaling the pan by
 * the zoom ratio. Apply {@link clampPan} afterwards, since the bound grows with
 * zoom.
 */
export function rezoomPan(
  pan: Vec2,
  fromZoom: number,
  toZoom: number,
  anchor: Vec2 = { x: 0.5, y: 0.5 },
): Vec2 {
  const from = fromZoom > 0 ? fromZoom : 1;
  const to = toZoom > 0 ? toZoom : 1;
  const ratio = to / from;
  return {
    x: (anchor.x - 0.5) * (1 - ratio) + pan.x * ratio,
    y: (anchor.y - 0.5) * (1 - ratio) + pan.y * ratio,
  };
}

/**
 * Cursor-anchored pan for a wheel zoom over an MPR pane. Turns the cursor
 * (canvas-relative CSS pixels) into the pane's screen-uv anchor, re-zooms the pan
 * about it so the plane point under the cursor stays put across the zoom change,
 * then re-clamps — the pan bound grows with zoom. Folds the {@link rezoomPan} and
 * {@link clampPan} geometry a cursor-anchored zoom composes behind one tested call.
 */
export function cursorZoomPan(
  volume: Volume,
  orientation: Orientation,
  rect: PaneRect,
  fromZoom: number,
  toZoom: number,
  pan: Vec2,
  cursor: Vec2,
): Vec2 {
  const anchor: Vec2 = {
    x: (cursor.x - rect.x) / rect.width,
    y: (cursor.y - rect.y) / rect.height,
  };
  const anchored = rezoomPan(pan, fromZoom, toZoom, anchor);
  return clampPan(volume, orientation, rect.width, rect.height, toZoom, anchored);
}

/**
 * Next slice index after one wheel notch: step by the sign of `deltaY` (scroll
 * down advances) and clamp into `[0, max]`. The same index arithmetic the
 * linked-master and independent-group scroll paths share — they differ only in
 * which grid's current index and `max` they feed in.
 */
export function steppedSliceIndex(current: number, deltaY: number, max: number): number {
  return Math.min(max, Math.max(0, current + Math.sign(deltaY)));
}

/** Keep a rect within the [0, maxW] × [0, maxH] bounds of the canvas. */
export function clampRect(rect: PaneRect, maxWidth: number, maxHeight: number): PaneRect {
  const x = Math.max(0, Math.min(rect.x, maxWidth));
  const y = Math.max(0, Math.min(rect.y, maxHeight));
  return {
    x,
    y,
    width: Math.max(0, Math.min(rect.width, maxWidth - x)),
    height: Math.max(0, Math.min(rect.height, maxHeight - y)),
  };
}
