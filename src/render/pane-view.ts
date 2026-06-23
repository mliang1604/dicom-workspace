import { Orientation } from '../dicom/types';
import type { OrbitCamera } from './camera';
import type { PaneRect, Vec2 } from './layout';
import type { ObliqueRotation, PatientPlane } from './reslice';
import type { ProjectionMode } from './projection';
import type { TransferFunction } from './transfer-function';
import type { DvrLighting } from './dvr';

/** One MPR pane: an orientation/slice of the volume drawn into a viewport rect. */
export interface MprPaneView {
  readonly kind: 'mpr';
  readonly orientation: Orientation;
  /** Index of the slice along the orientation's axis. */
  readonly sliceIndex: number;
  readonly windowCenter: number;
  readonly windowWidth: number;
  /** Magnification factor; 1 fits the slice to the pane, >1 zooms in. */
  readonly zoom: number;
  /** Pan offset in screen-uv (pane-fraction) units; defaults to no shift. */
  readonly pan?: Vec2;
  /**
   * Oblique tilt of the slice plane off its anatomical default. Omitted (or
   * {@link NO_OBLIQUE}) keeps the orthogonal plane; a non-zero tilt reslices the
   * pane along an arbitrary oblique/double-oblique plane.
   */
  readonly rotation?: ObliqueRotation;
  /** Mirror the in-plane horizontal axis (e.g. flip the sagittal view L/R). */
  readonly flipX?: boolean;
  /** Invert the windowed grayscale (white ⇄ black); omitted/false renders normally. */
  readonly invert?: boolean;
  /**
   * Which volume this pane draws: 0 (default) = the base; ≥ 1 = the overlay layer
   * drawn standalone (the Compare layout's second column). Out of the loaded set
   * it falls back to the base.
   */
  readonly group?: number;
  /**
   * Composite the fusion overlay over this pane (the default). False in Compare,
   * where each column shows a single layer with no blend.
   */
  readonly composite?: boolean;
  /** Destination rectangle in device pixels, origin top-left. */
  readonly rect: PaneRect;
}

/** The 3D MIP pane: an orbit camera projecting the volume into a viewport rect. */
export interface MipPaneView {
  readonly kind: 'mip';
  readonly windowCenter: number;
  readonly windowWidth: number;
  /** Orbit camera state (azimuth/elevation/zoom). */
  readonly camera: OrbitCamera;
  /**
   * Which projection to accumulate along each ray. Omitted defaults to
   * {@link ProjectionMode.Max} (MIP), reproducing the historical behaviour.
   */
  readonly projectionMode?: ProjectionMode;
  /**
   * Thickness (mm) of the projected slab, centred on the volume along the view
   * direction. Omitted or ≥ the volume's full depth projects the whole volume.
   */
  readonly slabThicknessMm?: number;
  /**
   * Transfer function for {@link ProjectionMode.Dvr}; ignored by the projection
   * modes. A preset's table (see {@link transferFunction}) or a live-edited copy
   * of one. Omitted defaults to the {@link TransferFunctionPreset.CtBone} preset.
   */
  readonly transferFunction?: TransferFunction;
  /**
   * Lighting/shading for {@link ProjectionMode.Dvr}; ignored by the projection
   * modes. Omitted defaults to {@link DEFAULT_DVR_LIGHTING} (a plain headlight).
   */
  readonly lighting?: DvrLighting;
  /**
   * Clip the 3D pane to the current MPR slice planes for a cut-away view. Needs
   * {@link sliceIndices}; applies to every mode (projection and DVR alike).
   */
  readonly clipToPlanes?: boolean;
  /**
   * Current axial/coronal/sagittal slice indices (in {@link Orientation} order),
   * used to place the cut-away planes when {@link clipToPlanes} is set.
   */
  readonly sliceIndices?: readonly [number, number, number];
  /**
   * An arbitrary handle-driven cut-plane (patient space) clipping every ray to
   * the side its normal points into, independent of {@link clipToPlanes}. Omitted
   * leaves the free cut-plane off.
   */
  readonly cutPlane?: PatientPlane;
  /**
   * Render at a reduced level of detail (fewer march samples) for a smoother
   * frame while the view is being manipulated. Omitted/false renders the
   * full-quality image, identical to the settled output.
   */
  readonly interactive?: boolean;
  /**
   * Invert the windowed grayscale of the projection (MIP/MinIP/Average), matching
   * the MPR panes' display inversion. Ignored by DVR, which maps colour through
   * the transfer function. Omitted/false renders normally.
   */
  readonly invert?: boolean;
  /** Destination rectangle in device pixels, origin top-left. */
  readonly rect: PaneRect;
}

/** A pane to draw: an MPR slice or the 3D MIP, discriminated by `kind`. */
export type PaneView = MprPaneView | MipPaneView;
