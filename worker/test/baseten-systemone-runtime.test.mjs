import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { BASETEN_SYSTEMONE_MODELS: models } = await import("../provider-baseten-systemone.ts");
const { systemOneDecision } = await import("./native-decision-catalog-fixture.ts");
const { basetenSystemOneRequest: input, basetenSystemOneResponse: output } = await import("./baseten-systemone-fixtures.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const source = parse(readFileSync(new URL("../../providers/baseten.provider.yaml", import.meta.url), "utf8"));
const capacity = 8 * 1024 * 1024, path = "/v1/native/baseten/systemone";

async function setup(t, options = {}) {
  const original = snapshot.providers;
  snapshot.providers = original.filter(provider => provider.id !== "baseten");
  t.after(() => { snapshot.providers = original; });
  const manifest = structuredClone(source);
  manifest.capabilities.push({ id: "llm.decisions", endpoint: "systemone", methods: ["POST"] });
  manifest.endpoints.systemone = { path: "/systemone", requestFormat: "baseten.systemone", responseFormat: "baseten.systemone" };
  manifest.models.entries.push(...models.map(upstream => ({ id: `baseten/${upstream}`, upstream, capabilities: ["llm.decisions"], nativeCapabilities: {
    version: "clawrouter.native-capabilities.v1", endpoints: { systemone: { sources: ["https://docs.baseten.co/reference/inference-api/system-one"],
      checkedAt: "2026-11-03", input: ["text", "json"], inference: { chat: false, decision: structuredClone(systemOneDecision) } } },
  } })));
  const f = await fixture(t, { ...options, providerId: "baseten", configure(provider) {
    Object.assign(provider, compileProviderSnapshot([manifest]).providers[0]);
    provider.endpoints.find(endpoint => endpoint.id === "systemone").timeout_ms = options.timeout ?? 1000;
    if (options.origin) provider.base_urls.default = options.origin;
  } });
  f.env.BASETEN_API_KEY = "synthetic-baseten-environment";
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = request => {
    f.preDispatch = { capacity: bodyBudgetCharged(), rows: f.rows() };
    return options.response ? options.response(request) : Response.json(output);
  };
  f.request = (body = input, { manifest = false, query = "", ...extra } = {}) => f.call(
    (manifest ? "/v1/proxy/baseten/systemone" : path) + query, manifest ? { body } : body,
    { ...extra, headers: { "x-api-key": "synthetic-caller-key", ...extra.headers } });
  t.after(f.drain); return f;
}
async function failure(response, status = 502) {
  const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body));
  assert.doesNotMatch(JSON.stringify(body), /synthetic-original-key|synthetic-baseten-environment|synthetic-caller-key|synthetic private/);
  return body.error;
}
async function settled(f, cost = 700) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, cost); assert.equal(events[0].cost_basis, "policy_fixed");
  assert.equal(f.rows().length, 2); assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === cost));
  assert.equal(bodyBudgetCharged(), 0); return events[0];
}
for (const model of models) for (const manifest of [false, true]) for (const pooled of [false, true]) {
  test(`SystemOne ${model} ${manifest ? "manifest" : "native"} ${pooled ? "pooled" : "environment"} preserves answers, selected identity and observed usage`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled }), body = { ...structuredClone(input), model: manifest ? `baseten/${model}` : model };
    const response = await f.request(body, { manifest });
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    assert.deepEqual(await response.json(), output); assert.equal(f.sent.length, 1);
    const request = f.sent[0]; assert.equal(request.url, "https://inference.baseten.co/v1/systemone");
    assert.equal(request.method, "POST"); assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-baseten-environment");
    assert.equal(request.headers.get("x-api-key"), null);
    assert.deepEqual(await request.clone().json(), { ...body, model });
    assert.equal(f.preDispatch.capacity, capacity); assert.equal(f.preDispatch.rows.length, 2);
    assert.ok(f.preDispatch.rows.every(row => row.dispatch_started === 1 && row.settled === 0 && row.reserved_micros === 700));
    const event = await settled(f); assert.equal(event.model, `baseten/${model}`); assert.equal(event.provider, "baseten");
    assert.equal(event.capability, "llm.decisions"); assert.equal(event.status, "success");
    assert.equal(event.input_tokens, 42); assert.equal(event.output_tokens, 3);
  });
}

test("SystemOne malformed native input, OpenAI aliases, streaming and query secrets are zero-egress", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  for (const patch of [{ questions: {} }, { state: {} }, { stream: true }, { model: "baseten/alias" }, { tools: [] }, { service_tier: "priority" }]) {
    await failure(await f.request({ ...input, ...patch }), 400);
  }
  await failure(await f.request(input, { query: "?key=synthetic" }), 400);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.equal(bodyBudgetCharged(), 0);
});
for (const scenario of ["unpriced", "missing-credential", "foreign-origin"]) test(`SystemOne ${scenario} denies before paid dispatch`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: scenario === "unpriced" ? null : 700, ...(scenario === "foreign-origin" ? { origin: "https://unqualified.example/v1" } : {}) });
  if (scenario === "missing-credential") delete f.env.BASETEN_API_KEY;
  const response = await f.request(), body = await response.json(); assert.ok(response.status >= 400, JSON.stringify(body));
  if (scenario === "unpriced") assert.equal(body.error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
});
for (const scenario of ["redirect", "rejected", "mime", "range", "length", "overflow", "missing-usage", "wrong-question-count", "partial-answers", "interrupt", "deadline"]) {
  test(`SystemOne ${scenario} withholds native output and retains one conservative charge`, { timeout: 10_000 }, async t => {
    let canceled = false;
    const f = await setup(t, { pooled: true, timeout: 50, response: () => {
      if (scenario === "redirect") return new Response(null, { status: 307, headers: { location: "https://unqualified.example" } });
      if (scenario === "rejected") return Response.json({ error: "synthetic private rejection" }, { status: 422 });
      const body = structuredClone(output), headers = { "content-type": "application/json" };
      if (scenario === "missing-usage") delete body.usage;
      if (scenario === "wrong-question-count") body.usage.output_tokens = 2;
      if (scenario === "partial-answers") delete body.answers.urgency;
      if (scenario === "mime") headers["content-type"] = "text/html";
      if (scenario === "range") headers["content-range"] = "bytes 0-10/100";
      if (scenario === "length") headers["content-length"] = "1";
      if (scenario === "overflow") headers["content-length"] = String(1024 * 1024 + 1);
      if (["interrupt", "deadline"].includes(scenario)) return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":')); if (scenario === "interrupt") controller.error(new Error("synthetic private interruption"));
      }, cancel() { canceled = true; } }), { headers });
      return new Response(JSON.stringify(body), { headers });
    } });
    assert.equal((await failure(await f.request())).code, "provider_unavailable");
    const event = await settled(f); assert.equal(f.sent.length, 1);
    assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null);
    if (scenario === "deadline") { assert.equal(event.status, "timeout"); assert.equal(canceled, true); }
  });
}

test("SystemOne complete JSON is withheld until EOF and caller cancellation never publishes provisional answers", { timeout: 10_000 }, async t => {
  const reached = Promise.withResolvers(), abort = new AbortController(); let canceled = false, delivered = false;
  const f = await setup(t, { response: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(output))); reached.resolve();
  }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } }) });
  const pending = f.request(input, { signal: abort.signal }).then(response => { delivered = true; return response; });
  await reached.promise; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(delivered, false); assert.equal(bodyBudgetCharged(), capacity); assert.deepEqual(await f.events(), []);
  abort.abort(); await failure(await pending); const event = await settled(f);
  assert.equal(canceled, true); assert.equal(event.status, "client_error"); assert.equal(f.sent.length, 1);
});

test("SystemOne capacity denial is known-unsent and releases both fixed reservation legs", { timeout: 10_000 }, async t => {
  const other = new BodyLease(); assert.equal(other.grow(46 * 1024 * 1024), true); const f = await setup(t);
  try { assert.equal((await failure(await f.request(), 503)).code, "server_overloaded"); }
  finally { other.release(); }
  await settled(f, 0); assert.equal(f.sent.length, 0);
});
