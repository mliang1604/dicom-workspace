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
}
function recordingCatalog(): RecordingCatalog {
  return {
    adds: 0,
    clears: 0,
    add() {
      this.adds += 1;
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
  it('replaces the view (and catalogs) for a same-patient batch that does not fuse', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(fileDeps({ previous: result('base'), catalog }));
    // previous present but the (default) merge doesn't add → replace.
    expect(outcome).toEqual({ kind: 'replace', result: INCOMING });
    expect(catalog.adds).toBe(1);
    expect(catalog.clears).toBe(0);
  });

  it('fuses as an overlay when the merge adds a layer', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({ previous: result('base'), merge: (_c, i) => merged(i, true), catalog }),
    );
    expect(outcome).toEqual({ kind: 'overlay', result: INCOMING, compare: false });
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

  it('clears the catalog and replaces when a patient switch is confirmed', () => {
    const catalog = recordingCatalog();
    // A switch means the previous view is dropped, so the merge is never consulted.
    const outcome = planFileLoad(
      fileDeps({
        previous: result('base'),
        keepsOnePatient: () => false,
        confirm: () => true,
        merge: () => {
          throw new Error('merge must not run on a patient switch');
        },
        catalog,
      }),
    );
    expect(outcome).toEqual({ kind: 'replace', result: INCOMING });
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
    loadSeries: () => INCOMING,
    merge: (_c, incoming) => ({ result: incoming, added: false }),
    ...overrides,
  };
}

describe('planSeriesLoad', () => {
  it('is a no-op for an already-shown series, without re-parsing', () => {
    const outcome = planSeriesLoad(
      seriesDeps({
        previous: result('shown'),
        series: { uid: 'shown' } as Series,
        loadSeries: () => {
          throw new Error('must not re-parse an already-shown series');
        },
      }),
    );
    expect(outcome).toEqual({ kind: 'noop', compare: false });
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

  it('replaces the view for a fresh series that does not fuse', () => {
    const outcome = planSeriesLoad(seriesDeps({ previous: result('base') }));
    expect(outcome).toEqual({ kind: 'replace', result: INCOMING });
  });

  it('passes the known structure sets to the parser', () => {
    let knownSeen: unknown = 'unset';
    planSeriesLoad(
      seriesDeps({
        previous: result('base'),
        loadSeries: (_s, known) => {
          knownSeen = known;
          return INCOMING;
        },
      }),
    );
    expect(knownSeen).toEqual([]); // the stub's allStructureSets
  });

  it('carries the current registrations into the lazily-built series', () => {
    // A Spatial Registration linking the panel series to the base must survive the
    // lazy build, or the merge sees no registration and refuses to fuse.
    const registrations = [{ name: 'reg' }] as unknown as LoadResult['registrations'];
    let regsSeen: unknown = 'unset';
    planSeriesLoad(
      seriesDeps({
        previous: { ...result('base'), registrations } as LoadResult,
        loadSeries: (_s, _known, regs) => {
          regsSeen = regs;
          return INCOMING;
        },
      }),
    );
    expect(regsSeen).toBe(registrations);
  });

  it('fuses a same-frame series as an overlay', () => {
    const outcome = planSeriesLoad(
      seriesDeps({ previous: result('base'), merge: (_c, i) => merged(i, true) }),
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
