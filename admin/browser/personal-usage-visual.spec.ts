import { completeDisplayOutcome } from './fixtures/complete-usage';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { visualUsageEvents, visualUsageReport } from './fixtures/personal-usage-visual';
import { fixtureNow, fixtureResponses } from './fixtures/personal-usage';

async function story(page: Page, prices: 'mixed'|'unknown'|'free'='mixed') {
 const queries:URL[]=[];await page.clock.setFixedTime(new Date(fixtureNow));await page.addInitScript(()=>localStorage.setItem('clawrouter-theme','light'));
 await page.route('**/v1/**',async route=>{const u=new URL(route.request().url());if(route.request().method()==='GET')queries.push(u);if(route.request().method()==='DELETE'){await route.fulfill({json:{kind:'complete',value:{released:true}}});return;}if(u.pathname==='/v1/session/avatar'){await route.fulfill({status:204});return;}let body:unknown;
 if(u.pathname.endsWith('/usage/report')){const p=visualUsageReport(u.searchParams);if(prices!=='mixed'){const cost=(calls:number)=>[{lane:'api' as const,costClass:prices==='unknown'?'unknown' as const:'no_charge' as const,calls,amountMicros:0}];p.costs=cost(p.metrics.calls);p.groups=p.groups.map(g=>({...g,costs:cost(g.metrics.calls)}));p.buckets=p.buckets.map(b=>({...b,costs:cost(b.metrics.calls)}));}body=p;}
 else body=u.pathname.endsWith('/usage/events')?visualUsageEvents(u.searchParams):fixtureResponses[u.pathname];await route.fulfill({status:body?200:404,json:completeDisplayOutcome(body??{},u)});});return queries;
}
const summary=(p:Page)=>p.getByRole('region',{name:'Your personal usage',exact:true});
const metric=(p:Page)=>p.getByRole('group',{name:'Chart metric',exact:true});
const reports=(q:URL[])=>q.filter(u=>u.pathname.endsWith('/report')).length;
const eventReads=(q:URL[])=>q.filter(u=>u.pathname.endsWith('/events')).length;
const rows=(p:Page)=>p.locator('.personalActivityTable tbody > tr');
const afterPaint=(p:Page)=>p.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));

test('overview foregrounds honest cards, trend and ranked models without accounting dump',async({page},info)=>{
 const q=await story(page);await page.goto('/dashboard/my-usage');await expect(page.getByRole('heading',{name:'My usage',exact:true})).toHaveCount(1);
 await expect(summary(page)).toContainText('5,310');await expect(summary(page)).toContainText('Subscription equivalent');
 await expect(page.getByRole('region',{name:'Usage trend',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Top models',exact:true})).toBeVisible();
 await expect(page.getByRole('tab',{name:'Overview',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('.personalActivityTable')).toHaveCount(0);await expect(page.locator('.personalCosts')).toHaveCount(0);await expect(page.locator('.personalAdvanced')).not.toHaveAttribute('open');
 await afterPaint(page);expect(eventReads(q),'Overview must not read event pages').toBe(0);
 const axis=await page.locator('.personalChartViewport .chartAxisLabel').evaluateAll(nodes=>nodes.map(node=>{const e=node as SVGTextElement;return{font:parseFloat(getComputedStyle(e).fontSize)*(e.getScreenCTM()?.a??1),text:e.textContent};}));expect(axis.length).toBeGreaterThan(0);expect(axis.every(v=>v.font>=10)).toBe(true);
 const geometry=await page.evaluate(()=>{const b=(s:string)=>{const r=document.querySelector(s)!.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};return{viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,nodes:document.querySelectorAll('*').length,controls:b('.personalControls'),summary:b('.personalUsageSummary'),glance:b('.personalGlance'),trend:b('.personalTrendPanel'),ranking:b('.personalRanksPanel')};});
 await info.attach('overview-geometry',{body:JSON.stringify({geometry,axis,reportReads:reports(q),eventReads:eventReads(q)}),contentType:'application/json'});
 expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport.width);expect(geometry.trend.right).toBeLessThanOrEqual(geometry.viewport.width);expect(geometry.ranking.right).toBeLessThanOrEqual(geometry.viewport.width);if(info.project.name==='desktop')expect(geometry.trend.bottom).toBeLessThanOrEqual(geometry.viewport.height+20);
 await expect(summary(page).getByText('For your current access. Earlier access and locations are not claimed covered.',{exact:false})).toBeVisible();
 const accounting=summary(page).locator('.personalAccounting');
 await expect(accounting.locator('summary')).toBeVisible();await expect(accounting.locator('summary')).toContainText('not a price or confirmed settlement');
 await accounting.locator('summary').focus();await page.keyboard.press('Enter');
 await expect(accounting.getByText(/rows with a valid recorded accounting field/)).toBeVisible();
 await expect(accounting.getByText(/Settlement-confirmation evidence is unavailable/)).toBeVisible();
 const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(axe.violations).toEqual([]);
});

test('metric switches remain client-only, preserve selection across periods and expose real gap/keyboard values',async({page},info)=>{
 const q=await story(page);await page.goto('/dashboard/my-usage');await expect(page.getByRole('heading',{name:'Tokens over time',exact:true})).toBeVisible();await afterPaint(page);expect(eventReads(q)).toBe(0);
 const before={report:reports(q),events:eventReads(q)},timings:Array<{metric:string;actionToVisibleMs:number}>=[];
 for(const label of ['API cost','Calls','Tokens','API cost']){const start=await page.evaluate(()=>performance.now());await metric(page).getByRole('button',{name:label,exact:true}).click();await expect(page.getByRole('heading',{name:label+' over time',exact:true})).toBeVisible();await afterPaint(page);timings.push({metric:label,actionToVisibleMs:await page.evaluate(t=>performance.now()-t,start)});}
 expect(reports(q)).toBe(before.report);expect(eventReads(q)).toBe(before.events);
 const path=await page.locator('.personalChartViewport .chartLine').getAttribute('d');expect((path?.match(/M/g)??[]).length).toBeGreaterThanOrEqual(2);await expect(page.locator('.personalChartLegend')).toContainText('Gaps: not reported');
 const chart=page.locator('.personalChartViewport');await chart.focus();await page.keyboard.press('Home');await expect(page.locator('.personalChartReadout')).toContainText('2026-10-26');await page.keyboard.press('ArrowRight');await expect(page.locator('.personalChartReadout')).toContainText('2026-10-27');
 if(info.project.name==='mobile'){await chart.tap({position:{x:150,y:100}});await expect(page.locator('.personalChartReadout')).not.toHaveText('Hover, tap, or use arrow keys to inspect a day.');}
 await page.getByRole('button',{name:'Last 30 days',exact:true}).click();await expect.poll(()=>q.filter(u=>u.pathname.endsWith('/report')).at(-1)?.searchParams.get('days')).toBe('30');await expect(metric(page).getByRole('button',{name:'API cost',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('combobox',{name:'Group by',exact:true}).selectOption('provider');await expect(page.getByRole('heading',{name:'Top providers',exact:true})).toBeVisible();await expect(metric(page).getByRole('button',{name:'API cost',exact:true})).toHaveAttribute('aria-pressed','true');
 await info.attach('client-metric-responsiveness',{body:JSON.stringify({timings,scope:'synthetic browser action-to-render, two animation frames; not INP/backend/WAN latency',noExtraQueriesForMetricSwitch:true}),contentType:'application/json'});
});

test('Activity and Details progressively disclose paging, metadata and exports with keyboard tabs',async({page})=>{
 const q=await story(page);await page.goto('/dashboard/my-usage');await expect(page.getByRole('heading',{name:'Tokens over time',exact:true})).toBeVisible();
 const tabs=page.getByRole('tablist',{name:'Personal usage views',exact:true});await tabs.getByRole('tab',{name:'Overview',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(tabs.getByRole('tab',{name:'Activity',exact:true})).toBeFocused();await expect(tabs.getByRole('tab',{name:'Overview',exact:true})).toHaveAttribute('aria-selected','true');expect(eventReads(q)).toBe(0);await page.keyboard.press('Enter');await expect(rows(page)).toHaveCount(25);expect(eventReads(q)).toBe(1);
 const r=reports(q);await page.getByRole('button',{name:'Next page',exact:true}).click();await expect(rows(page)).toHaveCount(5);await expect(page.getByText('Page 2',{exact:true})).toBeVisible();expect(reports(q)).toBe(r);
 await page.getByRole('tab',{name:'Details',exact:true}).click();await expect(page.getByRole('region',{name:'Costs by billing lane',exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'Time bucket data',exact:true})).toBeVisible();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export activity page 2 CSV',exact:true}).click();expect((await download).suggestedFilename()).toBe('usage-current-page-2.csv');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(axe.violations).toEqual([]);
});

for(const prices of ['unknown','free'] as const)test('cost chart distinguishes '+prices+' from invented zero',async({page})=>{
 await story(page,prices);await page.goto('/dashboard/my-usage');await expect(page.getByRole('heading',{name:'Tokens over time',exact:true})).toBeVisible();await metric(page).getByRole('button',{name:'API cost',exact:true}).click();
 const card=summary(page).locator('.personalGlance > div').filter({hasText:'Known API cost'});
 if(prices==='unknown'){await expect(card).toContainText('Unavailable');await expect(card).not.toContainText('$0.00');await expect(page.locator('.personalChartEmpty')).toContainText('No reported values');expect((await page.locator('.personalChartViewport .chartLine').getAttribute('d'))?.trim()).toBe('');}
 else{await expect(card).toContainText('$0.00');await expect(page.locator('.personalChartEmpty')).toHaveCount(0);expect((await page.locator('.personalChartViewport .chartLine').getAttribute('d') ?? '').trim()).not.toBe('');}
});

test('dark narrow overview keeps contextual help accessible and contained',async({page})=>{
 await story(page);await page.goto('/dashboard/my-usage');await expect(page.getByRole('heading',{name:'Tokens over time',exact:true})).toBeVisible();
 await page.getByRole('switch',{name:'Light mode',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.setViewportSize({width:320,height:800});await afterPaint(page);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const help=summary(page).locator('.personalGlance > div').filter({hasText:'Known API cost'}).locator('details');
 await help.locator('summary').click();await expect(help).toHaveAttribute('open');
 const box=await help.locator('.personalHelpContent').boundingBox();expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(8);expect(box!.x+box!.width).toBeLessThanOrEqual(312);
 await help.locator('summary').focus();await page.keyboard.press('Escape');await expect(help).not.toHaveAttribute('open');
 const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(axe.violations).toEqual([]);
});
