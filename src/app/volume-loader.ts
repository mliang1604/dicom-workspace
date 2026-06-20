import { Injectable } from '@angular/core';
import { buildVolume } from '../dicom/volume';
import { groupSeries, largestSeries, type Series } from '../dicom/series';
import { structureSetsForSeries } from '../dicom/structure-set';
import type { StructureSet, Volume } from '../dicom/types';
import { parseFilesInWorkers, type LoadProgress } from './parse-pool';

/**
 * Outcome of loading a batch of files: the series found across them and the one
 * currently assembled into {@link volume}. A folder may hold several series; the
 * grouped slices are kept so switching selection rebuilds without re-reading.
 */
export interface LoadResult {
  /** Every series found, in picker order. */
  readonly series: readonly Series[];
  /** UID of the series whose slices were built into {@link volume}. */
  readonly selectedUid: string;
  /** The volume assembled from the selected series. */
  readonly volume: Volume;
  /**
   * Structure sets (RTSTRUCT) that annotate the selected series, matched by
   * frame of reference (see {@link structureSetsForSeries}). Empty when the load
   * held no RTSTRUCT or none referenced the selected series. Their contour
   * points are in patient coordinates; map them with
   * {@link import('../dicom/volume').patientToVoxel} against {@link volume}.
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

  private buildResult(
    series: readonly Series[],
    selected: Series,
    allStructureSets: readonly StructureSet[],
    fileCount: number,
  ): LoadResult {
    return {
      series,
      selectedUid: selected.uid,
      volume: buildVolume(selected.slices),
      structureSets: structureSetsForSeries(allStructureSets, selected),
      allStructureSets,
      fileCount,
      sliceCount: selected.slices.length,
    };
  }
}
