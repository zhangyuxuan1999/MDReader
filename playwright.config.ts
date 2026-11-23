import { defineConfig } from '@playwright/test';

// Browser-side performance/e2e specs live in bench/*.spec.ts and run against a Vite dev server.
export default defineConfig({
  testDir: 'bench',
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5199', headless: true, viewport: { width: 1400, height: 900 } },
  webServer: {
    command: 'npx vite --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
