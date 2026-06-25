import { rangeFillPercent } from './range-fill';

describe('rangeFillPercent', () => {
  it('maps the value to its position within the range', () => {
    expect(rangeFillPercent(0, 100, 50)).toBe(50);
    expect(rangeFillPercent(2, 30, 16)).toBe(50); // checkerboard slider midpoint
    expect(rangeFillPercent(0, 2, 0.5)).toBe(25);
  });

  it('is 0 at the minimum and 100 at the maximum (knob hard left / right)', () => {
    expect(rangeFillPercent(16, 96, 16)).toBe(0);
    expect(rangeFillPercent(16, 96, 96)).toBe(100);
    expect(rangeFillPercent(-180, 180, 0)).toBe(50); // signed range
  });

  it('clamps out-of-range values', () => {
    expect(rangeFillPercent(0, 100, -10)).toBe(0);
    expect(rangeFillPercent(0, 100, 250)).toBe(100);
  });

  it('returns 0 for a degenerate (non-positive) span instead of NaN', () => {
    expect(rangeFillPercent(5, 5, 5)).toBe(0);
    expect(rangeFillPercent(10, 0, 5)).toBe(0);
  });
});
