import { type Vec3, type Volume, type Orientation } from '../dicom/types';
import { patientToVoxel } from '../dicom/volume';
import type { PlanePoint } from './pane-coords';
import {
  planeCoordsAt,
  planeToTex,
  resolveGeometry,
  sliceCountFor,
  type ObliqueRotation,
  type PlaneCoords,
} from './reslice';

/**
 * Geometry for drawing RTSTRUCT ROI contours over the MPR panes.
 *
 * An ROI contour is a planar loop of points in patient coordinates (LPS, mm; see
 * {@link import('../dicom/types').Contour}). To overlay it on a resliced pane we
 * map every point into the pane's in-plane frame — the same `(u, v, slicePos)`
 * coordinates the cursor probe and the linked crosshair use — via the shared
 * {@link planeToTex} affine, so the contour tracks pan/zoom/flip/scroll exactly
 * like the other overlays ({@link planePointToPane} does the final pane-pixel
 * projection, identical to the measurements).
 *
 * A contour interacts with a pane's slice in one of two ways, both handled by
 * {@link contourOnPlane}:
 *   - **Coplanar** with the slice (e.g. an axial loop on the axial pane at its
 *     own z): its through-plane spread is ~flat, so the whole loop is projected
 *     as a polyline — but only when it sits on the displayed slice.
 *   - **Crossing** the slice (e.g. that same axial loop seen edge-on in coronal
 *     or sagittal, or any oblique cut): the polygon is intersected with the slice
 *     plane ({@link sliceSegments}), yielding the cross-section line segments.
 *
 * The maths is pure and lives here so it can be unit-tested without a GPU or DOM.
 */

/** A polyline projected onto a pane's plane, in normalised in-plane `(u, v)` coordinates. */
export interface ContourPolyline {
  /** The polyline's vertices, in plane `(u, v)` axes (both in `[0, 1]` when on-pane). */
  readonly points: readonly PlanePoint[];
  /** Whether to close the loop (a `CLOSED_PLANAR` contour drawn coplanar). */
  readonly closed: boolean;
}

/**
 * Map a patient-space point (LPS, mm) into a pane's in-plane `(u, v, slicePos)`
 * coordinates for `orientation`, the same frame {@link planeCoordsAt} returns.
 *
 * Composes the volume's patient→voxel inverse ({@link patientToVoxel}) with the
 * voxel-centre texture normalisation and the plane's inverse affine, so the
 * result lands on exactly the pixel the reslice would sample for that point.
 * Returns `null` only when the volume geometry is singular (non-invertible).
 */
export function patientToPlane(
  volume: Volume,
  orientation: Orientation,
  point: Vec3,
  rotation?: ObliqueRotation,
): PlaneCoords | null {
  return projectPoint(planeToTex(volume, orientation, rotation), volume, point);
}

/** Shared core of {@link patientToPlane}, reusing a precomputed `planeToTex` map. */
function projectPoint(
  map: ReturnType<typeof planeToTex>,
  volume: Volume,
  point: Vec3,
): PlaneCoords | null {
  const voxel = patientToVoxel(resolveGeometry(volume), point);
  if (!voxel) return null;
  const [dx, dy, dz] = volume.dims;
  const tex: Vec3 = [(voxel[0] + 0.5) / dx, (voxel[1] + 0.5) / dy, (voxel[2] + 0.5) / dz];
  return planeCoordsAt(map, tex);
}

/**
 * The through-plane position (`slicePos`, 0→1) of the displayed slice and the
 * half-slice tolerance around it, matching the shader's voxel-centre sampling
 * `(sliceIndex + 0.5) / count`. The tolerance is half a slice's thickness, the
 * band a coplanar contour is considered "on" this slice.
 */
function slicePosBand(
  volume: Volume,
  orientation: Orientation,
  sliceIndex: number,
): {
  slicePos0: number;
  half: number;
} {
  const count = sliceCountFor(volume, orientation);
  return count > 1
    ? { slicePos0: (sliceIndex + 0.5) / count, half: 0.5 / count }
    : { slicePos0: 0.5, half: 0.5 };
}

/**
 * Crossing points where a polygon (given in plane `(u, v, slicePos)` coordinates)
 * pierces the plane `slicePos = slicePos0`. Each polygon edge straddling the
 * plane contributes one linearly-interpolated `(u, v)` crossing. A vertex exactly
 * on the plane is treated as the positive side, so shared vertices aren't
 * double-counted. `closed` wraps the last edge back to the first.
 */
export function sliceCrossings(
  coords: readonly PlaneCoords[],
  slicePos0: number,
  closed: boolean,
): PlanePoint[] {
  const crossings: PlanePoint[] = [];
  const n = coords.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = coords[i];
    const b = coords[(i + 1) % n];
    const aAbove = a.slicePos > slicePos0;
    const bAbove = b.slicePos > slicePos0;
    if (aAbove === bAbove) continue;
    const t = (slicePos0 - a.slicePos) / (b.slicePos - a.slicePos);
    crossings.push({ u: a.u + t * (b.u - a.u), v: a.v + t * (b.v - a.v) });
  }
  return crossings;
}

/**
 * The cross-section line segments where a planar polygon (in plane
 * `(u, v, slicePos)` coordinates) meets the slice `slicePos = slicePos0`. The
 * intersection of two planes is a line, so the {@link sliceCrossings} all lie on
 * it; sorting them along that line and pairing consecutive points yields the
 * filled spans of the polygon's interior — one segment for a convex loop, more
 * for a concave one.
 */
export function sliceSegments(
  coords: readonly PlaneCoords[],
  slicePos0: number,
  closed: boolean,
): [PlanePoint, PlanePoint][] {
  const crossings = sliceCrossings(coords, slicePos0, closed);
  if (crossings.length < 2) return [];
  // The crossings are collinear, so lexicographic (u, then v) order is their
  // geometric order along the line (u is monotonic unless the line is vertical,
  // in which case v breaks the tie).
  crossings.sort((p, q) => p.u - q.u || p.v - q.v);
  const segments: [PlanePoint, PlanePoint][] = [];
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    segments.push([crossings[i], crossings[i + 1]]);
  }
  return segments;
}

/**
 * Project one ROI contour onto a pane's slice as drawable polylines in plane
 * `(u, v)` coordinates.
 *
 * Maps the contour's patient-space points into the pane's `(u, v, slicePos)`
 * frame, then either projects the whole loop (when it lies in the displayed
 * slice) or intersects it with the slice plane (when it crosses):
 *   - **Coplanar** (through-plane spread within half a slice): returned as a
 *     single polyline, `closed` per the contour type, but only when its mean
 *     `slicePos` sits within the displayed slice's half-slice band — otherwise it
 *     belongs to another slice and nothing is drawn.
 *   - **Crossing**: returned as the open cross-section segments from
 *     {@link sliceSegments}.
 *
 * `closed` distinguishes a `CLOSED_PLANAR` loop from an `OPEN_PLANAR` polyline.
 * Returns an empty array for degenerate input (fewer than two points, or a
 * singular volume geometry).
 */
/**
 * Map a whole contour's patient-space points into a pane's `(u, v, slicePos)`
 * frame in one pass, reusing a single `planeToTex` affine. Returns null for a
 * degenerate contour (fewer than two points) or a singular volume geometry —
 * the expensive step, so callers can cache it independent of pan/zoom/flip.
 */
export function contourPlaneCoords(
  volume: Volume,
  orientation: Orientation,
  points: readonly Vec3[],
  rotation?: ObliqueRotation,
): PlaneCoords[] | null {
  if (points.length < 2) return null;
  const map = planeToTex(volume, orientation, rotation);
  const coords: PlaneCoords[] = [];
  for (const point of points) {
    const pc = projectPoint(map, volume, point);
    if (!pc) return null;
    coords.push(pc);
  }
  return coords;
}

export function contourOnPlane(
  volume: Volume,
  orientation: Orientation,
  sliceIndex: number,
  points: readonly Vec3[],
  closed: boolean,
  rotation?: ObliqueRotation,
): ContourPolyline[] {
  const coords = contourPlaneCoords(volume, orientation, points, rotation);
  if (!coords) return [];

  const { slicePos0, half } = slicePosBand(volume, orientation, sliceIndex);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const c of coords) {
    if (c.slicePos < min) min = c.slicePos;
    if (c.slicePos > max) max = c.slicePos;
    sum += c.slicePos;
  }

  if (max - min <= half) {
    // Coplanar with the slice: draw the loop, but only when it sits on this slice.
    if (Math.abs(sum / coords.length - slicePos0) > half) return [];
    return [{ points: coords.map((c) => ({ u: c.u, v: c.v })), closed }];
  }

  return sliceSegments(coords, slicePos0, closed).map((segment) => ({
    points: segment,
    closed: false,
  }));
}

/** One contour's crossing of a slice: its spans' `u` values at a constant `v`. */
export interface CrossSectionRow {
  readonly v: number;
  readonly us: readonly number[];
}

/**
 * How one contour meets a pane's displayed slice, with the expensive patient→plane
 * projection done once. Either a coplanar `loop` to draw whole, a `cross` row of
 * `(u, v)` crossings to fold into the ROI's cross-section silhouette, or null when
 * the contour is off this slice / degenerate. Unlike {@link contourOnPlane} this
 * returns the raw crossings so the caller can build an *outline* across the ROI's
 * contours rather than stacking per-slice interior spans (which read as a fill).
 */
export type ContourPlaneResult =
  | { readonly kind: 'loop'; readonly points: PlanePoint[]; readonly closed: boolean }
  | { readonly kind: 'cross'; readonly row: CrossSectionRow }
  | null;

export function contourPlaneResult(
  volume: Volume,
  orientation: Orientation,
  sliceIndex: number,
  points: readonly Vec3[],
  closed: boolean,
  rotation?: ObliqueRotation,
): ContourPlaneResult {
  const coords = contourPlaneCoords(volume, orientation, points, rotation);
  if (!coords) return null;

  const { slicePos0, half } = slicePosBand(volume, orientation, sliceIndex);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const c of coords) {
    if (c.slicePos < min) min = c.slicePos;
    if (c.slicePos > max) max = c.slicePos;
    sum += c.slicePos;
  }

  if (max - min <= half) {
    if (Math.abs(sum / coords.length - slicePos0) > half) return null;
    return { kind: 'loop', points: coords.map((c) => ({ u: c.u, v: c.v })), closed };
  }

  const crossings = sliceCrossings(coords, slicePos0, closed);
  if (crossings.length < 2) return null;
  // For axial contours (constant z) on a coronal/sagittal pane the crossings are
  // collinear at a constant v (= the contour's plane position); the mean is exact
  // there and a reasonable row position for the rare oblique case.
  const v = crossings.reduce((s, c) => s + c.v, 0) / crossings.length;
  return { kind: 'cross', row: { v, us: crossings.map((c) => c.u) } };
}

/**
 * Build the cross-section *outline* of an ROI from its per-contour crossing rows:
 * the left (min-u) and right (max-u) envelopes down the stack of slices, joined
 * into one closed loop. This traces the structure's silhouette where it cuts the
 * plane instead of filling it with one interior span per contour.
 */
export function crossSectionOutline(rows: readonly CrossSectionRow[]): ContourPolyline[] {
  const valid = rows
    .filter((r) => r.us.length > 0)
    .map((r) => ({ v: r.v, lo: Math.min(...r.us), hi: Math.max(...r.us) }))
    .sort((a, b) => a.v - b.v);
  if (valid.length === 0) return [];
  if (valid.length === 1) {
    const r = valid[0];
    return [
      {
        points: [
          { u: r.lo, v: r.v },
          { u: r.hi, v: r.v },
        ],
        closed: false,
      },
    ];
  }
  const left = valid.map((r) => ({ u: r.lo, v: r.v }));
  const right = valid.map((r) => ({ u: r.hi, v: r.v })).reverse();
  return [{ points: [...left, ...right], closed: true }];
}

/** Perpendicular distance from `p` to the line through `a` and `b`. */
function perpDistance(p: PlanePoint, a: PlanePoint, b: PlanePoint): number {
  const dx = b.u - a.u;
  const dy = b.v - a.v;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.u - a.u, p.v - a.v);
  return Math.abs((p.u - a.u) * dy - (p.v - a.v) * dx) / len;
}

/**
 * Ramer–Douglas–Peucker simplification: drop points that stray less than
 * `tolerance` from the line between their kept neighbours. Halves the point count
 * of dense contour loops with no visible change, cutting projection + SVG cost.
 */
export function decimate(points: readonly PlanePoint[], tolerance: number): PlanePoint[] {
  const n = points.length;
  if (n <= 2 || tolerance <= 0) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(points[i], points[lo], points[hi]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out: PlanePoint[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}
