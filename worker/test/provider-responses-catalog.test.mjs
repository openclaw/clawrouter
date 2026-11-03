import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

function compile(id) {
  return JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", `providers/${id}.provider.yaml`], { encoding: "utf8" }));
}

test("xAI advertises Responses only on the sourced Grok row and retains the request-fee gap", () => {
  const snapshot = compile("xai");
  const provider = snapshot.providers[0];
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "responses");
  assert.equal(endpoint.path, "/v1/responses");
  assert.equal(endpoint.streaming, "sse");
  assert.equal(endpoint.modelPassthrough.pricing, null);
  assert.equal(endpoint.responsesLifecycle, undefined);
  const model = snapshot.model_index["xai/grok-4.7"];
  assert.deepEqual(model.capabilities, ["llm.responses"]);
  assert.deepEqual(model.nativeCapabilities.endpoints.responses.input, ["text", "image"]);
  assert.equal(model.requestParameters.responses.defaultReasoningEffort, "high");
  assert.deepEqual(model.pricing.unpricedCosts, ["request_fee"]);
  assert.equal(model.pricing.longContext.thresholdInputTokens, 199999);
  assert.deepEqual(model.pricing.serviceTiers.map(tier => [tier.id, tier.outputMicrosPerMillion, tier.longContext.outputMicrosPerMillion]), [
    ["default", 6000000, 12000000], ["priority", 12000000, 24000000],
  ]);
  assert.deepEqual(snapshot.model_index["xai/grok-4.3"].capabilities, ["llm.chat"]);
});

test("qualified OpenRouter Responses metadata cannot certify auto or Azure deployments", () => {
  const snapshot = compile("openrouter");
  const terra = snapshot.model_index["openrouter/openai/gpt-6.1-terra"];
  assert.equal(terra.upstream, "openai/gpt-6.1-terra");
  assert.ok(terra.capabilities.includes("llm.responses"));
  assert.equal(terra.nativeCapabilities.endpoints.responses.contextWindow, 1050000);
  assert.equal(terra.nativeCapabilities.endpoints.responses.maxOutputTokens, 128000);
  assert.equal(terra.pricing, null);
  assert.deepEqual(snapshot.model_index["openrouter/auto"].capabilities, ["llm.chat"]);
  const azure = compile("azure-openai").model_index["azure-openai/deployment"];
  assert.equal(azure.capabilities.includes("llm.responses"), false);
  assert.equal(azure.pricing, null);
});
