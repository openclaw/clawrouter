import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");
const { providerById } = await import("../provider-catalog.ts");

export function registerGooglePriceBoundDispatchCases({ provider, models, amounts, plain }) {
  for (const model of models) for (const manifest of [false, true]) {
    test(`${model.upstream} actual ${manifest ? "manifest" : "native"} JSON/SSE dispatch settles the explicitly labeled upper bound`, async t => {
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
          assert.equal(events[0].cost_basis, "manifest_rate_upper_bound"); assert.equal(events[0].served_service_tier, serviceTier);
          assert.equal(events[0].input_tokens, 1000); assert.equal(events[0].output_tokens, 100);
        } finally { upstream.mock.restore(); }
      }
    });
  }
}
