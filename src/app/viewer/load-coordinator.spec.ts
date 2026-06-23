import type { Series } from '../../dicom/series';
import type { LoadResult, MergedLoad } from '../volume-loader';
import {
  cantFuseMessage,
  planFileLoad,
  planSeriesLoad,
  type CatalogOps,
  type FileLoadDeps,
  type SeriesLoadDeps,
} from './load-coordinator';

/** A minimal LoadResult stub: just the fields the load policy reads. */
function result(...layerIds: string[]): LoadResult {
  return {
    series: [{ uid: layerIds[0] ?? 'series' }],
    layers: layerIds.map((id) => ({ id })),
    allStructureSets: [],
  } as unknown as LoadResult;
}

const INCOMING = result('incoming');

/** A recording catalog so we can assert how the policy mutated it. */
interface RecordingCatalog extends CatalogOps {
  adds: number;
  clears: number;
  structureSetAdds: number;
}
function recordingCatalog(): RecordingCatalog {
  return {
    adds: 0,
    clears: 0,
    structureSetAdds: 0,
    add() {
      this.adds += 1;
    },
    addStructureSets() {
      this.structureSetAdds += 1;
    },
    clear() {
      this.clears += 1;
    },
  };
}

function fileDeps(overrides: Partial<FileLoadDeps>): FileLoadDeps {
  return {
    previous: null,
    result: INCOMING,
    intent: 'primary',
    confirm: () => true,
    currentPatientId: 'p1',
    keepsOnePatient: () => true,
    merge: (_c, incoming) => ({ result: incoming, added: false }),
    catalog: recordingCatalog(),
    ...overrides,
  };
}

const merged = (result: LoadResult, added: boolean): MergedLoad => ({ result, added });

describe('cantFuseMessage', () => {
  it('names the action that could not apply and the frame-of-reference reason', () => {
    expect(cantFuseMessage('overlay')).toContain('fuse');
    expect(cantFuseMessage('compare')).toContain('compare');
    expect(cantFuseMessage('overlay')).toContain('frame of reference');
  });
});

describe('planFileLoad — primary', () => {
  it('catalogues a plain import into history without showing it (#241)', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(fileDeps({ previous: result('base'), catalog }));
    // A plain import only ingests — the viewport waits for a history pick.
    expect(outcome).toEqual({ kind: 'imported', cleared: false });
    expect(catalog.adds).toBe(1);
    expect(catalog.clears).toBe(0);
    // The batch's RTSTRUCTs are retained so a later pick can re-associate them (#241).
    expect(catalog.structureSetAdds).toBe(1);
  });

  it('never fuses a plain import — it ingests even when a same-frame merge could add', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({
        previous: result('base'),
        merge: () => {
          throw new Error('a plain import must not merge — it only catalogues');
        },
        catalog,
      }),
    );
    expect(outcome).toEqual({ kind: 'imported', cleared: false });
    expect(catalog.adds).toBe(1);
  });

  it('prompts on a different patient and cancels without touching the catalog', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({ keepsOnePatient: () => false, confirm: () => false, catalog }),
    );
    expect(outcome).toEqual({ kind: 'cancel' });
    expect(catalog.adds).toBe(0);
    expect(catalog.clears).toBe(0);
  });

  it('clears the catalog and reports the switch when a patient switch is confirmed', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({
        previous: result('base'),
        keepsOnePatient: () => false,
        confirm: () => true,
        merge: () => {
          throw new Error('merge must not run on an import');
        },
        catalog,
      }),
    );
    // `cleared` tells the viewer to unload the now-stale view of the old patient.
    expect(outcome).toEqual({ kind: 'imported', cleared: true });
    expect(catalog.clears).toBe(1);
    expect(catalog.adds).toBe(1);
  });
});

describe('planFileLoad — held modifier', () => {
  it('adds the overlay (⌥) for a same-patient, same-frame fuse', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({
        intent: 'overlay',
        previous: result('base'),
        merge: (_c, i) => merged(i, true),
        catalog,
      }),
    );
    expect(outcome).toEqual({ kind: 'overlay', result: INCOMING, compare: false });
    expect(catalog.adds).toBe(1);
  });

  it('opens the compare columns (⇧) for a fuse', () => {
    const outcome = planFileLoad(
      fileDeps({ intent: 'compare', previous: result('base'), merge: (_c, i) => merged(i, true) }),
    );
    expect(outcome).toEqual({ kind: 'overlay', result: INCOMING, compare: true });
  });

  it('rejects (never prompts, never catalogs) when the series cannot fuse', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({
        intent: 'overlay',
        previous: result('base'),
        merge: (_c, i) => merged(i, false),
        confirm: () => {
          throw new Error('a held-modifier load must never prompt');
        },
        catalog,
      }),
    );
    expect(outcome).toEqual({ kind: 'reject', message: cantFuseMessage('overlay') });
    expect(catalog.adds).toBe(0);
  });

  it('rejects a held-modifier load against a different patient without prompting', () => {
    const outcome = planFileLoad(
      fileDeps({ intent: 'compare', previous: result('base'), keepsOnePatient: () => false }),
    );
    expect(outcome).toEqual({ kind: 'reject', message: cantFuseMessage('compare') });
  });
});

function seriesDeps(overrides: Partial<SeriesLoadDeps>): SeriesLoadDeps {
  return {
    previous: null,
    series: { uid: 'incoming' } as Series,
    intent: 'primary',
    knownStructureSets: [],
    loadSeries: () => INCOMING,
    merge: (_c, incoming) => ({ result: incoming, added: false }),
    ...overrides,
  };
}

describe('planSeriesLoad', () => {
  it('is a no-op for an already-shown series under a held modifier, without re-parsing', () => {
    const outcome = planSeriesLoad(
      seriesDeps({
        previous: result('shown'),
        series: { uid: 'shown' } as Series,
        intent: 'overlay',
        loadSeries: () => {
          throw new Error('must not re-parse an already-shown series');
        },
      }),
    );
    expect(outcome).toEqual({ kind: 'noop', compare: false });
  });

  it('reloads (replaces) the current base when it is re-picked as primary (#241)', () => {
    const outcome = planSeriesLoad(
      seriesDeps({ previous: result('shown'), series: { uid: 'shown' } as Series }),
    );
    expect(outcome).toEqual({ kind: 'replace', result: INCOMING });
  });

  it('still opens the compare columns (⇧) for an already-shown series', () => {
    const outcome = planSeriesLoad(
      seriesDeps({
        previous: result('shown'),
        series: { uid: 'shown' } as Series,
        intent: 'compare',
      }),
    );
    expect(outcome).toEqual({ kind: 'noop', compare: true });
  });

  it('replaces the view for a plain (primary) pick', () => {
    const outcome = planSeriesLoad(seriesDeps({ previous: result('base') }));
    expect(outcome).toEqual({ kind: 'replace', result: INCOMING });
  });

  it('replaces (unloads others) on a plain pick even when a same-frame fuse is possible (#241)', () => {
    const outcome = planSeriesLoad(
      seriesDeps({
        previous: result('base'),
        merge: () => {
          throw new Error('a plain pick must not fuse — it replaces');
        },
      }),
    );
    expect(outcome).toEqual({ kind: 'replace', result: INCOMING });
  });

  it('passes the retained structure sets to the parser even with nothing displayed (#241)', () => {
    // The regression fix: an RTSTRUCT imported ingest-only is retained on the
    // catalog and threaded in here, so a primary pick re-associates it by frame
    // of reference even though `previous` is null (nothing was on screen).
    const retained = [{ name: 'rtstruct' }] as unknown as SeriesLoadDeps['knownStructureSets'];
    let knownSeen: unknown = 'unset';
    planSeriesLoad(
      seriesDeps({
        previous: null,
        knownStructureSets: retained,
        loadSeries: (_s, known) => {
          knownSeen = known;
          return INCOMING;
        },
      }),
    );
    expect(knownSeen).toBe(retained);
  });

  it('fuses a same-frame series as an overlay under ⌥', () => {
    const outcome = planSeriesLoad(
      seriesDeps({
        previous: result('base'),
        intent: 'overlay',
        merge: (_c, i) => merged(i, true),
      }),
    );
    expect(outcome).toEqual({ kind: 'overlay', result: INCOMING, compare: false });
  });

  it('rejects a held-modifier panel load that cannot fuse', () => {
    const outcome = planSeriesLoad(
      seriesDeps({
        previous: result('base'),
        intent: 'overlay',
        merge: (_c, i) => merged(i, false),
      }),
    );
    expect(outcome).toEqual({ kind: 'reject', message: cantFuseMessage('overlay') });
  });
});
