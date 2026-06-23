import { test, expect, type Page } from '@playwright/test';
import { syntheticCtSeries } from './fixtures/synthetic-dicom';
import { importFiles, pickSeries } from './fixtures/load';

const DISCLAIMER_KEY = 'dicom-workspace.disclaimer-acknowledged';

/** Pre-acknowledge the disclaimer so a test can land straight on the viewer. */
async function preAcknowledge(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    try {
      localStorage.setItem(key, 'true');
    } catch {
      /* private mode — guard falls back to in-memory */
    }
  }, DISCLAIMER_KEY);
}

async function hasWebGpu(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    if (!('gpu' in navigator) || !navigator.gpu) return false;
    try {
      return !!(await navigator.gpu.requestAdapter());
    } catch {
      return false;
    }
  });
}

test.describe('DICOM Workspace smoke', () => {
  test('disclaimer gate leads to the viewer', async ({ page }) => {
    await page.goto('/');
    // The acknowledged-guard redirects a first-time visitor to the disclaimer.
    await expect(page.getByRole('heading', { name: /before you continue/i })).toBeVisible();

    await page.getByRole('button', { name: /i acknowledge and accept/i }).click();

    // Viewer chrome renders.
    await expect(page.locator('header.toolbar')).toBeVisible();
    await expect(page.getByRole('button', { name: /open folder/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /open files/i })).toBeVisible();
  });

  test('loads a synthetic volume and brings up the panes', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    // WebGPU shader/pipeline validation failures don't throw — Chromium logs
    // them to the console. Capturing them is how a broken render is detected
    // headlessly (the rendered pixels themselves can't be read back).
    const gpuErrors: string[] = [];
    const GPU_ERROR =
      /error while parsing wgsl|is invalid due to a previous error|invalid (shadermodule|renderpipeline|bindgrouplayout|computepipeline)/i;
    page.on('console', (m) => {
      if (GPU_ERROR.test(m.text())) gpuErrors.push(m.text().split('\n')[0]);
    });

    await preAcknowledge(page);
    await page.goto('/');
    await expect(page.locator('header.toolbar')).toBeVisible();

    const webgpu = await hasWebGpu(page);

    // Import the synthetic CT series. Since #241 an import is ingest-only: it
    // catalogues into the history panel without displaying anything.
    await importFiles(page, syntheticCtSeries(12, 32));

    const status = page.locator('div.status');
    const layout = page.getByRole('button', { name: /layout/i });

    if (webgpu) {
      // Pick the CT from the history to bring the viewer up (the explicit load
      // step that replaced the old auto-load on import). pickSeries retries until
      // the layout control (gated on isReady()) enables — i.e. the GPU is up, the
      // shader pipeline built, and a volume assembled. A broken render path
      // (shader/device/pipeline failure) leaves it disabled and fails there.
      await pickSeries(page, 'CT');
      await expect(layout).toBeEnabled({ timeout: 30_000 });
      await expect(status).not.toHaveClass(/error/);

      // Per-pane orientation labels render only once the panes are live — a
      // DOM-level proxy for "the panes came up" (headless WebGPU pixels can't be
      // read back reliably, so we assert at the DOM/pipeline level).
      await expect(page.getByText(/axial|coronal|sagittal/i).first()).toBeVisible({
        timeout: 10_000,
      });

      // The render surface exists and is sized.
      const size = await page
        .locator('canvas')
        .first()
        .evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
      expect(size.w).toBeGreaterThan(0);
      expect(size.h).toBeGreaterThan(0);

      // Layout cycling updates the control's label (also forces re-renders,
      // surfacing any pipeline error across all panes).
      const before = (await layout.innerText()).trim();
      await layout.click();
      await expect
        .poll(async () => (await layout.innerText()).trim(), { timeout: 5_000 })
        .not.toBe(before);

      // The shader pipeline built and ran without a WebGPU validation error.
      await page.waitForTimeout(500);
      expect(gpuErrors, `WebGPU pipeline errors:\n${gpuErrors.join('\n')}`).toEqual([]);
    } else {
      // No WebGPU (some CI runners): the app must degrade gracefully, not crash.
      await expect(status).toContainText(/webgpu|gpu/i, { timeout: 15_000 });
      test.info().annotations.push({
        type: 'note',
        description: 'WebGPU unavailable; render assertions skipped.',
      });
    }

    expect(pageErrors, `unexpected page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
