import { describe, expect, it } from 'vitest';

import { clamp, clamp01, clampIndex } from './math';

describe('clamp', () => {
  it('passes values inside the range through unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to the bounds', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it('supports symmetric ranges', () => {
    expect(clamp(-7, -5, 5)).toBe(-5);
    expect(clamp(7, -5, 5)).toBe(5);
  });
});

describe('clamp01', () => {
  it('clamps to the unit range', () => {
    expect(clamp01(0.3)).toBe(0.3);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });
});

describe('clampIndex', () => {
  it('clamps to a valid voxel slot', () => {
    expect(clampIndex(3, 10)).toBe(3);
    expect(clampIndex(-1, 10)).toBe(0);
    expect(clampIndex(20, 10)).toBe(9);
  });
});
