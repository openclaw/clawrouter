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

async function openCaps(page: Page, monthlyBudgetMicros = 1_000_000) {
  const policies = ['alpha', 'beta'].map(policyId => ({
    policyId, enabled: true, providers: [], budgetScope: 'principal', dailyBudgetMicros: 15_000_000, monthlyBudgetMicros, retainRequestContent: false,
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
      '/v1/admin/caps': { users: [user], rows: policies.map(policy => ({ policy, members: [{ email: user.email, budget: { configured: true, ledger: 'durable_object', spentMicros: 1, limitMicros: policy.monthlyBudgetMicros, remainingMicros: policy.monthlyBudgetMicros - 1 } }] })) },
    };
    await route.fulfill({ json: responses[path] ?? {} });
  });
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Caps', exact: true }).click();
  return { user, writes };
}

test('Caps shows exact inherited and overridden limits and resaves the same microdollars', async ({ page }) => {
  const { user, writes } = await openCaps(page, Number.MAX_SAFE_INTEGER);
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: user.email }) });
  const defaultInput = page.getByLabel('Default monthly cap USD');
  await expect(defaultInput).toHaveValue('9007199254.740991');
  await expect(row.getByText('<$0.01 / $9007199254.740991 (inherited)', { exact: true })).toBeVisible();
  const defaultSave = page.getByRole('button', { name: 'Save Default monthly cap', exact: true });
  await defaultInput.press('Tab');
  await expect(defaultSave).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => writes.map(write => write.body)).toEqual([{ monthlyBudgetMicros: Number.MAX_SAFE_INTEGER }]);
  await expect(defaultSave).toBeEnabled();

  const label = user.email + ' daily cap';
  await row.getByLabel(label + ' mode').selectOption('number');
  const input = row.getByLabel(label + ' USD');
  const save = row.getByRole('button', { name: 'Save ' + label, exact: true });
  await input.fill('0');
  await save.click();
  await expect(row.getByText('unknown / $0.00 (override)', { exact: true })).toBeVisible();
  await input.fill('0.000001');
  await save.click();
  await expect(row.getByText('unknown / $0.000001 (override)', { exact: true })).toBeVisible();
  await input.fill('9007199254.740989');
  await save.click();
  await expect(row.getByText('unknown / $9007199254.740989 (override)', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('9007199254.740989');
  await save.click(); // Re-saving the stored override must not add a microdollar.
  await expect.poll(() => writes.slice(1).map(write => write.body)).toEqual([
    { dailyBudgetMicros: 0 }, { dailyBudgetMicros: 1 }, { dailyBudgetMicros: 9_007_199_254_740_989 }, { dailyBudgetMicros: 9_007_199_254_740_989 },
  ]);
});

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

for (const scope of ['default', 'member'] as const) {
  test(`Caps ${scope} Amount validates text without interpreting it as a mode`, async ({ page }) => {
    const policy = { policyId: 'alpha', enabled: true, providers: [], budgetScope: 'principal', monthlyBudgetMicros: 10_000_000,
      grantRouting: { strategy: 'priority', stickiness: 'none', failover: true, staleState: 'allow', staleAfterSeconds: 300, eligibleGrants: {} },
    };
    const updatedAt = '2026-10-17T00:00:00.000Z';
    const user = { email: 'member@example.com', enabled: true, role: 'user', groups: [], budgetOverrides: {
      alpha: { weeklyBudgetMicros: 9_000_000, monthlyBudgetMicros: 4_000_000, updatedAt, updatedBy: 'admin@example.com' },
    } };
    const responses: Record<string, unknown> = {
      '/v1/session': { authenticated: true, auth: 'cloudflare_access', role: 'admin', email: 'admin@example.com', entitlements: { providers: [] } },
      '/v1/providers': { providers: [] }, '/v1/routes': { openaiCompatible: [], manifestProxy: [] },
      '/v1/session/credentials': { credentials: [] }, '/v1/session/usage': { policies: [] },
      '/v1/admin/bootstrap': { policies: [policy], users: [user], credentials: [], bindings: [], grants: [], connections: [], rules: [], providers: [], tenants: [], overview: null, fusion: { enabled: false, adviserModels: [], aggregatorModel: '' } },
      '/v1/admin/caps': { users: [user], rows: [{ policy, members: [{ email: user.email, budget: { spentMicros: 0 } }] }] },
    };
    await page.route('**/v1/**', route => route.fulfill({ json: responses[new URL(route.request().url()).pathname] ?? {} }));
    await page.goto('/dashboard/users');
    await page.getByRole('button', { name: 'Caps', exact: true }).click();
    const label = `${scope === 'default' ? 'Default' : user.email} monthly cap`;
    const mode = page.getByLabel(`${label} mode`, { exact: true });
    const input = page.getByLabel(`${label} USD`, { exact: true });
    const save = page.getByRole('button', { name: `Save ${label}`, exact: true });
    await mode.selectOption('number');
    const requests: import('@playwright/test').Request[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) requests.push(request); });
    for (const invalid of ['unlimited', 'inherit', '', '-1', '0.0000001']) {
      await input.fill(invalid);
      await save.click();
      await expect(page.getByRole('alert')).toHaveText('Enter non-negative USD with at most six decimal places.');
      await expect(mode).toHaveValue('number');
      await expect(input).toHaveValue(invalid);
      expect(requests).toHaveLength(0);
    }

    const member = scope === 'member';
    const path = member ? '/v1/admin/access-users/member%40example.com/budget-overrides/alpha' : '/v1/admin/policies/alpha/budget-limits';
    async function expectSave(monthlyBudgetMicros: number | null | undefined) {
      const refresh = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/admin/caps');
      await save.click();
      await refresh;
      await expect(save).toBeEnabled();
      const writes = requests.splice(0).filter(request => request.method() !== 'GET');
      expect(writes).toHaveLength(1);
      const [write] = writes;
      expect(write.method()).toBe('PUT');
      expect(new URL(write.url()).pathname).toBe(path);
      expect(await write.headerValue('if-match')).toBe(member ? updatedAt : null);
      expect(write.postDataJSON()).toStrictEqual({ ...(member ? { weeklyBudgetMicros: 9_000_000 } : {}), ...(monthlyBudgetMicros === undefined ? {} : { monthlyBudgetMicros }) });
    }
    await input.fill('0');
    await expectSave(0);
    await input.fill('0.000001');
    await expectSave(1);
    await mode.selectOption('unlimited');
    await expectSave(null);
    if (member) {
      await mode.selectOption('inherit');
      await expectSave(undefined);
    }
  });
}
