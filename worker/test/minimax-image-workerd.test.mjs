import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { imageBody, imageResult, imageModel } from "./minimax-image-runtime-fixture.mjs";
const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {inspectGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {BodyLease,bodyBudgetCharged} from './worker/body-budget.ts';
import {usageStub} from './worker/ledgers.ts';
import {configureImage,imageModel} from './worker/test/minimax-image-runtime-fixture.mjs';
configureImage(snapshot.providers.find(p=>p.id==='minimax'));
let initialized,fetches=0,pending=new Set(),mode='',capacityAtFetch=0,readStarted=0,canceled=0,activeReads=0,aborted=false;
let currentController,contention;
const original=globalThis.fetch.bind(globalThis);
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init);fetches++;capacityAtFetch=bodyBudgetCharged();
 if(request.url!=='https://api.minimax.io/v1/image_generation')throw new Error('unexpected fixture destination');
 const reply=await original(request);
 if(mode!=='cancel')return reply;
 // Controlled Worker request signal, not a claim about host TCP disconnect.
 const reader=reply.body.getReader();let first=true,cleanup;
 const retire=reason=>cleanup??=(async()=>{try{await reader.cancel(reason);}finally{reader.releaseLock();if(activeReads){activeReads--;canceled++;}}})();
 const body=new ReadableStream({async pull(controller){
   if(first){first=false;const chunk=await reader.read();controller.enqueue(chunk.value);readStarted++;activeReads++;
     setTimeout(()=>currentController.abort(new DOMException('fixture cancellation','AbortError')),20);
     return;
   }
   if(!request.signal.aborted)await new Promise(resolve=>request.signal.addEventListener('abort',resolve,{once:true}));
   aborted=request.signal.aborted;
   await retire(request.signal.reason);controller.error(request.signal.reason);
 },async cancel(reason){aborted=request.signal.aborted;await retire(reason);}},{highWaterMark:0});
 return new Response(body,{headers:reply.headers,status:reply.status});
};
export default {async fetch(request,bindings,context){
 const env={...bindings,MINIMAX_API_KEY:'synthetic-forbidden-environment-key'};
 env.CLAWROUTER_ADMIN_TOKEN_SHA256=await sha256Hex('synthetic-admin');
 initialized??=(async()=>{
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['minimax'],models:[imageModel],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false,grantRouting:{eligibleGrants:{minimax:['image']},environmentFallback:true,failover:true}}}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env,'/connections/initialize-all',[{providerId:'minimax',enabled:true,monthlyBudgetMicros:10000}]);
 })();await initialized;
 const path=new URL(request.url).pathname;
 if(path==='/fixture/proof'){const grant=await inspectGrantCredentials(env,'oauth/fixture/image');return Response.json({fetches,pending:pending.size,capacity:bodyBudgetCharged(),capacityAtFetch,generation:grant.credentialGeneration,lineage:grant.credentialLineage,enabled:grant.enabled,binding:grant.minimaxImageBinding,readStarted,canceled,activeReads,aborted});}
 if(path==='/fixture/events')return usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin');
 if(path.startsWith('/fixture/mode/')){mode=path.split('/').at(-1);if(mode==='contention'){contention=new BodyLease();if(!contention.grow(17*1024*1024))throw new Error('fixture capacity');}else if(contention){contention.release();contention=undefined;}return new Response(null,{status:204});}
 if(path==='/fixture/unprice'){await authorityCall(env,'/policies/put',{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['minimax'],models:[imageModel],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:null,retainRequestContent:false,grantRouting:{eligibleGrants:{minimax:['image']}}}});return new Response(null,{status:204});}
 const ledger=env.BUDGET_LEDGER;
 env.BUDGET_LEDGER={idFromName:name=>ledger.idFromName(name),get:id=>{const stub=ledger.get(id);return {async fetch(url,init){const reply=await stub.fetch(url,init);if(new URL(url).pathname==='/dispatch'&&mode==='revoke'){mode='';await revokeGrantCredentials(env,'oauth/fixture/image');}return reply;}};}};
 currentController=new AbortController();
 return worker.fetch(new Request(request,{signal:currentController.signal}),env,{waitUntil(p){const tracked=Promise.resolve(p).finally(()=>pending.delete(tracked));pending.add(tracked);context.waitUntil(tracked);}});
},queue:worker.queue};`;
const upstream = `export default {async fetch(request){
 const body=await request.json();
 if(request.method!=='POST'||request.redirect!=='manual'||request.headers.get('authorization')!=='Bearer synthetic-image-key'||request.headers.has('x-api-key')||body.model!=='image-01'||body.response_format!=='base64')return new Response(null,{status:400});
 return Response.json(${JSON.stringify(imageResult())});
}};`;
async function fixture(t) {
  const temporary=await mkdtemp(join(tmpdir(),'minimax-image-workerd-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
  const runtime=await startWorkerdFixture(temporary,router,upstream,{preventEviction:true});t.after(()=>runtime.dispose());
  const origin='https://router.example';
  const get=async path=>{const r=await runtime.dispatchFetch(origin+path);assert.equal(r.status,200,await r.clone().text());return r.json();};
  const admin=await runtime.dispatchFetch(origin+'/v1/admin/upstream-grants/policies/fixture/image',{method:'PUT',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify({provider:'minimax',kind:'api_key',enabled:true,credential:'synthetic-image-key',minimaxImageAuthorization:'minimax-global-image'})});
  const text=await admin.text();assert.equal(admin.status,200,text);assert.doesNotMatch(text,/synthetic-image-key/);
  const run=manifest=>runtime.dispatchFetch(origin+(manifest?'/v1/proxy/minimax/images':'/v1/native/minimax/v1/image_generation'),{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},body:JSON.stringify(manifest?{body:{...imageBody(),model:imageModel}}:imageBody())});
  const mode=value=>runtime.dispatchFetch(origin+'/fixture/mode/'+value);
  const settled=async count=>{let proof,events;for(let i=0;i<100;i++){events=(await get('/fixture/events')).events;proof=await get('/fixture/proof');if(events.length===count&&proof.pending===0)break;await delay(20);}assert.equal(proof.pending,0);assert.equal(events.length,count);return {proof,events};};
  return {runtime,origin,get,run,mode,settled};
}
test('MiniMax image actual workerd native/manifest EOF and fresh original-owner revocation', {timeout:120000}, async t=>{
  const f=await fixture(t), admitted=await f.get('/fixture/proof');
  for(const manifest of [false,true]){const r=await f.run(manifest);assert.equal(r.status,200,await r.clone().text());assert.deepEqual(await r.json(),imageResult());}
  await f.mode('revoke');const r=await f.run(false);assert.notEqual(r.status,200);await r.text();
  const {proof,events}=await f.settled(3);assert.equal(proof.fetches,2);assert.equal(proof.capacityAtFetch,64*1024*1024);assert.equal(proof.capacity,0);
  assert.equal(proof.enabled,false);assert.equal(proof.binding,null);assert.ok(proof.generation>admitted.generation);assert.notEqual(proof.lineage,admitted.lineage);
  assert.deepEqual(events.map(e=>e.actual_cost_micros).sort((a,b)=>a-b),[0,700,700]);for(const e of events)assert.equal(e.total_tokens,null);
});
test('MiniMax image actual workerd capacity refusal, controlled pending-read cancellation and unknown USD', {timeout:120000}, async t=>{
  const f=await fixture(t);await f.mode('contention');let r=await f.run(false);assert.notEqual(r.status,200);await r.text();
  let proof=await f.get('/fixture/proof');assert.equal(proof.fetches,0);assert.equal(proof.capacity,34*1024*1024);
  await f.mode('cancel');r=await f.run(true);assert.notEqual(r.status,200);await r.text();
  let state=await f.settled(2);proof=state.proof;assert.equal(proof.fetches,1);assert.equal(proof.readStarted,1);assert.equal(proof.activeReads,0);assert.equal(proof.canceled,1);assert.equal(proof.capacity,0);assert.equal(proof.aborted,true);
  assert.deepEqual(state.events.map(e=>e.actual_cost_micros).sort((a,b)=>a-b),[0,700]);
  await f.runtime.dispatchFetch(f.origin+'/fixture/unprice');r=await f.run(false);assert.equal(r.status,402,await r.clone().text());await r.text();
  state=await f.settled(3);assert.equal(state.proof.fetches,1);assert.equal(state.proof.capacity,0);assert.equal(state.events.filter(e=>e.actual_cost_micros===700).length,1);
});
