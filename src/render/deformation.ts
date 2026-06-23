import { floatsToHalf } from '../dicom/half';
import { invert, multiply, toColumnMajor, transformPoint } from '../dicom/mat4';
import type {
  DeformableRegistration,
  DeformationGrid,
  Mat4,
  Vec3,
  Volume,
  VolumeGeometry,
} from '../dicom/types';
import { cross } from '../dicom/vec3';
import { resolveGeometry } from './reslice';

/**
 * GPU/CPU preparation for a deformable Spatial Registration's displacement field.
 *
 * The field warps an overlay (the registration's moving / source frame) onto the
 * base (its fixed / target frame). The renderer samples it per fragment: a base
 * pane point in fixed-patient mm is looked up in the field to get a displacement,
 * added, then mapped into the overlay's grid. The pipeline (documented so the
 * shader and these matrices stay in lockstep):
 *
 *   p1       = preMatrix · paneToPatient · (u, v, slicePos)     // fixed patient, pre-aligned
 *   disp     = field( patientToField · p1 )                     // mm, 0 outside the grid
 *   p_moving = postMatrix · (p1 + disp)                          // moving patient
 *   texcoord = overlayPatientToTex · p_moving                    // overlay grid sample
 *
 * `paneToPatientPre` folds the pre-matrix into the base pane→patient map;
 * `patientToField` maps fixed-patient mm to the field's `[0,1]³` texture space;
 * `patientToOverlayTex` folds the post-matrix into the overlay's patient→texture
 * map. All three are returned column-major for the WGSL uniform.
 *
 * Direction note: this assumes the field maps fixed→moving (the lookup the
 * renderer needs). DICOM does not fix the displacement sign across producers, so
 * the warp direction is the one thing to confirm visually against real data.
 */
export interface DeformationUniforms {
  /** `preMatrix · paneToPatient`, column-major (orientation-specific). */
  readonly paneToPatientPre: Float32Array;
  /** Fixed-patient mm → field texture `[0,1]³`, column-major. */
  readonly patientToField: Float32Array;
  /** Moving-patient mm → overlay texture, folding the post-matrix, column-major. */
  readonly patientToOverlayTex: Float32Array;
}

/**
 * Pack a displacement grid's `[dx, dy, dz]` vectors (mm) into the half-float RGBA
 * data for an `rgba16float` 3D texture — the GPU's filterable format, so hardware
 * trilinear interpolation does the field lookup. The 4th (alpha) component pads
 * each texel and is unused. Node order matches the grid's `[z][y][x]` layout,
 * which is also the 3D texture's (x fastest).
 */
export function deformationFieldHalf(grid: DeformationGrid): Uint16Array {
  const [nx, ny, nz] = grid.dims;
  const nodes = nx * ny * nz;
  const rgba = new Float32Array(nodes * 4);
  for (let n = 0; n < nodes; n++) {
    rgba[n * 4] = grid.vectors[n * 3];
    rgba[n * 4 + 1] = grid.vectors[n * 3 + 1];
    rgba[n * 4 + 2] = grid.vectors[n * 3 + 2];
    // rgba[n * 4 + 3] stays 0 (unused padding).
  }
  return floatsToHalf(rgba);
}

/** The grid's index→patient affine, from its origin, orientation cosines and spacing. */
export function gridGeometry(grid: DeformationGrid): VolumeGeometry {
  const o = grid.orientation;
  const rowDir: Vec3 = [o[0], o[1], o[2]];
  const colDir: Vec3 = [o[3], o[4], o[5]];
  const normal = cross(rowDir, colDir);
  const [sx, sy, sz] = grid.spacing;
  return {
    iStep: [rowDir[0] * sx, rowDir[1] * sx, rowDir[2] * sx],
    jStep: [colDir[0] * sy, colDir[1] * sy, colDir[2] * sy],
    kStep: [normal[0] * sz, normal[1] * sz, normal[2] * sz],
    origin: grid.origin,
  };
}

/**
 * Row-major patient→texture affine for a grid: `tex = (M⁻¹·(p − origin's frame) )`
 * normalised to `[0,1]` voxel-centre coordinates. Built from the index→patient
 * geometry (columns iStep/jStep/kStep, translation origin), inverted, then scaled
 * by `1/dim` with a half-voxel offset. Returns null when the geometry is singular.
 */
export function patientToTexRowMajor(
  geom: VolumeGeometry,
  dims: readonly [number, number, number],
): Mat4 | null {
  const { iStep, jStep, kStep, origin } = geom;
  // prettier-ignore
  const indexToPatient: Mat4 = [
    iStep[0], jStep[0], kStep[0], origin[0],
    iStep[1], jStep[1], kStep[1], origin[1],
    iStep[2], jStep[2], kStep[2], origin[2],
    0, 0, 0, 1,
  ];
  const patientToIndex = invert(indexToPatient);
  if (!patientToIndex) return null;
  // index → texture: tex_a = (index_a + 0.5) / dim_a.
  // prettier-ignore
  const indexToTex: Mat4 = [
    1 / dims[0], 0, 0, 0.5 / dims[0],
    0, 1 / dims[1], 0, 0.5 / dims[1],
    0, 0, 1 / dims[2], 0.5 / dims[2],
    0, 0, 0, 1,
  ];
  return multiply(indexToTex, patientToIndex);
}

/**
 * Build the per-pane deformation uniforms for the shader, or null when a geometry
 * is singular (the caller then skips the deformable overlay). `paneToPatient` is
 * the base pane→patient row-major affine (see `reslice.paneToPatientMatrix`),
 * supplied per orientation/rotation.
 */
export function deformationUniforms(
  paneToPatient: Mat4,
  overlayVolume: Volume,
  preMatrix: Mat4,
  postMatrix: Mat4,
  grid: DeformationGrid,
): DeformationUniforms | null {
  const patientToField = patientToTexRowMajor(gridGeometry(grid), grid.dims);
  const overlayPatientToTex = patientToTexRowMajor(
    resolveGeometry(overlayVolume),
    overlayVolume.dims,
  );
  if (!patientToField || !overlayPatientToTex) return null;
  return {
    paneToPatientPre: toColumnMajor(multiply(preMatrix, paneToPatient)),
    patientToField: toColumnMajor(patientToField),
    patientToOverlayTex: toColumnMajor(multiply(overlayPatientToTex, postMatrix)),
  };
}

/**
 * Sample the displacement (mm) at a fixed-patient point by trilinear interpolation
 * of the grid — the CPU mirror of the shader's hardware-filtered lookup. Returns
 * `[0, 0, 0]` outside the grid (the renderer's out-of-grid fallback). Pure, so the
 * field's geometry and interpolation can be unit-tested without a GPU, and reused
 * by a future voxel probe.
 */
export function sampleDisplacement(grid: DeformationGrid, point: Vec3): Vec3 {
  const toIndex = invert(buildIndexToPatient(grid));
  if (!toIndex) return [0, 0, 0];
  const idx = transformPoint(toIndex, point);
  const [nx, ny, nz] = grid.dims;
  if (
    idx[0] < 0 ||
    idx[0] > nx - 1 ||
    idx[1] < 0 ||
    idx[1] > ny - 1 ||
    idx[2] < 0 ||
    idx[2] > nz - 1
  ) {
    return [0, 0, 0];
  }

  const x0 = Math.floor(idx[0]);
  const y0 = Math.floor(idx[1]);
  const z0 = Math.floor(idx[2]);
  const x1 = Math.min(x0 + 1, nx - 1);
  const y1 = Math.min(y0 + 1, ny - 1);
  const z1 = Math.min(z0 + 1, nz - 1);
  const fx = idx[0] - x0;
  const fy = idx[1] - y0;
  const fz = idx[2] - z0;

  const at = (x: number, y: number, z: number, c: number): number =>
    grid.vectors[((z * ny + y) * nx + x) * 3 + c];

  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = lerp(at(x0, y0, z0, c), at(x1, y0, z0, c), fx);
    const c10 = lerp(at(x0, y1, z0, c), at(x1, y1, z0, c), fx);
    const c01 = lerp(at(x0, y0, z1, c), at(x1, y0, z1, c), fx);
    const c11 = lerp(at(x0, y1, z1, c), at(x1, y1, z1, c), fx);
    out[c] = lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz);
  }
  return out;
}

/** Row-major index→patient affine of a grid (columns iStep/jStep/kStep, origin). */
function buildIndexToPatient(grid: DeformationGrid): Mat4 {
  const { iStep, jStep, kStep, origin } = gridGeometry(grid);
  // prettier-ignore
  return [
    iStep[0], jStep[0], kStep[0], origin[0],
    iStep[1], jStep[1], kStep[1], origin[1],
    iStep[2], jStep[2], kStep[2], origin[2],
    0, 0, 0, 1,
  ];
}

/**
 * A diagnostic snapshot of how a deformable overlay maps at the base volume's
 * centre — for tracing a deformable fusion that shows nothing because the overlay
 * sampling lands out of bounds. Runs the same pipeline as the shader on the CPU:
 * base(fixed)-patient → preMatrix → field displacement → postMatrix → overlay tex.
 *
 * The tells: `fieldCoversCentre` false means the base centre falls outside the
 * grid, so the displacement is 0 and the overlay is then read at fixed-frame
 * coordinates through the moving grid — which `overlaySampledInBounds` false
 * confirms is off the moving volume, i.e. invisible. Pure; values are rounded for
 * readability. Returns null when the base lacks geometry.
 */
export function describeDeformationCoverage(
  base: Volume,
  overlay: Volume,
  reg: DeformableRegistration,
): Record<string, unknown> {
  const g = resolveGeometry(base);
  const [nx, ny, nz] = base.dims;
  const centre: Vec3 = [
    g.origin[0] +
      ((nx - 1) / 2) * g.iStep[0] +
      ((ny - 1) / 2) * g.jStep[0] +
      ((nz - 1) / 2) * g.kStep[0],
    g.origin[1] +
      ((nx - 1) / 2) * g.iStep[1] +
      ((ny - 1) / 2) * g.jStep[1] +
      ((nz - 1) / 2) * g.kStep[1],
    g.origin[2] +
      ((nx - 1) / 2) * g.iStep[2] +
      ((ny - 1) / 2) * g.jStep[2] +
      ((nz - 1) / 2) * g.kStep[2],
  ];
  const p1 = transformPoint(reg.preMatrix, centre);
  const toField = patientToTexRowMajor(gridGeometry(reg.grid), reg.grid.dims);
  const fuv = toField ? transformPoint(toField, p1) : null;
  const disp = sampleDisplacement(reg.grid, p1);
  const pMoving = transformPoint(reg.postMatrix, [
    p1[0] + disp[0],
    p1[1] + disp[1],
    p1[2] + disp[2],
  ]);
  const overlayGeom = resolveGeometry(overlay);
  const toOverlay = patientToTexRowMajor(overlayGeom, overlay.dims);
  const ocoord = toOverlay ? transformPoint(toOverlay, pMoving) : null;

  let maxVectorMm = 0;
  for (let i = 0; i < reg.grid.vectors.length; i++) {
    const a = Math.abs(reg.grid.vectors[i]);
    if (a > maxVectorMm) maxVectorMm = a;
  }

  const round = (v: Vec3 | null): number[] | null =>
    v ? v.map((c) => Math.round(c * 100) / 100) : null;
  const inUnit = (v: Vec3 | null): boolean => v !== null && v.every((c) => c >= 0 && c <= 1);
  const roundArr = (a: readonly number[]): number[] => a.map((c) => Math.round(c * 10000) / 10000);
  const geomSummary = (geo: VolumeGeometry, dims: readonly [number, number, number]) => ({
    origin: roundArr(geo.origin),
    iStep: roundArr(geo.iStep),
    jStep: roundArr(geo.jStep),
    kStep: roundArr(geo.kStep),
    dims,
  });

  return {
    gridDims: reg.grid.dims,
    gridSpacingMm: reg.grid.spacing,
    gridOrigin: round(reg.grid.origin),
    maxVectorMm: Math.round(maxVectorMm * 100) / 100,
    preMatrix: roundArr(reg.preMatrix),
    postMatrix: roundArr(reg.postMatrix),
    baseGeometry: geomSummary(g, base.dims),
    overlayGeometry: geomSummary(overlayGeom, overlay.dims),
    baseCentrePatient: round(centre),
    fieldTexCoord: round(fuv),
    fieldCoversCentre: inUnit(fuv),
    dispAtCentreMm: round(disp),
    overlayTexCoord: round(ocoord),
    overlaySampledInBounds: inUnit(ocoord),
  };
}
