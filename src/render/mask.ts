/**
 * The display LUT for an authored label mask: a 1-D RGBA ramp indexed directly by
 * ROI id, so the slice shader can colour each painted voxel by the id stored in
 * the label volume. Unlike a {@link import('./colormap').Colormap} (a continuous
 * value→colour ramp), this is a discrete id→colour table — texel `i` holds the
 * display colour of ROI id `i`, and texel `0` (background) is transparent.
 *
 * The shader samples the mask volume NEAREST (ids must never be interpolated),
 * rounds the sampled value to an id, and looks the colour up here.
 */

import { clamp01 } from '../dicom/math';

/**
 * Texel count of a baked mask LUT — the largest ROI id it can colour. Authored
 * structures take ids `1, 2, 3, …` in creation order (never recycled), so this
 * caps a single load at {@link MASK_LUT_SIZE} − 1 distinct structures, ample for
 * hand authoring. A 1-D texture can't grow unbounded (the GPU's 1-D dimension
 * limit), so ids at/above this are clamped to the last texel by the sampler.
 */
export const MASK_LUT_SIZE = 256;

/** One label-mask LUT entry: an ROI id and the colour to draw its voxels in. */
export interface MaskColor {
  /** The ROI id, doubling as the voxel value tagging the structure (≥ 1). */
  readonly id: number;
  /** Display colour as `[r, g, b]` in 0–255. */
  readonly color: readonly [number, number, number];
}

/**
 * Bake an id→colour table into a `size`-texel RGBA LUT (floats, 0–1), for upload
 * to a 1-D texture the shader samples nearest. Texel `0` is the transparent
 * background (alpha 0); each {@link MaskColor} writes its colour at its id's texel
 * with alpha 1. Ids outside `[1, size)` are skipped (a later id reuse can't paint
 * a stale colour, and an id past the table simply doesn't colour). Pure — the GPU
 * upload stays in the renderer.
 */
export function maskColorLut(rois: readonly MaskColor[], size = MASK_LUT_SIZE): Float32Array {
  const lut = new Float32Array(size * 4); // zeroed → background and any gaps transparent
  for (const { id, color } of rois) {
    if (!Number.isInteger(id) || id < 1 || id >= size) continue;
    const o = id * 4;
    lut[o + 0] = clamp01(color[0] / 255);
    lut[o + 1] = clamp01(color[1] / 255);
    lut[o + 2] = clamp01(color[2] / 255);
    lut[o + 3] = 1; // opaque; the per-mask composite opacity is applied in the shader
  }
  return lut;
}
