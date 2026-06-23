import type { Volume } from '../dicom/types';

/**
 * How the 3D pane turns the volume into a picture. The first three reduce each
 * ray to a single windowed sample (a projection); {@link ProjectionMode.Dvr}
 * composites a lit, coloured volume through a transfer function instead. The
 * numeric values are the codes the raycast shader switches on, kept in sync via
 * {@link projectionModeCode}.
 */
export enum ProjectionMode {
  /** Maximum Intensity Projection — the brightest sample (default). */
  Max = 0,
  /** Minimum Intensity Projection — the darkest sample. */
  Min = 1,
  /** Average (mean) of the samples along the ray. */
  Mean = 2,
  /** Direct volume rendering — front-to-back transfer-function compositing. */
  Dvr = 3,
}

/** Whether a 3D mode is direct volume rendering (vs. a single-value projection). */
export function isDvr(mode: ProjectionMode): boolean {
  return mode === ProjectionMode.Dvr;
}

/** Shader code for a 3D mode; an exhaustive map kept beside the WGSL. */
export function projectionModeCode(mode: ProjectionMode): number {
  switch (mode) {
    case ProjectionMode.Max:
      return 0;
    case ProjectionMode.Min:
      return 1;
    case ProjectionMode.Mean:
      return 2;
    case ProjectionMode.Dvr:
      return 3;
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/** A display window expressed as a DICOM centre/width pair. */
export interface DisplayWindow {
  readonly center: number;
  readonly width: number;
}

/**
 * Effective window/level for the 3D projection pane, chosen by projection mode.
 *
 * MIP (Max) latches onto the brightest sample at every angle, so it keeps the
 * shared MPR window and looks exactly as it does today. MinIP (Min) and Average
 * (Mean) instead track the volume's air-filled margins, whose contribution to
 * the per-ray min/mean slides with the orbit angle; reusing the bright MPR
 * window clamps them to black at some angles. Fitting the window to the volume's
 * full data range keeps those projections visible from every direction.
 */
export function projectionWindow(
  mode: ProjectionMode,
  volume: Volume,
  sharedCenter: number,
  sharedWidth: number,
): DisplayWindow {
  switch (mode) {
    // MIP keeps the shared MPR window; DVR ignores the window entirely (it maps
    // samples through the transfer function), so the shared one is a harmless default.
    case ProjectionMode.Max:
    case ProjectionMode.Dvr:
      return { center: sharedCenter, width: sharedWidth };
    case ProjectionMode.Min:
    case ProjectionMode.Mean:
      return {
        center: (volume.min + volume.max) / 2,
        width: Math.max(1, volume.max - volume.min),
      };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/**
 * Default slab thickness (mm) for a projection mode, given the volume's full
 * depth (`fullDepthMm`, the slab thickness at which the whole volume projects).
 *
 * MIP keeps the full-volume default so it is unchanged. MinIP and Average are
 * used with a thinner slab so the air margins around the anatomy stay out of the
 * min/mean; a moderate band of ~⅓ of the depth (capped to keep it moderate, and
 * clamped into the volume) is a sensible starting point the user can adjust.
 */
export function defaultSlabThicknessMm(mode: ProjectionMode, fullDepthMm: number): number {
  switch (mode) {
    // MIP and DVR render the whole volume by default; the cut-away toggle, not a
    // thin slab, is how DVR reveals the interior.
    case ProjectionMode.Max:
    case ProjectionMode.Dvr:
      return fullDepthMm;
    case ProjectionMode.Min:
    case ProjectionMode.Mean:
      return Math.min(fullDepthMm, Math.max(1, Math.min(fullDepthMm / 3, 50)));
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
