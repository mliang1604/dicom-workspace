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
 * The selectable viewport arrangements. The viewer maps each to a set of panes
 * (see `placePanes`): `TriMpr` and `Quad` show the MPR orientations, `Quad` and
 * `Volume3d` include the 3D pane.
 */
export enum LayoutMode {
  /** 1 large main + 2 stacked side panes — the three MPR orientations, no 3D pane. */
  TriMpr,
  /** 2×2 grid — three MPR panes plus the 3D pane. */
  Quad,
  /** The 3D pane filling the whole viewport. */
  Volume3d,
  // Appended last: the numeric value is persisted, so don't renumber the above.
  /** Side-by-side MPR groups (a column of axial/coronal/sagittal per layer). */
  Compare,
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
 * The three-pane "1 large main + 2 stacked side" MPR arrangement: a tall main
 * pane on the left, two side panes stacked on the right. Which orientation lands
 * where is decided by the caller (see `placePanes` in the viewer).
 */
export interface TriLayout {
  readonly main: PaneRect;
  readonly topRight: PaneRect;
  readonly bottomRight: PaneRect;
}

/** Fraction of the width the main pane takes in the 1+2 ({@link TriLayout}) arrangement. */
export const MAIN_WIDTH_FRACTION = 2 / 3;

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

/**
 * Split a `width × height` area into the 1+2 arrangement: a `MAIN_WIDTH_FRACTION`
 * wide main pane on the left at full height, and two equal side panes stacked in
 * the remaining right column, separated by `gap` pixels. Rects are clamped to be
 * non-negative so a zero-sized container yields empty rects rather than negatives.
 */
export function triLayout(width: number, height: number, gap = 6): TriLayout {
  const mainWidth = clampNonNegative(Math.round((width - gap) * MAIN_WIDTH_FRACTION));
  const rightX = mainWidth + gap;
  const rightWidth = clampNonNegative(width - rightX);

  const topHeight = clampNonNegative(Math.round((height - gap) / 2));
  const bottomY = topHeight + gap;
  const bottomHeight = clampNonNegative(height - bottomY);

  return {
    main: { x: 0, y: 0, width: mainWidth, height: clampNonNegative(height) },
    topRight: { x: rightX, y: 0, width: rightWidth, height: topHeight },
    bottomRight: { x: rightX, y: bottomY, width: rightWidth, height: bottomHeight },
  };
}

/** A single pane filling the whole `width × height` area (the 3D-only layout). */
export function singleLayout(width: number, height: number): PaneRect {
  return { x: 0, y: 0, width: clampNonNegative(width), height: clampNonNegative(height) };
}

/**
 * Split a `width × height` area into `groups` equal columns, each stacked into 3
 * equal rows — the side-by-side compare layout (one column of axial/coronal/
 * sagittal per group). Returns rects indexed `[group][row]`. The last column/row
 * absorbs the rounding remainder so the panes reach the far edges exactly.
 */
export function compareLayout(
  width: number,
  height: number,
  groups: number,
  gap = 6,
): PaneRect[][] {
  const colWidth = clampNonNegative(Math.round((width - (groups - 1) * gap) / groups));
  const rowHeight = clampNonNegative(Math.round((height - 2 * gap) / 3));
  const cols: PaneRect[][] = [];
  for (let g = 0; g < groups; g++) {
    const x = g * (colWidth + gap);
    const w = g === groups - 1 ? clampNonNegative(width - x) : colWidth;
    const rows: PaneRect[] = [];
    for (let r = 0; r < 3; r++) {
      const y = r * (rowHeight + gap);
      const h = r === 2 ? clampNonNegative(height - y) : rowHeight;
      rows.push({ x, y, width: w, height: h });
    }
    cols.push(rows);
  }
  return cols;
}

/**
 * Scale a rect by a factor (e.g. CSS pixels to device pixels), snapping to whole
 * pixels by its edges. Deriving width/height from rounded right/bottom edges —
 * rather than rounding width/height independently — makes adjacent panes share
 * an exact device-pixel edge and makes a pane that fills the viewport scale to
 * exactly `round(size * factor)`. Rounding each component on its own instead
 * leaves 1px seams, overlaps, or clamping between panes at fractional DPRs.
 */
export function scaleRect(rect: PaneRect, factor: number): PaneRect {
  const x = Math.round(rect.x * factor);
  const y = Math.round(rect.y * factor);
  const right = Math.round((rect.x + rect.width) * factor);
  const bottom = Math.round((rect.y + rect.height) * factor);
  return { x, y, width: clampNonNegative(right - x), height: clampNonNegative(bottom - y) };
}

function clampNonNegative(value: number): number {
  return value > 0 ? value : 0;
}

/** Placement of the in-pane overlay blend bar (a horizontal slider). */
export interface BlendBar {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/**
 * Place the in-pane fusion blend bar: a centred horizontal slider near the bottom
 * of the largest MPR pane among `mprRects`. Returns null when there's no pane, or
 * the host pane is too small to host a usable bar, so the caller hides it.
 */
export function blendBarPlacement(mprRects: readonly PaneRect[]): BlendBar | null {
  if (mprRects.length === 0) return null;
  const host = mprRects.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  if (host.width < 120 || host.height < 80) return null;
  const width = Math.min(260, Math.round(host.width * 0.6));
  return {
    x: Math.round(host.x + (host.width - width) / 2),
    y: Math.round(host.y + host.height - 30),
    width,
  };
}
