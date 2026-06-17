import { Orientation, type Volume } from '../dicom/types';
import type { PaneRect } from './layout';
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
 * This is the inverse of the reslice in `slice-shader.ts`: it letterboxes the
 * pane the same way (via {@link aspectScale} and the pane's zoom), then applies
 * the per-orientation axis mapping. Keep the orientation `switch` here in sync
 * with the shader's. Returns `null` when the cursor is outside the pane or over
 * its letterbox margin (where no voxel is drawn).
 *
 * @param rect    Pane rectangle in the same pixel units as the cursor.
 * @param cursorX Cursor X relative to the canvas, same units as `rect`.
 * @param cursorY Cursor Y relative to the canvas, same units as `rect`.
 * @param flipX   Mirror the in-plane horizontal axis, matching the shader.
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
): VoxelProbe | null {
  if (rect.width < 1 || rect.height < 1) return null;

  // Cursor → uv in [0,1] within the pane, v = 0 at the top (matches the shader).
  const u = (cursorX - rect.x) / rect.width;
  const v = (cursorY - rect.y) / rect.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;

  // Undo the letterbox: the shader scales the centered uv by aspect-fit / zoom.
  const z = zoom > 0 ? zoom : 1;
  const [scaleX, scaleY] = aspectScale(volume, orientation, rect.width, rect.height);
  const planeX = (u - 0.5) * (scaleX / z) + 0.5;
  const planeY = (v - 0.5) * (scaleY / z) + 0.5;
  if (planeX < 0 || planeX > 1 || planeY < 0 || planeY > 1) return null;

  // Mirror the horizontal axis the same way the shader does when flipped.
  const px = flipX ? 1 - planeX : planeX;

  const [dimX, dimY, dimZ] = volume.dims;
  let vx: number;
  let vy: number;
  let vz: number;
  switch (orientation) {
    case Orientation.Axial: // x→X, y→Y, slice walks Z.
      vx = toIndex(px, dimX);
      vy = toIndex(planeY, dimY);
      vz = clampIndex(sliceIndex, dimZ);
      break;
    case Orientation.Coronal: // x→X, y→Z (flipped), slice walks Y.
      vx = toIndex(px, dimX);
      vy = clampIndex(sliceIndex, dimY);
      vz = toIndex(1 - planeY, dimZ);
      break;
    case Orientation.Sagittal: // x→Y, y→Z (flipped), slice walks X.
      vx = clampIndex(sliceIndex, dimX);
      vy = toIndex(px, dimY);
      vz = toIndex(1 - planeY, dimZ);
      break;
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }

  const value = volume.data[(vz * dimY + vy) * dimX + vx];
  const rawValue =
    volume.rescaleSlope !== 0
      ? (value - volume.rescaleIntercept) / volume.rescaleSlope
      : value;
  return { voxel: [vx, vy, vz], value, rawValue };
}

/** Normalized coordinate (0..1) → nearest voxel index, clamped into the volume. */
function toIndex(norm: number, dim: number): number {
  return clampIndex(Math.floor(norm * dim), dim);
}

function clampIndex(index: number, dim: number): number {
  return Math.min(dim - 1, Math.max(0, index));
}
