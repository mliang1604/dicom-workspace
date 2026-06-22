/// <reference lib="webworker" />

import { parseFileAsync } from '../dicom/loader';
import { parseRegistration } from '../dicom/registration';
import { parseStructureSet } from '../dicom/structure-set';
import type { Registration, Slice, StructureSet } from '../dicom/types';

/**
 * A request to parse one file: the file's bytes plus the id used to pair the
 * response with its caller. The {@link buffer} is transferred in (not copied),
 * so the main thread must not reuse it after posting.
 */
export interface ParseRequest {
  readonly id: number;
  readonly name: string;
  readonly buffer: ArrayBuffer;
}

/**
 * The result of one {@link ParseRequest}: the parsed image slices and structure
 * sets on success, or the error message on failure (the worker never throws
 * across the boundary). On success each slice's pixel buffer is transferred
 * back, not copied. `structureSets` holds the file's RTSTRUCT and
 * `registrations` its Spatial Registration when it is one of those (they carry no
 * pixel buffers, so they are cloned, not transferred); both empty otherwise.
 */
export type ParseResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly slices: Slice[];
      readonly structureSets: StructureSet[];
      readonly registrations: Registration[];
    }
  | { readonly id: number; readonly ok: false; readonly message: string };

/**
 * Thin off-main-thread wrapper around the pure parsers: parse one file per
 * message and post its slices (and any RTSTRUCT or registration) back,
 * transferring the pixel buffers so the large arrays move without a copy. An
 * RTSTRUCT or registration carries no PixelData, so {@link parseFileAsync} yields
 * no slices for it; only then do we try {@link parseStructureSet} and, failing
 * that, {@link parseRegistration} — each returns null for files of the other
 * kinds. All parsing/decoding logic stays in `../dicom`; this file is only the
 * worker plumbing.
 */
addEventListener('message', async (event: MessageEvent<ParseRequest>) => {
  const { id, name, buffer } = event.data;
  try {
    const slices = await parseFileAsync(name, buffer);
    const structureSet = slices.length === 0 ? parseStructureSet(name, buffer) : null;
    const structureSets = structureSet ? [structureSet] : [];
    // Only a non-image, non-RTSTRUCT file can be a registration; try it last.
    const registration =
      slices.length === 0 && !structureSet ? parseRegistration(name, buffer) : null;
    const registrations = registration ? [registration] : [];
    // Transfer each frame's pixel buffer back instead of cloning it.
    const transfer = slices.map((slice) => slice.pixels.buffer);
    postMessage(
      { id, ok: true, slices, structureSets, registrations } satisfies ParseResponse,
      transfer,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ id, ok: false, message } satisfies ParseResponse);
  }
});
