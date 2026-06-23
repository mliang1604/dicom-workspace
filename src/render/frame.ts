import { Orientation, type Volume } from '../dicom/types';
import { scaleRect, type PaneRect, type Vec2 } from './layout';
import { linkedSliceIndex, type ObliqueRotation, type PatientPlane } from './reslice';
import type { OrbitCamera } from './camera';
import { type PaneView, type ProjectionMode } from './slice-renderer';
import type { TransferFunction } from './transfer-function';
import type { DvrLighting } from './dvr';
import type { WindowLevel } from './window-level';

/** A value per orientation, indexed by the orientation's numeric value. */
type PerOrientation = readonly [number, number, number];
/** A pan offset per orientation, indexed by the orientation's numeric value. */
type PerOrientationPan = readonly [Vec2, Vec2, Vec2];
/** A tilt per orientation, indexed by the orientation's numeric value. */
type PerOrientationOblique = readonly [ObliqueRotation, ObliqueRotation, ObliqueRotation];

/**
 * A pane's placement, in CSS pixels, plus what it shows — the plain shape the
 * frame composition consumes (structurally the viewer's `PanePlacement`). The
 * rect is scaled to device pixels here, so callers pass CSS-pixel rects.
 */
export type FramePane =
  | {
      readonly kind: 'mpr';
      readonly orientation: Orientation;
      readonly rect: PaneRect;
      /** Compare-group index (0 unless the Compare layout splits into columns). */
      readonly group: number;
    }
  | { readonly kind: 'mip'; readonly rect: PaneRect };

/**
 * Independent navigation state for one Compare group, used only when the groups
 * are unlinked. Structurally the viewer's `GroupNav`; kept render-layer-local so
 * the composition stays free of any UI/store dependency.
 */
export interface GroupView {
  readonly sliceIndices: PerOrientation;
  readonly zooms: PerOrientation;
  readonly pans: PerOrientationPan;
}

/**
 * Everything the per-frame pane composition reads, as plain values (no signals).
 * The viewer gathers these from its signals once per frame and hands them off so
 * the regression-prone assembly — Compare linking, per-group nav, fusion vs
 * compare windowing, MIP settling quality — is a pure, unit-testable function.
 */
export interface FrameInput {
  /** Panes to draw, in CSS pixels (scaled to device pixels by {@link dpr}). */
  readonly panes: readonly FramePane[];
  /** Device-pixel ratio used to scale each pane's CSS rect. */
  readonly dpr: number;
  /** The base series volume (group 0). */
  readonly baseVolume: Volume;
  /**
   * The overlay layer's volume, drawn by the non-base Compare groups and used to
   * map the linked slice onto its grid. Null falls back to the base volume.
   */
  readonly overlayVolume: Volume | null;
  /** Master per-orientation slice indices (axial/coronal/sagittal). */
  readonly sliceIndices: PerOrientation;
  /** Master per-orientation zoom factors. */
  readonly zooms: PerOrientation;
  /** Master per-orientation pan offsets. */
  readonly pans: PerOrientationPan;
  /** Per-orientation oblique tilts (shared by the linked groups). */
  readonly obliques: PerOrientationOblique;
  /** Shared base-layer window centre. */
  readonly windowCenter: number;
  /** Shared base-layer window width. */
  readonly windowWidth: number;
  /** The overlay column's own window/level (Compare); null when no overlay. */
  readonly overlayWindow: WindowLevel | null;
  /** Whether the Compare side-by-side layout is active. */
  readonly compareMode: boolean;
  /** Whether the Compare columns navigate together (linked) or independently. */
  readonly compareLinked: boolean;
  /** Per-group independent nav, read only while unlinked. */
  readonly groupNav: readonly GroupView[];
  /** Whether an overlay layer is selected (drives the Compare overlay column). */
  readonly hasOverlay: boolean;
  /** Invert the windowed grayscale across every pane. */
  readonly invert: boolean;
  /** Mirror the sagittal pane's horizontal axis (L/R flip). */
  readonly sagittalFlipped: boolean;
  /** Render the 3D pane at reduced quality (mid-interaction). */
  readonly mipInteractive: boolean;
  /** Orbit camera state for the 3D pane. */
  readonly camera: OrbitCamera;
  readonly projectionMode: ProjectionMode;
  readonly transferFunction: TransferFunction;
  readonly lighting: DvrLighting;
  readonly clipToPlanes: boolean;
  /** Free handle-driven cut-plane for the 3D pane; null leaves it off. */
  readonly cutPlane: PatientPlane | null;
  readonly slabThicknessMm: number;
}

/** Whether a Compare group navigates on its own (unlinked, and not the base group). */
function isIndependent(group: number, compareMode: boolean, compareLinked: boolean): boolean {
  return compareMode && !compareLinked && group > 0;
}

/**
 * The volume a Compare group draws: the base layer for group 0, the overlay for
 * the others (falling back to the base when no overlay is loaded).
 */
function groupVolume(group: number, baseVolume: Volume, overlayVolume: Volume | null): Volume {
  return group === 0 ? baseVolume : (overlayVolume ?? baseVolume);
}

/**
 * The slice index a pane shows, resolving linked/unlinked Compare navigation: the
 * master index outside Compare and for group 0; the group's own index while
 * unlinked; and, while linked, the master patient plane mapped onto the group's
 * own grid (so a coarse dose lines up with a fine CT).
 */
function resolveSlice(group: number, orientation: Orientation, input: FrameInput): number {
  const master = input.sliceIndices[orientation];
  if (!input.compareMode || group === 0) return master;
  if (!input.compareLinked) return input.groupNav[group]?.sliceIndices[orientation] ?? master;
  const target = groupVolume(group, input.baseVolume, input.overlayVolume);
  return linkedSliceIndex(
    input.baseVolume,
    target,
    orientation,
    master,
    input.obliques[orientation],
  );
}

/** The zoom a pane uses: shared while linked, the group's own when unlinked. */
function resolveZoom(group: number, orientation: Orientation, input: FrameInput): number {
  const master = input.zooms[orientation];
  if (!isIndependent(group, input.compareMode, input.compareLinked)) return master;
  return input.groupNav[group]?.zooms[orientation] ?? master;
}

/** The pan a pane uses: shared while linked, the group's own when unlinked. */
function resolvePan(group: number, orientation: Orientation, input: FrameInput): Vec2 {
  const master = input.pans[orientation];
  if (!isIndependent(group, input.compareMode, input.compareLinked)) return master;
  return input.groupNav[group]?.pans[orientation] ?? master;
}

/**
 * Build the {@link PaneView} descriptors the renderer draws from the current
 * frame state, in device pixels. Pure: every input is a plain value, so the same
 * inputs always yield the same views. The fragment-shader geometry the views feed
 * lives in `slice-shader.ts`; this only decides, per pane, *what* to draw —
 * which layer, slice, window/level, zoom/pan — resolving the Compare linking,
 * per-group nav, fusion-vs-compare windowing, and MIP-settling quality.
 *
 * In the Compare layout each column draws its own layer standalone (no fusion
 * compositing); the non-base column (group ≥ 1) shows the overlay layer windowed
 * by its own window/level. Elsewhere every pane composites the fusion overlay.
 */
export function composePaneViews(input: FrameInput): PaneView[] {
  const { dpr, invert, windowCenter, windowWidth, compareMode } = input;
  return input.panes.map((pane) => {
    if (pane.kind === 'mip') {
      return {
        kind: 'mip',
        windowCenter,
        windowWidth,
        camera: input.camera,
        projectionMode: input.projectionMode,
        transferFunction: input.transferFunction,
        lighting: input.lighting,
        clipToPlanes: input.clipToPlanes,
        sliceIndices: input.sliceIndices,
        cutPlane: input.cutPlane ?? undefined,
        slabThicknessMm: input.slabThicknessMm,
        interactive: input.mipInteractive,
        invert,
        rect: scaleRect(pane.rect, dpr),
      };
    }
    const showOverlay = compareMode && pane.group >= 1 && input.hasOverlay;
    return {
      kind: 'mpr',
      orientation: pane.orientation,
      // Resolve the group's slice/zoom/pan: shared (linked) or independent
      // (unlinked), and patient-plane-matched for non-base Compare groups.
      sliceIndex: resolveSlice(pane.group, pane.orientation, input),
      windowCenter: showOverlay ? input.overlayWindow!.center : windowCenter,
      windowWidth: showOverlay ? input.overlayWindow!.width : windowWidth,
      zoom: resolveZoom(pane.group, pane.orientation, input),
      pan: resolvePan(pane.group, pane.orientation, input),
      rotation: input.obliques[pane.orientation],
      flipX: pane.orientation === Orientation.Sagittal && input.sagittalFlipped,
      invert,
      rect: scaleRect(pane.rect, dpr),
      // Which layer this pane draws and whether to composite the overlay over it:
      // group ≥ 1 in Compare draws the overlay layer standalone.
      group: showOverlay ? pane.group : 0,
      composite: !compareMode,
    };
  });
}
