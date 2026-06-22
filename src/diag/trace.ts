/**
 * Toggleable, near-zero-cost tracing for diagnosing load / fusion / render
 * decisions that otherwise fail silently (e.g. why an overlay refuses to fuse).
 *
 * Off by default. Output always goes to the console; only the *persisted* config
 * uses storage, so two of the three toggles work even when `localStorage` is
 * inaccessible (Safari private mode, a sandboxed iframe). Turn categories on
 * without a rebuild via any of:
 *   - localStorage: `localStorage['dicom-workspace.trace'] = 'load,merge'`, reload;
 *   - URL query: append `?trace=load,merge` (or `?trace=all`) — no storage needed;
 *   - the console at runtime: `__trace__.enable('merge')` — no storage needed.
 * When storage is blocked, `install` says so once and points at the runtime toggle.
 *
 * At a trace point:
 *   trace('merge')?.('frames neither match nor are linked', { baseFrame, overlayFrame });
 *
 * `trace(category)` returns an emit function only while the category is enabled,
 * otherwise `undefined`. Combined with optional-call (`?.`), neither the message
 * nor the data argument is evaluated when the category is off — so a trace point
 * left in shipped code costs a single `Set` lookup. Emitted events are also kept
 * in a bounded ring buffer; `__trace__.dump()` returns them for copy-paste out of
 * a reproduction.
 *
 * Scope: main thread only. Web Workers have no `localStorage`, so the parsers that
 * run there (see `parse.worker`) aren't traced; their results are traced on the
 * main thread where they land (see `volume-loader`). To trace inside a worker
 * later, pass the active spec through the parse request.
 */

/** The trace categories, as an `as const` tuple so the type stays a checked union. */
export const TRACE_CATEGORIES = ['load', 'merge', 'align', 'render', 'gpu'] as const;
export type TraceCategory = (typeof TRACE_CATEGORIES)[number];

/** One recorded trace point. */
export interface TraceEvent {
  /** Monotonic sequence number, so a {@link Tracer.dump} preserves emission order. */
  readonly seq: number;
  readonly category: TraceCategory;
  readonly message: string;
  /** Optional structured payload, kept by reference (don't mutate after tracing). */
  readonly data?: unknown;
}

/** Emits one trace event for an enabled category. */
export type TraceFn = (message: string, data?: unknown) => void;

/** Where emitted events go. Swapped in tests; defaults to {@link consoleSink}. */
export type TraceSink = (event: TraceEvent) => void;

/** How many recent events the ring buffer retains for {@link Tracer.dump}. */
const BUFFER_LIMIT = 1000;

/** localStorage key under which an enabled-category spec persists across reloads. */
const TRACE_STORAGE_KEY = 'dicom-workspace.trace';

/**
 * The tracer core: a set of enabled categories, a pluggable sink, and a bounded
 * ring buffer. Exported as a class so tests drive it with a fake sink without
 * touching the module singleton or the environment; app code uses the {@link
 * trace} convenience bound to the shared {@link defaultTracer}.
 */
export class Tracer {
  private readonly enabled = new Set<TraceCategory>();
  private readonly buffer: TraceEvent[] = [];
  private seq = 0;

  constructor(private sink: TraceSink = consoleSink) {}

  /** Turn categories on; `'all'` enables every known category. */
  enable(...categories: readonly (TraceCategory | 'all')[]): void {
    for (const c of categories) {
      if (c === 'all') for (const known of TRACE_CATEGORIES) this.enabled.add(known);
      else if ((TRACE_CATEGORIES as readonly string[]).includes(c)) this.enabled.add(c);
    }
  }

  /** Turn categories off; `'all'` disables everything. */
  disable(...categories: readonly (TraceCategory | 'all')[]): void {
    for (const c of categories) {
      if (c === 'all') this.enabled.clear();
      else this.enabled.delete(c);
    }
  }

  /** Whether a category is currently traced. */
  isEnabled(category: TraceCategory): boolean {
    return this.enabled.has(category);
  }

  /** The enabled categories, for the runtime console helper. */
  active(): TraceCategory[] {
    return [...this.enabled];
  }

  /**
   * An emit function for `category` when it's enabled, else `undefined`. The
   * undefined return is the zero-cost guard: `channel(c)?.(msg, data)` evaluates
   * neither `msg` nor `data` when the category is off.
   */
  channel(category: TraceCategory): TraceFn | undefined {
    if (!this.enabled.has(category)) return undefined;
    return (message, data) => this.record(category, message, data);
  }

  /** Recent events in emission order (oldest first), copied so callers can't mutate the buffer. */
  dump(): TraceEvent[] {
    return [...this.buffer];
  }

  /** Drop the buffered events (leaves the enabled set untouched). */
  clear(): void {
    this.buffer.length = 0;
  }

  /** Replace the sink (tests). */
  setSink(sink: TraceSink): void {
    this.sink = sink;
  }

  private record(category: TraceCategory, message: string, data: unknown): void {
    const event: TraceEvent = { seq: this.seq++, category, message, data };
    this.buffer.push(event);
    if (this.buffer.length > BUFFER_LIMIT) this.buffer.shift();
    this.sink(event);
  }
}

/**
 * Parse a trace spec string (`"load, merge"`, or `"all"` / `"*"`) into category
 * tokens, trimming whitespace and dropping empties and unknowns. Pure, for testing
 * and for reading the localStorage / query configuration.
 */
export function parseTraceSpec(spec: string | null | undefined): (TraceCategory | 'all')[] {
  if (!spec) return [];
  const valid = new Set<string>([...TRACE_CATEGORIES, 'all']);
  return spec
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .map((token) => (token === '*' ? 'all' : token))
    .filter((token): token is TraceCategory | 'all' => valid.has(token));
}

/** The level-`debug` console sink: `[trace:merge] message {data}`. */
function consoleSink(event: TraceEvent): void {
  const tag = `[trace:${event.category}] ${event.message}`;
  if (event.data === undefined) console.debug(tag);
  else console.debug(tag, event.data);
}

/** The process-wide tracer the {@link trace} convenience and the app's trace points share. */
const defaultTracer = new Tracer();

/**
 * The app-facing trace entry point: `trace('merge')?.('msg', data)`. Returns an
 * emit function when the category is enabled on the shared tracer, else undefined.
 */
export function trace(category: TraceCategory): TraceFn | undefined {
  return defaultTracer.channel(category);
}

/** Enable categories on the shared tracer (also reachable as `__trace__.enable`). */
export function enableTrace(...categories: readonly (TraceCategory | 'all')[]): void {
  defaultTracer.enable(...categories);
}

/** Disable categories on the shared tracer. */
export function disableTrace(...categories: readonly (TraceCategory | 'all')[]): void {
  defaultTracer.disable(...categories);
}

/** The shared tracer's currently enabled categories (e.g. to seed a UI toggle). */
export function activeTrace(): TraceCategory[] {
  return defaultTracer.active();
}

/**
 * Persist an enabled-category spec to the localStorage key the startup config
 * reads, so a UI toggle survives a reload. Writing an empty list removes the key.
 * Guarded: when storage is inaccessible the in-memory tracer state still applies
 * for the session (and tracing still logs to the console).
 */
export function persistTraceSpec(categories: readonly TraceCategory[]): void {
  try {
    if (categories.length > 0) localStorage.setItem(TRACE_STORAGE_KEY, categories.join(','));
    else localStorage.removeItem(TRACE_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, sandbox); session-only is fine.
  }
}

/** Recent events from the shared tracer, for copy-paste out of a reproduction. */
export function dumpTrace(): TraceEvent[] {
  return defaultTracer.dump();
}

/** Drop the shared tracer's buffered events. */
export function clearTrace(): void {
  defaultTracer.clear();
}

/** Replace the shared tracer's sink (tests). */
export function setTraceSink(sink: TraceSink): void {
  defaultTracer.setSink(sink);
}

// --- Environment wiring (main thread) --------------------------------------

/** The runtime console control surface installed at {@link globalThis}.__trace__. */
interface TraceConsole {
  enable: (...categories: string[]) => readonly TraceCategory[];
  disable: (...categories: string[]) => readonly TraceCategory[];
  list: () => readonly TraceCategory[];
  dump: () => readonly TraceEvent[];
  clear: () => void;
  help: () => void;
}

/** Ambient startup inputs, injected so {@link startupConfig} is testable. */
export interface TraceEnv {
  /** The page URL's query string (e.g. `location.search`), or null when there's none. */
  readonly query: string | null;
  /** Read the persisted spec from storage; may throw when storage is inaccessible. */
  readonly readStored: () => string | null;
}

/** What {@link startupConfig} resolves: the categories to enable, and whether storage worked. */
export interface StartupConfig {
  readonly categories: (TraceCategory | 'all')[];
  /**
   * False when reading the persisted spec threw — storage is inaccessible (Safari
   * private mode, a sandboxed iframe, a worker). Tracing is unaffected: it's still
   * toggled at runtime via `__trace__.enable(...)` and logs to the console, which
   * is always the output regardless of storage.
   */
  readonly storageAccessible: boolean;
}

/**
 * Resolve the categories to enable at startup from the environment: the URL
 * `?trace=` query wins (and needs no storage), otherwise the persisted spec. Pure
 * given an injected {@link TraceEnv}, and it reports whether storage was accessible
 * so the caller can point the user at the storage-free, console-logged toggle when
 * it wasn't.
 */
export function startupConfig(env: TraceEnv): StartupConfig {
  let spec: string | null = null;
  try {
    if (env.query) spec = new URLSearchParams(env.query).get('trace');
  } catch {
    // Malformed query string; fall through to storage.
  }

  let storageAccessible = true;
  if (spec === null) {
    try {
      spec = env.readStored();
    } catch {
      storageAccessible = false; // Storage threw; the console/runtime toggle still works.
    }
  }
  return { categories: parseTraceSpec(spec), storageAccessible };
}

/** Usage banner shown by `__trace__.help()`. */
const TRACE_HELP =
  `[trace] categories: ${TRACE_CATEGORIES.join(', ')}\n` +
  'enable:  __trace__.enable("load","merge")   (or ?trace=load,merge, or localStorage["dicom-workspace.trace"])\n' +
  'disable: __trace__.disable()    dump: __trace__.dump()    list: __trace__.list()';

/**
 * Apply the startup configuration and install the runtime console helper.
 * Environment-guarded so importing this module is safe on the server, in tests, and
 * in workers. Output is always the console sink, so even when storage is
 * inaccessible the named exports and `__trace__` still toggle tracing for the
 * session — that case is announced once so the localStorage instructions aren't a
 * dead end.
 */
function install(): void {
  let query: string | null = null;
  try {
    if (typeof location !== 'undefined') query = location.search;
  } catch {
    // Some sandboxes throw on location access; treat it as no query.
  }

  const { categories, storageAccessible } = startupConfig({
    query,
    readStored: () => localStorage.getItem(TRACE_STORAGE_KEY),
  });
  defaultTracer.enable(...categories);

  try {
    (globalThis as typeof globalThis & { __trace__?: TraceConsole }).__trace__ = {
      enable: (...c) => {
        defaultTracer.enable(...parseTraceSpec(c.join(',')));
        return defaultTracer.active();
      },
      disable: (...c) => {
        const tokens = parseTraceSpec(c.join(','));
        // No argument means "turn everything off" — the common console reset.
        if (tokens.length > 0) defaultTracer.disable(...tokens);
        else defaultTracer.disable('all');
        return defaultTracer.active();
      },
      list: () => defaultTracer.active(),
      dump: () => defaultTracer.dump(),
      clear: () => defaultTracer.clear(),
      help: () => console.info(TRACE_HELP),
    };
  } catch {
    // No global to attach to; the named exports still work.
  }

  // When storage is blocked the localStorage/URL instructions can't be followed, so
  // surface the storage-free runtime toggle — which logs to the console — instead.
  if (!storageAccessible && typeof console !== 'undefined') {
    console.info(
      '[trace] localStorage is unavailable, so trace settings can’t persist. ' +
        'Enable for this session with __trace__.enable("load","merge"); output goes to the console.',
    );
  }
}

install();
