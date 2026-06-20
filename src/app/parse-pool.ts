import type { Slice } from '../dicom/types';
import type { ParseRequest, ParseResponse } from './parse.worker';

/** Reports parse progress: files finished out of the total selected. */
export type LoadProgress = (loaded: number, total: number) => void;

/**
 * Upper bound on the worker pool size. Parsing is CPU-bound, so a handful of
 * workers saturates a typical machine; more would just contend. Capped further
 * by the file count and the hardware's reported core count.
 */
const MAX_WORKERS = 4;

/** Spawn a module worker running {@link file:parse.worker.ts}. */
function createWorker(): Worker {
  return new Worker(new URL('./parse.worker', import.meta.url), { type: 'module' });
}

/**
 * Parse a batch of DICOM files off the main thread, keeping the UI responsive.
 *
 * Files are read on the main thread (async, non-blocking) and parsed in a small
 * pool of {@link file:parse.worker.ts} workers, with their pixel buffers
 * transferred in and back rather than copied. Slices are returned in the
 * original file order — identical to a sequential parse — regardless of which
 * worker finishes first, so the assembled volume is unchanged. {@link onProgress}
 * fires once per finished file.
 *
 * Rejects with the first file's parse error (e.g. an unsupported transfer
 * syntax), matching the previous synchronous behaviour.
 */
export async function parseFilesInWorkers(
  files: readonly File[],
  onProgress?: LoadProgress,
): Promise<Slice[]> {
  const total = files.length;
  onProgress?.(0, total);
  if (total === 0) return [];

  // One result bucket per file, filled at the file's original index so the
  // flattened output preserves selection order despite out-of-order completion.
  const perFile: Slice[][] = new Array(total);
  let nextIndex = 0;
  let completed = 0;

  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || MAX_WORKERS;
  const workerCount = Math.min(MAX_WORKERS, total, cores);
  const workers = Array.from({ length: workerCount }, createWorker);

  /** Pull files off the shared queue until it's drained, parsing each in turn. */
  const runWorker = async (worker: Worker): Promise<void> => {
    for (let index = nextIndex++; index < total; index = nextIndex++) {
      const file = files[index];
      const buffer = await file.arrayBuffer();
      perFile[index] = await parseInWorker(worker, index, file.name, buffer);
      onProgress?.(++completed, total);
    }
  };

  try {
    await Promise.all(workers.map(runWorker));
  } finally {
    for (const worker of workers) worker.terminate();
  }

  return perFile.flat();
}

/**
 * Post one file to a worker and await its parsed slices. Each worker handles a
 * single file at a time, so at most one request is in flight per worker.
 */
function parseInWorker(
  worker: Worker,
  id: number,
  name: string,
  buffer: ArrayBuffer,
): Promise<Slice[]> {
  return new Promise<Slice[]>((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (event: MessageEvent<ParseResponse>) => {
      const data = event.data;
      if (data.id !== id) return; // not this request's response
      cleanup();
      if (data.ok) resolve(data.slices);
      else reject(new Error(data.message));
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || `Failed to parse ${name}.`));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    // Transfer the file bytes in; the main thread no longer needs them.
    worker.postMessage({ id, name, buffer } satisfies ParseRequest, [buffer]);
  });
}
