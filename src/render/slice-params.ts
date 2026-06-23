import type { Vec3, Volume } from '../dicom/types';
import { normalize } from '../dicom/vec3';
import { cameraBasis, type CameraBasis } from './camera';
import type { PaneRect, Vec2 } from './layout';
import {
  clipPlaneTex,
  slabTRange,
  viewClipHalfSpaces,
  volumeBounds,
  type HalfSpace,
} from './reslice';
import { ProjectionMode, projectionModeCode, projectionWindow } from './projection';
import type { MipPaneView } from './pane-view';
import { DEFAULT_DVR_LIGHTING, dvrLightingParams, lightToPatient, lightViewDirection } from './dvr';
import { TransferFunctionPreset, transferFunction } from './transfer-function';
import { mipStepScale } from './pan-zoom';

// bytes: planeToTex mat4x4 (64) + scale.xy + pan.xy + windowCenter,windowWidth,
// slicePos,flipX (32) + invert + 12 bytes pad — overlayCheckerboard, checkerSize,
// colormapBase (16) = 112; then the fusion-overlay block at byte 112 (16-aligned
// for its mat4x4): overlayToTex mat4x4 (64) + overlayWindowCenter,
// overlayWindowWidth,overlayOpacity,overlayColormap (16) = 80. Total 192.
export const PARAMS_SIZE = 192;
/** Float offset of the overlay block (overlayToTex mat4 then window/opacity). */
const OVERLAY_FLOATS = 28;
// bytes: patientToTex mat4x4 (64) + eyeSteps, axisU, axisV, forward, modeSlab,
// tfDomain, clipA, clipC, clipS, light, material, clipFree (12 × vec4 = 192).
export const MIP_PARAMS_SIZE = 256;
/** Float offset of the per-frame params that follow the 4×4 reslice matrix. */
const MATRIX_FLOATS = 16;
/**
 * Fraction of the full MIP sample budget used while the 3D view is actively
 * manipulated (orbit/zoom/window-level). Halving the samples roughly halves the
 * march cost; the settled frame renders at full quality.
 */
const MIP_INTERACTIVE_LOD = 0.5;
/** A no-op half-space: a zero normal the shader ignores (its clip flag is off too). */
const NO_HALF_SPACE: HalfSpace = { normal: [0, 0, 0], offset: 0 };
/** A no-op cut-away: zero-normal planes the shader ignores (clip flag off too). */
const NO_CLIP: readonly [HalfSpace, HalfSpace, HalfSpace] = [
  NO_HALF_SPACE,
  NO_HALF_SPACE,
  NO_HALF_SPACE,
];

/** The base reslice + screen fit + window for one MPR pane (see {@link packSliceParams}). */
export interface SliceParams {
  readonly matrix: Float32Array | readonly number[];
  readonly scaleX: number;
  readonly scaleY: number;
  readonly pan: Vec2;
  readonly windowCenter: number;
  readonly windowWidth: number;
  readonly slicePos: number;
  readonly flipX: boolean;
  readonly invert: boolean;
  /**
   * Map the windowed BASE value through the overlay colormap LUT (binding 4)
   * instead of drawing it grayscale — the standalone Compare overlay column,
   * where the overlay layer is bound as the base and shown in its colormap.
   * Independent of {@link overlay} (which composites a second layer).
   */
  readonly colormapBase: boolean;
  /** The fusion overlay block, or null when no overlay is composited. */
  readonly overlay: {
    readonly matrix: Float32Array | readonly number[];
    readonly windowCenter: number;
    readonly windowWidth: number;
    readonly opacity: number;
    /** Map the windowed overlay value through the colormap LUT (vs. grayscale). */
    readonly colormap: boolean;
    /** Composite as a checkerboard (alternating cells) vs. a uniform blend. */
    readonly checkerboard: boolean;
    /** Checkerboard cell size in framebuffer pixels. */
    readonly checkerSize: number;
  } | null;
}

/**
 * Pack one MPR pane's uniform to the exact byte layout the WGSL `Params` struct
 * expects (see slice-shader.ts): the base reslice matrix + screen fit + window
 * (floats 0..24), then the fusion-overlay block at float 28 (byte 112) — overlay
 * matrix (28..43), overlay window centre/width and opacity (44..46), and the
 * colormap flag (47, u32). The colormap-the-base flag (27, u32) sits in the
 * pre-overlay pad. With no overlay the opacity stays 0, so the shader
 * leaves the base untouched. Pure and exported so the layout can be unit-tested
 * without a GPU — the shader and this packing must stay in lockstep.
 */
export function packSliceParams(p: SliceParams): ArrayBuffer {
  const params = new ArrayBuffer(PARAMS_SIZE);
  const floats = new Float32Array(params);
  const uints = new Uint32Array(params);
  floats.set(p.matrix as ArrayLike<number>, 0); // planeToTex, floats 0..15
  floats[MATRIX_FLOATS + 0] = p.scaleX;
  floats[MATRIX_FLOATS + 1] = p.scaleY;
  floats[MATRIX_FLOATS + 2] = p.pan.x;
  floats[MATRIX_FLOATS + 3] = p.pan.y;
  floats[MATRIX_FLOATS + 4] = p.windowCenter;
  floats[MATRIX_FLOATS + 5] = p.windowWidth;
  floats[MATRIX_FLOATS + 6] = p.slicePos;
  uints[MATRIX_FLOATS + 7] = p.flipX ? 1 : 0;
  uints[MATRIX_FLOATS + 8] = p.invert ? 1 : 0;
  // Colormap-the-base flag (float 27): the standalone Compare overlay column.
  // Set independently of the overlay block, which the compare column leaves null.
  uints[MATRIX_FLOATS + 11] = p.colormapBase ? 1 : 0;
  if (p.overlay) {
    // Checkerboard flag + cell size fill the mat4-alignment pad (floats 25, 26).
    uints[MATRIX_FLOATS + 9] = p.overlay.checkerboard ? 1 : 0; // float 25 (u32)
    floats[MATRIX_FLOATS + 10] = p.overlay.checkerSize; // float 26
    floats.set(p.overlay.matrix as ArrayLike<number>, OVERLAY_FLOATS); // overlayToTex, 28..43
    floats[OVERLAY_FLOATS + 16] = p.overlay.windowCenter; // float 44
    floats[OVERLAY_FLOATS + 17] = p.overlay.windowWidth; // float 45
    floats[OVERLAY_FLOATS + 18] = p.overlay.opacity; // float 46
    uints[OVERLAY_FLOATS + 19] = p.overlay.colormap ? 1 : 0; // float 47 (u32)
  }
  return params;
}

/**
 * Pack the 3D raycast pane's uniform ({@link MIP_PARAMS_SIZE} bytes) to the byte
 * layout `raycast-shader.ts` expects: patient→texture affine, camera basis +
 * march budget, projection mode / slab / transfer-function domain, the three MPR
 * cut-away planes, the DVR light + material, and the free cut-plane. Pure given
 * the geometry — the GPU upload (and keeping the DVR LUT current) stays in
 * {@link SliceRenderer.writeMipParams}.
 */
export function packMipParams(
  patientToTex: Float32Array,
  mipSteps: number,
  view: MipPaneView,
  rect: PaneRect,
  volume: Volume,
): Float32Array {
  const basis: CameraBasis = cameraBasis(volume, view.camera, rect.width, rect.height);
  // Reduce the sample budget while the view is being manipulated, then restore
  // it for the settled frame. The cap and the per-t scale move together so the
  // whole image coarsens uniformly; at full quality (lod 1) the output equals
  // a one-sample-per-voxel march.
  const lod = view.interactive ? MIP_INTERACTIVE_LOD : 1;
  const maxSteps = Math.max(1, Math.ceil(mipSteps * lod));
  const stepScale = mipStepScale(patientToTex, basis.forward, volume.dims) * lod;

  // Thick-slab clip planes (perpendicular to the shared orthographic view) as a
  // t-range along the ray; full thickness yields ±∞, leaving the march unclipped.
  const thickness = view.slabThicknessMm ?? Infinity;
  const [slabLo, slabHi] = slabTRange(volumeBounds(volume), basis.eye, basis.forward, thickness);
  const mode = view.projectionMode ?? ProjectionMode.Max;
  // MIP/DVR keep the shared MPR window (DVR ignores it); MinIP/Average auto-fit
  // to the data range so they stay visible as the air fraction per ray slides.
  const window = projectionWindow(mode, volume, view.windowCenter, view.windowWidth);

  // DVR: pass the transfer function's intensity domain (the LUT upload is the
  // renderer's side-effect, kept in the calling method).
  const tf = view.transferFunction ?? transferFunction(TransferFunctionPreset.CtBone);
  const [tfLo, tfHi] = tf.domain;

  // DVR lighting: rotate the view-frame light into texture space (so the shader
  // can dot it against the texture-space gradient) and pack the material weights.
  const lighting = view.lighting ?? DEFAULT_DVR_LIGHTING;
  const lightPatient = lightToPatient(
    lightViewDirection(lighting),
    normalize(basis.axisU),
    normalize(basis.axisV),
    basis.forward,
  );
  const lightTex = normalize(texDirection(patientToTex, lightPatient));
  const light = dvrLightingParams(lightTex, lighting);

  // Cut-away: the three MPR slice planes as texture-space half-spaces oriented
  // to keep the far side of the shared view ray (rd = patientToTex·forward).
  const clipOn = !!view.clipToPlanes && !!view.sliceIndices;
  const clip =
    clipOn && view.sliceIndices
      ? viewClipHalfSpaces(volume, view.sliceIndices, texDirection(patientToTex, basis.forward))
      : NO_CLIP;

  // Arbitrary handle-driven cut-plane (patient space) as a texture-space
  // half-space; independent of the MPR cut-away above.
  const freeClipOn = !!view.cutPlane;
  const clipFree = view.cutPlane ? clipPlaneTex(volume, view.cutPlane) : NO_HALF_SPACE;

  const floats = new Float32Array(MIP_PARAMS_SIZE / 4);
  floats.set(patientToTex, 0); // patientToTex, floats 0..15
  floats.set(basis.eye, 16);
  floats[19] = maxSteps;
  floats.set(basis.axisU, 20);
  floats[23] = window.center;
  floats.set(basis.axisV, 24);
  floats[27] = window.width;
  floats.set(basis.forward, 28);
  floats[31] = stepScale;
  floats[32] = projectionModeCode(mode);
  floats[33] = slabLo;
  floats[34] = slabHi;
  floats[35] = clipOn ? 1 : 0;
  floats[36] = tfLo;
  floats[37] = tfHi;
  floats[38] = freeClipOn ? 1 : 0; // arbitrary cut-plane enabled
  floats[39] = view.invert ? 1 : 0; // invert grayscale projections (ignored by DVR)
  packHalfSpace(floats, 40, clip[0]); // axial cut-plane
  packHalfSpace(floats, 44, clip[1]); // coronal cut-plane
  packHalfSpace(floats, 48, clip[2]); // sagittal cut-plane
  floats.set(light, 52); // light dir + enabled (52..55), material weights (56..59)
  packHalfSpace(floats, 60, clipFree); // arbitrary handle-driven cut-plane
  return floats;
}

/**
 * Map a patient-space direction into texture space with the linear part of the
 * column-major `patientToTex` affine (w = 0), matching the shader's
 * `(patientToTex * vec4(forward, 0)).xyz`. Used to orient the cut-away planes
 * along the same ray direction the shader marches.
 */
function texDirection(patientToTex: Float32Array, forward: Vec3): Vec3 {
  const m = patientToTex;
  const [fx, fy, fz] = forward;
  return [
    m[0] * fx + m[4] * fy + m[8] * fz,
    m[1] * fx + m[5] * fy + m[9] * fz,
    m[2] * fx + m[6] * fy + m[10] * fz,
  ];
}

/** Pack a half-space into four floats at `offset`: normal.xyz then the constant. */
function packHalfSpace(floats: Float32Array, offset: number, plane: HalfSpace): void {
  floats[offset + 0] = plane.normal[0];
  floats[offset + 1] = plane.normal[1];
  floats[offset + 2] = plane.normal[2];
  floats[offset + 3] = plane.offset;
}
