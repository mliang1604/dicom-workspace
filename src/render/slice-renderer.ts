import type { GpuContext } from './device';
import { floatsToHalf } from '../dicom/half';
import { Orientation, type Volume } from '../dicom/types';
import type { PaneRect, Vec2 } from './layout';
import { SLICE_SHADER } from './slice-shader';

/** One pane to draw: an orientation/slice of the volume into a viewport rect. */
export interface PaneView {
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

// bytes: windowCenter,windowWidth,orientation,slicePos + scale.xy + pan.xy + flipX + pad.
// Rounded up to the 16-byte uniform-struct stride.
const PARAMS_SIZE = 48;
const BYTES_PER_HALF = 2;
const MAX_PANES = 3;
const ORIGIN: Vec2 = { x: 0, y: 0 };

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
  private readonly sampler: GPUSampler;
  private readonly slots: readonly PaneSlot[];

  private volume: Volume | null = null;
  private texture: GPUTexture | null = null;

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

    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

    this.slots = Array.from({ length: MAX_PANES }, () => ({
      buffer: this.device.createBuffer({
        size: PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      bindGroup: null,
    }));
  }

  /** Number of slices available along the given orientation for the loaded volume. */
  sliceCount(orientation: Orientation): number {
    if (!this.volume) return 0;
    return this.volume.dims[axisOf(orientation)];
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

    this.volume = volume;
    this.texture = texture;
  }

  /** Draw the given panes into their viewports on the canvas. */
  renderPanes(panes: readonly PaneView[]): void {
    const volume = this.volume;
    if (!volume) return;

    const canvas = this.gpu.canvas;
    const draws: { readonly rect: PaneRect; readonly bindGroup: GPUBindGroup }[] = [];
    for (let i = 0; i < panes.length && i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.bindGroup) continue;
      const rect = clampRect(panes[i].rect, canvas.width, canvas.height);
      if (rect.width < 1 || rect.height < 1) continue;
      this.writeParams(slot.buffer, panes[i], rect, volume);
      draws.push({ rect, bindGroup: slot.bindGroup });
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
    pass.setPipeline(this.pipeline);
    for (const draw of draws) {
      const { x, y, width, height } = draw.rect;
      pass.setViewport(x, y, width, height, 0, 1);
      pass.setScissorRect(x, y, width, height);
      pass.setBindGroup(0, draw.bindGroup);
      pass.draw(3);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private writeParams(buffer: GPUBuffer, view: PaneView, rect: PaneRect, volume: Volume): void {
    const count = volume.dims[axisOf(view.orientation)];
    // Sample the centre of the voxel so the first/last slices aren't clamped away.
    const slicePos = count > 1 ? (view.sliceIndex + 0.5) / count : 0.5;
    const [scaleX, scaleY] = aspectScale(volume, view.orientation, rect.width, rect.height);
    // Dividing the letterbox scale by the zoom magnifies (covers less of the plane).
    const zoom = view.zoom > 0 ? view.zoom : 1;
    const pan = view.pan ?? ORIGIN;

    const params = new ArrayBuffer(PARAMS_SIZE);
    const floats = new Float32Array(params);
    const uints = new Uint32Array(params);
    floats[0] = view.windowCenter;
    floats[1] = view.windowWidth;
    uints[2] = view.orientation;
    floats[3] = slicePos;
    floats[4] = scaleX / zoom;
    floats[5] = scaleY / zoom;
    floats[6] = pan.x;
    floats[7] = pan.y;
    uints[8] = view.flipX ? 1 : 0;
    this.device.queue.writeBuffer(buffer, 0, params);
  }
}

/** Which volume axis (0=x, 1=y, 2=z) the slice index walks for an orientation. */
function axisOf(orientation: Orientation): 0 | 1 | 2 {
  switch (orientation) {
    case Orientation.Sagittal:
      return 0;
    case Orientation.Coronal:
      return 1;
    case Orientation.Axial:
      return 2;
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

/** Physical width/height (mm) of the slice plane for an orientation. */
function planeExtent(volume: Volume, orientation: Orientation): [number, number] {
  const [dx, dy, dz] = volume.dims;
  const [sx, sy, sz] = volume.spacing;
  switch (orientation) {
    case Orientation.Axial:
      return [dx * sx, dy * sy];
    case Orientation.Coronal:
      return [dx * sx, dz * sz];
    case Orientation.Sagittal:
      return [dy * sy, dz * sz];
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
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
  const [planeW, planeH] = planeExtent(volume, orientation);
  const planeAspect = planeW / planeH;
  const viewAspect = viewWidth / viewHeight;
  if (viewAspect > planeAspect) {
    return [viewAspect / planeAspect, 1];
  }
  return [1, planeAspect / viewAspect];
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
