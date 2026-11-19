import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { estimateModelCost, actualModelCost } = await import("../pricing.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { providerById } = await import("../providers.ts");
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
    const { googleContinuationFixture, googleOriginalRequest, googleContinuationResponse, googleContinuationToken } = await import("./google-continuation-fixture.mjs");
    const continuation = { ...googleOriginalRequest, [stream ? "continuation_token" : "continuationToken"]: googleContinuationToken };
    const reserve = estimateCost(model, continuation, null, "llm.generate", endpoint).reserveMicros;
    const plainReserve = estimateCost(model, googleOriginalRequest, null, "llm.generate", endpoint).reserveMicros;
    assert.ok(reserve > plainReserve);
    for (const [name, body, limit, providerLimit, fixed, denied] of [
      ["caller ceiling", continuation, plainReserve, null, null, true],
      ["provider ceiling", continuation, null, plainReserve, null, true],
      ["plain control", googleOriginalRequest, plainReserve, plainReserve, null, false],
      ["owned hop", continuation, reserve, reserve, null, false],
      ["explicit fixed", continuation, 17, 17, 17, false],
    ]) await t.test(name, async t => {
      const f = await googleContinuationFixture(t, { stream, manifest, fixed });
      const usage = googleContinuationResponse.usageMetadata;
      const initialCost = fixed ?? actualModelCost(model.pricing, { input: usage.promptTokenCount,
        output: usage.candidatesTokenCount + usage.thoughtsTokenCount, cached: 0, serviceTier: "standard" }, endpoint.request_format);
      assert.notEqual(initialCost, null);
      // Both budgets fund the real initial hop separately; no authority record
      // or ledger state is seeded/reset to make the continuation admissible.
      f.policy.monthlyBudgetMicros = limit === null ? null : limit + initialCost;
      f.policy.budgetMode = "reserve";
      await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
      await f.authority("/connections/put", { providerId: provider.id, enabled: true,
        monthlyBudgetMicros: providerLimit === null ? null : providerLimit + initialCost });
      await f.initial();
      assert.equal(f.sent.length, 1); assert.equal(f.continuations().length, 1);
      const initialEvents = await f.events(); assert.equal(initialEvents.length, 1);
      assert.equal(initialEvents[0].actual_cost_micros, initialCost);
      const final = { candidates: [{ finishReason: "CONTINUATION", continuationToken: "bmV4dA==", content: { parts: [{ text: "" }] } }],
        usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 100, totalTokenCount: 1100 } };
      f.output = final;
      const wire = f.wire(), response = await f.request(body);
      assert.equal(response.status, denied ? 402 : 200, await response.clone().text());
      if (!denied) assert.equal(await response.text(), wire);
      await f.drain();
      assert.equal(f.sent.length, denied ? 1 : 2);
      const path = `/v1beta/models/${model.upstream}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      for (const request of f.sent) {
        assert.equal(request.url, `https://generativelanguage.googleapis.com${path}`);
        assert.equal(request.headers.get("x-goog-api-key"), "synthetic-google-environment");
        assert.equal(request.redirect, "manual");
      }
      assert.deepEqual(await f.sent[0].clone().json(), googleOriginalRequest);
      if (!denied) assert.deepEqual(await f.sent[1].clone().json(), body);
      const events = await f.events(); assert.equal(events.length, 2);
      const hop = events.find(event => event.id !== initialEvents[0].id); assert.ok(hop);
      if (denied) assert.equal(hop.actual_cost_micros, 0);
      else {
        assert.equal(hop.reserved_cost_micros, fixed ?? (body === googleOriginalRequest ? plainReserve : reserve));
        assert.equal(hop.actual_cost_micros, fixed ?? actualModelCost(model.pricing, { input: 1000, output: 100, cached: 0, serviceTier: "standard" }, endpoint.request_format));
        assert.equal(hop.cost_basis, fixed == null ? "manifest_pricing" : "policy_fixed");
        assert.equal(hop.output_tokens, 100);
      }
    });
  });
}
