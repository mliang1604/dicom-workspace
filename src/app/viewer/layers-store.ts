import { Injectable, signal } from '@angular/core';
import { clamp, clamp01 } from '../../dicom/math';
import { applyLayerOverrides, type Layer, type LayerDisplay } from '../../dicom/types';
import { DEFAULT_CHECKER_CELLS } from '../../render/slice-renderer';
import type { WindowLevel } from '../../render/window-level';

/** Checkerboard density bounds (cells across the image), shared by the slider. */
const CHECKER_CELLS_MIN = 2;
const CHECKER_CELLS_MAX = 20;

/** One layer listed in the layers panel, with its display controls. */
export interface LayerLegendEntry {
  /** The layer's id (see {@link Layer.id}); the `@for` track and override key. */
  readonly id: string;
  /** Human label: the modality, or a fallback when the layer has none. */
  readonly label: string;
  /** Role badge text: 'BASE' or 'OVERLAY'. */
  readonly roleBadge: string;
  /** Whether this is the base underlay (shown without overlay-only controls). */
  readonly isBase: boolean;
  /** Whether the layer is currently composited. */
  readonly visible: boolean;
  /** Composite opacity as a whole percent `[0, 100]`, for the opacity slider. */
  readonly opacityPercent: number;
  /** Selected display: `'grayscale'` or a colormap name, for the `<select>`. */
  readonly displayValue: string;
}

/** Project the composed layers into panel rows (base first), each with its controls. */
export function layerLegend(layers: readonly Layer[]): LayerLegendEntry[] {
  return layers.map((layer) => ({
    id: layer.id,
    label: layer.modality ?? 'Image',
    roleBadge: layer.role === 'base' ? 'BASE' : 'OVERLAY',
    isBase: layer.role === 'base',
    visible: layer.visible,
    opacityPercent: Math.round(layer.opacity * 100),
    displayValue: layer.display.kind === 'grayscale' ? 'grayscale' : layer.display.name,
  }));
}

/**
 * Owns the fusion / layers domain: the per-layer override maps the layers panel
 * and blend bar edit (visibility, composite opacity, display colormap, and the
 * Compare layout's per-column window/level), plus the checkerboard blend state.
 *
 * The store is the single home for these overrides; the viewer feeds it the
 * loaded layer registry through {@link apply} and delegates the panel/blend-bar
 * handlers here. Provided at the component so its lifetime tracks the viewer.
 */
@Injectable()
export class LayersStore {
  /**
   * Layer ids hidden from the layers panel. The base never appears here (it's the
   * underlay); an overlay listed here is dropped from compositing.
   */
  private readonly _hidden = signal<ReadonlySet<string>>(new Set());

  /**
   * Per-layer composite opacity in `[0, 1]` keyed by {@link Layer.id}. A layer
   * absent keeps its registry default; the layers-panel slider and the in-pane
   * blend bar both write here (they edit the same value).
   */
  private readonly _opacities = signal<ReadonlyMap<string, number>>(new Map());

  /**
   * Per-layer display-transform overrides keyed by {@link Layer.id}: the colormap
   * (or grayscale) the layers panel picks for an overlay, overriding the load-time
   * default (RTDOSE → jet).
   */
  private readonly _displays = signal<ReadonlyMap<string, LayerDisplay>>(new Map());

  /**
   * Per-layer window/level overrides keyed by {@link Layer.id}, for the Compare
   * layout's independent per-column windowing. The base layer is never keyed here;
   * an overlay column absent from the map falls back to its volume's default.
   */
  private readonly _windows = signal<ReadonlyMap<string, WindowLevel>>(new Map());

  /** Checkerboard the overlay (alternating cells) instead of a uniform blend. */
  readonly checkerboardEnabled = signal(false);

  /** Checkerboard density in cells across the image (at zoom 1); the slider's value. */
  readonly checkerCells = signal(DEFAULT_CHECKER_CELLS);

  /**
   * Apply the current visibility / opacity / display overrides to the loaded layer
   * registry, producing the composed layers every consumer reads.
   */
  apply(rawLayers: readonly Layer[]): readonly Layer[] {
    return applyLayerOverrides(rawLayers, this._hidden(), this._opacities(), this._displays());
  }

  /** Toggle an overlay layer's visibility (the base underlay is never hidden). */
  toggleVisible(id: string): void {
    this._hidden.update((hidden) => {
      const next = new Set(hidden);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Set a layer's composite opacity from a 0..100 slider value. */
  setOpacity(id: string, percent: number): void {
    const opacity = clamp01(percent / 100);
    this._opacities.update((map) => new Map(map).set(id, opacity));
  }

  /** Set a layer's display transform: grayscale or a named colormap. */
  setDisplay(id: string, display: LayerDisplay): void {
    this._displays.update((map) => new Map(map).set(id, display));
  }

  /**
   * An overlay layer's effective window/level: its per-layer override, or the
   * layer volume's default when none is set. (The base reads the shared window.)
   */
  windowFor(layer: Layer): WindowLevel {
    return (
      this._windows().get(layer.id) ?? {
        center: layer.volume.windowCenter,
        width: layer.volume.windowWidth,
      }
    );
  }

  /** Override an overlay layer's window/level (per Compare column). */
  setWindow(id: string, next: WindowLevel): void {
    this._windows.update((map) => new Map(map).set(id, next));
  }

  /** Toggle compositing the fusion overlay as a checkerboard. */
  toggleCheckerboard(): void {
    this.checkerboardEnabled.update((on) => !on);
  }

  /** Set the checkerboard density (cells across the image), clamped to its bounds. */
  setCheckerCells(cells: number): void {
    this.checkerCells.set(clamp(cells, CHECKER_CELLS_MIN, CHECKER_CELLS_MAX));
  }

  /**
   * Reset the per-layer overrides on a fresh base load (an added overlay starts
   * visible, fully opaque, at its default display and window). The checkerboard
   * blend state is intentionally left as-is, matching the viewer's prior reset.
   */
  reset(): void {
    this._hidden.set(new Set());
    this._opacities.set(new Map());
    this._displays.set(new Map());
    this._windows.set(new Map());
  }
}
