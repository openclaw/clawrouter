import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
const bases = { baseten: "https://inference.baseten.co/v1", arcee: "https://api.arcee.ai/api/v1",
  novita: "https://api.novita.ai/openai/v1" };
const sources = Object.fromEntries(Object.keys(bases).map(id => [id,
  parse(readFileSync(new URL(`../../providers/${id}.provider.yaml`, import.meta.url), "utf8"))]));
const compile = source => compileProviderSnapshot([source]);
const row = (provider, id) => provider === "arcee" ? { id, name: id, context_length: 1024, max_output_length: 512,
  input_modalities: ["text"], output_modalities: ["text"] }
  : provider === "novita" ? { id, object: "model", created: 1, context_size: 1024 } : { id };
for (const id of Object.keys(bases)) {
  test(`${id} catalog declaration preserves all inference cards, prices, auth and Chat bytes in compilation`, () => {
    const source = sources[id], before = structuredClone(source);
    delete before.endpoints.models_list;
    before.capabilities = before.capabilities.filter(value => value.endpoint !== "models_list");
    const result = compile(source), baseline = compile(before), provider = result.providers[0], original = baseline.providers[0];
    assert.deepEqual(result.model_index, baseline.model_index); assert.deepEqual(provider.models, original.models);
    for (const key of ["auth", "adapter", "routing", "base_urls", "billing", "config_keys", "optional_config_keys"])
      assert.deepEqual(provider[key], original[key]);
    assert.deepEqual(provider.endpoints.filter(value => value.id !== "models_list"), original.endpoints);
    assert.deepEqual(provider.capabilities.filter(value => value.endpoint !== "models_list"), original.capabilities);
    const endpoint = provider.endpoints.find(value => value.id === "models_list");
    assert.equal(endpoint.path, "/models"); assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]);
    assert.equal(endpoint.request_format, `${id}.models`); assert.equal(endpoint.response_format, `${id}.models`);
    assert.equal(endpoint.native_proxy, true); assert.equal(endpoint.upstreamPath, undefined);
    assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.path_params, []);
    assert.equal(endpoint.modelPassthrough, undefined); assert.equal(endpoint.requestPricing, undefined);
    assert.ok(provider.models.every(model => !model.capabilities.includes("models.list")));
  });
}

// Both workers import the shipping snapshot. No provider/card injection.
const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials,revokeGrantCredentials,inspectGrantCredentials} from './worker/grant-credentials.ts';
import {ingestUsage,usageSnapshot} from './worker/ledgers.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {sha256Hex} from './worker/utils.ts';
const bases=BASES_VALUE,makeRow=ROW_VALUE,nativeFetch=globalThis.fetch;
export default {async fetch(request,bindings){
 const {providerId:id,mode}=await request.json(),provider=snapshot.providers.find(p=>p.id===id);
 const model=provider.models.find(m=>m.capabilities.includes('llm.chat')&&!m.upstream.startsWith('decision-models/'));
 const policyId=id+'_'+mode,grantKey='oauth/'+id+'_'+mode+'/'+id,roots=[],operations=[],readers=[],calls=[],authorityReads=[],grantReads=[];
 let prefix=false,mutation=false,returned=false,mutationBeforeReturn=false,hasPrimary=false,primary,result;
 const observe=(promise,kind)=>{
  const record={kind,state:'pending'};operations.push(record);
  const outcome=promise.then(value=>{record.state='fulfilled';return {failed:false,value};},error=>{record.state='rejected';return {failed:true,error};});
  roots.push(outcome);return promise;
 };
 const context={waitUntil:p=>{observe(p,'waitUntil');}};
 const policy={enabled:true,generation:'g1',providers:[id],models:mode==='decision'?null:[model.id],tenantId:'fixture',
  monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false};
 const credential={enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId,policyGeneration:'g1'};
 const access=bindings.ACCESS_CONTROL,grants=bindings.GRANT_CREDENTIALS;
 const env={...bindings,ACCESS_CONTROL:{idFromName:n=>access.idFromName(n),get:n=>{
  const stub=access.get(n);return {fetch(input,init){authorityReads.push({path:new URL(typeof input==='string'?input:input.url).pathname,afterMutation:mutation});return Reflect.apply(stub.fetch,stub,arguments);}};
 }},GRANT_CREDENTIALS:{idFromName:n=>grants.idFromName(n),get:n=>{const stub=grants.get(n);return {fetch(input,init){grantReads.push({path:new URL(typeof input==='string'?input:input.url).pathname,afterMutation:mutation});return Reflect.apply(stub.fetch,stub,arguments);}};}},USAGE_QUEUE:{send:event=>ingestUsage(bindings,event)}};
 for(const name of provider.config_keys)env[name]='synthetic-environment-cannot-replace-owner';
 const control=async(path,body)=>{
  const response=await observe(Reflect.apply(nativeFetch,globalThis,['https://private-fixture.test'+path,{method:'POST',body:JSON.stringify(body)}]),'control_fetch');
  return observe(response.json(),'control_body');
 };
 const drain=async()=>{
  const failures=[];let index=0;
  while(index<roots.length){const batch=roots.slice(index);index=roots.length;for(const outcome of await Promise.all(batch))if(outcome.failed)failures.push(outcome.error);}
  if(failures.length)throw new AggregateError(failures,'original private catalog operations failed');
 };
 const call=async(manifest=false,query='',body=null)=>{
  const response=await observe(worker.fetch(new Request('https://router.example'+(manifest?'/v1/proxy/'+id+'/models_list':'/v1/native/'+id+'/models')+query,
   {method:body===null?'GET':'POST',headers:{authorization:'Bearer clawrouter-live-'+policyId+'-fixture-secret','content-type':'application/json','x-api-key':'synthetic-caller-key','x-account':'foreign'},
    ...(body===null?{}:{body:JSON.stringify(body)})}),env,context),'handler');
  returned=true;mutationBeforeReturn=mutation;
  const text=await observe(response.text(),'delivery');
  return {status:response.status,body:JSON.parse(text),cache:response.headers.get('cache-control')};
 };
 try{
  const seeds=Object.keys(bases).flatMap(providerId=>['native','manifest','empty','invalid','revoke','rotate','redirect','decision','held'].map(scenario=>({policyId:providerId+'_'+scenario,policy:{...policy,providers:[providerId]}})));
  await authorityCall(env,'/policies/initialize-all',seeds);
  await authorityCall(env,'/credentials/initialize-all',seeds.map(seed=>({credentialId:seed.policyId,credential:{...credential,policyId:seed.policyId}})));
  await authorityCall(env,'/policies/put',{policyId,policy});
  await authorityCall(env,'/connections/initialize-all',Object.keys(bases).map(providerId=>({providerId,enabled:true,monthlyBudgetMicros:10000})));
  await putGrantCredentials(env,grantKey,{provider:id,kind:'api_key',enabled:true,credential:'synthetic-original-key'});
  const ids=mode==='decision'?[model.upstream]:[model.upstream,'synthetic-unqualified-model'];
  if(mode==='decision')ids.push(...provider.models.filter(m=>m.upstream.startsWith('decision-models/')).map(m=>m.upstream),'decision-models/synthetic-unknown');
  await control('/setup',{id,mode,payload:{data:(mode==='empty'?[]:ids).map(upstream=>makeRow(id,upstream))}});
  globalThis.fetch=function(input,init){
   const url=typeof input==='string'?input:input instanceof URL?input.href:input.url,headers=new Headers(init?.headers??input.headers);
   calls.push({url,method:init?.method??input.method??'GET',bodyAbsent:(init?.body??input.body??null)===null,redirect:init?.redirect??input.redirect,
    originalKey:headers.get('authorization')==='Bearer synthetic-original-key',rotatedKey:headers.get('authorization')==='Bearer synthetic-rotated-key',
    noCallerHeaders:!headers.has('x-api-key')&&!headers.has('x-account')});
   const fetched=Reflect.apply(nativeFetch,this,arguments);observe(fetched,'fetch');
   observe(fetched.then(response=>{
    if(!response.body)return;
    const body=response.body,getReader=body.getReader;
    body.getReader=function(){
     const reader=Reflect.apply(getReader,this,arguments),state={body,unlocks:0,reads:0,cancels:0};readers.push(state);
     observe(reader.closed,'closed');
     for(const kind of ['read','cancel']){
      const original=reader[kind];
      reader[kind]=function(){
       state[kind==='read'?'reads':'cancels']++;
       const pending=Reflect.apply(original,this,arguments);observe(pending,kind);
       if(kind==='read')observe(pending.then(async chunk=>{
        if(mode!=='held'||prefix||chunk.done||!chunk.value.byteLength)return;
        prefix=true;
        if(returned)throw Error('publication preceded held prefix');
        await authorityCall(env,'/policies/put',{policyId,policy:{...policy,models:[]}});
        mutation=true;
        await control('/complete',{});
       }),'prefix_observer');
       return pending;
      };
     }
     const release=reader.releaseLock;
     reader.releaseLock=function(){state.unlocks++;return Reflect.apply(release,this,arguments);};
     return reader;
    };
   }),'fetch_observer');
   return fetched;
  };
  const results=[];
  if(mode==='invalid'){
   for(const manifest of [false,true])for(const query of ['?page=2','?url=https://other.example','?api_key=synthetic'])results.push(await call(manifest,query));
   results.push(await call(false,'',{model:model.upstream}));
   for(const body of [{body:{account:'other'}},{method:'POST',body:{}},{query:{page:'2'}}])results.push(await call(true,'',body));
  }else if(mode==='empty'){
   results.push(await call(false),await call(true));
  }else if(mode==='revoke'||mode==='rotate'){
   results.push(await call(false));await drain();
   if(mode==='revoke')await revokeGrantCredentials(env,grantKey);
   else await putGrantCredentials(env,grantKey,{provider:id,kind:'api_key',enabled:true,credential:'synthetic-rotated-key'});
   results.push(await call(true));
  }else results.push(await call(mode==='manifest'));
  await drain();
  const upstream=await control('/proof',{});
  const current=await authorityCall(env,'/policies/list',{});
  const currentPolicy=current.policies.find(p=>p.policyId===policyId)?.policy;
  const grant=await inspectGrantCredentials(env,grantKey);
  const usage=await usageSnapshot(bindings,'fixture',policyId,{kind:'admin'});
  await drain();
  result={id,mode,model:model.upstream,results,calls,events:usage.events,upstream,prefix,mutation,mutationBeforeReturn,
   latestModels:currentPolicy?.models,grantActive:grant?.enabled===true&&!grant.revokedAt,authorityReads,grantReads,
   operations:operations.map(p=>({kind:p.kind,state:p.state})),readers:readers.map(r=>({unlocks:r.unlocks,reads:r.reads,cancels:r.cancels,locked:r.body.locked})),charged:bodyBudgetCharged()};
 }catch(error){hasPrimary=true;primary=error;}
 const failures=[];try{await drain();}catch(error){failures.push(error);}
 globalThis.fetch=nativeFetch;
 if(hasPrimary||failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'private catalog fixture failed');
 return Response.json(result);
},queue:worker.queue};`.replace("BASES_VALUE", JSON.stringify(bases)).replace("ROW_VALUE", row.toString());

const upstream = `
let config,complete,producer,settleProducer,expiry,calls=0,held=0,settled=0,canceled=0,expired=0;
export default {async fetch(request){
 const url=new URL(request.url);
 if(url.origin==='https://private-fixture.test'){
  if(url.pathname==='/setup'){config=await request.json();complete=producer=settleProducer=expiry=undefined;calls=held=settled=canceled=expired=0;return Response.json({ready:true});}
  if(url.pathname==='/complete'){if(!complete)throw Error('missing original producer');complete();return Response.json({accepted:true});}
  if(url.pathname==='/proof'){if(producer){await producer;settled=1;}return Response.json({calls,held,settled,canceled,expired});}
 }
 calls++;
 if(config.mode==='redirect')return new Response(null,{status:302,headers:{location:'https://foreign.example/models'}});
 if(config.mode!=='held')return Response.json(config.payload);
 const wire=JSON.stringify(config.payload),prefix='{"data":[';
 const body=new ReadableStream({
  start(controller){held=1;controller.enqueue(new TextEncoder().encode(prefix));},
  pull(controller){
   if(producer)return producer;
   producer=new Promise((resolve,reject)=>{
    settleProducer=resolve;
    expiry=setTimeout(()=>{expired++;held=0;controller.error(Error('fixture producer expired'));reject(Error('fixture producer expired'));},5000);
    complete=()=>{clearTimeout(expiry);controller.enqueue(new TextEncoder().encode(wire.slice(prefix.length)));controller.close();held=0;resolve();};
   });return producer;
  },
  cancel(){canceled++;if(held){clearTimeout(expiry);held=0;complete=undefined;settleProducer();}}
 });
 return new Response(body,{headers:{'content-type':'application/json'}});
}};`;

function assertRetired(proof) {
  assert.ok(proof.operations.length > 0);
  assert.ok(proof.operations.every(operation => operation.state === "fulfilled"));
  assert.ok(proof.readers.every(reader => reader.unlocks === 1 && !reader.locked));
  assert.equal(proof.upstream.held, 0);
  assert.equal(proof.upstream.expired, 0);
  assert.equal(proof.charged, 0);
  for (const event of proof.events) {
    assert.equal(event.model, null);
    assert.equal(event.actual_cost_micros, 0);
    assert.equal(event.reserved_cost_micros, 0);
  }
}

test("shipping private catalogs use real Workerd requests, original owners and SQLite", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "private-catalog-shipping-"));
  let runtime, primaryPresent = false, primary;
  const failures = [];
  try {
    runtime = await startWorkerdFixture(directory, router, upstream);
    for (const id of Object.keys(bases)) {
      for (const mode of ["native", "manifest", "empty", "invalid", "revoke", "rotate", "redirect"]) {
        await t.test(id + " " + mode, async () => {
          const response = await runtime.dispatchFetch("https://router.example/fixture", {
            method: "POST", body: JSON.stringify({ providerId: id, mode }),
          });
          const text = await response.text();
          assert.equal(response.status, 200, text);
          const proof = JSON.parse(text);
          assertRetired(proof);
          if (mode === "invalid") {
            assert.ok(proof.results.every(result => result.status >= 400)); assert.equal(proof.calls.length, 0);
          } else if (mode === "redirect") {
            assert.equal(proof.results[0].status, 502); assert.equal(proof.calls.length, 1);
          } else {
            const accepted = mode === "revoke" ? proof.results.slice(0, 1) : proof.results;
            for (const result of accepted) {
              assert.equal(result.status, 200, result.body.error?.code);
              assert.deepEqual(result.body, { data: mode === "empty" ? [] : [row(id, proof.model)] });
              assert.match(result.cache, /private, no-store/);
            }
            if (mode === "revoke") {
              assert.ok([403, 503].includes(proof.results[1].status)); assert.equal(proof.calls.length, 1);
            }
            assert.equal(proof.events.length, proof.results.length);
          }
          assert.equal(proof.upstream.calls, proof.calls.length);
          for (const [index, call] of proof.calls.entries()) {
            assert.equal(call.url, bases[id] + "/models"); assert.equal(call.method, "GET");
            assert.equal(call.bodyAbsent, true); assert.equal(call.redirect, "manual"); assert.equal(call.noCallerHeaders, true);
            assert.equal(mode === "rotate" && index === 1 ? call.rotatedKey : call.originalKey, true);
          }
        });
      }
    }
    await t.test("Baseten decision namespace stays excluded under unrestricted models", async () => {
      const response = await runtime.dispatchFetch("https://router.example/fixture", { method: "POST", body: JSON.stringify({ providerId: "baseten", mode: "decision" }) });
      assert.equal(response.status, 200); const proof = await response.json(); assertRetired(proof);
      assert.equal(proof.results[0].status, 200);
      assert.deepEqual(proof.results[0].body, { data: [{ id: proof.model }] });
      assert.equal(proof.calls.length, 1);
    });
  } catch (error) { primaryPresent = true; primary = error; }
  try { await runtime?.dispose(); } catch (error) { failures.push(error); }
  try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (primaryPresent || failures.length) throw new AggregateError(primaryPresent ? [primary, ...failures] : failures, "private catalog execution and cleanup");
});

test("held private response records authority changes before model publication", { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "private-catalog-authority-"));
  let runtime, primaryPresent = false, primary;
  const failures = [];
  try {
    runtime = await startWorkerdFixture(directory, router, upstream);
    const response = await runtime.dispatchFetch("https://router.example/fixture", {
      method: "POST", body: JSON.stringify({ providerId: "baseten", mode: "held" }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const proof = JSON.parse(text);
    assertRetired(proof);
    assert.equal(proof.prefix, true); assert.equal(proof.mutation, true); assert.equal(proof.mutationBeforeReturn, true);
    assert.deepEqual(proof.latestModels, []); assert.equal(proof.grantActive, true);
    assert.equal(proof.calls.length, 1); assert.equal(proof.upstream.settled, 1);
    // Observation of the existing pre-dispatch contract, not a new denial oracle.
    t.diagnostic(JSON.stringify({ mode: "held_policy_narrow", status: proof.results[0].status,
      published: proof.results[0].body.data?.length ?? 0, latestAllowed: proof.latestModels.length,
      authorityReadsAfterMutation: proof.authorityReads.filter(read => read.afterMutation).map(read => read.path),
      grantReadsAfterMutation: proof.grantReads.filter(read => read.afterMutation).map(read => read.path),
      originalsFulfilled: true, unlocked: true, producerJoined: proof.upstream.settled, expired: proof.upstream.expired,
      events: proof.events.length, zeroCost: proof.events.every(event => event.actual_cost_micros === 0) }));
  } catch (error) { primaryPresent = true; primary = error; }
  try { await runtime?.dispose(); } catch (error) { failures.push(error); }
  try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (primaryPresent || failures.length) throw new AggregateError(primaryPresent ? [primary, ...failures] : failures, "private authority witness and cleanup");
});
