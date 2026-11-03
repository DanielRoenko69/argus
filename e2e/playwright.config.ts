import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['line'], ['html', { outputFolder: 'test-results/report', open: 'never' }]],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: process.env.ARGUS_E2E_BASE_URL || 'http://argus:3000',
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});

