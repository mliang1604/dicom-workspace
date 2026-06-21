import type { Series } from './series';

/**
 * One DICOM study: the series acquired in a single examination, sharing a
 * StudyInstanceUID, with the descriptive fields a timeline needs lifted from a
 * representative series.
 */
export interface StudyRecord {
  /** StudyInstanceUID; the empty string for series that carry no UID. */
  readonly studyUid: string;
  /** StudyDate (raw DICOM `DA`, `YYYYMMDD`); null when absent. Orders the timeline. */
  readonly date: string | null;
  /** StudyTime (raw DICOM `TM`); null when absent. Tie-breaks same-date studies. */
  readonly time: string | null;
  /** StudyDescription for the label; null when absent. */
  readonly description: string | null;
  /** The distinct modalities present across the study's series, in encounter order. */
  readonly modalities: readonly string[];
  /** The study's series, in the order {@link groupStudies} received them. */
  readonly series: Series[];
}

/**
 * One patient: the studies sharing a PatientID, each a {@link StudyRecord}
 * ordered along the longitudinal timeline.
 */
export interface PatientRecord {
  /** PatientID; the empty string for series that carry no ID. */
  readonly patientId: string;
  /** PatientName (raw DICOM `PN`) lifted from a representative series; null when absent. */
  readonly name: string | null;
  /** The patient's studies, ordered by date ascending (undated last). */
  readonly studies: StudyRecord[];
}

/**
 * Group a flat list of series into studies by StudyInstanceUID.
 *
 * A loaded folder may span several studies (e.g. a baseline and a follow-up);
 * this splits them so a longitudinal timeline can show one entry per
 * examination. The descriptive fields (date, time, description, patient) are
 * lifted from the first series of each group, mirroring how {@link groupSeries}
 * lifts series fields from a slice. Series without a UID fall into a single
 * unnamed study. Studies are ordered by StudyDate ascending — those without a
 * date sort last — tie-broken by StudyTime then UID so the timeline is
 * deterministic.
 */
export function groupStudies(series: readonly Series[]): StudyRecord[] {
  const byUid = new Map<string, Series[]>();
  for (const s of series) {
    const uid = s.studyUid ?? '';
    const group = byUid.get(uid);
    if (group) group.push(s);
    else byUid.set(uid, [s]);
  }

  const studies: StudyRecord[] = [];
  for (const [studyUid, group] of byUid) {
    const first = group[0];
    studies.push({
      studyUid,
      date: first.studyDate,
      time: first.studyTime,
      description: first.studyDescription,
      modalities: distinctModalities(group),
      series: group,
    });
  }

  return studies.sort(compareStudies);
}

/**
 * Group a flat list of series into patients by PatientID, each patient's studies
 * grouped and ordered by {@link groupStudies}.
 *
 * Series without an ID fall into a single unnamed patient. Patients are ordered
 * by PatientID for stability; the meaningful ordering — the longitudinal
 * timeline — lives within each patient's studies.
 */
export function groupPatients(series: readonly Series[]): PatientRecord[] {
  const byId = new Map<string, Series[]>();
  for (const s of series) {
    const id = s.patientId ?? '';
    const group = byId.get(id);
    if (group) group.push(s);
    else byId.set(id, [s]);
  }

  const patients: PatientRecord[] = [];
  for (const [patientId, group] of byId) {
    patients.push({
      patientId,
      name: group[0].patientName,
      studies: groupStudies(group),
    });
  }

  return patients.sort((a, b) => compareStrings(a.patientId, b.patientId));
}

/** The distinct, non-null modalities across a study's series, in encounter order. */
function distinctModalities(series: readonly Series[]): string[] {
  const seen = new Set<string>();
  const modalities: string[] = [];
  for (const s of series) {
    if (s.modality !== null && !seen.has(s.modality)) {
      seen.add(s.modality);
      modalities.push(s.modality);
    }
  }
  return modalities;
}

/**
 * Order studies by StudyDate ascending (absent last), then by StudyTime (absent
 * last), then by UID for stability. `YYYYMMDD` / DICOM `TM` strings compare
 * correctly lexicographically, so no parsing is needed.
 */
function compareStudies(a: StudyRecord, b: StudyRecord): number {
  const byDate = compareNullableLast(a.date, b.date);
  if (byDate !== 0) return byDate;
  const byTime = compareNullableLast(a.time, b.time);
  if (byTime !== 0) return byTime;
  return compareStrings(a.studyUid, b.studyUid);
}

/** Compare two optional strings ascending, sorting null/absent values last. */
function compareNullableLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareStrings(a, b);
}

/** Stable ascending comparison of two strings. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
