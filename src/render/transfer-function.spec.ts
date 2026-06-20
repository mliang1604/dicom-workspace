import {
  addControlPoint,
  moveControlPoint,
  removeControlPoint,
  sampleTransferFunction,
  setControlPointColor,
  TF_LUT_SIZE,
  TransferFunctionPreset,
  transferFunction,
  transferFunctionLut,
  TRANSFER_FUNCTION_PRESETS,
} from './transfer-function';

/** Compare a baked (Float32) RGBA texel against the float64 reference, per channel. */
function expectRgba(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i], 5);
}

describe('transfer-function presets', () => {
  it('offers the four CT presets in display order', () => {
    expect(TRANSFER_FUNCTION_PRESETS.map((tf) => tf.label)).toEqual([
      'CT Bone',
      'CT Soft-tissue',
      'CT Angio',
      'CT Lung',
    ]);
    expect(TRANSFER_FUNCTION_PRESETS.map((tf) => tf.preset)).toEqual([
      TransferFunctionPreset.CtBone,
      TransferFunctionPreset.CtSoftTissue,
      TransferFunctionPreset.CtAngio,
      TransferFunctionPreset.CtLung,
    ]);
  });

  it('resolves each preset code to its table', () => {
    for (const tf of TRANSFER_FUNCTION_PRESETS) {
      expect(transferFunction(tf.preset)).toBe(tf);
    }
  });

  it('keeps every control point sorted, in-domain, and within [0, 1]', () => {
    for (const tf of TRANSFER_FUNCTION_PRESETS) {
      const [lo, hi] = tf.domain;
      expect(hi).toBeGreaterThan(lo);
      let previous = -Infinity;
      for (const point of tf.controlPoints) {
        expect(point.intensity).toBeGreaterThan(previous);
        previous = point.intensity;
        expect(point.intensity).toBeGreaterThanOrEqual(lo);
        expect(point.intensity).toBeLessThanOrEqual(hi);
        expect(point.opacity).toBeGreaterThanOrEqual(0);
        expect(point.opacity).toBeLessThanOrEqual(1);
        for (const channel of point.color) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('starts every preset fully transparent so air contributes nothing', () => {
    for (const tf of TRANSFER_FUNCTION_PRESETS) {
      expect(tf.controlPoints[0].opacity).toBe(0);
    }
  });
});

describe('sampleTransferFunction', () => {
  const bone = transferFunction(TransferFunctionPreset.CtBone);

  it('clamps to the first control point below the domain', () => {
    const first = bone.controlPoints[0];
    expect(sampleTransferFunction(bone, -5000)).toEqual([...first.color, first.opacity]);
  });

  it('clamps to the last control point above the domain', () => {
    const last = bone.controlPoints[bone.controlPoints.length - 1];
    expect(sampleTransferFunction(bone, 99999)).toEqual([...last.color, last.opacity]);
  });

  it('reproduces a control point exactly at its intensity', () => {
    // CT Bone has a stop at 1000 HU with opacity 0.6.
    expect(sampleTransferFunction(bone, 1000)[3]).toBeCloseTo(0.6, 6);
  });

  it('interpolates opacity linearly between two control points', () => {
    // Between 300 HU (a = 0.18) and 1000 HU (a = 0.6); the midpoint 650 HU is the mean.
    const a = sampleTransferFunction(bone, 650)[3];
    expect(a).toBeCloseTo((0.18 + 0.6) / 2, 5);
  });

  it('rises monotonically in opacity as intensity climbs through a ramp', () => {
    let previous = -1;
    for (let hu = -1000; hu <= 2000; hu += 100) {
      const a = sampleTransferFunction(bone, hu)[3];
      expect(a).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = a;
    }
  });
});

describe('transferFunctionLut', () => {
  it('bakes RGBA texels spanning the domain end to end', () => {
    const bone = transferFunction(TransferFunctionPreset.CtBone);
    const lut = transferFunctionLut(bone, TF_LUT_SIZE);

    expect(lut.length).toBe(TF_LUT_SIZE * 4);
    // Texel 0 is the domain low end, the last texel its high end (Float32, so close).
    expectRgba(lut.subarray(0, 4), sampleTransferFunction(bone, bone.domain[0]));
    expectRgba(lut.subarray((TF_LUT_SIZE - 1) * 4), sampleTransferFunction(bone, bone.domain[1]));
  });

  it('keeps the opacity channel non-decreasing for a monotonic preset', () => {
    const bone = transferFunction(TransferFunctionPreset.CtBone);
    const lut = transferFunctionLut(bone, 64);
    let previous = -1;
    for (let i = 0; i < 64; i++) {
      const a = lut[i * 4 + 3];
      expect(a).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = a;
    }
  });

  it('matches the control-point sampler at an interior texel', () => {
    const angio = transferFunction(TransferFunctionPreset.CtAngio);
    const size = 16;
    const lut = transferFunctionLut(angio, size);
    const i = 7;
    const [lo, hi] = angio.domain;
    const intensity = lo + ((hi - lo) * i) / (size - 1);
    expectRgba(lut.subarray(i * 4, i * 4 + 4), sampleTransferFunction(angio, intensity));
  });

  it('clamps a tiny size up to a usable two-texel LUT', () => {
    const lut = transferFunctionLut(transferFunction(TransferFunctionPreset.CtLung), 1);
    expect(lut.length).toBe(2 * 4);
  });
});

describe('moveControlPoint', () => {
  const bone = transferFunction(TransferFunctionPreset.CtBone);

  it('returns a new TF without mutating the original', () => {
    const edited = moveControlPoint(bone, 2, bone.controlPoints[2].intensity, 0.9);
    expect(edited).not.toBe(bone);
    expect(edited.controlPoints[2].opacity).toBeCloseTo(0.9, 6);
    expect(bone.controlPoints[2].opacity).toBe(0.18); // original untouched
  });

  it('clamps opacity into [0, 1]', () => {
    expect(moveControlPoint(bone, 2, 0, 5).controlPoints[2].opacity).toBe(1);
    expect(moveControlPoint(bone, 2, 0, -5).controlPoints[2].opacity).toBe(0);
  });

  it('pins the endpoints in intensity while still moving their opacity', () => {
    const last = bone.controlPoints.length - 1;
    const movedFirst = moveControlPoint(bone, 0, 9999, 0.5);
    expect(movedFirst.controlPoints[0].intensity).toBe(bone.controlPoints[0].intensity);
    expect(movedFirst.controlPoints[0].opacity).toBe(0.5);
    const movedLast = moveControlPoint(bone, last, -9999, 0.3);
    expect(movedLast.controlPoints[last].intensity).toBe(bone.controlPoints[last].intensity);
  });

  it('keeps an interior point strictly between its neighbours (no reorder)', () => {
    // Point 2 sits at 300 HU between 150 (point 1) and 1000 (point 3); shoving it
    // past 1000 clamps it just below the next point, preserving ascending order.
    const edited = moveControlPoint(bone, 2, 5000, 0.4);
    const xs = edited.controlPoints.map((p) => p.intensity);
    expect(xs[2]).toBeLessThan(xs[3]);
    expect(xs[2]).toBeGreaterThan(xs[1]);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });

  it('is a no-op for an out-of-range index', () => {
    expect(moveControlPoint(bone, 99, 0, 1)).toBe(bone);
  });

  it('re-bakes a higher opacity into the LUT (the live-edit path)', () => {
    const edited = moveControlPoint(bone, 2, bone.controlPoints[2].intensity, 0.95);
    const at = bone.controlPoints[2].intensity;
    expect(sampleTransferFunction(edited, at)[3]).toBeCloseTo(0.95, 6);
    expect(sampleTransferFunction(bone, at)[3]).toBeCloseTo(0.18, 6);
  });
});

describe('setControlPointColor', () => {
  const bone = transferFunction(TransferFunctionPreset.CtBone);

  it('replaces a point colour, clamped per channel, leaving opacity/intensity', () => {
    const edited = setControlPointColor(bone, 3, [2, -1, 0.5]);
    expect(edited.controlPoints[3].color).toEqual([1, 0, 0.5]);
    expect(edited.controlPoints[3].intensity).toBe(bone.controlPoints[3].intensity);
    expect(edited.controlPoints[3].opacity).toBe(bone.controlPoints[3].opacity);
  });
});

describe('addControlPoint', () => {
  const bone = transferFunction(TransferFunctionPreset.CtBone);

  it('inserts a sorted stop whose colour sits on the existing ramp', () => {
    const at = 650; // between the 300 and 1000 HU stops
    const expectedColor = sampleTransferFunction(bone, at).slice(0, 3);
    const edited = addControlPoint(bone, at, 0.5);
    expect(edited.controlPoints.length).toBe(bone.controlPoints.length + 1);
    const xs = edited.controlPoints.map((p) => p.intensity);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    const inserted = edited.controlPoints.find((p) => p.intensity === at)!;
    expect(inserted.opacity).toBe(0.5);
    expect([...inserted.color]).toEqual(expectedColor);
  });

  it('clamps the inserted intensity into the domain', () => {
    const edited = addControlPoint(bone, 9999, 1);
    const xs = edited.controlPoints.map((p) => p.intensity);
    expect(Math.max(...xs)).toBeLessThanOrEqual(bone.domain[1]);
  });
});

describe('removeControlPoint', () => {
  const bone = transferFunction(TransferFunctionPreset.CtBone);

  it('drops the indexed point', () => {
    const edited = removeControlPoint(bone, 2);
    expect(edited.controlPoints.length).toBe(bone.controlPoints.length - 1);
    expect(edited.controlPoints.map((p) => p.intensity)).not.toContain(
      bone.controlPoints[2].intensity,
    );
  });

  it('refuses to drop below two points', () => {
    const two = { ...bone, controlPoints: bone.controlPoints.slice(0, 2) };
    expect(removeControlPoint(two, 0)).toBe(two);
  });
});
