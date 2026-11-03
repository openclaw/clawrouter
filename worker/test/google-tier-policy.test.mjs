import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";

const { default: handler } = await import("../index.ts");
const model = "google-gemini/gemini-3.5-flash";
const tiers = ["default", "flex", "priority"];
const cases = [
  [{}, "default"], [{ serviceTier: null }, "default"],
  [{ service_tier: "unspecified" }, "default"], [{ serviceTier: "standard" }, "default"],
  [{ serviceTier: "flex" }, "flex"], [{ service_tier: "priority" }, "priority"],
  [{ serviceTier: "priority", service_tier: "flex" }, "flex"],
  [{ service_tier: "flex", serviceTier: "priority" }, "priority"],
  [{ serviceTier: "priority", service_tier: null }, "default"],
  [{ service_tier: null, serviceTier: "priority" }, "priority"],
  [{ serviceTier: "bad", service_tier: "standard" }, "default"],
  ...["default", "auto", "fast", "future", "", "PRIORITY", " priority ", 0, true, {}, []].flatMap(value => [
    [{ serviceTier: value }, null], [{ service_tier: value }, null],
  ]),
  [{ serviceTier: "standard", service_tier: "bad" }, null],
];

for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`Google ${manifest ? "manifest" : "native"} ${stream ? "stream" : "unary"} intersects policy and key tiers before dispatch`, async t => {
    for (const [policy, credential, allowed] of [
      [{ allowed: tiers }, undefined, tiers],
      [{ allowed: ["default"] }, tiers, ["default"]],
      [{ allowed: tiers }, ["default"], ["default"]],
      [{ allowed: ["priority"] }, ["default"], []],
      [{ allowed: ["default"], models: { [model]: ["flex", "priority"] } }, ["flex"], ["flex"]],
    ]) for (const [fields, tier] of cases) {
      const pending = [], events = [];
      const env = usageEnv([], { provider: "google-gemini", limit: null, fixedCost: null, retainContent: false, serviceTiers: policy, credentialServiceTiers: credential });
      env.GOOGLE_API_KEY = "fixture-google-key";
      env.USAGE_QUEUE = { send: async event => events.push(event) };
      const body = { contents: [{ parts: [{ text: "fixture" }] }], ...fields };
      const final = { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, serviceTier: tier === "default" ? "standard" : tier } };
      const wire = stream ? sse(final) : JSON.stringify(final);
      const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
        assert.deepEqual(JSON.parse(init.body), body, "admission preserves native spelling and values");
        return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
      });
      const route = manifest ? `/v1/proxy/google-gemini/${stream ? "stream_generate_content" : "generate_content"}`
        : `/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      const response = await handler.fetch(new Request(`https://router.example${route}`, {
        method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
        body: JSON.stringify(manifest ? { body, pathParams: { model: "gemini-3.5-flash" }, query: stream ? { alt: "sse" } : {} } : body),
      }), env, { waitUntil: promise => pending.push(promise) });
      const admitted = tier !== null && allowed.includes(tier);
      assert.equal(response.status, admitted ? 200 : 400, JSON.stringify({ fields, policy, credential }));
      if (admitted) assert.equal(await response.text(), wire);
      else assert.equal((await response.json()).error.code, "service_tier_not_allowed");
      await Promise.all(pending);
      assert.equal(upstream.mock.callCount(), admitted ? 1 : 0);
      assert.equal(events.length, 1);
      assert.equal(events[0].input_tokens, admitted ? 10 : null);
      assert.equal(events[0].output_tokens, admitted ? 2 : null);
      if (!admitted) assert.equal(events[0].actual_cost_micros, 0);
      upstream.mock.restore();
    }
  });
}
