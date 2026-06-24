import { createLabelVolume, labelIndex, paintLabels, type LabelVolume } from './label-volume';
import { parseStructureSet } from './structure-set';
import { writeStructureSet } from './structure-set-writer';
import { buildStructureSet, type AuthoredRoi } from './structure-export';
import type { Vec3, Volume } from './types';

/** An axis-aligned image volume so voxel `(i, j, k)` sits at patient `(i, j, k)·spacing + origin`. */
function imageVolume(
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number] = [1, 1, 1],
  origin: Vec3 = [0, 0, 0],
): Volume {
  const [dx, dy, dz] = dims;
  const [sx, sy, sz] = spacing;
  return {
    dims,
    spacing,
    data: new Float32Array(dx * dy * dz),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry: { iStep: [sx, 0, 0], jStep: [0, sy, 0], kStep: [0, 0, sz], origin },
  };
}

/** Paint id `id` into a rectangular block `[x0,x1)×[y0,y1)` on axial slice `z`. */
function paintBlock(
  label: LabelVolume,
  id: number,
  z: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void {
  const voxels: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) voxels.push(labelIndex(label.dims, x, y, z));
  }
  paintLabels(label, id, voxels);
}

/** A contour's points as a Set of "x,y,z" strings, order-independent. */
function pointSet(points: readonly Vec3[]): Set<string> {
  return new Set(points.map(([x, y, z]) => `${x},${y},${z}`));
}

/** Signed area of a contour projected onto its x/y plane (shoelace). */
function planarArea(points: readonly Vec3[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a / 2);
}

const ROI: AuthoredRoi = { id: 1, name: 'Block', color: [255, 99, 71], interpretedType: 'ORGAN' };

describe('buildStructureSet', () => {
  it('contours a painted block on its slice as a CLOSED_PLANAR loop in patient mm', () => {
    const label = createLabelVolume(imageVolume([4, 4, 2]));
    paintBlock(label, 1, 0, 1, 3, 1, 3); // 2×2 block on slice z=0

    const ss = buildStructureSet(label, [ROI]);
    expect(ss.rois).toHaveLength(1);
    const roi = ss.rois[0];
    expect(roi.number).toBe(1);
    expect(roi.name).toBe('Block');
    expect(roi.color).toEqual([255, 99, 71]);
    expect(roi.interpretedType).toBe('ORGAN');
    expect(roi.contours).toHaveLength(1);

    const contour = roi.contours[0];
    expect(contour.geometricType).toBe('CLOSED_PLANAR');
    // Block voxels (1,1)-(2,2) → corners at half-integer voxel indices → patient mm.
    expect(pointSet(contour.points)).toEqual(
      pointSet([
        [0.5, 0.5, 0],
        [2.5, 0.5, 0],
        [2.5, 2.5, 0],
        [0.5, 2.5, 0],
      ]),
    );
    expect(planarArea(contour.points)).toBe(4); // 2×2 mm
  });

  it('honours spacing and origin when mapping to patient space', () => {
    const label = createLabelVolume(imageVolume([4, 4, 1], [2, 3, 5], [10, 20, 30]));
    paintBlock(label, 1, 0, 1, 2, 1, 2); // single voxel (1,1)

    const contour = buildStructureSet(label, [ROI]).rois[0].contours[0];
    // Corners (1,1),(2,1),(2,2),(1,2) → voxel (0.5,0.5)…(0.5,1.5) → ·spacing + origin.
    expect(pointSet(contour.points)).toEqual(
      pointSet([
        [10 + 0.5 * 2, 20 + 0.5 * 3, 30],
        [10 + 1.5 * 2, 20 + 0.5 * 3, 30],
        [10 + 1.5 * 2, 20 + 1.5 * 3, 30],
        [10 + 0.5 * 2, 20 + 1.5 * 3, 30],
      ]),
    );
  });

  it('emits a separate contour per axial slice', () => {
    const label = createLabelVolume(imageVolume([4, 4, 3]));
    paintBlock(label, 1, 0, 1, 3, 1, 3);
    paintBlock(label, 1, 2, 0, 2, 0, 2); // a different block two slices up

    const contours = buildStructureSet(label, [ROI]).rois[0].contours;
    expect(contours).toHaveLength(2);
    // Each loop lies in a single z plane.
    for (const c of contours) {
      const zs = new Set(c.points.map((p) => p[2]));
      expect(zs.size).toBe(1);
    }
    expect(new Set(contours.map((c) => c.points[0][2]))).toEqual(new Set([0, 2]));
  });

  it('emits outer and hole loops for a ring', () => {
    const label = createLabelVolume(imageVolume([5, 5, 1]));
    paintBlock(label, 1, 0, 1, 4, 1, 4); // 3×3 block
    label.data[labelIndex(label.dims, 2, 2, 0)] = 0; // punch a hole in the centre

    const contours = buildStructureSet(label, [ROI]).rois[0].contours;
    expect(contours).toHaveLength(2);
    const areas = contours.map((c) => planarArea(c.points)).sort((a, b) => a - b);
    expect(areas).toEqual([1, 9]); // the 1 mm² hole and the 9 mm² outer square
  });

  it('keeps an unpainted ROI with an empty contour stack', () => {
    const label = createLabelVolume(imageVolume([4, 4, 1]));
    const roi = buildStructureSet(label, [ROI]).rois[0];
    expect(roi.contours).toEqual([]);
  });

  it('separates two structures by id', () => {
    const label = createLabelVolume(imageVolume([4, 4, 1]));
    paintBlock(label, 1, 0, 0, 2, 0, 2);
    paintBlock(label, 2, 0, 2, 4, 2, 4);

    const ss = buildStructureSet(label, [
      ROI,
      { id: 2, name: 'Other', color: [0, 0, 255], interpretedType: null },
    ]);
    expect(ss.rois.map((r) => r.contours.length)).toEqual([1, 1]);
    // The blocks meet only at the shared corner voxel, patient coord 1.5.
    expect(ss.rois[0].contours[0].points.every((p) => p[0] <= 1.5 && p[1] <= 1.5)).toBe(true);
    expect(ss.rois[1].contours[0].points.every((p) => p[0] >= 1.5 && p[1] >= 1.5)).toBe(true);
  });
});

describe('label volume → RTSTRUCT round trip', () => {
  it('survives buildStructureSet → writeStructureSet → parseStructureSet', () => {
    const label = createLabelVolume(imageVolume([6, 6, 2], [1, 1, 2], [0, 0, 0]));
    paintBlock(label, 1, 0, 1, 5, 1, 5); // big block, slice 0
    label.data[labelIndex(label.dims, 3, 3, 0)] = 0; // with a hole
    paintBlock(label, 2, 1, 0, 2, 0, 2); // a second structure on slice 1

    const rois: AuthoredRoi[] = [
      ROI,
      { id: 2, name: 'Two', color: [0, 200, 0], interpretedType: 'PTV' },
    ];
    const built = buildStructureSet(label, rois, {
      label: 'Authored',
      frameOfReferenceUid: '1.2.840.FOR',
      referencedSeriesUids: ['1.2.840.SERIES'],
    });

    const parsed = parseStructureSet('rt.dcm', writeStructureSet(built))!;
    expect(parsed.label).toBe('Authored');
    expect(parsed.frameOfReferenceUid).toBe('1.2.840.FOR');
    expect(parsed.referencedSeriesUids).toEqual(['1.2.840.SERIES']);
    expect(parsed.rois).toHaveLength(2);

    for (let i = 0; i < built.rois.length; i++) {
      const before = built.rois[i];
      const after = parsed.rois[i];
      expect(after.number).toBe(before.number);
      expect(after.name).toBe(before.name);
      expect(after.color).toEqual(before.color);
      expect(after.interpretedType).toBe(before.interpretedType);
      expect(after.contours.map((c) => c.points)).toEqual(before.contours.map((c) => c.points));
    }
  });
});
