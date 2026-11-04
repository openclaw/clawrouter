import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { musicBody } from "./openrouter-music-runtime-fixture.mjs";

const MiB = 1024 * 1024;
function maximumImage() {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGUlEQVR4nGP8z8Dwn/E/QyMLI8N/IGSsBwA6swYEbMHgjAAAAABJRU5ErkJggg==", "base64");
  const chunk = Buffer.alloc(8 * MiB - png.length, 65); chunk.writeUInt32BE(chunk.length - 12);
  chunk.write("tEXt", 4); chunk.write("Fixture\0", 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

// A complete 16 MiB mono WAV, emitted in bounded base64 frames. Valid comments
// before DONE fill the original 32 MiB wire limit; no aggregate audio/string is
// needed in the upstream fixture. The host computes the exact expected digest.
function* maximumWire() {
  const model = "google/lyria-3-pro-preview", total = 16 * 1024 * 1024;
  const encode = value => new TextEncoder().encode(value);
  const frame = delta => 'data: ' + JSON.stringify({ id: "gen-inline-fixture", model, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n';
  let emitted = 0;
  for (let offset = 0; offset < total; offset += 192 * 1024) {
    const bytes = new Uint8Array(Math.min(192 * 1024, total - offset));
    if (!offset) {
      const view = new DataView(bytes.buffer), text = (at, value) => { for (let index = 0; index < value.length; index++) bytes[at + index] = value.charCodeAt(index); };
      text(0, "RIFF"); view.setUint32(4, total - 8, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
      view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      text(36, "data"); view.setUint32(40, total - 44, true);
    }
    let binary = ""; for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    const wire = encode(frame({ audio: { data: btoa(binary) } })); emitted += wire.length; yield wire;
  }
  const stop = encode('data: ' + JSON.stringify({ id: "gen-inline-fixture", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + '\n\n');
  emitted += stop.length; yield stop;
  const done = encode('data: [DONE]\n\n');
  let remaining = 32 * 1024 * 1024 - emitted - done.length;
  while (remaining) { const count = Math.min(1024 * 1024, remaining); const comment = encode(':' + 'x'.repeat(count - 3) + '\n\n'); remaining -= comment.length; yield comment; }
  yield done;
}

const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {usageStub} from './worker/ledgers.ts';
import {configureMusic} from './worker/test/openrouter-music-runtime-fixture.mjs';
const provider=snapshot.providers.find(value=>value.id==='openrouter');configureMusic(provider);
provider.endpoints.find(value=>value.id==='music_generate').timeout_ms=30000;
const original=globalThis.fetch.bind(globalThis),pending=[],networkBodies=new WeakSet();
let fetches=0,capacity=0,uploadBytes=0,uploadDigest='',networkByob=false,controlled,activeReads=0,cancels=0,cancelCharge=0;
let releaseOutput,outputBytes=0,outputEof=false;
const getReader=ReadableStream.prototype.getReader;
ReadableStream.prototype.getReader=function(options){
 const reader=getReader.call(this,options);
 if(networkBodies.has(this)&&options?.mode==='byob'){
  const read=reader.read.bind(reader),cancel=reader.cancel.bind(reader);
  reader.read=async(...args)=>{activeReads++;try{return await read(...args);}finally{activeReads--;}};
  reader.cancel=async(...args)=>{cancelCharge=bodyBudgetCharged();await cancel(...args);cancels++;};
 }
 return reader;
};
globalThis.fetch=async(input,init)=>{
 const url=input instanceof Request?input.url:String(input);
 if(url!=='https://openrouter.ai/api/v1/chat/completions')throw new Error('unexpected destination');
 fetches++;capacity=bodyBudgetCharged();const response=await original(input,init);
 uploadBytes=Number(response.headers.get('x-fixture-image-bytes'));uploadDigest=response.headers.get('x-fixture-image-digest');
 const reader=response.body.getReader({mode:'byob'});reader.releaseLock();networkByob=true;networkBodies.add(response.body);return response;
};
export default {async fetch(request,bindings){
 const env={...bindings,OPENROUTER_SITE_URL:'https://example.com'},path=new URL(request.url).pathname;
 if(path==='/fixture/phase')return Response.json({activeReads,cancels,outputBytes,outputEof,remaining:bodyBudgetCharged()});
 if(path==='/fixture/release'){releaseOutput();return new Response('released');}
 if(path==='/fixture/abort'){controlled.abort();return new Response('aborted');}
 if(path==='/fixture/setup'){
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['openrouter'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env,'/connections/initialize-all',[{providerId:'openrouter',enabled:true,monthlyBudgetMicros:10000}]);
  await putGrantCredentials(env,'oauth/fixture/openrouter',{provider:'openrouter',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
  return new Response('ready');
 }
 if(path==='/fixture/state'){
  while(pending.length)await Promise.all(pending.splice(0));
  const usage=await(await usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin')).json();
  return Response.json({fetches,capacity,uploadBytes,uploadDigest,networkByob,remaining:bodyBudgetCharged(),activeReads,cancels,cancelCharge,outputBytes,outputEof,events:usage.events});
 }
 if(request.headers.has('x-fixture-controlled')){
  controlled=new AbortController();const headers=new Headers(request.headers);headers.delete('x-fixture-controlled');
  request=new Request(request,{headers,signal:controlled.signal});
 }
 const gated=request.headers.has('x-fixture-gated');
 if(gated){const headers=new Headers(request.headers);headers.delete('x-fixture-gated');request=new Request(request,{headers});}
 const result=await worker.fetch(request,env,{waitUntil(value){pending.push(value);}});
 if(!gated||!result.ok)return result;
 const reader=result.body.getReader(),gate=new Promise(resolve=>{releaseOutput=resolve;});let first=true;
 return new Response(new ReadableStream({async pull(controller){
  if(!first)await gate;first=false;
  const part=await reader.read();
  if(part.done){outputEof=true;reader.releaseLock();controller.close();}
  else{outputBytes+=part.value.byteLength;controller.enqueue(part.value);}
 },async cancel(reason){releaseOutput();await reader.cancel(reason);reader.releaseLock();}},{highWaterMark:0}),result);
},queue:worker.queue};`;
const upstream = `${maximumWire.toString()}
export default {async fetch(request){
 if(request.url!=='https://openrouter.ai/api/v1/chat/completions'||request.headers.get('authorization')!=='Bearer synthetic-original-key')return new Response('invalid original owner',{status:400});
 const body=await request.json();if(body.model!=='google/lyria-3-pro-preview'||body.audio.format!=='wav')return new Response('invalid model',{status:400});
 const encoded=body.messages[0].content[1].image_url.url.split(',')[1],binary=atob(encoded),image=new Uint8Array(binary.length);
 for(let index=0;index<image.length;index++)image[index]=binary.charCodeAt(index);
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',image)),value=>value.toString(16).padStart(2,'0')).join('');
 const parts=maximumWire();let piece,offset=0,started=false;
 const response=new ReadableStream({type:'bytes',pull(controller){
  if(body.messages[0].content[0].text==='Stall quarantine'){
   if(!started){started=true;controller.enqueue(new TextEncoder().encode('data: {'));}return;
  }
  if(!piece||offset===piece.length){const next=parts.next();if(next.done){controller.close();controller.byobRequest?.respond(0);return;}piece=next.value;offset=0;}
  const count=Math.min(16384,piece.length-offset),copy=piece.slice(offset,offset+count);offset+=count;controller.enqueue(copy);
 },cancel(){parts.return();piece=undefined;}},{highWaterMark:0});
 return new Response(response,{headers:{'content-type':'text/event-stream',...(body.messages[0].content[0].text==='Stall quarantine'?{}:{'content-length':String(32*1024*1024)}),'x-fixture-image-bytes':String(image.length),'x-fixture-image-digest':digest}});
}};`;

test("workerd full inline music carries exact 8 MiB input and 32 MiB native wire under the shared 96 MiB charge", { timeout: 90000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "inline-music-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const runtime = await startWorkerdFixture(temporary, router, upstream); t.after(() => runtime.dispose());
  assert.equal((await runtime.dispatchFetch("https://router.example/fixture/setup")).status, 200);
  const image = maximumImage(), body = musicBody();
  body.messages[0].content = [{ type: "text", text: "Synthetic instrumental." }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } }];
  const expected = createHash("sha256"); let expectedBytes = 0;
  for (const part of maximumWire()) { expected.update(part); expectedBytes += part.length; }
  assert.equal(expectedBytes, 32 * MiB);
  const response = await runtime.dispatchFetch("https://router.example/v1/native/openrouter/v1/chat/completions", {
    method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", "x-fixture-gated": "true" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
  const actual = createHash("sha256"), reader = response.body.getReader(); let count = 0;
  const first = await reader.read(); assert.equal(first.done, false); actual.update(first.value); count += first.value.length;
  const phase = await (await runtime.dispatchFetch("https://router.example/fixture/phase")).json();
  // The controlled consumer has not pulled the complete Worker producer. This
  // measures actual output progress, not merely unread client-buffered bytes.
  assert.ok(phase.outputBytes > 0 && phase.outputBytes < 32 * MiB); assert.equal(phase.outputEof, false);
  assert.equal(phase.remaining, 96 * MiB);
  await runtime.dispatchFetch("https://router.example/fixture/release");
  for (;;) { const part = await reader.read(); if (part.done) break; actual.update(part.value); count += part.value.length; }
  reader.releaseLock(); assert.equal(count, 32 * MiB); assert.equal(actual.digest("hex"), expected.digest("hex"));
  const state = await (await runtime.dispatchFetch("https://router.example/fixture/state")).json();
  assert.equal(state.fetches, 1); assert.equal(state.capacity, 96 * MiB); assert.equal(state.uploadBytes, 8 * MiB);
  assert.equal(state.uploadDigest, createHash("sha256").update(image).digest("hex"));
  assert.equal(state.networkByob, true); assert.equal(state.remaining, 0);
  assert.equal(state.outputBytes, 32 * MiB); assert.equal(state.outputEof, true);
  assert.equal(state.events.length, 1); assert.equal(state.events[0].actual_cost_micros, 700);
  assert.equal(state.events[0].cost_basis, "policy_fixed"); assert.equal(state.events[0].grant_key, "oauth/fixture/openrouter");
  for (const field of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(state.events[0][field], null);
});

test("workerd controlled caller signal cancels the actual pending quarantine read before releasing either phase", { timeout: 45000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "inline-music-cancel-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const runtime = await startWorkerdFixture(temporary, router, upstream); t.after(() => runtime.dispose());
  assert.equal((await runtime.dispatchFetch("https://router.example/fixture/setup")).status, 200);
  const image = maximumImage(), body = musicBody();
  body.messages[0].content = [{ type: "text", text: "Stall quarantine" }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } }];
  const pending = runtime.dispatchFetch("https://router.example/v1/native/openrouter/v1/chat/completions", {
    method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", "x-fixture-controlled": "true" }, body: JSON.stringify(body),
  });
  let phase; const deadline = Date.now() + 15000;
  do {
    phase = await (await runtime.dispatchFetch("https://router.example/fixture/phase")).json();
    if (phase.activeReads === 1) break;
    assert.ok(Date.now() < deadline, JSON.stringify(phase));
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (true);
  assert.equal(phase.remaining, 96 * MiB); assert.equal(phase.cancels, 0);
  await runtime.dispatchFetch("https://router.example/fixture/abort");
  const response = await pending; assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('"audio"'));
  const state = await (await runtime.dispatchFetch("https://router.example/fixture/state")).json();
  assert.equal(state.fetches, 1); assert.equal(state.activeReads, 0); assert.equal(state.cancels, 1);
  assert.equal(state.cancelCharge, 96 * MiB); assert.equal(state.remaining, 0);
  assert.equal(state.events.length, 1); assert.equal(state.events[0].actual_cost_micros, 700);
  assert.equal(state.events[0].cost_basis, "policy_fixed");
  // This proves the explicitly supplied caller signal inside workerd. It does
  // not claim the separate locked host/front-Worker disconnect boundary works.
});
