import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  timeout: 120_000,
  use: {
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 }
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ]
});

