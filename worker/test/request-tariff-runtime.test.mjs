import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const { estimateCost, accountingReceipt } = await import("../proxy-accounting.ts");
const { estimateModelCost, requestPricingGap } = await import("../pricing.ts");
const { observeUsage } = await import("../proxy-response.ts");
const { selectRequestTariff } = await import("../request-tariff.ts");
const { HttpOperation } = await import("../http-operation.ts");
const { operationAffordability } = await import("../operation-budget.ts");

const tariff = { unit: "request", version: "xai-responses-outcome-2026-11-03", effectiveAt: "2026-11-03",
  source: "https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee", outcome: "xai.responses_violation",
  maximumAdditionalMicros: 50000, receipt: "xai.usage.cost_in_usd_ticks" };
const input = { model: "grok-4.3", input: "synthetic input", max_output_tokens: 1 };
const receipt = (ticks = 158500) => ({ object: "response", id: "resp_fixture", model: input.model, status: "completed", output: [],
  usage: { input_tokens: 3, output_tokens: 2, cost_in_usd_ticks: ticks } });
const frame = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\r\n\r\n`;
const created = () => ({ type: "response.created", response: { ...receipt(999999999), status: "in_progress" } });
const terminal = value => ({ type: `response.${value.status}`, response: value });
const encoder = new TextEncoder();
function candidate() {
  const provider = structuredClone(snapshot.providers.find(p => p.id === "xai"));
  const endpoint = { ...provider.endpoints[0], id: "responses", path: "/v1/responses", request_format: "openai.responses", response_format: "openai.responses", requestPricing: structuredClone(tariff) };
  delete endpoint.modelPassthrough;
  provider.endpoints = [endpoint];
  provider.capabilities = [{ id: "llm.responses", endpoint: "responses", methods: ["POST"] }];
  provider.models = provider.models.filter(m => m.upstream === input.model);
  for (const model of provider.models) { model.capabilities = ["llm.responses"]; model.pricing.unpricedCosts = ["request_fee"]; }
  return provider;
}

async function fixture(t, options = {}) {
  const original = snapshot.providers, provider = candidate(), endpoint = provider.endpoints[0], model = provider.models[0];
  options.change?.(provider);
  snapshot.providers = original.map(row => row.id === provider.id ? provider : row);
  t.after(() => { snapshot.providers = original; });
  const policy = { enabled: true, generation: "v1", providers: ["xai"], models: null, tenantId: "fixture",
    monthlyBudgetMicros: options.limit ?? 2000000, requestCostMicros: options.fixed ?? null, retainRequestContent: false };
  const records = new Map(), events = [], pending = [], sent = [], ledgerNames = new Set();
  const budgets = sqlBudgetNamespace(t);
  const env = { XAI_API_KEY: "synthetic-upstream-key", POLICY_KV: {
    async get(key, type) {
      const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null;
      return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value);
    },
    async put(key, value) { records.set(key, JSON.parse(value)); },
    async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => events.push(event) }, BUDGET_LEDGER: {
    idFromName: name => name, get(name) { ledgerNames.add(name); return budgets.get(name); },
  } };
  const authority = createGrantAuthority(undefined, env), continuations = continuationAuthority(t, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: name => name.startsWith("http-continuations:") ? continuations.get(name) : authority };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "tariff", policy }]);
  await authorityCall(env, "/credentials/initialize-all", [{ credentialId: "tariff", credential: { enabled: true,
    secretSha256: await sha256Hex("synthetic-tariff"), policyId: "tariff", policyGeneration: "v1" } }]);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "xai", enabled: true, ...options.connection }]);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: await new Response(init.body).json(), redirect: init.redirect });
    const rows = [...ledgerNames].flatMap(name => budgets.get(name).reservations());
    if (options.fixed === undefined) assert.ok(rows.some(row => row.reserved_micros > 50000), "inference plus outcome fee must be reserved before fetch");
    options.dispatched?.(provider);
    return options.fetch ? options.fetch(url, init) : Response.json(options.response ?? receipt(), { status: options.status ?? 200 });
  });
  const request = (body = input, { native = true, signal } = {}) => worker.fetch(new Request(
    native ? "https://router.example/v1/native/xai/v1/responses" : "https://router.example/v1/proxy/xai/responses", {
      method: "POST", signal, headers: { authorization: "Bearer clawrouter-live-tariff-synthetic-tariff", "content-type": "application/json" },
      body: JSON.stringify(native ? body : { body }),
    }), env, { waitUntil: promise => pending.push(promise) });
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending, endpoint, model, provider,
    catalog: () => worker.fetch(new Request("https://router.example/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-tariff-synthetic-tariff" } }), env, { waitUntil: promise => pending.push(promise) }), rows: () => [...ledgerNames].flatMap(name => budgets.get(name).reservations()) };
}

test("outcome admission uses the source combined estimate and leaves independent pricing gaps closed", () => {
  const provider = candidate(), endpoint = provider.endpoints[0], model = provider.models[0];
  const cost = estimateCost(model, input, null, "llm.responses", endpoint);
  assert.equal(cost.reserveMicros, estimateModelCost(model.pricing, input, endpoint, tariff).reserveMicros);
  assert.equal(cost.outputTokens, model.pricing.defaultMaxOutputTokens);
  assert.equal(cost.basis, "manifest_request");
  assert.equal(requestPricingGap(model.pricing, input, endpoint.request_format), "model_request_fee", "the original model card stays guarded");
  for (const body of [{ ...input, tools: [{ type: "web_search" }] }, { ...input, prompt: { id: "saved" } }, { ...input, previous_response_id: "resp_parent" }]) {
    assert.ok(estimateCost(model, body, null, "llm.responses", endpoint).pricingGap);
  }
  for (const tools of [[{ type: "x_search" }], [{ type: "new_server_tool" }], [{ type: "function" }], { type: "function", name: "synthetic" }]) {
    assert.ok(estimateCost(model, { ...input, tools }, null, "llm.responses", endpoint).pricingGap);
    assert.ok(estimateCost(model, { ...input, input: [{ type: "additional_tools", tools }] }, null, "llm.responses", endpoint).pricingGap);
  }
  const plain = { ...input, tools: [{ type: "function", name: "web_search", parameters: { properties: { violation: { type: "string" } } } }] };
  assert.equal(estimateCost(model, plain, null, "llm.responses", endpoint).pricingGap, undefined);
  assert.equal(estimateCost(model, input, 7, "llm.responses", endpoint).basis, "policy_fixed");
  assert.equal(estimateCost(model, { ...input, service_tier: "unqualified" }, null, "llm.responses", endpoint).basis, "unpriced_service_tier");
});

test("native and manifest calls reserve once and settle the whole receipt without adding token or outcome charges", async t => {
  for (const native of [true, false]) await t.test(String(native), async t => {
    const f = await fixture(t);
    const response = await f.request(input, { native });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), receipt());
    await Promise.all(f.pending);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].url, "https://api.x.ai/v1/responses");
    assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-upstream-key");
    assert.equal(f.sent[0].redirect, "manual");
    assert.equal(f.events.length, 1);
    const event = f.events[0];
    assert.equal(event.actual_cost_micros, 16);
    assert.equal(event.cost_basis, "provider_reported");
    assert.equal(event.pricing_ref, tariff.version);
    assert.ok(event.reserved_cost_micros > 50000);
    assert.equal(event.reserved_output_tokens, f.model.pricing.defaultMaxOutputTokens);
    assert.ok(f.rows().every(row => row.reserved_micros === 16));
  });
});

test("receipt settlement preserves zero, native incomplete, and amounts above the reservation", async t => {
  for (const [ticks, status] of [[0, "completed"], [500000000, "incomplete"], [100000000000, "completed"]]) await t.test(`${ticks}-${status}`, async t => {
    const f = await fixture(t, { response: { ...receipt(ticks), status } });
    await (await f.request()).arrayBuffer(); await Promise.all(f.pending);
    assert.equal(f.events[0].actual_cost_micros, ticks / 10000);
    assert.equal(f.events[0].cost_basis, "provider_reported");
    if (ticks === 100000000000) assert.ok(f.events[0].actual_cost_micros > f.events[0].reserved_cost_micros);
  });
});

test("post-dispatch errors, missing receipts and model mismatches retain the original reservation", async t => {
  const missing = receipt(); delete missing.usage.cost_in_usd_ticks;
  for (const [label, options] of [
    ["403", { status: 403, response: { error: { code: "unqualified", message: "synthetic" } } }],
    ["missing", { response: missing }], ["other-model", { response: { ...receipt(0), model: "different-model" } }],
    ["loss", { fetch() { throw new Error("synthetic transport loss"); } }],
    ["redirect", { fetch() { return new Response(null, { status: 307, headers: { location: "https://other.example/" } }); } }],
  ]) await t.test(label, async t => {
    const f = await fixture(t, options);
    await (await f.request()).arrayBuffer(); await Promise.all(f.pending);
    assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].cost_basis, "manifest_request_reservation");
    assert.ok(f.events[0].actual_cost_micros > 50000);
    assert.equal(f.events[0].actual_cost_micros, f.events[0].reserved_cost_micros);
  });
});

test("fee bounds, tools, tiers, background and actual origin overrides deny before egress", async t => {
  for (const [label, options, body] of [
    ["fee-budget", { limit: 49999 }, input], ["tool", {}, { ...input, tools: [{ type: "web_search" }] }],
    ["x-search", {}, { ...input, tools: [{ type: "x_search" }] }], ["tier", {}, { ...input, service_tier: "unknown" }], ["background", {}, { ...input, background: true }],
    ["region", { change(provider) { provider.base_urls.default = "https://us-east-1.api.x.ai"; } }, input],
  ]) await t.test(label, async t => {
    const f = await fixture(t, options);
    const response = await f.request(body);
    assert.ok(response.status >= 400, await response.text()); await Promise.all(f.pending);
    assert.equal(f.sent.length, 0);
    assert.ok(f.events.every(event => event.actual_cost_micros === 0));
  });
});

test("selected tariff facts survive manifest mutation after dispatch and fixed policy keeps its own basis", async t => {
  for (const fixed of [undefined, 7]) await t.test(String(fixed), async t => {
    const f = await fixture(t, { fixed, dispatched(provider) { provider.endpoints[0].requestPricing.version = "changed-after-dispatch"; } });
    await (await f.request()).arrayBuffer(); await Promise.all(f.pending);
    assert.equal(f.events[0].actual_cost_micros, fixed ?? 16);
    assert.equal(f.events[0].cost_basis, fixed === undefined ? "provider_reported" : "policy_fixed");
    if (fixed === undefined) assert.equal(f.events[0].pricing_ref, tariff.version);
  });
});

async function inspect(text, streaming = true, chunk = 7) {
  const bytes = encoder.encode(text); let offset = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    const end = Math.min(offset + chunk, bytes.length); controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } }, { highWaterMark: 0 }), { headers: { "content-type": streaming ? "text/event-stream" : "application/json" } });
  const endpoint = candidate().endpoints[0];
  const observed = observeUsage(response, new HttpOperation(), undefined, "openai.responses", selectRequestTariff(endpoint, input));
  assert.equal(await observed.response.text(), text, "observation preserves original bytes");
  return observed.result;
}

test("SSE uses one original terminal receipt after complete framing, never running charges", async () => {
  const text = frame(created()) + frame({ type: "response.output_text.delta", delta: "synthetic output" }) + frame(terminal(receipt())) + frame("[DONE]");
  for (const chunk of [1, 7, 4096]) {
    const result = await inspect(text, true, chunk);
    assert.equal(result.requestCostReceipt.costMicros, 16);
    assert.equal(result.delivery, "complete");
  }
  assert.equal((await inspect(frame(terminal({ ...receipt(500000000), status: "incomplete" })))).requestCostReceipt.costMicros, 50000);
});

test("duplicate terminals, crossed response identities, malformed tails and unsafe receipts remain unknown", async () => {
  for (const text of [
    frame(created()), frame(terminal(receipt())).trimEnd(), frame(terminal(receipt())) + 'data: {"type":',
    frame(terminal(receipt())) + frame(terminal(receipt())), frame(terminal(receipt())) + frame({ type: "error", error: { code: "synthetic" } }),
    frame("[DONE]") + frame(terminal(receipt())), frame(created()) + frame(terminal({ ...receipt(), id: "resp_other" })),
    frame(terminal({ ...receipt(), model: "other" })), frame(terminal(receipt(Number.MAX_SAFE_INTEGER + 1))),
    frame(terminal(receipt("500000000"))), frame(terminal({ ...receipt(), usage: { input_tokens: 0, output_tokens: 0 } })),
  ]) assert.equal((await inspect(text)).requestCostReceipt, undefined);
  assert.equal((await inspect(JSON.stringify({ ...receipt(), padding: "x".repeat(2 * 1024 * 1024) }), false, 4093)).requestCostReceipt.costMicros, 16, "projection ignores large output rather than buffering it");
});

test("consumer cancellation after a complete terminal frame still cannot certify complete transport", async () => {
  const abort = new AbortController(); let pulls = 0, cancels = 0;
  const source = new ReadableStream({ pull(controller) { if (pulls++ === 0) controller.enqueue(encoder.encode(frame(terminal(receipt(0))))); }, cancel() { cancels++; } }, { highWaterMark: 0 });
  const observed = observeUsage(new Response(source, { headers: { "content-type": "text/event-stream" } }), new HttpOperation(abort.signal), undefined,
    "openai.responses", selectRequestTariff(candidate().endpoints[0], input));
  const reader = observed.response.body.getReader();
  assert.equal(pulls, 0); await reader.read(); assert.equal(pulls, 1);
  await reader.cancel(); abort.abort();
  const result = await observed.result;
  assert.equal(result.delivery, "canceled"); assert.equal(result.requestCostReceipt, undefined); assert.equal(cancels, 1);
});

test("frozen accounting facts distinguish unsent, uncertainty, and a version-bound receipt", () => {
  const provider = candidate(), endpoint = provider.endpoints[0], model = provider.models[0];
  const cost = estimateCost(model, input, null, "llm.responses", endpoint);
  const facts = { event: { id: "usage_fixture", capability: "llm.responses" }, model, fixed: null, cost, requestFormat: "openai.responses", startedAtMs: 1 };
  const outcome = { occurredAtMs: 2, statusCode: 403, status: "client_error", billable: false, tokens: null,
    reservation: { reservedMicros: cost.reserveMicros }, contentRef: null };
  assert.equal(accountingReceipt(facts, outcome).actual_cost_micros, cost.reserveMicros);
  assert.equal(accountingReceipt(facts, { ...outcome, requestTariffOutcome: "unsent" }).actual_cost_micros, 0);
  assert.equal(accountingReceipt(facts, { ...outcome, requestCostReceipt: { costMicros: 0, basis: "provider_reported", pricingVersion: "different" } }).actual_cost_micros, cost.reserveMicros);
  assert.deepEqual(accountingReceipt(JSON.parse(JSON.stringify(facts)), outcome), accountingReceipt(facts, outcome));
});

test("catalog affordability preserves the request component even on a zero-token card", () => {
  const provider = candidate(), endpoint = provider.endpoints[0], model = provider.models[0];
  model.pricing.inputMicrosPerMillion = model.pricing.outputMicrosPerMillion = 0; model.pricing.longContext = null;
  const availability = operationAffordability({ policy: { monthlyBudgetMicros: 1000000 } }, { providerId: "xai" }, model, "llm.responses", endpoint,
    { policyRemaining: 1000000, providerRemaining: null });
  assert.equal(availability.status, "request-dependent");
});


test("public SSE delivery settles one receipt and catalog retains its evidence qualification", async t => {
  const text = frame(created()) + frame(terminal(receipt())) + frame("[DONE]");
  const f = await fixture(t, { fetch() { return new Response(text, { headers: { "content-type": "text/event-stream" } }); } });
  const catalog = await f.catalog(); assert.equal(catalog.status, 200, await catalog.clone().text());
  const entry = (await catalog.json()).providers.find(provider => provider.id === "xai");
  assert.deepEqual(entry.routes.find(route => route.endpoint === "responses").requestPricing, tariff);
  assert.ok(entry.offers.length > 0);
  assert.ok(entry.offers.every(offer => offer.requestPricing.receipt === tariff.receipt && offer.affordability === "request-dependent"));
  assert.equal(f.sent.length, 0);
  const response = await f.request({ ...input, stream: true });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await response.text(), text); await Promise.all(f.pending);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 16);
});

test("a lost delivery after the terminal frame retains one charged reservation", { timeout: 10000 }, async t => {
  const abort = new AbortController(); let pulls = 0, cancels = 0;
  const f = await fixture(t, { fetch() { return new Response(new ReadableStream({
    pull(controller) { if (pulls++ === 0) controller.enqueue(encoder.encode(frame(terminal(receipt(0))))); },
    cancel() { cancels++; },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }); } });
  const response = await f.request({ ...input, stream: true }, { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); await reader.read(); await reader.cancel(); abort.abort();
  await Promise.all(f.pending);
  assert.equal(f.events.length, 1); assert.equal(f.sent.length, 1); assert.equal(cancels, 1);
  assert.equal(f.events[0].actual_cost_micros, f.events[0].reserved_cost_micros);
  assert.equal(f.events[0].cost_basis, "manifest_request_reservation");
});

test("successful-request selection freezes one native price and rejects cheap malformed defaults", () => {
  const endpoint = { method: "POST", path: "/search", request_format: "perplexity.search", response_format: "perplexity.search", query: {},
    requestPricing: { unit: "request", version: "perplexity-search-2026-11-03", effectiveAt: "2026-11-03",
      source: "https://docs.perplexity.ai/docs/getting-started/pricing", successfulResponseMicros: 5000,
      parameterRates: { parameter: "search_type", rates: { web: 5000, fast: 1000 } } } };
  for (const [body, micros] of [[{ query: "synthetic" }, 5000], [{ query: ["one", "two"], search_type: "fast" }, 1000],
    [{ query: "synthetic", search_type: "web", max_results: 100 }, 5000], [{ query: { search_type: "fast" } }, 5000]]) {
    const cost = estimateCost(null, body, null, "web.search", endpoint);
    assert.equal(cost.reserveMicros, micros); assert.equal(cost.inputTokens, null);
    const facts = { event: {}, model: null, fixed: null, cost, requestFormat: "perplexity.search", startedAtMs: 1 };
    const event = accountingReceipt(facts, { occurredAtMs: 2, statusCode: 422, status: "client_error", billable: false,
      tokens: null, reservation: { reservedMicros: micros }, contentRef: null });
    assert.equal(event.actual_cost_micros, micros, "HTTP status alone cannot attest free work");
    assert.equal(event.cost_basis, "manifest_request_reservation");
  }
  for (const value of [null, undefined, false, 0, [], {}, "unknown", "FAST", "__proto__"]) {
    assert.throws(() => selectRequestTariff(endpoint, { query: "synthetic", search_type: value }), error => error.code === "invalid_request_tariff_parameter");
  }
  const selected = selectRequestTariff(endpoint, { search_type: "fast" });
  endpoint.requestPricing.parameterRates.rates.fast = 999;
  assert.equal(selected.micros, 1000);
  assert.throws(() => selectRequestTariff({ ...endpoint, streaming: "sse" }, {}), error => error.code === "request_tariff_unqualified");
});
