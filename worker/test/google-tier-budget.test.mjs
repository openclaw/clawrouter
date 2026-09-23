import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";
import test from "node:test";

const { default: handler } = await import("../index.ts");
const { providerBudgetStatus } = await import("../ledgers.ts");

for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`Gemini tier evidence settles ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} in both budgets`, async (t) => {
    for (const [requestTier, metadataTier, headerTier, expected, served, omitUsage = false] of [
      [undefined, undefined, undefined, 10_185, "standard"],
      ["flex", undefined, undefined, 5_097, "flex"],
      ["priority", "priority", "priority", 18_333, "priority"],
      ["priority", undefined, "standard", 10_185, "standard"],
      ["priority", "standard", undefined, 10_185, "standard"],
      ["priority", undefined, undefined, null, null],
      ["priority", "priority", "standard", null, null],
      ["standard", "default", "standard", null, null],
      ["standard", "standard", "future", null, null],
      ["priority", undefined, "priority", null, "priority", true],
    ]) {
      const limit = 50_000, events = [], pending = [];
      const env = usageEnv([], { provider: "google-gemini", limit, fixedCost: null, retainContent: false });
      env.GOOGLE_API_KEY = "fixture-google-key";
      env.BUDGET_LEDGER = sqlBudgetNamespace(t);
      env.USAGE_QUEUE = { send: async event => events.push(event) };
      const body = { contents: [{ parts: [{ text: "fixture" }] }], generationConfig: { maxOutputTokens: 1_100 }, serviceTier: requestTier };
      const usageMetadata = { promptTokenCount: 1_000, cachedContentTokenCount: 900, candidatesTokenCount: 100, thoughtsTokenCount: 1_000, totalTokenCount: 2_100, serviceTier: metadataTier };
      const final = { candidates: [{ finishReason: "STOP" }], ...(omitUsage ? {} : { usageMetadata }) };
      const wire = stream ? sse(...(omitUsage ? [] : [{ usageMetadata: { ...usageMetadata, serviceTier: "priority", candidatesTokenCount: 1 } }]), final) : JSON.stringify(final);
      const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
        assert.deepEqual(JSON.parse(init.body), JSON.parse(JSON.stringify(body)));
        return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json", ...(headerTier === undefined ? {} : { "x-gemini-service-tier": headerTier }) } });
      });
      const route = manifest ? `/v1/proxy/google-gemini/${stream ? "stream_generate_content" : "generate_content"}`
        : `/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
        method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
        body: JSON.stringify(manifest ? { body, pathParams: { model: "gemini-3.5-flash" }, query: stream ? { alt: "sse" } : {} } : body),
      }), env, { waitUntil: promise => pending.push(promise) });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), wire);
      await Promise.all(pending);
      assert.equal(upstream.mock.callCount(), 1);
      assert.equal(events.length, 1);
      const [event] = events, cost = expected ?? event.reserved_cost_micros;
      assert.equal(event.actual_cost_micros, cost);
      assert.equal(event.cost_basis, expected == null ? "manifest_reservation" : "manifest_pricing");
      assert.equal(event.requested_service_tier, requestTier ?? null);
      assert.equal(event.served_service_tier, served);
      assert.equal(event.input_tokens, omitUsage ? null : 1_000);
      assert.equal(event.output_tokens, omitUsage ? null : 1_100);
      const status = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
      assert.equal((await status.json()).budget.spentMicros, cost);
      assert.equal((await providerBudgetStatus(env, "google-gemini", limit)).spentMicros, cost);
      upstream.mock.restore();
    }
  });
}

test("Gemini tier admission uses native aliases and both budgets without upgrading Flex", async (t) => {
  for (const manifest of [false, true]) for (const [fields, limit, providerLimit, expected, reserved] of [
    [{ serviceTier: "priority" }, 2_000_000, 3_000_000, "budget_exhausted"],
    [{ service_tier: "priority" }, 3_000_000, 2_000_000, "provider_budget_exhausted"],
    [{ serviceTier: "priority", service_tier: "flex" }, 1_000_000, 1_000_000, null, 790_932],
    [{ service_tier: "flex", serviceTier: "priority" }, 3_000_000, 3_000_000, null, 2_847_356],
    [{ serviceTier: "priority", service_tier: null }, 2_000_000, 2_000_000, null, 1_581_864],
  ]) {
    const events = [], pending = [], env = usageEnv([], { provider: "google-gemini", limit, providerLimit, fixedCost: null, retainContent: false });
    env.GOOGLE_API_KEY = "fixture-google-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({}));
    const body = { contents: [{ parts: [{ text: "x".repeat(1_100_000) }] }], generationConfig: { maxOutputTokens: 1_000 }, ...fields };
    const route = manifest ? "/v1/proxy/google-gemini/generate_content" : "/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:generateContent";
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify(manifest ? { body, pathParams: { model: "gemini-3.5-flash" } } : body),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, expected ? 402 : 200);
    if (expected) assert.equal((await response.json()).error.code, expected);
    else await response.text();
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), expected ? 0 : 1);
    assert.equal(events.length, 1);
    const cost = expected ? 0 : reserved;
    assert.equal(events[0].actual_cost_micros, cost);
    const status = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal((await status.json()).budget.spentMicros, cost);
    assert.equal((await providerBudgetStatus(env, "google-gemini", providerLimit)).spentMicros, cost);
    upstream.mock.restore();
  }
});

test("Gemini tier qualification preserves fixed tariffs and unmetered forwarding", async (t) => {
  for (const requestTier of ["default", "auto", "fast", "future", 0, {}]) for (const [limit, fixedCost, metadataTier, expected] of [
    [50_000, null, "standard", "denied"], [null, null, "standard", "measured"], [null, null, "future", "unpriced"], [50_000, 0, "future", "fixed"], [50_000, 7, "future", "fixed"],
  ]) {
    const events = [], pending = [], env = usageEnv([], { provider: "google-gemini", limit, fixedCost, retainContent: false });
    env.GOOGLE_API_KEY = "fixture-google-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ usageMetadata: { promptTokenCount: 1_000, cachedContentTokenCount: 900, candidatesTokenCount: 100, thoughtsTokenCount: 1_000, serviceTier: metadataTier } }));
    const response = await handler.fetch(new Request("https://clawrouter.example/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:generateContent", {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "fixture" }] }], generationConfig: { maxOutputTokens: 1_100 }, serviceTier: requestTier }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, expected === "denied" ? 400 : 200);
    if (expected === "denied") assert.equal((await response.json()).error.code, "pricing_required");
    else await response.text();
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), expected === "denied" ? 0 : 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].actual_cost_micros, expected === "measured" ? 10_185 : expected === "fixed" ? fixedCost : 0);
    if (expected !== "denied") assert.equal(events[0].cost_basis, expected === "measured" ? "manifest_pricing" : expected === "fixed" ? "policy_fixed" : "unpriced_usage");
    upstream.mock.restore();
  }
});

test("Gemini tier reservations preserve known rejection, cancellation, and missing-response accounting", async (t) => {
  for (const manifest of [false, true]) for (const stream of [false, true]) for (const [serviceTier, inputRate, outputRate] of [
    ["standard", 1_500_000, 9_000_000], ["flex", 750_000, 4_500_000], ["priority", 2_700_000, 16_200_000],
  ]) for (const outcome of ["rejected", "canceled", "missing_response"]) {
    const limit = 50_000, events = [], pending = [];
    const env = usageEnv([], { provider: "google-gemini", limit, fixedCost: null, retainContent: false });
    env.GOOGLE_API_KEY = "fixture-google-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const body = { contents: [{ parts: [{ text: "fixture" }] }], generationConfig: { maxOutputTokens: 100 }, serviceTier };
    const reservation = Math.ceil((new TextEncoder().encode(JSON.stringify(body)).byteLength + 1_024) * inputRate / 1_000_000) + Math.ceil(100 * outputRate / 1_000_000);
    let pulls = 0, canceled = false;
    const upstream = t.mock.method(globalThis, "fetch", async () => {
      if (outcome === "missing_response") throw new Error("fixture connection lost after dispatch");
      if (outcome === "rejected") return Response.json({ error: { message: "fixture capacity rejection" } }, { status: 429, headers: { "x-gemini-service-tier": "standard" } });
      return new Response(new ReadableStream({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(stream ? sse({ candidates: [{ content: { parts: [{ text: "fixture" }] } }] }) : '{"candidates":['));
        },
        cancel() { canceled = true; },
      }, { highWaterMark: 0 }), { headers: { "content-type": stream ? "text/event-stream" : "application/json", "x-gemini-service-tier": "standard" } });
    });
    const route = manifest ? `/v1/proxy/google-gemini/${stream ? "stream_generate_content" : "generate_content"}`
      : `/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify(manifest ? { body, pathParams: { model: "gemini-3.5-flash" }, query: stream ? { alt: "sse" } : {} } : body),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, outcome === "rejected" ? 429 : outcome === "missing_response" ? 502 : 200);
    if (outcome === "canceled") {
      const reader = response.body.getReader();
      assert.equal((await reader.read()).done, false);
      await reader.cancel();
      assert.equal(canceled, true);
    } else await response.text();
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), 1);
    assert.equal(events.length, 1);
    const [event] = events, cost = outcome === "rejected" ? 0 : reservation;
    assert.equal(event.status_code, response.status);
    assert.equal(event.status, outcome === "missing_response" ? "provider_error" : "client_error");
    assert.equal(event.requested_service_tier, serviceTier);
    assert.equal(event.reserved_cost_micros, reservation);
    assert.equal(event.actual_cost_micros, cost);
    assert.equal(event.cost_basis, outcome === "rejected" ? "none" : "manifest_reservation");
    assert.equal(event.input_tokens, null, "a tier header cannot invent missing or partially delivered usage");
    const usage = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal((await usage.json()).budget.spentMicros, cost);
    assert.equal((await providerBudgetStatus(env, "google-gemini", limit)).spentMicros, cost);
    upstream.mock.restore();
  }
});
