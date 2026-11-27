import { expect, test, type Page } from '@playwright/test';
import { cursorUsageFixture } from '../test/helpers/personal-usage-cursor.mjs';
import { fixtureResponses } from './fixtures/personal-usage';

const currentName = 'Nightly production build';
const active = 'key_61b3a42d9ec016f8', previous = 'key_d73c4e5f28a910ba';
type InventoryKey = {credentialId: string; name: string; enabled: boolean};
const listed = (credentialId: string, enabled = true): InventoryKey => ({credentialId, enabled, name: currentName});

async function withPicker(page: Page, ids: readonly string[], inventory: InventoryKey[], check: () => Promise<void>) {
  const f = await cursorUsageFixture({rows: 0});
  try {
    for (const [i, id] of ids.entries()) await f.ingest('own-call-' + i, {
      credential_id: id, model: 'test-model', input_tokens: 1, output_tokens: i + 1,
      total_tokens: i + 2, actual_cost_micros: i + 1,
    });
    await page.clock.setFixedTime(new Date(f.now));
    await page.route('**/v1/**', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname.startsWith('/v1/session/usage/')) {
        await route.fulfill({json: await f.read(url.href, f.now, req.method())});
      } else if (url.pathname === '/v1/session/credentials') {
        expect(req.method()).toBe('GET');
        await route.fulfill({json: {credentials: inventory.map(k => ({...k, policyId: 'p', principalId: 'member@example.com'}))}});
      } else if (url.pathname.endsWith('/avatar')) await route.fulfill({status: 204});
      else await route.fulfill({status: url.pathname in fixtureResponses ? 200 : 404, json: fixtureResponses[url.pathname] ?? {}});
    });
    await page.goto('/');
    await page.getByRole('button', {name: 'Open My usage'}).click();
    await page.getByRole('button', {name: 'Compare keys', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Top keys'})).toBeVisible();
    await check();
  } finally { await page.unrouteAll({behavior: 'wait'}); f.close(); }
}
const picker = (page: Page) => page.getByRole('combobox', {name: 'Current own-key selector'});
const scope = (page: Page) => page.getByRole('region', {name: 'Your personal usage'}).locator('.personalActiveFilters');

async function readSelection(page: Page, id: string, state: 'Current key' | 'Revoked key' | 'Retained key') {
  const select = picker(page);
  await expect(select).toHaveValue('key:' + id);
  await expect(scope(page)).toContainText('Selected key = ' + id);
  const desc = state + ' · ' + id + (state === 'Retained key' ? ' · Not in current key list' : ' · Current name: ' + currentName);
  await expect(select).toHaveAccessibleDescription(desc);
  // The complete current identity must also be legible at the closed field, not just in the option DOM.
  const shown = await select.evaluate(el => {
    const note = document.getElementById(el.getAttribute('aria-describedby')!)!;
    const bounds = el.closest('form')!.getBoundingClientRect();
    const text = document.createRange(); text.selectNodeContents(note);
    const lines = Array.from(text.getClientRects());
    return {text: note.innerText, fits: lines.length > 0 && lines.every(r => r.width > 0 && r.left >= bounds.left && r.right <= bounds.right)};
  });
  expect(shown).toEqual({text: desc, fits: true});
}

for (const colliding of [false, true]) test('closed same-name choices stay distinct' + (colliding ? ' with matching ID prefixes, suffixes and states' : ' for a revoked key'), async ({page, isMobile}) => {
  const shared = 'build_0123456789abcdef0123456789abcdef0123456789abcdef';
  const ids = colliding ? [shared + '_01_shared_123456', shared + '_02_shared_123456'] : [active, previous];
  await page.setViewportSize({width: isMobile ? 320 : 412, height: isMobile ? 568 : 839});
  await page.emulateMedia({colorScheme: isMobile ? 'light' : 'dark'});
  await withPicker(page, ids, [listed(ids[1], colliding), listed(ids[0])], async () => {
    const select = picker(page), images: Buffer[] = [];
    for (const [i, id] of ids.entries()) {
      await select.selectOption('key:' + id);
      await expect(scope(page)).toContainText('Selected key = ' + id);
      await select.focus(); await page.evaluate(() => document.fonts.ready);
      images.push(await select.screenshot({animations: 'disabled', scale: 'css'}));
      if (i === 1) expect(images[0].equals(images[1]), 'different key selections must not paint the same control').toBe(false);
    }
    for (const [i, id] of ids.entries()) {
      await select.selectOption('key:' + id);
      await readSelection(page, id, i === 1 && !colliding ? 'Revoked key' : 'Current key');
      await page.getByRole('tab', {name: 'Activity', exact: true}).click();
      const rows = page.getByRole('region', {name: 'Recent calls table'}).locator('tbody tr');
      await expect(rows).toHaveCount(1); await expect(rows.getByText('Key: ' + id, {exact: true})).toBeVisible();
      const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: 'Export refreshed snapshot JSON', exact: true}).click()]);
      const stream = await file.createReadStream(); if (!stream) throw Error('No export stream');
      const bytes: Buffer[] = []; for await (const chunk of stream) bytes.push(chunk);
      const snapshot = JSON.parse(Buffer.concat(bytes).toString());
      expect(snapshot.metadata.filters.key).toEqual({kind: 'credential', id});
      expect(snapshot.events).toEqual([expect.objectContaining({id: 'own-call-' + i, keyId: id})]);
    }
    await select.selectOption('session'); await expect(scope(page)).toContainText('Dashboard session');
    await expect(select).not.toHaveAttribute('aria-describedby');
    await select.selectOption(''); await expect(scope(page)).toContainText('All keys');
    await expect(select).not.toHaveAttribute('aria-describedby');
  });
});

test('an unlisted historical selection does not borrow a current name or imply revocation', async ({page}) => {
  await withPicker(page, [active, previous], [listed(active)], async () => {
    await expect(picker(page)).not.toContainText(previous);
    await page.getByRole('region', {name: 'Usage breakdown'}).getByRole('button', {name: previous, exact: true}).press('Enter');
    await readSelection(page, previous, 'Retained key');
    await expect(picker(page).locator('option:checked')).toHaveText('Retained key: ' + previous);
    await page.getByRole('button', {name: 'Show all keys'}).press('Space');
    await expect(picker(page)).toHaveValue(''); await expect(picker(page)).not.toContainText(previous);
  });
});
