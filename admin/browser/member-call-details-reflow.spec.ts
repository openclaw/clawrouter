import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { cursorUsageFixture } from '../test/helpers/personal-usage-cursor.mjs';
import { fixtureResponses } from './fixtures/personal-usage';

const model = 'team-inference/long-context-reasoning-72b-instruct-2026-11-production';
const provider = 'inference-gateway-europe-west-production';
const prefix = 'req_01JY4TEB0J98X75P92VK4A7W2M:attempt-00000001:stage-';
const fusion = 'fusion_0123456789abcdef0123456789abcdef0123456789abcdef';

async function openActivity(page: Page) {
  const f = await cursorUsageFixture({rows: 0});
  const shared = {model, provider, compound_request_id: fusion};
  await f.ingest(prefix + 'A9X2', {...shared, occurred_at_ms: f.now - 2000, compound_request_stage: 'adviser', input_tokens: 0, output_tokens: 0, actual_cost_micros: 0});
  await f.ingest(prefix + 'B8C3', {...shared, occurred_at_ms: f.now - 1000, compound_request_stage: 'synthesizer', input_tokens: null, output_tokens: 0, actual_cost_micros: 7, cost_basis: 'unpriced_usage'});
  await page.clock.setFixedTime(new Date(f.now));
  await page.route('**/v1/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.startsWith('/v1/session/usage/')) await route.fulfill({json: await f.read(url.href, f.now, req.method())});
    else if (url.pathname.endsWith('/avatar')) await route.fulfill({status: 204});
    else await route.fulfill({status: url.pathname in fixtureResponses ? 200 : 404, json: fixtureResponses[url.pathname] ?? {}});
  });
  await page.goto('/');
  await page.getByRole('button', {name: 'Open My usage'}).click();
  await page.getByRole('tab', {name: 'Activity', exact: true}).press('Enter');
  const table = page.getByRole('region', {name: 'Recent calls table'});
  await expect(table.getByRole('rowheader')).toHaveCount(2);
  return {table, close: async () => { await page.unrouteAll({behavior: 'wait'}); f.close(); }};
}

async function expectFieldsFit(table: Locator) {
  // Check the actual wrapped text, not just the page width or a locator's visibility:
  // a wide grid can be fully laid out but clipped by its scroll container.
  const geometry = await table.evaluate(el => {
    const clip = el.getBoundingClientRect();
    const outside = Array.from(el.querySelectorAll('tbody th > strong, tbody th > small, details[open] :is(dt,dd,p)')).filter(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects());
      return !rects.length || rects.some(rect => rect.left < clip.left - 1 || rect.right > clip.right + 1);
    }).map(node => node.textContent);
    return {outside, scrollLeft: el.scrollLeft, overflow: el.scrollWidth - el.clientWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth};
  });
  expect(geometry).toEqual({outside: [], scrollLeft: 0, overflow: 0, pageOverflow: 0});
}

for (const theme of ['light','dark'] as const) test('call details reflow without changing field meanings: ' + theme, async ({page, isMobile}) => {
  await page.emulateMedia({colorScheme: theme});
  const {table, close} = await openActivity(page);
  try {
    const rows = table.locator('tbody tr'), first = rows.first(), details = first.locator('details');
    const summary = details.locator('summary');
    const field = (label: string) => details.getByText(label, {exact: true}).locator('+ dd');
    await summary.focus(); await page.keyboard.press('Enter');
    for (const width of (isMobile ? [412,320] : [1440,412,1440])) {
      await page.setViewportSize({width, height: width === 320 ? 568 : width === 412 ? 839 : 900});
      await expect(details).toHaveAttribute('open', ''); await expect(summary).toBeFocused();
      await expect(table.getByRole('table')).toHaveCount(1);
      await expect(table.getByRole('columnheader')).toHaveText(['Time','Model / key','Outcome','Input / output','Reporting cost']);
      await expect(table.getByRole('row')).toHaveCount(3);
      await expect(table.getByRole('rowheader')).toHaveCount(2);
      await expect(first.getByRole('cell')).toHaveCount(4);
      await expect(field('Event ID')).toHaveText(prefix + 'B8C3');
      await expect(field('HTTP status')).toHaveText('200');
      await expect(field('Input tokens')).toHaveText('Not reported');
      await expect(field('Output tokens')).toHaveText('0');
      await expect(field('Reporting-only price')).toHaveText('Price unknown');
      await expect(field('Recorded accounting amount')).toHaveText('$0.000007');
      await expect(field('Fusion request')).toHaveText(fusion);
      await expectFieldsFit(table);
      if (width === 1440) await expect(first).toHaveCSS('display', 'table-row');
    }
    const axe = await new AxeBuilder({page}).include('.personalActivityWrap').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(axe.violations).toEqual([]);
    const peer = details.getByRole('link', {name: 'adviser', exact: true});
    await page.keyboard.press('Tab'); await expect(peer).toBeFocused();
    const target = '#' + await rows.nth(1).getAttribute('id');
    await expect(peer).toHaveAttribute('href', target);
    await page.keyboard.press('Enter'); await expect(page).toHaveURL(url => url.hash === target);
    await summary.press('Space'); await expect(details).not.toHaveAttribute('open', '');
    const other = rows.nth(1).locator('details'); await other.locator('summary').press('Enter');
    await expect(other.getByText('Input tokens', {exact:true}).locator('+ dd')).toHaveText('0');
    await expect(other.getByText('Reporting-only price', {exact:true}).locator('+ dd')).toHaveText('$0.00');
    await expect(other.getByText('Event ID', {exact:true}).locator('+ dd')).toHaveText(prefix + 'A9X2');
    await expectFieldsFit(table);
  } finally { await close(); }
});
