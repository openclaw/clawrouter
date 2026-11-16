import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");
const { providerById } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { actualModelCost } = await import("../pricing.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const source = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"))]);
const provider = source.providers[0], endpoint = provider.endpoints.find(row => row.id === "generate_content");
const amounts = { "gemini-3.5-flash-lite": [415, 210, 745] };
const models = Object.keys(amounts).map(id => provider.models.find(model => model.upstream === id));
const plain = { contents: [{ role: "user", parts: [{ text: "fixture" }] }] };
const tokens = { input: 1000, cached: 500, output: 100, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

test("the frozen Gemini 3.5 Flash-Lite identity retains native selection, qualified bounds and the original default", () => {
  assert.equal(provider.models[0].upstream, "gemini-3.5-flash");
  for (const model of models) for (const id of ["generate_content", "stream_generate_content"]) {
    const route = provider.endpoints.find(row => row.id === id), facts = model.nativeCapabilities.endpoints[id];
    const body = { ...plain, tools: [{ functionDeclarations: [{ name: "googleSearch", parameters: { type: "OBJECT" } }] }] };
    const selected = prepareManifestRequest(provider, route, body, { model: model.upstream }, {}, true);
    assert.equal(selected.model.id, model.id); assert.equal(selected.pathParams.model, model.upstream);
    assert.deepEqual(selected.body, body); assert.equal(Object.hasOwn(selected.body, "model"), false);
    assert.deepEqual(facts.input, ["text", "image", "video", "audio"]);
    assert.equal(facts.contextWindow, 1048576); assert.equal(facts.maxOutputTokens, 65536);
    assert.equal(facts.checkedAt, "2026-11-04");
    assert.equal(model.availability, undefined);
    assert.equal(facts.supportedServiceTiers, undefined, "Google tier prices do not extend the OpenAI-only discovery field");
    assert.equal(model.pricing.settlementBasis, undefined);
    assert.deepEqual(source.model_index[model.id].pricing, model.pricing);
    if (id === "stream_generate_content") assert.deepEqual(route.query, { alt: "sse" });
  }
});

test("Gemini 3.5 Flash-Lite published tiers preserve exact cache rates and bound native media input", () => {
  for (const model of models) {
    for (const [index, serviceTier] of ["standard", "flex", "priority"].entries()) {
      assert.equal(actualModelCost(model.pricing, { ...tokens, serviceTier }, endpoint.request_format), amounts[model.upstream][index]);
      const media = { contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: "Zml4dHVyZQ==" } }] }],
        serviceTier, generationConfig: { maxOutputTokens: 100, candidateCount: 2 } };
      const estimate = estimateCost(model, media, null, "llm.generate", endpoint);
      assert.equal(estimate.basis, "manifest_pricing");
      assert.equal(estimate.inputTokens, 1048576); assert.equal(estimate.outputTokens, 200);
      const actual = actualModelCost(model.pricing, { ...tokens, input: 1048576, cached: 0, output: 200, serviceTier }, endpoint.request_format);
      assert.ok(actual !== null && estimate.reserveMicros >= actual);
    }
    assert.equal(actualModelCost(model.pricing, { ...tokens, serviceTier: "future" }, endpoint.request_format), null);
  }
  for (const model of models) {
    const [standard, flex] = model.pricing.serviceTiers;
    assert.equal(standard.cachedInputMicrosPerMillion, 30000);
    assert.equal(flex.cachedInputMicrosPerMillion, 20000);
    assert.equal(model.pricing.serviceTiers[2].cachedInputMicrosPerMillion, 50000);
    assert.equal(flex.inputMicrosPerMillion, standard.inputMicrosPerMillion / 2);
  }
});

test("Gemini 3.5 Flash-Lite plain client functions stay priced while hosted tools, explicit stored context and unknown tiers remain closed", () => {
  for (const model of models) {
    const body = { ...plain, tools: [{ functionDeclarations: [{ name: "googleSearch", parameters: { type: "OBJECT", properties: { codeExecution: { type: "STRING" } } } }] }] };
    const known = estimateCost(model, body, null, "llm.generate", endpoint);
    for (const [limit, providerLimit] of [[100000000, null], [null, 100000000]]) {
      const connection = { providerId: provider.id, monthlyBudgetMicros: providerLimit };
      assert.equal(validateBudgetReservation("llm.generate", known, limit, connection), true);
      for (const extra of [{ tools: [{ googleSearch: {} }] }, { tools: [{ code_execution: {} }] },
        { cachedContent: "cachedContents/fixture" }, { serviceTier: "contributor" }, { service_tier: "future" }]) {
        const request = { ...plain, ...extra };
        assert.throws(() => validateBudgetReservation("llm.generate", estimateCost(model, request, null, "llm.generate", endpoint), limit, connection), error => error.code === "pricing_required");
        const fixed = estimateCost(model, request, 17, "llm.generate", endpoint);
        assert.equal(fixed.basis, "policy_fixed"); assert.equal(fixed.reserveMicros, 17);
      }
    }
  }
});

for (const model of models) for (const manifest of [false, true]) {
  test(`${model.upstream} actual ${manifest ? "manifest" : "native"} JSON/SSE dispatch settles the qualified served-tier rate`, async t => {
    const live = providerById("google-gemini"), previous = live.models;
    live.models = provider.models; t.after(() => { live.models = previous; });
    for (const [index, serviceTier] of ["standard", "flex", "priority"].entries()) {
      const stream = index !== 0, pending = [], events = [], env = usageEnv([], {
        provider: "google-gemini", limit: 10000000, fixedCost: null, retainContent: false, budgetMode: "reserve" });
      env.GOOGLE_API_KEY = "synthetic-original"; env.BUDGET_LEDGER = sqlBudgetNamespace(t);
      env.USAGE_QUEUE = { async send(event) { events.push(event); } };
      const body = { ...plain, serviceTier, generationConfig: { maxOutputTokens: 100 } };
      const final = { modelVersion: model.upstream, candidates: [{ finishReason: "STOP", content: { parts: [{ text: "fixture" }] } }],
        usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 500, candidatesTokenCount: 90,
          thoughtsTokenCount: 10, totalTokenCount: 1100, serviceTier } };
      const wire = stream ? sse(final) : JSON.stringify(final);
      const path = `/v1beta/models/${model.upstream}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
        assert.equal(String(url), `https://generativelanguage.googleapis.com${path}`);
        assert.equal(new Headers(init.headers).get("x-goog-api-key"), "synthetic-original");
        assert.deepEqual(JSON.parse(init.body), body);
        return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
      });
      try {
        const route = manifest ? `/v1/proxy/google-gemini/${stream ? "stream_generate_content" : "generate_content"}` : `/v1/native/google-gemini${path}`;
        const response = await handler.fetch(new Request(`https://router.example${route}`, { method: "POST",
          headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
          body: JSON.stringify(manifest ? { body, pathParams: { model: model.upstream }, query: stream ? { alt: "sse" } : {} } : body),
        }), env, { waitUntil: promise => pending.push(promise) });
        assert.equal(response.status, 200, await response.clone().text()); assert.equal(await response.text(), wire);
        await Promise.all(pending); assert.equal(upstream.mock.callCount(), 1); assert.equal(events.length, 1);
        assert.equal(events[0].actual_cost_micros, amounts[model.upstream][index]);
        assert.equal(events[0].cost_basis, "manifest_pricing"); assert.equal(events[0].served_service_tier, serviceTier);
        assert.equal(events[0].input_tokens, 1000); assert.equal(events[0].output_tokens, 100);
      } finally { upstream.mock.restore(); }
    }
  });
}
