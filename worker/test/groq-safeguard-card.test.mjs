import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";
const { actualModelCost, estimateModelCost, requestPricingGap } = await import("../pricing.ts");
const { providerById } = await import("../providers.ts");
const { default: handler } = await import("../index.ts");
const source = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/groq.provider.yaml", import.meta.url), "utf8"))]);
const model = source.providers[0].models.find(value => value.id === "groq/gpt-oss-safeguard-20b");

test("Safeguard uses its frozen native identity while retired public Qwen has no priced alias", () => {
  assert.equal(model.upstream, "openai/gpt-oss-safeguard-20b");
  assert.deepEqual(model.capabilities, ["llm.chat"]);
  assert.deepEqual(model.supportedReasoningEfforts, ["low", "medium", "high"]);
  const facts = model.nativeCapabilities.endpoints.chat_completions;
  assert.deepEqual(facts.input, ["text"]); assert.equal(facts.contextWindow, 131072); assert.equal(facts.maxOutputTokens, 65536);
  assert.equal(facts.checkedAt, "2026-11-03");
  assert.equal(source.providers[0].models[0].id, "groq/gpt-oss-120b");
  assert.ok(!source.providers[0].models.some(value => value.upstream.startsWith("qwen/")));
  assert.equal(source.providers[0].endpoints[0].modelPassthrough.pricing, null);
});

test("Safeguard cache upper bound and explicit tiers preserve priced plain calls without qualifying hosted execution", () => {
  const pricing = model.pricing, tokens = { input: 1000, output: 100, cached: 500, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
  assert.equal(pricing.settlementBasis, "published_upper_bound");
  assert.deepEqual([pricing.inputMicrosPerMillion, pricing.cachedInputMicrosPerMillion, pricing.outputMicrosPerMillion], [75000, 37500, 300000]);
  assert.equal(pricing.unpricedCosts, undefined);
  for (const service_tier of [undefined, "on_demand", "flex"]) {
    assert.notEqual(estimateModelCost(pricing, { service_tier, max_tokens: 1 }).pricingAvailable, false);
    assert.equal(actualModelCost(pricing, { ...tokens, serviceTier: service_tier ?? "on_demand" }), 87);
  }
  for (const service_tier of ["auto", "performance", "future"]) {
    assert.equal(estimateModelCost(pricing, { service_tier }).pricingAvailable, false);
    assert.equal(actualModelCost(pricing, { ...tokens, serviceTier: service_tier }), null);
  }
  assert.equal(requestPricingGap(pricing, { tools: [{ type: "function", function: { name: "browser_search", parameters: { const: { type: "code_interpreter" } } } }], messages: [{ role: "user", content: '{"type":"browser_search"}' }] }, "openai.chat_completions"), null);
  for (const type of ["browser_search", "code_interpreter"]) assert.equal(requestPricingGap(pricing, { tools: [{ type }] }, "openai.chat_completions"), "hosted_tool_fee");
});

test("real Worker dispatches Safeguard once and rejects unqualified hosted tools and tiers before reservation", async t => {
  const provider = providerById("groq");
  provider.models.push(model);
  try {
    for (const [extra, allowed] of [[{}, true], [{ service_tier: "flex" }, true],
      [{ tools: [{ type: "function", function: { name: "code_interpreter", parameters: { type: "object" } } }] }, true],
      [{ tools: [{ type: "browser_search" }] }, false], [{ tools: [{ type: "code_interpreter" }] }, false],
      [{ service_tier: "auto" }, false], [{ service_tier: "performance" }, false]]) {
      const env = usageEnv([], { provider: "groq", limit: 1000000, fixedCost: null, retainContent: false, budgetMode: "reserve",
        serviceTiers: { allowed: ["default", "flex", "performance"], models: {} } });
      const ledger = sqlBudgetNamespace(t), pending = [], events = [];
      Object.assign(env, { GROQ_API_KEY: "fixture-groq-key", BUDGET_LEDGER: ledger, USAGE_QUEUE: { send: async event => events.push(event) } });
      const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
        assert.equal(String(url), "https://api.groq.com/openai/v1/chat/completions");
        const body = JSON.parse(init.body); assert.equal(body.model, model.upstream);
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-groq-key");
        return Response.json({ id: "fixture", object: "chat.completion", model: body.model, service_tier: body.service_tier ?? "on_demand",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "fixture" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 500 } } });
      });
      try {
        const response = await handler.fetch(new Request("https://router.example/v1/chat/completions", { method: "POST",
          headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
          body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "x".repeat(1000) }], max_completion_tokens: 100, ...extra }),
        }), env, { waitUntil: promise => pending.push(promise) });
        assert.equal(response.status, allowed ? 200 : 400, JSON.stringify(extra));
        const body = await response.json();
        if (!allowed) assert.equal(body.error.code, "pricing_required");
        await Promise.all(pending);
        assert.equal(upstream.mock.callCount(), allowed ? 1 : 0);
        if (allowed) {
          assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 87);
          assert.equal(events[0].cost_basis, "manifest_rate_upper_bound");
        } else assert.equal(ledger.get("provider:groq").reservations().length, 0);
      } finally { upstream.mock.restore(); }
    }
  } finally { provider.models.splice(provider.models.indexOf(model), 1); }
});
