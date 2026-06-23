import { Orientation, type Volume, type VolumeGeometry } from '../dicom/types';
import { NO_OBLIQUE } from './reslice';
import { ProjectionMode, type MipPaneView, type MprPaneView } from './slice-renderer';
import { transferFunction, TransferFunctionPreset } from './transfer-function';
import { DEFAULT_DVR_LIGHTING } from './dvr';
import { composePaneViews, type FrameInput, type FramePane, type GroupView } from './frame';

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

const NO_PAN = { x: 0, y: 0 } as const;
const NO_PANS = [NO_PAN, NO_PAN, NO_PAN] as const;
const NO_OBLIQUES = [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE] as const;
const RECT = { x: 0, y: 0, width: 100, height: 100 } as const;

function mprPane(orientation: Orientation, group = 0): FramePane {
  return { kind: 'mpr', orientation, rect: RECT, group };
}

const MIP_PANE: FramePane = { kind: 'mip', rect: RECT };

/** A baseline single-volume, non-Compare frame; tests override what they exercise. */
function baseInput(overrides: Partial<FrameInput> = {}): FrameInput {
  return {
    panes: [mprPane(Orientation.Axial)],
    dpr: 1,
    baseVolume: makeVolume([4, 4, 4]),
    overlayVolume: null,
    sliceIndices: [2, 2, 2],
    zooms: [1, 1, 1],
    pans: NO_PANS,
    obliques: NO_OBLIQUES,
    windowCenter: 40,
    windowWidth: 400,
    overlayWindow: null,
    compareMode: false,
    compareLinked: true,
    groupNav: [],
    hasOverlay: false,
    invert: false,
    sagittalFlipped: false,
    mipInteractive: false,
    camera: { azimuth: 0, elevation: 0, zoom: 1, panX: 0, panY: 0 },
    projectionMode: ProjectionMode.Max,
    transferFunction: transferFunction(TransferFunctionPreset.CtBone),
    lighting: DEFAULT_DVR_LIGHTING,
    clipToPlanes: false,
    cutPlane: null,
    slabThicknessMm: 50,
    ...overrides,
  };
}

const INDEPENDENT_NAV: GroupView = {
  sliceIndices: [1, 1, 1],
  zooms: [3, 3, 3],
  pans: [
    { x: 0.25, y: 0.25 },
    { x: 0.25, y: 0.25 },
    { x: 0.25, y: 0.25 },
  ],
};

describe('composePaneViews', () => {
  it('assembles an MPR pane from the master nav outside Compare', () => {
    const [view] = composePaneViews(baseInput()) as [MprPaneView];
    expect(view.kind).toBe('mpr');
    expect(view.orientation).toBe(Orientation.Axial);
    expect(view.sliceIndex).toBe(2);
    expect(view.zoom).toBe(1);
    expect(view.pan).toEqual(NO_PAN);
    expect(view.windowCenter).toBe(40);
    expect(view.windowWidth).toBe(400);
    // Outside Compare every pane composites the fusion overlay over the base layer.
    expect(view.composite).toBe(true);
    expect(view.group).toBe(0);
  });

  it('scales each pane rect to device pixels', () => {
    const [view] = composePaneViews(baseInput({ dpr: 2 }));
    expect(view.rect).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });

  it('flips only the sagittal pane when sagittalFlipped is set', () => {
    const views = composePaneViews(
      baseInput({
        panes: [mprPane(Orientation.Axial), mprPane(Orientation.Sagittal)],
        sagittalFlipped: true,
      }),
    ) as MprPaneView[];
    expect(views[0].flipX).toBe(false);
    expect(views[1].flipX).toBe(true);
  });

  describe('Compare linked vs independent groups', () => {
    const comparePanes = [mprPane(Orientation.Axial, 0), mprPane(Orientation.Axial, 1)];

    it('draws every group from the shared master nav while linked', () => {
      const [base, overlay] = composePaneViews(
        baseInput({
          panes: comparePanes,
          compareMode: true,
          compareLinked: true,
          groupNav: [INDEPENDENT_NAV, INDEPENDENT_NAV],
        }),
      ) as [MprPaneView, MprPaneView];
      // Group 1 ignores its independent nav while linked: same zoom/pan as the
      // base column, and the same slice (a self-mapping round-trips to master).
      expect(overlay.zoom).toBe(base.zoom);
      expect(overlay.zoom).toBe(1);
      expect(overlay.pan).toEqual(NO_PAN);
      expect(overlay.sliceIndex).toBe(2);
    });

    it('draws the non-base group from its own nav while unlinked', () => {
      const [base, overlay] = composePaneViews(
        baseInput({
          panes: comparePanes,
          compareMode: true,
          compareLinked: false,
          groupNav: [INDEPENDENT_NAV, INDEPENDENT_NAV],
        }),
      ) as [MprPaneView, MprPaneView];
      // Group 0 still reads the master; group 1 takes its independent slice/zoom/pan.
      expect(base.sliceIndex).toBe(2);
      expect(base.zoom).toBe(1);
      expect(overlay.sliceIndex).toBe(1);
      expect(overlay.zoom).toBe(3);
      expect(overlay.pan).toEqual({ x: 0.25, y: 0.25 });
    });

    it('falls back to the master when a group has no independent nav', () => {
      const [, overlay] = composePaneViews(
        baseInput({
          panes: comparePanes,
          compareMode: true,
          compareLinked: false,
          groupNav: [],
        }),
      ) as [MprPaneView, MprPaneView];
      expect(overlay.sliceIndex).toBe(2);
      expect(overlay.zoom).toBe(1);
    });

    it('maps the linked slice onto a coarser overlay grid', () => {
      // A 2-slice overlay shifted half a base voxel: the base's slice 2 (of 4)
      // projects onto the overlay's own grid rather than copying the index.
      const overlayVolume = makeVolume([4, 4, 2], {
        iStep: [1, 0, 0],
        jStep: [0, 1, 0],
        kStep: [0, 0, 2],
        origin: [0, 0, 0],
      });
      const [, overlay] = composePaneViews(
        baseInput({
          panes: comparePanes,
          baseVolume: makeVolume([4, 4, 4], {
            iStep: [1, 0, 0],
            jStep: [0, 1, 0],
            kStep: [0, 0, 1],
            origin: [0, 0, 0],
          }),
          overlayVolume,
          compareMode: true,
          compareLinked: true,
        }),
      ) as [MprPaneView, MprPaneView];
      // The overlay has only two slices, so the mapped index is clamped into 0..1.
      expect(overlay.sliceIndex).toBeGreaterThanOrEqual(0);
      expect(overlay.sliceIndex).toBeLessThanOrEqual(1);
    });
  });

  describe('fusion vs compare windowing', () => {
    it('composites the overlay over a single column in fusion (non-Compare)', () => {
      const [view] = composePaneViews(
        baseInput({ hasOverlay: true, overlayWindow: { center: 500, width: 100 } }),
      ) as [MprPaneView];
      expect(view.composite).toBe(true);
      expect(view.group).toBe(0);
      // The base window still drives the fused pane; the overlay column is Compare-only.
      expect(view.windowCenter).toBe(40);
    });

    it('windows the Compare overlay column on its own per-layer window', () => {
      const [base, overlay] = composePaneViews(
        baseInput({
          panes: [mprPane(Orientation.Axial, 0), mprPane(Orientation.Axial, 1)],
          compareMode: true,
          hasOverlay: true,
          overlayWindow: { center: 500, width: 100 },
        }),
      ) as [MprPaneView, MprPaneView];
      // Each Compare column draws a single layer standalone (no fusion compositing).
      expect(base.composite).toBe(false);
      expect(overlay.composite).toBe(false);
      // The base column keeps the shared window; the overlay column uses its own.
      expect(base.group).toBe(0);
      expect(base.windowCenter).toBe(40);
      expect(overlay.group).toBe(1);
      expect(overlay.windowCenter).toBe(500);
      expect(overlay.windowWidth).toBe(100);
    });

    it('keeps the non-base column on the base layer when no overlay is selected', () => {
      const [, overlay] = composePaneViews(
        baseInput({
          panes: [mprPane(Orientation.Axial, 0), mprPane(Orientation.Axial, 1)],
          compareMode: true,
          hasOverlay: false,
        }),
      ) as [MprPaneView, MprPaneView];
      expect(overlay.group).toBe(0);
      expect(overlay.windowCenter).toBe(40);
    });
  });

  describe('MIP-settling quality', () => {
    it('renders the 3D pane at reduced quality mid-interaction', () => {
      const [view] = composePaneViews(baseInput({ panes: [MIP_PANE], mipInteractive: true })) as [
        MipPaneView,
      ];
      expect(view.kind).toBe('mip');
      expect(view.interactive).toBe(true);
    });

    it('renders the 3D pane at full quality once interaction settles', () => {
      const [view] = composePaneViews(baseInput({ panes: [MIP_PANE], mipInteractive: false })) as [
        MipPaneView,
      ];
      expect(view.interactive).toBe(false);
    });

    it('packs the 3D pane camera, mode, and clip state', () => {
      const camera = { azimuth: 1, elevation: 0.5, zoom: 2, panX: 1, panY: -1 };
      const [view] = composePaneViews(
        baseInput({
          panes: [MIP_PANE],
          camera,
          projectionMode: ProjectionMode.Dvr,
          clipToPlanes: true,
          slabThicknessMm: 25,
        }),
      ) as [MipPaneView];
      expect(view.camera).toBe(camera);
      expect(view.projectionMode).toBe(ProjectionMode.Dvr);
      expect(view.clipToPlanes).toBe(true);
      expect(view.sliceIndices).toEqual([2, 2, 2]);
      expect(view.slabThicknessMm).toBe(25);
      expect(view.cutPlane).toBeUndefined();
    });
  });
});
