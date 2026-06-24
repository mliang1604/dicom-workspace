import { f32ToF16, floatsToHalf } from '../dicom/half';
import type { DirtyBox, LabelVolume } from '../dicom/label-volume';
import type { Volume } from '../dicom/types';
import type { PaneRect } from './layout';

/**
 * GPU resource construction for {@link SliceRenderer}: uploading a volume to a 3D
 * texture, baking a 1-D LUT, and assembling the MPR / MIP bind groups. Pure given
 * the device and the views/buffers the renderer owns, so the renderer keeps only
 * the lifecycle (what to (re)build when) and these own the descriptor shape.
 */

const BYTES_PER_HALF = 2;

/** Upload a {@link Volume} to a fresh `r16float` 3D texture, with a size guard. */
export function createVolumeTexture(device: GPUDevice, volume: Volume, label: string): GPUTexture {
  const [width, height, depth] = volume.dims;
  const limit = device.limits.maxTextureDimension3D;
  if (width > limit || height > limit || depth > limit) {
    throw new Error(
      `${label} ${width}×${height}×${depth} exceeds this GPU's 3D texture limit of ${limit}.`,
    );
  }
  const texture = device.createTexture({
    dimension: '3d',
    size: { width, height, depthOrArrayLayers: depth },
    format: 'r16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    floatsToHalf(volume.data),
    { bytesPerRow: width * BYTES_PER_HALF, rowsPerImage: height },
    { width, height, depthOrArrayLayers: depth },
  );
  return texture;
}

/**
 * Upload a {@link LabelVolume}'s ids into `texture` (an `r16float` 3D texture the
 * same size as the base volume). The ids are integers, stored as half-floats and
 * sampled NEAREST so they round-trip exactly — half-float represents integers up
 * to 2048 exactly, which bounds a single load's structure count (ample for hand
 * authoring). Used for both the initial upload and the in-place re-upload on a
 * version bump (the buffer is mutated in place; see {@link LabelVolume}).
 */
export function writeLabelTexture(
  device: GPUDevice,
  texture: GPUTexture,
  label: LabelVolume,
): void {
  const [width, height, depth] = label.dims;
  const halves = new Uint16Array(label.data.length);
  for (let i = 0; i < label.data.length; i++) halves[i] = f32ToF16(label.data[i]);
  device.queue.writeTexture(
    { texture },
    halves,
    { bytesPerRow: width * BYTES_PER_HALF, rowsPerImage: height },
    { width, height, depthOrArrayLayers: depth },
  );
}

/**
 * Re-upload only the dirty sub-box of a label volume, converting just that region
 * to half-float. A brush stamp touches a tiny `(2r)³` corner of the grid, so this
 * keeps a paint event off the ~78 MB whole-volume re-encode + `writeTexture` that
 * {@link writeLabelTexture} does — the difference between smooth and laggy
 * painting. `box` is inclusive in voxel coordinates (see {@link LabelVolume.dirty}).
 */
export function writeLabelTextureRegion(
  device: GPUDevice,
  texture: GPUTexture,
  label: LabelVolume,
  box: DirtyBox,
): void {
  const [dimX, dimY] = label.dims;
  const { data } = label;
  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  const depth = box.maxZ - box.minZ + 1;
  const halves = new Uint16Array(width * height * depth);
  let out = 0;
  for (let z = box.minZ; z <= box.maxZ; z++) {
    for (let y = box.minY; y <= box.maxY; y++) {
      let src = (z * dimY + y) * dimX + box.minX;
      for (let x = 0; x < width; x++) halves[out++] = f32ToF16(data[src++]);
    }
  }
  device.queue.writeTexture(
    { texture, origin: { x: box.minX, y: box.minY, z: box.minZ } },
    halves,
    { bytesPerRow: width * BYTES_PER_HALF, rowsPerImage: height },
    { width, height, depthOrArrayLayers: depth },
  );
}

/** Allocate the `r16float` 3D texture a {@link LabelVolume} uploads into, with a size guard. */
export function createLabelTexture(device: GPUDevice, label: LabelVolume): GPUTexture {
  const [width, height, depth] = label.dims;
  const limit = device.limits.maxTextureDimension3D;
  if (width > limit || height > limit || depth > limit) {
    throw new Error(
      `Label volume ${width}×${height}×${depth} exceeds this GPU's 3D texture limit of ${limit}.`,
    );
  }
  const texture = device.createTexture({
    dimension: '3d',
    size: { width, height, depthOrArrayLayers: depth },
    format: 'r16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  writeLabelTexture(device, texture, label);
  return texture;
}

/** Bake a 1-D RGBA `size`-texel LUT (transfer function or colormap) into `texture`. */
export function writeLut1d(
  device: GPUDevice,
  texture: GPUTexture,
  lut: Float32Array,
  size: number,
): void {
  device.queue.writeTexture(
    { texture },
    floatsToHalf(lut),
    { bytesPerRow: size * 4 * BYTES_PER_HALF, rowsPerImage: 1 },
    { width: size },
  );
}

/** The views/buffer an MPR slice pane binds: base + overlay + mask textures, LUTs, params. */
export interface SliceBindResources {
  readonly sampler: GPUSampler;
  readonly base: GPUTextureView;
  readonly overlay: GPUTextureView;
  readonly lut: GPUTextureView;
  readonly buffer: GPUBuffer;
  /** Label-mask texture (the base view when no mask; the shader skips it at opacity 0). */
  readonly mask: GPUTextureView;
  /** Nearest sampler for the label ids and their LUT. */
  readonly maskSampler: GPUSampler;
  /** The id→colour mask LUT (binding 7). */
  readonly maskLut: GPUTextureView;
}

/**
 * The MPR slice bind group (base 0, sampler 1, params 2, overlay 3, colormap LUT 4,
 * mask texture 5, nearest mask sampler 6, mask LUT 7).
 */
export function sliceBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  r: SliceBindResources,
): GPUBindGroup {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: r.base },
      { binding: 1, resource: r.sampler },
      { binding: 2, resource: { buffer: r.buffer } },
      { binding: 3, resource: r.overlay },
      { binding: 4, resource: r.lut },
      { binding: 5, resource: r.mask },
      { binding: 6, resource: r.maskSampler },
      { binding: 7, resource: r.maskLut },
    ],
  });
}

/** The 3D raycast bind group (volume 0, sampler 1, params 2, transfer-function LUT 3). */
export function mipBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  r: { sampler: GPUSampler; volume: GPUTextureView; buffer: GPUBuffer; tf: GPUTextureView },
): GPUBindGroup {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: r.volume },
      { binding: 1, resource: r.sampler },
      { binding: 2, resource: { buffer: r.buffer } },
      { binding: 3, resource: r.tf },
    ],
  });
}

/**
 * Upload `data` into `existing`, reallocating a larger buffer (and freeing the
 * old one) only when it no longer fits. `usage` is OR-ed with `COPY_DST`. Returns
 * the buffer to keep — the same one when it was reused, a fresh one when it grew.
 */
export function uploadResizingBuffer(
  device: GPUDevice,
  existing: GPUBuffer | null,
  data: Float32Array | Uint32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  let buffer = existing;
  if (!buffer || buffer.size < data.byteLength) {
    existing?.destroy();
    buffer = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
  }
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/** One full-screen-triangle pane draw: its viewport rect, bind group and pipeline. */
export interface PaneDraw {
  readonly rect: PaneRect;
  readonly bindGroup: GPUBindGroup;
  readonly pipeline: GPURenderPipeline;
}

/** The translucent ROI surface pass, drawn last over the 3D pane (or null). */
export interface SurfacePass {
  readonly rect: PaneRect;
  readonly pipeline: GPURenderPipeline;
  readonly bindGroup: GPUBindGroup;
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly indexCount: number;
}

/**
 * Encode and submit one frame: clear the swap-chain view, draw each pane through
 * its viewport/scissor, then the translucent ROI surface pass (if any) over the
 * 3D pane. The per-pane uniform writes happen before this; here it is pure GPU
 * command recording given the prepared draws.
 */
export function encodeFrame(
  device: GPUDevice,
  targetView: GPUTextureView,
  draws: readonly PaneDraw[],
  surface: SurfacePass | null,
): void {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: targetView,
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
  if (surface) {
    const { x, y, width, height } = surface.rect;
    pass.setPipeline(surface.pipeline);
    pass.setViewport(x, y, width, height, 0, 1);
    pass.setScissorRect(x, y, width, height);
    pass.setBindGroup(0, surface.bindGroup);
    pass.setVertexBuffer(0, surface.vertexBuffer);
    pass.setIndexBuffer(surface.indexBuffer, 'uint32');
    pass.drawIndexed(surface.indexCount);
  }
  pass.end();
  device.queue.submit([encoder.finish()]);
}
