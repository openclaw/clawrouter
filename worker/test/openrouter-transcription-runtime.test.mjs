import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { default: worker } = await import("../index.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const source = parse(readFileSync(new URL("../../providers/openrouter.provider.yaml", import.meta.url), "utf8"));
const model = "openai/whisper-large-v3-turbo", modelId = `openrouter/${model}`, format = "openrouter.audio_transcription";
const nativePath = "/v1/native/openrouter/v1/audio/transcriptions", manifestPath = "/v1/proxy/openrouter/transcription";
// Same decoder-qualified 2,048-byte WAV as the published native client/wrapper.
function wave(total = 2048) {
  const value = Buffer.alloc(total, 42); value.write("RIFF"); value.writeUInt32LE(total - 8, 4); value.write("WAVEfmt ", 8);
  value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22); value.writeUInt32LE(8000, 24);
  value.writeUInt32LE(16000, 28); value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34);
  value.write("data", 36); value.writeUInt32LE(total - 44, 40); return value;
}
const audio = wave();
const body = (data = audio) => ({ model, input_audio: { data: data.toString("base64"), format: "wav" }, language: "en" });
const result = () => ({ text: "Synthetic offline transcript.", model, usage: { input_tokens: 7, output_tokens: 0, total_tokens: 7, seconds: 0.125, cost: 999 } });
const bytes = value => new TextEncoder().encode(JSON.stringify(value));
async function setup(t, options = {}) {
  const manifest = structuredClone(source);
  manifest.capabilities = manifest.capabilities.filter(value => value.id !== "audio.transcription" || value.endpoint !== "transcription");
  manifest.models.entries = manifest.models.entries.filter(value => value.id !== modelId);
  manifest.capabilities.push({ id: "audio.transcription", endpoint: "transcription", methods: ["POST"] });
  manifest.endpoints.transcription = { method: "POST", path: "/v1/audio/transcriptions", requestFormat: format, responseFormat: format };
  manifest.models.entries.push({ id: modelId, upstream: model, capabilities: ["audio.transcription"] });
  const original = snapshot.providers; snapshot.providers = original.filter(provider => provider.id !== "openrouter");
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId: "openrouter", configure(provider) {
    Object.assign(provider, compileProviderSnapshot([manifest]).providers[0]);
    provider.endpoints.find(endpoint => endpoint.id === "transcription").timeout_ms = options.timeout ?? 1000;
  } });
  f.env.OPENROUTER_API_KEY = "synthetic-environment-key"; f.env.OPENROUTER_SITE_URL = "https://example.com";
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.request = (value = body(), { manifest = false, query = "", ...extra } = {}) => f.call((manifest ? manifestPath : nativePath) + query,
    manifest ? { body: { ...value, model: modelId } } : value, extra);
  f.pending = [];
  f.raw = (stream, headers = {}, signal) => worker.fetch(new Request(`https://router.example${nativePath}`, {
    method: "POST", body: stream, duplex: "half", signal,
    headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", ...headers },
  }), f.env, { waitUntil: promise => f.pending.push(promise) });
  const drain = f.drain; f.drain = async () => { await drain(); while (f.pending.length) await Promise.all(f.pending.splice(0)); };
  f.upstream = async request => {
    f.dispatch = { capacity: bodyBudgetCharged(), rows: f.rows() };
    f.upload = await request.json();
    return options.response ? options.response(request) : Response.json(result(), { headers: { "x-generation-id": "gen_fixture", "x-private-upstream": "synthetic" } });
  };
  t.after(f.drain); return f;
}
async function error(response, status) { const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text).error; }
async function settled(f, cost = 700) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1); const event = events[0];
  assert.equal(event.actual_cost_micros, cost); assert.ok(f.rows().every(row => row.settled === 1)); assert.equal(bodyBudgetCharged(), 0);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:original-key|environment-key)|offline transcript/);
  return event;
}
for (const manifest of [false, true]) for (const pooled of [false, true]) {
  test(`OpenRouter native JSON transcription ${manifest ? "manifest" : "native"}/${pooled ? "grant" : "environment"} preserves actual audio, original credentials and one fixed settlement`, async t => {
    const f = await setup(t, { pooled });
    assert.equal(createHash("sha256").update(audio).digest("hex"), "5efcd8ff93f78a2a9177e4db8b767662c7feb49aec41238f78fad5ceb6d635ed");
    const response = await f.request(undefined, { manifest, headers: { "x-api-key": "synthetic-caller-key" } });
    assert.equal(response.status, 200, response.ok ? undefined : await response.text()); assert.deepEqual(await response.json(), result());
    assert.equal(response.headers.get("x-generation-id"), "gen_fixture"); assert.equal(response.headers.get("x-private-upstream"), null);
    assert.equal(f.sent.length, 1); const sent = f.sent[0];
    assert.equal(sent.url, "https://openrouter.ai/api/v1/audio/transcriptions"); assert.equal(sent.method, "POST"); assert.equal(sent.redirect, "manual");
    assert.equal(sent.headers.get("authorization"), `Bearer synthetic-${pooled ? "original" : "environment"}-key`); assert.equal(sent.headers.get("x-api-key"), null);
    assert.deepEqual(f.upload, body()); assert.deepEqual(Buffer.from(f.upload.input_audio.data, "base64"), audio);
    assert.equal(f.dispatch.rows.length, 2); assert.ok(f.dispatch.rows.every(row => row.dispatch_started === 1 && row.reserved_micros === 700));
    assert.ok(f.dispatch.capacity >= 16 * 1024 * 1024);
    const event = await settled(f); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.capability, "audio.transcription");
    assert.equal(event.model, modelId); assert.equal(event.input_tokens, 7); assert.equal(event.output_tokens, 0); assert.equal(event.total_tokens, 7);
  });
}
for (const manifest of [false, true]) test(`OpenRouter ${manifest ? "manifest" : "native"} ingress expands beyond 8 MiB only on its qualified JSON route`, { timeout: 20_000 }, async t => {
  const f = await setup(t, { pooled: true }), large = wave(7 * 1024 * 1024), value = body(large);
  assert.ok(bytes(value).length > 8 * 1024 * 1024);
  const response = await f.request(value, { manifest }); assert.equal(response.status, 200, response.ok ? undefined : await response.text()); await response.text();
  assert.equal(f.sent.length, 1); assert.equal(f.upload.input_audio.data, value.input_audio.data);
  assert.ok(f.dispatch.capacity > 32 * 1024 * 1024); assert.ok(f.dispatch.capacity <= 64 * 1024 * 1024); await settled(f);
});
for (const scenario of ["unpriced", "unauthenticated", "missing-credential", "foreign-origin", "query", "wrong-model", "stream", "remote-audio", "multipart"]) {
  test(`OpenRouter transcription ${scenario} cannot dispatch`, async t => {
    const f = await setup(t, { fixed: scenario === "unpriced" ? null : 700 }); const value = body(), extra = {};
    if (scenario === "missing-credential") delete f.env.OPENROUTER_API_KEY;
    if (scenario === "foreign-origin") f.provider.base_urls.default = "https://unqualified.example";
    if (scenario === "unauthenticated") extra.headers = { authorization: "Bearer synthetic-invalid" };
    if (scenario === "query") extra.query = "?temperature=0.5";
    if (scenario === "wrong-model") value.model = "openai/whisper-1";
    if (scenario === "stream") value.stream = true;
    if (scenario === "remote-audio") value.input_audio = { url: "https://unqualified.example/audio.wav", format: "wav" };
    if (scenario === "multipart") extra.headers = { "content-type": "multipart/form-data; boundary=fixture" };
    const response = await f.request(value, extra); const text = await response.text(); assert.ok(response.status >= 400 && response.status < 600, text);
    if (scenario === "unpriced") assert.equal(JSON.parse(text).error.code, "pricing_required");
    assert.equal(f.sent.length, 0); await f.drain(); assert.ok((await f.events()).every(event => event.actual_cost_micros === 0)); assert.equal(bodyBudgetCharged(), 0);
  });
}
test("OpenRouter exact 24 MiB ingress boundary rejects declared overflow before reading or leasing", async t => {
  const f = await setup(t); let pulled = 0;
  const stream = new ReadableStream({ pull() { pulled++; } }, { highWaterMark: 0 });
  await error(await f.raw(stream, { "content-length": String(24 * 1024 * 1024 + 1) }), 413);
  assert.equal(pulled, 0); assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
});
test("OpenRouter expanded upload authenticates before its lease and re-admits the caller after EOF", async t => {
  const f = await setup(t, { pooled: true }), encoded = bytes(body(wave(7 * 1024 * 1024)));
  let pulled = 0;
  await error(await f.raw(new ReadableStream({ pull() { pulled++; } }, { highWaterMark: 0 }), {
    "content-length": String(encoded.length), authorization: "Bearer synthetic-invalid",
  }), 401);
  assert.equal(pulled, 0); assert.equal(bodyBudgetCharged(), 0);
  const reached = Promise.withResolvers(); let input;
  const pending = f.raw(new ReadableStream({ start(controller) { input = controller; }, pull() { reached.resolve(); } }, { highWaterMark: 0 }), { "content-length": String(encoded.length) });
  await reached.promise;
  await f.authority("/credentials/mutate", { operation: "revoke", scope: "admin", credentialId: "fixture", actor: { auth: "admin_token", role: "admin", email: "fixture@example.com" } });
  input.enqueue(encoded); input.close(); const response = await pending; assert.ok(response.status >= 400); await response.text();
  assert.equal(f.sent.length, 0); await f.drain(); assert.equal(bodyBudgetCharged(), 0);
});
for (const failure of ["redirect", "rejected", "partial", "wrong-model", "error-null", "length", "encoding"]) test(`OpenRouter dispatched ${failure} withholds output and retains conservative settlement`, async t => {
  const f = await setup(t, { pooled: true, response: () => {
    if (failure === "redirect") return new Response(null, { status: 307, headers: { location: "https://unqualified.example" } });
    if (failure === "rejected") return Response.json({ error: { message: "private upstream rejection" } }, { status: 422 });
    if (failure === "partial") return new Response('{"text":"partial', { headers: { "content-type": "application/json" } });
    const value = result(), headers = { "content-type": "application/json" };
    if (failure === "wrong-model") value.model = "other";
    if (failure === "error-null") value.error = null;
    if (failure === "length") headers["content-length"] = String(bytes(value).length + 1);
    if (failure === "encoding") headers["content-encoding"] = "gzip";
    return new Response(bytes(value), { headers });
  } });
  assert.equal((await error(await f.request(), 502)).code, "provider_unavailable"); const event = await settled(f);
  assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(event.total_tokens, null); assert.equal(f.sent.length, 1);
});
for (const text of ["", "   "]) test(`OpenRouter successful silence ${JSON.stringify(text)} is delivered once with unknown tokens and no invented free charge`, async t => {
  const f = await setup(t, { response: () => Response.json({ text, model, usage: { seconds: 1.25, cost: 0 } }) });
  const response = await f.request(); assert.equal(response.status, 200); assert.equal((await response.json()).text, text);
  const event = await settled(f); assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(event.total_tokens, null); assert.equal(f.sent.length, 1);
});
test("OpenRouter complete JSON is held until EOF and caller abort cancels its original reader", async t => {
  const reached = Promise.withResolvers(), abort = new AbortController(); let published = false, canceled = false;
  const f = await setup(t, { response: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes(result())); reached.resolve(); }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } }) });
  const pending = f.request(undefined, { signal: abort.signal }).then(response => { published = true; return response; });
  await reached.promise; await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(published, false);
  abort.abort(); await error(await pending, 502); const event = await settled(f);
  assert.equal(canceled, true); assert.equal(event.input_tokens, null); assert.equal(f.sent.length, 1);
});
test("OpenRouter response capacity failure is known-unsent", async t => {
  const f = await setup(t), blocker = new BodyLease(); assert.equal(blocker.grow(48 * 1024 * 1024), true);
  try { await error(await f.request(), 503); assert.equal(f.sent.length, 0); } finally { blocker.release(); }
  await settled(f, 0);
});

test("OpenRouter missing dispatch acknowledgment never sends paid transcription", async t => {
  const f = await setup(t), ledger = f.env.BUDGET_LEDGER; let denied = 0;
  f.env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ async fetch(url, init) {
    if (new URL(url).pathname === "/dispatch") { denied++; return Response.json({ error: "synthetic lost ACK" }, { status: 503 }); }
    const response = await ledger.get(name).fetch(url, init);
    if (new URL(url).pathname !== "/reserve") return response;
    const receipt = await response.json(); delete receipt.dispatched; return Response.json(receipt, { status: response.status });
  } }) };
  assert.equal((await error(await f.request(), 503)).code, "accounting_unavailable");
  await settled(f, 0); assert.equal(f.sent.length, 0); assert.equal(denied, 2);
});
test("OpenRouter decoded audio beyond 16 MiB is rejected inside the distinct 24 MiB JSON envelope", { timeout: 20_000 }, async t => {
  const f = await setup(t); const value = body(wave(16 * 1024 * 1024 + 1));
  assert.ok(bytes(value).length < 24 * 1024 * 1024);
  await error(await f.request(value), 400); assert.equal(f.sent.length, 0); assert.equal(f.rows().length, 0);
  await f.drain(); assert.equal(bodyBudgetCharged(), 0);
});
