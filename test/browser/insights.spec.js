const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const output = '/tmp/camaze-insights-screenshots';
test('recorded-usage path renders coverage without overflow', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/insights.html');
  await expect(page.locator('#status')).toContainText('No comparison available');
  await expect(page.locator('#coverage')).toContainText('gpt-4o-2024-11-20');
  await expect(page.locator('#coverage')).toContainText('Exact model or version unsupported');
  await expect(page.getByText('LOCAL PREVIEW:', { exact: false })).toBeVisible();
  fs.mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `${info.project.name}-recorded.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: path.join(output, `${info.project.name}-recorded-dark.png`), fullPage: true });
  expect(errors).toEqual([]);
});
test('loading, no usage, source failure and request failure states', async ({ page }) => {
  let finish;
  await page.route('**/api/insights', async route => {
    await new Promise(resolve => { finish = resolve; });
    await route.fulfill({ json: { period: { start: '2026-03-13', end: '2026-09-11' }, insights: [], unsupported: [], excluded: [], observedModels: 0, source: { status: 'error', ageDays: 8 } } });
  });
  await page.goto('/insights.html');
  await expect(page.locator('#status')).toHaveText('Loading recorded usage...');
  await expect.poll(() => Boolean(finish)).toBe(true);
  finish();
  await expect(page.locator('#status')).toContainText('No recorded usage');
  await expect(page.locator('#status')).toContainText('refresh failed');
  await expect(page.locator('#status')).toContainText('older than 7 days');
  await page.unroute('**/api/insights');
  await page.route('**/api/insights', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.reload();
  await expect(page.locator('#status')).toContainText('could not be loaded');
});

test('estimated published scores render with per-score labels', async ({ page }) => {
  // Hand-built fixture (same shape lib/insights/rules.js's recommend()
  // produces) rather than pulling from product data, now that the sample
  // path is gone.
  const data = {
    period: { start: '2026-03-13', end: '2026-09-11' },
    observedModels: 1,
    unsupported: [],
    excluded: [],
    usageSyncedAt: null,
    source: { status: 'ok', fetchedAt: '2026-09-11T00:00:00Z', ageDays: 0.5, lastAttemptAt: '2026-09-11T00:00:00Z' },
    insights: [{
      current: { provider: 'openai', id: 'gpt-4o-2024-11-20', name: 'GPT-4o (November 2024)', input: 2.5, output: 10, context: 128000, pricingSource: 'https://developers.openai.com/api/docs/models/gpt-4o', reviewedAt: '2026-09-11T00:00:00Z' },
      candidate: { provider: 'openai', id: 'gpt-4.1-2025-04-14', name: 'GPT-4.1', input: 2, output: 8, context: 1047576, pricingSource: 'https://developers.openai.com/api/docs/models/gpt-4.1', reviewedAt: '2026-09-11T00:00:00Z' },
      benchmark: { version: '4.3', current: 8.4, candidate: 12.7, currentEstimated: false, candidateEstimated: true, currentSource: 'https://artificialanalysis.ai/models/gpt-4o', candidateSource: 'https://artificialanalysis.ai/models/gpt-4-1', observedAt: null, candidateObservedAt: null },
      usage: { provider: 'openai', model: 'gpt-4o-2024-11-20', firstSeen: '2026-09-09', lastSeen: '2026-09-10' },
      fetchedAt: '2026-09-11T00:00:00Z',
    }],
  };
  await page.route('**/api/insights', route => route.fulfill({ json: data }));
  await page.goto('/insights.html');
  await expect(page.locator('.insight')).toHaveCount(1);
  await expect(page.locator('.metric-grid strong.candidate').first()).toContainText('Estimated by Artificial Analysis');
  await expect(page.getByText('Estimated by Artificial Analysis', { exact: true })).toHaveCount(1);
  await expect(page.locator('.reason')).toContainText('Higher AA Intelligence Index score');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
