import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { actualModelCost, estimateModelCost, requestPricingGap } from "../pricing.ts";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";
import { providerById } from "../providers.ts";
const { default: handler } = await import("../index.ts");

const manifest = parse(readFileSync(new URL("../../providers/groq.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([manifest]);

test("Groq OSS20B exposes the sourced Chat limits and conservative cache tariff", () => {
  const model = snapshot.model_index["groq/gpt-oss-20b"];
  assert.equal(model.upstream, "openai/gpt-oss-20b");
  assert.deepEqual(model.capabilities, ["llm.chat"]);
  assert.deepEqual(model.supportedReasoningEfforts, ["low", "medium", "high"]);
  const facts = model.nativeCapabilities.endpoints.chat_completions;
  assert.deepEqual(facts.input, ["text"]);
  assert.equal(facts.contextWindow, 131072);
  assert.equal(facts.maxOutputTokens, 65536);
  assert.equal(facts.checkedAt, "2026-11-03");
  assert.deepEqual([model.pricing.inputMicrosPerMillion, model.pricing.cachedInputMicrosPerMillion, model.pricing.outputMicrosPerMillion], [75000, 37500, 300000]);
  assert.equal(model.pricing.settlementBasis, "published_upper_bound");
  assert.equal(snapshot.providers[0].endpoints[0].modelPassthrough.pricing, null);
});

test("Groq ordinary Chat and client functions stay priced while actual hosted tools fail closed", () => {
  for (const id of ["groq/gpt-oss-20b", "groq/gpt-oss-120b"]) {
    const pricing = snapshot.model_index[id].pricing;
    assert.equal(pricing.unpricedCosts, undefined);
    for (const body of [
      {},
      { messages: [{ role: "user", content: '{"type":"browser_search"}' }] },
      { functions: [{ name: "browser_search", parameters: { type: "object" } }] },
      { tools: [{ type: "function", function: { name: "code_interpreter", parameters: { type: "object", properties: { tool: { const: { type: "browser_search" } } } } } }] },
    ]) assert.equal(requestPricingGap(pricing, body, "openai.chat_completions"), null);
    for (const body of [
      { tools: [{ type: "browser_search" }] },
      { tools: [{ type: "code_interpreter" }] },
    ]) assert.equal(requestPricingGap(pricing, body, "openai.chat_completions"), "hosted_tool_fee");
    assert.equal(requestPricingGap(pricing, { tools: [{ type: "local_shell" }] }, "openai.chat_completions"), null);
    const tokens = { input: 1000, output: 100, cached: 0, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
    for (const service_tier of [undefined, "on_demand", "flex"]) {
      assert.notEqual(estimateModelCost(pricing, { service_tier, max_tokens: 1 }, { request_format: "openai.chat_completions" }).pricingAvailable, false);
      assert.ok(actualModelCost(pricing, { ...tokens, serviceTier: service_tier ?? "on_demand" }) > 0);
    }
    for (const service_tier of ["auto", "performance", "future", 7, {}]) {
      assert.equal(estimateModelCost(pricing, { service_tier }, { request_format: "openai.chat_completions" }).pricingAvailable, false);
      assert.equal(actualModelCost(pricing, { ...tokens, serviceTier: service_tier }), null);
    }
  }
});

test("automatic-tier exclusion requires a typed declaration and explicit tier cards", () => {
  const invalid = structuredClone(manifest), pricing = invalid.models.entries[0].pricing;
  pricing.autoServiceTier = "free";
  assert.throws(() => compileProviderSnapshot([invalid]), /invalid manifest/);
  pricing.autoServiceTier = "unpriced";
  delete pricing.serviceTiers;
  assert.throws(() => compileProviderSnapshot([invalid]), /autoServiceTier requires/);
});

test("real Worker preserves plain Groq hard-budget Chat and denies conditional gaps before egress", async t => {
  // Exercise current source pricing before the separately gated snapshot update.
  const model = providerById("groq").models.find(model => model.id === "groq/gpt-oss-120b"), original = model.pricing;
  model.pricing = snapshot.model_index[model.id].pricing;
  try {
    for (const [extra, expected] of [
      [{}, 200],
      [{ service_tier: "on_demand" }, 200],
      [{ service_tier: "flex" }, 200],
      [{ tools: [{ type: "function", function: { name: "browser_search", parameters: { type: "object" } } }] }, 200],
      [{ tools: [{ type: "browser_search" }] }, 400],
      [{ tools: [{ type: "code_interpreter" }] }, 400],
      [{ service_tier: "auto" }, 400],
      [{ service_tier: "performance" }, 400],
      [{ service_tier: "future" }, 400],
    ]) {
      const env = usageEnv([], { provider: "groq", limit: 1000000, fixedCost: null, retainContent: false, budgetMode: "reserve",
        serviceTiers: ["default", "on_demand", "flex", "auto", "performance", "future"] });
      const ledger = sqlBudgetNamespace(t), pending = [], events = [];
      Object.assign(env, { GROQ_API_KEY: "fixture-groq-key", BUDGET_LEDGER: ledger, USAGE_QUEUE: { send: async event => events.push(event) } });
      const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.model, "openai/gpt-oss-120b");
        return Response.json({ id: "fixture", object: "chat.completion", model: body.model, service_tier: body.service_tier ?? "on_demand",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, prompt_tokens_details: { cached_tokens: 0 } } });
      });
      try {
        const response = await handler.fetch(new Request("https://router.example/v1/chat/completions", { method: "POST",
          headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
          body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "hello" }], max_completion_tokens: 1, ...extra }),
        }), env, { waitUntil: promise => pending.push(promise) });
        assert.equal(response.status, expected, JSON.stringify(extra));
        const body = await response.json();
        if (expected === 400) assert.equal(body.error.code, "pricing_required");
        await Promise.all(pending);
        assert.equal(upstream.mock.callCount(), expected === 200 ? 1 : 0);
        if (expected === 200) assert.ok(events.some(event => event.actual_cost_micros > 0 && event.cost_basis === "manifest_pricing"));
        else assert.equal(ledger.get("provider:groq").reservations().length, 0);
      } finally { upstream.mock.restore(); }
    }
  } finally { model.pricing = original; }
});
