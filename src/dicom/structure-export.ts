import type { LabelVolume } from './label-volume';
import { idOccupancy, traceMaskLoops } from './marching-squares';
import type { Contour, Roi, StructureSet, Vec3 } from './types';
import { voxelToPatient } from './volume';

/**
 * The identity of one authored structure to export — structurally a subset of
 * `EditableRoi` (the editable-structures store's ROI), so the app passes its
 * registry straight through. Its {@link id} is the voxel value tagging the
 * structure in the {@link LabelVolume} and doubles as the exported ROI Number.
 */
export interface AuthoredRoi {
  /** Voxel value tagging this structure; also its exported ROI Number (≥ 1). */
  readonly id: number;
  /** ROI Name. */
  readonly name: string;
  /** ROI Display Color as `[r, g, b]` in 0–255. */
  readonly color: readonly [number, number, number];
  /** RT ROI Interpreted Type (e.g. `ORGAN`, `PTV`); null when unset. */
  readonly interpretedType: string | null;
}

/** Association + labelling for the exported {@link StructureSet}. */
export interface StructureExportOptions {
  /** Source name for diagnostics; defaults to a generic RTSTRUCT filename. */
  readonly name?: string;
  /** Structure Set Label (3006,0002); null when unlabelled. */
  readonly label?: string | null;
  /** Frame of reference the contour points live in — the active image series'. */
  readonly frameOfReferenceUid?: string | null;
  /** Image Series Instance UIDs the set references, for re-association on import. */
  readonly referencedSeriesUids?: readonly string[];
}

/**
 * Build a {@link StructureSet} from an authored {@link LabelVolume} by tracing
 * each structure's voxels into per-slice contours — the geometry half of
 * RTSTRUCT export ({@link import('./structure-set-writer').writeStructureSet}
 * then serializes the result to DICOM bytes).
 *
 * For every ROI and every **axial** slice (constant k), the slice's occupancy is
 * traced with marching squares ({@link traceMaskLoops}) into closed pixel-corner
 * loops — one per connected component, holes as separate oppositely-wound loops.
 * Each loop's corners are mapped to patient space (LPS, mm) via
 * {@link voxelToPatient} (a corner `(cx, cy)` sits at continuous voxel index
 * `(cx − 0.5, cy − 0.5)`) and emitted as a `CLOSED_PLANAR` {@link Contour},
 * matching the parser's model so the round-trip is exact.
 *
 * Axial-only contouring matches conventional RTSTRUCT. ROIs with no painted
 * voxels are kept (with an empty contour stack) so the structure registry
 * round-trips. Note these marching-squares contours are the staircase boundary
 * of the mask — they will not reproduce an imported RTSTRUCT's original points.
 */
export function buildStructureSet(
  label: LabelVolume,
  rois: readonly AuthoredRoi[],
  options: StructureExportOptions = {},
): StructureSet {
  const [dimX, dimY, dimZ] = label.dims;
  const sliceVoxels = dimX * dimY;
  return {
    name: options.name ?? 'authored-structures.dcm',
    label: options.label ?? null,
    frameOfReferenceUid: options.frameOfReferenceUid ?? null,
    referencedSeriesUids: options.referencedSeriesUids ?? [],
    rois: rois.map((roi) => roiContours(label, roi, dimX, dimY, dimZ, sliceVoxels)),
  };
}

/** Trace one ROI's voxels across every axial slice into its contour stack. */
function roiContours(
  label: LabelVolume,
  roi: AuthoredRoi,
  dimX: number,
  dimY: number,
  dimZ: number,
  sliceVoxels: number,
): Roi {
  const contours: Contour[] = [];
  for (let z = 0; z < dimZ; z++) {
    const slice = label.data.subarray(z * sliceVoxels, (z + 1) * sliceVoxels);
    const loops = traceMaskLoops(idOccupancy(slice, dimX, dimY, roi.id), dimX, dimY);
    for (const loop of loops) {
      const points: Vec3[] = loop.map(([cx, cy]) =>
        voxelToPatient(label.geometry, [cx - 0.5, cy - 0.5, z]),
      );
      contours.push({ geometricType: 'CLOSED_PLANAR', points });
    }
  }
  return {
    number: roi.id,
    name: roi.name,
    color: roi.color,
    interpretedType: roi.interpretedType,
    contours,
  };
}
