import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { providerModel } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { estimateModelCost } = await import("../pricing.ts");

const manifest = parse(readFileSync(new URL("../../providers/deepseek.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([manifest]), provider = snapshot.providers[0];
const endpoint = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");
const flashes = ["deepseek-v4-flash", "deepseek-flash", "deepseek-v4-flash-vision-exp"];

test("DeepSeek's named Flash aliases expose image input without granting it to Pro or unknown models", () => {
  for (const upstream of [...flashes, "deepseek-v4-pro"]) {
    const model = snapshot.model_index[`deepseek/${upstream}`];
    const facts = model.nativeCapabilities.endpoints.chat_completions;
    assert.deepEqual(facts.input, upstream === "deepseek-v4-pro" ? ["text"] : ["text", "image"]);
    assert.equal(facts.maxOutputTokens, 393216);
    assert.equal(facts.checkedAt, "2026-11-03");
    assert.deepEqual(Object.keys(model.nativeCapabilities.endpoints), ["chat_completions"]);
    assert.deepEqual(model.supportedReasoningEfforts, ["none", "low", "high", "max"]);
    assert.equal(model.requestParameters.chat_completions.defaultReasoningEffort, "high");
    assert.equal(model.requestParameters.chat_completions.temperature, "requires_reasoning_none");
    assert.equal(model.requestParameters.chat_completions.topP, undefined, "mode-dependent top_p does not fit a blanket support claim");
    assert.equal(model.requestParameters.chat_completions.toolCalling, "supported");
  }
  const unknown = providerModel(provider, "deepseek-future", endpoint, true);
  assert.equal(unknown.nativeCapabilities, undefined);
  assert.equal(unknown.pricing, null);
});

test("DeepSeek Chat preparation preserves image blocks, thinking replay, and client function tools", () => {
  for (const upstream of flashes) {
    const body = { model: `deepseek/${upstream}`, messages: [
      { role: "user", content: [{ type: "text", text: "describe this fixture" }, { type: "image_url", image_url: { url: "https://example.com/image.png", detail: "low" } }] },
      { role: "assistant", content: null, reasoning_content: "fixture reasoning", tool_calls: [{ id: "fixture-call", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "fixture-call", content: "fixture result" },
    ], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    thinking: { type: "enabled" }, reasoning_effort: "max", stream: true, max_tokens: 16 };
    const before = structuredClone(body);
    const prepared = prepareManifestRequest(provider, endpoint, body, {}, {});
    assert.deepEqual(prepared.body, { ...body, model: upstream });
    assert.deepEqual(body, before);
    assert.equal(prepared.model.id, `deepseek/${upstream}`);
  }
});

test("DeepSeek image reservations retain the full input bound and published peak prices", () => {
  for (const upstream of flashes) {
    const pricing = snapshot.model_index[`deepseek/${upstream}`].pricing;
    assert.equal(pricing.checkedAt, "2026-11-03");
    assert.equal(pricing.settlementBasis, "published_upper_bound");
    assert.deepEqual([pricing.inputMicrosPerMillion, pricing.cachedInputMicrosPerMillion, pricing.outputMicrosPerMillion], [300000, 6000, 1200000]);
    const estimate = estimateModelCost(pricing, { max_tokens: 16, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }] }] }, endpoint);
    assert.equal(estimate.inputTokens, 1048576);
    assert.equal(estimate.outputTokens, 16);
    assert.equal(estimate.reserveMicros, Math.ceil(1048576 * 300000 / 1000000) + Math.ceil(16 * 1200000 / 1000000));
  }
});
