import type { DicomMetadata } from './metadata';

/** A single parsed DICOM slice, with the bits we need to build a volume. */
export interface Slice {
  /** Source file name, for diagnostics. */
  readonly name: string;
  /** Columns (width) in pixels. DICOM tag (0028,0011). */
  readonly columns: number;
  /** Rows (height) in pixels. DICOM tag (0028,0010). */
  readonly rows: number;
  /** In-plane pixel spacing [row, col] in mm. Tag (0028,0030). */
  readonly pixelSpacing: readonly [number, number];
  /** ImagePositionPatient [x,y,z] in mm. Tag (0020,0032). */
  readonly position: readonly [number, number, number] | null;
  /** ImageOrientationPatient (6 values: row & col direction cosines). Tag (0020,0037). */
  readonly orientation: readonly number[] | null;
  /** InstanceNumber, fallback ordering. Tag (0020,0013). */
  readonly instanceNumber: number;
  /** SeriesInstanceUID, Tag (0020,000E). Groups slices into a series; null if absent. */
  readonly seriesUid: string | null;
  /** SeriesNumber, Tag (0020,0011). Orders series in the picker; null if absent. */
  readonly seriesNumber: number | null;
  /** SeriesDescription, Tag (0008,103E). Labels the series; null if absent. */
  readonly seriesDescription: string | null;
  /** Modality (e.g. "CT", "MR"), Tag (0008,0060). Determines the value unit. Null if absent. */
  readonly modality: string | null;
  /** Modality LUT: rescaled value = raw * slope + intercept. */
  readonly rescaleSlope: number;
  readonly rescaleIntercept: number;
  /** Suggested display window from the file, if present. */
  readonly windowCenter: number | null;
  readonly windowWidth: number | null;
  /** Rescaled pixel values for this slice (rows * columns), row-major. */
  readonly pixels: Float32Array;
  /**
   * Captured study/series/patient metadata and the raw-tag list for the info
   * panel. Present only on a file's first frame (the series-representative image);
   * null on the others to avoid carrying the tag list on every slice.
   */
  readonly metadata?: DicomMetadata | null;
}

/**
 * Which way we are slicing the volume. Modelled as an `as const` object rather
 * than a `const enum` so it survives `isolatedModules` transpilation, and as a
 * union type so switches can be checked for exhaustiveness.
 *
 * The numeric values double as the orientation index passed to the shader.
 */
export const Orientation = {
  Axial: 0,
  Coronal: 1,
  Sagittal: 2,
} as const;

export type Orientation = (typeof Orientation)[keyof typeof Orientation];

/** A 3-vector, used for patient-space (LPS, millimetre) positions and steps. */
export type Vec3 = readonly [number, number, number];

/**
 * The index→patient affine for a volume: where each voxel sits in the DICOM
 * patient coordinate system (LPS — +x left, +y posterior, +z superior), in
 * millimetres. Derived from ImageOrientationPatient, ImagePositionPatient and
 * PixelSpacing.
 *
 * For a continuous voxel index `(i, j, k)` — column, row, slice — the patient
 * point is `origin + i·iStep + j·jStep + k·kStep`. The three steps are the
 * columns of the 3×3 linear map; together with `origin` they let the viewer
 * reslice true anatomical planes regardless of how the series was acquired
 * (axial, sagittal, coronal, or oblique/gantry-tilted).
 */
export interface VolumeGeometry {
  /** Patient displacement per +1 column index (i): `colSpacing · rowDirection`. */
  readonly iStep: Vec3;
  /** Patient displacement per +1 row index (j): `rowSpacing · colDirection`. */
  readonly jStep: Vec3;
  /** Patient displacement per +1 slice index (k): the inter-slice vector. */
  readonly kStep: Vec3;
  /** Patient coordinates of voxel (0, 0, 0): the first slice's ImagePositionPatient. */
  readonly origin: Vec3;
}

/**
 * A 3D scalar volume assembled from a stack of slices.
 * Voxels are stored row-major as [z][y][x] in a single Float32Array,
 * already rescaled to modality units (e.g. Hounsfield for CT).
 */
export interface Volume {
  /** Voxel counts along x (columns), y (rows), z (slices). */
  readonly dims: readonly [number, number, number];
  /** Physical voxel size in mm along x, y, z. */
  readonly spacing: readonly [number, number, number];
  /** Flat voxel data, length dims[0]*dims[1]*dims[2]. */
  readonly data: Float32Array;
  /** Min / max rescaled value across the volume. */
  readonly min: number;
  readonly max: number;
  /** Default display window derived from the data or file. */
  readonly windowCenter: number;
  readonly windowWidth: number;
  /**
   * Modality LUT used to rescale the stored pixels into {@link data}'s units:
   * `data = rawStored * rescaleSlope + rescaleIntercept`. Taken from the first
   * slice (assumed uniform across the series); lets callers recover the raw
   * stored value from a rescaled voxel.
   */
  readonly rescaleSlope: number;
  readonly rescaleIntercept: number;
  /**
   * DICOM modality (e.g. "CT", "MR") taken from the first slice, used to label
   * the value's unit in readouts. Null when the series has no modality tag.
   */
  readonly modality: string | null;
  /**
   * Index→patient (LPS) placement, used to reslice anatomical planes. Optional:
   * when absent (e.g. a series with no spatial metadata, or a hand-built test
   * volume), reslicing treats the acquisition axes as the patient axes.
   */
  readonly geometry?: VolumeGeometry;
  /**
   * Set when the source series had missing slices (gaps wider than the
   * representative slice spacing). The volume was resampled onto a uniform grid
   * and the absent slices filled by interpolation, so reconstructed planes that
   * cross a gap are not acquired data. Absent when the series is uniform.
   */
  readonly missingSlices?: MissingSlices;
}

/** Summary of through-plane interpolation done to fill a gapped series. */
export interface MissingSlices {
  /** Grid layers synthesized to fill gaps (grid depth − acquired slice count). */
  readonly count: number;
  /** Largest inter-slice gap in the source series, in mm. */
  readonly maxGapMm: number;
}

/**
 * The unit of a volume's rescaled voxel values, given its DICOM modality.
 *
 * CT values rescaled through the modality LUT are Hounsfield Units (HU). Other
 * modalities (e.g. MR signal intensity) have no standard scalar unit, so they
 * return null and should be shown unitless.
 */
export function modalityUnit(modality: string | null): string | null {
  switch (modality) {
    case 'CT':
      return 'HU';
    default:
      return null;
  }
}
