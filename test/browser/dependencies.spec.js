const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');

function costs(month = '2026-09', amount = 12) {
  return {
    providers: [{ name: 'anthropic', label: 'Anthropic' }, { name: 'openai', label: 'OpenAI' }],
    days: [{ date: `${month}-01`, anthropic: 3, openai: amount }, { date: `${month}-02`, anthropic: 0, openai: 0 }],
    totals: { anthropic: 3, openai: amount, usage: amount + 3, subscriptions: 5, combined: amount + 8 },
    errors: {}, models: [], attribution: [], subscriptions: [{ name: 'Subscription', amount_usd: 5 }],
  };
}

test('built chart supports filtering, theme, month navigation and an exact usage table', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/costs?*', route => route.fulfill({ json: costs(new URL(route.request().url()).searchParams.get('month')) }));
  await page.goto('/dashboard.html');
  await expect(page.locator('.spend-chart svg')).toBeVisible();
  await expect(page.locator('.tabs svg')).toHaveCount(5);
  const tooltip = page.locator('wa-tooltip[for="theme-toggle-btn"]');
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toHaveJSProperty('open', false);
  await page.getByRole('button', { name: 'Switch to dark theme' }).hover();
  await expect(tooltip).toHaveJSProperty('open', true);
  await page.mouse.move(300, 300);
  await expect(tooltip).toHaveJSProperty('open', false);
  await page.getByRole('button', { name: 'OpenAI', exact: true }).click();
  await expect(page.getByRole('button', { name: 'OpenAI', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByText('View daily usage data', { exact: true }).click();
  await expect(page.locator('.chart-data tbody tr').first()).toContainText('$15.00');
  await expect(page.locator('#chart-description')).toContainText('$20.00');
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#month-prev').click();
  await expect(page.locator('.spend-chart svg')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/camaze-chart-${test.info().project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('simulation refresh updates the existing chart and preserves filters', async ({ page }) => {
  let amount = 12;
  await page.route('**/api/sim/state', route => route.fulfill({ json: { environment: { business_now: '2026-09-14T12:00:00Z', status: 'ready', revision: 1, playing: false }, messages: [] } }));
  await page.route('**/api/sim/config', route => route.fulfill({ json: { supabaseUrl: 'https://preview.supabase.co', supabaseAnonKey: 'preview' } }));
  await page.route('**/api/sim/costs?*', route => route.fulfill({ json: costs('2026-09', amount) }));
  await page.goto('/sim/dashboard.html');
  await expect(page.locator('.spend-chart svg')).toBeVisible();
  await page.getByRole('button', { name: 'OpenAI', exact: true }).click();
  amount = 20;
  await page.evaluate(() => window.camazeSimRefresh());
  await expect(page.locator('#chart-total-amount')).toHaveText('$28.00');
  await expect(page.getByRole('button', { name: 'OpenAI', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('assignment search, safe export and partial bulk saves work', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const departments = [{ id: 'd1', name: 'Engineering', headcount: 2, monthly_budget_usd: null }];
  const entities = ['Alpha', '=SUM(1,2)'].map((name, i) => ({ id: 'p' + i, provider: 'openai', scope: 'project', name, amount_usd: 20 - i, department: { id: null, name: 'Unassigned' }, person: null }));
  const saved = [];
  await page.route('**/api/org?*', async route => {
    const resource = new URL(route.request().url()).searchParams.get('resource');
    if (resource === 'assignments') {
      const body = route.request().postDataJSON(); saved.push(body);
      return route.fulfill({ status: body.entity_id === 'p1' ? 500 : 200, json: body.entity_id === 'p1' ? { error: 'Try again' } : { ok: true } });
    }
    return route.fulfill({ json: resource === 'departments' ? { departments } : resource === 'people' ? { people: [] } : { entities } });
  });
  await page.goto('/assignments.html');
  await expect(page.locator('.tabulator-row')).toHaveCount(2);
  await page.getByRole('searchbox').fill('Alpha');
  await expect(page.locator('.tabulator-row')).toHaveCount(1);
  await page.getByRole('searchbox').fill('');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const csv = await fs.readFile(await (await download).path(), 'utf8');
  expect(csv).toContain("'=SUM(1,2)");
  await page.locator('.tabulator-row input[type=checkbox]').nth(0).check();
  await page.locator('.tabulator-row input[type=checkbox]').nth(1).check();
  await page.locator('[data-department]').selectOption('d1');
  await page.getByRole('button', { name: 'Assign selected' }).click();
  await expect(page.locator('[data-status]')).toContainText('1 assignment saved. Failed rows remain selected.');
  await expect(page.locator('[data-count]')).toHaveText('1 selected');
  expect(saved.map(row => row.department_id)).toEqual(['d1', 'd1']);
  await expect(page.getByLabel('Department for Alpha', { exact: true })).toHaveValue('d1');
  await expect(page.getByLabel('Department for =SUM(1,2)', { exact: true })).toHaveValue('');
  await page.locator('[data-group]').selectOption('departmentName');
  await expect(page.locator('.tabulator-group').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/camaze-assignments-${test.info().project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});
