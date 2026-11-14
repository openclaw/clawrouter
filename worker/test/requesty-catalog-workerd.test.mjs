import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged,BodyLease} from './worker/body-budget.ts';
import {HttpOperation} from './worker/http-operation.ts';
const originalFetch=globalThis.fetch.bind(globalThis),calls=[];
let physicalPending,physical,operation;
const originalWait=HttpOperation.prototype.wait,originalStop=HttpOperation.prototype.stop;
HttpOperation.prototype.wait=function(pending,...args){if(pending===physicalPending){operation=this;physical.operation=this;}return originalWait.call(this,pending,...args);};
HttpOperation.prototype.stop=function(cause,...args){const found=calls.find(c=>c.operation===this);if(found){if(cause==='complete')found.producerEOF=true;if(cause==='caller')found.producerCanceled=true;}return originalStop.call(this,cause,...args);};
globalThis.fetch=(input,init)=>{
 const request=new Request(input,init),proof={url:request.url,method:request.method,redirect:request.redirect,headers:[...request.headers],capacity:bodyBudgetCharged(),bytes:0,canceled:false,readRejected:false,activeReads:0,fetchAborted:false,producerEOF:false,producerCanceled:false};calls.push(proof);physical=proof;
 request.signal.addEventListener('abort',()=>{proof.fetchAborted=true;},{once:true});
 physicalPending=originalFetch(request).then(response=>{
  const reader=response.body?.getReader();if(!reader)return response;
  let terminal;proof.readerDone=new Promise(resolve=>{terminal=resolve;});
  return new Response(new ReadableStream({async pull(controller){proof.activeReads++;let ended=false;try{const next=await reader.read();if(next.done){ended=true;reader.releaseLock();controller.close();}else{proof.bytes+=next.value.byteLength;controller.enqueue(next.value);}}catch(error){proof.readRejected=true;ended=true;throw error;}finally{proof.activeReads--;if(ended){proof.chargeAtReadEnd=bodyBudgetCharged();terminal();}}},async cancel(reason){proof.canceled=true;try{await reader.cancel(reason);}finally{reader.releaseLock();terminal();}}},{highWaterMark:0}),{status:response.status,headers:response.headers});
 });return physicalPending;
};
const provider=structuredClone(snapshot.providers.find(p=>p.id==='openai'));
const endpoint={...provider.endpoints.find(e=>e.id==='models_list'),id:'models_managed',path:'/models/managed',method:'GET',methods:['GET'],request_format:'requesty.models_managed',response_format:'requesty.models_managed',native_proxy:true,timeout_ms:10000,path_params:[],path_param_styles:{},headers:{},query:{}};
Object.assign(provider,{id:'requesty',config_keys:['REQUESTY_API_KEY'],optional_config_keys:[],base_urls:{default:'https://router.requesty.ai/v1'},native_prefixes:['requesty'],routing:{nativePrefixes:['requesty'],modelPrefixes:['requesty/'],baseUrlParam:null,serviceParam:null},auth:{schemes:[{type:'bearer',header:'Authorization',format:'Bearer '+String.fromCharCode(36)+'{secret}',secretKind:'api_key'}],grantTransports:{}},adapter:{...provider.adapter,injectHeaders:{},injectQuery:{},passthroughHeaders:[]},capabilities:[{id:'models.list',endpoint:'models_managed',methods:['GET']}],endpoints:[endpoint],models:[]});
snapshot.providers=[...snapshot.providers.filter(p=>p.id!=='requesty'),provider];
export default {async fetch(request,env){
 const pending=[],ctx={waitUntil:p=>pending.push(p)},drain=async()=>{while(pending.length)await Promise.all(pending.splice(0));};
 await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['requesty'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
 await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
 await authorityCall(env,'/connections/initialize-all',[{providerId:'requesty',enabled:true,monthlyBudgetMicros:10000}]);
 await putGrantCredentials(env,'oauth/fixture/requesty',{provider:'requesty',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
 const call=manifest=>worker.fetch(new Request('https://router.example'+(manifest?'/v1/proxy/requesty/models_managed':'/v1/native/requesty/models/managed'),{headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','x-api-key':'synthetic-caller-key'}}),env,ctx);
 const held=new BodyLease();held.grow(40*1024*1024);const refused=await call(false);const denied=refused.status;await refused.text();const before=calls.length;held.release();await drain();
 const results=[];
 for(const manifest of [false,true]){
  const response=await call(manifest),proof=calls.at(-1),charged=bodyBudgetCharged(),completeAtReturn=proof?.producerEOF;
  if(response.status!==200)throw new Error('catalog status='+response.status+' body='+await response.text());
  const reader=response.body.getReader();let wire='',maximum=0;
  for(;;){const next=await reader.read();if(next.done)break;wire+=new TextDecoder().decode(next.value);maximum=Math.max(maximum,next.value.byteLength);if(!proof.producerEOF&&bodyBudgetCharged()!==32*1024*1024)throw new Error('catalog lease ended before producer EOF');}
  reader.releaseLock();await drain();const value=JSON.parse(wire);
  results.push({manifest,status:response.status,charged,completeAtReturn,count:value.data.length,keys:Object.keys(value),first:value.data[0],last:value.data.at(-1).id,bytes:new TextEncoder().encode(wire).byteLength,maximum,producerEOF:proof.producerEOF,released:bodyBudgetCharged()});
 }
 const cancel=await call(true),cancelProof=calls.at(-1);await cancel.body.cancel();await drain();
 const cancelResult={status:cancel.status,complete:cancelProof.producerEOF,canceled:cancelProof.producerCanceled,released:bodyBudgetCharged()};
 endpoint.timeout_ms=1000;const deadline=await call(false),deadlineProof=calls.at(-1);const deadlineResult={status:deadline.status,body:await deadline.json()};await drain();
 await deadlineProof.readerDone;
 Object.assign(deadlineResult,{readBytes:deadlineProof.bytes,canceled:deadlineProof.canceled,readRejected:deadlineProof.readRejected,activeReads:deadlineProof.activeReads,chargeAtReadEnd:deadlineProof.chargeAtReadEnd,fetchAborted:deadlineProof.fetchAborted,aborted:deadlineProof.operation.signal.aborted,released:bodyBudgetCharged()});
 return Response.json({denied,before,results,cancelResult,deadlineResult,calls:calls.map(({operation,readerDone,...proof})=>proof)});
},queue:worker.queue};`;

const upstream = `
let calls=0;const id=n=>'model-'+String(n).padStart(4,'0')+'x'.repeat(350);
export default {async fetch(request){
 if(request.url!=='https://router.requesty.ai/v1/models/managed'||request.method!=='GET'||request.headers.get('authorization')!=='Bearer synthetic-original-key'||request.headers.has('x-api-key'))return new Response('unqualified',{status:400});
 if(++calls===4){let first=true;return new Response(new ReadableStream({pull(controller){if(first){first=false;controller.enqueue(new TextEncoder().encode('{"data":['));}}},{highWaterMark:0}),{headers:{'content-type':'application/json'}});}
 return Response.json({data:Array.from({length:4096},(_,n)=>({id:id(n),api:'chat',input_price:'0.2',output_price:0}))});
}};`;

test("workerd Requesty native/manifest actual fetch holds capacity through 4096-row publication and real reader cancellation", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-requesty-workerd-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const instance = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true }); t.after(() => instance.dispose());
  const response = await fetch((await instance.ready).origin); assert.equal(response.status, 200, await response.clone().text()); const proof = await response.json();
  assert.equal(proof.denied, 503); assert.equal(proof.before, 0); assert.equal(proof.calls.length, 4);
  for (const result of proof.results) {
    assert.equal(result.status, 200); assert.equal(result.count, 4096); assert.deepEqual(result.keys, ["data"]);
    assert.equal(result.first.input_price, "0.2"); assert.equal(result.first.output_price, 0); assert.equal("context_window" in result.first, false);
    assert.equal(result.last, `model-4095${"x".repeat(350)}`); assert.ok(result.bytes > 1024 * 1024 && result.bytes < 2 * 1024 * 1024);
    assert.ok(result.charged === 32 * 1024 * 1024 || result.completeAtReturn && result.charged === 0);
    assert.equal(result.producerEOF, true); assert.equal(result.released, 0); assert.ok(result.maximum <= 2 * 1024 * 1024);
  }
  for (const call of proof.calls) {
    assert.equal(call.url, "https://router.requesty.ai/v1/models/managed"); assert.equal(call.method, "GET"); assert.equal(call.redirect, "manual");
    assert.deepEqual(call.headers, [["accept", "application/json"], ["authorization", "Bearer synthetic-original-key"]]); assert.equal(call.capacity, 32 * 1024 * 1024);
  }
  assert.equal(proof.cancelResult.status, 200); assert.ok(proof.cancelResult.complete || proof.cancelResult.canceled); assert.equal(proof.cancelResult.released, 0);
  assert.equal(proof.deadlineResult.status, 502); assert.ok(proof.deadlineResult.readBytes > 0);
  // A workerd fetch abort may error its pending read before the wrapper can
  // receive cancel(). Require a real terminal reader and both bound signals.
  assert.ok(proof.deadlineResult.canceled || proof.deadlineResult.readRejected, JSON.stringify(proof.deadlineResult));
  assert.equal(proof.deadlineResult.activeReads, 0); assert.equal(proof.deadlineResult.fetchAborted, true);
  assert.equal(proof.deadlineResult.chargeAtReadEnd, 32 * 1024 * 1024);
  assert.equal(proof.deadlineResult.aborted, true); assert.equal(proof.deadlineResult.released, 0);
});
async function catalogRetirementBarriers(t) {
  const { createServer } = await import("node:http");
  const held = new Map(), released = new Set(), counts = new Map();
  const server = createServer((request, response) => {
    const key = request.url;
    if (request.method !== "GET" || request.headers.authorization || !/^\/(requesty|featherless)\/(abort|read|cleanup)$/.test(key)) {
      response.writeHead(400); response.end(); return;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.get(key) !== 1) { response.writeHead(409); response.end(); return; }
    if (released.has(key)) response.end("released"); else held.set(key, response);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: "http://127.0.0.1:" + server.address().port,
    release(mode, phase) { const key = "/" + mode + "/" + phase; released.add(key); held.get(key)?.end("released"); held.delete(key); },
    count(mode, phase) { return counts.get("/" + mode + "/" + phase) ?? 0; } };
}

const retirementRouter = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {BodyLease,bodyBudgetCharged} from './worker/body-budget.ts';
const rawFetch=globalThis.fetch.bind(globalThis),release=BodyLease.prototype.release;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
let active;
BodyLease.prototype.release=function(){const before=bodyBudgetCharged();release.call(this);if(active&&bodyBudgetCharged()<before)active.releases++;};
const state=()=>active?{mode:active.mode,phase:active.phase,errorClass:active.errorClass,errorCode:active.errorCode,fetches:active.fetches,reads:active.reads,cancels:active.cancels,cleanup:active.cleanup,readRetired:active.readRetired,
  results:active.results,status:active.status,releases:active.releases,lateEnqueues:active.lateEnqueues,charged:bodyBudgetCharged(),
  sourceLocked:active.source?.locked??false,physicalLocked:active.physical?.locked??false}:{};
const gate=(a,phase)=>rawFetch('https://catalog-retirement-gate.example/'+a.mode+'/'+phase,{redirect:'manual'}).then(async response=>{
 if(!response.ok)throw new Error('fixture gate rejected');await response.text();
});
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init),a=active;
 if(!a||!request.url.startsWith(a.base+'/models'))throw new Error('unexpected catalog fetch');
 a.fetches++;a.phase='physical-fetch';
 const response=await rawFetch(request);a.phase='headers';a.physical=response.body;const reader=response.body.getReader();
 let stopped=false,first=true,cancellation,pulling;
 const cancel=reason=>cancellation??=(async()=>{
   stopped=true;a.cancels++;
   const cleanup=(async()=>{try{await reader.cancel(reason);}catch{}await gate(a,'cleanup');a.cleanup=true;})();
   // This fixture owns its extra source continuation as well as the real reader.
   await Promise.allSettled([pulling,cleanup]);reader.releaseLock();
 })();
 a.source=new ReadableStream({pull(controller){return pulling=(async()=>{
   a.reads++;a.phase='physical-read';let next;
   try{next=await reader.read();}
   finally{if(first){first=false;a.ready.resolve();await gate(a,'read');a.readRetired=true;}}
   if(stopped)return;
   if(next.done)controller.close();else controller.enqueue(next.value);
 })();},cancel},{highWaterMark:0});
 return new Response(a.source,{status:response.status,headers:response.headers});
};
export default {async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.pathname==='/state')return Response.json(state());
 if(url.pathname==='/contend'){const lease=new BodyLease(),allowed=lease.grow(33*1024*1024);lease.release();return Response.json({allowed,charged:bodyBudgetCharged()});}
 if(url.pathname!=='/start'||active&&active.releases!==1)return new Response(null,{status:409});
 const mode=url.searchParams.get('mode');if(!['requesty','featherless'].includes(mode))return new Response(null,{status:400});
 const a={mode,phase:'setup',base:mode==='requesty'?'https://router.requesty.ai/v1':'https://api.featherless.ai/v1',fetches:0,reads:0,cancels:0,cleanup:false,
  readRetired:false,results:0,status:0,releases:0,lateEnqueues:0,ready:deferred(),abort:new AbortController()};active=a;
 const provider=structuredClone(snapshot.providers.find(p=>p.id==='openai'));
 const endpoint={...provider.endpoints.find(e=>e.id==='models_list'),id:mode==='requesty'?'models_managed':'catalog',
  path:mode==='requesty'?'/models/managed':'/models',method:'GET',methods:['GET'],request_format:mode==='requesty'?'requesty.models_managed':'featherless.catalog',
  response_format:mode==='requesty'?'requesty.models_managed':'featherless.catalog',native_proxy:mode==='requesty',timeout_ms:10000,path_params:[],path_param_styles:{},headers:{},query:{}};
 Object.assign(provider,{id:mode,base_urls:{default:a.base},native_prefixes:[mode],routing:{nativePrefixes:[mode],modelPrefixes:[mode+'/'],baseUrlParam:null,serviceParam:null},
  auth:{schemes:[{type:'bearer',header:'Authorization',format:'Bearer '+String.fromCharCode(36)+'{secret}',secretKind:'api_key'}],grantTransports:{}},
  adapter:{...provider.adapter,injectHeaders:{},injectQuery:{},passthroughHeaders:[]},
  capabilities:[{id:'models.list',endpoint:endpoint.id,methods:['GET']}],endpoints:[endpoint],
  models:[{id:mode+'/one',upstream:'one',capabilities:[],pricing:null,pricing_ref:null}]});
 snapshot.providers=[...snapshot.providers.filter(p=>p.id!==mode),provider];
 // These owner initializers seed once; both sequential cases must be admitted from the first call.
 await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['requesty','featherless'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
 await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
 await authorityCall(env,'/connections/initialize-all',['requesty','featherless'].map(providerId=>({providerId,enabled:true,monthlyBudgetMicros:10000})));
 await putGrantCredentials(env,'oauth/fixture/'+mode,{provider:mode,kind:'api_key',enabled:true,credential:'synthetic-original-key'});
 // The abort continuation originates in this request; control requests only read state.
 ctx.waitUntil(gate(a,'abort').then(()=>a.abort.abort(new Error('synthetic caller cancellation'))));
 const route=mode==='requesty'?'/v1/native/requesty/models/managed':'/v1/proxy/featherless/catalog';
 a.phase='router-call';
 ctx.waitUntil(worker.fetch(new Request('https://router.example'+route,{headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret'},signal:a.abort.signal}),env,ctx)
  .then(async response=>{a.status=response.status;const body=await response.text();try{a.errorCode=JSON.parse(body)?.error?.code;}catch{}a.results++;a.phase='result';a.ready.resolve();})
  .catch(error=>{a.errorClass=error?.name;a.results++;a.phase='rejected';a.ready.resolve();}));
 await a.ready.promise;return Response.json(state());
},queue:worker.queue};
`;
const retirementUpstream = origin => (String.raw`
export default {fetch(request){
 const url=new URL(request.url);
 if(url.origin==='https://catalog-retirement-gate.example'){
  if(request.headers.has('authorization'))throw new Error('gate credential leak');
  return fetch(BARRIER_ORIGIN+url.pathname,{redirect:'manual',signal:request.signal});
 }
 if(request.headers.get('authorization')!=='Bearer synthetic-original-key'||request.method!=='GET')throw new Error('wrong original catalog credential');
 if(url.origin==='https://router.requesty.ai')return Response.json({data:[{id:'one',api:'chat'}]});
 if(url.origin==='https://api.featherless.ai')return Response.json({data:[{id:'one'}],pagination:{current_page:1,per_page:100,total_items:1,total_pages:1},total:1});
 throw new Error('unexpected fixture origin');
}};
`).replace("BARRIER_ORIGIN", JSON.stringify(origin));

test("workerd charged catalogs keep original read and first cleanup through prompt abort", { timeout: 120000 }, async t => {
  const { setTimeout: delay } = await import("node:timers/promises");
  const temporary = await mkdtemp(join(tmpdir(), "charged-catalog-retirement-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const barriers = await catalogRetirementBarriers(t);
  const runtime = await startWorkerdFixture(temporary, retirementRouter, retirementUpstream(barriers.origin), { preventEviction: true });
  t.after(async () => {
    for (const mode of ["requesty", "featherless"]) for (const phase of ["abort", "read", "cleanup"]) barriers.release(mode, phase);
    await runtime.dispose();
  });
  const call = async path => { const response = await runtime.dispatchFetch("https://router.example" + path); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const until = async predicate => { let value; for (let i=0;i<100;i++) { value=await call("/state"); if(predicate(value))return value; await delay(10); } assert.fail(JSON.stringify(value)); };
  for (const mode of ["requesty", "featherless"]) {
    const charge=(mode==="requesty"?32:96)*1024*1024;
    let state=await call("/start?mode="+mode); assert.equal(state.charged,charge,JSON.stringify(state)); assert.equal(state.fetches,1,JSON.stringify(state)); assert.equal(state.reads,1,JSON.stringify(state));
    barriers.release(mode,"abort"); state=await until(s=>s.results===1&&s.cancels===1);
    assert.equal(state.status,502); assert.equal(state.releases,0); assert.equal(state.charged,charge);
    assert.equal(state.sourceLocked,true); assert.equal(state.physicalLocked,true);
    assert.deepEqual(await call("/contend"),{allowed:false,charged:charge});
    const first=mode==="requesty"?"read":"cleanup",second=first==="read"?"cleanup":"read";
    barriers.release(mode,first); state=await until(s=>first==="read"?s.readRetired:s.cleanup);
    assert.equal(state.releases,0); assert.equal(state.charged,charge); assert.equal(state.sourceLocked,true);
    barriers.release(mode,second); state=await until(s=>s.releases===1);
    assert.equal(state.charged,0); assert.equal(state.cleanup,true); assert.equal(state.readRetired,true);
    assert.equal(state.sourceLocked,false); assert.equal(state.physicalLocked,false); assert.equal(state.cancels,1); assert.equal(state.fetches,1); assert.equal(state.results,1);
    assert.equal(state.lateEnqueues,0);
    for (const phase of ["abort","read","cleanup"]) assert.equal(barriers.count(mode,phase),1);
  }
});
