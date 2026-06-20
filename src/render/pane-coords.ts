import { Orientation, type Volume } from '../dicom/types';
import type { PaneRect, Vec2 } from './layout';
import { aspectScale } from './slice-renderer';

/**
 * Pane ↔ in-plane coordinate mapping, shared by the measurement overlays.
 *
 * A measurement anchor is stored as an in-plane point `{ u, v }` in `[0, 1]`,
 * the *texture-space* axes the reslice samples (`u` along the plane's horizontal
 * axis before the display flip, `v` top→bottom) — the same coordinates
 * {@link planeCoordsAt} returns and the cursor probe runs through `planeToTex`.
 * Storing the pre-flip texture coordinate keeps an annotation pinned to the
 * anatomy it was drawn on regardless of pan, zoom, or the sagittal flip; only
 * the final projection to a pane pixel applies the flip.
 *
 * {@link paneToPlanePoint} (cursor → plane) and {@link planePointToPane}
 * (plane → cursor) reproduce, in both directions, the exact pan/letterbox/zoom
 * geometry the shader (`slice-shader.ts`), the probe (`probe.ts`) and the linked
 * crosshair (`crosshair.ts`) use, so a placed point lands on — and tracks — the
 * pixel the probe would sample.
 */

/** An in-plane anchor in texture-space axes, both components in `[0, 1]`. */
export interface PlanePoint {
  /** Position along the plane's horizontal axis (pre-display-flip), 0→1. */
  readonly u: number;
  /** Position along the plane's vertical axis, 0 at the top → 1 at the bottom. */
  readonly v: number;
}

/** A point within a pane, in the same pixel units as the pane rect. */
export interface PanePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Map a cursor over a pane to the in-plane point it covers, the same inverse
 * the probe runs (`probe.ts`) but stopping at the plane instead of a voxel.
 * Returns `null` when the cursor is outside the pane rect; a cursor over the
 * letterbox margin is clamped to the nearest plane edge so endpoint drags near
 * the border stay responsive rather than snapping back.
 */
export function paneToPlanePoint(
  volume: Volume,
  orientation: Orientation,
  zoom: number,
  rect: PaneRect,
  cursorX: number,
  cursorY: number,
  flipX = false,
  pan: Vec2 = { x: 0, y: 0 },
): PlanePoint | null {
  if (rect.width < 1 || rect.height < 1) return null;

  const u = (cursorX - rect.x) / rect.width;
  const v = (cursorY - rect.y) / rect.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;

  const z = zoom > 0 ? zoom : 1;
  const [scaleX, scaleY] = aspectScale(volume, orientation, rect.width, rect.height);
  const planeX = clamp01((u - 0.5 - pan.x) * (scaleX / z) + 0.5);
  const planeY = clamp01((v - 0.5 - pan.y) * (scaleY / z) + 0.5);
  // Mirror to the texture axis the way the shader and probe do, so the stored
  // point follows the anatomy rather than the screen when the view is flipped.
  return { u: flipX ? 1 - planeX : planeX, v: planeY };
}

/**
 * Project an in-plane point onto a pane pixel, the forward direction of
 * {@link paneToPlanePoint} (and the same tail as {@link focusPanePoint}): undo
 * the flip, then apply the centre/letterbox/zoom and pan. Returns `null` for a
 * degenerate pane; the point may lie outside the rect when panned or zoomed off
 * screen, which the caller checks.
 */
export function planePointToPane(
  volume: Volume,
  orientation: Orientation,
  point: PlanePoint,
  zoom: number,
  rect: PaneRect,
  flipX = false,
  pan: Vec2 = { x: 0, y: 0 },
): PanePoint | null {
  if (rect.width < 1 || rect.height < 1) return null;

  const planeX = flipX ? 1 - point.u : point.u;
  const z = zoom > 0 ? zoom : 1;
  const [scaleX, scaleY] = aspectScale(volume, orientation, rect.width, rect.height);
  const u = (planeX - 0.5) * (z / scaleX) + 0.5 + pan.x;
  const v = (point.v - 0.5) * (z / scaleY) + 0.5 + pan.y;
  return { x: rect.x + u * rect.width, y: rect.y + v * rect.height };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
