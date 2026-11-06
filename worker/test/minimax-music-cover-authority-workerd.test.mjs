import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { musicAccessFixture } from "./minimax-music-admin-fixture.mjs";

const router = String.raw`
import worker from './worker/index.ts';
import {PolicyBindingIndexObject as Authority,BudgetLedgerObject as Budget,UsageLedgerObject} from './worker/index.ts';
import {GrantCredentialObject as Credentials} from './worker/grant-credentials.ts';
import {authorityCall} from './worker/authority.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged,BodyLease} from './worker/body-budget.ts';
import {beginMiniMaxMusicCoverInput,claimMiniMaxMusicCoverInput} from './worker/minimax-music-cover-input.ts';
import {prepareInactiveMiniMaxMusicCover,isInactiveMusicCoverPreparation} from './worker/minimax-music-cover-authority.ts';
import {MiniMaxMusicCoverControl,musicCoverControlHeader,musicCoverControlVersion} from './worker/minimax-music-cover-control.ts';
import {musicCoverVerification} from './worker/proxy-auth.ts';
export {UsageLedgerObject};
function maximumControl(value){
 const row={...value,padding:'x'.repeat(4096),discarded:[]};
 const count=v=>1+(v&&typeof v==='object'?Object.values(v).reduce((sum,item)=>sum+count(item),0):0);
 while(count(row)<128)row.discarded.push(null);
 if(count(row)!==128)throw Error('fixture control node bound');
 const text=JSON.stringify(row);if(text.length>16384)throw Error('fixture control wire bound');
 return new Response(text+' '.repeat(16384-text.length),{headers:{'content-type':'application/json','content-length':'16384'}});
}
export class BudgetLedgerObject extends Budget {
 async fetch(request){
  const mode=request.headers.get('x-fixture-cover-mode'),path=new URL(request.url).pathname;
  const response=await super.fetch(request);
  if(!mode||!response.ok)return response;
  if(path==='/settle'&&mode==='bodyless'){await response.body?.cancel();return new Response(null,{status:503});}
  const value=await response.json();
  if(path==='/settle'&&mode==='fallback'){
   const error=maximumControl({error:'synthetic bounded rejection'});return new Response(error.body,{status:503,headers:error.headers});
  }
  return maximumControl(value);
 }
}
const admin='music-admin@example.invalid',principal='cover-user@example.invalid';
const gate=(mode,phase)=>fetch('https://cover-authority-gate.example/'+mode+'/'+phase,{redirect:'manual'}).then(async r=>{if(!r.ok)throw Error('fixture gate');await r.text();});
export class PolicyBindingIndexObject extends Authority {
 constructor(state,env){super(state,env);this.fixtureState=state;}
 async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/fixture/oversize'){
   const sql=this.fixtureState.storage.sql;
   if(url.searchParams.get('on')==='true'){
    this.originalPolicy=[...sql.exec("SELECT policy_json FROM access_policies WHERE policy_id='fixture'")][0]?.policy_json;
    sql.exec("UPDATE access_policies SET policy_json=? WHERE policy_id='fixture'",' '.repeat(16385));
   }else if(this.originalPolicy)sql.exec("UPDATE access_policies SET policy_json=? WHERE policy_id='fixture'",this.originalPolicy);
   return Response.json({ok:true});
  }
  return super.fetch(request);
 }
}
export class GrantCredentialObject extends Credentials {
 constructor(state,env){
  const held={armed:false},namespace=env.ACCESS_CONTROL;
  super(state,{...env,ACCESS_CONTROL:{idFromName:n=>namespace.idFromName(n),get:id=>{const stub=namespace.get(id);return {async fetch(url,init){
   const reply=await stub.fetch(url,init);
   if(held.armed&&new URL(url).pathname==='/grant-pools/admit'){held.armed=false;await gate('admin','pool');}
   return reply;
  }}}}});this.fixtureState=state;this.fixtureHeld=held;
 }
 async fetch(request){const url=new URL(request.url);
  if(url.pathname==='/fixture/arm'){this.fixtureHeld.armed=true;return Response.json({armed:true});}
  if(url.pathname==='/fixture/pin'){const r=await this.fixtureState.storage.get('credential');return Response.json(r?{
   generation:r.generation,lineage:r.lineage,binding:r.nativeMediaBinding??null,account:r.accountId,
   fingerprint:await sha256Hex(r.credential??''),enabled:r.enabled,pending:r.poolSyncPending??false}:null);}
  return super.fetch(request);
 }
}
let initialized,active;
const originalControlJson=MiniMaxMusicCoverControl.prototype.controlJson;
MiniMaxMusicCoverControl.prototype.controlJson=function(...args){if(active)active.controlOwner=this;return originalControlJson.apply(this,args);};
function retainedControl(owner){return owner?{
 transports:owner.tickets.reduce((n,t)=>n+Number(!!t.response)+Number(!!t.input)+Number(!!t.cancellation)+Number(!!t.work),0),
 verifier:!!musicCoverVerification(owner),phase:!!owner.controlPhase,operation:!!owner.activeOperation}:null;}
const policy=(soft=false,price=700)=>({enabled:true,generation:'g1',providers:['minimax'],models:['minimax/music-cover'],tenantId:'fixture',
 budgetMode:soft?'soft':'reserve',budgetScope:'principal',monthlyBudgetMicros:100000,dailyBudgetMicros:100000,weeklyBudgetMicros:100000,
 requestCostMicros:price,retainRequestContent:false,grantRouting:{eligibleGrants:{minimax:['cover']},environmentFallback:false,failover:false}});
const state=()=>active?{mode:active.mode,charged:bodyBudgetCharged(),done:active.done,retired:active.retired,code:active.code,
 cleanupCode:active.cleanupCode,calls:active.calls,materializations:active.materializations,reads:active.reads,cancels:active.cancels,
 unlocks:active.unlocks,locked:active.source?.locked??false,held:active.held,cleanup:active.cleanup,prepared:active.prepared,
 snapshot:active.flow?.snapshot(),retainedControl:retainedControl(active.controlOwner),ids:active.ids,queue:active.queue,maximumControls:active.maximumControls,post:0}:{};
function controlEnvironment(bindings,a){
 const env={...bindings};
 for(const name of ['ACCESS_CONTROL','GRANT_CREDENTIALS','BUDGET_LEDGER','USAGE_LEDGER']){
  const namespace=bindings[name];env[name]={idFromName:n=>namespace.idFromName(n),get:id=>{const stub=namespace.get(id);return {async fetch(url,init){
   const path=new URL(url).pathname,owned=new Headers(init?.headers).get(musicCoverControlHeader)===musicCoverControlVersion;
   if(!owned)return stub.fetch(url,init);
   a.calls.push(path);if(path==='/materialize')a.materializations++;
   if(path==='/authorization/snapshot'&&((a.mode.startsWith('preprice-')&&a.calls.filter(p=>p===path).length===1)
      ||a.mode==='coverage'&&a.calls.filter(p=>p===path).length===2)){a.held=true;await gate(a.mode,'policy');}

   if(['/reserve','/dispatch','/settle'].includes(path))a.ids.push({path,id:JSON.parse(init.body).reservationId});
   const outgoing=name==='BUDGET_LEDGER'?{...init,headers:{...Object.fromEntries(new Headers(init.headers)),'x-fixture-cover-mode':a.mode}}:init;
   let response=await stub.fetch(url,outgoing);
   if(name==='BUDGET_LEDGER'&&response.headers.get('content-length')==='16384')a.maximumControls++;
   if(a.mode==='partial'&&path==='/reserve'&&a.calls.filter(p=>p==='/reserve').length===2){await response.body.cancel();return new Response(null,{status:503});}
   if(['policy','read','reject','late'].includes(a.mode)&&path==='/authorization/snapshot'&&a.calls.filter(p=>p===path).length===2){
    a.source=response.body;const get=response.body.getReader.bind(response.body);let cancellation;
    response.body.getReader=options=>{const reader=get(options);return {
     async read(view){a.reads++;try{return await reader.read(view);}finally{
      if(a.mode==='read'||a.mode==='reject'){a.held=true;await gate(a.mode,'read');}
     }},cancel(reason){if(!cancellation){let resolve,reject;cancellation=new Promise((yes,no)=>{resolve=yes;reject=no;});
      void Promise.resolve().then(async()=>{a.cancels++;try{await reader.cancel(reason);}finally{
       await gate(a.mode,'cleanup');a.cleanup=true;if(a.mode==='reject')throw Error('synthetic first cancellation rejection');
      }}).then(resolve,reject);}return cancellation;},releaseLock(){a.unlocks++;reader.releaseLock();}
    };};
    if(a.mode==='policy'||a.mode==='late'){a.held=true;await gate(a.mode,a.mode==='policy'?'policy':'late');}
   }
   return response;
  }}}};
 }
 const queue=bindings.USAGE_QUEUE;env.USAGE_QUEUE={async send(message){a.queue++;if(a.mode==='fallback')throw Error('synthetic queue failure');return queue.send(message);}};
 return env;
}
export default {async fetch(request,bindings,context){
 const env={...bindings,...ACCESS_ENV},url=new URL(request.url);
 initialized??=(async()=>{
  await authorityCall(env,'/users/initialize-all',[
   {email:admin,record:{role:'admin',enabled:true,tenantId:'fixture',groups:[],contentRetentionDisabled:false}},
   {email:principal,record:{role:'user',enabled:true,tenantId:'fixture',groups:[],contentRetentionDisabled:false}}]);
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:policy()}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'cover',credential:{enabled:true,secretSha256:await sha256Hex('cover-secret'),policyId:'fixture',policyGeneration:'g1',principalId:principal}}]);
  await authorityCall(env,'/connections/initialize-all',[{providerId:'minimax',enabled:true,monthlyBudgetMicros:100000}]);
 })();await initialized;
 if(url.pathname==='/fixture/state')return Response.json(state());
 if(url.pathname==='/fixture/contend'){const lease=new BodyLease();try{return Response.json({allowed:lease.grow(1024*1024),charged:bodyBudgetCharged()});}finally{lease.release();}}
 if(url.pathname==='/fixture/configure'){
  const next=policy(url.searchParams.get('soft')==='true',url.searchParams.get('unknown')==='true'?null:700);
  if(url.searchParams.get('unmetered')==='true')next.monthlyBudgetMicros=next.dailyBudgetMicros=next.weeklyBudgetMicros=null;
  await authorityCall(env,'/policies/put',{policyId:'fixture',policy:next});
  await authorityCall(env,'/connections/put',{providerId:'minimax',monthlyBudgetMicros:url.searchParams.get('unmetered')==='true'?null:100000});
  return Response.json({ok:true});
 }
 if(url.pathname==='/fixture/user'){
  await authorityCall(env,'/users/put',{email:url.searchParams.get('admin')==='true'?admin:principal,record:{role:url.searchParams.get('demote')==='true'?'user':url.searchParams.get('admin')==='true'?'admin':'user',enabled:url.searchParams.get('disabled')!=='true',tenantId:'fixture',groups:[],contentRetentionDisabled:false,
   ...(url.searchParams.has('budget')?{budgetOverrides:{fixture:{[url.searchParams.get('budget')+'BudgetMicros']:500,updatedBy:admin,updatedAt:new Date().toISOString()}}}:{})}});
  return Response.json({ok:true});
 }
 if(url.pathname==='/fixture/oversize')return env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings')).fetch(request);
 if(url.pathname==='/fixture/arm'||url.pathname==='/fixture/pin')return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName('oauth/fixture/cover')).fetch(request);
 if(url.pathname==='/fixture/start'){
  if(active&&!active.retired)return new Response(null,{status:409});
  const a=active={mode:url.searchParams.get('mode')??'normal',done:false,retired:false,reads:0,cancels:0,unlocks:0,
   held:false,cleanup:false,calls:[],ids:[],materializations:0,queue:0,maximumControls:0},controller=new AbortController();
  if(['read','reject','late'].includes(a.mode))context.waitUntil(gate(a.mode,'abort').then(()=>controller.abort('fixture caller abort')));
  const input=beginMiniMaxMusicCoverInput({body:request.body,signal:controller.signal,deadlineAt:Date.now()+60000,
   route:url.searchParams.get('route')==='manifest'?'manifest':'native',contentType:'application/json'});
  try{
   const sealed=await input.result;
   if(a.mode==='metadata')claimMiniMaxMusicCoverInput(sealed);
   a.flow=prepareInactiveMiniMaxMusicCover(controlEnvironment(env,a),request.headers,a.mode==='forged'?{...sealed}:sealed);
   try{a.prepared=isInactiveMusicCoverPreparation(await a.flow.result);}catch(error){a.code=error?.code??'cancelled';}finally{a.done=true;}
   try{await a.flow.retired;}catch{a.cleanupCode='control_cleanup';}
  }catch(error){a.code=error?.code??'failure';a.done=true;await input.discard().catch(()=>{});}
  try{await input.retired;}catch{a.cleanupCode??='input_cleanup';}a.retired=true;
  return Response.json(state());
 }
 return worker.fetch(request,env,context);
},queue:worker.queue};`;

function input(bytes = 2, route = "native") {
  const prefix = (route === "manifest" ? '{"body":' : "") + '{"audio_base64":"';
  const tail = '","prompt":"Synthetic cover style","model":"' + "music-cover" + '"}' + (route === "manifest" ? "}" : "");
  let remaining = Math.floor(bytes / 3) * 4, phase = 0;
  return { length: Buffer.byteLength(prefix + tail) + Math.ceil(bytes / 3) * 4,
    body: new ReadableStream({ pull(c) {
      const encode = value => new TextEncoder().encode(value);
      if (!phase) { phase = 1; c.enqueue(encode(prefix)); return; }
      if (remaining) { const count = Math.min(remaining, 16384); remaining -= count; c.enqueue(encode("A".repeat(count))); return; }
      if (phase === 1) { phase = 2; c.enqueue(encode((bytes % 3 === 1 ? "AA==" : bytes % 3 === 2 ? "AAA=" : "") + tail)); return; }
      c.close();
    } }, { highWaterMark: 0 }) };
}

test("inactive cover actual isolated SQL/control owner: full input, authority, counts and physical retirement without POST", { timeout: 180000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "cover-authority-workerd-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const held = new Map(), arrived = new Set(), released = new Set();
  const server = createServer((request, response) => {
    if (request.headers.authorization || !/^\/(admin|policy|read|reject|late|preprice-daily|preprice-weekly|preprice-monthly|coverage)\/(pool|policy|abort|read|cleanup|late)$/.test(request.url)) { response.writeHead(400); response.end(); return; }
    arrived.add(request.url); if (released.has(request.url)) response.end("ok"); else held.set(request.url, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const release = key => { released.add(key); held.get(key)?.end("ok"); held.delete(key); };
  const releaseAll = () => { for (const mode of ["admin", "policy", "read", "reject", "late", "preprice-daily", "preprice-weekly", "preprice-monthly", "coverage"]) for (const phase of ["pool", "policy", "abort", "read", "cleanup", "late"]) release("/" + mode + "/" + phase); };
  const access = await musicAccessFixture();
  const upstream = `export default {fetch(request){const u=new URL(request.url);
    if(u.href==='https://music-admin-fixture.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json({keys:[${JSON.stringify(access.jwk)}]});
    if(u.hostname==='cover-authority-gate.example')return fetch(${JSON.stringify("http://127.0.0.1:" + server.address().port)}+u.pathname,{redirect:'manual'});
    throw Error('inactive cover forbids every provider request');}};`;
  const runtime = await startWorkerdFixture(temporary, router.replace("ACCESS_ENV", JSON.stringify(access.env)), upstream, { preventEviction: true });
  const clients = new Set();
  t.after(async () => {
    releaseAll();
    try { const results = await Promise.allSettled([...clients]); const failed = results.filter(value => value.status === "rejected");
      if (failed.length) throw new AggregateError(failed.map(value => value.reason), "fixture clients failed");
    } finally { await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  const call = async path => { const r = await runtime.dispatchFetch("https://router.example/fixture/" + path); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const put = body => runtime.dispatchFetch("https://router.example/v1/admin/upstream-grants/policies/fixture/cover", {
    method: "PUT", headers: { ...access.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const attest = async (credential = "synthetic-cover-original") => {
    const r = await put({ provider: "minimax", kind: "api_key", enabled: true, accountId: "cover-account", credential,
      nativeMediaAuthorization: "minimax-global-music-cover-inline-audio" });
    assert.equal(r.status, 200, await r.clone().text()); assert.doesNotMatch(await r.text(), /synthetic-cover-original/);
  };
  const start = (mode = "normal", bytes = 2, route = "native") => {
    const stream = input(bytes, route), controller = new AbortController();
    const pending = runtime.dispatchFetch("https://router.example/fixture/start?mode=" + mode + "&route=" + route, {
      method: "POST", headers: { authorization: "Bearer clawrouter-live-cover-cover-secret", "content-type": "application/json", "content-length": String(stream.length) },
      body: stream.body, duplex: "half", signal: controller.signal }).then(async r => { assert.equal(r.status, 200, await r.clone().text()); return r.json(); });
    // This ownership observer is registered before any state assertion. Failed
    // cases release barriers and JOIN the client before runtime disposal.
    clients.add(pending); void pending.then(() => clients.delete(pending), () => {});
    return { pending, controller };
  };
  const wait = async predicate => { for (let i = 0; i < 400; i++) { const value = await call("state"); if (predicate(value)) return value; await delay(10); } throw Error("fixture state boundary did not arrive"); };
  await call("configure"); await attest();
  for (const soft of [false, true]) for (const route of ["native", "manifest"]) {
    await call("configure?soft=" + soft);
    const result = await start("normal", 50_000_000, route).pending;
    assert.equal(result.prepared, true, JSON.stringify(result)); assert.equal(result.snapshot.ordinary, soft ? 12 : 16);
    assert.equal(result.calls.filter(x => x === "/materialize").length, 1);
    assert.equal(result.calls.filter(x => x === "/settle").length, soft ? 0 : 4);
    assert.equal(result.post, 0); assert.equal(result.queue, 1); assert.equal(result.charged, 0);
    assert.equal(result.snapshot.mandatory, soft ? 1 : 5);
    assert.equal(result.maximumControls, soft ? 4 : 12);
    assert.deepEqual(result.retainedControl,{transports:0,verifier:false,phase:false,operation:false});
  }
  await call("configure");
  for (const mode of ["forged", "metadata"]) {
    const result = await start(mode).pending; assert.equal(result.code, "used"); assert.equal(result.calls.length, 0); assert.equal(result.charged, 0);
  }
  await call("configure?unknown=true");
  const unpriced = await start().pending; assert.equal(unpriced.code, "pricing_required"); assert.equal(unpriced.materializations, 0);
  for (const field of ["daily", "weekly", "monthly"]) {
    await call("configure?unknown=true&unmetered=true");
    const mode = "preprice-" + field, client = start(mode);
    try {
      await wait(value => value.mode === mode && value.held); await call("user?budget=" + field); release("/" + mode + "/policy");
      const result = await client.pending; assert.equal(result.code, "pricing_required"); assert.equal(result.materializations, 0); assert.equal(result.post, 0);
    } finally { release("/" + mode + "/policy"); await client.pending; await call("user"); }
  }
  await call("configure");
  const coverageClient = start("coverage");
  try {
    await wait(value => value.mode === "coverage" && value.held); await call("user?budget=daily"); release("/coverage/policy");
    const result = await coverageClient.pending; assert.ok(result.code); assert.equal(result.calls.filter(x => x === "/reserve").length, 4);
    assert.equal(result.calls.filter(x => x === "/settle").length, 4); assert.equal(result.post, 0);
  } finally { release("/coverage/policy"); await coverageClient.pending; await call("user"); }
  await call("oversize?on=true");
  try { const cold = await start().pending; assert.equal(cold.calls.length, 1); assert.equal(cold.materializations, 0); assert.ok(cold.code); }
  finally { await call("oversize?on=false"); }
  for (const mode of ["partial", "bodyless", "fallback"]) {
    const result = await start(mode).pending;
    const reserved = result.ids.filter(x => x.path === "/reserve"), settled = result.ids.filter(x => x.path === "/settle");
    assert.equal(reserved.length, mode === "partial" ? 2 : 4); assert.equal(settled.length, reserved.length);
    assert.deepEqual(settled.map(x => x.id), reserved.map(x => x.id));
    assert.equal(new Set(settled.map(x => x.id)).size, settled.length); assert.equal(result.charged, 0);
    assert.equal(result.snapshot.mandatory, mode === "fallback" ? 10 : mode === "bodyless" ? 9 : 3);
  }
  for (const mode of ["read", "reject", "late"]) {
    const client = start(mode, 50_000_000); let primary;
    try {
      const heldState = await wait(value => value.mode === mode && value.held);
      assert.equal(heldState.charged, 96 * 1024 * 1024); assert.equal((await call("contend")).allowed, false);
      release("/" + mode + "/abort");
      const canceled = await wait(value => value.done); assert.equal(canceled.charged, 96 * 1024 * 1024); assert.equal(canceled.retired, false);
      assert.ok(canceled.retainedControl.transports>0);assert.equal(canceled.retainedControl.verifier,true);
      if (mode === "late") { assert.equal(canceled.reads, 0); release("/late/late"); }
      await wait(value => value.cancels === 1);
      release("/" + mode + "/cleanup");
      const cleanup = await wait(value => value.cleanup);
      if (mode !== "late") { assert.equal(cleanup.locked, true); assert.equal(cleanup.charged, 96 * 1024 * 1024); }
      release("/" + mode + "/read");
      const done = await client.pending; assert.equal(done.charged, 0); assert.equal(done.cancels, 1); assert.equal(done.unlocks, 1);
      assert.deepEqual(done.retainedControl,{transports:0,verifier:false,phase:false,operation:false});
      assert.equal(done.locked, false); if (mode === "reject") assert.equal(done.cleanupCode, "control_cleanup");
      if (mode === "late") assert.equal(done.reads, 0);
    } catch (error) { primary = error; }
    finally {
      for (const phase of ["abort", "read", "cleanup", "late"]) release("/" + mode + "/" + phase);
      try { await client.pending; } catch (error) { primary = primary ? new AggregateError([primary, error], "fixture and client failed") : error; }
    }
    if (primary) throw primary;
  }
  // An owner rotation while final policy transport is held is observed by
  // the LAST original-owner read. This does not claim atomic caller revocation.
  const policyClient = start("policy");
  try { await wait(value => value.held); await attest("synthetic-cover-rotated"); release("/policy/policy");
    const result = await policyClient.pending; assert.ok(result.code); assert.equal(result.post, 0); }
  finally { release("/policy/policy"); release("/policy/cleanup"); await policyClient.pending; await call("user"); }
  const before = await call("pin"); await call("arm");
  const changed = put({ enabled: true, credential: "synthetic-cover-replacement", nativeMediaAuthorization: "minimax-global-music-cover-inline-audio" });
  clients.add(changed); void changed.then(() => clients.delete(changed), () => {});
  try {
    for (let i = 0; !arrived.has("/admin/pool") && i < 400; i++) await delay(10);
    assert.ok(arrived.has("/admin/pool")); await call("user?admin=true&demote=true"); release("/admin/pool");
    const denied = await changed; assert.equal(denied.status, 403, await denied.clone().text()); await denied.text();
    assert.deepEqual(await call("pin"), before);
  } finally { release("/admin/pool"); await changed; }
});
