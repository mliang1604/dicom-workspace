import { clamp01 } from '../dicom/math';
import type { Vec3 } from '../dicom/types';
import { add, length, normalize, scale } from '../dicom/vec3';

/**
 * Pure helpers for the 3D pane's direct volume rendering (DVR), the CPU mirror
 * of the compositing maths in `raycast-shader.ts`.
 *
 * DVR marches a ray front-to-back, mapping each sample through a transfer
 * function (`transfer-function.ts`) and compositing the emitted colour over the
 * accumulated colour with `over`. Two pieces of the maths are subtle enough to
 * want testing away from the GPU: the opacity correction that keeps the image
 * invariant to the march step size, and the central-difference gradient that
 * gives each sample a surface normal for Lambert shading. Both live here and are
 * exercised by `dvr.spec.ts`; the shader implements the identical formulae.
 */

/** Reference march length (in voxels) the transfer-function opacities are tuned for. */
export const DVR_REFERENCE_STEP_VOXELS = 1;

/** Ambient light fraction so unlit (away-facing) surfaces stay visible, not black. */
export const DVR_AMBIENT = 0.3;

/**
 * Correct a transfer-function opacity for the actual march step length so the
 * composited image is independent of how finely the ray is sampled.
 *
 * Opacities are authored for a reference step of {@link DVR_REFERENCE_STEP_VOXELS}
 * voxels; a step covering `stepVoxels` voxels accumulates more (or less) of the
 * material. Treating opacity as absorption over the step, the corrected value is
 * `1 − (1 − refOpacity) ^ (stepVoxels / reference)` — the standard DVR opacity
 * correction. With `stepVoxels === reference` it returns `refOpacity` unchanged,
 * and a fully opaque sample (`refOpacity === 1`) stays opaque at any step.
 */
export function opacityCorrection(
  refOpacity: number,
  stepVoxels: number,
  referenceStepVoxels: number = DVR_REFERENCE_STEP_VOXELS,
): number {
  const a = clamp01(refOpacity);
  if (a <= 0) return 0;
  if (a >= 1) return 1;
  const ref = referenceStepVoxels > 0 ? referenceStepVoxels : 1;
  const ratio = Math.max(0, stepVoxels) / ref;
  return 1 - Math.pow(1 - a, ratio);
}

/**
 * Composite source colour/opacity under the accumulated front-to-back result
 * (the painter's `over` operator), returning the updated `[r, g, b, a]`. Colours
 * are straight (non-premultiplied); each source contributes weighted by the
 * transparency `1 − dst.a` still remaining. Mirrors the shader's accumulation so
 * the running total can be checked on the CPU.
 */
export function compositeOver(
  dst: readonly [number, number, number, number],
  srcColor: Vec3,
  srcOpacity: number,
): [number, number, number, number] {
  const a = clamp01(srcOpacity);
  const w = (1 - dst[3]) * a;
  return [dst[0] + srcColor[0] * w, dst[1] + srcColor[1] * w, dst[2] + srcColor[2] * w, dst[3] + w];
}

/**
 * Surface normal from an intensity gradient: the unit vector pointing "uphill"
 * is `normalize(gradient)`; the outward surface normal used for shading points
 * the opposite way, toward lower intensity. Returns the zero vector in a
 * homogeneous region (gradient below `epsilon`), which the caller treats as
 * unshaded so flat interiors don't turn black.
 */
export function surfaceNormal(gradient: Vec3, epsilon = 1e-6): Vec3 {
  if (length(gradient) < epsilon) return [0, 0, 0];
  return normalize(scale(gradient, -1));
}

/**
 * Lambert shading factor for a surface normal lit by a single directional light,
 * lifted by an ambient term so back-facing surfaces keep some brightness. The
 * normal and light direction need not be normalised; a degenerate (zero) normal
 * — a flat region with no gradient — returns full brightness (`1`) so it renders
 * its transfer-function colour unshaded. The result is in `[ambient, 1]`.
 */
export function lambertShade(normal: Vec3, lightDir: Vec3, ambient: number = DVR_AMBIENT): number {
  const n = length(normal);
  if (n < 1e-6) return 1;
  const l = length(lightDir);
  if (l < 1e-6) return clamp01(ambient);
  const ndotl = Math.max(0, dot(normal, lightDir) / (n * l));
  const amb = clamp01(ambient);
  return amb + (1 - amb) * ndotl;
}

/**
 * Central-difference gradient of a scalar field sampled by `sampleAt`, evaluated
 * at `p` with the per-axis offsets `h` (one voxel in texture space). Each
 * component is `(f(p + hₐ) − f(p − hₐ)) / (2 hₐ)`, the same six taps the shader
 * issues. Exposed mainly so the formula — and its normalisation — can be tested
 * on a known field.
 */
export function centralDifference(sampleAt: (point: Vec3) => number, p: Vec3, h: Vec3): Vec3 {
  const grad: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    if (h[a] === 0) continue;
    const plus: [number, number, number] = [p[0], p[1], p[2]];
    const minus: [number, number, number] = [p[0], p[1], p[2]];
    plus[a] += h[a];
    minus[a] -= h[a];
    grad[a] = (sampleAt(plus) - sampleAt(minus)) / (2 * h[a]);
  }
  return grad;
}

/**
 * User-tunable lighting for DVR. The light is a single directional source posed
 * relative to the camera: `azimuth`/`elevation` (degrees) swing it off the
 * headlight — `0, 0` points straight back at the viewer, the historical default.
 * `ambient`/`diffuse`/`specular` are the Blinn–Phong material weights and
 * `shininess` the specular exponent. With `enabled` false the DVR samples render
 * unshaded at their transfer-function colour.
 */
export interface DvrLighting {
  readonly enabled: boolean;
  /** Degrees the light swings around the view-up axis; 0 keeps it on the headlight. */
  readonly azimuth: number;
  /** Degrees the light tilts toward the view-up axis; 0 keeps it on the headlight. */
  readonly elevation: number;
  /** Ambient floor in `[0, 1]` so away-facing surfaces stay visible. */
  readonly ambient: number;
  /** Diffuse (Lambert) weight, ≥ 0. */
  readonly diffuse: number;
  /** Specular (Blinn–Phong highlight) weight, ≥ 0. */
  readonly specular: number;
  /** Specular exponent, ≥ 1; larger is a tighter highlight. */
  readonly shininess: number;
}

/**
 * Default DVR lighting: a headlight with the legacy ambient/diffuse split
 * ({@link DVR_AMBIENT} + the complementary diffuse) and no specular, so a freshly
 * loaded volume looks exactly as it did before the lighting controls existed.
 */
export const DEFAULT_DVR_LIGHTING: DvrLighting = {
  enabled: true,
  azimuth: 0,
  elevation: 0,
  ambient: DVR_AMBIENT,
  diffuse: 1 - DVR_AMBIENT,
  specular: 0,
  shininess: 24,
};

/**
 * The light direction in the camera's view frame (x = right, y = up, z = toward
 * the camera) from its azimuth/elevation. `0, 0` returns the headlight `(0, 0, 1)`;
 * the result is a unit vector. The renderer rotates this into texture space with
 * {@link lightToPatient} before handing it to the shader.
 */
export function lightViewDirection(lighting: Pick<DvrLighting, 'azimuth' | 'elevation'>): Vec3 {
  const az = (lighting.azimuth * Math.PI) / 180;
  const el = (lighting.elevation * Math.PI) / 180;
  const cosEl = Math.cos(el);
  return [cosEl * Math.sin(az), Math.sin(el), cosEl * Math.cos(az)];
}

/**
 * Express a view-frame light direction in patient space, given the camera's unit
 * right (`u`) and up (`v`) axes and its `forward` (into-the-scene) direction. The
 * view frame's z points toward the camera — opposite `forward` — so a headlight
 * `(0, 0, 1)` comes back as `-forward`. The result is normalised.
 */
export function lightToPatient(viewLight: Vec3, u: Vec3, v: Vec3, forward: Vec3): Vec3 {
  const back = scale(forward, -1);
  return normalize(
    add(add(scale(u, viewLight[0]), scale(v, viewLight[1])), scale(back, viewLight[2])),
  );
}

/**
 * Pack the DVR lighting into the eight floats the raycast shader reads as its
 * `light` and `material` uniforms: `[lx, ly, lz, enabled]` then
 * `[ambient, diffuse, specular, shininess]`. The light direction is taken
 * pre-transformed into texture space (the shader dots it against the texture-space
 * gradient); the material weights are clamped to their valid ranges. Pure, so the
 * exact bytes the shader sees can be unit-tested.
 */
export function dvrLightingParams(lightDirTex: Vec3, lighting: DvrLighting): Float32Array {
  return new Float32Array([
    lightDirTex[0],
    lightDirTex[1],
    lightDirTex[2],
    lighting.enabled ? 1 : 0,
    clamp01(lighting.ambient),
    Math.max(0, lighting.diffuse),
    Math.max(0, lighting.specular),
    Math.max(1, lighting.shininess),
  ]);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
