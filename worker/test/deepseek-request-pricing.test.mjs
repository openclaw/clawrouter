import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Validator } from "@cfworker/json-schema";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { deepSeekSearchReserve, requestOutcomeCost } = await import("../pricing.ts");
const { deepSeekSearchTariff, prepareDeepSeekSearch, readDeepSeekSearch } = await import("../deepseek-search.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const schema = JSON.parse(readFileSync(new URL("../../providers/_schema/service-provider.schema.json", import.meta.url)));
const validator = new Validator(schema.$defs.deepSeekSearchRequestPricing);
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/deepseek/search.json", import.meta.url)));
const source = parse(readFileSync(new URL("../../providers/deepseek.provider.yaml", import.meta.url), "utf8"));
const tariff = {
  unit: "request", protocol: "deepseek.search", version: "deepseek-search-2026-11-01",
  effectiveAt: "2026-11-01T00:00:00+08:00", source: "https://api-docs.deepseek.com/guides/search/",
  successfulNonemptyRequestMicros: 750, emptyRequestMicros: 0,
};
function fixture() {
  const manifest = structuredClone(source);
  manifest.capabilities = manifest.capabilities.filter(value => value.endpoint !== "search");
  manifest.capabilities.push({ id: "search.web", endpoint: "search", methods: ["POST"] });
  manifest.endpoints.search = { method: "POST", path: "/v1/tools/search", requestFormat: "deepseek.search", responseFormat: "deepseek.search" };
  return manifest;
}

test("DeepSeek tariff definition matches the published native request fee and maximum dispatch reserve", () => {
  assert.equal(validator.validate(tariff).valid, true);
  for (const key of ["source", "effectiveAt", "successfulNonemptyRequestMicros", "emptyRequestMicros"]) {
    assert.equal(tariff[key], deepSeekSearchTariff[key]);
  }
  assert.equal(deepSeekSearchReserve(tariff), 750);
});

test("DeepSeek fee qualification rejects altered provenance, rates, versions and extra authority", () => {
  for (const value of [null, [], {}, ...[
    { protocol: "perplexity.search" }, { unit: "token" }, { version: "" }, { version: "a".repeat(129) },
    { version: "invalid version" }, { effectiveAt: "2026-11-01" }, { source: "https://example.com/rates" },
    { successfulNonemptyRequestMicros: 0 }, { successfulNonemptyRequestMicros: 751 }, { emptyRequestMicros: 750 },
    { successfulNonemptyRequestMicros: "750" }, { billableRequests: 0 }, { receipt: "caller" },
    { parameterRates: { parameter: "count", rates: { 1: 750 } } },
  ].map(delta => ({ ...tariff, ...delta }))]) {
    assert.equal(validator.validate(value).valid, false, JSON.stringify(value));
    assert.equal(deepSeekSearchReserve(value), null, JSON.stringify(value));
  }
});

test("dispatch reserve is independent of requested count and native empty or filtered output", async () => {
  for (const count of [1, 5, 10]) {
    const request = prepareDeepSeekSearch({ ...wire.request.body, count });
    for (const [body, billableRequests] of [[wire.empty, 0], [wire.response, 1], [wire.filtered, 1]]) {
      const observed = await readDeepSeekSearch(Response.json(body), request);
      assert.equal(observed.billableRequests, billableRequests);
      if (body === wire.filtered) assert.equal(observed.results.length, 0);
      // A future settlement observation does not change the pre-dispatch maximum.
      assert.equal(deepSeekSearchReserve(tariff), 750);
    }
  }
});

test("a frozen tariff copy retains its version and reserve after source mutation", () => {
  const manifestValue = structuredClone(tariff), admitted = Object.freeze(structuredClone(manifestValue));
  manifestValue.version = "changed"; manifestValue.successfulNonemptyRequestMicros = 0;
  assert.equal(admitted.version, tariff.version);
  assert.equal(deepSeekSearchReserve(admitted), 750);
  assert.equal(deepSeekSearchReserve(manifestValue), null);
  // This is a pure value test; shared admission must establish the actual freeze.
});

test("unknown or interrupted native observations do not lower the dispatch bound", async () => {
  for (const response of [Response.json({ error: { code: "synthetic" } }), Response.json({}, { status: 500 }),
    new Response('{"results":[', { headers: { "content-type": "application/json" } })]) {
    await assert.rejects(() => readDeepSeekSearch(response, prepareDeepSeekSearch(wire.request.body)));
    assert.equal(deepSeekSearchReserve(tariff), 750);
  }
});

test("definition-only tariff does not activate compiler or hard-dollar admission", () => {
  const manifest = fixture(), provider = compileProviderSnapshot([manifest]).providers[0];
  const endpoint = provider.endpoints.find(value => value.id === "search");
  assert.equal(endpoint.requestPricing, undefined);
  manifest.endpoints.search.requestPricing = structuredClone(tariff);
  assert.throws(() => compileProviderSnapshot([manifest]), /requestPricing|invalid manifest/);
  // Even an injected unqualified tariff must not bypass the existing early guard.
  for (const selected of [endpoint, { ...endpoint, requestPricing: tariff }]) {
    const cost = estimateCost(null, wire.request.body, null, "search.web", selected);
    assert.equal(cost.requestTariff, undefined);
    for (const [caller, providerLimit] of [[10000, null], [null, 10000]]) {
      assert.throws(() => validateBudgetReservation("search.web", cost, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
    }
    for (const fixed of [0, 17]) assert.deepEqual(estimateCost(null, wire.request.body, fixed, "search.web", selected), {
      reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null,
    });
  }
});

test("existing provider-reported receipts remain distinct from a manifest request rate", () => {
  const pricing = { unit: "request", version: "xai-responses-outcome-2026-11-03", effectiveAt: "2026-11-03",
    source: "https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee", outcome: "xai.responses_violation",
    maximumAdditionalMicros: 50000, receipt: "xai.usage.cost_in_usd_ticks" };
  const body = { id: "synthetic", object: "response", status: "completed", usage: { cost_in_usd_ticks: 7500000 } };
  assert.deepEqual(requestOutcomeCost(pricing, body, true), { costMicros: 750, basis: "provider_reported", pricingVersion: pricing.version });
  assert.equal(requestOutcomeCost(tariff, body, true), null);
});
