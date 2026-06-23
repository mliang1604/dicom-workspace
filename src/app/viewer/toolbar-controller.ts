import { Injectable, inject, type Signal, type WritableSignal } from '@angular/core';
import { LayoutMode, scaleRect } from '../../render/layout';
import { PreferencesStore } from '../preferences-store';
import { oneToOneZoom, type SliceRenderer } from '../../render/slice-renderer';
import { clamp } from '../../dicom/math';
import { Orientation, type Volume } from '../../dicom/types';
import { CaptureController } from './capture-controller';
import { CineStore } from './cine-store';
import { LayersController } from './layers-controller';
import { MeasurementStore } from './measurement-store';
import { RenderController } from './render-controller';
import { View3dController } from './view3d-controller';
import { isEditableTarget, releaseSelectFocus } from './viewer-dom';
import { nextCineIndex } from './viewer-format';
import { paneKeyOf, type PanePlacement } from './pane-placement';
import { type ToolMode } from './measure-controller';
import { type PerOrientation, type PerOrientationPan } from './viewer-overlays';

const NO_PAN = { x: 0, y: 0 } as const;
const NO_PANS: PerOrientationPan = [NO_PAN, NO_PAN, NO_PAN];
const ORIENTATION_ORDER = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal] as const;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 20;

/** One entry per orientation, updated immutably by {@link withValue}. */
function withValue<T>(values: readonly [T, T, T], orientation: Orientation, value: T): [T, T, T] {
  const next: [T, T, T] = [...values];
  next[orientation] = value;
  return next;
}

/** The layout options the cycle button steps through, in display order. */
export const LAYOUT_MODES = [
  { value: LayoutMode.TriMpr, label: '3-pane MPR' },
  { value: LayoutMode.Quad, label: '4-pane' },
  { value: LayoutMode.Compare, label: 'Compare' },
  { value: LayoutMode.Volume3d, label: '3D only' },
] as const;

/** Component state the {@link ToolbarController} reads/writes; wired via {@link ToolbarController.init}. */
export interface ToolbarInit {
  readonly renderer: () => SliceRenderer | null;
  readonly isReady: () => boolean;
  readonly hasMprPane: () => boolean;
  readonly panes: () => readonly PanePlacement[];
  readonly volume: () => Volume | null;
  readonly viewportDpr: () => number;
  readonly hoveredKey: () => string | null;
  readonly layoutMode: WritableSignal<LayoutMode>;
  readonly mainOrientation: WritableSignal<Orientation>;
  readonly sagittalFlipped: WritableSignal<boolean>;
  readonly crosshairsEnabled: WritableSignal<boolean>;
  readonly invert: WritableSignal<boolean>;
  readonly helpOpen: WritableSignal<boolean>;
  readonly infoPanelOpen: WritableSignal<boolean>;
  readonly rawTagFilter: WritableSignal<string>;
  readonly zooms: WritableSignal<PerOrientation>;
  readonly pans: WritableSignal<PerOrientationPan>;
  readonly sliceIndices: WritableSignal<PerOrientation>;
  readonly slabThicknessMm: () => number;
  /** The modal help panel element, for focus management. */
  readonly helpPanel: () => HTMLElement | undefined;
  /** The active measurement tool (read + write), for the Escape teardown. */
  readonly activeTool: WritableSignal<ToolMode>;
  /** Toggle the study-history panel's collapsed state (the `H` hotkey). */
  readonly toggleHistory: () => void;
}

/**
 * Owns the toolbar / keyboard view actions: the layout cycle and main-pane swap,
 * the sagittal-flip / crosshair / invert / help / info toggles, the zoom-to-fit
 * and native-scale fits, the full view reset, the cine playback driver, and the
 * screenshot / rotation-capture triggers. The view signals it mutates stay on the
 * component (read/written through {@link init}); this is the branchy action glue.
 * Provided at the component so its lifetime tracks the viewer.
 */
@Injectable()
export class ToolbarController {
  constructor(
    private readonly cine: CineStore,
    private readonly capture: CaptureController,
    private readonly layersCtl: LayersController,
    private readonly render: RenderController,
    private readonly view3d: View3dController,
  ) {}

  private readonly preferencesStore = inject(PreferencesStore);
  private readonly measure = inject(MeasurementStore);
  private deps: ToolbarInit | null = null;
  /** The control focused before the help modal opened, restored when it closes. */
  private helpReturnFocus: HTMLElement | null = null;

  /**
   * The single code path for every keyboard shortcut bar Escape: the single-letter
   * actions, the viewport fits and the help overlay. Reads {@link KeyboardEvent.key}
   * and case-folds it so Shift / Caps Lock still match, behind one editable-target
   * focus guard so shortcuts are suppressed while typing in a field.
   */
  onShortcutKey(event: KeyboardEvent): void {
    const d = this.deps!;
    if (isEditableTarget(event.target) || !d.isReady()) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    switch (key) {
      case 'x':
        event.preventDefault();
        this.swapMain();
        break;
      case 'f':
        event.preventDefault();
        this.toggleSagittalFlip();
        break;
      case 'c':
        event.preventDefault();
        this.toggleCrosshairs();
        break;
      case 'p':
        if (!d.hasMprPane()) return;
        event.preventDefault();
        this.toggleCine();
        break;
      case 'l':
        event.preventDefault();
        this.cycleLayout();
        break;
      case 'i':
        event.preventDefault();
        this.toggleInfoPanel();
        break;
      case 'r':
        event.preventDefault();
        this.resetView();
        break;
      case 'v':
        event.preventDefault();
        this.toggleInvert();
        break;
      case 'h':
        event.preventDefault();
        d.toggleHistory();
        break;
      case '?':
        event.preventDefault();
        this.toggleHelp();
        break;
      case '0':
        if (!d.hasMprPane()) return;
        event.preventDefault();
        this.fitView();
        break;
      case '1':
        if (!d.hasMprPane()) return;
        event.preventDefault();
        this.oneToOne();
        break;
    }
  }

  /** Return focus to the document after a `<select>` is changed (issue #175). */
  onControlChange(event: Event): void {
    releaseSelectFocus(event.target);
  }

  /**
   * Escape closes the open overlays (help, then metadata), then cancels an
   * in-progress measurement, then deactivates the tool — most-modal first.
   */
  onEscapeKey(event: Event): void {
    const d = this.deps!;
    if (isEditableTarget(event.target)) return;
    if (d.helpOpen()) {
      d.helpOpen.set(false);
      return;
    }
    if (d.infoPanelOpen()) {
      d.infoPanelOpen.set(false);
      return;
    }
    if (this.measure.pending()) {
      this.measure.cancelPending();
      return;
    }
    if (d.activeTool() !== 'none') d.activeTool.set('none');
  }

  /**
   * Mirror the curated view preferences into persistent storage whenever they
   * change. Gated on a loaded volume so the window/level and slab never persist
   * their placeholder pre-load values; the store skips redundant writes.
   */
  persistPreferences(): void {
    const d = this.deps!;
    if (!d.isReady()) return;
    this.preferencesStore.update({
      layoutMode: d.layoutMode(),
      projectionMode: this.view3d.projectionMode(),
      sagittalFlipped: d.sagittalFlipped(),
      windowCenter: this.layersCtl.windowCenter(),
      windowWidth: this.layersCtl.windowWidth(),
      slabThicknessMm: d.slabThicknessMm(),
    });
  }

  /**
   * Focus management for the modal shortcut help: move focus into the panel when
   * it opens (so keyboard/AT users land inside it) and restore it to the trigger
   * when it closes. Focus is moved, not trapped — Tab still reaches the chrome.
   */
  manageHelpFocus(): void {
    const d = this.deps!;
    const panel = d.helpPanel();
    if (d.helpOpen()) {
      if (panel && this.helpReturnFocus === null) {
        this.helpReturnFocus = document.activeElement as HTMLElement | null;
        panel.focus();
      }
    } else if (this.helpReturnFocus) {
      this.helpReturnFocus.focus();
      this.helpReturnFocus = null;
    }
  }

  /** Wire the controller to the component's view state. Called once. */
  init(deps: ToolbarInit): void {
    this.deps = deps;
  }

  orientationName(orientation: Orientation): string {
    switch (orientation) {
      case Orientation.Axial:
        return 'Axial';
      case Orientation.Coronal:
        return 'Coronal';
      case Orientation.Sagittal:
        return 'Sagittal';
      default: {
        const exhaustive: never = orientation;
        return exhaustive;
      }
    }
  }

  paneSliceLabel(orientation: Orientation): string {
    const renderer = this.deps!.renderer();
    const count = renderer ? renderer.sliceCount(orientation) : 0;
    return count > 0 ? `${this.deps!.sliceIndices()[orientation] + 1} / ${count}` : '–';
  }

  /** Step the viewport to the next layout (3-pane → 4-pane → 3D-only → …). */
  cycleLayout(): void {
    this.cine.stop(); // the cined pane may move or vanish in the new layout
    this.deps!.layoutMode.update((mode) => {
      const i = LAYOUT_MODES.findIndex((m) => m.value === mode);
      return LAYOUT_MODES[(i + 1) % LAYOUT_MODES.length].value;
    });
  }

  swapMain(): void {
    this.cine.stop(); // swapping reshuffles the panes, so stop the cined one
    this.deps!.mainOrientation.update((current) => {
      const next = (ORIENTATION_ORDER.indexOf(current) + 1) % ORIENTATION_ORDER.length;
      return ORIENTATION_ORDER[next];
    });
  }

  toggleSagittalFlip(): void {
    this.deps!.sagittalFlipped.update((flipped) => !flipped);
  }

  toggleCrosshairs(): void {
    this.deps!.crosshairsEnabled.update((enabled) => !enabled);
  }

  /** Zoom-to-fit every MPR pane: the letterbox fit (zoom 1) with no pan. */
  fitView(): void {
    const d = this.deps!;
    d.zooms.set([1, 1, 1]);
    d.pans.set(NO_PANS);
    // Fit unlinked groups too, keeping each group's own slice level.
    if (this.layersCtl.isCompare() && !this.layersCtl.compareLinked()) {
      this.layersCtl.groupNav.update((navs) =>
        navs.map((nav) => ({ ...nav, zooms: [1, 1, 1], pans: NO_PANS })),
      );
    }
  }

  /** Show each MPR pane at native voxel scale (1:1), centred (pan reset). */
  oneToOne(): void {
    const d = this.deps!;
    const volume = this.layersCtl.volume();
    if (!volume) return;
    const dpr = d.viewportDpr();
    let zooms = d.zooms();
    let pans = d.pans();
    for (const pane of d.panes()) {
      if (pane.kind !== 'mpr') continue;
      const rect = scaleRect(pane.rect, dpr);
      if (rect.width < 1 || rect.height < 1) continue;
      const independent = this.layersCtl.groupIsIndependent(pane.group);
      const paneVolume = independent ? this.layersCtl.groupVolume(pane.group) : volume;
      if (!paneVolume) continue;
      const zoom = clamp(
        oneToOneZoom(paneVolume, pane.orientation, rect.width, rect.height),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      if (independent) {
        const nav = this.layersCtl.groupNav()[pane.group];
        if (!nav) continue;
        this.layersCtl.updateGroupNav(pane.group, {
          zooms: withValue(nav.zooms, pane.orientation, zoom),
          pans: withValue(nav.pans, pane.orientation, NO_PAN),
        });
      } else {
        zooms = withValue(zooms, pane.orientation, zoom);
        pans = withValue(pans, pane.orientation, NO_PAN);
      }
    }
    d.zooms.set(zooms);
    d.pans.set(pans);
  }

  /** Reset the view to its defaults: fit, clear invert/oblique, restore window/level. */
  resetView(): void {
    this.fitView();
    this.deps!.invert.set(false);
    this.view3d.resetOblique();
    const volume = this.layersCtl.volume();
    if (!volume) return;
    this.layersCtl.windowCenter.set(Math.round(volume.windowCenter));
    this.layersCtl.windowWidth.set(Math.max(1, Math.round(volume.windowWidth)));
    this.render.markMipSettling();
  }

  /** Toggle the display grayscale inversion (white ⇄ black) across every pane. */
  toggleInvert(): void {
    this.deps!.invert.update((on) => !on);
    this.render.markMipSettling();
  }

  /** Open/close the keyboard-shortcut help overlay. */
  toggleHelp(): void {
    this.deps!.helpOpen.update((open) => !open);
  }

  /** Open/close the metadata & raw-tag inspector panel. */
  toggleInfoPanel(): void {
    this.deps!.infoPanelOpen.update((open) => !open);
  }

  onRawTagFilterInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.deps!.rawTagFilter.set(event.target.value);
  }

  /** Save a PNG of the active pane; the export plumbing lives in the capture controller. */
  captureScreenshot(): void {
    this.capture.screenshot();
  }

  /** Record a 360° spin of the 3D pane to WebM; orchestrated by the capture controller. */
  captureRotation(): void {
    this.capture.recordRotation();
  }

  /** Start or stop cine playback, cining the hovered MPR pane (else the main pane). */
  toggleCine(): void {
    this.cine.toggle(() => {
      const d = this.deps!;
      if (!d.isReady() || !d.hasMprPane()) return null;
      return { orientation: this.cinePaneOrientation(), advance: (o) => this.cineTick(o) };
    });
  }

  /** Change the cine speed; the store re-arms a running timer so it takes effect at once. */
  onCineFpsChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    this.cine.setFps(Number(event.target.value));
  }

  /** Advance the given orientation's pane by one slice, looping at the ends. */
  private cineTick(orientation: Orientation): void {
    const renderer = this.deps!.renderer();
    if (!renderer) return;
    const count = renderer.sliceCount(orientation);
    this.deps!.sliceIndices.update((indices) =>
      withValue(indices, orientation, nextCineIndex(indices[orientation], count, 1)),
    );
  }

  /** The orientation cine should drive: the hovered MPR pane's, else the main pane's. */
  private cinePaneOrientation(): Orientation {
    const d = this.deps!;
    const hovered = d.hoveredKey();
    for (const pane of d.panes()) {
      if (pane.kind === 'mpr' && paneKeyOf(pane) === hovered) return pane.orientation;
    }
    return d.mainOrientation();
  }

  /** A short view tag for a capture filename: an orientation name, or `3d`. */
  paneViewTag(pane: PanePlacement): string {
    return pane.kind === 'mip' ? '3d' : this.orientationName(pane.orientation).toLowerCase();
  }
}
