import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";

const { default: handler } = await import("../index.ts");
const { providerById } = await import("../providers.ts");
const { grantSupports } = await import("../provider-auth.ts");
const { operationAffordability } = await import("../operation-budget.ts");

const owners = ["tenant:maintainer_access:owner@example.com", "provider:openai"];
const audio = new Uint8Array([0, 255, 128, 1, 2, 3]);
const input = "Aé😀e\u0301"; // 10 UTF-8 bytes, 5 code points.
const routes = ["/v1/audio/speech", "/v1/native/openai/v1/audio/speech", "/v1/proxy/openai/speech"];

function fixture(t, options = {}) {
  const env = usageEnv([], { limit: 1_000_000, fixedCost: null, ...options });
  const events = [], pending = [], retained = [], ledger = sqlBudgetNamespace(t);
  env.BUDGET_LEDGER = ledger;
  env.OPENAI_API_KEY = "fixture-upstream-key";
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  env.CONTENT_ARCHIVE = { put: async (_key, value, metadata) => retained.push({ record: JSON.parse(value), metadata }) };
  const call = (path = routes[0], body = { input }, signal) => handler.fetch(new Request(`https://router.example${path}`, {
    method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, signal,
    body: JSON.stringify(path === routes[2] ? { body: { model: "openai/tts-1", voice: "alloy", ...body } } : { model: path === routes[1] ? "tts-1" : "openai/tts-1", voice: "alloy", ...body }),
  }), env, { waitUntil: promise => pending.push(promise) });
  return { env, events, pending, retained, ledger, call };
}

for (const route of routes) test(`speech route ${route} streams unchanged audio and settles both SQL ledgers after EOF`, async t => {
  const f = fixture(t);
  const upstream = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://api.openai.com/v1/audio/speech");
    assert.equal(options.headers.get("authorization"), "Bearer fixture-upstream-key");
    assert.deepEqual(JSON.parse(options.body), { model: "tts-1", voice: "alloy", input, response_format: "pcm", speed: 1.25, stream_format: "audio" });
    return new Response(audio, { headers: { "content-type": "application/octet-stream" } });
  });
  const response = await f.call(route, { input, response_format: "pcm", speed: 1.25, stream_format: "audio" });
  assert.equal(response.status, 200);
  assert.equal(f.events.length, 0, "returning headers is not completed delivery");
  for (const name of owners) {
    const [row] = f.ledger.get(name).reservations();
    assert.equal(row.reserved_micros, 150); assert.equal(row.settled, 0); assert.equal(row.dispatch_started, 1);
  }
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio);
  await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(f.events.length, 1);
  const event = f.events[0];
  assert.equal(event.actual_cost_micros, 75); assert.equal(event.reserved_cost_micros, 150);
  assert.equal(event.cost_basis, "request_character_estimate"); assert.equal(event.status, "success");
  for (const field of ["input_tokens", "output_tokens", "total_tokens", "reserved_input_tokens", "reserved_output_tokens"]) assert.equal(event[field], null);
  for (const name of owners) { const rows = f.ledger.get(name).reservations(); assert.equal(rows.length, 1); assert.equal(rows[0].reserved_micros, 75); assert.equal(rows[0].settled, 1); }
  assert.equal(response.headers.get("x-clawrouter-content-retention"), "on; retention-days=30");
  assert.equal(f.retained.length, 1);
  assert.deepEqual(f.retained[0].record.body, JSON.parse(upstream.mock.calls[0].arguments[1].body));
  assert.equal(f.retained[0].metadata.httpMetadata.contentType, "application/json");
  assert.equal(event.content_retained, true, "only request text was archived before audio arrived");
});

for (const route of routes) test(`speech ${route} validates its bounded input before any reservation or dispatch`, async t => {
  const f = fixture(t, { fixedCost: 0 });
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("invalid input reached upstream"); });
  for (const body of [{}, { input: "" }, { input: null }, { input: 42 }, { input: "😀".repeat(4097) }, { input, stream_format: "sse" }, ...["fixture", "", null].map(instructions => ({ input, instructions }))]) {
    const response = await f.call(route, body);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.code, /invalid_speech_input|unsupported_speech_stream|unsupported_speech_instructions/);
  }
  assert.equal(upstream.mock.callCount(), 0); assert.equal(f.retained.length, 0);
  for (const name of owners) assert.equal(f.ledger.get(name).reservations().length, 0);
});

for (const scenario of ["empty", "no-body", "wrong-mime", "malformed-mime", "json-usage", "sse-usage", "cancel", "read-error", "fetch-error", "rejection", "retention-error", "retention-off", "fixed-zero", "maximum"]) {
  test(`speech lifecycle ${scenario} preserves delivered evidence and both budgets`, async t => {
    const f = fixture(t, { retainContent: scenario !== "retention-off", fixedCost: scenario === "fixed-zero" ? 0 : null });
    let canceled = 0;
    if (scenario === "retention-error") f.env.CONTENT_ARCHIVE.put = async () => { throw new Error("fixture archive unavailable"); };
    const upstream = t.mock.method(globalThis, "fetch", async () => {
      if (scenario === "fetch-error") throw new Error("fixture upstream unavailable");
      if (scenario === "no-body") return new Response(null, { headers: { "content-type": "audio/mpeg" } });
      if (scenario === "rejection") return Response.json({ error: "fixture" }, { status: 400 });
      if (scenario === "json-usage") return Response.json({ usage: { input_tokens: 0, output_tokens: 0 } });
      if (scenario === "sse-usage") return new Response('data: {"usage":{"input_tokens":0,"output_tokens":0}}\n\n', { headers: { "content-type": "text/event-stream" } });
      let pulls = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (scenario === "empty") controller.close();
          else if (pulls++ === 0) controller.enqueue(audio);
          else if (scenario === "read-error") controller.error(new Error("fixture audio failure"));
          else if (scenario !== "cancel") controller.close();
        }, cancel() { canceled++; },
      }, { highWaterMark: 0 }), { headers: { "content-type": scenario === "wrong-mime" ? "text/plain" : scenario === "malformed-mime" ? "audio/mpeg, text/plain" : "AuDiO/MPEG; charset=binary" } });
    });
    const response = await f.call(routes[0], { input: scenario === "maximum" ? "😀".repeat(4096) : input });
    if (scenario === "cancel") { const reader = response.body.getReader(); await reader.read(); await reader.cancel("fixture caller stopped"); }
    else if (scenario === "read-error") await assert.rejects(response.arrayBuffer(), /fixture audio failure/);
    else await response.arrayBuffer();
    await Promise.all(f.pending);
    assert.equal(f.events.length, 1);
    const event = f.events[0];
    const complete = ["retention-off", "fixed-zero", "maximum"].includes(scenario);
    const free = ["rejection", "retention-error"].includes(scenario);
    const actual = free || scenario === "fixed-zero" ? 0 : scenario === "maximum" ? 61440 : complete ? 75 : 150;
    assert.equal(event.actual_cost_micros, actual);
    assert.equal(event.cost_basis, free ? "none" : scenario === "fixed-zero" ? "policy_fixed" : complete ? "request_character_estimate" : "manifest_reservation");
    assert.equal(event.total_tokens, null);
    assert.equal(event.status, scenario === "cancel" || scenario === "rejection" ? "client_error" : complete ? "success" : "provider_error");
    assert.equal(event.reserved_cost_micros, scenario === "fixed-zero" ? 0 : scenario === "maximum" ? 245760 : 150);
    for (const name of owners) { const [row] = f.ledger.get(name).reservations(); assert.equal(row.reserved_micros, actual); assert.equal(row.settled, 1); }
    assert.equal(upstream.mock.callCount(), scenario === "retention-error" ? 0 : 1);
    if (scenario === "cancel") assert.equal(canceled, 1);
    if (scenario === "retention-off") { assert.equal(f.retained.length, 0); assert.equal(response.headers.get("x-clawrouter-content-retention"), "off"); }
  });
}

test("speech catalog affordability remains request-dependent and subscriptions remain Responses-only", () => {
  const provider = providerById("openai"), model = provider.models.find(model => model.id === "openai/tts-1"), endpoint = provider.endpoints.find(endpoint => endpoint.id === "speech");
  assert.ok(model); assert.ok(endpoint);
  assert.equal(grantSupports({ provider, endpoint, mode: "http" }, { kind: "subscription" }), false);
  assert.equal(grantSupports({ provider, endpoint, mode: "http" }, { kind: "api_key" }), true);
  assert.equal(grantSupports({ provider, endpoint, mode: "websocket" }, { kind: "api_key" }), false);
  const auth = { policy: { monthlyBudgetMicros: 100, requestCostMicros: null } }, connection = { monthlyBudgetMicros: 100 };
  assert.deepEqual(operationAffordability(auth, connection, model, "audio.speech", endpoint, { policyRemaining: 100, providerRemaining: 100 }), { status: "request-dependent" });
  assert.deepEqual(operationAffordability(auth, connection, model, "audio.speech", endpoint, { policyRemaining: 14, providerRemaining: 100 }), { status: "exact-blocked", reasonCode: "budget_exhausted" });
});

for (const limited of ["policy", "provider"]) test(`speech ${limited} budget admits the byte envelope, never the cheaper completion estimate`, async t => {
  const f = fixture(t, { limit: limited === "policy" ? 100 : 1_000_000, providerLimit: limited === "provider" ? 100 : 1_000_000 });
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("under-reserved speech reached upstream"); });
  const response = await f.call();
  assert.equal(response.status, 402);
  assert.equal((await response.json()).error.code, limited === "policy" ? "budget_exhausted" : "provider_budget_exhausted");
  await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 0); assert.equal(f.retained.length, 0);
  for (const name of owners) assert.ok(f.ledger.get(name).reservations().every(row => row.reserved_micros === 0 && row.settled === 1));
});

test("speech caller abort owns a pending read even when the upstream later closes", async t => {
  const f = fixture(t), caller = new AbortController();
  let release, cancels = 0;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    let first = true;
    return new Response(new ReadableStream({
      async pull(controller) {
        if (first) { first = false; controller.enqueue(audio); return; }
        await gate;
        try { controller.close(); } catch { /* A canceled reader has already closed. */ }
      }, cancel() { cancels++; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "audio/mpeg" } });
  });
  const response = await f.call(routes[0], { input }, caller.signal), reader = response.body.getReader();
  await reader.read();
  const pending = reader.read();
  caller.abort(new Error("fixture caller canceled"));
  await assert.rejects(pending, /fixture caller canceled/);
  release();
  await Promise.all(f.pending);
  assert.equal(cancels, 1); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].actual_cost_micros, 150); assert.equal(f.events[0].cost_basis, "manifest_reservation");
  assert.equal(f.events[0].status, "client_error");
  for (const name of owners) { const [row] = f.ledger.get(name).reservations(); assert.equal(row.reserved_micros, 150); assert.equal(row.settled, 1); }
});
