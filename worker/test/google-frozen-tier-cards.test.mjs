import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { actualModelCost } = await import("../pricing.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const manifest = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([manifest]), provider = snapshot.providers[0];
const models = ["gemini-3.5-flash-lite", "gemini-3.1-pro-preview"].map(id => provider.models.find(model => model.upstream === id));
const endpoint = provider.endpoints.find(value => value.id === "generate_content");
const format = endpoint.request_format;
const plain = { contents: [{ role: "user", parts: [{ text: "fixture" }] }] };
const tokens = { input: 1000, cached: 500, output: 100, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

test("frozen Gemini rows select exact native path models and preserve thinking, tools and stream facts", () => {
  assert.equal(provider.models[0].upstream, "gemini-3.5-flash", "existing default stays first");
  for (const model of models) for (const selected of provider.endpoints) {
    const body = { ...plain, generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } }, tools: [{ functionDeclarations: [{ name: "googleSearch", parameters: { type: "OBJECT" } }] }] };
    const request = prepareManifestRequest(provider, selected, body, { model: model.upstream }, {}, true);
    assert.equal(request.model.id, model.id);
    assert.equal(request.pathParams.model, model.upstream);
    assert.deepEqual(request.body, body, "native body and function declarations stay untouched");
    assert.equal(Object.hasOwn(request.body, "model"), false);
    assert.deepEqual(model.nativeCapabilities.endpoints[selected.id].input, ["text", "image", "video", "audio"]);
    assert.equal(model.nativeCapabilities.endpoints[selected.id].contextWindow, 1048576);
    assert.equal(model.nativeCapabilities.endpoints[selected.id].maxOutputTokens, 65536);
    assert.deepEqual(snapshot.model_index[model.id].pricing, model.pricing);
    if (selected.id === "stream_generate_content") assert.deepEqual(selected.query, { alt: "sse" });
  }
});

test("Gemini served tiers use published cache prices and Pro changes at the exact long-context boundary", () => {
  for (const [model, amounts] of [[models[0], [415, 210, 745]], [models[1], [2300, 1200, 4140]]]) {
    for (const [index, tier] of ["standard", "flex", "priority"].entries()) {
      assert.equal(actualModelCost(model.pricing, { ...tokens, serviceTier: tier }, format), amounts[index]);
    }
    assert.equal(actualModelCost(model.pricing, { ...tokens, serviceTier: "future" }, format), null);
  }
  const pro = models[1].pricing;
  for (const [tier, short, long] of [["standard", 232000, 458004], ["flex", 126000, 249002], ["priority", 417600, 824408]]) {
    const counts = { ...tokens, input: 200000, cached: 100000, output: 1000, serviceTier: tier };
    assert.equal(actualModelCost(pro, counts, format), short);
    assert.equal(actualModelCost(pro, { ...counts, input: 200001 }, format), long);
  }
});

test("Gemini media reservations cover the full input ceiling and native candidate output bounds", () => {
  for (const model of models) for (const tier of ["standard", "flex", "priority"]) {
    for (const part of [{ inlineData: { mimeType: "audio/wav", data: "Zml4dHVyZQ==" } }, { file_data: { mime_type: "video/mp4", file_uri: "https://example.com/fixture.mp4" } }]) {
      const body = { contents: [{ parts: [part] }], serviceTier: tier, generationConfig: { maxOutputTokens: 100, candidateCount: 2 } };
      const cost = estimateCost(model, body, null, "llm.generate", endpoint);
      assert.equal(cost.basis, "manifest_pricing");
      assert.equal(cost.inputTokens, 1048576);
      assert.equal(cost.outputTokens, 200);
      const actual = actualModelCost(model.pricing, { ...tokens, input: 1048576, cached: 0, output: 200, serviceTier: tier }, format);
      assert.ok(actual !== null && cost.reserveMicros >= actual);
    }
    assert.equal(estimateCost(model, { ...plain, serviceTier: tier, max_tokens: 1 }, null, "llm.generate", endpoint).outputTokens, 65536, "Chat aliases cannot lower a native Gemini reservation");
  }
});

test("Gemini priced plain generation stays admitted while hosted tools, stored context and unknown tiers fail closed", () => {
  for (const model of models) {
    const ordinary = { ...plain, tools: [{ functionDeclarations: [{ name: "googleSearch", parameters: { type: "OBJECT", properties: { codeExecution: { type: "STRING" } } } }] }] };
    const priced = estimateCost(model, ordinary, null, "llm.generate", endpoint);
    assert.equal(priced.basis, "manifest_pricing");
    for (const [policyLimit, providerLimit] of [[100000000, null], [null, 100000000]]) {
      const connection = { providerId: provider.id, monthlyBudgetMicros: providerLimit };
      assert.equal(validateBudgetReservation("llm.generate", priced, policyLimit, connection), true);
      for (const fields of [{ tools: [{ googleSearch: {} }] }, { tools: [{ google_maps: {} }] }, { tools: [{ codeExecution: {} }] }, { cached_content: "cachedContents/fixture" }, { serviceTier: "contributor" }, { service_tier: "future" }]) {
        const body = { ...plain, ...fields };
        const unknown = estimateCost(model, body, null, "llm.generate", endpoint);
        assert.throws(() => validateBudgetReservation("llm.generate", unknown, policyLimit, connection), error => error.code === "pricing_required");
        const fixed = estimateCost(model, body, 25, "llm.generate", endpoint);
        assert.equal(fixed.basis, "policy_fixed");
        assert.equal(validateBudgetReservation("llm.generate", fixed, policyLimit, connection), true);
      }
    }
  }
});
