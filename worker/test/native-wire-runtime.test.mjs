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
const dataEvent = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const continued = {
  openai: [
    { object: "chat.completion.chunk", choices: [{ delta: { content: "real output 🦞" } }] },
    { object: "chat.completion.chunk", choices: [], service_tier: "default", usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } },
  ].map(dataEvent).join("") + "data: [DONE]\r\n\r\n",
  responses: [
    { type: "response.output_text.delta", delta: "real output 🦞" },
    { type: "response.completed", response: { id: "resp_after_error", status: "completed", service_tier: "default", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } },
  ].map(dataEvent).join(""),
  anthropic: [
    { type: "message_start", message: { type: "message", usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "real output 🦞" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ].map(dataEvent).join(""),
};
const followup = (kind, mode) => mode === "marker" || mode === "marker-usage"
  ? (kind === "anthropic" ? dataEvent({ type: "message_stop" }) : "data: [DONE]\r\n\r\n") + (mode === "marker-usage" ? continued[kind] : "")
  : mode === "empty" ? ": keepalive\r\n\r\ndata: \r\n\r\n"
  : mode === "usage" ? continued[kind]
  : mode === "null-error" ? continued[kind].replaceAll('data: {', 'data: {"error":null,')
  : mode === "truncated" ? dataEvent(kind === "anthropic" ? { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } } : kind === "responses" ? { type: "response.output_text.delta", delta: "real output" } : { object: "chat.completion.chunk", choices: [{ delta: { content: "real output" } }] })
  : mode === "oversized" ? dataEvent({ type: "future_event", output: "x".repeat(2 * 1024 * 1024 + 100) })
  : mode === "invalid" ? "data: not-json\r\n\r\n"
  : ": keepalive\r\n\r\ndata: \r\n\r\n" + event(errors[kind === "anthropic" ? kind : "openai"]);
const router = `
import worker, { BudgetLedgerObject as Budget } from "./worker/index.ts";
export * from "./worker/index.ts";
import { sha256Hex } from "./worker/utils.ts";
import { ingestUsage, usageStub } from "./worker/ledgers.ts";
export class BudgetLedgerObject extends Budget {
  constructor(state) { super(state); this.sql = state.storage.sql; }
  async fetch(request) { if (new URL(request.url).pathname === "/rows") return Response.json([...this.sql.exec("SELECT * FROM budget_reservations")]); return super.fetch(request); }
}
export default { ...worker, async fetch(request, env, context) {
  const url = new URL(request.url);
  if (url.pathname === "/fixture/events") return usageStub(env, "tenant", "fixture").fetch("https://usage/snapshot?events=admin");
  if (url.pathname === "/fixture/rows") return env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(url.searchParams.get("name"))).fetch("https://budget/rows");
  if (url.pathname === "/fixture/setup") {
    const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));
    const policy = { enabled: true, generation: "g1", providers: ["openai", "anthropic"], tenantId: "tenant", monthlyBudgetMicros: 10_000_000, retainRequestContent: false };
    const credential = { enabled: true, secretSha256: await sha256Hex("fixture-key"), policyId: "fixture", policyGeneration: "g1" };
    for (const [path, body] of [
      ["/policies/initialize-all", [{ policyId: "fixture", policy }]],
      ["/credentials/initialize-all", [{ credentialId: "fixture", credential }, { credentialId: "expired", credential: { ...credential, expiresAt: "2020-01-01T00:00:00.000Z" } }]],
      ["/connections/initialize-all", ["openai", "anthropic"].map(providerId => ({ providerId, enabled: true, monthlyBudgetMicros: 10_000_000 }))],
    ]) {
      const response = await stub.fetch("https://owner" + path, { method: "POST", body: JSON.stringify(body) });
      if (!response.ok) return response;
    }
    return Response.json({ ok: true });
  }
  return worker.fetch(request, { ...env, ANTHROPIC_API_KEY: "fixture-anthropic-key", USAGE_QUEUE: { send: event => ingestUsage(env, event) } }, context);
} };
`;
const upstream = `
const errors = ${JSON.stringify(errors)}, ids = ${JSON.stringify(upstreamIds)}, rates = ${JSON.stringify(rateHeaders)};
const continued = ${JSON.stringify(continued)};
const dataEvent = ${dataEvent.toString()}, event = ${event.toString()}, followup = ${followup.toString()};
export default { async fetch(request) {
  const body = await request.json();
  const provider = new URL(request.url).hostname === "api.anthropic.com" ? "anthropic" : "openai";
  const scenario = body.metadata?.fixture;
  const headers = { ...ids, ...rates, "x-clawrouter-request-id": "untrusted-upstream-correlation", "x-clawrouter-error-code": "untrusted-upstream-code", "x-fixture-private": "not-browser-exposed", "openai-organization": "fixture-org", "openai-project": "fixture-project", "anthropic-organization-id": "fixture-anthropic-org", "anthropic-workspace-id": "fixture-workspace" };
  if (scenario === "json-error") return new Response("  " + JSON.stringify(errors[provider]) + "\\n", { status: 400, headers: { ...headers, "content-type": "application/json" } });
  if (scenario.startsWith("after-error:")) {
    const [, kind, mode] = scenario.split(":");
    const bytes = new TextEncoder().encode(event(errors[provider]) + followup(kind, mode)); let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(bytes.length, offset + (mode === "oversized" ? 4093 : 7));
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } }, { highWaterMark: 0 }), { headers: { ...headers, "content-type": "text/event-stream" } });
  }
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
    for (const name of ["openai-organization", "openai-project", "anthropic-organization-id", "anthropic-workspace-id"]) assert.equal(response.headers.get(name), null, name);
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

test("first native SSE errors release both real SQL budgets, including durable background creation", async () => {
  const rows = async name => (await (await runtime.dispatchFetch("https://router.example/fixture/rows?name=" + encodeURIComponent(name))).json());
  for (const [path, provider, background] of [["/v1/chat/completions", "openai", false], ["/v1/responses", "openai", false], ["/v1/messages", "anthropic", false], ["/v1/responses", "openai", true]]) {
    const id = `free-${provider}-${background}-${path.replaceAll("/", "-")}`;
    const owners = ["tenant:fixture", "provider:" + provider], before = await Promise.all(owners.map(rows));
    const raw = JSON.stringify({ model: provider === "anthropic" ? "claude-sonnet-4-6" : "openai/gpt-6-astra", input: "synthetic", messages: [{ role: "user", content: "synthetic" }], max_tokens: 16, max_output_tokens: 16, stream: true, ...(background ? { background: true } : {}), metadata: { fixture: "sse-error" } });
    const response = await call(provider, "sse-error", { path, raw, headers: { "x-request-id": id } });
    assert.equal(response.status, 200); assert.equal(await response.text(), event(errors[provider]));
    let receipt;
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await (await runtime.dispatchFetch("https://router.example/fixture/events")).json();
      receipt = snapshot.events.find(value => value.request_id === id);
      if (receipt) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(receipt, "one durable usage receipt must be visible");
    assert.equal(receipt.status_code, 200); assert.equal(receipt.status, "provider_error");
    assert.equal(receipt.actual_cost_micros, 0); assert.equal(receipt.cost_basis, "none");
    assert.ok(receipt.reserved_cost_micros > 0, "a real reservation was released");
    for (let index = 0; index < owners.length; index++) {
      const added = (await rows(owners[index])).slice(before[index].length);
      assert.equal(added.length, 1); assert.equal(added[0].settled, 1); assert.equal(added[0].reserved_micros, 0);
    }
  }
});

// A provider may violate its terminal-error contract. Preserve its bytes, but
// observable later work must withdraw the initial no-charge evidence.
for (const [kind, path, background] of [["openai", "/v1/chat/completions", false], ["responses", "/v1/responses", false], ["anthropic", "/v1/messages", false], ["responses", "/v1/responses", true]]) {
  for (const mode of ["marker", "marker-usage", "empty", "usage", "null-error", "truncated", "errors-only", "invalid", "oversized"]) test(`first SSE error followed by ${mode}: ${kind}, background=${background}`, { timeout: 60000 }, async () => {
    const provider = kind === "anthropic" ? kind : "openai", id = `continued-${kind}-${background}-${mode}`;
    const owners = ["tenant:fixture", "provider:" + provider];
    const rows = async name => (await (await runtime.dispatchFetch("https://router.example/fixture/rows?name=" + encodeURIComponent(name))).json());
    const before = await Promise.all(owners.map(rows));
    const raw = JSON.stringify({ model: provider === "anthropic" ? "claude-sonnet-4-6" : "openai/gpt-6-astra", input: "synthetic", messages: [{ role: "user", content: "synthetic" }], max_tokens: 16, max_output_tokens: 16, stream: true, ...(background ? { background: true } : {}), metadata: { fixture: `after-error:${kind}:${mode}` } });
    const response = await call(provider, "", { path, raw, headers: { "x-request-id": id } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), event(errors[provider]) + followup(kind, mode));
    let receipt;
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await (await runtime.dispatchFetch("https://router.example/fixture/events")).json();
      const matches = snapshot.events.filter(value => value.request_id === id);
      if (matches.length) { assert.equal(matches.length, 1); receipt = matches[0]; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(receipt, "one durable receipt must be visible");
    assert.equal(receipt.status_code, 200); assert.equal(receipt.status, "provider_error");
    if (mode === "errors-only" || mode === "marker" || mode === "empty") { assert.equal(receipt.actual_cost_micros, 0); assert.equal(receipt.cost_basis, "none"); }
    else {
      assert.ok(receipt.actual_cost_micros > 0, "delivered work cannot be free");
      if (mode === "usage" || mode === "null-error" || mode === "marker-usage") {
        assert.deepEqual([receipt.input_tokens, receipt.output_tokens, receipt.total_tokens], [10, 2, 12]);
        assert.equal(receipt.cost_basis, "manifest_pricing");
        assert.equal(receipt.actual_cost_micros, provider === "anthropic" ? 60 : 200);
        assert.ok(receipt.actual_cost_micros < receipt.reserved_cost_micros, "authoritative usage replaces the reservation");
      } else { assert.equal(receipt.actual_cost_micros, receipt.reserved_cost_micros); assert.equal(receipt.cost_basis, "manifest_reservation"); }
    }
    for (let index = 0; index < owners.length; index++) {
      const added = (await rows(owners[index])).slice(before[index].length);
      assert.equal(added.length, 1); assert.equal(added[0].settled, 1); assert.equal(added[0].reserved_micros, receipt.actual_cost_micros);
    }
    if (kind === "responses" && (mode === "usage" || mode === "marker-usage")) {
      const follow = await call("openai", "", { path: "/v1/responses", raw: JSON.stringify({ model: "openai/gpt-6-astra", input: "x", previous_response_id: "resp_after_error", max_output_tokens: 1, stream: true }), headers: { "x-request-id": "unpublished-" + background + "-" + mode } });
      assert.equal(follow.status, 409); assert.equal((await follow.json()).error.code, "continuation_restart_required");
    }
  });
}
