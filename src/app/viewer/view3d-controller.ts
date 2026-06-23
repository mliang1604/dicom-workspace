import { Injectable, computed, inject, type Signal, type WritableSignal } from '@angular/core';
import { clamp } from '../../dicom/math';
import {
  volumeBounds,
  NO_OBLIQUE,
  type ObliqueRotation,
  type PatientPlane,
} from '../../render/reslice';
import {
  clipPlaneGizmoGeometry,
  type ClipPlaneGizmoGeometry,
  type OrbitCamera,
} from '../../render/camera';
import { axisIndicatorGeometry, type AxisIndicatorOverlay } from '../../render/axis-indicator';
import { defaultSlabThicknessMm, isDvr, ProjectionMode } from '../../render/slice-renderer';
import {
  TRANSFER_FUNCTION_PRESETS,
  type TransferFunctionPreset,
} from '../../render/transfer-function';
import { type DvrLighting } from '../../render/dvr';
import { Orientation, type Vec3, type Volume } from '../../dicom/types';
import { Camera3dStore } from './camera3d-store';
import { type Drag } from './interaction-controller';
import { hexToRgb, rgbToHex } from './viewer-format';
import { type PanePlacement } from './pane-placement';
import {
  buildSlicePlanes,
  MAX_OBLIQUE_RAD,
  OBLIQUE_PX_PER_RAD,
  type PerOrientation,
  type PerOrientationOblique,
  type SlicePlanesOverlay,
} from './viewer-overlays';

const NO_OBLIQUES: PerOrientationOblique = [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE];

/** Short 3D-pane tags, indexed by {@link ProjectionMode}, for the pane label. */
const MODE_TAGS: Readonly<Record<ProjectionMode, string>> = {
  [ProjectionMode.Max]: 'MIP',
  [ProjectionMode.Min]: 'MinIP',
  [ProjectionMode.Mean]: 'Average',
  [ProjectionMode.Dvr]: 'DVR',
};

/** Outline colour of each MPR cut-plane drawn in the 3D pane, indexed by Orientation. */
const SLICE_PLANE_COLORS: readonly [string, string, string] = ['#ff6b6b', '#5ee08a', '#6bb6ff'];

function withOblique(
  values: PerOrientationOblique,
  orientation: Orientation,
  value: ObliqueRotation,
): PerOrientationOblique {
  const next: [ObliqueRotation, ObliqueRotation, ObliqueRotation] = [...values];
  next[orientation] = value;
  return next;
}

/** Component hooks the {@link View3dController} reads/writes; wired once via {@link View3dController.init}. */
export interface View3dInit {
  /** The active base volume, or null until one loads. */
  readonly volume: () => Volume | null;
  /** Whether the GPU + a volume are ready (gates the 3D overlays). */
  readonly isReady: () => boolean;
  /** The current pane placements. */
  readonly panes: () => readonly PanePlacement[];
  /** The orbit camera state. */
  readonly camera3d: () => OrbitCamera;
  /** The per-orientation slice indices (for the 3D cut-plane outlines). */
  readonly sliceIndices: Signal<PerOrientation>;
  /** Whether the linked crosshairs / 3D cut-planes overlay is enabled. */
  readonly crosshairsEnabled: () => boolean;
  /** The per-orientation oblique tilt signal (read + write). */
  readonly obliques: WritableSignal<PerOrientationOblique>;
  /** The 3D slab thickness signal (read + write). */
  readonly slabThicknessMm: WritableSignal<number>;
  /** The shared pointer-drag signal (read + write); clip/oblique gizmos drive it. */
  readonly drag: WritableSignal<Drag | null>;
  /** Hold the 3D MIP at reduced quality until interaction settles. */
  readonly markMipSettling: () => void;
}

/**
 * Owns the 3D-pane editing gestures: the transfer-function curve editor, the DVR
 * lighting sliders, the slice/arbitrary cut-plane toggles + handle drag, the
 * oblique-knob drag, and the slab-thickness slider. The view state itself lives
 * in {@link Camera3dStore} and the component's signals (oblique tilt, slab,
 * shared drag); this controller is the branchy DOM glue that drives them, kept
 * out of the component. Wired once through {@link init}; provided at the
 * component so its lifetime tracks the viewer.
 */
@Injectable()
export class View3dController {
  private deps: View3dInit | null = null;

  private readonly cam = inject(Camera3dStore);

  /** Wire the controller to the component's 3D state. Called once. */
  init(deps: View3dInit): void {
    this.deps = deps;
  }

  // The 3D pane's view state lives in Camera3dStore; these alias its signals so the
  // template, the render frame and the gesture handlers read them unchanged.
  /** What the 3D pane renders (MIP / MinIP / Average / DVR). */
  readonly projectionMode = this.cam.projectionMode;
  /** The live DVR transfer function, seeded from a preset and then editable. */
  readonly transferFunction = this.cam.transferFunction;
  /** DVR lighting/shading (Blinn–Phong material + posed headlight). */
  readonly dvrLighting = this.cam.dvrLighting;
  /** The selected TF control point (for recolour / removal), or null. */
  readonly tfSelected = this.cam.tfSelected;
  /** When true, clip the 3D pane to the MPR slice planes for a cut-away view. */
  readonly clipToPlanes = this.cam.clipToPlanes;
  /** When true, an arbitrary handle-driven cut-plane clips the 3D pane. */
  readonly clipPlaneEnabled = this.cam.clipPlaneEnabled;
  /** Cut-plane normal in patient space (unit); the kept half is the side it points into. */
  private readonly clipPlaneNormal = this.cam.clipPlaneNormal;
  /** Signed offset (mm) of the cut-plane from the volume centre along its normal. */
  private readonly clipPlaneOffsetMm = this.cam.clipPlaneOffsetMm;

  /** The 3D-mode options offered in the toolbar, in display order. */
  readonly projectionModes = [
    { value: ProjectionMode.Max, label: 'MIP (max)' },
    { value: ProjectionMode.Min, label: 'MinIP (min)' },
    { value: ProjectionMode.Mean, label: 'Average' },
    { value: ProjectionMode.Dvr, label: 'DVR (volume)' },
  ] as const;
  /** Transfer-function presets offered for DVR, in display order. */
  readonly transferFunctions = TRANSFER_FUNCTION_PRESETS;
  /** The preset the editor is currently seeded from, driving the TF selector. */
  readonly transferFunctionPreset = computed(() => this.transferFunction().preset);

  /** The live cut-plane in patient space, or null when the handle is off. */
  readonly cutPlane = computed<PatientPlane | null>(() => {
    const volume = this.deps!.volume();
    if (!this.clipPlaneEnabled() || !volume) return null;
    const normal = this.clipPlaneNormal();
    const c = volumeBounds(volume).center;
    const o = this.clipPlaneOffsetMm();
    const point: Vec3 = [c[0] + normal[0] * o, c[1] + normal[1] * o, c[2] + normal[2] * o];
    return { point, normal };
  });

  /** True when the 3D pane is in direct-volume-rendering mode (drives the UI). */
  readonly isDvrMode = computed(() => isDvr(this.projectionMode()));

  /** Short tag for the 3D pane's current mode (with the cut-away state appended). */
  readonly mode3dTag = computed(() => {
    const label = MODE_TAGS[this.projectionMode()];
    return this.clipToPlanes() ? `${label} ✂` : label;
  });

  /** Whether any MPR pane is currently tilted off its orthogonal default. */
  readonly hasOblique = computed(() =>
    this.deps!.obliques().some((r) => r.tiltU !== 0 || r.tiltV !== 0),
  );

  /** Geometry for the TF editor's SVG: control points, the opacity curve and its fill. */
  readonly tfEditor = computed(() => {
    const tf = this.transferFunction();
    const [lo, hi] = tf.domain;
    const span = hi - lo || 1;
    const points = tf.controlPoints.map((p, index) => ({
      index,
      x: ((p.intensity - lo) / span) * 100,
      y: (1 - p.opacity) * 100,
      color: rgbToHex(p.color),
      intensity: Math.round(p.intensity),
      isEndpoint: index === 0 || index === tf.controlPoints.length - 1,
    }));
    const line = points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
    return { lo, hi, points, line, area: `0,100 ${line} 100,100` };
  });

  /** Hex colour of the selected TF control point, for the colour input. */
  readonly tfSelectedColor = computed(() => {
    const index = this.tfSelected();
    const points = this.transferFunction().controlPoints;
    return index !== null && points[index] ? rgbToHex(points[index].color) : '#ffffff';
  });

  /** Whether the selected TF control point can be removed (interior, ≥ 3 points). */
  readonly tfCanRemove = computed(() => {
    const index = this.tfSelected();
    const points = this.transferFunction().controlPoints;
    return index !== null && index > 0 && index < points.length - 1 && points.length > 2;
  });

  /** Largest valid 3D slab thickness (mm): the volume's full diameter. */
  readonly slabMaxMm = computed(() => {
    const volume = this.deps!.volume();
    return volume ? Math.round(2 * volumeBounds(volume).radius) : 0;
  });

  /** The interactive cut-plane gizmo for the 3D pane, or null unless enabled. */
  readonly clipPlaneGizmo = computed<ClipPlaneGizmoGeometry | null>(() => {
    const d = this.deps!;
    const volume = d.volume();
    if (!this.clipPlaneEnabled() || !d.isReady() || !volume) return null;
    const mip = d.panes().find((pane) => pane.kind === 'mip');
    if (!mip) return null;
    return clipPlaneGizmoGeometry(
      volume,
      d.camera3d(),
      this.clipPlaneNormal(),
      this.clipPlaneOffsetMm(),
      mip.rect,
    );
  });

  /** Anatomical orientation indicator for the 3D pane, or null when no 3D pane. */
  readonly axisIndicator = computed<AxisIndicatorOverlay | null>(() => {
    const d = this.deps!;
    if (!d.isReady()) return null;
    const mip = d.panes().find((pane) => pane.kind === 'mip');
    if (!mip) return null;
    const camera = d.camera3d();
    return axisIndicatorGeometry(mip.rect, camera.azimuth, camera.elevation);
  });

  /** The three MPR cut-planes drawn inside the 3D pane, or null when off. */
  readonly slicePlanes = computed<SlicePlanesOverlay | null>(() => {
    const d = this.deps!;
    const volume = d.volume();
    if (!d.crosshairsEnabled() || !d.isReady() || !volume) return null;
    return buildSlicePlanes(volume, d.panes(), d.camera3d(), d.sliceIndices(), SLICE_PLANE_COLORS);
  });

  /**
   * Map a pointer event over the TF editor to a `[intensity, opacity]` in the
   * transfer function's domain. The editor's viewBox is 0..100 in each axis, with
   * intensity rising left→right across the domain and opacity rising bottom→top.
   */
  private tfEventValue(event: PointerEvent | MouseEvent): [number, number] {
    const svg = (event.currentTarget ?? event.target) as SVGGraphicsElement;
    const rect = svg.getBoundingClientRect();
    const fx = rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0;
    const fy = rect.height > 0 ? clamp((event.clientY - rect.top) / rect.height, 0, 1) : 0;
    const [lo, hi] = this.cam.transferFunction().domain;
    return [lo + fx * (hi - lo), 1 - fy];
  }

  /** Start dragging the TF control point at `index` (and select it). */
  onTfPointerDown(event: PointerEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.cam.beginPointDrag(index);
    const svg = (event.target as SVGElement).ownerSVGElement;
    svg?.setPointerCapture(event.pointerId);
  }

  /** Drag the active TF control point to the pointer's intensity/opacity. */
  onTfPointerMove(event: PointerEvent): void {
    const index = this.cam.tfDrag();
    if (index === null) return;
    const [intensity, opacity] = this.tfEventValue(event);
    this.cam.movePoint(index, intensity, opacity);
    this.deps?.markMipSettling();
  }

  /** Finish a TF control-point drag. */
  onTfPointerUp(event: PointerEvent): void {
    if (this.cam.tfDrag() === null) return;
    this.cam.endPointDrag();
    (event.target as SVGElement).ownerSVGElement?.releasePointerCapture(event.pointerId);
  }

  /** Double-click the TF editor background to insert a control point there. */
  onTfAddPoint(event: MouseEvent): void {
    const [intensity, opacity] = this.tfEventValue(event);
    this.cam.addPoint(intensity, opacity);
    this.deps?.markMipSettling();
  }

  /** Recolour the selected TF control point from the colour input. */
  onTfColorChange(event: Event): void {
    const index = this.cam.tfSelected();
    if (index === null || !(event.target instanceof HTMLInputElement)) return;
    this.cam.recolorPoint(index, hexToRgb(event.target.value));
    this.deps?.markMipSettling();
  }

  /** Remove the selected TF control point (no-op on an endpoint or the last two). */
  onTfRemovePoint(): void {
    const index = this.cam.tfSelected();
    if (index === null) return;
    this.cam.removePoint(index);
    this.deps?.markMipSettling();
  }

  /** Toggle DVR shading on/off (off renders samples at their flat TF colour). */
  toggleShading(): void {
    this.cam.toggleLighting();
    this.deps?.markMipSettling();
  }

  /** Update one numeric DVR lighting parameter from a slider. */
  onLightingInput(key: keyof DvrLighting, event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    this.cam.setLightingValue(key, value);
    this.deps?.markMipSettling();
  }

  /** Toggle the cut-away that clips the 3D pane to the current MPR slice planes. */
  toggleClipToPlanes(): void {
    this.cam.toggleClipToPlanes();
    this.deps?.markMipSettling();
  }

  /** Toggle the arbitrary handle-driven cut-plane, aligning it to the view when enabling. */
  toggleClipPlane(): void {
    this.cam.toggleClipPlane();
    this.deps?.markMipSettling();
  }

  /** Re-aim the cut-plane to face the current view and recentre it on the volume. */
  resetClipPlane(): void {
    this.cam.faceClipToView();
    this.deps?.markMipSettling();
  }

  /** Begin dragging the cut-plane handle to translate the plane along its normal. */
  onClipHandleDown(event: PointerEvent): void {
    const d = this.deps;
    if (!d || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation(); // don't start an orbit under the handle
    const gizmo = this.clipPlaneGizmo();
    const volume = d.volume();
    if (!gizmo || !volume) return;
    const target = event.target as Element;
    target.setPointerCapture?.(event.pointerId);
    d.drag.set({
      kind: 'clipPlane',
      startOffset: this.cam.clipPlaneOffsetMm(),
      startX: event.clientX,
      startY: event.clientY,
      axisX: gizmo.axisX,
      axisY: gizmo.axisY,
      maxOffset: volumeBounds(volume).radius,
    });
  }

  /** Translate the cut-plane to follow the handle drag, clamped within the volume. */
  onClipHandleMove(event: PointerEvent): void {
    const d = this.deps;
    if (!d) return;
    const drag = d.drag();
    if (drag?.kind !== 'clipPlane') return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    // Project the pointer displacement onto the screen-space normal axis to get
    // the offset change in mm (least-squares onto the gizmo's drag direction).
    const len2 = drag.axisX * drag.axisX + drag.axisY * drag.axisY;
    const delta = len2 > 1e-9 ? (dx * drag.axisX + dy * drag.axisY) / len2 : 0;
    this.cam.clipPlaneOffsetMm.set(
      clamp(drag.startOffset + delta, -drag.maxOffset, drag.maxOffset),
    );
    d.markMipSettling();
  }

  /** End a cut-plane handle drag. */
  onClipHandleUp(event: PointerEvent): void {
    const d = this.deps;
    if (!d || d.drag()?.kind !== 'clipPlane') return;
    event.stopPropagation();
    const target = event.target as Element;
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    d.drag.set(null);
  }

  /** Begin dragging an MPR pane's oblique knob to tilt its reslice plane. */
  onObliqueHandleDown(event: PointerEvent, orientation: Orientation): void {
    const d = this.deps;
    if (!d || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation(); // don't start a pan under the knob
    const target = event.target as Element;
    target.setPointerCapture?.(event.pointerId);
    const tilt = d.obliques()[orientation];
    d.drag.set({
      kind: 'oblique',
      orientation,
      startX: event.clientX,
      startY: event.clientY,
      startTiltU: tilt.tiltU,
      startTiltV: tilt.tiltV,
    });
  }

  /** Tilt the plane to follow the knob: horizontal yaws (tiltV), vertical pitches (tiltU). */
  onObliqueHandleMove(event: PointerEvent): void {
    const d = this.deps;
    if (!d) return;
    const drag = d.drag();
    if (drag?.kind !== 'oblique') return;
    event.preventDefault();
    event.stopPropagation();
    const tiltV = clamp(
      drag.startTiltV + (event.clientX - drag.startX) / OBLIQUE_PX_PER_RAD,
      -MAX_OBLIQUE_RAD,
      MAX_OBLIQUE_RAD,
    );
    const tiltU = clamp(
      drag.startTiltU + (event.clientY - drag.startY) / OBLIQUE_PX_PER_RAD,
      -MAX_OBLIQUE_RAD,
      MAX_OBLIQUE_RAD,
    );
    d.obliques.update((obliques) => withOblique(obliques, drag.orientation, { tiltU, tiltV }));
  }

  /** End an oblique knob drag. */
  onObliqueHandleUp(event: PointerEvent): void {
    const d = this.deps;
    if (!d || d.drag()?.kind !== 'oblique') return;
    event.stopPropagation();
    const target = event.target as Element;
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    d.drag.set(null);
  }

  /** Double-click a knob (or the toolbar button) to restore the orthogonal plane. */
  resetOblique(orientation?: Orientation): void {
    const d = this.deps;
    if (!d) return;
    if (orientation === undefined) {
      d.obliques.set(NO_OBLIQUES);
      return;
    }
    d.obliques.update((obliques) => withOblique(obliques, orientation, NO_OBLIQUE));
  }

  /** Switch the 3D pane's mode (MIP / MinIP / Average / DVR), resetting the slab default. */
  onProjectionModeChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const mode = Number(event.target.value) as ProjectionMode;
    this.cam.projectionMode.set(mode);
    // Reset the slab to the mode's default: full-volume for MIP/DVR, a moderate
    // band for MinIP/Average (keeps the air margins out). Reversible across switches.
    this.deps!.slabThicknessMm.set(Math.round(defaultSlabThicknessMm(mode, this.slabMaxMm())));
    this.deps!.markMipSettling();
  }

  /** Re-seed the editable TF from a preset (CT Bone / Soft-tissue / Angio / Lung). */
  onTransferFunctionChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    this.cam.setPreset(Number(event.target.value) as TransferFunctionPreset);
    this.deps!.markMipSettling();
  }

  /** Set the 3D slab thickness (mm), clamped to [1, full volume depth]. */
  onSlabThicknessInput(event: Event): void {
    const d = this.deps;
    if (!d || !(event.target instanceof HTMLInputElement)) return;
    const parsed = Number(event.target.value);
    const value = Number.isFinite(parsed) ? Math.round(parsed) : 0;
    const max = this.slabMaxMm();
    d.slabThicknessMm.set(clamp(value, 1, max > 0 ? max : 1));
    d.markMipSettling();
  }
}
