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

  // The pane is wide enough to show the full ROI names (no truncation).
  const anyTruncated = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.roi-legend .roi-name')).some(
      (e) => e.scrollWidth > e.clientWidth + 1,
    ),
  );
  expect(anyTruncated).toBe(false);

  // When WebGPU is available the contours render as SVG overlays on the panes.
  if (await hasWebGpu(page)) {
    await expect(page.locator('.contours polygon, .contours polyline').first()).toBeVisible({
      timeout: 10_000,
    });
  }
});

// The 3D pane draws ROIs as translucent shaded surfaces (a 2D-canvas overlay),
// not wireframe rings. Needs WebGPU (the 3D pane renders the volume).
test('renders translucent ROI surfaces in the 3D pane', async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      localStorage.setItem(key, 'true');
    } catch {
      /* ignore */
    }
  }, DISCLAIMER_KEY);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('/');

  if (!(await hasWebGpu(page))) {
    test.skip(true, 'WebGPU unavailable; the 3D pane needs a live render.');
    return;
  }

  await page
    .locator('input[type="file"][multiple]:not([webkitdirectory])')
    .first()
    .setInputFiles([...syntheticCtSeries(24, 48), syntheticRtStruct(24)]);
  await expect(page.getByText('All structures')).toBeVisible({ timeout: 30_000 });

  // Cycle to the 3D-only layout (L: 3-pane -> 4-pane -> 3D-only).
  await page.locator('body').click();
  await page.keyboard.press('l');
  await page.keyboard.press('l');
  await expect(page.locator('canvas.surface-3d')).toBeVisible({ timeout: 10_000 });

  // Nudge the orbit so the surface redraws, then let the frame settle.
  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy + 50, { steps: 8 });
  await page.mouse.up();

  // The surface overlay paints translucent triangles (non-transparent pixels).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = document.querySelector('.surface-3d') as HTMLCanvasElement | null;
          if (!s || !s.width) return 0;
          const data = s.getContext('2d')!.getImageData(0, 0, s.width, s.height).data;
          let n = 0;
          for (let i = 3; i < data.length; i += 4) if (data[i] > 4) n++;
          return n / (data.length / 4);
        }),
      { timeout: 5_000 },
    )
    .toBeGreaterThan(0.01);
});

// Middle-drag (and Alt+left-drag) pans the 3D camera, so you can recentre after
// a cursor-anchored zoom. Needs WebGPU (measures the rendered surface overlay).
test('middle-drag pans the 3D view', async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      localStorage.setItem(key, 'true');
    } catch {
      /* ignore */
    }
  }, DISCLAIMER_KEY);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('/');

  if (!(await hasWebGpu(page))) {
    test.skip(true, 'WebGPU unavailable; the 3D pane needs a live render.');
    return;
  }

  await page
    .locator('input[type="file"][multiple]:not([webkitdirectory])')
    .first()
    .setInputFiles([...syntheticCtSeries(24, 48), syntheticRtStruct(24)]);
  await expect(page.getByText('All structures')).toBeVisible({ timeout: 30_000 });

  await page.locator('body').click();
  await page.keyboard.press('l');
  await page.keyboard.press('l'); // 3D-only
  await expect(page.locator('canvas.surface-3d')).toBeVisible({ timeout: 10_000 });

  const centroidX = () =>
    page.evaluate(() => {
      const s = document.querySelector('.surface-3d') as HTMLCanvasElement;
      const d = s.getContext('2d')!.getImageData(0, 0, s.width, s.height).data;
      let sx = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 4) {
          sx += (i / 4) % s.width;
          n++;
        }
      }
      return n ? sx / n : 0;
    });

  await page.waitForTimeout(300);
  const before = await centroidX();
  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 140, cy, { steps: 8 });
  await page.mouse.up({ button: 'middle' });

  await expect.poll(centroidX, { timeout: 5_000 }).toBeGreaterThan(before + 60);
});
