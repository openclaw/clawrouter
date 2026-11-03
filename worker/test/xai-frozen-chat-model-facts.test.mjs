import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");
const { providerById, configuredUpstream, providerModel } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const manifest = parse(readFileSync(new URL("../../providers/xai.provider.yaml", import.meta.url), "utf8"));
const compiled = compileProviderSnapshot([manifest]), provider = compiled.providers[0];
const endpoint = provider.endpoints.find(row => row.id === "chat_completions");
const contexts = { "grok-4.6": 500000, "grok-4.5": 500000, "grok-build-0.1": 256000,
  "grok-4.20-0309-reasoning": 1000000, "grok-4.20-0309-non-reasoning": 1000000 };
const models = Object.keys(contexts).map(id => provider.models.find(model => model.upstream === id));
const messages = [{ role: "user", content: "Synthetic frozen identity fixture" }];

test("five frozen xAI identities retain exact context and input facts without manufactured output or prices", () => {
  for (const model of models) {
    assert.equal(model.id, `xai/${model.upstream}`); assert.deepEqual(model.capabilities, ["llm.chat"]);
    const facts = model.nativeCapabilities.endpoints.chat_completions;
    assert.equal(facts.contextWindow, contexts[model.upstream]); assert.deepEqual(facts.input, ["text", "image"]);
    assert.equal(facts.maxOutputTokens, undefined); assert.equal(facts.contextTokens, undefined);
    assert.equal(facts.checkedAt, "2026-11-04"); assert.equal(facts.supportedServiceTiers, undefined);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null); assert.equal(model.endpointPricing, undefined);
    assert.equal(model.availability, undefined); assert.equal(model.nativeCapabilities.endpoints.responses, undefined);
    assert.deepEqual(compiled.model_index[model.id].nativeCapabilities, model.nativeCapabilities);
  }
});

test("only the documented configurable models advertise reasoning efforts and defaults", () => {
  for (const model of models) {
    const controls = model.requestParameters.chat_completions;
    assert.equal(controls.toolCalling, "supported");
    if (["grok-4.6", "grok-4.5"].includes(model.upstream)) {
      assert.deepEqual(model.supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
      assert.equal(controls.defaultReasoningEffort, "high");
    } else {
      assert.equal(model.supportedReasoningEfforts, undefined);
      assert.equal(controls.defaultReasoningEffort, undefined);
    }
  }
});

test("native and manifest Chat selection preserve all five wire identities and the original global key", () => {
  for (const model of models) for (const native of [false, true]) {
    const body = { model: model.upstream, messages, stream: true };
    const selected = prepareManifestRequest(provider, endpoint, body, {}, {}, native);
    assert.equal(selected.model.id, model.id); assert.deepEqual(selected.body, body);
  }
  const upstream = configuredUpstream(provider, null, { XAI_API_KEY: "synthetic-original" });
  assert.equal(upstream.baseUrl, "https://api.x.ai");
  assert.equal(upstream.headers.get("Authorization"), "Bearer synthetic-original");
  assert.equal(endpoint.path, "/v1/chat/completions");
  assert.equal(endpoint.request_format, "openai.chat_completions");
});

test("unit-price observations do not turn unknown xAI request charges into hard-budget certification", () => {
  for (const model of models) for (const extra of [{}, { service_tier: "priority" }, { max_completion_tokens: 1 },
    { tools: [{ type: "function", function: { name: "x_search", parameters: { type: "object" } } }] }]) {
    const body = { model: model.upstream, messages, ...extra };
    const estimate = estimateCost(model, body, null, "llm.chat", endpoint);
    assert.equal(estimate.inputTokens, null); assert.equal(estimate.outputTokens, null);
    for (const [caller, providerLimit] of [[10000, null], [null, 10000], [10000, 10000]]) {
      assert.throws(() => validateBudgetReservation("llm.chat", estimate, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
    }
    for (const fixed of [0, 17]) assert.deepEqual(estimateCost(model, body, fixed, "llm.chat", endpoint),
      { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
  }
});

test("new xAI rows preserve the existing default, price card and unrelated passthrough", () => {
  assert.equal(provider.models[0].upstream, "grok-4.3");
  assert.equal(provider.models[0].pricing_ref, "xai-grok-4-3-standard-2026-06-21");
  assert.equal(provider.endpoints.length, 1);
  assert.deepEqual(endpoint.modelPassthrough, { pricing_ref: null, pricing: null });
  assert.equal(providerModel(provider, "synthetic-unknown-model", endpoint).pricing, null);
});

function attachModels(t) {
  const live = providerById("xai"), previous = live.models;
  live.models = provider.models; t.after(() => { live.models = previous; });
}
function request(manifestRoute, body) {
  const path = manifestRoute ? "/v1/proxy/xai/chat_completions" : "/v1/native/xai/v1/chat/completions";
  return new Request(`https://router.example${path}`, { method: "POST",
    headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
    body: JSON.stringify(manifestRoute ? { body } : body) });
}

test("actual Worker denies each unpriced frozen xAI model before egress under either hard-dollar budget", async t => {
  attachModels(t);
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected unpriced egress"); });
  for (const model of models) for (const manifestRoute of [false, true]) for (const [limit, providerLimit] of [[10000, null], [null, 10000]]) {
    const pending = [], env = usageEnv([], { provider: "xai", limit, providerLimit, fixedCost: null, retainContent: false, budgetMode: "reserve" });
    env.XAI_API_KEY = "synthetic-original"; env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    const response = await handler.fetch(request(manifestRoute, { model: model.upstream, messages }), env,
      { waitUntil: promise => pending.push(promise) });
    assert.equal(response.headers.get("x-clawrouter-error-code"), "pricing_required");
    assert.equal((await response.json()).error.code, "pricing_required");
    await Promise.all(pending);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

for (const manifestRoute of [false, true]) test(`actual xAI ${manifestRoute ? "manifest" : "native"} JSON/SSE keeps authorized fixed charges explicit`, async t => {
  attachModels(t);
  for (const model of models) for (const stream of [false, true]) {
    const pending = [], events = [], env = usageEnv([], { provider: "xai", limit: 10000, fixedCost: 17, retainContent: false, budgetMode: "reserve" });
    env.XAI_API_KEY = "synthetic-original"; env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { async send(event) { events.push(event); } };
    const body = { model: model.upstream, messages, stream };
    const final = { id: "synthetic", object: stream ? "chat.completion.chunk" : "chat.completion", model: model.upstream,
      choices: [{ index: 0, finish_reason: "stop", ...(stream ? { delta: { content: "fixture" } } : { message: { role: "assistant", content: "fixture" } }) }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } };
    const wire = stream ? sse(final, "[DONE]") : JSON.stringify(final);
    const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(String(url), "https://api.x.ai/v1/chat/completions");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-original");
      assert.deepEqual(JSON.parse(init.body), body);
      return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    });
    try {
      const response = await handler.fetch(request(manifestRoute, body), env, { waitUntil: promise => pending.push(promise) });
      assert.equal(response.status, 200, await response.clone().text()); assert.equal(await response.text(), wire);
      await Promise.all(pending); assert.equal(upstream.mock.callCount(), 1); assert.equal(events.length, 1);
      assert.equal(events[0].actual_cost_micros, 17); assert.equal(events[0].cost_basis, "policy_fixed");
      assert.equal(events[0].input_tokens, 11); assert.equal(events[0].output_tokens, 3);
    } finally { upstream.mock.restore(); }
  }
});
