import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

for (const alternate of [false, true]) test(`workerd refuses ${alternate ? "alternate" : "initial"} redirects on unified/native/manifest routes and preserves JSON/SSE`, { timeout: 30_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-routing-")); let mf;
  try {
    mf = await startWorkerdFixture(temporary, `
      import handler from "./worker/index.ts";
      import { putGrantCredentials } from "./worker/grant-credentials.ts";
      export * from "./worker/index.ts";
      export default { async fetch(request, env, context) {
        if (new URL(request.url).pathname === "/fixture-setup") {
          for (const id of ["primary", "alternate"]) await putGrantCredentials(env, "oauth/fixture/" + id, { provider: "openai", kind: "api_key", enabled: true, credential: "synthetic-" + id });
          return Response.json({ ok: true });
        }
        return handler.fetch(request, env, context);
      }, queue: handler.queue };
    `, String.raw`
      const calls = [], attempts = new Map();
      export default { async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/fixture-calls") return Response.json({ calls });
        calls.push({ origin: url.origin, path: url.pathname, method: request.method, credentialed: request.headers.has("authorization") });
        if (url.pathname === "/redirect-target") return Response.json({ error: "redirect replayed" });
        const body = await request.json();
        const attempt = (attempts.get(body.fixture_id) ?? 0) + 1;
        attempts.set(body.fixture_id, attempt);
        // An already-expired Retry-After keeps independent cases from cooling the pool.
        if (body.fixture_alternate && attempt === 1) return Response.json({ error: "synthetic initial rejection" }, { status: 429, headers: { "retry-after": "0" } });
        if (body.fixture_redirect) return new Response("synthetic redirect body",  { status: body.fixture_redirect, headers: { location: body.fixture_cross_origin ? "https://redirect.example/redirect-target" : "/redirect-target" } });
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
        // String.raw preserves these single escapes for the generated script.
        return body.stream
          ? new Response('data: ' + JSON.stringify({ choices: [], usage }) + '\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
          : Response.json({ choices: [], usage });
      } };
    `);
    const kv = await mf.getKVNamespace("POLICY_KV", "router"), secret = "routing-fixture-secret";
    await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", requestCostMicros: 1, retainRequestContent: false, grantRouting: { strategy: "round_robin", stickiness: "none", failover: true } }));
    await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true }));
    const headers = { authorization: "Bearer clawrouter-live-fixture-" + secret, "content-type": "application/json" }, origin = await mf.ready;
    if (alternate) {
      const setup = await fetch(new URL("/fixture-setup", origin));
      assert.equal(setup.status, 200, await setup.text());
    }
    const upstream = await mf.getWorker("upstream");
    const state = async () => (await upstream.fetch("https://api.openai.com/fixture-calls")).json();
    let fixtureId = 0;
    for (const path of ["/v1/chat/completions", "/v1/native/openai/v1/chat/completions", "/v1/proxy/openai/chat_completions"]) {
      const send = (body, auth = headers) => {
        body = { ...body, fixture_id: ++fixtureId, fixture_alternate: alternate };
        return fetch(new URL(path, origin), { method: "POST", headers: auth, body: JSON.stringify(path.includes("/proxy/") ? { body } : body), redirect: "manual", signal: AbortSignal.timeout(5_000) });
      };
      const input = { model: "openai/gpt-4.1-mini", messages: [{ role: "user", content: "synthetic private input" }] };
      for (const status of [301, 302, 303, 307, 308]) for (const crossOrigin of [false, true]) {
        const before = await state();
        const response = await send({ ...input, fixture_redirect: status, fixture_cross_origin: crossOrigin });
        assert.equal(response.status, 502, path + " must reject " + status);
        assert.equal(response.headers.has("location"), false);
        assert.deepEqual(await response.json(), { error: { code: "provider_unavailable", message: "upstream request to provider openai failed" } });
        const after = await state();
        assert.equal(after.calls.length, before.calls.length + (alternate ? 2 : 1), "only the selected attempt(s), never a redirect replay");
        t.diagnostic(JSON.stringify({ route: path, dispatch: alternate ? "alternate" : "initial", upstreamStatus: status, target: crossOrigin ? "cross-origin" : "same-origin", status: response.status, location: null, selectedRequests: after.calls.length - before.calls.length, redirectTargetRequests: after.calls.filter(call => call.path === "/redirect-target").length }));
      }
      for (const stream of [false, true]) {
        const response = await send({ ...input, stream });
        assert.equal(response.status, 200);
        const expected = { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        if (stream) {
          assert.match(response.headers.get("content-type"), /^text\/event-stream/);
          const frames = (await response.text()).split("\n\n");
          assert.equal(frames.pop(), "", "last event is terminated");
          assert.equal(frames.length, 2);
          assert.ok(frames.every(frame => frame.startsWith("data: ")));
          assert.deepEqual(JSON.parse(frames[0].slice(6)), expected);
          assert.equal(frames[1], "data: [DONE]");
        } else assert.deepEqual(await response.json(), expected);
        t.diagnostic(JSON.stringify({ route: path, dispatch: alternate ? "alternate" : "initial", format: stream ? "SSE (2 parsed events)" : "JSON", status: response.status }));
      }
      const before = (await state()).calls.length;
      const denied = await send(input, { "content-type": "application/json" });
      assert.equal(denied.status, 401); await denied.text();
      assert.equal((await state()).calls.length, before, "authentication still precedes dispatch");
    }
    const { calls } = await state();
    assert.equal(calls.length, alternate ? 72 : 36);
    assert.ok(calls.every(call => call.origin === "https://api.openai.com" && call.path === "/v1/chat/completions" && call.method === "POST" && call.credentialed));
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

for (const cause of ["deadline", "caller"]) for (const late of ["admit", "reject"]) test(`workerd ${cause} bounds stalled alternate admission before late ${late}`, { timeout: 15_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-failover-lifetime-")); let mf;
  try {
    mf = await startWorkerdFixture(temporary, `
      import handler from "./worker/index.ts";
      import { providerById } from "./worker/providers.ts";
      import { putGrantCredentials } from "./worker/grant-credentials.ts";
      export * from "./worker/index.ts";
      // Allow slow runners to reach held admission; correctness is response-before-release,
      // not a tight latency assertion. The real endpoint timer still owns interruption.
      providerById("openai").endpoints.find(endpoint => endpoint.id === "chat_completions").timeout_ms = ${cause === "deadline" ? 1000 : 5000};
      let entered = false, finished = false, admitted = false;
      let released = false;
      const caller = new AbortController();
      export default { async fetch(request, env, context) {
        const path = new URL(request.url).pathname;
        if (path === "/fixture-setup") {
          for (const id of ["primary", "alternate"]) await putGrantCredentials(env, "oauth/fixture/" + id, { provider: "openai", kind: "api_key", enabled: true, credential: "synthetic-" + id });
          return Response.json({ ok: true });
        }
        if (path === "/fixture-state") return Response.json({ entered, finished, admitted });
        if (path === "/fixture-abort") { caller.abort(new Error("synthetic caller abort")); return Response.json({ ok: true }); }
        if (path === "/fixture-release") { released = true; return Response.json({ ok: true }); }
        const authority = env.ACCESS_CONTROL;
        const wrapped = { idFromName: name => authority.idFromName(name), get: id => {
          const stub = authority.get(id);
          return { fetch(url, init) {
            const pending = (async () => {
              const call = new Request(url, init);
              if (new URL(call.url).pathname === "/admission/resolve" && (await call.clone().json()).selection?.excludedKeys?.length) {
                entered = true;
                // Timer belongs to this request; no cross-request promise continuation.
                while (!released) await new Promise(resolve => setTimeout(resolve, 10));
                if (${late === "reject"}) { finished = true; throw new Error("synthetic late admission failure"); }
                const response = await stub.fetch(call);
                const result = await response.clone().json();
                admitted = !!result.selection?.selected;
                finished = true;
                return response;
              }
              return stub.fetch(call);
            })();
            // Keep the real late authority operation alive after response delivery.
            context.waitUntil(pending.catch(() => {}));
            return pending;
          } };
        } };
        // Inject an observed caller signal, not a claim about idle TCP disconnects.
        return handler.fetch(new Request(request, { signal: caller.signal }), { ...env, ACCESS_CONTROL: wrapped }, context);
      }, queue: handler.queue };
    `, `
      let calls = 0;
      export default { async fetch(request) {
        if (new URL(request.url).pathname === "/fixture-count") return Response.json(calls);
        calls++;
        return Response.json({ error: "synthetic rate limit" }, { status: 429 });
      } };
    `);
    const kv = await mf.getKVNamespace("POLICY_KV", "router"), secret = "deadline-fixture-secret", origin = await mf.ready;
    await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", requestCostMicros: 1, retainRequestContent: false, grantRouting: { strategy: "round_robin", stickiness: "none", failover: true } }));
    await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true }));
    const control = async path => (await fetch(new URL(path, origin))).json();
    assert.deepEqual(await control("/fixture-setup"), { ok: true });
    const state = () => control("/fixture-state");
    const waitFor = async key => {
      for (let i = 0; i < 200; i++) { const current = await state(); if (current[key]) return current; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.fail("fixture did not reach " + key);
    };
    const pending = fetch(new URL("/v1/chat/completions", origin), { method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-" + secret, "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-4.1-mini", messages: [] }), signal: AbortSignal.timeout(5_000) });
    let guard;
    try {
      await waitFor("entered");
      if (cause === "caller") await control("/fixture-abort");
      const response = await Promise.race([pending, new Promise(resolve => { guard = setTimeout(() => resolve(null), 3000); })]);
      assert.ok(response, "interruption must return before admission is released");
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: { code: "provider_unavailable", message: "upstream request to provider openai failed" } });
      assert.deepEqual(await state(), { entered: true, finished: false, admitted: false });
      t.diagnostic(JSON.stringify({ cause, late, status: response.status, admissionFinishedAtResponse: false }));
    } finally {
      clearTimeout(guard);
      await control("/fixture-release");
      const response = await pending; await response.text().catch(() => {});
    }
    const completed = await waitFor("finished");
    assert.equal(completed.admitted, late === "admit", "late successful authority selection really completes");
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://api.openai.com/fixture-count")).json();
    assert.equal(calls, 1, "late admission never dispatches another upstream request");
    t.diagnostic(JSON.stringify({ cause, late, admissionFinished: completed.finished, admitted: completed.admitted, upstreamRequests: calls }));
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
