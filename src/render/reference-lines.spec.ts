import { Orientation, type Volume, type VolumeGeometry } from '../dicom/types';
import type { PaneRect, Vec2 } from './layout';
import { referenceLineGeometry, type ReferenceLinePane } from './reference-lines';
import { NO_OBLIQUE } from './reslice';

function makeVolume(dims: [number, number, number], geometry?: VolumeGeometry): Volume {
  const [x, y, z] = dims;
  return {
    dims,
    spacing: [1, 1, 1],
    data: new Float32Array(x * y * z),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry,
  };
}

const RECTS: readonly [PaneRect, PaneRect, PaneRect] = [
  { x: 0, y: 0, width: 100, height: 100 }, // axial
  { x: 100, y: 0, width: 100, height: 100 }, // coronal
  { x: 200, y: 0, width: 100, height: 100 }, // sagittal
];

/** A full set of orthogonal MPR panes (one per orientation) in one compare group. */
function orthoPanes(group = 0): ReferenceLinePane[] {
  return [
    { orientation: Orientation.Axial, rect: RECTS[0], group },
    { orientation: Orientation.Coronal, rect: RECTS[1], group },
    { orientation: Orientation.Sagittal, rect: RECTS[2], group },
  ];
}

const OBLIQUES = [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE] as const;
const ZOOMS = [1, 1, 1] as const;
const NO_PAN: Vec2 = { x: 0, y: 0 };
const PANS = [NO_PAN, NO_PAN, NO_PAN] as const;
const COLORS = ['#f00', '#0f0', '#00f'] as const;
const INDICES = [2, 2, 2] as const; // centre slice of a 4-slice box

function lines(panes: ReferenceLinePane[]): ReturnType<typeof referenceLineGeometry> {
  const volume = makeVolume([4, 4, 4]);
  return referenceLineGeometry(volume, panes, INDICES, OBLIQUES, ZOOMS, PANS, false, COLORS);
}

describe('referenceLineGeometry', () => {
  it('pairs every pane with the two other orthogonal planes', () => {
    const result = lines(orthoPanes());
    // 3 panes × 2 crossing planes each.
    expect(result).toHaveLength(6);
    expect(new Set(result.map((l) => l.key))).toEqual(
      new Set(['0-0-1', '0-0-2', '0-1-0', '0-1-2', '0-2-0', '0-2-1']),
    );
  });

  it('draws each line on the target pane and colours it by the crossing plane', () => {
    for (const l of lines(orthoPanes())) {
      const [, intoStr, otherStr] = l.key.split('-');
      const into = Number(intoStr) as Orientation;
      const other = Number(otherStr) as Orientation;
      expect(l.rect).toBe(RECTS[into]); // drawn on the target ("into") pane
      expect(l.color).toBe(COLORS[other]); // coloured like the crossing plane
    }
  });

  it('never pairs a pane with another orientation in a different compare group', () => {
    // Axial+coronal in group 0, sagittal alone in group 1: only the in-group pair
    // (axial↔coronal) yields lines; nothing crosses the group boundary.
    const panes: ReferenceLinePane[] = [
      { orientation: Orientation.Axial, rect: RECTS[0], group: 0 },
      { orientation: Orientation.Coronal, rect: RECTS[1], group: 0 },
      { orientation: Orientation.Sagittal, rect: RECTS[2], group: 1 },
    ];
    const result = lines(panes);
    expect(new Set(result.map((l) => l.key))).toEqual(new Set(['0-0-1', '0-1-0']));
  });

  it('keeps two compare groups independent (no cross-group pairing)', () => {
    const result = lines([...orthoPanes(0), ...orthoPanes(1)]);
    // Each group pairs internally (6 lines) and never across (would be 12 total).
    expect(result).toHaveLength(12);
    expect(result.filter((l) => l.key.startsWith('0-'))).toHaveLength(6);
    expect(result.filter((l) => l.key.startsWith('1-'))).toHaveLength(6);
  });

  it('never pairs a pane with itself', () => {
    for (const l of lines(orthoPanes())) {
      const [, into, other] = l.key.split('-');
      expect(into).not.toBe(other);
    }
  });

  it('returns nothing for fewer than two panes', () => {
    expect(lines([])).toEqual([]);
    expect(lines([{ orientation: Orientation.Axial, rect: RECTS[0], group: 0 }])).toEqual([]);
  });

  it('mirrors the sagittal pane lines when the sagittal flip is on', () => {
    const volume = makeVolume([4, 4, 4]);
    const panes = orthoPanes();
    const unflipped = referenceLineGeometry(
      volume,
      panes,
      INDICES,
      OBLIQUES,
      ZOOMS,
      PANS,
      false,
      COLORS,
    );
    const flipped = referenceLineGeometry(
      volume,
      panes,
      INDICES,
      OBLIQUES,
      ZOOMS,
      PANS,
      true,
      COLORS,
    );
    const sagKey = '0-2-0'; // group 0, sagittal pane ("into") crossed by axial
    const a = unflipped.find((l) => l.key === sagKey);
    const b = flipped.find((l) => l.key === sagKey);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // The flip mirrors horizontally about the pane centre (x = rect.x + width/2).
    const mid = RECTS[2].x + RECTS[2].width / 2;
    expect(b!.x1).toBeCloseTo(2 * mid - a!.x1, 6);
    expect(b!.x2).toBeCloseTo(2 * mid - a!.x2, 6);
    // Only the sagittal pane flips; the axial line is untouched.
    const axial = '0-0-2';
    expect(flipped.find((l) => l.key === axial)!.x1).toBeCloseTo(
      unflipped.find((l) => l.key === axial)!.x1,
      6,
    );
  });
});
