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
