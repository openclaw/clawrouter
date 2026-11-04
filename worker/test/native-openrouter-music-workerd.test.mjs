import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

// Shared only between this test host and its synthetic upstream Worker. Neither
// buffers the full wire/audio. The router under test uses the actual fetch path.
function* musicWire(full = true, padded = true, terminal = true) {
  const size = full ? 16 * 1024 * 1024 : 236;
  const header = new Uint8Array(44), view = new DataView(header.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) header[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, size - 8, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true); view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, size - 44, true);
  let bytes = 0;
  const envelope = (choices, extra = {}) => "data: " + JSON.stringify({ id: "gen-full-size-fixture", model: "google/lyria-3-pro-preview", choices, ...extra }) + "\n\n";
  for (let offset = 0; offset < size; offset += 24576) {
    const audio = new Uint8Array(Math.min(24576, size - offset));
    if (!offset) audio.set(header);
    const part = envelope([{ index: 0, delta: { audio: { data: btoa(String.fromCharCode(...audio)) } }, finish_reason: null }]);
    bytes += part.length; yield part;
  }
  for (const part of [envelope([{ index: 0, delta: {}, finish_reason: "stop" }]),
    envelope([], { usage: { prompt_tokens: 99, completion_tokens: 999, cost: 12.34 } })]) { bytes += part.length; yield part; }
  const done = "data: [DONE]\n\n";
  let padding = padded ? 32 * 1024 * 1024 - bytes - done.length : 0;
  while (padding) {
    let size = Math.min(padding, 128 * 1024);
    if (padding > size && padding - size < 3) size -= 3;
    yield ":" + "p".repeat(size - 3) + "\n\n"; padding -= size;
  }
  if (terminal) yield done;
}

const router = `
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject } from './worker/index.ts';
import worker from './worker/index.ts';
import { snapshot } from './worker/providers.ts';
import { authorityCall } from './worker/authority.ts';
import { putGrantCredentials } from './worker/grant-credentials.ts';
import { sha256Hex } from './worker/utils.ts';
import { bodyBudgetCharged } from './worker/body-budget.ts';
import { usageStub } from './worker/ledgers.ts';
// This is the published source1 composition dependency, not a substitute selector.
import { configureMusic, musicBody } from './worker/test/openrouter-music-runtime-fixture.mjs';
configureMusic(snapshot.providers.find(value => value.id === 'openrouter'));
const originalFetch = globalThis.fetch.bind(globalThis), originalReader = ReadableStream.prototype.getReader;
const bodies = new WeakSet(); let initialized, metrics = {}, pending = new Set();
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('unexpected physical destination');
  metrics.fetches++; metrics.dispatchCapacity = bodyBudgetCharged();
  const response = await originalFetch(input, init); if (response.body) bodies.add(response.body); return response;
};
ReadableStream.prototype.getReader = function(options) {
  const reader = originalReader.call(this, options);
  if (bodies.has(this)) {
    bodies.delete(this); metrics.nativeReaders++; metrics.byob = options?.mode === 'byob';
    const read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
    reader.read = async (view, options) => {
      metrics.reads++;
      if (!view || view.buffer.byteLength > 65536) throw new Error('unbounded transport window');
      metrics.maxWindow = Math.max(metrics.maxWindow, view.buffer.byteLength);
      const result = await read(view, options);
      if (result.value) {
        if (result.value.buffer.byteLength > 65536) throw new Error('unbounded returned window');
        metrics.bytes += result.value.byteLength;
      }
      return result;
    };
    reader.cancel = reason => { metrics.cancels++; return cancel(reason); };
  }
  return reader;
};
export default { async fetch(request, bindings, context) {
  const url = new URL(request.url), env = {...bindings, OPENROUTER_SITE_URL:'https://example.com'};
  if (url.pathname === '/proof') return Response.json({...metrics, pending:pending.size, capacity:bodyBudgetCharged()});
  if (url.pathname === '/usage') return usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin');
  initialized ??= (async () => {
    await authorityCall(env, '/policies/initialize-all', [{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['openrouter'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
    await authorityCall(env, '/credentials/initialize-all', [{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
    await authorityCall(env, '/connections/initialize-all', [{providerId:'openrouter',enabled:true,monthlyBudgetMicros:10000}]);
    await putGrantCredentials(env, 'oauth/fixture/openrouter', {provider:'openrouter',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
  })();
  await initialized;
  const mode = url.searchParams.get('mode');
  if (pending.size || bodyBudgetCharged()) {
    metrics.guardRejection = {requestedMode:mode,previousMode:metrics.mode,pending:pending.size,capacity:bodyBudgetCharged()};
    return Response.json({error:'fixture_previous_delivery_pending',...metrics.guardRejection},{status:500});
  }
  metrics = {mode,fetches:0,nativeReaders:0,reads:0,bytes:0,maxWindow:0,cancels:0,byob:false};
  if (!['full','delivery-cancel','quarantine-cancel','small','truncated'].includes(mode)) return new Response('invalid fixture mode',{status:400});
  const body = musicBody(); body.messages[0].content = mode;
  const response = await worker.fetch(new Request('https://router.example/v1/native/openrouter/v1/chat/completions',{
    method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},body:JSON.stringify(body),signal:request.signal
  }),env,{waitUntil(promise){const tracked=Promise.resolve(promise).finally(()=>pending.delete(tracked));pending.add(tracked);context.waitUntil(tracked);}});
  metrics.status = response.status; metrics.beforeDeliveryCapacity = bodyBudgetCharged();
  // Do not call response.text()/arrayBuffer() here: actual delivery must leave
  // the isolate without another whole-wire allocation or synthetic reader.
  return response;
}, queue:worker.queue };
`;
const upstream = `const musicWire = ${musicWire.toString()};
export default {async fetch(request){
  if(request.url !== 'https://openrouter.ai/api/v1/chat/completions' || request.method !== 'POST'
    || request.headers.get('authorization') !== 'Bearer synthetic-original-key') return new Response('invalid original dispatch',{status:400});
  const body = await request.json(); if(body.model !== 'google/lyria-3-pro-preview' || body.audio.format !== 'wav') return new Response('invalid native body',{status:400});
  const mode = body.messages[0].content, small = mode === 'small' || mode === 'quarantine-cancel';
  const parts = musicWire(!small,!small,mode !== 'truncated' && mode !== 'quarantine-cancel'); let finished = false;
  return new Response(new ReadableStream({pull(controller){
    if(finished) return; const part=parts.next();
    if(part.done){finished=true;if(mode==='truncated')controller.close();return;}
    controller.enqueue(new TextEncoder().encode(part.value));
  },cancel(){finished=true;parts.return();}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}});
}};`;

async function readFixtureJson(url) {
  const response = await fetch(url);
  try { assert.equal(response.status, 200, 'fixture observation failed'); return await response.json(); }
  finally { await response.body?.cancel().catch(() => {}); }
}
async function settled(origin) {
  let value;
  for (let attempt = 0; attempt < 100; attempt++) {
    value = await readFixtureJson(new URL('/proof', origin));
    if (value.capacity === 0 && value.pending === 0) return value;
    await delay(50);
  }
  assert.fail("original music operation did not release capacity after delivery/cancellation: " + JSON.stringify(value));
}
async function settlement(origin, count, status) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { events } = await readFixtureJson(new URL('/usage', origin));
    if (events.length >= count) {
      assert.equal(events.length, count); assert.equal(new Set(events.map(event => event.id)).size, count);
      const event = events[0]; assert.equal(event.status, status);
      assert.equal(event.actual_cost_micros, 700); assert.equal(event.cost_basis, 'policy_fixed');
      assert.equal(event.grant_key, 'oauth/fixture/openrouter'); assert.equal(event.capability, 'music.generate');
      assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(event.total_tokens, null);
      return;
    }
    await delay(50);
  }
  assert.fail('original operation did not publish one conservative policy-fixed settlement');
}
function assertPhysical(value) {
  assert.equal(value.fetches, 1); assert.equal(value.nativeReaders, 1); assert.equal(value.byob, true);
  assert.ok(value.reads > 0); assert.equal(value.maxWindow, 65536); assert.equal(value.cancels, 1);
  assert.ok(value.dispatchCapacity >= 64 * 1024 * 1024 && value.dispatchCapacity <= 96 * 1024 * 1024);
  assert.equal(value.capacity, 0); assert.equal(value.pending, 0);
}

// A failed header/status assertion must still stop the HTTP pump and retire its
// original operation. Otherwise the first case can retain capacity into the next.
async function musicRequest(origin, mode, run) {
  const abort = new AbortController(); let response, failure;
  const pending = fetch(new URL('/?mode=' + mode, origin), {signal:abort.signal})
    .then(value => { response = value; return value; });
  void pending.catch(() => {}); // Observe a rejection even if a fixture assertion fails first.
  try { return await run(pending, abort); }
  catch (error) { failure = error; throw error; }
  finally {
    abort.abort();
    await pending.catch(() => {});
    await response?.body?.cancel().catch(() => {});
    try { await settled(origin); }
    catch (error) {
      if (failure) throw new AggregateError([failure,error], 'fixture assertion failed and cleanup did not release the original operation');
      throw error;
    }
  }
}
async function assertStatus(response, expected, origin) {
  if (response.status !== expected)
    assert.fail(JSON.stringify({expectedStatus:expected,actualStatus:response.status,proof:await readFixtureJson(new URL('/proof',origin))}));
}

test("workerd full-output music uses actual fetch BYOB, original wire, bounded delivery and cancellation", {timeout:120000}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-full-music-workerd-")); t.after(() => rm(temporary, {recursive:true,force:true}));
  const instance = await startWorkerdFixture(temporary,router,upstream); t.after(() => instance.dispose());
  const origin = (await instance.ready).origin;
  await t.test("exact 16 MiB WAV / 32 MiB SSE reaches the consumer with the response lease held", () => musicRequest(origin,'full',async pending => {
    const response = await pending;
    await assertStatus(response,200,origin); assert.equal(response.headers.get('content-type'),'text/event-stream');
    // Workerd ignores manually assigned Content-Length for an ordinary stream:
    // https://developers.cloudflare.com/workers/runtime-apis/response/#set-the-content-length-header
    // Prove the actual count/hash after complete delivery, independently of HTTP framing.
    const hash=createHash('sha256'); let bytes=0;
    for await (const chunk of response.body) {bytes+=chunk.byteLength;hash.update(chunk);}
    const expected=createHash('sha256'); for(const part of musicWire())expected.update(part);
    // Independently decoder-qualified 16 MiB WAV in this exact 32 MiB SSE fixture.
    const expectedHash=expected.digest('hex');
    assert.equal(expectedHash,'b25351f0c76ebc191d53b6275d14277aff41279a3c1d1af45131af243875bd43');
    assert.equal(bytes,32*1024*1024); assert.equal(hash.digest('hex'),expectedHash);
    const proof=await settled(origin);assertPhysical(proof);assert.equal(proof.bytes,bytes);
    assert.ok(proof.beforeDeliveryCapacity>=64*1024*1024);
    await settlement(origin,1,'success');
  }));
  await t.test("small DONE on an open socket never requires filling the BYOB window", () => musicRequest(origin,'small',async pending => {
    const response=await pending;await assertStatus(response,200,origin);
    assert.equal(await response.text(),[...musicWire(false,false)].join(''));
    const proof=await settled(origin);assertPhysical(proof);assert.ok(proof.bytes<65536);
    await settlement(origin,2,'success');
  }));
  await t.test("full-size replay cancellation releases the original operation without replaying POST", () => musicRequest(origin,'delivery-cancel',async (pending,abort) => {
    const response=await pending;await assertStatus(response,200,origin);
    const reader=response.body.getReader();
    try { assert.ok((await reader.read()).value.length); }
    finally { abort.abort(); await reader.cancel().catch(()=>{}); reader.releaseLock(); }
    const proof=await settled(origin);assertPhysical(proof);assert.equal(proof.bytes,32*1024*1024);
    assert.ok(proof.beforeDeliveryCapacity>=64*1024*1024);
    await settlement(origin,3,'client_error');
  }));
  await t.test("cancellation during quarantine exposes no partial HTTP 200 or audio", () => musicRequest(origin,'quarantine-cancel',async (pending,abort) => {
    const outcome=pending.then(response=>({response}),error=>({error}));
    let started=false;
    for(let attempt=0;attempt<100;attempt++){
      const p=await readFixtureJson(new URL('/proof',origin));
      if(p.mode==='quarantine-cancel'&&p.nativeReaders===1&&p.bytes>0&&p.bytes<65536){started=true;break;}
      await delay(20);
    }
    assert.equal(started,true,JSON.stringify(await readFixtureJson(new URL('/proof',origin))));
    abort.abort();const result=await outcome;assert.equal(result.error?.name,'AbortError');
    assertPhysical(await settled(origin)); await settlement(origin,4,'client_error');
  }));
  await t.test("full audio with missing native DONE is an atomic failure", () => musicRequest(origin,'truncated',async pending => {
    const response=await pending;await assertStatus(response,502,origin);
    const text=await response.text();assert.ok(text.length<4096);assert.doesNotMatch(text,/UklG|AAAA/);
    assertPhysical(await settled(origin));
    await settlement(origin,5,'provider_error');
  }));
});
