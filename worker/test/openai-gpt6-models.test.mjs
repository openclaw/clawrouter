import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { assessModelRequest } from "../../shared/model-request-parameters.ts";
import { actualModelCost, estimateModelCost } from "../pricing.ts";
import { modelRoute, providerById, transformRequestBody } from "../providers.ts";
import snapshot from "../generated/provider-snapshot.json" with { type: "json" };

const provider = providerById("openai");
const chat = provider.endpoints.find(({ id }) => id === "chat_completions");
const responses = provider.endpoints.find(({ id }) => id === "responses");
const counts = { input: 272_000, output: 1_000, cached: 100_000, cacheWrite: 100_000, cacheWrite5m: null, cacheWrite1h: null };
const contracts = [
  { name: "gpt-6-sol", supportsNone: true, extraCapabilities: [], invalidEfforts: ["ultra"], costs: [["default", 424_000, 843_004], ["priority", 848_000, 1_686_008], ["fast", 848_000, 1_686_008], ["flex", 212_000, 421_502]], reservation: 6_530_000 },
  { name: "gpt-6-luna", supportsNone: true, extraCapabilities: ["llm.decisions"], invalidEfforts: ["ultra"], costs: [["default", 21_200, 42_151], ["priority", 42_400, 84_301], ["fast", 42_400, 84_301], ["flex", 10_600, 21_076]], reservation: 326_500 },
  { name: "gpt-6.1-sol", supportsNone: false, extraCapabilities: ["llm.responses.compact"], invalidEfforts: ["none", "minimal"], costs: [["default", 414_000, 823_004], ["priority", 828_000, 1_646_008], ["fast", 828_000, 1_646_008], ["flex", 207_000, 411_502], ["ultrafast", 2_484_000, 4_938_024]], reservation: 6_530_000, pricingRef: "openai-gpt-6-1-sol-tiers-2026-10-18", ultrafast: true },
];

for (const { name: upstream, supportsNone, extraCapabilities, invalidEfforts, costs, reservation, pricingRef, ultrafast } of contracts) {
  const id = `openai/${upstream}`;

  test(`${upstream} resolves concrete Chat and Responses models with the declared effort domain`, () => {
    const model = snapshot.model_index[id];
    assert.ok(model);
    assert.equal(model.upstream, upstream);
    assert.deepEqual(model.capabilities, ["llm.responses", "llm.chat", ...extraCapabilities, "llm.count_tokens", "search.web"]);
    assert.deepEqual(model.supportedReasoningEfforts, [...(supportsNone ? ["none"] : []), "low", "medium", "high", "xhigh", "max"]);
    if (pricingRef) {
      assert.equal(model.pricing_ref, pricingRef);
      assert.equal(model.pricing.effectiveAt, "2026-10-18");
    }
    for (const capability of pricingRef ? model.capabilities : ["llm.responses", "llm.chat"]) {
      assert.equal(modelRoute(id, capability).model.pricing, provider.models.find((entry) => entry.id === id).pricing);
    }
    for (const endpoint of [chat, responses]) {
      assert.equal(model.requestParameters[endpoint.id].defaultReasoningEffort, "medium");
      for (const effort of model.supportedReasoningEfforts) {
        const body = endpoint === chat ? { reasoning_effort: effort } : { reasoning: { effort } };
        assert.deepEqual(assessModelRequest(model, endpoint, body), { conflicts: [], unknown: [] });
      }
      for (const effort of invalidEfforts) {
        const body = endpoint === chat ? { reasoning_effort: effort } : { reasoning: { effort } };
        assert.equal(assessModelRequest(model, endpoint, body).conflicts.length, 1);
      }
    }
  });

  test(`${upstream} preserves its sampling and tool-call reasoning contract`, () => {
    const model = snapshot.model_index[id];
    if (supportsNone) {
      for (const endpoint of [chat, responses]) {
        const fields = endpoint === chat
          ? [{ temperature: 0.2 }, { top_p: 0.9 }, { logprobs: true }, { top_logprobs: 5 }]
          : [{ temperature: 0.2 }, { top_p: 0.9 }, { top_logprobs: 5 }, { include: ["message.output_text.logprobs"] }];
        for (const field of fields) {
          const original = structuredClone(field);
          assert.equal(assessModelRequest(model, endpoint, field).conflicts.length, 1);
          const none = endpoint === chat ? { ...field, reasoning_effort: "none" } : { ...field, reasoning: { effort: "none" } };
          assert.deepEqual(assessModelRequest(model, endpoint, none), { conflicts: [], unknown: [] });
          const unknown = endpoint === chat ? { ...field, reasoning_effort: null } : { ...field, reasoning: { effort: null } };
          assert.equal(assessModelRequest(model, endpoint, unknown).conflicts.length, 0);
          assert.ok(assessModelRequest(model, endpoint, unknown).unknown.length > 0);
          assert.deepEqual(field, original);
        }
      }
    }
    const tools = { tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] };
    assert.equal(assessModelRequest(model, chat, tools).conflicts[0].field, "tools");
    if (supportsNone) assert.deepEqual(assessModelRequest(model, chat, { ...tools, reasoning_effort: "none" }), { conflicts: [], unknown: [] });
    assert.deepEqual(assessModelRequest(model, responses, { tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] }), { conflicts: [], unknown: [] });
  });

  test(`${upstream} settles the served tier and reprices the entire request above 272K input tokens`, () => {
    const pricing = snapshot.model_index[id].pricing;
    if (ultrafast) assert.deepEqual(pricing.serviceTiers.map(({ id, aliases }) => [id, aliases]), [
      ["default", []], ["priority", ["fast"]], ["flex", []], ["ultrafast", []],
    ]);
    for (const [serviceTier, short, long] of costs) {
      assert.equal(actualModelCost(pricing, { ...counts, serviceTier }), short);
      assert.equal(actualModelCost(pricing, { ...counts, serviceTier, input: 272_001 }), long);
    }
    for (const serviceTier of [undefined, "auto", "unknown", "batch"]) assert.equal(actualModelCost(pricing, { ...counts, serviceTier }), null);
    assert.equal(actualModelCost(pricing, { ...counts, serviceTier: "default", cacheWrite: null }), null);
  });

  test(`${upstream} reserves the full opaque input and output bounds across possible served tiers`, () => {
    const pricing = snapshot.model_index[id].pricing;
    assert.equal(pricing.maxInputTokens, 922_000);
    assert.equal(pricing.defaultMaxOutputTokens, 128_000);
    const maximum = reservation * (ultrafast ? 6 : 2);
    for (const [service_tier, expected] of [["default", reservation], ["flex", reservation], ["priority", reservation * 2], ["fast", reservation * 2], ...(ultrafast ? [["ultrafast", maximum]] : []), ["auto", maximum], [undefined, maximum]]) {
      const body = { previous_response_id: "resp_fixture", ...(service_tier ? { service_tier } : {}) }, original = structuredClone(body);
      const estimate = estimateModelCost(pricing, body, responses);
      assert.deepEqual(estimate, { inputTokens: 922_000, outputTokens: 128_000, reserveMicros: expected });
      const served = service_tier == null || service_tier === "auto" ? costs.map(([tier]) => tier)
        : service_tier === "fast" ? ["default", "priority", "fast"] : [...new Set(["default", service_tier])];
      for (const serviceTier of served) {
        const actual = actualModelCost(pricing, { ...counts, input: 922_000, output: 128_000, cached: 0, cacheWrite: 922_000, serviceTier });
        assert.ok(actual != null && actual <= estimate.reserveMicros);
      }
      assert.deepEqual(body, original);
    }
  });

  test(`${upstream} renames only Chat max_tokens and preserves an explicit completion limit`, () => {
    const body = { model: upstream, messages: [], max_tokens: 16 }, original = structuredClone(body);
    assert.deepEqual(transformRequestBody(provider, chat.path, upstream, body, {}), { model: upstream, messages: [], max_completion_tokens: 16 });
    assert.deepEqual(transformRequestBody(provider, responses.path, upstream, body, {}), body);
    const explicit = { ...body, max_completion_tokens: 32 };
    assert.deepEqual(transformRequestBody(provider, chat.path, upstream, explicit, {}), explicit);
    assert.deepEqual(body, original);
  });
}
