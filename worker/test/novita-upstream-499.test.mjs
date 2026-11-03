import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { createProxyAccounting } = await import("../proxy-accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const rejected = { error: { type: "request_cancelled", message: "Synthetic upstream disconnection" }, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };

async function setup(t, options = {}) {
  const providerId = options.providerId ?? "novita", original = snapshot.providers;
  const source = structuredClone(original.find(provider => provider.id === providerId)); assert.ok(source);
  snapshot.providers = original.filter(provider => provider.id !== providerId); t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId, configure(provider) { Object.assign(provider, source); } });
  f.model = f.provider.models.find(model => model.capabilities.includes("llm.chat")); assert.ok(f.model);
  f.endpoint = f.provider.endpoints.find(endpoint => endpoint.id === "chat_completions"); assert.ok(f.endpoint);
  f.env[source.config_keys[0]] = "synthetic-selected-environment";
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = request => { f.dispatch = f.rows(); return options.response ? options.response(request) : Response.json(rejected, { status: options.status ?? 499 }); };
  f.request = ({ route = "native", stream = false, ...extra } = {}) => {
    const body = { model: route === "unified" ? f.model.id : f.model.upstream, messages: [{ role: "user", content: "Synthetic billing fixture" }], max_tokens: 16, stream };
    return f.call(route === "unified" ? "/v1/chat/completions" : route === "manifest" ? `/v1/proxy/${providerId}/chat_completions` : `/v1/native/${providerId}/chat/completions`,
      route === "manifest" ? { body } : body, extra);
  };
  t.after(f.drain); return f;
}
async function event(f) { await f.drain(); const rows = await f.events(); assert.equal(rows.length, 1); return rows[0]; }

for (const route of ["native", "manifest", "unified"]) for (const pooled of [false, true]) for (const stream of [false, true]) {
  test(`Novita upstream499 ${route}/${pooled ? "grant" : "environment"}/${stream ? "SSE request" : "JSON request"} retains one dispatched policy charge`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled }), response = await f.request({ route, stream });
    assert.equal(response.status, 499); await response.text();
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, "https://api.novita.ai/openai/v1/chat/completions");
    assert.equal(f.sent[0].headers.get("authorization"), `Bearer ${pooled ? "synthetic-original-key" : "synthetic-selected-environment"}`);
    assert.equal(f.sent[0].redirect, "manual"); assert.ok(f.dispatch.every(row => row.dispatch_started === 1 && row.settled === 0));
    const settled = await event(f); assert.equal(settled.status_code, 499); assert.equal(settled.actual_cost_micros, 700); assert.equal(settled.cost_basis, "policy_fixed");
    assert.equal(settled.input_tokens, null); assert.equal(settled.output_tokens, null); assert.equal(settled.total_tokens, null);
    assert.ok(f.rows().every(row => row.settled === 1));
    assert.doesNotMatch(JSON.stringify(settled), /synthetic-original-key|synthetic-selected-environment/);
  });
}

for (const status of [400, 401, 403, 429, 500, 503, 504]) test(`Novita upstream${status} retains the existing nonbillable rejection behavior`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { status }), response = await f.request(); assert.equal(response.status, status); await response.text();
  const settled = await event(f); assert.equal(settled.actual_cost_micros, 0); assert.equal(settled.cost_basis, "none"); assert.equal(f.sent.length, 1);
});

test("another provider's HTTP499 does not acquire Novita billing semantics", { timeout: 10_000 }, async t => {
  const f = await setup(t, { providerId: "openai" }), response = await f.request(); assert.equal(response.status, 499); await response.text();
  const settled = await event(f); assert.equal(settled.actual_cost_micros, 0); assert.equal(settled.cost_basis, "none"); assert.equal(f.sent.length, 1);
});

test("unknown Novita inference price stays denied before egress under a hard budget", { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: null }), response = await f.request();
  assert.equal(response.status, 402); assert.equal((await response.json()).error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(f.rows().length, 0); await f.drain(); assert.ok((await f.events()).every(row => row.actual_cost_micros === 0));
});

test("a local already-aborted request is known-unsent and is not an upstream499 receipt", { timeout: 10_000 }, async t => {
  const f = await setup(t), abort = new AbortController(); abort.abort();
  const response = await f.request({ signal: abort.signal }); await response.text().catch(() => undefined);
  assert.equal(f.sent.length, 0); await f.drain(); assert.ok((await f.events()).every(row => row.actual_cost_micros === 0));
});

for (const loss of ["body-error", "caller-abort"]) test(`Novita499 ${loss} cannot erase the original upstream billing evidence`, { timeout: 10_000 }, async t => {
  const reached = Promise.withResolvers(), abort = new AbortController(); let canceled = false;
  const f = await setup(t, { pooled: true, response: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"error":')); reached.resolve();
    if (loss === "body-error") controller.error(new Error("Synthetic body loss"));
  }, cancel() { canceled = true; } }), { status: 499, headers: { "content-type": "application/json" } }) });
  const pending = f.request({ stream: true, signal: abort.signal }); await reached.promise;
  if (loss === "caller-abort") { await new Promise(resolve => setTimeout(resolve, 0)); abort.abort(); }
  const response = await pending; await response.text().catch(() => undefined);
  const settled = await event(f); assert.equal(settled.actual_cost_micros, 700); assert.equal(settled.cost_basis, "policy_fixed");
  assert.equal(settled.total_tokens, null); assert.equal(f.sent.length, 1); assert.ok(f.rows().every(row => row.settled === 1));
  if (loss === "caller-abort") assert.equal(canceled, true);
});

test("the original route-bound499 preserves uncertain reserved cost without inventing a tariff or token receipt", { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: null });
  const selection = { provider: f.provider, endpoint: f.endpoint, model: f.model, body: {}, pathParams: {}, method: "POST", capability: "llm.chat" };
  const accounting = createProxyAccounting({ env: f.env, context: { waitUntil() {} }, request: correlateIngressRequest(new Request("https://router.example")).request,
    auth: { credentialId: "fixture", principalId: null, policyId: "fixture", policy: f.policy, authType: "proxy_key" }, selection,
    // Exercise an existing conservative reservation, not a fabricated Novita rate.
    cost: { reserveMicros: 900, basis: "unpriced_request", pricingGap: "opaque_input_bound", inputTokens: null, outputTokens: null } });
  accounting.observeUpstreamResponse(new Response(null, { status: 499 }), new URL("https://api.novita.ai/openai/v1/chat/completions"));
  assert.equal(accounting.upstreamChargePossible, true);
  await accounting.complete(new Response(null, { status: 499 }), { tokens: { input: 0, output: 0, total: 0, billable: false }, nonbillable: true, delivery: "complete" }, { reservedMicros: 900, reservations: [] }, null);
  const settled = await event(f); assert.equal(settled.actual_cost_micros, 900); assert.equal(settled.cost_basis, "unpriced_usage");
  assert.equal(settled.total_tokens, null); assert.equal(settled.pricing_ref, null); assert.equal(f.sent.length, 0);
});

test("a dispatched local abort without upstream headers keeps ordinary uncertainty without fabricating499", { timeout: 10_000 }, async t => {
  const abort = new AbortController(), reached = Promise.withResolvers();
  const f = await setup(t, { response: request => new Promise((_, reject) => {
    reached.resolve(); request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  }) });
  const pending = f.request({ signal: abort.signal }); await reached.promise; abort.abort();
  const response = await pending; await response.text().catch(() => undefined);
  const settled = await event(f); assert.equal(f.sent.length, 1); assert.equal(settled.actual_cost_micros, 700);
  assert.notEqual(settled.status_code, 499); assert.equal(settled.total_tokens, null);
});

test("a received metadata GET499 remains nonbillable and cannot establish generation evidence", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  const selection = { provider: f.provider, endpoint: { ...f.endpoint, request_format: "openai.models" }, model: null,
    body: {}, pathParams: {}, method: "GET", capability: "llm.models" };
  const accounting = createProxyAccounting({ env: f.env, context: { waitUntil() {} }, request: correlateIngressRequest(new Request("https://router.example")).request,
    auth: { credentialId: "fixture", principalId: null, policyId: "fixture", policy: f.policy, authType: "proxy_key" }, selection });
  const response = new Response(null, { status: 499 });
  accounting.observeUpstreamResponse(response, new URL("https://api.novita.ai/openai/v1/models"));
  assert.equal(accounting.upstreamChargePossible, false);
  await accounting.complete(response, { tokens: null, nonbillable: true, delivery: "complete" }, { reservedMicros: 0, reservations: [] }, null);
  const settled = await event(f); assert.equal(settled.actual_cost_micros, 0); assert.equal(settled.cost_basis, "none");
});
