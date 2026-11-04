import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { createServer } from "node:http";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { musicBody } from "./openrouter-music-runtime-fixture.mjs";

const MiB = 1024 * 1024, model = "google/lyria-3-pro-preview";
function maximumImage() {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGUlEQVR4nGP8z8Dwn/E/QyMLI8N/IGSsBwA6swYEbMHgjAAAAABJRU5ErkJggg==", "base64");
  const chunk = Buffer.alloc(8 * MiB - png.length, 65);
  chunk.writeUInt32BE(chunk.length - 12); chunk.write("tEXt", 4); chunk.write("Fixture\0", 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}
function* maximumWire() {
  const total = 16 * 1024 * 1024, encode = value => new TextEncoder().encode(value);
  const frame = delta => 'data: ' + JSON.stringify({ id: "gen-published-fixture", model: "google/lyria-3-pro-preview", choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n';
  let emitted = 0;
  for (let offset = 0; offset < total; offset += 192 * 1024) {
    const bytes = new Uint8Array(Math.min(192 * 1024, total - offset));
    if (!offset) {
      const view = new DataView(bytes.buffer), text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
      text(0, "RIFF"); view.setUint32(4, total - 8, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true); view.setUint32(28, 48000, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, total - 44, true);
    }
    let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const part = encode(frame({ audio: { data: btoa(binary) } })); emitted += part.length; yield part;
  }
  const stop = encode('data: ' + JSON.stringify({ id: "gen-published-fixture", model: "google/lyria-3-pro-preview", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + '\n\n');
  emitted += stop.length; yield stop;
  const done = encode('data: [DONE]\n\n'); let remaining = 32 * 1024 * 1024 - emitted - done.length;
  while (remaining) {
    let count = Math.min(1024 * 1024, remaining); if (remaining > count && remaining - count < 3) count -= 3;
    const comment = encode(':' + 'x'.repeat(count - 3) + '\n\n'); remaining -= comment.length; yield comment;
  }
  yield done;
}
async function network(t) {
  let gate, released = false, close, enter;
  const closed = new Promise(resolve => { close = resolve; }), entered = new Promise(resolve => { enter = resolve; });
  const metrics = { pending: 0, closed: 0, gates: 0 };
  const server = createServer((request, response) => {
    if (request.headers.authorization) { response.writeHead(400); response.end(); return; }
    if (request.url === "/gate") { metrics.gates++; gate = response; if (released) response.end("released"); }
    else if (request.url === "/pending") { metrics.pending++; enter(); response.on("close", () => { metrics.closed++; close(); });
      response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: {"); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, metrics, entered, closed, release() { released = true; gate?.end("released"); } };
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
import {configureMusic,musicModels} from './worker/test/openrouter-music-runtime-fixture.mjs';
configureMusic(snapshot.providers.find(value=>value.id==='openrouter'));
snapshot.providers.find(value=>value.id==='openrouter').endpoints.find(value=>value.id==='music_generate').timeout_ms=30000;
const original=globalThis.fetch.bind(globalThis),pending=[];
let currentEnv,controlled,fetches=0,dispatchCharge=0,getCharge=0,imageBytes=0,imageDigest='',outputBytes=0,outputEof=false,upstreamAborted=false;
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init);
 if(request.url!=='https://openrouter.ai/api/v1/chat/completions'||request.headers.get('authorization')!=='Bearer synthetic-original-key')throw new Error('unexpected destination');
 fetches++;dispatchCharge=bodyBudgetCharged();request.signal.addEventListener('abort',()=>{upstreamAborted=true;},{once:true});
 const body=await request.clone().json();
 const asset=await worker.fetch(new Request(body.messages[0].content[1].image_url.url),currentEnv,{waitUntil(value){pending.push(value);}});
 if(asset.status!==200)throw new Error('asset denied');getCharge=bodyBudgetCharged();
 const image=await asset.arrayBuffer();imageBytes=image.byteLength;
 imageDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',image)),byte=>byte.toString(16).padStart(2,'0')).join('');
 return original(request);
};
export default {async fetch(request,bindings,context){
 const env={...bindings,OPENROUTER_SITE_URL:'https://example.com',CLAWROUTER_PUBLIC_ORIGIN:'https://router.example'};currentEnv=env;
 const path=new URL(request.url).pathname;
 if(path==='/fixture/setup'){
  const allow=musicModels.map(model=>({providerId:'openrouter',endpointId:'music_generate',modelId:'openrouter/'+model,publish:true,forward:true,expiresAt:new Date(Date.now()+3600000).toISOString()}));
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['openrouter'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false,inputPublication:{version:'clawrouter.input-publication.v1',allow}}}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env,'/connections/initialize-all',[{providerId:'openrouter',enabled:true,monthlyBudgetMicros:10000}]);
  await putGrantCredentials(env,'oauth/fixture/openrouter',{provider:'openrouter',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
  return new Response('ready');
 }
 if(path==='/fixture/abort'){controlled.abort();return new Response('aborted');}
 if(path==='/fixture/phase')return Response.json({remaining:bodyBudgetCharged(),outputBytes,outputEof,fetches,dispatchCharge,getCharge,imageBytes,upstreamAborted});
 if(path==='/fixture/state'){
  while(pending.length)await Promise.all(pending.splice(0));
  const usage=await(await usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin')).json();
  return Response.json({remaining:bodyBudgetCharged(),outputBytes,outputEof,fetches,dispatchCharge,getCharge,imageBytes,imageDigest,upstreamAborted,events:usage.events});
 }
 const gated=request.headers.has('x-fixture-gated'),headers=new Headers(request.headers);headers.delete('x-fixture-gated');
 if(headers.has('x-fixture-controlled')){controlled=new AbortController();headers.delete('x-fixture-controlled');request=new Request(request,{headers,signal:controlled.signal});}
 else request=new Request(request,{headers});
 const response=await worker.fetch(request,env,{waitUntil(value){pending.push(value);context.waitUntil(value);}});
 if(!gated||!response.ok)return response;
 const reader=response.body.getReader();let first=true,gate;
 return new Response(new ReadableStream({async pull(controller){
  if(!first){gate??=original('https://fixture.invalid/gate');await gate;}first=false;
  const part=await reader.read();if(part.done){outputEof=true;reader.releaseLock();controller.close();}
  else{outputBytes+=part.value.byteLength;controller.enqueue(part.value);}
 },async cancel(reason){await reader.cancel(reason);reader.releaseLock();}},{highWaterMark:0}),response);
}};
`;
async function start(t, held) {
  const temporary = await mkdtemp(join(tmpdir(), "published-music-workerd-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const io = await network(t);
  const upstream = `const maximumWire=${maximumWire.toString()};export default {async fetch(request){
    if(request.url==='https://fixture.invalid/gate')return fetch(${JSON.stringify(io.origin + "/gate")});
    if(request.url!=='https://openrouter.ai/api/v1/chat/completions')return new Response(null,{status:400});
    await request.arrayBuffer();
    ${held ? `return fetch(${JSON.stringify(io.origin + "/pending")});` : `const parts=maximumWire();return new Response(new ReadableStream({type:'bytes',pull(controller){const part=parts.next();if(part.done){controller.close();controller.byobRequest?.respond(0);}else controller.enqueue(part.value);},cancel(){parts.return();}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}});`}
  }};`;
  const runtime = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true, r2Buckets: ["CONTENT_ARCHIVE"],
    bindings: { CLAWROUTER_PUBLIC_ORIGIN: "https://router.example", OPENROUTER_SITE_URL: "https://example.com" } });
  t.after(() => runtime.dispose()); assert.equal((await runtime.dispatchFetch("https://router.example/fixture/setup")).status, 200);
  return { runtime, io };
}
async function publish(runtime) {
  const image = maximumImage(), body = musicBody(model);
  body.messages[0].content = [{ type: "text", text: "Synthetic instrumental." }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } }];
  const response = await runtime.dispatchFetch("https://router.example/v1/input-assets/openrouter/music", { method: "POST",
    headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", "idempotency-key": "actual-workerd-image" }, body: JSON.stringify(body) });
  assert.equal(response.status, 201, response.status === 201 ? undefined : await response.text());
  const issued = await response.json(); body.messages[0].content[1].image_url.url = issued.url;
  return { body, digest: createHash("sha256").update(image).digest("hex") };
}

test("published music actual R2/DO/fetch path holds maximum image and wire charges through downstream EOF", { timeout: 120000 }, async t => {
  const { runtime, io } = await start(t, false), { body, digest } = await publish(runtime);
  const expected = createHash("sha256"); for (const part of maximumWire()) expected.update(part);
  const response = await runtime.dispatchFetch("https://router.example/v1/native/openrouter/v1/chat/completions", { method: "POST",
    headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", "x-fixture-gated": "true" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
  const reader = response.body.getReader(), actual = createHash("sha256"); let bytes = 0;
  const first = await reader.read(); assert.equal(first.done, false); actual.update(first.value); bytes += first.value.length;
  const phase = await (await runtime.dispatchFetch("https://router.example/fixture/phase")).json();
  assert.ok(phase.outputBytes > 0 && phase.outputBytes < 32 * MiB); assert.equal(phase.outputEof, false);
  assert.equal(phase.remaining, 76 * MiB); assert.equal(phase.dispatchCharge, 80 * MiB); assert.equal(phase.getCharge, 96 * MiB);
  io.release();
  for (;;) { const part = await reader.read(); if (part.done) break; actual.update(part.value); bytes += part.value.length; }
  reader.releaseLock(); assert.equal(bytes, 32 * MiB); assert.equal(actual.digest("hex"), expected.digest("hex"));
  const state = await (await runtime.dispatchFetch("https://router.example/fixture/state")).json();
  assert.equal(state.remaining, 0); assert.equal(state.fetches, 1); assert.equal(state.imageBytes, 8 * MiB); assert.equal(state.imageDigest, digest);
  assert.equal(state.outputEof, true); assert.equal(state.events.length, 1); assert.equal(state.events[0].actual_cost_micros, 700);
  assert.equal(state.events[0].cost_basis, "policy_fixed"); assert.equal(state.events[0].grant_key, "oauth/fixture/openrouter");
});

test("controlled request cancellation retires the actual pending DO/provider read without replay or refund", { timeout: 120000 }, async t => {
  const { runtime, io } = await start(t, true), { body } = await publish(runtime);
  const pending = runtime.dispatchFetch("https://router.example/v1/native/openrouter/v1/chat/completions", { method: "POST",
    headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", "x-fixture-controlled": "true" }, body: JSON.stringify(body) });
  // Wait for actual TCP read ownership, not a producer's speculative first pull.
  await io.entered;
  assert.equal(io.metrics.pending, 1);
  const phase = await (await runtime.dispatchFetch("https://router.example/fixture/phase")).json();
  assert.equal(phase.remaining, 80 * MiB); assert.equal(phase.upstreamAborted, false);
  assert.equal((await runtime.dispatchFetch("https://router.example/fixture/abort")).status, 200);
  const response = await pending; assert.equal(response.status, 502); await response.text(); await io.closed;
  const state = await (await runtime.dispatchFetch("https://router.example/fixture/state")).json();
  assert.equal(state.fetches, 1); assert.equal(state.remaining, 0); assert.equal(state.upstreamAborted, true);
  assert.equal(io.metrics.closed, 1); assert.equal(state.events.length, 1); assert.equal(state.events[0].actual_cost_micros, 700);
});
