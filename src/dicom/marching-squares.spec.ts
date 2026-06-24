import { idOccupancy, removeCollinear, traceMaskLoops, type MaskLoop } from './marching-squares';

/**
 * Build a slice + dims from an ASCII grid: `#`/`1` occupied, anything else
 * empty. Rows are top (y=0) down; columns left (x=0) right.
 */
function grid(rows: readonly string[]): { slice: Uint16Array; width: number; height: number } {
  const height = rows.length;
  const width = rows[0].length;
  const slice = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = rows[y][x];
      slice[y * width + x] = c === '#' || c === '1' ? 1 : 0;
    }
  }
  return { slice, width, height };
}

function loops(rows: readonly string[], id = 1): MaskLoop[] {
  const { slice, width, height } = grid(rows);
  return traceMaskLoops(idOccupancy(slice, width, height, id), width, height);
}

/** Signed area (shoelace) of a closed loop; +ve and −ve mark opposite windings. */
function signedArea(loop: MaskLoop): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** A loop's vertices as a Set of "x,y" strings, order-independent. */
function cornerSet(loop: MaskLoop): Set<string> {
  return new Set(loop.map(([x, y]) => `${x},${y}`));
}

describe('traceMaskLoops', () => {
  it('traces a single pixel as one unit square', () => {
    const result = loops(['#']);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(4);
    expect(Math.abs(signedArea(result[0]))).toBe(1);
    expect(cornerSet(result[0])).toEqual(new Set(['0,0', '1,0', '1,1', '0,1']));
  });

  it('traces a solid block as one rectangle with collinear runs collapsed', () => {
    // A 3×2 block: the boundary has 4 corners, not 10 staircase points.
    const result = loops(['###', '###']);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(4);
    expect(Math.abs(signedArea(result[0]))).toBe(6); // = occupied pixel count
    expect(cornerSet(result[0])).toEqual(new Set(['0,0', '3,0', '3,2', '0,2']));
  });

  it('traces a disk-like blob as one loop enclosing its pixel count', () => {
    const result = loops(['.###.', '#####', '#####', '#####', '.###.']);
    expect(result).toHaveLength(1);
    // 5×5 minus the four corner pixels = 21 occupied.
    expect(Math.abs(signedArea(result[0]))).toBe(21);
  });

  it('traces a ring as an outer loop and an oppositely-wound hole', () => {
    const result = loops(['###', '#.#', '###']);
    expect(result).toHaveLength(2);
    const [outer, inner] = [...result].sort(
      (a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)),
    );
    expect(Math.abs(signedArea(outer))).toBe(9); // 3×3 enclosed
    expect(Math.abs(signedArea(inner))).toBe(1); // the 1×1 hole
    // Outer and hole wind in opposite directions.
    expect(Math.sign(signedArea(outer))).toBe(-Math.sign(signedArea(inner)));
    expect(cornerSet(inner)).toEqual(new Set(['1,1', '2,1', '2,2', '1,2']));
  });

  it('traces two disjoint components as two independent loops', () => {
    const result = loops(['#.#', '#.#']);
    expect(result).toHaveLength(2);
    for (const loop of result) expect(Math.abs(signedArea(loop))).toBe(2);
  });

  it('returns nothing for an all-empty slice', () => {
    expect(loops(['...', '...'])).toEqual([]);
  });

  it('only traces the requested id', () => {
    const { slice, width, height } = grid(['##', '..']);
    // Tag the bottom row with id 2.
    slice[2] = 2;
    slice[3] = 2;
    const ones = traceMaskLoops(idOccupancy(slice, width, height, 1), width, height);
    const twos = traceMaskLoops(idOccupancy(slice, width, height, 2), width, height);
    expect(ones).toHaveLength(1);
    expect(twos).toHaveLength(1);
    expect(cornerSet(ones[0])).toEqual(new Set(['0,0', '2,0', '2,1', '0,1']));
    expect(cornerSet(twos[0])).toEqual(new Set(['0,1', '2,1', '2,2', '0,2']));
  });
});

describe('removeCollinear', () => {
  it('collapses a straight run to its endpoints on a closed loop', () => {
    // A square sampled at every integer corner along its edges.
    const dense: [number, number][] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
      [2, 2],
      [1, 2],
      [0, 2],
      [0, 1],
    ];
    expect(removeCollinear(dense)).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ]);
  });

  it('leaves a loop with no collinear points unchanged', () => {
    const tri: [number, number][] = [
      [0, 0],
      [2, 0],
      [1, 2],
    ];
    expect(removeCollinear(tri)).toEqual(tri);
  });
});
