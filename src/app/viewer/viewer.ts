import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { LayoutMode, scaleRect, type Vec2 } from '../../render/layout';
import { SliceRenderer } from '../../render/slice-renderer';
import { NO_OBLIQUE } from '../../render/reslice';
import { Orientation } from '../../dicom/types';
import { clamp } from '../../dicom/math';
import { RecentStore } from '../recent-store';
import { PreferencesStore } from '../preferences-store';
import { modifierLabel } from '../platform';
import { MeasurementStore } from './measurement-store';
import { LayersStore } from './layers-store';
import { Camera3dStore } from './camera3d-store';
import { CineStore } from './cine-store';
import { CompareStore } from './compare-store';
import { LoadCoordinator, type DropIntent } from './load-coordinator';
import { pickCaptureTarget } from './capture';
import { CaptureController, type ScreenshotTarget } from './capture-controller';
import { InteractionController, type Drag } from './interaction-controller';
import { View3dController } from './view3d-controller';
import { LoadController, type LoadState } from './load-controller';
import { MeasureController, type ToolMode } from './measure-controller';
import { RenderController } from './render-controller';
import { RoiController } from './roi-controller';
import { LayersController } from './layers-controller';
import { ToolbarController, LAYOUT_MODES } from './toolbar-controller';
import { StatusController } from './status-controller';
import { RangeFill } from './range-fill';
import { HistoryPanel } from './history-panel/history-panel';
import { placePanes, placementAt, type PanePlacement } from './pane-placement';
import { downloadBlob, dropHeadlineText } from './viewer-dom';
import { paneKeyOf } from './pane-placement';
import { SHORTCUTS, MEASURE_TOOLS, CINE_FPS_OPTIONS } from './viewer-consts';
import {
  type PerOrientation,
  type PerOrientationOblique,
  type PerOrientationPan,
} from './viewer-overlays';

/** Re-exported for templates/specs; the drop-intent policy lives in the load coordinator. */
export type { DropIntent } from './load-coordinator';
export { placePanes, placementAt, withinRect, type PanePlacement } from './pane-placement';
export {
  buildRoiLegend,
  groupRoiLegend,
  allRoiKeys,
  type RoiLegendEntry,
  type RoiLegendGroup,
} from './roi-legend';
export {
  formatProbe,
  polylineOf,
  loadingText,
  filterRawTags,
  nextCineIndex,
  missingSliceWarning,
} from './viewer-format';
export { dropIntentOf, dropHeadlineText, isEditableTarget, releaseSelectFocus } from './viewer-dom';

const NO_PAN: Vec2 = { x: 0, y: 0 };
const NO_PANS: PerOrientationPan = [NO_PAN, NO_PAN, NO_PAN];

const NO_OBLIQUES: PerOrientationOblique = [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE];

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 20;

@Component({
  selector: 'app-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RangeFill, HistoryPanel],
  providers: [
    MeasurementStore,
    LayersStore,
    Camera3dStore,
    CineStore,
    CompareStore,
    LoadCoordinator,
    CaptureController,
    InteractionController,
    View3dController,
    LoadController,
    MeasureController,
    RenderController,
    RoiController,
    LayersController,
    ToolbarController,
    StatusController,
  ],
  templateUrl: './viewer.html',
  styleUrl: './viewer.css',
  host: {
    '(window:keydown.escape)': 'toolbar.onEscapeKey($event)',
    // Every single-letter and viewport shortcut goes through one handler that reads
    // event.key itself and case-folds it. Angular's per-key bindings (keydown.x)
    // match event.key exactly, so Shift / Caps Lock (reported as 'X') would silently
    // miss; and they'd need a separate focus guard from the digit/'?' shortcuts.
    '(window:keydown)': 'toolbar.onShortcutKey($event)',
    // Picking from a <select> leaves it focused, so isEditableTarget swallows every
    // subsequent shortcut until the user clicks away. Release that focus on change
    // (the event bubbles to window) so the keyboard works straight after a pick.
    '(window:change)': 'toolbar.onControlChange($event)',
  },
})
export class Viewer {
  /** Owns the screenshot / rotation-capture export domain; wired in the constructor. */
  private readonly capture = inject(CaptureController);
  /** Owns the canvas pointer/drag/wheel state machine; wired in the constructor. */
  protected readonly interaction = inject(InteractionController);
  /** Owns the 3D-pane editing gestures (TF / clip / oblique / slab); wired in the constructor. */
  protected readonly view3d = inject(View3dController);
  /** Owns the load/import flow (drop overlay, pickers, resolve→apply); wired in the constructor. */
  protected readonly loadCtl = inject(LoadController);
  /** Owns the measurement-tool gestures and Shift+click focus picks; wired in the constructor. */
  protected readonly measureCtl = inject(MeasureController);
  /** Owns the WebGPU lifecycle + per-frame submission pipeline; wired in the constructor. */
  private readonly render = inject(RenderController);
  /** Owns the RTSTRUCT structures domain (ROI state, legend, contours, surfaces); wired in the constructor. */
  protected readonly roiCtl = inject(RoiController);
  /** Owns the layer registry / fusion / Compare domain (volume, window/level, blend); wired in the constructor. */
  protected readonly layersCtl = inject(LayersController);
  /** Owns the toolbar / keyboard view actions (layout, fit, reset, cine, capture); wired in the constructor. */
  protected readonly toolbar = inject(ToolbarController);
  /** Owns the read-only status / series / metadata derivations; wired in the constructor. */
  protected readonly status = inject(StatusController);
  private readonly recentStore = inject(RecentStore);
  private readonly preferencesStore = inject(PreferencesStore);
  /** 3D pane view state (camera / DVR / TF / clip); provided per-component (see providers). */
  private readonly cam = inject(Camera3dStore);
  /** Preferences restored at startup; seed the view signals and per-load defaults. */
  private readonly initialPrefs = this.preferencesStore.preferences();

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  /** The history panel, so the `H` hotkey can toggle its collapsed state. */
  private readonly historyPanel = viewChild(HistoryPanel);

  private readonly renderer = signal<SliceRenderer | null>(null);
  private readonly load = signal<LoadState>({ status: 'idle' });
  private readonly gpuError = signal<string | null>(null);
  /** Canvas size in CSS pixels plus the device-pixel ratio; drives layout + render. */
  private readonly viewport = signal({ width: 0, height: 0, dpr: 1 });

  private readonly sliceIndices = signal<PerOrientation>([0, 0, 0]);
  private readonly zooms = signal<PerOrientation>([1, 1, 1]);
  /** Per-orientation pan offset in screen-uv units; drives shader + probe. */
  private readonly pans = signal<PerOrientationPan>(NO_PANS);
  /**
   * Per-orientation oblique tilt; {@link NO_OBLIQUE} (the default) reslices the
   * orthogonal anatomical plane, a non-zero tilt an arbitrary oblique plane. Set
   * by the rotation knob and read by the reslice, probe, crosshair and reference
   * lines so every pane and overlay shares one tilt.
   */
  private readonly obliques = signal<PerOrientationOblique>(NO_OBLIQUES);
  /** Orbit/zoom state of the 3D MIP pane (aliases Camera3dStore for the frame composer). */
  private readonly camera3d = this.cam.camera3d;
  /**
   * Thick-slab thickness (mm) for the 3D pane, centred on the volume along the
   * view direction. Defaults to the volume's full depth (whole-volume projection).
   */
  protected readonly slabThicknessMm = signal(0);
  /**
   * The in-progress drag (pan / orbit / window-level / gizmo), or null when no
   * button is held. Owned by the {@link interaction} controller, which runs the
   * pointer/wheel state machine; the in-pane gizmo handlers here share it.
   */
  private readonly drag = this.interaction.drag;
  /**
   * True briefly after a wheel-zoom or window/level change so the MIP renders at
   * reduced quality; cleared by a {@link MIP_SETTLE_MS} timeout for the final
   * full-quality frame. Orbit interaction is read from {@link drag} directly.
   */
  private readonly mipSettling = signal(false);
  protected readonly isPanning = computed(() => this.drag() !== null);
  protected readonly mainOrientation = signal<Orientation>(Orientation.Axial);
  /** When true, the sagittal view is mirrored so anterior sits on the right. */
  protected readonly sagittalFlipped = signal(this.initialPrefs.sagittalFlipped);
  /** Shared focus voxel set by Shift+click, navigated to in every pane; null until set. */
  private readonly focusVoxel = signal<readonly [number, number, number] | null>(null);
  /** When true (default), draw the linked crosshair at the focus voxel in each MPR pane. */
  protected readonly crosshairsEnabled = signal(true);
  /**
   * When true, invert the displayed grayscale (white ⇄ black) after windowing.
   * A user-facing toggle, separate from the MONOCHROME1 sense already folded into
   * the volume at load — this flips whatever is shown, in every pane.
   */
  protected readonly invert = signal(false);
  /** True while a 3D rotation capture is recording; disables the export controls. */
  protected readonly recordingRotation = this.capture.recordingRotation;
  /** Whether the 3D rotation capture is available (3D pane shown + WebM support). */
  protected readonly canRecordRotation = computed(
    () => this.isReady() && this.has3dPane() && this.capture.recordingMimeType !== null,
  );

  /** Whether the keyboard-shortcut help overlay is open. */
  protected readonly helpOpen = signal(false);
  /** The modal help panel, so the toolbar controller can move focus into it on open. */
  private readonly helpPanelRef = viewChild<ElementRef<HTMLElement>>('helpPanel');
  /** The shortcuts listed in the help overlay, in display order. */
  protected readonly shortcuts = SHORTCUTS;
  /** Cine playback state/logic; provided per-component (see providers). */
  private readonly cine = inject(CineStore);
  // Cine state lives in CineStore; these alias its signals so the template reads
  // them unchanged.
  /** True while cine playback is auto-advancing slices through a pane. */
  protected readonly cinePlaying = this.cine.isPlaying;
  /** Cine playback speed in frames per second. */
  protected readonly cineFps = this.cine.fps;
  /** The fps options offered in the cine speed selector, in display order. */
  protected readonly cineFpsOptions = CINE_FPS_OPTIONS;
  /** The active measurement tool, or `none` for the default pan/orbit gestures. */
  protected readonly activeTool = signal<ToolMode>('none');
  /** Measurement / ROI-tool state and logic; provided per-component (see providers). */
  private readonly measure = inject(MeasurementStore);
  /** The measurement tools offered in the palette, in display order. */
  protected readonly measureTools = MEASURE_TOOLS;
  /** Whether any measurement (placed or in-progress) exists, for the Clear button. */
  protected readonly hasMeasurements = this.measure.hasMeasurements;
  /**
   * The Compare column the toolbar window/level controls (preset selector, WL/WW
   * inputs) target: the index of the last MPR pane hovered. Sticky — it survives
   * the pointer moving off the panes onto the toolbar, so the controls keep
   * editing the column you were over rather than snapping back to the base. Only
   * meaningful in {@link LayoutMode.Compare}; reset on a fresh load.
   */
  private readonly activeCompareGroup = signal(0);
  /** Key of the hovered pane (see {@link paneKey}), or null when away. */
  protected readonly hoveredKey = signal<string | null>(null);
  /** True while files are being dragged over the viewport, for the drop overlay. */
  protected readonly isDraggingFiles = signal(false);
  /**
   * What releasing the current drag will do, from the modifier held over the
   * viewport (⌥ fuse / ⇧ compare / plain primary). Tracked live off `dragover` so
   * the drop overlay's hint follows the key as it's pressed or released mid-drag.
   */
  protected readonly dropIntent = signal<DropIntent>('primary');
  /**
   * Whether the in-progress drag is a history-panel series chip (vs. dropped
   * files). A chip drop replaces the view; a plain file drop only catalogues into
   * the history (#241), so the drop-overlay headline reads differently for each.
   */
  protected readonly draggingSeries = signal(false);
  /** The drop-overlay headline for the modifier held and the drag's kind (see {@link dropIntent}). */
  protected readonly dropHeadline = computed(() =>
    dropHeadlineText(this.dropIntent(), this.draggingSeries()),
  );
  /**
   * Host-adapted modifier labels for the drop-hint spans — macOS glyphs (`⌥`,
   * `⇧`) on a Mac, words (`Alt`, `Shift`) elsewhere — so the hint reads as the
   * user's own keyboard does. Detection still keys off `altKey`/`shiftKey`.
   */
  protected readonly altLabel = modifierLabel('alt');
  protected readonly shiftLabel = modifierLabel('shift');
  /**
   * A transient status notice shown over the viewport — e.g. a ⌥/⇧ drop that
   * couldn't fuse — auto-cleared after {@link NOTICE_MS}. Null when none is up.
   */
  protected readonly notice = signal<string | null>(null);
  /** The recent loads, most recent first, surfaced for the toolbar re-pick list. */
  protected readonly recent = this.recentStore.entries;
  /** Cursor position in CSS pixels relative to the canvas, or null when away. */
  private readonly cursor = signal<{ readonly x: number; readonly y: number } | null>(null);

  protected readonly isReady = computed(
    () => this.load().status === 'ready' && this.renderer() !== null,
  );

  /** Whether the metadata / tag inspector panel is open. */
  protected readonly infoPanelOpen = signal(false);
  /** Case-insensitive filter typed into the raw-tag search box. */
  protected readonly rawTagFilter = signal('');

  /** The selected viewport layout; defaults to the classic 3-pane MPR (1+2) view. */
  protected readonly layoutMode = signal<LayoutMode>(this.initialPrefs.layoutMode);
  /** Human label for the current layout, shown on the cycle button. */
  protected readonly layoutLabel = computed(
    () => LAYOUT_MODES.find((m) => m.value === this.layoutMode())?.label ?? '',
  );

  /** Pane placements in CSS pixels, for the label overlay. */
  protected readonly panes = computed<PanePlacement[]>(() => {
    const { width, height } = this.viewport();
    return placePanes(this.layoutMode(), width, height, this.mainOrientation());
  });

  /** Whether the current layout includes the 3D pane (drives 3D-control enablement). */
  protected readonly has3dPane = computed(() => this.panes().some((pane) => pane.kind === 'mip'));
  /** Whether the current layout includes any MPR pane (drives swap/flip enablement). */
  protected readonly hasMprPane = computed(() => this.panes().some((pane) => pane.kind === 'mpr'));

  constructor() {
    // Seed the 3D pane's projection mode from the persisted preference before any
    // effect or the template reads it (the store defaults to MIP otherwise).
    this.cam.projectionMode.set(this.initialPrefs.projectionMode);

    // Wire the capture controller to the renderer/canvas/camera through lazy
    // callbacks so it owns the export plumbing without reaching into the component.
    this.capture.init({
      renderer: () => this.renderer(),
      canvas: () => this.canvasRef().nativeElement,
      isReady: () => this.isReady(),
      screenshotTarget: () => this.screenshotTarget(),
      canRecordRotation: () => this.canRecordRotation(),
      composeViews: () => this.render.composeViews(),
      presentViews: (views) => this.render.present(views),
      camera: this.camera3d,
      naming: () =>
        this.status.seriesList().find((s) => s.uid === this.status.selectedSeriesUid()) ?? null,
      now: () => new Date(),
      download: downloadBlob,
    });

    // Wire the interaction controller to the panes / per-orientation view tuples
    // and the 3D camera through lazy callbacks, the same way: it owns the pointer/
    // wheel state machine without reaching into the component's signals directly.
    this.interaction.init({
      isReady: () => this.isReady(),
      panes: () => this.panes(),
      canvas: () => this.canvasRef().nativeElement,
      placementAt: (event) => this.placementAtEvent(event),
      paneKey: (pane) => this.paneKey(pane),
      volume: () => this.layersCtl.volume(),
      groupVolume: (group) => this.layersCtl.groupVolume(group),
      groupIsIndependent: (group) => this.layersCtl.groupIsIndependent(group),
      paneZoom: (group, orientation) => this.layersCtl.paneZoom(group, orientation),
      panePan: (group, orientation) => this.layersCtl.panePan(group, orientation),
      masterSliceIndex: (orientation) => this.sliceIndices()[orientation],
      groupSliceIndex: (group, orientation) => this.layersCtl.paneSliceIndex(group, orientation),
      setMasterPan: (orientation, pan) =>
        this.pans.update((pans) => withValue(pans, orientation, pan)),
      setMasterZoom: (orientation, zoom) =>
        this.zooms.update((zooms) => withValue(zooms, orientation, zoom)),
      setMasterSlice: (orientation, index) =>
        this.sliceIndices.update((indices) => withValue(indices, orientation, index)),
      setGroupPan: (group, orientation, pan) => {
        const nav = this.layersCtl.groupNav()[group];
        if (nav)
          this.layersCtl.updateGroupNav(group, { pans: withValue(nav.pans, orientation, pan) });
      },
      setGroupZoomPan: (group, orientation, zoom, pan) => {
        const nav = this.layersCtl.groupNav()[group];
        if (nav)
          this.layersCtl.updateGroupNav(group, {
            zooms: withValue(nav.zooms, orientation, zoom),
            pans: withValue(nav.pans, orientation, pan),
          });
      },
      setGroupSlice: (group, orientation, index) => {
        const nav = this.layersCtl.groupNav()[group];
        if (nav)
          this.layersCtl.updateGroupNav(group, {
            sliceIndices: withValue(nav.sliceIndices, orientation, index),
          });
      },
      clampZoom: (zoom) => clamp(zoom, MIN_ZOOM, MAX_ZOOM),
      layers: () => this.layersCtl.layers(),
      isCompare: () => this.layersCtl.isCompare(),
      selectedOverlay: () => this.layersCtl.selectedOverlay(),
      layerWindow: (layer) => this.layersCtl.layerWindow(layer),
      setLayerWindow: (layer, next) => this.layersCtl.setLayerWindow(layer, next),
      camera3d: this.camera3d,
      renderer: () => this.renderer(),
      stopCine: () => this.cine.stop(),
      markMipSettling: () => this.render.markMipSettling(),
      setCursor: (point) => this.cursor.set(point),
      setHoveredKey: (key) => this.hoveredKey.set(key),
      setActiveCompareGroup: (group) => this.activeCompareGroup.set(group),
      setFocus: (placement, event) => this.measureCtl.setFocus(placement, event),
      setFocusFromMip: (placement, event) => this.measureCtl.setFocusFromMip(placement, event),
      activeTool: () => this.activeTool(),
      placeMeasurePoint: (placement, event) => this.measureCtl.placeMeasurePoint(placement, event),
    });

    // Wire the 3D-pane editing controller: it owns the TF / clip-plane / oblique /
    // slab gestures, driving Camera3dStore and the shared oblique/slab/drag signals
    // through these lazy hooks without reaching into the component directly.
    this.view3d.init({
      volume: () => this.layersCtl.volume(),
      isReady: () => this.isReady(),
      panes: () => this.panes(),
      camera3d: () => this.camera3d(),
      sliceIndices: this.sliceIndices,
      crosshairsEnabled: () => this.crosshairsEnabled(),
      obliques: this.obliques,
      slabThicknessMm: this.slabThicknessMm,
      drag: this.drag,
      markMipSettling: () => this.render.markMipSettling(),
    });

    // Wire the load/import controller: it owns the drop overlay, file pickers and
    // the resolve→apply pipeline, driving the shared load/notice/drag-overlay
    // signals and calling back into the component for the per-load view reset.
    this.loadCtl.init({
      load: this.load,
      notice: this.notice,
      isDraggingFiles: this.isDraggingFiles,
      dropIntent: this.dropIntent,
      draggingSeries: this.draggingSeries,
      renderer: () => this.renderer(),
      setCompareLayout: () => this.layoutMode.set(LayoutMode.Compare),
      sliceIndices: this.sliceIndices,
      zooms: this.zooms,
      pans: this.pans,
      obliques: this.obliques,
      slabThicknessMm: this.slabThicknessMm,
      mainOrientation: this.mainOrientation,
      invert: this.invert,
      activeTool: this.activeTool,
      focusVoxel: this.focusVoxel,
      activeCompareGroup: this.activeCompareGroup,
    });

    // Wire the measurement controller: it owns the measure-tool place/drag gestures
    // and the Shift+click crosshair-focus picks, reading the view tuples and driving
    // the focus/slice/tool signals and the MeasurementStore through these hooks.
    this.measureCtl.init({
      volume: () => this.layersCtl.volume(),
      isReady: () => this.isReady(),
      panes: () => this.panes(),
      canvasBounds: () => this.canvasRef().nativeElement.getBoundingClientRect(),
      zooms: this.zooms,
      pans: this.pans,
      obliques: this.obliques,
      sliceIndices: this.sliceIndices,
      sagittalFlipped: () => this.sagittalFlipped(),
      focusVoxel: this.focusVoxel,
      crosshairsEnabled: this.crosshairsEnabled,
      hoveredKey: () => this.hoveredKey(),
      cursor: () => this.cursor(),
      activeTool: this.activeTool,
      camera3d: () => this.camera3d(),
      projectionMode: () => this.view3d.projectionMode(),
      slabThicknessMm: () => this.slabThicknessMm(),
      clipToPlanes: () => this.view3d.clipToPlanes(),
      cutPlane: () => this.view3d.cutPlane(),
      transferFunction: () => this.view3d.transferFunction(),
    });

    // Wire the render controller: it owns the WebGPU lifecycle, the resize sync and
    // the coalesced per-frame submit, reading the frame's view state through
    // composeViews and the renderer/error/viewport slots.
    this.render.init({
      canvas: () => this.canvasRef().nativeElement,
      volume: () => this.layersCtl.volume(),
      panes: () => this.panes(),
      camera3d: () => this.camera3d(),
      renderer: this.renderer,
      gpuError: this.gpuError,
      viewport: this.viewport,
      sliceIndices: this.sliceIndices,
      zooms: this.zooms,
      pans: this.pans,
      obliques: this.obliques,
      invert: () => this.invert(),
      sagittalFlipped: () => this.sagittalFlipped(),
      slabThicknessMm: () => this.slabThicknessMm(),
      layoutMode: () => this.layoutMode(),
      drag: () => this.drag(),
      auxEffects: [() => this.toolbar.persistPreferences(), () => this.toolbar.manageHelpFocus()],
    });

    // Wire the ROI/structures controller: it owns the RTSTRUCT state and derives
    // the legend, contour overlays and surface meshes, reading the view tuples that
    // drive the per-slice/per-pane stages through these hooks.
    this.roiCtl.init({
      load: () => this.load(),
      isReady: () => this.isReady(),
      volume: () => this.layersCtl.volume(),
      panes: () => this.panes(),
      obliques: this.obliques,
      sliceIndices: this.sliceIndices,
      zooms: this.zooms,
      pans: this.pans,
      sagittalFlipped: () => this.sagittalFlipped(),
    });

    // Wire the layers/fusion/Compare controller: it owns the layer registry, the
    // base volume, the window/level and the Compare per-group resolution, reading
    // the load state and the view tuples through these hooks.
    this.layersCtl.init({
      load: () => this.load(),
      layoutMode: this.layoutMode,
      panes: () => this.panes(),
      sliceIndices: this.sliceIndices,
      zooms: this.zooms,
      pans: this.pans,
      obliques: this.obliques,
      activeCompareGroup: () => this.activeCompareGroup(),
      markMipSettling: () => this.render.markMipSettling(),
    });

    // Wire the toolbar / keyboard view-action controller: it owns the layout cycle,
    // fits, reset, the toggles, cine and capture triggers, mutating the view signals
    // through these hooks.
    this.toolbar.init({
      renderer: () => this.renderer(),
      isReady: () => this.isReady(),
      hasMprPane: () => this.hasMprPane(),
      panes: () => this.panes(),
      volume: () => this.layersCtl.volume(),
      viewportDpr: () => this.viewport().dpr,
      hoveredKey: () => this.hoveredKey(),
      layoutMode: this.layoutMode,
      mainOrientation: this.mainOrientation,
      sagittalFlipped: this.sagittalFlipped,
      crosshairsEnabled: this.crosshairsEnabled,
      invert: this.invert,
      helpOpen: this.helpOpen,
      infoPanelOpen: this.infoPanelOpen,
      rawTagFilter: this.rawTagFilter,
      zooms: this.zooms,
      pans: this.pans,
      sliceIndices: this.sliceIndices,
      slabThicknessMm: () => this.slabThicknessMm(),
      helpPanel: () => this.helpPanelRef()?.nativeElement,
      activeTool: this.activeTool,
      toggleHistory: () => this.historyPanel()?.toggleCollapsedFromHotkey(),
    });

    // Wire the status controller: it derives the banner text, load progress, the
    // series picker and the metadata inspector feed from the load state.
    this.status.init({
      load: () => this.load(),
      gpuError: () => this.gpuError(),
      volume: () => this.layersCtl.volume(),
      rawTagFilter: this.rawTagFilter,
    });

    afterNextRender(() => void this.render.initGpu());

    // The render controller owns the GPU-redraw effects (frame compose+submit,
    // surface-mesh rebuild, overlay upload, checkerboard uniforms, camera-pan seam)
    // plus the auxiliary effects passed above, frees the renderer on destroy, and
    // the capture controller stops its own recording.
    this.render.startEffects();
  }

  /** Stable identity for a placement, used for `@for` tracking and hover state. */
  protected paneKey(pane: PanePlacement): string {
    return paneKeyOf(pane);
  }

  /**
   * The screenshot's target, for the capture controller: the hovered pane (else
   * the main pane), as its device-pixel crop rect and a filename view tag. Null
   * when there's no pane to capture. The pane selection and naming stay here — they
   * read the component's layout/hover/series state — while the snapshot plumbing is
   * the controller's.
   */
  private screenshotTarget(): ScreenshotTarget | null {
    const pane = pickCaptureTarget(this.panes(), this.hoveredKey(), (p) => this.paneKey(p));
    if (!pane) return null;
    return { rect: scaleRect(pane.rect, this.viewport().dpr), tag: this.toolbar.paneViewTag(pane) };
  }
  /** Placement of the pane under a pointer event, or null if outside the panes. */
  private placementAtEvent(event: MouseEvent): PanePlacement | null {
    const bounds = this.canvasRef().nativeElement.getBoundingClientRect();
    return placementAt(this.panes(), event.clientX - bounds.left, event.clientY - bounds.top);
  }
}

function withValue<T>(
  values: readonly [T, T, T],
  orientation: Orientation,
  value: T,
): readonly [T, T, T] {
  const next: [T, T, T] = [...values];
  next[orientation] = value;
  return next;
}
