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
import {PolicyBindingIndexObject as Authority,BudgetLedgerObject as Budget,UsageLedgerObject as Usage} from './worker/index.ts';
import {GrantCredentialObject as Credentials} from './worker/grant-credentials.ts';
import {authorityCall} from './worker/authority.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged,BodyLease} from './worker/body-budget.ts';
import {beginMiniMaxMusicCoverWaveInput,beginMiniMaxMusicCoverInput,claimMiniMaxMusicCoverInput} from './worker/minimax-music-cover-input.ts';
import {composePrivateMiniMaxMusicCover} from './worker/minimax-music-cover-authority.ts';
import {MiniMaxMusicCoverControl,musicCoverControlHeader,musicCoverControlVersion} from './worker/minimax-music-cover-control.ts';
import {musicCoverVerification} from './worker/proxy-auth.ts';
import {MusicCoverUploadSource} from './worker/minimax-music-cover-upload.ts';
export class UsageLedgerObject extends Usage {
 constructor(state,env){super(state,env);this.fixtureState=state;}
 async fetch(request){const u=new URL(request.url);if(u.pathname==='/fixture/event'){
  const row=[...this.fixtureState.storage.sql.exec('SELECT event_json FROM usage_events WHERE id=?',u.searchParams.get('id'))][0];
  return Response.json(row?JSON.parse(row.event_json):null);
 }return super.fetch(request);}
}


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
  if((path==='/settle'||path==='/charge')&&mode==='fallback'){
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
const produce=MusicCoverUploadSource.prototype.produce;
MusicCoverUploadSource.prototype.produce=async function(controller){const a=active;if(a)a.upload=this;
 if(a?.mode==='early'&&this.emitted+2===this.length){a.uploadHeld=true;await gate(a.mode,'upload');}
 return produce.call(this,controller);
};
const handoff=MiniMaxMusicCoverControl.prototype.tryPostHandoff;
MiniMaxMusicCoverControl.prototype.tryPostHandoff=function(cap,read,...args){
 const a=active;if(a){a.handoffRetired=this.tickets[this.finalRead.index].released;a.handoffIdle=!this.active[0];a.handoffCharged=bodyBudgetCharged();}
 if(a?.mode==='busy')this.queues[0].push(()=>{});
 try{return handoff.call(this,a?.mode==='capsule'?{...cap}:cap,read,...args);}
 finally{if(a?.mode==='busy')this.queues[0].pop();}
};
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
 if(String(url)!=='https://api.minimax.io/v1/music_generation')return realFetch(url,init);
 const a=active;a.post++;const response=await realFetch(url,init);a.headers=true;
 if(['read','reject','late','unlock'].includes(a.mode)){
  a.source=response.body;const get=response.body.getReader.bind(response.body);let first;
  response.body.getReader=options=>{const reader=get(options);return {
   async read(view){a.reads++;const part=await reader.read(view);
    if(a.mode==='read'||a.mode==='reject'){a.held=true;await gate(a.mode,'read');}return part;},
   cancel(reason){if(!first){let resolve,reject;first=new Promise((yes,no)=>{resolve=yes;reject=no;});
    Promise.resolve().then(async()=>{a.cancels++;try{await reader.cancel(reason);}finally{
     a.cancelHeld=true;if(a.mode!=='unlock')await a.cleanupGate;a.cleanup=true;if(a.mode==='reject')throw Error('fixture FIRST cancel rejection');
    }}).then(resolve,reject);}return first;},
   releaseLock(){a.unlocks++;if(a.mode==='unlock')throw Error('fixture unknown unlock');reader.releaseLock();}
  };};
  if(a.mode==='late'){a.held=true;await gate(a.mode,'late');}
 }
 return response;
};
async function consume(response,a){const reader=response.body.getReader();try{for(;;){const p=await reader.read();if(p.done)break;
 if(p.value.buffer.byteLength>16384)throw Error('output backing');a.outputBytes+=p.value.length;
}}finally{reader.releaseLock();}}

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
 post:active.post,headers:active.headers,published:active.published,uploadHeld:active.uploadHeld,upload:active.upload?.snapshot(),handoffRetired:active.handoffRetired,handoffIdle:active.handoffIdle,handoffCharged:active.handoffCharged,outputBytes:active.outputBytes,eventId:active.eventId,
 snapshot:active.flow?.snapshot(),retainedControl:retainedControl(active.controlOwner),ids:active.ids,queue:active.queue,maximumControls:active.maximumControls}:{};
function controlEnvironment(bindings,a){
 const env={...bindings};
 for(const name of ['ACCESS_CONTROL','GRANT_CREDENTIALS','BUDGET_LEDGER','USAGE_LEDGER']){
  const namespace=bindings[name];env[name]={idFromName:n=>namespace.idFromName(n),get:id=>{const stub=namespace.get(id);return {async fetch(url,init){
   const path=new URL(url).pathname,owned=new Headers(init?.headers).get(musicCoverControlHeader)===musicCoverControlVersion;
   if(!owned)return stub.fetch(url,init);
   a.calls.push(path);if(path==='/materialize')a.materializations++;
   if(path==='/authorization/snapshot'&&((a.mode.startsWith('preprice-')&&a.calls.filter(p=>p===path).length===1)
      ||['coverage','rotate','revoke'].includes(a.mode)&&a.calls.filter(p=>p===path).length===2)){a.held=true;await gate(a.mode,'policy');}

   if(['/reserve','/dispatch','/settle','/charge'].includes(path)){const b=JSON.parse(init.body);a.ids.push({path,id:b.reservationId??b.chargeId,amount:b.actualCostMicros??b.amountMicros});}
   const outgoing=name==='BUDGET_LEDGER'?{...init,headers:{...Object.fromEntries(new Headers(init.headers)),'x-fixture-cover-mode':a.mode}}:init;
   let response=await stub.fetch(url,outgoing);
   if(a.mode==='held-settle'&&path==='/settle'&&a.calls.filter(p=>p==='/settle').length===1){a.held=true;await gate(a.mode,'settle');}
   if(name==='BUDGET_LEDGER'&&response.headers.get('content-length')==='16384')a.maximumControls++;
   if((a.mode==='partial'&&path==='/reserve'&&a.calls.filter(p=>p==='/reserve').length===2)||(a.mode==='dispatch-lost'&&path==='/dispatch'&&a.calls.filter(p=>p==='/dispatch').length===2)){await response.body.cancel();return new Response(null,{status:503});}
   if(a.mode==='malformed'&&path==='/reserve'&&a.calls.filter(p=>p===path).length===2){await response.body.cancel();return Response.json({allowed:true,chargedMicros:'700'});}
   return response;
  }}}};
 }
 const queue=bindings.USAGE_QUEUE;env.USAGE_QUEUE={async send(message){a.queue++;if('type' in message)a.eventId=message.id;if(a.mode==='fallback')throw Error('synthetic queue failure');return queue.send(message);}};
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
 if(url.pathname==='/fixture/event')return env.USAGE_LEDGER.get(env.USAGE_LEDGER.idFromName('policy:fixture:fixture')).fetch(request);
 if(url.pathname==='/fixture/abort'){active?.requestAbort();if(active?.flow)context.waitUntil(active.flow.retired.catch(()=>{}));return Response.json({ok:true});}
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
   held:false,cleanup:false,calls:[],ids:[],materializations:0,queue:0,maximumControls:0,post:0,outputBytes:0},controller=new AbortController();
  const abortRequested=new Promise(resolve=>{a.requestAbort=resolve;});void abortRequested.then(()=>controller.abort('fixture caller abort'));
  if(['read','reject','late'].includes(a.mode)){a.cleanupGate=gate(a.mode,'cleanup');void a.cleanupGate.catch(()=>{});}
  const input=(a.mode==='opaque'?beginMiniMaxMusicCoverInput:beginMiniMaxMusicCoverWaveInput)({body:request.body,signal:controller.signal,deadlineAt:Date.now()+60000,
   route:url.searchParams.get('route')==='manifest'?'manifest':'native',contentType:'application/json'});
  try{
   const sealed=await input.result;
   if(a.mode==='metadata')claimMiniMaxMusicCoverInput(sealed);
   a.flow=composePrivateMiniMaxMusicCover(controlEnvironment(env,a),request.headers,a.mode==='forged'?{...sealed}:sealed);
   try{const response=await a.flow.result;a.published=true;
    if(a.mode==='unclaimed')await gate(a.mode,'delivery');
    if(a.mode==='downstream')await response.body.cancel();else await consume(response,a);
   }catch(error){a.code=error?.code??'cancelled';}finally{a.done=true;}
   if(a.mode==='unlock'){context.waitUntil(a.flow.retired);return Response.json(state());}
   try{await a.flow.retired;}catch{a.cleanupCode='control_cleanup';}
  }catch(error){a.code=error?.code??'failure';a.done=true;await input.discard().catch(()=>{});}
  try{await input.retired;}catch{a.cleanupCode??='input_cleanup';}a.retired=true;
  return Response.json(state());
 }
 return worker.fetch(request,env,context);
},queue:worker.queue};`;

const MiB = 1024 * 1024;
function waveHeader(bytes, channels = 1, extras = 0) {
  const header = Buffer.alloc(44 + extras * 8), at = header.length - 8;
  header.write("RIFF"); header.writeUInt32LE(bytes - 8, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(48000 * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  for (let i = 0; i < extras; i++) header.write("JUNK", 36 + i * 8);
  header.write("data", at); header.writeUInt32LE(bytes - header.length, at + 4); return header;
}
function waveInput(bytes = 576044, route = "native", channels = 1, extras = 0) {
  const header = waveHeader(bytes, channels, extras), first = Buffer.alloc(Math.ceil(header.length / 3) * 3);
  header.copy(first); const encodedHeader = Buffer.from(first.toString("base64"));
  const prefix = Buffer.from((route === "manifest" ? '{"body":' : "") + '{"audio_base64":"');
  const suffix = Buffer.from('","prompt":"Synthetic cover style","model":"music-cover"}' + (route === "manifest" ? "}" : ""));
  const encoded = Math.ceil(bytes / 3) * 4, padding = (3 - bytes % 3) % 3; let phase = 0, offset = 0;
  return { encodedHeader, encoded, padding, length: prefix.length + encoded + suffix.length,
    body: new ReadableStream({ pull(controller) {
      if (!phase) { phase = 1; controller.enqueue(prefix); return; }
      if (offset < encoded) {
        const size = Math.min(16384, encoded - offset), chunk = Buffer.alloc(size, 65);
        for (let i = 0; i < size; i++) {
          if (offset + i < encodedHeader.length) chunk[i] = encodedHeader[offset + i];
          else if (offset + i >= encoded - padding) chunk[i] = 61;
        }
        offset += size; controller.enqueue(chunk); return;
      }
      if (phase === 1) { phase = 2; controller.enqueue(suffix); return; } controller.close();
    } }, { highWaterMark: 0 }) };
}

test("private authorized cover actual Workerd: WAVE custody, original authority, one POST and original-ID settlement", { timeout: 180000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "cover-composition-workerd-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const held = new Map(), arrived = new Set(), released = new Set(), clients = new Set(), serverErrors = [];
  let mode = "normal", source, audio = 3, posts = 0, uploaded = 0, valid = true, earlyReply, postEntered;
  const release = key => { released.add(key); held.get(key)?.end("ok"); held.delete(key); };
  const releaseAll = () => {
    for (const m of ["unclaimed", "early", "read", "reject", "late", "rotate", "revoke", "coverage", "held-settle", "preprice-current"])
      for (const p of ["upload", "delivery", "read", "cleanup", "late", "policy", "settle"]) release("/" + m + "/" + p);
  };
  const server = createServer((request, response) => {
    if (request.url.startsWith("/gate/")) {
      const key = request.url.slice(5); arrived.add(key); if (released.has(key)) response.end("ok"); else held.set(key, response); return;
    }
    if (request.url !== "/provider" || request.method !== "POST" || request.headers.authorization !== "Bearer synthetic-cover-original") {
      response.writeHead(400); response.end(); return;
    }
    posts++; const current = mode, input = source, expectedAudio = audio;
    const prefix = Buffer.from('{"model":"music-cover","prompt":"Synthetic cover style","stream":false,"output_format":"hex","audio_base64":"');
    const suffix = Buffer.from('"}'); let count = 0, sent = false;
    request.on("data", chunk => {
      for (const byte of chunk) {
        const at = count - prefix.length;
        const expected = count < prefix.length ? prefix[count] : at < input.encoded
          ? at < input.encodedHeader.length ? input.encodedHeader[at] : at < input.encoded - input.padding ? 65 : 61
          : suffix[at - input.encoded];
        if (byte !== expected) valid = false; count++;
      }
      uploaded = count;
    });
    request.on("error", error => { if (!(current === "early" && sent && error.code === "ECONNRESET")) serverErrors.push(error); });
    const send = async () => {
      if (sent || response.destroyed) return; sent = true;
      if (current === "lost-response") { response.destroy(); return; }
      const p = '{"base_resp":{"status_code":0},"data":{"status":2,"audio":"', s = '"}}';
      response.writeHead(200, { "content-type": "application/json", "content-length": String(p.length + expectedAudio * 2 + s.length) });
      const write = async value => {
        if (response.destroyed) return false;
        if (!response.write(value)) await new Promise(resolve => {
          const complete = () => { response.off("drain", complete); response.off("close", complete); resolve(); };
          response.once("drain", complete); response.once("close", complete);
        });
        return !response.destroyed;
      };
      if (!await write(p)) return;
      for (let remaining = expectedAudio * 2; remaining;) { const n = Math.min(16384, remaining); remaining -= n; if (!await write("ab".repeat(n / 2))) return; }
      response.end(s);
    };
    earlyReply = send;
    postEntered?.(); postEntered = undefined;
    request.on("end", () => {
      if (count !== prefix.length + input.encoded + suffix.length) valid = false;
      if (current !== "early") void send().catch(error => serverErrors.push(error));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const access = await musicAccessFixture(), origin = "http://127.0.0.1:" + server.address().port;
  const upstream = `export default {fetch(request){const u=new URL(request.url);
   if(u.href==='https://music-admin-fixture.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json({keys:[${JSON.stringify(access.jwk)}]});
   if(u.hostname==='cover-authority-gate.example')return fetch(${JSON.stringify(origin)}+'/gate'+u.pathname,{redirect:'manual'});
   if(u.href==='https://api.minimax.io/v1/music_generation')return fetch(${JSON.stringify(origin)}+'/provider',request);
   throw Error('unqualified fixture destination');}};`;
  const runtime = await startWorkerdFixture(temporary, router.replace("ACCESS_ENV", JSON.stringify(access.env)), upstream, { preventEviction: true });
  t.after(async () => {
    releaseAll();
    try {
      const outcomes = await Promise.allSettled([...clients]);
      const errors = outcomes.filter(x => x.status === "rejected").map(x => x.reason);
      if (errors.length || serverErrors.length) throw new AggregateError([...errors, ...serverErrors], "fixture transport failure");
    } finally { await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  const call = async path => {
    const r = await runtime.dispatchFetch("https://router.example/fixture/" + path);
    assert.equal(r.status, 200, await r.clone().text()); return r.json();
  };
  const attest = async (key = "synthetic-cover-original", replace = false) => {
    const r = await runtime.dispatchFetch("https://router.example/v1/admin/upstream-grants/policies/fixture/cover" + (replace ? "?mode=replace" : ""), {
      method: "PUT", headers: { ...access.headers, "content-type": "application/json" }, body: JSON.stringify({ provider: "minimax", kind: "api_key", enabled: true,
        accountId: "cover-account", credential: key, nativeMediaAuthorization: "minimax-global-music-cover-inline-audio" }) });
    assert.equal(r.status, 200, await r.clone().text()); await r.body.cancel();
  };
  const start = (nextMode = "normal", bytes = 576044, route = "native", channels = 1, extras = 0, output = 3) => {
    mode = nextMode; source = waveInput(bytes, route, channels, extras); audio = output; valid = true; uploaded = 0;
    const before = posts;
    const entered = mode === "early" ? new Promise(resolve => { postEntered = resolve; }) : undefined;
    const pending = runtime.dispatchFetch("https://router.example/fixture/start?mode=" + mode + "&route=" + route, {
      method: "POST", headers: { authorization: "Bearer clawrouter-live-cover-cover-secret", "content-type": "application/json", "content-length": String(source.length) },
      body: source.body, duplex: "half",
    }).then(async response => { assert.equal(response.status, 200, await response.clone().text()); return response.json(); });
    clients.add(pending); void pending.then(() => clients.delete(pending), () => {});
    const witnessed = entered && Promise.race([entered, pending.then(() => { throw Error("request finished before provider POST"); })]);
    if (witnessed) void witnessed.catch(() => {}); // The owned client and explicit entry wait still propagate failure.
    return { pending, before, entered: witnessed };
  };
  const wait = async predicate => {
    for (let i = 0; i < 500; i++) {
      const value = await call("state");
      if (value.mode === mode && predicate(value)) return value;
      if (value.mode === mode && value.retired) throw Error("early fixture retirement " + JSON.stringify(value));
      await delay(10);
    }
    throw Error("composition boundary absent " + JSON.stringify(await call("state")));
  };
  const receipt = async state => {
    assert.ok(state.eventId);
    for (let i = 0; i < 200; i++) { const event = await call("event?id=" + state.eventId); if (event) return event; await delay(10); }
    throw Error("original usage receipt absent");
  };
  const retired = state => {
    assert.equal(state.charged, 0, JSON.stringify(state)); assert.equal(state.retired, true);
    assert.deepEqual(state.retainedControl, { transports: 0, verifier: false, phase: false, operation: false });
  };
  await call("configure"); await attest();
  for (const soft of [false, true]) for (const route of ["native", "manifest"]) {
    await call("configure?soft=" + soft);
    const client = start("maximum", 50_000_000, route, 2, 0, 4 * MiB), value = await client.pending;
    retired(value); assert.equal(value.code, undefined, JSON.stringify(value)); assert.equal(value.published, true);
    assert.equal(value.snapshot.ordinary, soft ? 13 : 17); assert.equal(value.snapshot.mandatory, 5);
    assert.equal(value.post, 1); assert.equal(posts - client.before, 1); assert.equal(valid, true); assert.ok(uploaded > 66_000_000);
    assert.equal(value.handoffRetired, true); assert.equal(value.handoffIdle, true); assert.equal(value.upload.references, 0);
    assert.equal(value.handoffCharged, 96 * MiB);
    assert.ok(value.outputBytes > 8 * MiB); assert.equal(value.maximumControls, soft ? 8 : 12);
    const event = await receipt(value); assert.equal(event.actual_cost_micros, 700); assert.equal(event.cost_basis, "policy_fixed");
    assert.equal(event.status, "success"); assert.equal(event.input_tokens, null); assert.equal(event.reporting_known_cost_micros, null);
    const settled = value.ids.filter(x => x.path === (soft ? "/charge" : "/settle")); assert.equal(settled.length, 4);
    assert.ok(settled.every(x => x.amount === 700));
    if (!soft) assert.deepEqual(settled.map(x => x.id), value.ids.filter(x => x.path === "/reserve").map(x => x.id));
  }
  await call("configure");
  for (const [bytes, channels, extras] of [[50_000_000, 1, 0], [576044, 3, 0], [576044 + 31 * 8, 1, 31]]) {
    const client = start("invalid-wave", bytes, "native", channels, extras), value = await client.pending;
    assert.ok(value.code); assert.equal(value.calls.length, 0); assert.equal(value.post, 0); assert.equal(value.charged, 0);
    assert.equal(posts, client.before);
  }
  retired(await start("chunks32", 576044 + 30 * 8, "native", 1, 30).pending);
  for (const m of ["opaque", "forged", "metadata", "capsule", "busy"]) {
    const client = start(m), value = await client.pending; assert.ok(value.code, m); assert.equal(value.charged, 0);
    assert.equal(value.post, 0); assert.equal(posts, client.before);
  }
  await call("configure?unknown=true");
  const unknown = await start("unpriced").pending;
  assert.equal(unknown.code, "pricing_required"); assert.equal(unknown.materializations, 0); assert.equal(unknown.post, 0);
  await call("configure");
  const repriced = start("preprice-current");
  try {
    await wait(s => s.held); await call("configure?unknown=true"); release("/preprice-current/policy");
    const value = await repriced.pending; retired(value); assert.equal(value.code, "pricing_required");
    assert.equal(value.materializations, 0); assert.equal(value.post, 0);
  } finally { release("/preprice-current/policy"); await repriced.pending; await call("configure"); }
  for (const m of ["partial", "malformed", "dispatch-lost", "fallback", "lost-response"]) {
    const client = start(m), value = await client.pending; retired(value);
    const reserve = value.ids.filter(x => x.path === "/reserve"), settle = value.ids.filter(x => x.path === "/settle");
    assert.deepEqual(settle.map(x => x.id), reserve.map(x => x.id));
    assert.equal(value.post, ["partial", "malformed", "dispatch-lost"].includes(m) ? 0 : 1);
    assert.equal(posts - client.before, value.post); assert.equal(value.snapshot.mandatory, m === "fallback" ? 10 : reserve.length + 1);
    const event = await receipt(value); assert.equal(event.actual_cost_micros, value.post ? 700 : 0);
    assert.equal(event.cost_basis, value.post ? "policy_fixed" : "not_dispatched");
  }
  for (const m of ["rotate", "revoke", "coverage"]) {
    const client = start(m); let primary;
    try {
      await wait(value => value.held); assert.equal((await call("contend")).allowed, false);
      if (m === "coverage") await call("user?budget=daily");
      else if (m === "rotate") await attest("synthetic-cover-rotated");
      else {
        const r = await runtime.dispatchFetch("https://router.example/v1/admin/upstream-grants/policies/fixture/cover/revoke", { method: "POST", headers: access.headers });
        assert.equal(r.status, 200, await r.clone().text()); await r.body.cancel();
      }
      release("/" + m + "/policy"); const value = await client.pending;
      retired(value); assert.ok(value.code); assert.equal(value.post, 0); assert.equal(posts, client.before);
    } catch (error) { primary = error; }
    finally {
      release("/" + m + "/policy");
      for (const cleanup of [() => client.pending, () => call("user"), () => attest(undefined, m === "revoke")]) {
        try { await cleanup(); } catch (error) { primary = primary ? new AggregateError([primary, error]) : error; }
      }
    }
    if (primary) throw primary;
  }
  const unclaimed = start("unclaimed");
  try {
    const value = await wait(s => s.published); assert.equal(value.charged, 96 * MiB);
    assert.equal(value.calls.filter(x => x === "/settle").length, 0); assert.equal(value.snapshot.ordinaryActive, 1);
    assert.equal((await call("contend")).allowed, false); release("/unclaimed/delivery"); retired(await unclaimed.pending);
  } finally { release("/unclaimed/delivery"); await unclaimed.pending; }
  const heldSettle = start("held-settle");
  try {
    const value = await wait(s => s.held);
    assert.equal(value.published, true); assert.equal(value.outputBytes > 0, true);
    assert.equal(value.charged, 32 * MiB); assert.equal(value.snapshot.ordinaryActive, 0);
    assert.equal(value.snapshot.mandatoryActive, 1); assert.equal(value.calls.filter(x => x === "/settle").length, 1);
    release("/held-settle/settle"); retired(await heldSettle.pending);
  } finally { release("/held-settle/settle"); await heldSettle.pending; }
  for (const m of ["early", "read", "reject", "late"]) {
    const client = start(m); let primary;
    try {
      if (m === "early") {
        await wait(s => s.uploadHeld && s.post === 1); await client.entered;
        assert.equal(posts - client.before, 1); await earlyReply();
        await wait(s => s.headers);
      } else await wait(s => s.held);
      assert.equal((await call("contend")).allowed, false); await call("abort");
      const stopped = await wait(s => s.done); assert.equal(stopped.charged, 96 * MiB);
      assert.equal(stopped.calls.filter(x => x === "/settle").length, 0);
      if (m === "early") release("/early/upload");
      else {
        if (m === "late") { assert.equal(stopped.reads, 0); release("/late/late"); }
        await wait(s => s.cancels === 1 && arrived.has("/" + m + "/cleanup")); release("/" + m + "/cleanup");
        if (m !== "late") { const cleaned = await wait(s => s.cleanup); assert.equal(cleaned.locked, true); assert.equal(cleaned.charged, 96 * MiB); }
        release("/" + m + "/read");
      }
      const value = await client.pending; retired(value); assert.equal(value.post, 1);
      assert.equal((await receipt(value)).actual_cost_micros, 700);
      if (m === "reject") assert.equal(value.cleanupCode, "control_cleanup");
    } catch (error) { primary = error; }
    finally {
      for (const phase of ["upload", "read", "cleanup", "late"]) release("/" + m + "/" + phase);
      try { await client.pending; } catch (error) { primary = primary ? new AggregateError([primary, error]) : error; }
    }
    if (primary) throw primary;
  }
  // Final isolated invocation: unknown unlock must retain ownership. Runtime
  // teardown is not an application retirement or a successful cleanup receipt.
  const blocked = await start("unlock").pending;
  assert.ok(blocked.code); assert.equal(blocked.charged, 96 * MiB); assert.equal(blocked.locked, true);
  assert.equal(blocked.snapshot.ordinaryActive, 1); assert.equal(blocked.calls.filter(x => x === "/settle").length, 0);
  assert.equal((await call("contend")).allowed, false);
});
