import { clamp01, clampIndex } from '../dicom/math';
import type { Vec3, Volume, VolumeGeometry } from '../dicom/types';
import { add, cross, dot, length, normalize, scale, sub } from '../dicom/vec3';
import { patientToVoxel } from '../dicom/volume';
import { resolveGeometry } from './reslice';

/**
 * Curved planar reformation (CPR) geometry.
 *
 * A CPR "straightens" a curved structure (e.g. a vessel) by sampling the volume
 * along a user-drawn centreline: at evenly-spaced steps along the curve it cuts a
 * line perpendicular to the path and stacks those lines into a single 2D image,
 * so a tortuous structure is laid out flat. The path drawn on the MPR panes is a
 * list of patient-space control points; everything here works in patient space
 * (LPS, millimetres) so the maths is independent of how the series was acquired
 * and can be unit-tested without a GPU or DOM.
 *
 * The pipeline is three pure stages, each exported for testing:
 *   1. {@link buildCenterline} — fit a Catmull–Rom spline through the control
 *      points and resample it at a uniform *arc-length* step, so each output row
 *      represents the same physical distance along the curve.
 *   2. {@link rotationMinimizingFrames} — carry a stable cutting direction along
 *      the path by parallel transport (no sudden twists at curves), giving, per
 *      sample, an in-plane `normal`/`binormal` pair perpendicular to the tangent.
 *   3. {@link straightenedCpr} — for each centreline sample, walk the cutting
 *      line (rotatable around the path) and trilinearly sample the volume, filling
 *      a row of the straightened raster.
 */

/** One resampled point along the centreline: its position and unit tangent. */
export interface CenterlineSample {
  /** Patient-space position (LPS, mm). */
  readonly position: Vec3;
  /** Unit tangent (direction of travel along the curve) at this point. */
  readonly tangent: Vec3;
}

/** A centreline resampled at a uniform arc-length step. */
export interface Centerline {
  /** Samples ordered from the start of the path, spaced `stepMm` apart. */
  readonly samples: readonly CenterlineSample[];
  /** Arc-length step between consecutive samples, in mm. */
  readonly stepMm: number;
  /** Total arc length of the path, in mm. */
  readonly lengthMm: number;
}

/** Options for fitting and resampling a centreline. */
export interface CenterlineOptions {
  /** Arc-length spacing between output samples, in mm (must be > 0). */
  readonly stepMm: number;
  /**
   * Catmull–Rom knot exponent: 0 = uniform, 0.5 = centripetal (default), 1 =
   * chordal. Centripetal avoids the cusps and self-intersections uniform
   * Catmull–Rom can produce on sharp or unevenly-spaced control points, so it is
   * the safe default for a hand-drawn vessel path.
   */
  readonly alpha?: number;
  /** Spline-subdivision count per control-point segment used to measure arc length. */
  readonly subdivisions?: number;
}

/** A perpendicular cutting frame at a centreline sample. */
export interface Frame {
  /** Unit normal: the cutting line's direction at rotation angle 0. */
  readonly normal: Vec3;
  /** Unit binormal: `tangent × normal`, completing a right-handed frame. */
  readonly binormal: Vec3;
}

/** A straightened CPR raster plus the physical size of its pixels. */
export interface CprImage {
  /** Row-major scalar samples, length `width * height`, in modality units. */
  readonly data: Float32Array;
  /** Columns: samples across the cutting line. */
  readonly width: number;
  /** Rows: samples along the curve (one per centreline sample). */
  readonly height: number;
  /** Physical width of one column, in mm (the cutting-line sample spacing). */
  readonly mmPerColumn: number;
  /** Physical height of one row, in mm (the centreline arc-length step). */
  readonly mmPerRow: number;
}

/** Options for {@link straightenedCpr}. */
export interface CprOptions extends CenterlineOptions {
  /** Half-extent of the cutting line either side of the path, in mm. */
  readonly halfWidthMm: number;
  /** Sample spacing across the cutting line, in mm (defaults to {@link CenterlineOptions.stepMm}). */
  readonly acrossStepMm?: number;
  /** Rotation of the cutting direction around the path, in radians (default 0). */
  readonly angle?: number;
  /**
   * Value written where the cutting line leaves the volume. Defaults to the
   * volume's minimum, so out-of-bounds reads read as background rather than a
   * bright streak.
   */
  readonly background?: number;
}

const DEFAULT_ALPHA = 0.5;
const DEFAULT_SUBDIVISIONS = 24;

/**
 * Fit a Catmull–Rom spline through `controlPoints` (patient space, mm) and
 * resample it at a uniform arc-length step.
 *
 * The spline passes through every control point; endpoints are handled by
 * reflecting a phantom point so the curve has a defined tangent there. The fitted
 * curve is densely subdivided to measure true arc length, then walked at `stepMm`
 * intervals — so each returned sample is the same physical distance from the last,
 * which is what keeps the straightened image's vertical scale uniform.
 *
 * Fewer than two control points cannot define a path and yield an empty
 * centreline. Duplicate/coincident control points are tolerated (zero-length
 * segments contribute no arc length).
 */
export function buildCenterline(
  controlPoints: readonly Vec3[],
  options: CenterlineOptions,
): Centerline {
  const stepMm = options.stepMm;
  if (!(stepMm > 0)) throw new RangeError(`CPR step must be positive, got ${stepMm}`);
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const subdivisions = Math.max(1, Math.floor(options.subdivisions ?? DEFAULT_SUBDIVISIONS));

  const pts = dedupeAdjacent(controlPoints);
  if (pts.length < 2) return { samples: [], stepMm, lengthMm: 0 };

  // Densely sample the spline, accumulating arc length along the polyline.
  const dense: Vec3[] = [];
  const arc: number[] = [];
  let total = 0;
  const pushDense = (p: Vec3): void => {
    if (dense.length > 0) total += length(sub(p, dense[dense.length - 1]));
    dense.push(p);
    arc.push(total);
  };

  pushDense(pts[0]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? reflect(pts[i], pts[i + 1]);
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? reflect(pts[i + 1], pts[i]);
    for (let s = 1; s <= subdivisions; s++) {
      pushDense(catmullRom(p0, p1, p2, p3, s / subdivisions, alpha));
    }
  }

  const samples = resampleByArcLength(dense, arc, total, stepMm);
  return { samples, stepMm, lengthMm: total };
}

/**
 * Walk a dense polyline (with precomputed cumulative arc lengths `arc`, total
 * `total`) at uniform `stepMm` intervals, returning a position and unit tangent at
 * each step. The number of samples is `floor(total / stepMm) + 1`, so the first
 * sample is the path start and the last is at or just before the end. The tangent
 * is the local direction of the dense polyline at the sample.
 */
export function resampleByArcLength(
  dense: readonly Vec3[],
  arc: readonly number[],
  total: number,
  stepMm: number,
): CenterlineSample[] {
  const samples: CenterlineSample[] = [];
  const count = Math.floor(total / stepMm + 1e-9) + 1;
  let cursor = 0;
  for (let n = 0; n < count; n++) {
    const target = Math.min(n * stepMm, total);
    while (cursor < dense.length - 2 && arc[cursor + 1] < target) cursor++;
    const lo = cursor;
    const hi = Math.min(cursor + 1, dense.length - 1);
    const span = arc[hi] - arc[lo];
    const t = span > 1e-9 ? (target - arc[lo]) / span : 0;
    const position = lerp(dense[lo], dense[hi], t);
    samples.push({ position, tangent: tangentAt(dense, lo, hi) });
  }
  return samples;
}

/**
 * Carry a stable cutting frame along the centreline by the double-reflection
 * rotation-minimizing-frame method (Wang et al. 2008).
 *
 * A naïve Frenet frame flips the normal at inflection points and spins wildly
 * where the curve is nearly straight; parallel transport instead rotates the
 * frame by the minimum needed to stay perpendicular to the tangent, so the
 * straightened image does not twist. The first normal is `initialNormal`
 * projected perpendicular to the first tangent (or an arbitrary perpendicular
 * when that is degenerate); each subsequent frame is transported from the last.
 *
 * Returns one {@link Frame} per sample. An empty input yields an empty array.
 */
export function rotationMinimizingFrames(
  samples: readonly CenterlineSample[],
  initialNormal?: Vec3,
): Frame[] {
  if (samples.length === 0) return [];
  const frames: Frame[] = [];

  const t0 = samples[0].tangent;
  let r = perpendicularTo(t0, initialNormal);
  frames.push(frameFrom(t0, r));

  for (let i = 0; i < samples.length - 1; i++) {
    const x0 = samples[i].position;
    const x1 = samples[i + 1].position;
    const t1 = samples[i + 1].tangent;

    // Reflect r and the tangent across the plane between the two points...
    const v1 = sub(x1, x0);
    const c1 = dot(v1, v1);
    let rL = r;
    let tL = samples[i].tangent;
    if (c1 > 1e-12) {
      rL = sub(r, scale(v1, (2 / c1) * dot(v1, r)));
      tL = sub(samples[i].tangent, scale(v1, (2 / c1) * dot(v1, samples[i].tangent)));
    }
    // ...then reflect again across the plane between the transported and next
    // tangent, landing the frame perpendicular to t1 with minimal rotation.
    const v2 = sub(t1, tL);
    const c2 = dot(v2, v2);
    r = c2 > 1e-12 ? sub(rL, scale(v2, (2 / c2) * dot(v2, rL))) : rL;
    r = perpendicularTo(t1, r); // re-orthogonalise against drift
    frames.push(frameFrom(t1, r));
  }
  return frames;
}

/**
 * Build a straightened CPR raster from a volume and a patient-space path.
 *
 * Rows run along the curve (top = path start) at `stepMm` arc-length spacing;
 * columns run across the cutting line over `[-halfWidthMm, +halfWidthMm]` at
 * `acrossStepMm` spacing, centred on the path. The cutting direction is the
 * rotation-minimizing normal rotated by `angle` radians around the local tangent,
 * so sweeping `angle` spins the reformat around the vessel. Each pixel is a
 * trilinear sample of the volume; reads outside the volume get `background`.
 *
 * Returns a 1×1 background image when the path has fewer than two usable control
 * points, so callers can render unconditionally.
 */
export function straightenedCpr(
  volume: Volume,
  controlPoints: readonly Vec3[],
  options: CprOptions,
): CprImage {
  const background = options.background ?? volume.min;
  const acrossStepMm = options.acrossStepMm ?? options.stepMm;
  if (!(acrossStepMm > 0)) throw new RangeError(`CPR column step must be positive`);
  if (!(options.halfWidthMm > 0)) throw new RangeError(`CPR half-width must be positive`);

  const centerline = buildCenterline(controlPoints, options);
  const height = centerline.samples.length;
  if (height < 2) {
    return {
      data: Float32Array.of(background),
      width: 1,
      height: 1,
      mmPerColumn: acrossStepMm,
      mmPerRow: options.stepMm,
    };
  }

  const frames = rotationMinimizingFrames(centerline.samples);
  const angle = options.angle ?? 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Columns span the cutting line symmetrically about the path.
  const half = Math.max(1, Math.round(options.halfWidthMm / acrossStepMm));
  const width = 2 * half + 1;
  const data = new Float32Array(width * height);
  const geom = resolveGeometry(volume);

  for (let row = 0; row < height; row++) {
    const center = centerline.samples[row].position;
    const { normal, binormal } = frames[row];
    // cutDir rotates around the tangent as `angle` changes.
    const cutDir: Vec3 = add(scale(normal, cos), scale(binormal, sin));
    const rowOffset = row * width;
    for (let col = 0; col < width; col++) {
      const offsetMm = (col - half) * acrossStepMm;
      const p = add(center, scale(cutDir, offsetMm));
      const value = sampleVolumeTrilinear(volume, geom, p);
      data[rowOffset + col] = Number.isNaN(value) ? background : value;
    }
  }

  return { data, width, height, mmPerColumn: acrossStepMm, mmPerRow: centerline.stepMm };
}

/**
 * Trilinearly sample `volume` at a patient-space point (LPS, mm). The point is
 * mapped to continuous voxel indices through the inverse of the volume geometry,
 * and the eight surrounding voxels are blended. Returns `NaN` when the point lies
 * outside the voxel grid, which the caller replaces with a background value.
 */
export function sampleVolumeTrilinear(volume: Volume, geom: VolumeGeometry, point: Vec3): number {
  const index = patientToVoxel(geom, point);
  if (index === null) return NaN;
  const [fx, fy, fz] = index;
  const [dimX, dimY, dimZ] = volume.dims;
  if (
    fx < -0.5 ||
    fx > dimX - 0.5 ||
    fy < -0.5 ||
    fy > dimY - 0.5 ||
    fz < -0.5 ||
    fz > dimZ - 0.5
  ) {
    return NaN;
  }
  const x0 = clampIndex(Math.floor(fx), dimX);
  const y0 = clampIndex(Math.floor(fy), dimY);
  const z0 = clampIndex(Math.floor(fz), dimZ);
  const x1 = clampIndex(x0 + 1, dimX);
  const y1 = clampIndex(y0 + 1, dimY);
  const z1 = clampIndex(z0 + 1, dimZ);
  const tx = clamp01(fx - x0);
  const ty = clamp01(fy - y0);
  const tz = clamp01(fz - z0);

  const data = volume.data;
  const at = (x: number, y: number, z: number): number => data[(z * dimY + y) * dimX + x];
  const c00 = lerpScalar(at(x0, y0, z0), at(x1, y0, z0), tx);
  const c10 = lerpScalar(at(x0, y1, z0), at(x1, y1, z0), tx);
  const c01 = lerpScalar(at(x0, y0, z1), at(x1, y0, z1), tx);
  const c11 = lerpScalar(at(x0, y1, z1), at(x1, y1, z1), tx);
  const c0 = lerpScalar(c00, c10, ty);
  const c1 = lerpScalar(c01, c11, ty);
  return lerpScalar(c0, c1, tz);
}

/**
 * A point on a Catmull–Rom segment defined by the four control points
 * `p0..p3`, at parameter `t ∈ [0, 1]` between `p1` and `p2`. `alpha` is the knot
 * exponent (0 uniform, 0.5 centripetal, 1 chordal). Reduces to a straight-line
 * interpolation when the points are collinear and evenly spaced.
 */
export function catmullRom(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  t: number,
  alpha = DEFAULT_ALPHA,
): Vec3 {
  // Non-uniform Catmull–Rom via Barry–Goldman knot parametrisation.
  const t0 = 0;
  const t1 = t0 + knot(p0, p1, alpha);
  const t2 = t1 + knot(p1, p2, alpha);
  const t3 = t2 + knot(p2, p3, alpha);
  const tt = t1 + (t2 - t1) * t;

  // Degenerate knots (coincident points) collapse to linear interpolation.
  if (t1 === t0 || t2 === t1 || t3 === t2) return lerp(p1, p2, t);

  const a1 = blend(p0, p1, t0, t1, tt);
  const a2 = blend(p1, p2, t1, t2, tt);
  const a3 = blend(p2, p3, t2, t3, tt);
  const b1 = blend2(a1, a2, t0, t2, tt);
  const b2 = blend2(a2, a3, t1, t3, tt);
  return blend2(b1, b2, t1, t2, tt);
}

// --- internal helpers -------------------------------------------------------

function knot(a: Vec3, b: Vec3, alpha: number): number {
  const d = length(sub(b, a));
  return Math.pow(d, alpha);
}

/** Linear blend `a + (b−a)·((tt−ta)/(tb−ta))`, guarding a zero interval. */
function blend(a: Vec3, b: Vec3, ta: number, tb: number, tt: number): Vec3 {
  const span = tb - ta;
  return span !== 0 ? lerp(a, b, (tt - ta) / span) : a;
}

/** Same as {@link blend} but reused at the second/third pyramid levels for clarity. */
function blend2(a: Vec3, b: Vec3, ta: number, tb: number, tt: number): Vec3 {
  return blend(a, b, ta, tb, tt);
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function lerpScalar(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Reflect `p` through `mirror` (a phantom endpoint: `2·mirror − p`). */
function reflect(mirror: Vec3, p: Vec3): Vec3 {
  return sub(scale(mirror, 2), p);
}

/** Drop control points coincident with their predecessor (zero-length segments). */
function dedupeAdjacent(points: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || length(sub(p, prev)) > 1e-9) out.push([p[0], p[1], p[2]]);
  }
  return out;
}

/** Local unit tangent of a dense polyline at the `[lo, hi]` segment. */
function tangentAt(dense: readonly Vec3[], lo: number, hi: number): Vec3 {
  // Use the widest defined neighbourhood for a stable direction.
  const a = dense[Math.max(0, lo - 1)] ?? dense[lo];
  const b = dense[Math.min(dense.length - 1, hi + 1)] ?? dense[hi];
  const dir = sub(b, a);
  return length(dir) > 1e-12 ? normalize(dir) : normalize(sub(dense[hi], dense[lo]));
}

/** A unit vector perpendicular to `tangent`, biased toward `hint` when given. */
function perpendicularTo(tangent: Vec3, hint?: Vec3): Vec3 {
  const t = normalize(tangent);
  const seed = hint && length(hint) > 1e-9 ? hint : defaultUp(t);
  // Remove the component of seed along t (Gram–Schmidt).
  const proj = sub(seed, scale(t, dot(seed, t)));
  if (length(proj) > 1e-9) return normalize(proj);
  // Seed was parallel to t: fall back to any axis not aligned with t.
  const alt = defaultUp(t);
  return normalize(sub(alt, scale(t, dot(alt, t))));
}

/** A reference up-direction unlikely to be parallel to `t`. */
function defaultUp(t: Vec3): Vec3 {
  // Patient superior (+z) usually works; switch axes when the tangent is along z.
  return Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
}

function frameFrom(tangent: Vec3, normal: Vec3): Frame {
  const t = normalize(tangent);
  const n = normalize(normal);
  return { normal: n, binormal: normalize(cross(t, n)) };
}
