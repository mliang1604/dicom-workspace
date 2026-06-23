import { RAYCAST_SHADER } from './raycast-shader';
import { SLICE_SHADER } from './slice-shader';
import { SURFACE_SHADER } from './surface-shader';
import { SURFACE_VERTEX_FLOATS } from './surface';

/**
 * GPU pipeline/sampler construction for {@link SliceRenderer}, factored out of
 * its constructor so the renderer holds the wiring and these own the descriptor
 * boilerplate. Each takes the device and swap-chain format and returns a single
 * resource, so the constructor reads as a list of assignments.
 */

/** The MPR slice pipeline (full-screen triangle, windowed reslice fragment). */
export function createSlicePipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: SLICE_SHADER });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
}

/** The 3D raycast (MIP/MinIP/Average/DVR) pipeline. */
export function createMipPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  const module = device.createShaderModule({ code: RAYCAST_SHADER });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
}

/** The translucent, double-sided RTSTRUCT ROI surface pipeline. */
export function createSurfacePipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: SURFACE_SHADER });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
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
      module,
      entryPoint: 'fs',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' }, // translucent, double-sided
  });
}

/** The linear, clamped 3D sampler used for every volume texture. */
export function createVolumeSampler(device: GPUDevice): GPUSampler {
  return device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  });
}
