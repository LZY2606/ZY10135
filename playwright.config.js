import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5335' },
  webServer: {
    command: 'LINEAGE_DB_PATH=/tmp/lineage-e2e.sqlite node server/dev.js --host 127.0.0.1 --port 5335 --strictPort',
    url: 'http://127.0.0.1:5335/api/datasets',
    reuseExistingServer: false,
    timeout: 20000,
  },
});
