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
  /**
   * FrameOfReferenceUID, Tag (0020,0052). The spatial frame the patient
   * coordinates live in; an RTSTRUCT is associated to a series by matching this.
   * Null when absent.
   */
  readonly frameOfReferenceUid: string | null;
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
 * One planar contour of an ROI: a loop or polyline of points in patient space.
 *
 * Sourced from one item of the Contour Sequence (3006,0040). The points come
 * straight from Contour Data (3006,0050) — a flat `x\y\z` list in patient
 * coordinates (LPS, millimetres) — regrouped into triplets.
 */
export interface Contour {
  /**
   * Contour Geometric Type (3006,0042): typically `CLOSED_PLANAR`,
   * `OPEN_PLANAR`, or `POINT`. Kept as the raw string so unrecognised types
   * (e.g. `CLOSED_PLANAR_XOR`) round-trip rather than being dropped.
   */
  readonly geometricType: string;
  /** The contour's points in patient coordinates (LPS, mm). */
  readonly points: readonly Vec3[];
}

/**
 * One region of interest from an RTSTRUCT: its identity and colour joined to the
 * contour stack and interpreted type that live in separate top-level sequences.
 */
export interface Roi {
  /** ROI Number (3006,0022): the identifier the other sequences reference. */
  readonly number: number;
  /** ROI Name (3006,0026), e.g. "Heart" or "PTV". */
  readonly name: string;
  /** ROI Display Color (3006,002A) as `[r, g, b]` in 0–255; null when absent. */
  readonly color: readonly [number, number, number] | null;
  /**
   * RT ROI Interpreted Type (3006,00A4) from the RT ROI Observations Sequence
   * (e.g. `ORGAN`, `PTV`, `GTV`); null when the ROI has no observation.
   */
  readonly interpretedType: string | null;
  /** The ROI's planar contours, in Contour Sequence order. */
  readonly contours: readonly Contour[];
}

/**
 * A parsed DICOM RTSTRUCT: a named set of coloured ROIs, each a stack of planar
 * contours in patient coordinates. Unlike a {@link Slice}, it carries no pixel
 * data; it overlays onto a separately-loaded image volume sharing its frame of
 * reference.
 */
export interface StructureSet {
  /** Source file name, for diagnostics. */
  readonly name: string;
  /** Structure Set Label (3006,0002), a short human label; null when absent. */
  readonly label: string | null;
  /**
   * Referenced Frame of Reference UID — the spatial frame the contour points are
   * defined in. Taken from the Referenced Frame of Reference Sequence (3006,0010
   * → 0020,0052), falling back to a ROI's Referenced Frame of Reference UID
   * (3006,0024). The primary key for {@link import('./series').Series}
   * association: it matches the series' {@link Slice.frameOfReferenceUid}. Null
   * when absent.
   */
  readonly frameOfReferenceUid: string | null;
  /**
   * Series Instance UIDs this structure set references (RT Referenced Series
   * Sequence, 3006,0014 → 0020,000E). Used as the association fallback when the
   * frame of reference is absent or unmatched. Empty when none are declared.
   */
  readonly referencedSeriesUids: readonly string[];
  /** The regions of interest, joined across the three RTSTRUCT sequences. */
  readonly rois: readonly Roi[];
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
 * How a {@link Layer}'s voxels are colour-mapped when composited. The base image
 * layer is drawn grayscale through its window/level (`'grayscale'`); fusion
 * overlays (e.g. a dose map) tint through a named colormap. Modelled as a union
 * so the renderer can switch on it exhaustively as fusion modes are added.
 */
export type LayerDisplay =
  | { readonly kind: 'grayscale' }
  | { readonly kind: 'colormap'; readonly name: string };

/** The default grayscale display, used by the base image layer. */
export const GRAYSCALE_DISPLAY: LayerDisplay = { kind: 'grayscale' };

/**
 * Default composite opacity for an added overlay image layer: half-transparent so
 * the base layer beneath stays visible through it. Fusion (dose) overlays may
 * pick a different value through their own controls.
 */
export const DEFAULT_OVERLAY_OPACITY = 0.5;

/**
 * One entry in the viewer's layer registry: a loaded {@link Volume} plus how it
 * participates in the composited view. A single-series load holds exactly one
 * layer, role `'base'`; fusion (CT + dose overlay) and side-by-side compare add
 * `'overlay'` layers above it. Identified by {@link id} so the registry can be
 * keyed and reordered without positional ambiguity.
 */
export interface Layer {
  /** Stable identifier, unique within a load; the registry's key. */
  readonly id: string;
  /** The assembled scalar volume this layer draws. */
  readonly volume: Volume;
  /** DICOM modality of {@link volume}, surfaced for labelling; null when absent. */
  readonly modality: string | null;
  /** Whether this is the underlying image (`'base'`) or sits above it (`'overlay'`). */
  readonly role: 'base' | 'overlay';
  /** How the layer is colour-mapped when composited. */
  readonly display: LayerDisplay;
  /** Composite opacity in `[0, 1]`; 1 for an opaque base layer. */
  readonly opacity: number;
  /** Whether the layer is currently drawn. */
  readonly visible: boolean;
}

/**
 * Build the base image layer for a {@link Volume}: an opaque, visible,
 * grayscale `'base'`-role layer. The single layer a one-series load holds, and
 * the underlay fusion overlays sit on top of.
 */
export function baseImageLayer(id: string, volume: Volume): Layer {
  return {
    id,
    volume,
    modality: volume.modality,
    role: 'base',
    display: GRAYSCALE_DISPLAY,
    opacity: 1,
    visible: true,
  };
}

/**
 * Build an overlay image layer for a {@link Volume}: a translucent, visible,
 * grayscale `'overlay'`-role layer that sits above the base. Used when a second
 * (or Nth) series sharing the base's frame of reference is loaded as an added
 * layer rather than replacing the current load. Grayscale by default — a fusion
 * caller (e.g. a dose map) can swap {@link Layer.display} for a colormap.
 */
export function overlayImageLayer(id: string, volume: Volume): Layer {
  return {
    id,
    volume,
    modality: volume.modality,
    role: 'overlay',
    display: GRAYSCALE_DISPLAY,
    opacity: DEFAULT_OVERLAY_OPACITY,
    visible: true,
  };
}

/**
 * The base image layer of a registry: the `'base'`-role layer, falling back to
 * the first entry when none is tagged (a non-empty registry always has one).
 * Every single-layer consumer (reslice, probe, contours, crosshair, capture)
 * reads this, so one-layer behaviour matches the pre-registry single volume.
 * Returns `undefined` only for an empty registry.
 */
export function baseLayer(layers: readonly Layer[]): Layer | undefined {
  return layers.find((layer) => layer.role === 'base') ?? layers[0];
}

/**
 * Whether two DICOM Frame of Reference UIDs (0020,0052) name the same spatial
 * frame. A null UID never matches — not even another null — because an absent
 * frame gives nothing to align against, so callers must fall back to another
 * association (e.g. referenced series UID) or refuse to co-register rather than
 * guess. The single source of truth for "same frame", shared by RTSTRUCT↔series
 * association and layer overlay/compare eligibility.
 */
export function framesMatch(a: string | null, b: string | null): boolean {
  return a !== null && a === b;
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
