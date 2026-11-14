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
const { actualModelCost, estimateModelCost } = await import("../pricing.ts");
const manifest = parse(readFileSync(new URL("../../providers/xai.provider.yaml", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([manifest]).providers[0];
const model = provider.models.find(row => row.upstream === "grok-4.3");
const endpoint = provider.endpoints.find(row => row.id === "chat_completions");
const usage = input => ({ input, cached: 100000, output: 1000, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

function requestBody(input, stream = false) {
  const body = { model: model.upstream, messages: [{ role: "user", content: "" }], max_tokens: 1000, stream };
  const envelope = new TextEncoder().encode(JSON.stringify(body)).length + model.pricing.inputTokenOverhead;
  body.messages[0].content = "x".repeat(input - envelope);
  return body;
}

test("Grok 4.3 settles cached and uncached usage at the published inclusive 200k boundary", () => {
  for (const [input, expected] of [[199999, 147499], [200000, 295000], [200001, 295003]]) {
    assert.equal(actualModelCost(model.pricing, usage(input), endpoint.request_format), expected);
  }
  // Other providers retain the shared exclusive-threshold contract.
  const exclusive = { ...model.pricing, longContext: { ...model.pricing.longContext, thresholdInputTokens: 200000 } };
  assert.equal(actualModelCost(exclusive, usage(200000), endpoint.request_format), 147500);
  assert.equal(actualModelCost(exclusive, usage(200001), endpoint.request_format), 295003);
});

test("Grok 4.3 admission includes long-context input and output rates from exactly 200k", () => {
  for (const [input, expected] of [[199999, 252499], [200000, 505000], [200001, 505003]]) {
    const estimate = estimateModelCost(model.pricing, requestBody(input), endpoint);
    assert.equal(estimate.inputTokens, input); assert.equal(estimate.outputTokens, 1000);
    assert.equal(estimate.reserveMicros, expected);
    assert.ok(estimate.reserveMicros >= actualModelCost(model.pricing, usage(input), endpoint.request_format));
  }
});

test("actual native and manifest Worker JSON/SSE account for the inclusive long-context tariff", async t => {
  const live = providerById("xai"), previous = live.models;
  live.models = provider.models; t.after(() => { live.models = previous; });
  for (const native of [false, true]) for (const stream of [false, true]) {
    const pending = [], events = [], env = usageEnv([], { provider: "xai", limit: 10000000, fixedCost: null, retainContent: false, budgetMode: "reserve" });
    env.XAI_API_KEY = "synthetic-original"; env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { async send(event) { events.push(event); } };
    const body = requestBody(200000, stream);
    const final = { id: "synthetic", object: stream ? "chat.completion.chunk" : "chat.completion", model: model.upstream,
      choices: [{ index: 0, finish_reason: "stop", ...(stream ? { delta: { content: "fixture" } } : { message: { role: "assistant", content: "fixture" } }) }],
      usage: { prompt_tokens: 200000, prompt_tokens_details: { cached_tokens: 100000 }, completion_tokens: 1000, total_tokens: 201000 } };
    const wire = stream ? sse(final, "[DONE]") : JSON.stringify(final);
    const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(String(url), "https://api.x.ai/v1/chat/completions");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-original");
      assert.deepEqual(JSON.parse(init.body), body);
      return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    });
    try {
      const path = native ? "/v1/native/xai/v1/chat/completions" : "/v1/proxy/xai/chat_completions";
      const response = await handler.fetch(new Request(`https://router.example${path}`, { method: "POST",
        headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, body: JSON.stringify(native ? body : { body }),
      }), env, { waitUntil: promise => pending.push(promise) });
      assert.equal(response.status, 200, await response.clone().text()); assert.equal(await response.text(), wire);
      await Promise.all(pending); assert.equal(upstream.mock.callCount(), 1); assert.equal(events.length, 1);
      assert.equal(events[0].actual_cost_micros, 295000); assert.equal(events[0].cost_basis, "manifest_pricing");
      assert.equal(events[0].input_tokens, 200000); assert.equal(events[0].output_tokens, 1000);
    } finally { upstream.mock.restore(); }
  }
});
