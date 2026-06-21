import { afterEveryRender, Directive, ElementRef, HostListener, inject } from '@angular/core';

/**
 * Fill percentage (0–100, clamped) for a range slider at `value` within
 * `[min, max]` — the thumb's position along the track. A non-positive span (e.g.
 * an unset/degenerate range) yields 0 rather than NaN.
 */
export function rangeFillPercent(min: number, max: number, value: number): number {
  const span = max - min;
  const pct = span > 0 ? ((value - min) / span) * 100 : 0;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Paints a range slider's filled portion. Sets a `--range-fill` custom property to
 * the thumb's position (0–100% of the track) so the slider's track CSS can draw an
 * accent fill from the left up to the thumb — restoring the filled look while the
 * thumb still travels edge to edge (see the range styles in `styles.css`).
 *
 * Auto-applies to every range input and keeps the fill in sync both on drag (the
 * `input` event) and on programmatic value changes (after each render) — e.g. the
 * blend bar and the layers-panel opacity slider editing the same overlay opacity.
 */
@Directive({ selector: 'input[type="range"]' })
export class RangeFill {
  private readonly host = inject<ElementRef<HTMLInputElement>>(ElementRef);

  constructor() {
    // Programmatic value changes (a synced sibling, a reset) don't fire `input`,
    // so re-derive the fill after every render from the element's current value.
    afterEveryRender(() => this.sync());
  }

  @HostListener('input')
  protected sync(): void {
    const el = this.host.nativeElement;
    const min = el.min === '' ? 0 : Number(el.min);
    const max = el.max === '' ? 100 : Number(el.max);
    el.style.setProperty('--range-fill', `${rangeFillPercent(min, max, Number(el.value))}%`);
  }
}
