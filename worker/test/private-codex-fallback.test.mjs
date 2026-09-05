import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { default: worker } = await import("../index.ts");
const { sha256Hex } = await import("../utils.ts");
const target = "SYNTHETIC_PRIMARY_TARGET", fallbackTarget = "SYNTHETIC_FALLBACK_TARGET";
const credential = "private-workload-SYNTHETIC_ISOLATED_CREDENTIAL_123456789";
const alias = "internal";

async function fixture() {
  const policy = { version: 1, enabled: true, alias: { id: alias, name: "Codex" }, auth: { mode: "workload", credentialSha256: await sha256Hex(credential) } };
  const upstream = { version: 1, target, fallbackTarget, accountId: "SYNTHETIC_ACCOUNT", accessToken: "SYNTHETIC_SUBSCRIPTION_TOKEN", expiresAt: Date.now() + 3600_000 };
  const env = { PRIVATE_CODEX_POLICY: { get: async () => JSON.stringify(policy) }, PRIVATE_CODEX_UPSTREAM: { get: async () => JSON.stringify(upstream) } };
  const run = (body = {}, headers = {}) => worker.fetch(new Request("https://private.invalid/private/v1/responses", {
    method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: alias, store: false, input: "Synthetic input", ...body }),
  }), env, { waitUntil() { assert.fail("Private calls do not enqueue generic accounting"); } });
  return { policy, upstream, env, run };
}

const failed = (status, code) => Response.json({ error: { code, message: `${target} ${fallbackTarget}` } }, { status });
const completed = (model, output = []) => Response.json({ id: "synthetic-response", object: "response", model, status: "completed", output }, { headers: { "OpenAI-Model": model, "x-codex-turn-state": "synthetic-upstream-affinity" } });
function contained(value) { for (const secret of [target, fallbackTarget, "SYNTHETIC_ACCOUNT", "SYNTHETIC_SUBSCRIPTION_TOKEN"]) assert.equal(value.includes(secret), false); }

test("private fallback stays on the fixed account, rewrites hints, and returns one alias", async (context) => {
  for (const [status, code] of [[404, "model_not_found"], [429, "rate_limit_exceeded"], [503, "overloaded_error"]]) {
    const { run } = await fixture(); const calls = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
      const body = JSON.parse(options.body); calls.push(body);
      assert.equal(options.headers.get("x-codex-routing-hint"), `model=${body.model};tier=priority`);
      assert.equal(options.headers.get("authorization"), "Bearer SYNTHETIC_SUBSCRIPTION_TOKEN");
      return calls.length === 1 ? failed(status, code) : completed(fallbackTarget);
    });
    const result = await run({ service_tier: "priority" }, { "x-codex-routing-hint": `model=${alias};tier=priority` });
    assert.equal(result.status, 200); assert.equal(result.headers.get("openai-model"), alias);
    const body = await result.text(); contained(body); assert.equal(JSON.parse(body).model, alias);
    assert.deepEqual(calls.map(x => x.model), [target, fallbackTarget]);
    assert.deepEqual({ ...calls[0], model: alias }, { ...calls[1], model: alias });
    context.mock.restoreAll();
  }
});

test("private fallback never retries auth, policy, quota, transport, or successful streaming responses", async (context) => {
  for (const makeResponse of [
    () => failed(401, "unauthorized"), () => failed(403, "misalignment_policy_violation"),
    () => failed(429, "insufficient_quota"), () => failed(503, "cyber_policy"),
    () => { throw new Error(target); },
    () => new Response('data: {"type":"error","message":"synthetic failure"}\n\n', { headers: { "content-type": "text/event-stream" } }),
  ]) {
    const { run } = await fixture(); let calls = 0;
    context.mock.method(globalThis, "fetch", async () => { calls++; return makeResponse(); });
    const result = await run({ stream: true }); contained(await result.text()); assert.equal(calls, 1);
    context.mock.restoreAll();
  }
});

test("private fallback is bounded and refuses server-side continuation or affinity", async (context) => {
  for (const [body, headers, expected] of [[{}, {}, 2], [{ previous_response_id: "synthetic-response" }, {}, 1], [{}, { "x-codex-turn-state": "synthetic-affinity" }, 1]]) {
    const { run } = await fixture(); let calls = 0;
    context.mock.method(globalThis, "fetch", async () => { calls++; return failed(429, "rate_limit_exceeded"); });
    const result = await run(body, headers); assert.equal(result.status, 429); contained(await result.text()); assert.equal(calls, expected);
    context.mock.restoreAll();
  }
});

test("private fallback revalidates revocation and configuration before a second call", async (context) => {
  for (const change of [x => { x.policy.enabled = false; }, x => { x.upstream.fallbackTarget = "SYNTHETIC_ROTATED_TARGET"; }, x => { x.upstream.expiresAt = 1; }]) {
    const state = await fixture(); let calls = 0;
    context.mock.method(globalThis, "fetch", async () => { calls++; change(state); return failed(503, "server_error"); });
    const result = await state.run(); assert.equal(result.status, 404); contained(await result.text()); assert.equal(calls, 1);
    context.mock.restoreAll();
  }
});

test("both configured identities stay sensitive on either successful target", async (context) => {
  for (const fallback of [false, true]) {
    const { run } = await fixture(); let calls = 0;
    context.mock.method(globalThis, "fetch", async () => {
      if (++calls === 1 && fallback) return failed(503, "server_error");
      return completed(fallback ? fallbackTarget : target, [{ type: "message", content: [{ type: "output_text", text: fallback ? target : fallbackTarget }] }]);
    });
    const result = await run(); assert.equal(result.status, 502); contained(await result.text());
    context.mock.restoreAll();
  }
});

test("invalid private fallback configuration fails before upstream", async (context) => {
  for (const invalid of [null, "", target, [], "invalid/model"]) {
    const { run, upstream } = await fixture(); upstream.fallbackTarget = invalid;
    let calls = 0; context.mock.method(globalThis, "fetch", async () => { calls++; return completed(target); });
    assert.equal((await run()).status, 404); assert.equal(calls, 0);
    context.mock.restoreAll();
  }
});

test("fallback response IDs and affinity keep subsequent tool turns on their originating target", async (context) => {
  const { run } = await fixture(); const calls = [];
  context.mock.method(globalThis, "fetch", async (_, options) => {
    const body = JSON.parse(options.body); calls.push({ body, affinity: options.headers.get("x-codex-turn-state") });
    return calls.length === 1 ? failed(503, "server_error") : completed(fallbackTarget);
  });
  const first = await run(); const affinity = first.headers.get("x-codex-turn-state");
  const previous = (await first.json()).id;
  assert.match(previous, /^cr1\./); assert.match(affinity, /^cr1\./);
  contained(previous + affinity);
  const second = await run({ previous_response_id: previous }, { "x-codex-turn-state": affinity });
  assert.equal(second.status, 200); contained(await second.text());
  assert.deepEqual(calls.map(x => x.body.model), [target, fallbackTarget, fallbackTarget]);
  assert.equal(calls[2].body.previous_response_id, "synthetic-response");
  assert.equal(calls[2].affinity, "synthetic-upstream-affinity");
});

test("private continuation tampering, rotation, and conflicting origins fail before upstream", async (context) => {
  const state = await fixture(); let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls++; return completed(target); });
  const first = await state.run(); const primary = (await first.json()).id;
  const { privateContinuations } = await import("../private-codex-continuation.ts");
  const codec = await privateContinuations(state.policy, state.upstream);
  const fallback = await (await codec.projection(1)).wrap("synthetic-affinity");
  assert.equal((await state.run({ previous_response_id: primary }, { "x-codex-turn-state": fallback })).status, 400);
  const parts = primary.split("."); parts[1] = (parts[1][0] === "A" ? "B" : "A") + parts[1].slice(1);
  assert.equal((await state.run({ previous_response_id: parts.join(".") })).status, 400);
  assert.equal((await state.run({ previous_response_id: fallback + "." + Buffer.from("synthetic-response").toString("base64url") })).status, 400);
  const payload = Buffer.from(fallback.slice(4), "base64url"); payload[payload.length - 1] ^= 1;
  assert.equal((await state.run({ previous_response_id: "cr1." + payload.toString("base64url") })).status, 400);
  state.upstream.accessToken = "SYNTHETIC_ROTATED_SUBSCRIPTION_TOKEN";
  assert.equal((await state.run({ previous_response_id: primary })).status, 400);
  assert.equal(calls, 1);
});

test("typed affinity header casing and singleton arrays preserve fallback continuation", async (context) => {
  for (const envelope of ["json", "sse-top", "sse-response"]) for (const key of ["x-codex-turn-state", "X-Codex-Turn-State"]) for (const array of [false, true]) {
    const { run } = await fixture(); const calls = [];
    const upstreamAffinity = "synthetic-typed-affinity";
    context.mock.method(globalThis, "fetch", async (_, options) => {
      const body = JSON.parse(options.body);
      calls.push({ model: body.model, affinity: options.headers.get("x-codex-turn-state"), previous: body.previous_response_id });
      if (calls.length === 1) return failed(503, "server_error");
      const headers = { [key]: array ? [upstreamAffinity] : upstreamAffinity };
      const response = { id: "synthetic-typed-response", object: "response", model: fallbackTarget, status: "completed", output: [] };
      if (envelope === "json") return Response.json({ ...response, headers });
      const event = envelope === "sse-top"
        ? { type: "response.completed", response, headers }
        : { type: "response.completed", response: { ...response, headers } };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const first = await run({ stream: envelope !== "json" });
    assert.equal(first.status, 200);
    const raw = await first.text(); contained(raw);
    const projected = JSON.parse(envelope === "json" ? raw : raw.trim().slice("data: ".length));
    assert.notEqual(projected.type, "error");
    const response = envelope === "json" ? projected : projected.response;
    const headers = envelope === "sse-top" ? projected.headers : response.headers;
    assert.equal(Array.isArray(headers[key]), array);
    const affinity = array ? headers[key][0] : headers[key];
    assert.match(affinity, /^cr1\./);
    for (const body of [{}, { previous_response_id: response.id }]) {
      const next = await run({ stream: envelope !== "json", ...body }, { "x-codex-turn-state": affinity });
      assert.equal(next.status, 200); contained(await next.text());
    }
    assert.deepEqual(calls.map(call => call.model), [target, fallbackTarget, fallbackTarget, fallbackTarget]);
    assert.equal(calls[2].affinity, upstreamAffinity);
    assert.equal(calls[3].previous, "synthetic-typed-response");
    context.mock.restoreAll();
  }
});

test("streaming fallback wraps typed response state consistently without touching tool identities", async (context) => {
  const { run } = await fixture(); const calls = [];
  context.mock.method(globalThis, "fetch", async (_, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) return failed(503, "server_error");
    const response = { id: "resp-synthetic", model: fallbackTarget, status: "completed", previous_response_id: "resp-before", output: [] };
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress" } },
      { type: "response.output_item.done", response_id: "resp-synthetic", item: { type: "function_call", id: "tool-synthetic", call_id: "call-synthetic", name: "synthetic_tool", arguments: "{}" }, output_index: 0 },
      { type: "response.completed", response },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-codex-turn-state": "affinity-synthetic" } });
  });
  const result = await run({ stream: true });
  const raw = await result.text(); contained(raw);
  const events = raw.trim().split("\n\n").map(frame => JSON.parse(frame.split("data: ")[1]));
  assert.equal(events.length, 3);
  const id = events[0].response.id;
  assert.match(id, /^cr1\./); assert.equal(events[1].response_id, id); assert.equal(events[2].response.id, id);
  assert.match(events[2].response.previous_response_id, /^cr1\./);
  assert.equal(events[1].item.call_id, "call-synthetic"); assert.equal(events[1].item.id, "tool-synthetic");
  const next = await run({ stream: true, previous_response_id: id }, { "x-codex-turn-state": result.headers.get("x-codex-turn-state") });
  assert.equal(next.status, 200); await next.text();
  assert.equal(calls[2].model, fallbackTarget); assert.equal(calls[2].previous_response_id, "resp-synthetic");
});
