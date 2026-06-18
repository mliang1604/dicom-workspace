import { Orientation, type Volume } from '../dicom/types';
import type { PaneRect, Vec2 } from './layout';
import { planeToTex, sliceCountFor, texCoordAt } from './reslice';
import { aspectScale } from './slice-renderer';

/** A voxel sampled under the cursor: its volume index and value. */
export interface VoxelProbe {
  /** Voxel index along x (column), y (row), z (slice), zero-based. */
  readonly voxel: readonly [number, number, number];
  /** Value as stored in {@link Volume.data} — modality units (e.g. Hounsfield). */
  readonly value: number;
  /** Raw stored value before the modality LUT, recovered via slope/intercept. */
  readonly rawValue: number;
}

/**
 * Map a cursor position over a pane back to the voxel it displays.
 *
 * This is the inverse of the reslice in `slice-shader.ts`: it pans and
 * letterboxes the pane the same way (via {@link aspectScale} and the pane's
 * zoom), then runs the pane coordinate through the very same `planeToTex`
 * affine the shader uses (from `reslice.ts`), so the sampled voxel always
 * matches the pixel drawn — even for oblique acquisitions. Returns `null` when
 * the cursor is outside the pane, over its letterbox margin, or over a part of
 * the plane that lies outside the (possibly rotated) volume.
 *
 * @param rect    Pane rectangle in the same pixel units as the cursor.
 * @param cursorX Cursor X relative to the canvas, same units as `rect`.
 * @param cursorY Cursor Y relative to the canvas, same units as `rect`.
 * @param flipX   Mirror the in-plane horizontal axis, matching the shader.
 * @param pan     Pane pan offset in screen-uv units, matching the shader.
 */
export function probeVoxel(
  volume: Volume,
  orientation: Orientation,
  sliceIndex: number,
  zoom: number,
  rect: PaneRect,
  cursorX: number,
  cursorY: number,
  flipX = false,
  pan: Vec2 = { x: 0, y: 0 },
): VoxelProbe | null {
  if (rect.width < 1 || rect.height < 1) return null;

  // Cursor → uv in [0,1] within the pane, v = 0 at the top (matches the shader).
  const u = (cursorX - rect.x) / rect.width;
  const v = (cursorY - rect.y) / rect.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;

  // Undo the pan and letterbox: the shader translates by pan in screen-uv, then
  // scales the centered uv by aspect-fit / zoom.
  const z = zoom > 0 ? zoom : 1;
  const [scaleX, scaleY] = aspectScale(volume, orientation, rect.width, rect.height);
  const planeX = (u - 0.5 - pan.x) * (scaleX / z) + 0.5;
  const planeY = (v - 0.5 - pan.y) * (scaleY / z) + 0.5;
  if (planeX < 0 || planeX > 1 || planeY < 0 || planeY > 1) return null;

  // Mirror the horizontal axis the same way the shader does when flipped.
  const px = flipX ? 1 - planeX : planeX;

  const count = sliceCountFor(volume, orientation);
  const slicePos = count > 1 ? (sliceIndex + 0.5) / count : 0.5;
  const coord = texCoordAt(planeToTex(volume, orientation), px, planeY, slicePos);
  if (coord.some((c) => c < 0 || c > 1)) return null; // outside the volume

  const [dimX, dimY, dimZ] = volume.dims;
  const vx = clampIndex(Math.floor(coord[0] * dimX), dimX);
  const vy = clampIndex(Math.floor(coord[1] * dimY), dimY);
  const vz = clampIndex(Math.floor(coord[2] * dimZ), dimZ);

  const value = volume.data[(vz * dimY + vy) * dimX + vx];
  const rawValue =
    volume.rescaleSlope !== 0 ? (value - volume.rescaleIntercept) / volume.rescaleSlope : value;
  return { voxel: [vx, vy, vz], value, rawValue };
}

function clampIndex(index: number, dim: number): number {
  return Math.min(dim - 1, Math.max(0, index));
}
