const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './test/browser',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3018' },
  webServer: { command: 'PORT=3018 node scripts/insights-preview.js', url: 'http://127.0.0.1:3018', reuseExistingServer: false },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
});
