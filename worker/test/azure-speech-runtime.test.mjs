import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig, HOT_CACHE_DISABLED } = await import("../hot-cache.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/azure-speech/ssml.json", import.meta.url)));
const source = parse(readFileSync(new URL("../../providers/azure-speech.provider.yaml", import.meta.url), "utf8"));
// Byte transport fixture only; vendor synthesis is not called by these tests.
const audio = Uint8Array.of(0xff, 0xf3, 0x64, 0xc4, 0, 0, 0, 3, 0x48, 0, 0, 0);
const path = "/v1/native/azure-speech/cognitiveservices/v1";
const format = "audio-24khz-48kbitrate-mono-mp3", capacity = 32 * 1024 * 1024;
const encode = value => new TextEncoder().encode(value);

async function setup(t, options = {}) {
  const original = snapshot.providers;
  snapshot.providers = original.filter(provider => provider.id !== "azure-speech");
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId: "azure-speech", configure(provider) {
    Object.assign(provider, compileProviderSnapshot([structuredClone(source)]).providers[0]);
    provider.endpoints[0].timeout_ms = options.timeout ?? 1000;
    if (options.origin) provider.base_urls.default = options.origin;
  } });
  f.env.AZURE_SPEECH_API_KEY = "synthetic-azure-environment-key";
  f.env.AZURE_SPEECH_REGION = "eastus";
  const pending = [], drain = f.drain;
  f.drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); await drain(); };
  f.request = (body = wire.request.body, { manifest = false, query = "", ...extra } = {}) => worker.fetch(
    new Request("https://router.example" + (manifest ? "/v1/proxy/azure-speech/speech" : path) + query, {
      method: "POST", ...extra, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/ssml+xml; charset=utf-8",
        "x-microsoft-outputformat": format, "ocp-apim-subscription-key": "synthetic-caller-upstream-key", ...extra.headers },
    }), f.env, { waitUntil: promise => pending.push(promise) });
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = async request => {
    f.dispatched = { capacity: bodyBudgetCharged(), paths: f.budgetCalls.map(call => call.path), rows: f.rows() };
    return options.response ? options.response(request) : new Response(audio, { headers: { "content-type": "audio/mpeg", "x-private-upstream": "synthetic" } });
  };
  t.after(f.drain); return f;
}
async function error(response, status) {
  const text = await response.text(); assert.equal(response.status, status, text);
  assert.doesNotMatch(text, /synthetic private|synthetic-original-key|synthetic-azure-environment-key|synthetic-caller-upstream-key/);
  return JSON.parse(text).error;
}
async function settled(f, cost = 700) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, cost); assert.equal(events[0].cost_basis, cost === 0 ? "none" : "policy_fixed");
  assert.equal(f.rows().length, 2); assert.equal(events[0].input_tokens, null); assert.equal(events[0].output_tokens, null);
  assert.equal(events[0].total_tokens, null);
  assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === cost));
  assert.equal(bodyBudgetCharged(), 0); return events[0];
}

for (const manifest of [false, true]) for (const pooled of [false, true]) {
  test(`Azure ${manifest ? "manifest" : "native"} ${pooled ? "grant" : "environment"} preserves SSML bytes and original credentials`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled }), bytes = encode(wire.request.body);
    const response = await f.request(bytes, { manifest, headers: { "content-length": String(bytes.length) } });
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    assert.equal(bodyBudgetCharged(), capacity); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio);
    assert.equal(response.headers.get("content-type"), "audio/mpeg"); assert.equal(response.headers.get("x-private-upstream"), null);
    assert.equal(f.sent.length, 1); const request = f.sent[0];
    assert.equal(request.url, "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
    assert.equal(request.method, "POST"); assert.equal(request.redirect, "manual");
    assert.deepEqual(new Uint8Array(await request.clone().arrayBuffer()), bytes);
    assert.equal(request.headers.get("content-type"), "application/ssml+xml; charset=utf-8");
    assert.equal(request.headers.get("x-microsoft-outputformat"), format);
    assert.equal(request.headers.get("ocp-apim-subscription-key"), pooled ? "synthetic-original-key" : "synthetic-azure-environment-key");
    assert.equal(request.headers.get("authorization"), null); assert.equal(f.dispatched.capacity, capacity);
    assert.equal(f.dispatched.rows.length, 2);
    assert.ok(f.dispatched.rows.every(row => row.dispatch_started === 1 && row.settled === 0 && row.reserved_micros === 700));
    const event = await settled(f); assert.equal(event.model, null); assert.equal(event.capability, "audio.speech");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-original-key|synthetic-azure-environment-key|Synthetic café/);
  });
}

for (const manifest of [false, true]) test(`Azure ${manifest ? "manifest" : "native"} rejects malformed/raw-JSON/unsupported input before egress`, { timeout: 10_000 }, async t => {
  const f = await setup(t);
  for (const body of ["", JSON.stringify({ body: wire.request.body }), "\uFEFF" + wire.request.body,
    Uint8Array.of(0xff, 0xfe), encode(wire.request.body.replace("Synthetic café &amp; 中文 😀", "<audio src=\"https://unqualified.example\"/>"))])
    await error(await f.request(body, { manifest }), 400);
  for (const headers of [{ "content-type": "application/json" }, { "content-type": "application/ssml+xml; charset=utf-16" },
    { "x-microsoft-outputformat": "" }, { "x-microsoft-outputformat": "raw-8khz-8bit-mono-mulaw" },
    { "content-encoding": "gzip" }, { "content-length": "-1" }, { "content-length": "1" }])
    await error(await f.request(undefined, { manifest, headers }), 400);
  await error(await f.request(undefined, { manifest, query: "?region=westus" }), 400);
  await error(await f.request("x".repeat(65537), { manifest }), 413);
  await error(await f.request(undefined, { manifest, headers: { "content-length": "65537" } }), 413);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});

for (const scenario of ["unpriced", "missing-credential", "foreign-origin", "provider-policy"]) test(`Azure ${scenario} denies before dispatch`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: scenario === "unpriced" ? null : 700, ...(scenario === "foreign-origin" ? { origin: "https://unqualified.example" } : {}) });
  if (scenario === "missing-credential") delete f.env.AZURE_SPEECH_API_KEY;
  if (scenario === "provider-policy") { f.policy.providers = ["unrelated"]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
  const response = await f.request(), text = await response.text(); assert.ok(response.status >= 400, text);
  if (scenario === "unpriced") assert.equal(JSON.parse(text).error.code, "pricing_required");
  assert.equal(f.sent.length, 0); await f.drain(); assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
});

test("Azure authenticates before reading the upload", { timeout: 10_000 }, async t => {
  const f = await setup(t); let reads = 0;
  const body = new ReadableStream({ pull(c) { reads++; c.enqueue(encode(wire.request.body)); c.close(); } }, { highWaterMark: 0 });
  await error(await f.request(body, { headers: { authorization: "Bearer synthetic-invalid" } }), 401);
  assert.equal(reads, 0); assert.equal(f.sent.length, 0); await body.cancel();
});

for (const change of ["credential", "policy", "grant"]) test(`Azure re-admits ${change} changes after upload despite a warm cache`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  overrideHotCacheConfig({ freshMs: 30_000, maxAgeMs: 60_000 }); t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
  let changed = false;
  const body = new ReadableStream({ async pull(c) {
    if (change === "credential") {
      const mutation = await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "revoke", credentialId: "fixture" });
      assert.equal((await mutation.json()).outcome, "updated");
    }
    if (change === "policy") await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, enabled: false } });
    if (change === "grant") await putGrantCredentials(f.env, grantKey, { provider: "azure-speech", kind: "api_key", enabled: false, credential: "synthetic-original-key" });
    changed = true; c.enqueue(encode(wire.request.body)); c.close();
  } }, { highWaterMark: 0 });
  const result = await error(await f.request(body), change === "grant" ? 503 : 403);
  assert.equal(changed, true);
  assert.equal(result.code, change === "credential" ? "proxy_key_revoked" : change === "policy" ? "policy_revoked" : "upstream_grant_pool_unavailable");
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});

test("Azure rejects an aborted upload and bounds a stalled upload deadline", { timeout: 10_000 }, async t => {
  const f = await setup(t), abort = new AbortController();
  let canceled = false; const read = Promise.withResolvers();
  const body = new ReadableStream({ pull() { read.resolve(); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
  const pending = f.request(body, { signal: abort.signal }); await read.promise; abort.abort();
  await error(await pending, 400); assert.equal(canceled, true);
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 30_000 ? 10 : ms, ...args));
  const stalled = new ReadableStream({ pull() {}, cancel() { canceled = true; } }, { highWaterMark: 0 });
  canceled = false; await error(await f.request(stalled), 408); assert.equal(canceled, true);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});

test("Azure permits the exact UTF-8 byte bound without character/token billing inference", { timeout: 10_000 }, async t => {
  const f = await setup(t), text = "Synthetic café &amp; 中文 😀";
  const overhead = encode(wire.request.body.replace(text, "")).length;
  const body = wire.request.body.replace(text, "x".repeat(65536 - overhead));
  assert.equal(encode(body).length, 65536);
  const response = await f.request(body); assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(await f.sent[0].clone().text(), body); await settled(f);
});

test("Azure selected regional configuration and explicit retention preserve the real raw input", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }), retained = [];
  f.env.AZURE_SPEECH_REGION = "westus2";
  f.policy.retainRequestContent = true;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.env.CONTENT_ARCHIVE = { async put(key, value) { retained.push(JSON.parse(value)); } };
  const response = await f.request(); assert.equal(response.status, 200); await response.arrayBuffer();
  const event = await settled(f);
  assert.equal(f.sent[0].url, "https://westus2.tts.speech.microsoft.com/cognitiveservices/v1");
  assert.equal(f.sent[0].headers.get("ocp-apim-subscription-key"), "synthetic-original-key");
  assert.equal(retained.length, 1); assert.deepEqual(retained[0].body, { ssml: wire.request.body });
  assert.equal(event.content_retained, true); assert.equal(event.content_ref, retained[0].contentRef);
});

for (const failure of ["redirect", "rejected", "mime", "range", "length", "overflow", "interrupt", "deadline"]) {
  test(`Azure ${failure} response preserves uncertainty without paid replay or partial audio`, { timeout: 10_000 }, async t => {
    let canceled = false;
    const f = await setup(t, { pooled: true, timeout: 50, response: () => {
      if (failure === "redirect") return new Response(null, { status: 307, headers: { location: "https://unqualified.example" } });
      if (failure === "rejected") return Response.json({ error: "synthetic private rejection" }, { status: 422 });
      if (failure === "mime") return new Response(audio, { headers: { "content-type": "audio/ogg" } });
      const headers = { "content-type": "audio/mpeg" };
      if (failure === "range") headers["content-range"] = "bytes 0-7/100";
      if (failure === "length") headers["content-length"] = String(audio.byteLength + 1);
      if (failure === "overflow") headers["content-length"] = String(16 * 1024 * 1024 + 1);
      if (["interrupt", "deadline"].includes(failure)) return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(audio.subarray(0, 8)); if (failure === "interrupt") controller.error(new Error("synthetic transport loss"));
      }, cancel() { canceled = true; } }), { headers });
      return new Response(audio, { headers });
    } });
    await error(await f.request(), 502); const event = await settled(f);
    assert.equal(f.sent.length, 1); assert.equal(event.cost_basis, "policy_fixed");
    if (failure === "deadline") { assert.equal(canceled, true); assert.equal(event.status, "timeout"); }
  });
}

test("Azure waits for bounded binary EOF before publication and holds capacity through delivery", { timeout: 10_000 }, async t => {
  const reached = Promise.withResolvers(); let stream;
  const f = await setup(t, { response: () => new Response(new ReadableStream({ start(controller) {
    stream = controller; controller.enqueue(audio); reached.resolve();
  } }), { headers: { "content-type": "audio/mpeg" } }) });
  let delivered = false; const pending = f.request().then(response => { delivered = true; return response; });
  await reached.promise; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(delivered, false); assert.equal(bodyBudgetCharged(), capacity); assert.deepEqual(await f.events(), []);
  stream.close(); const response = await pending; assert.equal(response.status, 200);
  assert.equal(bodyBudgetCharged(), capacity); await response.body.cancel("synthetic delivery cancellation");
  await settled(f); assert.equal(f.sent.length, 1);
});

test("Azure caller cancellation stops the original reader and conservatively settles once", { timeout: 10_000 }, async t => {
  const reached = Promise.withResolvers(), abort = new AbortController(); let canceled = false;
  const f = await setup(t, { response: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(audio.subarray(0, 8)); reached.resolve();
  }, cancel() { canceled = true; } }), { headers: { "content-type": "audio/mpeg" } }) });
  const pending = f.request(undefined, { signal: abort.signal }); await reached.promise; abort.abort();
  await error(await pending, 502); const event = await settled(f);
  assert.equal(event.status, "client_error"); assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});

test("Azure shared capacity denial is known-unsent and releases the fixed reservation", { timeout: 10_000 }, async t => {
  const other = new BodyLease(); assert.equal(other.grow(40 * 1024 * 1024), true);
  const f = await setup(t);
  try { assert.equal((await error(await f.request(), 503)).code, "server_overloaded"); }
  finally { other.release(); }
  await settled(f, 0); assert.equal(f.sent.length, 0);
});

test("Azure missing dispatch acknowledgments cannot turn a reservation into an upstream attempt", { timeout: 10_000 }, async t => {
  const f = await setup(t), ledger = f.env.BUDGET_LEDGER;
  let combined = 0, fallback = 0;
  f.env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ async fetch(url, init) {
    const path = new URL(url).pathname;
    if (path === "/dispatch") {
      fallback++;
      return Response.json({ error: "synthetic lost dispatch ACK" }, { status: 503 });
    }
    const response = await ledger.get(name).fetch(url, init);
    if (path !== "/reserve") return response;
    if (JSON.parse(init.body).dispatched === true) combined++;
    // The reserve receipt survives but its dispatch acknowledgment does not.
    // The existing fallback must obtain that acknowledgment before paid egress.
    const receipt = await response.json(); delete receipt.dispatched;
    return Response.json(receipt, { status: response.status });
  } }) };
  assert.equal((await error(await f.request(), 503)).code, "accounting_unavailable");
  await settled(f, 0); assert.equal(f.sent.length, 0);
  assert.equal(combined, 2); assert.equal(fallback, 2);
});
