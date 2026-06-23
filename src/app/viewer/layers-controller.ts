import {
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { LayoutMode, blendBarPlacement, type BlendBar, type Vec2 } from '../../render/layout';
import { linkedSliceIndex } from '../../render/reslice';
import { windowPresets, type WindowLevel, type WindowPreset } from '../../render/window-level';
import { COLORMAPS } from '../../render/colormap';
import {
  baseLayer,
  DEFAULT_OVERLAY_OPACITY,
  Orientation,
  type Layer,
  type LayerDisplay,
  type Volume,
} from '../../dicom/types';
import { LayersStore, layerLegend, type LayerLegendEntry } from './layers-store';
import { CompareStore, type GroupNav } from './compare-store';
import { type LoadState } from './load-controller';
import { type PanePlacement } from './pane-placement';
import {
  type PerOrientation,
  type PerOrientationOblique,
  type PerOrientationPan,
} from './viewer-overlays';

/** Component view state the {@link LayersController} reads; wired via {@link LayersController.init}. */
export interface LayersInit {
  readonly load: () => LoadState;
  readonly layoutMode: WritableSignal<LayoutMode>;
  readonly panes: () => readonly PanePlacement[];
  readonly sliceIndices: Signal<PerOrientation>;
  readonly zooms: Signal<PerOrientation>;
  readonly pans: Signal<PerOrientationPan>;
  readonly obliques: Signal<PerOrientationOblique>;
  /** The hovered Compare column index (drives which layer windowing targets). */
  readonly activeCompareGroup: () => number;
  /** Hold the 3D MIP at reduced quality until interaction settles. */
  readonly markMipSettling: () => void;
}

function intValue(event: Event): number {
  if (!(event.target instanceof HTMLInputElement)) return 0;
  const parsed = Number(event.target.value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

/**
 * Owns the layer registry / fusion / Compare domain: the loaded {@link Layer}
 * stack and its base {@link volume}, the active fusion overlay, the shared and
 * per-overlay window/level, the layers-panel + blend-bar + checkerboard controls,
 * and the Compare linked/unlinked per-group slice/zoom/pan resolution. The view
 * tuples it resolves against stay on the component (read through {@link init});
 * this owns the layer + window/level state and the {@link LayersStore} /
 * {@link CompareStore} plumbing. Provided at the component so its lifetime tracks
 * the viewer.
 */
@Injectable()
export class LayersController {
  private readonly layerStore = inject(LayersStore);
  private readonly compareStore = inject(CompareStore);
  private deps: LayersInit | null = null;

  /** Shared base-layer window centre (the overlay reads its own per-layer override). */
  readonly windowCenter = signal(0);
  /** Shared base-layer window width. */
  readonly windowWidth = signal(1);

  /** Compare-layout linking state (aliases the store). */
  readonly compareLinked = this.compareStore.linked;
  /** Per-group independent slice/zoom/pan when unlinked (aliases the store). */
  readonly groupNav = this.compareStore.groupNav;
  /** Checkerboard the overlay instead of a uniform blend (aliases the store). */
  readonly checkerboardEnabled = this.layerStore.checkerboardEnabled;
  /** Checkerboard density in cells across the image (aliases the store). */
  readonly checkerCells = this.layerStore.checkerCells;
  /** Overlay display choices for the layers panel: grayscale plus each colormap. */
  readonly displayOptions = ['grayscale', ...Object.keys(COLORMAPS)];

  /** Wire the controller to the component's load + view state. Called once. */
  init(deps: LayersInit): void {
    this.deps = deps;
  }

  /** The loaded layer registry, or empty until a load succeeds. */
  readonly layers = computed<readonly Layer[]>(() => {
    const state = this.deps!.load();
    if (state.status !== 'ready') return [];
    return this.layerStore.apply(state.result.layers);
  });

  /** The base layer's volume — what reslice, probe, contours, crosshair and capture read. */
  readonly volume = computed<Volume | null>(() => baseLayer(this.layers())?.volume ?? null);

  /** The active fusion overlay: the first visible `'overlay'`-role layer, or null. */
  readonly selectedOverlay = computed<Layer | null>(
    () => this.layers().find((layer) => layer.role === 'overlay' && layer.visible) ?? null,
  );

  /** True in the side-by-side Compare layout (vs. the composited fusion views). */
  readonly isCompare = computed(() => this.deps!.layoutMode() === LayoutMode.Compare);

  /** True in the composited Fusion view (the 3-pane MPR with the overlay blended in). */
  readonly isFusion = computed(() => this.deps!.layoutMode() === LayoutMode.TriMpr);

  /** The layer the window/level controls target (the hovered Compare column's, else base). */
  readonly activeWlLayer = computed<Layer | null>(() => {
    const base = baseLayer(this.layers()) ?? null;
    if (!this.isCompare()) return base;
    const overlay = this.selectedOverlay();
    if (!overlay) return base;
    return this.deps!.activeCompareGroup() >= 1 ? overlay : base;
  });

  /** Resolve a layer's window/level: base reads the shared signals, an overlay its override. */
  layerWindow(layer: Layer | null): WindowLevel {
    if (!layer || layer.role === 'base') {
      return { center: this.windowCenter(), width: this.windowWidth() };
    }
    return this.layerStore.windowFor(layer);
  }

  /** Write a layer's window/level: base updates the shared signals, an overlay its override. */
  setLayerWindow(layer: Layer | null, next: WindowLevel): void {
    if (!layer || layer.role === 'base') {
      this.windowCenter.set(next.center);
      this.windowWidth.set(next.width);
    } else {
      this.layerStore.setWindow(layer.id, next);
    }
  }

  /** The active target's window centre, shown in the WL input. */
  readonly activeWindowCenter = computed(() => this.layerWindow(this.activeWlLayer()).center);
  /** The active target's window width, shown in the WW input. */
  readonly activeWindowWidth = computed(() => this.layerWindow(this.activeWlLayer()).width);

  /** Whether the layers panel applies: more than the lone base layer is loaded. */
  readonly hasLayersPanel = computed(() => this.layers().length > 1);

  /** The layers for the panel, each with its display controls (base first). */
  readonly layerLegend = computed<LayerLegendEntry[]>(() => layerLegend(this.layers()));

  /** Toggle an overlay layer's visibility (the base underlay is never hidden). */
  toggleLayerVisible(id: string): void {
    this.layerStore.toggleVisible(id);
  }

  /** Layers-panel opacity slider for a layer. */
  onLayerOpacity(id: string, event: Event): void {
    this.layerStore.setOpacity(id, Number((event.target as HTMLInputElement).value));
  }

  /** Layers-panel display selector: grayscale or a named colormap for the layer. */
  onLayerDisplay(id: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const display: LayerDisplay =
      value === 'grayscale' ? { kind: 'grayscale' } : { kind: 'colormap', name: value };
    this.layerStore.setDisplay(id, display);
  }

  /** View-mode selector: Fusion (composited 3-pane) vs Compare (side-by-side 6-pane). */
  setViewMode(mode: 'fusion' | 'compare'): void {
    this.deps!.layoutMode.set(mode === 'compare' ? LayoutMode.Compare : LayoutMode.TriMpr);
  }

  /** The volume a Compare group draws: base for group 0, the active overlay otherwise. */
  groupVolume(group: number): Volume | null {
    if (group === 0) return this.volume();
    return this.selectedOverlay()?.volume ?? this.volume();
  }

  /** Whether a Compare group navigates on its own (unlinked, and not the base group). */
  groupIsIndependent(group: number): boolean {
    return this.compareStore.isIndependent(group, this.isCompare());
  }

  /** The slice index a pane shows, resolving linked/unlinked Compare navigation. */
  paneSliceIndex(group: number, orientation: Orientation): number {
    const d = this.deps!;
    const master = d.sliceIndices()[orientation];
    return this.compareStore.resolveSlice(group, orientation, this.isCompare(), master, () => {
      const base = this.volume();
      const target = this.groupVolume(group);
      if (!base || !target) return master;
      return linkedSliceIndex(base, target, orientation, master, d.obliques()[orientation]);
    });
  }

  /** The zoom a pane uses: shared while linked, the group's own when unlinked. */
  paneZoom(group: number, orientation: Orientation): number {
    return this.compareStore.resolveZoom(
      group,
      orientation,
      this.isCompare(),
      this.deps!.zooms()[orientation],
    );
  }

  /** The pan a pane uses: shared while linked, the group's own when unlinked. */
  panePan(group: number, orientation: Orientation): Vec2 {
    return this.compareStore.resolvePan(
      group,
      orientation,
      this.isCompare(),
      this.deps!.pans()[orientation],
    );
  }

  /** Link or unlink the Compare groups (unlinking snapshots the current per-group view). */
  toggleCompareLinked(): void {
    this.compareStore.toggleLinked(() => this.snapshotGroupNav());
  }

  /** Snapshot the current per-group view (while still linked) for unlinked editing. */
  snapshotGroupNav(): GroupNav[] {
    const d = this.deps!;
    return this.compareStore.snapshot(d.zooms(), d.pans(), (group, orientation) =>
      this.paneSliceIndex(group, orientation),
    );
  }

  /** Replace one field of one group's independent nav (used by the unlinked handlers). */
  updateGroupNav(group: number, patch: Partial<GroupNav>): void {
    this.compareStore.updateGroupNav(group, patch);
  }

  /** Whether the fusion controls apply: an overlay is active AND we're compositing. */
  readonly hasOverlay = computed(() => this.selectedOverlay() !== null && !this.isCompare());

  /** Toggle compositing the fusion overlay as a checkerboard. */
  toggleCheckerboard(): void {
    this.layerStore.toggleCheckerboard();
  }

  /** Set the checkerboard density (cells across the image) from the slider, clamped. */
  onCheckerCellsInput(event: Event): void {
    this.layerStore.setCheckerCells(Number((event.target as HTMLInputElement).value));
  }

  /** The active overlay's composite opacity as a 0..100 percentage. */
  readonly blendPercent = computed(() =>
    Math.round((this.selectedOverlay()?.opacity ?? DEFAULT_OVERLAY_OPACITY) * 100),
  );

  /** Placement of the in-pane blend bar over the largest MPR pane, or null. */
  readonly blendBar = computed<BlendBar | null>(() => {
    if (!this.hasOverlay()) return null;
    const mprRects = this.deps!.panes()
      .filter((pane) => pane.kind === 'mpr')
      .map((pane) => pane.rect);
    return blendBarPlacement(mprRects);
  });

  /** Drag/keyboard the blend bar: set the active overlay's opacity from its 0..100 value. */
  onBlendInput(event: Event): void {
    const overlay = this.selectedOverlay();
    if (overlay) {
      this.layerStore.setOpacity(overlay.id, Number((event.target as HTMLInputElement).value));
    }
  }

  /** Window/level presets offered for the active target (base, or the hovered overlay). */
  readonly wlPresets = computed<WindowPreset[]>(() => {
    const volume = this.activeWlLayer()?.volume ?? this.volume();
    return volume ? windowPresets(volume) : [];
  });

  /** Set the active target's window centre from the WL input. */
  onWindowCenterInput(event: Event): void {
    const layer = this.activeWlLayer();
    this.setLayerWindow(layer, { center: intValue(event), width: this.layerWindow(layer).width });
    this.deps!.markMipSettling();
  }

  /** Set the active target's window width from the WW input. */
  onWindowWidthInput(event: Event): void {
    const layer = this.activeWlLayer();
    this.setLayerWindow(layer, {
      center: this.layerWindow(layer).center,
      width: Math.max(1, intValue(event)),
    });
    this.deps!.markMipSettling();
  }

  /** Apply the chosen window/level preset to the active target, then reset the selector. */
  onPresetChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const preset = this.wlPresets()[Number(event.target.value)];
    event.target.selectedIndex = 0; // back to the "Preset…" placeholder so re-picking fires
    if (!preset) return;
    this.setLayerWindow(this.activeWlLayer(), { center: preset.center, width: preset.width });
    this.deps!.markMipSettling();
  }

  /** Reset the layers panel to defaults for a fresh base load. */
  reset(): void {
    this.layerStore.reset();
  }
}
