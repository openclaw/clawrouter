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
test('members see only current own calls, never shared policy totals in analytics',async({page})=>{
 const f=await serve(page,'user');try{
  await page.goto('/dashboard/home');const region=page.getByRole('region',{name:'Your personal usage',exact:true});await expect(region.locator('.personalGlance > div:nth-child(3) > dd:not(.personalGlanceMeta)').first()).toHaveText('6');await expect(region).toContainText('For your current access');await expect(region).not.toContainText('999,999');await expect(page.locator('.dashboardAnalyticsGrid')).toHaveCount(0);
 }finally{f.close();}
});
test('admins refine retained user to deleted key, page events, and export the same selected scope',async({page})=>{
 const f=await serve(page,'admin');try{
  await page.goto('/dashboard/usage');await expect(page.getByRole('heading',{name:'Usage in discovered locations',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Retained usage ranking',exact:true})).toContainText('bob@example.test');
  await page.getByRole('button',{name:'bob@example.test',exact:true}).click();await expect(page.getByRole('heading',{name:'Exact ranking by key',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'bob@example.test · removed-key',exact:true}).click();const events=page.getByRole('region',{name:'Retained events',exact:true});await expect(events.locator('tbody > tr')).toHaveCount(100);await expect(events).not.toContainText('member@example.com');
  await page.getByRole('button',{name:'Next page',exact:true}).click();await expect(events.locator('tbody > tr')).toHaveCount(13);
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export refreshed snapshot JSON',exact:true}).click();const stream=await(await download).createReadStream();let text='';for await(const chunk of stream!)text+=chunk.toString();const file=JSON.parse(text);
  expect(file.events).toHaveLength(113);expect(file.events.every((e:{user:string;keyId:string})=>e.user==='bob@example.test'&&e.keyId==='removed-key')).toBe(true);expect(file.metadata.filters.user).toBe('bob@example.test');expect(file.metadata.totals.metrics.calls).toBe(113);
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
  await page.getByRole('combobox',{name:'Group by',exact:true}).selectOption('key');
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
