import { clamp } from '../../dicom/math';
import { formatValue } from '../../render/measure';
import type { PanePoint } from '../../render/pane-coords';
import type { VoxelProbe } from '../../render/probe';
import { modalityUnit, type Layer, type MissingSlices, type Volume } from '../../dicom/types';
import type { RawTag } from '../../dicom/metadata';

/**
 * Only warn about interpolation when the widest gap spans more than this
 * multiple of the slice spacing. A gap up to 2× spacing is a single missing
 * slice (or spacing jitter), which interpolates cleanly and isn't worth a
 * banner; wider gaps leave a visible reconstructed region.
 */
const GAP_WARNING_RATIO = 2;

/** One-line readout: orientation, voxel index, and value (plus raw if rescaled). */
export function formatProbe(
  name: string,
  probe: VoxelProbe,
  volume: Volume,
  others: ReadonlyArray<{ readonly layer: Layer; readonly sample: VoxelProbe }> = [],
): string {
  const [x, y, z] = probe.voxel;
  const unit = modalityUnit(volume.modality);
  const value = `${formatValue(probe.value)}${unit ? ` ${unit}` : ''}`;
  const trivialLut = volume.rescaleSlope === 1 && volume.rescaleIntercept === 0;
  const stored = trivialLut ? '' : ` · stored ${formatValue(probe.rawValue)}`;
  // Append each other visible layer read at the same patient point (e.g. dose Gy).
  const overlays = others
    .map(({ layer, sample }) => {
      const u = modalityUnit(layer.modality);
      return ` · ${layer.modality ?? 'Image'} ${formatValue(sample.value)}${u ? ` ${u}` : ''}`;
    })
    .join('');
  return `${name} · voxel (${x}, ${y}, ${z}) · value ${value}${stored}${overlays}`;
}

/** Join pane-local points into an SVG polyline `points` string. */
export function polylineOf(points: readonly PanePoint[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/** Midpoint of a point list's first and last points. */
export function midpoint(points: readonly PanePoint[]): PanePoint {
  const a = points[0];
  const b = points[points.length - 1];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Parse a `#rrggbb` colour-input value into [r, g, b] (0–255), or null. */
export function parseHexColor(hex: string | undefined): [number, number, number] | null {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * An ROI's effective colour as `#rrggbb` for the colour `<input>`: the user's
 * override when set, else the RTSTRUCT display colour (0–255), else a neutral grey.
 */
export function roiColorHex(
  color: readonly [number, number, number] | null,
  override?: string,
): string {
  if (override) return override;
  if (!color) return '#c8c8c8';
  return rgbToHex([color[0] / 255, color[1] / 255, color[2] / 255]);
}

/** A linear RGB triple in [0, 1] as a `#rrggbb` hex string for an `<input type=color>`. */
export function rgbToHex(color: readonly [number, number, number]): string {
  const hex = (c: number) =>
    Math.round(clamp(c, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(color[0])}${hex(color[1])}${hex(color[2])}`;
}

/** Parse a `#rrggbb` hex string back into a linear RGB triple in [0, 1]. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/**
 * Status line for an in-flight load: files parsed of the total with a percentage
 * once the count is known. Exported for unit testing the wording and rounding.
 */
export function loadingText(loaded: number, total: number): string {
  if (total <= 0) return 'Loading…';
  const percent = Math.round((loaded / total) * 100);
  return `Loading… ${loaded} / ${total} files (${percent}%)`;
}

/**
 * Narrow the raw-tag list to those matching a case-insensitive query against the
 * tag id, name, VR, or value. An empty/blank query returns the list unchanged.
 * Exported for direct unit testing of the search behaviour.
 */
export function filterRawTags(tags: readonly RawTag[], query: string): readonly RawTag[] {
  const q = query.trim().toLowerCase();
  if (!q) return tags;
  return tags.filter(
    (tag) =>
      tag.tag.toLowerCase().includes(q) ||
      (tag.name !== null && tag.name.toLowerCase().includes(q)) ||
      (tag.vr !== null && tag.vr.toLowerCase().includes(q)) ||
      tag.value.toLowerCase().includes(q),
  );
}

/**
 * The next slice index for cine playback, wrapping at the ends so the loop runs
 * continuously: stepping past the last slice returns to the first, and stepping
 * before the first returns to the last. `step` is the per-tick advance (±1) and
 * `count` the orientation's slice count. A stack of one slice (or none) has
 * nothing to cine, so the index is clamped into range and left there. Exported
 * for unit testing the advance/looping logic.
 */
export function nextCineIndex(current: number, count: number, step: number): number {
  if (count <= 1) return clamp(current, 0, Math.max(0, count - 1));
  return (((current + step) % count) + count) % count;
}

/**
 * Warning text for an interpolated volume, or null when interpolation is
 * negligible. Only gaps wider than {@link GAP_WARNING_RATIO}× the slice spacing
 * are flagged, so a single missing slice or sub-voxel jitter stays quiet.
 * Exported for direct unit testing of the threshold and wording.
 */
export function missingSliceWarning(
  missing: MissingSlices | undefined,
  spacingMm: number,
): string | null {
  if (!missing || missing.maxGapMm <= GAP_WARNING_RATIO * spacingMm) return null;
  const slices = missing.count === 1 ? 'slice' : 'slices';
  const gap = Math.round(missing.maxGapMm);
  return `${missing.count} missing ${slices} interpolated (largest gap ${gap} mm). Views crossing a gap are reconstructed, not acquired.`;
}
