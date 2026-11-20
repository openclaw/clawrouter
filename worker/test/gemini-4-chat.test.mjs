import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createRouteCatalog } from "../../shared/route-catalog.ts";
import { providerById } from "../providers.ts";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";

const { default: handler } = await import("../index.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const google = providerById("google-gemini");
// Single raw REST hop, not the aggregate allowance of a client continuation loop.
const models = [
  { name: "Neon", unaryLimit: 65536 },
  { name: "Carbon", unaryLimit: 32768 },
  { name: "Hydrogen", unaryLimit: 65536 },

];

test("Argon is not offered until the actual client qualifies continuation", () => {
  assert.equal(google.models.some(row => row.upstream === "gemini-4-argon"), false);
  assert.equal(createRouteCatalog([google]).manifestProxy.some(route => route.models.some(row => row.id === "google/gemini-4-argon")), false);
});

for (const { name, unaryLimit } of models) {
  const upstream = `gemini-4-${name.toLowerCase()}`;
  const id = `google/${upstream}`;
  test(`${upstream} is offered only on Google's two text-generation routes`, () => {
    const { manifestProxy } = createRouteCatalog([google]);
    const routes = manifestProxy.filter(route => route.models.some(model => model.id === id));
    assert.deepEqual(routes.map(route => route.endpoint).sort(), ["generate_content", "stream_generate_content"]);
    const model = google.models.find(row => row.id === id);
    assert.equal(model.upstream, upstream);
    assert.equal(model.displayName, `Gemini 4 ${name}`);
    for (const route of routes) {
      const facts = model.nativeCapabilities.endpoints[route.endpoint];
      assert.deepEqual(facts.input, ["text", "image", "video", "audio"]);
      assert.equal(facts.contextWindow, 1048576);
      assert.equal(facts.maxOutputTokens, route.streaming ? 65536 : unaryLimit);
      assert.equal(route.sampleModel, "google/gemini-3.5-flash");
    }
  });
}

test("media and continuation hops reserve the full unified input window", () => {
  const endpoint = google.endpoints.find(row => row.id === "generate_content");
  for (const { name } of models) {
    const model = google.models.find(row => row.upstream === "gemini-4-" + name.toLowerCase());
    for (const request of [
      { contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: "Zml4dHVyZQ==" } }] }] },
      { contents: [{ parts: [{ text: "fixture" }] }], continuationToken: "eA==" },
    ]) {
      const estimate = estimateCost(model, request, null, "llm.generate", endpoint);
      assert.equal(estimate.basis, "manifest_pricing");
      assert.equal(estimate.inputTokens, 1048576);
      assert.equal(estimate.outputTokens, 65536);
    }
  }
});

// 4,000 prompt (2,000 cache hits) and 1,000 output tokens, including thoughts.
const charges = {
  Neon: [21300, 10650, 38340], Hydrogen: [10650, 5325, 19170],
  Carbon: [28400, 14200, 51120],
};
for (const { name } of models) for (const manifest of [false, true]) {
  const upstream = "gemini-4-" + name.toLowerCase();
  test(upstream + " dispatches and settles " + (manifest ? "manifest" : "native") + " JSON and SSE", async t => {
    for (const [i, serviceTier] of ["standard", "flex", "priority"].entries()) {
      const stream = i !== 0;
      const path = "/v1beta/models/" + upstream + (stream ? ":streamGenerateContent?alt=sse" : ":generateContent");
      const endpoint = stream ? "stream_generate_content" : "generate_content";
      const body = { contents: [{ role: "user", parts: [{ text: "fixture" }] }], serviceTier, generationConfig: { maxOutputTokens: 1024 } };
      const result = { modelVersion: upstream, candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 4000, cachedContentTokenCount: 2000, candidatesTokenCount: 900, thoughtsTokenCount: 100, totalTokenCount: 5000, serviceTier } };
      const wire = stream ? sse(result) : JSON.stringify(result);
      const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
        assert.equal(String(url), "https://generativelanguage.googleapis.com" + path);
        assert.equal(new Headers(init.headers).get("x-goog-api-key"), "fixture-google");
        assert.deepEqual(JSON.parse(init.body), body);
        return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
      });
      const pending = [], events = [];
      const env = usageEnv([], { provider: "google-gemini", fixedCost: null, limit: 10000000, budgetMode: "reserve", retainContent: false });
      env.GOOGLE_API_KEY = "fixture-google";
      env.BUDGET_LEDGER = sqlBudgetNamespace(t);
      env.USAGE_QUEUE = { async send(event) { events.push(event); } };
      try {
        const route = manifest ? "/v1/proxy/google-gemini/" + endpoint : "/v1/native/google-gemini" + path;
        const response = await handler.fetch(new Request("https://router.example" + route, {
          method: "POST", headers: { authorization: "Bearer " + proxyKey(), "content-type": "application/json" },
          body: JSON.stringify(manifest ? { body, pathParams: { model: upstream } } : body),
        }), env, { waitUntil: promise => pending.push(promise) });
        const output = await response.text();
        assert.equal(response.status, 200, output);
        assert.equal(output, wire);
        await Promise.all(pending);
        assert.equal(fetch.mock.callCount(), 1);
        assert.equal(events.length, 1);
        assert.equal(events[0].actual_cost_micros, charges[name][i]);
        assert.equal(events[0].served_service_tier, serviceTier);
        const promotional = name === "Carbon";
        assert.equal(events[0].cost_basis, promotional ? "manifest_rate_upper_bound" : "manifest_pricing");
      } finally { fetch.mock.restore(); }
    }
  });
}
