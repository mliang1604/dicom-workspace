import { describe, expect, it, vi } from 'vitest';
import { initWebGpu, WebGpuUnavailableError, type GpuHandlers } from './device';

/**
 * A canvas stub whose WebGPU context records its `configure` call; everything
 * the renderer touches beyond init is out of scope here.
 */
function fakeCanvas(): HTMLCanvasElement {
  const context = { configure: vi.fn() };
  return {
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
}

/**
 * Install a minimal `navigator.gpu` whose device exposes a controllable
 * `lost` promise and an `uncapturederror` listener registry, then restore the
 * real `navigator.gpu` after the test runs.
 */
function withFakeGpu(
  lostInfo: GPUDeviceLostInfo | null,
  run: (device: {
    dispatchUncaptured: (error: GPUError) => void;
    settleLost: () => void;
  }) => Promise<void>,
): Promise<void> {
  const listeners: Array<(event: Event) => void> = [];
  let resolveLost: (info: GPUDeviceLostInfo) => void = () => {};
  const device = {
    lost: new Promise<GPUDeviceLostInfo>((resolve) => {
      resolveLost = resolve;
    }),
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (type === 'uncapturederror') listeners.push(listener);
    },
  };
  const original = (navigator as { gpu?: unknown }).gpu;
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: {
      requestAdapter: vi.fn(async () => ({ requestDevice: vi.fn(async () => device) })),
      getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm' as GPUTextureFormat),
    },
  });
  const restore = () =>
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: original });
  return run({
    dispatchUncaptured: (error) => listeners.forEach((l) => l({ error } as unknown as Event)),
    settleLost: () => {
      if (lostInfo) resolveLost(lostInfo);
    },
  }).finally(restore);
}

describe('initWebGpu', () => {
  it('throws when the browser has no WebGPU', async () => {
    const original = (navigator as { gpu?: unknown }).gpu;
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    try {
      await expect(initWebGpu(fakeCanvas())).rejects.toBeInstanceOf(WebGpuUnavailableError);
    } finally {
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: original });
    }
  });

  it('routes a runtime device loss to onDeviceLost', async () => {
    const info = { reason: 'unknown', message: 'driver reset' } as GPUDeviceLostInfo;
    await withFakeGpu(info, async (device) => {
      const onDeviceLost = vi.fn();
      await initWebGpu(fakeCanvas(), { onDeviceLost });
      device.settleLost();
      await Promise.resolve();
      await Promise.resolve();
      expect(onDeviceLost).toHaveBeenCalledWith(info);
    });
  });

  it('ignores an intentional (destroyed) device loss', async () => {
    const info = { reason: 'destroyed', message: '' } as GPUDeviceLostInfo;
    await withFakeGpu(info, async (device) => {
      const onDeviceLost = vi.fn();
      await initWebGpu(fakeCanvas(), { onDeviceLost });
      device.settleLost();
      await Promise.resolve();
      await Promise.resolve();
      expect(onDeviceLost).not.toHaveBeenCalled();
    });
  });

  it('forwards uncaptured errors to onUncapturedError', async () => {
    await withFakeGpu(null, async (device) => {
      const onUncapturedError: NonNullable<GpuHandlers['onUncapturedError']> = vi.fn();
      await initWebGpu(fakeCanvas(), { onUncapturedError });
      const error = { message: 'shader validation failed' } as GPUError;
      device.dispatchUncaptured(error);
      expect(onUncapturedError).toHaveBeenCalledWith(error);
    });
  });
});
