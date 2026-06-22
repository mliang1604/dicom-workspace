import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TraceStore } from '../../trace-store';

/**
 * The toolbar's diagnostic-tracing control: a toggle button and a small popover to
 * enable trace categories, then capture the log to share. It exists so tracing can
 * be driven from the UI — not only via the console, a `?trace=` URL or a
 * localStorage key — which is what you need when reproducing on another machine
 * where those aren't at hand.
 *
 * The popover is shown in the browser **top layer** (the native `popover`
 * attribute + `showPopover()`), so it clears the toolbar's `backdrop-filter`
 * stacking context and paints above the WebGPU canvas — an absolutely-positioned
 * child would be painted over by the panes below the toolbar. It's positioned
 * manually under the button on open (the viewer uses no `z-index`, so there's no
 * stacking layer to lean on).
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
  host: {
    '(document:pointerdown)': 'onOutsidePointerDown($event)',
    '(document:keydown.escape)': 'close()',
  },
})
export class TracePanel {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly store = inject(TraceStore);

  private readonly popover = viewChild.required<ElementRef<HTMLElement>>('pop');
  private readonly toggleButton = viewChild.required<ElementRef<HTMLButtonElement>>('toggleBtn');

  /** Whether the popover is open. */
  protected readonly open = signal(false);

  /** Transient feedback line (copied / cleared / clipboard blocked). */
  protected readonly status = signal<string | null>(null);

  /** The captured log JSON shown for manual copy, or null when hidden. */
  protected readonly logText = signal<string | null>(null);

  /** Open the popover (anchored under the button) or close it if already open. */
  protected toggleOpen(): void {
    if (this.open()) {
      this.close();
      return;
    }
    const el = this.popover().nativeElement;
    const btn = this.toggleButton().nativeElement.getBoundingClientRect();
    // Anchor the top-layer popover under the button's right edge.
    el.style.top = `${Math.round(btn.bottom + 8)}px`;
    el.style.right = `${Math.round(Math.max(8, window.innerWidth - btn.right))}px`;
    el.showPopover();
    this.open.set(true);
  }

  /** Close the popover and clear any transient capture state. */
  protected close(): void {
    if (!this.open()) return;
    const el = this.popover().nativeElement;
    if (el.matches(':popover-open')) el.hidePopover();
    this.open.set(false);
    this.reset();
  }

  /** Dismiss on a click anywhere outside the control (the popover stays a DOM child). */
  protected onOutsidePointerDown(event: PointerEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.close();
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
