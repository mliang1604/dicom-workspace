import type { Vec3 } from '../dicom/types';
import {
  flattenSurfaceMeshes,
  loftContours,
  loftRoiMesh,
  SURFACE_VERTEX_FLOATS,
  type ColoredSurfaceMesh,
  type RoiSurfaceMesh,
} from './surface';

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

/** Magnitude of a 3-float slice of an array starting at `o`. */
function norm3(a: ArrayLike<number>, o: number): number {
  return Math.hypot(a[o], a[o + 1], a[o + 2]);
}

describe('loftRoiMesh', () => {
  it('returns null when the loops do not loft', () => {
    expect(loftRoiMesh(0, 1, [10, 20, 30], [])).toBeNull();
    expect(loftRoiMesh(0, 1, [10, 20, 30], [square(0)])).toBeNull(); // single loop
  });

  it('tags the mesh and sizes positions/normals from the triangle count', () => {
    const mesh = loftRoiMesh(2, 7, [10, 20, 30], [square(0), square(1)], 4);
    expect(mesh).not.toBeNull();
    const m = mesh!;
    expect(m.setIndex).toBe(2);
    expect(m.roiNumber).toBe(7);
    expect(m.baseColor).toEqual([10, 20, 30]);
    // 4 samples: band 4×2 = 8, caps 4×2 = 8 → 16 triangles.
    expect(m.count).toBe(16);
    expect(m.positions).toHaveLength(16 * 9); // 9 floats (3 verts × xyz) per triangle
    expect(m.normals).toHaveLength(16 * 3); // one face normal per triangle
  });

  it('emits unit-length face normals', () => {
    const m = loftRoiMesh(0, 1, [10, 20, 30], [square(0), square(2)], 8)!;
    for (let t = 0; t < m.count; t++) {
      expect(norm3(m.normals, t * 3)).toBeCloseTo(1, 6);
    }
  });

  it('orients each normal perpendicular to its triangle (cross of two edges)', () => {
    const m = loftRoiMesh(0, 1, [10, 20, 30], [square(0), square(3)], 8)!;
    for (let t = 0; t < m.count; t++) {
      const o = t * 9;
      const a: Vec3 = [m.positions[o], m.positions[o + 1], m.positions[o + 2]];
      const b: Vec3 = [m.positions[o + 3], m.positions[o + 4], m.positions[o + 5]];
      const c: Vec3 = [m.positions[o + 6], m.positions[o + 7], m.positions[o + 8]];
      const n: Vec3 = [m.normals[t * 3], m.normals[t * 3 + 1], m.normals[t * 3 + 2]];
      // The face normal is orthogonal to both in-plane edges.
      const eAB = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const eAC = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      expect(n[0] * eAB[0] + n[1] * eAB[1] + n[2] * eAB[2]).toBeCloseTo(0, 5);
      expect(n[0] * eAC[0] + n[1] * eAC[1] + n[2] * eAC[2]).toBeCloseTo(0, 5);
    }
  });

  it("gives a band wall's normal a horizontal (in-plane) tilt", () => {
    // A vertical wall between two stacked squares should face outward (xy), not
    // straight up the stacking axis — its first band triangle is not z-aligned.
    const m = loftRoiMesh(0, 1, [10, 20, 30], [square(0), square(1)], 8)!;
    const n0: Vec3 = [m.normals[0], m.normals[1], m.normals[2]];
    expect(Math.hypot(n0[0], n0[1])).toBeGreaterThan(0.5); // mostly sideways
  });
});

describe('flattenSurfaceMeshes', () => {
  /** A tiny stand-in mesh: `count` triangles with known positions/normals. */
  function fakeMesh(count: number, fill: number): RoiSurfaceMesh {
    const positions = new Float32Array(count * 9);
    const normals = new Float32Array(count * 3);
    for (let t = 0; t < count; t++) {
      // Each vertex of triangle t sits at (fill+t, fill+t, fill+t) so the
      // centroid is trivially the same point.
      for (let k = 0; k < 9; k++) positions[t * 9 + k] = fill + t;
      normals[t * 3] = 0;
      normals[t * 3 + 1] = 0;
      normals[t * 3 + 2] = 1;
    }
    return { setIndex: 0, roiNumber: 1, baseColor: [0, 0, 0], positions, normals, count };
  }

  it('returns empty arrays for no visible meshes', () => {
    const out = flattenSurfaceMeshes([]);
    expect(out.count).toBe(0);
    expect(out.vertices).toHaveLength(0);
    expect(out.centroids).toHaveLength(0);
  });

  it('packs pos3 + normal3 + rgba4 at the expected stride and vertex count', () => {
    const colored: ColoredSurfaceMesh = {
      mesh: fakeMesh(2, 5),
      rgba: [0.1, 0.2, 0.3, 0.4],
    };
    const out = flattenSurfaceMeshes([colored]);
    expect(out.count).toBe(2);
    // 2 triangles × 3 verts × 10 floats.
    expect(SURFACE_VERTEX_FLOATS).toBe(10);
    expect(out.vertices).toHaveLength(2 * 3 * SURFACE_VERTEX_FLOATS);
    // First vertex: position (5,5,5), normal (0,0,1), rgba (0.1,0.2,0.3,0.4).
    // Position + normal are exact; the rgba channels round through Float32.
    expect(Array.from(out.vertices.slice(0, 6))).toEqual([5, 5, 5, 0, 0, 1]);
    expect(out.vertices[6]).toBeCloseTo(0.1);
    expect(out.vertices[7]).toBeCloseTo(0.2);
    expect(out.vertices[8]).toBeCloseTo(0.3);
    expect(out.vertices[9]).toBeCloseTo(0.4);
    // Every vertex carries the same flat normal + rgba within a mesh.
    for (let v = 0; v < out.count * 3; v++) {
      const o = v * SURFACE_VERTEX_FLOATS;
      expect(norm3(out.vertices, o + 3)).toBeCloseTo(1, 6); // unit normal
      expect(out.vertices[o + 9]).toBeCloseTo(0.4); // alpha preserved
    }
  });

  it('computes each triangle centroid as the mean of its three vertices', () => {
    const out = flattenSurfaceMeshes([{ mesh: fakeMesh(2, 5), rgba: [0, 0, 0, 1] }]);
    expect(out.centroids).toHaveLength(2 * 3);
    // Triangle 0 vertices all at (5,5,5); triangle 1 all at (6,6,6).
    expect(Array.from(out.centroids)).toEqual([5, 5, 5, 6, 6, 6]);
  });

  it('concatenates multiple meshes in order, each with its own colour', () => {
    const out = flattenSurfaceMeshes([
      { mesh: fakeMesh(1, 0), rgba: [1, 0, 0, 0.5] },
      { mesh: fakeMesh(1, 9), rgba: [0, 1, 0, 0.25] },
    ]);
    expect(out.count).toBe(2);
    const stride = SURFACE_VERTEX_FLOATS;
    // First triangle's first vertex is red; the second mesh's first vertex is green.
    expect(out.vertices[6]).toBeCloseTo(1); // mesh A red channel
    expect(out.vertices[3 * stride + 7]).toBeCloseTo(1); // mesh B green channel
    expect(out.vertices[3 * stride + 9]).toBeCloseTo(0.25); // mesh B alpha
  });
});
