import { createHash } from "node:crypto";
import { inlineImage, uri, png } from "./minimax-video-inline-fixture.mjs";
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
import { miniMaxFrozenVideoModels } from "../../shared/minimax-video-binding.ts";
const addedModels = miniMaxFrozenVideoModels.slice(2);
const sixModelInput = model => ({ ...videoInput(model), resolution: model.startsWith("I2V-") ? "720P" : "768P" });
const MiB = 1024 * 1024;
function assertInlineCreateCalls(state, { lookup = false, unsent = false } = {}) {
  const counts = Object.fromEntries([...new Set(state.controls)].map(path => [path, state.controls.filter(value => value === path).length]));
  assert.deepEqual(counts, {
    "authority:/admission/resolve": 2, "authority:/connections/resolve": 4,
    "authority:/authorization/snapshot": 3, "grant:/inspect": unsent ? 2 : 3,
    "grant:/materialize": 1, "authority:/responses-background": unsent ? 3 : lookup ? 5 : 4,
  });
  assert.deepEqual(state.actions, unsent ? ["managed_admit", "dispatch", "freeze"]
    : [...(lookup ? ["managed_lookup"] : []), "managed_admit", "dispatch", "managed_bind", "managed_observe"]);
  assert.deepEqual(state.exchanges, [{ kind: "create", ordinary: unsent ? 13 : lookup ? 16 : 15, mandatory: unsent ? 2 : 3 }]);
}
function heldCallFailure(t, error, attempt, posts) {
  const code = error?.cause?.code ?? error?.code, syscall = error?.cause?.syscall;
  t.diagnostic(JSON.stringify({ phase: "held-call-rejected", attempt, posts,
    code: ["EPIPE", "ECONNRESET", "UND_ERR_SOCKET", "ABORT_ERR"].includes(code) ? code : "other",
    syscall: ["write", "read", "connect"].includes(syscall) ? syscall : "other" }));
}
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
  let mode = "pending", id = 100, current = "100", earlyReply, postStarted;
  const held = new Map(), entered = new Map(), released = new Set(), counts = { post: 0, poll: 0, metadata: 0, download: 0, imageBytes: 0, imageDigest: null, destinations: {} };
  const server = createServer(async (request, response) => {
    if (request.url.startsWith("/gate/")) { entered.get(request.url)?.resolve(); if (released.has(request.url)) response.end("released"); else held.set(request.url, response); return; }
    if (request.headers.authorization) { response.writeHead(400); response.end(); return; }
    const path = new URL(request.url, "http://fixture").pathname;
    const destination = request.headers["x-fixture-video-origin"] + path;
    counts.destinations[destination] = (counts.destinations[destination] ?? 0) + 1;
    const base_resp = { status_code: 0, status_msg: "success" }; let value;
    if (path === "/v1/video_generation") {
      counts.post++; current = String(++id); postStarted?.(); postStarted = undefined;
      if (mode === "early") { const task_id = current; earlyReply = () => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ task_id, base_resp })); }; request.resume(); return; }
      let text = ""; for await (const part of request) text += part;
      const body = JSON.parse(text); assert.ok(miniMaxFrozenVideoModels.includes(body.model)); assert.equal(body.duration, 6); counts.model = body.model;
      if (body.first_frame_image) { const bytes = Buffer.from(body.first_frame_image.split(",")[1], "base64"); counts.imageBytes = bytes.length; counts.imageDigest = createHash("sha256").update(bytes).digest("hex"); }
      value = { task_id: current, base_resp };
    } else if (path === "/v1/query/video_generation") {
      counts.poll++; const task_id = new URL(request.url, "http://fixture").searchParams.get("task_id");
      value = { task_id, status: mode === "unknown" ? "UNKNOWN" : mode === "pending" ? "Processing" : "Success", ...(mode === "pending" ? {} : { file_id: task_id + "1" }), base_resp };
    } else if (path === "/v1/files/retrieve") {
      counts.metadata++; value = { file: { file_id: new URL(request.url, "http://fixture").searchParams.get("file_id"), purpose: "video_generation", bytes: 16 * MiB }, base_resp };
    } else if (path === "/v1/files/retrieve_content") {
      counts.download++; const bytes = mp4(16 * MiB); response.writeHead(200, { "content-type": "application/json", "content-length": bytes.length }); response.end(bytes); return;
    } else { response.writeHead(404); response.end(); return; }
    if (mode === "maximum") {
      // The public projection replaces this untrusted URL with the bound file
      // link. Keep both the incoming and projected graphs at the admitted cap.
      if (value.status === "Success") value.video_url = "https://media.example/never-fetch";
      const units = path.includes("/files/") ? 2000 : 65530;
      value.ignored = { a: "x".repeat(units), b: "x".repeat(units), c: "x".repeat(units) };
      let nodes = 0; const count = x => { nodes++; if (x && typeof x === "object") for (const v of Object.values(x)) count(v); }; count(value);
      value.discarded = Array(4095 - nodes).fill(null);
      nodes = 0; count(value); assert.equal(nodes, 4096);
    }
    let text = JSON.stringify(value);
    if (mode === "maximum") text += " ".repeat((path.includes("/files/") ? 65536 : MiB) - Buffer.byteLength(text));
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }); response.end(text);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: "http://127.0.0.1:" + server.address().port, counts, nextPost() { assert.equal(postStarted, undefined); const started = Promise.withResolvers(); postStarted = started.resolve; return started.promise; }, replyEarly() { assert.ok(earlyReply); earlyReply(); earlyReply = undefined; }, current: () => current, entered(key) { const gate = Promise.withResolvers(); entered.set("/gate/" + key, gate); return gate.promise; }, mode(value) { mode = value; },
    release(key) { const path = "/gate/" + key; released.add(path); held.get(path)?.end("released"); held.delete(path); },
    releaseAll() { for (const [path, response] of held) { released.add(path); response.end("released"); } held.clear(); } };
}
const router = String.raw`
export {BudgetLedgerObject,UsageLedgerObject} from './worker/index.ts';
import {PolicyBindingIndexObject as PolicyBase} from './worker/index.ts';
export class PolicyBindingIndexObject extends PolicyBase { async fetch(request){if(new URL(request.url).pathname==='/fixture/alarm'){await this.alarm();return Response.json({settled:true});}return super.fetch(request);} }
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {configureVideo} from './worker/test/minimax-video-declaration-fixture.mjs';
import {authorityCall} from './worker/authority.ts';
import {GrantCredentialObject as BaseGrantCredentialObject,putGrantCredentials,inspectGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {miniMaxVideoBinding,miniMaxInlineVideoBinding,miniMaxSixModelVideoBinding,miniMaxCurrentCnVideoBinding,miniMaxCurrentCnInlineVideoBinding,miniMaxFrozenVideoModels} from './shared/minimax-video-binding.ts';
import {inputRetirement} from './worker/input-retirement.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged,BodyLease} from './worker/body-budget.ts';
import {MiniMaxVideoOperation,readVideoJson,inspectVideoJson} from './worker/minimax-video-operation.ts';
import {collectManagedPrediction} from './worker/managed-predictions.ts';
import {resolveResponseControlOwner} from './worker/response-controls.ts';
import {usageStub} from './worker/ledgers.ts';
const provider=snapshot.providers.find(p=>p.id==='minimax');configureVideo(provider,miniMaxFrozenVideoModels);const videoCards=provider.models.map(card=>({...card}));
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
const records=new WeakMap(),operationFetch=MiniMaxVideoOperation.prototype.fetch,providerFetch=MiniMaxVideoOperation.prototype.providerFetch;
function measure(response,a){if(!response.body)return response;const get=response.body.getReader.bind(response.body);response.body.getReader=options=>{const r=get(options);return {async read(...args){const part=await r.read(...args);if(part.value){a.nativeBytes=(a.nativeBytes??0)+part.value.byteLength;a.nativeMaxBacking=Math.max(a.nativeMaxBacking??0,part.value.buffer.byteLength);}return part;},cancel:x=>r.cancel(x),releaseLock:()=>r.releaseLock()};};return response;}
function counters(owner){let row=records.get(owner);if(!row){row={kind:owner.kind,ordinary:0,mandatory:0};records.set(owner,row);active?.exchanges.push(row);}return row;}
MiniMaxVideoOperation.prototype.fetch=function(start,mandatory=false,...rest){const row=counters(this);return operationFetch.call(this,signal=>{
 row[mandatory?'mandatory':'ordinary']++;return start(signal);
},mandatory,...rest);};
MiniMaxVideoOperation.prototype.providerFetch=function(start){const row=counters(this),a=active;
 if(a?.mode==='inline-late')this.track(gate(a,'execution-abort').then(()=>this.executionOperation.cancel(Error('controlled execution abort'))));
 return providerFetch.call(this,async signal=>{row.ordinary++;if(a)a.providerAttempts=(a.providerAttempts??0)+1;const response=await start(signal);if(a?.mode==='inline-late'){hold(response.body,a);a.readyReason??='response';a.ready.resolve();await gate(a,'arrival');}return a?measure(response,a):response;});};
const ownerFinish=MiniMaxVideoOperation.prototype.finish;
MiniMaxVideoOperation.prototype.finish=function(){const a=active;return ownerFinish.call(this).catch(e=>{if(a)a.cleanupFailure=e.code??e.name;throw e;});};
function fresh(mode){return active={mode,status:null,error:null,results:0,reads:0,cancels:0,unlocks:0,releases:0,maxBacking:0,actions:[],exchanges:[],controls:[],candidates:0,controlMaxValues:0,
 cleanup:false,readRetired:false,ready:deferred(),abort:new AbortController()};}
function heldObservation(a,request,stage){if(!a.attempt)return;
 console.log(JSON.stringify({phase:'held-observation',attempt:a.attempt,stage,readyReason:a.readyReason??'pending',
  reads:a.reads,nativeReads:a.nativeReads??0,firstNativeRead:a.firstNativeRead??'pending',results:a.results,status:a.status,
  error:typeof a.error==='string'&&/^[a-z][a-z0-9_]{0,63}$/i.test(a.error)?a.error:a.error==null?null:'other',
  bodyUsed:request.bodyUsed,locked:request.body?.locked??false,callerAborted:request.signal.aborted,controlAborted:a.abort.signal.aborted,providerAttempts:a.providerAttempts??0}));
}
function observeHeldRead(a,request){if(!a.attempt||!request.body)return;const get=request.body.getReader.bind(request.body);let first=true;
 request.body.getReader=options=>{const reader=get(options),read=reader.read.bind(reader);
  reader.read=(...args)=>{a.nativeReads=(a.nativeReads??0)+1;const pending=read(...args);
   if(first){first=false;void pending.then(()=>{a.firstNativeRead='fulfilled';heldObservation(a,request,'first-native-read');},()=>{a.firstNativeRead='rejected';heldObservation(a,request,'first-native-read');});}
   return pending;
  };return reader;
 };
}
async function paddedControl(response,a){
 if(!response.body||!response.headers.get('content-type')?.includes('application/json'))return response;
 const value=await response.json();
 if(value?.pools?.minimax)a.candidates=Math.max(a.candidates,value.pools.minimax.keys.length);
 const counts=inspectVideoJson(JSON.stringify(value));
 if(value&&typeof value==='object'&&!Array.isArray(value)){
 if(counts.values+3>512||counts.members+3>512)throw Error('fixture control has no padding room');
 const room=32768-counts.units-'fixtureAfixtureBfixtureC'.length;
 if(room<0)throw Error('fixture strings overflow');
 value.fixtureA='x'.repeat(Math.min(16384,room));value.fixtureB='x'.repeat(Math.min(16384,room-value.fixtureA.length));
 value.fixtureC=Array(512-counts.values-3).fill(null);
 }
 let text=JSON.stringify(value);const verified=inspectVideoJson(text);if(verified.values>512||text.length>65536)throw Error('fixture maximum malformed');
 a.controlMaxValues=Math.max(a.controlMaxValues,verified.values);text+=' '.repeat(65536-text.length);
 let at=0;return new Response(new ReadableStream({type:'bytes',pull(c){if(at===text.length){c.close();c.byobRequest?.respond(0);return;}
 const end=Math.min(at+16384,text.length);c.enqueue(new TextEncoder().encode(text.slice(at,end)));at=end;},cancel(){text='';}},{highWaterMark:0}),
 {status:response.status,headers:{'content-type':'application/json','content-length':'65536'}});
}

const state=()=>({charged:bodyBudgetCharged(),...(active?{mode:active.mode,status:active.status,locator:active.locator,error:active.error,results:active.results,
 reads:active.reads,cancels:active.cancels,unlocks:active.unlocks,materializations:active.materializations??0,inputReads:active.inputReads??0,inputCancels:active.inputCancels??0,inputUnlocks:active.inputUnlocks??0,inputMaxBacking:active.inputMaxBacking??0,releases:active.releases,maxBacking:active.maxBacking,actions:active.actions,
 providerAttempts:active.providerAttempts??0,failedControl:active.failedControl,cancelRejected:active.cancelRejected??false,cleanup:active.cleanup,cleanupFailure:active.cleanupFailure,readRetired:active.readRetired,locked:active.source?.locked??false,exchanges:active.exchanges,controls:active.controls,candidates:active.candidates,controlMaxValues:active.controlMaxValues,nativeBytes:active.nativeBytes,nativeMaxBacking:active.nativeMaxBacking}: {})});
BodyLease.prototype.release=function(){const before=bodyBudgetCharged();release.call(this);if(active&&before-bodyBudgetCharged()===96*1024*1024)active.releases++;};
const gate=(a,part)=>raw('https://video-gates.example/gate/'+a.mode+'/'+part,{redirect:'manual'}).then(async r=>{if(!r.ok)throw Error('gate refused');await r.text();});
const nativeDigest=crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest=async function(algorithm,data){const result=await nativeDigest(algorithm,data),a=active;if(a?.mode==='inline-hash-reject'&&data.byteLength>1024*1024)throw Error('controlled hash rejection');if(a?.mode==='inline-hash'&&data.byteLength>1024*1024){a.readyReason??='hash';a.ready.resolve();await gate(a,'hash');}return result;};
const registerUpload=MiniMaxVideoOperation.prototype.registerUpload;
MiniMaxVideoOperation.prototype.registerUpload=function(upload){const a=active;if(!a?.mode.startsWith('inline-upload'))return registerUpload.call(this,upload);
 const originalUpload={...upload},reader=originalUpload.body.getReader();a.source=originalUpload.body;let first=true,cancel,controller,stopped=false;
 // The pinned fetch drain targets256KiB. Let two batches traverse the fixture's
 // frontend/upstream hops before holding a read; server entry is STILL awaited.
 const holdRead=2*256*1024/16384+1;
 const input=inputRetirement({cancel(reason){return cancel??=(async()=>{a.cancels++;try{await reader.cancel(reason);}catch(error){a.cancelRejected=true;throw error;}finally{await gate(a,'cleanup');a.cleanup=true;if(a.mode==='inline-upload-reject')throw Error('held upload cleanup rejection');}})();},releaseLock(){a.unlocks++;reader.releaseLock();}});
 const retired=Promise.allSettled([originalUpload.retired,input.retired]).then(()=>cancel);void retired.catch(()=>{});
 const discard=()=>{stopped=true;try{controller?.error(Error('discarded'));}catch{}void originalUpload.discard().catch(()=>{});void input.retire('cancel').catch(()=>{});return retired;};
 const body=new ReadableStream({start(c){controller=c;},async pull(c){try{const result=await input.read(async()=>{a.reads++;try{return await reader.read();}finally{if(first&&a.reads===holdRead){first=false;a.readyReason??='first-read';a.ready.resolve();await gate(a,'read');a.readRetired=true;}}});if(stopped)return;if(result.done){await input.retire('eof');c.close();}else{a.maxBacking=Math.max(a.maxBacking,result.value.buffer.byteLength);c.enqueue(result.value);}}catch(e){if(!stopped)c.error(e);}},cancel:discard},{highWaterMark:0});
 Object.assign(upload,{body,retired,discard});return registerUpload.call(this,upload);
};

function hold(source,a){a.source=source;const get=source.getReader.bind(source);let first=true,cancel;
 source.getReader=options=>{const reader=get(options);return {
  async read(...args){a.reads++;try{const result=await reader.read(...args);if(result.value)a.maxBacking=Math.max(a.maxBacking,result.value.buffer.byteLength);return result;}
   finally{if(first){first=false;a.readyReason??='first-read';a.ready.resolve();await gate(a,'read');a.readRetired=true;}}},
  cancel(reason){return cancel??=(async()=>{a.cancels++;try{await reader.cancel(reason);}finally{await gate(a,'cleanup');a.cleanup=true;if(a.mode==='cleanup-reject')throw Error('synthetic cleanup rejection');}})();},
  releaseLock(){reader.releaseLock();a.unlocks++;}
 };};
}
function controlled(env,a){const grants=env.GRANT_CREDENTIALS,authority=env.ACCESS_CONTROL;return {...env,
 GRANT_CREDENTIALS:{idFromName:n=>grants.idFromName(n),get:id=>{const stub=grants.get(id);return {async fetch(input,init){
  const path=new URL(input).pathname;a.controls.push('grant:'+path);if(path==='/materialize')a.materializations=(a.materializations??0)+1;const response=await stub.fetch(input,init);
  if(!response.ok)a.failedControl={owner:'grant',path,status:response.status};
  if(path==='/responses/control')measure(response,a);
  if(path==='/responses/control'&&['poll-read','file-read','cleanup-reject','late'].includes(a.mode)){
   if(a.mode!=='file-read'||JSON.parse(init.body).file?.action==='download'){hold(response.body,a);if(a.mode==='late'){a.ready.resolve();await gate(a,'arrival');}}
  }return a.mode.startsWith('combined')&&path!=='/responses/control'?paddedControl(response,a):response;
 }}}},
 ACCESS_CONTROL:{idFromName:n=>authority.idFromName(n),get:id=>{const stub=authority.get(id);return {async fetch(input,init){
  const path=new URL(input).pathname,packet=JSON.parse(init.body);a.controls.push('authority:'+path);if(path==='/responses-background')a.actions.push(packet.action);
  const response=await stub.fetch(input,init);
  if(!response.ok)a.failedControl={owner:'authority',path,status:response.status};
  if(path==='/authorization/snapshot'&&['inline-revoke','inline-rotate','inline-freeze-held','cn-revoke','cn-rotate','cn-expire','cn-inline-revoke','cn-inline-rotate','cn-inline-expire','cn-inline-account','cn-inline-v4'].includes(a.mode)&&(a.snapshots=(a.snapshots??0)+1)===3){
   if(a.mode==='inline-freeze-held'){hold(response.body,a);const headers=new Headers(response.headers);headers.set('content-type','text/plain');return new Response(response.body,{status:response.status,headers});}
   a.ready.resolve();await gate(a,'authority');
  }
  if(path==='/responses-background'&&packet.action==='dispatch'){
   if(a.mode==='lost-ack'){await response.body.cancel();throw Error('synthetic lost ACK');}
   if(a.mode==='confirmed-revoke')await revokeGrantCredentials(env,key,undefined,undefined,undefined,actor);
  }return a.mode.startsWith('combined')?paddedControl(response,a):response;
 }}}}};
}
export default {async fetch(request,bindings,ctx){const env={...bindings,...ACCESS_ENV},u=new URL(request.url);
 if(u.pathname.startsWith("/v1/admin/"))return worker.fetch(request,env,ctx);
 if(u.pathname==="/fixture/user"){await authorityCall(env,"/users/put",{email:"music-admin@example.invalid",record:{role:u.searchParams.get("role")??"admin",enabled:u.searchParams.get("enabled")!=="false",tenantId:"fixture",groups:[]}});return Response.json({updated:true});}
 if(["/fixture/arm","/fixture/pin"].includes(u.pathname))return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName("oauth/fixture/video-admin-"+u.searchParams.get("mode"))).fetch("https://owner"+u.pathname+"?mode="+u.searchParams.get("mode"));
 if(u.pathname==='/fixture/card'){
  provider.models=videoCards.map(card=>({...card}));const card=provider.models.find(card=>card.upstream==='I2V-01-Director'),kind=u.searchParams.get('kind');
  if(kind==='missing')delete card.upstream;
  if(kind==='foreign')card.upstream='foreign/I2V-01-Director';
  if(kind==='duplicate')provider.models.push({...card});
  if(kind==='ambiguous')provider.models.push({...card,id:'minimax/ambiguous-director'});
  return Response.json({configured:true});
 }
 if(u.pathname==='/state')return Response.json(state());
 if(u.pathname==='/contend'){const l=new BodyLease();try{const allowed=l.grow(1024*1024);return Response.json({allowed,charged:bodyBudgetCharged()});}finally{l.release();}}
 if(u.pathname==='/setup'){
  const policy={enabled:true,generation:'g1',providers:['minimax'],tenantId:'fixture',dailyBudgetMicros:100000,weeklyBudgetMicros:100000,monthlyBudgetMicros:100000,requestCostMicros:u.searchParams.has('unpriced')?null:700,retainRequestContent:false,
    grantRouting:{eligibleGrants:{minimax:['video']},environmentFallback:true,failover:true}};
  await authorityCall(env,'/users/initialize-all',[{email:actor.email,record:{enabled:true,role:'admin',tenantId:'fixture',groups:[]}}]);
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy}]);
  await authorityCall(env,'/policies/put',{policyId:'fixture',policy});
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1',principalId:actor.email}}]);
  await authorityCall(env,'/connections/initialize-all',[{providerId:'minimax',enabled:true,monthlyBudgetMicros:100000}]);
  await putGrantCredentials(env,key,{provider:'minimax',kind:'api_key',enabled:true,credential:'synthetic-video-key',accountId:'synthetic-account',expiresAt:null,...(u.searchParams.has('import')?{minimaxVideoBinding:u.searchParams.has('cninline')?miniMaxCurrentCnInlineVideoBinding():u.searchParams.has('currentcn')?miniMaxCurrentCnVideoBinding():u.searchParams.has('six')?miniMaxSixModelVideoBinding():miniMaxInlineVideoBinding()}: {})},false,undefined,
    undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,u.searchParams.has('import')?undefined:u.searchParams.has('cninline')?miniMaxCurrentCnInlineVideoBinding():u.searchParams.has('currentcn')?miniMaxCurrentCnVideoBinding():u.searchParams.has('six')?miniMaxSixModelVideoBinding():u.searchParams.has('inline')?miniMaxInlineVideoBinding():miniMaxVideoBinding(u.searchParams.get('region')??'global'),actor);
  return Response.json({ready:true});
 }
 if(u.pathname==='/maximum-pool'){
  // Determine the reachable boundary using genuine owner attestations and the
  // actual SQL admission guard. Every probe is setup, not an inference ticket.
  const policy={enabled:true,generation:'g1',providers:['minimax'],tenantId:'fixture',dailyBudgetMicros:100000,weeklyBudgetMicros:100000,monthlyBudgetMicros:100000,
   requestCostMicros:700,retainRequestContent:false,grantRouting:{environmentFallback:false,failover:false}};
  await authorityCall(env,'/policies/put',{policyId:'fixture',policy});
  const input={video:'clawrouter.minimax-video.v1',credentialId:'fixture',secretSha256:await sha256Hex('fixture-secret'),providers:[{id:'minimax',tokenRef:'minimax'}],
   selection:{providerId:'minimax',endpointId:'video',mode:'http',model:'MiniMax-Hailuo-2.3',catalogModelId:'minimax/MiniMax-Hailuo-2.3',capability:'media.predict'}};
  const probe=()=>env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings')).fetch('https://owner/admission/resolve',{method:'POST',body:JSON.stringify(input)});
  let candidates=1,overflow=null;
  for(let i=1;i<32;i++){
   const name='oauth/fixture/maximum'+i;
   await putGrantCredentials(env,name,{provider:'minimax',kind:'api_key',enabled:true,credential:'synthetic-video-key',accountId:'synthetic-account'},false,undefined,
    undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,u.searchParams.has('cninline')?miniMaxCurrentCnInlineVideoBinding():u.searchParams.has('six')?miniMaxSixModelVideoBinding():u.searchParams.has('inline')?miniMaxInlineVideoBinding():miniMaxVideoBinding('global'),actor);
   const response=await probe(),body=await response.json();
   if(!response.ok){overflow={count:i+1,status:response.status,code:body.error?.code};await revokeGrantCredentials(env,name,undefined,undefined,undefined,actor);break;}
   if(!body.selection?.selected)throw Error('maximum fixture lost all eligible candidates');candidates=body.pools.minimax.keys.length;
  }
  const verified=await probe(),body=await verified.json();if(!verified.ok||body.pools.minimax.keys.length!==candidates)throw Error('maximum restoration failed');
  return Response.json({candidates,overflow});
 }
 if(u.pathname==='/slots'){
  const locator=u.searchParams.get('locator');if(!/^[a-f0-9]{64}\.bg_[a-f0-9]{32}$/.test(locator))throw Error('fixture locator');
  const [scope,id]=locator.split('.'),stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('http-continuations:'+scope)),
   job=await (await stub.fetch('https://owner/responses-background',{method:'POST',body:JSON.stringify({action:'get',id})})).json();
  const a=fresh('slots'),owner=new MiniMaxVideoOperation('poll',request),ready=Array.from({length:4},deferred),cleanup=deferred();
  const work=ready.map((r,i)=>owner.controlJson({},async(text,signal)=>{
   const response=await env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key)).fetch('https://owner/inspect',{method:'POST',body:text,signal});
   const get=response.body.getReader.bind(response.body);let first=true,cancel;
   response.body.getReader=options=>{const reader=get(options);return {
    async read(...args){try{return await reader.read(...args);}finally{if(first){first=false;r.resolve();await gate(a,'read'+i);a.readRetired=true;}}},
    cancel(reason){return cancel??=(async()=>{a.cancels++;await reader.cancel(reason);if(a.cancels===4)cleanup.resolve();await gate(a,'cleanup'+i);a.cleanupDone=(a.cleanupDone??0)+1;a.cleanup=a.cleanupDone===4;})();},
    releaseLock(){reader.releaseLock();a.unlocks++;}
   };};return response;
  }));
  for(const p of work)void p.catch(()=>{});
  ctx.waitUntil((async()=>{try{await Promise.all(ready.map(r=>r.promise));owner.operation.cancel(Error('controlled all-slot cancel'));await cleanup.promise;
   const ack=await owner.controlJson({action:'managed_files',id,responseId:job.managed.upstreamId,files:job.managed.files},
    (text,signal)=>stub.fetch('https://owner/responses-background',{method:'POST',body:text,signal}),true);
   if(!Array.isArray(ack.files))throw Error('mandatory ACK absent');a.status=200;a.ready.resolve();await Promise.allSettled(work);
  }catch(e){a.error=e.code??e.name;a.ready.resolve();}finally{await owner.finish();a.results++;}})());
  await a.ready.promise;return Response.json(state());
 }
 if(u.pathname==='/scope-overflow'){
  const kind=u.searchParams.get('kind'),a=fresh('scope-overflow'),owner=new MiniMaxVideoOperation(kind,request);let lookups=0,code;
  try{await resolveResponseControlOwner({...env,ACCESS_CONTROL:{idFromName:n=>n,get(){lookups++;throw Error('unreachable lookup');}}},
   Array(kind==='file'?12:16).fill({}),'synthetic',owner.operation,'minimax','video',undefined,owner);}catch(e){code=e.code??e.name;}finally{await owner.finish();}
  return Response.json({code,lookups,charged:bodyBudgetCharged(),exchanges:a.exchanges});
 }
 if(u.pathname==='/collect'){
  const locator=u.searchParams.get('locator');if(!/^[a-f0-9]{64}\.bg_[a-f0-9]{32}$/.test(locator))throw Error('fixture locator');
  const [scope,id]=locator.split('.'),reply=await env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('http-continuations:'+scope))
   .fetch('https://owner/responses-background',{method:'POST',body:JSON.stringify({action:'get',id})}),job=await reply.json();
  const a=fresh('collector'),competing=new BodyLease();let accepted=0,error;
  if(u.searchParams.has('missing'))job.facts=null;
  if(u.searchParams.has('version'))job.managed.requestedVersion=u.searchParams.get('version');
  if(u.searchParams.has('foreign-owner'))job.owner.grantKey='oauth/fixture/unattested-video';
  if(u.searchParams.has('deny'))await authorityCall(env,'/users/put',{email:actor.email,record:{enabled:false,role:'admin',tenantId:'fixture',groups:[]}});
  try{if(u.searchParams.has('contend')){if(!competing.grow(1024*1024))throw Error('fixture competition');}
   await collectManagedPrediction(controlled(env,a),job,async()=>{accepted++;});
  }catch(e){error=e.code??e.name;}finally{competing.release();if(u.searchParams.has('deny'))await authorityCall(env,'/users/put',{email:actor.email,record:{enabled:true,role:'admin',tenantId:'fixture',groups:[]}});}
  return Response.json({...state(),accepted,error});
 }
 if(u.pathname==='/revoke'){await revokeGrantCredentials(env,key,undefined,undefined,undefined,actor);return Response.json({revoked:true});}
 if(u.pathname==='/rotate'){await putGrantCredentials(env,key,{credential:'synthetic-rotated-video-key'},true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,u.searchParams.has('cninline')?miniMaxCurrentCnInlineVideoBinding():u.searchParams.has('currentcn')?miniMaxCurrentCnVideoBinding():u.searchParams.has('six')?miniMaxSixModelVideoBinding():miniMaxInlineVideoBinding(),actor);return Response.json({rotated:true});}
 if(u.pathname==='/expire'){await putGrantCredentials(env,key,{expiresAt:new Date(Date.now()-1).toISOString()},true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,u.searchParams.has('cninline')?miniMaxCurrentCnInlineVideoBinding():miniMaxCurrentCnVideoBinding(),actor);return Response.json({expired:true});}
 if(u.pathname==='/account'){await putGrantCredentials(env,key,{accountId:'synthetic-rebound-account'},true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,miniMaxCurrentCnInlineVideoBinding(),actor);return Response.json({rebound:true});}
 if(u.pathname==='/reattest-cn'){await putGrantCredentials(env,key,{},true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,u.searchParams.has('legacy')?miniMaxVideoBinding('cn'):miniMaxCurrentCnVideoBinding(),actor);return Response.json({attested:true});}
 if(u.pathname==='/metadata-edit'){await putGrantCredentials(env,key,{label:'metadata changed'},true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,actor);return Response.json({changed:true});}
 if(u.pathname==='/settle'){const locator=u.searchParams.get('locator');if(!/^[a-f0-9]{64}\.bg_[a-f0-9]{32}$/.test(locator))return new Response(null,{status:400});return env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('http-continuations:'+locator.split('.')[0])).fetch('https://owner/fixture/alarm');}
 if(u.pathname==='/events')return usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin');
 if(u.pathname==='/job'){const locator=u.searchParams.get('locator');if(!/^[a-f0-9]{64}\.bg_[a-f0-9]{32}$/.test(locator))return new Response(null,{status:400});
  const [scope,id]=locator.split('.');return env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('http-continuations:'+scope)).fetch('https://owner/responses-background',{method:'POST',body:JSON.stringify({action:'get',id})});}
 if(u.pathname==='/bounded-reader'){
  const owner=new MiniMaxVideoOperation('create',request),get=request.body.getReader.bind(request.body);let empty=Number(u.searchParams.get('empty')??0),reads=0,maxBacking=0;
  request.body.getReader=options=>{const r=get(options);return {async read(...args){reads++;if(empty-->0)return {done:false,value:args[0].subarray(0,0)};const part=await r.read(...args);if(part.value)maxBacking=Math.max(maxBacking,part.value.buffer.byteLength);return part;},cancel:x=>r.cancel(x),releaseLock:()=>r.releaseLock()};};
  let ok=false,error;try{await readVideoJson(request,owner.controlSignal,'input',owner.registerInput);ok=true;}catch(e){error=e.code??e.name;}finally{await owner.finish();}
  return Response.json({ok,error,reads,maxBacking,charged:bodyBudgetCharged()});
 }
 if(!['/call','/held','/scenario','/max-held'].includes(u.pathname))return new Response(null,{status:404});
 const target=u.searchParams.get('target');if(!target?.startsWith('/v1/'))return new Response(null,{status:400});
 const headers=new Headers(request.headers);headers.set('authorization','Bearer clawrouter-live-fixture-fixture-secret');
 const a=fresh(u.searchParams.get('mode')??'normal');
 const attempt=u.searchParams.get('attempt');if(u.pathname==='/held'&&/^(GLOBAL|CN):(upload|inline-hash|inline-upload|inline-upload-reject|inline-late):[1-5]$/.test(attempt??'')){
  a.attempt=attempt;heldObservation(a,request,'entry');observeHeldRead(a,request);
 }
 if(request.body&&a.mode.startsWith('inline-raw')){const get=request.body.getReader.bind(request.body);let empty=Number(u.searchParams.get('empty')??0),eof=false;const total=Number(u.searchParams.get('total')??0),fragment=Number(u.searchParams.get('fragment')??16384);
 request.body.getReader=options=>{const r=get(options);return {async read(view){a.inputReads=(a.inputReads??0)+1;let part;
 if(eof)part={done:a.inputReads>=total,value:view.subarray(0,0)};
 else if(empty-->0)part={done:false,value:view.subarray(0,0)};else part=await r.read(view.subarray(0,Math.min(fragment,view.length)));
 if(part.done&&total>a.inputReads){eof=true;const backing=part.value?.buffer?.byteLength?new Uint8Array(part.value.buffer):new Uint8Array(16384);part={done:false,value:backing.subarray(0,0)};}
 if(a.mode==='inline-raw-backing'&&part.value?.length){const huge=new Uint8Array(16385);huge.set(part.value.subarray(0,1));part={done:false,value:huge.subarray(0,1)};}
 if(part.value)a.inputMaxBacking=Math.max(a.inputMaxBacking??0,part.value.buffer.byteLength);return part;},
 cancel(reason){a.inputCancels=(a.inputCancels??0)+1;return r.cancel(reason);},releaseLock(){a.inputUnlocks=(a.inputUnlocks??0)+1;r.releaseLock();}};};}

 if(u.pathname==='/call')return worker.fetch(new Request('https://router.example'+target,{method:request.method,headers,body:request.body,signal:request.signal}),controlled(env,a),ctx);
 if(u.pathname==='/max-held'){
  ctx.waitUntil((async()=>{const response=await worker.fetch(new Request('https://router.example'+target,{method:request.method,headers,body:request.body,signal:request.signal}),controlled(env,a),ctx);
   a.status=response.status;a.locator=response.headers.get('x-clawrouter-background-recovery');a.ready.resolve();await gate(a,'output');const reader=response.body.getReader();try{for(;;){const part=await reader.read();if(part.done)break;a.reads++;}}finally{reader.releaseLock();}a.results++;})().catch(e=>{a.error=e.code??e.name;a.results++;a.ready.resolve();}));
  await a.ready.promise;return Response.json(state());
 }
 if(u.pathname==='/scenario')return worker.fetch(new Request('https://router.example'+target,{method:request.method,headers,body:request.body,signal:request.signal}),controlled(env,a),ctx);
 if(['upload','inline-header-held'].includes(a.mode))hold(request.body,a);
 const routed=new Request('https://router.example'+target,{method:request.method,headers,body:request.body,signal:a.abort.signal});
 ctx.waitUntil(gate(a,'abort').then(()=>a.abort.abort(new Error('controlled caller cancellation'))));
 ctx.waitUntil(worker.fetch(routed,controlled(env,a),ctx).then(async r=>{a.status=r.status;try{const b=await r.json();a.error=b.error?.code??null;}catch{}a.results++;a.readyReason??='result';a.ready.resolve();}).catch(e=>{a.error=e.code??e.name;a.results++;a.readyReason??='exception';a.ready.resolve();}));
 await a.ready.promise;heldObservation(a,request,'before-return');return Response.json(state());
},queue:worker.queue};
`;
const upstream = (origin, jwk) => String.raw`
export default {async fetch(request){const u=new URL(request.url);
 if(u.href==='https://music-admin-fixture.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json({keys:[JWK]});
 if(u.origin==='https://video-gates.example')return fetch(ORIGIN+u.pathname,{redirect:'manual',signal:request.signal});
 if(!['https://api.minimax.io','https://api.minimaxi.com','https://api.minimax.cn'].includes(u.origin)||request.headers.get('authorization')!=='Bearer synthetic-video-key')throw Error('unqualified video destination');
 return fetch(ORIGIN+u.pathname+u.search,{method:request.method,body:request.body,headers:{'content-type':'application/json','x-fixture-video-origin':u.origin},signal:request.signal,redirect:'manual'});
}};`.replaceAll('ORIGIN',JSON.stringify(origin)).replace('JWK',JSON.stringify(jwk));

test("isolated workerd Hailuo original owner, restart/file, full charge and physical retirement", { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "hailuo-owned-runtime-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const io = await external(t), access = await musicAccessFixture(), script = router.replace("ACCESS_ENV", JSON.stringify(access.env)); let runtime = await isolated(directory, script, upstream(io.origin, access.jwk));
  t.after(async () => { io.releaseAll(); await runtime.dispose(); });
  const request = (path, init) => runtime.dispatchFetch("https://router.example" + path, { ...init, redirect: "manual" });
  const json = async path => { const r = await request(path); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const call = (target, body, headers = {}, kind = "call", mode = "") => request("/" + kind + "?mode=" + mode + "&target=" + encodeURIComponent(target), {
    ...(body == null ? {} : { method: "POST", body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) }), headers: { "content-type": "application/json", ...headers } });
  const idle = async () => { let s; for (let i = 0; i < 100; i++) { s = await json("/state"); if (!s.charged) return s; await delay(10); } assert.fail(JSON.stringify(s)); };
  const native = "/v1/native/minimax/v1/video_generation";
  let task, filePath, locator;
  for (const region of ["global", "cn"]) for (const model of hailuoModels) for (const manifest of [false, true]) {
    assert.deepEqual(await json("/setup?region=" + region), { ready: true }); io.mode("maximum");
    const value = manifest ? { body: { ...videoInput(model), model: "minimax/" + model } } : videoInput(model), text = JSON.stringify(value);
    const r = await call(manifest ? "/v1/proxy/minimax/video" : native, text + " ".repeat(65536 - Buffer.byteLength(text)), { "idempotency-key": region + model + manifest });
    assert.equal(r.status, 200, await r.clone().text()); locator = r.headers.get("x-clawrouter-background-recovery"); task = (await r.json()).task_id; let counts = await idle();
    assert.equal(counts.exchanges.length, 1); assert.equal(counts.exchanges[0].kind, "create");
    assert.ok(counts.exchanges[0].ordinary <= 16); assert.ok(counts.exchanges[0].mandatory <= 5);
    assert.equal(counts.exchanges[0].ordinary + counts.exchanges[0].mandatory, counts.controls.length + 1);
    await runtime.dispose(); runtime = await isolated(directory, script, upstream(io.origin, access.jwk));
    const pollPath = (manifest ? "/v1/proxy/minimax/task?task_id=" : "/v1/native/minimax/v1/query/video_generation?task_id=") + task;
    const p = await call(pollPath, null); assert.equal(p.status, 200, await p.clone().text()); const body = await p.json(); counts = await idle();
    assert.equal(counts.exchanges.length, 1); assert.equal(counts.exchanges[0].kind, "poll");
    assert.ok(counts.exchanges[0].ordinary <= 8); assert.ok(counts.exchanges[0].mandatory <= 2);
    assert.equal(counts.exchanges[0].ordinary + counts.exchanges[0].mandatory, counts.controls.length);
    assert.equal(body.status, "Success"); filePath = body.video_url;
    assert.equal(filePath, "/v1/native/minimax/v1/files/retrieve_content?file_id=" + task + "1");
    const f = await call(filePath, null, { "x-clawrouter-job-id": task }); if (f.status !== 200) assert.fail(await f.text());
    assert.equal(f.headers.get("content-type"), "video/mp4"); assert.equal((await f.arrayBuffer()).byteLength, 16 * MiB); counts = await idle();
    assert.equal(counts.exchanges.length, 1); assert.equal(counts.exchanges[0].kind, "file");
    assert.ok(counts.exchanges[0].ordinary <= 12); assert.equal(counts.exchanges[0].mandatory, 0);
    assert.equal(counts.exchanges[0].ordinary, counts.controls.length);
    const job = await json("/job?locator=" + encodeURIComponent(locator)); assert.equal(job.basis ?? job.event?.cost_basis, "policy_fixed"); assert.equal(job.amount ?? job.event?.actual_cost_micros, 700);
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
    if (mode === "late") {
      assert.equal(s.reads, 0); assert.equal(s.readRetired, false);
      io.release(mode + "/cleanup"); s = await idle();
      assert.equal(s.cleanup, true); assert.equal(s.reads, 0); assert.equal(s.readRetired, false);
    } else {
      assert.ok(s.reads >= 1); io.release(mode + "/cleanup");
      for (let i = 0; i < 100; i++) { s = await json("/state"); if (s.cleanup) break; await delay(10); }
      assert.equal(s.cleanup, true); assert.equal(s.charged, 96 * MiB); assert.equal(s.locked, true);
      io.release(mode + "/read"); s = await idle(); assert.equal(s.readRetired, true);
    }
    assert.equal(s.releases, 1); assert.equal(s.unlocks, 1); assert.ok(s.maxBacking <= 16384);
  }
  for (const mode of ["lost-ack", "confirmed-revoke"]) {
    await json("/setup"); const before = io.counts.post;
    const r = await call(native, videoInput(), {}, "scenario", mode); assert.equal(r.status, 503, await r.clone().text()); const error = await r.json();
    assert.equal(error.error.code, mode === "confirmed-revoke" ? "prediction_submission_unsent" : "prediction_submission_unknown"); await idle();
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

  await json("/setup");
  const pool = await json("/maximum-pool"); assert.ok(pool.candidates >= 2 && pool.candidates <= 32, JSON.stringify(pool));
  if (pool.candidates < 32) { assert.equal(pool.overflow.count, pool.candidates + 1); assert.ok(pool.overflow.status >= 400); }
  io.mode("maximum");
  for (const kind of ["create", "poll", "file"]) {
    const mode = "combined-" + kind;
    const target = kind === "create" ? native : kind === "poll" ? "/v1/native/minimax/v1/query/video_generation?task_id=" + task
      : "/v1/native/minimax/v1/files/retrieve_content?file_id=" + task + "1";
    const text = JSON.stringify({ ...videoInput(), prompt: "x".repeat(2000) });
    const response = await call(target, kind === "create" ? text + " ".repeat(65536 - Buffer.byteLength(text)) : null,
      { "x-clawrouter-job-id": task, "idempotency-key": "combined-maximum" }, "max-held", mode);
    let state = await response.json(); assert.equal(state.status, 200, JSON.stringify(state));
    assert.equal(state.charged, 96 * MiB); assert.equal(state.candidates, pool.candidates); assert.equal(state.controlMaxValues, 512);
    assert.equal(state.exchanges.length, 1); const exchange = state.exchanges[0]; assert.equal(exchange.kind, kind);
    assert.ok(exchange.ordinary <= { create: 16, poll: 8, file: 12 }[kind]); assert.ok(exchange.mandatory <= { create: 5, poll: 2, file: 0 }[kind]);
    assert.equal(exchange.ordinary + exchange.mandatory, state.controls.length + (kind === "create" ? 1 : 0));
    assert.equal(state.nativeBytes, kind === "file" ? 16 * MiB + 65536 : MiB); assert.ok(state.nativeMaxBacking <= 16384);
    assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB }); assert.equal(state.releases, 0);
    if (kind === "create") { task = io.current(); locator = state.locator; }
    io.release(mode + "/output"); state = await idle(); assert.equal(state.results, 1); assert.equal(state.releases, 1);
    if (kind === "create") {
      const denied = await json("/collect?contend=1&locator=" + encodeURIComponent(locator));
      assert.equal(denied.error, "server_overloaded"); assert.equal(denied.accepted, 0); assert.deepEqual(denied.exchanges, []);
      for (const refusal of ["missing", "deny"]) {
        const before = io.counts.poll, refused = await json("/collect?" + refusal + "=1&locator=" + encodeURIComponent(locator));
        assert.equal(refused.accepted, 0); assert.ok(refused.error, JSON.stringify(refused)); assert.equal(refused.charged, 0); assert.equal(io.counts.poll, before);
      }
      const collected = await json("/collect?locator=" + encodeURIComponent(locator));
      assert.equal(collected.accepted, 1, JSON.stringify(collected)); assert.deepEqual(collected.exchanges, [{ kind: "collector", ordinary: 4, mandatory: 0 }]);
      assert.equal(collected.controls.length, 4); assert.equal(collected.charged, 0);
    }
  }
  const slots = await json("/slots?locator=" + encodeURIComponent(locator));
  assert.equal(slots.status, 200, JSON.stringify(slots)); assert.equal(slots.cancels, 4); assert.equal(slots.unlocks, 0);
  assert.equal(slots.charged, 96 * MiB); assert.deepEqual(slots.exchanges, [{ kind: "poll", ordinary: 4, mandatory: 1 }]);
  assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB });
  for (let i = 0; i < 4; i++) io.release("slots/cleanup" + i);
  for (let i = 0; i < 100; i++) { const s = await json("/state"); if (s.cleanup) break; await delay(10); }
  const pending = await json("/state"); assert.equal(pending.cleanup, true); assert.equal(pending.charged, 96 * MiB); assert.equal(pending.unlocks, 0);
  for (let i = 0; i < 4; i++) io.release("slots/read" + i); const retired = await idle(); assert.equal(retired.unlocks, 4); assert.equal(retired.releases, 1);
  for (const kind of ["poll", "file"]) {
    const result = await json("/scope-overflow?kind=" + kind);
    assert.equal(result.code, "minimax_video_control_limit"); assert.equal(result.lookups, 0); assert.equal(result.charged, 0); assert.deepEqual(result.exchanges, []);
  }

});

test("isolated workerd full8MiB global inline frames, original receipts and physical upload/hash custody", { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "hailuo-inline-runtime-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const io = await external(t), access = await musicAccessFixture(), script = router.replace("ACCESS_ENV", JSON.stringify(access.env));
  const runtime = await isolated(directory, script, upstream(io.origin, access.jwk));
  t.after(async () => { io.releaseAll(); await runtime.dispose(); });
  const request = (path, init) => runtime.dispatchFetch("https://router.example" + path, { ...init, redirect: "manual" });
  const json = async path => { const response = await request(path); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const call = (target, body, headers = {}, kind = "call", mode = "", attempt = "") => request("/" + kind + "?mode=" + mode + "&target=" + encodeURIComponent(target) + (attempt ? "&attempt=" + attempt : ""), {
    ...(body == null ? {} : { method: "POST", body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) }), headers: { "content-type": "application/json", ...headers } });
  const idle = async () => { let state; for (let i = 0; i < 100; i++) { state = await json("/state"); if (!state.charged) return state; await delay(10); } assert.fail(JSON.stringify(state)); };
  const native = "/v1/native/minimax/v1/video_generation";
  let last, lastBody, lastLocator;
  for (const mime of ["image/png", "image/jpeg", "image/webp"]) for (const model of hailuoModels) for (const manifest of [false, true]) {
    await json("/setup?inline=1"); io.mode("maximum");
    const image = inlineImage(mime), digest = createHash("sha256").update(image).digest("hex");
    const input = { ...videoInput(model), first_frame_image: uri(image, mime) };
    const body = manifest ? { body: { ...input, model: "minimax/" + model } } : input;
    const target = manifest ? "/v1/proxy/minimax/video" : native;
    const key = mime.replace("/", "-") + model + manifest, before = io.counts.post;
    const response = await call(target, body, { "idempotency-key": key });
    assert.equal(response.status, 200, await response.clone().text());
    const locator = response.headers.get("x-clawrouter-background-recovery"), created = await response.json();
    const state = await idle();
    assert.equal(io.counts.post, before + 1); assert.equal(io.counts.imageBytes, 8 * MiB); assert.equal(io.counts.imageDigest, digest);
    assert.equal(state.exchanges.length, 1); assert.ok(state.exchanges[0].ordinary <= 16); assert.ok(state.exchanges[0].mandatory <= 5);
    assert.equal(state.exchanges[0].ordinary + state.exchanges[0].mandatory, state.controls.length + 1);
    assertInlineCreateCalls(state, { lookup: true });
    assert.equal(state.nativeBytes, MiB); assert.ok(state.nativeMaxBacking <= 16384); assert.equal(state.releases, 1);
    const repeat = await call(target, body, { "idempotency-key": key }); assert.equal(repeat.status, 303); await repeat.text(); await idle();
    assert.equal(io.counts.post, before + 1);
    const changed = { ...input, prompt: input.prompt + " changed" };
    const conflict = await call(target, manifest ? { body: { ...changed, model: "minimax/" + model } } : changed, { "idempotency-key": key });
    assert.equal(conflict.status, 409, await conflict.clone().text()); await conflict.text(); await idle(); assert.equal(io.counts.post, before + 1);
    const changedImage = { ...input, first_frame_image: uri(inlineImage("image/png", 1024)) };
    const imageConflict = await call(target, manifest ? { body: { ...changedImage, model: "minimax/" + model } } : changedImage, { "idempotency-key": key });
    assert.equal(imageConflict.status, 409, await imageConflict.clone().text()); await imageConflict.text(); await idle(); assert.equal(io.counts.post, before + 1);
    const polled = await call("/v1/native/minimax/v1/query/video_generation?task_id=" + created.task_id, null);
    assert.equal(polled.status, 200, await polled.clone().text()); assert.equal((await polled.json()).status, "Success"); await idle();
    assert.deepEqual(await json("/settle?locator=" + encodeURIComponent(locator)), { settled: true });
    let event;
    for (let i = 0; i < 100; i++) {
      const events = (await json("/events")).events;
      if (events.length === io.counts.post) { event = events.at(-1); break; }
      await delay(10);
    }
    assert.ok(event); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 700); assert.equal(event.total_tokens, null);
    last = created.task_id; lastBody = input; lastLocator = locator;
  }
  assert.equal(io.counts.post, 12);

  // These requests enter the new inline reader through the actual Worker/DO
  // route. Raw Uint8Arrays bypass string re-encoding, including invalid UTF8.
  const small = { ...videoInput(), first_frame_image: uri(inlineImage("image/png", 1024)) };
  const raw = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  const paddingMutation = size => {
    const value = uri(inlineImage("image/png", size)), padding = value.endsWith("==") ? 2 : 1;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", at = value.length - padding - 1;
    return value.slice(0, at) + alphabet[alphabet.indexOf(value[at]) + 1] + value.slice(at + 1);
  };
  const validUtf8 = raw({ ...small, prompt: "Synthetic \u00e9 \ud83e\udd8a" });
  const prefix = Buffer.from('{"prompt":"'), suffix = Buffer.from('","model":"MiniMax-Hailuo-2.3","duration":6,"resolution":"768P","first_frame_image":' + JSON.stringify(small.first_frame_image) + '}');
  const malformedUtf8 = Buffer.concat([prefix, Buffer.from([0xc3]), suffix]);
  let deep = null; for (let i = 0; i < 17; i++) deep = { a: deep };
  const cases = [
    ["canonical-padding2", raw(small), true, ""],
    ["canonical-padding1", raw({ ...small, first_frame_image: uri(inlineImage("image/png", 1025)) }), true, ""],
    ["canonical-padding0", raw({ ...small, first_frame_image: uri(inlineImage("image/png", 1026)) }), true, ""],
    ["mime", raw({ ...small, first_frame_image: uri(inlineImage("image/png", 1024), "image/jpeg") }), false, ""],
    ["container", raw({ ...small, first_frame_image: "data:image/png;base64,AAAA" }), false, ""],
    ["padding-bits2", raw({ ...small, first_frame_image: paddingMutation(1024) }), false, ""],
    ["padding-bits1", raw({ ...small, first_frame_image: paddingMutation(1025) }), false, ""],
    ["fragmented-utf8", validUtf8, true, "&fragment=1"],
    ["malformed-utf8", malformedUtf8, false, "&fragment=1"],
    ["decoded-plus-one", raw({ ...small, first_frame_image: uri(inlineImage("image/png", 8 * MiB + 1)) }), false, ""],
    ["trailing-json", Buffer.concat([raw(small), Buffer.from("!")]), false, ""],
    ["read8192", raw(small), true, "&total=8192"],
    ["read8193", raw(small), false, "&total=8193"],
    ["backing", raw(small), false, ""],
    ["graph", raw({ ...small, discarded: Array(128).fill(null) }), false, ""],
    ["depth", raw({ ...small, discarded: deep }), false, ""],
    ["dimensions", raw({ ...small, first_frame_image: uri(png(300, 301)) }), false, ""],
    ["duplicate", raw(JSON.stringify(small).slice(0, -1) + ',"first_frame_\\u0069mage":' + JSON.stringify(small.first_frame_image) + '}'), false, ""],
    ["wrong-slot", raw({ ...videoInput(), nested: { first_frame_image: small.first_frame_image } }), false, ""],
  ];
  io.mode("pending");
  for (const [name, bytes, accepts, options] of cases) {
    await json("/setup?inline=1"); const posts = io.counts.post;
    const response = await call(native, bytes, {}, "call", "inline-raw-" + name + options);
    const text = await response.text(); assert.equal(response.status === 200, accepts, name + ": " + text);
    const state = await idle(); assert.equal(io.counts.post, posts + Number(accepts), name);
    assert.equal(state.inputUnlocks, 1, name); assert.ok(state.inputReads >= 1, name);
    assert.equal(state.materializations, accepts ? 1 : 0, name);
    if (name === "backing") { assert.equal(state.inputMaxBacking, 16385); assert.equal(state.inputCancels, 1); }
    else assert.ok(state.inputMaxBacking <= 16384, name);
    if (name.startsWith("read819")) assert.equal(state.inputReads, 8192, name);
    if (!accepts) assert.equal(state.inputCancels, ["dimensions", "mime", "container"].includes(name) ? 0 : 1, name);
    assert.equal(state.charged, 0); assert.equal(state.releases, 1);
  }
  for (const mode of ["inline-hash-reject"]) {
    await json("/setup?inline=1"); const posts = io.counts.post;
    const response = await call(native, lastBody, {}, "call", mode); assert.ok(response.status >= 400); await response.text();
    const state = await idle(); assert.equal(state.materializations, 0); assert.equal(io.counts.post, posts); assert.equal(state.releases, 1);
  }
  for (const config of ["", "region=cn", "import=1", "inline=1&unpriced=1"]) {
    for (const manifest of [false, true]) {
      await json("/setup?" + config); const posts = io.counts.post;
      const response = await call(manifest ? "/v1/proxy/minimax/video" : native,
        manifest ? { body: { ...small, model: "minimax/" + small.model } } : small);
      assert.ok(response.status >= 400, await response.clone().text()); await response.text();
      const state = await idle(); assert.equal(state.materializations, 0); assert.equal(io.counts.post, posts); assert.equal(state.releases, 1);
    }
  }
  for (const mode of ["inline-revoke", "inline-rotate"]) {
    await json("/setup?inline=1"); const posts = io.counts.post;
    const response = await call(native, small, {}, "held", mode); let state = await response.json(); assert.equal(state.charged, 96 * MiB);
    await json(mode === "inline-revoke" ? "/revoke" : "/rotate"); io.release(mode + "/authority");
    for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.results === 1) break; await delay(10); }
    assert.equal(state.results, 1); assert.ok(state.status >= 400); assert.equal(io.counts.post, posts);
    io.release(mode + "/abort"); await idle();
  }

  let state;
  for (const [ordinal, mode] of ["upload", "inline-hash", "inline-upload", "inline-upload-reject", "inline-late"].entries()) {
    await json("/setup?inline=1"); io.mode(mode.startsWith("inline-upload") ? "early" : "pending");
    const posts = io.counts.post, started = mode.startsWith("inline-upload") ? io.nextPost() : undefined;
    const attempt = "GLOBAL:" + mode + ":" + (ordinal + 1);
    t.diagnostic(JSON.stringify({ phase: "held-request", mode, attempt, postsBefore: posts }));
    let response;
    try { response = await call(native, lastBody, {}, "held", mode, attempt); }
    catch (error) { heldCallFailure(t, error, attempt, io.counts.post); throw error; }
    state = await response.json();
    t.diagnostic(JSON.stringify({ phase: "held-entry", mode, postsBefore: posts, posts: io.counts.post,
      charged: state.charged, reads: state.reads, cancels: state.cancels, results: state.results, status: state.status, error: state.error, failedControl: state.failedControl }));
    assert.equal(state.charged, 96 * MiB, JSON.stringify(state));
    if (started) { await started; assert.equal(io.counts.post, posts + 1, JSON.stringify(state));
      t.diagnostic(JSON.stringify({ phase: "actual-post-started", mode, posts: io.counts.post })); io.replyEarly(); }
    if (!mode.startsWith("inline-upload")) io.release(mode + "/abort");
    if (mode === "inline-late") io.release(mode + "/execution-abort");
    for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.results === 1) break; await delay(10); }
    assert.equal(state.results, 1, JSON.stringify(state)); assert.equal(state.charged, 96 * MiB, JSON.stringify(state)); assert.equal(state.releases, 0);
    if (mode.startsWith("inline-upload")) {
      assertInlineCreateCalls(state);
      assert.equal(state.status, 200); assert.equal(state.actions.filter(action => action === "managed_bind").length, 1);
      assert.equal(state.actions.filter(action => action === "managed_observe").length, 1);
      assert.equal(state.exchanges.length, 1); assert.ok(state.exchanges[0].ordinary <= 16); assert.ok(state.exchanges[0].mandatory <= 5);
      assert.equal(state.exchanges[0].ordinary + state.exchanges[0].mandatory, state.controls.length + 1);
      io.release(mode + "/abort");
    }
    assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB });
    if (mode === "inline-hash") io.release(mode + "/hash");
    else if (mode === "inline-late") {
      io.release(mode + "/arrival");
      for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.cancels === 1) break; await delay(10); }
      assert.equal(state.cancels, 1); assert.equal(state.reads, 0); assert.equal(state.locked, true); io.release(mode + "/cleanup");
    } else {
      for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.cancels === 1) break; await delay(10); }
      assert.equal(state.cancels, 1); assert.equal(state.locked, true);
      io.release(mode + "/cleanup");
      for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.cleanup) break; await delay(10); }
      assert.equal(state.cleanup, true, JSON.stringify(state)); assert.equal(state.charged, 96 * MiB); assert.equal(state.locked, true);
      io.release(mode + "/read");
    }
    state = await idle(); assert.equal(state.releases, 1);
    if (mode !== "inline-hash") { assert.equal(state.unlocks, 1); assert.equal(state.readRetired, mode !== "inline-late"); }
    if (mode === "inline-upload-reject") assert.equal(state.cleanupFailure, "minimax_video_cleanup_failed");
  }
  for (const mode of ["inline-header-held", "inline-freeze-held"]) {
    await json("/setup?inline=1"); const posts = io.counts.post;
    const response = await call(native, small, mode === "inline-header-held" ? { "content-type": "text/plain" } : {}, "held", mode);
    let state = await response.json(); assert.equal(state.results, 1); assert.ok(state.status >= 400);
    assert.equal(state.reads, 0); assert.equal(state.cancels, 1); assert.equal(state.locked, true);
    assert.equal(state.charged, 96 * MiB); assert.equal(state.releases, 0); assert.equal(io.counts.post, posts);
    assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB });
    if (mode === "inline-freeze-held") {
      assertInlineCreateCalls(state, { unsent: true });
      assert.equal(state.error, "prediction_submission_unsent"); assert.equal(state.actions.filter(action => action === "freeze").length, 1);
      assert.equal(state.exchanges.length, 1); const exchange = state.exchanges[0];
      assert.ok(exchange.ordinary + 1 <= 16); assert.equal(exchange.mandatory, 2);
      assert.equal(exchange.ordinary + exchange.mandatory, state.controls.length);
    }
    io.release(mode + "/abort"); io.release(mode + "/cleanup"); state = await idle();
    assert.equal(state.unlocks, 1); assert.equal(state.releases, 1); assert.equal(state.reads, 0);
  }
  const put = (mode, body) => request("/v1/admin/upstream-grants/policies/fixture/video-admin-" + mode, {
    method: "PUT", headers: { ...access.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const mode of ["inline-admin-demote", "inline-admin-disable"]) {
    await json("/fixture/user");
    const created = await put(mode, { provider: "minimax", kind: "api_key", enabled: false, accountId: "synthetic-original-account",
      credential: "synthetic-original-video-key", minimaxVideoAuthorization: "minimax-global-video" });
    assert.equal(created.status, 200, await created.clone().text()); await created.text();
    const original = await json("/fixture/pin?mode=" + mode);
    await json("/fixture/arm?mode=" + mode); const entered = io.entered(mode + "/pool");
    const mutation = put(mode, { enabled: true, accountId: "synthetic-new-account", credential: "synthetic-new-video-key",
      minimaxVideoAuthorization: "minimax-global-video-inline-first-frame" });
    await entered; await json(mode.endsWith("demote") ? "/fixture/user?role=user" : "/fixture/user?enabled=false"); io.release(mode + "/pool");
    const denied = await mutation; assert.equal(denied.status, 403, await denied.clone().text()); await denied.text();
    assert.deepEqual(await json("/fixture/pin?mode=" + mode), original);
  }
  // Run the capacity-filling pool LAST: setup replaces the primary grant but
  // does not clear the other genuine pool records. All maximum assertions remain.
  // Reachable maximum controls and maximum input/lifecycle under ONE owner.
  io.mode("maximum");
  await json("/setup?inline=1"); const pool = await json("/maximum-pool?inline=1");
  const input = { ...lastBody, prompt: "x".repeat(2000) }, text = JSON.stringify(input);
  const nonimage = Buffer.byteLength(text) - input.first_frame_image.split(",")[1].length;
  const maximum = await call(native, text + " ".repeat(65536 - nonimage), { "idempotency-key": "inline-max" }, "max-held", "combined-inline");
  state = await maximum.json(); assert.equal(state.status, 200, JSON.stringify(state));
  assert.equal(state.charged, 96 * MiB); assert.equal(state.candidates, pool.candidates); assert.equal(state.controlMaxValues, 512);
  assert.equal(state.exchanges.length, 1); assert.ok(state.exchanges[0].ordinary <= 16); assert.ok(state.exchanges[0].mandatory <= 5);
  assert.equal(state.exchanges[0].ordinary + state.exchanges[0].mandatory, state.controls.length + 1);
  assertInlineCreateCalls(state, { lookup: true });
  assert.equal(state.nativeBytes, MiB); assert.ok(state.nativeMaxBacking <= 16384); assert.equal(state.releases, 0);
  assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB });
  io.release("combined-inline/output"); state = await idle(); assert.equal(state.releases, 1);

  assert.ok(last); assert.ok(lastLocator);
});

test("isolated workerd V3 four required-frame models, retired CREATE input and fresh original-job controls", { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "hailuo-six-model-runtime-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const io = await external(t), access = await musicAccessFixture(), script = router.replace("ACCESS_ENV", JSON.stringify(access.env));
  let runtime = await isolated(directory, script, upstream(io.origin, access.jwk));
  t.after(async () => { io.releaseAll(); await runtime.dispose(); });
  const request = (path, init) => runtime.dispatchFetch("https://router.example" + path, { ...init, redirect: "manual" });
  const json = async path => { const r = await request(path); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const call = (target, body, headers = {}, kind = "call", mode = "") => request("/" + kind + "?mode=" + mode + "&target=" + encodeURIComponent(target), {
    ...(body == null ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), headers: { "content-type": "application/json", ...headers } });
  const idle = async () => { let state; for (let i = 0; i < 100; i++) { state = await json("/state"); if (!state.charged) return state; await delay(10); } assert.fail(JSON.stringify(state)); };
  const native = "/v1/native/minimax/v1/video_generation", manifestPath = "/v1/proxy/minimax/video";
  for (const [config, allowed] of [["", false], ["inline=1", false], ["region=cn", false], ["six=1", true]]) {
    await json("/setup?" + config);
    const r = await call("/v1/catalog", null); assert.equal(r.status, 200, await r.clone().text());
    const view = (await r.json()).providers.find(row => row.id === "minimax");
    assert.equal((view?.offers ?? []).some(offer => offer.modelId === "minimax/I2V-01-Director" && offer.eligible), allowed);
    assert.equal((await json("/state")).materializations, 0); assert.equal(io.counts.post, 0);
  }
  for (const kind of ["missing", "duplicate", "ambiguous", "foreign"]) {
    await json("/fixture/card?kind=" + kind);
    const r = await call("/v1/catalog", null); assert.equal(r.status, 200, await r.clone().text());
    const view = (await r.json()).providers.find(row => row.id === "minimax");
    assert.equal((view?.offers ?? []).some(offer => offer.modelId === "minimax/I2V-01-Director" && offer.eligible), false);
    assert.equal((await json("/state")).materializations, 0); assert.equal(io.counts.post, 0);
  }
  await json("/fixture/card");
  await json("/setup?six=1"); io.mode("maximum");
  let previousFile, lastBody;
  for (const mime of ["image/png", "image/jpeg", "image/webp"]) for (const model of addedModels) for (const manifest of [false, true]) {
    const bytes = inlineImage(mime), digest = createHash("sha256").update(bytes).digest("hex"), input = { ...sixModelInput(model), first_frame_image: uri(bytes, mime) };
    if (model === "I2V-01") delete input.prompt;
    const body = manifest ? { body: { ...input, model: "minimax/" + model } } : input, target = manifest ? manifestPath : native;
    const key = mime.replace("/", "-") + model + manifest, before = io.counts.post;
    const response = await call(target, body, { "idempotency-key": key }); assert.equal(response.status, 200, await response.clone().text());
    const locator = response.headers.get("x-clawrouter-background-recovery"), created = await response.json();
    let state = await idle(); assert.equal(state.releases, 1); assert.equal(state.charged, 0);
    assert.equal(io.counts.post, before + 1); assert.equal(io.counts.model, model); assert.equal(io.counts.imageBytes, 8 * MiB); assert.equal(io.counts.imageDigest, digest);
    assertInlineCreateCalls(state, { lookup: true }); assert.equal(state.nativeBytes, MiB); assert.ok(state.nativeMaxBacking <= 16384);
    const repeat = await call(target, body, { "idempotency-key": key }); assert.equal(repeat.status, 303); await repeat.text(); await idle();
    for (const changed of [{ ...input, first_frame_image: uri(inlineImage("image/png", 1024)) },
      { ...sixModelInput(addedModels[(addedModels.indexOf(model) + 1) % addedModels.length]), first_frame_image: input.first_frame_image }]) {
      const r = await call(target, manifest ? { body: { ...changed, model: "minimax/" + changed.model } } : changed, { "idempotency-key": key });
      assert.equal(r.status, 409, await r.clone().text()); await r.text(); await idle(); assert.equal(io.counts.post, before + 1);
    }
    if (mime === "image/png" && !manifest) {
      // The CREATE owner and image have retired before a fresh owner reads the job.
      await runtime.dispose(); runtime = await isolated(directory, script, upstream(io.origin, access.jwk));
      const gets = io.counts.poll;
      const wrong = await json("/collect?locator=" + encodeURIComponent(locator) + "&version=" + encodeURIComponent(addedModels[(addedModels.indexOf(model) + 1) % addedModels.length]));
      assert.equal(wrong.accepted, 0); assert.ok(wrong.error); assert.equal(io.counts.poll, gets); assert.equal(wrong.charged, 0);
      const collected = await json("/collect?locator=" + encodeURIComponent(locator));
      assert.equal(collected.accepted, 1, JSON.stringify(collected)); assert.equal(collected.charged, 0);
      assert.deepEqual(collected.exchanges, [{ kind: "collector", ordinary: 4, mandatory: 0 }]);
    }
    const polled = await call("/v1/native/minimax/v1/query/video_generation?task_id=" + created.task_id, null);
    assert.equal(polled.status, 200, await polled.clone().text()); const terminal = await polled.json(); await idle(); assert.equal(terminal.status, "Success");
    if (mime === "image/png") {
      if (previousFile) {
        const gets = io.counts.metadata + io.counts.download;
        const foreign = await call(previousFile, null, { "x-clawrouter-job-id": created.task_id });
        assert.ok(foreign.status >= 400); await foreign.text(); await idle(); assert.equal(io.counts.metadata + io.counts.download, gets);
      }
      const file = await call(terminal.video_url, null, { "x-clawrouter-job-id": created.task_id });
      assert.equal(file.status, 200, await file.clone().text()); assert.deepEqual(new Uint8Array(await file.arrayBuffer()), mp4(16 * MiB));
      state = await idle(); assert.equal(state.releases, 1); assert.equal(state.charged, 0); previousFile = terminal.video_url;
    }
    await json("/settle?locator=" + encodeURIComponent(locator));
    let events;
    for (let i = 0; i < 100; i++) { events = (await json("/events")).events; if (events.length === io.counts.post) break; await delay(10); }
    assert.equal(events.length, io.counts.post); const event = events.at(-1);
    assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 700); assert.equal(event.total_tokens, null);
    lastBody = input;
  }
  assert.equal(io.counts.post, 24);
  const small = { ...sixModelInput(addedModels[0]), first_frame_image: uri(inlineImage("image/png", 1024)) };
  for (const config of ["", "inline=1", "region=cn", "six=1&import=1", "six=1&unpriced=1"]) for (const manifest of [false, true]) {
    await json("/setup?" + config); const posts = io.counts.post;
    const response = await call(manifest ? manifestPath : native, manifest ? { body: { ...small, model: "minimax/" + small.model } } : small);
    assert.ok(response.status >= 400, await response.clone().text()); await response.text(); const state = await idle();
    assert.equal(state.materializations, 0); assert.equal(io.counts.post, posts); assert.equal(state.releases, 1);
  }
  for (const model of addedModels) for (const manifest of [false, true]) {
    await json("/setup?six=1");
    const value = { ...sixModelInput(model), first_frame_image: small.first_frame_image }, { first_frame_image: _image, ...missing } = value;
    for (const invalid of [missing, { ...value, duration: 5 }, { ...value, prompt: 7 }, { ...value, prompt: "x".repeat(2001) },
      { ...value, resolution: model.startsWith("I2V-") ? "768P" : "720P" }]) {
      const posts = io.counts.post, r = await call(manifest ? manifestPath : native, manifest ? { body: { ...invalid, model: "minimax/" + model } } : invalid);
      assert.ok(r.status >= 400, await r.clone().text()); await r.text(); const state = await idle(); assert.equal(state.materializations, 0); assert.equal(io.counts.post, posts);
    }
  }
  for (const mode of ["inline-revoke", "inline-rotate"]) {
    await json("/setup?six=1"); const posts = io.counts.post, r = await call(native, small, {}, "held", mode); let state = await r.json(); assert.equal(state.charged, 96 * MiB);
    await json(mode === "inline-revoke" ? "/revoke" : "/rotate?six=1"); io.release(mode + "/authority");
    for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.results === 1) break; await delay(10); }
    assert.equal(state.results, 1); assert.ok(state.status >= 400); assert.equal(io.counts.post, posts); io.release(mode + "/abort"); await idle();
  }
  const put = (mode, body) => request("/v1/admin/upstream-grants/policies/fixture/video-admin-" + mode, {
    method: "PUT", headers: { ...access.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const mode of ["six-admin-demote", "six-admin-disable", "six-admin-success"]) {
    await json("/fixture/user");
    const created = await put(mode, { provider: "minimax", kind: "api_key", enabled: false, accountId: "synthetic-original-account",
      credential: "synthetic-original-video-key", minimaxVideoAuthorization: "minimax-global-video-inline-first-frame" });
    assert.equal(created.status, 200, await created.clone().text()); await created.text(); const original = await json("/fixture/pin?mode=" + mode);
    const intent = { minimaxVideoAuthorization: "minimax-global-video-six-model-inline-first-frame" };
    if (mode.endsWith("success")) {
      const accepted = await put(mode, intent); assert.equal(accepted.status, 200, await accepted.clone().text()); await accepted.text();
      const next = await json("/fixture/pin?mode=" + mode); assert.equal(next.binding.version, "clawrouter.minimax-video.v3");
      assert.equal(next.generation, original.generation + 1); assert.notEqual(next.lineage, original.lineage); continue;
    }
    await json("/fixture/arm?mode=" + mode); const entered = io.entered(mode + "/pool"), mutation = put(mode, intent);
    await entered; await json(mode.endsWith("demote") ? "/fixture/user?role=user" : "/fixture/user?enabled=false"); io.release(mode + "/pool");
    const denied = await mutation; assert.equal(denied.status, 403, await denied.clone().text()); await denied.text();
    assert.deepEqual(await json("/fixture/pin?mode=" + mode), original);
  }
  const forged = await put("six-forged", { provider: "minimax", kind: "api_key", credential: "synthetic-forged-video-key",
    minimaxVideoBinding: { version: "clawrouter.minimax-video.v3" }, videoActor: { role: "admin" } });
  assert.equal(forged.status, 400); await forged.text();
  // Reachable maximum remains a separate, same-owner phase; pool state is last.
  await json("/setup?six=1"); io.mode("maximum"); const pool = await json("/maximum-pool?six=1");
  const input = { ...lastBody, prompt: "x".repeat(2000) }, text = JSON.stringify(input), nonimage = Buffer.byteLength(text) - input.first_frame_image.split(",")[1].length;
  const r = await call(native, text + " ".repeat(65536 - nonimage), { "idempotency-key": "six-max" }, "max-held", "combined-six");
  let state = await r.json(); assert.equal(state.status, 200, JSON.stringify(state)); assert.equal(state.charged, 96 * MiB);
  assert.equal(state.candidates, pool.candidates); assert.equal(state.controlMaxValues, 512); assertInlineCreateCalls(state, { lookup: true });
  assert.equal(state.nativeBytes, MiB); assert.ok(state.nativeMaxBacking <= 16384); assert.equal(state.releases, 0);
  assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB });
  io.release("combined-six/output"); state = await idle(); assert.equal(state.releases, 1);
});

test("actual isolated current-CN V4: exact host after restart, original files, SQL mutation and retirement", { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "hailuo-current-cn-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const io = await external(t), access = await musicAccessFixture(), script = router.replace("ACCESS_ENV", JSON.stringify(access.env));
  let runtime = await isolated(directory, script, upstream(io.origin, access.jwk));
  t.after(async () => { io.releaseAll(); await runtime.dispose(); });
  const request = (path, init) => runtime.dispatchFetch("https://router.example" + path, { ...init, redirect: "manual" });
  const json = async path => { const r = await request(path); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const call = (target, body, headers = {}, kind = "call", mode = "") => request("/" + kind + "?mode=" + mode + "&target=" + encodeURIComponent(target), {
    ...(body == null ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), headers: { "content-type": "application/json", ...headers } });
  const idle = async () => { let state; for (let i = 0; i < 100; i++) { state = await json("/state"); if (!state.charged) return state; await delay(10); } assert.fail(JSON.stringify(state)); };
  const native = "/v1/native/minimax/v1/video_generation", manifestPath = "/v1/proxy/minimax/video", origin = "https://api.minimax.cn";
  await json("/setup?currentcn=1"); io.mode("maximum"); let previousFile, task, filePath;
  for (const model of hailuoModels) for (const manifest of [false, true]) {
    const input = videoInput(model), body = manifest ? { body: { ...input, model: "minimax/" + model } } : input;
    const target = manifest ? manifestPath : native, key = "current-cn-" + model + manifest, posts = io.counts.post;
    const text = JSON.stringify(body), r = await call(target, text + " ".repeat(65536 - Buffer.byteLength(text)), { "idempotency-key": key });
    assert.equal(r.status, 200, await r.clone().text()); const locator = r.headers.get("x-clawrouter-background-recovery"); task = (await r.json()).task_id;
    let state = await idle(); assert.equal(io.counts.post, posts + 1); assert.equal(state.releases, 1); assert.equal(state.nativeBytes, MiB);
    assert.ok(state.nativeMaxBacking <= 16384); assert.ok(state.exchanges[0].ordinary <= 16); assert.ok(state.exchanges[0].mandatory <= 5);
    assert.equal(state.exchanges[0].ordinary + state.exchanges[0].mandatory, state.controls.length + 1);
    await runtime.dispose(); runtime = await isolated(directory, script, upstream(io.origin, access.jwk));
    const gets = io.counts.poll, wrong = await json("/collect?locator=" + encodeURIComponent(locator) + "&version=" + encodeURIComponent(hailuoModels.find(value => value !== model)));
    assert.equal(wrong.accepted, 0); assert.ok(wrong.error); assert.equal(io.counts.poll, gets); assert.equal(wrong.charged, 0);
    const foreignOwner = await json("/collect?locator=" + encodeURIComponent(locator) + "&foreign-owner=1");
    assert.equal(foreignOwner.accepted, 0); assert.ok(foreignOwner.error); assert.equal(io.counts.poll, gets); assert.equal(foreignOwner.charged, 0);
    const p = await call((manifest ? "/v1/proxy/minimax/task?task_id=" : "/v1/native/minimax/v1/query/video_generation?task_id=") + task, null);
    assert.equal(p.status, 200, await p.clone().text()); const completed = await p.json(); await idle(); assert.equal(completed.status, "Success"); filePath = completed.video_url;
    if (previousFile) {
      const before = io.counts.metadata + io.counts.download, denied = await call(previousFile, null, { "x-clawrouter-job-id": task });
      assert.ok(denied.status >= 400); await denied.text(); await idle(); assert.equal(io.counts.metadata + io.counts.download, before);
    }
    const metadata = await call("/v1/native/minimax/v1/files/retrieve?file_id=" + task + "1", null, { "x-clawrouter-job-id": task });
    assert.equal(metadata.status, 200, await metadata.clone().text()); await metadata.text(); await idle();
    const file = await call(filePath, null, { "x-clawrouter-job-id": task });
    const originalFileBody = file.body, bodyObservations = [];
    const observeBody = stage => bodyObservations.push({ model, manifest, stage, bodyUsed: file.bodyUsed, locked: file.body?.locked ?? null, sameBody: file.body === originalFileBody });
    observeBody("received"); if (file.status !== 200) assert.fail(await file.text());
    assert.equal(file.headers.get("content-type"), "video/mp4"); assert.equal((await json("/state")).charged, 96 * MiB); observeBody("after-state");
    assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB });
    observeBody("after-contend"); observeBody("before-read");
    let fileBytes; try { fileBytes = await file.arrayBuffer(); } catch (error) { console.error(JSON.stringify(bodyObservations)); throw error; }
    assert.deepEqual(new Uint8Array(fileBytes), mp4(16 * MiB)); state = await idle(); assert.equal(state.releases, 1); previousFile = filePath;
    for (const [value, expected] of [[body, 303], [manifest ? { body: { ...body.body, prompt: "changed" } } : { ...body, prompt: "changed" }, 409]]) {
      const repeat = await call(target, value, { "idempotency-key": key }); assert.equal(repeat.status, expected, await repeat.clone().text()); await repeat.text(); await idle();
    }
    assert.equal(io.counts.post, posts + 1); await json("/settle?locator=" + encodeURIComponent(locator)); let events;
    for (let i = 0; i < 100; i++) { events = (await json("/events")).events; if (events.length === io.counts.post) break; await delay(10); }
    assert.equal(events.length, io.counts.post); assert.equal(events.at(-1).cost_basis, "policy_fixed");
    assert.equal(events.at(-1).actual_cost_micros, 700); assert.equal(events.at(-1).total_tokens, null);
  }
  assert.equal(io.counts.post, 4);
  assert.deepEqual(Object.keys(io.counts.destinations).sort(), ["/v1/video_generation", "/v1/query/video_generation", "/v1/files/retrieve", "/v1/files/retrieve_content"].map(path => origin + path).sort());
  assert.equal(io.counts.destinations[origin + "/v1/video_generation"], 4);
  // These are caller-owned returned-body roots, not producer/socket acknowledgments.
  for (const mode of ["poll-read", "file-read", "cleanup-reject", "late"]) {
    const target = mode === "file-read" ? filePath : "/v1/native/minimax/v1/query/video_generation?task_id=" + task;
    const r = await call(target, null, { "x-clawrouter-job-id": task }, "held", mode); let state = await r.json();
    assert.equal(state.charged, 96 * MiB, JSON.stringify(state)); io.release(mode + "/abort");
    for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.results === 1) break; await delay(10); }
    assert.equal(state.results, 1); assert.equal(state.charged, 96 * MiB); assert.equal(state.releases, 0);
    if (mode === "late") io.release(mode + "/arrival");
    for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.cancels === 1) break; await delay(10); }
    assert.equal(state.cancels, 1); assert.equal(state.locked, true); assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB });
    if (mode === "late") { assert.equal(state.reads, 0); io.release(mode + "/cleanup"); state = await idle(); assert.equal(state.reads, 0); }
    else {
      assert.ok(state.reads >= 1); io.release(mode + "/cleanup");
      for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.cleanup) break; await delay(10); }
      assert.equal(state.cleanup, true); assert.equal(state.charged, 96 * MiB); assert.equal(state.locked, true);
      io.release(mode + "/read"); state = await idle(); assert.equal(state.readRetired, true);
    }
    assert.equal(state.cleanup, true); assert.equal(state.unlocks, 1); assert.equal(state.releases, 1);
    if (mode === "cleanup-reject") assert.equal(state.cleanupFailure, "minimax_video_cleanup_failed");
  }
  const image = uri(inlineImage("image/png", 1024));
  for (const manifest of [false, true]) {
    await json("/setup?currentcn=1"); const posts = io.counts.post;
    for (const model of miniMaxFrozenVideoModels) {
      const input = { ...sixModelInput(model), first_frame_image: image };
      for (const value of hailuoModels.includes(model) ? [input] : [input, sixModelInput(model)]) {
        const denied = await call(manifest ? manifestPath : native, manifest ? { body: { ...value, model: "minimax/" + model } } : value);
        assert.ok(denied.status >= 400); await denied.text(); const state = await idle();
        assert.equal(state.materializations, 0); assert.equal(state.providerAttempts, 0); assert.equal(io.counts.post, posts);
      }
    }
    for (const config of ["import=1", "unpriced=1"]) {
      await json("/setup?currentcn=1&" + config);
      const denied = await call(manifest ? manifestPath : native, manifest ? { body: { ...videoInput(), model: "minimax/" + videoInput().model } } : videoInput());
      assert.ok(denied.status >= 400); await denied.text(); const state = await idle();
      assert.equal(state.materializations, 0); assert.equal(state.providerAttempts, 0); assert.equal(io.counts.post, posts);
    }
  }
  for (const mode of ["cn-revoke", "cn-rotate", "cn-expire"]) {
    await json("/setup?currentcn=1"); const posts = io.counts.post;
    const r = await call(native, videoInput(), {}, "held", mode); let state = await r.json(); assert.equal(state.charged, 96 * MiB);
    await json(mode === "cn-revoke" ? "/revoke" : mode === "cn-rotate" ? "/rotate?currentcn=1" : "/expire"); io.release(mode + "/authority");
    for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.results === 1) break; await delay(10); }
    assert.equal(state.results, 1); assert.ok(state.status >= 400); assert.equal(io.counts.post, posts); assert.equal(state.providerAttempts, 0);
    io.release(mode + "/abort"); await idle();
  }
  // A newly attested host invalidates the original job; it never migrates it.
  for (const legacy of [true, false]) {
    await json(legacy ? "/setup?region=cn" : "/setup?currentcn=1"); io.mode("pending");
    const created = await call(native, videoInput()); assert.equal(created.status, 200, await created.clone().text()); const oldTask = (await created.json()).task_id; await idle();
    await json(legacy ? "/reattest-cn" : "/reattest-cn?legacy=1"); const gets = io.counts.poll + io.counts.metadata + io.counts.download;
    const denied = await call("/v1/native/minimax/v1/query/video_generation?task_id=" + oldTask, null);
    assert.ok(denied.status >= 400); await denied.text(); await idle(); assert.equal(io.counts.poll + io.counts.metadata + io.counts.download, gets);
  }
  const put = (mode, body) => request("/v1/admin/upstream-grants/policies/fixture/video-admin-" + mode, {
    method: "PUT", headers: { ...access.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  await json("/fixture/user");
  const legacy = await put("cn-retained", { provider: "minimax", kind: "api_key", enabled: false, accountId: "synthetic-retained-account",
    credential: "synthetic-retained-video-key", minimaxVideoAuthorization: "minimax-cn-video" });
  assert.equal(legacy.status, 200, await legacy.clone().text()); await legacy.text(); const retained = await json("/fixture/pin?mode=cn-retained");
  for (const mode of ["cn-admin-demote", "cn-admin-disable", "cn-admin-success"]) {
    await json("/fixture/user");
    const created = await put(mode, { provider: "minimax", kind: "api_key", enabled: false, accountId: "synthetic-original-account",
      credential: "synthetic-original-video-key", minimaxVideoAuthorization: "minimax-cn-video" });
    assert.equal(created.status, 200, await created.clone().text()); await created.text(); const original = await json("/fixture/pin?mode=" + mode);
    const intent = { enabled: true, minimaxVideoAuthorization: "minimax-current-cn-video" };
    if (mode.endsWith("success")) {
      const accepted = await put(mode, intent); assert.equal(accepted.status, 200, await accepted.clone().text()); await accepted.text();
      const next = await json("/fixture/pin?mode=" + mode); assert.equal(next.binding.version, "clawrouter.minimax-video.v4"); assert.equal(next.binding.origin, origin);
      assert.equal(Object.hasOwn(next.binding, "inputProfile"), false); assert.equal(next.generation, original.generation + 1); assert.notEqual(next.lineage, original.lineage);
    } else {
      await json("/fixture/arm?mode=" + mode); const entered = io.entered(mode + "/pool"), mutation = put(mode, intent);
      await entered; await json(mode.endsWith("demote") ? "/fixture/user?role=user" : "/fixture/user?enabled=false"); io.release(mode + "/pool");
      const denied = await mutation; assert.equal(denied.status, 403, await denied.clone().text()); await denied.text();
      assert.deepEqual(await json("/fixture/pin?mode=" + mode), original); await json("/fixture/user");
      const retry = await put(mode, intent); assert.equal(retry.status, 403, await retry.clone().text()); await retry.text();
      assert.deepEqual(await json("/fixture/pin?mode=" + mode), original);
    }
    assert.deepEqual(await json("/fixture/pin?mode=cn-retained"), retained);
  }
  const forged = await put("cn-forged", { provider: "minimax", kind: "api_key", credential: "synthetic-forged-video-key",
    minimaxVideoBinding: { version: "clawrouter.minimax-video.v4" }, videoActor: { role: "admin" } });
  assert.equal(forged.status, 400); await forged.text();
});

test("isolated workerd V5 current-CN all six inline models, retired CREATE input and original-job controls", { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "hailuo-cn-inline-runtime-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const io = await external(t), access = await musicAccessFixture(), script = router.replace("ACCESS_ENV", JSON.stringify(access.env));
  let runtime = await isolated(directory, script, upstream(io.origin, access.jwk));
  t.after(async () => { io.releaseAll(); await runtime.dispose(); });
  const request = (path, init) => runtime.dispatchFetch("https://router.example" + path, { ...init, redirect: "manual" });
  const json = async path => { const r = await request(path); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const call = (target, body, headers = {}, kind = "call", mode = "", attempt = "") => request("/" + kind + "?mode=" + mode + "&target=" + encodeURIComponent(target) + (attempt ? "&attempt=" + attempt : ""), {
    ...(body == null ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), headers: { "content-type": "application/json", ...headers } });
  const idle = async () => { let state; for (let i = 0; i < 100; i++) { state = await json("/state"); if (!state.charged) return state; await delay(10); } assert.fail(JSON.stringify(state)); };
  const native = "/v1/native/minimax/v1/video_generation", manifestPath = "/v1/proxy/minimax/video";
  for (const [config, allowed] of [["", false], ["inline=1", false], ["region=cn", false], ["currentcn=1", false], ["cninline=1", true]]) {
    await json("/setup?" + config);
    const r = await call("/v1/catalog", null); assert.equal(r.status, 200, await r.clone().text());
    const view = (await r.json()).providers.find(row => row.id === "minimax");
    assert.equal((view?.offers ?? []).some(offer => offer.modelId === "minimax/I2V-01-Director" && offer.eligible), allowed);
    assert.equal((await json("/state")).materializations, 0); assert.equal(io.counts.post, 0);
  }
  for (const kind of ["missing", "duplicate", "ambiguous", "foreign"]) {
    await json("/fixture/card?kind=" + kind);
    const r = await call("/v1/catalog", null); assert.equal(r.status, 200, await r.clone().text());
    const view = (await r.json()).providers.find(row => row.id === "minimax");
    assert.equal((view?.offers ?? []).some(offer => offer.modelId === "minimax/I2V-01-Director" && offer.eligible), false);
    assert.equal((await json("/state")).materializations, 0); assert.equal(io.counts.post, 0);
  }
  await json("/fixture/card");
  await json("/setup?cninline=1"); io.mode("maximum");
  let previousFile, lastBody;
  for (const mime of ["image/png", "image/jpeg", "image/webp"]) for (const model of miniMaxFrozenVideoModels) for (const manifest of [false, true]) {
    const bytes = inlineImage(mime), digest = createHash("sha256").update(bytes).digest("hex"), input = { ...sixModelInput(model), first_frame_image: uri(bytes, mime) };
    if (model === "I2V-01") delete input.prompt;
    const body = manifest ? { body: { ...input, model: "minimax/" + model } } : input, target = manifest ? manifestPath : native;
    const key = mime.replace("/", "-") + model + manifest, before = io.counts.post;
    const response = await call(target, body, { "idempotency-key": key }); assert.equal(response.status, 200, await response.clone().text());
    const locator = response.headers.get("x-clawrouter-background-recovery"), created = await response.json();
    let state = await idle(); assert.equal(state.releases, 1); assert.equal(state.charged, 0);
    assert.equal(io.counts.post, before + 1); assert.equal(io.counts.model, model); assert.equal(io.counts.imageBytes, 8 * MiB); assert.equal(io.counts.imageDigest, digest);
    assertInlineCreateCalls(state, { lookup: true }); assert.equal(state.nativeBytes, MiB); assert.ok(state.nativeMaxBacking <= 16384);
    const repeat = await call(target, body, { "idempotency-key": key }); assert.equal(repeat.status, 303); await repeat.text(); await idle();
    for (const changed of [{ ...input, first_frame_image: uri(inlineImage("image/png", 1024)) },
      { ...sixModelInput(miniMaxFrozenVideoModels[(miniMaxFrozenVideoModels.indexOf(model) + 1) % miniMaxFrozenVideoModels.length]), first_frame_image: input.first_frame_image }]) {
      const r = await call(target, manifest ? { body: { ...changed, model: "minimax/" + changed.model } } : changed, { "idempotency-key": key });
      assert.equal(r.status, 409, await r.clone().text()); await r.text(); await idle(); assert.equal(io.counts.post, before + 1);
    }
    if (mime === "image/png" && !manifest) {
      // The CREATE owner and image have retired before a fresh owner reads the job.
      await runtime.dispose(); runtime = await isolated(directory, script, upstream(io.origin, access.jwk));
      const gets = io.counts.poll;
      const wrong = await json("/collect?locator=" + encodeURIComponent(locator) + "&version=" + encodeURIComponent(miniMaxFrozenVideoModels[(miniMaxFrozenVideoModels.indexOf(model) + 1) % miniMaxFrozenVideoModels.length]));
      assert.equal(wrong.accepted, 0); assert.ok(wrong.error); assert.equal(io.counts.poll, gets); assert.equal(wrong.charged, 0);
      const foreignOwner = await json("/collect?locator=" + encodeURIComponent(locator) + "&foreign-owner=1");
      assert.equal(foreignOwner.accepted, 0); assert.ok(foreignOwner.error); assert.equal(io.counts.poll, gets); assert.equal(foreignOwner.charged, 0);
      const collected = await json("/collect?locator=" + encodeURIComponent(locator));
      assert.equal(collected.accepted, 1, JSON.stringify(collected)); assert.equal(collected.charged, 0);
      assert.deepEqual(collected.exchanges, [{ kind: "collector", ordinary: 4, mandatory: 0 }]);
    }
    const polled = await call("/v1/native/minimax/v1/query/video_generation?task_id=" + created.task_id, null);
    assert.equal(polled.status, 200, await polled.clone().text()); const terminal = await polled.json(); await idle(); assert.equal(terminal.status, "Success");
    if (mime === "image/png") {
      if (previousFile) {
        const gets = io.counts.metadata + io.counts.download;
        const foreign = await call(previousFile, null, { "x-clawrouter-job-id": created.task_id });
        assert.ok(foreign.status >= 400); await foreign.text(); await idle(); assert.equal(io.counts.metadata + io.counts.download, gets);
      }
      const file = await call(terminal.video_url, null, { "x-clawrouter-job-id": created.task_id });
      assert.equal(file.status, 200, await file.clone().text()); assert.deepEqual(new Uint8Array(await file.arrayBuffer()), mp4(16 * MiB));
      state = await idle(); assert.equal(state.releases, 1); assert.equal(state.charged, 0); previousFile = terminal.video_url;
    }
    await json("/settle?locator=" + encodeURIComponent(locator));
    let events;
    for (let i = 0; i < 100; i++) { events = (await json("/events")).events; if (events.length === io.counts.post) break; await delay(10); }
    assert.equal(events.length, io.counts.post); const event = events.at(-1);
    assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 700); assert.equal(event.total_tokens, null);
    lastBody = input;
  }
  assert.equal(io.counts.post, 36);
  assert.ok(Object.keys(io.counts.destinations).every(url => url.startsWith("https://api.minimax.cn/")));
  const small = { ...sixModelInput(miniMaxFrozenVideoModels[2]), first_frame_image: uri(inlineImage("image/png", 1024)) };
  for (const config of ["", "inline=1", "region=cn", "currentcn=1", "cninline=1&import=1", "cninline=1&unpriced=1"]) for (const manifest of [false, true]) {
    await json("/setup?" + config); const posts = io.counts.post;
    const response = await call(manifest ? manifestPath : native, manifest ? { body: { ...small, model: "minimax/" + small.model } } : small);
    assert.ok(response.status >= 400, await response.clone().text()); await response.text(); const state = await idle();
    assert.equal(state.materializations, 0); assert.equal(io.counts.post, posts); assert.equal(state.releases, 1);
  }
  for (const model of miniMaxFrozenVideoModels) for (const manifest of [false, true]) {
    await json("/setup?cninline=1");
    const value = { ...sixModelInput(model), first_frame_image: small.first_frame_image }, { first_frame_image: _image, ...missing } = value;
    for (const invalid of [missing, { ...value, duration: 5 }, { ...value, prompt: 7 }, { ...value, prompt: "x".repeat(2001) },
      { ...value, first_frame_image: "https://media.example/never-fetch" }, { ...missing, first_frame_image_id: "untrusted-handle" },
      { ...value, resolution: model.startsWith("I2V-") ? "1080P" : "512P" }]) {
      const posts = io.counts.post, r = await call(manifest ? manifestPath : native, manifest ? { body: { ...invalid, model: "minimax/" + model } } : invalid);
      assert.ok(r.status >= 400, await r.clone().text()); await r.text(); const state = await idle(); assert.equal(state.materializations, 0); assert.equal(io.counts.post, posts);
    }
  }
  for (const mode of ["cn-inline-revoke", "cn-inline-rotate", "cn-inline-expire", "cn-inline-account", "cn-inline-v4"]) {
    await json("/setup?cninline=1"); const posts = io.counts.post, r = await call(native, small, {}, "held", mode); let state = await r.json(); assert.equal(state.charged, 96 * MiB);
    await json(mode === "cn-inline-revoke" ? "/revoke" : mode === "cn-inline-rotate" ? "/rotate?cninline=1"
      : mode === "cn-inline-expire" ? "/expire?cninline=1" : mode === "cn-inline-account" ? "/account?cninline=1" : "/reattest-cn"); io.release(mode + "/authority");
    for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.results === 1) break; await delay(10); }
    assert.equal(state.results, 1); assert.ok(state.status >= 400); assert.equal(io.counts.post, posts); assert.equal(state.providerAttempts, 0); io.release(mode + "/abort"); await idle();
  }
  for (const [ordinal, mode] of ["upload", "inline-hash", "inline-upload", "inline-upload-reject", "inline-late"].entries()) {
    await json("/setup?cninline=1"); io.mode(mode.startsWith("inline-upload") ? "early" : "pending");
    const posts = io.counts.post, started = mode.startsWith("inline-upload") ? io.nextPost() : undefined;
    const attempt = "CN:" + mode + ":" + (ordinal + 1);
    t.diagnostic(JSON.stringify({ phase: "held-request", mode, attempt, postsBefore: posts }));
    let response;
    try { response = await call(native, lastBody, {}, "held", mode, attempt); }
    catch (error) { heldCallFailure(t, error, attempt, io.counts.post); throw error; }
    let state = await response.json();
    t.diagnostic(JSON.stringify({ phase: "held-entry", mode, postsBefore: posts, posts: io.counts.post,
      charged: state.charged, reads: state.reads, cancels: state.cancels, results: state.results, status: state.status, error: state.error, failedControl: state.failedControl }));
    assert.equal(state.charged, 96 * MiB, JSON.stringify(state));
    if (started) { await started; assert.equal(io.counts.post, posts + 1, JSON.stringify(state));
      t.diagnostic(JSON.stringify({ phase: "actual-post-started", mode, posts: io.counts.post })); io.replyEarly(); }
    if (!mode.startsWith("inline-upload")) io.release(mode + "/abort");
    if (mode === "inline-late") io.release(mode + "/execution-abort");
    for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.results === 1) break; await delay(10); }
    assert.equal(state.results, 1, JSON.stringify(state)); assert.equal(state.charged, 96 * MiB, JSON.stringify(state)); assert.equal(state.releases, 0);
    if (mode.startsWith("inline-upload")) {
      assertInlineCreateCalls(state);
      assert.equal(state.status, 200); assert.equal(state.actions.filter(action => action === "managed_bind").length, 1);
      assert.equal(state.actions.filter(action => action === "managed_observe").length, 1);
      assert.equal(state.exchanges.length, 1); assert.ok(state.exchanges[0].ordinary <= 16); assert.ok(state.exchanges[0].mandatory <= 5);
      assert.equal(state.exchanges[0].ordinary + state.exchanges[0].mandatory, state.controls.length + 1);
      io.release(mode + "/abort");
    }
    assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB });
    if (mode === "inline-hash") io.release(mode + "/hash");
    else if (mode === "inline-late") {
      io.release(mode + "/arrival");
      for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.cancels === 1) break; await delay(10); }
      assert.equal(state.cancels, 1); assert.equal(state.reads, 0); assert.equal(state.locked, true); io.release(mode + "/cleanup");
    } else {
      for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.cancels === 1) break; await delay(10); }
      assert.equal(state.cancels, 1); assert.equal(state.locked, true);
      io.release(mode + "/cleanup");
      for (let i = 0; i < 100; i++) { state = await json("/state"); if (state.cleanup) break; await delay(10); }
      assert.equal(state.cleanup, true, JSON.stringify(state)); assert.equal(state.charged, 96 * MiB); assert.equal(state.locked, true);
      io.release(mode + "/read");
    }
    state = await idle(); assert.equal(state.releases, 1);
    if (mode !== "inline-hash") { assert.equal(state.unlocks, 1); assert.equal(state.readRetired, mode !== "inline-late"); }
    if (mode === "inline-upload-reject") assert.equal(state.cleanupFailure, "minimax_video_cleanup_failed");
  }
  const put = (mode, body) => request("/v1/admin/upstream-grants/policies/fixture/video-admin-" + mode, {
    method: "PUT", headers: { ...access.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const mode of ["cn-inline-admin-demote", "cn-inline-admin-disable", "cn-inline-admin-success"]) {
    await json("/fixture/user");
    const created = await put(mode, { provider: "minimax", kind: "api_key", enabled: false, accountId: "synthetic-original-account",
      credential: "synthetic-original-video-key", minimaxVideoAuthorization: "minimax-current-cn-video" });
    assert.equal(created.status, 200, await created.clone().text()); await created.text(); const original = await json("/fixture/pin?mode=" + mode);
    const intent = { enabled: true, minimaxVideoAuthorization: "minimax-current-cn-video-six-model-inline-first-frame" };
    if (mode.endsWith("success")) {
      const accepted = await put(mode, intent); assert.equal(accepted.status, 200, await accepted.clone().text()); await accepted.text();
      const next = await json("/fixture/pin?mode=" + mode); assert.equal(next.binding.version, "clawrouter.minimax-video.v5");
      assert.equal(next.generation, original.generation + 1); assert.notEqual(next.lineage, original.lineage); continue;
    }
    await json("/fixture/arm?mode=" + mode); const entered = io.entered(mode + "/pool"), mutation = put(mode, intent);
    await entered; await json(mode.endsWith("demote") ? "/fixture/user?role=user" : "/fixture/user?enabled=false"); io.release(mode + "/pool");
    const denied = await mutation; assert.equal(denied.status, 403, await denied.clone().text()); await denied.text();
    assert.deepEqual(await json("/fixture/pin?mode=" + mode), original);
  }
  const forged = await put("cn-inline-forged", { provider: "minimax", kind: "api_key", credential: "synthetic-forged-video-key",
    minimaxVideoBinding: { version: "clawrouter.minimax-video.v5" }, videoActor: { role: "admin" } });
  assert.equal(forged.status, 400); await forged.text();
  // Reachable maximum remains a separate, same-owner phase; pool state is last.
  await json("/setup?cninline=1"); io.mode("maximum"); const pool = await json("/maximum-pool?cninline=1");
  const input = { ...lastBody, prompt: "x".repeat(2000) }, text = JSON.stringify(input), nonimage = Buffer.byteLength(text) - input.first_frame_image.split(",")[1].length;
  const r = await call(native, text + " ".repeat(65536 - nonimage), { "idempotency-key": "cn-inline-max" }, "max-held", "combined-cn-inline");
  let state = await r.json(); assert.equal(state.status, 200, JSON.stringify(state)); assert.equal(state.charged, 96 * MiB);
  assert.equal(state.candidates, pool.candidates); assert.equal(state.controlMaxValues, 512); assertInlineCreateCalls(state, { lookup: true });
  assert.equal(state.nativeBytes, MiB); assert.ok(state.nativeMaxBacking <= 16384); assert.equal(state.releases, 0);
  assert.deepEqual(await json("/contend"), { allowed: false, charged: 96 * MiB });
  io.release("combined-cn-inline/output"); state = await idle(); assert.equal(state.releases, 1);
});
