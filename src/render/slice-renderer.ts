import type { GpuContext } from './device';
import { floatsToHalf } from '../dicom/half';
import { Orientation, type LayerDisplay, type Vec3, type Volume } from '../dicom/types';
import { cameraBasis, type CameraBasis, type OrbitCamera } from './camera';
import {
  colormap,
  colormapLut,
  COLORMAP_LUT_SIZE,
  DEFAULT_COLORMAP,
  type Colormap,
} from './colormap';
import type { PaneRect, Vec2 } from './layout';
import {
  clipPlaneTex,
  clipTRange,
  overlayPlaneToTexMatrix,
  patientToTexMatrix,
  planeExtentMm,
  planePixelDims,
  planeToTexMatrix,
  slabTRange,
  sliceCountFor,
  isOblique,
  viewClipHalfSpaces,
  volumeBounds,
  type HalfSpace,
  type ObliqueRotation,
  type PatientPlane,
} from './reslice';
import { RAYCAST_SHADER } from './raycast-shader';
import { SLICE_SHADER } from './slice-shader';
import { SURFACE_SHADER } from './surface-shader';
import {
  DEFAULT_DVR_LIGHTING,
  dvrLightingParams,
  lightToPatient,
  lightViewDirection,
  type DvrLighting,
} from './dvr';
import { normalize } from '../dicom/vec3';
import {
  TF_LUT_SIZE,
  TransferFunctionPreset,
  transferFunction,
  transferFunctionLut,
  type TransferFunction,
} from './transfer-function';

/**
 * How the 3D pane turns the volume into a picture. The first three reduce each
 * ray to a single windowed sample (a projection); {@link Dvr} composites a lit,
 * coloured volume through a transfer function instead. The numeric values are the
 * codes the raycast shader switches on, kept in sync via {@link projectionModeCode}.
 */
export enum ProjectionMode {
  /** Maximum Intensity Projection — the brightest sample (default). */
  Max = 0,
  /** Minimum Intensity Projection — the darkest sample. */
  Min = 1,
  /** Average (mean) of the samples along the ray. */
  Mean = 2,
  /** Direct volume rendering — front-to-back transfer-function compositing. */
  Dvr = 3,
}

/** Whether a 3D mode is direct volume rendering (vs. a single-value projection). */
export function isDvr(mode: ProjectionMode): boolean {
  return mode === ProjectionMode.Dvr;
}

/** Shader code for a 3D mode; an exhaustive map kept beside the WGSL. */
export function projectionModeCode(mode: ProjectionMode): number {
  switch (mode) {
    case ProjectionMode.Max:
      return 0;
    case ProjectionMode.Min:
      return 1;
    case ProjectionMode.Mean:
      return 2;
    case ProjectionMode.Dvr:
      return 3;
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/** A display window expressed as a DICOM centre/width pair. */
export interface DisplayWindow {
  readonly center: number;
  readonly width: number;
}

/**
 * Effective window/level for the 3D projection pane, chosen by projection mode.
 *
 * MIP (Max) latches onto the brightest sample at every angle, so it keeps the
 * shared MPR window and looks exactly as it does today. MinIP (Min) and Average
 * (Mean) instead track the volume's air-filled margins, whose contribution to
 * the per-ray min/mean slides with the orbit angle; reusing the bright MPR
 * window clamps them to black at some angles. Fitting the window to the volume's
 * full data range keeps those projections visible from every direction.
 */
export function projectionWindow(
  mode: ProjectionMode,
  volume: Volume,
  sharedCenter: number,
  sharedWidth: number,
): DisplayWindow {
  switch (mode) {
    // MIP keeps the shared MPR window; DVR ignores the window entirely (it maps
    // samples through the transfer function), so the shared one is a harmless default.
    case ProjectionMode.Max:
    case ProjectionMode.Dvr:
      return { center: sharedCenter, width: sharedWidth };
    case ProjectionMode.Min:
    case ProjectionMode.Mean:
      return {
        center: (volume.min + volume.max) / 2,
        width: Math.max(1, volume.max - volume.min),
      };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/**
 * Default slab thickness (mm) for a projection mode, given the volume's full
 * depth (`fullDepthMm`, the slab thickness at which the whole volume projects).
 *
 * MIP keeps the full-volume default so it is unchanged. MinIP and Average are
 * used with a thinner slab so the air margins around the anatomy stay out of the
 * min/mean; a moderate band of ~⅓ of the depth (capped to keep it moderate, and
 * clamped into the volume) is a sensible starting point the user can adjust.
 */
export function defaultSlabThicknessMm(mode: ProjectionMode, fullDepthMm: number): number {
  switch (mode) {
    // MIP and DVR render the whole volume by default; the cut-away toggle, not a
    // thin slab, is how DVR reveals the interior.
    case ProjectionMode.Max:
    case ProjectionMode.Dvr:
      return fullDepthMm;
    case ProjectionMode.Min:
    case ProjectionMode.Mean:
      return Math.min(fullDepthMm, Math.max(1, Math.min(fullDepthMm / 3, 50)));
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/** One MPR pane: an orientation/slice of the volume drawn into a viewport rect. */
export interface MprPaneView {
  readonly kind: 'mpr';
  readonly orientation: Orientation;
  /** Index of the slice along the orientation's axis. */
  readonly sliceIndex: number;
  readonly windowCenter: number;
  readonly windowWidth: number;
  /** Magnification factor; 1 fits the slice to the pane, >1 zooms in. */
  readonly zoom: number;
  /** Pan offset in screen-uv (pane-fraction) units; defaults to no shift. */
  readonly pan?: Vec2;
  /**
   * Oblique tilt of the slice plane off its anatomical default. Omitted (or
   * {@link NO_OBLIQUE}) keeps the orthogonal plane; a non-zero tilt reslices the
   * pane along an arbitrary oblique/double-oblique plane.
   */
  readonly rotation?: ObliqueRotation;
  /** Mirror the in-plane horizontal axis (e.g. flip the sagittal view L/R). */
  readonly flipX?: boolean;
  /** Invert the windowed grayscale (white ⇄ black); omitted/false renders normally. */
  readonly invert?: boolean;
  /**
   * Which volume this pane draws: 0 (default) = the base; ≥ 1 = the overlay layer
   * drawn standalone (the Compare layout's second column). Out of the loaded set
   * it falls back to the base.
   */
  readonly group?: number;
  /**
   * Composite the fusion overlay over this pane (the default). False in Compare,
   * where each column shows a single layer with no blend.
   */
  readonly composite?: boolean;
  /** Destination rectangle in device pixels, origin top-left. */
  readonly rect: PaneRect;
}

/** The 3D MIP pane: an orbit camera projecting the volume into a viewport rect. */
export interface MipPaneView {
  readonly kind: 'mip';
  readonly windowCenter: number;
  readonly windowWidth: number;
  /** Orbit camera state (azimuth/elevation/zoom). */
  readonly camera: OrbitCamera;
  /**
   * Which projection to accumulate along each ray. Omitted defaults to
   * {@link ProjectionMode.Max} (MIP), reproducing the historical behaviour.
   */
  readonly projectionMode?: ProjectionMode;
  /**
   * Thickness (mm) of the projected slab, centred on the volume along the view
   * direction. Omitted or ≥ the volume's full depth projects the whole volume.
   */
  readonly slabThicknessMm?: number;
  /**
   * Transfer function for {@link ProjectionMode.Dvr}; ignored by the projection
   * modes. A preset's table (see {@link transferFunction}) or a live-edited copy
   * of one. Omitted defaults to the {@link TransferFunctionPreset.CtBone} preset.
   */
  readonly transferFunction?: TransferFunction;
  /**
   * Lighting/shading for {@link ProjectionMode.Dvr}; ignored by the projection
   * modes. Omitted defaults to {@link DEFAULT_DVR_LIGHTING} (a plain headlight).
   */
  readonly lighting?: DvrLighting;
  /**
   * Clip the 3D pane to the current MPR slice planes for a cut-away view. Needs
   * {@link sliceIndices}; applies to every mode (projection and DVR alike).
   */
  readonly clipToPlanes?: boolean;
  /**
   * Current axial/coronal/sagittal slice indices (in {@link Orientation} order),
   * used to place the cut-away planes when {@link clipToPlanes} is set.
   */
  readonly sliceIndices?: readonly [number, number, number];
  /**
   * An arbitrary handle-driven cut-plane (patient space) clipping every ray to
   * the side its normal points into, independent of {@link clipToPlanes}. Omitted
   * leaves the free cut-plane off.
   */
  readonly cutPlane?: PatientPlane;
  /**
   * Render at a reduced level of detail (fewer march samples) for a smoother
   * frame while the view is being manipulated. Omitted/false renders the
   * full-quality image, identical to the settled output.
   */
  readonly interactive?: boolean;
  /**
   * Invert the windowed grayscale of the projection (MIP/MinIP/Average), matching
   * the MPR panes' display inversion. Ignored by DVR, which maps colour through
   * the transfer function. Omitted/false renders normally.
   */
  readonly invert?: boolean;
  /** Destination rectangle in device pixels, origin top-left. */
  readonly rect: PaneRect;
}

/** A pane to draw: an MPR slice or the 3D MIP, discriminated by `kind`. */
export type PaneView = MprPaneView | MipPaneView;

// bytes: planeToTex mat4x4 (64) + scale.xy + pan.xy + windowCenter,windowWidth,
// slicePos,flipX (32) + invert + 12 bytes pad (16) = 112; then the fusion-overlay
// block at byte 112 (16-aligned for its mat4x4): overlayToTex mat4x4 (64) +
// overlayWindowCenter,overlayWindowWidth,overlayOpacity,overlayColormap (16) = 80.
// Total 192.
const PARAMS_SIZE = 192;
/** Float offset of the overlay block (overlayToTex mat4 then window/opacity). */
const OVERLAY_FLOATS = 28;
/** Default fusion checkerboard cell size, in framebuffer pixels (at zoom 1). */
export const DEFAULT_CHECKER_SIZE_PX = 24;
// bytes: patientToTex mat4x4 (64) + eyeSteps, axisU, axisV, forward, modeSlab,
// tfDomain, clipA, clipC, clipS, light, material, clipFree (12 × vec4 = 192).
const MIP_PARAMS_SIZE = 256;
const BYTES_PER_HALF = 2;
/** Floats per ROI-surface vertex: position (3) + normal (3) + rgba (4). */
const SURFACE_VERTEX_FLOATS = 10;
/** Surface camera uniform bytes: eye, axisU+uu, axisV+vv, light (4 × vec4). */
const SURFACE_CAMERA_SIZE = 64;
/** MPR panes drawn with the slice pipeline; the 3D MIP uses its own slot. Six
 * covers the Compare layout (two columns × axial/coronal/sagittal). */
const MAX_MPR_PANES = 6;
const ORIGIN: Vec2 = { x: 0, y: 0 };
/** Float offset of the per-frame params that follow the 4×4 reslice matrix. */
const MATRIX_FLOATS = 16;
/**
 * Fraction of the full MIP sample budget used while the 3D view is actively
 * manipulated (orbit/zoom/window-level). Halving the samples roughly halves the
 * march cost; the settled frame renders at full quality.
 */
const MIP_INTERACTIVE_LOD = 0.5;
/** A no-op half-space: a zero normal the shader ignores (its clip flag is off too). */
const NO_HALF_SPACE: HalfSpace = { normal: [0, 0, 0], offset: 0 };
/** A no-op cut-away: zero-normal planes the shader ignores (clip flag off too). */
const NO_CLIP: readonly [HalfSpace, HalfSpace, HalfSpace] = [
  NO_HALF_SPACE,
  NO_HALF_SPACE,
  NO_HALF_SPACE,
];

interface PaneSlot {
  readonly buffer: GPUBuffer;
  bindGroup: GPUBindGroup | null;
}

/**
 * Uploads a {@link Volume} to a single 3D texture and draws any number of
 * orthogonal slices of it (up to {@link MAX_PANES}) into separate viewports of
 * one canvas, with GPU-side windowing and per-pane aspect correction.
 */
/** Per-frame data for the ROI surface pass: depth-sorted indices + packed camera. */
export interface SurfaceFrame {
  /** Triangle vertex indices, back-to-front (painter's order). */
  readonly indices: Uint32Array;
  /** Packed camera uniform: eye, _, axisU, uu, axisV, vv, light, _ (16 floats). */
  readonly camera: Float32Array;
}

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
  private surfaceVertexBytes = 0;
  private surfaceVertexCount = 0;
  /** Depth-sorted triangle indices for the surface pass; reuploaded each frame. */
  private surfaceIndexBuffer: GPUBuffer | null = null;
  private surfaceIndexBytes = 0;
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
  /** Checkerboard cell size in framebuffer pixels at zoom 1; scaled by the pane zoom. */
  private overlayCheckerSize = DEFAULT_CHECKER_SIZE_PX;
  /** Patient→texture affine for the 3D raycaster; depends only on geometry. */
  private patientToTex: Float32Array = new Float32Array(16);
  /** Upper bound on MIP march steps: the volume's full voxel diagonal. */
  private mipSteps = 1;

  constructor(gpu: GpuContext) {
    this.gpu = gpu;
    this.device = gpu.device;

    const module = this.device.createShaderModule({ code: SLICE_SHADER });
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: gpu.format }] },
      primitive: { topology: 'triangle-list' },
    });

    const mipModule = this.device.createShaderModule({ code: RAYCAST_SHADER });
    this.mipPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mipModule, entryPoint: 'vs' },
      fragment: { module: mipModule, entryPoint: 'fs', targets: [{ format: gpu.format }] },
      primitive: { topology: 'triangle-list' },
    });

    const surfaceModule = this.device.createShaderModule({ code: SURFACE_SHADER });
    this.surfacePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: surfaceModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: SURFACE_VERTEX_FLOATS * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
              { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
              { shaderLocation: 2, offset: 24, format: 'float32x4' }, // rgba
            ],
          },
        ],
      },
      fragment: {
        module: surfaceModule,
        entryPoint: 'fs',
        targets: [
          {
            format: gpu.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, // translucent, double-sided
    });
    this.surfaceCameraBuffer = this.device.createBuffer({
      size: SURFACE_CAMERA_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.surfaceBindGroup = this.device.createBindGroup({
      layout: this.surfacePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.surfaceCameraBuffer } }],
    });

    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

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
  }

  /** Bake a colormap into the overlay's 1-D LUT texture. */
  private uploadOverlayLut(map: Colormap): void {
    this.device.queue.writeTexture(
      { texture: this.overlayLut },
      floatsToHalf(colormapLut(map, COLORMAP_LUT_SIZE)),
      { bytesPerRow: COLORMAP_LUT_SIZE * 4 * BYTES_PER_HALF, rowsPerImage: 1 },
      { width: COLORMAP_LUT_SIZE },
    );
  }

  /** Bake a transfer function into the 1-D LUT texture, once per change. */
  private uploadTransferFunction(tf: TransferFunction): void {
    if (tf === this.tfBaked) return;
    const lut = transferFunctionLut(tf, TF_LUT_SIZE);
    this.device.queue.writeTexture(
      { texture: this.tfTexture },
      floatsToHalf(lut),
      { bytesPerRow: TF_LUT_SIZE * 4 * BYTES_PER_HALF, rowsPerImage: 1 },
      { width: TF_LUT_SIZE },
    );
    this.tfBaked = tf;
  }

  /** Number of slices available along the given orientation for the loaded volume. */
  sliceCount(orientation: Orientation): number {
    if (!this.volume) return 0;
    return sliceCountFor(this.volume, orientation);
  }

  /** Upload a {@link Volume} to a fresh `r16float` 3D texture, with a size guard. */
  private createVolumeTexture(volume: Volume, label: string): GPUTexture {
    const [width, height, depth] = volume.dims;
    const limit = this.device.limits.maxTextureDimension3D;
    if (width > limit || height > limit || depth > limit) {
      throw new Error(
        `${label} ${width}×${height}×${depth} exceeds this GPU's 3D texture limit of ${limit}.`,
      );
    }
    const texture = this.device.createTexture({
      dimension: '3d',
      size: { width, height, depthOrArrayLayers: depth },
      format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture },
      floatsToHalf(volume.data),
      { bytesPerRow: width * BYTES_PER_HALF, rowsPerImage: height },
      { width, height, depthOrArrayLayers: depth },
    );
    return texture;
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
    for (const slot of this.slots) {
      slot.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: baseView },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: slot.buffer } },
          { binding: 3, resource: overlayView },
          { binding: 4, resource: lutView },
        ],
      });
    }
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

  /** Replace the displayed volume, (re)allocating the GPU texture and bind groups. */
  setVolume(volume: Volume): void {
    this.texture?.destroy();
    this.texture = this.createVolumeTexture(volume, 'Volume');
    // A fresh base load drops any previous fusion overlay; the viewer re-adds one
    // through setOverlay when the new load carries an overlay layer.
    this.clearOverlay();
    this.rebuildMprBindGroups();

    this.mipSlot.bindGroup = this.device.createBindGroup({
      layout: this.mipPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.texture.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.mipSlot.buffer } },
        { binding: 3, resource: this.tfTexture.createView({ dimension: '1d' }) },
      ],
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
    this.overlayTexture = this.createVolumeTexture(volume, 'Overlay');
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
   * Set the checkerboard cell size in framebuffer pixels (at zoom 1). A per-frame
   * uniform — no texture work — so the caller just redraws; the drawn size scales
   * with each pane's zoom so the pattern stays anchored to the anatomy.
   */
  setCheckerSize(px: number): void {
    this.overlayCheckerSize = px;
  }

  /**
   * Replace the ROI surface mesh (patient-space vertices: pos3 + normal3 + rgba4
   * per vertex). Uploaded once when the structures/visibility change, then drawn
   * each frame via {@link renderPanes}; pass an empty array to clear.
   */
  setSurfaceMesh(vertices: Float32Array): void {
    this.surfaceVertexCount = Math.floor(vertices.length / SURFACE_VERTEX_FLOATS);
    if (this.surfaceVertexCount === 0) return;
    const bytes = vertices.byteLength;
    if (!this.surfaceVertexBuffer || this.surfaceVertexBytes < bytes) {
      this.surfaceVertexBuffer?.destroy();
      this.surfaceVertexBytes = bytes;
      this.surfaceVertexBuffer = this.device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this.surfaceVertexBuffer, 0, vertices);
  }

  /** Draw the given panes (MPR slices and/or the 3D MIP), then the ROI surfaces. */
  renderPanes(panes: readonly PaneView[], surface?: SurfaceFrame | null): void {
    const volume = this.volume;
    if (!volume) return;

    const canvas = this.gpu.canvas;
    const draws: {
      readonly rect: PaneRect;
      readonly bindGroup: GPUBindGroup;
      readonly pipeline: GPURenderPipeline;
    }[] = [];
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
      const bindGroup = useOverlay ? this.overlayAsBaseBindGroup(slot) : slot.bindGroup;
      if (!bindGroup) continue;
      this.writeParams(slot.buffer, pane, rect, paneVolume, matrices, composite);
      draws.push({ rect, bindGroup, pipeline: this.pipeline });
    }

    const drawSurface = this.prepareSurface(mipRect, surface);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.gpu.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    for (const draw of draws) {
      const { x, y, width, height } = draw.rect;
      pass.setPipeline(draw.pipeline);
      pass.setViewport(x, y, width, height, 0, 1);
      pass.setScissorRect(x, y, width, height);
      pass.setBindGroup(0, draw.bindGroup);
      pass.draw(3);
    }
    // Translucent ROI surfaces, last, blended over the volume in the 3D pane.
    if (drawSurface && mipRect && this.surfaceVertexBuffer && this.surfaceIndexBuffer) {
      pass.setPipeline(this.surfacePipeline);
      pass.setViewport(mipRect.x, mipRect.y, mipRect.width, mipRect.height, 0, 1);
      pass.setScissorRect(mipRect.x, mipRect.y, mipRect.width, mipRect.height);
      pass.setBindGroup(0, this.surfaceBindGroup);
      pass.setVertexBuffer(0, this.surfaceVertexBuffer);
      pass.setIndexBuffer(this.surfaceIndexBuffer, 'uint32');
      pass.drawIndexed(drawSurface);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
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
    const bytes = indices.byteLength;
    if (!this.surfaceIndexBuffer || this.surfaceIndexBytes < bytes) {
      this.surfaceIndexBuffer?.destroy();
      this.surfaceIndexBytes = bytes;
      this.surfaceIndexBuffer = this.device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this.surfaceIndexBuffer, 0, indices);
    return indices.length;
  }

  /** Pack the MIP camera basis and window into the raycast uniform buffer. */
  private writeMipParams(
    buffer: GPUBuffer,
    view: MipPaneView,
    rect: PaneRect,
    volume: Volume,
  ): void {
    const basis: CameraBasis = cameraBasis(volume, view.camera, rect.width, rect.height);
    // Reduce the sample budget while the view is being manipulated, then restore
    // it for the settled frame. The cap and the per-t scale move together so the
    // whole image coarsens uniformly; at full quality (lod 1) the output equals
    // a one-sample-per-voxel march.
    const lod = view.interactive ? MIP_INTERACTIVE_LOD : 1;
    const maxSteps = Math.max(1, Math.ceil(this.mipSteps * lod));
    const stepScale = mipStepScale(this.patientToTex, basis.forward, volume.dims) * lod;

    // Thick-slab clip planes (perpendicular to the shared orthographic view) as a
    // t-range along the ray; full thickness yields ±∞, leaving the march unclipped.
    const thickness = view.slabThicknessMm ?? Infinity;
    const [slabLo, slabHi] = slabTRange(volumeBounds(volume), basis.eye, basis.forward, thickness);
    const mode = view.projectionMode ?? ProjectionMode.Max;
    // MIP/DVR keep the shared MPR window (DVR ignores it); MinIP/Average auto-fit
    // to the data range so they stay visible as the air fraction per ray slides.
    const window = projectionWindow(mode, volume, view.windowCenter, view.windowWidth);

    // DVR: keep the LUT current and pass the transfer function's intensity domain.
    const tf = view.transferFunction ?? transferFunction(TransferFunctionPreset.CtBone);
    if (isDvr(mode)) this.uploadTransferFunction(tf);
    const [tfLo, tfHi] = tf.domain;

    // DVR lighting: rotate the view-frame light into texture space (so the shader
    // can dot it against the texture-space gradient) and pack the material weights.
    const lighting = view.lighting ?? DEFAULT_DVR_LIGHTING;
    const lightPatient = lightToPatient(
      lightViewDirection(lighting),
      normalize(basis.axisU),
      normalize(basis.axisV),
      basis.forward,
    );
    const lightTex = normalize(texDirection(this.patientToTex, lightPatient));
    const light = dvrLightingParams(lightTex, lighting);

    // Cut-away: the three MPR slice planes as texture-space half-spaces oriented
    // to keep the far side of the shared view ray (rd = patientToTex·forward).
    const clipOn = !!view.clipToPlanes && !!view.sliceIndices;
    const clip =
      clipOn && view.sliceIndices
        ? viewClipHalfSpaces(
            volume,
            view.sliceIndices,
            texDirection(this.patientToTex, basis.forward),
          )
        : NO_CLIP;

    // Arbitrary handle-driven cut-plane (patient space) as a texture-space
    // half-space; independent of the MPR cut-away above.
    const freeClipOn = !!view.cutPlane;
    const clipFree = view.cutPlane ? clipPlaneTex(volume, view.cutPlane) : NO_HALF_SPACE;

    const floats = new Float32Array(MIP_PARAMS_SIZE / 4);
    floats.set(this.patientToTex, 0); // patientToTex, floats 0..15
    floats.set(basis.eye, 16);
    floats[19] = maxSteps;
    floats.set(basis.axisU, 20);
    floats[23] = window.center;
    floats.set(basis.axisV, 24);
    floats[27] = window.width;
    floats.set(basis.forward, 28);
    floats[31] = stepScale;
    floats[32] = projectionModeCode(mode);
    floats[33] = slabLo;
    floats[34] = slabHi;
    floats[35] = clipOn ? 1 : 0;
    floats[36] = tfLo;
    floats[37] = tfHi;
    floats[38] = freeClipOn ? 1 : 0; // arbitrary cut-plane enabled
    floats[39] = view.invert ? 1 : 0; // invert grayscale projections (ignored by DVR)
    packHalfSpace(floats, 40, clip[0]); // axial cut-plane
    packHalfSpace(floats, 44, clip[1]); // coronal cut-plane
    packHalfSpace(floats, 48, clip[2]); // sagittal cut-plane
    floats.set(light, 52); // light dir + enabled (52..55), material weights (56..59)
    packHalfSpace(floats, 60, clipFree); // arbitrary handle-driven cut-plane
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
    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: slot.buffer } },
        { binding: 3, resource: view }, // overlay binding unused (composite off)
        { binding: 4, resource: this.overlayLut.createView({ dimension: '1d' }) },
      ],
    });
  }

  private writeParams(
    buffer: GPUBuffer,
    view: MprPaneView,
    rect: PaneRect,
    volume: Volume,
    matrices: readonly Float32Array[],
    composite: boolean,
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
            // Scale the cell by the pane zoom so the pattern tracks the anatomy
            // (the shader divides framebuffer coords by this).
            checkerSize: this.overlayCheckerSize * zoom,
          }
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
      overlay,
    });
    this.device.queue.writeBuffer(buffer, 0, params);
  }
}

/** The base reslice + screen fit + window for one MPR pane (see {@link packSliceParams}). */
export interface SliceParams {
  readonly matrix: Float32Array | readonly number[];
  readonly scaleX: number;
  readonly scaleY: number;
  readonly pan: Vec2;
  readonly windowCenter: number;
  readonly windowWidth: number;
  readonly slicePos: number;
  readonly flipX: boolean;
  readonly invert: boolean;
  /** The fusion overlay block, or null when no overlay is composited. */
  readonly overlay: {
    readonly matrix: Float32Array | readonly number[];
    readonly windowCenter: number;
    readonly windowWidth: number;
    readonly opacity: number;
    /** Map the windowed overlay value through the colormap LUT (vs. grayscale). */
    readonly colormap: boolean;
    /** Composite as a checkerboard (alternating cells) vs. a uniform blend. */
    readonly checkerboard: boolean;
    /** Checkerboard cell size in framebuffer pixels. */
    readonly checkerSize: number;
  } | null;
}

/**
 * Pack one MPR pane's uniform to the exact byte layout the WGSL `Params` struct
 * expects (see slice-shader.ts): the base reslice matrix + screen fit + window
 * (floats 0..24), then the fusion-overlay block at float 28 (byte 112) — overlay
 * matrix (28..43), overlay window centre/width and opacity (44..46), and the
 * colormap flag (47, u32). With no overlay the opacity stays 0, so the shader
 * leaves the base untouched. Pure and exported so the layout can be unit-tested
 * without a GPU — the shader and this packing must stay in lockstep.
 */
export function packSliceParams(p: SliceParams): ArrayBuffer {
  const params = new ArrayBuffer(PARAMS_SIZE);
  const floats = new Float32Array(params);
  const uints = new Uint32Array(params);
  floats.set(p.matrix as ArrayLike<number>, 0); // planeToTex, floats 0..15
  floats[MATRIX_FLOATS + 0] = p.scaleX;
  floats[MATRIX_FLOATS + 1] = p.scaleY;
  floats[MATRIX_FLOATS + 2] = p.pan.x;
  floats[MATRIX_FLOATS + 3] = p.pan.y;
  floats[MATRIX_FLOATS + 4] = p.windowCenter;
  floats[MATRIX_FLOATS + 5] = p.windowWidth;
  floats[MATRIX_FLOATS + 6] = p.slicePos;
  uints[MATRIX_FLOATS + 7] = p.flipX ? 1 : 0;
  uints[MATRIX_FLOATS + 8] = p.invert ? 1 : 0;
  if (p.overlay) {
    // Checkerboard flag + cell size fill the mat4-alignment pad (floats 25, 26).
    uints[MATRIX_FLOATS + 9] = p.overlay.checkerboard ? 1 : 0; // float 25 (u32)
    floats[MATRIX_FLOATS + 10] = p.overlay.checkerSize; // float 26
    floats.set(p.overlay.matrix as ArrayLike<number>, OVERLAY_FLOATS); // overlayToTex, 28..43
    floats[OVERLAY_FLOATS + 16] = p.overlay.windowCenter; // float 44
    floats[OVERLAY_FLOATS + 17] = p.overlay.windowWidth; // float 45
    floats[OVERLAY_FLOATS + 18] = p.overlay.opacity; // float 46
    uints[OVERLAY_FLOATS + 19] = p.overlay.colormap ? 1 : 0; // float 47 (u32)
  }
  return params;
}

/**
 * Letterbox scale that fits the plane into a viewport without distortion.
 * Exported so the CPU-side cursor probe can reproduce the exact same fit the
 * shader uses when mapping a pixel back to a voxel.
 */
export function aspectScale(
  volume: Volume,
  orientation: Orientation,
  viewWidth: number,
  viewHeight: number,
): [number, number] {
  const [planeW, planeH] = planeExtentMm(volume, orientation);
  const planeAspect = planeW / planeH;
  const viewAspect = viewWidth / viewHeight;
  if (viewAspect > planeAspect) {
    return [viewAspect / planeAspect, 1];
  }
  return [1, planeAspect / viewAspect];
}

/**
 * Magnification that renders an orientation's slice at its native resolution —
 * one resampled output voxel per device pixel. {@link aspectScale}'s letterbox
 * fit is `zoom = 1` (the slice scaled to just fit the pane); this returns the
 * extra zoom on top of that fit which makes the finer-sampled in-plane axis
 * exactly one voxel per pixel. The coarser axis is then upsampled, so no acquired
 * detail is dropped (for the common square-pixel slice both axes coincide).
 *
 * `viewWidth`/`viewHeight` are the pane's size in the same device-pixel units
 * {@link aspectScale} sees. Returns 1 if the plane has no extent. Apply
 * {@link clampPan} afterwards, since the pan bound grows with zoom.
 */
export function oneToOneZoom(
  volume: Volume,
  orientation: Orientation,
  viewWidth: number,
  viewHeight: number,
): number {
  const [planeW, planeH] = planeExtentMm(volume, orientation);
  const [nU, nV] = planePixelDims(volume, orientation);
  // Device pixels per mm at the letterbox fit (zoom = 1): the plane just fits.
  const fitPxPerMm = Math.min(viewWidth / planeW, viewHeight / planeH);
  // Device pixels per mm at native scale: the finer in-plane sampling sets it,
  // so every voxel covers at least one pixel.
  const nativePxPerMm = Math.max(nU / planeW, nV / planeH);
  const zoom = nativePxPerMm / fitPxPerMm;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * Voxels crossed per unit of ray parameter `t` for the MIP's shared orthographic
 * direction. Multiplying this by a ray's `tExit − tEntry` span gives ≈ one sample
 * per voxel along that ray's real path, so the shader can size its march to the
 * actual traversal instead of the worst-case full diagonal.
 *
 * `forward` is the patient-space ray direction; `patientToTex` is the column-major
 * affine from {@link patientToTexMatrix}. Its linear part maps the direction into
 * texture space (matching `(patientToTex * vec4(forward, 0)).xyz` in the shader),
 * and scaling each texture component by `dims` converts the step to voxel units.
 * The direction is shared by every fragment (orthographic), so this is computed
 * once per frame on the CPU and passed as a uniform.
 */
export function mipStepScale(
  patientToTex: Float32Array,
  forward: Vec3,
  dims: readonly [number, number, number],
): number {
  const [fx, fy, fz] = forward;
  const m = patientToTex;
  // Column-major mat4x4 · vec4(forward, 0): texture component c = m[c] + m[4+c] + m[8+c].
  const rx = m[0] * fx + m[4] * fy + m[8] * fz;
  const ry = m[1] * fx + m[5] * fy + m[9] * fz;
  const rz = m[2] * fx + m[6] * fy + m[10] * fz;
  return Math.hypot(rx * dims[0], ry * dims[1], rz * dims[2]);
}

/**
 * Constrain a pane's pan offset (screen-uv units) so the pane centre always
 * lands on the slice rather than its letterbox margin. The bound grows with
 * zoom, so a magnified pane can be panned proportionally further to reach its
 * edges. Mirrors the pan applied in `slice-shader.ts` and undone in `probe.ts`.
 */
export function clampPan(
  volume: Volume,
  orientation: Orientation,
  viewWidth: number,
  viewHeight: number,
  zoom: number,
  pan: Vec2,
): Vec2 {
  const z = zoom > 0 ? zoom : 1;
  const [scaleX, scaleY] = aspectScale(volume, orientation, viewWidth, viewHeight);
  // Pane centre stays on the plane while |pan * (aspectScale / zoom)| <= 0.5.
  const maxX = (0.5 * z) / scaleX;
  const maxY = (0.5 * z) / scaleY;
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y)),
  };
}

/**
 * Rescale a pan offset so a zoom change pivots about a fixed screen point
 * instead of the image centre. The shader maps a screen-uv point `uv` to the
 * plane point `(uv - 0.5 - pan) * (aspectScale / zoom) + 0.5`; holding the plane
 * point under `anchor` fixed across a zoom change from `fromZoom` to `toZoom`
 * gives `pan' = (anchor - 0.5) * (1 - ratio) + pan * ratio`, with `ratio =
 * toZoom / fromZoom`. `anchor` is in screen-uv (pane-fraction) units and
 * defaults to the pane centre (0.5, 0.5), which reduces to scaling the pan by
 * the zoom ratio. Apply {@link clampPan} afterwards, since the bound grows with
 * zoom.
 */
export function rezoomPan(
  pan: Vec2,
  fromZoom: number,
  toZoom: number,
  anchor: Vec2 = { x: 0.5, y: 0.5 },
): Vec2 {
  const from = fromZoom > 0 ? fromZoom : 1;
  const to = toZoom > 0 ? toZoom : 1;
  const ratio = to / from;
  return {
    x: (anchor.x - 0.5) * (1 - ratio) + pan.x * ratio,
    y: (anchor.y - 0.5) * (1 - ratio) + pan.y * ratio,
  };
}

/**
 * Map a patient-space direction into texture space with the linear part of the
 * column-major `patientToTex` affine (w = 0), matching the shader's
 * `(patientToTex * vec4(forward, 0)).xyz`. Used to orient the cut-away planes
 * along the same ray direction the shader marches.
 */
function texDirection(patientToTex: Float32Array, forward: Vec3): Vec3 {
  const m = patientToTex;
  const [fx, fy, fz] = forward;
  return [
    m[0] * fx + m[4] * fy + m[8] * fz,
    m[1] * fx + m[5] * fy + m[9] * fz,
    m[2] * fx + m[6] * fy + m[10] * fz,
  ];
}

/** Pack a half-space into four floats at `offset`: normal.xyz then the constant. */
function packHalfSpace(floats: Float32Array, offset: number, plane: HalfSpace): void {
  floats[offset + 0] = plane.normal[0];
  floats[offset + 1] = plane.normal[1];
  floats[offset + 2] = plane.normal[2];
  floats[offset + 3] = plane.offset;
}

/** Keep a rect within the [0, maxW] × [0, maxH] bounds of the canvas. */
function clampRect(rect: PaneRect, maxWidth: number, maxHeight: number): PaneRect {
  const x = Math.max(0, Math.min(rect.x, maxWidth));
  const y = Math.max(0, Math.min(rect.y, maxHeight));
  return {
    x,
    y,
    width: Math.max(0, Math.min(rect.width, maxWidth - x)),
    height: Math.max(0, Math.min(rect.height, maxHeight - y)),
  };
}
