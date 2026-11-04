import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

// A real I/O gate keeps each continuation in its original Worker request.
// Resolving a stored promise from a later request can cancel that continuation.
async function networkBarriers(t) {
  const pending = new Map(), released = new Set(), counts = new Map();
  const server = createServer((request, response) => {
    const key = request.url;
    if (request.method !== "GET" || request.headers.authorization ||
        !/^\/(native|google|header|delivery|downstream|inspection)\/(cancel|cleanup|inspection)$/.test(key)) {
      response.writeHead(400); response.end(); return;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.get(key) !== 1) { response.writeHead(409); response.end(); return; }
    if (released.has(key)) response.end("released");
    else pending.set(key, response);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`,
    release(mode, phase) { const key = `/${mode}/${phase}`; released.add(key); pending.get(key)?.end("released"); pending.delete(key); },
    count(mode, phase) { return counts.get(`/${mode}/${phase}`) ?? 0; } };
}

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
 result:active.result,charged:bodyBudgetCharged(),lateEnqueues:active.lateEnqueues,cancelSettled:active.cancelSettled,inspectionStarted:active.inspectionStarted,inspectionFinished:active.inspectionFinished}:{};
export default {async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.pathname==='/state')return Response.json(state());
 if(url.pathname==='/contend'){const other=new BodyLease();const allowed=other.grow(17*1024*1024);other.release();return Response.json({allowed,charged:bodyBudgetCharged()});}
 if(url.pathname!=='/start'||active&&active.releases!==1)return new Response(null,{status:409});
 const mode=url.searchParams.get('mode');
 const lease=new BodyLease();if(!lease.grow(32*1024*1024))throw new Error('fixture capacity');
 const upstream=await fetch('https://retirement-upstream.example/data',{redirect:'manual'});
 const physical=upstream.body,reader=physical.getReader(),ready=deferred();
 const gate=phase=>fetch('https://retirement-upstream.example/gate/'+mode+'/'+phase,{redirect:'manual'}).then(response=>{if(!response.ok)throw new Error('fixture barrier');return response.text();});
 const a={mode,fetches:1,cancels:0,cleanup:false,readStarted:0,results:0,releases:0,result:null,lateEnqueues:0,cancelSettled:false,physical,inspectionReady:deferred(),inspectionStarted:false,inspectionFinished:false,abort:new AbortController()};
 let first=true,stopped=false,cancellation;
 const cancel=reason=>cancellation??=(async()=>{stopped=true;a.cancels++;await reader.cancel(reason);ready.resolve();await gate('cleanup');reader.releaseLock();a.cleanup=true;})();
 a.source=new ReadableStream({async pull(c){
   if(first){first=false;const part=await reader.read();a.readStarted++;if(stopped){a.lateEnqueues++;return;}c.enqueue(part.value);ready.resolve();return;}
   // The controlled Worker signal owns this deliberately held input. This is
   // not a physical host-disconnect or provider entitlement claim.
 },cancel},{highWaterMark:0});active=a;
 ctx.waitUntil(gate('cancel').then(()=>a.mode==='downstream'
   ? a.output.cancel('synthetic downstream cancel') : a.abort.abort(new Error('synthetic cancellation'))).then(()=>{a.cancelSettled=true;}));
 const operation=new HttpOperation(a.abort.signal);
 const response=new Response(a.source,{headers:{'content-type':mode==='header'?'text/plain':'application/json'}});
 let retirement;
 if(mode==='delivery'||mode==='downstream'||mode==='inspection'){
   const inspect=mode==='inspection'?{async push(){a.inspectionStarted=true;a.inspectionReady.resolve();await gate('inspection');a.inspectionFinished=true;},async end(){}}:undefined;
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
const upstream = origin => `export default {fetch(request){
 const url=new URL(request.url);
 if(url.origin!=='https://retirement-upstream.example'||request.method!=='GET'||url.search||request.headers.has('authorization'))throw new Error('unexpected fixture URL');
 if(url.pathname.startsWith('/gate/'))return fetch(${JSON.stringify(origin)}+url.pathname.slice(5),{signal:request.signal,redirect:'manual'});
 if(url.pathname!=='/data')throw new Error('unexpected fixture path');
 return new Response('{"held":',{headers:{'content-type':'application/json'}});
}};`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "input-retirement-workerd-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const barriers = await networkBarriers(t);
  const runtime = await startWorkerdFixture(directory, router, upstream(barriers.origin), { preventEviction: true }); t.after(() => runtime.dispose());
  const call = async path => { const response = await runtime.dispatchFetch("https://router.example" + path); assert.ok(response.ok, await response.clone().text()); return response.status === 204 ? null : response.json(); };
  const until = async predicate => { let value; for (let i=0;i<100;i++) { value=await call('/state'); if(predicate(value))return value; await delay(10); } assert.fail(JSON.stringify(value)); };
  return {call,until,barriers};
}
for (const modes of [["native","google","header"],["delivery","downstream","inspection"]]) test(`actual workerd held input cleanup: ${modes.join('/')}`, { timeout:120000 }, async t => {
  const f=await fixture(t);
  for(const mode of modes){
    let state=await f.call('/start?mode='+mode);assert.equal(state.fetches,1);assert.equal(state.charged,64*1024*1024);assert.equal(state.readStarted,mode==='header'?0:1);
    f.barriers.release(mode,'cancel');state=await f.until(s=>s.results===1&&s.cancels===1&&s.cancelSettled);
    assert.equal(state.releases,0);assert.equal(state.cleanup,false);assert.equal(state.sourceLocked,true);assert.equal(state.physicalLocked,true);
    assert.deepEqual(await f.call('/contend'),{allowed:false,charged:64*1024*1024});
    f.barriers.release(mode,'cleanup');
    if(mode==='inspection'){
      state=await f.until(s=>s.cleanup&&s.sourceLocked===false);
      assert.equal(state.releases,0);assert.equal(state.charged,64*1024*1024);assert.equal(state.inspectionStarted,true);assert.equal(state.inspectionFinished,false);
      f.barriers.release(mode,'inspection');
    }
    state=await f.until(s=>s.releases===1);
    assert.equal(state.charged,0);assert.equal(state.cleanup,true);assert.equal(state.sourceLocked,false);assert.equal(state.physicalLocked,false);
    assert.equal(state.cancels,1);assert.equal(state.results,1);assert.equal(state.lateEnqueues,0);
    assert.equal(f.barriers.count(mode,'cancel'),1);assert.equal(f.barriers.count(mode,'cleanup'),1);
    assert.equal(f.barriers.count(mode,'inspection'),mode==='inspection'?1:0);
  }
});
