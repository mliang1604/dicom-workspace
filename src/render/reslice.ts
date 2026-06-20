import { Orientation, type Vec3, type Volume, type VolumeGeometry } from '../dicom/types';
import { add, cross, dot, length, normalize, scale, sub } from '../dicom/vec3';

/**
 * Oblique multi-planar reslicing geometry.
 *
 * The volume texture stays in raw acquisition (index) space; these pure
 * functions derive, from a volume's {@link VolumeGeometry}, how to sample true
 * anatomical planes out of it. The key output is {@link planeToTex}: an affine
 * map from a pane's in-plane coordinates to 3D texture coordinates, shared by
 * the shader (forward) and the cursor probe (inverse) so the two never drift.
 *
 * Patient space is DICOM LPS: +x patient-left, +y posterior, +z superior.
 * Display conventions (chosen to match the historical axis-aligned views):
 *   - Axial    — x→right, y(anterior)→top,   slice walks +z (inferior→superior)
 *   - Coronal  — x→right, z(superior)→top,   slice walks +y (anterior→posterior)
 *   - Sagittal — y(anterior)→left, z(sup)→top, slice walks +x (right→left)
 */

/** Affine map from a pane's (u, v, slicePos) to 3D texture coordinates. */
export interface PlaneToTex {
  /** Texture-coord change per unit of the pane's horizontal axis (u, 0→1). */
  readonly dU: Vec3;
  /** Texture-coord change per unit of the pane's vertical axis (v, 0→1 top→bottom). */
  readonly dV: Vec3;
  /** Texture-coord change per unit of the through-plane position (slicePos, 0→1). */
  readonly dS: Vec3;
  /** Texture coordinate at u=v=slicePos=0. */
  readonly origin: Vec3;
}

/** Axis-aligned bounding box of the volume in patient (LPS) space, in mm. */
interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** A plane's placement in patient space: where u/v/slice run, in mm. */
interface PlaneBasis {
  readonly origin: Vec3;
  readonly axisU: Vec3;
  readonly axisV: Vec3;
  readonly axisS: Vec3;
}

/**
 * An oblique tilt of a pane's plane away from its orthogonal anatomical default,
 * as two rotations applied about the plane's *own* in-plane axes (so the tilt is
 * intrinsic to the pane and survives pan/zoom/scroll):
 *   - `tiltU` (radians) rotates about the in-plane horizontal axis (u) — a
 *     pitch that swings the plane's top/bottom out of plane (single oblique);
 *   - `tiltV` (radians) rotates about the in-plane vertical axis (v) — a yaw
 *     that swings its left/right out of plane (the second, double-oblique, axis).
 * `{ tiltU: 0, tiltV: 0 }` (see {@link NO_OBLIQUE}) is the orthogonal default and
 * reproduces the axis-aligned views exactly.
 */
export interface ObliqueRotation {
  readonly tiltU: number;
  readonly tiltV: number;
}

/** The orthogonal (untilted) default: both oblique angles zero. */
export const NO_OBLIQUE: ObliqueRotation = { tiltU: 0, tiltV: 0 };

/** Whether a rotation actually tilts the plane (a non-zero angle on either axis). */
export function isOblique(rotation: ObliqueRotation | undefined): rotation is ObliqueRotation {
  return !!rotation && (rotation.tiltU !== 0 || rotation.tiltV !== 0);
}

/**
 * The volume's geometry, or an axis-aligned identity derived from its spacing
 * when none is recorded. The identity reproduces the legacy behaviour of
 * treating the acquisition axes as the patient axes.
 */
export function resolveGeometry(volume: Volume): VolumeGeometry {
  if (volume.geometry) return volume.geometry;
  const [sx, sy, sz] = volume.spacing;
  return { iStep: [sx, 0, 0], jStep: [0, sy, 0], kStep: [0, 0, sz], origin: [0, 0, 0] };
}

/**
 * Affine plane→texture map for one orientation, shared by shader and probe.
 *
 * Pass an {@link ObliqueRotation} to tilt the plane off its anatomical default;
 * omitting it (or passing {@link NO_OBLIQUE}) reproduces the orthogonal view. The
 * tilt rotates the plane's in-plane and through-plane axes about the volume
 * centre, so the same physical field of view and slice spacing are preserved —
 * only the plane's orientation changes.
 */
export function planeToTex(
  volume: Volume,
  orientation: Orientation,
  rotation?: ObliqueRotation,
): PlaneToTex {
  const geom = resolveGeometry(volume);
  const dims = volume.dims;
  const basis = obliqueBasis(planeBasis(orientation, patientBounds(geom, dims)), rotation);

  const dU = perTexel(invMul(geom, basis.axisU), dims);
  const dV = perTexel(invMul(geom, basis.axisV), dims);
  const dS = perTexel(invMul(geom, basis.axisS), dims);
  // origin maps voxel-centre sampling: texcoord = (index + 0.5) / dim.
  const indexOrigin = invMul(geom, sub(basis.origin, geom.origin));
  const origin = perTexel(add(indexOrigin, [0.5, 0.5, 0.5]), dims);
  return { dU, dV, dS, origin };
}

/** Texture coordinate for a pane point: `origin + u·dU + v·dV + slicePos·dS`. */
export function texCoordAt(map: PlaneToTex, u: number, v: number, slicePos: number): Vec3 {
  return add(add(add(scale(map.dU, u), scale(map.dV, v)), scale(map.dS, slicePos)), map.origin);
}

/** A pane point recovered from a texture coordinate by inverting {@link texCoordAt}. */
export interface PlaneCoords {
  /** In-plane horizontal position (u, matching the shader's post-flip axis). */
  readonly u: number;
  /** In-plane vertical position (v, 0→1 top→bottom). */
  readonly v: number;
  /** Through-plane position (slicePos, 0→1). */
  readonly slicePos: number;
}

/**
 * Inverse of {@link texCoordAt}: solve `origin + u·dU + v·dV + slicePos·dS = coord`
 * for the pane coordinates `(u, v, slicePos)`. Used to project a known voxel back
 * onto each orientation's plane — the forward direction of the cursor probe — so
 * the linked crosshair lands on the same pixel the probe would sample.
 */
export function planeCoordsAt(map: PlaneToTex, coord: Vec3): PlaneCoords {
  // Invert the 3×3 [dU | dV | dS] via Cramer's rule, as in invMul above.
  const rhs = sub(coord, map.origin);
  const r0 = cross(map.dV, map.dS);
  const r1 = cross(map.dS, map.dU);
  const r2 = cross(map.dU, map.dV);
  const det = dot(map.dU, r0);
  const inv = det !== 0 ? 1 / det : 0;
  return { u: dot(r0, rhs) * inv, v: dot(r1, rhs) * inv, slicePos: dot(r2, rhs) * inv };
}

/** Column-major 4×4 of {@link planeToTex} for upload to the shader uniform. */
export function planeToTexMatrix(
  volume: Volume,
  orientation: Orientation,
  rotation?: ObliqueRotation,
): Float32Array {
  const { dU, dV, dS, origin } = planeToTex(volume, orientation, rotation);
  // texcoord = (M · vec4(u, v, slicePos, 1)).xyz, with M's columns being the
  // three deltas and the origin. WGSL reads mat4x4 column-major.
  // prettier-ignore
  return new Float32Array([
    dU[0], dU[1], dU[2], 0,
    dV[0], dV[1], dV[2], 0,
    dS[0], dS[1], dS[2], 0,
    origin[0], origin[1], origin[2], 1,
  ]);
}

/** A pane's displayed plane: its orientation, slice, and optional oblique tilt. */
export interface ObliquePlane {
  readonly orientation: Orientation;
  readonly sliceIndex: number;
  /** Oblique tilt; omitted/{@link NO_OBLIQUE} is the orthogonal plane. */
  readonly rotation?: ObliqueRotation;
}

/**
 * A line in a pane's normalised in-plane coordinates, as the implicit equation
 * `a·u + b·v + c = 0` (u along the plane's pre-flip horizontal axis, v top→bottom,
 * both in [0, 1]). This is the reference line {@link referenceLine} produces and
 * {@link clipLineToUnitSquare} trims to the displayed square.
 */
export interface PlaneLine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/** A pane's current plane frame in patient space (LPS, mm). */
interface PlaneFrame {
  /** Patient point at u=v=0 on the displayed slice. */
  readonly base: Vec3;
  /** Unit in-plane horizontal axis; `lengthU` mm spans u∈[0,1]. */
  readonly uHat: Vec3;
  readonly lengthU: number;
  /** Unit in-plane vertical axis; `lengthV` mm spans v∈[0,1]. */
  readonly vHat: Vec3;
  readonly lengthV: number;
  /** Unit plane normal (the through-plane direction). */
  readonly normal: Vec3;
}

/** The patient-space frame of a pane's currently displayed (possibly oblique) slice. */
function planeFrame(volume: Volume, plane: ObliquePlane): PlaneFrame {
  const geom = resolveGeometry(volume);
  const basis = obliqueBasis(
    planeBasis(plane.orientation, patientBounds(geom, volume.dims)),
    plane.rotation,
  );
  const count = sliceCountFor(volume, plane.orientation);
  const slicePos = count > 1 ? (plane.sliceIndex + 0.5) / count : 0.5;
  return {
    base: add(basis.origin, scale(basis.axisS, slicePos)),
    uHat: normalize(basis.axisU),
    lengthU: length(basis.axisU),
    vHat: normalize(basis.axisV),
    lengthV: length(basis.axisV),
    normal: normalize(basis.axisS),
  };
}

/**
 * Where plane `other` cuts across pane `into`, as a {@link PlaneLine} in `into`'s
 * normalised in-plane coordinates — the reference line a viewer draws on `into`
 * to show (and let the user adjust) the oblique angle of `other`. Both planes may
 * themselves be oblique. Returns `null` when the planes are parallel (no visible
 * crossing) — including the degenerate case of a plane against itself.
 *
 * Derivation: a point on `into`'s slice is `base + u'·uHat + v'·vHat` (u', v' in
 * mm); it also lies on `other`'s plane when `dot(normalₒ, point − baseₒ) = 0`.
 * That constraint is linear in (u', v'); rescaling u'=u·lengthU, v'=v·lengthV to
 * the [0,1] pane axes gives the implicit line returned here.
 */
export function referenceLine(
  volume: Volume,
  into: ObliquePlane,
  other: ObliquePlane,
): PlaneLine | null {
  const fa = planeFrame(volume, into);
  const fb = planeFrame(volume, other);
  const a = dot(fb.normal, fa.uHat) * fa.lengthU;
  const b = dot(fb.normal, fa.vHat) * fa.lengthV;
  const c = dot(fb.normal, sub(fa.base, fb.base));
  if (Math.abs(a) < 1e-9 && Math.abs(b) < 1e-9) return null; // parallel planes
  return { a, b, c };
}

/**
 * The two endpoints where a {@link PlaneLine} crosses the unit square [0,1]², in
 * pane (u, v) coordinates, or `null` when the line misses the square. Used to
 * draw a reference line as a segment spanning the pane.
 */
export function clipLineToUnitSquare(
  line: PlaneLine,
): readonly [PlaneCoords2D, PlaneCoords2D] | null {
  const { a, b, c } = line;
  const hits: PlaneCoords2D[] = [];
  const push = (u: number, v: number): void => {
    if (u < -1e-9 || u > 1 + 1e-9 || v < -1e-9 || v > 1 + 1e-9) return;
    const cu = Math.min(1, Math.max(0, u));
    const cv = Math.min(1, Math.max(0, v));
    if (!hits.some((p) => Math.abs(p.u - cu) < 1e-6 && Math.abs(p.v - cv) < 1e-6)) {
      hits.push({ u: cu, v: cv });
    }
  };
  // Crossings with the v=0 and v=1 edges (solve for u), then the u=0/u=1 edges.
  if (Math.abs(a) > 1e-12) {
    push(-c / a, 0);
    push(-(b + c) / a, 1);
  }
  if (Math.abs(b) > 1e-12) {
    push(0, -c / b);
    push(1, -(a + c) / b);
  }
  if (hits.length < 2) return null;
  return [hits[0], hits[1]];
}

/** An in-plane point in normalised pane coordinates, both components in [0,1]. */
export interface PlaneCoords2D {
  readonly u: number;
  readonly v: number;
}

/** The volume's patient-space (LPS) bounding box, plus its centre and radius. */
export interface VolumeBounds {
  /** Minimum corner of the axis-aligned box, in mm. */
  readonly min: Vec3;
  /** Maximum corner of the axis-aligned box, in mm. */
  readonly max: Vec3;
  /** Centre of the box, in mm — a natural orbit target for the 3D view. */
  readonly center: Vec3;
  /** Radius of the box's bounding sphere (half its diagonal), in mm. */
  readonly radius: number;
}

/** Patient-space bounding box of a volume, with centre and bounding radius. */
export function volumeBounds(volume: Volume): VolumeBounds {
  const { min, max } = patientBounds(resolveGeometry(volume), volume.dims);
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = 0.5 * length(sub(max, min));
  return { min, max, center, radius };
}

/**
 * View-direction parameter range `[tLo, tHi]` of a thick slab of `thicknessMm`,
 * centred on the volume centre and perpendicular to the orthographic view, for
 * the 3D raycaster. The camera is orthographic so every ray shares `forward` and
 * the slab is two parallel clip planes; a world point at ray parameter `t` has
 * view-depth `dot(eye − center, forward) + t` (since `forward` is unit and the
 * image-plane axes are perpendicular to it), so the slab `|depth| ≤ thickness/2`
 * is the t-interval returned here, the same parameter the shader marches in.
 *
 * A thickness covering the volume's full depth (`2·radius`, the diameter) yields
 * `[−∞, +∞]`, which leaves the box traversal unclipped — the default, exactly
 * reproducing the whole-volume projection.
 */
export function slabTRange(
  bounds: VolumeBounds,
  eye: Vec3,
  forward: Vec3,
  thicknessMm: number,
): [number, number] {
  if (!(thicknessMm < 2 * bounds.radius)) return [-Infinity, Infinity];
  const depth0 = dot(sub(eye, bounds.center), forward);
  const half = thicknessMm / 2;
  return [-half - depth0, half - depth0];
}

/**
 * Column-major 4×4 affine mapping a patient (LPS) point to 3D texture
 * coordinates `[0,1]^3`, the inverse of the index→patient geometry composed with
 * voxel-centre normalisation: `tex = (M⁻¹·(p − origin) + 0.5) / dims`. The 3D
 * MIP raycaster uses it to march world-space rays through the texture, mirroring
 * how {@link planeToTexMatrix} maps a plane into the same texture for the MPR
 * panes.
 */
export function patientToTexMatrix(volume: Volume): Float32Array {
  const geom = resolveGeometry(volume);
  const [d0, d1, d2] = volume.dims;
  // Rows of the inverse 3×3 (Cramer's rule), matching invMul above.
  const r0 = cross(geom.jStep, geom.kStep);
  const r1 = cross(geom.kStep, geom.iStep);
  const r2 = cross(geom.iStep, geom.jStep);
  const det = dot(geom.iStep, r0);
  const inv = det !== 0 ? 1 / det : 0;
  // a_c is the coefficient of the patient point for texture component c.
  const a0 = scale(r0, inv / d0);
  const a1 = scale(r1, inv / d1);
  const a2 = scale(r2, inv / d2);
  const b0 = 0.5 / d0 - dot(a0, geom.origin);
  const b1 = 0.5 / d1 - dot(a1, geom.origin);
  const b2 = 0.5 / d2 - dot(a2, geom.origin);
  // tex = (M · vec4(p, 1)).xyz; columns are p.x, p.y, p.z, 1. Column-major.
  // prettier-ignore
  return new Float32Array([
    a0[0], a1[0], a2[0], 0,
    a0[1], a1[1], a2[1], 0,
    a0[2], a1[2], a2[2], 0,
    b0,    b1,    b2,    1,
  ]);
}

/**
 * A clipping half-space in 3-D texture space: the set of points kept is
 * `{ tex : dot(normal, tex) + offset ≥ 0 }`. The 3D pane intersects three of
 * these — one per MPR slice plane — to clip every ray to a cut-away corner of
 * the volume, mode-agnostically (it narrows the marched `t`-range for the
 * projection modes and the DVR path alike).
 */
export interface HalfSpace {
  /** Plane normal in texture space; the kept side is where the value is positive. */
  readonly normal: Vec3;
  /** Constant term, so `dot(normal, tex) + offset` is the signed plane distance. */
  readonly offset: number;
}

/**
 * The MPR slice plane for an orientation, expressed in texture space as the
 * signed field `dot(normal, tex) + offset = slicePos(tex) − slicePos₀`: zero on
 * the slice, positive on the `+slicePos` side (the through-plane direction the
 * pane scrolls toward). `sliceIndex` selects the same slice the MPR pane shows,
 * matching its voxel-centre position `(sliceIndex + 0.5) / count`. The caller
 * orients the sign for the side it wants to keep (see {@link orientTowardRay}).
 */
export function sliceClipPlaneTex(
  volume: Volume,
  orientation: Orientation,
  sliceIndex: number,
): HalfSpace {
  const { dU, dV, dS, origin } = planeToTex(volume, orientation);
  // slicePos(tex) = dot(r2, tex − origin) / det, from planeCoordsAt's inverse.
  const r2 = cross(dU, dV);
  const det = dot(dU, cross(dV, dS));
  const inv = det !== 0 ? 1 / det : 0;
  const count = sliceCountFor(volume, orientation);
  const slicePos0 = count > 1 ? (sliceIndex + 0.5) / count : 0.5;
  const normal = scale(r2, inv);
  return { normal, offset: -(dot(normal, origin) + slicePos0) };
}

/**
 * Flip a half-space, if needed, so its kept side is the one a ray reaches at
 * larger `t` — i.e. the half deeper into the volume, away from an orthographic
 * eye. Intersecting the three slice planes oriented this way keeps the far
 * corner of the volume and removes the near octant facing the camera, the
 * cut-away that exposes the three MPR cross-sections. `rd` is the ray direction
 * in the same texture space as the plane.
 */
export function orientTowardRay(plane: HalfSpace, rd: Vec3): HalfSpace {
  // value(t) = dot(normal, rd)·t + const; a positive slope keeps the far (large-t)
  // half already, so only flip when the slope is negative.
  if (dot(plane.normal, rd) < 0) return { normal: scale(plane.normal, -1), offset: -plane.offset };
  return plane;
}

/**
 * An arbitrary clip plane placed in patient space (LPS, mm): a `point` the plane
 * passes through and a `normal`. The kept half is the side the normal points
 * into — `{ p : dot(normal, p − point) ≥ 0 }` — so translating `point` along
 * `normal` slides the cut-away through the volume. Drives the interactive 3D
 * clip-plane handle, independent of the MPR-plane cut-away.
 */
export interface PatientPlane {
  /** A point the plane passes through, in patient space (LPS, mm). */
  readonly point: Vec3;
  /** Plane normal (patient space, need not be unit); the kept half is the side it points into. */
  readonly normal: Vec3;
}

/**
 * An arbitrary patient-space {@link PatientPlane} expressed as a texture-space
 * {@link HalfSpace}, keeping the side its normal points into. The value
 * `dot(normal_tex, tex) + offset` equals `dot(normal, p − point)` for the same
 * physical point (same sign, same zero set), so feeding the result to
 * {@link clipTRange} — or the raycast shader — clips a ray exactly where the
 * plane cuts the volume. The texture-space normal is `Bᵀ·normal` for the
 * tex→patient linear part `B` (columns `iStep·dim`), which is how a plane's
 * coefficients transform under the affine; mirrors {@link sliceClipPlaneTex} for
 * a freely-placed plane rather than an MPR slice.
 */
export function clipPlaneTex(volume: Volume, plane: PatientPlane): HalfSpace {
  const geom = resolveGeometry(volume);
  const [d0, d1, d2] = volume.dims;
  const n = plane.normal;
  // tex→patient is p = B·tex + c, with B's columns iStep·dim0, jStep·dim1,
  // kStep·dim2 (since index = tex·dim − 0.5) and c the origin shifted by −½ voxel.
  const normal: Vec3 = [d0 * dot(geom.iStep, n), d1 * dot(geom.jStep, n), d2 * dot(geom.kStep, n)];
  const c = sub(geom.origin, scale(add(add(geom.iStep, geom.jStep), geom.kStep), 0.5));
  // value(tex) = dot(Bᵀn, tex) + dot(n, c) − dot(n, point) = dot(n, p − point).
  const offset = dot(n, c) - dot(n, plane.point);
  return { normal, offset };
}

/**
 * The three MPR slice planes as texture-space half-spaces oriented to keep the
 * far side of a ray travelling in direction `rd` (texture space). `sliceIndices`
 * are the current axial/coronal/sagittal indices, in {@link Orientation} order;
 * `rd` is the shared orthographic direction mapped into texture space. Feeding
 * the result to {@link clipTRange} yields the cut-away clip used by both the
 * raycast shader and the CPU pick.
 */
export function viewClipHalfSpaces(
  volume: Volume,
  sliceIndices: readonly [number, number, number],
  rd: Vec3,
): [HalfSpace, HalfSpace, HalfSpace] {
  return [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal].map((orientation) =>
    orientTowardRay(sliceClipPlaneTex(volume, orientation, sliceIndices[orientation]), rd),
  ) as [HalfSpace, HalfSpace, HalfSpace];
}

/**
 * Narrow a ray's `[tEntry, tExit]` parameter interval to the intersection of the
 * given half-spaces — the convex clip used for the 3D cut-away. Each half-space
 * `dot(normal, tex) + offset ≥ 0` becomes a one-sided bound on `t` along
 * `tex(t) = ro + t·rd`; a half-space the ray runs parallel to and outside of
 * collapses the interval (returns `tEntry > tExit`), which the caller reads as a
 * fully clipped ray. With no half-spaces the interval is returned unchanged.
 */
export function clipTRange(
  halfSpaces: readonly HalfSpace[],
  ro: Vec3,
  rd: Vec3,
  tEntry: number,
  tExit: number,
): [number, number] {
  let lo = tEntry;
  let hi = tExit;
  for (const { normal, offset } of halfSpaces) {
    const denom = dot(normal, rd);
    const value0 = dot(normal, ro) + offset; // value at t = 0
    if (Math.abs(denom) < 1e-12) {
      // Parallel to this plane: kept wholesale, or clipped away wholesale.
      if (value0 < 0) return [tEntry, tEntry - 1];
      continue;
    }
    const tCross = -value0 / denom;
    if (denom > 0) lo = Math.max(lo, tCross);
    else hi = Math.min(hi, tCross);
  }
  return [lo, hi];
}

/**
 * The four patient-space (LPS, mm) corners of an orientation's cut plane at a
 * given slice index, in rectangle order so they form a closed quad outline.
 *
 * The 3D pane projects these to draw where each MPR pane slices the volume, the
 * complement of {@link slabTRange}'s view-direction clip. The through-plane
 * position matches the shader's voxel-centre sampling `(sliceIndex + 0.5) /
 * count`, so the drawn rectangle sits exactly on the slice the MPR pane shows.
 */
export function slicePlaneCorners(
  volume: Volume,
  orientation: Orientation,
  sliceIndex: number,
): readonly [Vec3, Vec3, Vec3, Vec3] {
  const geom = resolveGeometry(volume);
  const basis = planeBasis(orientation, patientBounds(geom, volume.dims));
  const count = sliceCountFor(volume, orientation);
  const slicePos = count > 1 ? (sliceIndex + 0.5) / count : 0.5;
  const base = add(basis.origin, scale(basis.axisS, slicePos));
  const corner = (u: number, v: number): Vec3 =>
    add(add(base, scale(basis.axisU, u)), scale(basis.axisV, v));
  return [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
}

/** Physical width/height (mm) of an orientation's plane, for aspect-fit. */
export function planeExtentMm(volume: Volume, orientation: Orientation): [number, number] {
  const { min, max } = patientBounds(resolveGeometry(volume), volume.dims);
  const [lx, ly, lz] = sub(max, min);
  switch (orientation) {
    case Orientation.Axial:
      return [lx, ly];
    case Orientation.Coronal:
      return [lx, lz];
    case Orientation.Sagittal:
      return [ly, lz];
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

/**
 * Unit patient-space (LPS) directions of an orientation's pane axes: where the
 * pane's +u (rightward) and +v (downward, top→bottom) screen axes point in
 * patient space. Shares {@link planeBasis} with the reslice, so the on-screen
 * orientation labels can never drift from the planes the shader samples. The
 * display convention is axis-aligned and volume-independent, so a unit box gives
 * the directions; only their signs matter.
 */
export function planeAxisDirs(orientation: Orientation): { right: Vec3; down: Vec3 } {
  const basis = planeBasis(orientation, { min: [0, 0, 0], max: [1, 1, 1] });
  return { right: normalize(basis.axisU), down: normalize(basis.axisV) };
}

/**
 * In-plane pixel dimensions `[nu, nv]` of an orientation's resliced slice: how
 * many resampled samples span the pane's horizontal (u) and vertical (v) axes.
 * These are the through-plane slice counts of the two *other* orientations,
 * since each orientation's in-plane axes are the through-plane axes of the other
 * two (axial's u=x is sagittal's walk, its v=y is coronal's walk, etc.). Used to
 * iterate the slice's voxel grid for ROI statistics at the displayed resolution.
 */
export function planePixelDims(volume: Volume, orientation: Orientation): [number, number] {
  switch (orientation) {
    case Orientation.Axial:
      return [
        sliceCountFor(volume, Orientation.Sagittal),
        sliceCountFor(volume, Orientation.Coronal),
      ];
    case Orientation.Coronal:
      return [
        sliceCountFor(volume, Orientation.Sagittal),
        sliceCountFor(volume, Orientation.Axial),
      ];
    case Orientation.Sagittal:
      return [sliceCountFor(volume, Orientation.Coronal), sliceCountFor(volume, Orientation.Axial)];
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

/** Number of output slices walking an orientation's through-plane patient axis. */
export function sliceCountFor(volume: Volume, orientation: Orientation): number {
  const [cx, cy, cz] = sliceCounts(volume);
  switch (orientation) {
    case Orientation.Axial:
      return cz;
    case Orientation.Coronal:
      return cy;
    case Orientation.Sagittal:
      return cx;
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

/** Output slice counts along patient x, y, z, sized to preserve resolution. */
function sliceCounts(volume: Volume): Vec3 {
  const geom = resolveGeometry(volume);
  const { min, max } = patientBounds(geom, volume.dims);
  const [lx, ly, lz] = sub(max, min);
  const [sx, sy, sz] = outputSpacing(geom);
  return [count(lx, sx), count(ly, sy), count(lz, sz)];
}

function count(extent: number, spacing: number): number {
  return Math.max(1, Math.round(extent / spacing));
}

/**
 * Output voxel spacing (mm) along each patient axis: the largest component any
 * source step contributes to that axis. For an axis-aligned acquisition this is
 * exactly the source spacing, so slice counts match the original series; for an
 * oblique one it samples a touch finer, which avoids dropping detail.
 */
function outputSpacing(geom: VolumeGeometry): Vec3 {
  const steps = [geom.iStep, geom.jStep, geom.kStep];
  const out: [number, number, number] = [1, 1, 1];
  for (let c = 0; c < 3; c++) {
    let best = 0;
    for (const step of steps) best = Math.max(best, Math.abs(step[c]));
    out[c] = best > 1e-6 ? best : 1;
  }
  return out;
}

/** Patient-space AABB of the volume, using full voxel coverage (±½ voxel). */
function patientBounds(geom: VolumeGeometry, dims: readonly [number, number, number]): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const i of [-0.5, dims[0] - 0.5]) {
    for (const j of [-0.5, dims[1] - 0.5]) {
      for (const k of [-0.5, dims[2] - 0.5]) {
        const p = add(
          add(add(geom.origin, scale(geom.iStep, i)), scale(geom.jStep, j)),
          scale(geom.kStep, k),
        );
        for (let c = 0; c < 3; c++) {
          if (p[c] < min[c]) min[c] = p[c];
          if (p[c] > max[c]) max[c] = p[c];
        }
      }
    }
  }
  return { min, max };
}

/** Where a plane's u/v/slice axes run in patient space, per display convention. */
function planeBasis(orientation: Orientation, bounds: Bounds): PlaneBasis {
  const { min, max } = bounds;
  const [lx, ly, lz] = sub(max, min);
  switch (orientation) {
    case Orientation.Axial:
      return {
        origin: [min[0], min[1], min[2]],
        axisU: [lx, 0, 0], // x → right
        axisV: [0, ly, 0], // y (anterior) → top
        axisS: [0, 0, lz], // walk +z
      };
    case Orientation.Coronal:
      return {
        origin: [min[0], min[1], max[2]],
        axisU: [lx, 0, 0], // x → right
        axisV: [0, 0, -lz], // z (superior) → top
        axisS: [0, ly, 0], // walk +y
      };
    case Orientation.Sagittal:
      return {
        origin: [min[0], min[1], max[2]],
        axisU: [0, ly, 0], // y (anterior) → left
        axisV: [0, 0, -lz], // z (superior) → top
        axisS: [lx, 0, 0], // walk +x
      };
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

/**
 * Tilt a plane basis off its orthogonal default by an {@link ObliqueRotation},
 * pivoting about the plane's centre so the slice rotates in place.
 *
 * The two angles rotate the basis about its own (orthonormal) in-plane axes —
 * `tiltU` about `axisU`, `tiltV` about `axisV` — preserving each axis's length,
 * so the field of view and the through-plane spacing are unchanged and only the
 * plane's orientation tilts. The centre (`origin + ½(axisU+axisV+axisS)`, the
 * volume centre for every orthogonal basis) is held fixed, and the origin is
 * re-derived from the rotated axes. A zero/absent rotation returns the basis
 * untouched, so the orthogonal path is bit-for-bit unchanged.
 */
function obliqueBasis(basis: PlaneBasis, rotation: ObliqueRotation | undefined): PlaneBasis {
  if (!isOblique(rotation)) return basis;
  const uHat = normalize(basis.axisU);
  const vHat = normalize(basis.axisV);
  const sHat = normalize(basis.axisS);
  // Rotate the orthonormal frame about its own u then v axis. Both pivots are the
  // original axes, so the composition is a single rigid rotation of the frame.
  const rot = (v: Vec3): Vec3 =>
    rotateAbout(rotateAbout(v, uHat, rotation.tiltU), vHat, rotation.tiltV);
  const axisU = scale(rot(uHat), length(basis.axisU));
  const axisV = scale(rot(vHat), length(basis.axisV));
  const axisS = scale(rot(sHat), length(basis.axisS));
  const center = add(basis.origin, scale(add(add(basis.axisU, basis.axisV), basis.axisS), 0.5));
  const origin = sub(center, scale(add(add(axisU, axisV), axisS), 0.5));
  return { origin, axisU, axisV, axisS };
}

/** Rotate `v` about unit axis `k` by `angle` (radians) via Rodrigues' formula. */
function rotateAbout(v: Vec3, k: Vec3, angle: number): Vec3 {
  if (angle === 0) return v;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // v·c + (k×v)·s + k·(k·v)·(1−c), with k a unit vector.
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/** Multiply the inverse of the geometry's 3×3 linear map by a patient vector. */
function invMul(geom: VolumeGeometry, v: Vec3): Vec3 {
  // For M = [iStep | jStep | kStep], the inverse rows are the cross products of
  // the opposite columns over the determinant (Cramer's rule).
  const r0 = cross(geom.jStep, geom.kStep);
  const r1 = cross(geom.kStep, geom.iStep);
  const r2 = cross(geom.iStep, geom.jStep);
  const det = dot(geom.iStep, r0);
  const inv = det !== 0 ? 1 / det : 0;
  return [dot(r0, v) * inv, dot(r1, v) * inv, dot(r2, v) * inv];
}

/** Convert a continuous voxel index vector to texture coords: `index / dim`. */
function perTexel(index: Vec3, dims: readonly [number, number, number]): Vec3 {
  return [index[0] / dims[0], index[1] / dims[1], index[2] / dims[2]];
}
