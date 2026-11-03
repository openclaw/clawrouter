import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { hostedToolPricingGap, requestPricingGap, outcomeRequestPricingGap, estimateModelCost } = await import("../pricing.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const { retainedToolBase } = await import("../responses-tool-evidence.ts");
const provider = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/xai.provider.yaml", import.meta.url), "utf8"))]).providers[0];
const model = provider.models[0], endpoint = { request_format: "openai.responses" };
const guarded = { ...model.pricing, unpricedCosts: ["request_fee"] };
const tariff = {
  unit: "request", version: "xai-responses-outcome-2026-11-03", effectiveAt: "2026-11-03",
  source: "https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee",
  outcome: "xai.responses_violation", maximumAdditionalMicros: 50000, receipt: "xai.usage.cost_in_usd_ticks",
};
const nativeTools = [
  [{ type: "web_search", enable_image_understanding: true }, "hosted_tool_fee"],
  [{ type: "x_search", allowed_x_handles: ["fixture"], enable_video_understanding: true }, "hosted_tool_fee"],
  [{ type: "code_interpreter" }, "hosted_tool_fee"],
  [{ type: "file_search", vector_store_ids: ["collection_fixture"] }, "hosted_tool_fee"],
  [{ type: "image_generation" }, "hosted_tool_fee"],
  [{ type: "mcp", server_label: "fixture", server_url: "https://mcp.example" }, "hosted_tool_usage"],
];
const body = tools => ({ input: "synthetic", max_output_tokens: 1, tools });
const outcomeGap = value => outcomeRequestPricingGap(guarded, value, endpoint.request_format, tariff);

test("native xAI declarations keep hosted fees and hosted iteration bounds distinct from the outcome charge", () => {
  for (const [tool, gap] of nativeTools) {
    assert.equal(hostedToolPricingGap([tool], endpoint.request_format), gap);
    assert.equal(requestPricingGap(model.pricing, body([tool]), endpoint.request_format), gap);
    assert.equal(outcomeGap(body([tool])), gap);
    assert.equal(requestPricingGap(guarded, body([tool]), endpoint.request_format), "model_request_fee", "ordinary admission retains the outcome guard");
  }
  for (const controls of [{ max_tool_calls: 1 }, { max_turns: 1 }, { max_search_results: 1 }]) {
    assert.equal(outcomeGap({ ...body([{ type: "x_search" }]), ...controls }), "hosted_tool_fee", "a call/result hint does not bound every fetched post/profile");
  }
});

test("client functions with hosted names and user JSON are not hosted execution", () => {
  for (const name of ["x_search", "web_search", "code_interpreter", "code_execution", "file_search", "collections_search", "attachment_search", "view_image", "view_x_video", "image_generation", "mcp"]) {
    const tool = { type: "function", name, parameters: { type: "object", properties: { payload: { type: "string", description: JSON.stringify({ type: "x_search" }) } } } };
    assert.equal(hostedToolPricingGap([tool], endpoint.request_format), null);
    assert.equal(outcomeGap(body([tool])), null);
    assert.equal(requestPricingGap(model.pricing, { messages: [{ role: "user", content: "synthetic" }], tools: [{ type: "function", function: { name, parameters: tool.parameters } }] }, "openai.chat_completions"), null);
  }
  for (const input of [JSON.stringify({ tools: [{ type: "x_search" }], type: "input_file" }), [{ role: "user", content: [{ type: "input_text", text: JSON.stringify({ type: "x_search", search_parameters: { mode: "on" } }) }] }], [{ type: "function_call_output", call_id: "call_fixture", output: JSON.stringify({ type: "input_file", tools: [{ type: "x_search" }] }) }]]) {
    assert.equal(outcomeGap({ input }), null);
  }
});

test("X Search is rejected by real budget admission while explicit policy-fixed requests retain their label", () => {
  const request = body([{ type: "x_search" }]);
  const estimate = estimateCost(model, request, null, "llm.responses", endpoint);
  assert.equal(estimate.pricingGap, "hosted_tool_fee");
  for (const [policyLimit, providerLimit] of [[1000000, null], [null, 1000000]]) {
    const connection = { providerId: provider.id, monthlyBudgetMicros: providerLimit };
    assert.throws(() => validateBudgetReservation("llm.responses", estimate, policyLimit, connection), error => error.code === "pricing_required");
    for (const fixed of [0, 50000]) {
      const explicit = estimateCost(model, request, fixed, "llm.responses", endpoint);
      assert.equal(explicit.basis, "policy_fixed"); assert.equal(explicit.reserveMicros, fixed);
      assert.equal(validateBudgetReservation("llm.responses", explicit, policyLimit, connection), true);
    }
  }
  assert.equal(validateBudgetReservation("llm.responses", estimate, null), false, "unmetered dispatch policy stays unchanged");
});

test("typed additional declarations retain the X Search gap without searching nested content or function arguments", () => {
  for (const type of ["additional_tools", "tool_search_output"]) {
    const input = [{ type, tools: [{ type: "x_search" }] }];
    assert.equal(requestPricingGap(model.pricing, { input }, endpoint.request_format), "hosted_tool_fee");
    assert.equal(outcomeGap({ input }), "hosted_tool_fee");
    assert.equal(retainedToolBase({ input }, "token_only"), "hosted_tool_fee");
  }
  assert.equal(outcomeGap({ input: [{ role: "user", content: [{ type: "input_text", text: "synthetic", metadata: { type: "additional_tools", tools: [{ type: "x_search" }] } }] }] }), null);
});

test("native attachments and legacy search cannot borrow the possible-violation fee as a whole-request bound", () => {
  for (const part of [{ type: "input_file", file_id: "file_fixture" }, { type: "input_file", file_url: "https://files.example/document.pdf" }]) {
    assert.equal(outcomeGap({ input: [{ role: "user", content: [part] }] }), "hosted_tool_usage");
    assert.equal(outcomeGap({ input: [part] }), "hosted_tool_usage");
  }
  for (const search_parameters of [{ mode: "on" }, { mode: "auto" }, {}, "on", { mode: "unknown" }])
    assert.equal(outcomeGap({ input: "synthetic", search_parameters }), "hosted_tool_usage");
  assert.equal(outcomeGap({ input: "synthetic", search_parameters: { mode: "off" } }), null);
  assert.equal(outcomeGap({ input: "synthetic", metadata: { search_parameters: { mode: "on" } } }), null);
});

test("the opt-in contract rejects unsupported tool declarations and unqualified native ancestry", () => {
  for (const tool of [{ type: "future_executor" }, { type: "code_execution" }, { type: "attachment_search" }, { type: "collections_search" }, { type: "view_image" }, { type: "view_x_video" }, {}, null])
    assert.equal(outcomeGap(body([tool])), "hosted_tool_usage");
  assert.equal(outcomeGap(body({ type: "x_search" })), "hosted_tool_usage");
  for (const extra of [{ previous_response_id: "resp_fixture" }, { conversation: "conv_fixture" }]) {
    assert.equal(outcomeRequestPricingGap(guarded, { input: "synthetic", ...extra }, endpoint.request_format, tariff, "token_only"), "retained_tool_unknown");
  }
  assert.equal(outcomeGap({ prompt: { id: "prompt_fixture" } }), "hosted_tool_usage");
  assert.equal(outcomeGap({ multi_agent: { enabled: true } }), "hosted_tool_usage");
});

test("only the explicit qualified outcome helper clears its represented fee and leaves tariff inputs immutable", () => {
  const before = structuredClone(guarded);
  assert.equal(requestPricingGap(guarded, body([]), endpoint.request_format), "model_request_fee");
  assert.equal(outcomeGap(body([])), null);
  assert.deepEqual(guarded, before);
  assert.equal(estimateModelCost(guarded, body([]), endpoint, tariff).outputTokens, guarded.defaultMaxOutputTokens);
  for (const bad of [{ ...tariff, outcome: "unknown" }, { ...tariff, maximumAdditionalMicros: 0 }])
    assert.equal(outcomeRequestPricingGap(guarded, body([]), endpoint.request_format, bad), "model_request_fee");
  assert.equal(outcomeRequestPricingGap(guarded, body([]), "openai.chat_completions", tariff), "model_request_fee");
  assert.equal(outcomeRequestPricingGap(null, body([]), endpoint.request_format, tariff), "model_request_fee");
});
