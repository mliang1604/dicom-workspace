import {
  captureFilename,
  pickCaptureTarget,
  pickVideoMimeType,
  rotationAzimuths,
  slugify,
  timestampSlug,
} from './capture';

describe('slugify', () => {
  it('lowercases and joins non-alphanumeric runs with single hyphens', () => {
    expect(slugify('CT Chest / Abdomen')).toBe('ct-chest-abdomen');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  (Head) ')).toBe('head');
  });

  it('returns an empty string when nothing is usable', () => {
    expect(slugify('—/—')).toBe('');
  });
});

describe('timestampSlug', () => {
  it('formats a date as YYYYMMDD-HHMMSS with zero padding', () => {
    expect(timestampSlug(new Date(2026, 5, 20, 9, 5, 3))).toBe('20260620-090503');
  });
});

describe('captureFilename', () => {
  it('combines modality, description, view and timestamp', () => {
    const name = captureFilename(
      { modality: 'CT', description: 'Chest', seriesNumber: 3 },
      'axial',
      'png',
      '20260620-090503',
    );
    expect(name).toBe('ct-chest-axial-20260620-090503.png');
  });

  it('falls back to the series number when there is no description', () => {
    const name = captureFilename(
      { modality: 'MR', description: null, seriesNumber: 7 },
      'rotation',
      'webm',
      '20260620-090503',
    );
    expect(name).toBe('mr-series-7-rotation-20260620-090503.webm');
  });

  it('drops absent parts', () => {
    const name = captureFilename(null, '3d', 'webm', '20260620-090503');
    expect(name).toBe('3d-20260620-090503.webm');
  });

  it('uses a fixed base when nothing names the capture', () => {
    expect(captureFilename(null, '', 'png', '')).toBe('dicom-capture.png');
  });
});

describe('rotationAzimuths', () => {
  it('produces evenly spaced angles over a full turn, ending one step short', () => {
    const angles = rotationAzimuths(0, 4);
    expect(angles).toEqual([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
  });

  it('offsets every angle by the start azimuth', () => {
    expect(rotationAzimuths(1, 2)).toEqual([1, 1 + Math.PI]);
  });

  it('floors the frame count to at least one', () => {
    expect(rotationAzimuths(0.5, 0)).toEqual([0.5]);
    expect(rotationAzimuths(0, 2.9).length).toBe(2);
  });
});

describe('pickCaptureTarget', () => {
  const panes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const keyOf = (pane: { id: string }) => pane.id;

  it('targets the hovered pane when one is under the cursor', () => {
    expect(pickCaptureTarget(panes, 'b', keyOf)).toEqual({ id: 'b' });
  });

  it('falls back to the first pane when nothing is hovered', () => {
    expect(pickCaptureTarget(panes, null, keyOf)).toEqual({ id: 'a' });
  });

  it('falls back to the first pane when the hovered key matches none', () => {
    expect(pickCaptureTarget(panes, 'gone', keyOf)).toEqual({ id: 'a' });
  });

  it('returns null when there are no panes', () => {
    expect(pickCaptureTarget([], 'a', keyOf)).toBeNull();
  });
});

describe('pickVideoMimeType', () => {
  it('returns the first supported candidate', () => {
    const supported = new Set(['video/webm']);
    const type = pickVideoMimeType(['video/webm;codecs=vp9', 'video/webm'], (t) =>
      supported.has(t),
    );
    expect(type).toBe('video/webm');
  });

  it('returns null when none are supported', () => {
    expect(pickVideoMimeType(['video/webm'], () => false)).toBeNull();
  });
});
