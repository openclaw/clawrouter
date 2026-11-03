import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { transcriptionLimits } = await import("../transcription-body.ts");
const { revokeGrantCredentials } = await import("../grant-credentials.ts");
const source = parse(readFileSync(new URL("../../providers/senseaudio.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/senseaudio/transcription.json", import.meta.url), "utf8"));
const upstreamModel = "senseaudio-asr-pro-1.5-260319", model = `senseaudio/${upstreamModel}`;
const routes = ["/v1/native/senseaudio/v1/audio/transcriptions", "/v1/proxy/senseaudio/transcriptions"];
function form(path = routes[0], sample = wire.aacFile, fields = {}) {
  const body = new FormData();
  body.set("model", path.includes("/native/") ? upstreamModel : model);
  body.set("file", new File([Buffer.from(sample.base64, "base64")], sample.name, { type: sample.type }));
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return body;
}
async function setup(t, options = {}) {
  const original = snapshot.providers; snapshot.providers = original.filter(provider => provider.id !== "senseaudio");
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId: "senseaudio", configure(provider) {
    Object.assign(provider, compileProviderSnapshot([structuredClone(source)]).providers[0]);
  } });
  f.env.SENSEAUDIO_API_KEY = "synthetic-environment-key";
  if (options.pooled) {
    f.policy.grantRouting = { eligibleGrants: { senseaudio: ["replicate"] }, environmentFallback: false };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  }
  const pending = [];
  f.request = (body = form(), { path = routes[0], headers = {}, signal } = {}) => worker.fetch(new Request("https://router.example" + path, {
    method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", ...headers }, body, signal,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  }), f.env, { waitUntil: promise => pending.push(promise) });
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  const drain = f.drain;
  f.drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); await drain(); };
  f.upstream = () => Response.json(wire.response);
  t.after(f.drain); return f;
}

for (const path of routes) for (const pooled of [false, true]) for (const sampleName of ["aacFile", "wav"]) {
  test(`SenseAudio real multipart ${sampleName}, ${pooled ? "grant" : "environment"}, ${path}`, async t => {
    const f = await setup(t, { pooled }), sample = sampleName === "wav" ? wire.request.file : wire.aacFile;
    const original = Buffer.from(sample.base64, "base64");
    if (sampleName === "aacFile") {
      assert.equal(original.length, 1401); assert.ok(original.length >= wire.mediaEvidence.audioHostMinimumBytes);
      assert.equal(createHash("sha256").update(original).digest("hex"), "b6997afc26e56714955991922c489f947f4b353b37e7cf39eae48e61dd0c1b28");
    }
    f.upstream = async request => {
      assert.equal(request.url, "https://api.senseaudio.cn/v1/audio/transcriptions"); assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("authorization"), pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-environment-key");
      assert.equal(request.headers.has("x-api-key"), false);
      const uploaded = await request.formData(), file = uploaded.get("file");
      assert.equal(file.name, sample.name); assert.equal(file.type, sample.type); assert.deepEqual(Buffer.from(await file.arrayBuffer()), original);
      assert.equal(uploaded.get("model"), upstreamModel); assert.equal(uploaded.get("language"), "eng"); assert.equal(uploaded.get("prompt"), "synthetic café");
      assert.equal(f.rows().length, 2); assert.ok(f.rows().every(row => row.dispatch_started === 1));
      return Response.json({ ...wire.response, usage: { input_tokens: 999, output_tokens: 8, total_tokens: 1007 } });
    };
    const response = await f.request(form(path, sample, { language: "eng", prompt: "synthetic café" }), { path, headers: { "x-api-key": "synthetic-caller-key" } });
    const result = await response.json(); assert.equal(response.status, 200); assert.equal(result.text, wire.response.text);
    assert.equal(response.headers.get("x-clawrouter-accounting"), "policy-fixed");
    await f.drain(); assert.equal(f.sent.length, 1, "actual host-sized upload must reach upstream exactly once");
    const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].provider, "senseaudio"); assert.equal(events[0].model, model);
    assert.equal(events[0].total_tokens, null); assert.equal(events[0].input_tokens, null); assert.equal(events[0].output_tokens, null);
    assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
    assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 700));
  });
}

for (const path of routes) test("SenseAudio unknown dollar bound denies dispatch and catalog eligibility: " + path, async t => {
  const f = await setup(t, { fixed: null });
  const response = await f.request(form(path), { path }); const error = await response.json();
  assert.equal(response.status, 400); assert.equal(error.error.code, "pricing_required"); assert.equal(f.sent.length, 0);
  const catalog = await f.call("/v1/catalog", null); const value = await catalog.json(); assert.equal(catalog.status, 200);
  const offers = value.providers.find(provider => provider.id === "senseaudio").offers;
  assert.ok(offers.length > 0); assert.ok(offers.every(offer => !offer.eligible && offer.reasonCode === "pricing_required"));
});

for (const native of [true, false]) test("SenseAudio catalog advertises only the qualified multipart wire: " + native, async t => {
  const f = await setup(t); f.provider.endpoints[0].native_proxy = native;
  const response = await f.call("/v1/catalog", null), value = await response.json(); assert.equal(response.status, 200);
  const provider = value.providers.find(provider => provider.id === "senseaudio");
  assert.equal(provider.models[0].pricing, null);
  const offer = provider.offers.find(offer => offer.modelId === model && offer.eligible);
  assert.ok(offer); assert.equal(offer.routeKind, native ? "native" : "manifest"); assert.equal(offer.route, routes[native ? 0 : 1]);
  assert.equal(provider.routes[0].requestFormat, "openai.audio_transcriptions"); assert.equal(provider.routes[0].responseFormat, "senseaudio.transcription");
  assert.ok(provider.offers.every(offer => offer.routeKind !== "unified"));
  assert.equal(f.sent.length, 0);
});

test("SenseAudio authenticates before reading or rejecting malformed uploads", async t => {
  const f = await setup(t); let pulled = 0;
  const body = new ReadableStream({ pull() { pulled++; } }, { highWaterMark: 0 });
  const response = await f.request(body, { headers: { authorization: "invalid", "content-type": "bad", "content-length": "10032769" } });
  await response.text(); assert.equal(response.status, 401); assert.equal(pulled, 0); assert.equal(f.sent.length, 0); await body.cancel();
});

for (const kind of ["model", "duplicate", "file-id", "stream", "language", "mime", "oversize", "json", "query", "destination"]) {
  test("SenseAudio rejects unqualified multipart input before egress: " + kind, async t => {
    const f = await setup(t); let body = form(), path = routes[0], headers = {};
    if (kind === "model") body.set("model", "openai/gpt-4o-transcribe");
    if (kind === "duplicate") body.append("model", upstreamModel);
    if (kind === "file-id") body.set("file_id", "unowned-file");
    if (kind === "stream") body.set("stream", "true");
    if (kind === "language") body.set("language", "engl");
    if (kind === "mime") body.set("file", new File([Buffer.from(wire.aacFile.base64, "base64")], "renamed.m4a", { type: "audio/aac" }));
    if (kind === "oversize") body.set("file", new File([new Uint8Array(10_000_001)], "large.wav", { type: "audio/wav" }));
    if (kind === "json") { body = JSON.stringify({ model: upstreamModel, file: "https://audio.example/file.wav" }); headers["content-type"] = "application/json"; }
    if (kind === "query") path += "?language=eng";
    if (kind === "destination") f.provider.base_urls.default = "https://foreign.example";
    const response = await f.request(body, { path, headers }); await response.text(); assert.ok([400, 413].includes(response.status));
    await f.drain(); assert.equal(f.sent.length, 0); assert.ok(f.rows().every(row => row.reserved_micros === 0));
  });
}

test("SenseAudio AAC and three-letter language do not relax OpenAI multipart", async t => {
  const f = await setup(t);
  for (const body of [form(routes[0], wire.aacFile, { model: "gpt-4o-transcribe" }), form(routes[0], wire.request.file, { model: "gpt-4o-transcribe", language: "eng" })]) {
    const response = await f.request(body, { path: "/v1/native/openai/v1/audio/transcriptions" }); await response.text(); assert.equal(response.status, 400);
  }
  assert.equal(f.sent.length, 0);
});

for (const kind of ["model-policy", "capability", "streaming", "native-disabled"]) test("SenseAudio selected declaration and model policy remain authoritative: " + kind, async t => {
  const f = await setup(t);
  if (kind === "model-policy") { f.policy.models = ["senseaudio/other"]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
  if (kind === "capability") f.provider.models[0].capabilities = ["llm.chat"];
  if (kind === "streaming") f.provider.endpoints[0].streaming = "sse";
  if (kind === "native-disabled") f.provider.endpoints[0].native_proxy = false;
  const response = await f.request(); await response.text(); assert.ok([400, 403].includes(response.status)); assert.equal(f.sent.length, 0);
});

test("SenseAudio chunked input stops at its own raw envelope", async t => {
  const f = await setup(t); let pulls = 0, canceled = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1_000_000)); }, cancel() { canceled++; } }, { highWaterMark: 0 });
  const response = await f.request(body, { headers: { "content-type": "multipart/form-data; boundary=synthetic" } }); await response.text();
  assert.equal(response.status, 413); assert.equal(pulls, 11); assert.equal(canceled, 1); assert.equal(f.sent.length, 0);
});

for (const kind of ["grant", "credential"]) test("SenseAudio re-admits after upload and denies revoked original " + kind, async t => {
  const f = await setup(t, { pooled: true });
  const encoded = new Request("https://upload.example", { method: "POST", body: form() });
  const bytes = new Uint8Array(await encoded.arrayBuffer()); let sent = false;
  const body = new ReadableStream({ async pull(controller) {
    if (sent) { controller.close(); return; } sent = true;
    if (kind === "grant") await revokeGrantCredentials(f.env, grantKey);
    else await f.authority("/credentials/mutate", { operation: "revoke", scope: "admin", credentialId: "fixture", actor: { auth: "admin_token", role: "admin", email: "fixture@example.com" } });
    controller.enqueue(bytes);
  } }, { highWaterMark: 0 });
  const response = await f.request(body, { headers: { "content-type": encoded.headers.get("content-type") } }); await response.text();
  assert.equal(response.status, kind === "grant" ? 503 : 401); assert.equal(f.sent.length, 0); assert.equal(f.rows().length, 0);
});

for (const kind of ["redirect", "rejection", "partial", "invalid-utf8", "length", "compression", "range", "error"]) {
  test("SenseAudio dispatched uncertainty retains one policy charge without replay: " + kind, async t => {
    const f = await setup(t);
    f.upstream = () => {
      if (kind === "redirect") return new Response(null, { status: 307, headers: { location: "https://foreign.example" } });
      if (kind === "rejection") return Response.json({ error: "synthetic-upstream-private" }, { status: 422 });
      if (kind === "partial") return new Response('{"text":"partial",', { headers: { "content-type": "application/json" } });
      if (kind === "invalid-utf8") return new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } });
      if (kind === "error") return Response.json({ text: "unqualified", error: null });
      return Response.json(wire.response, { headers: kind === "length" ? { "content-length": "999999" } : kind === "compression" ? { "content-encoding": "gzip" } : { "content-range": "bytes 0-4/5" } });
    };
    const response = await f.request(); const text = await response.text(); assert.equal(response.status, 502); assert.ok(!text.includes("synthetic-upstream-private"));
    await f.drain(); assert.equal(f.sent.length, 1); const events = await f.events(); assert.equal(events.length, 1);
    assert.equal(events[0].total_tokens, null); assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
    assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 700));
  });
}

test("SenseAudio interrupted response cancels the reader and retains dispatched accounting", async t => {
  const f = await setup(t), caller = new AbortController(); let canceled = 0;
  f.upstream = () => new Response(new ReadableStream({ pull() { caller.abort(); }, cancel() { canceled++; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const response = await f.request(form(), { signal: caller.signal }); await response.text(); assert.equal(response.status, 499);
  await f.drain(); assert.equal(canceled, 1); assert.equal(f.sent.length, 1); assert.equal((await f.events())[0].actual_cost_micros, 700);
});

test("SenseAudio dispatch acknowledgment denial refunds known-unsent work", async t => {
  const f = await setup(t), get = f.env.BUDGET_LEDGER.get.bind(f.env.BUDGET_LEDGER);
  f.env.BUDGET_LEDGER.get = name => { const stub = get(name); return { fetch: (url, init) => new URL(url).pathname === "/dispatch" ? Response.json({ dispatched: false }) : stub.fetch(url, init) }; };
  const response = await f.request(); await response.text(); assert.equal(response.status, 503); await f.drain();
  assert.equal(f.sent.length, 0); assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 0));
});

test("SenseAudio upload deadline cancels reading before dispatch", async t => {
  const f = await setup(t), saved = transcriptionLimits.readMs; transcriptionLimits.readMs = 5; t.after(() => { transcriptionLimits.readMs = saved; });
  let canceled = 0; const body = new ReadableStream({ pull() {}, cancel() { canceled++; } }, { highWaterMark: 0 });
  const response = await f.request(body, { headers: { "content-type": "multipart/form-data; boundary=synthetic" } }); await response.text();
  assert.equal(response.status, 408); assert.equal(canceled, 1); assert.equal(f.sent.length, 0);
});
