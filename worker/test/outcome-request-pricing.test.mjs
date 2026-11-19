import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { estimateModelCost, requestPricingGap, requestOutcomeReserve, requestOutcomeCost } = await import("../pricing.ts");
const original = parse(readFileSync(new URL("../../providers/xai.provider.yaml", import.meta.url), "utf8"));
const tariff = {
  unit: "request", version: "xai-responses-outcome-2026-11-03", effectiveAt: "2026-11-03",
  source: "https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee",
  outcome: "xai.responses_violation", maximumAdditionalMicros: 50000, receipt: "xai.usage.cost_in_usd_ticks",
};
function fixture() {
  const manifest = structuredClone(original);
  // Select the named existing row: queued catalog additions can change defaults.
  manifest.models.entries = [manifest.models.entries.find(model => model.upstream === "grok-4.3")];
  manifest.capabilities = manifest.capabilities.filter(capability => capability.endpoint !== "responses");
  manifest.endpoints.responses = { path: "/v1/responses", requestFormat: "openai.responses", responseFormat: "openai.responses", streaming: "sse", requestPricing: structuredClone(tariff) };
  manifest.capabilities.push({ id: "llm.responses", endpoint: "responses", methods: ["POST"] });
  manifest.models.entries[0].capabilities.push("llm.responses");
  manifest.models.entries[0].pricing.unpricedCosts = ["request_fee"];
  return manifest;
}
const compile = manifest => compileProviderSnapshot([manifest]);
// Synthetic whole-response receipts, not captured violation prompts or an
// assertion that a particular refusal/error is a billable violation.
const response = ticks => ({ object: "response", id: "resp_synthetic", model: "grok-4.3", status: "completed", output: [], usage: { cost_in_usd_ticks: ticks } });

test("outcome request tariff compiles separately from token pricing and preserves the live admission guard", () => {
  const manifest = fixture(), snapshot = compile(manifest), endpoint = snapshot.providers[0].endpoints.find(e => e.id === "responses");
  assert.deepEqual(endpoint.requestPricing, tariff);
  manifest.endpoints.responses.requestPricing.version = "changed";
  assert.equal(endpoint.requestPricing.version, tariff.version);
  const pricing = snapshot.model_index["xai/grok-4.3"].pricing;
  assert.equal(requestPricingGap(pricing, { input: "synthetic", max_output_tokens: 10 }, "openai.responses"), "model_request_fee");
  assert.deepEqual(snapshot.providers[0].endpoints.find(e => e.id === "chat_completions"), compile(original).providers[0].endpoints[0]);
  assert.ok(compile(original).providers[0].endpoints.every(e => e.requestPricing === undefined));
});

test("outcome tariffs reject invented signals, unqualified rates and successful-request mixing", () => {
  for (const change of [
    p => { p.outcome = "any_http_error"; }, p => { p.receipt = "error.code"; },
    p => { p.maximumAdditionalMicros = 0; }, p => { p.maximumAdditionalMicros = 50001; },
    p => { p.maximumAdditionalMicros = "50000"; }, p => { p.maximumAdditionalMicros = 0.5; },
    p => { delete p.version; }, p => { p.source = "https://example.com"; }, p => { p.effectiveAt = "unknown"; },
    p => { p.successfulResponseMicros = 0; }, p => { p.parameterRates = { parameter: "status", rates: { failed: 0 } }; },
    p => { p.errorCode = "invented_violation"; }, p => { p.failedResponseMicros = 0; },
  ]) {
    const manifest = fixture(); change(manifest.endpoints.responses.requestPricing);
    assert.throws(() => compile(manifest), /invalid manifest/);
  }
});

test("outcome tariff cannot leak to Chat, regional prices, controls or credential overrides", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://us-east-1.api.x.ai"; },
    m => { m.baseUrls.regional = "https://other.example"; }, m => { m.auth.schemes[0].header = "X-Api-Key"; },
    m => { m.auth.grantTransports = { api_key: { headers: { Authorization: "synthetic" } } }; },
    m => { m.adapter.injectHeaders = { Authorization: "synthetic" }; }, m => { m.adapter.injectQuery = { api_key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["Authorization"]; }, m => { m.endpoints.responses.headers = { Authorization: "synthetic" }; },
    m => { m.endpoints.responses.requestHeaders = ["Authorization"]; }, m => { m.endpoints.responses.auth = "none"; },
    m => { m.endpoints.responses.path = "/v1/chat/completions"; }, m => { m.endpoints.responses.method = "GET"; },
    m => { m.endpoints.responses.requestFormat = "openai.chat_completions"; }, m => { m.endpoints.responses.responseFormat = "openai.chat_completions"; },
    m => { m.capabilities.at(-1).id = "llm.chat"; m.models.entries[0].capabilities = ["llm.chat"]; }, m => { m.capabilities.at(-1).methods.push("GET"); },
    m => { m.endpoints.responses.query = { background: "true" }; }, m => { m.endpoints.responses.modelPassthrough = {}; },
    m => { m.endpoints.responses.websocket = "openai.responses"; }, m => { m.endpoints.responses.responsesLifecycle = { retrieve: "get", cancel: "cancel" }; },
  ]) {
    const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /requestPricing|invalid manifest/, String(change));
  }
});

test("admission adds the possible outcome fee to real inference bounds and rejects overflow or missing bounds", () => {
  const pricing = compile(fixture()).model_index["xai/grok-4.3"].pricing;
  const inference = estimateModelCost(pricing, { input: "synthetic", max_output_tokens: 10 }, { request_format: "openai.responses" });
  assert.equal(requestOutcomeReserve(tariff, inference.reserveMicros), inference.reserveMicros + 50000);
  assert.equal(requestOutcomeReserve(tariff, 0), 50000);
  assert.equal(requestOutcomeReserve(tariff, Number.MAX_SAFE_INTEGER - 50000), Number.MAX_SAFE_INTEGER);
  for (const bound of [null, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER - 49999, "100"])
    assert.equal(requestOutcomeReserve(tariff, bound), null);
  for (const changed of [{ outcome: "unknown" }, { maximumAdditionalMicros: 0 }, { receipt: "other" }, { unit: "credit" }])
    assert.equal(requestOutcomeReserve({ ...tariff, ...changed }, 100), null);
});

test("opt-in outcome admission preserves the full output bound despite visible-output limits", () => {
  const pricing = compile(fixture()).model_index["xai/grok-4.3"].pricing;
  const endpoint = { request_format: "openai.responses" };
  for (const limits of [{ max_output_tokens: 1 }, { max_tokens: 1, max_completion_tokens: 1 }, { n: 0 }, {}]) {
    const body = { input: "synthetic", ...limits };
    const estimate = estimateModelCost(pricing, body, endpoint, tariff);
    const fullOutput = estimateModelCost(pricing, { ...body, max_output_tokens: pricing.defaultMaxOutputTokens, n: 1 }, endpoint);
    assert.equal(estimate.outputTokens, pricing.defaultMaxOutputTokens);
    // Input byte estimates differ with controls; calculate using the actual
    // estimated input and the compiled rates, not a second request's bytes.
    const inference = Math.ceil(estimate.inputTokens * pricing.inputMicrosPerMillion / 1e6)
      + Math.ceil(pricing.defaultMaxOutputTokens * pricing.outputMicrosPerMillion / 1e6);
    assert.equal(estimate.reserveMicros, inference + 50000);
    assert.equal(fullOutput.outputTokens, estimate.outputTokens);
  }
  assert.equal(estimateModelCost(pricing, {}, { request_format: "openai.chat_completions" }, tariff).pricingAvailable, false);
  assert.equal(estimateModelCost(pricing, {}, endpoint, { ...tariff, maximumAdditionalMicros: 0 }).pricingAvailable, false);
  const overflow = { ...pricing, defaultMaxOutputTokens: 1_000_000, inputMicrosPerMillion: Number.MAX_SAFE_INTEGER, outputMicrosPerMillion: Number.MAX_SAFE_INTEGER };
  assert.equal(estimateModelCost(overflow, {}, endpoint, tariff).pricingAvailable, false);
});

test("native cost ticks settle the whole bill with upward micro rounding and no inferred violation surcharge", () => {
  for (const ticks of [0, 1, 9999, 10000, 10001, 158500, 500000000, 500000001, Number.MAX_SAFE_INTEGER]) {
    const expected = Number((BigInt(ticks) + 9999n) / 10000n);
    assert.deepEqual(requestOutcomeCost(tariff, response(ticks), true), { costMicros: expected, basis: "provider_reported", pricingVersion: tariff.version });
  }
  const incomplete = response(500000001); incomplete.status = "incomplete";
  assert.equal(requestOutcomeCost(tariff, incomplete, true).costMicros, 50001, "a complete truncated generation can still have a bill");
  const refusal = response(158500); refusal.output = [{ type: "message", content: [{ type: "refusal", refusal: "synthetic refusal" }] }];
  assert.equal(requestOutcomeCost(tariff, refusal, true).costMicros, 16, "refusal content must not select a fee");
});

test("unknown errors and incomplete observations never prove a free failure or a charged violation", () => {
  for (const body of [
    { error: { code: "invalid_request", message: "synthetic" } },
    { error: { code: "invented_violation", message: "synthetic" }, usage: { cost_in_usd_ticks: 500000000 } },
    { status: 403, body: response(500000000) }, { ...response(0), status: "failed" }, { ...response(0), status: "in_progress" },
    { ...response(0), object: "chat.completion" }, { ...response(0), id: "" },
    { ...response(0), usage: { cost_in_nano_usd: 50000000 } },
    ...[undefined, null, -1, 0.5, "500000000", Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map(response),
  ]) assert.equal(requestOutcomeCost(tariff, body, true), null);
  assert.equal(requestOutcomeCost(tariff, response(500000000), false), null, "a running or cut-off cost must not release the reserve");
  assert.equal(requestOutcomeCost({ ...tariff, receipt: "unknown" }, response(0), true), null);
});

test("the new outcome component does not qualify hosted tools or caller JSON as priced execution", () => {
  const pricing = compile(fixture()).model_index["xai/grok-4.3"].pricing;
  // Isolate the independent tool check; actual runtime still sees request_fee.
  const tokenOnly = { ...pricing, unpricedCosts: [] };
  assert.equal(requestPricingGap(tokenOnly, { tools: [{ type: "web_search" }] }, "openai.responses"), "hosted_tool_fee");
  assert.equal(requestPricingGap(tokenOnly, { tools: [{ type: "function", name: "web_search", parameters: { properties: { violation: { type: "string" } } } }] }, "openai.responses"), null);
  assert.equal(requestPricingGap(tokenOnly, { input: JSON.stringify({ type: "web_search", status: 403 }) }, "openai.responses"), null);
});
