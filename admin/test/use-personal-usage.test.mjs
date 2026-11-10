import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as api from '../src/complete-usage.ts';
import {parseUsageRangeInput} from '../src/usage-range.ts';
import {emptyFilters} from '../src/personal-usage.ts';
// Execute the actual hook with a deterministic React scheduling harness; no source assertions.
const source=stripTypeScriptTypes(await readFile(new URL('../src/hooks/use-personal-usage.ts',import.meta.url),'utf8')).split(String.fromCharCode(10)).filter(line=>!line.startsWith('import ')).join(String.fromCharCode(10)).replaceAll('export function ','function ');
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const now=Date.parse('2026-11-10T12:00:00Z');
const metrics=()=>Object.fromEntries(api.metricKeys.map(k=>[k,0]));
function report(extra={}){return {query:{from:now-3600000,to:now,timezone:'Asia/Kathmandu',grain:'day',groupBy:'model',rankBy:'calls',rankOffset:0,filters:{user:'alice@example.com'}},cut:'a'.repeat(43),metrics:metrics(),costs:[],recordedChargeMicros:0,chargeReportedCalls:0,groups:[],buckets:[],remainder:{metrics:metrics(),costs:[],recordedChargeMicros:0,chargeReportedCalls:0},rank:{exact:true,distinctGroups:0,offset:0,hasMore:false},coverage:{allDiscoveredSourcesAnswered:true,effectiveFrom:now-3600000,clippedFrom:null,capturedBetween:{from:now,to:now},captureAudit:{startedAt:now-1000,verifiedSince:now-1000,captureGapObserved:false},historicalLocations:'not_exhaustively_assessed',formerLocationLateWrites:'not_bounded'},...extra};}
const outcome=value=>({kind:'complete',value});
function mount({full=true,audience='personal'}={}){
 const slots=[],effects=[],pending=[],requests=[],downloads=[],timeouts=new Map(),intervals=new Map();let cursor=0,alive=true,id=0;
 const props={active:true,full,scope:{origin:'https://console.example',epoch:1,session:{auth:'local',role:audience==='admin'?'admin':'user',tenantId:'tenant',email:'alice@example.com'},isCurrent:()=>alive},request:(_origin,path,init={})=>{if(init.method==='DELETE'){requests.push({path,init});return Promise.resolve(outcome({released:true}));}return new Promise((resolve,reject)=>requests.push({path,init,resolve,reject}));}};
 const useState=initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];};
 const useRef=initial=>useState(()=>({current:initial}))[0];
 const useEffect=(setup,deps)=>{const i=cursor++,old=effects[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j])))pending.push(()=>{old?.cleanup?.();effects[i]={deps,cleanup:setup()};});};
 const useMemo=(create,deps)=>{const memo=useRef();if(!memo.current||deps.some((v,i)=>!Object.is(v,memo.current.deps[i])))memo.current={deps,value:create()};return memo.current.value;};
 const dependencies={useState,useRef,useEffect,useMemo,emptyFilters,parseUsageRangeInput,...api,downloadUsageFile:file=>downloads.push(file),setTimeout:fn=>{timeouts.set(++id,fn);return id;},clearTimeout:i=>timeouts.delete(i),setInterval:fn=>{intervals.set(++id,fn);return id;},clearInterval:i=>intervals.delete(i)};
 const hooks=new Function(...Object.keys(dependencies),source+'; return {useUsageReport,usePersonalUsage};')(...Object.values(dependencies));
 const render=()=>{cursor=0;const data=audience==='personal'?hooks.usePersonalUsage(props):hooks.useUsageReport(props,audience);while(pending.length)pending.shift()();return data;};
 return {props,requests,downloads,render,tick:()=>{for(const [i,fn]of [...timeouts]){timeouts.delete(i);fn();}},interval:()=>{for(const fn of intervals.values())fn();},retire:()=>{alive=false;for(const e of effects)e?.cleanup?.();},reads:()=>requests.filter(r=>r.resolve)};
}
async function opened(f,value=report()){f.render();f.render();f.tick();f.reads().at(-1).resolve(outcome(value));await flush();return f.render();}
test('personal presentation retains ranges and fields without asserting exhaustive history',async()=>{
 const f=mount(),value=report();let h=await opened(f,value);assert.equal(h.report.value.range.from,value.query.from);assert.equal('historyComplete' in h.report.value,false);assert.equal(h.complete.report.value,value);assert.equal(h.query.from,new Date(value.query.from).toISOString());const query=h.query,view=h.report.value;for(let i=0;i<5;i++)h=f.render();assert.equal(h.query,query);assert.equal(h.report.value,view);assert.equal(f.reads().length,1);f.retire();
});
test('Home forty refresh ticks use summary without any retained cut; detail opens browse',async()=>{
 const f=mount({full:false});await opened(f,report({cut:null}));for(let i=0;i<40;i++){f.interval();f.render();f.tick();const r=f.reads().at(-1),p=new URL(r.path,'https://console.example').searchParams;assert.equal(p.get('intent'),'summary');assert.equal(p.has('cut'),false);assert.equal(p.get('days'),'7');r.resolve(outcome(report({cut:null})));await flush();f.render();}
 f.props.full=true;f.render();f.render();f.tick();assert.equal(new URL(f.reads().at(-1).path,'https://console.example').searchParams.get('intent'),'browse');f.retire();
});
test('presets coalesce and superseded responses cannot publish; late roots released',async()=>{
 const f=mount();let h=await opened(f);h.preset(30);f.render();h.preset(7);f.render();f.tick();const read=f.reads().at(-1);assert.equal(f.reads().length,2);assert.equal(new URL(read.path,'https://console.example').searchParams.get('days'),'7');h=f.render();h.preset(30);f.render();f.tick();assert.equal(read.init.signal.aborted,true);read.resolve(outcome(report({cut:'b'.repeat(43)})));await flush();assert.equal(f.render().report.value,undefined);assert.ok(f.requests.some(r=>r.init.method==='DELETE'&&r.path.includes('b'.repeat(43))));f.retire();
});
for(const audience of ['personal','admin'])test(audience+' refine/back and pages retain exact server bounds, page size and cut; retry retains cursor',async()=>{
 const f=mount({audience});let h=await opened(f);h.showEvents(true);f.render();const first=f.reads().at(-1),p=new URL(first.path,'https://console.example').searchParams;assert.equal(p.get('limit'),'100');assert.equal(p.get('cut'),'a'.repeat(43));assert.equal(p.get('from'),new Date(now-3600000).toISOString());assert.equal(p.has('user'),audience==='admin');
 first.resolve(outcome({events:[{id:'first'}],nextCursor:'c'.repeat(43)}));await flush();h=f.render();h.nextPage();f.render();const second=f.reads().at(-1);assert.match(second.path,/cursor=c{43}/);second.reject(Error('temporary'));await flush();h=f.render();assert.equal(h.page,2);h.retryEvents();f.render();assert.equal(f.reads().at(-1).path,second.path);f.reads().at(-1).resolve(outcome({events:[{id:'second'}],nextCursor:null}));await flush();h=f.render();h.previousPage();h=f.render();h=f.render();assert.equal(h.events.value.events[0].id,'first');
 h.refine({...(h.complete?.query??h.query),filters:{...report().query.filters,model:'different'}});f.render();f.tick();assert.equal(f.render().events.value,undefined);const refined=f.reads().at(-1);assert.match(refined.path,/cut=a{43}/);refined.resolve(outcome(report({query:{...report().query,filters:{user:'alice@example.com',model:'different'}}})));await flush();h=f.render();h.back();f.render();f.tick();assert.equal(new URL(f.reads().at(-1).path,'https://console.example').searchParams.has('model'),false);f.retire();
});
for(const field of ['epoch','origin','email','subject','tenantId'])test('auth scope transition retires cached reports/cursors: '+field,async()=>{
 const f=mount();let h=await opened(f);h.showEvents(true);f.render();const pending=f.reads().at(-1);if(field==='epoch')f.props.scope.epoch++;else if(field==='origin')f.props.scope.origin='https://another.example';else f.props.scope.session={...f.props.scope.session,[field]:'changed'};
 assert.equal(f.render().report.value,undefined);f.render();f.tick();assert.equal(pending.init.signal.aborted,true);pending.resolve(outcome({events:[{id:'leak'}],nextCursor:null}));await flush();assert.equal(f.render().events.value,undefined);f.retire();
});
test('navigation releases retained root, reentry never reuses released selection, no stale late errors',async()=>{
 const f=mount();let h=await opened(f);h.refine({...h.complete.query,filters:{model:'selected'}});f.render();f.tick();const pending=f.reads().at(-1);f.props.active=false;f.render();assert.ok(pending.init.signal.aborted);assert.ok(f.requests.some(r=>r.init.method==='DELETE'));pending.reject(Error('late'));await flush();f.props.active=true;f.render();f.render();f.tick();const p=new URL(f.reads().at(-1).path,'https://console.example').searchParams;assert.equal(p.has('cut'),false);assert.equal(f.render().report.error,'');f.retire();
});
test('admin and personal are distinct request and cache owners',async()=>{
 const a=mount({audience:'admin'}),p=mount();await opened(a,report({query:{...report().query,groupBy:'user',filters:{}}}));await opened(p);assert.ok(a.reads()[0].path.startsWith('/v1/admin/'));assert.ok(p.reads()[0].path.startsWith('/v1/session/'));a.render().refine({...report().query,filters:{user:'retired@example.com'},groupBy:'key'});a.render();a.tick();assert.match(a.reads().at(-1).path,/user=retired%40example.com/);assert.equal(p.reads().length,1);a.retire();p.retire();
});
for(const kind of ['no_access','outside_retained_range'])test(kind+' is an explicit nonzero outcome and never queries events',async()=>{
 const f=mount();f.render();f.render();f.tick();f.reads()[0].resolve({kind,effectiveFrom:now,requestedTo:now-1});await flush();const h=f.render();assert.equal(h.report.value,undefined);assert.equal(h.report.state,kind);h.showEvents(true);f.render();assert.equal(f.reads().length,1);f.retire();
});
test('410 keeps old report labelled via event failure; refresh creates new root and resets page',async()=>{
 const f=mount();let h=await opened(f);h.showEvents(true);f.render();f.reads().at(-1).reject(Error('Refresh required (410)'));await flush();h=f.render();assert.equal(h.report.value.metrics.calls,0);assert.match(h.events.error,/Refresh required/);h.reload();f.render();f.tick();assert.equal(new URL(f.reads().at(-1).path,'https://console.example').searchParams.has('cut'),false);assert.equal(f.render().page,1);f.retire();
});

async function exporting(f){const h=f.render(),work=h.startExport('json');const r=f.reads().at(-1);assert.equal(new URL(r.path,'https://console.example').searchParams.get('intent'),'export');const fresh=report({cut:'e'.repeat(43)});r.resolve(outcome(fresh));await flush();assert.equal(f.render().exportState.report,fresh);assert.equal(f.downloads.length,0);const p=f.reads().at(-1);assert.match(p.path,/events/);p.resolve(outcome({events:[],nextCursor:null,coverage:fresh.coverage}));await flush();assert.match(f.reads().at(-1).path,/validate/);assert.equal(f.downloads.length,0);return {work,final:f.reads().at(-1)};}
test('hook downloads only after final validation and keeps fresh export totals separate from displayed snapshot',async()=>{
 const f=mount();await opened(f);const displayed=f.render().complete.report.value,{work,final}=await exporting(f);assert.equal(f.render().complete.report.value,displayed);final.resolve(outcome({valid:true}));await work;assert.equal(f.downloads.length,1);assert.match(f.render().exportState.message,/downloaded/);assert.ok(f.requests.some(r=>r.init.method==='DELETE'&&r.path.includes('e'.repeat(43))));f.retire();
});
for(const reason of ['cancel','navigation','auth','validateFailure'])test('hook export '+reason+' creates no file, no stale panel and releases root',async()=>{
 const f=mount();await opened(f);const {work,final}=await exporting(f);
 if(reason==='cancel')f.render().cancelExport();if(reason==='navigation'){f.props.active=false;f.render();f.props.active=true;f.render();}if(reason==='auth'){f.props.scope.epoch++;const retired=f.render();assert.equal(retired.exportState.report,undefined);}
 if(reason==='validateFailure')final.reject(Error('validation failed'));else final.resolve(outcome({valid:true}));await work;assert.equal(f.downloads.length,0);assert.ok(f.requests.some(r=>r.init.method==='DELETE'&&r.path.includes('e'.repeat(43))));
 if(reason==='auth'||reason==='navigation')assert.equal(f.render().exportState.message,'');else assert.match(f.render().exportState.message,/cancelled|validation failed/);f.retire();
});

test('failed refinement retains a labelled old report and requires refresh instead of continuing old cut',async()=>{
 const f=mount();let h=await opened(f);h.refine({...h.complete.query,filters:{model:'selected'}});f.render();f.tick();f.reads().at(-1).reject(Error('Refresh required (410)'));await flush();h=f.render();assert.match(h.report.error,/Refresh required/);assert.equal(h.complete.report.value.query.filters.model,undefined);const count=f.reads().length;h.refine({...h.complete.query,groupBy:'provider'});f.render();f.tick();assert.equal(f.reads().length,count);h.reload();f.render();f.tick();assert.equal(new URL(f.reads().at(-1).path,'https://console.example').searchParams.has('cut'),false);f.retire();
});
test('preset preserves draft exact filters/timezone, typed session key survives grouping; widening opens fresh base',async()=>{
 const f=mount();let h=await opened(f);assert.equal(h.query.rollingDays,7);h.choosePreset(30,{...h.query,timezone:'Pacific/Auckland',filters:{...h.query.filters,model:'draft + exact',lane:'api'}});f.render();f.tick();let p=new URL(f.reads().at(-1).path,'https://console.example').searchParams;assert.equal(p.get('days'),'30');assert.equal(p.has('from'),false);assert.equal(p.has('cut'),false);assert.equal(p.get('model'),'draft + exact');assert.equal(p.get('timezone'),'Pacific/Auckland');
 const v=report({query:{...report().query,filters:{user:'alice@example.com',key:{kind:'session'}}}});f.reads().at(-1).resolve(outcome(v));await flush();h=f.render();h.setQuery({...h.query,groupBy:'provider'});f.render();f.tick();p=new URL(f.reads().at(-1).path,'https://console.example').searchParams;assert.equal(p.get('keyKind'),'session');assert.equal(p.has('key'),false);assert.equal(p.get('cut'),v.cut);f.reads().at(-1).resolve(outcome({...v,query:{...v.query,groupBy:'provider'}}));await flush();h=f.render();h.refine({...h.complete.query,filters:{}});f.render();f.tick();assert.equal(new URL(f.reads().at(-1).path,'https://console.example').searchParams.has('cut'),false);f.retire();
});
test('outside-retention response preserves custom controls and can recover with a new valid custom range',async()=>{
 const f=mount();let h=await opened(f);const from=new Date(now-30*86400000).toISOString(),to=new Date(now-29*86400000).toISOString();h.setQuery({...h.query,rollingDays:undefined,from,to});f.render();f.tick();f.reads().at(-1).resolve({kind:'outside_retained_range'});await flush();h=f.render();assert.equal(h.report.value,undefined);assert.equal(h.query.from,from);assert.equal(h.query.to,to);h.setQuery({...h.query,from:new Date(now-60000).toISOString(),to:new Date(now).toISOString()});f.render();f.tick();const p=new URL(f.reads().at(-1).path,'https://console.example').searchParams;assert.equal(p.get('from'),new Date(now-60000).toISOString());assert.equal(p.has('cut'),false);f.retire();
});

// Calendar regressions exercise the shipped hook, not a mirror of its parser.
for (const from of ['2026-02-30T00:00:00Z','2026-04-31T01:00:00+05:45','2025-02-29','2026-02-28T24:00:00Z']) test('custom input rejects calendar normalization: '+from,async()=>{
 const f=mount();try{const h=await opened(f),before=f.reads().length;
  h.setQuery({...h.query,rollingDays:undefined,from,to:'2026-05-01T00:00:00Z'});f.render();f.tick();
  assert.equal(f.reads().length,before,'invalid original input must not dispatch a normalized report');
  const invalid=f.render();assert.match(invalid.report.error,/calendar|RFC3339|range/i);assert.equal(invalid.report.value,undefined);
  await invalid.startExport('json');assert.equal(f.reads().length,before);assert.equal(f.downloads.length,0);
 }finally{f.retire();}
});
test('date-only input resolves chosen timezone and custom controls preserve the original selection',async()=>{
 const f=mount();try{let h=await opened(f);h.setQuery({...h.query,rollingDays:undefined,from:'2024-02-29',to:'2024-03-01',timezone:'Asia/Kathmandu'});f.render();f.tick();
  const read=f.reads().at(-1),p=new URL(read.path,'https://console.example').searchParams;
  assert.equal(p.get('from'),'2024-02-28T18:15:00.000Z');assert.equal(p.get('to'),'2024-02-29T18:15:00.000Z');
  const query={...report().query,from:Date.parse(p.get('from')),to:Date.parse(p.get('to')),timezone:'Asia/Kathmandu'};
  read.resolve(outcome(report({query})));await flush();h=f.render();assert.equal(h.query.from,'2024-02-29');assert.equal(h.query.to,'2024-03-01');
  h.setQuery({...h.query,groupBy:'provider'});f.render();f.tick();assert.match(f.reads().at(-1).path,/cut=a{43}/);
 }finally{f.retire();}
});
for(const audience of ['personal','admin'])test(audience+' clipped controls and refreshed export keep original selected bounds',async()=>{
 const f=mount({audience});try{let h=await opened(f);const selected={...report().query,from:now-2*3600000};
  if(audience==='personal')h.setQuery({...h.query,rollingDays:undefined,from:new Date(selected.from).toISOString(),to:new Date(selected.to).toISOString()});else h.newRange(selected);
  f.render();f.tick();const clipped=report({query:{...selected,from:now-3600000},coverage:{...report().coverage,clippedFrom:selected.from,effectiveFrom:now-3600000}});
  f.reads().at(-1).resolve(outcome(clipped));await flush();h=f.render();
  if(audience==='personal')assert.equal(h.query.from,new Date(selected.from).toISOString());
  h.showEvents(true);f.render();let request=f.reads().at(-1);assert.equal(new URL(request.path,'https://console.example').searchParams.get('from'),new Date(clipped.query.from).toISOString());request.resolve(outcome({events:[],nextCursor:null}));await flush();h=f.render();
  const work=h.startExport('json');request=f.reads().at(-1);assert.equal(new URL(request.path,'https://console.example').searchParams.get('from'),new Date(selected.from).toISOString());
  const fresh={...clipped,cut:'e'.repeat(43)};request.resolve(outcome(fresh));await flush();request=f.reads().at(-1);
  assert.match(request.path,/events/);assert.equal(new URL(request.path,'https://console.example').searchParams.get('from'),new Date(clipped.query.from).toISOString());
  request.resolve(outcome({events:[],nextCursor:null,coverage:fresh.coverage}));await flush();request=f.reads().at(-1);assert.match(request.path,/validate/);assert.equal(f.downloads.length,0);
  request.resolve(outcome({valid:true}));await work;assert.equal(f.downloads.length,1);
  const metadata=JSON.parse(f.downloads[0].content).metadata;assert.equal(metadata.range.from,clipped.query.from);assert.equal(metadata.coverage.clippedFrom,selected.from);assert.equal(f.render().selectedQuery.from,selected.from);
 }finally{f.retire();}
});

for(const audience of ['personal','admin'])test(audience+' clipped selection survives refinements, refresh, explicit new base and back',async()=>{
 const f=mount({audience});try{
  let h=await opened(f);const selected={...report().query,from:now-2*3600000},input={from:new Date(selected.from).toISOString(),to:new Date(selected.to).toISOString(),timezone:selected.timezone};
  h.customRange(selected,input,true);f.render();f.tick();
  const clipped=report({query:{...selected,from:now-3600000},coverage:{...report().coverage,clippedFrom:selected.from,effectiveFrom:now-3600000}});
  f.reads().at(-1).resolve(outcome(clipped));await flush();h=f.render();
  const refined={...clipped.query,groupBy:'provider'};h.refine(refined);f.render();f.tick();
  let request=f.reads().at(-1);assert.match(request.path,/cut=a{43}/);assert.equal(new URL(request.path,'https://console.example').searchParams.get('from'),new Date(clipped.query.from).toISOString());
  request.resolve(outcome({...clipped,query:refined}));await flush();h=f.render();assert.equal(h.selectedQuery.from,selected.from);
  h.reload();f.render();f.tick();request=f.reads().at(-1);let p=new URL(request.path,'https://console.example').searchParams;
  assert.equal(p.get('from'),input.from,'refresh must not replace selected start with retention floor');assert.equal(p.has('cut'),false);
  request.resolve(outcome({...clipped,query:refined}));await flush();h=f.render();
  h.customRange(refined,input,true);f.render();f.tick();request=f.reads().at(-1);p=new URL(request.path,'https://console.example').searchParams;
  assert.equal(p.get('from'),input.from,'explicit new base must use original selected bounds');assert.equal(p.has('cut'),false);
  request.resolve(outcome({...clipped,query:refined}));await flush();h=f.render();
  const narrowed={...refined,from:now-1800000};h.customRange(narrowed,{...input,from:new Date(narrowed.from).toISOString()});f.render();f.tick();
  request=f.reads().at(-1);assert.match(request.path,/cut=a{43}/);request.resolve(outcome({...clipped,query:narrowed}));await flush();h=f.render();assert.equal(h.selectedQuery.from,narrowed.from);
  h.back();f.render();f.tick();request=f.reads().at(-1);request.resolve(outcome({...clipped,query:refined}));await flush();h=f.render();
  assert.equal(h.selectedQuery.from,selected.from,'base restores the original requested interval, not its floor');assert.equal(h.rangeInput.from,input.from);
 }finally{f.retire();}
});
for(const audience of ['personal','admin'])test(audience+' clipped rolling selection stays absolute for filter-only refinement and export',async()=>{
 const f=mount({audience});try{const selectedFrom=now-2*3600000,clipped=report({coverage:{...report().coverage,clippedFrom:selectedFrom}});let h=await opened(f,clipped);
  h.refine({...clipped.query,filters:{...clipped.query.filters,model:'chosen'}});f.render();f.tick();f.reads().at(-1).resolve(outcome({...clipped,query:{...clipped.query,filters:{...clipped.query.filters,model:'chosen'}}}));await flush();h=f.render();
  assert.equal(h.selectedQuery.from,selectedFrom);const work=h.startExport('json'),request=f.reads().at(-1),p=new URL(request.path,'https://console.example').searchParams;
  assert.equal(p.get('from'),new Date(selectedFrom).toISOString());assert.equal(p.get('model'),'chosen');assert.equal(p.has('days'),false);assert.equal(p.has('cut'),false);
  request.reject(Error('stop after selected export boundary'));await work;
 }finally{f.retire();}
});

for(const audience of ['personal','admin'])test(audience+' invalid custom end is visible, cancels stale report, blocks export and recovers with explicit offsets',async()=>{
 const f=mount({audience});try{let h=await opened(f);h.preset(30);f.render();f.tick();const pending=f.reads().at(-1),before=f.reads().length;
  h=f.render();h.customRange(report().query,{from:'2024-02-29T10:15:00+05:45',to:'2024-02-30T12:00:00+05:45',timezone:'Asia/Kathmandu'});f.render();f.tick();
  assert.equal(pending.init.signal.aborted,true);pending.resolve(outcome(report({cut:'b'.repeat(43)})));await flush();h=f.render();
  assert.match(h.report.error,/calendar/);assert.equal(h.report.value,undefined);assert.equal(h.rangeInput.to,'2024-02-30T12:00:00+05:45');assert.equal(f.reads().length,before);
  await h.startExport('csv');assert.equal(f.reads().length,before);assert.equal(f.downloads.length,0);assert.ok(f.requests.some(r=>r.init.method==='DELETE'&&r.path.includes('b'.repeat(43))));
  h.customRange(report().query,{from:'2024-02-29T10:15:00.123456789+05:45',to:'2024-02-29T01:00:00-04:00',timezone:'America/New_York'});f.render();f.tick();
  const r=f.reads().at(-1),p=new URL(r.path,'https://console.example').searchParams;
  assert.equal(p.get('from'),'2024-02-29T04:30:00.123Z');assert.equal(p.get('to'),'2024-02-29T05:00:00.000Z');assert.equal(p.get('timezone'),'America/New_York');assert.equal(p.has('cut'),false);
  r.resolve(outcome(report({query:{...report().query,from:Date.parse(p.get('from')),to:Date.parse(p.get('to')),timezone:'America/New_York'}})));await flush();h=f.render();assert.equal(h.report.error,'');assert.ok(h.report.value);
 }finally{f.retire();}
});
test('invalid custom input cancels an in-flight export instead of downloading stale selection',async()=>{
 const f=mount();try{let h=await opened(f);const work=h.startExport('json'),r=f.reads().at(-1);
  h.setQuery({...h.query,from:'2026-02-30',to:'2026-03-01'});f.render();assert.equal(r.init.signal.aborted,true);
  r.resolve(outcome(report({cut:'e'.repeat(43)})));await work;assert.equal(f.downloads.length,0);assert.match(f.render().report.error,/calendar/);assert.ok(f.requests.some(r=>r.init.method==='DELETE'&&r.path.includes('e'.repeat(43))));
 }finally{f.retire();}
});

test('clear filters cannot bypass invalid input and preserves a clipped original interval on widening',async()=>{
 const f=mount();try{const filtered={...report().query,filters:{model:'base-filter'}};let h=await opened(f,report({query:filtered}));
  h.setQuery({...h.query,from:'2026-02-30',to:'2026-03-01'});h=f.render();const before=f.reads().length;h.clearFilters();f.render();f.tick();h=f.render();
  assert.equal(f.reads().length,before);assert.match(h.report.error,/calendar/);assert.equal(h.query.from,'2026-02-30');
  const input={from:new Date(now-2*3600000).toISOString(),to:new Date(now).toISOString(),timezone:filtered.timezone};h.customRange(filtered,input,true);f.render();f.tick();
  const clipped=report({query:filtered,coverage:{...report().coverage,clippedFrom:now-2*3600000}});f.reads().at(-1).resolve(outcome(clipped));await flush();h=f.render();h.clearFilters();f.render();f.tick();
  const p=new URL(f.reads().at(-1).path,'https://console.example').searchParams;assert.equal(p.get('from'),input.from);assert.equal(p.has('model'),false);assert.equal(p.has('cut'),false);
 }finally{f.retire();}
});
