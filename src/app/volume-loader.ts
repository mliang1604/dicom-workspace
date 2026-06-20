import { Injectable } from '@angular/core';
import { buildVolume } from '../dicom/volume';
import { groupSeries, largestSeries, type Series } from '../dicom/series';
import type { Volume } from '../dicom/types';
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
    const slices = await parseFilesInWorkers(files, onProgress);

    const series = groupSeries(slices);
    if (series.length === 0) buildVolume(slices); // throws the canonical "no slices" error

    return this.buildResult(series, largestSeries(series), files.length);
  }

  /**
   * Rebuild the result for a different series of an existing load — the picker's
   * selection — reusing the already-parsed slices.
   */
  selectSeries(result: LoadResult, uid: string): LoadResult {
    const series = result.series.find((s) => s.uid === uid);
    if (!series) return result;
    return this.buildResult(result.series, series, result.fileCount);
  }

  private buildResult(series: readonly Series[], selected: Series, fileCount: number): LoadResult {
    return {
      series,
      selectedUid: selected.uid,
      volume: buildVolume(selected.slices),
      fileCount,
      sliceCount: selected.slices.length,
    };
  }
}
