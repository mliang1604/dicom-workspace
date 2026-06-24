import type { GpuContext } from './device';
import { Orientation, type LayerDisplay, type Volume } from '../dicom/types';
import {
  colormap,
  colormapLut,
  COLORMAP_LUT_SIZE,
  DEFAULT_COLORMAP,
  type Colormap,
} from './colormap';
import type { PaneRect, Vec2 } from './layout';
import {
  isOblique,
  overlayPlaneToTexMatrix,
  patientToTexMatrix,
  planeToTexMatrix,
  sliceCountFor,
} from './reslice';
import { SURFACE_VERTEX_FLOATS } from './surface';
import {
  TF_LUT_SIZE,
  TransferFunctionPreset,
  transferFunction,
  transferFunctionLut,
  type TransferFunction,
} from './transfer-function';
import {
  createMipPipeline,
  createNearestSampler,
  createSlicePipeline,
  createSurfacePipeline,
  createVolumeSampler,
} from './slice-pipelines';
import { MASK_LUT_SIZE } from './mask';
import type { LabelVolume } from '../dicom/label-volume';
import { SURFACE_CAMERA_SIZE, type SurfaceFrame } from './surface-frame';
import {
  MIP_PARAMS_SIZE,
  PARAMS_SIZE,
  packMipParams,
  packSliceParams,
  type SliceParams,
} from './slice-params';
import { aspectScale, clampRect } from './pan-zoom';
import {
  createLabelTexture,
  createVolumeTexture,
  encodeFrame,
  mipBindGroup,
  sliceBindGroup,
  uploadResizingBuffer,
  writeLabelTexture,
  writeLut1d,
  type PaneDraw,
  type SurfacePass,
} from './slice-resources';
import { isDvr, ProjectionMode } from './projection';
import type { MipPaneView, MprPaneView, PaneView } from './pane-view';

// Public surface kept stable as this module was split into focused siblings;
// callers continue to import these geometry/packing helpers from './slice-renderer'.
export {
  defaultSlabThicknessMm,
  isDvr,
  projectionModeCode,
  projectionWindow,
  ProjectionMode,
  type DisplayWindow,
} from './projection';
export type { MipPaneView, MprPaneView, PaneView } from './pane-view';
export {
  ensureSurfaceSortScratch,
  packSurfaceFrame,
  type SurfaceFrame,
  type SurfaceSortScratch,
} from './surface-frame';
export { packSliceParams, type SliceParams } from './slice-params';
export {
  aspectScale,
  clampPan,
  cursorZoomPan,
  mipStepScale,
  oneToOneZoom,
  rezoomPan,
  steppedSliceIndex,
} from './pan-zoom';

/** MPR panes drawn with the slice pipeline; the 3D MIP uses its own slot. Six
 * covers the Compare layout (two columns × axial/coronal/sagittal). */
const MAX_MPR_PANES = 6;
const ORIGIN: Vec2 = { x: 0, y: 0 };
/**
 * Default fusion checkerboard density, as the number of cells spanning the image
 * (at zoom 1). The cell's pixel size is derived per-pane from the pane width, so
 * the pattern stays the same coarseness regardless of how large the image draws.
 */
export const DEFAULT_CHECKER_CELLS = 20;

interface PaneSlot {
  readonly buffer: GPUBuffer;
  bindGroup: GPUBindGroup | null;
}

/**
 * Uploads a {@link Volume} to a single 3D texture and draws any number of
 * orthogonal slices of it (up to {@link MAX_PANES}) into separate viewports of
 * one canvas, with GPU-side windowing and per-pane aspect correction.
 */
export class SliceRenderer {
  private readonly device: GPUDevice;
  private readonly gpu: GpuContext;
  private readonly pipeline: GPURenderPipeline;
  private readonly mipPipeline: GPURenderPipeline;
  /** Pipeline for the translucent RTSTRUCT ROI surfaces drawn over the 3D pane. */
  private readonly surfacePipeline: GPURenderPipeline;
  /** Camera uniform (eye / image-plane axes / light) for the surface pass. */
  private readonly surfaceCameraBuffer: GPUBuffer;
  private readonly surfaceBindGroup: GPUBindGroup;
  /** ROI surface vertices (pos3 + normal3 + rgba4); rebuilt when structures change. */
  private surfaceVertexBuffer: GPUBuffer | null = null;
  private surfaceVertexCount = 0;
  /** Depth-sorted triangle indices for the surface pass; reuploaded each frame. */
  private surfaceIndexBuffer: GPUBuffer | null = null;
  private readonly sampler: GPUSampler;
  private readonly slots: readonly PaneSlot[];
  private readonly mipSlot: PaneSlot;
  /** 1-D RGBA LUT the DVR shader samples; contents swapped when the TF changes. */
  private readonly tfTexture: GPUTexture;
  /** Transfer function currently baked into {@link tfTexture}, to skip redundant uploads. */
  private tfBaked: TransferFunction | null = null;

  private volume: Volume | null = null;
  private texture: GPUTexture | null = null;
  /** Per-orientation plane→texture matrices, indexed by Orientation value. */
  private matrices: readonly Float32Array[] = [];
  /** The active fusion overlay (a second volume), or null when none is shown. */
  private overlayVolume: Volume | null = null;
  private overlayTexture: GPUTexture | null = null;
  /** Overlay co-registration matrices (base pane plane → overlay grid), or null. */
  private overlayMatrices: readonly Float32Array[] | null = null;
  /** Overlay matrices on its OWN bounds, for drawing it standalone (Compare). */
  private overlayOwnMatrices: readonly Float32Array[] | null = null;
  /** Composite opacity of the overlay over the base, 0 when no overlay. */
  private overlayOpacity = 0;
  /** 1-D RGBA colormap LUT for a colormap overlay (e.g. a dose wash). */
  private readonly overlayLut: GPUTexture;
  /** Whether the active overlay is colour-mapped through {@link overlayLut}. */
  private overlayColormap = false;
  /** Whether the overlay is composited as a checkerboard (vs. a uniform blend). */
  private overlayCheckerboard = false;
  /** Checkerboard density: cells across the image at zoom 1. Pixel size is per-pane. */
  private overlayCheckerCells = DEFAULT_CHECKER_CELLS;
  /** Label-mask texture (authored segmentation), aligned to the base grid, or null. */
  private maskTexture: GPUTexture | null = null;
  /** The label volume currently uploaded, to detect a re-upload vs. a fresh grid. */
  private maskLabel: LabelVolume | null = null;
  /** Last uploaded mask version, to skip re-uploading unchanged voxels. */
  private maskVersion = -1;
  /** Composite opacity of the coloured mask over the slice, 0 when no mask is shown. */
  private maskOpacity = 0;
  /** Nearest sampler for the categorical label ids (and their LUT). */
  private readonly maskSampler: GPUSampler;
  /** 1-D RGBA LUT mapping an ROI id to its display colour (texel 0 = transparent). */
  private readonly maskLut: GPUTexture;
  /** Patient→texture affine for the 3D raycaster; depends only on geometry. */
  private patientToTex: Float32Array = new Float32Array(16);
  /** Upper bound on MIP march steps: the volume's full voxel diagonal. */
  private mipSteps = 1;

  constructor(gpu: GpuContext) {
    this.gpu = gpu;
    this.device = gpu.device;

    this.pipeline = createSlicePipeline(this.device, gpu.format);
    this.mipPipeline = createMipPipeline(this.device, gpu.format);
    this.surfacePipeline = createSurfacePipeline(this.device, gpu.format);
    this.surfaceCameraBuffer = this.device.createBuffer({
      size: SURFACE_CAMERA_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.surfaceBindGroup = this.device.createBindGroup({
      layout: this.surfacePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.surfaceCameraBuffer } }],
    });

    this.sampler = createVolumeSampler(this.device);
    this.maskSampler = createNearestSampler(this.device);

    this.slots = Array.from({ length: MAX_MPR_PANES }, () => ({
      buffer: this.device.createBuffer({
        size: PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      bindGroup: null,
    }));
    this.mipSlot = {
      buffer: this.device.createBuffer({
        size: MIP_PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      bindGroup: null,
    };

    // The DVR transfer function lives in a small 1-D RGBA LUT, sampled with
    // hardware interpolation; rebaked in place (no bind-group churn) on a preset
    // change. Seeded with the default so the texture is always valid to bind.
    this.tfTexture = this.device.createTexture({
      dimension: '1d',
      size: { width: TF_LUT_SIZE },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.uploadTransferFunction(transferFunction(TransferFunctionPreset.CtBone));

    // The overlay colormap lives in its own 1-D RGBA LUT, rebaked in place when a
    // colormap overlay is set. Seeded so binding 4 is always valid to bind.
    this.overlayLut = this.device.createTexture({
      dimension: '1d',
      size: { width: COLORMAP_LUT_SIZE },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.uploadOverlayLut(colormap(DEFAULT_COLORMAP)); // valid seed; the flag gates use

    // The label-mask id→colour LUT lives in its own 1-D RGBA texture, rewritten in
    // place from the structures' colours by setMask. Seeded all-zero (transparent)
    // so binding 7 is always valid to bind even before any mask is set.
    this.maskLut = this.device.createTexture({
      dimension: '1d',
      size: { width: MASK_LUT_SIZE },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    writeLut1d(this.device, this.maskLut, new Float32Array(MASK_LUT_SIZE * 4), MASK_LUT_SIZE);
  }

  /** Bake a colormap into the overlay's 1-D LUT texture. */
  private uploadOverlayLut(map: Colormap): void {
    writeLut1d(
      this.device,
      this.overlayLut,
      colormapLut(map, COLORMAP_LUT_SIZE),
      COLORMAP_LUT_SIZE,
    );
  }

  /** Bake a transfer function into the 1-D LUT texture, once per change. */
  private uploadTransferFunction(tf: TransferFunction): void {
    if (tf === this.tfBaked) return;
    writeLut1d(this.device, this.tfTexture, transferFunctionLut(tf, TF_LUT_SIZE), TF_LUT_SIZE);
    this.tfBaked = tf;
  }

  /** Number of slices available along the given orientation for the loaded volume. */
  sliceCount(orientation: Orientation): number {
    if (!this.volume) return 0;
    return sliceCountFor(this.volume, orientation);
  }

  /**
   * (Re)build the MPR slot bind groups for the current base + overlay textures.
   * With no overlay, binding 3 reuses the base view — a valid texture the shader
   * skips (overlayOpacity 0); `layout:'auto'` requires the binding to exist.
   */
  private rebuildMprBindGroups(): void {
    if (!this.texture) return;
    const baseView = this.texture.createView();
    const overlayView = this.overlayTexture?.createView() ?? baseView;
    const lutView = this.overlayLut.createView({ dimension: '1d' });
    // No mask yet: bind the base view as a valid placeholder the shader skips
    // (maskOpacity 0), the same trick the overlay binding uses.
    const maskView = this.maskTexture?.createView() ?? baseView;
    const maskLutView = this.maskLut.createView({ dimension: '1d' });
    const layout = this.pipeline.getBindGroupLayout(0);
    for (const slot of this.slots) {
      slot.bindGroup = sliceBindGroup(this.device, layout, {
        sampler: this.sampler,
        base: baseView,
        overlay: overlayView,
        lut: lutView,
        buffer: slot.buffer,
        mask: maskView,
        maskSampler: this.maskSampler,
        maskLut: maskLutView,
      });
    }
  }

  /**
   * Free every GPU resource this renderer owns. The constructor allocates the
   * MPR/MIP uniform buffers, the surface camera buffer, and the transfer-function
   * and overlay LUT textures once and keeps them for the renderer's lifetime;
   * {@link setVolume}/{@link setOverlay}/{@link setSurfaceMesh} allocate the
   * per-load volume, overlay and surface buffers/textures. None of these are
   * freed by the per-load `destroy()` calls, so call this before dropping the
   * renderer (component destroy) or rebuilding it (a fresh `initGpu`) to avoid
   * leaking GPU memory. Pipelines and the sampler have no explicit `destroy()`;
   * they're released with the device. Idempotent for the per-load resources.
   */
  dispose(): void {
    // Per-load resources (also cleared on the next setVolume/setOverlay/setMask).
    this.texture?.destroy();
    this.texture = null;
    this.clearOverlay();
    this.clearMask();
    this.surfaceVertexBuffer?.destroy();
    this.surfaceVertexBuffer = null;
    this.surfaceIndexBuffer?.destroy();
    this.surfaceIndexBuffer = null;
    // Constructor-time resources, never otherwise freed.
    this.surfaceCameraBuffer.destroy();
    this.mipSlot.buffer.destroy();
    for (const slot of this.slots) slot.buffer.destroy();
    this.tfTexture.destroy();
    this.overlayLut.destroy();
    this.maskLut.destroy();
  }

  /** Drop any fusion overlay (texture + matrices + opacity + colormap). */
  private clearOverlay(): void {
    this.overlayTexture?.destroy();
    this.overlayTexture = null;
    this.overlayVolume = null;
    this.overlayMatrices = null;
    this.overlayOwnMatrices = null;
    this.overlayOpacity = 0;
    this.overlayColormap = false;
  }

  /** Drop the label mask (texture + opacity), so the panes draw without it. */
  private clearMask(): void {
    this.maskTexture?.destroy();
    this.maskTexture = null;
    this.maskLabel = null;
    this.maskVersion = -1;
    this.maskOpacity = 0;
  }

  /**
   * Set, update, or clear (`null` label) the authored label mask drawn over the
   * MPR panes — a distinct slot from the fusion overlay (see {@link setOverlay}).
   * The label grid shares the base volume's geometry, so it reuses the base
   * reslice matrices; this only owns the id texture, the id→colour LUT, and the
   * composite opacity.
   *
   * - A new label grid (re)allocates the 3D texture and uploads it.
   * - The same grid at a newer `version` re-uploads its voxels in place (the brush
   *   mutates the buffer in place and bumps the version; see {@link LabelVolume}).
   * - The `lut` (id→colour, texel 0 transparent) and `opacity` are refreshed every
   *   call — cheap — so a recolour or opacity change needs no texture work.
   */
  setMask(label: LabelVolume | null, lut: Float32Array, version: number, opacity: number): void {
    if (!label) {
      if (!this.maskTexture && this.maskOpacity === 0) return;
      this.clearMask();
      this.rebuildMprBindGroups();
      return;
    }
    this.maskOpacity = opacity;
    writeLut1d(this.device, this.maskLut, lut, MASK_LUT_SIZE);
    if (label !== this.maskLabel) {
      // A fresh label grid: (re)allocate the texture and rebind the panes to it.
      this.maskTexture?.destroy();
      this.maskTexture = createLabelTexture(this.device, label);
      this.maskLabel = label;
      this.maskVersion = version;
      this.rebuildMprBindGroups();
    } else if (version !== this.maskVersion && this.maskTexture) {
      // Same grid, painted since the last upload: rewrite the voxels in place (no
      // reallocation, no bind-group churn).
      writeLabelTexture(this.device, this.maskTexture, label);
      this.maskVersion = version;
    }
  }

  /** Replace the displayed volume, (re)allocating the GPU texture and bind groups. */
  setVolume(volume: Volume): void {
    this.texture?.destroy();
    this.texture = createVolumeTexture(this.device, volume, 'Volume');
    // A fresh base load drops any previous fusion overlay and label mask; the
    // viewer re-adds them through setOverlay / setMask for the new load.
    this.clearOverlay();
    this.clearMask();
    this.rebuildMprBindGroups();

    this.mipSlot.bindGroup = mipBindGroup(this.device, this.mipPipeline.getBindGroupLayout(0), {
      sampler: this.sampler,
      volume: this.texture.createView(),
      buffer: this.mipSlot.buffer,
      tf: this.tfTexture.createView({ dimension: '1d' }),
    });

    this.volume = volume;
    // The reslice matrix depends only on the volume's geometry, so build one
    // per orientation up front and reuse it across frames.
    this.matrices = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal].map(
      (orientation) => planeToTexMatrix(volume, orientation),
    );
    // The patient→texture affine and march count likewise depend only on the
    // geometry; cache them for the MIP raycaster. Step the ray roughly once per
    // voxel along the box diagonal so detail isn't skipped.
    this.patientToTex = patientToTexMatrix(volume);
    const [width, height, depth] = volume.dims;
    this.mipSteps = Math.ceil(Math.hypot(width, height, depth));
  }

  /**
   * Set, replace, or clear (`null`) the fusion overlay — a second volume
   * composited over the base in the MPR panes by `opacity`, drawn grayscale or
   * through a colormap per `display`. Uploads only the overlay texture (and its
   * colormap LUT) and rebuilds the MPR bind groups; the base volume, its matrices
   * and the view state are untouched (unlike {@link setVolume}). The overlay
   * shares the patient frame but has its own grid, so it carries its own
   * per-orientation plane→texture matrices.
   */
  setOverlay(volume: Volume | null, opacity: number, display?: LayerDisplay): void {
    if (!volume) {
      if (!this.overlayVolume) return;
      this.clearOverlay();
      this.rebuildMprBindGroups();
      return;
    }
    // Same overlay grid, only opacity/colormap changed (the blend bar and the
    // layers-panel slider): update the per-frame scalars and the LUT in place —
    // no texture re-upload, matrix recompute, or bind-group churn per drag frame.
    if (volume === this.overlayVolume) {
      this.overlayOpacity = opacity;
      this.overlayColormap = display?.kind === 'colormap';
      if (display?.kind === 'colormap') this.uploadOverlayLut(colormap(display.name));
      return;
    }
    this.overlayTexture?.destroy();
    this.overlayTexture = createVolumeTexture(this.device, volume, 'Overlay');
    this.overlayVolume = volume;
    this.overlayOpacity = opacity;
    // Colormap display bakes the named ramp into the overlay LUT; grayscale leaves
    // the flag off and the shader uses the windowed value directly.
    this.overlayColormap = display?.kind === 'colormap';
    if (display?.kind === 'colormap') this.uploadOverlayLut(colormap(display.name));
    // The overlay matrices co-register the BASE's pane plane with the overlay's
    // grid, so they need the base volume; rebuilt here for the orthogonal panes
    // and refreshed per-frame for oblique ones in writeParams. Without a base
    // there's nothing to composite over (matrices stay null → shader skips it).
    const base = this.volume;
    this.overlayMatrices = base
      ? [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal].map((orientation) =>
          overlayPlaneToTexMatrix(base, volume, orientation),
        )
      : null;
    // Standalone matrices on the overlay's own bounds — the Compare layout draws
    // the overlay as a base in its column, not co-registered onto the base plane.
    this.overlayOwnMatrices = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal].map(
      (orientation) => planeToTexMatrix(volume, orientation),
    );
    this.rebuildMprBindGroups();
  }

  /**
   * Toggle checkerboard compositing of the overlay (alternating base/overlay cells
   * for registration QA) vs. a uniform opacity blend. A per-frame mode flag — no
   * texture work — so the caller just redraws.
   */
  setOverlayCheckerboard(on: boolean): void {
    this.overlayCheckerboard = on;
  }

  /**
   * Set the checkerboard density: the number of cells spanning the image (at zoom
   * 1). Each pane derives its cell's pixel size from this and its own width, so the
   * pattern reads the same coarseness on any image, then scales with the pane zoom
   * so it stays anchored to the anatomy. A per-frame uniform — no texture work.
   */
  setCheckerCells(cells: number): void {
    this.overlayCheckerCells = cells;
  }

  /**
   * Replace the ROI surface mesh (patient-space vertices: pos3 + normal3 + rgba4
   * per vertex). Uploaded once when the structures/visibility change, then drawn
   * each frame via {@link renderPanes}; pass an empty array to clear.
   */
  setSurfaceMesh(vertices: Float32Array): void {
    this.surfaceVertexCount = Math.floor(vertices.length / SURFACE_VERTEX_FLOATS);
    if (this.surfaceVertexCount === 0) return;
    this.surfaceVertexBuffer = uploadResizingBuffer(
      this.device,
      this.surfaceVertexBuffer,
      vertices,
      GPUBufferUsage.VERTEX,
    );
  }

  /** Draw the given panes (MPR slices and/or the 3D MIP), then the ROI surfaces. */
  renderPanes(panes: readonly PaneView[], surface?: SurfaceFrame | null): void {
    const volume = this.volume;
    if (!volume) return;

    const canvas = this.gpu.canvas;
    const draws: PaneDraw[] = [];
    let mipRect: PaneRect | null = null;
    let mprIndex = 0;
    for (const pane of panes) {
      const rect = clampRect(pane.rect, canvas.width, canvas.height);
      if (rect.width < 1 || rect.height < 1) continue;
      if (pane.kind === 'mip') {
        if (!this.mipSlot.bindGroup) continue;
        this.writeMipParams(this.mipSlot.buffer, pane, rect, volume);
        draws.push({ rect, bindGroup: this.mipSlot.bindGroup, pipeline: this.mipPipeline });
        mipRect = rect;
        continue;
      }
      const slot = this.slots[mprIndex++];
      if (!slot) continue;
      // Compare's second column (group ≥ 1) draws the overlay layer standalone on
      // its own grid; everything else draws the base. Fall back to the base when
      // there's no overlay to compare against.
      const useOverlay =
        (pane.group ?? 0) >= 1 &&
        !!this.overlayTexture &&
        !!this.overlayVolume &&
        !!this.overlayOwnMatrices;
      const paneVolume = useOverlay ? this.overlayVolume! : volume;
      const matrices = useOverlay ? this.overlayOwnMatrices! : this.matrices;
      const composite = pane.composite ?? true;
      // The standalone overlay column draws through the overlay's colormap (when
      // it has one), so a dose shows in jet/hot instead of grayscale.
      const colormapBase = useOverlay && this.overlayColormap;
      const bindGroup = useOverlay ? this.overlayAsBaseBindGroup(slot) : slot.bindGroup;
      if (!bindGroup) continue;
      // The label mask is aligned to the base grid, so it draws only on base panes
      // (not Compare's standalone overlay column, which samples the overlay's grid).
      const mask = !useOverlay;
      this.writeParams(
        slot.buffer,
        pane,
        rect,
        paneVolume,
        matrices,
        composite,
        colormapBase,
        mask,
      );
      draws.push({ rect, bindGroup, pipeline: this.pipeline });
    }

    const drawSurface = this.prepareSurface(mipRect, surface);
    // Translucent ROI surfaces draw last, blended over the volume in the 3D pane.
    const surfacePass: SurfacePass | null =
      drawSurface && mipRect && this.surfaceVertexBuffer && this.surfaceIndexBuffer
        ? {
            rect: mipRect,
            pipeline: this.surfacePipeline,
            bindGroup: this.surfaceBindGroup,
            vertexBuffer: this.surfaceVertexBuffer,
            indexBuffer: this.surfaceIndexBuffer,
            indexCount: drawSurface,
          }
        : null;

    encodeFrame(this.device, this.gpu.context.getCurrentTexture().createView(), draws, surfacePass);
  }

  /**
   * Upload this frame's surface camera + sorted indices; returns the index count
   * to draw, or 0 when there's nothing to draw (no 3D pane, no mesh, no frame).
   */
  private prepareSurface(mipRect: PaneRect | null, surface?: SurfaceFrame | null): number {
    if (!mipRect || !surface || !this.surfaceVertexBuffer || this.surfaceVertexCount === 0)
      return 0;
    const { indices, camera } = surface;
    if (indices.length === 0) return 0;
    this.device.queue.writeBuffer(this.surfaceCameraBuffer, 0, camera);
    this.surfaceIndexBuffer = uploadResizingBuffer(
      this.device,
      this.surfaceIndexBuffer,
      indices,
      GPUBufferUsage.INDEX,
    );
    return indices.length;
  }

  /** Pack the MIP camera basis and window into the raycast uniform buffer. */
  private writeMipParams(
    buffer: GPUBuffer,
    view: MipPaneView,
    rect: PaneRect,
    volume: Volume,
  ): void {
    // DVR keeps the transfer-function LUT current; the rest of the packing is
    // pure (see {@link packMipParams}) and shared with the layout unit tests.
    const mode = view.projectionMode ?? ProjectionMode.Max;
    if (isDvr(mode)) {
      this.uploadTransferFunction(
        view.transferFunction ?? transferFunction(TransferFunctionPreset.CtBone),
      );
    }
    const floats = packMipParams(this.patientToTex, this.mipSteps, view, rect, volume);
    this.device.queue.writeBuffer(buffer, 0, floats);
  }

  /**
   * Bind group that draws the OVERLAY texture as the base (binding 0) — the
   * Compare layout's second column, where the overlay layer is shown standalone.
   * Built per pane (cheap) since it's only the compare path. Returns null without
   * an overlay texture.
   */
  private overlayAsBaseBindGroup(slot: PaneSlot): GPUBindGroup | null {
    if (!this.overlayTexture) return null;
    const view = this.overlayTexture.createView();
    return sliceBindGroup(this.device, this.pipeline.getBindGroupLayout(0), {
      sampler: this.sampler,
      base: view,
      overlay: view, // overlay binding unused (composite off)
      lut: this.overlayLut.createView({ dimension: '1d' }),
      buffer: slot.buffer,
      // The mask is aligned to the base grid, not this standalone overlay column,
      // so it isn't drawn here: bind a valid placeholder and leave maskOpacity 0.
      mask: view,
      maskSampler: this.maskSampler,
      maskLut: this.maskLut.createView({ dimension: '1d' }),
    });
  }

  private writeParams(
    buffer: GPUBuffer,
    view: MprPaneView,
    rect: PaneRect,
    volume: Volume,
    matrices: readonly Float32Array[],
    composite: boolean,
    colormapBase: boolean,
    maskActive: boolean,
  ): void {
    const count = sliceCountFor(volume, view.orientation);
    // Sample the centre of the voxel so the first/last slices aren't clamped away.
    const slicePos = count > 1 ? (view.sliceIndex + 0.5) / count : 0.5;
    const [scaleX, scaleY] = aspectScale(volume, view.orientation, rect.width, rect.height);
    // Dividing the letterbox scale by the zoom magnifies (covers less of the plane).
    const zoom = view.zoom > 0 ? view.zoom : 1;
    const pan = view.pan ?? ORIGIN;

    // The orthogonal reslice matrix is cached per orientation; an oblique pane
    // needs a fresh matrix built from its live tilt (cheap, only while tilted).
    const matrix = isOblique(view.rotation)
      ? planeToTexMatrix(volume, view.orientation, view.rotation)
      : matrices[view.orientation];

    // The overlay shares the pane plane but samples its own grid, so it gets its
    // own (possibly oblique) plane→texture matrix and is windowed by its own
    // volume's defaults. Null when not compositing (Compare) or there's no overlay.
    const overlay =
      composite && this.overlayVolume && this.overlayMatrices
        ? {
            matrix: isOblique(view.rotation)
              ? overlayPlaneToTexMatrix(volume, this.overlayVolume, view.orientation, view.rotation)
              : this.overlayMatrices[view.orientation],
            windowCenter: this.overlayVolume.windowCenter,
            windowWidth: this.overlayVolume.windowWidth,
            opacity: this.overlayOpacity,
            colormap: this.overlayColormap,
            checkerboard: this.overlayCheckerboard,
            // Derive the cell's framebuffer size from the pane width so a fixed
            // count of cells spans the image regardless of how large it draws,
            // then scale by the pane zoom so the pattern tracks the anatomy (the
            // shader divides framebuffer coords by this).
            checkerSize: (rect.width / Math.max(this.overlayCheckerCells, 1)) * zoom,
          }
        : null;

    // The label mask shares the base grid, so it samples through the very same
    // (possibly oblique) reslice matrix as the slice — no separate co-registration.
    const mask =
      maskActive && this.maskTexture && this.maskOpacity > 0
        ? { matrix, opacity: this.maskOpacity, lutSize: MASK_LUT_SIZE }
        : null;

    const params = packSliceParams({
      matrix,
      scaleX: scaleX / zoom,
      scaleY: scaleY / zoom,
      pan,
      windowCenter: view.windowCenter,
      windowWidth: view.windowWidth,
      slicePos,
      flipX: !!view.flipX,
      invert: !!view.invert,
      colormapBase,
      overlay,
      mask,
    });
    this.device.queue.writeBuffer(buffer, 0, params);
  }
}
