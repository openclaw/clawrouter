import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { configurePcm, pcmBody, pcmModel } from "./openrouter-pcm-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig, HOT_CACHE_DISABLED } = await import("../hot-cache.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const native = "/v1/native/openrouter/v1/audio/speech", manifest = "/v1/proxy/openrouter/speech";
// Opaque bytes prove transport, not PCM signedness, endianness or playability.
const audio = Uint8Array.from({ length: 2048 }, (_, i) => i % 251);
async function setup(t, options = {}) {
  const provider = structuredClone(snapshot.providers.find(p => p.id === "openrouter")); configurePcm(provider);
  const f = await fixture(t, { pooled: true, ...options, providerId: "openrouter", configure(p) { Object.assign(p, provider); } });
  f.env.OPENROUTER_API_KEY = "synthetic-environment-key"; f.env.GOOGLE_API_KEY = "synthetic-unrelated-key";
  f.env.OPENROUTER_SITE_URL = "https://example.com";
  f.request = (body = pcmBody(), { manifest: envelope = false, query = "", ...extra } = {}) => f.call((envelope ? manifest : native) + query,
    envelope ? { body: { ...body, model: `openrouter/${body.model}` } } : body, extra);
  f.upstream = async request => { f.capacity = bodyBudgetCharged(); f.upload = await request.json();
    return new Response(audio, { headers: { "content-type": "audio/pcm", "content-length": String(audio.length), "content-encoding": "identity" } }); };
  t.after(async () => { await f.drain(); assert.equal(bodyBudgetCharged(), 0); }); return f;
}
async function settled(f, cost) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1); const event = events[0];
  assert.equal(event.actual_cost_micros, cost); for (const name of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(event[name], null);
  return event;
}
for (const envelope of [false, true]) test(`opaque PCM ${envelope ? "manifest" : "native"} uses the original OpenRouter grant and exact wire`, async t => {
  const f = await setup(t), body = { ...pcmBody(), input: "x".repeat(32768) };
  const response = await f.request(body, { manifest: envelope }); assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("content-type"), "audio/pcm"); assert.equal(response.headers.get("content-length"), String(audio.length));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio); assert.deepEqual(f.upload, body); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].url, "https://openrouter.ai/api/v1/audio/speech"); assert.equal(f.sent[0].redirect, "manual");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key"); assert.equal(f.capacity, 64 * 1024 * 1024);
  const receipt = await settled(f, 700); assert.equal(receipt.cost_basis, "policy_fixed"); assert.equal(receipt.grant_key, grantKey);
});

for (const mode of ["unknown", "text", "character"])
test(`PCM hard USD refuses ${mode} pricing before egress`, async t => {
  const f = await setup(t, { fixed: null });
  const pricing = mode === "text" ? structuredClone(snapshot.providers.find(p => p.id === "openai").models.find(model => model.pricing && model.pricing.unit == null).pricing)
    : mode === "character" ? { unit: "character", inputMicrosPerMillionCharacters: 1, maxInputCharacters: 32768 } : null;
  f.provider.models.find(model => model.upstream === pcmModel).pricing = pricing;
  for (const envelope of [false, true]) { const response = await f.request(undefined, { manifest: envelope }); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required"); }
  const catalog = await (await f.call("/v1/catalog", null)).json();
  const offers = catalog.providers.find(p => p.id === "openrouter").offers.filter(o => o.modelId === `openrouter/${pcmModel}`);
  assert.ok(offers.length); assert.ok(offers.every(o => !o.eligible)); assert.equal(f.sent.length, 0);
});

for (const mode of ["environment", "oauth", "subscription", "access-token", "disabled", "wrong-provider"]) test(`PCM ${mode} is not original API-key authority`, async t => {
  const f = await setup(t, { pooled: false });
  if (mode !== "environment") await putGrantCredentials(f.env, grantKey, { provider: mode === "wrong-provider" ? "google-gemini" : "openrouter",
    kind: ["oauth", "subscription"].includes(mode) ? mode : "api_key", enabled: mode !== "disabled",
    ...(mode === "access-token" ? { accessToken: "synthetic-access-token" } : { credential: "synthetic-original-key" }) });
  const response = await f.request(); assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
  if (mode === "environment") {
    const catalog = await (await f.call("/v1/catalog", null)).json();
    const offers = catalog.providers.find(p => p.id === "openrouter").offers.filter(o => o.modelId === `openrouter/${pcmModel}`);
    assert.ok(offers.length); assert.ok(offers.every(o => !o.eligible));
  }
});

for (const change of ["revoke", "rotate", "models", "caller", "routing", "owner-unavailable"]) test(`PCM ${change} after reservation denies without fallback`, async t => {
  const f = await setup(t);
  f.policy.grantRouting = { eligibleGrants: { openrouter: ["replicate"] }, environmentFallback: true, failover: true };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 });
  t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
  const warm = await f.request(); assert.equal(warm.status, 200); await warm.arrayBuffer(); await f.drain();
  assert.equal(f.sent.length, 1);
  const namespace = f.env.BUDGET_LEDGER; let changed = false;
  f.env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ async fetch(url, init) {
    const response = await namespace.get(name).fetch(url, init);
    if (!changed && new URL(url).pathname === "/dispatch") {
      changed = true;
      if (change === "revoke") await revokeGrantCredentials(f.env, grantKey);
      if (change === "rotate") await putGrantCredentials(f.env, grantKey, { provider: "openrouter", kind: "api_key", enabled: true, credential: "synthetic-rotated-key" });
      if (change === "models" || change === "routing") {
        if (change === "models") f.policy.models = ["openrouter/unrelated"];
        else f.policy.grantRouting = { eligibleGrants: { openrouter: ["foreign"] }, environmentFallback: true };
        await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
      }
      if (change === "caller") await f.authority("/credentials/mutate", { credentialId: "fixture", operation: "revoke", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "fixture@example.com" } });
      if (change === "owner-unavailable") f.env.GRANT_CREDENTIALS = { idFromName: name => name, get: () => ({ fetch: async () => new Response("unavailable", { status: 503 }) }) };
    }
    return response;
  } }) };
  const response = await f.request(); assert.equal(changed, true); assert.ok(response.status >= 400); await response.text();
  assert.equal(f.sent.length, 1); await f.drain();
  const receipts = await f.events(); assert.equal(receipts.length, 2); assert.deepEqual(receipts.map(row => row.actual_cost_micros).sort((a,b) => a-b), [0,700]);
});

for (const mode of ["query", "voice", "format", "mp3", "speed", "origin", "too-long", "too-large", "chat"]) test(`PCM ${mode} rejects before egress`, async t => {
  const f = await setup(t), body = pcmBody();
  if (mode === "voice") delete body.voice; if (mode === "format") delete body.response_format;
  if (mode === "mp3") body.response_format = "mp3"; if (mode === "speed") body.speed = 1;
  if (mode === "origin") f.provider.base_urls.default = "https://other.example/api";
  if (mode === "too-long") body.input = "x".repeat(32769); if (mode === "too-large") body.input = "x".repeat(256 * 1024);
  const response = mode === "chat" ? await f.call("/v1/chat/completions", { model: `openrouter/${pcmModel}`, messages: [] })
    : await f.request(body, { query: mode === "query" ? "?voice=foreign" : "" });
  assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
});

for (const mode of ["odd", "partial", "mime", "redirect", "non200", "encoding", "empty"]) test(`PCM dispatched ${mode} withholds audio and retains fixed charge`, async t => {
  const f = await setup(t); f.upstream = () => new Response(mode === "empty" ? new Uint8Array() : mode === "odd" ? audio.subarray(0, 3) : audio,
    { status: mode === "redirect" ? 302 : mode === "non200" ? 422 : 200, headers: { "content-type": mode === "mime" ? "audio/wav" : "audio/pcm",
      ...(mode === "partial" ? { "content-length": String(audio.length + 2) } : {}), ...(mode === "encoding" ? { "content-encoding": "gzip" } : {}) } });
  const response = await f.request(); assert.equal(response.status, 502); await response.text(); assert.equal(f.sent.length, 1); await settled(f, 700);
});
test("PCM accepts split odd chunks only when the complete aggregate is even", async t => {
  const f = await setup(t); f.upstream = () => new Response(new ReadableStream({ start(c) { c.enqueue(audio.slice(0, 3)); c.enqueue(audio.slice(3)); c.close(); } }), { headers: { "content-type": "audio/pcm" } });
  const response = await f.request(); assert.equal(response.status, 200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio); await settled(f, 700);
});
test("PCM response capacity is acquired before physical dispatch", async t => {
  const f = await setup(t), other = new BodyLease(); assert.equal(other.grow(32 * 1024 * 1024), true);
  try { const response = await f.request(); assert.equal(response.status, 503); await response.text(); assert.equal(f.sent.length, 0); await settled(f, 0); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024); }
  finally { other.release(); }
});
test("PCM caller cancellation reaches the active original quarantine read", async t => {
  const f = await setup(t), abort = new AbortController(); let reach, canceled = false, signal;
  const reading = new Promise(resolve => { reach = resolve; });
  f.upstream = request => { signal = request.signal; return new Response(new ReadableStream({ pull() { reach(); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "audio/pcm" } }); };
  const pending = f.request(undefined, { signal: abort.signal }); await reading; assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024); abort.abort();
  const response = await pending; assert.equal(response.status, 502); await response.text(); assert.equal(signal.aborted, true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(canceled, true); assert.equal(f.sent.length, 1); await settled(f, 700);
});

test("PCM owner-only eligibility preserves the existing MP3 environment offer and dispatch", async t => {
  const f = await setup(t, { pooled: false });
  const catalog = await (await f.call("/v1/catalog", null)).json(), offers = catalog.providers.find(p => p.id === "openrouter").offers;
  const pcm = offers.filter(o => o.modelId === `openrouter/${pcmModel}`), mp3 = offers.filter(o => o.modelId === "openrouter/hexgrad/kokoro-82m");
  assert.ok(pcm.length && mp3.length); assert.ok(pcm.every(o => !o.eligible)); assert.ok(mp3.some(o => o.eligible));
  const { speechAudio, speechBody } = await import("./openrouter-speech-runtime-fixture.mjs");
  f.upstream = () => new Response(speechAudio(), { headers: { "content-type": "audio/mpeg" } });
  const response = await f.request(speechBody()); assert.equal(response.status, 200, await response.clone().text()); await response.arrayBuffer();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-environment-key");
});
