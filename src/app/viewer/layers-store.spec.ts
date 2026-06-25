import { baseImageLayer, overlayImageLayer, type Layer, type Volume } from '../../dicom/types';
import { LayersStore, layerLegend } from './layers-store';

function makeVolume(modality: string, windowCenter = 40, windowWidth = 400): Volume {
  return {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    data: new Float32Array(8),
    min: 0,
    max: 0,
    windowCenter,
    windowWidth,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality,
    geometry: undefined,
  };
}

/** A two-layer registry: a CT base plus one MR overlay. */
function registry(): readonly Layer[] {
  return [
    baseImageLayer('base', makeVolume('CT')),
    overlayImageLayer('ov', makeVolume('MR', 1000, 2000)),
  ];
}

describe('layerLegend', () => {
  it('projects each layer into a panel row (base first)', () => {
    const rows = layerLegend(registry());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'base',
      roleBadge: 'BASE',
      isBase: true,
      visible: true,
      opacityPercent: 100,
      displayValue: 'grayscale',
    });
    expect(rows[1]).toMatchObject({
      id: 'ov',
      roleBadge: 'OVERLAY',
      isBase: false,
      opacityPercent: 50, // DEFAULT_OVERLAY_OPACITY
      displayValue: 'grayscale',
    });
  });

  it('labels a layer by its modality and reports the chosen colormap', () => {
    const rows = layerLegend([
      overlayImageLayer('dose', makeVolume('RTDOSE')), // RTDOSE defaults to a jet wash
    ]);
    expect(rows[0].label).toBe('RTDOSE');
    expect(rows[0].displayValue).toBe('jet');
  });
});

describe('LayersStore.apply', () => {
  it('returns the layers unchanged when there are no overrides', () => {
    const store = new LayersStore();
    const layers = registry();
    const out = store.apply(layers);
    expect(out[0]).toBe(layers[0]); // same reference — no edits layered on
    expect(out[1]).toBe(layers[1]);
  });

  it('hides an overlay toggled off without touching the base', () => {
    const store = new LayersStore();
    store.toggleVisible('ov');
    const out = store.apply(registry());
    expect(out[0].visible).toBe(true);
    expect(out[1].visible).toBe(false);
    store.toggleVisible('ov'); // toggling again restores it
    expect(store.apply(registry())[1].visible).toBe(true);
  });

  it('applies a composite-opacity override, clamped to [0, 1]', () => {
    const store = new LayersStore();
    store.setOpacity('ov', 30);
    expect(store.apply(registry())[1].opacity).toBeCloseTo(0.3, 6);
    store.setOpacity('ov', 150); // over 100 clamps to fully opaque
    expect(store.apply(registry())[1].opacity).toBe(1);
    store.setOpacity('ov', -10); // below 0 clamps to transparent
    expect(store.apply(registry())[1].opacity).toBe(0);
  });

  it('applies a display-transform override', () => {
    const store = new LayersStore();
    store.setDisplay('ov', { kind: 'colormap', name: 'viridis' });
    expect(store.apply(registry())[1].display).toEqual({ kind: 'colormap', name: 'viridis' });
    // The legend over the composed layers reflects it.
    expect(layerLegend(store.apply(registry()))[1].displayValue).toBe('viridis');
  });
});

describe('LayersStore.windowFor', () => {
  it('falls back to the layer volume default window when unset', () => {
    const store = new LayersStore();
    const overlay = registry()[1];
    expect(store.windowFor(overlay)).toEqual({ center: 1000, width: 2000 });
  });

  it('returns the per-layer override once set', () => {
    const store = new LayersStore();
    const overlay = registry()[1];
    store.setWindow('ov', { center: 50, width: 350 });
    expect(store.windowFor(overlay)).toEqual({ center: 50, width: 350 });
  });
});

describe('LayersStore checkerboard state', () => {
  it('toggles the checkerboard flag', () => {
    const store = new LayersStore();
    expect(store.checkerboardEnabled()).toBe(false);
    store.toggleCheckerboard();
    expect(store.checkerboardEnabled()).toBe(true);
  });

  it('clamps the checkerboard cell count to its bounds', () => {
    const store = new LayersStore();
    store.setCheckerCells(8);
    expect(store.checkerCells()).toBe(8);
    store.setCheckerCells(1); // below min (2)
    expect(store.checkerCells()).toBe(2);
    store.setCheckerCells(99); // above max (30)
    expect(store.checkerCells()).toBe(30);
  });
});

describe('LayersStore.reset', () => {
  it('drops the per-layer overrides and turns the checkerboard back off', () => {
    const store = new LayersStore();
    store.toggleVisible('ov');
    store.setOpacity('ov', 20);
    store.setDisplay('ov', { kind: 'colormap', name: 'jet' });
    store.setWindow('ov', { center: 5, width: 5 });
    store.toggleCheckerboard();

    store.reset();

    const out = store.apply(registry());
    expect(out[1].visible).toBe(true);
    expect(out[1].opacity).toBe(0.5); // back to the overlay default
    expect(out[1].display).toEqual({ kind: 'grayscale' });
    expect(store.windowFor(registry()[1])).toEqual({ center: 1000, width: 2000 });
    // A stale checkerboard no longer carries into a fresh load (#206).
    expect(store.checkerboardEnabled()).toBe(false);
  });
});
