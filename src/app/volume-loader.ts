import { Injectable } from '@angular/core';
import { parseSlice } from '../dicom/loader';
import { buildVolume } from '../dicom/volume';
import type { Slice, Volume } from '../dicom/types';

/** Outcome of loading a batch of files into a single volume. */
export interface LoadResult {
  readonly volume: Volume;
  /** Number of files the user selected. */
  readonly fileCount: number;
  /** Number of those files that contributed an image slice. */
  readonly sliceCount: number;
}

/**
 * Turns a batch of on-disk DICOM files into a {@link Volume}. Pure parsing and
 * assembly live in `../dicom`; this service is the injectable seam the UI
 * depends on (and the test seam components can replace).
 */
@Injectable({ providedIn: 'root' })
export class VolumeLoader {
  async loadFromFiles(files: readonly File[]): Promise<LoadResult> {
    const slices: Slice[] = [];
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const slice = parseSlice(file.name, buffer);
      if (slice) slices.push(slice);
    }

    const volume = buildVolume(slices);
    return { volume, fileCount: files.length, sliceCount: slices.length };
  }
}
