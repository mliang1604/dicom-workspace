import type { Vec3, Volume } from '../dicom/types';
import { cross, length, normalize, scale } from '../dicom/vec3';
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
  const eyeDir = eyeDirection(camera.azimuth, camera.elevation);
  const forward = scale(eyeDir, -1);

  // Right/up of the image plane, with superior as the up reference. Falls back
  // to a fixed right when looking straight up/down (forward ∥ superior).
  let right = cross(forward, SUPERIOR);
  right = length(right) > 1e-6 ? normalize(right) : [1, 0, 0];
  const up = normalize(cross(right, forward));

  const zoom = camera.zoom > 0 ? camera.zoom : 1;
  const aspect = viewHeight > 0 ? viewWidth / viewHeight : 1;
  // Fit the bounding sphere into the shorter pane axis, widen the longer one.
  const halfH = aspect >= 1 ? radius / zoom : radius / zoom / aspect;
  const halfW = aspect >= 1 ? (radius / zoom) * aspect : radius / zoom;

  // Place the eye outside the box; orthographic depth is irrelevant, the
  // ray/box intersection finds the real entry/exit.
  const eye: Vec3 = [
    center[0] + eyeDir[0] * radius * 2,
    center[1] + eyeDir[1] * radius * 2,
    center[2] + eyeDir[2] * radius * 2,
  ];
  return { eye, forward, axisU: scale(right, halfW), axisV: scale(up, halfH) };
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
