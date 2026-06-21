import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  serializePreferences,
  type ViewPreferences,
} from './preferences-store';
import { LayoutMode } from '../render/layout';
import { ProjectionMode } from '../render/slice-renderer';

/** A fully-populated, non-default preference set for round-trip tests. */
const SAMPLE: ViewPreferences = {
  layoutMode: LayoutMode.Quad,
  projectionMode: ProjectionMode.Dvr,
  sagittalFlipped: true,
  windowCenter: 40,
  windowWidth: 400,
  slabThicknessMm: 50,
  historyCollapsed: true,
  historyView: 'tree',
  lastOpenedStudyUid: '1.2.840.113619.2.55.3.123',
};

describe('serializePreferences / parsePreferences', () => {
  it('round-trips a full preference set', () => {
    expect(parsePreferences(serializePreferences(SAMPLE))).toEqual(SAMPLE);
  });

  it('preserves a window centre of 0 (not coerced to null)', () => {
    const prefs = { ...SAMPLE, windowCenter: 0 };
    expect(parsePreferences(serializePreferences(prefs)).windowCenter).toBe(0);
  });

  it('writes the schema version into the blob', () => {
    expect(JSON.parse(serializePreferences(SAMPLE))).toMatchObject({ version: 3 });
  });

  it('preserves the open-study UID and collapsed flag', () => {
    const restored = parsePreferences(serializePreferences(SAMPLE));
    expect(restored.historyCollapsed).toBe(true);
    expect(restored.lastOpenedStudyUid).toBe('1.2.840.113619.2.55.3.123');
  });

  it('preserves the history view choice', () => {
    expect(parsePreferences(serializePreferences(SAMPLE)).historyView).toBe('tree');
  });
});

describe('parsePreferences fallbacks', () => {
  it('returns defaults when nothing is stored', () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it('returns defaults for unparseable JSON', () => {
    expect(parsePreferences('{not json')).toEqual(DEFAULT_PREFERENCES);
  });

  it('returns defaults for a non-object payload', () => {
    expect(parsePreferences('42')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('null')).toEqual(DEFAULT_PREFERENCES);
  });

  it('discards data written under a different schema version', () => {
    const stale = JSON.stringify({ version: 0, ...SAMPLE });
    expect(parsePreferences(stale)).toEqual(DEFAULT_PREFERENCES);
  });

  it('drops a missing version entirely', () => {
    const noVersion = JSON.stringify(SAMPLE);
    expect(parsePreferences(noVersion)).toEqual(DEFAULT_PREFERENCES);
  });

  it('falls back per-field for mistyped or out-of-range values', () => {
    const raw = JSON.stringify({
      version: 3,
      layoutMode: 99, // not a real LayoutMode
      projectionMode: 'dvr', // wrong type
      sagittalFlipped: 'yes', // wrong type
      windowCenter: 'wide', // wrong type → null
      windowWidth: 0, // below the ≥1 floor → null
      slabThicknessMm: -5, // negative → null
      historyView: 'mosaic', // not a real HistoryView → default
    });
    expect(parsePreferences(raw)).toEqual(DEFAULT_PREFERENCES);
  });

  it('keeps valid fields while defaulting the invalid ones', () => {
    const raw = JSON.stringify({
      version: 3,
      layoutMode: LayoutMode.Volume3d,
      projectionMode: 'bad',
      sagittalFlipped: true,
    });
    expect(parsePreferences(raw)).toEqual({
      ...DEFAULT_PREFERENCES,
      layoutMode: LayoutMode.Volume3d,
      sagittalFlipped: true,
    });
  });

  it('rounds a fractional slab thickness and rejects sub-1 widths', () => {
    const raw = JSON.stringify({ version: 3, slabThicknessMm: 12.7, windowWidth: 0.4 });
    const prefs = parsePreferences(raw);
    expect(prefs.slabThicknessMm).toBe(13);
    expect(prefs.windowWidth).toBeNull();
  });
});
