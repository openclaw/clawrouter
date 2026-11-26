import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-18T00:00:00.000Z'));
  await page.addInitScript(() => localStorage.setItem('clawrouter-theme', 'light'));
});

test('Caps defaults and member override editors are accessible and visually stable', async ({ page }) => {
  await page.goto('/dashboard/users?demo=1');
  await page.getByRole('button', { name: 'Caps', exact: true }).click();
  await page.getByLabel('Caps policy').selectOption('maintainer_models');
  await expect(page.getByRole('heading', { name: 'Member caps' })).toBeVisible();
  const editor = page.getByRole('combobox', { name: 'Default weekly cap mode' });
  await editor.selectOption('number');
  await page.getByLabel('Default weekly cap USD').fill('5000');
  await page.getByRole('button', { name: 'Save Default weekly cap', exact: true }).click();
  await expect(page.getByText('$5000.00 (inherited)', { exact: false }).first()).toBeVisible();
  const member = page.getByRole('combobox', { name: / weekly cap mode$/ }).nth(1);
  const label = (await member.getAttribute('aria-label'))!.replace(/ mode$/, '');
  await member.selectOption('number');
  await page.getByLabel(`${label} USD`).fill('2500');
  await page.getByRole('button', { name: `Save ${label}`, exact: true }).click();
  await expect(page.getByText('$2500.00 (override)', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: `${label} mode`, exact: true }).selectOption('unlimited');
  await page.getByRole('button', { name: `Save ${label}`, exact: true }).click();
  await expect(page.getByText('unlimited (override)', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: `${label} mode`, exact: true }).selectOption('inherit');
  await page.getByRole('button', { name: `Save ${label}`, exact: true }).click();
  await expect(page.getByText('$2500.00 (override)', { exact: false })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include('.capsView').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await expect(page).toHaveScreenshot('caps.png', { animations: 'disabled', fullPage: true });
});

test('Members do not see the Caps view', async ({ page }) => {
  await page.goto('/dashboard/users?demo=user');
  await expect(page.getByRole('button', { name: 'Caps', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Caps', exact: true })).toHaveCount(0);
});

async function openCaps(page: Page) {
  const policies = ['alpha', 'beta'].map(policyId => ({
    policyId, enabled: true, providers: [], budgetScope: 'principal', dailyBudgetMicros: 15_000_000, monthlyBudgetMicros: 1_000_000, retainRequestContent: false,
    grantRouting: { strategy: 'priority', stickiness: 'none', failover: true, staleState: 'allow', staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} },
  }));
  const overrides: Record<string, Record<string, unknown>> = {};
  const user = { email: 'member@example.com', role: 'user', tenantId: 'synthetic', enabled: true, groups: [], contentRetentionDisabled: false, budgetOverrides: overrides };
  const writes: { path: string; body: unknown; ifMatch?: string }[] = [];
  await page.route('**/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      const body = request.postDataJSON();
      writes.push({ path, body, ifMatch: request.headers()['if-match'] });
      if (request.method() === 'PUT' && path === '/v1/admin/policies/alpha/budget-limits') Object.assign(policies[0], body);
      else if (request.method() === 'PUT' && path === '/v1/admin/access-users/member%40example.com/budget-overrides/alpha') overrides.alpha = { ...body, updatedBy: 'admin@example.com', updatedAt: new Date(Date.UTC(2026, 9, 18, 0, 0, writes.length)).toISOString() };
      else throw new Error('Unexpected mutation: ' + request.method() + ' ' + path);
      await route.fulfill({ json: {} });
      return;
    }
    const responses: Record<string, unknown> = {
      '/v1/session': { authenticated: true, auth: 'cloudflare_access', role: 'admin', email: 'admin@example.com', entitlements: { providers: [] } },
      '/v1/providers': { providers: [] }, '/v1/routes': { openaiCompatible: [], manifestProxy: [] },
      '/v1/session/credentials': { credentials: [] }, '/v1/session/usage': { policies: [] },
      '/v1/admin/bootstrap': { policies, users: [user], credentials: [], bindings: [], grants: [], connections: [], rules: [], providers: [], tenants: [], overview: {} },
      '/v1/admin/caps': { users: [user], rows: policies.map(policy => ({ policy, members: [{ email: user.email, budget: { configured: true, ledger: 'durable_object', spentMicros: 0, limitMicros: 1_000_000, remainingMicros: 1_000_000 } }] })) },
    };
    await route.fulfill({ json: responses[path] ?? {} });
  });
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Caps', exact: true }).click();
  return { user, writes };
}

test('Switching policies resets unsaved member cap edits even when limits match', async ({ page }) => {
  const { user, writes } = await openCaps(page);
  const mode = page.getByRole('combobox', { name: `${user.email} monthly cap mode`, exact: true });
  await mode.selectOption('unlimited');
  await page.getByLabel('Caps policy').selectOption('beta');
  await expect(mode).toHaveValue('inherit');
  await mode.selectOption('number');
  await page.getByLabel(`${user.email} monthly cap USD`).fill('123');
  await page.getByLabel('Caps policy').selectOption('alpha');
  await expect(mode).toHaveValue('inherit');
  await expect(page.getByLabel(`${user.email} monthly cap USD`)).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('Saving one cap keeps unrelated member drafts until their own Save', async ({ page }) => {
  const { user, writes } = await openCaps(page);
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: user.email }) });
  const daily = row.getByLabel(`${user.email} daily cap USD`);
  const weekly = row.getByLabel(`${user.email} weekly cap USD`);
  await row.getByLabel(`${user.email} daily cap mode`).selectOption('number');
  await daily.fill('20');
  await row.getByLabel(`${user.email} weekly cap mode`).selectOption('number');
  await weekly.fill('65');
  await row.getByRole('button', { name: `Save ${user.email} weekly cap` }).click();
  await expect(row.getByText('$65.00 (override)', { exact: false })).toBeVisible();
  await expect(row.getByText('$15.00 (inherited)', { exact: false })).toBeVisible();
  await expect(daily).toHaveValue('20');

  // The effective inherited cap changes, but the unsaved member override has not.
  await page.getByLabel('Default daily cap USD').fill('18');
  await page.getByRole('button', { name: 'Save Default daily cap', exact: true }).click();
  await expect(row.getByText('$18.00 (inherited)', { exact: false })).toBeVisible();
  await expect(daily).toHaveValue('20');

  await daily.press('Tab');
  await expect(row.getByRole('button', { name: `Save ${user.email} daily cap` })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row.getByText('$20.00 (override)', { exact: false })).toBeVisible();
  const memberPath = '/v1/admin/access-users/member%40example.com/budget-overrides/alpha';
  expect(writes).toEqual([
    { path: memberPath, body: { weeklyBudgetMicros: 65_000_000 }, ifMatch: 'absent' },
    { path: '/v1/admin/policies/alpha/budget-limits', body: { dailyBudgetMicros: 18_000_000 }, ifMatch: undefined },
    { path: memberPath, body: { weeklyBudgetMicros: 65_000_000, dailyBudgetMicros: 20_000_000 }, ifMatch: '2026-10-18T00:00:01.000Z' },
  ]);
});
