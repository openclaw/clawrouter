import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { cursorUsageFixture } from '../test/helpers/personal-usage-cursor.mjs';
import { fixtureResponses } from './fixtures/personal-usage';

async function fromMemberHome(page: Page, populated = true) {
  const history = await cursorUsageFixture({rows: 0});
  if (populated) {
    // The historical key is intentionally absent from today's inventory.
    await history.ingest('build', {credential_id: 'archived-build', input_tokens: 120, output_tokens: 30, actual_cost_micros: 10000});
    await history.ingest('laptop', {credential_id: 'workstation', input_tokens: 10, output_tokens: 20, actual_cost_micros: 50000});
    await history.ingest('web', {credential_id: null, cost_basis: 'unpriced_usage'});
  }
  await page.clock.setFixedTime(new Date(history.now));
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/v1/session/usage/')) {
      await route.fulfill({json: await history.read(url.href, history.now, route.request().method())});
    } else if (url.pathname === '/v1/session/avatar') await route.fulfill({status: 204});
    else {
      const body = fixtureResponses[url.pathname];
      await route.fulfill({status: body ? 200 : 404, json: body ?? {}});
    }
  });
  await page.goto('/');
  await page.getByRole('button', {name: 'Open My usage'}).click();
  await expect(page.getByRole('heading', {name: 'Top models'})).toBeVisible();
  return async () => { await page.unrouteAll({behavior: 'wait'}); history.close(); };
}

const button = (page: Page, name: string) => page.getByRole('button', {name, exact: true});
const ranks = (page: Page) => page.getByRole('region', {name: 'Usage breakdown'});
const metrics = (page: Page) => page.getByRole('group', {name: 'Chart metric'});
const scope = (page: Page) => page.getByRole('region', {name: 'Your personal usage'}).locator('.personalActiveFilters');
const period = (page: Page) => scope(page).locator('time').evaluateAll(times => times.map(time => time.dateTime));

for (const theme of ['light', 'dark'] as const) {
  test('Compare keys reveals the metric and retained identities in ' + theme, async ({page, isMobile}) => {
    await page.emulateMedia({colorScheme: theme});
    const close = await fromMemberHome(page);
    try {
      await button(page, 'Last 30 days').click();
      await expect(page.getByRole('heading', {name: 'Top models'})).toBeVisible();
      await button(page, 'Compare keys').press('Enter');
      const rank = ranks(page), metric = metrics(page);
      await expect(rank.getByRole('heading', {name: 'Top keys'})).toBeVisible();
      await expect(button(page, 'Comparing keys')).toBeFocused();
      await expect(metric).toHaveCount(1);
      await expect(rank).toHaveCount(1);
      // Check before Playwright scrolls for a later interaction.
      await expect(metric).toBeInViewport({ratio: 1});
      await expect(rank.getByRole('button', {name: 'archived-build'})).toBeInViewport({ratio: 1});
      await expect(rank.getByRole('button', {name: 'workstation'})).toBeInViewport({ratio: 1});
      const selectedPeriod = await period(page);
      expect(selectedPeriod).toHaveLength(2);
      if (isMobile) {
        const order = await page.evaluate(() => {
          const selectors = ['.personalActiveFilters','.personalMetricSwitch','.personalRanksPanel','.personalGlance','.personalTrendPanel'];
          const elements = selectors.map(selector => document.querySelector(selector)!);
          return elements.slice(1).every((el, i) => (elements[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
            && elements[i].getBoundingClientRect().bottom <= el.getBoundingClientRect().top + 1);
        });
        expect(order).toBe(true);
      }
      await expect(rank.getByRole('listitem').first()).toContainText('archived-build150');
      await metric.getByRole('button', {name: 'API cost'}).press('Space');
      await expect(rank.getByRole('listitem').first()).toContainText('workstation$0.05');
      await expect(rank.getByRole('listitem').filter({hasText: 'Dashboard session'})).toContainText('Not reported');
      await rank.getByRole('button', {name: 'workstation'}).press('Enter');
      await expect(scope(page)).toContainText('Selected key = workstation');
      expect(await period(page)).toEqual(selectedPeriod);
      await button(page, 'Show all keys').click();
      await expect(scope(page)).toContainText('All keys and dashboard sessions');
      expect(await period(page)).toEqual(selectedPeriod);
      const axe = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      expect(axe.violations).toEqual([]);
    } finally { await close(); }
  });
}

test('a delayed comparison does not pull a member back after they leave its trigger', async ({page}) => {
  await page.setViewportSize({width: 320, height: 568});
  const close = await fromMemberHome(page);
  const release = Promise.withResolvers<void>();
  try {
    const comparing = (url: URL) => url.pathname.endsWith('/usage/report') && url.searchParams.get('groupBy') === 'key';
    await page.route(comparing, async route => { await release.promise; await route.fallback(); });
    const pending = page.waitForRequest(req => comparing(new URL(req.url())));
    await button(page, 'Compare keys').press('Enter');
    await pending;
    // Leave the trigger before the key report arrives. Focus and the visible
    // controls must not be scrolled away to reveal a no-longer-requested result.
    await page.keyboard.press('Shift+Tab');
    const grouping = page.getByRole('combobox', {name: 'Group by'});
    await expect(grouping).toBeFocused();
    const controlPosition = (await grouping.boundingBox())!.y;
    release.resolve();
    await expect(ranks(page).getByRole('heading', {name: 'Top keys'})).toBeVisible();
    await expect(grouping).toBeFocused();
    await expect(grouping).toBeInViewport({ratio: 1});
    expect((await grouping.boundingBox())!.y).toBeCloseTo(controlPosition, 0);
  } finally { release.resolve(); await close(); }
});

test('short reflowed view reveals an empty comparison without stealing keyboard focus', async ({page}) => {
  await page.setViewportSize({width: 320, height: 568});
  const close = await fromMemberHome(page, false);
  try {
    await button(page, 'Compare keys').press('Enter');
    const trigger = button(page, 'Comparing keys');
    await expect(ranks(page).getByText('No groups in this period.')).toBeInViewport({ratio: 1});
    await expect(trigger).toBeFocused();
    await expect(trigger).toBeInViewport({ratio: 1});
    await expect(metrics(page)).toBeInViewport({ratio: 1});
    await expect(scope(page)).toBeInViewport({ratio: 1});
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', {name: 'Grain'})).toBeFocused();
    // Resize on the active report: one metric switch, one ranking, same dates.
    const selectedPeriod = await period(page);
    await page.setViewportSize({width: 1280, height: 900});
    await expect(page.getByRole('tabpanel', {name: 'Overview'}).getByRole('region', {name: 'Usage breakdown'})).toHaveCount(1);
    expect(await period(page)).toEqual(selectedPeriod);
    await page.setViewportSize({width: 640, height: 450});
    await expect(page.getByRole('region', {name: 'Your personal usage'}).getByRole('group', {name: 'Chart metric'})).toHaveCount(1);
    await expect(ranks(page)).toHaveCount(1);
    expect(await period(page)).toEqual(selectedPeriod);
  } finally { await close(); }
});
