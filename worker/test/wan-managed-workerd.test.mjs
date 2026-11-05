import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const MiB = 1024 * 1024;
const body = { model: "wan2.6-t2v", input: { prompt: "Synthetic quiet landscape" }, parameters: { duration: 5 } };
const native = "/v1/native/alibaba/api/v1/services/aigc/video-generation/video-synthesis";
const poll = "/v1/native/alibaba/api/v1/tasks/wan_fixture_001";

async function isolated(directory, router, upstream) {
  const require = createRequire(import.meta.resolve("wrangler/package.json"));
  const { Miniflare, convertV4MiniflareOptions } = require("miniflare"), { build } = require("esbuild");
  const bundle = await build({ stdin: { contents: router, resolveDir: process.cwd(), sourcefile: "wan-owned-fixture.ts", loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  const classes = { ACCESS_CONTROL: "PolicyBindingIndexObject", BUDGET_LEDGER: "BudgetLedgerObject", USAGE_LEDGER: "UsageLedgerObject", GRANT_CREDENTIALS: "GrantCredentialObject" };
  const objects = external => Object.fromEntries(Object.entries(classes).map(([name, className]) => [name, { className, useSQLite: true, unsafePreventEviction: true, ...(external ? { scriptName: "owner" } : {}) }]));
  const common = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-06-05", compatibilityFlags: ["enable_request_signal"],
    bindings: { CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: "0" }, kvNamespaces: { POLICY_KV: "wan-retirement-policy" }, outboundService: "upstream" };
  const runtime = new Miniflare(convertV4MiniflareOptions({ resourceTmpPath: directory, resourcePersistencePath: join(directory, "state"), workers: [
    { ...common, name: "front", durableObjects: objects(true) },
    { ...common, name: "owner", durableObjects: objects(false), queueProducers: { USAGE_QUEUE: "usage" }, queueConsumers: { usage: { maxBatchSize: 1, maxBatchTimeout: 0 } } },
    { name: "upstream", modules: true, script: upstream, compatibilityDate: "2026-06-05", compatibilityFlags: ["enable_request_signal"] },
  ] }));
  try { await runtime.ready; return runtime; } catch (error) { await runtime.dispose(); throw error; }
}

async function external(t) {
  let mode = "pending", taskId = "wan_fixture_001";
  const gates = new Map(), released = new Set(), counts = { post: 0, get: 0 };
  const server = createServer(async (request, response) => {
    if (request.url.startsWith("/gate/")) {
      if (released.has(request.url)) response.end("released"); else gates.set(request.url, response);
      return;
    }
    if (request.headers.authorization) { response.writeHead(400); response.end("fixture credential leak"); return; }
    if (request.url !== "/provider") { response.writeHead(404); response.end(); return; }
    counts[request.method === "POST" ? "post" : "get"]++;
    if (request.method === "POST") { let text = ""; for await (const part of request) text += part; assert.deepEqual(JSON.parse(text), body); }
    if (mode === "lost") { request.socket.destroy(); return; }
    const status = mode === "terminal" ? "SUCCEEDED" : mode === "unknown" ? "UNKNOWN" : "RUNNING";
    let text = JSON.stringify({ output: { task_id: taskId, task_status: status } });
    if (mode === "maximum") text += " ".repeat(MiB - Buffer.byteLength(text));
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }); response.end(text);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: "http://127.0.0.1:" + server.address().port, counts, mode(value, id = taskId) { mode = value; taskId = id; },
    release(key) { const path = "/gate/" + key; released.add(path); gates.get(path)?.end("released"); gates.delete(path); },
    releaseAll() { for (const [key, response] of gates) { released.add(key); response.end("released"); } gates.clear(); } };
}

const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {usageStub} from './worker/ledgers.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged,BodyLease} from './worker/body-budget.ts';
import {WanManagedOperation,readWanJson} from './worker/managed-media-json.ts';
import {HttpOperation} from './worker/http-operation.ts';
const rawFetch=globalThis.fetch.bind(globalThis),nativeRelease=BodyLease.prototype.release;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
let active,competing;
const state=()=>({charged:bodyBudgetCharged(),...(active?{mode:active.mode,status:active.status,error:active.error,results:active.results,reads:active.reads,cancels:active.cancels,
 readRetired:active.readRetired,cleanup:active.cleanup,unlocks:active.unlocks,releases:active.releases,maximumBacking:active.maximumBacking,actions:active.actions,locked:active.source?.locked??false}: {})});
BodyLease.prototype.release=function(){const before=bodyBudgetCharged();nativeRelease.call(this);if(active&&before-bodyBudgetCharged()===72*1024*1024)active.releases++;};
const gate=(a,name)=>rawFetch('https://wan-gates.example/gate/'+a.mode+'/'+name,{redirect:'manual'}).then(async response=>{if(!response.ok)throw Error('gate denied');await response.text();});
function hold(body,a){
 a.source=body;const get=body.getReader.bind(body);let cancellation,first=true;
 body.getReader=options=>{const reader=get(options);return {
  async read(...args){a.reads++;try{const result=await reader.read(...args);if(result.value)a.maximumBacking=Math.max(a.maximumBacking,result.value.buffer.byteLength);return result;}
   finally{if(first){first=false;a.ready.resolve();await gate(a,'read');a.readRetired=true;}}},
  cancel(reason){return cancellation??=(async()=>{a.cancels++;let error;try{await reader.cancel(reason);}catch(value){error=value;}await gate(a,'cleanup');a.cleanup=true;if(a.mode==='cleanup-reject')throw Error('synthetic cleanup rejection');if(error)throw error;})();},
  releaseLock(){reader.releaseLock();a.unlocks++;}
 };};
 return body;
}
globalThis.fetch=async(input,init)=>{
 const url=input instanceof Request?input.url:String(input),a=active;
 const response=await rawFetch(input,init);
 if(a&&url.startsWith('https://dashscope-intl.aliyuncs.com/')&&a.mode==='create-read')hold(response.body,a);
 if(a&&url.startsWith('https://dashscope-intl.aliyuncs.com/')&&a.mode==='late-response'){a.ready.resolve();await gate(a,'late');hold(response.body,a);}
 return response;
};
function controlledEnvironment(env,a){
 if(!a)return env;
 const namespace=env.GRANT_CREDENTIALS,authority=env.ACCESS_CONTROL;
 return {...env,GRANT_CREDENTIALS:{idFromName:name=>namespace.idFromName(name),get(id){const stub=namespace.get(id);return {fetch:async(input,init)=>{
  const response=await stub.fetch(input,init);
  if(String(input)==='https://clawrouter.internal/responses/control'&&['poll-read','cleanup-reject','late-poll'].includes(a.mode)){
   hold(response.body,a);if(a.mode==='late-poll'){a.ready.resolve();await gate(a,'late');}
  }
  return response;
 }};}},ACCESS_CONTROL:{idFromName:name=>authority.idFromName(name),get(id){const stub=authority.get(id);return {fetch:async(input,init)=>{
  const packet=JSON.parse(init.body),background=String(input)==='https://clawrouter.internal/responses-background';
  if(background)a.actions.push(packet.action);
  const response=await stub.fetch(input,init);
  if(background&&packet.action==='dispatch'){
   if(a.mode==='lost-ack'){await response.body.cancel();throw Error('synthetic lost dispatch acknowledgment');}
   if(a.mode==='revoke-ack')await authorityCall(env,'/credentials/mutate',{scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'},operation:'revoke',credentialId:'fixture'});
  }
  return response;
 }};}}};
}
export default {async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.pathname==='/bounded-reader'){
  const owner=new WanManagedOperation(),operation=new HttpOperation(request.signal);let reads=0,cancels=0,unlocks=0,maximumBacking=0;
  const get=request.body.getReader.bind(request.body);let empty=Number(url.searchParams.get('empty')??0);
  request.body.getReader=options=>{const reader=get(options);return {async read(...args){
   reads++;if(empty-->0)return {done:false,value:args[0]?args[0].subarray(0,0):new Uint8Array(0)};
   const result=await reader.read(...args);if(result.value)maximumBacking=Math.max(maximumBacking,result.value.buffer.byteLength);return result;
  },cancel(reason){cancels++;return reader.cancel(reason);},releaseLock(){unlocks++;reader.releaseLock();}};};
  let ok=false,error;
  try{await owner.track(readWanJson(request,8*1024*1024,{signal:operation.signal,registerInput:owner.registerInput}));ok=true;}
  catch(value){error=value.code??value.name;}finally{operation.stop('complete');await owner.finish();}
  return Response.json({ok,error,reads,cancels,unlocks,maximumBacking,charged:bodyBudgetCharged()});
 }
 if(url.pathname==='/state')return Response.json(state());
 if(url.pathname==='/contend'){const lease=new BodyLease(),allowed=lease.grow(1024*1024);lease.release();return Response.json({allowed,charged:bodyBudgetCharged()});}
 if(url.pathname==='/competing-release'){competing?.release();competing=undefined;return Response.json(state());}
 if(url.pathname==='/setup'){
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['alibaba'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env,'/connections/initialize',[{providerId:'alibaba',enabled:true,monthlyBudgetMicros:10000}]);
  await putGrantCredentials(env,'oauth/fixture/alibaba',{provider:'alibaba',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
  const connections=await authorityCall(env,'/connections/resolve',{providerIds:['alibaba']});
  return Response.json({ready:true,globalInitialized:connections.initialized,missing:connections.missingProviderIds});
 }
 if(url.pathname==='/rotate'){await putGrantCredentials(env,'oauth/fixture/alibaba',{provider:'alibaba',kind:'api_key',enabled:true,credential:'synthetic-rotated-key'});return Response.json({rotated:true});}
 if(url.pathname==='/events')return usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin');
 if(url.pathname==='/job'){
  const locator=url.searchParams.get('locator');if(!/^[a-f0-9]{64}\.bg_[a-f0-9]{32}$/.test(locator))return new Response(null,{status:400});
  const [scope,id]=locator.split('.');return env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('http-continuations:'+scope)).fetch('https://clawrouter.internal/responses-background',{method:'POST',body:JSON.stringify({action:'get',id})});
 }
 if(url.pathname!=='/call'&&url.pathname!=='/held'&&url.pathname!=='/scenario')return new Response(null,{status:404});
 const target=url.searchParams.get('target');if(!target?.startsWith('/v1/'))return new Response(null,{status:400});
 const headers=new Headers(request.headers);headers.set('authorization','Bearer clawrouter-live-fixture-fixture-secret');
 if(url.pathname==='/call')return worker.fetch(new Request('https://router.example'+target,{method:request.method,headers,body:request.body,signal:request.signal}),env,ctx);
 const mode=url.searchParams.get('mode'),a={mode,status:0,error:null,results:0,reads:0,cancels:0,unlocks:0,releases:0,maximumBacking:0,actions:[],readRetired:false,cleanup:false,ready:deferred(),abort:new AbortController()};active=a;
 if(url.pathname==='/scenario')return worker.fetch(new Request('https://router.example'+target,{method:request.method,headers,body:request.body,signal:request.signal}),controlledEnvironment(env,a),ctx);
 competing=new BodyLease();if(!competing.grow(12*1024*1024))throw Error('fixture competitor admission failed');
 if(mode==='upload')hold(request.body,a);
 const routed=new Request('https://router.example'+target,{method:request.method,headers,body:request.body,signal:a.abort.signal});
 // Cancellation belongs to this original request's network continuation.
 ctx.waitUntil(gate(a,'abort').then(()=>a.abort.abort(new Error('synthetic caller abort'))));
 ctx.waitUntil(worker.fetch(routed,controlledEnvironment(env,a),ctx).then(async response=>{a.status=response.status;try{const value=await response.json();a.error=value.error?.code??null;}catch{}a.results++;a.ready.resolve();}).catch(error=>{a.error=error?.name;a.results++;a.ready.resolve();}));
 await a.ready.promise;return Response.json(state());
},queue:worker.queue};
`;
const upstream = origin => String.raw`
export default {async fetch(request){
 const url=new URL(request.url);
 if(url.origin==='https://wan-gates.example')return fetch(ORIGIN+url.pathname,{redirect:'manual',signal:request.signal});
 if(url.origin!=='https://dashscope-intl.aliyuncs.com'||request.headers.get('authorization')!=='Bearer synthetic-original-key')throw Error('wrong original Wan authority');
 if(request.method==='POST'&&url.pathname!=='/api/v1/services/aigc/video-generation/video-synthesis')throw Error('wrong create route');
 if(request.method==='GET'&&!/^\/api\/v1\/tasks\/wan_fixture_[a-z0-9_]+$/.test(url.pathname))throw Error('wrong poll route');
 return fetch(ORIGIN+'/provider',{method:request.method,body:request.body,headers:{'content-type':'application/json'},signal:request.signal,redirect:'manual'});
}};
`.replaceAll("ORIGIN", JSON.stringify(origin));

// This is the one real workerd/SQLite fixture for the scoped caller boundary.
// It never claims that DO transport carries an upstream-producer cleanup ACK.
test("isolated workerd Wan create/restart/poll and direct caller retirement preserve one paid attempt", { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "wan-managed-retirement-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const io = await external(t); let runtime = await isolated(directory, router, upstream(io.origin));
  t.after(async () => { io.releaseAll(); await runtime.dispose(); });
  const request = (path, init) => runtime.dispatchFetch("https://router.example" + path, { ...init, redirect: "manual" });
  const json = async path => { const response = await request(path); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const call = (target, value, headers = {}) => request("/call?target=" + encodeURIComponent(target), value === null ? {} : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof value === "string" ? value : JSON.stringify(value) });
  const idle = async expected => { let state; for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.charged === expected) return state; await delay(10); } assert.fail(JSON.stringify(state)); };
  assert.deepEqual(await json("/setup"), { ready: true, globalInitialized: false, missing: [] });
  for (const [empty, ok] of [[8190, true], [8191, false]]) {
    const response = await request("/bounded-reader?empty=" + empty, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    const result = await response.json(); assert.equal(result.ok, ok, JSON.stringify(result));
    assert.equal(result.reads, 8192); assert.equal(result.cancels, ok ? 0 : 1); assert.equal(result.unlocks, 1);
    assert.equal(result.charged, 0); assert.ok(result.maximumBacking <= 16384);
  }
  const maximumGraph = { a: [Array(1024).fill("x"), Array(1024).fill("x"), Array(1024).fill("x"), Array(1018).fill("x")] };
  const maximumStrings = Object.fromEntries(["a", "b", "c", "d"].map(key => [key, "x".repeat(65535)]));
  for (const value of [maximumGraph, maximumStrings]) {
    const response = await request("/bounded-reader", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.charged, 0); assert.equal(result.unlocks, 1); assert.ok(result.maximumBacking <= 16384);
  }

  io.mode("maximum");
  const maximum = JSON.stringify(body) + " ".repeat(8 * MiB - Buffer.byteLength(JSON.stringify(body)));
  let response = await call(native, maximum, { "idempotency-key": "one-wan-job" });
  assert.equal(response.status, 200, await response.clone().text()); const locator = response.headers.get("x-clawrouter-background-recovery");
  assert.equal((await response.json()).output.task_id, "wan_fixture_001"); await idle(0);
  assert.equal(io.counts.post, 1);
  await runtime.dispose(); runtime = await isolated(directory, router, upstream(io.origin));
  io.mode("terminal"); response = await call("/v1/proxy/alibaba/task?task_id=wan_fixture_001", null);
  assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).output.task_status, "SUCCEEDED"); await idle(0);
  const job = await json("/job?locator=" + encodeURIComponent(locator));
  assert.equal(job.managed.terminal, "succeeded"); assert.equal(job.event.actual_cost_micros, 700); assert.equal(job.event.cost_basis, "policy_fixed");
  response = await call("/v1/proxy/alibaba/video", { body }, { "idempotency-key": "one-wan-job" });
  assert.equal(response.status, 303, await response.clone().text()); assert.equal(response.headers.get("location"), poll);
  await response.text(); await idle(0); assert.equal(io.counts.post, 1);
  response = await call(native, { ...body, input: { prompt: "different" } }, { "idempotency-key": "one-wan-job" });
  assert.equal(response.status, 409, await response.text()); await idle(0); assert.equal(io.counts.post, 1);
  for (const mode of ["upload", "poll-read", "cleanup-reject"]) {
    const target = mode === "upload" ? native : poll;
    const before = { ...io.counts };
    response = await request("/held?mode=" + mode + "&target=" + encodeURIComponent(target), mode === "upload"
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    let state = await response.json(); assert.equal(state.charged, 96 * MiB, JSON.stringify(state)); assert.equal(state.reads, 1, JSON.stringify(state));
    io.release(mode + "/abort");
    for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.results === 1 && state.cancels === 1) break; await delay(10); }
    assert.equal(state.results, 1, JSON.stringify(state)); assert.equal(state.cancels, 1, JSON.stringify(state)); assert.equal(state.releases, 0);
    assert.equal(state.charged, 96 * MiB); assert.equal(state.locked, true); assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB });
    io.release(mode + "/cleanup");
    for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.cleanup) break; await delay(10); }
    assert.equal(state.cleanup, true); assert.equal(state.charged, 96 * MiB); assert.equal(state.locked, true); assert.equal(state.releases, 0);
    io.release(mode + "/read"); state = await idle(24 * MiB);
    assert.equal(state.readRetired, true); assert.equal(state.locked, false); assert.equal(state.unlocks, 1); assert.equal(state.releases, 1);
    assert.ok(state.maximumBacking <= 16 * 1024); assert.equal(io.counts.post, before.post);
    await json("/competing-release"); await idle(0);
  }
  // A late DO-returned response is still caller work after public cancellation.
  response = await request("/held?mode=late-poll&target=" + encodeURIComponent(poll));
  await response.json(); io.release("late-poll/abort");
  let late;
  for (let i = 0; i < 100; i++) { late = await json("/state"); if (late.results === 1) break; await delay(10); }
  assert.equal(late.results, 1); assert.equal(late.charged, 96 * MiB); assert.equal(late.cancels, 0); assert.equal(late.releases, 0);
  io.release("late-poll/late");
  for (let i = 0; i < 100; i++) { late = await json("/state"); if (late.cancels === 1) break; await delay(10); }
  assert.equal(late.cancels, 1); assert.equal(late.locked, true); assert.equal(late.charged, 96 * MiB);
  io.release("late-poll/cleanup"); late = await idle(24 * MiB);
  assert.equal(late.unlocks, 1); assert.equal(late.releases, 1); await json("/competing-release");

  io.mode("unknown", "wan_fixture_unknown");
  response = await call(native, body, { "idempotency-key": "wan-unknown" });
  assert.equal(response.status, 410, await response.clone().text()); const unknownLocator = response.headers.get("x-clawrouter-background-recovery");
  await response.text(); await idle(0);
  const unknown = await json("/job?locator=" + encodeURIComponent(unknownLocator));
  assert.equal(unknown.managed.observationUnavailable, "expired_or_unknown"); assert.equal(unknown.managed.terminal, null);
  assert.equal(unknown.event.actual_cost_micros, 700); assert.equal(unknown.event.cost_basis, "policy_fixed");
  const beforeUnknown = io.counts.post;
  response = await call(native, body, { "idempotency-key": "wan-unknown" }); assert.equal(response.status, 410); await response.text(); await idle(0);
  assert.equal(io.counts.post, beforeUnknown);

  await json("/rotate"); const before = io.counts.get;
  response = await call(poll, null); assert.equal(response.status, 503, await response.text()); assert.equal(io.counts.get, before); await idle(0);

  for (const mode of ["lost-ack", "revoke-ack"]) {
    const before = io.counts.post;
    response = await request("/scenario?mode=" + mode + "&target=" + encodeURIComponent(native),
      { method: "POST", headers: { "content-type": "application/json", "idempotency-key": mode }, body: JSON.stringify(body) });
    assert.equal(response.status, 503, await response.clone().text()); const value = await response.json();
    await idle(0); const state = await json("/state");
    assert.equal(io.counts.post, before); assert.equal(state.actions.filter(action => action === "dispatch").length, 1);
    assert.equal(state.actions.filter(action => action === "freeze").length, mode === "revoke-ack" ? 1 : 0);
    assert.equal(value.error.code, mode === "revoke-ack" ? "prediction_submission_unsent" : "prediction_submission_unknown");
  }
});
