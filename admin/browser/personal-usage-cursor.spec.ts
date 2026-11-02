import { expect, test, type Page } from '@playwright/test';
import { cursorUsageFixture } from '../test/helpers/personal-usage-cursor.mjs';
import { fixtureNow, fixtureResponses } from './fixtures/personal-usage';

async function cursorUsage(page: Page) {
  let now = fixtureNow, failReport = false, failEvents = false, failAnyEvents = false;
  const server = cursorUsageFixture(now), queries: URL[] = [], invalid: string[] = [];
  await page.clock.setFixedTime(new Date(now));
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url()); queries.push(url);
    if (!url.pathname.startsWith('/v1/session/usage/')) {
      const body = fixtureResponses[url.pathname];
      await route.fulfill({ status: body ? 200 : 404, json: body ?? {} }); return;
    }
    try {
      // Validate every request using the shipped parser/cursor and real SQL
      // event pagination, even those whose transport fails below.
      const body = await server.read(url.href, now);
      if (url.pathname.endsWith('/report') && failReport) { failReport = false; throw new Error('Injected report failure'); }
      if (url.pathname.endsWith('/events') && (failAnyEvents || failEvents && url.searchParams.get('to') === new Date(now).toISOString())) { failEvents = false; failAnyEvents = false; throw new Error('Injected event failure'); }
      await route.fulfill({ json: body });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!message.startsWith('Injected')) invalid.push(url.pathname + url.search + ': ' + message);
      await route.fulfill({ status: message.startsWith('Injected') ? 503 : 400, json: { error: { message } } });
    }
  });
  return {
    queries, invalid, close: () => server.close(),
    expire: async () => { now += 16_000; await page.clock.setFixedTime(new Date(now)); },
    failNextReportAndEvents: () => { failReport = true; failEvents = true; },
    failNextReport: () => { failReport = true; },
    failNextEvents: () => { failAnyEvents = true; },
    end: () => new Date(now).toISOString(),
  };
}
const calls = (page: Page) => page.locator('.personalEvents > li');
async function pageTwo(page: Page) {
  await expect(calls(page)).toHaveCount(25);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await expect(calls(page)).toHaveCount(17);
}
async function catalog(page: Page) {
  await page.getByRole('button', { name: 'Catalog', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Catalog', exact: true })).toBeVisible();
}
async function myUsage(page: Page) {
  await page.getByRole('button', { name: 'My usage', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My usage', exact: true })).toBeVisible();
}

test('expired rolling report reentry clears cursor and previous stack before new-bound events; report/event Retry stays anchored', async ({ page }) => {
  const fixture = await cursorUsage(page);
  try {
    await page.goto('/dashboard/my-usage'); await pageTwo(page);
    const oldCursor = fixture.queries.filter(url => url.pathname.endsWith('/events')).at(-1)!.searchParams.get('cursor');
    expect(oldCursor).toBeTruthy();
    await catalog(page); await fixture.expire(); await myUsage(page);
    await expect(page.locator('.personalRange')).toContainText(fixture.end());
    await expect(calls(page)).toHaveCount(25);
    await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
    const newReads = fixture.queries.filter(url => url.pathname.endsWith('/events') && url.searchParams.get('to') === fixture.end());
    expect(newReads.length).toBeGreaterThan(0);
    expect(newReads.every(url => !url.searchParams.has('cursor'))).toBe(true);
    expect(fixture.invalid).toEqual([]);

    await pageTwo(page); await catalog(page); await fixture.expire(); fixture.failNextReportAndEvents(); await myUsage(page);
    await expect(page.getByRole('alert')).toContainText('Injected report failure');
    await page.getByRole('button', { name: 'Retry report', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Injected event failure');
    const failedRead = fixture.queries.filter(url => url.pathname.endsWith('/events')).at(-1)!;
    expect(failedRead.searchParams.get('to')).toBe(fixture.end()); expect(failedRead.searchParams.has('cursor')).toBe(false);
    const reports = fixture.queries.filter(url => url.pathname.endsWith('/report')).length;
    await page.getByRole('button', { name: 'Retry recent calls', exact: true }).click();
    await expect(calls(page)).toHaveCount(25);
    expect(fixture.queries.filter(url => url.pathname.endsWith('/events')).at(-1)!.search).toBe(failedRead.search);
    expect(fixture.queries.filter(url => url.pathname.endsWith('/report'))).toHaveLength(reports);
    await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
    await pageTwo(page);
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(calls(page)).toHaveCount(25); await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
    expect(fixture.invalid).toEqual([]);
  } finally { fixture.close(); }
});

test('same-anchor cached navigation preserves valid page two; expired pinned custom report does too, explicit Refresh resets', async ({ page }) => {
  const fixture = await cursorUsage(page);
  try {
    await page.goto('/dashboard/my-usage'); await pageTwo(page);
    const pageTwoRead = fixture.queries.filter(url => url.pathname.endsWith('/events')).at(-1)!;
    await catalog(page); await myUsage(page);
    await expect(page.getByText('Page 2', { exact: true })).toBeVisible(); await expect(calls(page)).toHaveCount(17);
    expect(fixture.queries.filter(url => url.pathname.endsWith('/report'))).toHaveLength(1);
    expect(fixture.queries.filter(url => url.pathname.endsWith('/events')).at(-1)!.search).toBe(pageTwoRead.search);

    await page.getByText('Custom dates & exact filters', { exact: true }).click();
    await page.getByLabel('Start', { exact: true }).fill(new Date(fixtureNow - 2 * 3600000).toISOString());
    await page.getByLabel('End (exclusive)', { exact: true }).fill(new Date(fixtureNow).toISOString());
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(page.getByText('Page 1', { exact: true })).toBeVisible(); await pageTwo(page);
    const customReport = fixture.queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.search;
    const customPage = fixture.queries.filter(url => url.pathname.endsWith('/events')).at(-1)!.search;
    await catalog(page); await fixture.expire(); await myUsage(page);
    await expect(page.getByText('Page 2', { exact: true })).toBeVisible(); await expect(calls(page)).toHaveCount(17);
    expect(fixture.queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.search).toBe(customReport);
    expect(fixture.queries.filter(url => url.pathname.endsWith('/events')).at(-1)!.search).toBe(customPage);
    await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
    await expect(page.getByText('Page 1', { exact: true })).toBeVisible(); await expect(calls(page)).toHaveCount(25);
    expect(fixture.queries.filter(url => url.pathname.endsWith('/report')).at(-1)!.search).toBe(customReport);
    expect(fixture.invalid).toEqual([]);
  } finally { fixture.close(); }
});


async function customDates(page: Page, from: string, to: string, timezone: string) {
  const advanced = page.locator('.personalAdvanced');
  if (!await advanced.evaluate(element => element.hasAttribute('open'))) await page.getByText('Custom dates & exact filters', { exact: true }).click();
  await page.getByLabel('Start', { exact: true }).fill(from);
  await page.getByLabel('End (exclusive)', { exact: true }).fill(to);
  await page.getByLabel('Timezone', { exact: true }).fill(timezone);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
}

for (const timezone of ['UTC', 'America/Los_Angeles']) {
  test('fully expired custom controls stay usable across grouping, filters, refresh and report Retry: ' + timezone, async ({ page }) => {
    const fixture = await cursorUsage(page);
    try {
      await page.goto('/dashboard/my-usage'); await pageTwo(page);
      const eventsBefore = fixture.queries.filter(url => url.pathname.endsWith('/events')).length;
      const from = '2026-10-01', to = '2026-10-02';
      const resolvedEnd = timezone === 'UTC' ? '2026-10-02T00:00:00.000Z' : '2026-10-02T07:00:00.000Z';
      await customDates(page, from, to, timezone);
      const assertEmpty = async () => {
        await expect(page.locator('.personalRange')).toContainText(resolvedEnd + ' → ' + resolvedEnd);
        await expect(page.getByText('No recent model calls for these filters.', { exact: true })).toBeVisible();
        await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Export this page CSV', exact: true })).toBeDisabled();
        await expect(page.getByLabel('Start', { exact: true })).toHaveValue(from);
        await expect(page.getByLabel('End (exclusive)', { exact: true })).toHaveValue(to);
        await expect(page.getByLabel('Timezone', { exact: true })).toHaveValue(timezone);
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Retry recent calls', exact: true })).toHaveCount(0);
        expect(fixture.queries.filter(url => url.pathname.endsWith('/events'))).toHaveLength(eventsBefore);
        const reportRead = fixture.queries.filter(url => url.pathname.endsWith('/report')).at(-1)!;
        expect(reportRead.searchParams.get('from')).toBe(from); expect(reportRead.searchParams.get('to')).toBe(to);
        expect(reportRead.searchParams.get('timezone')).toBe(timezone);
      };
      await assertEmpty();
      await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('provider');
      await expect(page.getByRole('heading', { name: 'By provider', exact: true })).toBeVisible(); await assertEmpty();
      await page.getByLabel('Model (exact)', { exact: true }).fill('missing-model');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect(page.locator('.personalWarning').filter({ hasText: 'Exact filters:' })).toContainText('model = missing-model'); await assertEmpty();
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await expect(page.locator('.personalWarning').filter({ hasText: 'Exact filters:' })).toHaveCount(0); await assertEmpty();
      await page.getByRole('button', { name: 'Refresh report', exact: true }).click(); await assertEmpty();
      fixture.failNextReport(); await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Injected report failure');
      await expect(page.getByLabel('Start', { exact: true })).toHaveValue(from);
      await expect(page.getByLabel('End (exclusive)', { exact: true })).toHaveValue(to);
      await page.getByRole('button', { name: 'Retry report', exact: true }).click(); await assertEmpty();
      const count = fixture.queries.length; await page.waitForTimeout(100); expect(fixture.queries).toHaveLength(count);
      expect(fixture.invalid).toEqual([]);
    } finally { fixture.close(); }
  });

  test('partially expired custom uses clipped event instants but original controls and pinned refresh: ' + timezone, async ({ page }) => {
    const fixture = await cursorUsage(page);
    try {
      await page.goto('/dashboard/my-usage'); await expect(calls(page)).toHaveCount(25);
      const from = '2026-10-02', to = '2026-11-01';
      const clipped = new Date(fixtureNow - 30 * 86400000).toISOString();
      const resolvedEnd = timezone === 'UTC' ? '2026-11-01T00:00:00.000Z' : '2026-11-01T07:00:00.000Z';
      fixture.failNextEvents(); await customDates(page, from, to, timezone);
      await expect(page.locator('.personalRange')).toContainText(clipped + ' → ' + resolvedEnd);
      await expect(page.getByLabel('Start', { exact: true })).toHaveValue(from);
      await expect(page.getByLabel('End (exclusive)', { exact: true })).toHaveValue(to);
      await expect(page.getByRole('alert')).toContainText('Injected event failure');
      const failed = fixture.queries.filter(url => url.pathname.endsWith('/events')).at(-1)!;
      expect(failed.searchParams.get('from')).toBe(clipped); expect(failed.searchParams.get('to')).toBe(resolvedEnd);
      expect(Date.parse(failed.searchParams.get('to')!)).toBeLessThanOrEqual(fixtureNow); expect(failed.searchParams.has('cursor')).toBe(false);
      await page.getByRole('button', { name: 'Retry recent calls', exact: true }).click();
      await expect(page.getByText('No recent model calls for these filters.', { exact: true })).toBeVisible();
      expect(fixture.queries.filter(url => url.pathname.endsWith('/events')).at(-1)!.search).toBe(failed.search);
      await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('key');
      await expect(page.getByRole('heading', { name: 'By key', exact: true })).toBeVisible();
      await page.getByLabel('Model (exact)', { exact: true }).fill('missing-model');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect(page.locator('.personalWarning').filter({ hasText: 'Exact filters:' })).toContainText('model = missing-model');
      await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
      await expect(page.getByText('No recent model calls for these filters.', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Start', { exact: true })).toHaveValue(from);
      await expect(page.getByLabel('End (exclusive)', { exact: true })).toHaveValue(to);
      const reports = fixture.queries.filter(url => url.pathname.endsWith('/report') && url.searchParams.has('from'));
      expect(reports.every(url => url.searchParams.get('from') === from && url.searchParams.get('to') === to && url.searchParams.get('timezone') === timezone)).toBe(true);
      const events = fixture.queries.filter(url => url.pathname.endsWith('/events') && url.searchParams.get('to') === resolvedEnd);
      expect(events.length).toBeGreaterThanOrEqual(4);
      expect(events.every(url => url.searchParams.get('from') === clipped && !url.searchParams.has('cursor'))).toBe(true);
      expect(fixture.invalid).toEqual([]);
    } finally { fixture.close(); }
  });

  test('current custom interval with no calls still fetches a valid event page and Retry: ' + timezone, async ({ page }) => {
    const fixture = await cursorUsage(page);
    try {
      await page.goto('/dashboard/my-usage'); await expect(calls(page)).toHaveCount(25);
      const eventsBefore = fixture.queries.filter(url => url.pathname.endsWith('/events')).length;
      fixture.failNextEvents(); await customDates(page, '2026-11-01', '2026-11-02', timezone);
      await expect(page.getByText('No model calls in this period for these filters.', { exact: true })).toBeVisible();
      await expect(page.getByRole('alert')).toContainText('Injected event failure');
      const failed = fixture.queries.filter(url => url.pathname.endsWith('/events')).at(-1)!;
      expect(Date.parse(failed.searchParams.get('from')!)).toBeLessThan(Date.parse(failed.searchParams.get('to')!));
      expect(Date.parse(failed.searchParams.get('to')!)).toBeLessThanOrEqual(fixtureNow);
      await page.getByRole('button', { name: 'Retry recent calls', exact: true }).click();
      await expect(page.getByText('No recent model calls for these filters.', { exact: true })).toBeVisible();
      expect(fixture.queries.filter(url => url.pathname.endsWith('/events'))).toHaveLength(eventsBefore + 2);
      expect(fixture.queries.filter(url => url.pathname.endsWith('/events')).at(-1)!.search).toBe(failed.search);
      await expect(page.getByLabel('Start', { exact: true })).toHaveValue('2026-11-01');
      await expect(page.getByLabel('End (exclusive)', { exact: true })).toHaveValue('2026-11-02');
      expect(fixture.invalid).toEqual([]);
    } finally { fixture.close(); }
  });
}
