import { expect, test, type Page } from '@playwright/test';
import {cursorUsageFixture} from '../test/helpers/personal-usage-cursor.mjs';
import {fixtureResponses} from './fixtures/personal-usage';

async function serve(page:Page,role:'admin'|'user'){
 const f=await cursorUsageFixture({audience:role==='admin'?'admin':'personal',rows:6});
 for(let i=0;i<113;i++)await f.ingest('bob-'+i,{principal_id:'bob@example.test',credential_id:'removed-key'});
 await f.ingest('unattributed',{principal_id:null,credential_id:'svc_123'});
 const queries:URL[]=[];await page.clock.setFixedTime(new Date(f.now));
 await page.route('**/v1/**',async route=>{
  const url=new URL(route.request().url());queries.push(url);
  if(url.pathname==='/v1/session/avatar'){await route.fulfill({status:204});return;}
  if(url.pathname.startsWith('/v1/'+(role==='admin'?'admin':'session')+'/usage/')){const body=await f.read(url.href,f.now,route.request().method());await route.fulfill({json:body});return;}
  const bodies:Record<string,unknown>={...fixtureResponses,
   '/v1/session':{...(fixtureResponses['/v1/session'] as object),role},
   '/v1/admin/usage':{policies:[],usage:{ledger:'ready',summary:{requestCount:999999,totalTokens:999999,actualCostMicros:999999000000},providers:[],daily:[],events:[]}},
   '/v1/admin/bootstrap':{policies:[],credentials:[],users:[],bindings:[],grants:[],rules:[],providers:[],connections:[],fusion:{enabled:false,adviserModels:[],aggregatorModel:''},overview:null,tenants:[]},
  };
  await route.fulfill({status:url.pathname in bodies?200:404,json:bodies[url.pathname]??{}});
 });return {...f,queries};
}
async function expectAccountingBoundary(page:Page,amount:string,calls:number,scope:string){
 const metric=page.locator('.personalUsageSummary .personalGlance > div').filter({has:page.getByText('Recorded accounting amount',{exact:true})});
 const value=metric.locator('dd > strong'),coverage=metric.locator('dd > small');
 await expect(value).toHaveText(amount);await expect(coverage).toHaveText(calls+'/'+calls+' rows with a valid recorded accounting field');
 await expect(value).toBeVisible();await expect(coverage).toBeVisible();
 const valueBox=await value.boundingBox(),coverageBox=await coverage.boundingBox(),metricBox=await metric.boundingBox();
 if(!valueBox||!coverageBox||!metricBox)throw Error('Accounting metric has no rendered bounds');
 expect.soft(coverageBox.y-(valueBox.y+valueBox.height),scope+': coverage must start below the complete monetary amount with visible spacing').toBeGreaterThanOrEqual(4);
 for(const box of [valueBox,coverageBox]){
  expect.soft(box.x,scope+': accounting text must stay inside its metric').toBeGreaterThanOrEqual(metricBox.x);
  expect.soft(box.x+box.width,scope+': accounting text must not clip horizontally').toBeLessThanOrEqual(metricBox.x+metricBox.width);
 }
}
test('member Details exports its activity page without offering an inline events toggle', async ({page, isMobile}) => {
 const f = await serve(page, 'user'), release = Promise.withResolvers<void>();
 try {
  await page.emulateMedia({colorScheme: isMobile ? 'dark' : 'light'});
  await page.route('**/v1/session/usage/events?**', async route => { await release.promise; await route.fallback(); });
  await page.goto('/dashboard/my-usage');
  const details = page.getByRole('tab', {name: 'Details', exact: true});
  await page.getByRole('tab', {name: 'Overview'}).focus();
  await page.keyboard.press('End');
  await expect(details).toBeFocused();
  await page.keyboard.press('Enter');
  const pane = page.getByRole('tabpanel', {name: 'Details'});
  await expect(pane.getByRole('region', {name: 'Retained usage ranking'})).toBeVisible();
  await expect(pane.getByRole('button', {name: /^(Hide|Show) events$/})).toHaveCount(0);
  const csv = pane.getByRole('button', {name: 'Export activity page 1 CSV'});
  await expect(csv).toBeDisabled();
  release.resolve();
  await expect(csv).toBeEnabled();
  const download = page.waitForEvent('download');
  await csv.press('Space');
  const file = await download;
  expect(file.suggestedFilename()).toBe('usage-current-page-1.csv');
  const stream = await file.createReadStream();
  if (!stream) throw Error('No activity CSV stream');
  const bytes: Buffer[] = [];
  for await (const chunk of stream) bytes.push(chunk);
  const rows = Buffer.concat(bytes).toString().trimEnd().split('\r\n').slice(2);
  expect(rows).toHaveLength(6);
  expect(rows.every(row => row.includes('"member@example.com"'))).toBe(true);
  await details.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', {name: 'Recent calls table'}).locator('tbody tr')).toHaveCount(6);
 } finally { release.resolve(); await page.unrouteAll({behavior: 'wait'}); f.close(); }
});

test('admin ranking toggles its inline events table from the keyboard', async ({page, isMobile}) => {
 const f = await serve(page, 'admin');
 try {
  await page.emulateMedia({colorScheme: isMobile ? 'dark' : 'light'});
  await page.goto('/dashboard/usage');
  const show = page.getByRole('button', {name: 'Show events', exact: true});
  const events = page.getByRole('region', {name: 'Retained events', exact: true});
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(events).toHaveCount(0);
  await show.press('Enter');
  const hide = page.getByRole('button', {name: 'Hide events', exact: true});
  await expect(hide).toBeFocused();
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  await expect(events.locator('tbody tr')).toHaveCount(100);
  await hide.press('Space');
  await expect(show).toBeFocused();
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(events).toHaveCount(0);
 } finally { f.close(); }
});

test('members see only current own calls, never shared policy totals in analytics',async({page})=>{
 const f=await serve(page,'user');try{
  await page.goto('/dashboard/home');const region=page.getByRole('region',{name:'Your personal usage',exact:true});await expect(region.locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)').first()).toHaveText('6');await expect(region).toContainText('For your current access');await expect(region).not.toContainText('999,999');await expect(page.locator('.dashboardAnalyticsGrid')).toHaveCount(0);
 }finally{f.close();}
});
test('admins refine retained user to deleted key, page events, and export the same selected scope',async({page})=>{
 const f=await serve(page,'admin');try{
  await f.ingest('bob-sibling', {principal_id:'bob@example.test',credential_id:'backup-key',actual_cost_micros:17});
  await page.goto('/dashboard/usage');await expect(page.getByRole('heading',{name:'Usage in discovered locations',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Retained usage ranking',exact:true})).toContainText('bob@example.test');
  await expectAccountingBoundary(page,'$0.000857',121,'all users');
  await page.getByRole('button',{name:'bob@example.test',exact:true}).click();await expect(page.getByRole('heading',{name:'Exact ranking by key',exact:true})).toBeVisible();
  await expectAccountingBoundary(page,'$0.000808',114,'selected user');
  await page.getByRole('button',{name:'bob@example.test · removed-key',exact:true}).click();const events=page.getByRole('region',{name:'Retained events',exact:true});await expect(events.locator('tbody > tr')).toHaveCount(100);await expect(events).not.toContainText('member@example.com');
  await expectAccountingBoundary(page,'$0.000791',113,'selected key');
  await page.getByRole('button',{name:'Next page',exact:true}).click();await expect(events.locator('tbody > tr')).toHaveCount(13);
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export refreshed snapshot JSON',exact:true}).click();const stream=await(await download).createReadStream();let text='';for await(const chunk of stream!)text+=chunk.toString();const file=JSON.parse(text);
  expect(file.events).toHaveLength(113);expect(file.events.every((e:{user:string;keyId:string})=>e.user==='bob@example.test'&&e.keyId==='removed-key')).toBe(true);expect(file.metadata.filters.user).toBe('bob@example.test');expect(file.metadata.totals.metrics.calls).toBe(113);
  expect(file.metadata.filters.key).toEqual({kind:'credential',id:'removed-key'});
  await page.getByRole('button',{name:'Clear key filter',exact:true}).click();
  await expectAccountingBoundary(page,'$0.000808',114,'all keys for selected user');
  await expect(page.getByRole('group',{name:'Export snapshot scope'})).toContainText('Key: removed-key');
  await expect(page.getByRole('group',{name:'Displayed report scope'})).toContainText('All keys');
  await expect(page.getByRole('region',{name:'Retained usage ranking',exact:true})).not.toContainText('999,999');expect(f.queries.some((u:URL)=>u.pathname==='/v1/session/usage/report')).toBe(false);
 }finally{f.close();}
});

for (const action of ['Refresh report', 'Apply refinement'] as const) {
 test('admin keeps the attempted owner and period after a failed report: ' + action, async ({page, isMobile}) => {
  const f = await serve(page, 'admin');
  const previous = 'alex@example.test', attempted = 'sam@example.test', sharedKey = 'build-runner';
  const day = 86_400_000, today = Math.floor(f.now / day) * day;
  const date = (offset: number) => new Date(today + offset * day).toISOString().slice(0, 10);
  try {
   // Same retained credential ID under both owners: the key alone cannot distinguish them.
   for (const [id, user, at, model, key] of [
    ['old-row', previous, -5, 'earlier', sharedKey], ['wrong-owner', previous, -2, 'editor', sharedKey],
    ['first', attempted, -2, 'editor', sharedKey], ['second', attempted, -2, 'editor', sharedKey],
    ['wrong-model', attempted, -2, 'other-model', sharedKey], ['sibling', attempted, -2, 'editor', 'backup'],
   ] as const) await f.ingest(id, { principal_id: user, credential_id: key, model, occurred_at_ms: today + at * day });
   if (isMobile) await page.setViewportSize({width: 360, height: 780});
   await page.goto('/dashboard/usage');
   const form = page.getByRole('form', {name:'Usage filters'}), scope = form.getByRole('group', {name:'Displayed report scope'});
   const summary = page.locator('.personalUsageSummary'), calls = summary.getByText('Model calls', {exact:true}).locator('+ dd');
   const ranks = page.getByRole('region', {name:'Retained usage ranking'}), events = page.getByRole('region', {name:'Retained events'});
   const button = (name: string) => page.getByRole('button', {name, exact:true});
   const download = async () => {
    const [file] = await Promise.all([page.waitForEvent('download'), button('Export refreshed snapshot JSON').press('Enter')]);
    const stream = await file.createReadStream(); if (!stream) throw Error('No export stream');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
   };
   await button('By key').click();
   await form.getByText('Custom interval and exact filters').click();
   const owner = form.getByLabel('user (exact)', {exact:true}), model = form.getByLabel('model (exact)', {exact:true});
   const from = form.getByLabel('Start', {exact:true}), to = form.getByLabel('End', {exact:true});
   await owner.fill(previous); await from.fill(date(-6)); await to.fill(date(-4));
   await button('Apply refinement').click();
   await ranks.getByRole('button', {name:previous + ' · ' + sharedKey, exact:true}).click();
   await expect(calls).toHaveText('1'); await expect(events).toContainText('earlier');
   const original = await download(); expect(original.events.map((e: {id:string}) => e.id)).toEqual(['old-row']);
   const receipt = page.getByRole('group', {name:'Export snapshot scope'});
   const originalReceipt = await receipt.innerText();
   const failedReport = (u: URL) => u.pathname === '/v1/admin/usage/report' && u.searchParams.get('user') === attempted && u.searchParams.get('intent') === 'browse';
   let failedReads = 0;
   await page.route(failedReport, route => { failedReads++; return route.fulfill({status:503, json:{error:{message:'Report temporarily unavailable'}}}); }, {times:1});
   const eventReads = () => f.queries.filter((u: URL) => u.pathname === '/v1/admin/usage/events' && u.searchParams.get('user') === attempted);
   await owner.fill(attempted); await model.fill('editor'); await from.fill(date(-3)); await to.fill(date(-1));
   await button('Apply refinement').press('Enter');
   const alert = summary.getByRole('alert'); await expect(alert).toContainText('Report temporarily unavailable');
   expect.soft(await owner.inputValue()).toBe(attempted); expect.soft(await model.inputValue()).toBe('editor');
   await expect(from).toHaveValue(date(-3)); await expect(to).toHaveValue(date(-1));
   await expect(scope).toContainText('Last successful report:');
   await expect(scope).toContainText('User: ' + previous); await expect(scope).not.toContainText(attempted);
   await expect(calls).toHaveText('1'); await expect(ranks.getByRole('button', {name:previous + ' · ' + sharedKey})).toBeDisabled();
   await expect(receipt).toHaveText(originalReceipt, {useInnerText:true});
   for (const name of ['Export refreshed snapshot JSON','Export refreshed snapshot CSV','Export current rank page CSV']) await expect(button(name)).toBeDisabled();
   await expect(button('Export current page CSV')).toHaveCount(0);
   await expect(page.getByText('Refresh the report above to load retained events.', {exact:true})).toBeVisible();
   await expect(page.getByText('Loading events…', {exact:true})).toHaveCount(0);
   expect(eventReads()).toHaveLength(0); expect(failedReads).toBe(1);

   // A successful report can be exported even if its separate event page fails.
   let failedPage = '';
   await page.route(u => u.pathname === '/v1/admin/usage/events' && u.searchParams.get('user') === attempted, route => {
    failedPage = new URL(route.request().url()).search;
    return route.fulfill({status:503, json:{error:{message:'Event page temporarily unavailable'}}});
   }, {times:1});
   await (action === 'Refresh report' ? alert : form).getByRole('button', {name:action, exact:true}).press('Enter');
   await expect(scope).toContainText('User: ' + attempted); await expect(scope).toContainText('Model: editor');
   await expect(calls).toHaveText('2'); await expect(summary.getByRole('alert')).toHaveCount(0);
   await expect(page.getByRole('alert')).toContainText('Event page temporarily unavailable');
   await expect(receipt).toHaveText(originalReceipt, {useInnerText:true});
   const reportReads = f.queries.filter((u: URL) => u.pathname.endsWith('/report')).length;
   await button('Retry event page').press('Enter'); await expect(events.locator('tbody tr')).toHaveCount(2);
   expect(eventReads().at(-1)!.search).toBe(failedPage);
   expect(f.queries.filter((u: URL) => u.pathname.endsWith('/report'))).toHaveLength(reportReads);
   const recovered = await download();
   expect(recovered.metadata).toMatchObject({filters:{user:attempted, model:'editor', key:{kind:'credential',id:sharedKey}}, range:{from:Date.parse(date(-3)),to:Date.parse(date(-1)),timezone:'UTC'}});
   expect(recovered.events.map((e: {id:string}) => e.id).sort()).toEqual(['first','second']);
   await button('Clear key filter').press('Enter'); await expect(scope).toContainText('All keys');
   await expect(scope).toContainText('User: ' + attempted); await expect(calls).toHaveText('3');
   await owner.fill(''); await button('Apply refinement').press('Enter'); await expect(calls).toHaveText('4');
   const cleared = await download(); expect(cleared.metadata.filters).toEqual({model:'editor'});
   expect(cleared.metadata.range).toEqual(recovered.metadata.range);
   expect(cleared.events.map((e: {id:string}) => e.id).sort()).toEqual(['first','second','sibling','wrong-owner']);
  } finally { await page.unrouteAll({behavior:'wait'}); f.close(); }
 });
}

test('unbound retained owners stay unavailable and service keys cannot imply an owner',async({page})=>{
 const f=await serve(page,'admin');try{
  await page.goto('/dashboard/usage');
  const ranking=page.getByRole('region',{name:'Retained usage ranking',exact:true});
  await expect(page.getByRole('heading',{name:'Exact ranking by user',exact:true})).toBeVisible();
  const unavailableUser=ranking.getByRole('row').filter({has:page.getByRole('button',{name:'Unavailable identity',exact:true})});
  await expect(unavailableUser).toHaveCount(1);
  await expect(unavailableUser.getByRole('button',{name:'Unavailable identity',exact:true})).toBeDisabled();
  await expect(unavailableUser.locator('td').first()).toHaveText('1');
  await page.getByRole('button',{name:'By key',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Exact ranking by key',exact:true})).toBeVisible();
  const unboundKey=ranking.getByRole('row').filter({has:page.getByRole('button',{name:'Unavailable owner · svc_123',exact:true})});
  await expect(unboundKey).toHaveCount(1);
  await expect(unboundKey.getByRole('button',{name:'Unavailable owner · svc_123',exact:true})).toBeDisabled();
  await expect(unboundKey.locator('td').first()).toHaveText('1');
  await expect(unboundKey.getByRole('link')).toHaveCount(0);
  const query=f.queries.filter((url:URL)=>url.pathname==='/v1/admin/usage/report').at(-1)!.searchParams;
  expect(query.get('groupBy')).toBe('key');expect(query.has('user')).toBe(false);expect(query.has('key')).toBe(false);
 }finally{f.close();}
});

test('By key compares retained keys; selecting and clearing one preserves the report period and other filters', async ({ page }) => {
 const f = await serve(page, 'admin');
 try {
  await f.ingest('bob-session', {principal_id: 'bob@example.test', credential_id: null});
  await f.ingest('bob-other', {principal_id: 'bob@example.test', credential_id: 'build-key', input_tokens: 17, output_tokens: 3, cost_basis: 'unpriced_model'});
  await page.goto('/dashboard/usage');
  const ranking = page.getByRole('region', {name: 'Retained usage ranking', exact: true});
  const byKey = page.getByRole('button', {name: 'By key', exact: true});
  await expect(ranking.getByRole('button', {name: 'bob@example.test', exact: true})).toBeVisible();
  const start = new Date(f.now - 4 * 86400000).toISOString(), end = new Date(f.now).toISOString();
  const advanced = page.getByText('Custom interval and exact filters', {exact: true});
  await advanced.click();
  await page.getByLabel('Start', {exact: true}).fill(start);
  await page.getByLabel('End', {exact: true}).fill(end);
  await page.getByLabel('status (exact)', {exact: true}).fill('success');
  await page.getByRole('button', {name: 'Apply refinement', exact: true}).click();
  await expect(page.getByRole('group', {name:'Displayed report scope'})).toContainText('Status: success');
  await advanced.click();
  await byKey.focus();
  await page.keyboard.press('Enter');
  await expect(byKey).toHaveAttribute('aria-pressed', 'true');
  const keyRow = (name: string) => ranking.getByRole('row').filter({has: page.getByRole('button', {name, exact: true})});
  const removed = keyRow('bob@example.test · removed-key'), build = keyRow('bob@example.test · build-key');
  await expect(removed.locator('td')).toContainText(['113', '113 / 226', '$0.000791']);
  await expect(build.locator('td')).toContainText(['1', '17 / 3', '$0.000007']);
  await expect(ranking).toContainText('member@example.com · retained-key');
  const initial = f.queries.filter((u: URL) => u.pathname === '/v1/admin/usage/report' && u.searchParams.get('groupBy') === 'key').at(-1)!.searchParams;
  expect(initial.get('from')).toBe(start);
  expect(initial.get('to')).toBe(end);
  expect(initial.get('status')).toBe('success');
  expect(initial.has('key')).toBe(false);
  expect(initial.has('user')).toBe(false);
  await removed.getByRole('button').click();
  const scope = page.getByRole('group', {name: 'Displayed report scope'});
  await expect(scope).toContainText('Key: removed-key');
  await expect(scope).toContainText('User: bob@example.test');
  const range = scope.getByText(/end exclusive/);
  const period = await range.innerText();
  const events = page.getByRole('region', {name: 'Retained events', exact: true});
  await expect(events.locator('tbody tr')).toHaveCount(100);
  await page.getByRole('button', {name: 'Next page', exact: true}).click();
  await expect(events.locator('tbody tr')).toHaveCount(13);
  const clear = scope.getByRole('button', {name: 'Clear key filter'});
  await clear.focus();
  await page.keyboard.press('Space');
  await expect(scope).toContainText('All keys');
  await expect(byKey).toBeFocused();
  await expect(scope).toContainText('User: bob@example.test');
  await expect(range).toHaveText(period);
  await expect(ranking).toContainText('bob@example.test · Dashboard session');
  await expect(ranking).not.toContainText('member@example.com');
  await expect(build.getByRole('button')).toBeVisible();
  await expect(events.locator('tbody tr')).toHaveCount(100);
  await expect(page.getByRole('button', {name: 'Previous page', exact: true})).toBeDisabled();
  const pageQuery = f.queries.filter((u: URL) => u.pathname === '/v1/admin/usage/events').at(-1)!.searchParams;
  for (const k of ['from', 'to', 'timezone', 'groupBy', 'cut', 'status']) expect(pageQuery.get(k)).toBe(initial.get(k));
  expect(pageQuery.get('user')).toBe('bob@example.test');
  for (const k of ['key', 'keyKind', 'cursor']) expect(pageQuery.has(k)).toBe(false);

  await build.getByRole('button').click();
  await expect(scope).toContainText('Key: build-key');
  await expect(page.getByText(/api · unknown: Price unknown/)).toBeVisible();
  await clear.click();
  await ranking.getByRole('button', {name: 'bob@example.test · Dashboard session'}).click();
  await expect(scope).toContainText('Key: Dashboard session');
  await expect(events.locator('tbody tr')).toHaveCount(1);
  await expect(events).toContainText('Dashboard session');
  await page.getByText('Custom interval and exact filters', {exact:true}).click();
  await page.getByLabel('model (exact)', {exact:true}).fill('unused-model');
  await page.getByRole('button', {name:'Apply refinement', exact:true}).click();
  await expect(page.getByText('No calls in discovered locations for this range.', {exact:true})).toBeVisible();
  await expect(scope).toContainText('Key: Dashboard session');
  await clear.click();
  await expect(scope).toContainText('All keys');
  await expect(scope).toContainText('Model: unused-model');
  await expect(range).toHaveText(period);
  await expect(events.locator('tbody tr')).toHaveCount(0);
  await expect(ranking.locator('tbody tr')).toHaveCount(0);
 } finally { f.close(); }
});

test('displayed key report uses retained bounds and never labels pending results', async ({page}) => {
 const f = await serve(page, 'admin'), release = Promise.withResolvers<void>();
 try {
  // On November 26 this requests October 20–November 18; retention starts October 27.
  // Relative dates keep that seven-day gap under the fixture's real retention clock.
  const day = 86400000, from = f.now - 37 * day, to = f.now - 8 * day;
  for (const [id, at, key] of [
   ['before-cut', from + 1000, 'clipped-key'],
   ['inside-cut', f.now - 20 * day, 'clipped-key'],
   ['another-key', f.now - 20 * day, 'other-key'],
  ] as const) await f.ingest(id, {occurred_at_ms: at, credential_id: key});
  const scope = page.getByRole('group', {name:'Displayed report scope'});
  const calls = page.locator('.personalUsageSummary .personalGlance > div').filter({has:page.getByText('Model calls',{exact:true})}).locator('dd').first();
  await page.goto('/dashboard/usage');
  await page.getByRole('button', {name:'By key', exact:true}).click();
  await expect(page.getByRole('heading', {name:'Exact ranking by key', exact:true})).toBeVisible();
  await page.getByText('Custom interval and exact filters', {exact:true}).click();
  const start = page.getByLabel('Start', {exact:true});
  await start.fill(new Date(from).toISOString());
  await page.getByLabel('End', {exact:true}).fill(new Date(to).toISOString());
  const response = page.waitForResponse(r => new URL(r.url()).searchParams.get('from') === new Date(from).toISOString() && new URL(r.url()).pathname === '/v1/admin/usage/report');
  await page.getByRole('button', {name:'Apply refinement', exact:true}).click();
  const {value} = await (await response).json();
  expect(value.coverage.clippedFrom).toBe(from);
  expect(value.query.from).toBe(value.coverage.effectiveFrom);
  expect(value.query.from - from).toBeGreaterThanOrEqual(7 * day);
  expect(value.query.from - from).toBeLessThan(8 * day);
  expect(value.query.to).toBe(to);
  const retained = await page.evaluate(({from,to,timezone}) => new Intl.DateTimeFormat('en', {dateStyle:'medium',timeStyle:'short',timeZone:timezone}).formatRange(from,to), value.query);
  await expect(calls).toHaveText('2');
  await expect(start).toHaveValue(new Date(from).toISOString());
  await expect(scope).toContainText('Retained interval:');
  await expect(scope).toContainText(retained);

  const keyRead = (url: URL) => url.pathname === '/v1/admin/usage/report' && url.searchParams.get('key') === 'clipped-key';
  await page.route('**/v1/admin/usage/report?**', async route => {
   if (keyRead(new URL(route.request().url()))) await release.promise;
   await route.fallback();
  });
  const pending = page.waitForRequest(r => keyRead(new URL(r.url())));
  await page.getByRole('button', {name:'member@example.com · clipped-key'}).click();
  await pending;
  await expect(page.getByText('Loading complete usage…', {exact:true})).toBeVisible();
  await expect(scope).toHaveCount(0);
  await expect(calls).toHaveCount(0);
  release.resolve();
  await expect(scope).toContainText('Key: clipped-key');
  await expect(scope).toContainText(retained);
  await expect(calls).toHaveText('1');
  const events = page.getByRole('region', {name:'Retained events', exact:true});
  await expect(events.locator('tbody tr')).toHaveCount(1);
  expect(f.queries.filter((u: URL) => u.pathname === '/v1/admin/usage/events').at(-1)!.searchParams.get('from')).toBe(new Date(value.query.from).toISOString());
 } finally { release.resolve(); f.close(); }
});

for (const role of ['admin', 'user'] as const) test(role + ' keeps the last downloaded scope when a different export fails validation', async ({page, isMobile}) => {
 const f = await serve(page, role), release = Promise.withResolvers<void>();
 const files: string[] = [];
 page.on('download', file => files.push(file.suggestedFilename()));
 try {
  await f.ingest('sibling-key', {credential_id: 'weekend-key'});
  await page.emulateMedia({colorScheme: isMobile ? 'dark' : 'light'});
  await page.goto(role === 'admin' ? '/dashboard/usage' : '/dashboard/my-usage');
  const button = page.getByRole('button', {name: 'Export refreshed snapshot JSON', exact: true});
  const receipt = page.getByRole('group', {name: 'Export snapshot scope'});
  async function download() {
   const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
   const stream = await file.createReadStream();
   if (!stream) throw Error('No download stream');
   const bytes: Buffer[] = [];
   for await (const chunk of stream) bytes.push(chunk);
   return JSON.parse(Buffer.concat(bytes).toString());
  }
  const original = await download();
  expect(original.metadata.filters.key).toBeUndefined();
  expect(original.events).toHaveLength(role === 'admin' ? 121 : 7);
  await expect(receipt).toContainText('All keys');
  const originalScope = await receipt.innerText();

  await page.getByRole('button', {name: role === 'admin' ? 'By key' : 'Compare keys', exact: true}).click();
  if (role === 'user') await page.getByRole('tab', {name: 'Details', exact: true}).click();
  await page.getByRole('region', {name: 'Retained usage ranking'}).getByRole('button', {name: 'member@example.com · retained-key', exact: true}).click();
  const displayed = role === 'admin' ? page.getByRole('group', {name: 'Displayed report scope'}) : page.locator('.personalUsageSummary .personalActiveFilters');
  await expect(displayed).toContainText('retained-key');
  await expect(button).toBeEnabled();
  const validation = (url: URL) => url.pathname.endsWith('/usage/validate');
  await page.route(validation, async route => {
   await release.promise;
   await route.fulfill({status: 503, json: {error: {message: 'Validation temporarily unavailable'}}});
  }, {times: 1});
  const pending = page.waitForRequest(request => validation(new URL(request.url())));
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await pending;
  await expect(button).toBeDisabled();
  await expect(receipt).toHaveText(originalScope, {useInnerText: true});
  release.resolve();
  await expect(page.getByRole('status').filter({hasText: 'No file was downloaded'})).toContainText('Validation temporarily unavailable');
  await expect(receipt).toHaveText(originalScope, {useInnerText: true});
  expect(files).toHaveLength(1);

  const retried = await download();
  expect(retried.events).toHaveLength(6);
  expect(retried.metadata.filters).toMatchObject({user: 'member@example.com', key: {kind: 'credential', id: 'retained-key'}});
  await expect(receipt).toContainText('Key: retained-key');
  expect(files).toHaveLength(2);
 } finally { release.resolve(); await page.unrouteAll({behavior: 'wait'}); f.close(); }
});

for (const role of ['admin','user'] as const) test(role + ' keeps a completed export receipt but locks stale ranking and export actions until retry succeeds', async ({page}) => {
 const f = await serve(page, role);
 try {
  await page.goto(role === 'admin' ? '/dashboard/usage' : '/dashboard/my-usage');
  if (role === 'user') await page.getByRole('tab', {name:'Details',exact:true}).click();
  const section = (heading: RegExp) => page.locator('section').filter({has:page.getByRole('heading', {name:heading})}).last();
  const ranking = section(/^Exact ranking by /), exports = section(/^Export refreshed snapshot$/);
  const row = ranking.getByRole('button', {name:role === 'admin' ? 'bob@example.test' : 'cursor-model',exact:true});
  const json = exports.getByRole('button', {name:'Export refreshed snapshot JSON'});
  const csv = exports.getByRole('button', {name:'Export refreshed snapshot CSV'});
  const rankCsv = ranking.getByRole('button', {name:'Export current rank page CSV'});
  const order = ranking.getByRole('combobox');
  await expect(row).toBeEnabled();
  const original = page.waitForEvent('download');
  await json.click(); await original;
  const receipt = exports.getByRole('group', {name:'Export snapshot scope'});
  const originalScope = (await receipt.textContent())!;

  const path = '/v1/' + (role === 'admin' ? 'admin' : 'session') + '/usage/report';
  await page.route('**' + path + '?**', async route => {
   if (route.request().method() === 'GET' && new URL(route.request().url()).searchParams.get('intent') === 'browse') {
    await route.fulfill({status:503,json:{error:{message:'Report temporarily unavailable'}}});
   } else await route.fallback();
  });
  await page.getByRole('button', {name:'Refresh report',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Report temporarily unavailable');
  await expect(row).toBeVisible();
  await expect(receipt).toHaveText(originalScope);
  for (const control of [row, order, rankCsv, json, csv]) await expect(control).toBeDisabled();
  await expect(exports).toContainText('Retry the report');
  await expect(ranking).toContainText('Retry the report');

  await page.unroute('**' + path + '?**');
  await page.getByRole('alert').getByRole('button', {name:/^(Retry|Refresh) report$/}).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  for (const control of [row, order, rankCsv, json, csv]) await expect(control).toBeEnabled();
  await expect(receipt).toHaveText(originalScope);
  await row.click();
  if (role === 'admin') await expect(page.getByRole('heading', {name:'Exact ranking by key'})).toBeVisible();
  else await expect(ranking).toContainText('Model: cursor-model');
  const recovered = page.waitForEvent('download');
  await json.click(); await recovered;
  await expect(receipt).toContainText(role === 'admin' ? 'User: bob@example.test' : 'Model: cursor-model');
 } finally { f.close(); }
});
