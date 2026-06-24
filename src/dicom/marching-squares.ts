/**
 * Trace the boundary of a binary mask into closed polygon loops — the
 * per-slice contouring that turns an authored label slice into RTSTRUCT
 * `CLOSED_PLANAR` contours.
 *
 * The mask is treated as a union of unit pixel squares: pixel `(x, y)` occupies
 * the square spanning integer *corners* `(x, y)`→`(x+1, y+1)`. The boundary of
 * that union is the set of unit edges separating an occupied pixel from an
 * unoccupied one (or from outside the grid). Orienting every such edge so the
 * occupied pixel lies on a consistent side makes the boundary a set of directed
 * loops, which {@link traceMaskLoops} stitches end-to-end.
 *
 * This is the discrete dual of marching squares on a binary field: rather than
 * threshold-crossings on a scalar grid it walks pixel-edge crossings, which is
 * exact for a 0/1 occupancy and falls out as integer-corner loops with no
 * interpolation. It naturally yields:
 *   - **one loop per connected component** (each gets its own outer boundary),
 *   - **holes** as separate loops wound opposite to the outer boundary, and
 *   - **multiple components per slice** as independent loops.
 *
 * Points are emitted in pixel-corner coordinates (a corner `(cx, cy)` sits at
 * continuous voxel index `(cx - 0.5, cy - 0.5)`); the caller maps them to
 * patient space. The maths is pure and integer, so it unit-tests without a GPU.
 */

/** A closed loop of integer pixel-corner points `[x, y]`, first point ≠ last (implicitly closed). */
export type MaskLoop = readonly (readonly [number, number])[];

/** Tells whether pixel `(x, y)` of a `width`×`height` grid is occupied. */
export type Occupancy = (x: number, y: number) => boolean;

/**
 * Build an {@link Occupancy} predicate over a row-major slice that reports a
 * pixel occupied when its value equals `id`. Out-of-grid pixels read as empty,
 * so the predicate may be queried one step past the edges while tracing.
 */
export function idOccupancy(
  slice: ArrayLike<number>,
  width: number,
  height: number,
  id: number,
): Occupancy {
  return (x, y) => x >= 0 && x < width && y >= 0 && y < height && slice[y * width + x] === id;
}

/** A directed unit edge between two adjacent integer corners. */
interface Edge {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Pack a corner `(x, y)` into one integer key for a `width`×`height` pixel grid. */
function cornerKey(x: number, y: number, width: number): number {
  return y * (width + 1) + x;
}

/**
 * Trace every closed boundary loop of the mask `occupied` over a
 * `width`×`height` pixel grid, in pixel-corner coordinates.
 *
 * Each occupied pixel contributes a boundary edge wherever its neighbour across
 * that edge is empty, oriented (top→right→bottom→left, walking the pixel square
 * clockwise in y-down image space) so the occupied interior stays on the same
 * side. Shared edges between two occupied pixels are never boundary edges, so
 * the directed edges meet end-to-start and stitch into closed loops: outer
 * contours one way, holes the other. Loops shorter than a triangle (which a
 * unit-square union never produces) are dropped.
 *
 * At a diagonal pinch — two occupied pixels touching only at a corner — that
 * corner has two outgoing edges; the walk consumes them greedily, splitting the
 * figure-eight into two valid loops, which is a fine RTSTRUCT serialization.
 */
export function traceMaskLoops(occupied: Occupancy, width: number, height: number): MaskLoop[] {
  // Bucket directed boundary edges by their start corner; a corner usually has
  // one outgoing edge, two only at a diagonal pinch.
  const outgoing = new Map<number, Edge[]>();
  const push = (edge: Edge): void => {
    const key = cornerKey(edge.x0, edge.y0, width);
    const list = outgoing.get(key);
    if (list) list.push(edge);
    else outgoing.set(key, [edge]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!occupied(x, y)) continue;
      // Corners of this pixel's square, clockwise in y-down space.
      if (!occupied(x, y - 1)) push({ x0: x, y0: y, x1: x + 1, y1: y }); // top →
      if (!occupied(x + 1, y)) push({ x0: x + 1, y0: y, x1: x + 1, y1: y + 1 }); // right ↓
      if (!occupied(x, y + 1)) push({ x0: x + 1, y0: y + 1, x1: x, y1: y + 1 }); // bottom ←
      if (!occupied(x - 1, y)) push({ x0: x, y0: y + 1, x1: x, y1: y }); // left ↑
    }
  }

  const loops: MaskLoop[] = [];
  for (const [, edges] of outgoing) {
    while (edges.length) {
      const start = edges.pop()!;
      const loop = walkLoop(start, outgoing, width);
      if (loop && loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/** Follow edges from `start` corner to corner until the loop closes back on it. */
function walkLoop(start: Edge, outgoing: Map<number, Edge[]>, width: number): MaskLoop | null {
  const points: [number, number][] = [[start.x0, start.y0]];
  let edge = start;
  // A unit-square boundary loop can have at most 4·(grid corners) edges; bound
  // the walk so a malformed graph can't spin forever.
  for (let guard = 0; guard < 1e7; guard++) {
    points.push([edge.x1, edge.y1]);
    if (edge.x1 === start.x0 && edge.y1 === start.y0) {
      points.pop(); // drop the duplicated closing corner; the loop is implicitly closed
      return removeCollinear(points);
    }
    const next = takeEdge(outgoing, edge.x1, edge.y1, width);
    if (!next) return null; // dangling edge — should not happen for a sound mask
    edge = next;
  }
  return null;
}

/** Remove and return one outgoing edge from corner `(x, y)`, or null when none remain. */
function takeEdge(outgoing: Map<number, Edge[]>, x: number, y: number, width: number): Edge | null {
  const list = outgoing.get(cornerKey(x, y, width));
  return list && list.length ? list.pop()! : null;
}

/**
 * Drop interior points that lie on the straight segment between their kept
 * neighbours, collapsing each axis-aligned run of a staircase loop to its two
 * endpoints. Exact (zero-area change), so it only thins the dense corner lists
 * marching produces — it does not approximate the shape. Operates on a closed
 * loop (the wrap-around corner is considered too).
 */
export function removeCollinear(loop: readonly (readonly [number, number])[]): [number, number][] {
  const n = loop.length;
  if (n < 3) return loop.map((p) => [p[0], p[1]]);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const cur = loop[i];
    const next = loop[(i + 1) % n];
    const cross =
      (cur[0] - prev[0]) * (next[1] - prev[1]) - (cur[1] - prev[1]) * (next[0] - prev[0]);
    if (cross !== 0) out.push([cur[0], cur[1]]);
  }
  return out;
}
