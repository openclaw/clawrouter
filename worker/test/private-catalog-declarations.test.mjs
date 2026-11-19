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


async function joinOriginalOutcomes(roots) {
  const failures = []; let index = 0;
  while (index < roots.length) {
    const batch = roots.slice(index); index = roots.length;
    for (const outcome of await Promise.all(batch)) if (outcome.failed) failures.push(outcome.error);
  }
  if (failures.length) throw new AggregateError(failures, "original private catalog operations failed");
}

test("private original-operation join retains undefined and independent failures through dynamic joins", async () => {
  const first = {}, second = {}; let release, complete = false;
  const hold = new Promise(resolve => { release = resolve; });
  const roots = [Promise.resolve({ failed: true, error: undefined }), Promise.resolve({ failed: true, error: first }),
    hold.then(() => { roots.push(Promise.resolve({ failed: true, error: second })); return { failed: false }; })];
  const original = joinOriginalOutcomes(roots);
  const observed = original.then(() => { complete = true; }, error => { complete = true; return error; });
  await Promise.resolve(); assert.equal(complete, false);
  release(); const failure = await observed;
  assert.ok(failure instanceof AggregateError); assert.deepEqual(failure.errors, [undefined, first, second]);
});
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
 JOIN_VALUE
export default {async fetch(request,bindings){
 const {providerId:id,mode,change='empty',manifest=false}=await request.json(),provider=snapshot.providers.find(p=>p.id===id);
 const model=provider.models.find(m=>m.capabilities.includes('llm.chat')&&!m.upstream.startsWith('decision-models/'));
 const policyId=id+'_'+mode+(mode==='held'?'_'+change+'_'+Number(manifest):''),grantKey='oauth/'+policyId+'/'+id,roots=[],operations=[],readers=[],calls=[],authorityReads=[],grantReads=[],timeline=[];
 let sequence=0;const mark=name=>{timeline.push({name,sequence:++sequence});};
 let prefix=false,mutation=false,returned=false,mutationBeforeReturn=false,hasPrimary=false,primary,result;
 const observe=(promise,kind)=>{
  const record={kind,state:'pending'};operations.push(record);
  const outcome=promise.then(value=>{record.state='fulfilled';return {failed:false,value};},error=>{record.state='rejected';return {failed:true,error};});
  roots.push(outcome);return promise;
 };
 const context={waitUntil:p=>{observe(p,'waitUntil');}};
 const policy={enabled:true,generation:'g1',providers:[id],models:mode==='decision'||mode.startsWith('error')||mode==='held'&&change!=='broaden'?null:[model.id],tenantId:'fixture',
  monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false};
 const credential={enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId,policyGeneration:'g1'};
 const access=bindings.ACCESS_CONTROL,grants=bindings.GRANT_CREDENTIALS;
 const env={...bindings,ACCESS_CONTROL:{idFromName:n=>access.idFromName(n),get:n=>{
  const stub=access.get(n);return {fetch(input,init){const record={path:new URL(typeof input==='string'?input:input.url).pathname,afterMutation:mutation,verifier:returned,unlocked:readers.length>0&&readers.every(r=>r.eof&&r.unlocks===1&&!r.body.locked),sequence:++sequence};authorityReads.push(record);return observe(Reflect.apply(stub.fetch,stub,arguments),'authority_fetch');}};
 }},GRANT_CREDENTIALS:{idFromName:n=>grants.idFromName(n),get:n=>{const stub=grants.get(n);return {fetch(input,init){grantReads.push({path:new URL(typeof input==='string'?input:input.url).pathname,afterMutation:mutation,verifier:returned,sequence:++sequence});return observe(Reflect.apply(stub.fetch,stub,arguments),'grant_fetch');}};}},USAGE_QUEUE:{send:event=>ingestUsage(bindings,event)}};
 for(const name of provider.config_keys)env[name]='synthetic-environment-cannot-replace-owner';
 const control=async(path,body)=>{
  const response=await observe(Reflect.apply(nativeFetch,globalThis,['https://private-fixture.test'+path,{method:'POST',body:JSON.stringify(body)}]),'control_fetch');
  return observe(response.json(),'control_body');
 };
 const drain=()=>joinOriginalOutcomes(roots);
 const call=async(manifest=false,query='',body=null)=>{
  const response=await observe(worker.fetch(new Request('https://router.example'+(manifest?'/v1/proxy/'+id+'/models_list':'/v1/native/'+id+'/models')+query,
   {method:body===null?'GET':'POST',headers:{authorization:'Bearer clawrouter-live-'+policyId+'-fixture-secret','content-type':'application/json','x-api-key':'synthetic-caller-key','x-account':'foreign'},
    ...(body===null?{}:{body:JSON.stringify(body)})}),env,context),'handler');
  returned=true;mutationBeforeReturn=mutation;mark('publication');
  const text=await observe(response.text(),'delivery');
  return {status:response.status,body:JSON.parse(text),cache:response.headers.get('cache-control')};
 };
 try{
  const seeds=Object.keys(bases).flatMap(providerId=>['native','manifest','empty','invalid','revoke','rotate','redirect','decision','error401','error403','malformed'].map(scenario=>({policyId:providerId+'_'+scenario,policy:{...policy,providers:[providerId]}})));
  seeds.push({policyId,policy});
  await authorityCall(env,'/policies/initialize-all',seeds);
  await authorityCall(env,'/credentials/initialize-all',seeds.map(seed=>({credentialId:seed.policyId,credential:{...credential,policyId:seed.policyId}})));
  await authorityCall(env,'/policies/put',{policyId,policy});
  const created=await authorityCall(env,'/credentials/mutate',{credentialId:policyId,scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'},operation:'put',credential});
  if(created.outcome!=='updated')throw Error('fixture credential setup refused');
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
    const body=response.body,getReader=body.getReader,cancelBody=body.cancel;
    body.cancel=function(){return observe(Reflect.apply(cancelBody,this,arguments),'body_cancel');};
    body.getReader=function(){
     const reader=Reflect.apply(getReader,this,arguments),state={body,unlocks:0,reads:0,cancels:0,eof:false};readers.push(state);
     observe(reader.closed,'closed');
     for(const kind of ['read','cancel']){
      const original=reader[kind];
      reader[kind]=function(){
       state[kind==='read'?'reads':'cancels']++;
       const pending=Reflect.apply(original,this,arguments);observe(pending,kind);
       if(kind==='read')observe(pending.then(async chunk=>{
        if(chunk.done){state.eof=true;mark('eof');return;}
        if(mode!=='held'||prefix||!chunk.value.byteLength)return;
        prefix=true;mark('prefix');
        if(returned)throw Error('publication preceded held prefix');
        if(change==='empty'||change==='subset'||change==='broaden'||change==='disable'||change==='stale'||change==='provider'||change==='eligibility'){
         const next={...policy};
         if(change==='empty')next.models=[];
         if(change==='subset')next.models=[model.id];
         if(change==='broaden')next.models=null;
         if(change==='disable')next.enabled=false;
         if(change==='stale')next.generation='g2';
         if(change==='provider')next.providers=['openai'];
         if(change==='eligibility')next.grantRouting={eligibleGrants:{[id]:[]}};
         await authorityCall(env,'/policies/put',{policyId,policy:next});
        }else if(change==='caller_revoke'||change==='caller_expire'){
         const expiryAt=Date.now()+100;
         const mutationResult=await authorityCall(env,'/credentials/mutate',{credentialId:policyId,scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'},
          ...(change==='caller_revoke'?{operation:'revoke'}:{operation:'put',credential:{...credential,expiresAt:new Date(expiryAt).toISOString()}})});
         if(mutationResult.outcome!=='updated')throw Error('credential mutation refused');
         if(change==='caller_expire')await observe(new Promise(resolve=>setTimeout(resolve,Math.max(1,expiryAt-Date.now()+1))),'credential_expiry');
        }else if(change==='grant_revoke')await revokeGrantCredentials(env,grantKey);
        else if(['grant_disable','grant_expire','grant_rotate'].includes(change))await putGrantCredentials(env,grantKey,{provider:id,kind:'api_key',enabled:change!=='grant_disable',
         credential:change==='grant_rotate'?'synthetic-rotated-key':'synthetic-original-key',...(change==='grant_expire'?{expiresAt:new Date(Date.now()-1000).toISOString()}:{})});
        else if(change!=='normal')throw Error('unknown authority change');
        mutation=true;mark('mutation');
        await control('/complete',{});
       }),'prefix_observer');
       return pending;
      };
     }
     const release=reader.releaseLock;
     reader.releaseLock=function(){state.unlocks++;const result=Reflect.apply(release,this,arguments);mark('unlock');return result;};
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
  }else results.push(await call(mode==='held'?manifest:mode==='manifest'));
  await drain();
  const upstream=await control('/proof',{});
  const current=await authorityCall(env,'/policies/list',{});
  const currentPolicy=current.policies.find(p=>p.policyId===policyId)?.policy;
  const grant=await inspectGrantCredentials(env,grantKey);
  const usage=await usageSnapshot(bindings,'fixture',policyId,{kind:'admin'});
  await drain();
  result={id,mode,model:model.upstream,results,calls,events:usage.events,upstream,prefix,mutation,mutationBeforeReturn,
   timeline,policyId,grantKey,latestModels:currentPolicy?.models,grantActive:grant?.enabled===true&&!grant.revokedAt,authorityReads,grantReads,
   operations:operations.map(p=>({kind:p.kind,state:p.state})),readers:readers.map(r=>({unlocks:r.unlocks,reads:r.reads,cancels:r.cancels,locked:r.body.locked,eof:r.eof})),charged:bodyBudgetCharged()};
 }catch(error){hasPrimary=true;primary=error;}
 const failures=[];try{await drain();}catch(error){failures.push(error);}
 globalThis.fetch=nativeFetch;
 if(hasPrimary||failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'private catalog fixture failed');
 return Response.json(result);
},queue:worker.queue};`.replace("BASES_VALUE", JSON.stringify(bases)).replace("ROW_VALUE", row.toString()).replace("JOIN_VALUE", joinOriginalOutcomes.toString());

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
 if(config.mode==='malformed')return Response.json({data:[{}]});
 if(config.mode.startsWith('error'))return Response.json({error:{message:'private-upstream-sentinel-secret-prompt'}},{status:Number(config.mode.slice(5))});
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

const authorityChanges = ["normal", "subset", "empty", "broaden", "caller_revoke", "caller_expire", "disable", "stale", "provider",
  "grant_revoke", "grant_disable", "grant_expire", "grant_rotate", "eligibility"];

test("held private catalogs refresh original authority after complete input and before publication", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "private-catalog-authority-"));
  let runtime, primaryPresent = false, primary;
  const failures = [];
  try {
    runtime = await startWorkerdFixture(directory, router, upstream);
    for (const id of Object.keys(bases)) for (const manifest of [false, true]) for (const change of authorityChanges) {
      await t.test(`${id} ${manifest ? "manifest" : "native"} ${change}`, async () => {
        const response = await runtime.dispatchFetch("https://router.example/fixture", {
          method: "POST", body: JSON.stringify({ providerId: id, mode: "held", manifest, change }),
        });
        const text = await response.text(); assert.equal(response.status, 200, text);
        const proof = JSON.parse(text); assertRetired(proof);
        assert.equal(proof.prefix, true, JSON.stringify({status:proof.results[0].status,code:proof.results[0].body.error?.code,calls:proof.calls.length})); assert.equal(proof.mutation, true); assert.equal(proof.mutationBeforeReturn, true);
        assert.equal(proof.calls.length, 1); assert.equal(proof.calls[0].originalKey, true);
        assert.equal(proof.calls[0].url, bases[id] + "/models"); assert.equal(proof.calls[0].method, "GET");
        assert.equal(proof.calls[0].bodyAbsent, true); assert.equal(proof.calls[0].noCallerHeaders, true);
        assert.equal(proof.upstream.calls, 1); assert.equal(proof.upstream.settled, 1);
        const result = proof.results[0];
        const success = ["normal", "subset", "empty", "broaden"].includes(change);
        const ownerDenied = change.startsWith("grant_") || change === "eligibility";
        const status = success ? 200 : ownerDenied ? 503 : change === "caller_expire" ? 401 : 403;
        assert.equal(result.status, status, result.body.error?.code);
        if (success) assert.deepEqual(result.body, { data: change === "empty" ? [] : change === "normal"
          ? [row(id, proof.model), row(id, "synthetic-unqualified-model")].sort((a,b)=>a.id.localeCompare(b.id)) : [row(id, proof.model)] });
        else assert.equal(result.body.error.code, ownerDenied ? "model_discovery_owner_unavailable"
          : change === "caller_revoke" ? "proxy_key_revoked" : change === "caller_expire" ? "proxy_key_expired" : "response_caller_unavailable");
        const fresh = proof.authorityReads.filter(read => read.afterMutation && !read.verifier && read.path === "/authorization/snapshot");
        assert.equal(fresh.length, 1); assert.equal(fresh[0].unlocked, true);
        const event = name => proof.timeline.find(entry => entry.name === name)?.sequence;
        assert.ok(event("prefix") < event("mutation")); assert.ok(event("mutation") < event("eof"));
        assert.ok(event("eof") < event("unlock")); assert.ok(event("unlock") < fresh[0].sequence);
        assert.ok(fresh[0].sequence < event("publication"));
        const inspect = proof.grantReads.filter(read => read.afterMutation && !read.verifier && read.path === "/inspect");
        assert.equal(inspect.length, success || ownerDenied ? 1 : 0);
        if (inspect.length) assert.ok(inspect[0].sequence > fresh[0].sequence && inspect[0].sequence < event("publication"));
        assert.equal(proof.events.length, 1);
        const receipt = proof.events[0];
        assert.equal(receipt.provider, id); assert.equal(receipt.policy_id, proof.policyId); assert.equal(receipt.credential_id, proof.policyId);
        assert.equal(receipt.grant_key, proof.grantKey);
        assert.equal(receipt.status_code, status);
        assert.equal(receipt.status, success ? "success" : status === 403 ? "denied" : "provider_error");
      });
    }
    for (const id of Object.keys(bases)) for (const mode of ["error401", "error403", "malformed"]) {
      await t.test(`${id} ${mode} stays sanitized`, async () => {
        const response = await runtime.dispatchFetch("https://router.example/fixture", { method: "POST", body: JSON.stringify({providerId:id,mode}) });
        const text = await response.text(); assert.equal(response.status, 200, text);
        const proof = JSON.parse(text); assertRetired(proof);
        assert.equal(proof.results[0].status, mode === "malformed" ? 502 : Number(mode.slice(5)));
        assert.equal(proof.results[0].body.error.code, mode === "malformed" ? "invalid_model_discovery_response" : "model_discovery_rejected");
        assert.equal(text.includes("private-upstream-sentinel-secret-prompt"), false); assert.equal(proof.calls.length, 1);
      });
    }
  } catch (error) { primaryPresent = true; primary = error; }
  try { await runtime?.dispose(); } catch (error) { failures.push(error); }
  try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (primaryPresent || failures.length) throw new AggregateError(primaryPresent ? [primary, ...failures] : failures, "private authority execution and cleanup");
});

const authorityUnit = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {modelDiscoveryResponse} from './worker/model-discovery.ts';
import {HttpOperation} from './worker/http-operation.ts';
import {HttpError} from './worker/utils.ts';
import {snapshot} from './worker/providers.ts';
export default {async fetch(request){
 const mode=await request.text(),provider=snapshot.providers.find(p=>p.id==='baseten'),endpoint=provider.endpoints.find(e=>e.id==='models_list');
 const controller=new AbortController(),primary={},failure=mode==='undefined'?undefined:new HttpError(503,'authority_store_unavailable','fixture authority failure');
 const operation=new HttpOperation(controller.signal),response=Response.json({data:[{id:'synthetic'}]});
 let resolveTask,rejectTask,enter,settled=false;
 const task=new Promise((resolve,reject)=>{resolveTask=resolve;rejectTask=reject;});
 const taskOutcome=task.then(()=>({failed:false}),error=>({failed:true,same:error===failure}));
 const entered=new Promise(resolve=>{enter=resolve;});
 const reading=modelDiscoveryResponse(response,provider,endpoint,{providers:['baseten'],models:null},{},operation,
  ()=>{throw Error('unexpected page');},mode==='missing'?undefined:()=>{enter();return task;});
 const outcome=reading.then(()=>{settled=true;return {failed:false};},error=>{settled=true;return {failed:true,same:error===failure,abort:error===primary,
  canonical:error instanceof HttpError&&error.code==='authority_store_unavailable',missing:error instanceof HttpError&&error.code==='invalid_model_discovery_response'};});
 if(mode==='missing'){const result=await outcome;operation.stop('complete');return Response.json({result});}
 await entered;
 const unlocked=!response.body.locked;
 controller.abort(primary);await Promise.resolve();const pending=!settled;
 if(mode==='resolved')resolveTask({providers:['baseten'],models:null});else rejectTask(failure);
 const result=await outcome,originalTask=await taskOutcome;operation.stop('complete');
 return Response.json({unlocked,pending,result,originalTask,originalAbortRetained:operation.signal.reason===primary});
}};`;

test("keyed publication joins original authority after abort and preserves canonical or undefined failure", { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "private-catalog-control-"));
  let runtime, primaryPresent = false, primary; const failures = [];
  try {
    runtime = await startWorkerdFixture(directory, authorityUnit, "export default {fetch(){throw Error('unexpected egress')}}");
    for (const mode of ["resolved", "canonical", "undefined", "missing"]) await t.test(mode, async () => {
      const response = await runtime.dispatchFetch("https://router.example/unit", {method:"POST",body:mode});
      assert.equal(response.status, 200); const proof = await response.json();
      assert.equal(proof.result.failed, true);
      if (mode === "missing") { assert.equal(proof.result.missing, true); return; }
      assert.equal(proof.unlocked, true); assert.equal(proof.pending, true); assert.equal(proof.originalAbortRetained, true);
      if (mode === "resolved") { assert.equal(proof.result.abort, true); assert.equal(proof.originalTask.failed, false); }
      else { assert.equal(proof.result.same, true); assert.equal(proof.originalTask.failed, true); assert.equal(proof.originalTask.same, true); }
      if (mode === "canonical") assert.equal(proof.result.canonical, true);
    });
  } catch (error) { primaryPresent = true; primary = error; }
  try { await runtime?.dispose(); } catch (error) { failures.push(error); }
  try { await rm(directory, {recursive:true,force:true}); } catch (error) { failures.push(error); }
  if (primaryPresent || failures.length) throw new AggregateError(primaryPresent ? [primary, ...failures] : failures, "private authority unit and cleanup");
});
