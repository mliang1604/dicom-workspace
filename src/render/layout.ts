/** A rectangle in pixels, origin at the top-left of the viewport. */
export interface PaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The "1 + 2" MPR arrangement: one large main pane and two stacked side panes. */
export interface MprLayout {
  readonly main: PaneRect;
  readonly topRight: PaneRect;
  readonly bottomRight: PaneRect;
}

/** Fraction of the width given to the main pane. */
const MAIN_WIDTH_FRACTION = 2 / 3;

/**
 * Split a `width × height` area into the main pane (left) and two stacked side
 * panes (right), separated by `gap` pixels. Rects are clamped to be non-negative
 * so a zero-sized container yields empty rects rather than negatives.
 */
export function mprLayout(width: number, height: number, gap = 6): MprLayout {
  const mainWidth = clampNonNegative(Math.round((width - gap) * MAIN_WIDTH_FRACTION));
  const sideX = mainWidth + gap;
  const sideWidth = clampNonNegative(width - sideX);

  const topHeight = clampNonNegative(Math.round((height - gap) / 2));
  const bottomY = topHeight + gap;
  const bottomHeight = clampNonNegative(height - bottomY);

  return {
    main: { x: 0, y: 0, width: mainWidth, height: clampNonNegative(height) },
    topRight: { x: sideX, y: 0, width: sideWidth, height: topHeight },
    bottomRight: { x: sideX, y: bottomY, width: sideWidth, height: bottomHeight },
  };
}

/** Scale a rect by a factor (e.g. CSS pixels to device pixels), rounding to whole pixels. */
export function scaleRect(rect: PaneRect, factor: number): PaneRect {
  return {
    x: Math.round(rect.x * factor),
    y: Math.round(rect.y * factor),
    width: Math.round(rect.width * factor),
    height: Math.round(rect.height * factor),
  };
}

function clampNonNegative(value: number): number {
  return value > 0 ? value : 0;
}
