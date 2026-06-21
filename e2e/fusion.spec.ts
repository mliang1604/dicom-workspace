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

  // #130: the dose loaded as an overlay, so the Layers panel lists both layers
  // (base CT + overlay dose) and exposes the overlay's colormap and the view-mode
  // switch — the acceptance path: load dose, set its colormap, switch fusion ⇄
  // compare, all without a render error.
  const layerPanel = page.locator('.layer-panel');
  await expect(layerPanel).toBeVisible();
  await expect(layerPanel.locator('.layer-item')).toHaveCount(2);

  // Change the overlay colormap (jet → hot); recomposites without error.
  await layerPanel.locator('select.layer-display').selectOption('hot');

  // Hiding the overlay drops it from compositing (blend bar goes away); re-show it.
  const overlayRow = layerPanel.locator('.layer-item[data-layer]').last();
  await overlayRow.locator('input[type="checkbox"]').uncheck();
  await expect(blendBar).toHaveCount(0);
  await overlayRow.locator('input[type="checkbox"]').check();
  await expect(blendBar).toBeVisible();

  // The view-mode switch jumps to Compare (6 panes) and back to Fusion (3 panes).
  await layerPanel.getByRole('button', { name: 'Compare' }).click();
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(6);
  await layerPanel.getByRole('button', { name: 'Fusion' }).click();
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(3);
  await expect(blendBar).toBeVisible();

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

  // #132: the live probe reads every layer at the cursor. Hovering the overlay
  // column (group 1, top-right axial pane) probes the dose (Gy) as the primary and
  // reads the underlying CT (HU) at the same patient point — both in one readout.
  await page.mouse.move(961, 131);
  const probe = page.locator('.probe');
  await expect(probe).toBeVisible();
  await expect(probe).toContainText('Gy');
  await expect(probe).toContainText('HU');

  // #129: the Compare groups are linked by default; the toggle unlinks them so each
  // column navigates on its own. Both states must re-render the two-texture path
  // without error (group 1 re-reads its independent nav when unlinked).
  const linkToggle = page.locator('button[data-linked]');
  await expect(linkToggle).toHaveAttribute('data-linked', 'true');
  await linkToggle.click();
  await expect(linkToggle).toHaveAttribute('data-linked', 'false');
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(6);
  await linkToggle.click();
  await expect(linkToggle).toHaveAttribute('data-linked', 'true');

  // No Angular/render errors during the load + fusion + Compare interaction.
  expect(errors, errors.join('\n')).toEqual([]);
});
