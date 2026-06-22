import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearTrace,
  disableTrace,
  dumpTrace,
  enableTrace,
  parseTraceSpec,
  setTraceSink,
  startupConfig,
  trace,
  Tracer,
} from './trace';

describe('Tracer', () => {
  it('returns undefined for a disabled category', () => {
    const tracer = new Tracer(vi.fn());
    expect(tracer.channel('merge')).toBeUndefined();
    expect(tracer.isEnabled('merge')).toBe(false);
  });

  it('emits to the sink when the category is enabled', () => {
    const sink = vi.fn();
    const tracer = new Tracer(sink);
    tracer.enable('merge');
    tracer.channel('merge')?.('frames differ', { baseFrame: 'A' });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({
      seq: 0,
      category: 'merge',
      message: 'frames differ',
      data: { baseFrame: 'A' },
    });
  });

  it('does not evaluate the message or data arguments when disabled', () => {
    // The point of the undefined-return guard: `channel(c)?.(...)` short-circuits,
    // so building a (possibly expensive) payload costs nothing when the category
    // is off. If the optional call evaluated its arguments, `built` would tick up.
    const sink = vi.fn();
    const tracer = new Tracer(sink);
    let built = 0;
    const buildData = () => {
      built += 1;
      return {};
    };
    tracer.channel('merge')?.(`msg ${(built += 1)}`, buildData());
    expect(built).toBe(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it('enable("all") turns on every category', () => {
    const tracer = new Tracer(vi.fn());
    tracer.enable('all');
    expect(tracer.isEnabled('load')).toBe(true);
    expect(tracer.isEnabled('merge')).toBe(true);
    expect(tracer.isEnabled('render')).toBe(true);
  });

  it('disable removes one category, and disable("all") clears every one', () => {
    const tracer = new Tracer(vi.fn());
    tracer.enable('merge', 'load');
    tracer.disable('merge');
    expect(tracer.isEnabled('merge')).toBe(false);
    expect(tracer.isEnabled('load')).toBe(true);
    tracer.disable('all');
    expect(tracer.isEnabled('load')).toBe(false);
  });

  it('buffers events in order and bounds the buffer to its limit', () => {
    const tracer = new Tracer(vi.fn());
    tracer.enable('merge');
    const emit = tracer.channel('merge')!;
    for (let i = 0; i < 1002; i++) emit(`m${i}`);
    const dumped = tracer.dump();
    expect(dumped).toHaveLength(1000);
    // The two oldest were evicted, so the first retained event is the third emitted.
    expect(dumped[0]).toMatchObject({ seq: 2, message: 'm2' });
    expect(dumped[dumped.length - 1]).toMatchObject({ seq: 1001, message: 'm1001' });
  });

  it('clear empties the buffer but keeps the enabled set', () => {
    const tracer = new Tracer(vi.fn());
    tracer.enable('merge');
    tracer.channel('merge')?.('x');
    tracer.clear();
    expect(tracer.dump()).toEqual([]);
    expect(tracer.isEnabled('merge')).toBe(true);
  });
});

describe('parseTraceSpec', () => {
  it('returns no categories for empty input', () => {
    expect(parseTraceSpec(null)).toEqual([]);
    expect(parseTraceSpec(undefined)).toEqual([]);
    expect(parseTraceSpec('')).toEqual([]);
  });

  it('splits, trims, and lowercases category tokens', () => {
    expect(parseTraceSpec(' merge , Align ')).toEqual(['merge', 'align']);
  });

  it('maps "*" and "all" to the all token', () => {
    expect(parseTraceSpec('*')).toEqual(['all']);
    expect(parseTraceSpec('all')).toEqual(['all']);
  });

  it('drops unknown tokens', () => {
    expect(parseTraceSpec('merge,bogus,render')).toEqual(['merge', 'render']);
  });
});

describe('startupConfig', () => {
  const throwingStore = () => {
    throw new Error('localStorage is blocked');
  };

  it('reads the URL query first, without touching storage', () => {
    let read = false;
    const cfg = startupConfig({
      query: '?trace=merge,align',
      readStored: () => {
        read = true;
        return null;
      },
    });
    expect(cfg.categories).toEqual(['merge', 'align']);
    expect(cfg.storageAccessible).toBe(true);
    expect(read).toBe(false);
  });

  it('falls back to the stored spec when there is no query', () => {
    const cfg = startupConfig({ query: '', readStored: () => 'load' });
    expect(cfg.categories).toEqual(['load']);
    expect(cfg.storageAccessible).toBe(true);
  });

  it('reports storage inaccessible when reading throws, leaving categories empty', () => {
    // The toggle is still usable at runtime (and logs to console); only the
    // persisted spec is lost, which is exactly what storageAccessible: false flags.
    const cfg = startupConfig({ query: '', readStored: throwingStore });
    expect(cfg.categories).toEqual([]);
    expect(cfg.storageAccessible).toBe(false);
  });

  it('ignores a query without a trace param and consults storage', () => {
    const cfg = startupConfig({ query: '?other=1', readStored: () => 'render' });
    expect(cfg.categories).toEqual(['render']);
    expect(cfg.storageAccessible).toBe(true);
  });
});

describe('shared tracer convenience', () => {
  afterEach(() => {
    disableTrace('all');
    clearTrace();
  });

  it('routes trace() through the shared tracer and records to the buffer', () => {
    const sink = vi.fn();
    setTraceSink(sink);
    enableTrace('merge');
    trace('merge')?.('hello', { n: 1 });
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'merge', message: 'hello' }),
    );
    expect(dumpTrace().at(-1)).toMatchObject({
      category: 'merge',
      message: 'hello',
      data: { n: 1 },
    });
  });

  it('trace() is undefined while the category is disabled', () => {
    expect(trace('merge')).toBeUndefined();
  });
});
