/**
 * Representative CPU preview per series for the timeline chips.
 *
 * A series chip needs a small (~48–64 px) image of what the series looks like.
 * The parsed slice pixels already live on each {@link Slice}, so a preview needs
 * no assembled {@link import('../../dicom/types').Volume} and — deliberately — no
 * WebGPU: it is windowed and downsampled on the CPU into an `ImageData` the UI
 * paints onto a 2D `<canvas>`. (A headless WebGPU readback reads blank under
 * SwiftShader in CI, which is exactly the path a preview would otherwise take.)
 *
 * Everything here is side-effect free except {@link toImageData} (which wraps the
 * pixels in the browser `ImageData` type) and the {@link SeriesThumbnailCache},
 * so the windowing and pixel→`ImageData` mapping can be unit-tested without a GPU
 * or a browser.
 */

import { clamp } from '../../dicom/math';
import { middleSlice, type Series } from '../../dicom/series';
import type { Slice } from '../../dicom/types';

/** Default preview edge in pixels: the box a thumbnail is fit within. */
export const THUMBNAIL_SIZE = 64;

/** The display window (DICOM window/level) a preview is rendered through. */
export interface DisplayWindow {
  /** Window Center (level). */
  readonly center: number;
  /** Window Width. */
  readonly width: number;
}

/** A rendered preview: an RGBA bitmap, row-major, `data.length === width*height*4`. */
export interface ThumbnailPixels {
  readonly width: number;
  readonly height: number;
  /**
   * RGBA bytes; the same buffer {@link toImageData} hands to `ImageData`. Backed
   * by a plain `ArrayBuffer` (not the default `ArrayBufferLike`) so it satisfies
   * the `ImageData` constructor's `ImageDataArray` parameter directly.
   */
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * A series' preview: either a rendered grayscale {@link ThumbnailPixels} image,
 * or an `'icon'` fallback for series where a grayscale preview is meaningless
 * (RT objects, or a series with no pixel data). The UI draws the image to a
 * canvas and the icon from the modality.
 */
export type SeriesThumbnail =
  | { readonly kind: 'image'; readonly pixels: ThumbnailPixels }
  | { readonly kind: 'icon'; readonly modality: string | null };

/**
 * Modalities whose pixels (if any) make a poor grayscale thumbnail, so the chip
 * shows an icon instead. RTSTRUCT and RTPLAN carry no image; an RTDOSE grid is
 * image-like but a raw grayscale wash of dose values is not a recognisable
 * preview; the rest are reports/registrations/segmentations with no image to
 * show. Compared upper-cased, matching the modality normalisation elsewhere.
 */
const NON_IMAGE_MODALITIES = new Set([
  'RTSTRUCT',
  'RTDOSE',
  'RTPLAN',
  'RTRECORD',
  'REG',
  'SEG',
  'PR',
  'KO',
  'SR',
]);

/**
 * Whether a series of the given modality should get a rendered grayscale
 * preview (vs an icon fallback). A null modality is treated as previewable —
 * we try to render and fall back only if there are no pixels.
 */
export function isImageSeries(modality: string | null): boolean {
  return modality === null || !NON_IMAGE_MODALITIES.has(modality.toUpperCase());
}

/**
 * The display window for a slice's preview: the file's suggested window/level
 * when present, else one derived from the slice's own value range. Mirrors
 * {@link import('../../dicom/volume').buildVolume}'s `defaultWindow`, but over a
 * single slice so no volume need be assembled.
 */
export function sliceWindow(slice: Slice): DisplayWindow {
  if (slice.windowCenter !== null && slice.windowWidth !== null && slice.windowWidth > 0) {
    return { center: slice.windowCenter, width: slice.windowWidth };
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of slice.pixels) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { center: 0, width: 1 };
  const width = Math.max(1, max - min);
  return { center: min + width / 2, width };
}

/**
 * Map a rescaled value to an 8-bit gray level through a window, the CPU twin of
 * the WGSL reslice shader's windowing (PS3.3 C.11.2.1.2 linear form). No display
 * inversion is applied here: MONOCHROME1's inverted sense is already folded into
 * the slice pixels and window at parse time, so the same formula serves both.
 */
export function windowedByte(value: number, window: DisplayWindow): number {
  const lo = window.center - 0.5 - (window.width - 1) * 0.5;
  const g = clamp((value - lo) / Math.max(window.width - 1, 1), 0, 1);
  return Math.round(g * 255);
}

/**
 * Render a slice to a small RGBA preview, fit within a `size`×`size` box with
 * the slice's aspect ratio preserved. Pixels are windowed through `window`
 * (defaulting to the slice's own {@link sliceWindow}) and box-averaged when
 * downscaling, so the thumbnail is anti-aliased rather than point-sampled. Pure:
 * given the same slice and window it always yields the same bytes.
 */
export function renderSliceThumbnail(
  slice: Slice,
  size = THUMBNAIL_SIZE,
  window: DisplayWindow = sliceWindow(slice),
): ThumbnailPixels {
  const { columns, rows, pixels } = slice;
  const fit = Math.min(size / columns, size / rows);
  const width = Math.max(1, Math.round(columns * fit));
  const height = Math.max(1, Math.round(rows * fit));
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));

  for (let oy = 0; oy < height; oy++) {
    const y0 = Math.floor((oy * rows) / height);
    const y1 = Math.max(y0 + 1, Math.ceil(((oy + 1) * rows) / height));
    for (let ox = 0; ox < width; ox++) {
      const x0 = Math.floor((ox * columns) / width);
      const x1 = Math.max(x0 + 1, Math.ceil(((ox + 1) * columns) / width));

      // Average the source values covered by this output cell.
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1 && sy < rows; sy++) {
        for (let sx = x0; sx < x1 && sx < columns; sx++) {
          sum += pixels[sy * columns + sx];
          count++;
        }
      }
      const gray = windowedByte(count > 0 ? sum / count : 0, window);

      const o = (oy * width + ox) * 4;
      data[o] = gray;
      data[o + 1] = gray;
      data[o + 2] = gray;
      data[o + 3] = 255;
    }
  }

  return { width, height, data };
}

/**
 * Compute a series' preview: a rendered grayscale image from its middle slice
 * for an image series, or an `'icon'` fallback for an RT object or a series with
 * no pixels to show. Pure; {@link SeriesThumbnailCache} memoises it per series.
 */
export function computeSeriesThumbnail(series: Series, size = THUMBNAIL_SIZE): SeriesThumbnail {
  if (!isImageSeries(series.modality)) return { kind: 'icon', modality: series.modality };
  const slice = middleSlice(series);
  if (!slice || slice.pixels.length === 0) return { kind: 'icon', modality: series.modality };
  return { kind: 'image', pixels: renderSliceThumbnail(slice, size) };
}

/**
 * Wrap rendered preview pixels in the browser `ImageData` type, ready to
 * `putImageData` onto a 2D canvas. The one DOM-touching helper; kept separate so
 * the rendering above stays unit-testable without a browser.
 */
export function toImageData(pixels: ThumbnailPixels): ImageData {
  return new ImageData(pixels.data, pixels.width, pixels.height);
}

/**
 * A lazy, per-series preview cache keyed by SeriesInstanceUID. The first
 * {@link get} for a series computes its thumbnail (off the critical path when
 * the caller defers it, e.g. in an idle callback) and memoises it; later gets
 * return the same value. Series sharing a UID (e.g. several UID-less series, all
 * keyed by the empty string) collapse, mirroring the series model itself.
 */
export class SeriesThumbnailCache {
  private readonly cache = new Map<string, SeriesThumbnail>();

  /** The series' preview, computed and cached on first request. */
  get(series: Series, size = THUMBNAIL_SIZE): SeriesThumbnail {
    const cached = this.cache.get(series.uid);
    if (cached) return cached;
    const thumbnail = computeSeriesThumbnail(series, size);
    this.cache.set(series.uid, thumbnail);
    return thumbnail;
  }

  /** Drop all cached previews (e.g. on a fresh import). */
  clear(): void {
    this.cache.clear();
  }
}
