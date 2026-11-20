import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { musicWire } from "./openrouter-music-runtime-fixture.mjs";

const router = `
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject } from './worker/index.ts';
import worker from './worker/index.ts';
import { snapshot } from './worker/providers.ts';
import { authorityCall } from './worker/authority.ts';
import { putGrantCredentials } from './worker/grant-credentials.ts';
import { sha256Hex } from './worker/utils.ts';
import { bodyBudgetCharged } from './worker/body-budget.ts';
import { configureMusic, musicBody } from './worker/test/openrouter-music-runtime-fixture.mjs';
const provider = snapshot.providers.find(value => value.id === 'openrouter'); configureMusic(provider);
const originalFetch = globalThis.fetch.bind(globalThis), originalReader = ReadableStream.prototype.getReader;
const networkBodies = new WeakSet(); let fetches = 0, reads = 0, byob = false, dispatchCapacity = 0;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('unexpected physical destination');
  fetches++; dispatchCapacity = bodyBudgetCharged();
  const response = await originalFetch(input, init);
  if (response.body) networkBodies.add(response.body); return response;
};
ReadableStream.prototype.getReader = function(options) {
  if (networkBodies.has(this)) {
    networkBodies.delete(this); reads++;
    // Probe the actual fetch body when the native wrapper reads it. A common
    // non-byte TransformStream would lose this identity and fail the proof.
    const probe = originalReader.call(this, {mode:'byob'}); probe.releaseLock(); byob = true;
  }
  return originalReader.call(this, options);
};
export default { async fetch(request, bindings) {
  const env = {...bindings, OPENROUTER_SITE_URL:'https://example.com'};
  await authorityCall(env, '/policies/initialize-all', [{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['openrouter'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
  await authorityCall(env, '/credentials/initialize-all', [{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env, '/connections/initialize-all', [{providerId:'openrouter',enabled:true,monthlyBudgetMicros:10000}]);
  await putGrantCredentials(env, 'oauth/fixture/openrouter', {provider:'openrouter',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
  const pending = [], response = await worker.fetch(new Request('https://router.example/v1/native/openrouter/v1/chat/completions',{
    method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},body:JSON.stringify(musicBody())
  }), env, {waitUntil(promise){pending.push(promise);}});
  const wire = await response.text(); while(pending.length) await Promise.all(pending.splice(0));
  return Response.json({status:response.status,wire,fetches,reads,byob,dispatchCapacity,remainingCapacity:bodyBudgetCharged()});
}, queue: worker.queue };
`;
const upstream = `export default {async fetch(request){
  if(request.url !== 'https://openrouter.ai/api/v1/chat/completions' || request.method !== 'POST'
    || request.headers.get('authorization') !== 'Bearer synthetic-original-key') return new Response('invalid original dispatch',{status:400});
  const body = await request.json(); if(body.model !== 'google/lyria-3-pro-preview' || body.audio.format !== 'wav') return new Response('invalid native body',{status:400});
  return new Response(${JSON.stringify(musicWire())},{headers:{'content-type':'text/event-stream'}});
}};`;

test("workerd actual OpenRouter music fetch reaches the NativeResponse reader as BYOB and releases its charged lease", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-music-workerd-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const instance = await startWorkerdFixture(temporary, router, upstream); t.after(() => instance.dispose());
  const response = await fetch((await instance.ready).origin), result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.wire, musicWire()); assert.equal(result.fetches, 1); assert.equal(result.reads, 1); assert.equal(result.byob, true);
  assert.ok(result.dispatchCapacity >= 64 * 1024 * 1024 && result.dispatchCapacity <= 96 * 1024 * 1024);
  assert.equal(result.remainingCapacity, 0);
});
