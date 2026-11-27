import { expect, test, type Download, type Page } from '@playwright/test';
import { cursorUsageFixture } from '../test/helpers/personal-usage-cursor.mjs';
import { fixtureResponses } from './fixtures/personal-usage';

const owner = 'member@example.com';
const colleague = 'colleague@example.test';
const historical = 'build-runner'; // Retained ID, absent from today's credential inventory.
const current = 'workstation';
const day = 86_400_000;
type Role = 'user' | 'admin';
function responseGates() {
  return { validation: Promise.withResolvers<void>(), oldEvents: Promise.withResolvers<void>(), oldEventsRead: Promise.withResolvers<void>() };
}

async function withHistory(page: Page, role: Role, visit: (from: string, to: string, gates: ReturnType<typeof responseGates>) => Promise<void>) {
  const server = await cursorUsageFixture({ audience: role === 'admin' ? 'admin' : 'personal', rows: 0 });
  const gates = responseGates();
  try {
    const end = Math.floor(server.now / day) * day - day;
    const start = end - day;
    const own = { principal_id: owner, credential_id: historical, occurred_at_ms: start };
    // Equal retained IDs under different owners must remain separate.
    await server.ingest('first', { ...own, input_tokens: 16, output_tokens: 4, total_tokens: 20, actual_cost_micros: 25_000 });
    await server.ingest('unpriced', { ...own, occurred_at_ms: end - 1, input_tokens: 2, output_tokens: 1, total_tokens: 3, actual_cost_micros: 5_000, cost_basis: 'unpriced_usage' });
    await server.ingest('current', { ...own, credential_id: current, input_tokens: 9, output_tokens: 3, total_tokens: 12 });
    await server.ingest('session', { ...own, credential_id: null });
    await server.ingest('other-owner', { ...own, principal_id: colleague, model: 'colleague-only-model' });
    await server.ingest('at-exclusive-end', { ...own, occurred_at_ms: end, model: 'next-day-model' });
    const responses: Record<string, unknown> = {
      ...fixtureResponses,
      '/v1/session': { ...(fixtureResponses['/v1/session'] as object), role, email: owner, tenantId: 'tenant' },
      '/v1/session/credentials': { credentials: [{ principalId: owner, policyId: 'p', credentialId: current, name: 'Renamed laptop', enabled: true }] },
    };
    if (role === 'admin') {
      responses['/v1/admin/bootstrap'] = { policies: [], credentials: [], users: [], bindings: [], grants: [], rules: [], providers: [], connections: [], fusion: { enabled: false, adviserModels: [], aggregatorModel: '' }, overview: null, tenants: [] };
      responses['/v1/admin/usage'] = responses['/v1/session/usage'];
    }
    const endpoint = role === 'admin' ? '/v1/admin/usage/' : '/v1/session/usage/';
    const forbidden: string[] = [];
    await page.clock.setFixedTime(new Date(server.now));
    await page.route('**/v1/**', async route => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      if (role === 'user' && pathname.startsWith('/v1/admin/')) forbidden.push(pathname);
      if (pathname.startsWith(endpoint)) {
        const result = await server.read(request.url(), server.now, request.method());
        // Delay completed reads, never the real authority or SQLite computation.
        if (pathname === endpoint + 'validate') await gates.validation.promise;
        if (pathname === endpoint + 'events' && searchParams.get('key') === current) {
          gates.oldEventsRead.resolve();
          await gates.oldEvents.promise;
        }
        await route.fulfill({ json: result });
      } else if (pathname === '/v1/session/avatar') {
        await route.fulfill({ status: 204 });
      } else {
        await route.fulfill({ status: pathname in responses ? 200 : 404, json: responses[pathname] ?? {} });
      }
    });
    await page.goto(role === 'admin' ? '/dashboard/usage' : '/dashboard/my-usage');
    await visit(new Date(start).toISOString(), new Date(end).toISOString(), gates);
    expect(forbidden).toEqual([]);
  } finally {
    gates.validation.resolve();
    gates.oldEvents.resolve();
    await page.unrouteAll({ behavior: 'wait' });
    server.close();
  }
}

const controls = (page: Page) => page.getByRole('form', { name: 'Usage filters' });
const ranking = (page: Page) => page.getByRole('region', { name: 'Retained usage ranking' });
const summary = (page: Page) => page.locator('.personalUsageSummary');
const calls = (page: Page) => summary(page).getByText('Model calls', { exact: true }).locator('+ dd');
const tableRow = (page: Page, label: string) => ranking(page).getByRole('row').filter({ has: page.getByRole('button', { name: label, exact: true }) });

async function setInterval(page: Page, from: string, to: string) {
  const form = controls(page);
  if (!await form.getByLabel('Start', { exact: true }).isVisible()) await form.getByText(/^Custom (dates|interval)/).click();
  await form.getByLabel('Start', { exact: true }).fill(from);
  await form.getByRole('textbox', { name: /^End/ }).fill(to);
  await form.getByRole('button', { name: /^Apply (filters|refinement)$/ }).click();
}

async function verifyExport(file: Download, requestedFrom: string, to: string) {
  const stream = await file.createReadStream();
  if (!stream) throw new Error('No stream for the refreshed usage export');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const { metadata, events } = JSON.parse(Buffer.concat(chunks).toString());
  expect(metadata.range.from).toBeGreaterThan(Date.parse(requestedFrom));
  expect(metadata).toMatchObject({ range: { from: metadata.coverage.effectiveFrom, to: Date.parse(to), timezone: 'UTC' },
    coverage: { clippedFrom: Date.parse(requestedFrom) },
    filters: { user: owner, key: { kind: 'credential', id: historical } },
    totals: { metrics: { calls: 2, inputTokens: 18, outputTokens: 5 }, recordedChargeMicros: 30_000, chargeReportedCalls: 2 } });
  expect(events).toEqual([
    expect.objectContaining({ id: 'unpriced', user: owner, keyId: historical, reportingCostMicros: null, recordedChargeMicros: 5_000 }),
    expect.objectContaining({ id: 'first', user: owner, keyId: historical, recordedChargeMicros: 25_000 }),
  ]);
}

for (const role of ['user', 'admin'] as const) {
  test(role + ' keeps a retained owner and key scoped across a delayed export and activity response', async ({ page, isMobile }) => {
    // Complement the configured light desktop with a dark mobile journey.
    await page.emulateMedia({ colorScheme: isMobile ? 'dark' : 'light' });
    await withHistory(page, role, async (from, to, gates) => {
      const requestedFrom = new Date(Date.parse(to) - 30 * day).toISOString();
      await expect(page.locator('html')).toHaveAttribute('data-theme', isMobile ? 'dark' : 'light');
      await expect(calls(page)).toHaveText(role === 'admin' ? '6' : '5');
      const reported = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/usage/report') && url.searchParams.get('from') === requestedFrom;
      });
      await setInterval(page, requestedFrom, to);
      const { value } = await (await reported).json();
      expect(value.coverage.clippedFrom).toBe(Date.parse(requestedFrom));
      expect(value.query.from).toBeGreaterThan(value.coverage.clippedFrom);
      const expectedCalls = role === 'admin' ? '5' : '4';
      await expect(calls(page)).toHaveText(expectedCalls);
      await expect(controls(page).getByLabel('Start', { exact: true })).toHaveValue(requestedFrom);
      const coverage = summary(page).getByText('Report scope and capture dates', { exact: true });
      await coverage.click();
      await expect(summary(page).getByText('Start clipped from ' + requestedFrom, { exact: false })).toBeVisible();
      const effectiveDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(value.query.from);
      await coverage.click();
      if (role === 'user') {
        const selector = controls(page).getByRole('combobox', { name: 'Current own-key selector' });
        await expect(selector).toContainText('Renamed laptop');
        await expect(selector).not.toContainText(historical);
      }
      await controls(page).getByText(/^Custom (dates|interval)/).click();
      await controls(page).getByRole('button', { name: role === 'admin' ? 'By key' : 'Compare keys', exact: true }).click();
      if (role === 'user') await page.getByRole('tab', { name: 'Details', exact: true }).click();
      const historicalRow = tableRow(page, owner + ' · ' + historical);
      await expect(historicalRow.getByRole('cell').nth(0)).toHaveText('2');
      await expect(historicalRow.getByRole('cell').nth(1)).toHaveText('18 / 5');
      await expect(historicalRow.getByRole('cell').nth(2)).toContainText('$0.03');
      await expect(tableRow(page, owner + ' · ' + current).getByRole('cell').nth(0)).toHaveText('1');
      await expect(tableRow(page, owner + ' · Dashboard session')).toBeVisible();
      await expect(tableRow(page, colleague + ' · ' + historical)).toHaveCount(role === 'admin' ? 1 : 0);
      await expect(ranking(page)).not.toContainText('Renamed laptop');
      await historicalRow.getByRole('button').click();
      await expect(calls(page)).toHaveText('2');
      if (role === 'user') await page.getByRole('tab', { name: 'Activity', exact: true }).click();
      const displayedScope = role === 'admin' ? controls(page).getByRole('group', { name: 'Displayed report scope' }) : summary(page).locator('.personalActiveFilters');
      await expect(displayedScope).toContainText(historical);
      await expect(displayedScope).toContainText('end exclusive');
      await expect(displayedScope).toBeVisible();
      await expect(displayedScope).toContainText(effectiveDay);
      const events = page.getByRole('region', { name: role === 'admin' ? 'Retained events' : 'Recent calls table' });
      await expect(events.locator('tbody tr')).toHaveCount(2);
      await expect(events).not.toContainText(/colleague-only-model|next-day-model/);
      if (role === 'user') {
        await expect(summary(page).getByLabel('Known API cost $0.025', { exact: true })).toBeVisible();
        await expect(events).toContainText('Price unknown');
      }
      const validating = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/usage/validate'));
      await page.getByRole('button', { name: 'Export refreshed snapshot JSON', exact: true }).click();
      await validating;
      const clear = controls(page).getByRole('button', { name: role === 'admin' ? 'Clear key filter' : 'Show all keys', exact: true });
      await clear.click();
      // Clearing a credential does not discard the administrator's retained owner or the period.
      await expect(calls(page)).toHaveText('4');
      await expect(events.locator('tbody tr')).toHaveCount(4);
      await expect(events).not.toContainText(/colleague-only-model|next-day-model/);
      const ready = page.waitForEvent('download');
      gates.validation.resolve();
      await verifyExport(await ready, requestedFrom, to);
      await expect(page.getByRole('group', { name: 'Export snapshot scope' })).toContainText(historical);
      await expect(calls(page)).toHaveText('4');

      // Switch away from a key while its event reply is in flight. A late row
      // must not overwrite the four rows of the restored owner-scoped report.
      const pending = page.waitForRequest(request => {
        const u = new URL(request.url());
        return u.pathname.endsWith('/usage/events') && u.searchParams.get('key') === current;
      });
      if (role === 'user') await controls(page).getByRole('combobox', { name: 'Current own-key selector' }).selectOption('key:' + current);
      else await tableRow(page, owner + ' · ' + current).getByRole('button').click();
      await gates.oldEventsRead.promise;
      await expect(calls(page)).toHaveText('1');
      await clear.click();
      await expect(events.locator('tbody tr')).toHaveCount(4);
      gates.oldEvents.resolve();
      // Chromium can cancel the old request or receive a response that React ignores.
      const retired = await (await pending).response();
      await retired?.finished();
      await expect(calls(page)).toHaveText('4');
      await expect(events.locator('tbody tr')).toHaveCount(4);
      await setInterval(page, new Date(Date.parse(from) - day).toISOString(), from);
      await expect(summary(page).getByText(/^No calls in discovered locations for this range/)).toBeVisible();
      await expect(calls(page)).toHaveText('0');
    });
  });

  test(role + ' cannot act on stale ranks or start a fresh export until Retry succeeds', async ({ page }) => {
    await withHistory(page, role, async (_from, _to, gates) => {
      gates.validation.resolve(); // This test does not delay the final export.
      const form = controls(page);
      const exports = { name: /^Export refreshed snapshot (CSV|JSON)$/ };
      const ranks = role === 'admin' ? ranking(page) : page.getByRole('region', { name: 'Usage breakdown' });
      const label = role === 'admin' ? owner + ' · ' + historical : historical;
      await form.getByRole('button', { name: role === 'admin' ? 'By key' : 'Compare keys', exact: true }).click();
      await expect(ranks.getByRole('button', { name: label, exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { ...exports, disabled: false })).toHaveCount(2);

      async function download(format: 'CSV' | 'JSON') {
        const [file] = await Promise.all([page.waitForEvent('download'),
          page.getByRole('button', { name: 'Export refreshed snapshot ' + format, exact: true }).click()]);
        const stream = await file.createReadStream();
        if (!stream) throw new Error('No stream for the ' + format + ' export');
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks).toString();
      }
      const original = JSON.parse(await download('JSON'));
      expect(original.events).toHaveLength(role === 'admin' ? 6 : 5);
      const receipt = page.getByRole('group', { name: 'Export snapshot scope' });
      await expect(receipt).toContainText('All keys');
      const priorScope = await receipt.innerText();
      const path = role === 'admin' ? '/v1/admin/usage/report' : '/v1/session/usage/report';
      await page.route(url => url.pathname === path && url.searchParams.get('intent') === 'browse',
        route => route.fulfill({ status: 503, json: { error: { message: 'Fixture report refresh failed' } } }), { times: 1 });
      await form.getByRole('button', { name: 'Refresh report', exact: true }).click();
      const alert = summary(page).getByRole('alert');
      await expect(alert).toContainText(/Old displayed (report|data)/);
      await expect(ranks.getByText(label, { exact: true })).toBeVisible();
      await expect(receipt).toHaveText(priorScope, { useInnerText: true });
      await expect.soft(page.getByRole('button', { ...exports, disabled: false })).toHaveCount(0);
      await expect.soft(ranks.getByRole('button', { name: label, exact: true, disabled: false })).toHaveCount(0);

      await alert.getByRole('button', { name: role === 'admin' ? 'Refresh report' : 'Retry report', exact: true }).click();
      await expect(alert).toHaveCount(0);
      await ranks.getByRole('button', { name: label, exact: true }).click();
      await expect(calls(page)).toHaveText('3');
      await expect(page.getByRole('button', { ...exports, disabled: false })).toHaveCount(2);
      await expect(receipt).toHaveText(priorScope, { useInnerText: true });
      const csv = await download('CSV');
      // Fixture IDs contain no CSV delimiters; IDs are the first quoted event field.
      const expectedIds = ['at-exclusive-end', 'first', 'unpriced'];
      const rows = csv.trimEnd().split('\r\n').slice(2);
      expect(rows.map(row => row.split(',', 1)[0]).sort()).toEqual(expectedIds.map(id => JSON.stringify(id)));
      await expect(receipt).toContainText('Key: ' + historical);
      const { metadata, events } = JSON.parse(await download('JSON'));
      expect(metadata.filters).toMatchObject({ user: owner, key: { kind: 'credential', id: historical } });
      expect(events.map((event: { id: string }) => event.id).sort()).toEqual(expectedIds);
    });
  });
}
