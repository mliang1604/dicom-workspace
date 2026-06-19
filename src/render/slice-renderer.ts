import type { GpuContext } from './device';
import { floatsToHalf } from '../dicom/half';
import { Orientation, type Vec3, type Volume } from '../dicom/types';
import { cameraBasis, type CameraBasis, type OrbitCamera } from './camera';
import type { PaneRect, Vec2 } from './layout';
import {
  patientToTexMatrix,
  planeExtentMm,
  planeToTexMatrix,
  slabTRange,
  sliceCountFor,
  volumeBounds,
} from './reslice';
import { RAYCAST_SHADER } from './raycast-shader';
import { SLICE_SHADER } from './slice-shader';

/**
 * How the 3D pane reduces the samples along each ray. The numeric values are the
 * codes the raycast shader switches on, kept in sync via {@link projectionModeCode}.
 */
export enum ProjectionMode {
  /** Maximum Intensity Projection — the brightest sample (default). */
  Max = 0,
  /** Minimum Intensity Projection — the darkest sample. */
  Min = 1,
  /** Average (mean) of the samples along the ray. */
  Mean = 2,
}

/** Shader code for a projection mode; an exhaustive map kept beside the WGSL. */
export function projectionModeCode(mode: ProjectionMode): number {
  switch (mode) {
    case ProjectionMode.Max:
      return 0;
    case ProjectionMode.Min:
      return 1;
    case ProjectionMode.Mean:
      return 2;
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
    case ProjectionMode.Max:
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
    case ProjectionMode.Max:
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
  /** Mirror the in-plane horizontal axis (e.g. flip the sagittal view L/R). */
  readonly flipX?: boolean;
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
   * Render at a reduced level of detail (fewer march samples) for a smoother
   * frame while the view is being manipulated. Omitted/false renders the
   * full-quality image, identical to the settled output.
   */
  readonly interactive?: boolean;
  /** Destination rectangle in device pixels, origin top-left. */
  readonly rect: PaneRect;
}

/** A pane to draw: an MPR slice or the 3D MIP, discriminated by `kind`. */
export type PaneView = MprPaneView | MipPaneView;

// bytes: planeToTex mat4x4 (64) + scale.xy + pan.xy + windowCenter,windowWidth,
// slicePos,flipX (32). Already a multiple of the 16-byte uniform-struct stride.
const PARAMS_SIZE = 96;
// bytes: patientToTex mat4x4 (64) + eyeSteps, axisU, axisV, forward, modeSlab
// (5 × vec4 = 80).
const MIP_PARAMS_SIZE = 144;
const BYTES_PER_HALF = 2;
/** MPR panes drawn with the slice pipeline; the 3D MIP uses its own slot. */
const MAX_MPR_PANES = 3;
const ORIGIN: Vec2 = { x: 0, y: 0 };
/** Float offset of the per-frame params that follow the 4×4 reslice matrix. */
const MATRIX_FLOATS = 16;
/**
 * Fraction of the full MIP sample budget used while the 3D view is actively
 * manipulated (orbit/zoom/window-level). Halving the samples roughly halves the
 * march cost; the settled frame renders at full quality.
 */
const MIP_INTERACTIVE_LOD = 0.5;

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
  private readonly sampler: GPUSampler;
  private readonly slots: readonly PaneSlot[];
  private readonly mipSlot: PaneSlot;

  private volume: Volume | null = null;
  private texture: GPUTexture | null = null;
  /** Per-orientation plane→texture matrices, indexed by Orientation value. */
  private matrices: readonly Float32Array[] = [];
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
  }

  /** Number of slices available along the given orientation for the loaded volume. */
  sliceCount(orientation: Orientation): number {
    if (!this.volume) return 0;
    return sliceCountFor(this.volume, orientation);
  }

  /** Replace the displayed volume, (re)allocating the GPU texture and bind groups. */
  setVolume(volume: Volume): void {
    const [width, height, depth] = volume.dims;
    const limit = this.device.limits.maxTextureDimension3D;
    if (width > limit || height > limit || depth > limit) {
      throw new Error(
        `Volume ${width}×${height}×${depth} exceeds this GPU's 3D texture limit of ${limit}.`,
      );
    }

    this.texture?.destroy();
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

    const view = texture.createView();
    for (const slot of this.slots) {
      slot.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: slot.buffer } },
        ],
      });
    }
    this.mipSlot.bindGroup = this.device.createBindGroup({
      layout: this.mipPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.mipSlot.buffer } },
      ],
    });

    this.volume = volume;
    this.texture = texture;
    // The reslice matrix depends only on the volume's geometry, so build one
    // per orientation up front and reuse it across frames.
    this.matrices = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal].map(
      (orientation) => planeToTexMatrix(volume, orientation),
    );
    // The patient→texture affine and march count likewise depend only on the
    // geometry; cache them for the MIP raycaster. Step the ray roughly once per
    // voxel along the box diagonal so detail isn't skipped.
    this.patientToTex = patientToTexMatrix(volume);
    this.mipSteps = Math.ceil(Math.hypot(width, height, depth));
  }

  /** Draw the given panes (MPR slices and/or the 3D MIP) into their viewports. */
  renderPanes(panes: readonly PaneView[]): void {
    const volume = this.volume;
    if (!volume) return;

    const canvas = this.gpu.canvas;
    const draws: {
      readonly rect: PaneRect;
      readonly bindGroup: GPUBindGroup;
      readonly pipeline: GPURenderPipeline;
    }[] = [];
    let mprIndex = 0;
    for (const pane of panes) {
      const rect = clampRect(pane.rect, canvas.width, canvas.height);
      if (rect.width < 1 || rect.height < 1) continue;
      if (pane.kind === 'mip') {
        if (!this.mipSlot.bindGroup) continue;
        this.writeMipParams(this.mipSlot.buffer, pane, rect, volume);
        draws.push({ rect, bindGroup: this.mipSlot.bindGroup, pipeline: this.mipPipeline });
        continue;
      }
      const slot = this.slots[mprIndex++];
      if (!slot || !slot.bindGroup) continue;
      this.writeParams(slot.buffer, pane, rect, volume);
      draws.push({ rect, bindGroup: slot.bindGroup, pipeline: this.pipeline });
    }

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
    pass.end();
    this.device.queue.submit([encoder.finish()]);
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
    // MIP keeps the shared MPR window; MinIP/Average auto-fit to the data range
    // so they stay visible as the air fraction per ray slides with the orbit.
    const window = projectionWindow(mode, volume, view.windowCenter, view.windowWidth);

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
    this.device.queue.writeBuffer(buffer, 0, floats);
  }

  private writeParams(buffer: GPUBuffer, view: MprPaneView, rect: PaneRect, volume: Volume): void {
    const count = sliceCountFor(volume, view.orientation);
    // Sample the centre of the voxel so the first/last slices aren't clamped away.
    const slicePos = count > 1 ? (view.sliceIndex + 0.5) / count : 0.5;
    const [scaleX, scaleY] = aspectScale(volume, view.orientation, rect.width, rect.height);
    // Dividing the letterbox scale by the zoom magnifies (covers less of the plane).
    const zoom = view.zoom > 0 ? view.zoom : 1;
    const pan = view.pan ?? ORIGIN;

    const params = new ArrayBuffer(PARAMS_SIZE);
    const floats = new Float32Array(params);
    const uints = new Uint32Array(params);
    floats.set(this.matrices[view.orientation], 0); // planeToTex, floats 0..15
    floats[MATRIX_FLOATS + 0] = scaleX / zoom;
    floats[MATRIX_FLOATS + 1] = scaleY / zoom;
    floats[MATRIX_FLOATS + 2] = pan.x;
    floats[MATRIX_FLOATS + 3] = pan.y;
    floats[MATRIX_FLOATS + 4] = view.windowCenter;
    floats[MATRIX_FLOATS + 5] = view.windowWidth;
    floats[MATRIX_FLOATS + 6] = slicePos;
    uints[MATRIX_FLOATS + 7] = view.flipX ? 1 : 0;
    this.device.queue.writeBuffer(buffer, 0, params);
  }
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
