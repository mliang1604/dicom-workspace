import { test, expect, type Page } from '@playwright/test';
import { syntheticCtSeries } from './fixtures/synthetic-dicom';
import { importAndLoad } from './fixtures/load';

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

// Regression for the oblique tilt knob: moving onto the at-rest knob fired the
// canvas's pointerleave, which used to clear the hovered pane and unmount the
// knob right under the press — so it couldn't be grabbed (and after a reset it
// stayed ungrabbable). See onPointerLeave.
test('oblique tilt knob can be grabbed, reset, and grabbed again', async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      localStorage.setItem(key, 'true');
    } catch {
      /* ignore */
    }
  }, DISCLAIMER_KEY);
  await page.goto('/');

  if (!(await hasWebGpu(page))) {
    test.skip(true, 'WebGPU unavailable; the oblique gizmo needs a live render.');
    return;
  }

  await importAndLoad(page, syntheticCtSeries(10, 32));

  const layout = page.getByRole('button', { name: /layout/i });
  await expect(layout).toBeEnabled({ timeout: 30_000 });

  // The oblique gizmos are gated behind the crosshairs toggle.
  const crosshairs = page.getByRole('button', { name: /crosshairs/i });
  if ((await crosshairs.getAttribute('aria-pressed')) !== 'true') await crosshairs.click();

  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const knob = page.locator('[aria-label$="oblique tilt"]').first();

  // Hover an MPR pane to reveal a knob.
  for (const fx of [0.82, 0.85]) {
    for (const fy of [0.25, 0.75]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(120);
      if ((await knob.count()) && (await knob.isVisible().catch(() => false))) break;
    }
  }
  expect(await knob.isVisible()).toBe(true);

  const dragKnob = async (): Promise<number> => {
    const bb = await knob.boundingBox();
    if (!bb) return 0;
    const cx = bb.x + bb.width / 2;
    const cy = bb.y + bb.height / 2;
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.mouse.move(cx + 35, cy + 18, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    return page.locator('.oblique-gizmo.active').count();
  };

  // First grab: dragging the knob tilts the plane (the gizmo becomes active).
  expect(await dragKnob()).toBeGreaterThan(0);

  // Double-click to reset to orthogonal.
  const tilted = await knob.boundingBox();
  if (tilted) await page.mouse.dblclick(tilted.x + tilted.width / 2, tilted.y + tilted.height / 2);
  await page.waitForTimeout(150);
  expect(await page.locator('.oblique-gizmo.active').count()).toBe(0);

  // Re-grab after reset: the previously-broken case must work.
  await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.25);
  await page.waitForTimeout(120);
  expect(await dragKnob()).toBeGreaterThan(0);
});
