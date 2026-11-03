import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const source = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/music.json", import.meta.url)));
const models = ["lyria-3-clip-preview", "lyria-3-pro-preview"];
// Reuse the source-owned wrapper's real offline MPEG Layer III fixture. No
// live generation or duration-to-price inference is part of this proof.
const mp3 = "//uwZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+7JkAA/wAABpAAAACAAADSAAAAEAAAGkAAAAIAAANIAAAARMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+7JkAA/wAABpAAAACAAADSAAAAEAAAGkAAAAIAAANIAAAARMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=";
const payload = () => ({ ...structuredClone(wire.response), candidates: [{ finishReason: "STOP", content: { role: "model", parts: [
  { thought: true, inlineData: { data: "synthetic-private-thought" } }, { inlineData: { mimeType: "audio/mpeg", data: mp3 } },
  { text: "Synthetic final lyrics remain unchanged." },
] } }] });
const delivered = () => { const value = payload(); value.candidates[0].content.parts.shift(); return value; };
const bytes = value => new TextEncoder().encode(JSON.stringify(value));

async function setup(t, options = {}) {
  const manifest = structuredClone(source);
  manifest.capabilities.push({ id: "audio.generate", endpoint: "music_generate", methods: ["POST"] });
  manifest.endpoints.music_generate = { method: "POST", path: "/v1beta/models/${model}:generateContent", pathParams: ["model"],
    requestFormat: "google.music_generate", responseFormat: "google.music", timeoutMs: 600000 };
  for (const upstream of models) manifest.models.entries.push({ id: `google/${upstream}`, upstream, capabilities: ["audio.generate"] });
  const original = snapshot.providers; snapshot.providers = original.filter(provider => provider.id !== "google-gemini");
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId: "google-gemini", configure(provider) {
    Object.assign(provider, compileProviderSnapshot([manifest]).providers[0]);
    provider.endpoints.find(endpoint => endpoint.id === "music_generate").timeout_ms = options.timeout ?? 1000;
    if (options.reverse) provider.endpoints.reverse();
  } });
  f.env.GOOGLE_API_KEY = "synthetic-google-environment";
  f.request = (body = wire.request.body, { manifest = false, model = models[0], query = "", ...extra } = {}) => f.call(
    (manifest ? "/v1/proxy/google-gemini/music_generate" : `/v1/native/google-gemini/v1beta/models/${model}:generateContent`) + query,
    manifest ? { body, pathParams: { model } } : body,
    { ...extra, headers: { "x-goog-api-key": "synthetic-caller-key", ...extra.headers } });
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = request => {
    f.dispatch = { capacity: bodyBudgetCharged(), rows: f.rows() };
    return options.response ? options.response(request) : Response.json(payload(), { headers: { "x-private-upstream": "synthetic" } });
  };
  t.after(f.drain); return f;
}
async function error(response, status) {
  const body = await response.text(); assert.equal(response.status, status, body); return JSON.parse(body).error;
}
async function settled(f, cost = 700) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  const event = events[0]; assert.equal(event.actual_cost_micros, cost);
  assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(event.total_tokens, null);
  assert.ok(f.rows().every(row => row.settled === 1)); assert.equal(bodyBudgetCharged(), 0);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:original-key|caller-key|google-environment|private-thought)/);
  return event;
}

for (const model of models) for (const manifest of [false, true]) for (const pooled of [false, true]) {
  test(`Google music ${model}/${manifest ? "manifest" : "native"}/${pooled ? "grant" : "environment"} preserves native delivery and one separate fixed charge`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled, reverse: model === models[1] });
    const response = await f.request(undefined, { model, manifest });
    assert.equal(response.status, 200, response.ok ? undefined : await response.text());
    assert.ok(bodyBudgetCharged() >= 64 * 1024 * 1024);
    const output = await response.json(); assert.deepEqual(output, delivered());
    assert.deepEqual(Buffer.from(output.candidates[0].content.parts[0].inlineData.data, "base64"), Buffer.from(mp3, "base64"));
    assert.equal(response.headers.get("x-private-upstream"), null);
    assert.equal(f.sent.length, 1); const request = f.sent[0];
    assert.equal(request.url, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
    assert.equal(request.redirect, "manual"); assert.equal(request.method, "POST");
    assert.equal(request.headers.get("x-goog-api-key"), pooled ? "synthetic-original-key" : "synthetic-google-environment");
    assert.deepEqual(await request.clone().json(), wire.request.body);
    assert.ok(f.dispatch.capacity >= 64 * 1024 * 1024); assert.equal(f.dispatch.rows.length, 2);
    assert.ok(f.dispatch.rows.every(row => row.dispatch_started === 1 && row.settled === 0 && row.reserved_micros === 700));
    const event = await settled(f); assert.equal(event.capability, "audio.generate"); assert.equal(event.model, `google/${model}`);
    assert.equal(event.cost_basis, "policy_fixed"); assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
  });
}

for (const scenario of ["unpriced", "unauthenticated", "missing-credential", "foreign-origin"]) test(`Google music ${scenario} remains zero-egress`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: scenario === "unpriced" ? null : 700 });
  if (scenario === "missing-credential") delete f.env.GOOGLE_API_KEY;
  if (scenario === "foreign-origin") f.provider.base_urls.default = "https://unqualified.example";
  const response = await f.request(undefined, scenario === "unauthenticated" ? { headers: { authorization: "Bearer synthetic-invalid" } } : {});
  const body = await response.text(); assert.ok(response.status >= 400 && response.status < 600, body);
  if (scenario === "unpriced") assert.equal(JSON.parse(body).error.code, "pricing_required");
  assert.equal(f.sent.length, 0); await f.drain(); assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
  assert.equal(bodyBudgetCharged(), 0);
});

test("Google music query, alias, unowned asset and stream attempts fail before reservation", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  for (const query of ["?alt=sse", "?key=synthetic", "?url=https://unqualified.example"])
    await error(await f.request(undefined, { query }), 400);
  await error(await f.request(undefined, { model: encodeURIComponent("google/" + models[0]) }), 400);
  for (const body of [{ ...wire.request.body, stream: true }, { ...wire.request.body, continuationToken: "synthetic-unowned" },
    { ...wire.request.body, contents: [{ role: "user", parts: [{ fileData: { fileUri: "https://assets.example/private" } }] }] }])
    await error(await f.request(body), 400);
  assert.equal(f.sent.length, 0); assert.equal(f.rows().length, 0); assert.equal(bodyBudgetCharged(), 0);
});

test("Google music selected-model policy is checked again on a fresh native request", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  const first = await f.request(); assert.equal(first.status, 200); await first.text(); await settled(f);
  f.policy.models = [`google/${models[1]}`];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const next = await f.request(); await error(next, 403); assert.equal(f.sent.length, 1);
});

for (const failure of ["redirect", "rejected", "missing-mime", "invalid-sibling", "text-only", "length", "overflow", "interrupt", "deadline"]) {
  test(`Google music ${failure} cannot expose partial output or release dispatched uncertainty`, { timeout: 10_000 }, async t => {
    let canceled = false;
    const f = await setup(t, { pooled: true, timeout: 50, response: () => {
      if (failure === "redirect") return new Response(null, { status: 307, headers: { location: "https://unqualified.example" } });
      if (failure === "rejected") return Response.json({ error: { message: "synthetic private rejection" } }, { status: 429 });
      const body = payload(), headers = { "content-type": "application/json" };
      if (failure === "missing-mime") delete body.candidates[0].content.parts[1].inlineData.mimeType;
      if (failure === "text-only") body.candidates[0].content.parts.splice(1, 1);
      if (failure === "invalid-sibling") body.candidates.push({ finishReason: "MAX_TOKENS", content: { parts: [] } });
      const data = bytes(body);
      if (failure === "length") headers["content-length"] = String(data.length + 1);
      if (failure === "overflow") headers["content-length"] = String(8 * 1024 * 1024 + 1);
      if (["interrupt", "deadline"].includes(failure)) return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(data.subarray(0, 20)); if (failure === "interrupt") controller.error(new Error("synthetic read loss"));
      }, cancel() { canceled = true; } }), { headers });
      return new Response(data, { headers });
    } });
    assert.equal((await error(await f.request(), 502)).code, "provider_unavailable");
    const event = await settled(f); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(f.sent.length, 1);
    if (failure === "deadline") { assert.equal(canceled, true); assert.equal(event.status, "timeout"); }
  });
}

test("Google music delivery waits for complete EOF and holds capacity through caller consumption", { timeout: 10_000 }, async t => {
  const reached = Promise.withResolvers(); let stream, published = false;
  const f = await setup(t, { response: () => new Response(new ReadableStream({ start(controller) {
    stream = controller; controller.enqueue(bytes(payload())); reached.resolve();
  } }), { headers: { "content-type": "application/json" } }) });
  const pending = f.request().then(response => { published = true; return response; });
  await reached.promise; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(published, false); assert.ok(bodyBudgetCharged() >= 64 * 1024 * 1024); assert.deepEqual(await f.events(), []);
  stream.close(); const response = await pending; assert.equal(response.status, 200);
  await response.body.cancel("synthetic caller delivery cancellation"); await settled(f); assert.equal(f.sent.length, 1);
});

test("Google music caller abort cancels the original upstream reader and settles once", { timeout: 10_000 }, async t => {
  const abort = new AbortController(), reached = Promise.withResolvers(); let canceled = false;
  const f = await setup(t, { response: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes(payload()).subarray(0, 20)); reached.resolve();
  }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } }) });
  const pending = f.request(undefined, { signal: abort.signal }); await reached.promise; abort.abort();
  await error(await pending, 502); await settled(f); assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});

test("Google music capacity denial is known-unsent and returns the fixed reservation", { timeout: 10_000 }, async t => {
  const other = new BodyLease(); assert.equal(other.grow(20 * 1024 * 1024), true); const f = await setup(t);
  try { assert.equal((await error(await f.request(), 503)).code, "server_overloaded"); } finally { other.release(); }
  await settled(f, 0); assert.equal(f.sent.length, 0);
});

test("Google music missing dispatch acknowledgment never sends the paid request", { timeout: 10_000 }, async t => {
  const f = await setup(t), ledger = f.env.BUDGET_LEDGER; let fallback = 0;
  f.env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ async fetch(url, init) {
    if (new URL(url).pathname === "/dispatch") { fallback++; return Response.json({ error: "synthetic lost ACK" }, { status: 503 }); }
    const response = await ledger.get(name).fetch(url, init);
    if (new URL(url).pathname !== "/reserve") return response;
    const receipt = await response.json(); delete receipt.dispatched; return Response.json(receipt, { status: response.status });
  } }) };
  assert.equal((await error(await f.request(), 503)).code, "accounting_unavailable");
  await settled(f, 0); assert.equal(f.sent.length, 0); assert.equal(fallback, 2);
});

function wav() {
  const data = Buffer.alloc(1808); data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(44100, 24);
  data.writeUInt32LE(176400, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(data.length - 44, 40); return data;
}

test("Lyria Pro's qualified WAV is delivered unchanged while Clip's unsupported WAV retains uncertain cost", { timeout: 10_000 }, async t => {
  const data = wav(), output = payload(); output.candidates[0].content.parts[1].inlineData = { mimeType: "audio/wav", data: data.toString("base64") };
  const f = await setup(t, { response: () => Response.json(output) });
  const pro = await f.request(undefined, { model: models[1] }); assert.equal(pro.status, 200);
  assert.deepEqual(Buffer.from((await pro.json()).candidates[0].content.parts[0].inlineData.data, "base64"), data);
  await settled(f);
  await error(await f.request(undefined, { model: models[0] }), 502); await f.drain();
  const events = await f.events(); assert.equal(events.length, 2); assert.equal(f.sent.length, 2);
  assert.ok(events.every(event => event.cost_basis === "policy_fixed" && event.actual_cost_micros === 700 && event.total_tokens === null));
  assert.ok(f.rows().every(row => row.settled === 1)); assert.equal(bodyBudgetCharged(), 0);
});

test("Lyria qualified inline image input keeps the original native prompt, lyrics and bytes", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }), body = structuredClone(wire.request.body);
  body.contents[0].parts.push({ inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=" } });
  const response = await f.request(body); assert.equal(response.status, 200); await response.json(); await settled(f);
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].clone().json(), body);
});
