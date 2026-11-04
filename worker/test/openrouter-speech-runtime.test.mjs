import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { configureSpeech, speechAudio, speechBody, speechModels } from "./openrouter-speech-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const native = "/v1/native/openrouter/v1/audio/speech", manifest = "/v1/proxy/openrouter/speech", audio = speechAudio();
async function setup(t, options = {}) {
  const provider = structuredClone(snapshot.providers.find(p => p.id === "openrouter")); configureSpeech(provider);
  const f = await fixture(t, { pooled: true, ...options, providerId: "openrouter", configure(p) { Object.assign(p, provider); } });
  f.env.OPENROUTER_API_KEY = "synthetic-environment-key"; f.env.OPENROUTER_SITE_URL = "https://example.com";
  f.rows = () => [...new Set(f.budgetCalls.map(v => v.name))].flatMap(name => f.budgets.get(name).reservations());
  f.request = (body = speechBody(), { manifest: envelope = false, query = "", ...extra } = {}) => f.call((envelope ? manifest : native) + query,
    envelope ? { body: { ...body, model: `openrouter/${body.model}` } } : body, extra);
  f.upstream = async request => { f.dispatch = { capacity: bodyBudgetCharged(), rows: f.rows() }; f.upload = await request.json();
    return new Response(audio, { headers: { "content-type": "audio/mpeg", "content-length": String(audio.length), "x-private-upstream": "synthetic" } }); };
  t.after(async () => { await f.drain(); assert.equal(bodyBudgetCharged(), 0); }); return f;
}
async function settled(f, cost) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1); const event = events[0]; assert.equal(event.actual_cost_micros, cost);
  for (const name of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(event[name], null);
  assert.equal(event.grant_key, grantKey); assert.equal(event.capability, "audio.speech"); return event;
}
for (const model of speechModels) for (const envelope of [false, true]) test(`OpenRouter MP3 ${model} ${envelope ? "manifest" : "native"} preserves exact bytes and original dispatch`, async t => {
  const f = await setup(t), body = speechBody(model), response = await f.request(body, { manifest: envelope });
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio); assert.equal(f.sent.length, 1); assert.deepEqual(f.upload, body);
  assert.equal(f.sent[0].url, "https://openrouter.ai/api/v1/audio/speech"); assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key"); assert.equal(f.sent[0].redirect, "manual");
  assert.equal(response.headers.get("x-private-upstream"), null); assert.equal(f.dispatch.capacity, 64 * 1024 * 1024);
  assert.equal(f.dispatch.rows.length, 2); assert.ok(f.dispatch.rows.every(row => row.dispatch_started === 1 && row.reserved_micros === 700 && row.settled === 0));
  assert.equal((await settled(f, 700)).cost_basis, "policy_fixed");
});

test("native speech factory precedes the generic 4096-character validator", async t => {
  const f = await setup(t), body = { ...speechBody(), input: "x".repeat(32768) }, response = await f.request(body);
  assert.equal(response.status, 200, await response.clone().text()); await response.arrayBuffer(); assert.equal(f.upload.input, body.input); await settled(f, 700);
});

for (const mode of ["unknown", "text-price", "character-price"]) test(`hard USD ${mode} cannot invent an OpenRouter speech tariff or advertise admission`, async t => {
  const f = await setup(t, { fixed: null });
  const pricing = mode === "text-price" ? structuredClone(snapshot.providers.find(p => p.id === "openai").models.find(m => m.pricing && m.pricing.unit == null).pricing)
    : mode === "character-price" ? { unit: "character", inputMicrosPerMillionCharacters: 15000000, maxInputCharacters: 32768 } : null;
  for (const model of f.provider.models.filter(m => speechModels.includes(m.upstream))) model.pricing = pricing;
  for (const envelope of [false, true]) { const response = await f.request(undefined, { manifest: envelope }); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required"); }
  assert.equal(f.sent.length, 0);
  const catalog = await (await f.call("/v1/catalog", null)).json(); const offers = catalog.providers.find(p => p.id === "openrouter").offers.filter(o => o.endpoint === "speech");
  assert.ok(offers.length); assert.ok(offers.every(o => !o.eligible && o.reasonCode === "pricing_required"));
});

test("the existing OpenAI character tariff is unaffected by OpenRouter context", () => {
  const pricing = { unit: "character", inputMicrosPerMillionCharacters: 15000000, maxInputCharacters: 4096 };
  const args = [{ id: "openai/tts-1", upstream: "tts-1", pricing }, { input: "text" }, null, "audio.speech", { request_format: "openai.audio_speech" }, undefined, undefined];
  assert.equal(estimateCost(...args, "openai").basis, "manifest_pricing"); assert.equal(estimateCost(...args, "openrouter").pricingGap, "opaque_input_bound");
});

for (const mode of ["query", "origin", "missing-voice", "missing-format", "pcm", "gemini", "too-long", "generic-chat"]) test(`OpenRouter speech ${mode} refuses before egress`, async t => {
  const f = await setup(t), body = speechBody();
  if (mode === "origin") f.provider.base_urls.default = "https://other.example/api";
  if (mode === "missing-voice") delete body.voice;
  if (mode === "missing-format") delete body.response_format;
  if (mode === "pcm") body.response_format = "pcm";
  if (mode === "gemini") body.model = "google/gemini-3.1-flash-tts-preview";
  if (mode === "too-long") body.input = "x".repeat(32769);
  const response = mode === "generic-chat" ? await f.call("/v1/chat/completions", { model: `openrouter/${body.model}`, messages: [{ role: "user", content: "Synthetic." }] })
    : await f.request(body, { query: mode === "query" ? "?voice=foreign" : "" });
  assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
});

for (const mode of ["redirect", "non200", "mime", "partial", "encoding", "empty", "read-bound"]) test(`OpenRouter speech dispatched ${mode} retains fixed charge without partial audio or replay`, async t => {
  const f = await setup(t); f.upstream = () => {
    const headers = { "content-type": mode === "mime" ? "audio/pcm" : "audio/mpeg" };
    if (mode === "redirect") headers.location = "https://other.example";
    if (mode === "partial") headers["content-length"] = String(audio.length + 1);
    if (mode === "encoding") headers["content-encoding"] = "gzip";
    let body = mode === "empty" ? new Uint8Array() : audio;
    if (mode === "read-bound") { let reads = 0; body = new ReadableStream({ pull(c) { if (++reads <= 8192) c.enqueue(new Uint8Array()); else { c.enqueue(audio); c.close(); } } }, { highWaterMark: 0 }); }
    return new Response(body, { status: mode === "redirect" ? 302 : mode === "non200" ? 422 : 200, headers });
  };
  const response = await f.request(); assert.equal(response.status, 502); assert.equal(response.headers.get("content-type").includes("audio"), false); await response.text();
  assert.equal(f.sent.length, 1); assert.equal((await settled(f, 700)).cost_basis, "policy_fixed");
});

test("speech capacity exhaustion denies before dispatch, preserving the other lease", async t => {
  const f = await setup(t), lease = new BodyLease(); assert.equal(lease.grow(32 * 1024 * 1024), true);
  try { const response = await f.request(); assert.equal(response.status, 503); await response.text(); assert.equal(f.sent.length, 0); await settled(f, 0); }
  finally { lease.release(); }
});

test("speech cancellation reaches the original fetch and retains one fixed settlement", async t => {
  const f = await setup(t), abort = new AbortController(); let observed;
  f.upstream = request => new Promise((resolve, reject) => { observed = request.signal; observed.addEventListener("abort", () => reject(observed.reason), { once: true }); abort.abort(); });
  const response = await f.request(undefined, { signal: abort.signal }); assert.ok(response.status >= 400); await response.text(); assert.equal(observed.aborted, true); assert.equal(f.sent.length, 1); await settled(f, 700);
});

test("selected grant revocation cannot borrow environment credentials", async t => {
  const f = await setup(t); f.policy.grantRouting = { eligibleGrants: { openrouter: ["replicate"] }, environmentFallback: false }; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await putGrantCredentials(f.env, grantKey, { provider: "openrouter", kind: "api_key", enabled: false, credential: "synthetic-original-key" });
  const response = await f.request(); assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
});

test("registered speech ingress refuses more than 256 KiB before paid dispatch", async t => {
  const f = await setup(t), response = await f.request({ ...speechBody(), input: "x".repeat(256 * 1024) });
  assert.equal(response.status, 413); await response.text(); assert.equal(f.sent.length, 0);
});

test("frozen native speech accounting never promotes token or character observations to an invoice", async () => {
  const { accountingReceipt } = await import("../proxy-accounting.ts");
  const event = accountingReceipt({ event: {}, nativeSpeech: true, fixed: null,
    requestFormat: "openai.audio_speech", startedAtMs: 0, model: { pricing: { unit: "character", inputMicrosPerMillionCharacters: 1 } },
    cost: { reserveMicros: 700, basis: "unpriced_request", pricingGap: "opaque_input_bound" } },
  { occurredAtMs: 1, statusCode: 200, status: "success", billable: true, tokens: { input: 10, output: 20, total: 30 },
    characterEstimate: 1, reservation: { reservations: [], reservedMicros: 700 }, contentRef: null });
  assert.equal(event.actual_cost_micros, 700); assert.equal(event.cost_basis, "unpriced_usage");
  for (const name of ["input_tokens", "output_tokens", "total_tokens", "pricing_ref", "pricing_effective_at"]) assert.equal(event[name], null);
});
