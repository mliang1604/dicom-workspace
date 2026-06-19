/** A rectangle in pixels, origin at the top-left of the viewport. */
export interface PaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A 2D offset. Used for the per-pane pan, in screen-uv (pane-fraction) units. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * A four-up 2×2 grid of panes. Three cells hold the MPR orientations and the
 * fourth holds the 3D MIP view; which orientation lands where is decided by the
 * caller (see `placePanes` in the viewer).
 */
export interface MprLayout {
  readonly topLeft: PaneRect;
  readonly topRight: PaneRect;
  readonly bottomLeft: PaneRect;
  readonly bottomRight: PaneRect;
}

/**
 * Split a `width × height` area into a 2×2 grid of equal cells separated by
 * `gap` pixels. Rects are clamped to be non-negative so a zero-sized container
 * yields empty rects rather than negatives.
 */
export function mprLayout(width: number, height: number, gap = 6): MprLayout {
  const leftWidth = clampNonNegative(Math.round((width - gap) / 2));
  const rightX = leftWidth + gap;
  const rightWidth = clampNonNegative(width - rightX);

  const topHeight = clampNonNegative(Math.round((height - gap) / 2));
  const bottomY = topHeight + gap;
  const bottomHeight = clampNonNegative(height - bottomY);

  return {
    topLeft: { x: 0, y: 0, width: leftWidth, height: topHeight },
    topRight: { x: rightX, y: 0, width: rightWidth, height: topHeight },
    bottomLeft: { x: 0, y: bottomY, width: leftWidth, height: bottomHeight },
    bottomRight: { x: rightX, y: bottomY, width: rightWidth, height: bottomHeight },
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
