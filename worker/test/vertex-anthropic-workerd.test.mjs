import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { vertexAuthorization, vertexBody, vertexJson, vertexSse, vertexModelId } from "./vertex-runtime-fixture.mjs";
const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {inspectGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {usageStub} from './worker/ledgers.ts';
import {configureVertex,vertexModelId} from './worker/test/vertex-runtime-fixture.mjs';
const provider=structuredClone(snapshot.providers.find(p=>p.id==='anthropic'));configureVertex(provider);snapshot.providers.push(provider);
const key='oauth/fixture/vertex';let initialized,revokeAfterBudget=false,fetches=0,pending=new Set();
const original=globalThis.fetch.bind(globalThis);
globalThis.fetch=(input,init)=>{const request=new Request(input,init);fetches++;if(!request.url.startsWith('https://us-east5-aiplatform.googleapis.com/v1/projects/fixture-project/locations/us-east5/publishers/anthropic/models/'))throw new Error('unexpected fixture destination');return original(request);};
export default {async fetch(request,bindings,context){
 const env={...bindings};env.CLAWROUTER_ADMIN_TOKEN_SHA256=await sha256Hex('synthetic-admin');
 initialized??=(async()=>{
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['anthropic-vertex'],models:[vertexModelId],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false,grantRouting:{eligibleGrants:{'anthropic-vertex':['vertex']},environmentFallback:false}}}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env,'/connections/initialize-all',[{providerId:'anthropic-vertex',enabled:true,monthlyBudgetMicros:10000}]);
 })();await initialized;
 const path=new URL(request.url).pathname;
 if(path==='/fixture/proof'){const grant=await inspectGrantCredentials(env,key);return Response.json({fetches,pending:pending.size,capacity:bodyBudgetCharged(),generation:grant.credentialGeneration,lineage:grant.credentialLineage,enabled:grant.enabled,binding:grant.vertexAnthropicBinding,hasAccessToken:grant.hasAccessToken});}
 if(path==='/fixture/events')return usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin');
 if(path==='/fixture/revoke-after-budget'){revokeAfterBudget=true;return new Response(null,{status:204});}
 const ledger=env.BUDGET_LEDGER;
 env.BUDGET_LEDGER={idFromName:name=>ledger.idFromName(name),get:id=>{const stub=ledger.get(id);return {async fetch(url,init){const reply=await stub.fetch(url,init);if(new URL(url).pathname==='/dispatch'&&revokeAfterBudget){revokeAfterBudget=false;await revokeGrantCredentials(env,key);}return reply;}};}};
 return worker.fetch(request,env,{waitUntil(p){const tracked=Promise.resolve(p).finally(()=>pending.delete(tracked));pending.add(tracked);context.waitUntil(tracked);}});
},queue:worker.queue};`;
const upstream = `export default {async fetch(request){
 const body=await request.json();
 if(request.method!=='POST'||request.redirect!=='manual'||request.headers.get('authorization')!=='Bearer synthetic-vertex-access'||request.headers.has('x-api-key')||request.headers.has('anthropic-version')||body.model!==undefined||body.anthropic_version!=='vertex-2023-10-16')return new Response(null,{status:400});
 if(body.stream)return new Response(${JSON.stringify(vertexSse())},{headers:{'content-type':'text/event-stream'}});
 return Response.json(${JSON.stringify(vertexJson())});
}};`;
test("Vertex actual workerd admin/owner uses original resource and rejects post-budget revocation before fetch", { timeout: 120000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "vertex-owner-workerd-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const runtime = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true }); t.after(() => runtime.dispose());
  const origin = "https://router.example";
  const get = async path => { const response = await runtime.dispatchFetch(origin + path); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const admin = await runtime.dispatchFetch(origin + "/v1/admin/upstream-grants/policies/fixture/vertex", { method: "PUT", headers: { authorization: "Bearer synthetic-admin", "content-type": "application/json" }, body: JSON.stringify({ provider: "anthropic-vertex", kind: "oauth", tokenType: "Bearer", accessToken: "synthetic-vertex-access", expiresAt: new Date(Date.now() + 3600000).toISOString(), vertexAnthropicAuthorization: vertexAuthorization() }) });
  const adminText = await admin.text(); assert.equal(admin.status, 200, adminText); assert.doesNotMatch(adminText, /synthetic-vertex-access/);
  const admitted = await get("/fixture/proof"); assert.equal(admitted.hasAccessToken, true); assert.equal(admitted.fetches, 0);
  const run = (manifest, stream = false) => runtime.dispatchFetch(origin + (manifest ? "/v1/proxy/anthropic-vertex/messages" : "/v1/native/anthropic-vertex/v1/messages"), { method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json" }, body: JSON.stringify(manifest ? { body: { ...vertexBody(stream), model: vertexModelId } } : vertexBody(stream)) });
  for (const [manifest, stream] of [[false,false],[true,true]]) { const response=await run(manifest,stream);assert.equal(response.status,200,await response.clone().text());assert.equal(await response.text(),stream?vertexSse():JSON.stringify(vertexJson())); }
  await runtime.dispatchFetch(origin + "/fixture/revoke-after-budget");
  const denied = await run(false); const deniedText = await denied.text(); assert.notEqual(denied.status, 200, deniedText); assert.doesNotMatch(deniedText, /synthetic-vertex-access/);
  let events, proof;
  for(let i=0;i<100;i++){events=(await get('/fixture/events')).events;proof=await get('/fixture/proof');if(events.length===3&&proof.pending===0)break;await delay(20);}
  assert.equal(proof.fetches,2);assert.equal(proof.enabled,false);assert.ok(proof.generation>admitted.generation);assert.notEqual(proof.lineage,admitted.lineage);assert.equal(proof.binding,null);assert.equal(proof.capacity,0);assert.equal(proof.pending,0);
  assert.equal(events.length,3);assert.deepEqual(events.map(e=>e.actual_cost_micros).sort((a,b)=>a-b),[0,700,700]);
  assert.equal(events.filter(e=>e.input_tokens===4&&e.output_tokens===2).length,2);
});
