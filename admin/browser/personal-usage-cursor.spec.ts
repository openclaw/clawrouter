import { expect, test, type Page } from '@playwright/test';
import { cursorUsageFixture } from '../test/helpers/personal-usage-cursor.mjs';
import { fixtureNow, fixtureResponses } from './fixtures/personal-usage';

async function cursorUsage(page: Page) {
  let now = fixtureNow, failReport = false, failEvents = false;
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
      if (url.pathname.endsWith('/events') && failEvents && url.searchParams.get('to') === new Date(now).toISOString()) { failEvents = false; throw new Error('Injected event failure'); }
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
