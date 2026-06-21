/**
 * Transfer functions for the 3D pane's direct volume rendering (DVR).
 *
 * A transfer function maps a scalar sample value (modality units — Hounsfield
 * Units for CT) to an emitted RGB colour and an opacity, so the raycaster can
 * composite a lit, coloured volume instead of a single windowed projection. We
 * keep the function as a handful of intensity control points and bake them into
 * a small 1-D lookup table (LUT) the shader samples with hardware interpolation
 * — the GPU equivalent of {@link transferFunctionLut}.
 *
 * The presets below are CT windows (HU), the modality DVR is most useful for;
 * they are not a full editor, just sensible starting points. Each spans a finite
 * intensity {@link TransferFunction.domain}; the LUT covers exactly that range
 * and the shader clamps samples outside it to the end colours.
 */

import { clamp } from '../dicom/math';

/** The selectable DVR transfer-function presets; values double as UI codes. */
export const TransferFunctionPreset = {
  /** Dense bone: transparent below ~150 HU, opaque ivory above. */
  CtBone: 0,
  /** Soft tissue / organs around 40 HU, with translucent skin. */
  CtSoftTissue: 1,
  /** Contrast-enhanced vessels and bone for CT angiography. */
  CtAngio: 2,
  /** Low-density lung parenchyma (≈ −900…−200 HU). */
  CtLung: 3,
} as const;

export type TransferFunctionPreset =
  (typeof TransferFunctionPreset)[keyof typeof TransferFunctionPreset];

/** One stop of a transfer function: an intensity mapped to colour + opacity. */
export interface TfControlPoint {
  /** Sample intensity in modality units (HU for CT). */
  readonly intensity: number;
  /** Emitted linear RGB colour, each channel in [0, 1]. */
  readonly color: readonly [number, number, number];
  /** Opacity in [0, 1] contributed by a reference-length step at this intensity. */
  readonly opacity: number;
}

/** A named transfer function: a sorted set of control points over an intensity domain. */
export interface TransferFunction {
  readonly preset: TransferFunctionPreset;
  readonly label: string;
  /** Inclusive intensity range [lo, hi] the LUT spans; samples outside clamp to the ends. */
  readonly domain: readonly [number, number];
  /** Control points in ascending intensity; the LUT linearly interpolates between them. */
  readonly controlPoints: readonly TfControlPoint[];
}

/** Default LUT resolution: 256 RGBA texels is plenty for these smooth ramps. */
export const TF_LUT_SIZE = 256;

const PRESETS: Readonly<Record<TransferFunctionPreset, TransferFunction>> = {
  [TransferFunctionPreset.CtBone]: {
    preset: TransferFunctionPreset.CtBone,
    label: 'CT Bone',
    domain: [-1000, 2000],
    controlPoints: [
      { intensity: -1000, color: [0, 0, 0], opacity: 0 },
      { intensity: 150, color: [0.55, 0.45, 0.35], opacity: 0 },
      { intensity: 300, color: [0.85, 0.78, 0.66], opacity: 0.18 },
      { intensity: 1000, color: [1, 0.96, 0.9], opacity: 0.6 },
      { intensity: 2000, color: [1, 1, 1], opacity: 0.85 },
    ],
  },
  [TransferFunctionPreset.CtSoftTissue]: {
    preset: TransferFunctionPreset.CtSoftTissue,
    label: 'CT Soft-tissue',
    domain: [-200, 500],
    controlPoints: [
      { intensity: -200, color: [0, 0, 0], opacity: 0 },
      { intensity: -100, color: [0.4, 0.25, 0.2], opacity: 0 },
      { intensity: 20, color: [0.75, 0.45, 0.38], opacity: 0.12 },
      { intensity: 80, color: [0.9, 0.62, 0.52], opacity: 0.32 },
      { intensity: 300, color: [1, 0.92, 0.86], opacity: 0.55 },
      { intensity: 500, color: [1, 1, 1], opacity: 0.7 },
    ],
  },
  [TransferFunctionPreset.CtAngio]: {
    preset: TransferFunctionPreset.CtAngio,
    label: 'CT Angio',
    domain: [-100, 700],
    controlPoints: [
      { intensity: -100, color: [0, 0, 0], opacity: 0 },
      { intensity: 150, color: [0.6, 0.1, 0.08], opacity: 0.04 },
      { intensity: 250, color: [0.85, 0.2, 0.18], opacity: 0.4 },
      { intensity: 400, color: [1, 0.7, 0.6], opacity: 0.62 },
      { intensity: 700, color: [1, 1, 1], opacity: 0.82 },
    ],
  },
  [TransferFunctionPreset.CtLung]: {
    preset: TransferFunctionPreset.CtLung,
    label: 'CT Lung',
    domain: [-1000, -200],
    controlPoints: [
      { intensity: -1000, color: [0, 0, 0], opacity: 0 },
      { intensity: -900, color: [0.35, 0.45, 0.65], opacity: 0.06 },
      { intensity: -700, color: [0.55, 0.62, 0.78], opacity: 0.16 },
      { intensity: -500, color: [0.78, 0.8, 0.85], opacity: 0.28 },
      { intensity: -200, color: [0.95, 0.9, 0.85], opacity: 0.45 },
    ],
  },
};

/** The presets in display order, for building the UI selector. */
export const TRANSFER_FUNCTION_PRESETS: readonly TransferFunction[] = [
  PRESETS[TransferFunctionPreset.CtBone],
  PRESETS[TransferFunctionPreset.CtSoftTissue],
  PRESETS[TransferFunctionPreset.CtAngio],
  PRESETS[TransferFunctionPreset.CtLung],
];

/** The {@link TransferFunction} for a preset code. */
export function transferFunction(preset: TransferFunctionPreset): TransferFunction {
  return PRESETS[preset];
}

/**
 * Smallest intensity gap kept between an interior control point and its
 * neighbours while dragging, so the editor never lets two points cross and
 * reorder — the index of a point stays stable across an edit.
 */
const EDIT_EPSILON = 1e-3;

/**
 * Move one control point of a (preset-seeded) transfer function, returning a new
 * {@link TransferFunction} — the immutable edit the DVR editor applies live. The
 * opacity is clamped to `[0, 1]`. The two endpoints keep their intensity (so the
 * baked LUT always spans the full {@link TransferFunction.domain}); an interior
 * point's intensity is clamped to stay strictly between its neighbours, so the
 * points never reorder and `index` keeps addressing the same point. Colours are
 * untouched here — {@link setControlPointColor} edits those.
 */
export function moveControlPoint(
  tf: TransferFunction,
  index: number,
  intensity: number,
  opacity: number,
): TransferFunction {
  const points = tf.controlPoints;
  if (index < 0 || index >= points.length) return tf;
  const [lo, hi] = tf.domain;
  const a = clamp(opacity, 0, 1);
  let x = points[index].intensity;
  if (index > 0 && index < points.length - 1) {
    const left = points[index - 1].intensity + EDIT_EPSILON;
    const right = points[index + 1].intensity - EDIT_EPSILON;
    x = clamp(intensity, Math.min(left, right), Math.max(left, right));
  }
  x = clamp(x, lo, hi);
  const next = points.map((p, i) =>
    i === index ? { intensity: x, color: p.color, opacity: a } : p,
  );
  return { ...tf, controlPoints: next };
}

/** Recolour one control point (channels clamped to `[0, 1]`), returning a new TF. */
export function setControlPointColor(
  tf: TransferFunction,
  index: number,
  color: readonly [number, number, number],
): TransferFunction {
  const points = tf.controlPoints;
  if (index < 0 || index >= points.length) return tf;
  const c: [number, number, number] = [
    clamp(color[0], 0, 1),
    clamp(color[1], 0, 1),
    clamp(color[2], 0, 1),
  ];
  const next = points.map((p, i) => (i === index ? { ...p, color: c } : p));
  return { ...tf, controlPoints: next };
}

/**
 * Insert a control point at `intensity` (clamped to the domain) with the given
 * opacity, taking its colour from the curve at that intensity so the inserted
 * stop sits on the existing colour ramp. The result stays sorted by intensity.
 */
export function addControlPoint(
  tf: TransferFunction,
  intensity: number,
  opacity: number,
): TransferFunction {
  const [lo, hi] = tf.domain;
  const x = clamp(intensity, lo, hi);
  const [r, g, b] = sampleTransferFunction(tf, x);
  const point: TfControlPoint = { intensity: x, color: [r, g, b], opacity: clamp(opacity, 0, 1) };
  const next = [...tf.controlPoints, point].sort((p, q) => p.intensity - q.intensity);
  return { ...tf, controlPoints: next };
}

/**
 * Remove the control point at `index`, returning a new TF. A no-op when it would
 * drop below two points (a curve needs at least its two endpoints) or the index
 * is out of range.
 */
export function removeControlPoint(tf: TransferFunction, index: number): TransferFunction {
  const points = tf.controlPoints;
  if (points.length <= 2 || index < 0 || index >= points.length) return tf;
  return { ...tf, controlPoints: points.filter((_, i) => i !== index) };
}

/**
 * Sample a transfer function's control points at one intensity, returning the
 * piecewise-linearly interpolated `[r, g, b, a]`. Intensities below the first
 * control point clamp to it and those above the last clamp to it, so the curve
 * is defined for every input. Pure and exported so the LUT bake — and the shader
 * it mirrors — can be unit-tested against the control points directly.
 */
export function sampleTransferFunction(
  tf: TransferFunction,
  intensity: number,
): [number, number, number, number] {
  const points = tf.controlPoints;
  const first = points[0];
  if (intensity <= first.intensity) {
    return [first.color[0], first.color[1], first.color[2], first.opacity];
  }
  const last = points[points.length - 1];
  if (intensity >= last.intensity) {
    return [last.color[0], last.color[1], last.color[2], last.opacity];
  }
  for (let i = 1; i < points.length; i++) {
    const hi = points[i];
    if (intensity <= hi.intensity) {
      const lo = points[i - 1];
      const span = hi.intensity - lo.intensity;
      const f = span > 0 ? (intensity - lo.intensity) / span : 0;
      return [
        lerp(lo.color[0], hi.color[0], f),
        lerp(lo.color[1], hi.color[1], f),
        lerp(lo.color[2], hi.color[2], f),
        lerp(lo.opacity, hi.opacity, f),
      ];
    }
  }
  // Unreachable: the clamps above cover everything beyond the last point.
  return [last.color[0], last.color[1], last.color[2], last.opacity];
}

/**
 * Bake a transfer function into a flat RGBA LUT of `size` texels, evenly spaced
 * across its {@link TransferFunction.domain}. Texel `i` holds the colour/opacity
 * at intensity `lerp(domain.lo, domain.hi, i / (size − 1))`, so texel 0 is the
 * domain's low end and the last texel its high end. The renderer uploads this to
 * a 1-D texture the DVR shader samples with the same `[0, 1]` domain coordinate.
 */
export function transferFunctionLut(
  tf: TransferFunction,
  size: number = TF_LUT_SIZE,
): Float32Array {
  const n = Math.max(2, Math.floor(size));
  const [lo, hi] = tf.domain;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const intensity = lerp(lo, hi, i / (n - 1));
    const [r, g, b, a] = sampleTransferFunction(tf, intensity);
    out[i * 4 + 0] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}
