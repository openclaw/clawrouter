import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

test("generic HTTP routes refuse redirect replay in workerd and preserve normal JSON/SSE", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-routing-")); let mf;
  try {
    mf = await startWorkerdFixture(temporary, `
      export { default } from "./worker/index.ts";
      export * from "./worker/index.ts";
    `, String.raw`
      const calls = [];
      export default { async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/fixture-calls") return Response.json(calls);
        calls.push({ origin: url.origin, path: url.pathname, method: request.method });
        if (url.pathname === "/redirect-target") return Response.json({ error: "redirect replayed" });
        const body = await request.json();
        if (body.fixture_redirect) return new Response("synthetic redirect body", { status: body.fixture_redirect, headers: { location: body.fixture_cross_origin ? "https://redirect.example/redirect-target" : "/redirect-target" } });
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
        return body.stream
          ? new Response('data: ' + JSON.stringify({ choices: [], usage }) + '\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
          : Response.json({ choices: [], usage });
      } };
    `);
    const kv = await mf.getKVNamespace("POLICY_KV", "router"), secret = "routing-fixture-secret";
    await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", requestCostMicros: 1, retainRequestContent: false }));
    await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true }));
    const headers = { authorization: "Bearer clawrouter-live-fixture-" + secret, "content-type": "application/json" }, origin = await mf.ready;
    const upstream = await mf.getWorker("upstream");
    const calls = async () => (await upstream.fetch("https://api.openai.com/fixture-calls")).json();
    for (const path of ["/v1/chat/completions", "/v1/native/openai/v1/chat/completions", "/v1/proxy/openai/chat_completions"]) {
      const send = (body, auth = headers) => fetch(new URL(path, origin), { method: "POST", headers: auth, body: JSON.stringify(path.includes("/proxy/") ? { body } : body), redirect: "manual", signal: AbortSignal.timeout(5_000) });
      const input = { model: "openai/gpt-4.1-mini", messages: [{ role: "user", content: "synthetic private input" }] };
      for (const status of [301, 302, 303, 307, 308]) for (const crossOrigin of [false, true]) {
        const before = (await calls()).length;
        const response = await send({ ...input, fixture_redirect: status, fixture_cross_origin: crossOrigin });
        assert.equal(response.status, 502, path + " must reject " + status);
        assert.equal(response.headers.has("location"), false);
        assert.equal((await response.json()).error.code, "provider_unavailable");
        assert.equal((await calls()).length, before + 1, "redirect never dispatches a second request");
      }
      for (const stream of [false, true]) {
        const response = await send({ ...input, stream });
        assert.equal(response.status, 200); assert.match(await response.text(), /usage/);
      }
      const before = (await calls()).length;
      const denied = await send(input, { "content-type": "application/json" });
      assert.equal(denied.status, 401); await denied.text();
      assert.equal((await calls()).length, before, "authentication still precedes dispatch");
    }
    const sent = await calls();
    assert.equal(sent.length, 36);
    assert.ok(sent.every(call => call.origin === "https://api.openai.com" && call.path === "/v1/chat/completions" && call.method === "POST"));
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
