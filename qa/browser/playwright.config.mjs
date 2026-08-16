import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 15_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4177', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node fixture-server.mjs', url: 'http://127.0.0.1:4177/admin/', reuseExistingServer: false, timeout: 10_000 },
});
