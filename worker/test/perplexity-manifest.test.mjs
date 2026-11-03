import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream, endpointForPath, upstreamPath, unifiedPathForEndpoint } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { operationAffordability } = await import("../operation-budget.ts");

const manifest = parse(readFileSync(new URL("../../providers/perplexity.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([manifest]), provider = snapshot.providers[0];
const env = { PERPLEXITY_API_KEY: "fixture-perplexity-key" };
const id = "perplexity/openai/gpt-5.6-sol";
const endpoint = name => provider.endpoints.find(endpoint => endpoint.id === name);

test("Perplexity Agent and Responses share the documented wire format without borrowing legacy Sonar prices", () => {
  const model = provider.models.find(model => model.id === id), auth = configuredUpstream(provider, null, env);
  assert.equal(endpointForPath(provider, "/v1/responses").id, "responses");
  assert.equal(unifiedPathForEndpoint(provider, endpoint("responses")), "/v1/responses");
  assert.equal(auth.headers.get("authorization"), "Bearer fixture-perplexity-key");
  for (const name of ["agent", "responses"]) {
    const e = endpoint(name);
    assert.equal(auth.baseUrl + upstreamPath(provider, e, {}, env, auth), `https://api.perplexity.ai/v1/${name}`);
    assert.equal(e.request_format, "openai.responses");
    assert.equal(e.response_format, "openai.responses");
    assert.equal(e.streaming, "sse");
    assert.equal(e.responsesLifecycle, undefined);
    assert.equal(e.modelPassthrough.pricing, null);
    const body = { model: id, input: "fixture", stream: true, instructions: "fixture instruction", tools: [{ type: "web_search" }] };
    assert.deepEqual(prepareManifestRequest(provider, e, body, {}, env).body, { ...body, model: "openai/gpt-5.6-sol" });
    const facts = model.nativeCapabilities.endpoints[name];
    assert.equal(facts.checkedAt, "2026-11-03");
    assert.equal(facts.contextWindow, undefined);
    assert.equal(facts.maxOutputTokens, undefined);
  }
  assert.equal(model.pricing, null);
  assert.deepEqual(model.capabilities, ["llm.responses"]);
  const sonar = snapshot.model_index["perplexity/sonar-pro"];
  assert.deepEqual(sonar.capabilities, ["llm.chat"]);
  assert.deepEqual(sonar.pricing.unpricedCosts, ["request_fee"]);
  assert.equal(sonar.nativeCapabilities, undefined);
  assert.throws(() => prepareManifestRequest(provider, endpoint("responses"), { model: "perplexity/sonar-pro", input: "fixture" }, {}, env), /does not support/);
});

test("native Search preserves its non-model request and keeps unqualified hard-budget calls closed", () => {
  const search = endpoint("search"), auth = configuredUpstream(provider, null, env);
  assert.equal(search.request_format, "perplexity.search");
  assert.equal(search.response_format, "perplexity.search");
  assert.equal(search.streaming, null);
  assert.equal(search.modelPassthrough, undefined);
  assert.equal(auth.baseUrl + upstreamPath(provider, search, {}, env, auth), "https://api.perplexity.ai/search");
  const body = { query: ["fixture one", "fixture two"], max_results: 5, search_type: "fast", max_tokens_per_page: 1024 };
  const prepared = prepareManifestRequest(provider, search, body, {}, env);
  assert.equal(prepared.model, null);
  assert.deepEqual(prepared.body, body);
  const identity = { policy: { monthlyBudgetMicros: 1000000, requestCostMicros: null, budgetMode: "reserve" } };
  const connection = { providerId: "perplexity", enabled: true, monthlyBudgetMicros: null };
  for (const [e, model, capability] of [[search, null, "web.search"], [endpoint("responses"), provider.models.find(model => model.id === id), "llm.responses"]]) {
    assert.deepEqual(operationAffordability(identity, connection, model, capability, e), { status: "exact-blocked", reasonCode: "pricing_required" });
  }
});
