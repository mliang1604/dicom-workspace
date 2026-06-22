import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TraceStore } from '../../trace-store';

/**
 * The toolbar's diagnostic-tracing control: a toggle button and a small popover to
 * enable trace categories, then capture the log to share. It exists so tracing can
 * be driven from the UI — not only via the console, a `?trace=` URL or a
 * localStorage key — which is what you need when reproducing on another machine
 * where those aren't at hand.
 *
 * Self-contained: it owns its open state and routes every category toggle and the
 * log capture through {@link TraceStore} (which drives the shared tracer and
 * persists the choice). "Copy log" uses the async clipboard when available and
 * falls back to revealing the JSON in a selectable textarea when it's blocked
 * (an insecure context, e.g. plain-HTTP on a LAN), so there's always a way to get
 * the trace out.
 */
@Component({
  selector: 'app-trace-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './trace-panel.html',
  styleUrl: './trace-panel.css',
})
export class TracePanel {
  protected readonly store = inject(TraceStore);

  /** Whether the popover is open. */
  protected readonly open = signal(false);

  /** Transient feedback line (copied / cleared / clipboard blocked). */
  protected readonly status = signal<string | null>(null);

  /** The captured log JSON shown for manual copy, or null when hidden. */
  protected readonly logText = signal<string | null>(null);

  /** Open or close the popover; closing clears any transient capture state. */
  protected toggleOpen(): void {
    this.open.update((isOpen) => !isOpen);
    if (!this.open()) this.reset();
  }

  /** Close the popover. */
  protected close(): void {
    this.open.set(false);
    this.reset();
  }

  /** Copy the captured events to the clipboard, revealing them inline if it's blocked. */
  protected async copyLog(): Promise<void> {
    const text = this.serialize();
    try {
      await navigator.clipboard.writeText(text);
      this.status.set(`Copied ${this.count()} to the clipboard.`);
    } catch {
      this.logText.set(text);
      this.status.set('Clipboard blocked — select the text below and copy it.');
    }
  }

  /** Reveal the captured events inline (a selectable textarea) without the clipboard. */
  protected showLog(): void {
    this.logText.set(this.serialize());
    this.status.set(`${this.count()} captured.`);
  }

  /** Drop the buffered events and hide the inline log. */
  protected clearLog(): void {
    this.store.clearEvents();
    this.logText.set(null);
    this.status.set('Cleared.');
  }

  /** Select the whole log on focus, so a single Ctrl/⌘+C copies it. */
  protected selectAll(event: FocusEvent): void {
    (event.target as HTMLTextAreaElement).select();
  }

  private serialize(): string {
    return JSON.stringify(this.store.events(), null, 2);
  }

  private count(): string {
    const n = this.store.events().length;
    return `${n} event${n === 1 ? '' : 's'}`;
  }

  private reset(): void {
    this.status.set(null);
    this.logText.set(null);
  }
}
