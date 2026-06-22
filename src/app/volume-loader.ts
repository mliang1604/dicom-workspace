import { Injectable } from '@angular/core';
import { buildVolume } from '../dicom/volume';
import { initialImportSeries } from '../dicom/catalog';
import { groupSeries, type Series } from '../dicom/series';
import { structureSetsForSeries } from '../dicom/structure-set';
import {
  baseImageLayer,
  baseLayer,
  framesMatch,
  overlayImageLayer,
  type Layer,
  type Registration,
  type StructureSet,
} from '../dicom/types';
import { parseFilesInWorkers, type LoadProgress } from './parse-pool';

/**
 * Outcome of loading a batch of files: the series found across them and the one
 * currently assembled into the {@link layers} registry. A folder may hold several
 * series; the grouped slices are kept so switching selection rebuilds without
 * re-reading.
 */
export interface LoadResult {
  /** Every series found, in picker order. */
  readonly series: readonly Series[];
  /** UID of the series whose slices were built into the base {@link layers} entry. */
  readonly selectedUid: string;
  /**
   * The loaded volumes as an ordered layer registry, keyed by {@link Layer.id}.
   * A single-series load holds exactly one entry, role `'base'`, wrapping the
   * volume assembled from the selected series; fusion (CT + dose) and compare
   * will add `'overlay'` layers above it. Read the base with
   * {@link import('../dicom/types').baseLayer}.
   */
  readonly layers: readonly Layer[];
  /**
   * Structure sets (RTSTRUCT) that annotate the selected series, matched by
   * frame of reference (see {@link structureSetsForSeries}). Empty when the load
   * held no RTSTRUCT or none referenced the selected series. Their contour
   * points are in patient coordinates; map them with
   * {@link import('../dicom/volume').patientToVoxel} against the base layer's
   * volume.
   */
  readonly structureSets: readonly StructureSet[];
  /**
   * Every structure set parsed in the load, regardless of which series it
   * annotates. Retained so {@link VolumeLoader.selectSeries} can re-associate
   * against a different series without re-parsing; the UI should read
   * {@link structureSets} for the current selection.
   */
  readonly allStructureSets: readonly StructureSet[];
  /**
   * Spatial Registration objects (rigid or deformable) parsed in the load,
   * regardless of which frames they link. Retained like {@link allStructureSets}
   * so a later selection or merge can resolve cross-frame alignment without
   * re-parsing. Empty when the load held no registration. Nothing consumes these
   * yet — Phase 1 (rigid) and Phase 2 (deformable) wire them into fusion.
   */
  readonly registrations: readonly Registration[];
  /** Number of files the user selected. */
  readonly fileCount: number;
  /** Number of image slices the selected series contributed. */
  readonly sliceCount: number;
}

/**
 * Turns a batch of on-disk DICOM files into a {@link Volume}. Pure parsing and
 * assembly live in `../dicom`; this service is the injectable seam the UI
 * depends on (and the test seam components can replace).
 */
@Injectable({ providedIn: 'root' })
export class VolumeLoader {
  /**
   * Parse and assemble a batch of files. Parsing runs off the main thread in a
   * worker pool (see {@link parseFilesInWorkers}) so a large folder doesn't
   * freeze the UI; {@link onProgress} reports files parsed / total as it goes.
   * Assembly (grouping + {@link buildVolume}) stays on the main thread.
   */
  async loadFromFiles(files: readonly File[], onProgress?: LoadProgress): Promise<LoadResult> {
    const { slices, structureSets, registrations } = await parseFilesInWorkers(files, onProgress);

    const series = groupSeries(slices);
    // initialImportSeries returns undefined only for an empty batch; assemble it to
    // throw the canonical "no slices" error in that case.
    const selected = initialImportSeries(series);
    if (!selected) buildVolume(slices); // throws the canonical "no slices" error

    return this.buildResult(series, selected!, structureSets, registrations, files.length);
  }

  /**
   * Rebuild the result for a different series of an existing load — the picker's
   * selection — reusing the already-parsed slices and re-associating the
   * structure sets to the newly-selected series.
   */
  selectSeries(result: LoadResult, uid: string): LoadResult {
    const series = result.series.find((s) => s.uid === uid);
    if (!series) return result;
    return this.buildResult(
      result.series,
      series,
      result.allStructureSets,
      result.registrations,
      result.fileCount,
    );
  }

  /**
   * Build a load result for a single catalog {@link Series} — the history
   * panel's on-demand ("lazy") build. The series retains its parsed slices, so
   * the volume is assembled here ({@link buildVolume}) without re-reading files.
   * Structure sets parsed in an earlier load are carried through so an RTSTRUCT
   * still annotates a series it references (matched by frame of reference); pass
   * the current view's `allStructureSets`, or none. The viewer routes the result
   * through {@link merge} for the same-FoR-fuses / different-study-replaces rule.
   */
  loadSeries(
    series: Series,
    allStructureSets: readonly StructureSet[] = [],
    registrations: readonly Registration[] = [],
  ): LoadResult {
    return this.buildResult(
      [series],
      series,
      allStructureSets,
      registrations,
      series.slices.length,
    );
  }

  /**
   * Fold a freshly loaded batch into what's already shown. See {@link mergeLoad};
   * the injectable method just delegates so the viewer can go through the loader
   * seam, while the pure decision stays unit-testable.
   */
  merge(current: LoadResult, incoming: LoadResult): MergedLoad {
    return mergeLoad(current, incoming);
  }

  private buildResult(
    series: readonly Series[],
    selected: Series,
    allStructureSets: readonly StructureSet[],
    registrations: readonly Registration[],
    fileCount: number,
  ): LoadResult {
    const baseVolume = buildVolume(selected.slices);
    const layers: Layer[] = [baseImageLayer(selected.uid, baseVolume)];
    // A same-frame dose grid in the same load joins as a fusion overlay above the
    // base (the CT + dose case), so dropping the pair shows the wash immediately.
    // Co-sampling needs both grids' geometry, so a geometry-less series is skipped.
    if (baseVolume.geometry) {
      for (const s of doseOverlaySeries(series, selected)) {
        const overlayVolume = buildVolume(s.slices);
        if (overlayVolume.geometry) layers.push(overlayImageLayer(s.uid, overlayVolume));
      }
    }
    return {
      series,
      selectedUid: selected.uid,
      layers,
      structureSets: structureSetsForSeries(allStructureSets, selected),
      allStructureSets,
      registrations,
      fileCount,
      sliceCount: selected.slices.length,
    };
  }
}

/**
 * The series in a load that should sit above `selected` (the base) as fusion
 * overlays: a same-frame-of-reference dose grid (RTDOSE) other than the base —
 * the CT + dose case. Image series are left as selectable series, not forced
 * overlays, so an ordinary multi-series study isn't auto-fused. Pure for testing.
 */
export function doseOverlaySeries(series: readonly Series[], selected: Series): Series[] {
  return series.filter(
    (s) =>
      s.uid !== selected.uid &&
      s.modality === 'RTDOSE' &&
      framesMatch(s.frameOfReferenceUid, selected.frameOfReferenceUid),
  );
}

/**
 * How a freshly loaded batch joined the current view: either *added* above it as
 * an overlay layer (same patient/placement) or *replaced* it (a different study).
 * The viewer keeps its view state (zoom/pan/window) on an add and resets it on a
 * replace, so the distinction is surfaced rather than hidden inside the result.
 */
export interface MergedLoad {
  /** The registry to show: the current load grown by an overlay, or the incoming load. */
  readonly result: LoadResult;
  /** True when {@link result} added the incoming series as an overlay layer. */
  readonly added: boolean;
}

/**
 * Decide how a freshly loaded `incoming` batch joins the `current` view and
 * produce the merged result.
 *
 * When the incoming selected series shares the current base layer's frame of
 * reference, it images the same patient in the same placement, so it's *added*
 * as a translucent overlay layer above the base (which stays). Otherwise it's a
 * different study and *replaces* the current load. A series with no frame of
 * reference never matches, so it always replaces — there's nothing to align it
 * against.
 *
 * Pure for unit testing the add-vs-replace rule and the resulting registry.
 */
export function mergeLoad(current: LoadResult, incoming: LoadResult): MergedLoad {
  if (!sameFrameOfReference(current, incoming)) return { result: incoming, added: false };

  // Co-sampling an overlay in the base's patient frame maps each pane pixel
  // through both grids' index→patient affines, so both volumes need geometry;
  // without it (a series with no spatial metadata) they can't be aligned and we
  // fall back to replacing rather than stacking a mis-registered overlay.
  const baseVolume = baseLayer(current.layers)?.volume;
  const overlayVolume = baseLayer(incoming.layers)?.volume;
  if (!baseVolume?.geometry || !overlayVolume?.geometry) {
    return { result: incoming, added: false };
  }

  // Re-loading the series that's already the base would stack the image on top of
  // itself — the "double CT in overlays" of issue #160 (e.g. re-picking the same
  // study from Recent, which re-opens the picker for the same folder). Replace
  // with the freshly built registry instead, so the study — and any same-frame
  // dose it auto-promotes to an overlay — shows exactly once rather than twice.
  if (baseLayer(current.layers)?.id === incoming.selectedUid) {
    return { result: incoming, added: false };
  }

  const overlay = overlayImageLayer(
    uniqueLayerId(current.layers, incoming.selectedUid),
    overlayVolume,
  );
  // Keep any registration that arrived with the incoming series alongside the
  // current load's, so a REG dropped with the moving image is available to align
  // the overlay (consumed in Phase 1+).
  const registrations = [...current.registrations, ...incoming.registrations];
  return {
    result: { ...current, layers: [...current.layers, overlay], registrations },
    added: true,
  };
}

/**
 * Whether the two loads' selected series share a (non-null) frame of reference —
 * the rule for adding an overlay rather than replacing. A null frame of reference
 * never matches, even another null, since it gives nothing to align against.
 */
function sameFrameOfReference(a: LoadResult, b: LoadResult): boolean {
  return framesMatch(
    selectedSeries(a)?.frameOfReferenceUid ?? null,
    selectedSeries(b)?.frameOfReferenceUid ?? null,
  );
}

/** The series a load currently shows (its base layer's source), or undefined. */
function selectedSeries(result: LoadResult): Series | undefined {
  return result.series.find((s) => s.uid === result.selectedUid);
}

/**
 * A layer id unique within `layers`, preferring `desired` (the series UID) and
 * suffixing `#2`, `#3`… when it's already taken — e.g. the same series added as
 * an overlay twice — so the registry stays keyable without collisions.
 */
function uniqueLayerId(layers: readonly Layer[], desired: string): string {
  const used = new Set(layers.map((layer) => layer.id));
  if (!used.has(desired)) return desired;
  for (let n = 2; ; n++) {
    const candidate = `${desired}#${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
