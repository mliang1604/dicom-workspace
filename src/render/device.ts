export interface GpuContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
}

export class WebGpuUnavailableError extends Error {}

/** Hooks for runtime device events surfaced after a successful init. */
export interface GpuHandlers {
  /**
   * The device was lost at runtime (driver reset, GPU removed, browser reclaim)
   * rather than by an explicit teardown. A `'destroyed'` loss — the device being
   * destroyed on purpose — is filtered out before this fires, so a call here is
   * always an unexpected, recoverable loss the UI should surface.
   */
  readonly onDeviceLost?: (info: GPUDeviceLostInfo) => void;
  /**
   * An uncaptured error escaped the validation/out-of-memory scopes — typically a
   * WGSL validation or oversized-resource failure. Wired so these are logged/surfaced
   * instead of vanishing into the console with a silent blank frame.
   */
  readonly onUncapturedError?: (error: GPUError) => void;
}

/** Acquire a WebGPU device and configure the canvas for rendering. */
export async function initWebGpu(
  canvas: HTMLCanvasElement,
  handlers: GpuHandlers = {},
): Promise<GpuContext> {
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

  // A runtime device loss otherwise just stops producing frames silently; route
  // it to the caller so it can surface a recoverable state. An intentional
  // `'destroyed'` loss (our own teardown) isn't an error, so it's skipped.
  if (handlers.onDeviceLost) {
    void device.lost.then((info) => {
      if (info.reason !== 'destroyed') handlers.onDeviceLost!(info);
    });
  }
  // Validation/out-of-memory errors that escape any pushed scope (e.g. an
  // oversized texture or a shader-layout mismatch) surface here.
  if (handlers.onUncapturedError) {
    device.addEventListener('uncapturederror', (event) => {
      handlers.onUncapturedError!((event as GPUUncapturedErrorEvent).error);
    });
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { device, context, format, canvas };
}
