/// <reference lib="webworker" />

import { parseFileAsync } from '../dicom/loader';
import type { Slice } from '../dicom/types';

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
 * The result of one {@link ParseRequest}: the parsed slices on success, or the
 * error message on failure (the worker never throws across the boundary). On
 * success each slice's pixel buffer is transferred back, not copied.
 */
export type ParseResponse =
  | { readonly id: number; readonly ok: true; readonly slices: Slice[] }
  | { readonly id: number; readonly ok: false; readonly message: string };

/**
 * Thin off-main-thread wrapper around the pure {@link parseFileAsync}: parse one
 * file per message and post its slices back, transferring the pixel buffers so
 * the large arrays move without a copy. All parsing/decoding logic stays in
 * `../dicom`; this file is only the worker plumbing.
 */
addEventListener('message', async (event: MessageEvent<ParseRequest>) => {
  const { id, name, buffer } = event.data;
  try {
    const slices = await parseFileAsync(name, buffer);
    // Transfer each frame's pixel buffer back instead of cloning it.
    const transfer = slices.map((slice) => slice.pixels.buffer);
    postMessage({ id, ok: true, slices } satisfies ParseResponse, transfer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ id, ok: false, message } satisfies ParseResponse);
  }
});
