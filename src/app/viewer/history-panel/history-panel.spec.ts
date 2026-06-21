import { formatStudyDate, nextOpenStudy, seriesCountLabel, studyCountLabel } from './history-panel';
import { imageCountLabel, modalityGlyph, seriesChipLabel } from './series-chip';
import type { Series } from '../../../dicom/series';

/** A minimal series fixture; only the fields the chip label reads matter. */
function series(overrides: Partial<Series> = {}): Series {
  return {
    uid: '1.2.3',
    seriesNumber: null,
    description: null,
    modality: null,
    studyUid: null,
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    patientId: null,
    patientName: null,
    frameOfReferenceUid: null,
    imageCount: 0,
    dims: [0, 0],
    metadata: null,
    slices: [],
    ...overrides,
  };
}

describe('nextOpenStudy', () => {
  it('opens the clicked study when a different one (or none) is open', () => {
    expect(nextOpenStudy(null, 'a')).toBe('a');
    expect(nextOpenStudy('a', 'b')).toBe('b');
  });

  it('closes the study when it is already open (accordion toggle)', () => {
    expect(nextOpenStudy('a', 'a')).toBeNull();
  });
});

describe('formatStudyDate', () => {
  it('formats an 8-digit DICOM DA as YYYY-MM-DD', () => {
    expect(formatStudyDate('20240318')).toBe('2024-03-18');
  });

  it('labels a null or malformed date as Undated', () => {
    expect(formatStudyDate(null)).toBe('Undated');
    expect(formatStudyDate('2024')).toBe('Undated');
    expect(formatStudyDate('not-a-date')).toBe('Undated');
  });
});

describe('seriesCountLabel', () => {
  it('summarises a study’s series count', () => {
    expect(seriesCountLabel(1)).toBe('1 series');
    expect(seriesCountLabel(4)).toBe('4 series');
  });
});

describe('studyCountLabel', () => {
  it('singularises one study and pluralises the rest (tree root)', () => {
    expect(studyCountLabel(1)).toBe('1 study');
    expect(studyCountLabel(3)).toBe('3 studies');
    expect(studyCountLabel(0)).toBe('0 studies');
  });
});

describe('seriesChipLabel', () => {
  it('uses the description when present', () => {
    expect(seriesChipLabel(series({ description: 'AX T1' }))).toBe('AX T1');
  });

  it('falls back to the series number, then a generic label', () => {
    expect(seriesChipLabel(series({ description: '  ', seriesNumber: 3 }))).toBe('Series 3');
    expect(seriesChipLabel(series({ description: null, seriesNumber: null }))).toBe('Series');
  });
});

describe('imageCountLabel', () => {
  it('summarises the image count', () => {
    expect(imageCountLabel(1)).toBe('1 img');
    expect(imageCountLabel(120)).toBe('120 img');
  });
});

describe('modalityGlyph', () => {
  it('gives RT and report objects a recognisable glyph', () => {
    expect(modalityGlyph('RTSTRUCT')).toBe('◌');
    expect(modalityGlyph('rtdose')).toBe('◉');
  });

  it('falls back to a generic glyph for image / unknown modalities', () => {
    expect(modalityGlyph('CT')).toBe('⬚');
    expect(modalityGlyph(null)).toBe('⬚');
  });
});
