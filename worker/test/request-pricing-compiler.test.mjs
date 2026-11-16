import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const source = parse(readFileSync(new URL("../../providers/perplexity.provider.yaml", import.meta.url), "utf8"));
function fixture() {
  const manifest = structuredClone(source);
  manifest.capabilities.push({ id: "web.search", endpoint: "search", methods: ["POST"] });
  manifest.endpoints.search = { path: "/search", requestFormat: "perplexity.search", responseFormat: "perplexity.search", requestPricing: {
    unit: "request", version: "perplexity-search-2026-11-03", effectiveAt: "2026-11-03", source: "https://docs.perplexity.ai/docs/getting-started/pricing",
    successfulResponseMicros: 5000, parameterRates: { parameter: "search_type", rates: { web: 5000, fast: 1000 } },
  } };
  return manifest;
}
const tariff = manifest => manifest.endpoints.search.requestPricing;
const compile = manifest => compileProviderSnapshot([manifest]);

test("successful-request rates preserve units, provenance and native selection separately from model prices", () => {
  const manifest = fixture(), snapshot = compile(manifest), search = snapshot.providers[0].endpoints.find(e => e.id === "search");
  assert.deepEqual(search.requestPricing, tariff(manifest));
  assert.deepEqual(snapshot.model_index["perplexity/sonar-pro"].pricing.unpricedCosts, ["request_fee"]);
  assert.equal(search.modelPassthrough, undefined);
  tariff(manifest).parameterRates.rates.fast = 0;
  assert.equal(search.requestPricing.parameterRates.rates.fast, 1000, "compiled tariff must not alias mutable source");
  assert.ok(compile(source).providers[0].endpoints.every(e => e.requestPricing === undefined), "the contract alone activates no tariff");
});

test("request tariffs reject unknown units, incomplete provenance and unsafe amounts", () => {
  for (const change of [
    p => { p.unit = "credit"; }, p => { delete p.version; }, p => { p.source = "file:///fixture"; },
    p => { p.successfulResponseMicros = -1; }, p => { p.successfulResponseMicros = 0.5; }, p => { p.successfulResponseMicros = Number.MAX_SAFE_INTEGER + 1; },
    p => { p.effectiveAt = "unknown"; }, p => { p.unknownOutcome = "free"; },
    p => { p.parameterRates.rates.fast = -1; }, p => { p.parameterRates.rates.fast = "1000"; },
    p => { p.parameterRates.rates = {}; }, p => { p.parameterRates.parameter = "tools[0].type"; },
  ]) {
    const manifest = fixture(); change(tariff(manifest)); assert.throws(() => compile(manifest), /invalid manifest/);
  }
});

test("request tariffs cannot borrow a token, async, streaming or unqualified protocol's billing semantics", () => {
  for (const change of [
    m => { m.id = "other-provider"; }, m => { m.endpoints.search.path = "/other"; },
    m => { m.endpoints.search.requestFormat = "openai.responses"; }, m => { m.endpoints.search.responseFormat = "openai.responses"; },
    m => { m.endpoints.search.method = "GET"; }, m => { m.capabilities.at(-1).methods.push("GET"); },
    m => { m.capabilities.at(-1).id = "llm.chat"; }, m => { m.endpoints.search.streaming = "sse"; },
    m => { m.endpoints.search.modelPassthrough = {}; }, m => { m.endpoints.search.responsesLifecycle = { retrieve: "get", cancel: "cancel" }; },
    m => { m.endpoints.search.websocket = "openai.responses"; }, m => { m.endpoints.search.query = { search_type: "fast" }; },
    m => { tariff(m).parameterRates.parameter = "model"; }, m => { tariff(m).parameterRates.rates.future = 0; },
    m => { tariff(m).parameterRates.rates.web = 0; }, m => { delete tariff(m).parameterRates; },
    m => { delete tariff(m).parameterRates.rates.fast; },
  ]) {
    const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /requestPricing/);
  }
});
