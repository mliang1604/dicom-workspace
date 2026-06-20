import type { Volume } from '../dicom/types';

/** A display window: the centre (level) and the width of the intensity ramp. */
export interface WindowLevel {
  readonly center: number;
  readonly width: number;
}

/** A named window/level preset offered in the toolbar. */
export interface WindowPreset extends WindowLevel {
  readonly label: string;
}

/**
 * Standard CT display windows, in Hounsfield units (centre / width). These are
 * the conventional radiology values; applied verbatim when the series is CT.
 */
export const CT_WINDOW_PRESETS: readonly WindowPreset[] = [
  { label: 'Soft tissue', center: 40, width: 400 },
  { label: 'Lung', center: -600, width: 1500 },
  { label: 'Bone', center: 300, width: 1500 },
  { label: 'Brain', center: 40, width: 80 },
] as const;

/**
 * The "Full range" preset: a window spanning the volume's whole value range, so
 * every voxel maps somewhere onto the ramp. Width is kept ≥ 1 for flat volumes.
 */
export function fullRangePreset(volume: Volume): WindowPreset {
  const center = Math.round((volume.min + volume.max) / 2);
  const width = Math.max(1, Math.round(volume.max - volume.min));
  return { label: 'Full range', center, width };
}

/** The preset carrying the window the file itself suggested (the load default). */
export function fileDefaultPreset(volume: Volume): WindowPreset {
  return {
    label: 'File default',
    center: Math.round(volume.windowCenter),
    width: Math.max(1, Math.round(volume.windowWidth)),
  };
}

/**
 * The presets to offer for a volume. CT series get the standard radiology
 * windows plus Full range; other modalities (no standard scalar window) get the
 * file's own default plus Full range.
 */
export function windowPresets(volume: Volume): WindowPreset[] {
  if (volume.modality === 'CT') {
    return [...CT_WINDOW_PRESETS, fullRangePreset(volume)];
  }
  return [fileDefaultPreset(volume), fullRangePreset(volume)];
}

/**
 * Value-units a click-drag moves the window per pixel, scaled to the volume's
 * range so a CT (thousands of HU) and an MR (small intensities) both feel
 * responsive over the same drag distance. Kept ≥ 1 so a flat volume still moves.
 */
export function windowLevelSensitivity(min: number, max: number): number {
  return Math.max(1, (max - min) / 512);
}

/**
 * Map a raw sample to a 0..1 gray level through the DICOM linear window (PS3.3
 * C.11.2.1.2), the CPU mirror of the windowing WGSL in `slice-shader.ts` and
 * `raycast-shader.ts`, exposed so the math can be unit-tested. `width` is floored
 * at 1 so a degenerate window doesn't divide by zero.
 */
export function windowGray(raw: number, center: number, width: number): number {
  const lo = center - 0.5 - (width - 1) * 0.5;
  const g = (raw - lo) / Math.max(width - 1, 1);
  return g < 0 ? 0 : g > 1 ? 1 : g;
}

/**
 * Invert a 0..1 gray level for the optional display-inversion toggle (white ⇄
 * black). Independent of the MONOCHROME1 sense, which is baked into the volume at
 * load; this is a user-facing flip applied after windowing, matching the shaders'
 * `select(g, 1 - g, invert)`. Involutive: inverting twice is the identity.
 */
export function invertGray(g: number): number {
  return 1 - g;
}

/**
 * Map a click-drag from a starting window to a new one: horizontal movement
 * shifts the centre (drag right raises it), vertical movement changes the width
 * (drag up widens, drag down narrows — screen-y grows downward, hence `-dy`).
 * `dx`/`dy` are the total pixels moved since the drag began; `sensitivity` is
 * value-units per pixel (see {@link windowLevelSensitivity}). Width stays ≥ 1.
 */
export function windowLevelDrag(
  start: WindowLevel,
  dx: number,
  dy: number,
  sensitivity: number,
): WindowLevel {
  return {
    center: Math.round(start.center + dx * sensitivity),
    width: Math.max(1, Math.round(start.width - dy * sensitivity)),
  };
}
