import { parseFilesInWorkers, type WorkerFactory } from './parse-pool';
import type { Slice, StructureSet } from '../dicom/types';
import type { ParseRequest, ParseResponse } from './parse.worker';

type Listener = (event: unknown) => void;

/** A request posted to a fake worker, awaiting a test-driven response. */
interface Pending {
  readonly worker: FakeWorker;
  readonly req: ParseRequest;
}

/**
 * Stand-in for a {@link file:parse.worker.ts} worker: it records posted requests
 * instead of doing real work and exposes {@link emit} so a test delivers
 * `message`/`error` events back in whatever order it chooses. This lets the spec
 * complete files out of order and check the pool still assembles them in order.
 */
class FakeWorker {
  terminated = false;
  private readonly listeners: Record<string, Listener[]> = { message: [], error: [] };

  constructor(private readonly pending: Pending[]) {}

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== fn);
  }
  postMessage(req: ParseRequest): void {
    this.pending.push({ worker: this, req });
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(type: 'message' | 'error', event: unknown): void {
    for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
  }
}

/** Owns the workers a run spawns and the queue of their in-flight requests. */
class FakeWorkerPool {
  readonly workers: FakeWorker[] = [];
  readonly pending: Pending[] = [];
  readonly create: WorkerFactory = () => {
    const worker = new FakeWorker(this.pending);
    this.workers.push(worker);
    return worker as unknown as Worker;
  };
}

/** A File stub exposing only the `name`/`arrayBuffer` the pool reads. */
function fakeFile(name: string): File {
  return { name, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } as unknown as File;
}

/** A slice/structure-set carrying just a `name`, so output order is checkable. */
function sliceNamed(name: string): Slice {
  return { name } as unknown as Slice;
}
function structNamed(name: string): StructureSet {
  return { name } as unknown as StructureSet;
}

/** A successful response: one slice per file, plus an RTSTRUCT for odd ids. */
function successResponse(req: ParseRequest): ParseResponse {
  return {
    id: req.id,
    ok: true,
    slices: [sliceNamed(req.name)],
    structureSets: req.id % 2 === 1 ? [structNamed(req.name)] : [],
    registrations: [],
  };
}

/** Flush microtasks (and the resolved `arrayBuffer()` hop) via a macrotask. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Drive a run to completion, answering each wave of in-flight requests in
 * reverse order to force out-of-order completion. Returns the order ids were
 * completed in, so a test can confirm it differs from the input order.
 */
async function drainReversed(pool: FakeWorkerPool, total: number): Promise<number[]> {
  const completionOrder: number[] = [];
  while (completionOrder.length < total) {
    await tick();
    const wave = pool.pending.splice(0).reverse();
    for (const { worker, req } of wave) {
      completionOrder.push(req.id);
      worker.emit('message', { data: successResponse(req) });
    }
  }
  return completionOrder;
}

describe('parseFilesInWorkers', () => {
  // Pin the core count so the pool spawns several workers and a wave holds more
  // than one in-flight file (the precondition for out-of-order completion).
  const originalCores = Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency');
  beforeEach(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 4, configurable: true });
  });
  afterEach(() => {
    if (originalCores) Object.defineProperty(navigator, 'hardwareConcurrency', originalCores);
    else delete (navigator as { hardwareConcurrency?: number }).hardwareConcurrency;
  });

  it('returns slices and structure sets in original file order despite out-of-order completion', async () => {
    const pool = new FakeWorkerPool();
    const files = Array.from({ length: 5 }, (_, i) => fakeFile(`f${i}.dcm`));

    const run = parseFilesInWorkers(files, undefined, pool.create);
    const completionOrder = await drainReversed(pool, files.length);
    const result = await run;

    // Completion really happened out of order, but output is still file order.
    expect(completionOrder).not.toEqual([0, 1, 2, 3, 4]);
    expect(result.slices.map((s) => s.name)).toEqual([
      'f0.dcm',
      'f1.dcm',
      'f2.dcm',
      'f3.dcm',
      'f4.dcm',
    ]);
    expect(result.structureSets.map((s) => s.name)).toEqual(['f1.dcm', 'f3.dcm']);
  });

  it('fires progress once per file, from 0 up to the total', async () => {
    const pool = new FakeWorkerPool();
    const files = Array.from({ length: 5 }, (_, i) => fakeFile(`f${i}.dcm`));
    const loaded: number[] = [];

    const run = parseFilesInWorkers(
      files,
      (n, total) => {
        expect(total).toBe(5);
        loaded.push(n);
      },
      pool.create,
    );
    await drainReversed(pool, files.length);
    await run;

    expect(loaded).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('terminates every spawned worker once done', async () => {
    const pool = new FakeWorkerPool();
    const files = Array.from({ length: 3 }, (_, i) => fakeFile(`f${i}.dcm`));

    const run = parseFilesInWorkers(files, undefined, pool.create);
    await drainReversed(pool, files.length);
    await run;

    expect(pool.workers.length).toBeGreaterThan(0);
    expect(pool.workers.every((w) => w.terminated)).toBe(true);
  });

  it('rejects with the offending file name when a worker errors', async () => {
    const pool = new FakeWorkerPool();
    const run = parseFilesInWorkers([fakeFile('bad.dcm')], undefined, pool.create);
    await tick();

    pool.pending[0].worker.emit('error', { message: '' });

    await expect(run).rejects.toThrow('Failed to parse bad.dcm.');
    expect(pool.workers.every((w) => w.terminated)).toBe(true);
  });

  it('rejects with the worker-reported message on a parse failure', async () => {
    const pool = new FakeWorkerPool();
    const run = parseFilesInWorkers([fakeFile('weird.dcm')], undefined, pool.create);
    await tick();

    const { worker, req } = pool.pending[0];
    worker.emit('message', {
      data: { id: req.id, ok: false, message: 'Unsupported transfer syntax' },
    });

    await expect(run).rejects.toThrow('Unsupported transfer syntax');
  });

  it('does no work and spawns no workers for an empty selection', async () => {
    const pool = new FakeWorkerPool();
    const result = await parseFilesInWorkers([], undefined, pool.create);

    expect(result).toEqual({ slices: [], structureSets: [], registrations: [] });
    expect(pool.workers).toHaveLength(0);
  });
});
