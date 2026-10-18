import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { assessModelRequest } from "../../shared/model-request-parameters.ts";
import { actualModelCost, estimateModelCost } from "../pricing.ts";
import { modelRoute, providerById, transformRequestBody } from "../providers.ts";
import snapshot from "../generated/provider-snapshot.json" with { type: "json" };

const id = "openai/gpt-6.1-sol", upstream = "gpt-6.1-sol";
const provider = providerById("openai");
const model = snapshot.model_index[id];
const chat = provider.endpoints.find(({ id }) => id === "chat_completions");
const responses = provider.endpoints.find(({ id }) => id === "responses");
const counts = { input: 272_000, output: 1_000, cached: 100_000, cacheWrite: 100_000, cacheWrite5m: null, cacheWrite1h: null };

test("gpt-6.1-sol resolves Chat and Responses with versioned prices and its exact reasoning domain", () => {
  assert.equal(model.upstream, upstream);
  assert.deepEqual(model.capabilities, ["llm.responses", "llm.chat"]);
  assert.equal(model.pricing_ref, "openai-gpt-6-1-sol-tiers-2026-10-18");
  assert.equal(model.pricing.effectiveAt, "2026-10-18");
  assert.deepEqual(model.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  for (const capability of model.capabilities) {
    assert.equal(modelRoute(id, capability).model.pricing, provider.models.find((entry) => entry.id === id).pricing);
  }
  for (const endpoint of [chat, responses]) {
    assert.equal(model.requestParameters[endpoint.id].defaultReasoningEffort, "medium");
    for (const effort of model.supportedReasoningEfforts) {
      const body = endpoint === chat ? { reasoning_effort: effort } : { reasoning: { effort } };
      assert.deepEqual(assessModelRequest(model, endpoint, body), { conflicts: [], unknown: [] });
    }
    for (const effort of ["none", "minimal"]) {
      const body = endpoint === chat ? { reasoning_effort: effort } : { reasoning: { effort } };
      assert.equal(assessModelRequest(model, endpoint, body).conflicts.length, 1);
    }
  }
});

test("gpt-6.1-sol supports tool calling through Responses and flags it for Chat", () => {
  const tools = { tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] };
  assert.equal(assessModelRequest(model, chat, tools).conflicts[0].field, "tools");
  assert.deepEqual(assessModelRequest(model, responses, { tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] }), { conflicts: [], unknown: [] });
});

test("gpt-6.1-sol settles every served tier and reprices the entire request above 272K input", () => {
  const costs = [
    ["default", 414_000, 823_004],
    ["priority", 828_000, 1_646_008],
    ["fast", 828_000, 1_646_008],
    ["flex", 207_000, 411_502],
    ["ultrafast", 2_484_000, 4_938_024],
  ];
  assert.deepEqual(model.pricing.serviceTiers.map(({ id, aliases }) => [id, aliases]), [
    ["default", []], ["priority", ["fast"]], ["flex", []], ["ultrafast", []],
  ]);
  for (const [serviceTier, short, long] of costs) {
    assert.equal(actualModelCost(model.pricing, { ...counts, serviceTier }), short, serviceTier);
    assert.equal(actualModelCost(model.pricing, { ...counts, serviceTier, input: 272_001 }), long, `${serviceTier} long context`);
  }
  for (const serviceTier of [undefined, "auto", "unknown", "batch"]) {
    assert.equal(actualModelCost(model.pricing, { ...counts, serviceTier }), null);
  }
  assert.equal(actualModelCost(model.pricing, { ...counts, serviceTier: "default", cacheWrite: null }), null);
});

test("gpt-6.1-sol reserves full opaque bounds including Ultrafast for omitted and auto tiers", () => {
  assert.equal(model.pricing.maxInputTokens, 922_000);
  assert.equal(model.pricing.defaultMaxOutputTokens, 128_000);
  for (const [service_tier, expected] of [
    ["default", 6_530_000], ["flex", 6_530_000], ["priority", 13_060_000], ["fast", 13_060_000],
    ["ultrafast", 39_180_000], ["auto", 39_180_000], [undefined, 39_180_000],
  ]) {
    const body = { previous_response_id: "resp_fixture", ...(service_tier ? { service_tier } : {}) }, original = structuredClone(body);
    const estimate = estimateModelCost(model.pricing, body, responses);
    assert.deepEqual(estimate, { inputTokens: 922_000, outputTokens: 128_000, reserveMicros: expected });
    const served = service_tier == null || service_tier === "auto"
      ? ["default", "priority", "flex", "ultrafast"] : ["default", service_tier];
    for (const serviceTier of served) {
      const actual = actualModelCost(model.pricing, { ...counts, input: 922_000, output: 128_000, cached: 0, cacheWrite: 922_000, serviceTier });
      assert.ok(actual != null && actual <= estimate.reserveMicros);
    }
    assert.deepEqual(body, original);
  }
});

test("gpt-6.1-sol renames only Chat max_tokens and preserves an explicit completion limit", () => {
  const body = { model: upstream, messages: [], max_tokens: 16 }, original = structuredClone(body);
  assert.deepEqual(transformRequestBody(provider, chat.path, upstream, body, {}), { model: upstream, messages: [], max_completion_tokens: 16 });
  assert.deepEqual(transformRequestBody(provider, responses.path, upstream, body, {}), body);
  const explicit = { ...body, max_completion_tokens: 32 };
  assert.deepEqual(transformRequestBody(provider, chat.path, upstream, explicit, {}), explicit);
  assert.deepEqual(body, original);
});
