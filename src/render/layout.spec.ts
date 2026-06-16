import { mprLayout, scaleRect } from './layout';

describe('mprLayout', () => {
  it('gives the main pane the left two-thirds and full height', () => {
    const { main } = mprLayout(300, 200, 6);

    expect(main).toEqual({ x: 0, y: 0, width: 196, height: 200 });
  });

  it('stacks the two side panes in the remaining right column', () => {
    const { topRight, bottomRight } = mprLayout(300, 200, 6);

    expect(topRight.x).toBe(bottomRight.x); // same column
    expect(topRight.x).toBeGreaterThan(0);
    expect(topRight.y).toBe(0);
    expect(bottomRight.y).toBe(topRight.height + 6); // separated by the gap
  });

  it('clamps to empty rects for a zero-sized container', () => {
    const layout = mprLayout(0, 0);

    expect(layout.main.width).toBe(0);
    expect(layout.bottomRight.height).toBe(0);
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
});
