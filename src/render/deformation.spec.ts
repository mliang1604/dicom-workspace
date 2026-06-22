import { floatsToHalf } from '../dicom/half';
import { transformPoint } from '../dicom/mat4';
import { IDENTITY_MAT4, type DeformationGrid, type Volume } from '../dicom/types';
import {
  deformationFieldHalf,
  deformationUniforms,
  gridGeometry,
  patientToTexRowMajor,
  sampleDisplacement,
} from './deformation';

function grid(overrides: Partial<DeformationGrid> = {}): DeformationGrid {
  return {
    origin: [0, 0, 0],
    orientation: [1, 0, 0, 0, 1, 0],
    dims: [2, 1, 1],
    spacing: [10, 10, 10],
    vectors: new Float32Array([0, 0, 0, 10, 0, 0]), // node0 = 0, node1 = +10mm x
    ...overrides,
  };
}

function makeVolume(): Volume {
  return {
    dims: [2, 2, 2],
    spacing: [10, 10, 10],
    data: new Float32Array(8),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'MR',
    geometry: { iStep: [10, 0, 0], jStep: [0, 10, 0], kStep: [0, 0, 10], origin: [0, 0, 0] },
  };
}

describe('deformationFieldHalf', () => {
  it('packs xyz displacement into rgba16 with a zero alpha pad', () => {
    const packed = deformationFieldHalf(grid());
    expect(packed).toEqual(floatsToHalf(new Float32Array([0, 0, 0, 0, 10, 0, 0, 0])));
    expect(packed).toHaveLength(8); // 2 nodes × 4 components
  });
});

describe('gridGeometry', () => {
  it('builds index→patient steps from orientation cosines and spacing', () => {
    const geom = gridGeometry(grid({ spacing: [2, 3, 4] }));
    expect(geom.iStep).toEqual([2, 0, 0]);
    expect(geom.jStep).toEqual([0, 3, 0]);
    expect(geom.kStep).toEqual([0, 0, 4]); // normal = rowDir × colDir
    expect(geom.origin).toEqual([0, 0, 0]);
  });
});

describe('patientToTexRowMajor', () => {
  it('maps the grid centre to texture 0.5', () => {
    const m = patientToTexRowMajor(
      { iStep: [10, 0, 0], jStep: [0, 10, 0], kStep: [0, 0, 10], origin: [0, 0, 0] },
      [2, 2, 2],
    )!;
    expect(m).not.toBeNull();
    const tex = transformPoint(m, [5, 5, 5]); // patient centre → index 0.5 → tex 0.5
    tex.forEach((v) => expect(v).toBeCloseTo(0.5, 6));
  });

  it('returns null for a singular geometry', () => {
    expect(
      patientToTexRowMajor(
        { iStep: [0, 0, 0], jStep: [0, 10, 0], kStep: [0, 0, 10], origin: [0, 0, 0] },
        [2, 2, 2],
      ),
    ).toBeNull();
  });
});

describe('sampleDisplacement', () => {
  it('trilinearly interpolates the field between nodes', () => {
    // Nodes at x=0 (disp 0) and x=10 (disp +10mm x); midpoint → +5mm.
    expect(sampleDisplacement(grid(), [5, 0, 0])).toEqual([5, 0, 0]);
    expect(sampleDisplacement(grid(), [10, 0, 0])).toEqual([10, 0, 0]);
  });

  it('returns zero outside the grid (the renderer fallback)', () => {
    expect(sampleDisplacement(grid(), [50, 0, 0])).toEqual([0, 0, 0]);
    expect(sampleDisplacement(grid(), [-5, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('deformationUniforms', () => {
  it('returns three column-major matrices for the shader', () => {
    const u = deformationUniforms(
      IDENTITY_MAT4,
      makeVolume(),
      IDENTITY_MAT4,
      IDENTITY_MAT4,
      grid(),
    )!;
    expect(u).not.toBeNull();
    expect(u.paneToPatientPre).toHaveLength(16);
    expect(u.patientToField).toHaveLength(16);
    expect(u.patientToOverlayTex).toHaveLength(16);
  });

  it('returns null when a geometry is singular', () => {
    const badGrid = grid({ spacing: [0, 10, 10] }); // zero iStep → singular field map
    expect(
      deformationUniforms(IDENTITY_MAT4, makeVolume(), IDENTITY_MAT4, IDENTITY_MAT4, badGrid),
    ).toBeNull();
  });
});
