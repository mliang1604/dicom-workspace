import type { Vec3 } from '../dicom/types';
import { loftContours } from './surface';

/** An axis-aligned square loop (4 points) at height z. */
function square(z: number, r = 4): Vec3[] {
  return [
    [-r, -r, z],
    [r, -r, z],
    [r, r, z],
    [-r, r, z],
  ];
}

describe('loftContours', () => {
  it('returns nothing for fewer than two usable loops', () => {
    expect(loftContours([])).toEqual([]);
    expect(loftContours([square(0)])).toEqual([]);
    expect(loftContours([[[0, 0, 0]] as unknown as Vec3[], square(1)])).toEqual([]); // <3 pts dropped
  });

  it('lofts two loops into a closed band plus two end caps', () => {
    const tris = loftContours([square(0), square(1)], 4);
    // band: 1 gap × 4 sides × 2 triangles = 8; caps: 2 × 4 = 8.
    expect(tris).toHaveLength(16);
    for (const t of tris) {
      expect(t).toHaveLength(3);
      for (const v of t) expect(v.every((c) => Number.isFinite(c))).toBe(true);
    }
  });

  it('scales the band with the sample count', () => {
    const tris = loftContours([square(0), square(1)], 16);
    // band 16×2 = 32, caps 16×2 = 32.
    expect(tris).toHaveLength(64);
  });

  it('orders loops by z regardless of input order', () => {
    const up = loftContours([square(0), square(2)], 8);
    const down = loftContours([square(2), square(0)], 8);
    expect(down).toHaveLength(up.length);
  });

  it('caps the slice count via maxLoops', () => {
    const loops = Array.from({ length: 200 }, (_, i) => square(i));
    const tris = loftContours(loops, 8, 10);
    // 10 loops → 9 bands × 8 × 2 = 144, plus 2 caps × 8 = 16.
    expect(tris).toHaveLength(160);
  });

  it('samples the loop boundary, not the centroid', () => {
    // A loop of radius 4: every resampled vertex should sit ~4mm from centre.
    const tris = loftContours([square(0, 4), square(1, 4)], 8);
    const radii = tris.flat().map(([x, y]) => Math.hypot(x, y));
    expect(Math.max(...radii)).toBeGreaterThan(2); // not collapsed to the centroid
  });
});
