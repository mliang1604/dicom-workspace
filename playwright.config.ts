import { defineConfig, devices } from '@playwright/test';

// Browser smoke test config. The app is WebGPU-only; WebGPU is exposed by
// Chromium on a secure context (http://localhost), so the dev server is driven
// directly. The flags enable WebGPU (incl. a software adapter where present).
const PORT = Number(process.env.E2E_PORT ?? 4200);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'],
        },
      },
    },
  ],
  webServer: {
    command: `npm start -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
