import { resolveAlignment } from './align';
import { invert } from './mat4';
import { IDENTITY_MAT4, type DeformationGrid, type Mat4, type Registration } from './types';

/** Translate by (10, 20, 30) — an easy transform to verify by inspection. */
const TRANSLATE: Mat4 = [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1];

function rigid(sourceFrame: string, targetFrame: string, matrix: Mat4): Registration {
  return { kind: 'rigid', name: 'reg', sourceFrame, targetFrame, matrix, matrixType: 'RIGID' };
}

function deformable(sourceFrame: string, targetFrame: string): Registration {
  const grid: DeformationGrid = {
    origin: [0, 0, 0],
    orientation: [1, 0, 0, 0, 1, 0],
    dims: [1, 1, 1],
    spacing: [1, 1, 1],
    vectors: new Float32Array([0, 0, 0]),
  };
  return {
    kind: 'deformable',
    name: 'reg',
    sourceFrame,
    targetFrame,
    preMatrix: IDENTITY_MAT4,
    postMatrix: IDENTITY_MAT4,
    grid,
  };
}

describe('resolveAlignment', () => {
  it('returns the shared identity constant when frames match directly', () => {
    expect(resolveAlignment('F', 'F', [])).toBe(IDENTITY_MAT4);
  });

  it('returns null when frames differ and no registration links them', () => {
    expect(resolveAlignment('BASE', 'OVERLAY', [])).toBeNull();
    expect(resolveAlignment('BASE', 'OVERLAY', [rigid('X', 'Y', TRANSLATE)])).toBeNull();
  });

  it('never matches a null frame, even against another null', () => {
    expect(resolveAlignment(null, null, [])).toBeNull();
    expect(resolveAlignment(null, 'OVERLAY', [])).toBeNull();
  });

  it('uses the matrix directly when the base is the registration source', () => {
    // matrix maps source(BASE) → target(OVERLAY), which is exactly base → overlay.
    expect(resolveAlignment('BASE', 'OVERLAY', [rigid('BASE', 'OVERLAY', TRANSLATE)])).toEqual(
      TRANSLATE,
    );
  });

  it('inverts the matrix when the base is the registration target', () => {
    // matrix maps source(OVERLAY) → target(BASE); base → overlay is its inverse.
    const result = resolveAlignment('BASE', 'OVERLAY', [rigid('OVERLAY', 'BASE', TRANSLATE)]);
    expect(result).toEqual(invert(TRANSLATE));
  });

  it('ignores deformable registrations (resolved separately in Phase 2)', () => {
    expect(resolveAlignment('BASE', 'OVERLAY', [deformable('OVERLAY', 'BASE')])).toBeNull();
  });

  it('picks the linking registration out of several', () => {
    const regs = [
      rigid('A', 'B', TRANSLATE),
      rigid('OVERLAY', 'BASE', TRANSLATE),
      rigid('C', 'D', IDENTITY_MAT4),
    ];
    expect(resolveAlignment('BASE', 'OVERLAY', regs)).toEqual(invert(TRANSLATE));
  });
});
