import { test, expect } from '@playwright/test';
import { syntheticCtSeries } from './fixtures/synthetic-dicom';
import { syntheticRtDose } from './fixtures/synthetic-rtdose';

const DISCLAIMER_KEY = 'dicom-workspace.disclaimer-acknowledged';

// Loading a CT plus a same-frame RTDOSE exercises the whole fusion path that the
// other smoke specs never reach: dose parsing, overlay promotion, the two-volume
// reslice shader (binding 3/4), and the Compare layout's per-pane texture
// selection. WebGPU pixels can't be read back under a software adapter, so this
// asserts on the DOM/data-attribute seams that only appear when rendering works.
test('a same-frame dose loads as a fusion overlay; Compare shows both layers', async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      localStorage.setItem(key, 'true');
    } catch {
      /* ignore */
    }
  }, DISCLAIMER_KEY);

  // Surface any uncaught/console errors — a duplicate @for track key in Compare
  // throws an Angular RuntimeError during change detection (dev mode), which a
  // DOM-count assertion alone would miss.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');

  await page
    .locator('input[type="file"][multiple]:not([webkitdirectory])')
    .first()
    .setInputFiles([...syntheticCtSeries(12, 32), syntheticRtDose(6, 12)]);

  // The dose is promoted to a fusion overlay, so the in-pane blend bar appears —
  // which only happens once the overlay uploads and composites without error.
  const blendBar = page.locator('.blend-bar');
  await expect(blendBar).toBeVisible({ timeout: 30_000 });
  await expect(blendBar).toHaveAttribute('data-blend', /\d+/);

  // Cycle the Layout button to the Compare layout.
  const layoutButton = page.getByRole('button', { name: /Layout/ });
  for (let i = 0; i < 6; i++) {
    if (((await layoutButton.textContent()) ?? '').includes('Compare')) break;
    await layoutButton.click();
    await page.waitForTimeout(60); // let the label re-render before re-reading
  }
  await expect(layoutButton).toContainText('Compare');

  // Compare = two columns × axial/coronal/sagittal = six MPR panes, drawn without
  // error (group 1 binds the overlay texture as its base).
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(6);

  // The fusion blend bar is a composited-view control, hidden in Compare.
  await expect(blendBar).toHaveCount(0);

  // No Angular/render errors during the load + fusion + Compare interaction.
  expect(errors, errors.join('\n')).toEqual([]);
});
