import { groupSeries } from '../../dicom/series';
import type { Slice } from '../../dicom/types';
import {
  computeSeriesThumbnail,
  isImageSeries,
  renderSliceThumbnail,
  SeriesThumbnailCache,
  sliceWindow,
  THUMBNAIL_SIZE,
  windowedByte,
} from './series-thumbnail';

/** A minimal slice carrying just the fields a thumbnail reads. */
function slice(overrides: Partial<Slice> = {}): Slice {
  return {
    name: 'slice',
    columns: 2,
    rows: 2,
    pixelSpacing: [1, 1],
    position: null,
    orientation: null,
    instanceNumber: 0,
    seriesUid: 'series-1',
    seriesNumber: null,
    seriesDescription: null,
    frameOfReferenceUid: null,
    studyUid: null,
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    patientId: null,
    patientName: null,
    modality: 'CT',
    rescaleSlope: 1,
    rescaleIntercept: 0,
    windowCenter: null,
    windowWidth: null,
    pixels: new Float32Array([0, 0, 0, 0]),
    ...overrides,
  };
}

describe('windowedByte', () => {
  it('maps the window centre to mid-gray and the edges to black/white', () => {
    const window = { center: 100, width: 200 };
    expect(windowedByte(0, window)).toBe(0);
    expect(windowedByte(200, window)).toBe(255);
    // Centre lands at ~mid-gray (the -0.5 / width-1 offsets nudge it off exactly 128).
    expect(windowedByte(100, window)).toBeGreaterThan(120);
    expect(windowedByte(100, window)).toBeLessThan(135);
  });

  it('clamps values outside the window', () => {
    const window = { center: 0, width: 100 };
    expect(windowedByte(-1000, window)).toBe(0);
    expect(windowedByte(1000, window)).toBe(255);
  });
});

describe('sliceWindow', () => {
  it('prefers the file window/level when present', () => {
    expect(sliceWindow(slice({ windowCenter: 40, windowWidth: 400 }))).toEqual({
      center: 40,
      width: 400,
    });
  });

  it('derives a window from the value range when the file has none', () => {
    const s = slice({ pixels: new Float32Array([10, 20, 30, 50]) });
    expect(sliceWindow(s)).toEqual({ center: 30, width: 40 });
  });

  it('ignores a non-positive file width and falls back to the data range', () => {
    const s = slice({ windowCenter: 5, windowWidth: 0, pixels: new Float32Array([0, 4, 8, 8]) });
    expect(sliceWindow(s)).toEqual({ center: 4, width: 8 });
  });

  it('returns a unit window for an empty slice', () => {
    expect(sliceWindow(slice({ pixels: new Float32Array(0) }))).toEqual({ center: 0, width: 1 });
  });
});

describe('isImageSeries', () => {
  it('treats ordinary image modalities (and absent ones) as previewable', () => {
    expect(isImageSeries('CT')).toBe(true);
    expect(isImageSeries('MR')).toBe(true);
    expect(isImageSeries(null)).toBe(true);
  });

  it('treats RT objects and other non-image modalities as icon-only', () => {
    expect(isImageSeries('RTSTRUCT')).toBe(false);
    expect(isImageSeries('RTDOSE')).toBe(false);
    expect(isImageSeries('rtstruct')).toBe(false); // case-insensitive
    expect(isImageSeries('SEG')).toBe(false);
  });
});

describe('renderSliceThumbnail', () => {
  it('fits within the box preserving aspect ratio', () => {
    const wide = slice({ columns: 100, rows: 50, pixels: new Float32Array(100 * 50) });
    const t = renderSliceThumbnail(wide, 64);
    expect(t.width).toBe(64);
    expect(t.height).toBe(32);
    expect(t.data.length).toBe(64 * 32 * 4);
  });

  it('writes opaque gray (R=G=B, A=255) windowed from the pixels', () => {
    // A 2x2 with file window [center 50, width 100]; each pixel keeps its own cell.
    const s = slice({
      columns: 2,
      rows: 2,
      windowCenter: 50,
      windowWidth: 100,
      pixels: new Float32Array([0, 100, 100, 0]),
    });
    const t = renderSliceThumbnail(s, 2);
    expect(t.width).toBe(2);
    expect(t.height).toBe(2);
    // Top-left = 0 -> black, top-right = 100 -> white.
    expect([t.data[0], t.data[1], t.data[2], t.data[3]]).toEqual([0, 0, 0, 255]);
    expect([t.data[4], t.data[5], t.data[6], t.data[7]]).toEqual([255, 255, 255, 255]);
  });

  it('box-averages source pixels when downscaling', () => {
    // A 2x2 of [0, 100; 100, 0] averaged to 1x1 is 50 -> mid-gray.
    const s = slice({
      columns: 2,
      rows: 2,
      windowCenter: 50,
      windowWidth: 100,
      pixels: new Float32Array([0, 100, 100, 0]),
    });
    const t = renderSliceThumbnail(s, 1);
    expect(t.width).toBe(1);
    expect(t.height).toBe(1);
    expect(t.data[0]).toBe(windowedByte(50, { center: 50, width: 100 }));
    expect(t.data[3]).toBe(255);
  });
});

describe('computeSeriesThumbnail', () => {
  it('renders an image preview for an image series', () => {
    const [series] = groupSeries([slice({ modality: 'CT' })]);
    const thumb = computeSeriesThumbnail(series);
    expect(thumb.kind).toBe('image');
    if (thumb.kind === 'image') {
      expect(thumb.pixels.width).toBeGreaterThan(0);
      expect(thumb.pixels.height).toBeGreaterThan(0);
    }
  });

  it('uses the middle slice of a multi-slice series', () => {
    const [series] = groupSeries([
      slice({ instanceNumber: 1, columns: 4, rows: 4, pixels: new Float32Array(16) }),
      slice({ instanceNumber: 2, columns: 8, rows: 4, pixels: new Float32Array(32) }),
      slice({ instanceNumber: 3, columns: 4, rows: 4, pixels: new Float32Array(16) }),
    ]);
    const thumb = computeSeriesThumbnail(series, 8);
    // The middle slice (instance 2) is 8x4, so the preview is wider than tall.
    expect(thumb.kind).toBe('image');
    if (thumb.kind === 'image') {
      expect(thumb.pixels.width).toBe(8);
      expect(thumb.pixels.height).toBe(4);
    }
  });

  it('falls back to an icon for an RT object', () => {
    const [series] = groupSeries([slice({ modality: 'RTSTRUCT' })]);
    expect(computeSeriesThumbnail(series)).toEqual({ kind: 'icon', modality: 'RTSTRUCT' });
  });

  it('falls back to an icon for an image series with no pixels', () => {
    const [series] = groupSeries([slice({ modality: 'MR', pixels: new Float32Array(0) })]);
    expect(computeSeriesThumbnail(series)).toEqual({ kind: 'icon', modality: 'MR' });
  });
});

describe('SeriesThumbnailCache', () => {
  it('computes once per series and memoises by UID', () => {
    const cache = new SeriesThumbnailCache();
    const [series] = groupSeries([slice({ seriesUid: 'a', modality: 'CT' })]);
    const first = cache.get(series);
    const second = cache.get(series);
    expect(second).toBe(first); // same reference: not recomputed
  });

  it('clears its memo', () => {
    const cache = new SeriesThumbnailCache();
    const [series] = groupSeries([slice({ seriesUid: 'a', modality: 'CT' })]);
    const first = cache.get(series);
    cache.clear();
    expect(cache.get(series)).not.toBe(first);
  });

  it('uses the default thumbnail size', () => {
    const cache = new SeriesThumbnailCache();
    const big = slice({ columns: 256, rows: 256, pixels: new Float32Array(256 * 256) });
    const [series] = groupSeries([big]);
    const thumb = cache.get(series);
    if (thumb.kind === 'image') {
      expect(Math.max(thumb.pixels.width, thumb.pixels.height)).toBe(THUMBNAIL_SIZE);
    }
  });
});
