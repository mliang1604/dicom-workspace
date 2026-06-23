import {
  Orientation,
  type Contour,
  type Roi,
  type StructureSet,
  type Vec3,
  type Volume,
} from '../dicom/types';
import { NO_OBLIQUE, type ObliqueRotation } from './reslice';
import type { PaneRect } from './layout';
import {
  rgbColor,
  roiContourCoords,
  roiKeyOf,
  roiPlaneShapes,
  roiScreenShapes,
  setIsShown,
  type RoiContourCoords,
  type RoiOverlayPane,
} from './roi-overlay';

/** An identity-geometry cube whose patient coordinates equal voxel indices. */
function makeVolume(dim: number): Volume {
  return {
    dims: [dim, dim, dim],
    spacing: [1, 1, 1],
    data: new Float32Array(dim * dim * dim),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
  };
}

/** A CLOSED_PLANAR axial square at z, spanning x,y ∈ [2, 5]. */
function squareLoop(z: number): Contour {
  const points: Vec3[] = [
    [2, 2, z],
    [5, 2, z],
    [5, 5, z],
    [2, 5, z],
  ];
  return { geometricType: 'CLOSED_PLANAR', points };
}

function roi(number: number, color: Roi['color'], contours: Contour[]): Roi {
  return { number, name: `ROI ${number}`, color, interpretedType: null, contours };
}

function structureSet(rois: Roi[]): StructureSet {
  return {
    name: 'ss.dcm',
    label: null,
    frameOfReferenceUid: null,
    referencedSeriesUids: [],
    rois,
  };
}

const ALL_ORIENTATIONS = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal] as const;
const NO_OBLIQUES: readonly ObliqueRotation[] = [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE];

describe('rgbColor', () => {
  it('formats an RTSTRUCT colour as a CSS rgb() string', () => {
    expect(rgbColor([255, 128, 0])).toBe('rgb(255, 128, 0)');
  });

  it('falls back to a neutral grey when the colour is absent', () => {
    expect(rgbColor(null)).toBe('rgb(200, 200, 200)');
  });
});

describe('roiKeyOf', () => {
  it('qualifies the ROI number by its structure-set index', () => {
    expect(roiKeyOf(0, 1)).toBe('0:1');
    expect(roiKeyOf(2, 1)).toBe('2:1');
    expect(roiKeyOf(0, 1)).not.toBe(roiKeyOf(1, 1));
  });
});

describe('setIsShown', () => {
  it('shows every set when the selector is negative (all)', () => {
    expect(setIsShown(-1, 0)).toBe(true);
    expect(setIsShown(-1, 3)).toBe(true);
  });

  it('shows only the selected set otherwise', () => {
    expect(setIsShown(1, 1)).toBe(true);
    expect(setIsShown(1, 0)).toBe(false);
  });
});

describe('roiContourCoords', () => {
  const volume = makeVolume(8);

  it('projects each ROI into every requested orientation with its base colour', () => {
    const sets = [structureSet([roi(1, [255, 0, 0], [squareLoop(4)])])];
    const coords = roiContourCoords(volume, sets, ALL_ORIENTATIONS, NO_OBLIQUES);

    for (const orientation of ALL_ORIENTATIONS) {
      const rois = coords.get(orientation);
      expect(rois).toHaveLength(1);
      expect(rois![0]).toMatchObject({ setIndex: 0, roiNumber: 1, baseColor: 'rgb(255, 0, 0)' });
      expect(rois![0].contours).toHaveLength(1);
    }
  });

  it('only projects the orientations it is asked for', () => {
    const sets = [structureSet([roi(1, [0, 0, 0], [squareLoop(4)])])];
    const coords = roiContourCoords(volume, sets, [Orientation.Axial], NO_OBLIQUES);

    expect([...coords.keys()]).toEqual([Orientation.Axial]);
  });

  it('falls back to neutral grey when the ROI has no colour', () => {
    const sets = [structureSet([roi(7, null, [squareLoop(4)])])];
    const coords = roiContourCoords(volume, sets, [Orientation.Axial], NO_OBLIQUES);

    expect(coords.get(Orientation.Axial)![0].baseColor).toBe('rgb(200, 200, 200)');
  });

  it('drops ROIs whose contours are all degenerate, and orientations with none', () => {
    const sets = [structureSet([roi(1, null, [{ geometricType: 'POINT', points: [[1, 1, 1]] }])])];
    const coords = roiContourCoords(volume, sets, ALL_ORIENTATIONS, NO_OBLIQUES);

    expect(coords.size).toBe(0);
  });

  it('returns an empty map for no structure sets', () => {
    expect(roiContourCoords(volume, [], ALL_ORIENTATIONS, NO_OBLIQUES).size).toBe(0);
  });
});

/** Project a single-ROI set so the plane/screen stages have cached coords to chew on. */
function axialCoords(
  volume: Volume,
  roiNumber: number,
  color: Roi['color'],
  z: number,
): Map<Orientation, RoiContourCoords[]> {
  const sets = [structureSet([roi(roiNumber, color, [squareLoop(z)])])];
  return roiContourCoords(volume, sets, ALL_ORIENTATIONS, NO_OBLIQUES);
}

describe('roiPlaneShapes', () => {
  const volume = makeVolume(8);
  const baseOptions = {
    sliceIndices: [4, 3, 3] as const,
    shown: new Set<Orientation>([Orientation.Axial]),
    hidden: new Set<string>(),
    colorOverrides: new Map<string, string>(),
    opacities: new Map<string, number>(),
    selectedSet: -1,
    decimateTolerance: 0,
  };

  it('classifies the coplanar loop on its own slice into a closed polyline', () => {
    const coords = axialCoords(volume, 1, [255, 0, 0], 4);
    const shapes = roiPlaneShapes(volume, coords, baseOptions);

    const axial = shapes.get(Orientation.Axial);
    expect(axial).toHaveLength(1);
    expect(axial![0]).toMatchObject({ key: '0:1', color: 'rgb(255, 0, 0)', opacity: 1 });
    expect(axial![0].polylines[0].closed).toBe(true);
  });

  it('skips orientations whose panes are not shown', () => {
    const coords = axialCoords(volume, 1, [255, 0, 0], 4);
    const shapes = roiPlaneShapes(volume, coords, baseOptions);

    expect(shapes.has(Orientation.Coronal)).toBe(false);
    expect(shapes.has(Orientation.Sagittal)).toBe(false);
  });

  it('culls an ROI scrolled off the displayed slice (no polylines)', () => {
    const coords = axialCoords(volume, 1, [255, 0, 0], 4);
    const shapes = roiPlaneShapes(volume, coords, { ...baseOptions, sliceIndices: [6, 3, 3] });

    expect(shapes.size).toBe(0);
  });

  it('hides an ROI listed in the hidden set', () => {
    const coords = axialCoords(volume, 1, [255, 0, 0], 4);
    const shapes = roiPlaneShapes(volume, coords, {
      ...baseOptions,
      hidden: new Set(['0:1']),
    });

    expect(shapes.size).toBe(0);
  });

  it('filters ROIs by the structure-set selector', () => {
    const coords = axialCoords(volume, 1, [255, 0, 0], 4);
    // The only set is index 0; selecting set 1 hides it.
    expect(roiPlaneShapes(volume, coords, { ...baseOptions, selectedSet: 1 }).size).toBe(0);
    expect(roiPlaneShapes(volume, coords, { ...baseOptions, selectedSet: 0 }).size).toBe(1);
  });

  it('applies per-ROI colour and opacity overrides', () => {
    const coords = axialCoords(volume, 1, [255, 0, 0], 4);
    const shapes = roiPlaneShapes(volume, coords, {
      ...baseOptions,
      colorOverrides: new Map([['0:1', '#00ff00']]),
      opacities: new Map([['0:1', 0.5]]),
    });

    expect(shapes.get(Orientation.Axial)![0]).toMatchObject({ color: '#00ff00', opacity: 0.5 });
  });

  it('returns an empty map when there are no cached coords', () => {
    expect(roiPlaneShapes(volume, new Map(), baseOptions).size).toBe(0);
  });
});

describe('roiScreenShapes', () => {
  const volume = makeVolume(8);
  const rect: PaneRect = { x: 0, y: 0, width: 100, height: 100 };
  const zooms = [1, 1, 1] as const;
  const pans = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ] as const;

  function axialPlaneShapes() {
    const coords = axialCoords(volume, 1, [255, 0, 0], 4);
    return roiPlaneShapes(volume, coords, {
      sliceIndices: [4, 3, 3],
      shown: new Set<Orientation>([Orientation.Axial]),
      hidden: new Set<string>(),
      colorOverrides: new Map<string, string>(),
      opacities: new Map<string, number>(),
      selectedSet: -1,
      decimateTolerance: 0,
    });
  }

  it('projects plane shapes to pane-local pixels, propagating colour and opacity', () => {
    const planes = axialPlaneShapes();
    const panes: RoiOverlayPane[] = [{ key: 'p0', orientation: Orientation.Axial, rect }];
    const overlays = roiScreenShapes(volume, planes, panes, zooms, pans, false);

    expect(overlays).toHaveLength(1);
    expect(overlays[0].key).toBe('p0');
    const shape = overlays[0].shapes[0];
    expect(shape.key).toBe('0:1:0');
    expect(shape.color).toBe('rgb(255, 0, 0)');
    expect(shape.closed).toBe(true);
    // Four corners of the square loop, as "x,y" pairs relative to the pane origin.
    expect(shape.points.split(' ')).toHaveLength(4);
  });

  it('skips panes whose orientation has no plane shapes', () => {
    const planes = axialPlaneShapes();
    const panes: RoiOverlayPane[] = [{ key: 'p1', orientation: Orientation.Coronal, rect }];
    expect(roiScreenShapes(volume, planes, panes, zooms, pans, false)).toHaveLength(0);
  });

  it('drops a degenerate pane rect', () => {
    const planes = axialPlaneShapes();
    const panes: RoiOverlayPane[] = [
      { key: 'p0', orientation: Orientation.Axial, rect: { x: 0, y: 0, width: 0, height: 0 } },
    ];
    expect(roiScreenShapes(volume, planes, panes, zooms, pans, false)).toHaveLength(0);
  });

  it('mirrors the sagittal pane when flipped', () => {
    const coords = axialCoords(volume, 1, [255, 0, 0], 4);
    const planes = roiPlaneShapes(volume, coords, {
      sliceIndices: [4, 3, 3],
      shown: new Set<Orientation>([Orientation.Sagittal]),
      hidden: new Set<string>(),
      colorOverrides: new Map<string, string>(),
      opacities: new Map<string, number>(),
      selectedSet: -1,
      decimateTolerance: 0,
    });
    const panes: RoiOverlayPane[] = [{ key: 's', orientation: Orientation.Sagittal, rect }];

    const upright = roiScreenShapes(volume, planes, panes, zooms, pans, false);
    const flipped = roiScreenShapes(volume, planes, panes, zooms, pans, true);

    expect(upright[0].shapes[0].points).not.toBe('');
    // The flip mirrors u → the projected pixels differ from the upright pane.
    expect(flipped[0].shapes[0].points).not.toBe(upright[0].shapes[0].points);
  });

  it('returns an empty array when there are no plane shapes', () => {
    const panes: RoiOverlayPane[] = [{ key: 'p0', orientation: Orientation.Axial, rect }];
    expect(roiScreenShapes(volume, new Map(), panes, zooms, pans, false)).toHaveLength(0);
  });
});
