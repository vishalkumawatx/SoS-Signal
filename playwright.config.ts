import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: { baseURL: 'http://localhost:5178', channel: 'chrome', trace: 'retain-on-failure' },
  webServer: {
    command: 'npx vite --host localhost --port 5178 --strictPort',
    url: 'http://localhost:5178',
    reuseExistingServer: false,
  },
});
