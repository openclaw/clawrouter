import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

const secret = "request-headers-fixture-secret";
const authorization = "Bearer clawrouter-live-fixture-" + secret;
const anthropicBody = { model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "synthetic attribution é" }] };
const router = [
  'import handler from "./worker/index.ts";',
  'export * from "./worker/index.ts";',
  'import { copyRequestHeaders, providerById } from "./worker/providers.ts";',
  'import { putGrantCredentials } from "./worker/grant-credentials.ts";',
  'import { ingestUsage } from "./worker/ledgers.ts";',
  'export default { queue: handler.queue, async fetch(request, env, ctx) {',
  ' if (new URL(request.url).pathname === "/fixture/openai-grant") { await putGrantCredentials(env, "oauth/fixture/openai", { enabled: true, provider: "openai", kind: "api_key", credential: "fixture-openai-pool" }); return new Response("ok"); }',
  ' if (new URL(request.url).pathname === "/fixture/header-copy") {',
  '  const provider = structuredClone(providerById("anthropic"));',
  // A future manifest must not accidentally make a tenancy/replay header safe.
  '  provider.adapter.passthroughHeaders.push("Anthropic-Workspace-ID", "Anthropic-User-Profile-ID", "Idempotency-Key");',
  '  const endpoint = structuredClone(provider.endpoints[0]); endpoint.request_headers.push("IDEMPOTENCY-KEY", "anthropic-workspace-id", "anthropic-user-profile-id");',
  '  const target = new Headers(); copyRequestHeaders(request.headers, provider, endpoint, target, env);',
  '  return Response.json(Object.fromEntries(target));',
  ' }',
  ' return handler.fetch(request, { ...env, ANTHROPIC_API_KEY: "fixture-anthropic-environment", USAGE_QUEUE: { send: event => ingestUsage(env, event) } }, ctx);',
  '} };',
].join("\n");
const upstream = [
  'let calls = [];',
  'export default { async fetch(request) {',
  ' const url = new URL(request.url);',
  ' if (url.pathname === "/fixture/calls") return Response.json(calls);',
  ' const bytes = [...new Uint8Array(await request.arrayBuffer())];',
  ' const call = { path: url.pathname, method: request.method, headers: Object.fromEntries(request.headers), bytes };',
  ' calls.push(call);',
  ' if (url.pathname === "/v1/realtime" || request.headers.get("upgrade") === "websocket") {',
  '  const pair = new WebSocketPair(); pair[1].accept(); pair[1].addEventListener("close", () => pair[1].close());',
  '  pair[1].addEventListener("message", () => { pair[1].send(JSON.stringify({ type: "response.created", response: { id: "resp_ws_fixture", status: "in_progress" } })); pair[1].send(JSON.stringify({ type: "response.completed", response: { id: "resp_ws_fixture", object: "response", status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } })); });',
  '  return new Response(null, { status: 101, webSocket: pair[0] });',
  ' }',
  ' if (url.pathname === "/v1/audio/transcriptions") {',
  '  const form = await new Response(new Uint8Array(bytes), { headers: { "content-type": request.headers.get("content-type") } }).formData();',
  '  const file = form.get("file"); call.file = { name: file.name, type: file.type, bytes: [...new Uint8Array(await file.arrayBuffer())] };',
  '  call.fields = Object.fromEntries([...form].filter(([name]) => name !== "file"));',
  '  return Response.json({ text: "synthetic transcript", usage: { type: "tokens", input_tokens: 4, output_tokens: 2, total_tokens: 6 } });',
  ' }',
  ' if (url.pathname === "/v1/audio/speech") return new Response(new Uint8Array([0,255,128,42]), { headers: { "content-type": "audio/mpeg" } });',
  ' if (url.pathname === "/v1/messages/count_tokens") return Response.json({ input_tokens: 4 });',
  ' if (url.pathname === "/v1/messages") return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 4, output_tokens: 2 } });',
  ' if (url.pathname.startsWith("/v1/responses")) return Response.json({ id: request.headers.get("authorization") === "Bearer fixture-openai-pool" ? "resp_fixture_pooled" : "resp_fixture_headers", object: "response", status: "completed", model: "gpt-4.1-mini", output: [], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } });',
  ' return Response.json({ object: "list", data: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });',
  '} };',
].join("\n");

test("native identity selection and correlation headers cross the actual Worker egress boundary safely", { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-request-headers-"));
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, router, upstream);
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ["fixture", "environment"]) {
      await kv.put("policies/" + id, JSON.stringify({ enabled: true, generation: "g1", providers: ["openai", "anthropic"], monthlyBudgetMicros: 100_000_000, requestCostMicros: 100, retainRequestContent: false }));
      await kv.put("credentials/" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: id, policyGeneration: "g1" }));
    }
    await kv.put("oauth/fixture/anthropic", JSON.stringify({ provider: "anthropic", kind: "api_key", enabled: true, credential: "fixture-anthropic-pool" }));
    const service = await mf.getWorker("upstream");
    const calls = async () => (await service.fetch("https://fixture/fixture/calls")).json();
    const origin = await mf.ready;
    const send = (path, body, headers = {}, method = "POST") => fetch(new URL(path, origin), { method, headers: { authorization, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });

    await t.test("workspace and user-profile selectors fail closed after auth in both grant lanes", async () => {
      const before = (await calls()).length;
      for (const path of ["/v1/messages", "/v1/native/anthropic/v1/messages/count_tokens", "/v1/proxy/anthropic/messages"]) {
        for (const policy of ["fixture", "environment"]) {
          for (const [selector, kind, values] of [["anthropic-workspace-id", "workspace", ["wrkspc_foreign", "wrkspc_claimed_own", ""]], ["anthropic-user-profile-id", "user-profile", ["uprof_foreign", "uprof_claimed_own", ""]]]) for (const value of values) {
            const body = path.includes("/proxy/") ? { body: anthropicBody } : anthropicBody;
            const response = await send(path, body, { authorization: "Bearer clawrouter-live-" + policy + "-" + secret, [selector]: value });
            assert.equal(response.status, 403, await response.clone().text());
            const error = await response.json();
            assert.deepEqual(error, { type: "error", error: { type: "permission_error", message: `${selector} requires an explicitly authorized ${kind} binding; ClawRouter does not yet support ${kind} selection` }, request_id: response.headers.get("request-id") });
            assert.ok(error.request_id);
          }
        }
      }
      const unauthenticated = await send("/v1/messages", anthropicBody, { authorization: "", "anthropic-workspace-id": "wrkspc_foreign" });
      assert.equal(unauthenticated.status, 401, "workspace denial must not bypass authentication");
      assert.equal((await calls()).length, before, "no denied request may reach any upstream grant");
    });

    await t.test("denied upstream identities leave a zero-charge metadata-only audit receipt", async () => {
      const response = await send("/v1/messages", anthropicBody, { "anthropic-user-profile-id": "uprof_foreign", "x-request-id": "fixture-denied-profile" });
      assert.equal(response.status, 403); await response.text();
      let event;
      for (let attempt = 0; attempt < 100; attempt++) {
        const usage = await (await fetch(new URL("/v1/usage", origin), {headers:{authorization}})).json();
        event = usage.usage.events.find(item=>item.request_id==="fixture-denied-profile");
        if (event) break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(event); assert.equal(event.status,"denied"); assert.equal(event.status_code,403);
      assert.equal(event.actual_cost_micros,0); assert.equal(event.content_ref,null);
      assert.doesNotMatch(JSON.stringify(event),/uprof_foreign|synthetic attribution/);
    });

    await t.test("beta and explicit API version survive without changing JSON bytes or credential ownership", async () => {
      for (const path of ["/v1/messages", "/v1/native/anthropic/v1/messages/count_tokens", "/v1/proxy/anthropic/messages"]) {
        const body = path.includes("/proxy/") ? { body: anthropicBody } : anthropicBody;
        const response = await send(path, body, { "anthropic-version": "2023-06-01", "anthropic-beta": "fixture-beta-2026-10-21", "Idempotency-Key": "fixture-replay-key", "x-api-key": "fixture-client-key-not-upstream" });
        assert.equal(response.status, 200, await response.clone().text());
        await response.arrayBuffer();
        const call = (await calls()).at(-1);
        assert.equal(call.headers["anthropic-user-profile-id"], undefined);
        assert.equal(call.headers["anthropic-version"], "2023-06-01");
        assert.equal(call.headers["anthropic-beta"], "fixture-beta-2026-10-21");
        assert.equal(call.headers["x-api-key"], "fixture-anthropic-pool");
        assert.equal(call.headers.authorization, undefined);
        assert.equal(call.headers["anthropic-workspace-id"], undefined);
        assert.equal(call.headers["idempotency-key"], undefined);
        assert.deepEqual(call.bytes, [...Buffer.from(JSON.stringify(anthropicBody))]);
      }
    });

    await t.test("X-Client-Request-Id covers JSON native operations and stays out of Responses ownership", async t => {
      const operations = [
        ["decisions", { model: "gpt-6-luna", input: "synthetic é", questions: [{ type: "predicate", name: "fixture", instructions: "Synthetic?" }] }],
        ["chat/completions", { model: "gpt-4.1-mini", messages: [{ role: "user", content: "synthetic é" }], max_completion_tokens: 8, service_tier: "default" }],
        ["embeddings", { model: "text-embedding-3-small", input: "synthetic é" }],
        ["audio/speech", { model: "tts-1", voice: "alloy", input: "synthetic é" }],
        ["images/generations", { model: "gpt-image-2.5-sunburst", prompt: "synthetic é", size: "1024x1024", quality: "low", n: 1 }],
        ["responses", { model: "gpt-4.1-mini", input: "synthetic é", max_output_tokens: 8, service_tier: "default" }],
        ["responses/compact", { model: "gpt-6.1-sol", input: [{ role: "user", content: "synthetic é" }], service_tier: "default" }],
      ];
      for (const [path, body] of operations) await t.test(path, async () => {
        const id = "fixture-client-" + path.replaceAll("/", "-");
        const response = await send("/v1/native/openai/v1/" + path, body, { "X-Client-Request-Id": id, "Idempotency-Key": "fixture-replay-key" });
        assert.equal(response.status, 200, path + ": " + await response.clone().text());
        const bytes = await response.arrayBuffer();
        if (path === "audio/speech") assert.deepEqual([...new Uint8Array(bytes)], [0,255,128,42]);
        const call = (await calls()).at(-1);
        assert.equal(call.headers["x-client-request-id"], id, path);
        assert.equal(call.headers["idempotency-key"], undefined, path);
        assert.equal(call.headers.authorization, "Bearer fixture-upstream-key");
        assert.deepEqual(call.bytes, [...Buffer.from(JSON.stringify(body))], path);
      });
      // Exercise both environment dispatch and the actual credential-owner DO.
      assert.equal((await fetch(new URL("/fixture/openai-grant", origin))).status, 200);
      const pooled = await send("/v1/native/openai/v1/responses", operations.find(([path]) => path === "responses")[1], { "x-client-request-id": "fixture-pooled-create" });
      assert.equal(pooled.status, 200, await pooled.clone().text());
      await pooled.arrayBuffer();
      assert.equal((await calls()).at(-1).headers.authorization, "Bearer fixture-openai-pool");
      // A different diagnostic ID on each control must neither invalidate the
      // create owner digest nor silently disappear at the Durable Object hop.
      for (const [path, method] of [["responses/resp_fixture_pooled", "GET"], ["responses/resp_fixture_pooled/cancel", "POST"]]) {
        const id = "fixture-control-" + method;
        const response = await send("/v1/native/openai/v1/" + path, undefined, { "x-client-request-id": id, "idempotency-key": "fixture-replay-key" }, method);
        assert.equal(response.status, 200, await response.clone().text());
        await response.arrayBuffer();
        const call = (await calls()).at(-1);
        assert.equal(call.method, method);
        assert.equal(call.headers.authorization, "Bearer fixture-openai-pool");
        assert.equal(call.headers["x-client-request-id"], id);
        assert.equal(call.headers["idempotency-key"], undefined);
        assert.deepEqual(call.bytes, []);
      }
    });

    await t.test("multipart transcription preserves diagnostic ID, file bytes and fields on all public aliases", async () => {
      for (const path of ["/v1/audio/transcriptions", "/v1/native/openai/v1/audio/transcriptions", "/v1/proxy/openai/transcriptions"]) {
        const body = new FormData();
        body.set("model", path.includes("/native/") ? "gpt-4o-transcribe" : "openai/gpt-4o-transcribe");
        body.set("language", "en"); body.set("prompt", "synthetic é");
        body.set("file", new File([new Uint8Array([0,255,128,42])], "sample.wav", { type: "audio/wav" }));
        const response = await fetch(new URL(path, origin), { method: "POST", headers: { authorization, "x-client-request-id": "fixture-multipart-id", "idempotency-key": "fixture-replay-key" }, body, signal: AbortSignal.timeout(10_000) });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await response.json()).text, "synthetic transcript");
        const call = (await calls()).at(-1);
        assert.equal(call.headers["x-client-request-id"], "fixture-multipart-id");
        assert.equal(call.headers["idempotency-key"], undefined);
        assert.equal(call.headers.authorization, "Bearer fixture-openai-pool");
        assert.match(call.headers["content-type"], /^multipart\/form-data; boundary=/);
        assert.deepEqual(call.file, { name: "sample.wav", type: "audio/wav", bytes: [0,255,128,42] });
        assert.deepEqual(call.fields, { model: "gpt-4o-transcribe", language: "en", prompt: "synthetic é" });
      }
    });

    await t.test("native Realtime and Responses WebSocket handshakes forward diagnostic IDs", async () => {
      for (const [path, model] of [["realtime", "gpt-realtime-2.1"], ["responses", "gpt-4.1-mini"]]) {
        const response = await mf.dispatchFetch("https://router/v1/native/openai/v1/" + path + "?model=" + model, { headers: { authorization, upgrade: "websocket", "x-client-request-id": "fixture-ws-" + path, "idempotency-key": "fixture-replay-key" } });
        assert.equal(response.status, 101, response.status === 101 ? "" : await response.text());
        const ws = response.webSocket; ws.accept();
        if (path === "responses") {
          const terminal = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error("missing upstream WebSocket terminal")), 4000);
            ws.addEventListener("message", event => { const frame = JSON.parse(event.data); if (["response.completed", "error"].includes(frame.type)) { clearTimeout(timer); resolve(frame); } });
          });
          ws.send(JSON.stringify({ type: "response.create", model, input: "synthetic", max_output_tokens: 8 }));
          assert.equal((await terminal).type, "response.completed");
        }
        ws.close(1000);
        const call = (await calls()).at(-1);
        assert.equal(call.headers["x-client-request-id"], "fixture-ws-" + path);
        assert.equal(call.headers["idempotency-key"], undefined);
        assert.deepEqual(call.bytes, []);
      }
    });

    await t.test("manifest allowlists cannot opt caller identity selectors or unbound idempotency into egress", async () => {
      const response = await send("/fixture/header-copy", {}, { "Anthropic-Workspace-ID": "wrkspc_foreign", "Anthropic-User-Profile-ID": "uprof_foreign", "Idempotency-Key": "fixture-replay-key", "anthropic-beta": "fixture-beta" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { "anthropic-beta": "fixture-beta", "content-type": "application/json" });
    });
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
