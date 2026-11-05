import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

async function barriers(t) {
  const held = new Map(), released = new Set();
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.headers.authorization || !/^\/[a-z-]+\/(abort|read|cleanup|delivery)$/.test(request.url)) { response.writeHead(400); response.end(); return; }
    if (released.has(request.url)) response.end("released"); else held.set(request.url, response);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: "http://127.0.0.1:" + server.address().port,
    release(mode, phase) { const key = "/" + mode + "/" + phase; released.add(key); held.get(key)?.end("released"); held.delete(key); } };
}
const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {inspectGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {BodyLease,bodyBudgetCharged} from './worker/body-budget.ts';
import {usageStub} from './worker/ledgers.ts';
import {configureMusic,musicBody,musicModels} from './worker/test/minimax-music-runtime-fixture.mjs';
configureMusic(snapshot.providers.find(p=>p.id==='minimax'));
const original=globalThis.fetch.bind(globalThis),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
let initialized,active,pending=new Set();
const state=()=>active?{mode:active.mode,status:active.status,error:active.error,results:active.results,fetches:active.fetches,
 reads:active.reads,byob:active.byob,detached:active.detached,maxBacking:active.maxBacking,wire:active.wire,eof:active.eof,
 cancels:active.cancels,cleanup:active.cleanup,readRetired:active.readRetired,locked:active.source?.locked??false,
 charged:bodyBudgetCharged(),atFetch:active.atFetch,outputBytes:active.outputBytes,pending:pending.size,callerAborted:active.callerAborted,requestId:active.requestId}:{};
const gate=(a,phase)=>original('https://music-gate.example/'+a.mode+'/'+phase,{redirect:'manual'}).then(async r=>{if(!r.ok)throw new Error('fixture gate');await r.text();});
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init),a=active;
 if(request.url!=='https://api.minimax.io/v1/music_generation')throw new Error('unexpected fixture destination');
 a.fetches++;a.atFetch=bodyBudgetCharged();const response=await original(request);a.source=response.body;
 // Instrument the ACTUAL DO-returned body without replacing it or changing its
 // byte-stream capability. A returned backing is never the audio accumulator.
 const getReader=response.body.getReader.bind(response.body);
 response.body.getReader=options=>{
  const reader=getReader(options);if(options?.mode==='byob')a.byob++;
  let first=true,cancellation;
  return {async read(...args){a.reads++;try{
   const part=await reader.read(...args);if(args[0]?.buffer.byteLength===0)a.detached++;
   if(part.value){a.wire+=part.value.byteLength;a.maxBacking=Math.max(a.maxBacking,part.value.buffer.byteLength);}
   if(part.done)a.eof=true;return part;
  }finally{if(first&&a.mode==='held-input'){first=false;a.ready.resolve();await gate(a,'read');a.readRetired=true;}}},
  cancel(reason){return cancellation??=(async()=>{a.cancels++;try{await reader.cancel(reason);}finally{if(a.mode==='held-input')await gate(a,'cleanup');a.cleanup=true;}})();},
  releaseLock(){reader.releaseLock();}};
 };
 return response;
};
export default {async fetch(request,bindings,context){
 const env={...bindings,MINIMAX_API_KEY:'synthetic-forbidden-environment-key'};
 env.CLAWROUTER_ADMIN_TOKEN_SHA256=await sha256Hex('synthetic-admin');
 const policy={enabled:true,generation:'g1',providers:['minimax'],models:musicModels,tenantId:'fixture',monthlyBudgetMicros:100000,
  requestCostMicros:700,retainRequestContent:false,grantRouting:{eligibleGrants:{minimax:['music']},environmentFallback:true,failover:true}};
 initialized??=(async()=>{
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env,'/connections/initialize-all',[{providerId:'minimax',enabled:true,monthlyBudgetMicros:100000}]);
 })();await initialized;
 const url=new URL(request.url);
 if(url.pathname==='/state')return Response.json(state());
 if(url.pathname==='/events')return usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin');
 if(url.pathname==='/contend'){const lease=new BodyLease(),allowed=lease.grow(17*1024*1024);lease.release();return Response.json({allowed,charged:bodyBudgetCharged()});}
 if(url.pathname!=='/start')return worker.fetch(request,env,context);
 const mode=url.searchParams.get('mode'),a=active={mode,ready:deferred(),status:null,error:null,results:0,fetches:0,reads:0,byob:0,detached:0,maxBacking:0,wire:0,eof:false,cancels:0,cleanup:false,readRetired:false,outputBytes:0};
 if(mode==='unpriced')await authorityCall(env,'/policies/put',{policyId:'fixture',policy:{...policy,requestCostMicros:null}});
 const ledger=env.BUDGET_LEDGER;env.BUDGET_LEDGER={idFromName:n=>ledger.idFromName(n),get:id=>{const stub=ledger.get(id);return {async fetch(input,init){
  const r=await stub.fetch(input,init);if(new URL(input).pathname==='/dispatch'&&mode==='revoke')await revokeGrantCredentials(env,'oauth/fixture/music');return r;
 }}}};
 const controller=new AbortController(),stream=mode!=='unary',manifest=mode==='manifest',body=musicBody(stream,manifest?'music-2.6-free':'music-2.6');
 body.prompt=mode==='maximum'?'maximum':'Synthetic music';
 const track=p=>{const held=Promise.resolve(p).finally(()=>pending.delete(held));pending.add(held);context.waitUntil(held);};
 if(mode==='held-input')track(a.ready.promise.then(()=>gate(a,'abort')).then(()=>{controller.abort(new DOMException('controlled fixture abort','AbortError'));a.callerAborted=controller.signal.aborted;}));
 track((async()=>{
  const response=await worker.fetch(new Request('https://router.example'+(manifest?'/v1/proxy/minimax/music':'/v1/native/minimax/v1/music_generation'),{
   method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},
   body:JSON.stringify(manifest?{body:{...body,model:'minimax/music-2.6-free'}}:body),signal:controller.signal}),env,{waitUntil:track});
  a.status=response.status;a.requestId=response.headers.get('x-clawrouter-request-id');
  if(!response.ok){const text=await response.text();try{a.error=JSON.parse(text).error?.code??null;}catch{}return;}
  const reader=response.body.getReader();let first=true;
  try{for(;;){const part=await reader.read();if(part.done)break;a.outputBytes+=part.value.byteLength;
   if(first&&(mode==='delivery-eof'||mode==='delivery-cancel')){first=false;a.ready.resolve();await gate(a,'delivery');if(mode==='delivery-cancel'){await reader.cancel();break;}}
  }}finally{reader.releaseLock();}
 })().catch(error=>{a.error=error.name;}).finally(()=>{a.results++;a.ready.resolve();}));
 await a.ready.promise;return Response.json(state());
},queue:worker.queue};`;
function upstream(origin) { return String.raw`
const encoder=new TextEncoder(),maxAudio=8*1024*1024,maxWire=40*1024*1024+65536;
export class MusicSource {async fetch(request){
 const body=await request.json();
 if(request.method!=='POST'||request.headers.get('authorization')!=='Bearer synthetic-music-key'||request.headers.has('x-api-key')||!['music-2.6','music-2.6-free'].includes(body.model))return new Response(null,{status:400});
 if(!body.stream)return Response.json({model:body.model,base_resp:{status_code:0},data:{status:2,audio:'00ff80'},extra_info:{music_size:3,music_sample_rate:44100,bitrate:256000}});
 const full=body.prompt==='maximum';let wire=0;
 function* chunks(){
  const head=status=>'data: {"model":'+JSON.stringify(body.model)+',"base_resp":{"status_code":0},"data":{"status":'+status+',"audio":"';
  if(full){
   for(const status of [1,2]){yield head(status);for(let i=0;i<maxAudio*2;i+=16384)yield '0'.repeat(16384);yield '"}}\n\n';}
   // Fill the operational envelope exactly using independently bounded comments.
   let remaining=maxWire-wire-'data: [DONE]\n\n'.length;
   while(remaining){const size=Math.min(16000,remaining);if(size<3)throw new Error('fixture padding');yield ':'+' '.repeat(size-3)+'\n\n';remaining-=size;}
  }else{yield head(2);yield '00';yield 'ff80';yield '"}}\n\n';}
  yield 'data: [DONE]\n\n';
 }
 const iterator=chunks();return new Response(new ReadableStream({type:'bytes',pull(c){const next=iterator.next();if(next.done){c.close();c.byobRequest?.respond(0);return;}const bytes=encoder.encode(next.value);wire+=bytes.length;c.enqueue(bytes);},cancel(){iterator.return();}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream','content-encoding':'identity'}});
}}
export default {async fetch(request,env){const url=new URL(request.url);
 if(url.hostname==='music-gate.example')return fetch(BARRIER_ORIGIN+url.pathname,{redirect:'manual'});
 if(url.href!=='https://api.minimax.io/v1/music_generation')throw new Error('unexpected fixture destination');
 return env.MUSIC_SOURCE.get(env.MUSIC_SOURCE.idFromName('synthetic')).fetch(request);
}};`.replace('BARRIER_ORIGIN',JSON.stringify(origin)); }

test("MiniMax music registered workerd DO body, both routes, exact maximum, retirement and fresh authority", { timeout: 120000 }, async t => {
  const temporary=await mkdtemp(join(tmpdir(),"minimax-music-workerd-"));t.after(()=>rm(temporary,{recursive:true,force:true}));
  const controls=await barriers(t),runtime=await startWorkerdFixture(temporary,router,upstream(controls.origin),{
    preventEviction:true,upstreamDurableObjects:{MUSIC_SOURCE:{className:"MusicSource",useSQLite:true}}});
  t.after(async()=>{for(const mode of ['held-input','delivery-eof','delivery-cancel'])for(const phase of ['abort','read','cleanup','delivery'])controls.release(mode,phase);await runtime.dispose();});
  const call=async path=>{const r=await runtime.dispatchFetch('https://router.example'+path);assert.equal(r.status,200,await r.clone().text());return r.json();};
  const until=async predicate=>{let s;for(let i=0;i<200;i++){s=await call('/state');if(predicate(s))return s;await delay(10);}assert.fail(JSON.stringify(s));};
  const put=async(replace=false)=>{const r=await runtime.dispatchFetch('https://router.example/v1/admin/upstream-grants/policies/fixture/music'+(replace?'?mode=replace':''),{
    method:'PUT',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify({provider:'minimax',kind:'api_key',enabled:true,credential:'synthetic-music-key',nativeMediaAuthorization:'minimax-global-music'})});
    assert.equal(r.status,200,await r.clone().text());assert.doesNotMatch(await r.text(),/synthetic-music-key/);};
  await put();let events=0,abortedRequestId;
  for(const mode of ['unary','manifest','maximum','held-input','delivery-eof','delivery-cancel','revoke','unpriced']){
    if(mode==='unpriced')await put(true); // Explicitly replace the preceding revoked owner.
    let s=await call('/start?mode='+mode);
    if(mode==='held-input'){
      assert.equal(s.reads,1,JSON.stringify(s));controls.release(mode,'abort');s=await until(s=>s.results===1&&s.cancels===1);
      // A dispatched native-body failure keeps the existing HTTP 502 envelope;
      // the original caller cause is independently preserved in accounting.
      assert.equal(s.status,502,JSON.stringify(s));assert.equal(s.error,'provider_unavailable');assert.equal(s.callerAborted,true);
      abortedRequestId=s.requestId;assert.ok(abortedRequestId);assert.equal(s.locked,true);assert.equal(s.charged,64*1024*1024);
      assert.deepEqual(await call('/contend'),{allowed:false,charged:64*1024*1024});
      controls.release(mode,'cleanup');s=await until(s=>s.cleanup);assert.equal(s.charged,64*1024*1024);assert.equal(s.locked,true);
      controls.release(mode,'read');
    }else if(mode.startsWith('delivery-')){
      assert.equal(s.status,200,JSON.stringify(s));assert.equal(s.eof,true);assert.equal(s.locked,false);
      assert.equal(s.charged,64*1024*1024);assert.deepEqual(await call('/contend'),{allowed:false,charged:64*1024*1024});controls.release(mode,'delivery');
    }
    s=await until(s=>s.results===1&&s.pending===0);assert.equal(s.charged,0,JSON.stringify(s));assert.equal(s.locked,false);
    assert.equal(s.fetches,mode==='revoke'||mode==='unpriced'?0:1,JSON.stringify(s));
    if(!['held-input','revoke','unpriced'].includes(mode)){assert.equal(s.status,200,JSON.stringify(s));assert.equal(s.atFetch,64*1024*1024);}
    if(!['unary','revoke','unpriced'].includes(mode)){assert.ok(s.byob>0,JSON.stringify(s));assert.ok(s.detached>0,JSON.stringify(s));assert.ok(s.maxBacking<=65536,JSON.stringify(s));}
    if(mode==='maximum'){assert.equal(s.wire,40*1024*1024+65536,JSON.stringify(s));assert.ok(s.outputBytes>16*1024*1024);}
    if(mode==='unpriced'){assert.equal(s.status,400,JSON.stringify(s));assert.equal(s.error,'pricing_required');}
    events++;
  }
  const rows=(await call('/events')).events;assert.equal(rows.length,events);assert.equal(rows.filter(e=>e.actual_cost_micros===700).length,6);
  assert.equal(rows.filter(e=>e.actual_cost_micros===0).length,2);assert.ok(rows.every(e=>e.total_tokens===null));
  const canceled=rows.filter(e=>e.request_id===abortedRequestId);assert.equal(canceled.length,1);
  assert.equal(canceled[0].status,'client_error');assert.equal(canceled[0].actual_cost_micros,700);
});
