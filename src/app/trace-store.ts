import { Injectable, computed, signal } from '@angular/core';
import {
  activeTrace,
  clearTrace,
  disableTrace,
  dumpTrace,
  enableTrace,
  persistTraceSpec,
  TRACE_CATEGORIES,
  type TraceCategory,
  type TraceEvent,
} from '../diag/trace';

/**
 * Signal-based UI bridge to the {@link import('../diag/trace') trace} singleton, so
 * the trace mode is toggleable from the app chrome (not just the console /
 * localStorage / URL) — which matters when reproducing on a machine where opening
 * DevTools or pre-setting storage isn't convenient.
 *
 * It mirrors the tracer's enabled categories into a signal for the UI to bind, and
 * every change drives the shared tracer (so the instrumented call sites actually
 * emit) and persists the spec to localStorage (so it survives a reload). Seeded
 * from the tracer's startup state, so a category already on via `?trace=` / storage
 * shows as enabled. `root`-provided like the other stores; the tracer's ring buffer
 * remains the source of truth for captured events.
 */
@Injectable({ providedIn: 'root' })
export class TraceStore {
  /** Every toggleable category, for the UI to list. */
  readonly categories = TRACE_CATEGORIES;

  /** The enabled categories, seeded from the tracer's startup config (URL / storage). */
  private readonly enabledSet = signal<ReadonlySet<TraceCategory>>(new Set(activeTrace()));

  /** Whether any category is on — drives the toggle button's active state. */
  readonly anyEnabled = computed(() => this.enabledSet().size > 0);

  /** Whether a specific category is enabled (reactive; read per-row in the template). */
  isEnabled(category: TraceCategory): boolean {
    return this.enabledSet().has(category);
  }

  /** Flip one category, syncing the shared tracer and persisting the new spec. */
  toggle(category: TraceCategory): void {
    const next = new Set(this.enabledSet());
    if (next.has(category)) {
      next.delete(category);
      disableTrace(category);
    } else {
      next.add(category);
      enableTrace(category);
    }
    this.commit(next);
  }

  /** Turn every category on. */
  enableAll(): void {
    enableTrace('all');
    this.commit(new Set(TRACE_CATEGORIES));
  }

  /** Turn every category off. */
  disableAll(): void {
    disableTrace('all');
    this.commit(new Set());
  }

  /**
   * The buffered trace events, newest reproduction included. Read on demand (a
   * snapshot) rather than as a signal: the tracer doesn't notify on each emit, and
   * the UI only needs them when the user captures or copies the log.
   */
  events(): readonly TraceEvent[] {
    return dumpTrace();
  }

  /** Drop the buffered events (leaves the enabled categories untouched). */
  clearEvents(): void {
    clearTrace();
  }

  private commit(next: ReadonlySet<TraceCategory>): void {
    this.enabledSet.set(next);
    persistTraceSpec([...next]);
  }
}
