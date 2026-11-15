import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { startWorkerdFixture } from "./helpers/workerd.mjs";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const fixture = new URL("./fixtures/openclaw-qwen-regions-contract.test.ts", import.meta.url);
const fixtureText = readFileSync(fixture, "utf8");
const transformed = stripTypeScriptTypes(fixtureText);
const shared = transformed.split("// BEGIN shared fixture functions.")[1]?.split("// END shared fixture functions.")[0];
assert.ok(shared, "original fixture functions are present");
// The marker's prose ends before the first function declaration.
const functions = shared.slice(shared.indexOf("function qwenRegionCases"));
const { qwenRegionCases, createQwenLedger } = new Function(`${functions}; return { qwenRegionCases, createQwenLedger };`)();
const rows = qwenRegionCases();
const regions = ["qwen-cn", "qwen-coding-global", "qwen-coding-cn"];
const bases = ["https://dashscope.aliyuncs.com/compatible-mode/v1", "https://coding-intl.dashscope.aliyuncs.com/v1", "https://coding.dashscope.aliyuncs.com/v1"];
const key = id => `clawrouter-live-${id}-fixture-secret`;
const credential = (row, rotated = false) => `${row.provider === "qwen-cn" ? "sk-" : "sk-sp-"}synthetic-${rotated ? "rotated-" : ""}${row.id}`;
const paid = row => ["eof", "rotation", "no_usage", "effort_off", "effort_low", "effort_medium", "partial", "provider_error"].includes(row.mode);

async function finish(body, cleanups) {
  const failures = []; let result;
  try { result = await body(); } catch (error) { failures.push(error); }
  for (const cleanup of cleanups) try { await cleanup(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Qwen body and cleanup failed");
  return result;
}

function routerScript() {
  return `
import handler from './worker/index.ts';
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {ingestUsage,usageSnapshot,budgetStatus} from './worker/ledgers.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {sha256Hex} from './worker/utils.ts';
${createQwenLedger.toString()}
const rows=${JSON.stringify(rows)},regions=${JSON.stringify(regions)},states=new Map(),nativeFetch=globalThis.fetch;
const credential=${credential.toString()};
globalThis.fetch=function(input,init){
 const headers=new Headers(init?.headers!==undefined?init.headers:input instanceof Request?input.headers:undefined);
 const secret=headers.get('authorization'),matches=[...states.values()].filter(s=>secret==='Bearer '+credential(s.row)||secret==='Bearer '+credential(s.row,true));
 if(matches.length!==1)throw Error('unbound Qwen upstream request');const s=matches[0];
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 s.calls.push({url,method:init?.method??(input instanceof Request?input.method:'GET'),original:secret==='Bearer '+credential(s.row),rotated:secret==='Bearer '+credential(s.row,true),noCaller:!headers.has('x-api-key')&&!headers.has('api-key')});
 const original=s.ledger.invoke('fetch',nativeFetch,this,[input,init]);
 s.ledger.observe('fetch_observer',original.then(response=>s.ledger.body(response.body)));return original;
};
async function control(s,path){const response=await s.ledger.invoke('control_fetch',nativeFetch,globalThis,['https://control.fixture/'+path+'/'+s.row.id]);return s.ledger.observe('control_body',response.json());}
export default {async fetch(request,env,context){
 const path=new URL(request.url).pathname;
 if(path==='/fixture/setup'){
  if(states.size)throw Error('duplicate Qwen setup');
  const configured={...env,QWEN_API_KEY:'synthetic-poison-global',QWEN_CN_API_KEY:'synthetic-poison-cn',QWEN_CODING_GLOBAL_API_KEY:'synthetic-poison-coding',QWEN_CODING_CN_API_KEY:'synthetic-poison-coding-cn',DASHSCOPE_API_KEY:'synthetic-poison-legacy',QWEN_TOKEN_PLAN_API_KEY:'synthetic-poison-token',QWEN_TOKEN_PLAN_CN_API_KEY:'synthetic-poison-token-cn'};
  await authorityCall(env,'/policies/initialize-all',[]);await authorityCall(env,'/credentials/initialize-all',[]);
  await authorityCall(env,'/connections/initialize-all',regions.map(providerId=>({providerId,enabled:true,monthlyBudgetMicros:10000})));
  for(const row of rows){
   const ledger=createQwenLedger(),s={row,ledger,calls:[],requests:0,status:null,retirement:undefined};
   s.env={...configured,USAGE_QUEUE:{send:event=>ledger.invoke('usage_ingest',ingestUsage,undefined,[env,event])}};
   // The real credential owner rejects empty stored grants. Exercise an empty
   // selected environment binding explicitly, without poisoning another owner.
   const environmentCase=['missing','empty'].includes(row.mode),binding=['QWEN_CN_API_KEY','QWEN_CODING_GLOBAL_API_KEY','QWEN_CODING_CN_API_KEY'][regions.indexOf(row.provider)];
   if(row.mode==='empty')s.env[binding]='';if(row.mode==='missing')delete s.env[binding];
   const policy={enabled:true,generation:'fixture',tenantId:'fixture',providers:[row.mode==='foreign'?'qwen':row.provider],models:[row.provider+'/'+row.model],monthlyBudgetMicros:100,requestCostMicros:row.mode==='unpriced'?null:7,budgetMode:'reserve',retainRequestContent:false,grantRouting:{eligibleGrants:environmentCase?{}:{[row.provider]:[row.provider]},environmentFallback:environmentCase,failover:false}};
   await authorityCall(env,'/policies/put',{policyId:row.id,policy});
   const created=await authorityCall(env,'/credentials/mutate',{credentialId:row.id,scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'},operation:'put',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:row.id,policyGeneration:'fixture'}});
   if(created.outcome!=='updated')throw Error('Qwen credential setup failed');
   for(const foreign of ['qwen','qwen-cn','qwen-coding-global','qwen-coding-cn','qwen-token-plan','qwen-token-plan-cn'].filter(id=>id!==row.provider))await putGrantCredentials(env,'oauth/'+row.id+'/'+foreign,{provider:foreign,kind:'api_key',enabled:true,credential:'sk-sp-synthetic-foreign'});
   let secret=credential(row);
   if(row.mode==='invalid')secret='sk-synthetic-wrong-product';if(row.mode==='raw_c0')secret='\\n'+secret;if(row.mode==='raw_del')secret+='\\x7f';if(row.mode==='whitespace')secret='   ';
   const grant='oauth/'+row.id+'/'+row.provider;
   if(!['missing','empty','missing_grant'].includes(row.mode))await putGrantCredentials(env,grant,{provider:row.provider,kind:'api_key',enabled:true,credential:secret});
   if(row.mode==='rotation')await putGrantCredentials(env,grant,{provider:row.provider,kind:'api_key',enabled:true,credential:credential(row,true)});
   if(row.mode==='revoked')await revokeGrantCredentials(env,grant);
   states.set(row.id,s);
  }
  return Response.json({ready:true});
 }
 if(path.startsWith('/fixture/join/')){
  const s=states.get(path.slice('/fixture/join/'.length));if(!s)throw Error('unknown Qwen fixture');
  if(!s.retirement)s.retirement=(async()=>{
   const failures=[];try{await s.ledger.drain();}catch(error){failures.push(error);}
   let source,usage,budget;try{source=await control(s,'proof');}catch(error){failures.push(error);}
   try{usage=await s.ledger.invoke('usage',usageSnapshot,undefined,[env,'fixture',s.row.id,{kind:'admin'}]);}catch(error){failures.push(error);}
   try{budget=await s.ledger.invoke('budget',budgetStatus,undefined,[env,s.row.id,{tenantId:'fixture',monthlyBudgetMicros:100}]);}catch(error){failures.push(error);}
   try{await s.ledger.drain();}catch(error){failures.push(error);}
   return {retired:failures.length===0,calls:s.calls,source,usage,budget,status:s.status,requests:s.requests,charged:bodyBudgetCharged(),operations:s.ledger.operations.map(o=>({kind:o.kind,state:o.state})),readers:s.ledger.readers.map(r=>({unlocks:r.unlocks,returns:r.returns,locked:r.body.locked}))};
  })();const proof=await s.retirement;return Response.json(proof,{status:proof.retired?200:500});
 }
 const authorization=request.headers.get('authorization'),s=[...states.values()].find(s=>authorization==='Bearer clawrouter-live-'+s.row.id+'-fixture-secret'||authorization==='Bearer clawrouter-live-'+s.row.id+'-invalid');
 if(!s||s.retirement)throw Error('unbound or retired Qwen caller');s.requests++;
 const original=s.ledger.invoke('handler',handler.fetch,handler,[request,s.env,{waitUntil:p=>{s.ledger.observe('waitUntil',p);context.waitUntil(p);}}]);
 s.ledger.observe('handler_observer',original.then(response=>{s.status=response.status;}));return original;
},queue:handler.queue};`;
}

function upstreamScript() {
  return `const rows=${JSON.stringify(rows)},states=new Map(rows.map(row=>[row.id,{row,calls:[],held:0,canceled:0,expired:0,settled:0}]));const credential=${credential.toString()};
export default {async fetch(request){
 const url=new URL(request.url);
 if(url.origin==='https://control.fixture'){
  const s=states.get(url.pathname.split('/')[2]);if(!s)throw Error('unknown source');
  if(s.producer){await s.producer;s.settled=1;}
  return Response.json({calls:s.calls,held:s.held,canceled:s.canceled,expired:s.expired,settled:s.settled});
 }
 const matches=[...states.values()].filter(s=>request.headers.get('authorization')==='Bearer '+credential(s.row)||request.headers.get('authorization')==='Bearer '+credential(s.row,true));
 if(matches.length!==1)throw Error('unbound upstream secret');const s=matches[0],body=await request.json();
 s.calls.push({url:request.url,method:request.method,body,authorization:request.headers.get('authorization'),apiKey:request.headers.get('api-key'),xApiKey:request.headers.get('x-api-key')});
 const frame=value=>'data: '+JSON.stringify(value)+'\\n\\n';
 const chunk=delta=>({id:'chat_fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:null}]});
 if(s.row.mode==='provider_error')return new Response(frame({error:{message:'synthetic provider error',code:'synthetic_error'}}),{headers:{'content-type':'text/event-stream'}});
 const first=frame(chunk({role:'assistant',content:'synthetic-answer'}));
 if(s.row.mode==='partial')return new Response(new ReadableStream({start(c){s.held=1;c.enqueue(new TextEncoder().encode(first));},pull(c){
  if(!s.producer)s.producer=new Promise((resolve,reject)=>{s.resolve=resolve;s.timer=setTimeout(()=>{s.expired++;s.held=0;c.error(Error('source expired'));reject(Error('source expired'));},10000);});return s.producer;
 },cancel(){s.canceled++;clearTimeout(s.timer);s.held=0;s.resolve?.();}}),{headers:{'content-type':'text/event-stream'}});
 const usage=s.row.mode==='no_usage'?{}:{usage:{prompt_tokens:300,completion_tokens:20,total_tokens:320,prompt_tokens_details:{cached_tokens:256}}};
 const wire=first+frame({id:'chat_fixture',model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],...usage})+'data: [DONE]\\n\\n';
 const bytes=new TextEncoder().encode(wire);let at=0;
 return new Response(new ReadableStream({pull(c){if(at===bytes.length)c.close();else{const next=Math.min(at+7,bytes.length);c.enqueue(bytes.slice(at,next));at=next;}}}),{headers:{'content-type':'text/event-stream'}});
}};`;
}

async function startFixture() {
  const directory = await mkdtemp(join(tmpdir(), "qwen-regions-")); let runtime;
  try { runtime = await startWorkerdFixture(directory, routerScript(), upstreamScript()); }
  catch (error) { return finish(() => { throw error; }, [() => rm(directory, { recursive: true, force: true })]); }
  const origin = String(await runtime.ready).replace(/\/$/, "");
  return { runtime, origin, close: () => finish(() => {}, [() => runtime.dispose(), () => rm(directory, { recursive: true, force: true })]) };
}

async function readControl(f, path) {
  const response = await fetch(f.origin + path);
  const text = await response.text();
  assert.equal(response.status, 200, path === "/fixture/setup" ? "Worker setup failed" : "original Worker retirement failed");
  return JSON.parse(text);
}

function assertProof(row, proof) {
  assert.equal(proof.retired, true); assert.equal(proof.charged, 0);
  assert.equal(proof.budget.ledger, "durable_object"); assert.equal(proof.budget.limitMicros, 100);
  if (!paid(row)) assert.equal(proof.budget.spentMicros, 0);
  assert.ok(proof.operations.every(o => o.state === "fulfilled"));
  assert.ok(proof.readers.every(r => r.unlocks === 1 && r.returns === 1 && !r.locked));
  assert.equal(proof.source.held, 0); assert.equal(proof.source.expired, 0);
  const calls = proof.source.calls; assert.equal(calls.length, paid(row) ? 1 : 0); assert.equal(proof.calls.length, calls.length);
  if (calls.length) {
    const call = calls[0]; assert.equal(call.method, "POST"); assert.equal(call.url, bases[regions.indexOf(row.provider)] + "/chat/completions");
    assert.equal(call.authorization, "Bearer " + credential(row, row.mode === "rotation"));
    assert.equal(call.apiKey, null); assert.equal(call.xApiKey, null); assert.equal(call.body.model, row.model); assert.equal(call.body.stream, true);
    assert.ok(call.body.messages.some(m => m.role === "tool" && m.tool_call_id === "callfixture"));
    assert.ok(call.body.messages.some(m => m.tool_calls?.[0]?.function?.name === "lookup"));
    if (["qwen3.5-plus", "glm-5"].includes(row.model)) assert.ok(call.body.messages.every(m => m.reasoning_content === undefined));
    else assert.ok(call.body.messages.some(m => m.reasoning_content === "synthetic-prior-thinking"));
    if (row.model.startsWith("qwen3.8-")) assert.equal(call.body.reasoning_effort, row.mode === "effort_off" ? undefined : row.mode === "effort_low" ? "low" : row.mode === "effort_medium" ? "medium" : "xhigh");
    assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|synthetic-poison/);
  }
  if (row.mode === "partial") { assert.equal(proof.source.canceled, 1); assert.equal(proof.source.settled, 1); }
  const events = proof.usage.events;
  if (row.mode === "preabort") { assert.equal(proof.requests, 0); assert.equal(events.length, 0); return; }
  if (row.mode === "invalid_caller") { assert.equal(proof.status, 401); assert.equal(events.length, 0); return; }
  // prepareNativeRequest rejects an unsupported model before selection creates
  // accounting. The closed native row cannot reserve or emit a usage event.
  if (row.mode === "bad_model") { assert.equal(proof.status, 400); assert.equal(events.length, 0); return; }
  assert.equal(events.length, 1, row.id); const event = events[0];
  assert.equal(event.provider, row.provider); assert.equal(event.credential_id, row.id); assert.equal(event.model, row.provider + "/" + row.model);
  if (paid(row)) {
    const rejected = row.mode === "provider_error";
    assert.equal(event.status, row.mode === "partial" ? "client_error" : rejected ? "provider_error" : "success");
    assert.equal(event.actual_cost_micros, rejected ? 0 : 7); assert.equal(event.cost_basis, rejected ? "none" : "policy_fixed");
    assert.equal(proof.budget.spentMicros, rejected ? 0 : 7);
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens],
      ["partial", "provider_error", "no_usage"].includes(row.mode) ? [null, null, null, null] : [300, 20, 320, 256]);
  } else {
    assert.equal(event.actual_cost_micros, 0); assert.equal(event.reserved_cost_micros, 0);
    assert.equal(proof.budget.spentMicros, 0);
    if (["missing", "empty", "missing_grant", "revoked", "invalid", "raw_c0", "raw_del", "whitespace"].includes(row.mode)) assert.equal(proof.status, 503);
  }
}

test("Qwen shipping snapshot covers complete source inventory and exact consumer", () => {
  const manifests = readdirSync("providers").filter(f => f.endsWith(".provider.yaml")).sort().map(f => parse(readFileSync("providers/" + f, "utf8")));
  assert.ok(manifests.length > 0); assert.equal(new Set(manifests.map(m => m.id)).size, manifests.length);
  assert.deepEqual(manifests.map(m => m.id).sort(), snapshot.providers.map(p => p.id).sort());
  assert.deepEqual(compileProviderSnapshot(manifests), snapshot);
  for (const provider of regions) {
    const actual = snapshot.providers.find(p => p.id === provider);
    assert.deepEqual(actual.models.map(m => m.upstream), rows.filter(r => r.provider === provider && r.mode === "eof" && !r.simple).map(r => r.model));
    assert.ok(actual.models.every(m => m.pricing === null));
    assert.deepEqual(actual.endpoints.map(e => e.path), ["/chat/completions"]);
  }
  const matrix = parse(readFileSync(".github/workflows/openclaw-contract.yml", "utf8")).jobs.consumer.strategy.matrix.include;
  assert.equal(new Set(matrix.map(r => r.consumer)).size, matrix.length);
  assert.deepEqual(matrix.filter(r => r.consumer === "qwen-regions"), [{ consumer: "qwen-regions", ref: sourceHead, test: "test/openclaw-qwen-regions.test.mjs" }]);
  assert.ok(fixtureText.includes(sourceHead)); assert.equal(rows.filter(r => r.mode === "eof").length, 44);
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
});

test("actual shared ledger joins work registered during original settlement", async () => {
  const ledger = createQwenLedger(); let release, canceled, finished = false;
  const original = new Promise(resolve => { release = resolve; });
  assert.equal(ledger.observe("closed", original), original);
  const late = new Promise(resolve => { canceled = resolve; });
  ledger.observe("attachment", original.then(() => { ledger.observe("cancel", late); }));
  const joined = ledger.drain().then(() => { finished = true; });
  release(); await original; await Promise.resolve(); assert.equal(finished, false);
  canceled(); await joined; assert.equal(finished, true);
});
test("actual shared ledger preserves original receiver, promise, undefined and independent failures", async () => {
  const ledger = createQwenLedger(), receiver = {}, secondary = {};
  const original = Promise.reject(undefined);
  assert.equal(ledger.invoke("read", function (value) { assert.equal(this, receiver); assert.equal(value, 7); return original; }, receiver, [7]), original);
  ledger.observe("cancel", Promise.reject(secondary));
  let threw = false; try { ledger.invoke("release", () => { throw undefined; }, null, []); } catch (error) { threw = true; assert.equal(error, undefined); }
  assert.equal(threw, true);
  await assert.rejects(ledger.drain(), error => error instanceof AggregateError && error.errors.length === 3 && error.errors.includes(secondary) && error.errors.filter(e => e === undefined).length === 2);
});
test("actual shared ledger requires original reader unlock and restores observers", async () => {
  const ledger = createQwenLedger(), body = new ReadableStream({ start(c) { c.close(); } }), original = body.getReader;
  ledger.body(body); const reader = body.getReader(); await reader.read();
  await assert.rejects(ledger.drain()); reader.releaseLock(); await ledger.drain(); ledger.restore(); assert.equal(body.getReader, original);
});
test("cleanup retains body failure and attempts both independent finalizers", async () => {
  const order = [], second = {};
  await assert.rejects(finish(() => { throw undefined; }, [() => { order.push(1); throw second; }, () => { order.push(2); }]), error => error instanceof AggregateError && error.errors[0] === undefined && error.errors[1] === second);
  assert.deepEqual(order, [1, 2]);
});

test("registered Qwen regional SDK through shipping Worker and SQLite", { skip: !process.env.CLAWROUTER_OPENCLAW_CHECKOUT, timeout: 300_000 }, async t => {
  const f = await startFixture();
  await finish(async () => {
    await readControl(f, "/fixture/setup");
    await runOpenClawConsumer(t, { source: process.env.CLAWROUTER_OPENCLAW_CHECKOUT, sourceHead, fixture, testPath: "extensions/qwen/worker-regions-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: f.origin, CLAWROUTER_SDK_SOURCE_HEAD: sourceHead, QWEN_API_KEY: "synthetic-poison-client" } });
  }, [async () => {
    const failures = [];
    for (const row of rows) try { assertProof(row, await readControl(f, "/fixture/join/" + row.id)); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Qwen Worker cases and retirement failed");
  }, () => f.close()]);
});

test("shipping regional Worker reaches each original origin and joins positive metadata-free streams", { timeout: 60_000 }, async () => {
  const f = await startFixture(); const selected = regions.map(provider => rows.find(r => r.provider === provider && r.mode === "eof" && !r.simple));
  await finish(async () => {
    await readControl(f, "/fixture/setup");
    for (const row of selected) {
      const response = await fetch(f.origin + "/v1/native/" + row.provider + "/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key(row.id), "content-type": "application/json" },
        body: JSON.stringify({ model: row.model, stream: true, max_tokens: 128, messages: [
          { role: "assistant", content: "", ...(row.model === "qwen3.5-plus" ? {} : { reasoning_content: "synthetic-prior-thinking" }), tool_calls: [{ id: "callfixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "callfixture", content: "synthetic-tool-result" }, { role: "user", content: "synthetic request" },
        ] }),
      });
      assert.equal(response.status, 200); assert.match(await response.text(), /synthetic-answer/);
    }
  }, [async () => {
    const failures = [];
    for (const row of selected) try { assertProof(row, await readControl(f, "/fixture/join/" + row.id)); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "positive Worker retirement failed");
  }, () => f.close()]);
});

test("shipping regional Worker rejects missing, empty, foreign and invalid selected credentials before egress", { timeout: 60_000 }, async () => {
  const modes = ["missing", "empty", "missing_grant", "foreign", "revoked", "unpriced", "invalid_caller", "bad_model", "invalid", "raw_c0", "raw_del", "whitespace"];
  const selected = rows.filter(row => modes.includes(row.mode)), f = await startFixture();
  await finish(async () => {
    await readControl(f, "/fixture/setup");
    for (const row of selected) {
      const response = await fetch(f.origin + "/v1/native/" + row.provider + "/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + (row.mode === "invalid_caller" ? `clawrouter-live-${row.id}-invalid` : key(row.id)), "content-type": "application/json" },
        body: JSON.stringify({ model: row.model, stream: true, messages: [{ role: "user", content: "synthetic denial" }] }),
      });
      const body = await response.json(); assert.equal(response.ok, false, row.id);
      if (["missing", "empty"].includes(row.mode)) {
        assert.equal(response.status, 503); assert.equal(body.error.code, "provider_not_configured");
      }
      if (["invalid", "raw_c0", "raw_del", "whitespace"].includes(row.mode)) {
        assert.equal(response.status, 503); assert.equal(body.error.code, "provider_credentials_invalid");
      }
      if (row.mode === "missing_grant") { assert.equal(response.status, 503); assert.equal(body.error.code, "upstream_grant_pool_unavailable"); }
      assert.doesNotMatch(JSON.stringify(body), /synthetic-poison|sk-sp-synthetic|fixture-secret/);
    }
  }, [async () => {
    const failures = [];
    for (const row of selected) try { assertProof(row, await readControl(f, "/fixture/join/" + row.id)); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "denial Worker retirement failed");
  }, () => f.close()]);
});

export { routerScript, upstreamScript, qwenRegionCases, createQwenLedger, startFixture, readControl, assertProof };
