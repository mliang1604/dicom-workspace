import { test, expect, type Page } from '@playwright/test';
import { syntheticCtSeries } from './fixtures/synthetic-dicom';
import { syntheticRtStruct } from './fixtures/synthetic-rtstruct';

const DISCLAIMER_KEY = 'dicom-workspace.disclaimer-acknowledged';

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

// A CT series plus an RTSTRUCT that annotates it (matching Frame of Reference).
test('RTSTRUCT loads, lists ROIs, and the tools pane fits without scrolling', async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      localStorage.setItem(key, 'true');
    } catch {
      /* ignore */
    }
  }, DISCLAIMER_KEY);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');

  await page
    .locator('input[type="file"][multiple]:not([webkitdirectory])')
    .first()
    .setInputFiles([...syntheticCtSeries(12, 32), syntheticRtStruct(12)]);

  // The structure set associated and its ROIs are listed.
  await expect(page.getByText('All structures')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.roi-legend .roi-item')).toHaveCount(2);

  // The tools pane fits its contents: no horizontal scroll anywhere.
  const overflow = await page.evaluate(() => {
    const rail = document.querySelector('.tool-rail') as HTMLElement;
    const doc = document.scrollingElement || document.documentElement;
    return {
      rail: rail.scrollWidth - rail.clientWidth,
      doc: doc.scrollWidth - doc.clientWidth,
    };
  });
  expect(overflow.rail).toBe(0);
  expect(overflow.doc).toBe(0);

  // Long ROI names ellipsis-truncate rather than widening the pane.
  const truncates = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.roi-legend .roi-name')).find(
      (e) => (e.textContent ?? '').length > 12,
    ) as HTMLElement | undefined;
    return el ? el.scrollWidth > el.clientWidth : false;
  });
  expect(truncates).toBe(true);

  // When WebGPU is available the contours render as SVG overlays on the panes.
  if (await hasWebGpu(page)) {
    await expect(page.locator('.contours polygon, .contours polyline').first()).toBeVisible({
      timeout: 10_000,
    });
  }
});
