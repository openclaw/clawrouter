import { expect, test } from '@playwright/test';
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

test('Switching policies resets unsaved member cap edits even when limits match', async ({ page }) => {
  const policies = ['alpha', 'beta'].map(policyId => ({ policyId, enabled: true, providers: [], budgetScope: 'principal', monthlyBudgetMicros: 1_000_000, retainRequestContent: false }));
  const user = { email: 'member@example.com', role: 'user', tenantId: 'synthetic', enabled: true, groups: [], contentRetentionDisabled: false };
  let writes = 0;
  await page.route('**/v1/**', async route => {
    if (route.request().method() !== 'GET') writes++;
    const responses: Record<string, unknown> = {
      '/v1/session': { authenticated: true, auth: 'cloudflare_access', role: 'admin', email: 'admin@example.com', entitlements: { providers: [] } },
      '/v1/providers': { providers: [] }, '/v1/routes': { openaiCompatible: [], manifestProxy: [] },
      '/v1/session/credentials': { credentials: [] }, '/v1/session/usage': { policies: [] },
      '/v1/admin/bootstrap': { policies, users: [user], credentials: [], bindings: [], grants: [], connections: [], rules: [], tenants: [], overview: {} },
      '/v1/admin/caps': { users: [user], rows: policies.map(policy => ({ policy, members: [{ email: user.email, budget: { configured: true, ledger: 'durable_object', spentMicros: 0, limitMicros: 1_000_000, remainingMicros: 1_000_000 } }] })) },
    };
    await route.fulfill({ json: responses[new URL(route.request().url()).pathname] ?? {} });
  });
  await page.goto('/dashboard/users');
  await page.getByRole('button', { name: 'Caps', exact: true }).click();
  const mode = page.getByRole('combobox', { name: `${user.email} monthly cap mode`, exact: true });
  await mode.selectOption('unlimited');
  await page.getByLabel('Caps policy').selectOption('beta');
  await expect(mode).toHaveValue('inherit');
  await mode.selectOption('number');
  await page.getByLabel(`${user.email} monthly cap USD`).fill('123');
  await page.getByLabel('Caps policy').selectOption('alpha');
  await expect(mode).toHaveValue('inherit');
  await expect(page.getByLabel(`${user.email} monthly cap USD`)).toHaveCount(0);
  expect(writes).toBe(0);
});
