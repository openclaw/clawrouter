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
