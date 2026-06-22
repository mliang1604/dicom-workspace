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
  /** StudyInstanceUID, Tag (0020,000D). Groups series into a study; null if absent. */
  readonly studyUid: string | null;
  /**
   * StudyDate, Tag (0008,0020). Kept raw (DICOM `DA`, `YYYYMMDD`); formatting is a
   * UI concern. Null if absent.
   */
  readonly studyDate: string | null;
  /**
   * StudyTime, Tag (0008,0030). Kept raw (DICOM `TM`); formatting is a UI concern.
   * Null if absent.
   */
  readonly studyTime: string | null;
  /** StudyDescription, Tag (0008,1030). Labels the study; null if absent. */
  readonly studyDescription: string | null;
  /** PatientID, Tag (0010,0020). Identifies the patient; null if absent. */
  readonly patientId: string | null;
  /**
   * PatientName, Tag (0010,0010). Kept raw (DICOM `PN`,
   * `Family^Given^Middle^Prefix^Suffix`); formatting is a UI concern. Null if
   * absent.
   */
  readonly patientName: string | null;
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
 * A 4×4 affine transform as 16 numbers in **row-major** order — the layout of a
 * DICOM Frame of Reference Transformation Matrix (3006,00C6). For a point
 * `p = [x, y, z, 1]`, the transformed point is `M · p` with `M`'s rows read in
 * groups of four. Patient→patient registrations and their pre/post rigid stages
 * are carried in this form; the renderer transposes to WGSL's column-major
 * `mat4x4` when it uploads (see `texAffineMatrix` in `render/reslice.ts`).
 */
export type Mat4 = readonly number[];

/** The 4×4 identity, used when a registration stage is absent (a no-op transform). */
export const IDENTITY_MAT4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * The displacement field of a DICOM Deformable Spatial Registration: a regular
 * grid of patient-space (LPS, mm) offset vectors that warp the moving frame onto
 * the fixed frame. Read from the Deformable Registration Grid Sequence
 * (0064,0005). Sampled (trilinearly) at a patient point to get the local
 * displacement; Phase 2 uploads it as an `rgba16float` 3D texture so the GPU does
 * the interpolation.
 */
export interface DeformationGrid {
  /** Patient coordinates of grid node (0,0,0): ImagePositionPatient (0020,0032). */
  readonly origin: Vec3;
  /**
   * Grid axis direction cosines (6 values, row then column), ImageOrientationPatient
   * (0020,0037); the axis-aligned identity `[1,0,0,0,1,0]` when the grid omits it.
   */
  readonly orientation: readonly number[];
  /** Node counts along x, y, z: GridDimensions (0064,0007). */
  readonly dims: readonly [number, number, number];
  /** Inter-node spacing in mm along x, y, z: GridResolution (0064,0008). */
  readonly spacing: readonly [number, number, number];
  /**
   * Flat `[dx, dy, dz]` displacement per node in mm, row-major as `[z][y][x]`,
   * length `3 · dims[0] · dims[1] · dims[2]`: Vector Grid Data (0064,0009).
   */
  readonly vectors: Float32Array;
}

/**
 * A parsed DICOM Spatial Registration object: a transform from a **moving** frame
 * of reference ({@link sourceFrame}) onto a **fixed** one ({@link targetFrame}),
 * the two frames a fusion overlay and its base live in. Carries no pixels; like an
 * RTSTRUCT it associates to image series by frame of reference. A `'rigid'`
 * registration is a single affine {@link matrix}; a `'deformable'` one adds a
 * displacement {@link DeformationGrid} between optional pre/post rigid stages.
 *
 * `sourceFrame`/`targetFrame` are null when the object omits a frame UID; a null
 * frame never matches (see {@link framesMatch}), so such a registration links
 * nothing and is ignored by alignment.
 */
export type Registration =
  | {
      readonly kind: 'rigid';
      /** Source file name, for diagnostics. */
      readonly name: string;
      /** Moving frame of reference (0020,0052) the matrix maps from. */
      readonly sourceFrame: string | null;
      /** Fixed frame of reference (0020,0052) the matrix maps onto. */
      readonly targetFrame: string | null;
      /** Source→target affine (3006,00C6), row-major. */
      readonly matrix: Mat4;
      /** Frame of Reference Transformation Matrix Type (0070,030C): `RIGID`, `AFFINE`, … */
      readonly matrixType: string;
    }
  | {
      readonly kind: 'deformable';
      /** Source file name, for diagnostics. */
      readonly name: string;
      /** Moving frame of reference, Source Frame of Reference UID (0064,0003). */
      readonly sourceFrame: string | null;
      /** Fixed frame of reference (0020,0052) the deformation maps onto. */
      readonly targetFrame: string | null;
      /** Rigid stage applied before the displacement (0064,000F); identity when absent. */
      readonly preMatrix: Mat4;
      /** Rigid stage applied after the displacement (0064,000A); identity when absent. */
      readonly postMatrix: Mat4;
      /** The displacement field warping source onto target. */
      readonly grid: DeformationGrid;
    };

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

/** Default overlay colormap name for a dose wash; the render layer resolves it. */
export const DOSE_COLORMAP = 'jet';

/**
 * Build an overlay image layer for a {@link Volume}: a translucent, visible
 * `'overlay'`-role layer that sits above the base. Used when a second (or Nth)
 * series sharing the base's frame of reference is loaded as an added layer rather
 * than replacing the current load. A dose grid (modality RTDOSE) defaults to a
 * colour wash ({@link DOSE_COLORMAP}); other images default to grayscale, and a
 * caller can swap {@link Layer.display} later.
 */
export function overlayImageLayer(id: string, volume: Volume): Layer {
  const display: LayerDisplay =
    volume.modality === 'RTDOSE' ? { kind: 'colormap', name: DOSE_COLORMAP } : GRAYSCALE_DISPLAY;
  return {
    id,
    volume,
    modality: volume.modality,
    role: 'overlay',
    display,
    opacity: DEFAULT_OVERLAY_OPACITY,
    visible: true,
  };
}

/**
 * Apply the layers panel's user overrides onto the loaded registry: per-layer
 * visibility, composite opacity, and display transform (grayscale ⇄ colormap),
 * keyed by {@link Layer.id}. Mirrors the structures panel's override maps — the
 * loaded layers stay immutable and the panel layers its edits on top, so a reload
 * starts clean. A layer with no override is returned unchanged (same reference).
 */
export function applyLayerOverrides(
  layers: readonly Layer[],
  hidden: ReadonlySet<string>,
  opacities: ReadonlyMap<string, number>,
  displays: ReadonlyMap<string, LayerDisplay>,
): Layer[] {
  return layers.map((layer) => {
    const opacity = opacities.get(layer.id);
    const display = displays.get(layer.id);
    const visible = !hidden.has(layer.id) && layer.visible;
    if (opacity === undefined && display === undefined && visible === layer.visible) return layer;
    return {
      ...layer,
      visible,
      opacity: opacity ?? layer.opacity,
      display: display ?? layer.display,
    };
  });
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
 * CT values rescaled through the modality LUT are Hounsfield Units (HU); an
 * RTDOSE grid scaled by DoseGridScaling is absorbed dose in Gray (Gy). Other
 * modalities (e.g. MR signal intensity) have no standard scalar unit, so they
 * return null and should be shown unitless.
 */
export function modalityUnit(modality: string | null): string | null {
  switch (modality) {
    case 'CT':
      return 'HU';
    case 'RTDOSE':
      return 'Gy';
    default:
      return null;
  }
}
