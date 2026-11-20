import { completeDisplayOutcome, completeDisplayReport } from './fixtures/complete-usage';
import { parseUsageRangeInput } from '../src/usage-range';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { fixtureEvents, fixtureMetrics, fixtureNow, fixtureReport, fixtureResponses } from './fixtures/personal-usage';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(fixtureNow));
  await page.addInitScript(() => localStorage.setItem('clawrouter-theme', 'light'));
});
async function mockUsage(page: Page, override?: (route: Route, url: URL) => Promise<boolean>) {
  const queries: URL[] = [];
  await page.route('**/v1/**', async raw => {
    const route = new Proxy(raw, { get(target, key) {
      if (key === 'fulfill') return (options: Parameters<Route['fulfill']>[0]) => target.fulfill({ ...options, ...(options?.json ? { json: completeDisplayOutcome(options.json, new URL(target.request().url())) } : {}) });
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    }});
    const url = new URL(route.request().url()); if(raw.request().method()==='GET')queries.push(url);
    if(route.request().method()==='DELETE'){await raw.fulfill({json:{kind:'complete',value:{released:true}}});return;}
    if (await override?.(route, url)) return;
    const body = url.pathname === '/v1/session/usage/report' ? fixtureReport(url.searchParams) : url.pathname === '/v1/session/usage/events' ? fixtureEvents(url.searchParams) : fixtureResponses[url.pathname];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  return queries;
}
const summary = (page: Page) => page.getByRole('region', { name: 'Your personal usage', exact: true });
async function activity(page: Page) { await page.getByRole('tab', { name: /^Activity/ }).click(); }
async function details(page: Page) { await page.getByRole('tab', { name: 'Details', exact: true }).click(); }
async function advanced(page: Page) {
  if (!await page.locator('.personalAdvanced').evaluate(element => element.hasAttribute('open'))) await page.getByText('Custom dates & exact filters', { exact: true }).click();
}

test('personal report is accessible, price-safe and responsive with independent event pages', async ({ page }, testInfo) => {
  const queries = await mockUsage(page);
  const openedAt = Date.now();
  await page.goto('/dashboard/my-usage');
  await expect(page.getByRole('heading', { name: 'My usage', exact: true })).toBeVisible();
  await expect(summary(page).locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)')).toHaveText('42');
  const reportReadyMs = Date.now() - openedAt;
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  const trend = page.getByRole('region', { name: 'Usage trend', exact: true });
  await expect(trend).toBeVisible();
  await expect(trend.getByRole('img', { name: /^Tokens by bucket in UTC/ })).toBeVisible();
  await expect(trend.locator('.personalChartPoint')).not.toHaveCount(0);
  const ranks = page.getByRole('region', { name: 'Usage breakdown', exact: true });
  await expect(ranks.getByRole('heading', { name: 'Top models', exact: true })).toBeVisible();
  await expect(ranks.locator('.personalRankTrack > span')).not.toHaveCount(0);
  await expect(page.locator('.personalUsageCanvas table')).toHaveCount(0);
  await expect(page.locator('.personalEventDetails')).toHaveCount(0);
  await activity(page);
  await expect(page.locator('.personalActivityTable tbody > tr')).toHaveCount(3);
  const eventsReadyMs = Date.now() - openedAt;
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => { window.scrollTo(0, 0); return document.fonts.ready; });
  await expect(page).toHaveScreenshot('my-usage.png', { fullPage: true, animations: 'disabled' });
  await summary(page).getByLabel('Model-call accounting and outcomes', { exact: true }).click();
  await expect(summary(page)).toContainText('38 generation · 4 utility');
  await summary(page).getByLabel('Model-call accounting and outcomes', { exact: true }).click();
  await details(page);
  await expect(page.locator('.personalTokenStats').first()).toContainText('40/42 calls reported');
  const costs = page.getByRole('region', { name: 'Costs by billing lane' });
  await expect(costs.getByRole('row', { name: /Calculated \+ fixed subtotal/ })).toContainText('$1.39 · 20 calls');
  await expect(costs.getByRole('row', { name: /Unknown price/ })).toContainText('3 calls · price unknown');
  const daily = page.getByRole('region', { name: 'Time bucket data', exact: true });
  await expect(daily.getByRole('columnheader', { name: 'Reporting costs by lane & quality', exact: true })).toBeVisible();
  await expect(daily).toContainText('API · Calculated:');
  await expect(daily).toContainText('Subscription · Calculated:');
  await expect(daily).toContainText('Unattributed · Unknown price: Price unknown');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await activity(page);
  await expect(page.locator('.personalActivityTable tbody > tr')).toHaveCount(3);
  await expect(page.locator('.personalActivityTable tbody > tr').last()).toContainText('Price unknown');
  await page.getByText('Call details', { exact: true }).first().click();
  await expect(page.getByRole('link', { name: 'adviser', exact: true })).toHaveAttribute('href', '#usage-event-1-1');
  const detail = page.locator('.personalActivityTable tbody > tr').first();
  await expect(detail).toContainText('Estimate reason');
  await expect(detail).toContainText('max_declared_rate');
  await expect(detail).toContainText('not a guaranteed upper bound');
  await expect(detail.locator('.personalEventDetails > div').filter({ has: page.getByText('Recorded accounting amount', { exact: true }) })).toContainText('$0.00');
  await expect(detail.locator('.personalEventDetails > div').filter({ has: page.getByText('Reporting-only price', { exact: true }) })).toContainText('$0.018');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await testInfo.attach('synthetic-report-performance', { body: JSON.stringify({ reportReadyMs, eventsReadyMs, domNodes: await page.locator('*').count() }), contentType: 'application/json' });
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await expect(page.locator('.personalActivityTable tbody > tr')).toHaveCount(2);
  await expect(summary(page).locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)')).toHaveText('42');
  expect(queries.filter(url => url.pathname.endsWith('/report'))).toHaveLength(1);
  expect(queries.filter(url => url.pathname.endsWith('/events')).every(url => url.searchParams.get('limit') === '100')).toBe(true);
  await details(page);
  await expect(page.getByRole('button', { name: 'Export activity page 2 CSV', exact: true })).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export current rank page CSV' }).click();
  expect((await download).suggestedFilename()).toBe('usage-current-rank-page.csv');
});

test('filters, grouping and 30d range use exact bounded query parameters', async ({ page }) => {
  const queries = await mockUsage(page);
  await page.goto('/dashboard/my-usage');
  await page.getByRole('button', { name: 'openai/gpt-5-mini', exact: true }).click();
  await advanced(page);
  await expect(page.getByLabel('Model (exact)', { exact: true })).toHaveValue('openai/gpt-5-mini');
  await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('provider');
  await expect(page.getByRole('heading', { name: 'Top providers', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'anthropic', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh report', exact: true })).toBeEnabled();
  await advanced(page);
  await page.getByLabel('Key ID (exact)', { exact: true }).fill('studio-key');
  await page.getByLabel('Status (exact)', { exact: true }).fill('error');
  await page.getByRole('combobox', { name: 'Price quality', exact: true }).selectOption('unknown');
  await page.getByRole('combobox', { name: 'Billing lane', exact: true }).selectOption('unattributed');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => queries.filter(url => url.pathname.endsWith('/report')).at(-1)?.searchParams.get('status')).toBe('error');
  const filtered = queries.filter(url => url.pathname.endsWith('/report')).at(-1)!;
  for (const [key, value] of Object.entries({ model: 'openai/gpt-5-mini', provider: 'anthropic', key: 'studio-key', costClass: 'unknown', lane: 'unattributed' })) expect(filtered.searchParams.get(key)).toBe(value);
  await page.getByRole('button', { name: 'Last 30 days', exact: true }).click();
  await expect.poll(() => queries.filter(url => url.pathname.endsWith('/report')).at(-1)?.searchParams.get('days')).toBe('30');
  expect(queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.searchParams.has('to')).toBe(false);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByLabel('Model (exact)', { exact: true })).toHaveValue('');
});

test('loading, report error, retry and empty coverage never imply zero price', async ({ page }) => {
  let release!: () => void, attempt = 0;
  const gate = new Promise<void>(resolve => release = resolve);
  const queries = await mockUsage(page, async (route, url) => {
    if (!url.pathname.endsWith('/report')) return false;
    attempt++;
    if (attempt === 1) { await gate; await route.fulfill({ status: 503, json: { error: { message: 'Report temporarily unavailable' } } }); }
    else { const value = fixtureReport(url.searchParams); value.metrics = Object.fromEntries(Object.keys(fixtureMetrics).map(key => [key, 0])) as unknown as typeof fixtureMetrics; value.groups = []; value.costs = []; value.buckets = []; value.historyComplete = false; await route.fulfill({ json: value }); }
    return true;
  });
  await page.goto('/dashboard/my-usage');
  await expect(page.getByText('Loading your usage report…', { exact: true })).toBeVisible();
  expect(queries.filter(url => url.pathname.endsWith('/events'))).toHaveLength(0);
  release();
  await expect(page.getByRole('alert')).toContainText('Report temporarily unavailable');
  await page.getByRole('button', { name: 'Retry report', exact: true }).click();
  await expect(page.getByText('No calls in discovered locations for this range for your current access.')).toBeVisible();
  await expect(summary(page)).toContainText('Not all historical locations have been assessed.');
  await expect(summary(page)).not.toContainText('$0.00');
  await expect(summary(page)).toContainText('Not reported');
});

test('slow event reads never block reports, exports or navigation and cannot restore a former query', async ({ page }, testInfo) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const queries = await mockUsage(page, async (route, url) => {
    if (url.pathname.endsWith('/events') && !url.searchParams.has('model')) { await gate; await route.fulfill({ json: fixtureEvents() }).catch(() => undefined); return true; }
    return false;
  });
  await page.goto('/dashboard/my-usage');
  await activity(page);
  await expect(page.getByText('Loading recent model calls…', { exact: true })).toBeVisible();
  await details(page);
  await expect(page.getByRole('button', { name: 'Export current rank page CSV' })).toBeEnabled();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'openai/gpt-5-mini', exact: true }).click();
  await activity(page);
  await expect(page.locator('.personalActivityTable tbody > tr')).toHaveCount(3);
  release();
  await advanced(page);
  await expect(page.getByLabel('Model (exact)', { exact: true })).toHaveValue('openai/gpt-5-mini');
  const start = Date.now();
  await page.getByRole('button', { name: 'Catalog', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Catalog', exact: true })).toBeVisible();
  const navigationMs = Date.now() - start;
  expect(navigationMs).toBeLessThan(1500);
  await testInfo.attach('responsive-navigation', { body: JSON.stringify({ navigationMs, requests: queries.map(url => url.pathname + url.search) }), contentType: 'application/json' });
});

test('member home uses only personal report; a slow legacy pool ledger does not block refresh', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const queries = await mockUsage(page, async (route, url) => {
    if (url.pathname === '/v1/session/usage') { await gate; await route.fulfill({ json: fixtureResponses[url.pathname] }).catch(() => undefined); return true; }
    return false;
  });
  await page.goto('/dashboard/home');
  await expect(summary(page).locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)').first()).toHaveText('42');
  await expect(page.locator('.connectionMeta strong')).toHaveText('Connected');
  const budgetReads = queries.filter(url => url.pathname === '/v1/session/usage');
  expect(budgetReads.length).toBeGreaterThan(0);
  expect(budgetReads.every(url => url.searchParams.get('budgets_only') === 'true')).toBe(true);
  await expect(page.locator('.dashboardAnalyticsGrid')).toHaveCount(0);
  await expect(page.locator('.dashboardStats')).toHaveCount(0);
  await expect(page.locator('.dashboardCanvas')).not.toContainText('999,999');
  expect(queries.filter(url => url.pathname.endsWith('/events'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Open My usage', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My usage', exact: true })).toBeVisible();
  release();
});

test('event errors retry independently without removing the report or its export', async ({ page }) => {
  let reads = 0;
  const queries = await mockUsage(page, async (route, url) => {
    if (!url.pathname.endsWith('/events')) return false;
    if (++reads === 1) await route.fulfill({ status: 503, json: { error: { message: 'Recent calls unavailable' } } });
    else await route.fulfill({ json: { events: [], nextCursor: null, historyComplete: true } });
    return true;
  });
  await page.goto('/dashboard/my-usage');
  await activity(page);
  await expect(page.getByRole('alert')).toContainText('Recent calls unavailable');
  await expect(summary(page).locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)').first()).toHaveText('42');
  await details(page);
  await expect(page.getByRole('button', { name: 'Export current rank page CSV' })).toBeEnabled();
  await activity(page);
  await page.getByRole('button', { name: 'Retry recent calls' }).click();
  await expect(page.getByText('No recent model calls for these filters.')).toBeVisible();
  expect(queries.filter(url => url.pathname.endsWith('/report'))).toHaveLength(1);
});

test('identity replacement clears report cache and late former-owner events', async ({ page }) => {
  let secondOwner = false, release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const queries = await mockUsage(page, async (route, url) => {
    if (url.pathname === '/v1/session' && secondOwner) {
      await route.fulfill({ json: { ...(fixtureResponses[url.pathname] as object), email: 'second@example.com', tenantId: 'second-tenant' } }); return true;
    }
    if (url.pathname.endsWith('/report') && secondOwner) {
      const value = fixtureReport(url.searchParams); value.metrics = { ...value.metrics, calls: 7 };
      await route.fulfill({ json: value }); return true;
    }
    if (url.pathname.endsWith('/events')) {
      if (!secondOwner) { await gate; const value = fixtureEvents(); value.events[0].model = 'former-owner-only-model'; await route.fulfill({ json: value }).catch(() => undefined); }
      else await route.fulfill({ json: { events: [], nextCursor: null, historyComplete: true } });
      return true;
    }
    return false;
  });
  await page.goto('/dashboard/my-usage');
  await expect(summary(page).locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)').first()).toHaveText('42');
  await activity(page);
  await expect(page.getByText('Loading recent model calls…')).toBeVisible();
  secondOwner = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.tenantSwitch strong')).toHaveText('second@example.com');
  await expect(summary(page).locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)').first()).toHaveText('7');
  // A verified new identity mounts a fresh screen on Overview. Inspect its real Activity view.
  await activity(page);
  release();
  await expect(page.getByText('No recent model calls for these filters.')).toBeVisible();
  await expect(page.getByText('former-owner-only-model')).toHaveCount(0);
  expect(queries.filter(url => url.pathname.endsWith('/report'))).toHaveLength(2);
});

test('null credential groups and event details say Dashboard session, never a policy fallback', async ({ page }) => {
  await mockUsage(page);
  await page.goto('/dashboard/my-usage');
  await activity(page);
  await expect(page.locator('.personalActivityTable tbody > tr')).toHaveCount(3);
  const sessionEvent = page.locator('.personalActivityTable tbody > tr').nth(1);
  await sessionEvent.getByText('Call details', { exact: true }).click();
  await expect(sessionEvent.locator('.personalEventDetails > div').filter({ has: page.getByText('Key ID', { exact: true }) })).toContainText('Dashboard session');
  await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('key');
  await details(page);
  const groups = page.getByRole('region', { name: 'Retained usage ranking', exact: true });
  await expect(groups.getByRole('rowheader', { name: /Dashboard session/ })).toBeVisible();
  await expect(groups.getByRole('rowheader', { name: 'Unattributed', exact: true })).toHaveCount(0);
  await expect(groups.getByRole('button', { name: /member@example.com · studio-key/ })).toBeVisible();
});

test('available key names retain their actual ID and filters; missing key metadata falls back to ID', async ({ page }) => {
  const queries = await mockUsage(page, async (route, url) => {
    if (url.pathname === '/v1/session/credentials') {
      await route.fulfill({ json: { credentials: [{ credentialId: 'studio-key', name: 'Studio laptop', policyId: 'fixture-policy', principalId: 'member@example.com', enabled: true }] } }); return true;
    }
    if (url.pathname.endsWith('/events')) {
      const value = fixtureEvents(url.searchParams); if (value.events[2]) value.events[2].keyId = 'removed-key';
      await route.fulfill({ json: value }); return true;
    }
    return false;
  });
  await page.goto('/dashboard/my-usage');
  await activity(page);
  await expect(page.locator('.personalActivityTable tbody > tr')).toHaveCount(3);
  const detail = page.locator('.personalActivityTable tbody > tr').first();
  await detail.getByText('Call details', { exact: true }).click();
  await expect(detail.locator('.personalEventDetails > div').filter({ has: page.getByText('Key ID', { exact: true }) })).toContainText('studio-key');
  const missing = page.locator('.personalActivityTable tbody > tr').last();
  await missing.getByText('Call details', { exact: true }).click();
  await expect(missing.locator('.personalEventDetails > div').filter({ has: page.getByText('Key ID', { exact: true }) })).toHaveText('Key IDremoved-key');
  await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('key');
  await details(page);
  await page.getByRole('button', { name: /member@example.com · studio-key/ }).click();
  await expect.poll(() => queries.filter(url => url.pathname.endsWith('/report')).at(-1)?.searchParams.get('key')).toBe('studio-key');
  await expect(summary(page)).toContainText('key = studio-key');
  await expect(page.getByRole('combobox',{name:'Current own-key selector'})).toContainText('Current name: Studio laptop — studio-key');
  expect(queries.filter(url => url.pathname === '/v1/session/credentials')).toHaveLength(1);
});


test('refresh advances rolling presets but preserves an explicit custom range', async ({ page }) => {
  let serverNow = fixtureNow;
  const queries = await mockUsage(page, async (route, url) => {
    if (!url.pathname.endsWith('/report')) return false;
    // The legacy display fixture uses Date.parse (UTC for date-only text).
    // Adapt its input only; keep the actual request and raw controls unchanged.
    const fixtureParams = new URLSearchParams(url.searchParams);
    if (fixtureParams.has('from') && fixtureParams.has('to')) {
      const range = parseUsageRangeInput({ from: fixtureParams.get('from')!, to: fixtureParams.get('to')!, timezone: fixtureParams.get('timezone') ?? 'UTC' });
      fixtureParams.set('from', new Date(range.from).toISOString()); fixtureParams.set('to', new Date(range.to).toISOString());
    }
    await route.fulfill({ json: fixtureReport(fixtureParams, serverNow) }); return true;
  });
  await page.goto('/dashboard/my-usage');
  await expect(summary(page).locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)').first()).toHaveText('42');
  await page.clock.setFixedTime(new Date(fixtureNow + 3600000));
  serverNow += 60000;
  await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
  await expect(summary(page).locator('.personalRange')).toContainText(new Date(serverNow).toISOString());
  const preset = queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.searchParams;
  expect(preset.get('days')).toBe('7'); expect(preset.has('from')).toBe(false); expect(preset.has('to')).toBe(false);
  await advanced(page);
  // Date-only controls mean local midnight in the selected zone, not UTC.
  await page.getByLabel('Timezone', { exact: true }).fill('Asia/Kathmandu');
  await page.getByLabel('Start', { exact: true }).fill('2026-10-28');
  await page.getByLabel('End (exclusive)', { exact: true }).fill('2026-10-29');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.searchParams.get('from')).toBe('2026-10-27T18:15:00.000Z');
  await expect(summary(page).locator('.personalRange')).toContainText('2026-10-28T18:15:00.000Z');
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('2026-10-28');
  await expect(page.getByLabel('End (exclusive)', { exact: true })).toHaveValue('2026-10-29');
  const custom = queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.searchParams;
  expect(custom.get('to')).toBe('2026-10-28T18:15:00.000Z');
  expect(custom.get('cut')).toBeTruthy(); // Same-cut refinement uses normalized instants, not calendar syntax.
  expect(custom.get('timezone')).toBe('Asia/Kathmandu'); expect(custom.has('days')).toBe(false);
  await expect(summary(page).locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)').first()).toHaveText('42');
  const beforeRefresh = queries.filter(url => url.pathname.endsWith('/report')).length;
  serverNow += 60000;
  await page.clock.setFixedTime(new Date(fixtureNow + 7200000));
  await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
  await expect.poll(() => queries.filter(url => url.pathname.endsWith('/report')).length).toBe(beforeRefresh + 1);
  await expect(summary(page).locator('.personalRange')).toContainText('2026-10-28T18:15:00.000Z');
  await expect(summary(page).locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)').first()).toHaveText('42');
  const last = queries.filter(url => url.pathname.endsWith('/report')).at(-1)!;
  expect(last.searchParams.get('from')).toBe('2026-10-28');
  expect(last.searchParams.get('to')).toBe('2026-10-29');
  expect(last.searchParams.get('timezone')).toBe('Asia/Kathmandu');
  expect(last.searchParams.has('days')).toBe(false); expect(last.searchParams.has('cut')).toBe(false);
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('2026-10-28');
  await expect(page.getByLabel('End (exclusive)', { exact: true })).toHaveValue('2026-10-29');
});


test('duplicate cross-shard IDs keep unique rows and correct peer links; real estimate reasons are disclosed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await mockUsage(page, async (route, url) => {
    if (url.pathname === '/v1/session/avatar') { await route.fulfill({ status: 204 }); return true; }
    if (!url.pathname.endsWith('/events')) return false;
    const original = fixtureEvents().events[0];
    const reason = 'served_tier_unreported_max_declared_rate;cache_write_unreported_max_rate_allocation';
    await route.fulfill({ json: { historyComplete: true, nextCursor: null, events: [
      { ...original, id: 'same-ledger-id', compoundStage: 'synthesizer', estimateReason: reason },
      { ...original, id: 'same-ledger-id', compoundStage: 'adviser', estimateReason: reason },
      { ...original, id: String.fromCharCode(0xd800), compoundRequestId: null },
    ] } });
    return true;
  });
  await page.goto('/dashboard/my-usage');
  await activity(page);
  const rows = page.locator('.personalActivityTable tbody > tr');
  await expect(rows).toHaveCount(3);
  const ids = await rows.evaluateAll(elements => elements.map(element => element.id));
  expect(new Set(ids).size).toBe(3);
  await rows.first().getByText('Call details', { exact: true }).click();
  await expect(rows.first().getByRole('link', { name: 'adviser', exact: true })).toHaveAttribute('href', '#' + ids[1]);
  await expect(rows.first()).toContainText('not a guaranteed upper bound');
  expect(errors).toEqual([]);
});


for (const offset of [-60000, 60000]) test('server-time presets survive browser clock offset ' + offset + ', refresh, pagination and custom transitions', async ({ page }) => {
  let serverNow = fixtureNow;
  const queries = await mockUsage(page, async (route, url) => {
    if (!url.pathname.endsWith('/report')) return false;
    const p = url.searchParams;
    if (!p.has('days') && Date.parse(p.get('to')!) > serverNow) {
      await route.fulfill({ status: 400, json: { error: { code: 'invalid_usage_range', message: 'to must not be in the future' } } });
    } else await route.fulfill({ json: fixtureReport(p, serverNow) });
    return true;
  });
  await page.clock.setFixedTime(new Date(fixtureNow + offset));
  await page.goto('/dashboard/home');
  await expect(summary(page).locator('.personalRange')).toContainText(new Date(serverNow).toISOString());
  let reportReads = queries.filter(url => url.pathname.endsWith('/report'));
  expect(reportReads).toHaveLength(1);
  expect(reportReads[0].searchParams.get('days')).toBe('7');
  expect(reportReads[0].searchParams.has('from')).toBe(false); expect(reportReads[0].searchParams.has('to')).toBe(false);
  await page.getByRole('button', { name: 'Open My usage', exact: true }).click();
  await activity(page);
  await expect(page.locator('.personalActivityTable tbody > tr')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Last 7 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await advanced(page);
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue(new Date(serverNow - 7 * 86400000).toISOString());
  await expect(page.getByLabel('End (exclusive)', { exact: true })).toHaveValue(new Date(serverNow).toISOString());
  await page.clock.setFixedTime(new Date(fixtureNow + offset + 120000));
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.personalActivityTable tbody > tr')).toHaveCount(2);
  const firstPages = queries.filter(url => url.pathname.endsWith('/events'));
  expect(firstPages).toHaveLength(2);
  for (const url of firstPages) {
    expect(url.searchParams.get('from')).toBe(new Date(serverNow - 7 * 86400000).toISOString());
    expect(url.searchParams.get('to')).toBe(new Date(serverNow).toISOString());
    expect(url.searchParams.has('days')).toBe(false);
  }
  serverNow += 30000;
  await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
  await expect(summary(page).locator('.personalRange')).toContainText(new Date(serverNow).toISOString());
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  await expect(page.getByLabel('End (exclusive)', { exact: true })).toHaveValue(new Date(serverNow).toISOString());
  await expect.poll(() => queries.filter(url => url.pathname.endsWith('/events')).at(-1)?.searchParams.get('to')).toBe(new Date(serverNow).toISOString());
  // Preset transitions preserve even unapplied exact filters and the chosen timezone.
  await page.getByLabel('Model (exact)', { exact: true }).fill('model + exact');
  await page.getByLabel('Timezone', { exact: true }).fill('Asia/Kathmandu');
  await page.getByRole('combobox', { name: 'Billing lane', exact: true }).selectOption('api');
  await page.getByRole('button', { name: 'Last 30 days', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Last 30 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue(new Date(serverNow - 30 * 86400000).toISOString());
  reportReads = queries.filter(url => url.pathname.endsWith('/report'));
  const preset = reportReads.at(-1)!.searchParams;
  expect(preset.get('days')).toBe('30'); expect(preset.get('model')).toBe('model + exact'); expect(preset.get('lane')).toBe('api'); expect(preset.get('timezone')).toBe('Asia/Kathmandu');
  expect(preset.has('from')).toBe(false); expect(preset.has('to')).toBe(false);
  await page.getByLabel('Start', { exact: true }).fill('2026-10-28T00:00:00Z');
  await page.getByLabel('End (exclusive)', { exact: true }).fill('2026-10-29T00:00:00Z');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.searchParams.get('from')).toBe('2026-10-28T00:00:00.000Z');
  await expect(summary(page).locator('.personalRange')).toContainText('2026-10-29T00:00:00.000Z');
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('2026-10-28T00:00:00Z');
  await expect(page.getByLabel('End (exclusive)', { exact: true })).toHaveValue('2026-10-29T00:00:00Z');
  const customQuery = new URLSearchParams(queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.searchParams);
  expect(customQuery.get('from')).toBe('2026-10-28T00:00:00.000Z'); expect(customQuery.get('to')).toBe('2026-10-29T00:00:00.000Z');
  expect(customQuery.get('model')).toBe('model + exact'); expect(customQuery.get('lane')).toBe('api'); expect(customQuery.get('timezone')).toBe('Asia/Kathmandu');
  expect(customQuery.has('days')).toBe(false);
  customQuery.delete('cut'); const customParams=customQuery.toString();
  const beforeRefresh = queries.filter(url => url.pathname.endsWith('/report')).length;
  serverNow += 30000; await page.clock.setFixedTime(new Date(fixtureNow + offset + 3600000));
  await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
  await expect.poll(() => queries.filter(url => url.pathname.endsWith('/report')).length).toBe(beforeRefresh + 1);
  await expect(summary(page).locator('.personalRange')).toContainText('2026-10-29T00:00:00.000Z');
  await expect(summary(page).locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)').first()).toHaveText('42');
  const refreshed=new URLSearchParams(queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.searchParams);
  expect(refreshed.has('cut')).toBe(false); expect(refreshed.toString()).toBe(customParams);
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('2026-10-28T00:00:00Z');
  await expect(page.getByLabel('End (exclusive)', { exact: true })).toHaveValue('2026-10-29T00:00:00Z');
  await page.getByLabel('End (exclusive)', { exact: true }).fill(new Date(serverNow + 60000).toISOString());
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('to must not be in the future');
  await page.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  await expect(summary(page).locator('.personalRange')).toContainText(new Date(serverNow).toISOString());
  await expect(page.getByLabel('Model (exact)', { exact: true })).toHaveValue('model + exact');
  const recovered = queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.searchParams;
  expect(recovered.get('days')).toBe('7'); expect(recovered.has('from')).toBe(false); expect(recovered.has('to')).toBe(false);
  expect(recovered.get('model')).toBe('model + exact'); expect(recovered.get('lane')).toBe('api'); expect(recovered.get('timezone')).toBe('Asia/Kathmandu');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('capture gaps and pre-tracking history are disclosed without inventing missing usage', async ({page})=>{
 let gap=true;
 await mockUsage(page,async(route,url)=>{if(!url.pathname.endsWith('/report'))return false;const value=completeDisplayReport(fixtureReport(url.searchParams),url.searchParams);value.coverage.captureAudit.captureGapObserved=gap;await route.fulfill({json:{kind:'complete',value}});return true;});
 await page.goto('/dashboard/my-usage');
 await expect(summary(page)).toContainText('Not all historical locations have been assessed.');
 await page.getByText('Report scope and capture dates',{exact:true}).click();
 await expect(summary(page)).toContainText('Location tracking had a gap or incomplete capture; affected usage is unknown.');
 await expect(summary(page)).toContainText('the audit does not quantify missing usage');
 await expect(summary(page).locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)').first()).toHaveText('42');
 await details(page);await expect(page.locator('.personalTokenStats').first()).toContainText('40/42 calls reported');
 gap=false;await page.getByRole('button',{name:'Refresh report',exact:true}).click();
 await expect(summary(page)).not.toContainText('Location tracking had a gap');
 await expect(summary(page)).toContainText('Not all historical locations have been assessed.');
});
