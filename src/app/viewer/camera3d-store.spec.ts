import { viewBasis } from '../../render/camera';
import { DEFAULT_DVR_LIGHTING } from '../../render/dvr';
import { ProjectionMode } from '../../render/slice-renderer';
import { TransferFunctionPreset } from '../../render/transfer-function';
import { Camera3dStore, DEFAULT_CAMERA } from './camera3d-store';

describe('Camera3dStore defaults', () => {
  it('starts at the default orbit, MIP projection, and no clips', () => {
    const store = new Camera3dStore();
    expect(store.camera3d()).toEqual(DEFAULT_CAMERA);
    expect(store.projectionMode()).toBe(ProjectionMode.Max);
    expect(store.transferFunction().preset).toBe(TransferFunctionPreset.CtBone);
    expect(store.clipToPlanes()).toBe(false);
    expect(store.clipPlaneEnabled()).toBe(false);
    expect(store.dvrLighting()).toEqual(DEFAULT_DVR_LIGHTING);
  });
});

describe('Camera3dStore transfer-function editing', () => {
  it('re-seeds from a preset and clears the selection', () => {
    const store = new Camera3dStore();
    store.tfSelected.set(2);
    store.setPreset(TransferFunctionPreset.CtAngio);
    expect(store.transferFunction().preset).toBe(TransferFunctionPreset.CtAngio);
    expect(store.tfSelected()).toBeNull();
  });

  it('selects a point on drag start and clears the drag on end', () => {
    const store = new Camera3dStore();
    store.beginPointDrag(1);
    expect(store.tfDrag()).toBe(1);
    expect(store.tfSelected()).toBe(1);
    store.endPointDrag();
    expect(store.tfDrag()).toBeNull();
    expect(store.tfSelected()).toBe(1); // selection survives the drag
  });

  it('moves a control point to a new opacity', () => {
    const store = new Camera3dStore();
    const i = 1;
    const intensity = store.transferFunction().controlPoints[i].intensity;
    store.movePoint(i, intensity, 0.123);
    expect(store.transferFunction().controlPoints[i].opacity).toBeCloseTo(0.123, 6);
  });

  it('adds a control point and clears the selection', () => {
    const store = new Camera3dStore();
    store.tfSelected.set(0);
    const before = store.transferFunction().controlPoints.length;
    store.addPoint(0.5, 0.5);
    expect(store.transferFunction().controlPoints.length).toBe(before + 1);
    expect(store.tfSelected()).toBeNull();
  });

  it('removes a control point and clears the selection', () => {
    const store = new Camera3dStore();
    store.addPoint(0.5, 0.5); // ensure an interior point exists to remove
    const before = store.transferFunction().controlPoints.length;
    store.tfSelected.set(1);
    store.removePoint(1);
    expect(store.transferFunction().controlPoints.length).toBe(before - 1);
    expect(store.tfSelected()).toBeNull();
  });

  it('recolours a control point', () => {
    const store = new Camera3dStore();
    store.recolorPoint(1, [0.25, 0.5, 0.75]);
    expect(store.transferFunction().controlPoints[1].color).toEqual([0.25, 0.5, 0.75]);
  });
});

describe('Camera3dStore DVR lighting', () => {
  it('toggles shading on and off', () => {
    const store = new Camera3dStore();
    const before = store.dvrLighting().enabled;
    store.toggleLighting();
    expect(store.dvrLighting().enabled).toBe(!before);
  });

  it('sets a single numeric lighting parameter without disturbing the rest', () => {
    const store = new Camera3dStore();
    const original = store.dvrLighting();
    store.setLightingValue('ambient', 0.42);
    expect(store.dvrLighting().ambient).toBeCloseTo(0.42, 6);
    expect(store.dvrLighting().enabled).toBe(original.enabled); // others untouched
  });
});

describe('Camera3dStore cut-plane', () => {
  it('faces the cut-plane to the current view and recentres it', () => {
    const store = new Camera3dStore();
    store.clipPlaneOffsetMm.set(17);
    store.faceClipToView();
    const { forward } = viewBasis(DEFAULT_CAMERA.azimuth, DEFAULT_CAMERA.elevation);
    expect(store.clipPlaneNormal()).toEqual(forward);
    expect(store.clipPlaneOffsetMm()).toBe(0);
  });

  it('enables the cut-plane facing the view, and only disables on the second toggle', () => {
    const store = new Camera3dStore();
    store.toggleClipPlane();
    expect(store.clipPlaneEnabled()).toBe(true);
    const { forward } = viewBasis(DEFAULT_CAMERA.azimuth, DEFAULT_CAMERA.elevation);
    expect(store.clipPlaneNormal()).toEqual(forward);

    store.clipPlaneOffsetMm.set(5); // a drag moved it
    store.toggleClipPlane();
    expect(store.clipPlaneEnabled()).toBe(false);
    expect(store.clipPlaneOffsetMm()).toBe(5); // disabling leaves the placement alone
  });

  it('toggles the slice-plane cut-away independently', () => {
    const store = new Camera3dStore();
    store.toggleClipToPlanes();
    expect(store.clipToPlanes()).toBe(true);
    expect(store.clipPlaneEnabled()).toBe(false); // the two clips are independent
  });
});

describe('Camera3dStore.reset', () => {
  it('restores the per-volume view defaults but keeps the projection mode', () => {
    const store = new Camera3dStore();
    store.projectionMode.set(ProjectionMode.Dvr); // a saved preference, must persist
    store.camera3d.set({ azimuth: 1, elevation: 1, zoom: 3, panX: 9, panY: 9 });
    store.setPreset(TransferFunctionPreset.CtLung);
    store.toggleLighting();
    store.toggleClipToPlanes();
    store.toggleClipPlane();
    store.clipPlaneOffsetMm.set(12);

    store.reset();

    expect(store.camera3d()).toEqual(DEFAULT_CAMERA);
    expect(store.transferFunction().preset).toBe(TransferFunctionPreset.CtBone);
    expect(store.dvrLighting()).toEqual(DEFAULT_DVR_LIGHTING);
    expect(store.clipToPlanes()).toBe(false);
    expect(store.clipPlaneEnabled()).toBe(false);
    expect(store.clipPlaneOffsetMm()).toBe(0);
    expect(store.projectionMode()).toBe(ProjectionMode.Dvr); // preserved across the load
  });
});
