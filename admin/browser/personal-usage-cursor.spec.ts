import { expect, test, type Page } from '@playwright/test';
import { cursorUsageFixture } from '../test/helpers/personal-usage-cursor.mjs';
import { fixtureResponses } from './fixtures/personal-usage';

async function cursorUsage(page: Page) {
 const server=await cursorUsageFixture();let now=server.now,failReport=false,failEvents=false;
 const queries:URL[]=[],invalid:string[]=[];
 await page.clock.setFixedTime(new Date(now));
 await page.route('**/v1/**',async route=>{
  const url=new URL(route.request().url()),method=route.request().method();if(method==='GET')queries.push(url);
  if(!url.pathname.startsWith('/v1/session/usage/')){if(url.pathname==='/v1/session/avatar'){await route.fulfill({status:204});return;}const body=fixtureResponses[url.pathname];await route.fulfill({status:body?200:404,json:body??{}});return;}
  try{
   const body=await server.read(url.href,now,method);
   if(method==='GET'&&url.pathname.endsWith('/report')&&failReport){failReport=false;throw Error('Injected report failure');}
   if(url.pathname.endsWith('/events')&&failEvents){failEvents=false;throw Error('Injected event failure');}
   await route.fulfill({status:body.kind==='restart'?410:body.kind==='unavailable'?503:200,json:body});
  }catch(error){const message=String(error instanceof Error?error.message:error);if(!message.startsWith('Injected'))invalid.push(message);await route.fulfill({status:message.startsWith('Injected')?503:400,json:{error:{message}}});}
 });
 return {...server,queries,invalid,end:()=>new Date(now).toISOString(),advance:async()=>{now+=16000;await page.clock.setFixedTime(new Date(now));},failReport:()=>{failReport=true;},failEvents:()=>{failEvents=true;}};
}
const rows=(page:Page)=>page.locator('.personalActivityTable tbody > tr');
const reads=(f:Awaited<ReturnType<typeof cursorUsage>>,kind:string)=>f.queries.filter(u=>u.pathname.endsWith('/'+kind));
const activity=(page:Page)=>page.getByRole('tab',{name:/^Activity/}).click();
async function pageTwo(page:Page){await activity(page);await expect(rows(page)).toHaveCount(100);await page.getByRole('button',{name:'Next page',exact:true}).click();await expect(page.getByText('Page 2',{exact:true})).toBeVisible();await expect(rows(page)).toHaveCount(42);}
async function custom(page:Page,from:string,to:string,timezone='UTC'){
 const advanced=page.locator('.personalAdvanced');if(!await advanced.evaluate(e=>e.hasAttribute('open')))await page.getByText('Custom dates & exact filters',{exact:true}).click();
 await page.getByLabel('Start',{exact:true}).fill(from);await page.getByLabel('End (exclusive)',{exact:true}).fill(to);await page.getByLabel('Timezone',{exact:true}).fill(timezone);await page.getByRole('button',{name:'Apply filters',exact:true}).click();
}

test('members compare keys, inspect one and return to all keys in the same period', async ({ page }) => {
 const f = await cursorUsage(page);
 try {
  await f.ingest('build-call', { credential_id: 'build-key', model: 'build-model', input_tokens: 12, output_tokens: 4, total_tokens: 16, actual_cost_micros: 15, cost_basis: 'unpriced_usage' });
  await page.route('**/v1/session/credentials', route => route.fulfill({ json: { credentials: [
   { credentialId: 'build-key', name: 'Renamed build runner', policyId: 'p', principalId: 'member@example.com', enabled: true },
   { credentialId: 'retained-key', name: 'Retired laptop', policyId: 'p', principalId: 'member@example.com', enabled: false },
  ] } }));
  await f.ingest('session-call', { credential_id: null });
  await f.ingest('another-member', { principal_id: 'other@example.test', credential_id: 'another-members-key' });
  await page.goto('/dashboard/my-usage');
  const summary = page.getByRole('region', { name: 'Your personal usage' });
  const ranks = page.getByRole('region', { name: 'Usage breakdown' });
  const calls = summary.locator('.personalGlance > div').filter({ has: page.getByText('Model calls', { exact: true }) }).locator('dd').first();
  await expect(calls).toHaveText('144');
  const from = new Date(f.now - 3600000).toISOString(), to = f.end();
  await custom(page, from, to);
  await expect(summary.locator('.personalRange')).toContainText(from);
  await expect(calls).toHaveText('144');
  await page.getByText('Custom dates & exact filters', { exact: true }).click();
  const compare = page.getByRole('button', { name: 'Compare keys', exact: true });
  await page.getByRole('combobox', { name: 'Group by', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(compare).toBeFocused();
  await expect(compare).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(ranks.getByRole('heading', { name: 'Top keys' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Comparing keys' })).toBeFocused();
  await expect(ranks.getByRole('listitem').filter({ hasText: 'retained-key' })).toContainText('426');
  await expect(ranks.getByRole('listitem').filter({ hasText: 'build-key' })).toContainText('16');
  const inventory = page.getByRole('combobox', { name: 'Current own-key selector' });
  await expect(inventory).toContainText('Current name: Renamed build runner — build-key');
  await expect(inventory).toContainText('Current name: Retired laptop — retained-key (revoked)');
  await expect(ranks).not.toContainText('Renamed build runner');
  await expect(ranks).not.toContainText('Retired laptop');
  await expect(ranks).not.toContainText('another-members-key');
  const cut = reads(f, 'report').at(-1)!.searchParams.get('cut');
  expect(cut).toBeTruthy();

  await ranks.getByRole('button', { name: 'build-key', exact: true }).click();
  await expect(calls).toHaveText('1');
  await expect(ranks.getByRole('heading', { name: 'Selected key usage' })).toBeVisible();
  const scope = summary.locator('.personalActiveFilters');
  await expect(scope.locator('strong')).toHaveText('Selected key = build-key');
  await expect(scope.locator('time').first()).toHaveAttribute('datetime', from);
  await expect(scope.locator('time').last()).toHaveAttribute('datetime', to);
  await expect(summary).toContainText('12 input · 4 output');
  await expect(summary).toContainText('Recorded accounting amount: $0.000015');
  await expect(summary.getByLabel('Known API cost unavailable')).toBeVisible();
  await activity(page);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText('build-model');
  await expect(rows(page)).toContainText('Price unknown');
  await expect(rows(page).getByText('Key: build-key', { exact: true })).toBeVisible();
  const events = reads(f, 'events').at(-1)!.searchParams;
  expect([events.get('key'), events.get('from'), events.get('to'), events.get('cut')]).toEqual(['build-key', from, to, cut]);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export refreshed snapshot JSON' }).click();
  const stream = await (await download).createReadStream();
  let json = '';
  for await (const chunk of stream!) json += chunk.toString();
  const file = JSON.parse(json);
  expect(file.metadata.filters.key).toEqual({ kind: 'credential', id: 'build-key' });
  expect(file.metadata.range).toMatchObject({ from: Date.parse(from), to: Date.parse(to) });
  expect(file.events).toHaveLength(1);
  expect(file.events[0]).toMatchObject({ user: 'member@example.com', keyId: 'build-key', reportingCostMicros: null, recordedChargeMicros: 15 });

  await page.getByRole('button', { name: 'Show all keys', exact: true }).click();
  await expect(calls).toHaveText('144');
  await expect(rows(page)).toHaveCount(100);
  // Scanning mixed activity doesn't require opening each call or resolving today's names.
  const activityTable = page.getByRole('region', { name: 'Recent calls table', exact: true });
  for (const identity of ['Key: build-key', 'Key: retained-key', 'Dashboard session']) {
   await expect(activityTable.getByText(identity, { exact: true }).first()).toBeVisible();
  }
  await expect(activityTable).not.toContainText('another-members-key');
  await expect(activityTable).not.toContainText('Retired laptop');
  const restored = reads(f, 'events').at(-1)!.searchParams;
  expect([restored.get('groupBy'), restored.get('keyKind'), restored.get('from'), restored.get('to'), restored.get('cut')]).toEqual(['key', null, from, to, cut]);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await ranks.getByRole('button', { name: 'Dashboard session', exact: true }).click();
  await expect(calls).toHaveText('1');
  await expect(scope).toContainText('Dashboard session');
  expect(reads(f, 'report').at(-1)!.searchParams.get('keyKind')).toBe('session');

  // A key with no matching rows is a valid filter. Clearing only that key
  // keeps the member's applied provider and the original period.
  await page.getByText('Custom dates & exact filters', { exact: true }).click();
  await page.getByLabel('Key ID (exact)', { exact: true }).fill('unused-key');
  await page.getByLabel('Provider (exact)', { exact: true }).fill('openai');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(calls).toHaveText('0');
  await expect(summary).toContainText('No calls in discovered locations for this range for your current access.');
  await page.getByRole('button', { name: 'Show all keys' }).click();
  await expect(calls).toHaveText('144');
  await expect(summary).toContainText('provider = openai');
  const reset = reads(f, 'report').at(-1)!.searchParams;
  expect([reset.get('provider'), reset.get('keyKind'), reset.get('from'), reset.get('to')]).toEqual(['openai', null, from, to]);
  await inventory.selectOption('key:retained-key');
  await expect(calls).toHaveText('142');
  await expect(summary.getByText('Selected key = retained-key', { exact: true })).toBeVisible();
  await expect(summary).not.toContainText('Retired laptop');
  expect(f.queries.some(url => url.pathname.startsWith('/v1/admin/'))).toBe(false);
  expect(f.invalid).toEqual([]);
 } finally { f.close(); }
});

test('a failed refresh keeps key ranks readable but not actionable until Retry succeeds', async ({ page }) => {
 const f = await cursorUsage(page);
 try {
  await f.ingest('session-call', { credential_id: null });
  await page.goto('/dashboard/my-usage');
  await page.getByRole('button', { name: 'Compare keys', exact: true }).click();
  const ranks = page.getByRole('region', { name: 'Usage breakdown' });
  const keys = ['retained-key', 'Dashboard session'];
  for (const name of keys) await expect(ranks.getByRole('button', { name, exact: true })).toBeEnabled();
  f.failReport();
  await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Old displayed report');
  for (const name of keys) {
   await expect(ranks.getByText(name, { exact: true })).toBeVisible();
   await expect(ranks.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await ranks.getByLabel('Group ranking scope and coverage').click();
  await expect(ranks).not.toContainText('Select a named group');
  await expect(ranks).not.toContainText('select a name to filter');
  await expect(page.getByRole('combobox', { name: 'Current own-key selector' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Details', exact: true }).click();
  const exact = page.getByRole('region', { name: 'Retained usage ranking' });
  for (const name of keys) await expect(exact.getByRole('button', { name: 'member@example.com · ' + name, exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Retry report' }).click();
  for (const name of keys) await expect(ranks.getByRole('button', { name, exact: true })).toBeEnabled();
  await expect(ranks).toContainText('select a name to filter');
  await expect(page.getByRole('combobox', { name: 'Current own-key selector' })).toBeEnabled();
  expect(f.invalid).toEqual([]);
 } finally { f.close(); }
});

test('same-root retries preserve exact cursor; navigation retires roots and reentry starts page one',async({page})=>{
 const f=await cursorUsage(page);try{
  await page.goto('/dashboard/my-usage');await activity(page);await expect(rows(page)).toHaveCount(100);
  f.failEvents();await page.getByRole('button',{name:'Next page',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Injected event failure');
  const failed=reads(f,'events').at(-1)!.search,reportCount=reads(f,'report').length;
  await page.getByRole('button',{name:'Retry recent calls',exact:true}).click();await expect(rows(page)).toHaveCount(42);expect(reads(f,'events').at(-1)!.search).toBe(failed);expect(reads(f,'report')).toHaveLength(reportCount);
  const oldCut=reads(f,'events').at(-1)!.searchParams.get('cut');
  await page.getByRole('button',{name:'Catalog',exact:true}).click();await f.advance();
  await page.getByRole('button',{name:'My usage',exact:true}).click();await activity(page);await expect(rows(page)).toHaveCount(100);await expect(page.getByText('Page 1',{exact:true})).toBeVisible();
  expect(reads(f,'events').at(-1)!.searchParams.get('cut')).not.toBe(oldCut);expect(reads(f,'events').at(-1)!.searchParams.has('cursor')).toBe(false);
  await expect(page.getByRole('button',{name:'Previous page',exact:true})).toBeDisabled();expect(f.invalid).toEqual([]);
 }finally{f.close();}
});
test('invalid custom dates leave the last applied period, events and export intact', async ({ page }) => {
 const f = await cursorUsage(page);
 try {
  const day = 86_400_000, start = Math.floor(f.now / day) * day - 3 * day;
  const date = (offset: number) => new Date(start + offset * day).toISOString().slice(0, 10);
  for (const [id, at] of [['before', start - 1], ['first', start], ['last', start + day - 1], ['after', start + day]] as const) {
   await f.ingest(id, { model: 'period-test', occurred_at_ms: at });
  }
  await f.ingest('other-model', { model: 'excluded', occurred_at_ms: start });
  await page.goto('/dashboard/my-usage');
  const form = page.getByRole('form', { name: 'Usage filters' });
  const summary = page.getByRole('region', { name: 'Your personal usage' });
  const calls = summary.getByText('Model calls', { exact: true }).locator('+ dd');
  await expect(calls).toHaveText('147');
  await form.getByText('Custom dates & exact filters').click();
  const model = form.getByLabel('Model (exact)', { exact: true });
  const from = form.getByLabel('Start', { exact: true });
  const to = form.getByLabel('End (exclusive)', { exact: true });
  const apply = form.getByRole('button', { name: 'Apply filters' });
  await model.fill('period-test');
  await custom(page, date(0), date(1));
  await activity(page);
  await expect(calls).toHaveText('2');
  await expect(rows(page)).toHaveCount(2);
  const priorReads = f.queries.filter(url => url.pathname.startsWith('/v1/session/usage/')).length;
  await model.fill('unapplied');
  await from.fill(date(1));
  await to.fill(date(0));
  await apply.focus();
  await page.keyboard.press('Enter');
  const error = form.getByRole('alert');
  await expect(error).toContainText('not applied');
  await expect(error).toContainText('end is exclusive');
  await expect(from).toHaveValue(date(1));
  await expect(to).toHaveValue(date(0));
  await expect(form.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'false');
  await expect(calls).toHaveText('2');
  await expect(rows(page)).toContainText(['period-test', 'period-test']);
  await expect(summary).toContainText('model = period-test');
  await expect(page.getByRole('button', { name: 'Retry report' })).toHaveCount(0);
  await from.fill('2026-02-30');
  await form.getByRole('combobox', { name: 'Group by' }).selectOption('provider');
  await expect(error).toContainText('Invalid calendar date');
  await expect(form.getByRole('combobox', { name: 'Group by' })).toHaveValue('model');
  expect(f.queries.filter(url => url.pathname.startsWith('/v1/session/usage/'))).toHaveLength(priorReads);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export refreshed snapshot JSON' }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const file = JSON.parse(Buffer.concat(chunks).toString());
  expect(file.metadata.range).toMatchObject({ from: start, to: start + day, timezone: 'UTC' });
  expect(file.metadata.filters.model).toBe('period-test');
  expect(file.events.map((event: { id: string }) => event.id)).toEqual(['last', 'first']);
  await expect(from).toHaveValue('2026-02-30');
  await expect(model).toHaveValue('unapplied');

  await model.fill('period-test');
  await custom(page, date(1), date(2));
  await expect(error).toHaveCount(0);
  await expect(calls).toHaveText('1');
  await expect(rows(page)).toHaveCount(1);
  await custom(page, date(2), date(3));
  await expect(calls).toHaveText('0');
  await expect(page.getByText('No recent model calls for these filters.')).toBeVisible();
  await custom(page, date(2), date(1));
  await expect(error).toBeVisible();
  await form.getByRole('button', { name: 'Last 7 days' }).click();
  await expect(error).toHaveCount(0);
  await expect(calls).toHaveText('4');
  await expect(rows(page)).toHaveCount(4);
  expect(f.invalid).toEqual([]);
 } finally { f.close(); }
});

test('a replacement member does not inherit the invalid draft or the previous report', async ({ page }) => {
 const f = await cursorUsage(page);
 try {
  await page.goto('/dashboard/my-usage');
  await expect(page.getByRole('heading', { name: 'Top models', exact: true })).toBeVisible();
  await custom(page, 'not-a-date', f.end());
  const form = page.getByRole('form', { name: 'Usage filters' });
  await expect(form.getByRole('alert')).toContainText('not applied');
  await page.route('**/v1/session', route => route.fulfill({ json: {
   ...(fixtureResponses['/v1/session'] as object), email: 'second@example.test', tenantId: 'second-tenant',
  } }));
  // The replacement identity has no access to the former member's usage fixture.
  await page.route('**/v1/session/usage/report?**', route => route.fulfill({ json: { kind: 'no_access' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.tenantSwitch strong')).toHaveText('second@example.test');
  await expect(page.getByRole('alert')).toHaveText(/No current access/);
  await expect(form.getByRole('alert')).toHaveCount(0);
  await form.getByText('Custom dates & exact filters').click();
  await expect(form.getByLabel('Start', { exact: true })).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Top models', exact: true })).toHaveCount(0);
 } finally { f.close(); }
});

test('failed report retry creates a fresh root; custom range stays pinned on refresh and page stack resets',async({page})=>{
 const f=await cursorUsage(page);try{
  await page.goto('/dashboard/my-usage');await pageTwo(page);const from=new Date(f.now-3600000).toISOString(),to=f.end();
  await custom(page,from,to);await expect(rows(page)).toHaveCount(100);await pageTwo(page);
  const before=reads(f,'events').at(-1)!.searchParams.get('cut');f.failReport();await page.getByRole('button',{name:'Refresh report',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Injected report failure');await expect(page.getByRole('alert')).toContainText('Old displayed report');
  await page.getByRole('button',{name:'Retry report',exact:true}).click();await expect(rows(page)).toHaveCount(100);await expect(page.getByText('Page 1',{exact:true})).toBeVisible();
  const latest=reads(f,'events').at(-1)!.searchParams;expect(latest.get('from')).toBe(from);expect(latest.get('to')).toBe(to);expect(latest.get('cut')).not.toBe(before);expect(latest.has('cursor')).toBe(false);
  await pageTwo(page);await page.getByRole('button',{name:'Previous page',exact:true}).click();await expect(rows(page)).toHaveCount(100);expect(f.invalid).toEqual([]);
 }finally{f.close();}
});
for(const timezone of ['UTC','America/Los_Angeles']){
 test('outside-retention is not a zero; controls/group/filter/retry remain recoverable: '+timezone,async({page})=>{
  const f=await cursorUsage(page);try{
   await page.goto('/dashboard/my-usage');await pageTwo(page);const count=reads(f,'events').length,from=new Date(f.now-40*86400000).toISOString(),to=new Date(f.now-39*86400000).toISOString();
   await custom(page,from,to,timezone);await expect(page.getByRole('alert')).toContainText('Outside retained range');expect(reads(f,'events')).toHaveLength(count);
   await expect(page.getByLabel('Start',{exact:true})).toHaveValue(from);await expect(page.getByLabel('End (exclusive)',{exact:true})).toHaveValue(to);
   await page.getByRole('combobox',{name:'Group by',exact:true}).selectOption('provider');await expect(page.getByRole('alert')).toContainText('Outside retained range');
   await page.getByLabel('Model (exact)',{exact:true}).fill('missing-model');await page.getByRole('button',{name:'Apply filters',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Outside retained range');
   await page.getByRole('button',{name:'Retry report',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Outside retained range');expect(reads(f,'events')).toHaveLength(count);
   await page.getByLabel('Model (exact)',{exact:true}).fill('');await custom(page,new Date(f.now-3600000).toISOString(),f.end(),timezone);await expect(rows(page)).toHaveCount(100);expect(f.invalid).toEqual([]);
  }finally{f.close();}
 });
 test('retention clip is disclosed and events/retries use the effective fixed interval: '+timezone,async({page})=>{
  const f=await cursorUsage(page);try{
   await page.goto('/dashboard/my-usage');await activity(page);await expect(rows(page)).toHaveCount(100);
   const from=new Date(f.now-30*86400000).toISOString(),to=new Date(f.now-86400000).toISOString();f.failEvents();await custom(page,from,to,timezone);
   await expect(page.getByRole('alert')).toContainText('Injected event failure');const failed=reads(f,'events').at(-1)!;expect(Date.parse(failed.searchParams.get('from')!)).toBeGreaterThan(Date.parse(from));expect(failed.searchParams.get('to')).toBe(to);
   await page.getByText('Report scope and capture dates',{exact:true}).click();await expect(page.locator('.personalRange')).toContainText('Start clipped from '+from);
   await page.getByRole('button',{name:'Retry recent calls',exact:true}).click();await expect(page.getByText('No recent model calls for these filters.',{exact:true})).toBeVisible();expect(reads(f,'events').at(-1)!.search).toBe(failed.search);
   await page.getByRole('combobox',{name:'Group by',exact:true}).selectOption('key');await expect(page.getByRole('alert')).toHaveCount(0);expect(f.invalid).toEqual([]);
  }finally{f.close();}
 });
 test('current empty interval still reads a complete event page and Retry: '+timezone,async({page})=>{
  const f=await cursorUsage(page);try{
   await page.goto('/dashboard/my-usage');await activity(page);await expect(rows(page)).toHaveCount(100);f.failEvents();
   await custom(page,new Date(f.now-2*86400000).toISOString(),new Date(f.now-86400000).toISOString(),timezone);
   await expect(page.getByText('No calls in discovered locations for this range for your current access.',{exact:true})).toBeVisible();await expect(page.getByRole('alert')).toContainText('Injected event failure');
   const failed=reads(f,'events').at(-1)!.search;await page.getByRole('button',{name:'Retry recent calls',exact:true}).click();await expect(page.getByText('No recent model calls for these filters.',{exact:true})).toBeVisible();expect(reads(f,'events').at(-1)!.search).toBe(failed);expect(f.invalid).toEqual([]);
  }finally{f.close();}
 });
}
test('fresh JSON export reconciles a new capture, all pages, final validation and cleanup',async({page})=>{
 const f=await cursorUsage(page);try{
  await page.goto('/dashboard/my-usage');await pageTwo(page);const browse=reads(f,'events').at(-1)!.searchParams.get('cut');await f.ingest('late');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export refreshed snapshot JSON',exact:true}).click();const file=await download,stream=await file.createReadStream();let content='';for await(const chunk of stream!)content+=chunk.toString();const parsed=JSON.parse(content);
  expect(parsed.events).toHaveLength(143);expect(parsed.metadata.totals.metrics.calls).toBe(143);expect(parsed.metadata.coverage.historicalLocations).toBe('not_exhaustively_assessed');expect(content).not.toContain(browse);
  const fresh=reads(f,'report').find(u=>u.searchParams.get('intent')==='export')!;expect(fresh.searchParams.has('cut')).toBe(false);expect(fresh.searchParams.has('days')).toBe(false);expect(reads(f,'validate')).toHaveLength(1);expect(f.invalid).toEqual([]);
 }finally{f.close();}
});
