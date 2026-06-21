import {
  blendBarPlacement,
  MAIN_WIDTH_FRACTION,
  mprLayout,
  scaleRect,
  singleLayout,
  triLayout,
} from './layout';

describe('blendBarPlacement', () => {
  it('centres a bar near the bottom of the largest MPR pane', () => {
    const small = { x: 0, y: 0, width: 100, height: 200 };
    const large = { x: 200, y: 0, width: 600, height: 400 };
    const bar = blendBarPlacement([small, large]);

    expect(bar).not.toBeNull();
    const width = Math.min(260, Math.round(600 * 0.6)); // 260
    expect(bar!.width).toBe(width);
    expect(bar!.x).toBe(Math.round(200 + (600 - width) / 2)); // centred in the large pane
    expect(bar!.y).toBe(0 + 400 - 30); // near its bottom
  });

  it('returns null when there is no pane or the host is too small', () => {
    expect(blendBarPlacement([])).toBeNull();
    expect(blendBarPlacement([{ x: 0, y: 0, width: 100, height: 60 }])).toBeNull();
  });
});

describe('mprLayout', () => {
  it('splits the area into four equal cells', () => {
    const { topLeft } = mprLayout(300, 200, 6);

    // (300 - 6) / 2 = 147 wide, (200 - 6) / 2 = 97 tall.
    expect(topLeft).toEqual({ x: 0, y: 0, width: 147, height: 97 });
  });

  it('aligns the four cells into two rows and two columns', () => {
    const { topLeft, topRight, bottomLeft, bottomRight } = mprLayout(300, 200, 6);

    expect(topLeft.x).toBe(bottomLeft.x); // left column
    expect(topRight.x).toBe(bottomRight.x); // right column
    expect(topLeft.y).toBe(topRight.y); // top row
    expect(bottomLeft.y).toBe(bottomRight.y); // bottom row
    expect(topRight.x).toBe(topLeft.width + 6); // separated by the gap
    expect(bottomLeft.y).toBe(topLeft.height + 6); // separated by the gap
  });

  it('clamps to empty rects for a zero-sized container', () => {
    const layout = mprLayout(0, 0);

    expect(layout.topLeft.width).toBe(0);
    expect(layout.bottomRight.height).toBe(0);
  });
});

describe('triLayout', () => {
  it('gives the main pane the width fraction at full height', () => {
    const { main } = triLayout(300, 200, 6);

    // round((300 - 6) * 2/3) = round(196) = 196 wide, full 200 tall.
    expect(main).toEqual({
      x: 0,
      y: 0,
      width: Math.round((300 - 6) * MAIN_WIDTH_FRACTION),
      height: 200,
    });
  });

  it('stacks the two side panes in the remaining right column', () => {
    const { main, topRight, bottomRight } = triLayout(300, 200, 6);

    const rightX = main.width + 6;
    expect(topRight.x).toBe(rightX); // both side panes share the right column
    expect(bottomRight.x).toBe(rightX);
    expect(topRight.width).toBe(300 - rightX);
    expect(topRight.y).toBe(0); // top of the column
    expect(bottomRight.y).toBe(topRight.height + 6); // stacked below, past the gap
    // The two side panes fill the height around the gap.
    expect(topRight.height + 6 + bottomRight.height).toBe(200);
  });

  it('clamps to empty rects for a zero-sized container', () => {
    const layout = triLayout(0, 0);

    expect(layout.main.width).toBe(0);
    expect(layout.main.height).toBe(0);
    expect(layout.bottomRight.width).toBe(0);
  });
});

describe('singleLayout', () => {
  it('fills the whole area with one pane', () => {
    expect(singleLayout(300, 200)).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  it('clamps a negative-sized container to empty', () => {
    expect(singleLayout(-10, -5)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('scaleRect', () => {
  it('scales every component by the factor', () => {
    expect(scaleRect({ x: 1, y: 2, width: 3, height: 4 }, 2)).toEqual({
      x: 2,
      y: 4,
      width: 6,
      height: 8,
    });
  });

  it('is the identity for integer rects at factor 1', () => {
    const rect = { x: 7, y: 11, width: 13, height: 17 };
    expect(scaleRect(rect, 1)).toEqual(rect);
  });

  it('snaps adjacent panes to a shared edge at a fractional factor', () => {
    // Two columns split by a 6px gap at a 1.5x DPR: the left pane's right edge
    // and the right pane's left edge must land on the same device pixel.
    const left = { x: 0, y: 0, width: 133, height: 100 };
    const right = { x: 139, y: 0, width: 133, height: 100 };
    const dpr = 1.5;

    const sl = scaleRect(left, dpr);
    const sr = scaleRect(right, dpr);
    // No overlap and no seam: the gap is exactly round(139*dpr) - round(133*dpr).
    expect(sl.x + sl.width).toBe(Math.round(133 * dpr));
    expect(sr.x).toBe(Math.round(139 * dpr));
  });

  it('scales a full-viewport pane to exactly round(size * factor)', () => {
    // The single-pane / far-edge case must match the canvas backing store, which
    // is sized with the same rounding — so there is no 1px strip or clamp.
    for (const [size, dpr] of [
      [801, 1.25],
      [1366, 1.5],
      [999, 1.75],
    ] as const) {
      const scaled = scaleRect({ x: 0, y: 0, width: size, height: size }, dpr);
      expect(scaled.width).toBe(Math.round(size * dpr));
      expect(scaled.height).toBe(Math.round(size * dpr));
    }
  });

  it('tiles a two-column split with no overlap at a fractional factor', () => {
    // The right pane's right edge equals the scaled total width (no overshoot).
    const total = 1000;
    const { topLeft, topRight } = mprLayout(total, 200);
    const dpr = 1.25;
    const l = scaleRect(topLeft, dpr);
    const r = scaleRect(topRight, dpr);
    expect(r.x).toBeGreaterThanOrEqual(l.x + l.width); // no overlap
    expect(r.x + r.width).toBe(Math.round(total * dpr)); // reaches the far edge exactly
  });
});
