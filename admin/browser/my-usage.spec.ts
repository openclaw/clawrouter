import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { fixtureEvents, fixtureMetrics, fixtureNow, fixtureReport, fixtureResponses } from './fixtures/personal-usage';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(fixtureNow));
  await page.addInitScript(() => localStorage.setItem('clawrouter-theme', 'light'));
});
async function mockUsage(page: Page, override?: (route: Route, url: URL) => Promise<boolean>) {
  const queries: URL[] = [];
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url()); queries.push(url);
    if (await override?.(route, url)) return;
    const body = url.pathname === '/v1/session/usage/report' ? fixtureReport(url.searchParams) : url.pathname === '/v1/session/usage/events' ? fixtureEvents(url.searchParams) : fixtureResponses[url.pathname];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  return queries;
}
const summary = (page: Page) => page.getByRole('region', { name: 'Your personal usage', exact: true });

test('personal report is accessible, price-safe and responsive with independent event pages', async ({ page }, testInfo) => {
  const queries = await mockUsage(page);
  const openedAt = Date.now();
  await page.goto('/dashboard/my-usage');
  await expect(page.getByRole('heading', { name: 'My usage', exact: true })).toBeVisible();
  await expect(summary(page).locator('.personalCallStats dd').first()).toHaveText('42');
  const reportReadyMs = Date.now() - openedAt;
  await expect(page.locator('.personalEvents > li')).toHaveCount(3);
  const eventsReadyMs = Date.now() - openedAt;
  await expect(summary(page)).toContainText('38 generation · 4 utility');
  await expect(summary(page)).toContainText('40/42 calls reported');
  const costs = page.getByRole('region', { name: 'Costs by billing lane' });
  await expect(costs.getByRole('row', { name: /Calculated \+ fixed subtotal/ })).toContainText('$1.39 · 20 calls');
  await expect(costs.getByRole('row', { name: /Unknown price/ })).toContainText('3 calls · price unknown');
  await expect(page.locator('.personalEvents > li').last()).toContainText('Price unknown');
  const trend = page.getByRole('region', { name: 'Daily usage trend', exact: true });
  await expect(trend.getByRole('columnheader', { name: 'Reporting costs by lane & quality', exact: true })).toBeVisible();
  await expect(trend).toContainText('API · Calculated:');
  await expect(trend).toContainText('Subscription · Calculated:');
  await expect(trend).toContainText('Unattributed · Unknown price: Price unknown');
  await page.getByText('Call details', { exact: true }).first().click();
  await expect(page.getByRole('link', { name: 'adviser', exact: true })).toHaveAttribute('href', '#usage-event-1-1');
  const detail = page.locator('.personalEvents > li').first();
  await expect(detail).toContainText('Estimate reason');
  await expect(detail).toContainText('max_declared_rate');
  await expect(detail).toContainText('not a guaranteed upper bound');
  await expect(detail.locator('.personalEventDetails > div').filter({ has: page.getByText('Recorded budget charge', { exact: true }) })).toContainText('$0.00');
  await expect(detail.locator('.personalEventDetails > div').filter({ has: page.getByText('Reporting-only price', { exact: true }) })).toContainText('$0.018');
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => { window.scrollTo(0, 0); return document.fonts.ready; });
  await expect(page).toHaveScreenshot('my-usage.png', { fullPage: true, animations: 'disabled' });
  await testInfo.attach('synthetic-report-performance', { body: JSON.stringify({ reportReadyMs, eventsReadyMs, domNodes: await page.locator('*').count() }), contentType: 'application/json' });
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await expect(page.locator('.personalEvents > li')).toHaveCount(2);
  await expect(summary(page).locator('.personalCallStats dd').first()).toHaveText('42');
  expect(queries.filter(url => url.pathname.endsWith('/report'))).toHaveLength(1);
  expect(queries.filter(url => url.pathname.endsWith('/events')).every(url => url.searchParams.get('limit') === '25')).toBe(true);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export breakdown CSV' }).click();
  expect((await download).suggestedFilename()).toBe('my-usage-breakdown.csv');
});

test('filters, grouping and 30d range use exact bounded query parameters', async ({ page }) => {
  const queries = await mockUsage(page);
  await page.goto('/dashboard/my-usage');
  await page.getByRole('button', { name: 'openai/gpt-5-mini', exact: true }).click();
  await expect(page.getByLabel('Model (exact)', { exact: true })).toHaveValue('openai/gpt-5-mini');
  await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('provider');
  await expect(page.getByRole('heading', { name: 'By provider', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'anthropic', exact: true }).click();
  await page.getByText('Custom dates & exact filters', { exact: true }).click();
  await page.getByLabel('Key ID (exact)', { exact: true }).fill('studio-key');
  await page.getByLabel('Status (exact)', { exact: true }).fill('error');
  await page.getByRole('combobox', { name: 'Price quality', exact: true }).selectOption('unknown');
  await page.getByRole('combobox', { name: 'Billing lane', exact: true }).selectOption('unattributed');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => queries.filter(url => url.pathname.endsWith('/report')).at(-1)?.searchParams.get('status')).toBe('error');
  const filtered = queries.filter(url => url.pathname.endsWith('/report')).at(-1)!;
  for (const [key, value] of Object.entries({ model: 'openai/gpt-5-mini', provider: 'anthropic', key: 'studio-key', costClass: 'unknown', lane: 'unattributed' })) expect(filtered.searchParams.get(key)).toBe(value);
  await page.getByRole('button', { name: 'Last 30 days', exact: true }).click();
  await expect.poll(() => { const params = queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.searchParams; return Date.parse(params.get('to')!) - Date.parse(params.get('from')!); }).toBe(30 * 86400000);
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
    else { const value = fixtureReport(url.searchParams); value.metrics = Object.fromEntries(Object.keys(fixtureMetrics).map(key => [key, 0])) as typeof fixtureMetrics; value.groups = []; value.costs = []; value.buckets = []; value.historyComplete = false; await route.fulfill({ json: value }); }
    return true;
  });
  await page.goto('/dashboard/my-usage');
  await expect(page.getByText('Loading your usage report…', { exact: true })).toBeVisible();
  expect(queries.filter(url => url.pathname.endsWith('/events'))).toHaveLength(0);
  release();
  await expect(page.getByRole('alert')).toContainText('Report temporarily unavailable');
  await page.getByRole('button', { name: 'Retry report', exact: true }).click();
  await expect(page.getByText('No model calls in this period for these filters.')).toBeVisible();
  await expect(summary(page)).toContainText('Incomplete history');
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
  await expect(page.getByText('Loading recent model calls…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export breakdown CSV' })).toBeEnabled();
  await page.getByRole('button', { name: 'openai/gpt-5-mini', exact: true }).click();
  await expect(page.locator('.personalEvents > li')).toHaveCount(3);
  release();
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
  await expect(summary(page).locator('.personalCallStats dd').first()).toHaveText('42');
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
  await expect(page.getByRole('alert')).toContainText('Recent calls unavailable');
  await expect(summary(page).locator('.personalCallStats dd').first()).toHaveText('42');
  await expect(page.getByRole('button', { name: 'Export breakdown CSV' })).toBeEnabled();
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
  await expect(summary(page).locator('.personalCallStats dd').first()).toHaveText('42');
  await expect(page.getByText('Loading recent model calls…')).toBeVisible();
  secondOwner = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.tenantSwitch strong')).toHaveText('second@example.com');
  await expect(summary(page).locator('.personalCallStats dd').first()).toHaveText('7');
  release();
  await expect(page.getByText('No recent model calls for these filters.')).toBeVisible();
  await expect(page.getByText('former-owner-only-model')).toHaveCount(0);
  expect(queries.filter(url => url.pathname.endsWith('/report'))).toHaveLength(2);
});

test('null credential groups and event details say Dashboard session, never a policy fallback', async ({ page }) => {
  await mockUsage(page);
  await page.goto('/dashboard/my-usage');
  await expect(page.locator('.personalEvents > li')).toHaveCount(3);
  const sessionEvent = page.locator('.personalEvents > li').nth(1);
  await sessionEvent.getByText('Call details', { exact: true }).click();
  await expect(sessionEvent.locator('.personalEventDetails > div').filter({ has: page.getByText('Key ID', { exact: true }) })).toContainText('Dashboard session');
  await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('key');
  const groups = page.getByRole('region', { name: 'Grouped model calls', exact: true });
  await expect(groups.getByRole('rowheader', { name: 'Dashboard session', exact: true })).toBeVisible();
  await expect(groups.getByRole('rowheader', { name: 'Unattributed', exact: true })).toHaveCount(0);
  await expect(groups.getByRole('button', { name: 'studio-key', exact: true })).toBeVisible();
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
  await expect(page.locator('.personalEvents > li')).toHaveCount(3);
  const detail = page.locator('.personalEvents > li').first();
  await detail.getByText('Call details', { exact: true }).click();
  await expect(detail.locator('.personalEventDetails > div').filter({ has: page.getByText('Key ID', { exact: true }) })).toContainText('Studio laptop · studio-key');
  const missing = page.locator('.personalEvents > li').last();
  await missing.getByText('Call details', { exact: true }).click();
  await expect(missing.locator('.personalEventDetails > div').filter({ has: page.getByText('Key ID', { exact: true }) })).toHaveText('Key IDremoved-key');
  await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('key');
  await page.getByRole('button', { name: 'Studio laptop · studio-key', exact: true }).click();
  await expect.poll(() => queries.filter(url => url.pathname.endsWith('/report')).at(-1)?.searchParams.get('key')).toBe('studio-key');
  await expect(summary(page)).toContainText('key = Studio laptop · studio-key');
  expect(queries.filter(url => url.pathname === '/v1/session/credentials')).toHaveLength(1);
});


test('refresh advances rolling presets but preserves an explicit custom range', async ({ page }) => {
  const queries = await mockUsage(page);
  await page.goto('/dashboard/my-usage');
  await expect(summary(page).locator('.personalCallStats dd').first()).toHaveText('42');
  await page.clock.setFixedTime(new Date(fixtureNow + 3600000));
  await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
  await expect.poll(() => Date.parse(queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.searchParams.get('to')!)).toBe(fixtureNow + 3600000);
  await page.getByText('Custom dates & exact filters', { exact: true }).click();
  await page.getByLabel('Start', { exact: true }).fill('2026-10-28');
  await page.getByLabel('End (exclusive)', { exact: true }).fill('2026-10-29');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.searchParams.get('from')).toBe('2026-10-28');
  await expect(summary(page).locator('.personalCallStats dd').first()).toHaveText('42');
  await page.clock.setFixedTime(new Date(fixtureNow + 7200000));
  await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
  await expect(summary(page).locator('.personalCallStats dd').first()).toHaveText('42');
  const last = queries.filter(url => url.pathname.endsWith('/report')).at(-1)!;
  expect(last.searchParams.get('from')).toBe('2026-10-28');
  expect(last.searchParams.get('to')).toBe('2026-10-29');
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
  const rows = page.locator('.personalEvents > li');
  await expect(rows).toHaveCount(3);
  const ids = await rows.evaluateAll(elements => elements.map(element => element.id));
  expect(new Set(ids).size).toBe(3);
  await rows.first().getByText('Call details', { exact: true }).click();
  await expect(rows.first().getByRole('link', { name: 'adviser', exact: true })).toHaveAttribute('href', '#' + ids[1]);
  await expect(rows.first()).toContainText('not a guaranteed upper bound');
  expect(errors).toEqual([]);
});
