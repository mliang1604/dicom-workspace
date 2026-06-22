import { invert, multiply, transformPoint, transformVector } from './mat4';
import { IDENTITY_MAT4, type Mat4 } from './types';

/** A rigid transform: rotate 90° about +z (x→y, y→−x) then translate by (5,6,7). */
const ROT_Z_90_THEN_T: Mat4 = [0, -1, 0, 5, 1, 0, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1];

describe('transformPoint', () => {
  it('applies the linear part and the translation', () => {
    expect(transformPoint(ROT_Z_90_THEN_T, [1, 0, 0])).toEqual([5, 7, 7]);
    expect(transformPoint(ROT_Z_90_THEN_T, [0, 1, 0])).toEqual([4, 6, 7]);
  });

  it('is the identity for the identity matrix', () => {
    expect(transformPoint(IDENTITY_MAT4, [2, 3, 4])).toEqual([2, 3, 4]);
  });
});

describe('transformVector', () => {
  it('applies the linear part only (no translation)', () => {
    expect(transformVector(ROT_Z_90_THEN_T, [1, 0, 0])).toEqual([0, 1, 0]);
    expect(transformVector(ROT_Z_90_THEN_T, [0, 1, 0])).toEqual([-1, 0, 0]);
  });
});

describe('multiply', () => {
  it('composes transforms: multiply(a,b) applies b then a', () => {
    const composed = multiply(ROT_Z_90_THEN_T, ROT_Z_90_THEN_T);
    const point: [number, number, number] = [1, 2, 3];
    const viaComposed = transformPoint(composed, point);
    const viaSequence = transformPoint(ROT_Z_90_THEN_T, transformPoint(ROT_Z_90_THEN_T, point));
    viaComposed.forEach((v, i) => expect(v).toBeCloseTo(viaSequence[i], 10));
  });

  it('is identity-neutral', () => {
    expect(multiply(ROT_Z_90_THEN_T, IDENTITY_MAT4)).toEqual(ROT_Z_90_THEN_T as number[]);
  });
});

describe('invert', () => {
  it('round-trips a point through a transform and its inverse', () => {
    const inv = invert(ROT_Z_90_THEN_T)!;
    expect(inv).not.toBeNull();
    const point: [number, number, number] = [3, -2, 11];
    const back = transformPoint(inv, transformPoint(ROT_Z_90_THEN_T, point));
    back.forEach((v, i) => expect(v).toBeCloseTo(point[i], 10));
  });

  it('inverts a pure scale', () => {
    const scale: Mat4 = [2, 0, 0, 0, 0, 4, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1];
    const inv = invert(scale)!;
    expect(transformPoint(inv, [2, 4, 5])).toEqual([1, 1, 1]);
  });

  it('returns null for a singular linear part', () => {
    const singular: Mat4 = [1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 1];
    expect(invert(singular)).toBeNull();
  });
});
