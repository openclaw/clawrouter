import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";
const { estimateModelCost, actualModelCost } = await import("../pricing.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { providerById } = await import("../providers.ts");
const { default: handler } = await import("../index.ts");
const provider = providerById("google-gemini");
const model = provider.models.find(row => row.upstream === "gemini-3.5-flash");
const endpoint = provider.endpoints.find(row => row.id === "generate_content");
const original = { contents: [{ role: "user", parts: [{ text: "fixture" }] }], generationConfig: { maxOutputTokens: 100 } };

test("Google continuation tokens reserve restored context, independent of prompt/token bytes", () => {
  for (const field of ["continuationToken", "continuation_token"]) for (const token of ["eA==", "eA==".repeat(1000), "", {}]) {
    const cost = estimateModelCost(model.pricing, { ...original, [field]: token }, endpoint);
    assert.equal(cost.inputTokens, model.pricing.maxRequestInputTokens ?? model.pricing.maxInputTokens);
    assert.equal(cost.outputTokens, 100);
    const actual = actualModelCost(model.pricing, { input: cost.inputTokens, output: 100, cached: 0, serviceTier: "standard" }, endpoint.request_format);
    assert.notEqual(actual, null); assert.ok(cost.reserveMicros >= actual);
  }
  const priced = { ...model.pricing, maxRequestInputTokens: 200000 };
  assert.equal(estimateModelCost(priced, { ...original, continuationToken: "eA==" }, endpoint).inputTokens, 200000);
});

test("Google continuation qualification respects native ProtoJSON aliases and the selected wire format", () => {
  for (const body of [original, { ...original, continuationToken: null },
    { ...original, contents: [{ parts: [{ text: '{"continuationToken":"eA=="}' }] }] },
    { ...original, tools: [{ functionDeclarations: [{ name: "continuationToken", parameters: { continuation_token: "eA==" } }] }] },
    { ...original, continuationToken: "eA==", continuation_token: null }]) {
    assert.ok(estimateModelCost(model.pricing, body, endpoint).inputTokens < 10000);
  }
  assert.equal(estimateModelCost(model.pricing, { ...original, continuation_token: null, continuationToken: "eA==" }, endpoint).inputTokens, model.pricing.maxInputTokens);
  assert.ok(estimateModelCost(model.pricing, { messages: [{ role: "user", content: "fixture" }], continuationToken: "eA==" }, { request_format: "openai.chat_completions" }).inputTokens < 10000);
});

test("opaque Google continuation cannot use an absent or invalid input ceiling", () => {
  for (const maxInputTokens of [undefined, null, 0, -1, 1.5, Infinity]) {
    const cost = estimateModelCost({ ...model.pricing, maxInputTokens, maxRequestInputTokens: null }, { ...original, continuationToken: "eA==" }, endpoint);
    assert.equal(cost.pricingAvailable, false); assert.equal(cost.inputTokens, null);
  }
  const fixed = estimateCost(model, { ...original, continuationToken: "eA==" }, 17, "llm.generate", endpoint);
  assert.equal(fixed.basis, "policy_fixed"); assert.equal(fixed.reserveMicros, 17);
});

for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`Google continuation ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} checks both budgets before egress and settles only this HTTP hop`, async t => {
    const continuation = { ...original, [stream ? "continuation_token" : "continuationToken"]: "Zml4dHVyZQ==" };
    const reserve = estimateCost(model, continuation, null, "llm.generate", endpoint).reserveMicros;
    const plainReserve = estimateCost(model, original, null, "llm.generate", endpoint).reserveMicros;
    assert.ok(reserve > plainReserve);
    for (const [body, limit, providerLimit, fixed, denied] of [
      [continuation, plainReserve, null, null, true],
      [continuation, null, plainReserve, null, true],
      [original, plainReserve, plainReserve, null, false],
      [continuation, reserve, reserve, null, false],
      [continuation, 17, 17, 17, false],
    ]) {
      const events = [], pending = [];
      const env = usageEnv([], { provider: provider.id, limit, providerLimit, fixedCost: fixed, retainContent: false, budgetMode: "reserve" });
      env.GOOGLE_API_KEY = "synthetic-original-key"; env.BUDGET_LEDGER = sqlBudgetNamespace(t);
      env.USAGE_QUEUE = { async send(event) { events.push(event); } };
      const final = { candidates: [{ finishReason: "CONTINUATION", continuationToken: "bmV4dA==", content: { parts: [{ text: "" }] } }],
        usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 100, totalTokenCount: 1100 } };
      const wire = stream ? sse(final) : JSON.stringify(final);
      const path = `/v1beta/models/${model.upstream}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
        assert.equal(String(url), `https://generativelanguage.googleapis.com${path}`);
        assert.equal(new Headers(init.headers).get("x-goog-api-key"), "synthetic-original-key");
        assert.deepEqual(JSON.parse(init.body), body);
        return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
      });
      try {
        const route = manifest ? `/v1/proxy/google-gemini/${stream ? "stream_generate_content" : "generate_content"}` : `/v1/native/google-gemini${path}`;
        const response = await handler.fetch(new Request(`https://router.example${route}`, { method: "POST",
          headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
          body: JSON.stringify(manifest ? { body, pathParams: { model: model.upstream }, query: stream ? { alt: "sse" } : {} } : body),
        }), env, { waitUntil: promise => pending.push(promise) });
        assert.equal(response.status, denied ? 402 : 200, await response.clone().text());
        if (!denied) assert.equal(await response.text(), wire);
        await Promise.all(pending);
        assert.equal(upstream.mock.callCount(), denied ? 0 : 1); assert.equal(events.length, 1);
        if (denied) assert.equal(events[0].actual_cost_micros, 0);
        else {
          assert.equal(events[0].reserved_cost_micros, fixed ?? (body === original ? plainReserve : reserve));
          assert.equal(events[0].actual_cost_micros, fixed ?? actualModelCost(model.pricing, { input: 1000, output: 100, cached: 0, serviceTier: "standard" }, endpoint.request_format));
          assert.equal(events[0].cost_basis, fixed == null ? "manifest_pricing" : "policy_fixed");
          assert.equal(events[0].output_tokens, 100);
        }
      } finally { upstream.mock.restore(); }
    }
  });
}
