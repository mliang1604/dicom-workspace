import type { Vec3, Volume } from '../dicom/types';
import { add, cross, dot, length, normalize, scale, sub } from '../dicom/vec3';
import { volumeBounds } from './reslice';

/**
 * Pure camera maths for the 3D MIP pane.
 *
 * The MIP view is an orthographic orbit around the volume's patient-space
 * bounding box. These helpers derive, from an {@link OrbitCamera}, the camera
 * basis and image-plane axes the raycast shader needs; the shader then converts
 * world-space rays into texture space (via `patientToTexMatrix` in `reslice.ts`)
 * and marches them, accumulating the maximum sample. A TS copy of the ray/box
 * intersection lives here too so the geometry can be unit-tested without a GPU,
 * the same way `probe.ts` mirrors the slice shader.
 *
 * Conventions match the MPR panes: patient space is DICOM LPS (+x left, +y
 * posterior, +z superior) and the default view looks from anterior with patient
 * superior pointing up.
 */

/** Patient superior axis (LPS +z); kept as the world "up" reference. */
const SUPERIOR: Vec3 = [0, 0, 1];

/** Orbit-camera state for the 3D pane: view angles plus a magnification. */
export interface OrbitCamera {
  /** Rotation about the superior axis, in radians (0 = anterior view). */
  readonly azimuth: number;
  /** Tilt above/below the axial plane, in radians (0 = level). */
  readonly elevation: number;
  /** Magnification; 1 fits the volume's bounding sphere, >1 zooms in. */
  readonly zoom: number;
  /**
   * In-plane pan along the camera's screen-right axis, in patient mm; shifts the
   * eye (and so the whole orthographic image plane) sideways. 0 keeps the volume
   * centred. Lets the 3D pane anchor a wheel-zoom on the cursor, like the MPR pan.
   */
  readonly panX: number;
  /** In-plane pan along the camera's screen-up axis, in patient mm (see {@link panX}). */
  readonly panY: number;
}

/** The camera placed in patient space, with orthographic image-plane axes. */
export interface CameraBasis {
  /** Eye position in patient space (mm); rays start on the plane through it. */
  readonly eye: Vec3;
  /** Unit ray direction (eye → volume), shared by every fragment (orthographic). */
  readonly forward: Vec3;
  /** Image-plane horizontal axis, scaled to half the orthographic width. */
  readonly axisU: Vec3;
  /** Image-plane vertical axis, scaled to half the orthographic height. */
  readonly axisV: Vec3;
}

/**
 * Unit vector from the volume centre toward the eye, for the given orbit angles.
 * At azimuth 0, elevation 0 this is anterior (LPS −y), so the default view looks
 * the patient in the face with superior up.
 */
export function eyeDirection(azimuth: number, elevation: number): Vec3 {
  const ce = Math.cos(elevation);
  return [Math.sin(azimuth) * ce, -Math.cos(azimuth) * ce, Math.sin(elevation)];
}

/** The camera's orthonormal screen basis in patient space. */
export interface ViewBasis {
  /** Image-plane right: a patient direction mapping to screen +x. */
  readonly right: Vec3;
  /** Image-plane up: a patient direction mapping to screen +y (upward). */
  readonly up: Vec3;
  /** View direction into the screen (eye → volume), shared by every fragment. */
  readonly forward: Vec3;
}

/**
 * Orthonormal screen basis (right / up / forward) for the given orbit angles,
 * with patient superior as the up reference. Falls back to a fixed right when
 * looking straight up/down (forward ∥ superior). This is the pure orientation
 * half of {@link cameraBasis} — no volume needed — so it can drive both the MIP
 * raycast and the on-screen axis indicator from one definition.
 */
export function viewBasis(azimuth: number, elevation: number): ViewBasis {
  const forward = scale(eyeDirection(azimuth, elevation), -1);
  let right = cross(forward, SUPERIOR);
  right = length(right) > 1e-6 ? normalize(right) : [1, 0, 0];
  const up = normalize(cross(right, forward));
  return { right, up, forward };
}

/**
 * Camera basis and orthographic image-plane axes for a pane of the given pixel
 * size. The orthographic extent fits the volume's bounding sphere at zoom 1 (so
 * the volume never clips as it orbits) and the longer pane axis is widened to
 * preserve a square pixel aspect.
 */
export function cameraBasis(
  volume: Volume,
  camera: OrbitCamera,
  viewWidth: number,
  viewHeight: number,
): CameraBasis {
  const { center, radius } = volumeBounds(volume);
  const { right, up, forward } = viewBasis(camera.azimuth, camera.elevation);
  const eyeDir = scale(forward, -1);

  const zoom = camera.zoom > 0 ? camera.zoom : 1;
  const aspect = viewHeight > 0 ? viewWidth / viewHeight : 1;
  // Fit the bounding sphere into the shorter pane axis, widen the longer one.
  const halfH = aspect >= 1 ? radius / zoom : radius / zoom / aspect;
  const halfW = aspect >= 1 ? (radius / zoom) * aspect : radius / zoom;

  // Place the eye outside the box; orthographic depth is irrelevant, the
  // ray/box intersection finds the real entry/exit. The in-plane pan slides the
  // eye along right/up so the whole image plane shifts, panning the projection.
  const center3 = add(center, scale(eyeDir, radius * 2));
  const eye = add(add(center3, scale(right, camera.panX)), scale(up, camera.panY));
  return { eye, forward, axisU: scale(right, halfW), axisV: scale(up, halfH) };
}

/**
 * Cursor-anchored pan for a wheel-zoom over the 3D pane — the camera-space twin of
 * `rezoomPan` for the MPR panes. Given the cursor in centred device coords (ndc,
 * +y up, as the raycaster and {@link pickProjection} use) and the magnification
 * about to change to `toZoom`, return the new {@link OrbitCamera.panX}/`panY` that
 * keeps the world point currently under the cursor projecting to the same pixel.
 *
 * The orthographic half-extents are the lengths of `axisU`/`axisV`; holding the
 * cursor's `ndc = (P − eye)·axis / |axis|²` fixed across the zoom means shifting
 * the eye by `ndc·(halfExtentBefore − halfExtentAfter)` along each screen axis.
 */
export function rezoomCameraPan(
  volume: Volume,
  camera: OrbitCamera,
  viewWidth: number,
  viewHeight: number,
  toZoom: number,
  ndcX: number,
  ndcY: number,
): { panX: number; panY: number } {
  const before = cameraBasis(volume, camera, viewWidth, viewHeight);
  const after = cameraBasis(volume, { ...camera, zoom: toZoom }, viewWidth, viewHeight);
  return {
    panX: camera.panX + ndcX * (length(before.axisU) - length(after.axisU)),
    panY: camera.panY + ndcY * (length(before.axisV) - length(after.axisV)),
  };
}

/** A patient point projected onto the 3D pane: pane-fraction uv plus view depth. */
export interface PaneProjection {
  /** Horizontal pane fraction in [0,1] (matches the shader's uv.x, 0 at the left). */
  readonly u: number;
  /** Vertical pane fraction in [0,1] (matches the shader's uv.y, 0 at the top). */
  readonly v: number;
  /** Signed depth along `forward` (mm): larger is deeper into the screen. */
  readonly depth: number;
}

/**
 * Project a patient-space point onto the 3D pane, the inverse of the per-fragment
 * `originWorld = eye + ndc.x·axisU + ndc.y·axisV` the raycaster builds. Because
 * the camera is orthographic and `axisU`/`axisV` are perpendicular to `forward`,
 * the in-plane offset resolves directly onto those axes; `depth` is the component
 * along `forward`, used to order overlapping overlays front-to-back. Lets the
 * viewer draw the MPR cut-planes and the picked point as pane-space overlays
 * without a GPU pass, exactly where the corresponding ray would have struck.
 */
export function projectToPane(basis: CameraBasis, point: Vec3): PaneProjection {
  const rel = sub(point, basis.eye);
  const uu = dot(basis.axisU, basis.axisU);
  const vv = dot(basis.axisV, basis.axisV);
  const ndcX = uu > 0 ? dot(rel, basis.axisU) / uu : 0;
  const ndcY = vv > 0 ? dot(rel, basis.axisV) / vv : 0;
  return { u: (ndcX + 1) / 2, v: (1 - ndcY) / 2, depth: dot(rel, basis.forward) };
}

/** Entry/exit parameters of a ray against the unit box; `hit` is false if it misses. */
export interface BoxHit {
  readonly tEntry: number;
  readonly tExit: number;
  readonly hit: boolean;
}

/**
 * Intersect ray `origin + t·dir` with the axis-aligned unit box `[0,1]^3` (the
 * volume in texture space), clamped to `t ≥ 0`. Mirrors the slab test in
 * `raycast-shader.ts`; exported for unit testing the geometry on the CPU.
 */
export function intersectUnitBox(origin: Vec3, dir: Vec3): BoxHit {
  let tEntry = 0;
  let tExit = Infinity;
  for (let a = 0; a < 3; a++) {
    const o = origin[a];
    const d = dir[a];
    if (Math.abs(d) < 1e-12) {
      // Parallel to this slab: a miss unless the origin is already inside it.
      if (o < 0 || o > 1) return { tEntry: 0, tExit: 0, hit: false };
      continue;
    }
    let t0 = (0 - o) / d;
    let t1 = (1 - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tEntry) tEntry = t0;
    if (t1 < tExit) tExit = t1;
  }
  return { tEntry, tExit, hit: tExit >= tEntry };
}
