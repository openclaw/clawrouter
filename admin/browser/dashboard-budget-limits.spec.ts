import { expect, test } from '@playwright/test';
import type { AdminUsageRow, BudgetStatus } from '../src/ui-types';
import { fixtureReport, fixtureResponses } from './fixtures/personal-usage';
import { completeDisplayOutcome } from './fixtures/complete-usage';

// Synthetic, read-only inventory. A configured limit is exact even when balances are missing.
for (const role of ['admin', 'user'] as const) test(role + ' sees exact limits without turning missing or rounded balances into configured amounts', async ({page}) => {
  const policyId = 'team_tools';
  const budget: BudgetStatus = {
    configured:true, ledger:'unavailable', limitMicros:15_001, spentMicros:null, remainingMicros:null,
    daily: {configured:true, ledger:'blocked', limitMicros:0, spentMicros:0, remainingMicros:0, resetsAt:'2026-11-27T00:00:00Z'},
    weekly: {configured:false, override:true, ledger:'unmetered', limitMicros:null, spentMicros:15_001, remainingMicros:null, resetsAt:'2026-11-30T00:00:00Z'},
  };
  const row: AdminUsageRow = {kid:policyId, policyId, enabled:true, tenantId:'synthetic', providers:[], monthlyBudgetMicros:15_001, budget};
  const usage = {ledger:'ready', daily:[], providers:[], events:[], summary:{requestCount:1,successCount:1,errorCount:0,inputTokens:1,outputTokens:1,totalTokens:2,actualCostMicros:15_001}};
  const payloads: Record<string, unknown> = {
    '/v1/session': {authenticated:true, auth:'cloudflare_access', role, email:'viewer@example.test', tenantId:'synthetic', entitlements:{providers:[], policies:[{policyId,budget}]}},
    '/v1/providers': {providers:[]}, '/v1/routes': {openaiCompatible:[],manifestProxy:[]}, '/v1/session/credentials': {credentials:[]},
    '/v1/session/usage': {policies:[row],usage}, '/v1/admin/usage': {policies:[row],usage},
    '/v1/admin/bootstrap': {policies:[{...row,grantRouting:{eligibleGrants:{}}}],credentials:[],connections:[],users:[],bindings:[],grants:[],rules:[],providers:[],tenants:[],overview:null,fusion:{enabled:false,adviserModels:[],aggregatorModel:''}},
  };
  await page.route('**/v1/**', async route => {
    expect(route.request().method()).toBe('GET'); const path = new URL(route.request().url()).pathname;
    if (role === 'user') expect(path).not.toMatch(/^\/v1\/admin\//);
    await route.fulfill({status:path in payloads ? 200 : 404,json:payloads[path] ?? {}});
  });
  await page.goto('/dashboard/home');
  const quota = page.locator('.quotaPanel'), keys = page.locator('.myKeysPanel');
  await expect(quota.getByText(policyId, {exact:true})).toBeVisible();
  const monthly = role === 'admin' ? quota : quota.getByRole('group', {name:'Monthly', exact:true});
  await expect(monthly.locator('.quotaNumbers strong')).toHaveText('Remaining unavailable');
  await expect.soft(monthly.locator('.quotaNumbers small')).toHaveText('$0.015001 monthly limit · Used amount unavailable');
  if (role === 'admin') {
    await expect(quota.getByRole('group', {name:/Daily|Weekly/})).toHaveCount(0);
  } else {
    const daily = quota.getByRole('group', {name:'Daily', exact:true});
    await expect(daily).toContainText('$0.00 remaining');
    await expect(daily.locator('time')).toHaveAttribute('datetime', budget.daily!.resetsAt);
    const weekly = quota.getByRole('group', {name:'Weekly', exact:true});
    await expect(weekly).toContainText('No weekly cap');
    await expect(weekly).toContainText('member override');
    await expect(weekly.locator('time')).toHaveAttribute('datetime', budget.weekly!.resetsAt);
    await expect(monthly.locator('time')).toHaveCount(0);
  }
  await expect.soft(keys).toContainText('This month: Unknown used / $0.015001 limit · Unknown remaining');
  await expect(keys).toContainText('Today: $0.00 used / $0.00 limit · $0.00 remaining');
  await expect(keys).toContainText('This week: $0.02 used / unlimited · no cap · member override');
});

test('members see every held policy budget, including an exhausted seventh policy', async ({page}) => {
  const policyIds = ['batch_jobs', 'build_tools', 'demo_models', 'docs_search', 'image_render', 'research', 'support_chat'];
  const rows: AdminUsageRow[] = policyIds.map((policyId, index) => {
    const used = index === 6 ? 10_000_000 : index * 1_000_000;
    return {
      kid: policyId, policyId, enabled: true, tenantId: 'synthetic', providers: ['openai'], monthlyBudgetMicros: 10_000_000,
      budget: { configured: true, ledger: used === 10_000_000 ? 'blocked' : 'ready', limitMicros: 10_000_000, spentMicros: used, remainingMicros: 10_000_000 - used },
    };
  });
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe('GET');
    expect(url.pathname.startsWith('/v1/admin/')).toBe(false);
    let body = fixtureResponses[url.pathname];
    if (url.pathname === '/v1/session') {
      body = { ...body as object, entitlements: { providers: [], policies: rows.map(({ policyId, budget }) => ({ policyId, budget })) } };
    } else if (url.pathname === '/v1/session/usage') {
      expect(url.searchParams.get('budgets_only')).toBe('true');
      body = { ...body as object, policies: rows };
    } else if (url.pathname.endsWith('/usage/report')) {
      body = completeDisplayOutcome(fixtureReport(url.searchParams), url);
    }
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  await page.goto('/dashboard/home');
  const panel = page.locator('.quotaPanel');
  await expect(panel.getByRole('heading', {name: 'Your policy budgets'})).toBeVisible();
  await expect(panel.locator('.quotaIdentity strong')).toHaveText(policyIds);
  const exhausted = panel.locator('article').filter({has: page.getByText('support_chat', {exact: true})});
  await expect(exhausted).toContainText('$0.00 remaining');
  await expect(exhausted).toContainText('100%');
  await expect(panel.getByRole('button', {name: 'Open full usage ledger'})).toHaveCount(0);
});

test('member budgets distinguish spent, missing and positive weekly balances after the quota read', async ({page}) => {
  const reset = '2026-11-30T00:00:00.000Z';
  const weeklyLimit = 5_000_000_000;
  const rows: AdminUsageRow[] = [0, null, 2_000_000].map((remainingMicros, index) => {
    const policyId = ['research', 'tools', 'notebooks'][index];
    return { kid:policyId, policyId, enabled:true, tenantId:'research', providers:['openai'], budgetScope:'principal',
      monthlyBudgetMicros:null, weeklyBudgetMicros:weeklyLimit,
      budget:{configured:false, ledger:'unmetered', limitMicros:null, spentMicros:null, remainingMicros:null,
        weekly:{configured:true, ledger:remainingMicros === null ? 'unavailable' : 'durable_object', limitMicros:weeklyLimit,
          spentMicros:remainingMicros === null ? null : weeklyLimit - remainingMicros, remainingMicros, resetsAt:reset}},
    };
  });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe('GET');
    expect(url.pathname.startsWith('/v1/admin/')).toBe(false);
    let body = fixtureResponses[url.pathname];
    if (url.pathname === '/v1/session') {
      body = {...body as object, entitlements:{providers:[], policies:rows.map(({policyId,budget}) => ({policyId,budget}))}};
    } else if (url.pathname === '/v1/session/usage') {
      expect(url.searchParams.get('budgets_only')).toBe('true');
      reads++;
      await pending;
      body = {...body as object, policies:rows};
    } else if (url.pathname.endsWith('/usage/report')) {
      body = completeDisplayOutcome(fixtureReport(url.searchParams), url);
    }
    await route.fulfill({status:body ? 200 : 404, json:body ?? {}});
  });
  const panel = page.locator('.quotaPanel');
  try {
    await page.goto('/dashboard/home');
    await expect(panel.getByRole('status')).toContainText('Loading usage');
    await expect(panel.getByText('$0.00 remaining', {exact:true})).toHaveCount(0);
  } finally { release(); }
  const balances = ['$0.00 remaining', 'Remaining unavailable', '$2.00 remaining'];
  for (const [i,row] of rows.entries()) {
    const policy = panel.getByRole('article', {name:row.policyId, exact:true});
    const weekly = policy.getByRole('group', {name:'Weekly', exact:true});
    await expect(weekly.getByText(balances[i], {exact:true})).toBeVisible();
    await expect(weekly).toContainText('$5000.00 weekly limit');
    await expect(weekly.locator('time')).toHaveAttribute('datetime', reset);
    await expect(weekly.locator('time')).toContainText('Nov 30, 2026');
    await expect(weekly.locator('time')).toContainText('00:00 UTC');
    await expect(policy.getByRole('group', {name:'Monthly', exact:true})).toHaveCount(0);
    if (i === 1) await expect(weekly.locator('.quotaPercent')).toHaveCount(0);
    else await expect(weekly.locator('.quotaPercent')).toHaveText(i === 0 ? '100%' : '>99%');
  }
  await expect(panel).not.toContainText('No cap at this scope');
  expect(reads).toBe(1);
});
