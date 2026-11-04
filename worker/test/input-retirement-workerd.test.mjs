import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {readNativeJson} from './worker/native-json.ts';
import {readGoogleJson} from './worker/google-json.ts';
import {observeUsage} from './worker/proxy-response.ts';
import {HttpOperation} from './worker/http-operation.ts';
import {BodyLease,bodyBudgetCharged} from './worker/body-budget.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
let active;
const state=()=>active?{mode:active.mode,fetches:active.fetches,cancels:active.cancels,cleanup:active.cleanup,readStarted:active.readStarted,
 sourceLocked:active.source.locked,physicalLocked:active.physical.locked,results:active.results,releases:active.releases,
 result:active.result,charged:bodyBudgetCharged(),lateEnqueues:active.lateEnqueues,inspectionStarted:active.inspectionStarted,inspectionFinished:active.inspectionFinished}:{};
export default {async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.pathname==='/state')return Response.json(state());
 if(url.pathname==='/cancel'){
   active.cancelRequest.resolve();
   return new Response(null,{status:204});
 }
 if(url.pathname==='/release'){active.ack.resolve();return new Response(null,{status:204});}
 if(url.pathname==='/inspection-release'){active.inspection.resolve();return new Response(null,{status:204});}
 if(url.pathname==='/contend'){const other=new BodyLease();const allowed=other.grow(17*1024*1024);other.release();return Response.json({allowed,charged:bodyBudgetCharged()});}
 if(url.pathname!=='/start'||active&&active.releases!==1)return new Response(null,{status:409});
 const mode=url.searchParams.get('mode');
 const lease=new BodyLease();if(!lease.grow(32*1024*1024))throw new Error('fixture capacity');
 const upstream=await fetch('https://retirement-upstream.example/data',{redirect:'manual'});
 const physical=upstream.body,reader=physical.getReader(),ack=deferred(),ready=deferred();
 const a={mode,fetches:1,cancels:0,cleanup:false,readStarted:0,results:0,releases:0,result:null,lateEnqueues:0,physical,ack,cancelRequest:deferred(),inspection:deferred(),inspectionReady:deferred(),inspectionStarted:false,inspectionFinished:false,abort:new AbortController()};
 let first=true,stopped=false,cancellation;
 const cancel=reason=>cancellation??=(async()=>{stopped=true;a.cancels++;await reader.cancel(reason);ready.resolve();await ack.promise;reader.releaseLock();a.cleanup=true;})();
 a.source=new ReadableStream({async pull(c){
   if(first){first=false;const part=await reader.read();a.readStarted++;if(stopped){a.lateEnqueues++;return;}c.enqueue(part.value);ready.resolve();return;}
   // The controlled Worker signal owns this deliberately held input. This is
   // not a physical host-disconnect or provider entitlement claim.
 },cancel},{highWaterMark:0});active=a;
 ctx.waitUntil(a.cancelRequest.promise.then(()=>a.mode==='downstream'
   ? a.output.cancel('synthetic downstream cancel') : a.abort.abort(new Error('synthetic cancellation'))));
 const operation=new HttpOperation(a.abort.signal);
 const response=new Response(a.source,{headers:{'content-type':mode==='header'?'text/plain':'application/json'}});
 let retirement;
 if(mode==='delivery'||mode==='downstream'||mode==='inspection'){
   const inspect=mode==='inspection'?{async push(){a.inspectionStarted=true;a.inspectionReady.resolve();await a.inspection.promise;a.inspectionFinished=true;},async end(){}}:undefined;
   const observed=observeUsage(response,operation,inspect);a.output=observed.response.body.getReader();
   const consume=(async()=>{try{while(!(await a.output.read()).done){}}catch{}finally{a.output.releaseLock();}})();
   ctx.waitUntil(consume);ctx.waitUntil(observed.result.then(r=>{a.result=r.delivery;a.results++;}));
   retirement=observed.retired;
 }else{
   const read=mode==='google'?readGoogleJson:readNativeJson;
   const pending=read(response,operation.signal,1024,()=>{throw new Error('unexpected completed JSON');},()=>{throw new Error('invalid fixture JSON');});
   ctx.waitUntil(operation.wait(pending).then(()=>{a.result='complete';a.results++;},()=>{a.result='failed';a.results++;}));
   retirement=pending.then(()=>undefined,()=>undefined);
 }
 ctx.waitUntil(retirement.then(()=>{lease.release();a.releases++;}));
 await ready.promise;if(mode==='inspection')await a.inspectionReady.promise;return Response.json(state());
}};`;
const upstream = `export default {fetch(request){if(request.url!=='https://retirement-upstream.example/data')throw new Error('unexpected fixture URL');return new Response('{"held":',{headers:{'content-type':'application/json'}});}};`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "input-retirement-workerd-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await startWorkerdFixture(directory, router, upstream, { preventEviction: true }); t.after(() => runtime.dispose());
  const call = async path => { const response = await runtime.dispatchFetch("https://router.example" + path); assert.ok(response.ok, await response.clone().text()); return response.status === 204 ? null : response.json(); };
  const until = async predicate => { let value; for (let i=0;i<100;i++) { value=await call('/state'); if(predicate(value))return value; await delay(10); } assert.fail(JSON.stringify(value)); };
  return {call,until};
}
for (const modes of [["native","google","header"],["delivery","downstream","inspection"]]) test(`actual workerd held input cleanup: ${modes.join('/')}`, { timeout:120000 }, async t => {
  const f=await fixture(t);
  for(const mode of modes){
    let state=await f.call('/start?mode='+mode);assert.equal(state.fetches,1);assert.equal(state.charged,64*1024*1024);assert.equal(state.readStarted,mode==='header'?0:1);
    await f.call('/cancel');state=await f.until(s=>s.results===1&&s.cancels===1);
    assert.equal(state.releases,0);assert.equal(state.cleanup,false);assert.equal(state.sourceLocked,true);assert.equal(state.physicalLocked,true);
    assert.deepEqual(await f.call('/contend'),{allowed:false,charged:64*1024*1024});
    await f.call('/release');
    if(mode==='inspection'){
      state=await f.until(s=>s.cleanup&&s.sourceLocked===false);
      assert.equal(state.releases,0);assert.equal(state.charged,64*1024*1024);assert.equal(state.inspectionStarted,true);assert.equal(state.inspectionFinished,false);
      await f.call('/inspection-release');
    }
    state=await f.until(s=>s.releases===1);
    assert.equal(state.charged,0);assert.equal(state.cleanup,true);assert.equal(state.sourceLocked,false);assert.equal(state.physicalLocked,false);
    assert.equal(state.cancels,1);assert.equal(state.results,1);assert.equal(state.lateEnqueues,0);
  }
});
