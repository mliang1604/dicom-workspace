import { Injectable, computed, signal, type Signal } from '@angular/core';
import { loftRoiMesh, type RoiSurfaceMesh } from '../../render/surface';
import {
  roiContourCoords,
  roiPlaneShapes,
  roiScreenShapes,
  type ContourPaneOverlay,
  type RoiContourCoords,
  type RoiOverlayPane,
  type RoiPlaneShapes,
} from '../../render/roi-overlay';
import { clamp } from '../../dicom/math';
import { Orientation, type StructureSet, type Volume } from '../../dicom/types';
import { type LoadState } from './load-controller';
import { paneKeyOf, type PanePlacement } from './pane-placement';
import {
  allRoiKeys,
  buildRoiLegend,
  groupRoiLegend,
  structureSetLabel,
  type RoiLegendEntry,
  type RoiLegendGroup,
} from './roi-legend';
import {
  type PerOrientation,
  type PerOrientationOblique,
  type PerOrientationPan,
} from './viewer-overlays';

/** The three MPR orientations contours are projected for, regardless of layout. */
const MPR_ORIENTATIONS = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal] as const;

/** Decimation tolerance for coplanar loops, in plane `(u, v)` units (~0.15% of a pane). */
const CONTOUR_DECIMATE_UV = 0.0015;

/** Component view state the {@link RoiController} reads; wired via {@link RoiController.init}. */
export interface RoiInit {
  readonly load: () => LoadState;
  readonly isReady: () => boolean;
  readonly volume: () => Volume | null;
  readonly panes: () => readonly PanePlacement[];
  readonly obliques: Signal<PerOrientationOblique>;
  readonly sliceIndices: Signal<PerOrientation>;
  readonly zooms: Signal<PerOrientation>;
  readonly pans: Signal<PerOrientationPan>;
  readonly sagittalFlipped: () => boolean;
}

/**
 * Owns the RTSTRUCT structures domain: the per-ROI visibility / colour / opacity
 * and structure-set selection state, the structures-panel legend and its
 * grouping, the two-stage contour projection (cached patient-space projection +
 * the per-slice plane/screen classification) feeding the MPR overlays, and the
 * lofted 3D surface meshes. The view tuples that drive the per-slice/per-pane
 * stages stay on the component (read through {@link init}); this owns the ROI
 * state and the derived overlays. Provided at the component so its lifetime
 * tracks the viewer.
 */
@Injectable()
export class RoiController {
  private deps: RoiInit | null = null;

  /** Keys of ROIs whose contours are hidden (see {@link allRoiKeys}). */
  readonly hiddenRois = signal<ReadonlySet<string>>(new Set());
  /** Per-ROI colour overrides (`#rrggbb`), keyed by ROI key; empty by default. */
  readonly roiColorOverrides = signal<ReadonlyMap<string, string>>(new Map());
  /** Per-ROI draw opacity in `[0, 1]`, keyed by ROI key; default 1. */
  readonly roiOpacities = signal<ReadonlyMap<string, number>>(new Map());
  /** Which structure set the panel/overlays show: a set index, or -1 for all. */
  readonly selectedSetIndex = signal<number>(-1);

  /** Wire the controller to the component's load + view state. Called once. */
  init(deps: RoiInit): void {
    this.deps = deps;
  }

  /** Structure sets (RTSTRUCT) annotating the displayed series; empty when none. */
  readonly structureSets = computed<readonly StructureSet[]>(() => {
    const state = this.deps!.load();
    return state.status === 'ready' ? state.result.structureSets : [];
  });

  /** Whether any structure set annotates the displayed series (gates the panel). */
  readonly hasStructures = computed(() => this.structureSets().length > 0);

  /** Options for the structure-set selector: an "All" entry plus one per set. */
  readonly structureSetChoices = computed<{ value: number; label: string }[]>(() => {
    const sets = this.structureSets();
    return [
      { value: -1, label: 'All structure sets' },
      ...sets.map((ss, index) => ({ value: index, label: structureSetLabel(ss, index) })),
    ];
  });

  /** Whether more than one structure set is associated, gating the set selector. */
  readonly hasManyStructureSets = computed(() => this.structureSets().length > 1);

  /** The ROIs of the shown structure set(s) flattened for the panel. */
  readonly roiLegend = computed<RoiLegendEntry[]>(() =>
    buildRoiLegend(
      this.structureSets(),
      this.hiddenRois(),
      this.roiColorOverrides(),
      this.roiOpacities(),
      this.selectedSetIndex(),
    ),
  );

  /** The listed ROIs grouped by their structure set, each group labelled by the set. */
  readonly roiGroups = computed<RoiLegendGroup[]>(() =>
    groupRoiLegend(this.roiLegend(), this.structureSets()),
  );

  /** Whether to show per-set group headings: only when more than one group is listed. */
  readonly showRoiGroupLabels = computed(() => this.roiGroups().length > 1);

  /** Whether every listed ROI is visible: drives the master toggle's checked state. */
  readonly allRoisVisible = computed(() => this.roiLegend().every((e) => e.visible));

  /** Whether the listed ROIs are a mix of shown and hidden, for the indeterminate toggle. */
  readonly someRoisHidden = computed(() => {
    const entries = this.roiLegend();
    return entries.some((e) => e.visible) && entries.some((e) => !e.visible);
  });

  /** Per-ROI 3D surface meshes, lofted from each ROI's contour stack in patient space. */
  readonly surfaceMeshes = computed<RoiSurfaceMesh[]>(() => {
    const sets = this.structureSets();
    if (!this.deps!.isReady() || sets.length === 0) return [];
    const meshes: RoiSurfaceMesh[] = [];
    sets.forEach((ss, setIndex) => {
      for (const roi of ss.rois) {
        const loops = roi.contours
          .filter((c) => c.geometricType !== 'OPEN_PLANAR' && c.geometricType !== 'POINT')
          .map((c) => c.points);
        const baseColor = roi.color ?? ([200, 200, 200] as const);
        const mesh = loftRoiMesh(setIndex, roi.number, baseColor, loops);
        if (mesh) meshes.push(mesh);
      }
    });
    return meshes;
  });

  /** The expensive half: every ROI's contours projected into each MPR plane frame once. */
  private readonly contourCoords = computed<Map<Orientation, RoiContourCoords[]>>(() => {
    const d = this.deps!;
    const volume = d.volume();
    const sets = this.structureSets();
    if (!d.isReady() || !volume || sets.length === 0)
      return new Map<Orientation, RoiContourCoords[]>();
    return roiContourCoords(volume, sets, MPR_ORIENTATIONS, d.obliques());
  });

  /** The cheap, per-slice half: classify the cached coords against the current slice. */
  private readonly contourPlaneGeometry = computed<Map<Orientation, RoiPlaneShapes[]>>(() => {
    const d = this.deps!;
    const volume = d.volume();
    const coordsByOrientation = this.contourCoords();
    if (!volume || coordsByOrientation.size === 0) return new Map<Orientation, RoiPlaneShapes[]>();

    const shown = new Set<Orientation>();
    for (const pane of d.panes()) if (pane.kind === 'mpr') shown.add(pane.orientation);

    return roiPlaneShapes(volume, coordsByOrientation, {
      sliceIndices: d.sliceIndices(),
      shown,
      hidden: this.hiddenRois(),
      colorOverrides: this.roiColorOverrides(),
      opacities: this.roiOpacities(),
      selectedSet: this.selectedSetIndex(),
      decimateTolerance: CONTOUR_DECIMATE_UV,
    });
  });

  /** RTSTRUCT ROI contours mapped to each MPR pane's pixels — the cheap half. */
  readonly contourOverlays = computed<ContourPaneOverlay[]>(() => {
    const d = this.deps!;
    const volume = d.volume();
    const geometry = this.contourPlaneGeometry();
    if (!volume || geometry.size === 0) return [];

    const panes: RoiOverlayPane[] = [];
    for (const pane of d.panes()) {
      if (pane.kind !== 'mpr') continue;
      panes.push({ key: paneKeyOf(pane), orientation: pane.orientation, rect: pane.rect });
    }

    return roiScreenShapes(volume, geometry, panes, d.zooms(), d.pans(), d.sagittalFlipped());
  });

  /** Show or hide one ROI's contours, from the structures panel checkbox. */
  toggleRoi(key: string): void {
    this.hiddenRois.update((hidden) => {
      const next = new Set(hidden);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** Show or hide every currently-listed ROI at once, from the master toggle. */
  setAllRoisVisible(visible: boolean): void {
    const keys = this.roiLegend().map((e) => e.key);
    this.hiddenRois.update((hidden) => {
      const next = new Set(hidden);
      for (const key of keys) {
        if (visible) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  /** Override one ROI's contour colour from the panel's colour picker. */
  onRoiColor(key: string, event: Event): void {
    const hex = (event.target as HTMLInputElement).value;
    this.roiColorOverrides.update((map) => new Map(map).set(key, hex));
  }

  /** Set one ROI's contour opacity (whole percent) from the panel's slider. */
  onRoiOpacity(key: string, event: Event): void {
    const percent = Number((event.target as HTMLInputElement).value);
    this.roiOpacities.update((map) => new Map(map).set(key, clamp(percent, 0, 100) / 100));
  }

  /** Switch which structure set the panel and overlays show (-1 for all). */
  onStructureSetChange(event: Event): void {
    this.selectedSetIndex.set(Number((event.target as HTMLSelectElement).value));
  }

  /** Reset the ROI state for a freshly loaded volume: hide all contours, drop overrides. */
  resetForLoad(structureSets: readonly StructureSet[]): void {
    this.hiddenRois.set(allRoiKeys(structureSets)); // contours start hidden (#257)
    this.roiColorOverrides.set(new Map()); // and at its RTSTRUCT colours…
    this.roiOpacities.set(new Map()); // …fully opaque
    this.selectedSetIndex.set(-1); // showing every associated structure set
  }
}
