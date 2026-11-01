import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// Targets: web UI at http://127.0.0.1:19180 (served by apps/api in production; by `vite preview` + proxy
// to the mock API on 127.0.0.1:19189 in development) and the landing page at LANDING_URL (default 127.0.0.1:19181).
export const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:19180';
export const LANDING_URL = process.env.LANDING_URL ?? 'http://127.0.0.1:19181/';
const useMock = process.env.E2E_NO_MOCK !== '1';

export default defineConfig({
  testDir: './tests',
  globalSetup: useMock ? './tests/global-setup.ts' : undefined,
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-GB',
    timezoneId: 'Europe/Berlin',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 } },
    { name: 'mobile', use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } },
  ],
  webServer: useMock
    ? [
        {
          command: 'node apps/web/mock/server.mjs',
          url: 'http://127.0.0.1:19189/api/health',
          cwd: repoRoot,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
          env: { MOCK_PORT: '19189', BLACKBOX_E2E_KEY: process.env.BLACKBOX_E2E_KEY ?? 'bbk_demo_0000000000000000000000000000000000000000000' },
        },
        {
          command: 'pnpm --filter web preview',
          url: BASE_URL,
          cwd: repoRoot,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: 'pnpm --filter landing preview',
          url: LANDING_URL,
          cwd: repoRoot,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      ]
    : undefined,
});
