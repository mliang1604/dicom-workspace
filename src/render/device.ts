export interface GpuContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
}

export class WebGpuUnavailableError extends Error {}

/** Acquire a WebGPU device and configure the canvas for rendering. */
export async function initWebGpu(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!navigator.gpu) {
    throw new WebGpuUnavailableError(
      'WebGPU is not available in this browser. Try a recent Chrome, Edge, or Safari.',
    );
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new WebGpuUnavailableError('No suitable GPU adapter was found.');
  }

  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new WebGpuUnavailableError('Could not create a WebGPU canvas context.');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { device, context, format, canvas };
}
