import {
  addSeriesToCatalog,
  catalogSeries,
  groupPatients,
  groupStudies,
  importKeepsOnePatient,
  importPatientIds,
  initialImportSeries,
} from './catalog';
import type { Series } from './series';

/** A minimal series carrying just the study/patient-grouping fields under test. */
function series(studyUid: string | null, overrides: Partial<Series> = {}): Series {
  return {
    uid: 'series',
    seriesNumber: null,
    description: null,
    modality: null,
    studyUid,
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    patientId: null,
    patientName: null,
    frameOfReferenceUid: null,
    imageCount: 1,
    dims: [4, 4],
    metadata: null,
    slices: [],
    ...overrides,
  };
}

describe('groupStudies', () => {
  it('splits series into one study per StudyInstanceUID', () => {
    const studies = groupStudies([series('a'), series('b'), series('a')]);

    expect(studies).toHaveLength(2);
    expect(studies.map((s) => s.studyUid).sort()).toEqual(['a', 'b']);
    expect(studies.find((s) => s.studyUid === 'a')?.series).toHaveLength(2);
    expect(studies.find((s) => s.studyUid === 'b')?.series).toHaveLength(1);
  });

  it('lifts the descriptive fields from each study first series', () => {
    const studies = groupStudies([
      series('a', {
        studyDate: '20240115',
        studyTime: '101500',
        studyDescription: 'Chest CT',
        patientName: 'Doe^Jane',
      }),
    ]);

    expect(studies[0]).toMatchObject({
      studyUid: 'a',
      date: '20240115',
      time: '101500',
      description: 'Chest CT',
    });
  });

  it('collects the distinct modalities across a study, in encounter order', () => {
    const studies = groupStudies([
      series('a', { modality: 'CT' }),
      series('a', { modality: 'RTSTRUCT' }),
      series('a', { modality: 'CT' }),
      series('a', { modality: null }),
    ]);

    expect(studies[0].modalities).toEqual(['CT', 'RTSTRUCT']);
  });

  it('orders studies by StudyDate ascending, undated last', () => {
    const studies = groupStudies([
      series('undated', { studyDate: null }),
      series('late', { studyDate: '20240601' }),
      series('early', { studyDate: '20240101' }),
    ]);

    expect(studies.map((s) => s.studyUid)).toEqual(['early', 'late', 'undated']);
  });

  it('tie-breaks same-date studies by StudyTime, then UID', () => {
    const sameDate = '20240101';
    const studies = groupStudies([
      series('z', { studyDate: sameDate, studyTime: '120000' }),
      series('a', { studyDate: sameDate, studyTime: '120000' }),
      series('m', { studyDate: sameDate, studyTime: '080000' }),
    ]);

    expect(studies.map((s) => s.studyUid)).toEqual(['m', 'a', 'z']);
  });

  it('groups series that carry no UID into one unnamed study', () => {
    const studies = groupStudies([series(null), series(null)]);

    expect(studies).toHaveLength(1);
    expect(studies[0].studyUid).toBe('');
    expect(studies[0].series).toHaveLength(2);
  });

  it('returns an empty list for no series', () => {
    expect(groupStudies([])).toEqual([]);
  });
});

describe('groupPatients', () => {
  it('splits series into one patient per PatientID', () => {
    const patients = groupPatients([
      series('s1', { patientId: 'p1' }),
      series('s2', { patientId: 'p2' }),
      series('s3', { patientId: 'p1' }),
    ]);

    expect(patients).toHaveLength(2);
    expect(patients.map((p) => p.patientId)).toEqual(['p1', 'p2']);
    expect(patients[0].studies.flatMap((s) => s.series)).toHaveLength(2);
  });

  it('lifts the patient name from a representative series', () => {
    const patients = groupPatients([series('s1', { patientId: 'p1', patientName: 'Doe^Jane' })]);

    expect(patients[0].name).toBe('Doe^Jane');
  });

  it("orders each patient's studies along the timeline", () => {
    const patients = groupPatients([
      series('late', { patientId: 'p1', studyDate: '20240601' }),
      series('early', { patientId: 'p1', studyDate: '20240101' }),
    ]);

    expect(patients[0].studies.map((s) => s.studyUid)).toEqual(['early', 'late']);
  });

  it('orders patients by PatientID for stability', () => {
    const patients = groupPatients([
      series('s1', { patientId: 'pz' }),
      series('s2', { patientId: 'pa' }),
    ]);

    expect(patients.map((p) => p.patientId)).toEqual(['pa', 'pz']);
  });

  it('groups series that carry no PatientID into one unnamed patient', () => {
    const patients = groupPatients([series(null, { patientId: null }), series(null)]);

    expect(patients).toHaveLength(1);
    expect(patients[0].patientId).toBe('');
  });

  it('returns an empty list for no series', () => {
    expect(groupPatients([])).toEqual([]);
  });
});

describe('addSeriesToCatalog', () => {
  it('merges series across imports into one keyed-by-PatientID hierarchy', () => {
    const first = addSeriesToCatalog(new Map(), [series('s1', { uid: 'a', patientId: 'p1' })]);
    const second = addSeriesToCatalog(first, [series('s1', { uid: 'b', patientId: 'p1' })]);

    expect([...second.keys()]).toEqual(['p1']);
    expect(catalogSeries(second).map((s) => s.uid)).toEqual(['a', 'b']);
  });

  it('dedups by SeriesInstanceUID, keeping the series already present', () => {
    const original = series('s1', { uid: 'a', patientId: 'p1' });
    const first = addSeriesToCatalog(new Map(), [original]);
    const second = addSeriesToCatalog(first, [
      series('s1', { uid: 'a', patientId: 'p1', description: 're-import' }),
      series('s1', { uid: 'b', patientId: 'p1' }),
    ]);

    const merged = catalogSeries(second);
    expect(merged.map((s) => s.uid)).toEqual(['a', 'b']);
    expect(merged.find((s) => s.uid === 'a')).toBe(original);
  });

  it('keeps distinct patients across imports', () => {
    const first = addSeriesToCatalog(new Map(), [series('s1', { uid: 'a', patientId: 'p1' })]);
    const second = addSeriesToCatalog(first, [series('s1', { uid: 'b', patientId: 'p2' })]);

    expect([...second.keys()]).toEqual(['p1', 'p2']);
  });

  it('does not mutate the input catalog', () => {
    const first = addSeriesToCatalog(new Map(), [series('s1', { uid: 'a', patientId: 'p1' })]);
    addSeriesToCatalog(first, [series('s1', { uid: 'b', patientId: 'p1' })]);

    expect(catalogSeries(first).map((s) => s.uid)).toEqual(['a']);
  });
});

describe('catalogSeries', () => {
  it('flattens a catalog back to its series, the inverse of grouping', () => {
    const catalog = addSeriesToCatalog(new Map(), [
      series('s1', { uid: 'a', patientId: 'p1' }),
      series('s2', { uid: 'b', patientId: 'p1' }),
    ]);

    expect(
      catalogSeries(catalog)
        .map((s) => s.uid)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('is empty for an empty catalog', () => {
    expect(catalogSeries(new Map())).toEqual([]);
  });
});

describe('importPatientIds', () => {
  it('lists the distinct PatientIDs in encounter order', () => {
    const ids = importPatientIds([
      series('s1', { uid: 'a', patientId: 'p2' }),
      series('s2', { uid: 'b', patientId: 'p1' }),
      series('s3', { uid: 'c', patientId: 'p2' }),
    ]);

    expect(ids).toEqual(['p2', 'p1']);
  });

  it('keys a series with no PatientID under the empty string', () => {
    expect(importPatientIds([series('s1', { patientId: null })])).toEqual(['']);
  });

  it('is empty for no series', () => {
    expect(importPatientIds([])).toEqual([]);
  });
});

describe('importKeepsOnePatient', () => {
  it('allows the first import when the catalog is empty', () => {
    expect(importKeepsOnePatient(null, [series('s1', { patientId: 'p1' })])).toBe(true);
  });

  it('allows a further import of the same patient', () => {
    expect(importKeepsOnePatient('p1', [series('s1', { patientId: 'p1' })])).toBe(true);
  });

  it('flags an import of a different patient', () => {
    expect(importKeepsOnePatient('p1', [series('s1', { patientId: 'p2' })])).toBe(false);
  });

  it('flags an import spanning several patients, even into an empty catalog', () => {
    const mixed = [
      series('s1', { uid: 'a', patientId: 'p1' }),
      series('s2', { uid: 'b', patientId: 'p2' }),
    ];
    expect(importKeepsOnePatient(null, mixed)).toBe(false);
    expect(importKeepsOnePatient('p1', mixed)).toBe(false);
  });

  it('matches an unidentified import against an unidentified current patient', () => {
    expect(importKeepsOnePatient('', [series('s1', { patientId: null })])).toBe(true);
  });

  it('treats an empty import as a safe no-op', () => {
    expect(importKeepsOnePatient('p1', [])).toBe(true);
  });
});

describe('initialImportSeries', () => {
  it('picks the largest series of the most recent study', () => {
    const chosen = initialImportSeries([
      series('early', { uid: 'a', studyDate: '20240101', imageCount: 300 }),
      series('late', { uid: 'b', studyDate: '20240601', imageCount: 50 }),
      series('late', { uid: 'c', studyDate: '20240601', imageCount: 200 }),
    ]);

    expect(chosen?.uid).toBe('c');
  });

  it('falls back to the largest series when no study is dated', () => {
    const chosen = initialImportSeries([
      series('s', { uid: 'a', imageCount: 10 }),
      series('s', { uid: 'b', imageCount: 80 }),
    ]);

    expect(chosen?.uid).toBe('b');
  });

  it('skips a dose grid even when it is the largest series of the study (#241)', () => {
    const chosen = initialImportSeries([
      series('rt', { uid: 'ct', modality: 'CT', imageCount: 120 }),
      series('rt', { uid: 'dose', modality: 'RTDOSE', imageCount: 300 }),
      series('rt', { uid: 'struct', modality: 'RTSTRUCT', imageCount: 1 }),
    ]);

    expect(chosen?.uid).toBe('ct');
  });

  it('falls back to the largest series when a study holds only ancillary objects', () => {
    const chosen = initialImportSeries([
      series('rt', { uid: 'dose', modality: 'RTDOSE', imageCount: 200 }),
      series('rt', { uid: 'struct', modality: 'RTSTRUCT', imageCount: 1 }),
    ]);

    expect(chosen?.uid).toBe('dose');
  });

  it('returns undefined for an empty import', () => {
    expect(initialImportSeries([])).toBeUndefined();
  });
});
