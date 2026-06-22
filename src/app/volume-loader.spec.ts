import {
  baseImageLayer,
  overlayImageLayer,
  type Registration,
  type Slice,
  type Volume,
  type VolumeGeometry,
} from '../dicom/types';
import { invert } from '../dicom/mat4';
import type { Series } from '../dicom/series';
import { doseOverlaySeries, mergeLoad, VolumeLoader, type LoadResult } from './volume-loader';

/** A unit index→patient affine; real loads always carry one (see buildVolume). */
const FAKE_GEOMETRY: VolumeGeometry = {
  iStep: [1, 0, 0],
  jStep: [0, 1, 0],
  kStep: [0, 0, 1],
  origin: [0, 0, 0],
};

/**
 * A minimal volume; the merge reads it through the layer it wraps and, for the
 * overlay-eligibility check, its {@link VolumeGeometry}. Pass `geometry: null` to
 * model a series with no spatial metadata (`null`, not `undefined`, so the
 * default isn't re-applied).
 */
function fakeVolume(
  modality: string | null,
  geometry: VolumeGeometry | null = FAKE_GEOMETRY,
): Volume {
  return {
    dims: [1, 1, 1],
    spacing: [1, 1, 1],
    data: new Float32Array(1),
    min: 0,
    max: 1,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality,
    geometry: geometry ?? undefined,
  };
}

/** A minimal series; only the UID and frame of reference drive the merge rule. */
function fakeSeries(uid: string, frameOfReferenceUid: string | null, modality = 'CT'): Series {
  return {
    uid,
    seriesNumber: 1,
    description: null,
    modality,
    studyUid: null,
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    patientId: null,
    patientName: null,
    frameOfReferenceUid,
    imageCount: 1,
    dims: [1, 1],
    metadata: null,
    slices: [],
  };
}

/** A one-layer load of a single series, as {@link VolumeLoader.loadFromFiles} returns. */
function fakeLoad(
  uid: string,
  frameOfReferenceUid: string | null,
  modality = 'CT',
  geometry: VolumeGeometry | null = FAKE_GEOMETRY,
): LoadResult {
  const series = fakeSeries(uid, frameOfReferenceUid, modality);
  return {
    series: [series],
    selectedUid: uid,
    layers: [baseImageLayer(uid, fakeVolume(modality, geometry))],
    structureSets: [],
    allStructureSets: [],
    registrations: [],
    fileCount: 1,
    sliceCount: 1,
  };
}

/** A 2×2 axial CT slice at z, enough for {@link buildVolume} to assemble a volume. */
function axialSlice(z: number, instanceNumber: number): Slice {
  return {
    name: `slice-${instanceNumber}`,
    columns: 2,
    rows: 2,
    pixelSpacing: [1, 1],
    position: [0, 0, z],
    orientation: [1, 0, 0, 0, 1, 0],
    instanceNumber,
    seriesUid: 'series-1',
    seriesNumber: 1,
    frameOfReferenceUid: 'frame-1',
    seriesDescription: 'Axial',
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
    pixels: new Float32Array([0, 1, 2, 3]),
  };
}

/** A real (slice-backed) series, as the catalog retains for the lazy build. */
function seriesWithSlices(uid: string, frameOfReferenceUid: string | null): Series {
  return {
    ...fakeSeries(uid, frameOfReferenceUid),
    imageCount: 2,
    slices: [axialSlice(0, 1), axialSlice(2, 2)],
  };
}

describe('VolumeLoader.loadSeries', () => {
  it('builds a one-series load from the retained slices on demand', () => {
    const result = new VolumeLoader().loadSeries(seriesWithSlices('ct', 'frame-1'));

    expect(result.selectedUid).toBe('ct');
    expect(result.series.map((s) => s.uid)).toEqual(['ct']);
    expect(result.layers.map((l) => [l.id, l.role])).toEqual([['ct', 'base']]);
    expect(result.layers[0].volume.dims).toEqual([2, 2, 2]);
    expect(result.sliceCount).toBe(2);
  });

  it('associates an earlier structure set with a matching frame of reference', () => {
    const structureSet = {
      seriesUid: 'rt',
      frameOfReferenceUid: 'frame-1',
      rois: [],
    } as unknown as LoadResult['allStructureSets'][number];
    const result = new VolumeLoader().loadSeries(seriesWithSlices('ct', 'frame-1'), [structureSet]);

    expect(result.allStructureSets).toEqual([structureSet]);
    expect(result.structureSets).toEqual([structureSet]);
  });
});

describe('doseOverlaySeries', () => {
  const ct = fakeSeries('ct', 'frame-1', 'CT');

  it('selects a same-frame dose series to overlay above the base', () => {
    const dose = fakeSeries('dose', 'frame-1', 'RTDOSE');
    expect(doseOverlaySeries([ct, dose], ct)).toEqual([dose]);
  });

  it('ignores a dose in a different frame of reference', () => {
    const dose = fakeSeries('dose', 'frame-2', 'RTDOSE');
    expect(doseOverlaySeries([ct, dose], ct)).toEqual([]);
  });

  it('does not auto-overlay a same-frame image series (only dose)', () => {
    const mr = fakeSeries('mr', 'frame-1', 'MR');
    expect(doseOverlaySeries([ct, mr], ct)).toEqual([]);
  });

  it('never overlays the base onto itself', () => {
    const dose = fakeSeries('dose', 'frame-1', 'RTDOSE');
    // When the dose is the base (e.g. dose loaded alone), it isn't its own overlay.
    expect(doseOverlaySeries([dose], dose)).toEqual([]);
  });
});

describe('mergeLoad', () => {
  it('adds the incoming series as an overlay when its frame of reference matches', () => {
    const current = fakeLoad('ct', 'frame-1');
    const incoming = fakeLoad('mr', 'frame-1', 'MR');

    const { result, added } = mergeLoad(current, incoming);

    expect(added).toBe(true);
    expect(result.layers.map((l) => [l.id, l.role])).toEqual([
      ['ct', 'base'],
      ['mr', 'overlay'],
    ]);
    // The base study's fields are kept; only the registry grew.
    expect(result.selectedUid).toBe('ct');
    expect(result.series).toBe(current.series);
  });

  it('replaces when the frames of reference differ (a new study)', () => {
    const current = fakeLoad('ct', 'frame-1');
    const incoming = fakeLoad('ct2', 'frame-2');

    const { result, added } = mergeLoad(current, incoming);

    expect(added).toBe(false);
    expect(result).toBe(incoming);
  });

  it('replaces when either series has no frame of reference', () => {
    expect(mergeLoad(fakeLoad('a', null), fakeLoad('b', null)).added).toBe(false);
    expect(mergeLoad(fakeLoad('a', 'frame-1'), fakeLoad('b', null)).added).toBe(false);
    expect(mergeLoad(fakeLoad('a', null), fakeLoad('b', 'frame-1')).added).toBe(false);
  });

  it('replaces when a volume lacks geometry, even with matching frames', () => {
    // Without an index→patient affine the grids can't be co-sampled, so an
    // overlay would mis-register: fall back to replacing rather than guessing.
    const noGeom = mergeLoad(fakeLoad('ct', 'frame-1'), fakeLoad('mr', 'frame-1', 'MR', null));
    expect(noGeom.added).toBe(false);

    const baseNoGeom = mergeLoad(
      fakeLoad('ct', 'frame-1', 'CT', null),
      fakeLoad('mr', 'frame-1', 'MR'),
    );
    expect(baseNoGeom.added).toBe(false);
  });

  it('stacks a third same-frame series above the existing overlay', () => {
    const base = fakeLoad('ct', 'frame-1');
    const withOverlay = mergeLoad(base, fakeLoad('mr', 'frame-1', 'MR')).result;

    const { result, added } = mergeLoad(withOverlay, fakeLoad('pet', 'frame-1', 'PT'));

    expect(added).toBe(true);
    expect(result.layers.map((l) => l.id)).toEqual(['ct', 'mr', 'pet']);
  });

  it('keeps overlay ids unique when the same series is added twice', () => {
    const base = fakeLoad('ct', 'frame-1');
    const once = mergeLoad(base, fakeLoad('mr', 'frame-1', 'MR')).result;

    const { result } = mergeLoad(once, fakeLoad('mr', 'frame-1', 'MR'));

    expect(result.layers.map((l) => l.id)).toEqual(['ct', 'mr', 'mr#2']);
  });

  it('does not stack the current base series over itself when it is re-loaded (#160)', () => {
    // Re-picking the already-loaded study (same base series UID) must not add the
    // base as an overlay on itself: it replaces, leaving a single CT, not 'ct#2'.
    const current = fakeLoad('ct', 'frame-1');
    const reload = fakeLoad('ct', 'frame-1');

    const { result, added } = mergeLoad(current, reload);

    expect(added).toBe(false);
    expect(result.layers.map((l) => l.id)).toEqual(['ct']);
  });

  it('replaces a re-loaded fused study rather than duplicating its base (#160)', () => {
    // A CT + same-frame RTDOSE load is itself two layers. Re-loading it (e.g. via
    // Recent) must not re-promote the CT base to an overlay; the registry stays
    // [CT base, dose overlay] with no 'ct#2'.
    const fused: LoadResult = {
      ...fakeLoad('ct', 'frame-1'),
      layers: [
        baseImageLayer('ct', fakeVolume('CT')),
        overlayImageLayer('dose', fakeVolume('RTDOSE')),
      ],
    };

    const { result, added } = mergeLoad(fused, fused);

    expect(added).toBe(false);
    expect(result.layers.map((l) => [l.id, l.role])).toEqual([
      ['ct', 'base'],
      ['dose', 'overlay'],
    ]);
  });

  it('does not mutate the current registry', () => {
    const current = fakeLoad('ct', 'frame-1');
    mergeLoad(current, fakeLoad('mr', 'frame-1', 'MR'));
    expect(current.layers.map((l) => l.id)).toEqual(['ct']);
  });

  it('adds a different-frame series as a registered overlay when a registration links them', () => {
    // CT in frame-1, MR in frame-2; a rigid REG (carried on the incoming load)
    // maps the MR (moving) frame onto the CT (fixed) frame, so they fuse.
    const reg: Registration = {
      kind: 'rigid',
      name: 'reg.dcm',
      sourceFrame: 'frame-2',
      targetFrame: 'frame-1',
      matrix: [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1],
      matrixType: 'RIGID',
    };
    const current = fakeLoad('ct', 'frame-1');
    const incoming: LoadResult = { ...fakeLoad('mr', 'frame-2', 'MR'), registrations: [reg] };

    const { result, added } = mergeLoad(current, incoming);

    expect(added).toBe(true);
    expect(result.layers.map((l) => l.id)).toEqual(['ct', 'mr']);
    // The overlay carries the base→overlay transform (here the matrix's inverse,
    // since the base is the registration's target frame).
    const overlay = result.layers[1];
    expect(overlay.alignToBase).toEqual(invert(reg.matrix));
    // The registration is retained on the merged result for later re-resolution.
    expect(result.registrations).toEqual([reg]);
  });

  it('leaves a same-frame overlay without an alignment transform', () => {
    const { result } = mergeLoad(fakeLoad('ct', 'frame-1'), fakeLoad('mr', 'frame-1', 'MR'));
    expect(result.layers[1].alignToBase).toBeUndefined();
  });

  it('still replaces a different-frame series when no registration links them', () => {
    const current = fakeLoad('ct', 'frame-1');
    const incoming = fakeLoad('mr', 'frame-2', 'MR');
    expect(mergeLoad(current, incoming).added).toBe(false);
  });

  it('adds a different-frame series as a deformable overlay when a deformable REG links them', () => {
    const reg: Registration = {
      kind: 'deformable',
      name: 'reg.dcm',
      sourceFrame: 'frame-2', // moving (overlay)
      targetFrame: 'frame-1', // fixed (base)
      preMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      postMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      grid: {
        origin: [0, 0, 0],
        orientation: [1, 0, 0, 0, 1, 0],
        dims: [2, 2, 2],
        spacing: [1, 1, 1],
        vectors: new Float32Array(3 * 8),
      },
    };
    const current = fakeLoad('ct', 'frame-1');
    const incoming: LoadResult = { ...fakeLoad('mr', 'frame-2', 'MR'), registrations: [reg] };

    const { result, added } = mergeLoad(current, incoming);

    expect(added).toBe(true);
    const overlay = result.layers[1];
    expect(overlay.deformation).toBe(reg);
    expect(overlay.alignToBase).toBeUndefined(); // deformable, not rigid
  });
});
