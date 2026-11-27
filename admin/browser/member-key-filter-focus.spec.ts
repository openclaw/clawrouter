import { expect, test, type Page } from '@playwright/test';
import { cursorUsageFixture } from '../test/helpers/personal-usage-cursor.mjs';
import { fixtureResponses } from './fixtures/personal-usage';

const first = 'build_alpha', second = 'build_bravo';
const picker = (page: Page) => page.getByRole('combobox', { name: 'Current own-key selector' });
const summary = (page: Page) => page.getByRole('region', { name: 'Your personal usage' });
const calls = (page: Page) => summary(page).getByText('Model calls', { exact: true }).locator('+ dd');
const download = (page: Page) => page.getByRole('button', { name: 'Export refreshed snapshot JSON' });

async function withMember(page: Page, check: (f: {
  started: Promise<void>; release: () => void; fail: () => void; reportKeys: (string | null)[];
  refreshInventory: () => Promise<void>;
}) => Promise<void>) {
  const ledger = await cursorUsageFixture({ rows: 0 });
  const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const reportKeys: (string | null)[] = [];
  let secondReads = 0, fail = false, keyReads = 0, reverse = false;
  try {
    for (const [id, key] of [['first', first], ['second-a', second], ['second-b', second]]) {
      await ledger.ingest(id, { credential_id: key, model: key });
    }
    await page.clock.setFixedTime(new Date(ledger.now));
    await page.route('**/v1/**', async route => {
      const request = route.request(), url = new URL(request.url());
      expect(url.pathname.startsWith('/v1/admin/')).toBe(false);
      if (url.pathname.startsWith('/v1/session/usage/')) {
        if (request.method() === 'GET' && url.pathname.endsWith('/report')) reportKeys.push(url.searchParams.get('key'));
        if (request.method() === 'GET' && url.pathname.endsWith('/report') && url.searchParams.get('key') === second) {
          if (++secondReads === 1) {
            started.resolve(); await gate.promise;
            if (fail) return route.fulfill({ status: 503, json: { error: { message: 'Synthetic report failure' } } });
          }
        }
        const body = await ledger.read(url.href, ledger.now, request.method());
        return route.fulfill({ json: body });
      }
      expect(request.method()).toBe('GET');
      if (url.pathname === '/v1/session/avatar') return route.fulfill({ status:204 });
      if (url.pathname === '/v1/session/credentials') {
        keyReads++;
        return route.fulfill({ json:{credentials:(reverse ? [second, first] : [first, second]).map(id => ({credentialId:id, policyId:'p', name:id, enabled:true, active:true}))} });
      }
      const body = fixtureResponses[url.pathname];
      return route.fulfill({ status:body ? 200 : 404, json:body ?? {} });
    });
    await page.goto('/dashboard/my-usage');
    await expect(calls(page)).toHaveText('3');
    await picker(page).selectOption('key:' + first);
    await expect(calls(page)).toHaveText('1');
    await expect(summary(page)).toContainText('Selected key = ' + first);
    await picker(page).focus();
    await check({ started:started.promise, release:gate.resolve, fail:() => { fail = true; }, reportKeys,
      async refreshInventory() {
        const before = keyReads; reverse = true;
        await page.clock.setFixedTime(new Date(ledger.now + 16_000));
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(() => keyReads).toBeGreaterThan(before);
        await expect(picker(page).locator('option[value^="key:"]').first()).toHaveAttribute('value', 'key:' + second);
      },
    });
  } finally { gate.resolve(); await page.unrouteAll({ behavior:'wait' }); ledger.close(); }
}

for (const outcome of ['success', 'failure', 'success after Tab', 'failure after Tab'] as const) {
  test('member key filter keeps keyboard focus ownership through ' + outcome, async ({page, isMobile}) => {
    if (isMobile) await page.setViewportSize({width:320, height:800});
    await withMember(page, async f => {
      const select = picker(page), original = await select.elementHandle();
      if (outcome.startsWith('failure')) f.fail();
      await page.keyboard.press('ArrowDown');
      await f.started;
      await expect(summary(page).getByRole('status')).toContainText('Loading your usage report');
      await expect(calls(page)).toHaveCount(0); // Never label the previous total with the requested key.
      await expect(download(page)).toBeDisabled();
      expect(await original!.evaluate(el => el.isConnected && el === document.activeElement)).toBe(true);
      await expect(select).toHaveValue('key:' + second);
      await expect(select).toBeDisabled();
      await expect(select.locator('option:enabled')).toHaveCount(0);
      await page.keyboard.press('ArrowUp'); // A pending read cannot queue a different refinement.
      await expect(select).toHaveValue('key:' + second);
      let destination = select;
      if (outcome.endsWith('Tab')) {
        await page.keyboard.press('Tab');
        destination = page.getByText('Custom dates & exact filters', {exact:true});
        await expect(destination).toBeFocused();
      }
      f.release();
      if (outcome.startsWith('failure')) {
        const alert = summary(page).getByRole('alert');
        await expect(alert).toContainText('Old displayed report');
        await expect(calls(page)).toHaveText('1');
        await expect(summary(page)).toContainText('Selected key = ' + first);
        await expect(select).toHaveValue('key:' + first);
        await expect(select).toBeDisabled();
        await expect(select.locator('option:enabled')).toHaveCount(0);
        await expect(download(page)).toBeDisabled();
      } else {
        await expect(calls(page)).toHaveText('2');
        await expect(summary(page)).toContainText('Selected key = ' + second);
        await expect(select).toHaveValue('key:' + second);
        await expect(download(page)).toBeEnabled();
      }
      await expect(destination).toBeFocused();
      expect(await original!.evaluate(el => el.isConnected)).toBe(true);
      expect(f.reportKeys).toEqual([null, first, second]);
    });
  });
}

test('a member inventory-only refresh leaves the focused key selector and report intact', async ({page}) => {
  await withMember(page, async f => {
    const original = await picker(page).elementHandle();
    await f.refreshInventory();
    expect(await original!.evaluate(el => el === document.activeElement)).toBe(true);
    await expect(picker(page)).toHaveValue('key:' + first);
    await expect(calls(page)).toHaveText('1');
    await expect(download(page)).toBeEnabled();
    expect(f.reportKeys).toEqual([null, first]);
  });
});
