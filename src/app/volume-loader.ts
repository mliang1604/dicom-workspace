import { Injectable } from '@angular/core';
import { buildVolume } from '../dicom/volume';
import { groupSeries, largestSeries, type Series } from '../dicom/series';
import { structureSetsForSeries } from '../dicom/structure-set';
import {
  baseImageLayer,
  baseLayer,
  overlayImageLayer,
  type Layer,
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
    const { slices, structureSets } = await parseFilesInWorkers(files, onProgress);

    const series = groupSeries(slices);
    if (series.length === 0) buildVolume(slices); // throws the canonical "no slices" error

    return this.buildResult(series, largestSeries(series), structureSets, files.length);
  }

  /**
   * Rebuild the result for a different series of an existing load — the picker's
   * selection — reusing the already-parsed slices and re-associating the
   * structure sets to the newly-selected series.
   */
  selectSeries(result: LoadResult, uid: string): LoadResult {
    const series = result.series.find((s) => s.uid === uid);
    if (!series) return result;
    return this.buildResult(result.series, series, result.allStructureSets, result.fileCount);
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
    fileCount: number,
  ): LoadResult {
    return {
      series,
      selectedUid: selected.uid,
      layers: [baseImageLayer(selected.uid, buildVolume(selected.slices))],
      structureSets: structureSetsForSeries(allStructureSets, selected),
      allStructureSets,
      fileCount,
      sliceCount: selected.slices.length,
    };
  }
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

  const volume = baseLayer(incoming.layers)?.volume;
  if (!volume) return { result: incoming, added: false };

  const overlay = overlayImageLayer(uniqueLayerId(current.layers, incoming.selectedUid), volume);
  return { result: { ...current, layers: [...current.layers, overlay] }, added: true };
}

/**
 * Whether the two loads' selected series share a (non-null) frame of reference —
 * the rule for adding an overlay rather than replacing. A null frame of reference
 * never matches, even another null, since it gives nothing to align against.
 */
function sameFrameOfReference(a: LoadResult, b: LoadResult): boolean {
  const frame = selectedSeries(a)?.frameOfReferenceUid ?? null;
  return frame !== null && frame === (selectedSeries(b)?.frameOfReferenceUid ?? null);
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
