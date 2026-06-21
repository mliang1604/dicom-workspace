import { PatientCatalog } from './patient-catalog';
import type { Slice } from '../dicom/types';
import type { Series } from '../dicom/series';

/** A minimal series carrying just the catalog-grouping fields under test. */
function series(uid: string, overrides: Partial<Series> = {}): Series {
  return {
    uid,
    seriesNumber: null,
    description: null,
    modality: null,
    studyUid: 'study',
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    patientId: 'p1',
    patientName: null,
    frameOfReferenceUid: null,
    imageCount: 1,
    dims: [4, 4],
    metadata: null,
    slices: [{ marker: uid } as unknown as Slice],
    ...overrides,
  };
}

describe('PatientCatalog', () => {
  it('starts empty with no current patient', () => {
    const catalog = new PatientCatalog();
    expect(catalog.patients().size).toBe(0);
    expect(catalog.currentPatientId()).toBeNull();
    expect(catalog.currentPatient()).toBeNull();
  });

  it('accumulates series across imports into one merged hierarchy', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a')]);
    catalog.add([series('b')]);

    const patient = catalog.patients().get('p1');
    expect(catalog.patients().size).toBe(1);
    expect(patient?.studies.flatMap((s) => s.series).map((s) => s.uid)).toEqual(['a', 'b']);
  });

  it('dedups by SeriesInstanceUID, keeping the series already there', () => {
    const catalog = new PatientCatalog();
    const original = series('a', { slices: [{ marker: 'first' } as unknown as Slice] });
    catalog.add([original]);
    catalog.add([series('a', { slices: [{ marker: 'second' } as unknown as Slice] }), series('b')]);

    const kept =
      catalog
        .patients()
        .get('p1')
        ?.studies.flatMap((s) => s.series) ?? [];
    expect(kept.map((s) => s.uid)).toEqual(['a', 'b']);
    expect(kept.find((s) => s.uid === 'a')).toBe(original);
  });

  it('holds several patients while focusing the latest import', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a', { patientId: 'p1' })]);
    catalog.add([series('b', { patientId: 'p2' })]);

    expect([...catalog.patients().keys()]).toEqual(['p1', 'p2']);
    expect(catalog.currentPatientId()).toBe('p2');
    expect(catalog.currentPatient()?.patientId).toBe('p2');
  });

  it('builds no volumes, retaining each series slices', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a')]);

    const stored = catalog.patients().get('p1')?.studies[0].series[0];
    expect(stored?.slices).toHaveLength(1);
    expect('volume' in (stored ?? {})).toBe(false);
  });

  it('keys series with no PatientID under the empty string', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a', { patientId: null })]);

    expect(catalog.patients().has('')).toBe(true);
    expect(catalog.currentPatientId()).toBe('');
  });

  it('ignores an empty import', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a')]);
    catalog.add([]);

    expect(catalog.patients().size).toBe(1);
    expect(catalog.currentPatientId()).toBe('p1');
  });

  it('clear() empties the catalog and current selection', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a')]);
    catalog.clear();

    expect(catalog.patients().size).toBe(0);
    expect(catalog.currentPatientId()).toBeNull();
    expect(catalog.currentPatient()).toBeNull();
  });
});
