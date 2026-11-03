import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/gradium/speech.json", import.meta.url)));
const source = parse(readFileSync(new URL("../../providers/gradium.provider.yaml", import.meta.url), "utf8"));
const audio = {
  wav: Uint8Array.from(Buffer.from(wire.response.base64, "base64")),
  opus: new TextEncoder().encode("OggS\0synthetic OpusHead transport fixture"),
};
const mime = { wav: "audio/wav", opus: "audio/ogg" }, path = "/v1/native/gradium" + wire.request.path;
const capacity = 32 * 1024 * 1024;

async function setup(t, options = {}) {
  // Reuse the actual authority, grant, SQLite reservation and usage fixtures.
  // Replace any bundled declaration with this exact source-owned declaration.
  const original = snapshot.providers;
  snapshot.providers = original.filter(provider => provider.id !== "gradium");
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId: "gradium", configure(provider) {
    Object.assign(provider, compileProviderSnapshot([structuredClone(source)]).providers[0]);
    provider.endpoints[0].timeout_ms = options.timeout ?? 1000;
    if (options.origin) provider.base_urls.default = options.origin;
  } });
  f.env.GRADIUM_API_KEY = "synthetic-gradium-environment-key";
  f.request = (body = wire.request.body, { manifest = false, query = "", ...extra } = {}) => f.call(
    (manifest ? "/v1/proxy/gradium/speech" : path) + query, manifest ? { body } : body,
    { ...extra, headers: { "x-api-key": "synthetic-caller-upstream-key", ...extra.headers } });
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = async request => {
    // Capture pre-egress facts here; assert outside fetch so a test assertion
    // cannot be hidden behind the runtime's sanitized transport error response.
    f.dispatched = { capacity: bodyBudgetCharged(), paths: f.budgetCalls.map(call => call.path), rows: f.rows() };
    if (options.response) return options.response(request);
    const body = await request.clone().json();
    return new Response(audio[body.output_format], { headers: { "content-type": mime[body.output_format], "x-private-upstream": "synthetic" } });
  };
  t.after(f.drain); return f;
}

async function error(response, status) {
  const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text).error;
}
async function settled(f, cost = 700) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, cost);
  assert.equal(events[0].input_tokens, null); assert.equal(events[0].output_tokens, null);
  assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === cost));
  assert.equal(bodyBudgetCharged(), 0); return events[0];
}

for (const format of ["wav", "opus"]) for (const manifest of [false, true]) for (const pooled of [false, true]) {
  test(`Gradium ${format} ${manifest ? "manifest" : "native"} ${pooled ? "pooled" : "environment"} keeps native input, original credentials and one fixed settlement`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled }), body = { ...wire.request.body, output_format: format, model_name: "default" };
    const response = await f.request(body, { manifest });
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    assert.equal(bodyBudgetCharged(), capacity);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio[format]);
    assert.equal(response.headers.get("content-type"), mime[format]); assert.equal(response.headers.get("x-private-upstream"), null);
    assert.equal(f.sent.length, 1); const request = f.sent[0];
    assert.equal(request.url, "https://api.gradium.ai" + wire.request.path); assert.equal(request.method, "POST");
    assert.equal(request.redirect, "manual"); assert.deepEqual(await request.clone().json(), body);
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("x-api-key"), pooled ? "synthetic-original-key" : "synthetic-gradium-environment-key");
    assert.equal(f.dispatched.capacity, capacity, "binary capacity precedes fetch");
    assert.ok(f.dispatched.paths.includes("/dispatch"), "dispatch acknowledgment precedes fetch");
    assert.ok(f.dispatched.rows.length > 0 && f.dispatched.rows.every(row => row.reserved_micros === 700));
    const event = await settled(f); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.model, null);
    assert.equal(event.provider, "gradium"); assert.equal(event.capability, "audio.speech");
    assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
    assert.doesNotMatch(JSON.stringify(event), /synthetic-original-key|synthetic-gradium-environment-key|synthetic-caller-upstream-key|café/);
  });
}

test("Gradium invalid native modes, JSON model selectors and query credentials are zero-egress", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  for (const patch of [{ output_format: "ulaw_8000" }, { only_audio: false }, { stream: true }, { model: "default" }, { text: " " }, { json_config: "[]" }]) {
    await error(await f.request({ ...wire.request.body, ...patch }), 400);
  }
  await error(await f.request(undefined, { query: "?key=synthetic" }), 400);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.equal(bodyBudgetCharged(), 0);
});

for (const scenario of ["unpriced", "unauthenticated", "missing-credential", "foreign-origin"]) {
  test(`Gradium ${scenario} denies before any paid dispatch`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { fixed: scenario === "unpriced" ? null : 700, ...(scenario === "foreign-origin" ? { origin: "https://unqualified.example" } : {}) });
    if (scenario === "missing-credential") delete f.env.GRADIUM_API_KEY;
    const response = await f.request(undefined, scenario === "unauthenticated" ? { headers: { authorization: "Bearer synthetic-invalid" } } : {});
    const text = await response.text(); assert.ok(response.status >= 400 && response.status < 600, text);
    if (scenario === "unpriced") assert.equal(JSON.parse(text).error.code, "pricing_required");
    assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
    await f.drain(); assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
  });
}

for (const failure of ["redirect", "rejected", "mime", "range", "length", "overflow", "interrupt", "deadline"]) {
  test(`Gradium ${failure} response preserves uncertainty without paid replay or partial audio`, { timeout: 10_000 }, async t => {
    let canceled = false;
    const f = await setup(t, { pooled: true, timeout: 50, response: () => {
      if (failure === "redirect") return new Response(null, { status: 307, headers: { location: "https://unqualified.example" } });
      if (failure === "rejected") return Response.json(wire.rejection.body, { status: 429 });
      if (failure === "mime") return new Response(audio.wav, { headers: { "content-type": "audio/ogg" } });
      const headers = { "content-type": "audio/wav" };
      if (failure === "range") headers["content-range"] = "bytes 0-7/100";
      if (failure === "length") headers["content-length"] = String(audio.wav.byteLength + 1);
      if (failure === "overflow") headers["content-length"] = String(16 * 1024 * 1024 + 1);
      if (["interrupt", "deadline"].includes(failure)) return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(audio.wav.subarray(0, 8)); if (failure === "interrupt") controller.error(new Error("synthetic transport loss"));
      }, cancel() { canceled = true; } }), { headers });
      return new Response(audio.wav, { headers });
    } });
    await error(await f.request(), 502); const event = await settled(f);
    assert.equal(f.sent.length, 1); assert.equal(event.cost_basis, "policy_fixed");
    if (failure === "deadline") { assert.equal(canceled, true); assert.equal(event.status, "timeout"); }
  });
}

test("Gradium waits for bounded binary EOF before publication and holds capacity through delivery", { timeout: 10_000 }, async t => {
  const reached = Promise.withResolvers(); let stream;
  const f = await setup(t, { response: () => new Response(new ReadableStream({ start(controller) {
    stream = controller; controller.enqueue(audio.wav); reached.resolve();
  } }), { headers: { "content-type": "audio/wav" } }) });
  let delivered = false; const pending = f.request().then(response => { delivered = true; return response; });
  await reached.promise; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(delivered, false); assert.equal(bodyBudgetCharged(), capacity); assert.deepEqual(await f.events(), []);
  stream.close(); const response = await pending; assert.equal(response.status, 200);
  assert.equal(bodyBudgetCharged(), capacity); await response.body.cancel("synthetic delivery cancellation");
  await settled(f); assert.equal(f.sent.length, 1);
});

test("Gradium caller cancellation stops the original reader and conservatively settles once", { timeout: 10_000 }, async t => {
  const reached = Promise.withResolvers(), abort = new AbortController(); let canceled = false;
  const f = await setup(t, { response: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(audio.wav.subarray(0, 8)); reached.resolve();
  }, cancel() { canceled = true; } }), { headers: { "content-type": "audio/wav" } }) });
  const pending = f.request(undefined, { signal: abort.signal }); await reached.promise; abort.abort();
  await error(await pending, 502); const event = await settled(f);
  assert.equal(event.status, "client_error"); assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});

test("Gradium shared capacity denial is known-unsent and releases the fixed reservation", { timeout: 10_000 }, async t => {
  const other = new BodyLease(); assert.equal(other.grow(40 * 1024 * 1024), true);
  const f = await setup(t);
  try { assert.equal((await error(await f.request(), 503)).code, "server_overloaded"); }
  finally { other.release(); }
  await settled(f, 0); assert.equal(f.sent.length, 0);
});

test("Gradium dispatch-ack loss cannot turn a reservation into an upstream attempt", { timeout: 10_000 }, async t => {
  const f = await setup(t), ledger = f.env.BUDGET_LEDGER;
  f.env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ fetch(url, init) {
    return new URL(url).pathname === "/dispatch" ? Response.json({ error: "synthetic lost dispatch ACK" }, { status: 503 }) : ledger.get(name).fetch(url, init);
  } }) };
  assert.equal((await error(await f.request(), 503)).code, "accounting_unavailable");
  await settled(f, 0); assert.equal(f.sent.length, 0);
});
