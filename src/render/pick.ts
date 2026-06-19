import type { Vec3, Volume } from '../dicom/types';
import { add, scale } from '../dicom/vec3';
import { cameraBasis, intersectUnitBox, type OrbitCamera } from './camera';
import type { PaneRect } from './layout';
import {
  clipTRange,
  patientToTexMatrix,
  slabTRange,
  viewClipHalfSpaces,
  volumeBounds,
} from './reslice';
import { isDvr, mipStepScale, ProjectionMode } from './slice-renderer';
import {
  sampleTransferFunction,
  transferFunction,
  TransferFunctionPreset,
} from './transfer-function';
import { compositeOver } from './dvr';

/** Optional 3D-pane state the pick must mirror to track what the pane renders. */
export interface PickOptions {
  /** Clip to the MPR slice planes (the cut-away), as the pane is drawing it. */
  readonly clipToPlanes?: boolean;
  /** Current axial/coronal/sagittal slice indices, needed for the cut-away planes. */
  readonly sliceIndices?: readonly [number, number, number];
  /** Transfer-function preset for a DVR pick. Defaults to {@link TransferFunctionPreset.CtBone}. */
  readonly transferFunction?: TransferFunctionPreset;
}

/** Accumulated DVR opacity at which a pick locks onto the visible surface. */
const DVR_PICK_OPACITY = 0.5;

/**
 * Click-to-locate for the 3D pane: the CPU mirror of the raycast shader.
 *
 * {@link probeVoxel} (`probe.ts`) inverts the MPR slice shader to turn a pane
 * pixel into a voxel; this does the same for the 3D projection. It rebuilds the
 * orthographic camera ray for the clicked pixel (via {@link cameraBasis}), maps
 * it into texture space with the same `patientToTex` affine the shader marches,
 * clips it to the box and the thick slab (the `t`-range from {@link slabTRange}),
 * and walks it sampling the volume — finding, per projection mode, the source of
 * the displayed pixel: the brightest sample for MIP, the darkest for MinIP, the
 * slab centre for Average (whose mean has no single source). The patient point
 * and voxel at that depth let the viewer drive the MPR panes to what was clicked.
 *
 * Sampling is nearest-neighbour and the march steps roughly once per voxel, the
 * same one-sample-per-voxel cadence as the shader at full quality, so the pick
 * lands on the voxel the visible projection came from.
 */

/** The volume location a 3D-pane click resolved to. */
export interface Pick {
  /** Voxel index along x (column), y (row), z (slice), zero-based. */
  readonly voxel: readonly [number, number, number];
  /** The same point in patient space (LPS, mm). */
  readonly patient: Vec3;
}

/**
 * Resolve a click at `(cursorX, cursorY)` over the 3D pane (`rect`, same pixel
 * units as the cursor) to the volume location its projected pixel came from, or
 * `null` when the ray misses the volume or the click is outside the pane.
 *
 * `camera`, `mode` and `slabThicknessMm` must match what the pane is rendering
 * so the pick tracks the visible image; `slabThicknessMm ≥` the volume depth (or
 * `Infinity`) projects the whole volume, exactly as in {@link slabTRange}.
 */
export function pickProjection(
  volume: Volume,
  camera: OrbitCamera,
  mode: ProjectionMode,
  slabThicknessMm: number,
  rect: PaneRect,
  cursorX: number,
  cursorY: number,
  options: PickOptions = {},
): Pick | null {
  if (rect.width < 1 || rect.height < 1) return null;

  // Cursor → centred device coords with +y up, matching the raycast shader.
  const u = (cursorX - rect.x) / rect.width;
  const v = (cursorY - rect.y) / rect.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const ndcX = u * 2 - 1;
  const ndcY = 1 - v * 2;

  const basis = cameraBasis(volume, camera, rect.width, rect.height);
  const originWorld = add(add(basis.eye, scale(basis.axisU, ndcX)), scale(basis.axisV, ndcY));

  // World ray → texture space: a point for the origin, a vector for the direction.
  const m = patientToTexMatrix(volume);
  const ro = applyAffine(m, originWorld, 1);
  const rd = applyAffine(m, basis.forward, 0);

  // Clip to the unit box and the thick slab, the same segment the shader marches.
  const box = intersectUnitBox(ro, rd);
  if (!box.hit) return null;
  const [slabLo, slabHi] = slabTRange(
    volumeBounds(volume),
    basis.eye,
    basis.forward,
    slabThicknessMm,
  );
  let tEntry = Math.max(box.tEntry, slabLo);
  let tExit = Math.min(box.tExit, slabHi);
  // Mirror the cut-away the pane renders so a pick lands on the visible surface,
  // not on material the clip has hidden.
  if (options.clipToPlanes && options.sliceIndices) {
    [tEntry, tExit] = clipTRange(
      viewClipHalfSpaces(volume, options.sliceIndices, rd),
      ro,
      rd,
      tEntry,
      tExit,
    );
  }
  if (!(tExit >= tEntry)) return null;

  const dims = volume.dims;
  const span = tExit - tEntry;
  // Step ≈ once per voxel along this ray, capped by the full diagonal, as the
  // shader does; the per-t voxel rate is the shared orthographic step scale.
  const maxSteps = Math.max(1, Math.ceil(Math.hypot(dims[0], dims[1], dims[2])));
  const steps = Math.min(
    maxSteps,
    Math.max(1, Math.ceil(span * mipStepScale(m, basis.forward, dims))),
  );
  const dt = span / steps;

  // DVR locks onto the first composited surface (where opacity crosses a
  // threshold); the projections pick the sample that sourced the displayed pixel.
  const bestT = isDvr(mode)
    ? dvrSurfaceDepth(volume, options.transferFunction, ro, rd, tEntry, dt, steps)
    : sampleDepth(volume, mode, ro, rd, tEntry, tExit, dt, steps);
  if (bestT === null) return null; // a DVR ray that never accumulated enough opacity
  const coord = clampUnit(add(ro, scale(rd, bestT)));
  return {
    voxel: [
      clampIndex(Math.floor(coord[0] * dims[0]), dims[0]),
      clampIndex(Math.floor(coord[1] * dims[1]), dims[1]),
      clampIndex(Math.floor(coord[2] * dims[2]), dims[2]),
    ],
    patient: add(originWorld, scale(basis.forward, bestT)),
  };
}

/**
 * Ray parameter `t` of the DVR "visible surface": march front-to-back through the
 * transfer function (opacity-corrected to the step length, as the shader does) and
 * return the depth at which the accumulated opacity first crosses
 * {@link DVR_PICK_OPACITY}. Returns `null` when the whole ray stays too transparent
 * — nothing solid was clicked — so the caller leaves the focus untouched.
 */
function dvrSurfaceDepth(
  volume: Volume,
  preset: TransferFunctionPreset | undefined,
  ro: Vec3,
  rd: Vec3,
  tEntry: number,
  dt: number,
  steps: number,
): number | null {
  // sampleTransferFunction clamps to the domain, so a raw sample maps directly;
  // the pick marches at the reference step (~1 voxel) so opacities pass through.
  const tf = transferFunction(preset ?? TransferFunctionPreset.CtBone);
  let composited: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = tEntry + (i + 0.5) * dt;
    const s = sampleNearest(volume, clampUnit(add(ro, scale(rd, t))));
    const opacity = sampleTransferFunction(tf, s)[3];
    if (opacity > 0) {
      composited = compositeOver(composited, [0, 0, 0], opacity);
      if (composited[3] >= DVR_PICK_OPACITY) return t;
    }
  }
  return null;
}

/** Ray parameter `t` of the sample that sources the projected pixel for `mode`. */
function sampleDepth(
  volume: Volume,
  mode: ProjectionMode,
  ro: Vec3,
  rd: Vec3,
  tEntry: number,
  tExit: number,
  dt: number,
  steps: number,
): number {
  // Average reduces every sample together — no single source voxel — so the
  // natural pick is the centre of the marched slab.
  if (mode === ProjectionMode.Mean) return (tEntry + tExit) / 2;

  const wantMin = mode === ProjectionMode.Min;
  let best = wantMin ? Infinity : -Infinity;
  let bestT = tEntry + 0.5 * dt;
  for (let i = 0; i < steps; i++) {
    const t = tEntry + (i + 0.5) * dt;
    const s = sampleNearest(volume, clampUnit(add(ro, scale(rd, t))));
    if (wantMin ? s < best : s > best) {
      best = s;
      bestT = t;
    }
  }
  return bestT;
}

/** Nearest-neighbour sample of the volume at a texture coordinate, as in `probe.ts`. */
function sampleNearest(volume: Volume, coord: Vec3): number {
  const [dx, dy, dz] = volume.dims;
  const x = clampIndex(Math.floor(coord[0] * dx), dx);
  const y = clampIndex(Math.floor(coord[1] * dy), dy);
  const z = clampIndex(Math.floor(coord[2] * dz), dz);
  return volume.data[(z * dy + y) * dx + x];
}

/** Apply a column-major 4×4 affine to a vector with the given homogeneous `w`. */
function applyAffine(m: Float32Array, v: Vec3, w: number): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * w,
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * w,
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * w,
  ];
}

/** Clamp a texture coordinate into the unit cube, matching the shader's guard. */
function clampUnit(coord: Vec3): Vec3 {
  return [clamp01(coord[0]), clamp01(coord[1]), clamp01(coord[2])];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampIndex(index: number, dim: number): number {
  return Math.min(dim - 1, Math.max(0, index));
}
