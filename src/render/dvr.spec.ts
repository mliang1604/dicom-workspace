import type { Vec3 } from '../dicom/types';
import {
  centralDifference,
  compositeOver,
  DEFAULT_DVR_LIGHTING,
  DVR_AMBIENT,
  dvrLightingParams,
  lambertShade,
  lightToPatient,
  lightViewDirection,
  opacityCorrection,
  surfaceNormal,
} from './dvr';

describe('opacityCorrection', () => {
  it('returns the reference opacity unchanged at the reference step', () => {
    expect(opacityCorrection(0.4, 1)).toBeCloseTo(0.4, 6);
    expect(opacityCorrection(0.4, 2, 2)).toBeCloseTo(0.4, 6);
  });

  it('accumulates more opacity over a longer step', () => {
    // Two reference steps of 0.4 compound as 1 − (1 − 0.4)² = 0.64.
    expect(opacityCorrection(0.4, 2)).toBeCloseTo(0.64, 6);
  });

  it('thins out opacity over a shorter step', () => {
    // Half a reference step: 1 − sqrt(1 − 0.4) ≈ 0.2254.
    expect(opacityCorrection(0.4, 0.5)).toBeCloseTo(1 - Math.sqrt(0.6), 6);
  });

  it('keeps the transparent and opaque extremes fixed at any step', () => {
    expect(opacityCorrection(0, 3)).toBe(0);
    expect(opacityCorrection(1, 0.25)).toBe(1);
  });

  it('clamps a non-positive step to fully transparent', () => {
    expect(opacityCorrection(0.5, 0)).toBe(0);
  });
});

describe('compositeOver', () => {
  it('paints an opaque sample straight onto an empty accumulator', () => {
    expect(compositeOver([0, 0, 0, 0], [0.2, 0.4, 0.6], 1)).toEqual([0.2, 0.4, 0.6, 1]);
  });

  it('weights a later sample by the remaining transparency (front-to-back)', () => {
    // First a 0.5-opaque red, then a fully opaque green: the green only fills the
    // remaining 0.5, so it contributes half its colour.
    let c = compositeOver([0, 0, 0, 0], [1, 0, 0], 0.5);
    c = compositeOver(c, [0, 1, 0], 1);
    expect(c[0]).toBeCloseTo(0.5, 6); // red from the first sample
    expect(c[1]).toBeCloseTo(0.5, 6); // green into the remaining half
    expect(c[3]).toBeCloseTo(1, 6);
  });

  it('never lets the accumulated alpha exceed one', () => {
    let c: [number, number, number, number] = [0, 0, 0, 0];
    for (let i = 0; i < 20; i++) c = compositeOver(c, [1, 1, 1], 0.5);
    expect(c[3]).toBeLessThanOrEqual(1 + 1e-9);
    expect(c[3]).toBeGreaterThan(0.99);
  });
});

describe('surfaceNormal', () => {
  it('points down-gradient (toward lower intensity) and is unit length', () => {
    const n = surfaceNormal([2, 0, 0]);
    expect(n[0]).toBe(-1);
    expect(n[1]).toBeCloseTo(0, 12);
    expect(n[2]).toBeCloseTo(0, 12);
  });

  it('returns the zero vector in a flat region so the caller leaves it unshaded', () => {
    expect(surfaceNormal([0, 0, 0])).toEqual([0, 0, 0]);
    expect(surfaceNormal([1e-9, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('lambertShade', () => {
  it('fully lights a surface facing the light', () => {
    // Normal toward −x, light toward −x: head-on, so the full diffuse term.
    expect(lambertShade([-1, 0, 0], [-1, 0, 0])).toBeCloseTo(1, 6);
  });

  it('drops to the ambient floor for a surface facing away from the light', () => {
    expect(lambertShade([1, 0, 0], [-1, 0, 0])).toBeCloseTo(DVR_AMBIENT, 6);
  });

  it('lands between ambient and full at a glancing angle', () => {
    // 45°: ambient + (1 − ambient)·cos45.
    const expected = DVR_AMBIENT + (1 - DVR_AMBIENT) * Math.SQRT1_2;
    expect(lambertShade([-1, -1, 0], [-1, 0, 0])).toBeCloseTo(expected, 6);
  });

  it('renders a flat (zero-normal) region unshaded at full brightness', () => {
    expect(lambertShade([0, 0, 0], [-1, 0, 0])).toBe(1);
  });
});

describe('centralDifference', () => {
  it('recovers the gradient of a known linear field', () => {
    // f(x, y, z) = 3x − 2y + z has constant gradient (3, −2, 1).
    const field = (p: Vec3): number => 3 * p[0] - 2 * p[1] + p[2];
    const grad = centralDifference(field, [1, 1, 1], [0.5, 0.5, 0.5]);
    expect(grad[0]).toBeCloseTo(3, 6);
    expect(grad[1]).toBeCloseTo(-2, 6);
    expect(grad[2]).toBeCloseTo(1, 6);
  });

  it('skips an axis with a zero offset rather than dividing by zero', () => {
    const field = (p: Vec3): number => p[0] + p[1] + p[2];
    const grad = centralDifference(field, [0, 0, 0], [1, 0, 1]);
    expect(grad[1]).toBe(0); // no offset along y → left at zero
    expect(grad[0]).toBeCloseTo(1, 6);
    expect(grad[2]).toBeCloseTo(1, 6);
  });
});

describe('lightViewDirection', () => {
  it('points straight at the camera (the headlight) with no offset', () => {
    expect(lightViewDirection({ azimuth: 0, elevation: 0 })).toEqual([0, 0, 1]);
  });

  it('swings onto the view-right axis at 90° azimuth', () => {
    const d = lightViewDirection({ azimuth: 90, elevation: 0 });
    expect(d[0]).toBeCloseTo(1, 6);
    expect(d[1]).toBeCloseTo(0, 6);
    expect(d[2]).toBeCloseTo(0, 6);
  });

  it('tilts onto the view-up axis at 90° elevation', () => {
    const d = lightViewDirection({ azimuth: 0, elevation: 90 });
    expect(d[0]).toBeCloseTo(0, 6);
    expect(d[1]).toBeCloseTo(1, 6);
    expect(d[2]).toBeCloseTo(0, 6);
  });

  it('always returns a unit vector', () => {
    const d = lightViewDirection({ azimuth: 37, elevation: -52 });
    expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 6);
  });
});

describe('lightToPatient', () => {
  const u: Vec3 = [1, 0, 0];
  const v: Vec3 = [0, 1, 0];
  const forward: Vec3 = [0, 0, 1]; // into the scene → headlight comes back as -forward

  it('maps the headlight to the opposite of the forward direction', () => {
    expect(lightToPatient([0, 0, 1], u, v, forward)).toEqual([0, 0, -1]);
  });

  it('maps the view-right component onto the right axis', () => {
    const p = lightToPatient([1, 0, 0], u, v, forward);
    expect(p[0]).toBeCloseTo(1, 6);
    expect(p[1]).toBeCloseTo(0, 6);
    expect(p[2]).toBeCloseTo(0, 6);
  });

  it('returns a unit vector for a mixed direction', () => {
    const p = lightToPatient(lightViewDirection({ azimuth: 45, elevation: 20 }), u, v, forward);
    expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(1, 6);
  });
});

describe('dvrLightingParams', () => {
  it('packs the light direction + enabled flag, then the material weights', () => {
    const out = dvrLightingParams([0.1, 0.2, 0.3], {
      enabled: true,
      azimuth: 0,
      elevation: 0,
      ambient: 0.3,
      diffuse: 0.7,
      specular: 0.5,
      shininess: 32,
    });
    const expected = [0.1, 0.2, 0.3, 1, 0.3, 0.7, 0.5, 32];
    expect(out.length).toBe(expected.length);
    expected.forEach((v, i) => expect(out[i]).toBeCloseTo(v, 6));
  });

  it('flags shading off as a zero in the .w slot', () => {
    const out = dvrLightingParams([0, 0, 1], { ...DEFAULT_DVR_LIGHTING, enabled: false });
    expect(out[3]).toBe(0);
  });

  it('clamps the material weights to their valid ranges', () => {
    const out = dvrLightingParams([0, 0, 1], {
      enabled: true,
      azimuth: 0,
      elevation: 0,
      ambient: 2, // → clamped to 1
      diffuse: -1, // → clamped to 0
      specular: -3, // → clamped to 0
      shininess: 0, // → clamped up to 1
    });
    expect(out[4]).toBe(1);
    expect(out[5]).toBe(0);
    expect(out[6]).toBe(0);
    expect(out[7]).toBe(1);
  });

  it('defaults to the legacy headlight ambient/diffuse split with no specular', () => {
    expect(DEFAULT_DVR_LIGHTING.ambient).toBe(DVR_AMBIENT);
    expect(DEFAULT_DVR_LIGHTING.diffuse).toBeCloseTo(1 - DVR_AMBIENT, 6);
    expect(DEFAULT_DVR_LIGHTING.specular).toBe(0);
    expect(DEFAULT_DVR_LIGHTING.enabled).toBe(true);
  });
});
