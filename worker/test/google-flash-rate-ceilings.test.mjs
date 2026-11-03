import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { estimateCost, createProxyAccounting } = await import("../proxy-accounting.ts");
const { actualModelCost } = await import("../pricing.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const snapshot = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"))]);
const provider = snapshot.providers[0], endpoint = provider.endpoints.find(value => value.id === "generate_content");
const models = ["gemini-3.6-flash", "gemini-3.8-flash"].map(id => provider.models.find(model => model.upstream === id));
const body = { contents: [{ parts: [{ text: "fixture" }] }], generationConfig: { maxOutputTokens: 100 } };
const tokens = { input: 1000, output: 100, total: 1100, cached: 500, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, serviceTier: "standard" };

test("Flash ceilings preserve exact native identities and do not synthesize alias or retired offers", () => {
  assert.equal(provider.models[0].upstream, "gemini-3.5-flash");
  for (const model of models) for (const selected of provider.endpoints) {
    const request = prepareManifestRequest(provider, selected, body, { model: model.upstream }, {}, true);
    assert.equal(request.model.id, model.id);
    assert.equal(request.pathParams.model, model.upstream);
    assert.deepEqual(request.body, body);
    assert.deepEqual(model.nativeCapabilities.endpoints[selected.id].input, ["text", "image", "video", "audio"]);
    assert.equal(model.nativeCapabilities.endpoints[selected.id].contextWindow, 1048576);
    assert.equal(model.nativeCapabilities.endpoints[selected.id].maxOutputTokens, 65536);
    assert.equal(model.pricing.settlementBasis, "published_upper_bound");
    assert.deepEqual(snapshot.model_index[model.id].pricing, model.pricing);
  }
  for (const name of ["gemini-3.7-flash", "veo-3.1-generate-preview", "veo-3.1-fast-generate-preview", "veo-3.1-lite-generate-preview"])
    assert.equal(snapshot.model_index[`google/${name}`], undefined);
});

test("Flash rates bound both published price periods while cache and served-tier arithmetic stay explicit", () => {
  const published = [["standard", 1.5, 0.15, 7.5, 1575], ["flex", 0.75, 0.075, 3.75, 788], ["priority", 2.7, 0.27, 13.5, 2835]];
  for (const model of models) for (const [tier, input, cached, output, expected] of published) {
    const measured = actualModelCost(model.pricing, { ...tokens, serviceTier: tier }, endpoint.request_format);
    assert.equal(measured, expected);
    for (const factor of [0.5, 1]) assert.ok(measured >= Math.ceil((500 * input + 500 * cached + 100 * output) * factor));
    const media = { contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: "Zml4dHVyZQ==" } }] }], serviceTier: tier };
    const cost = estimateCost(model, media, null, "llm.generate", endpoint);
    assert.equal(cost.inputTokens, 1048576);
    assert.equal(cost.outputTokens, 65536);
    const full = actualModelCost(model.pricing, { ...tokens, input: 1048576, cached: 0, output: 65536, serviceTier: tier }, endpoint.request_format);
    assert.ok(cost.reserveMicros >= full);
    assert.equal(actualModelCost(model.pricing, { ...tokens, serviceTier: "future" }, endpoint.request_format), null);
  }
});

test("Flash settlement labels measured rate ceilings and retains reservations for missing usage", async () => {
  for (const model of models) for (const observed of [tokens, null]) {
    const events = [], pending = [];
    const owner = createProxyAccounting({ env: { USAGE_QUEUE: { send: async event => events.push(event) } },
      context: { waitUntil: promise => pending.push(promise) }, auth: { policyId: "fixture", policy: {} },
      selection: { provider, endpoint, model, body, capability: "llm.generate" },
      request: correlateIngressRequest(new Request("https://router.example/v1/proxy/google-gemini/generate_content")).request });
    const reservation = { reservations: [], reservedMicros: owner.cost.reserveMicros };
    assert.equal(await owner.settle(200, "success", true, observed, reservation, null), true);
    await Promise.all(pending);
    assert.equal(events.length, 1);
    assert.equal(events[0].cost_basis, observed ? "manifest_rate_upper_bound" : "manifest_reservation");
    assert.equal(events[0].actual_cost_micros, observed ? 1575 : reservation.reservedMicros);
  }
});

test("published Flash ceilings cannot qualify hosted fees, stored context or unknown request tiers", () => {
  for (const model of models) for (const [policyLimit, providerLimit] of [[100000000, null], [null, 100000000]]) {
    const connection = { providerId: provider.id, monthlyBudgetMicros: providerLimit };
    assert.equal(validateBudgetReservation("llm.generate", estimateCost(model, body, null, "llm.generate", endpoint), policyLimit, connection), true);
    for (const extra of [{ tools: [{ googleSearch: {} }] }, { tools: [{ code_execution: {} }] }, { cachedContent: "cachedContents/fixture" }, { serviceTier: "future" }]) {
      const unknown = estimateCost(model, { ...body, ...extra }, null, "llm.generate", endpoint);
      assert.throws(() => validateBudgetReservation("llm.generate", unknown, policyLimit, connection), error => error.code === "pricing_required");
      const fixed = estimateCost(model, { ...body, ...extra }, 0, "llm.generate", endpoint);
      assert.equal(fixed.basis, "policy_fixed");
      assert.equal(validateBudgetReservation("llm.generate", fixed, policyLimit, connection), true);
    }
  }
});
