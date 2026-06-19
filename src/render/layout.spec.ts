import { mprLayout, scaleRect } from './layout';

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
