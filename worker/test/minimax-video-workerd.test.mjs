import { musicAccessFixture } from "./minimax-music-admin-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { videoInput, hailuoModels, mp4 } from "./minimax-video-declaration-fixture.mjs";
const MiB = 1024 * 1024;
async function isolated(directory, router, upstream) {
  const require = createRequire(import.meta.resolve("wrangler/package.json"));
  const { Miniflare, convertV4MiniflareOptions } = require("miniflare"), { build } = require("esbuild");
  const bundle = await build({ stdin: { contents: router, resolveDir: process.cwd(), sourcefile: "hailuo-owned-fixture.ts", loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  const classes = { ACCESS_CONTROL: "PolicyBindingIndexObject", BUDGET_LEDGER: "BudgetLedgerObject", USAGE_LEDGER: "UsageLedgerObject", GRANT_CREDENTIALS: "GrantCredentialObject" };
  const objects = external => Object.fromEntries(Object.entries(classes).map(([name, className]) => [name, { className, useSQLite: true, unsafePreventEviction: true, ...(external ? { scriptName: "owner" } : {}) }]));
  const common = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-06-05", compatibilityFlags: ["enable_request_signal"],
    bindings: { CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: "0" }, kvNamespaces: { POLICY_KV: "hailuo-retirement-policy" }, outboundService: "upstream" };
  const runtime = new Miniflare(convertV4MiniflareOptions({ resourceTmpPath: directory, resourcePersistencePath: join(directory, "state"), workers: [
    { ...common, name: "front", durableObjects: objects(true) },
    { ...common, name: "owner", durableObjects: objects(false), queueProducers: { USAGE_QUEUE: "usage" }, queueConsumers: { usage: { maxBatchSize: 1, maxBatchTimeout: 0 } } },
    { name: "upstream", modules: true, script: upstream, compatibilityDate: "2026-06-05", compatibilityFlags: ["enable_request_signal"] },
  ] }));
  try { await runtime.ready; return runtime; } catch (error) { await runtime.dispose(); throw error; }
}

async function external(t) {
  let mode = "pending", id = 100, current = "100";
  const held = new Map(), entered = new Map(), released = new Set(), counts = { post: 0, poll: 0, metadata: 0, download: 0 };
  const server = createServer(async (request, response) => {
    if (request.url.startsWith("/gate/")) { entered.get(request.url)?.resolve(); if (released.has(request.url)) response.end("released"); else held.set(request.url, response); return; }
    if (request.headers.authorization) { response.writeHead(400); response.end(); return; }
    const path = new URL(request.url, "http://fixture").pathname;
    const base_resp = { status_code: 0, status_msg: "success" }; let value;
    if (path === "/v1/video_generation") {
      counts.post++; current = String(++id); let text = ""; for await (const part of request) text += part;
      const body = JSON.parse(text); assert.ok(hailuoModels.includes(body.model)); assert.equal(body.duration, 6);
      value = { task_id: current, base_resp };
    } else if (path === "/v1/query/video_generation") {
      counts.poll++; const task_id = new URL(request.url, "http://fixture").searchParams.get("task_id");
      value = { task_id, status: mode === "unknown" ? "UNKNOWN" : mode === "pending" ? "Processing" : "Success", ...(mode === "pending" ? {} : { file_id: task_id + "1" }), base_resp };
    } else if (path === "/v1/files/retrieve") {
      counts.metadata++; value = { file: { file_id: new URL(request.url, "http://fixture").searchParams.get("file_id"), purpose: "video_generation", bytes: 16 * MiB }, base_resp };
    } else if (path === "/v1/files/retrieve_content") {
      counts.download++; const bytes = mp4(16 * MiB); response.writeHead(200, { "content-type": "application/json", "content-length": bytes.length }); response.end(bytes); return;
    } else { response.writeHead(404); response.end(); return; }
    if (mode === "maximum" && !path.includes("/files/")) {
      value.ignored = { a: "x".repeat(65530), b: "x".repeat(65530), c: "x".repeat(65530) };
      let nodes = 0; const count = x => { nodes++; if (x && typeof x === "object") for (const v of Object.values(x)) count(v); }; count(value);
      value.discarded = Array(4095 - nodes).fill(null);
    }
    let text = JSON.stringify(value);
    if (mode === "maximum" && !path.includes("/files/")) text += " ".repeat(MiB - Buffer.byteLength(text));
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }); response.end(text);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: "http://127.0.0.1:" + server.address().port, counts, entered(key) { const gate = Promise.withResolvers(); entered.set("/gate/" + key, gate); return gate.promise; }, mode(value) { mode = value; },
    release(key) { const path = "/gate/" + key; released.add(path); held.get(path)?.end("released"); held.delete(path); },
    releaseAll() { for (const [path, response] of held) { released.add(path); response.end("released"); } held.clear(); } };
}
const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {configureVideo} from './worker/test/minimax-video-declaration-fixture.mjs';
import {authorityCall} from './worker/authority.ts';
import {GrantCredentialObject as BaseGrantCredentialObject,putGrantCredentials,inspectGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {miniMaxVideoBinding} from './shared/minimax-video-binding.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged,BodyLease} from './worker/body-budget.ts';
import {MiniMaxVideoOperation,readVideoJson} from './worker/minimax-video-operation.ts';
import {usageStub} from './worker/ledgers.ts';
const provider=snapshot.providers.find(p=>p.id==='minimax');configureVideo(provider);
const key='oauth/fixture/video',actor={auth:'cloudflare_access',role:'admin',email:'video-admin@example.invalid'};
const raw=globalThis.fetch.bind(globalThis),release=BodyLease.prototype.release,deferred=()=>Promise.withResolvers();
export class GrantCredentialObject extends BaseGrantCredentialObject {
 constructor(state,env){const held={mode:null},authority=env.ACCESS_CONTROL;
  super(state,{...env,ACCESS_CONTROL:{idFromName:n=>authority.idFromName(n),get:id=>{const stub=authority.get(id);return {async fetch(input,init){
   const response=await stub.fetch(input,init);
   if(held.mode&&new URL(input).pathname==='/grant-pools/admit'){
    if(!(await response.clone().json()).pending)throw Error('expected pending pool admission');
    const mode=held.mode;held.mode=null;const ack=await fetch('https://video-gates.example/gate/'+mode+'/pool',{redirect:'manual'});await ack.text();
   }return response;
  }}}}});this.fixtureState=state;this.held=held;
 }
 async fetch(request){const u=new URL(request.url);
  if(u.pathname==='/fixture/arm'){this.held.mode=u.searchParams.get('mode');return Response.json({armed:true});}
  if(u.pathname==='/fixture/pin'){const r=await this.fixtureState.storage.get('credential');return Response.json(r?{generation:r.generation,lineage:r.lineage,
   binding:r.minimaxVideoBinding??null,credentialSha256:await sha256Hex(r.credential??''),account:r.accountId,enabled:r.enabled,pending:r.poolSyncPending??false,revision:r.poolAdmissionRevision}:null);}
  return super.fetch(request);
 }
}
let active;
const state=()=>({charged:bodyBudgetCharged(),...(active?{mode:active.mode,status:active.status,error:active.error,results:active.results,
 reads:active.reads,cancels:active.cancels,unlocks:active.unlocks,releases:active.releases,maxBacking:active.maxBacking,actions:active.actions,
 cleanup:active.cleanup,readRetired:active.readRetired,locked:active.source?.locked??false}: {})});
BodyLease.prototype.release=function(){const before=bodyBudgetCharged();release.call(this);if(active&&before-bodyBudgetCharged()===96*1024*1024)active.releases++;};
const gate=(a,part)=>raw('https://video-gates.example/gate/'+a.mode+'/'+part,{redirect:'manual'}).then(async r=>{if(!r.ok)throw Error('gate refused');await r.text();});
function hold(source,a){a.source=source;const get=source.getReader.bind(source);let first=true,cancel;
 source.getReader=options=>{const reader=get(options);return {
  async read(...args){a.reads++;try{const result=await reader.read(...args);if(result.value)a.maxBacking=Math.max(a.maxBacking,result.value.buffer.byteLength);return result;}
   finally{if(first){first=false;a.ready.resolve();await gate(a,'read');a.readRetired=true;}}},
  cancel(reason){return cancel??=(async()=>{a.cancels++;try{await reader.cancel(reason);}finally{await gate(a,'cleanup');a.cleanup=true;if(a.mode==='cleanup-reject')throw Error('synthetic cleanup rejection');}})();},
  releaseLock(){reader.releaseLock();a.unlocks++;}
 };};
}
function controlled(env,a){const grants=env.GRANT_CREDENTIALS,authority=env.ACCESS_CONTROL;return {...env,
 GRANT_CREDENTIALS:{idFromName:n=>grants.idFromName(n),get:id=>{const stub=grants.get(id);return {async fetch(input,init){
  const response=await stub.fetch(input,init);
  if(new URL(input).pathname==='/responses/control'&&['poll-read','file-read','cleanup-reject','late'].includes(a.mode)){
   if(a.mode!=='file-read'||JSON.parse(init.body).file?.action==='download'){hold(response.body,a);if(a.mode==='late'){a.ready.resolve();await gate(a,'arrival');}}
  }return response;
 }}}},
 ACCESS_CONTROL:{idFromName:n=>authority.idFromName(n),get:id=>{const stub=authority.get(id);return {async fetch(input,init){
  const path=new URL(input).pathname,packet=JSON.parse(init.body);if(path==='/responses-background')a.actions.push(packet.action);
  const response=await stub.fetch(input,init);
  if(path==='/responses-background'&&packet.action==='dispatch'){
   if(a.mode==='lost-ack'){await response.body.cancel();throw Error('synthetic lost ACK');}
   if(a.mode==='confirmed-revoke')await revokeGrantCredentials(env,key,undefined,undefined,undefined,actor);
  }return response;
 }}}}};
}
export default {async fetch(request,bindings,ctx){const env={...bindings,...ACCESS_ENV},u=new URL(request.url);
 if(u.pathname.startsWith("/v1/admin/"))return worker.fetch(request,env,ctx);
 if(u.pathname==="/fixture/user"){await authorityCall(env,"/users/put",{email:"music-admin@example.invalid",record:{role:u.searchParams.get("role")??"admin",enabled:u.searchParams.get("enabled")!=="false",tenantId:"fixture",groups:[]}});return Response.json({updated:true});}
 if(["/fixture/arm","/fixture/pin"].includes(u.pathname))return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName("oauth/fixture/video-admin-"+u.searchParams.get("mode"))).fetch("https://owner"+u.pathname+"?mode="+u.searchParams.get("mode"));
 if(u.pathname==='/state')return Response.json(state());
 if(u.pathname==='/contend'){const l=new BodyLease(),allowed=l.grow(1);l.release();return Response.json({allowed,charged:bodyBudgetCharged()});}
 if(u.pathname==='/setup'){
  const policy={enabled:true,generation:'g1',providers:['minimax'],tenantId:'fixture',dailyBudgetMicros:100000,weeklyBudgetMicros:100000,monthlyBudgetMicros:100000,requestCostMicros:700,retainRequestContent:false,
    grantRouting:{eligibleGrants:{minimax:['video']},environmentFallback:true,failover:true}};
  await authorityCall(env,'/users/initialize-all',[{email:actor.email,record:{enabled:true,role:'admin',tenantId:'fixture',groups:[]}}]);
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1',principalId:actor.email}}]);
  await authorityCall(env,'/connections/initialize-all',[{providerId:'minimax',enabled:true,monthlyBudgetMicros:100000}]);
  await putGrantCredentials(env,key,{provider:'minimax',kind:'api_key',enabled:true,credential:'synthetic-video-key',accountId:'synthetic-account'},false,undefined,
    undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,miniMaxVideoBinding(u.searchParams.get('region')??'global'),actor);
  return Response.json({ready:true});
 }
 if(u.pathname==='/metadata-edit'){await putGrantCredentials(env,key,{label:'metadata changed'},true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,actor);return Response.json({changed:true});}
 if(u.pathname==='/events')return usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin');
 if(u.pathname==='/job'){const locator=u.searchParams.get('locator');if(!/^[a-f0-9]{64}\.bg_[a-f0-9]{32}$/.test(locator))return new Response(null,{status:400});
  const [scope,id]=locator.split('.');return env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('http-continuations:'+scope)).fetch('https://owner/responses-background',{method:'POST',body:JSON.stringify({action:'get',id})});}
 if(u.pathname==='/bounded-reader'){
  const owner=new MiniMaxVideoOperation('create',request),get=request.body.getReader.bind(request.body);let empty=Number(u.searchParams.get('empty')??0),reads=0,maxBacking=0;
  request.body.getReader=options=>{const r=get(options);return {async read(...args){reads++;if(empty-->0)return {done:false,value:args[0].subarray(0,0)};const part=await r.read(...args);if(part.value)maxBacking=Math.max(maxBacking,part.value.buffer.byteLength);return part;},cancel:x=>r.cancel(x),releaseLock:()=>r.releaseLock()};};
  let ok=false,error;try{await readVideoJson(request,owner.controlSignal,'input',owner.registerInput);ok=true;}catch(e){error=e.code??e.name;}finally{await owner.finish();}
  return Response.json({ok,error,reads,maxBacking,charged:bodyBudgetCharged()});
 }
 if(!['/call','/held','/scenario'].includes(u.pathname))return new Response(null,{status:404});
 const target=u.searchParams.get('target');if(!target?.startsWith('/v1/'))return new Response(null,{status:400});
 const headers=new Headers(request.headers);headers.set('authorization','Bearer clawrouter-live-fixture-fixture-secret');
 if(u.pathname==='/call')return worker.fetch(new Request('https://router.example'+target,{method:request.method,headers,body:request.body,signal:request.signal}),env,ctx);
 const a=active={mode:u.searchParams.get('mode'),status:null,error:null,results:0,reads:0,cancels:0,unlocks:0,releases:0,maxBacking:0,actions:[],cleanup:false,readRetired:false,ready:deferred(),abort:new AbortController()};
 if(u.pathname==='/scenario')return worker.fetch(new Request('https://router.example'+target,{method:request.method,headers,body:request.body,signal:request.signal}),controlled(env,a),ctx);
 if(a.mode==='upload')hold(request.body,a);
 const routed=new Request('https://router.example'+target,{method:request.method,headers,body:request.body,signal:a.abort.signal});
 ctx.waitUntil(gate(a,'abort').then(()=>a.abort.abort(new Error('controlled caller cancellation'))));
 ctx.waitUntil(worker.fetch(routed,controlled(env,a),ctx).then(async r=>{a.status=r.status;try{const b=await r.json();a.error=b.error?.code??null;}catch{}a.results++;a.ready.resolve();}).catch(e=>{a.error=e.code??e.name;a.results++;a.ready.resolve();}));
 await a.ready.promise;return Response.json(state());
},queue:worker.queue};
`;
const upstream = (origin, jwk) => String.raw`
export default {async fetch(request){const u=new URL(request.url);
 if(u.href==='https://music-admin-fixture.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json({keys:[JWK]});
 if(u.origin==='https://video-gates.example')return fetch(ORIGIN+u.pathname,{redirect:'manual',signal:request.signal});
 if(!['https://api.minimax.io','https://api.minimaxi.com'].includes(u.origin)||request.headers.get('authorization')!=='Bearer synthetic-video-key')throw Error('unqualified video destination');
 return fetch(ORIGIN+u.pathname+u.search,{method:request.method,body:request.body,headers:{'content-type':'application/json'},signal:request.signal,redirect:'manual'});
}};`.replaceAll('ORIGIN',JSON.stringify(origin)).replace('JWK',JSON.stringify(jwk));

test("isolated workerd Hailuo original owner, restart/file, full charge and physical retirement", { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "hailuo-owned-runtime-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const io = await external(t), access = await musicAccessFixture(), script = router.replace("ACCESS_ENV", JSON.stringify(access.env)); let runtime = await isolated(directory, script, upstream(io.origin, access.jwk));
  t.after(async () => { io.releaseAll(); await runtime.dispose(); });
  const request = (path, init) => runtime.dispatchFetch("https://router.example" + path, { ...init, redirect: "manual" });
  const json = async path => { const r = await request(path); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const call = (target, body, headers = {}, kind = "call", mode = "") => request("/" + kind + "?mode=" + mode + "&target=" + encodeURIComponent(target), {
    ...(body == null ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), headers: { "content-type": "application/json", ...headers } });
  const idle = async () => { let s; for (let i = 0; i < 100; i++) { s = await json("/state"); if (!s.charged) return s; await delay(10); } assert.fail(JSON.stringify(s)); };
  const native = "/v1/native/minimax/v1/video_generation";
  let task, filePath, locator;
  for (const region of ["global", "cn"]) for (const model of hailuoModels) for (const manifest of [false, true]) {
    assert.deepEqual(await json("/setup?region=" + region), { ready: true }); io.mode("maximum");
    const value = manifest ? { body: { ...videoInput(model), model: "minimax/" + model } } : videoInput(model), text = JSON.stringify(value);
    const r = await call(manifest ? "/v1/proxy/minimax/video" : native, text + " ".repeat(65536 - Buffer.byteLength(text)), { "idempotency-key": region + model + manifest });
    assert.equal(r.status, 200, await r.clone().text()); locator = r.headers.get("x-clawrouter-background-recovery"); task = (await r.json()).task_id; await idle();
    await runtime.dispose(); runtime = await isolated(directory, script, upstream(io.origin, access.jwk));
    const pollPath = (manifest ? "/v1/proxy/minimax/task?task_id=" : "/v1/native/minimax/v1/query/video_generation?task_id=") + task;
    const p = await call(pollPath, null); assert.equal(p.status, 200, await p.clone().text()); const body = await p.json(); await idle();
    assert.equal(body.status, "Success"); filePath = body.video_url;
    const f = await call(filePath, null, { "x-clawrouter-job-id": task }); if (f.status !== 200) assert.fail(await f.text());
    assert.equal(f.headers.get("content-type"), "video/mp4"); assert.equal((await f.arrayBuffer()).byteLength, 16 * MiB); await idle();
    const job = await json("/job?locator=" + encodeURIComponent(locator)); assert.equal(job.event.cost_basis, "policy_fixed"); assert.equal(job.event.actual_cost_micros, 700);
  }
  assert.equal(io.counts.post, 8);
  for (const [empty, ok] of [[8190, true], [8191, false]]) {
    const r = await request("/bounded-reader?empty=" + empty, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    const b = await r.json(); assert.equal(b.ok, ok, JSON.stringify(b)); assert.equal(b.reads, 8192); assert.ok(b.maxBacking <= 16384); assert.equal(b.charged, 0);
  }
  for (const mode of ["upload", "poll-read", "file-read", "cleanup-reject", "late"]) {
    const target = mode === "upload" ? native : mode === "file-read" ? filePath : "/v1/native/minimax/v1/query/video_generation?task_id=" + task;
    const r = await call(target, mode === "upload" ? videoInput() : null, { "x-clawrouter-job-id": task }, "held", mode);
    let s = await r.json(); assert.equal(s.charged, 96 * MiB, JSON.stringify(s)); io.release(mode + "/abort");
    for (let i = 0; i < 100; i++) { s = await json("/state"); if (s.results === 1) break; await delay(10); }
    assert.equal(s.results, 1, JSON.stringify(s)); assert.equal(s.charged, 96 * MiB); assert.equal(s.releases, 0);
    if (mode === "late") io.release(mode + "/arrival");
    for (let i = 0; i < 100; i++) { s = await json("/state"); if (s.cancels === 1) break; await delay(10); }
    assert.equal(s.cancels, 1); assert.equal(s.locked, true); assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB });
    io.release(mode + "/cleanup");
    for (let i = 0; i < 100; i++) { s = await json("/state"); if (s.cleanup) break; await delay(10); }
    assert.equal(s.cleanup, true); assert.equal(s.charged, 96 * MiB); assert.equal(s.locked, true);
    io.release(mode + "/read"); s = await idle(); assert.equal(s.releases, 1); assert.equal(s.unlocks, 1); assert.ok(s.maxBacking <= 16384);
  }
  for (const mode of ["lost-ack", "confirmed-revoke"]) {
    await json("/setup"); const before = io.counts.post;
    const r = await call(native, videoInput(), {}, "scenario", mode); assert.equal(r.status, 503, await r.clone().text()); await r.text(); await idle();
    const s = await json("/state"); assert.equal(io.counts.post, before); assert.equal(s.actions.filter(a => a === "freeze").length, mode === "confirmed-revoke" ? 1 : 0);
  }
  const put = (mode, body) => request("/v1/admin/upstream-grants/policies/fixture/video-admin-" + mode, {
    method: "PUT", headers: { ...access.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const mode of ["admin-demote", "admin-disable"]) {
    await json("/fixture/user");
    const created = await put(mode, { provider: "minimax", kind: "api_key", enabled: false, accountId: "synthetic-old-account",
      credential: "synthetic-old-video-key", minimaxVideoAuthorization: "minimax-global-video" });
    assert.equal(created.status, 200, await created.clone().text()); await created.text();
    const before = await json("/fixture/pin?mode=" + mode); assert.equal(before.binding.operation, "minimax.video");
    await json("/fixture/arm?mode=" + mode); const entered = io.entered(mode + "/pool");
    const pending = put(mode, { enabled: true, accountId: "synthetic-new-account", credential: "synthetic-new-video-key", minimaxVideoAuthorization: "minimax-cn-video" });
    await entered; await json(mode === "admin-demote" ? "/fixture/user?role=user" : "/fixture/user?enabled=false"); io.release(mode + "/pool");
    const denied = await pending; assert.equal(denied.status, 403, await denied.clone().text()); await denied.text();
    assert.deepEqual(await json("/fixture/pin?mode=" + mode), before);
    await json("/fixture/user"); const retry = await put(mode, { label: "no pending adoption" }); assert.equal(retry.status, 403, await retry.clone().text()); await retry.text();
    assert.deepEqual(await json("/fixture/pin?mode=" + mode), before);
  }

});
