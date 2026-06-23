import { Injectable } from '@angular/core';
import { resolveAlignment, resolveDeformable } from '../dicom/align';
import { buildVolume } from '../dicom/volume';
import { initialImportSeries } from '../dicom/catalog';
import { groupSeries, type Series } from '../dicom/series';
import { structureSetsForSeries } from '../dicom/structure-set';
import {
  baseImageLayer,
  baseLayer,
  framesMatch,
  IDENTITY_MAT4,
  overlayImageLayer,
  type Layer,
  type Mat4,
  type Registration,
  type StructureSet,
} from '../dicom/types';
import { parseFilesInWorkers, type LoadProgress } from './parse-pool';
import { trace } from '../diag/trace';

/**
 * Outcome of loading a batch of files: the series found across them and the one
 * currently assembled into the {@link layers} registry. A folder may hold several
 * series; the grouped slices are kept so switching selection rebuilds without
 * re-reading.
 */
export interface LoadResult {
  /** Every series found, in picker order. */
  readonly series: readonly Series[];
  /** UID of the series whose slices were built into the base {@link layers} entry. */
  readonly selectedUid: string;
  /**
   * The loaded volumes as an ordered layer registry, keyed by {@link Layer.id}.
   * A single-series load holds exactly one entry, role `'base'`, wrapping the
   * volume assembled from the selected series; fusion (CT + dose) and compare
   * will add `'overlay'` layers above it. Read the base with
   * {@link import('../dicom/types').baseLayer}.
   */
  readonly layers: readonly Layer[];
  /**
   * Structure sets (RTSTRUCT) that annotate the selected series, matched by
   * frame of reference (see {@link structureSetsForSeries}). Empty when the load
   * held no RTSTRUCT or none referenced the selected series. Their contour
   * points are in patient coordinates; map them with
   * {@link import('../dicom/volume').patientToVoxel} against the base layer's
   * volume.
   */
  readonly structureSets: readonly StructureSet[];
  /**
   * Every structure set parsed in the load, regardless of which series it
   * annotates. Retained so {@link VolumeLoader.selectSeries} can re-associate
   * against a different series without re-parsing; the UI should read
   * {@link structureSets} for the current selection.
   */
  readonly allStructureSets: readonly StructureSet[];
  /**
   * Spatial Registration objects (rigid or deformable) parsed in the load,
   * regardless of which frames they link. Retained like {@link allStructureSets}
   * so a later selection or merge can resolve cross-frame alignment without
   * re-parsing. Empty when the load held no registration. Nothing consumes these
   * yet — Phase 1 (rigid) and Phase 2 (deformable) wire them into fusion.
   */
  readonly registrations: readonly Registration[];
  /** Number of files the user selected. */
  readonly fileCount: number;
  /** Number of image slices the selected series contributed. */
  readonly sliceCount: number;
}

/**
 * Turns a batch of on-disk DICOM files into a {@link Volume}. Pure parsing and
 * assembly live in `../dicom`; this service is the injectable seam the UI
 * depends on (and the test seam components can replace).
 */
@Injectable({ providedIn: 'root' })
export class VolumeLoader {
  /**
   * Parse and assemble a batch of files. Parsing runs off the main thread in a
   * worker pool (see {@link parseFilesInWorkers}) so a large folder doesn't
   * freeze the UI; {@link onProgress} reports files parsed / total as it goes.
   * Assembly (grouping + {@link buildVolume}) stays on the main thread.
   */
  async loadFromFiles(files: readonly File[], onProgress?: LoadProgress): Promise<LoadResult> {
    const { slices, structureSets, registrations } = await parseFilesInWorkers(files, onProgress);
    trace('load')?.('parsed file batch', {
      files: files.length,
      slices: slices.length,
      structureSets: structureSets.length,
      registrations: registrations.map(summarizeRegistration),
    });

    const series = groupSeries(slices);
    // initialImportSeries returns undefined only for an empty batch; assemble it to
    // throw the canonical "no slices" error in that case.
    const selected = initialImportSeries(series);
    if (!selected) buildVolume(slices); // throws the canonical "no slices" error

    return this.buildResult(series, selected!, structureSets, registrations, files.length);
  }

  /**
   * Rebuild the result for a different series of an existing load — the picker's
   * selection — reusing the already-parsed slices and re-associating the
   * structure sets to the newly-selected series.
   */
  selectSeries(result: LoadResult, uid: string): LoadResult {
    const series = result.series.find((s) => s.uid === uid);
    if (!series) return result;
    return this.buildResult(
      result.series,
      series,
      result.allStructureSets,
      result.registrations,
      result.fileCount,
    );
  }

  /**
   * Build a load result for a single catalog {@link Series} — the history
   * panel's on-demand ("lazy") build. The series retains its parsed slices, so
   * the volume is assembled here ({@link buildVolume}) without re-reading files.
   * Structure sets parsed in an earlier load are carried through so an RTSTRUCT
   * still annotates a series it references (matched by frame of reference); pass
   * the current view's `allStructureSets`, or none. The viewer routes the result
   * through {@link merge} for the same-FoR-fuses / different-study-replaces rule.
   */
  loadSeries(
    series: Series,
    allStructureSets: readonly StructureSet[] = [],
    registrations: readonly Registration[] = [],
  ): LoadResult {
    return this.buildResult(
      [series],
      series,
      allStructureSets,
      registrations,
      series.slices.length,
    );
  }

  /**
   * Fold a freshly loaded batch into what's already shown. See {@link mergeLoad};
   * the injectable method just delegates so the viewer can go through the loader
   * seam, while the pure decision stays unit-testable.
   */
  merge(current: LoadResult, incoming: LoadResult): MergedLoad {
    return mergeLoad(current, incoming);
  }

  private buildResult(
    series: readonly Series[],
    selected: Series,
    allStructureSets: readonly StructureSet[],
    registrations: readonly Registration[],
    fileCount: number,
  ): LoadResult {
    const baseVolume = buildVolume(selected.slices);
    const layers: Layer[] = [baseImageLayer(selected.uid, baseVolume)];
    // A same-frame dose grid in the same load joins as a fusion overlay above the
    // base (the CT + dose case), so dropping the pair shows the wash immediately.
    // Co-sampling needs both grids' geometry, so a geometry-less series is skipped.
    if (baseVolume.geometry) {
      for (const s of doseOverlaySeries(series, selected)) {
        const overlayVolume = buildVolume(s.slices);
        if (overlayVolume.geometry) layers.push(overlayImageLayer(s.uid, overlayVolume));
      }
    }
    return {
      series,
      selectedUid: selected.uid,
      layers,
      structureSets: structureSetsForSeries(allStructureSets, selected),
      allStructureSets,
      registrations,
      fileCount,
      sliceCount: selected.slices.length,
    };
  }
}

/**
 * The series in a load that should sit above `selected` (the base) as fusion
 * overlays: a same-frame-of-reference dose grid (RTDOSE) other than the base —
 * the CT + dose case. Image series are left as selectable series, not forced
 * overlays, so an ordinary multi-series study isn't auto-fused. Pure for testing.
 */
export function doseOverlaySeries(series: readonly Series[], selected: Series): Series[] {
  return series.filter(
    (s) =>
      s.uid !== selected.uid &&
      s.modality === 'RTDOSE' &&
      framesMatch(s.frameOfReferenceUid, selected.frameOfReferenceUid),
  );
}

/**
 * How a freshly loaded batch joined the current view: either *added* above it as
 * an overlay layer (same patient/placement) or *replaced* it (a different study).
 * The viewer keeps its view state (zoom/pan/window) on an add and resets it on a
 * replace, so the distinction is surfaced rather than hidden inside the result.
 */
export interface MergedLoad {
  /** The registry to show: the current load grown by an overlay, or the incoming load. */
  readonly result: LoadResult;
  /** True when {@link result} added the incoming series as an overlay layer. */
  readonly added: boolean;
  /**
   * True when the merge changed which series is the base — deformable auto-orient:
   * a displacement field can only be sampled with its fixed frame as the base, so
   * when the *incoming* series is the fixed one it becomes the base and the current
   * series is warped onto it. The viewer then re-bases (resets the view) rather than
   * adding a layer over the unchanged base. Absent (falsy) for an ordinary add.
   */
  readonly baseChanged?: boolean;
}

/**
 * Decide how a freshly loaded `incoming` batch joins the `current` view and
 * produce the merged result.
 *
 * When the incoming selected series can be aligned to the current base layer —
 * either it shares the base's frame of reference (same patient/placement) or a
 * Spatial Registration links the two frames — it's *added* as a translucent
 * overlay layer above the base (which stays), carrying any cross-frame transform
 * on the layer. Otherwise it's a different study and *replaces* the current load.
 * A series with no frame of reference and no registration never aligns, so it
 * replaces — there's nothing to align it against.
 *
 * Pure for unit testing the add-vs-replace rule and the resulting registry.
 */
export function mergeLoad(current: LoadResult, incoming: LoadResult): MergedLoad {
  // A registration may arrive with either load (the REG dropped with the moving
  // series, or already loaded), so pool both before deciding alignability.
  const registrations = [...current.registrations, ...incoming.registrations];
  const currentFrame = selectedSeries(current)?.frameOfReferenceUid ?? null;
  const incomingFrame = selectedSeries(incoming)?.frameOfReferenceUid ?? null;

  // Same-frame / rigid keep the dropped base (current); rigid resolves in either
  // direction by inverting its matrix. A deformable field can only be sampled with
  // its FIXED frame as the base, so a forward link (current is fixed) overlays as
  // usual, while a reverse link (the incoming series is the fixed one) auto-orients:
  // the incoming becomes the base and the current series is warped onto it.
  const alignment = resolveAlignment(currentFrame, incomingFrame, registrations);
  const forwardDeform =
    alignment === null ? resolveDeformable(currentFrame, incomingFrame, registrations) : null;
  const reverseDeform =
    alignment === null && forwardDeform === null
      ? resolveDeformable(incomingFrame, currentFrame, registrations)
      : null;

  // Trace the whole alignment decision: the frames being matched, every pooled
  // registration's frames (the usual culprit when fusion silently refuses), and
  // what resolved. `trace('merge')` is undefined unless the category is enabled,
  // so the payload is only built when tracing is on.
  const t = trace('merge');
  t?.('alignment inputs', {
    baseFrame: currentFrame,
    overlayFrame: incomingFrame,
    registrations: registrations.map(summarizeRegistration),
    alignment: describeAlignment(alignment),
    deformation: forwardDeform ? summarizeRegistration(forwardDeform) : null,
    reverseDeformation: reverseDeform ? summarizeRegistration(reverseDeform) : null,
  });

  // Frames neither match nor are linked by any registration: a different study; replace.
  if (alignment === null && forwardDeform === null && reverseDeform === null) {
    t?.('replace: frames neither match nor are linked by a registration');
    return { result: incoming, added: false };
  }

  // Orient the fusion: the reverse-deformable case makes the incoming (fixed) the
  // base and the current series the (warped) overlay; every other case keeps the
  // dropped base.
  const swap = reverseDeform !== null;
  const baseLoad = swap ? incoming : current;
  const overlayLoad = swap ? current : incoming;
  const deformation = swap ? reverseDeform : forwardDeform;

  // Co-sampling an overlay in the base's patient frame maps each pane pixel
  // through both grids' index→patient affines, so both volumes need geometry;
  // without it (a series with no spatial metadata) they can't be aligned and we
  // fall back to replacing rather than stacking a mis-registered overlay.
  const baseVolume = baseLayer(baseLoad.layers)?.volume;
  const overlayVolume = baseLayer(overlayLoad.layers)?.volume;
  if (!baseVolume?.geometry || !overlayVolume?.geometry) {
    t?.('replace: a volume lacks geometry, cannot co-sample', {
      baseHasGeometry: !!baseVolume?.geometry,
      overlayHasGeometry: !!overlayVolume?.geometry,
    });
    return { result: incoming, added: false };
  }

  // Re-loading the series that's already the base would stack the image on top of
  // itself — the "double CT in overlays" of issue #160 (e.g. re-picking the same
  // study from Recent, which re-opens the picker for the same folder). Replace
  // with the freshly built registry instead, so the study — and any same-frame
  // dose it auto-promotes to an overlay — shows exactly once rather than twice.
  if (baseLayer(current.layers)?.id === incoming.selectedUid) {
    t?.('replace: incoming series is already the base', { id: incoming.selectedUid });
    return { result: incoming, added: false };
  }

  const overlayBase = overlayImageLayer(
    uniqueLayerId(baseLoad.layers, overlayLoad.selectedUid),
    overlayVolume,
  );
  // A cross-frame overlay carries its base→overlay transform: a rigid matrix
  // (alignToBase), or a deformable registration (deformation) when only a
  // displacement field links the frames. The same-frame case needs neither
  // (resolveAlignment returns the shared identity constant, detected by reference).
  let overlay: Layer = overlayBase;
  if (alignment !== null && alignment !== IDENTITY_MAT4) {
    overlay = { ...overlayBase, alignToBase: alignment };
  } else if (deformation !== null) {
    overlay = { ...overlayBase, deformation };
  }
  t?.('added overlay layer', {
    id: overlay.id,
    via: alignment === IDENTITY_MAT4 ? 'same-frame' : alignment !== null ? 'rigid' : 'deformable',
    baseChanged: swap,
  });
  return {
    result: { ...baseLoad, layers: [...baseLoad.layers, overlay], registrations },
    added: true,
    baseChanged: swap,
  };
}

/** The series a load currently shows (its base layer's source), or undefined. */
function selectedSeries(result: LoadResult): Series | undefined {
  return result.series.find((s) => s.uid === result.selectedUid);
}

/**
 * A trace-safe digest of a registration: its identity and the frames it links —
 * never the (potentially large) displacement grid. The frames are what matters
 * when diagnosing why fusion did or didn't pick a registration up.
 */
function summarizeRegistration(reg: Registration): Record<string, unknown> {
  const base = { kind: reg.kind, name: reg.name, source: reg.sourceFrame, target: reg.targetFrame };
  return reg.kind === 'rigid'
    ? { ...base, matrixType: reg.matrixType }
    : { ...base, gridDims: reg.grid.dims };
}

/** A one-word description of a resolved rigid alignment, for traces. */
function describeAlignment(alignment: Mat4 | null): 'none' | 'identity' | 'matrix' {
  if (alignment === null) return 'none';
  return alignment === IDENTITY_MAT4 ? 'identity' : 'matrix';
}

/**
 * A layer id unique within `layers`, preferring `desired` (the series UID) and
 * suffixing `#2`, `#3`… when it's already taken — e.g. the same series added as
 * an overlay twice — so the registry stays keyable without collisions.
 */
function uniqueLayerId(layers: readonly Layer[], desired: string): string {
  const used = new Set(layers.map((layer) => layer.id));
  if (!used.has(desired)) return desired;
  for (let n = 2; ; n++) {
    const candidate = `${desired}#${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
