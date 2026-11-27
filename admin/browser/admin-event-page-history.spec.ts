import { expect, test, type Page } from '@playwright/test';
import { mock } from 'node:test';
import { cursorUsageFixture } from '../test/helpers/personal-usage-cursor.mjs';
import { fixtureResponses } from './fixtures/personal-usage';

async function filteredHistory(page: Page, count: number) {
  const fixture = await cursorUsageFixture({audience: 'admin', rows: count});
  const eventReads: URL[] = [], reportReads: URL[] = [];
  let expired = false;
  const base: Record<string, unknown> = {
    ...fixtureResponses,
    '/v1/session': {...fixtureResponses['/v1/session'] as object, role: 'admin'},
    '/v1/admin/usage': fixtureResponses['/v1/session/usage'],
    '/v1/admin/bootstrap': {policies: [], credentials: [], users: [], bindings: [], grants: [], rules: [], providers: [], connections: [], fusion: {enabled: false, adviserModels: [], aggregatorModel: ''}, overview: null, tenants: []},
  };
  await fixture.ingest('different-model', {model: 'not-selected'});
  await page.clock.setFixedTime(new Date(fixture.now));
  await page.route('**/v1/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith('/v1/admin/usage/')) {
      if (url.pathname.endsWith('/avatar')) await route.fulfill({status: 204});
      else await route.fulfill({status: url.pathname in base ? 200 : 404, json: base[url.pathname] ?? {}});
      return;
    }
    if (request.method() === 'GET') (url.pathname.endsWith('/events') ? eventReads : reportReads).push(url);
    // Advance only the in-process service clock for a read, so its real registry expires the cut.
    const now = fixture.now + (expired ? 16 * 60_000 : 0);
    const clock = expired ? mock.method(Date, 'now', () => now) : undefined;
    let body;
    try { body = await fixture.read(url.href, now, request.method()); }
    finally { clock?.mock.restore(); }
    if (body.kind === 'restart') await route.fulfill({status: 410, json: {...body, error: {message: 'Refresh required'}}});
    else await route.fulfill({json: body});
  });
  return {eventReads, reportReads, expire: () => { expired = true; }, close: async () => {
    await page.unrouteAll({behavior: 'wait'}); fixture.close();
  }};
}

for (const [last, expired] of [[8, false], [9, false], [11, false], [9, true]] as const) {
  test('admin returns through ' + last + ' filtered event pages' + (expired ? ' with an expired snapshot' : ''), async ({page, isMobile}) => {
    test.setTimeout(90_000);
    const f = await filteredHistory(page, (last - 1) * 100 + 1);
    try {
      await page.emulateMedia({colorScheme: isMobile ? 'dark' : 'light'});
      await page.goto('/dashboard/usage');
      const button = (name: string) => page.getByRole('button', {name, exact: true});
      await button('By model').click();
      await page.getByRole('region', {name: 'Retained usage ranking'}).getByRole('button', {name: 'cursor-model', exact: true}).click();
      const scope = page.getByRole('group', {name: 'Displayed report scope'});
      await expect(scope).toContainText('Model: cursor-model');
      const originalScope = await scope.innerText();
      await button('Show events').press('Enter');
      const events = page.getByRole('region', {name: 'Retained events', exact: true});
      const at = async (n: number) => {
        await expect(page.getByText('Page ' + n + ' · at most 100 events · metadata only', {exact: true})).toBeVisible();
        await expect(events.locator('tbody tr')).toHaveCount(n === last ? 1 : 100);
      };
      await at(1);
      const ids = events.locator('tbody tr .personalEventDetails > div:first-child dd');
      const original = await ids.allTextContents();
      expect(original).toHaveLength(100);
      expect(original[0]).toBe('row-0000');
      const first = f.eventReads.at(-1)!;
      expect(first.searchParams.has('cursor')).toBe(false);
      expect(first.searchParams.get('cut')).toBeTruthy();
      expect(first.searchParams.get('model')).toBe('cursor-model');
      const reports = f.reportReads.length;
      const previous = button('Previous page'), recover = button('First page');
      for (let n = 2; n <= last; n++) { await button('Next page').press('Enter'); await at(n); }
      await expect(button('Next page')).toBeDisabled();
      for (let n = last - 1; n >= last - 7; n--) {
        await expect(recover).toHaveCount(0);
        await previous.press('Enter'); await at(n);
      }
      if (last === 8) {
        // Seven normal back steps reach page one; no recovery control or extra fetch.
        await expect(recover).toHaveCount(0);
        expect(f.eventReads).toHaveLength(8);
      } else {
        await expect(previous).toHaveCount(0);
        await expect(recover).toBeEnabled();
        if (expired) f.expire();
        const reads = f.eventReads.length;
        await recover.press('Space');
        await expect(page.getByRole('heading', {name: 'Retained events', exact: true})).toBeFocused();
        await expect.poll(() => f.eventReads.length).toBe(reads + 1);
        expect(f.eventReads.at(-1)!.href).toBe(first.href);
        if (expired) {
          const error = page.getByRole('alert');
          await expect(error).toContainText('Refresh required');
          await expect(error.getByRole('button', {name: 'Refresh report', exact: true})).toBeVisible();
          await expect(events).toHaveCount(0);
          await expect(recover).toHaveCount(0);
        } else { await at(1); }
      }
      if (!expired) {
        await expect(previous).toBeDisabled(); await expect(recover).toHaveCount(0);
        expect(await ids.allTextContents()).toEqual(original);
        await button('Next page').press('Enter'); await at(2);
        await expect(previous).toBeEnabled();
      }
      expect(f.reportReads).toHaveLength(reports);
      await expect(scope).toHaveText(originalScope, {useInnerText: true});
    } finally { await f.close(); }
  });
}
