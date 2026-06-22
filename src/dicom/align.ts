import { invert } from './mat4';
import { framesMatch, IDENTITY_MAT4, type Mat4, type Registration } from './types';

/**
 * Resolve how to sample an overlay volume in the base volume's displayed plane,
 * as the patient→patient transform mapping a point in the **base** (fixed) frame
 * of reference to the corresponding point in the **overlay** (moving) frame.
 *
 * This generalises the binary {@link framesMatch} gate that fusion has used so
 * far: two volumes are alignable when they share a frame of reference *or* a
 * Spatial Registration links their frames. The renderer applies the returned
 * transform to the base pane basis before mapping it through the overlay's grid
 * (see `overlayPlaneToTexMatrix` in `render/reslice.ts`).
 *
 * Returns:
 *  - {@link IDENTITY_MAT4} when the frames match directly (no transform needed —
 *    the historical same-frame fusion path, returned as the shared constant so
 *    callers can cheaply detect it by reference);
 *  - the base→overlay matrix when a rigid/affine registration links them,
 *    inverting the stored source→target matrix as the direction requires;
 *  - null when the frames neither match nor are linked (so the caller refuses to
 *    co-register rather than overlaying mis-aligned data).
 *
 * Deformable registrations are not resolved here — they return null in this phase
 * and are wired into fusion separately (the displacement field is a per-sample
 * warp, not a single matrix). A null frame never matches (see {@link framesMatch}).
 */
export function resolveAlignment(
  baseFrame: string | null,
  overlayFrame: string | null,
  registrations: readonly Registration[],
): Mat4 | null {
  if (framesMatch(baseFrame, overlayFrame)) return IDENTITY_MAT4;

  for (const reg of registrations) {
    if (reg.kind !== 'rigid') continue; // deformable: handled in Phase 2
    // reg.matrix maps its sourceFrame → targetFrame (moving → fixed).
    if (framesMatch(reg.sourceFrame, baseFrame) && framesMatch(reg.targetFrame, overlayFrame)) {
      // base is the registration's source: base → overlay is the matrix directly.
      return reg.matrix;
    }
    if (framesMatch(reg.sourceFrame, overlayFrame) && framesMatch(reg.targetFrame, baseFrame)) {
      // base is the registration's target: base → overlay is the inverse.
      const inverse = invert(reg.matrix);
      if (inverse) return inverse;
    }
  }
  return null;
}
