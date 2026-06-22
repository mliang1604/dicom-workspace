import { Injectable, signal } from '@angular/core';
import type { Vec3 } from '../../dicom/types';
import { viewBasis, type OrbitCamera } from '../../render/camera';
import { DEFAULT_DVR_LIGHTING, type DvrLighting } from '../../render/dvr';
import { ProjectionMode } from '../../render/slice-renderer';
import {
  addControlPoint,
  moveControlPoint,
  removeControlPoint,
  setControlPointColor,
  transferFunction,
  TransferFunctionPreset,
  type TransferFunction,
} from '../../render/transfer-function';

/** The 3D pane's default orbit: a gentle three-quarter view, fit to the volume. */
export const DEFAULT_CAMERA: OrbitCamera = {
  azimuth: 0.4,
  elevation: 0.25,
  zoom: 1,
  panX: 0,
  panY: 0,
};

/**
 * Owns the 3D MIP/DVR pane's view state: the orbit camera, projection mode, the
 * editable DVR transfer function (plus the editor's drag/selection), the DVR
 * lighting, and the cut-plane state (slice-plane clip + the arbitrary handle
 * plane). Holds the signals and the transfer-function / lighting / clip-plane
 * editing logic behind the viewer's `onTf*` and clip handlers; the viewer keeps
 * the gesture math (orbit/zoom, the handle drag onto the screen axis) and feeds
 * results back through these signals.
 *
 * Provided at the component so its lifetime tracks the viewer. The viewer seeds
 * {@link projectionMode} from the persisted preferences and mirrors changes back.
 */
@Injectable()
export class Camera3dStore {
  /** Orbit/zoom state of the 3D MIP pane. */
  readonly camera3d = signal<OrbitCamera>(DEFAULT_CAMERA);

  /**
   * What the 3D pane renders (MIP / MinIP / Average / DVR). Defaults to MIP; the
   * viewer seeds it from the persisted preference at startup before anything reads it.
   */
  readonly projectionMode = signal<ProjectionMode>(ProjectionMode.Max);

  /** The live DVR transfer function, seeded from a preset and then editable. */
  readonly transferFunction = signal<TransferFunction>(
    transferFunction(TransferFunctionPreset.CtBone),
  );

  /** The TF-editor control point being dragged (index), or null. */
  readonly tfDrag = signal<number | null>(null);

  /** The selected TF control point (for recolour / removal), or null. */
  readonly tfSelected = signal<number | null>(null);

  /** DVR lighting/shading (Blinn–Phong material + posed headlight). */
  readonly dvrLighting = signal<DvrLighting>(DEFAULT_DVR_LIGHTING);

  /** When true, clip the 3D pane to the MPR slice planes for a cut-away view. */
  readonly clipToPlanes = signal(false);

  /** When true, an arbitrary handle-driven cut-plane clips the 3D pane. */
  readonly clipPlaneEnabled = signal(false);

  /** Cut-plane normal in patient space (unit); the kept half is the side it points into. */
  readonly clipPlaneNormal = signal<Vec3>([0, -1, 0]);

  /** Signed offset (mm) of the cut-plane from the volume centre along its normal. */
  readonly clipPlaneOffsetMm = signal(0);

  /** Re-seed the editable TF from a preset (CT Bone / Soft-tissue / Angio / Lung). */
  setPreset(preset: TransferFunctionPreset): void {
    this.transferFunction.set(transferFunction(preset));
    this.tfSelected.set(null);
  }

  /** Start dragging the TF control point at `index` (and select it). */
  beginPointDrag(index: number): void {
    this.tfDrag.set(index);
    this.tfSelected.set(index);
  }

  /** Move the TF control point at `index` to a new intensity/opacity. */
  movePoint(index: number, intensity: number, opacity: number): void {
    this.transferFunction.update((tf) => moveControlPoint(tf, index, intensity, opacity));
  }

  /** Finish a TF control-point drag. */
  endPointDrag(): void {
    this.tfDrag.set(null);
  }

  /** Insert a TF control point at the given intensity/opacity (clears the selection). */
  addPoint(intensity: number, opacity: number): void {
    this.transferFunction.update((tf) => addControlPoint(tf, intensity, opacity));
    this.tfSelected.set(null);
  }

  /** Recolour the TF control point at `index`. */
  recolorPoint(index: number, color: readonly [number, number, number]): void {
    this.transferFunction.update((tf) => setControlPointColor(tf, index, color));
  }

  /** Remove the TF control point at `index` (no-op on an endpoint or the last two). */
  removePoint(index: number): void {
    this.transferFunction.update((tf) => removeControlPoint(tf, index));
    this.tfSelected.set(null);
  }

  /** Toggle DVR shading on/off (off renders samples at their flat TF colour). */
  toggleLighting(): void {
    this.dvrLighting.update((l) => ({ ...l, enabled: !l.enabled }));
  }

  /** Update one numeric DVR lighting parameter. */
  setLightingValue(key: keyof DvrLighting, value: number): void {
    this.dvrLighting.update((l) => ({ ...l, [key]: value }));
  }

  /** Toggle the cut-away that clips the 3D pane to the current MPR slice planes. */
  toggleClipToPlanes(): void {
    this.clipToPlanes.update((on) => !on);
  }

  /** Toggle the arbitrary handle-driven cut-plane, aligning it to the view when enabling. */
  toggleClipPlane(): void {
    const enabling = !this.clipPlaneEnabled();
    this.clipPlaneEnabled.set(enabling);
    if (enabling) this.faceClipToView();
  }

  /** Re-aim the cut-plane to face the current view and recentre it on the volume. */
  faceClipToView(): void {
    const { forward } = viewBasis(this.camera3d().azimuth, this.camera3d().elevation);
    // The kept half is the side the normal points into; forward (eye→volume) keeps
    // the far side, so the plane removes the near half facing the camera.
    this.clipPlaneNormal.set(forward);
    this.clipPlaneOffsetMm.set(0);
  }

  /**
   * Reset the per-volume 3D view state on a fresh load: camera, transfer function,
   * DVR lighting, and both clips back to defaults. The projection mode persists
   * across loads (it's a saved preference), so it is intentionally left as-is.
   */
  reset(): void {
    this.camera3d.set(DEFAULT_CAMERA);
    this.transferFunction.set(transferFunction(TransferFunctionPreset.CtBone));
    this.tfSelected.set(null);
    this.dvrLighting.set(DEFAULT_DVR_LIGHTING);
    this.clipToPlanes.set(false);
    this.clipPlaneEnabled.set(false);
    this.clipPlaneOffsetMm.set(0);
  }
}
