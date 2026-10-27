import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { assessModelRequest } from "../../shared/model-request-parameters.ts";
import { actualModelCost, estimateModelCost, hostedSearchPrice } from "../pricing.ts";
import { modelRoute, providerById, transformRequestBody } from "../providers.ts";
import snapshot from "../generated/provider-snapshot.json" with { type: "json" };

const id = "openai/gpt-6.1-terra", upstream = "gpt-6.1-terra";
const provider = providerById("openai");
const model = snapshot.model_index[id];
const chat = provider.endpoints.find(({ id }) => id === "chat_completions");
const responses = provider.endpoints.find(({ id }) => id === "responses");
const counts = { input: 272_000, output: 1_000, cached: 100_000, cacheWrite: 100_000, cacheWrite5m: null, cacheWrite1h: null };

test("Terra has independently sourced text/image facts and exact routing", () => {
  assert.ok(model, "the compiled catalog must advertise GPT-6.1 Terra");
  assert.equal(model.upstream, upstream);
  assert.equal(model.pricing_ref, "openai-gpt-6.1-terra-tiers-2026-10-26");
  assert.equal(model.pricing.effectiveAt, "2026-10-26");
  for (const capability of ["llm.responses", "llm.chat", "llm.responses.compact", "llm.count_tokens"]) {
    assert.equal(modelRoute(id, capability).model, provider.models.find(entry => entry.id === id));
  }
  for (const endpoint of ["chat_completions", "responses"]) {
    const facts = model.nativeCapabilities.endpoints[endpoint];
    assert.deepEqual(facts.input, ["text", "image"]);
    assert.equal(facts.contextWindow, 1_050_000);
    assert.equal(facts.contextTokens, 272_000);
    assert.equal(facts.maxOutputTokens, 128_000);
    assert.deepEqual(facts.supportedServiceTiers, ["default", "priority", "flex"]);
    assert.equal(facts.inference.chat, true);
    assert.ok(facts.sources.includes("https://developers.openai.com/api/docs/models/gpt-6.1-terra"));
  }
});

test("Terra allows none reasoning but requires Responses for tools at every effort", () => {
  assert.deepEqual(model.supportedReasoningEfforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  for (const endpoint of [chat, responses]) {
    assert.equal(model.requestParameters[endpoint.id].defaultReasoningEffort, "medium");
    for (const effort of model.supportedReasoningEfforts) {
      const reasoning = endpoint === chat ? { reasoning_effort: effort } : { reasoning: { effort } };
      assert.deepEqual(assessModelRequest(model, endpoint, reasoning), { conflicts: [], unknown: [] });
      const tools = endpoint === chat ? [{ type: "function", function: { name: "lookup" } }] : [{ type: "function", name: "lookup" }];
      const result = assessModelRequest(model, endpoint, { ...reasoning, tools });
      assert.equal(result.conflicts.length, endpoint === chat ? 1 : 0);
      if (endpoint === chat) assert.equal(result.conflicts[0].field, "tools");
    }
    const minimal = endpoint === chat ? { reasoning_effort: "minimal" } : { reasoning: { effort: "minimal" } };
    assert.equal(assessModelRequest(model, endpoint, minimal).conflicts.length, 1);
  }
  assert.equal(assessModelRequest(model, responses, { temperature: 0.5 }).conflicts[0].field, "temperature");
  assert.deepEqual(assessModelRequest(model, responses, { reasoning: { effort: "none" }, temperature: 0.5 }), { conflicts: [], unknown: [] });
});

test("Terra settles Standard, Fast and Flex with the whole-request long-context uplift", () => {
  for (const [serviceTier, short, long] of [["default", 207_000, 411_502], ["priority", 414_000, 823_004], ["fast", 414_000, 823_004], ["flex", 103_500, 205_751]]) {
    assert.equal(actualModelCost(model.pricing, { ...counts, serviceTier }), short, serviceTier);
    assert.equal(actualModelCost(model.pricing, { ...counts, serviceTier, input: 272_001 }), long, serviceTier + " long context");
  }
  for (const serviceTier of [undefined, "auto", "unknown", "batch", "ultrafast"]) {
    assert.equal(actualModelCost(model.pricing, { ...counts, serviceTier }), null);
  }
  assert.equal(actualModelCost(model.pricing, { ...counts, serviceTier: "default", cacheWrite: null }), null);
});

test("Terra opaque reservations cover every declared tier without borrowing Sol Ultrafast", () => {
  for (const [service_tier, expected] of [["default", 3_265_000], ["flex", 3_265_000], ["priority", 6_530_000], ["fast", 6_530_000], ["auto", 6_530_000], [undefined, 6_530_000]]) {
    const body = { previous_response_id: "resp_fixture", ...(service_tier ? { service_tier } : {}) }, original = structuredClone(body);
    assert.deepEqual(estimateModelCost(model.pricing, body, responses), { inputTokens: 922_000, outputTokens: 128_000, reserveMicros: expected });
    assert.deepEqual(body, original);
  }
  assert.equal(estimateModelCost(model.pricing, { previous_response_id: "resp_fixture", service_tier: "ultrafast" }, responses).pricingAvailable, false);
});

test("Terra transforms Chat limits only and qualifies its own hosted search tariff", () => {
  const body = { model: upstream, messages: [], max_tokens: 16 }, original = structuredClone(body);
  assert.deepEqual(transformRequestBody(provider, chat.path, upstream, body, {}), { model: upstream, messages: [], max_completion_tokens: 16 });
  assert.deepEqual(transformRequestBody(provider, responses.path, upstream, body, {}), original);
  assert.deepEqual(transformRequestBody(provider, chat.path, upstream, { ...body, max_completion_tokens: 32 }, {}), { model: upstream, messages: [], max_tokens: 16, max_completion_tokens: 32 });
  assert.deepEqual(body, original);
  assert.equal(hostedSearchPrice(responses.toolPricing, { tools: [{ type: "web_search_preview" }] }, upstream).microsPerCall, 10_000);
});
