import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { speechFixture } from "./openrouter-speech-runtime-fixture.mjs";
const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {configureSpeech,speechBody} from './worker/test/openrouter-speech-runtime-fixture.mjs';
configureSpeech(snapshot.providers.find(p=>p.id==='openrouter'));
const original=globalThis.fetch.bind(globalThis);let fetches=0,capacity=0,body;
globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(request.url!=='https://openrouter.ai/api/v1/audio/speech'||request.headers.get('authorization')!=='Bearer synthetic-original-key'||request.redirect!=='manual')throw new Error('invalid original dispatch');fetches++;capacity=bodyBudgetCharged();body=await request.clone().json();return original(request);};
export default {async fetch(request,bindings){
 const env={...bindings,OPENROUTER_SITE_URL:'https://example.com'},pending=[];
 await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['openrouter'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
 await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
 await authorityCall(env,'/connections/initialize-all',[{providerId:'openrouter',enabled:true,monthlyBudgetMicros:10000}]);
 await putGrantCredentials(env,'oauth/fixture/openrouter',{provider:'openrouter',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
 const supplied={...speechBody(),input:'x'.repeat(5000),provider:{zdr:true,data_collection:'deny'},speed:1.1};
 const response=await worker.fetch(new Request('https://router.example/v1/native/openrouter/v1/audio/speech',{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},body:JSON.stringify(supplied)}),env,{waitUntil:p=>pending.push(p)});
 const bytes=new Uint8Array(await response.arrayBuffer());while(pending.length)await Promise.all(pending.splice(0));
 let encoded='';for(const byte of bytes)encoded+=String.fromCharCode(byte);
 return Response.json({status:response.status,mime:response.headers.get('content-type'),length:response.headers.get('content-length'),audio:btoa(encoded),fetches,capacity,remaining:bodyBudgetCharged(),sameBody:JSON.stringify(body)===JSON.stringify(supplied)});
},queue:worker.queue};`;
const upstream = `export default {async fetch(request){const body=await request.json();
 if(body.model!=='hexgrad/kokoro-82m'||body.input.length!==5000||body.voice!=='synthetic_voice'||body.response_format!=='mp3')return new Response('invalid selected body',{status:400});
 const bytes=Uint8Array.from(atob(${JSON.stringify(speechFixture.base64)}),c=>c.charCodeAt(0));
 return new Response(bytes,{headers:{'content-type':'audio/mpeg','content-length':String(bytes.length),'content-encoding':'identity'}});
}};`;

test("workerd actual OpenRouter speech factory preserves native request and MP3, with bounded pre-dispatch capacity", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openrouter-speech-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const instance = await startWorkerdFixture(temporary, router, upstream); t.after(() => instance.dispose());
  const response = await fetch((await instance.ready).origin); assert.equal(response.status, 200, await response.clone().text()); const proof = await response.json();
  assert.equal(proof.status, 200, JSON.stringify(proof)); assert.equal(proof.mime, "audio/mpeg"); assert.equal(proof.length, String(speechFixture.bytes));
  assert.equal(proof.audio, speechFixture.base64); assert.equal(createHash("sha256").update(Buffer.from(proof.audio, "base64")).digest("hex"), speechFixture.sha256);
  assert.equal(proof.sameBody, true); assert.equal(proof.fetches, 1); assert.equal(proof.capacity, 64 * 1024 * 1024); assert.equal(proof.remaining, 0);
});

const retirementRouter = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {prepareNativeOpenRouterSpeech} from './worker/native-openrouter-speech.ts';
import {prepareNativeOpenRouterPcmSpeech} from './worker/native-openrouter-pcm-speech.ts';
import {HttpOperation} from './worker/http-operation.ts';
import {BodyLease,bodyBudgetCharged} from './worker/body-budget.ts';
let active;
const state=()=>active?{...active.metrics,locked:active.source.locked,physicalLocked:active.physical.locked,charged:bodyBudgetCharged()}:{};
export default {async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.pathname==='/state')return Response.json(state());
 if(url.pathname==='/contend'){const other=new BodyLease(),allowed=other.grow(17*1024*1024);other.release();return Response.json({allowed,charged:bodyBudgetCharged()});}
 if(url.pathname!=='/start'||active&&active.metrics.releases!==1)return new Response(null,{status:409});
 const mode=url.searchParams.get('mode'),pcm=mode==='pcm',model=pcm?'google/gemini-3.1-flash-tts-preview':'hexgrad/kokoro-82m';
 const native=(pcm?prepareNativeOpenRouterPcmSpeech:prepareNativeOpenRouterSpeech)({
   provider:{id:'openrouter',base_urls:{default:'https://openrouter.ai/api'}},
   endpoint:{method:'POST',path:'/v1/audio/speech',request_format:'openai.audio_speech',response_format:'audio.binary',path_params:[],query:{}},
   model:{upstream:model,capabilities:['audio.speech']},capability:'audio.speech',method:'POST',pathParams:{},
   body:{model,input:'Synthetic speech.',voice:pcm?'Kore':'af_alloy',response_format:pcm?'pcm':'mp3'}
 });
 const lease=native.acquire(),upstream=await fetch('https://adapter-retirement.example/data',{redirect:'manual'});
 const physical=upstream.body,reader=physical.getReader(),abort=new AbortController(),operation=new HttpOperation(abort.signal);
 const metrics={fetches:1,cancels:0,cleanup:false,readStarted:0,results:0,releases:0,lateEnqueues:0,cancelPhase:'none'};
 let ready;const started=new Promise(resolve=>{ready=resolve;});
 const gate=phase=>fetch('https://adapter-retirement.example/gate/'+mode+'/'+phase,{redirect:'manual'}).then(r=>{if(!r.ok)throw new Error('fixture barrier');return r.text();});
 let sent=false,stopped=false,cancellation;
 const source=new ReadableStream({async pull(controller){
   if(sent)return;sent=true;const part=await reader.read();metrics.readStarted++;
   if(stopped){metrics.lateEnqueues++;return;}
   controller.enqueue(mode==='transform'?'invalid binary chunk':part.value);ready();
 },cancel(reason){
   if(!cancellation)cancellation=(async()=>{
     stopped=true;metrics.cancels++;metrics.cancelPhase='physical-cancel';
     try{await reader.cancel(reason);}catch(error){metrics.physicalCancelError=error?.name??'other';throw error;}
     metrics.cancelPhase='cleanup-gate';
     try{await gate('cleanup');}catch(error){metrics.cleanupError=error?.name??'other';throw error;}
     reader.releaseLock();metrics.cleanup=true;metrics.cancelPhase='retired';
   })();
   return cancellation;
 }},{highWaterMark:0});
 active={metrics,source,physical};
 if(mode!=='transform')ctx.waitUntil(gate('abort').then(()=>abort.abort(new Error('synthetic controlled cancellation'))));
 const pending=native.read(new Response(source,{headers:{'content-type':pcm?'audio/pcm':'audio/mpeg'}}),operation.signal);
 ctx.waitUntil(operation.wait(pending).then(()=>{throw new Error('unexpected audio');},()=>{metrics.results++;}));
 ctx.waitUntil(pending.then(()=>{throw new Error('unexpected audio');},()=>{}).then(()=>{lease.release();metrics.releases++;}));
 await started;return Response.json(state());
}};`;

test("workerd binary adapters retain original fetch and transform ownership through first cancellation ACK", { timeout: 120000 }, async t => {
  const pending = new Map(), released = new Set(), counts = new Map();
  const server = createServer((request, response) => {
    const key = request.url;
    if (request.method !== "GET" || !/^\/(mp3|pcm|transform)\/(abort|cleanup)$/.test(key) || request.headers.authorization) {
      response.writeHead(400); response.end(); return;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (released.has(key)) response.end("released"); else pending.set(key, response);
  });
  t.after(() => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const release = (mode, phase) => { const key = "/" + mode + "/" + phase; released.add(key); pending.get(key)?.end("released"); pending.delete(key); };
  const upstream = `export default {fetch(request){
    const url=new URL(request.url);
    if(url.origin!=='https://adapter-retirement.example'||request.method!=='GET'||request.headers.has('authorization')||url.search)throw new Error('unexpected fixture request');
    if(url.pathname.startsWith('/gate/'))return fetch(${JSON.stringify(origin)}+url.pathname.slice(5),{redirect:'manual',signal:request.signal});
    if(url.pathname!=='/data')throw new Error('unexpected path');
    return new Response(new Uint8Array([0,1,2,3]),{headers:{'content-type':'application/octet-stream'}});
  }};`;
  const directory = await mkdtemp(join(tmpdir(), "adapter-retirement-workerd-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await startWorkerdFixture(directory, retirementRouter, upstream, { preventEviction: true });
  t.after(() => runtime.dispose());
  const call = async path => { const result = await runtime.dispatchFetch("https://router.example" + path); assert.ok(result.ok, await result.clone().text()); return result.json(); };
  const until = async predicate => { let state; for (let i = 0; i < 100; i++) { state = await call("/state"); if (predicate(state)) return state; await delay(10); } assert.fail(JSON.stringify(state)); };
  for (const mode of ["mp3", "pcm", "transform"]) {
    await call("/start?mode=" + mode);
    if (mode !== "transform") release(mode, "abort");
    const held = await until(state => state.cancels === 1 && (mode === "transform" || state.results === 1));
    const trace = JSON.stringify({ mode, held, cleanupRequests: counts.get("/" + mode + "/cleanup") ?? 0 });
    assert.equal(held.releases, 0, trace); assert.equal(held.cleanup, false, trace); assert.equal(held.locked, true, trace); assert.equal(held.physicalLocked, true, trace);
    assert.deepEqual(await call("/contend"), { allowed: false, charged: 64 * 1024 * 1024 });
    release(mode, "cleanup"); const done = await until(state => state.releases === 1 && state.results === 1);
    assert.equal(done.charged, 0); assert.equal(done.locked, false); assert.equal(done.physicalLocked, false);
    assert.equal(done.fetches, 1); assert.equal(done.cancels, 1); assert.equal(done.lateEnqueues, 0); assert.equal(done.cleanup, true);
    assert.equal(counts.get("/" + mode + "/cleanup"), 1);
    assert.equal(counts.get("/" + mode + "/abort") ?? 0, mode === "transform" ? 0 : 1);
  }
});
