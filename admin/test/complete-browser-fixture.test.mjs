import test from 'node:test';
import assert from 'node:assert/strict';
import {cursorUsageFixture} from './helpers/personal-usage-cursor.mjs';
const {exportRefreshedUsage,completeQueryString}=await import('../src/complete-usage.ts');
const {completeDisplayOutcome}=await import('../browser/fixtures/complete-usage.ts');
const {fixtureReport}=await import('../browser/fixtures/personal-usage.ts');
test('browser display scenario exposes complete envelope without exhaustive-history assertions',()=>{
 const url=new URL('https://console.example/v1/session/usage/report?intent=browse');const o=completeDisplayOutcome(fixtureReport(),url);assert.equal(o.kind,'complete');assert.equal(o.value.coverage.historicalLocations,'not_exhaustively_assessed');assert.equal(o.value.metrics.calls,42);assert.equal('historyComplete' in o.value,false);
});
test('browser runtime fixture executes parser, stable 100-row paging, fresh export and final validation',async()=>{
 const f=await cursorUsageFixture();try{
  const r=await f.read('/v1/session/usage/report?intent=browse');assert.equal(r.kind,'complete');assert.equal(r.value.metrics.calls,142);
  const params=completeQueryString(r.value.query,'personal');params.set('cut',r.value.cut);params.set('limit','100');const first=await f.read('/v1/session/usage/events?'+params);assert.equal(first.kind,'complete');assert.equal(first.value.events.length,100);params.set('cursor',first.value.nextCursor);const second=await f.read('/v1/session/usage/events?'+params);assert.equal(second.value.events.length,42);assert.equal(second.value.nextCursor,null);
  await f.ingest('late');const file=await exportRefreshedUsage({request:async(_,path,init={})=>f.read(path,f.now,init.method??'GET'),origin:'https://console.example',audience:'personal',query:r.value.query,signal:new AbortController().signal,isCurrent:()=>true},'json');const result=JSON.parse(file.content);assert.equal(result.events.length,143);assert.equal(result.metadata.totals.metrics.calls,143);assert.equal(f.calls.at(-2).input.kind,'validate');assert.equal(f.calls.at(-1).input.kind,'release');
 }finally{f.close();}
});
