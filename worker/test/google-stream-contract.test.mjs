import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");

for (const manifest of [false, true]) test(`Gemini ${manifest ? "manifest" : "native"} stream negotiates SSE and reports final usage`, async t => {
  for (const alt of [undefined, "sse", "json", "", "SSE", ["sse", "json"], ["sse", "sse"]]) {
    const pending = [], events = [], env = usageEnv([], { provider: "google-gemini", limit: null, fixedCost: null, retainContent: false });
    env.GOOGLE_API_KEY = "fixture-google-key";
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const body = { contents: [{ parts: [{ text: "fixture" }] }] };
    const wire = sse({ candidates: [{ content: { parts: [{ text: "fixture" }] } }] }, { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } });
    const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.deepEqual(new URL(url).searchParams.getAll("alt"), ["sse"]);
      assert.equal(new URL(url).searchParams.get("trace"), "fixture");
      assert.deepEqual(JSON.parse(init.body), body);
      return new Response(wire, { headers: { "content-type": "text/event-stream" } });
    });
    const query = new URLSearchParams({ trace: "fixture" });
    for (const value of alt === undefined ? [] : Array.isArray(alt) ? alt : [alt]) query.append("alt", value);
    const route = manifest ? "/v1/proxy/google-gemini/stream_generate_content" : `/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:streamGenerateContent?${query}`;
    const response = await handler.fetch(new Request(`https://router.example${route}`, {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify(manifest ? { body, pathParams: { model: "gemini-3.5-flash" }, query: { trace: "fixture", ...(alt === undefined ? {} : { alt }) } } : body),
    }), env, { waitUntil: promise => pending.push(promise) });
    const accepted = alt === undefined || alt === "sse";
    assert.equal(response.status, accepted ? 200 : 400);
    if (accepted) assert.equal(await response.text(), wire);
    else assert.equal((await response.json()).error.code, "unsupported_stream_format");
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), accepted ? 1 : 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].input_tokens, accepted ? 10 : null);
    assert.equal(events[0].output_tokens, accepted ? 2 : null);
    upstream.mock.restore();
  }
});

test("Gemini unary query contract is unchanged", async t => {
  const env = usageEnv([], { provider: "google-gemini", limit: null, retainContent: false }), pending = [];
  env.GOOGLE_API_KEY = "fixture-google-key";
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(new URL(url).searchParams.get("alt"), "json");
    return Response.json({ candidates: [] });
  });
  const response = await handler.fetch(new Request("https://router.example/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:generateContent?alt=json", {
    method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, body: JSON.stringify({ contents: [] }),
  }), env, { waitUntil: promise => pending.push(promise) });
  assert.equal(response.status, 200);
  await response.text(); await Promise.all(pending);
});
