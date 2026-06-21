import { clampIndex } from '../dicom/math';
import { Orientation, type Vec3, type Volume } from '../dicom/types';
import type { PaneRect, Vec2 } from './layout';
import {
  patientToTexMatrix,
  planeToTex,
  resolveGeometry,
  sliceCountFor,
  texCoordAt,
  type ObliqueRotation,
} from './reslice';
import { add, scale } from '../dicom/vec3';
import { aspectScale } from './slice-renderer';

/** A voxel sampled under the cursor: its volume index and value. */
export interface VoxelProbe {
  /** Voxel index along x (column), y (row), z (slice), zero-based. */
  readonly voxel: readonly [number, number, number];
  /** Value as stored in {@link Volume.data} — modality units (e.g. Hounsfield). */
  readonly value: number;
  /** Raw stored value before the modality LUT, recovered via slope/intercept. */
  readonly rawValue: number;
  /**
   * Patient-space (LPS, mm) location of the sample. Lets a caller read other
   * layers (e.g. a dose grid) at the same physical point via
   * {@link sampleVolumeAtPatient}, even when their grids differ.
   */
  readonly patient: Vec3;
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
 * @param rotation Oblique tilt of the plane, matching the shader's reslice.
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
  rotation?: ObliqueRotation,
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
  const coord = texCoordAt(planeToTex(volume, orientation, rotation), px, planeY, slicePos);
  if (coord.some((c) => c < 0 || c > 1)) return null; // outside the volume

  // The patient point of the cursor on this plane: invert the voxel-centre texture
  // mapping (index = coord·dim − ½) and place it through the volume's geometry.
  const [dimX, dimY, dimZ] = volume.dims;
  const geom = resolveGeometry(volume);
  const patient = add(
    geom.origin,
    add(
      add(scale(geom.iStep, coord[0] * dimX - 0.5), scale(geom.jStep, coord[1] * dimY - 0.5)),
      scale(geom.kStep, coord[2] * dimZ - 0.5),
    ),
  );
  return sampleTex(volume, coord[0], coord[1], coord[2], patient);
}

/**
 * Sample `volume` at a patient-space point — for reading a second layer (e.g. a
 * dose grid) at the location the cursor probe found on the displayed layer. Maps
 * the point through {@link patientToTexMatrix} into this volume's own grid and
 * returns null when it lies outside it; the grids need only share the patient
 * frame of reference, not bounds or spacing.
 */
export function sampleVolumeAtPatient(volume: Volume, patient: Vec3): VoxelProbe | null {
  const m = patientToTexMatrix(volume); // column-major patient → texcoord
  const tx = m[0] * patient[0] + m[4] * patient[1] + m[8] * patient[2] + m[12];
  const ty = m[1] * patient[0] + m[5] * patient[1] + m[9] * patient[2] + m[13];
  const tz = m[2] * patient[0] + m[6] * patient[1] + m[10] * patient[2] + m[14];
  if (tx < 0 || tx > 1 || ty < 0 || ty > 1 || tz < 0 || tz > 1) return null;
  return sampleTex(volume, tx, ty, tz, patient);
}

/** Floor a texture coordinate into `volume`'s grid and read the value there. */
function sampleTex(volume: Volume, tx: number, ty: number, tz: number, patient: Vec3): VoxelProbe {
  const [dimX, dimY, dimZ] = volume.dims;
  const vx = clampIndex(Math.floor(tx * dimX), dimX);
  const vy = clampIndex(Math.floor(ty * dimY), dimY);
  const vz = clampIndex(Math.floor(tz * dimZ), dimZ);
  const value = volume.data[(vz * dimY + vy) * dimX + vx];
  const rawValue =
    volume.rescaleSlope !== 0 ? (value - volume.rescaleIntercept) / volume.rescaleSlope : value;
  return { voxel: [vx, vy, vz], value, rawValue, patient };
}
