import { MAIN_WIDTH_FRACTION, mprLayout, scaleRect, singleLayout, triLayout } from './layout';

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
});
