/**
 * Named colour ramps for fusion overlays. A grayscale base layer is windowed to a
 * gray value; a colormap overlay (e.g. an RTDOSE wash) maps its windowed value
 * through one of these ramps to an RGB colour, which the slice shader composites
 * over the base. Each ramp is baked into a small RGBA LUT the GPU samples — the
 * same idea as the DVR transfer function ({@link import('./transfer-function')}),
 * but a pure colour ramp (opacity is the per-layer composite, not in the LUT).
 */

/** Resolution of a baked colormap LUT, in texels — matches the DVR LUT size. */
export const COLORMAP_LUT_SIZE = 256;

/** One colour stop of a {@link Colormap}: a position in [0, 1] and its RGB colour. */
export interface ColorStop {
  readonly pos: number;
  readonly color: readonly [number, number, number];
}

/** A named colour ramp: stops in ascending position, linearly interpolated. */
export interface Colormap {
  readonly name: string;
  readonly stops: readonly ColorStop[];
}

/**
 * The selectable overlay colormaps, keyed by name (the {@link Colormap.name} a
 * `Layer.display` of kind `'colormap'` references). `hot` (black→red→yellow→white)
 * and `jet` (blue→cyan→green→yellow→red) are the usual dose/PET washes.
 */
export const COLORMAPS: Record<string, Colormap> = {
  hot: {
    name: 'hot',
    stops: [
      { pos: 0, color: [0, 0, 0] },
      { pos: 0.4, color: [1, 0, 0] },
      { pos: 0.75, color: [1, 1, 0] },
      { pos: 1, color: [1, 1, 1] },
    ],
  },
  jet: {
    name: 'jet',
    stops: [
      { pos: 0, color: [0, 0, 0.5] },
      { pos: 0.125, color: [0, 0, 1] },
      { pos: 0.375, color: [0, 1, 1] },
      { pos: 0.625, color: [1, 1, 0] },
      { pos: 0.875, color: [1, 0, 0] },
      { pos: 1, color: [0.5, 0, 0] },
    ],
  },
};

/** The default overlay colormap (a dose/PET wash) when none is otherwise chosen. */
export const DEFAULT_COLORMAP = 'jet';

/**
 * Fraction of the value range over which a colormap's alpha ramps from 0 to 1.
 * Below it the wash fades out, so background / low-dose voxels are transparent and
 * the base shows through; above it the overlay is fully opaque (at the composite
 * opacity). Makes a dose wash read as an isodose overlay, not a full-frame tint.
 */
export const COLORMAP_ALPHA_RAMP = 0.15;

/** Resolve a colormap by name, falling back to {@link DEFAULT_COLORMAP}. */
export function colormap(name: string): Colormap {
  return COLORMAPS[name] ?? COLORMAPS[DEFAULT_COLORMAP];
}

/** Colour at position `t` (clamped to [0, 1]) along a colormap's stops. */
export function sampleColormap(map: Colormap, t: number): [number, number, number] {
  const stops = map.stops;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  if (clamped <= stops[0].pos) return [...stops[0].color];
  const last = stops[stops.length - 1];
  if (clamped >= last.pos) return [...last.color];
  for (let i = 1; i < stops.length; i++) {
    const hi = stops[i];
    if (clamped <= hi.pos) {
      const lo = stops[i - 1];
      const span = hi.pos - lo.pos;
      const f = span > 0 ? (clamped - lo.pos) / span : 0;
      return [
        lo.color[0] + (hi.color[0] - lo.color[0]) * f,
        lo.color[1] + (hi.color[1] - lo.color[1]) * f,
        lo.color[2] + (hi.color[2] - lo.color[2]) * f,
      ];
    }
  }
  return [...last.color];
}

/**
 * Bake a colormap into a flat RGBA LUT of `size` texels, evenly spaced across
 * [0, 1]. Alpha ramps from 0 at the low end up to 1 over {@link COLORMAP_ALPHA_RAMP}
 * of the range, so low/background values are transparent (the base shows through)
 * and only meaningful signal washes in; the slice shader multiplies the overlay
 * contribution by this alpha. The per-layer composite opacity is applied on top.
 */
export function colormapLut(map: Colormap, size: number = COLORMAP_LUT_SIZE): Float32Array {
  const n = Math.max(2, Math.floor(size));
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const [r, g, b] = sampleColormap(map, t);
    out[i * 4 + 0] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = Math.min(1, t / COLORMAP_ALPHA_RAMP);
  }
  return out;
}
