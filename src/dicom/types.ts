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
