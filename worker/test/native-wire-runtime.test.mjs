import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const requestId = "router-correlation";
const upstreamIds = { "request-id": "anthropic-upstream", "x-request-id": "openai-upstream" };
const rateHeaders = {
  "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-tokens": "19", "x-ratelimit-reset-requests": "1s",
  "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-input-tokens-remaining": "23",
  "anthropic-ratelimit-unified-status": "allowed", "retry-after": "7",
};
const errors = {
  openai: { error: { message: "bad input 🦞", type: "invalid_request_error", param: "messages[0].content", code: "invalid_value" } },
  anthropic: { type: "error", error: { type: "overloaded_error", message: "busy 🦞" }, request_id: "anthropic-body-id" },
};
const event = value => `: heartbeat\r\n\r\nevent: error\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const router = `
import worker from "./worker/index.ts";
export * from "./worker/index.ts";
import { sha256Hex } from "./worker/utils.ts";
export default { ...worker, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/setup") {
    const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));
    const policy = { enabled: true, generation: "g1", providers: ["openai", "anthropic"], tenantId: "tenant", monthlyBudgetMicros: null, retainRequestContent: false };
    const credential = { enabled: true, secretSha256: await sha256Hex("fixture-key"), policyId: "fixture", policyGeneration: "g1" };
    for (const [path, body] of [
      ["/policies/initialize-all", [{ policyId: "fixture", policy }]],
      ["/credentials/initialize-all", [{ credentialId: "fixture", credential }, { credentialId: "expired", credential: { ...credential, expiresAt: "2020-01-01T00:00:00.000Z" } }]],
      ["/connections/initialize-all", ["openai", "anthropic"].map(providerId => ({ providerId, enabled: true, monthlyBudgetMicros: null }))],
    ]) {
      const response = await stub.fetch("https://owner" + path, { method: "POST", body: JSON.stringify(body) });
      if (!response.ok) return response;
    }
    return Response.json({ ok: true });
  }
  return worker.fetch(request, { ...env, ANTHROPIC_API_KEY: "fixture-anthropic-key" }, context);
} };
`;
const upstream = `
const errors = ${JSON.stringify(errors)}, ids = ${JSON.stringify(upstreamIds)}, rates = ${JSON.stringify(rateHeaders)};
export default { async fetch(request) {
  const body = await request.json();
  const provider = new URL(request.url).hostname === "api.anthropic.com" ? "anthropic" : "openai";
  const scenario = body.metadata?.fixture;
  const headers = { ...ids, ...rates, "x-clawrouter-request-id": "untrusted-upstream-correlation", "x-clawrouter-error-code": "untrusted-upstream-code", "x-fixture-private": "not-browser-exposed" };
  if (scenario === "json-error") return new Response("  " + JSON.stringify(errors[provider]) + "\\n", { status: 400, headers: { ...headers, "content-type": "application/json" } });
  if (scenario === "sse-error" || scenario === "sse-rejection") {
    const text = ": heartbeat\\r\\n\\r\\nevent: error\\r\\ndata: " + JSON.stringify(errors[provider]) + "\\r\\n\\r\\n";
    const bytes = new TextEncoder().encode(text); let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) return controller.close();
      // Exercise CR/LF and UTF-8 boundaries in the real workerd stream.
      const end = Math.min(bytes.length, offset + 7); controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } }, { highWaterMark: 0 }), { status: scenario === "sse-rejection" ? 429 : 200, headers: { ...headers, "content-type": "text/event-stream" } });
  }
  if (scenario === "unstructured-rejection") return new Response("synthetic gateway failure", { status: 503, headers: { ...headers, "content-type": "text/plain" } });
  if (scenario === "future-event") return new Response('event: future_native_event\\ndata: {"type":"future_native_event","value":"🦞"}\\n\\nevent: message_stop\\ndata: {"type":"message_stop"}\\n\\n', { headers: { ...headers, "content-type": "text/event-stream" } });
  return new Response('{"usage":{"input_tokens":1,"output_tokens":1}}', { headers: { ...headers, "content-type": "application/json" } });
} };
`;
let runtime, temporary;
before(async () => {
  const scratch = join(process.cwd(), ".artifacts");
  await mkdir(scratch, { recursive: true });
  temporary = await mkdtemp(join(scratch, "native-wire-"));
  runtime = await startWorkerdFixture(temporary, router, upstream);
  assert.equal((await runtime.dispatchFetch("https://router.example/fixture/setup")).status, 200);
}, { timeout: 60_000 });
after(async () => { await runtime?.dispose(); if (temporary) await rm(temporary, { recursive: true, force: true }); });

function call(provider, scenario, { path, headers = {}, raw, credential = "fixture", stream = true } = {}) {
  path ??= provider === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const body = { model: provider === "anthropic" ? "claude-sonnet-4-6" : "openai/gpt-6-astra", messages: [{ role: "user", content: "synthetic fixture" }], max_tokens: 8, stream, metadata: { fixture: scenario } };
  return runtime.dispatchFetch("https://router.example" + path, {
    method: "POST", headers: { authorization: `Bearer clawrouter-live-${credential}-fixture-key`, "content-type": "application/json", "x-request-id": requestId, ...headers },
    body: raw ?? JSON.stringify(path.includes("/proxy/") ? { body } : body),
  });
}

for (const provider of ["openai", "anthropic"]) {
  test(`${provider}: streaming JSON rejection preserves exact native bytes and status`, async () => {
    const response = await call(provider, "json-error");
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "  " + JSON.stringify(errors[provider]) + "\n");
  });
  test(`${provider}: first SSE error remains the native 200 event stream, not a synthetic 502`, async () => {
    const response = await call(provider, "sse-error");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new TextEncoder().encode(event(errors[provider])));
  });
  test(`${provider}: non-2xx SSE rejection retains native error fields and upstream HTTP status`, async () => {
    const response = await call(provider, "sse-rejection");
    assert.equal(response.status, 429);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(await response.text(), JSON.stringify(errors[provider]));
    assert.equal(response.headers.get("retry-after"), "7");
  });
  test(`${provider}: router authentication and malformed JSON errors have native shapes`, async () => {
    const paths = provider === "anthropic" ? ["/v1/messages", "/v1/messages/count_tokens", "/v1/native/anthropic/v1/messages", "/v1/proxy/anthropic/messages"] : ["/v1/chat/completions", "/v1/responses", "/v1/audio/transcriptions", "/v1/native/openai/v1/chat/completions", "/v1/proxy/openai/chat_completions"];
    for (const path of paths) {
      const response = await call(provider, "", { path, headers: { authorization: "invalid" } });
      assert.equal(response.status, 401, path);
      const message = "a valid ClawRouter proxy key is required";
      const expected = provider === "anthropic"
        ? { type: "error", error: { type: "authentication_error", message }, request_id: requestId }
        : { error: { message, type: "invalid_request_error", param: null, code: "invalid_proxy_key" } };
      assert.equal(await response.text(), JSON.stringify(expected), path);
      assert.equal(response.headers.get("x-clawrouter-error-code"), "invalid_proxy_key");
      assert.ok(response.headers.get("access-control-expose-headers").split(",").includes("x-clawrouter-error-code"));
      if (provider === "anthropic") assert.equal(response.headers.get("request-id"), requestId);
    }
    const response = await call(provider, "", { raw: "{" });
    assert.equal(response.status, 400);
    const message = "request body must be valid JSON";
    assert.equal(await response.text(), JSON.stringify(provider === "anthropic"
      ? { type: "error", error: { type: "invalid_request_error", message }, request_id: requestId }
      : { error: { message, type: "invalid_request_error", param: null, code: "invalid_json" } }));
  });
  test(`${provider}: expired credentials use the native authentication envelope`, async () => {
    const response = await call(provider, "", { credential: "expired" });
    assert.equal(response.status, 401);
    const value = await response.json();
    assert.equal(value.error.type, provider === "anthropic" ? "authentication_error" : "invalid_request_error");
    if (provider === "anthropic") { assert.equal(value.type, "error"); assert.equal(value.request_id, requestId); }
    else { assert.equal(value.error.param, null); assert.equal(value.error.code, "proxy_key_expired"); }
  });
  test(`${provider}: unstructured upstream failures receive native-shaped fallback details`, async () => {
    const response = await call(provider, "unstructured-rejection");
    assert.equal(response.status, 503);
    assert.equal(await response.text(), JSON.stringify(provider === "anthropic"
      ? { type: "error", error: { type: "api_error", message: "Service Unavailable" }, request_id: upstreamIds["request-id"] }
      : { error: { message: "Service Unavailable", type: "server_error", param: null, code: 503 } }));
  });
}

test("native IDs and rate limits survive and are browser-readable; router ID cannot be spoofed upstream", async () => {
  for (const provider of ["openai", "anthropic"]) {
    const response = await call(provider, "healthy", { stream: false });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"usage":{"input_tokens":1,"output_tokens":1}}');
    const exposed = new Set(response.headers.get("access-control-expose-headers").split(","));
    for (const [name, value] of Object.entries({ ...upstreamIds, ...rateHeaders })) {
      assert.equal(response.headers.get(name), value, name);
      assert.ok(exposed.has(name), name);
    }
    assert.equal(response.headers.get("x-clawrouter-request-id"), requestId);
    assert.equal(response.headers.get("x-clawrouter-error-code"), null);
    assert.ok(exposed.has("x-clawrouter-request-id"));
    assert.ok(!exposed.has("x-fixture-private"));
  }
});

test("native future SSE events stay byte-identical", async () => {
  const response = await call("anthropic", "future-event");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'event: future_native_event\ndata: {"type":"future_native_event","value":"🦞"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
});

test("CORS permits safe native SDK request headers but does not advertise unused DELETE", async () => {
  const response = await runtime.dispatchFetch("https://router.example/v1/messages", { method: "OPTIONS" });
  assert.equal(response.status, 204);
  const allowed = new Set(response.headers.get("access-control-allow-headers").split(","));
  for (const name of ["x-client-request-id", "anthropic-user-profile-id", "anthropic-workspace-id"]) assert.ok(allowed.has(name), name);
  assert.ok(!response.headers.get("access-control-allow-methods").split(",").includes("DELETE"));
});

test("router management errors retain their existing shape outside native interfaces", async () => {
  const response = await runtime.dispatchFetch("https://router.example/v1/no-such-router-endpoint", { headers: { "x-request-id": requestId } });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), JSON.stringify({ error: { code: "route_not_found", message: "route not found" } }));
  const expired = await runtime.dispatchFetch("https://router.example/v1/key/inspect", { headers: { authorization: "Bearer clawrouter-live-expired-fixture-key" } });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).expired, true);
});
