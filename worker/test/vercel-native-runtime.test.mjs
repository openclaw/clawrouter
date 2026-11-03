import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { snapshot, configuredUpstream } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { providers: [provider] } = JSON.parse(execFileSync(process.execPath,
  ["scripts/compile-providers.mjs", "providers/vercel-ai-gateway.provider.yaml"], { encoding: "utf8" }));
const id = "vercel-ai-gateway", model = "anthropic/claude-sonnet-4.6";
const usage = { input_tokens: 100, output_tokens: 20 };
const result = { id: "msg_fixture", type: "message", role: "assistant", model,
  content: [{ type: "text", text: "synthetic-answer" }], stop_reason: "end_turn", stop_sequence: null, usage };
const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const replay = [
  { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-thinking", signature: "synthetic-signature" },
    { type: "redacted_thinking", data: "synthetic-redacted" }, { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_fixture", content: "synthetic-result" }] },
];

async function fixture(t, models = null) {
  const row = structuredClone(provider); snapshot.providers.push(row);
  t.after(() => snapshot.providers.splice(snapshot.providers.indexOf(row), 1));
  const values = new Map(), pending = [], events = [], sent = [];
  const env = { AI_GATEWAY_API_KEY: "synthetic-gateway-key", ANTHROPIC_API_KEY: "synthetic-foreign-key", VERCEL_OIDC_TOKEN: "synthetic-oidc",
    POLICY_KV: { async get(k) { return Array.isArray(k) ? new Map(k.map(k => [k, values.get(k) ?? null])) : values.get(k) ?? null; },
      async put(k, v) { values.set(k, JSON.parse(v)); }, async list() { return { keys: [], list_complete: true }; } },
    BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  const policy = { enabled: true, generation: "fixture", providers: [id], models, tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["anthropic"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async id => ({ credentialId: id,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${id}`), policyId: id, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: id, enabled: true }]);
  const f = { env, events, sent, reply: () => Response.json(result),
    call(path, body, key = "paid") { return worker.fetch(new Request(`https://router.example${path}`, {
      method: body == null ? "GET" : "POST", headers: { authorization: `Bearer clawrouter-live-${key}-fixture-${key}`,
        "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "fixture-beta", "x-api-key": "synthetic-caller-key" },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
    }), env, { waitUntil: p => pending.push(p) }); }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain); return f;
}

test("Vercel gateway does not substitute native lab keys, OIDC or invented model prices", () => {
  assert.throws(() => configuredUpstream(provider, null, { ANTHROPIC_API_KEY: "synthetic-lab", VERCEL_OIDC_TOKEN: "synthetic-oidc" }), e => e.code === "provider_not_configured");
  assert.equal(provider.models.length, 1); assert.equal(provider.models[0].pricing, null);
  assert.equal(provider.models[0].nativeCapabilities, undefined);
});

for (const manifest of [false, true]) for (const stream of [false, true]) test(`Vercel ${manifest ? "manifest" : "native"} Messages ${stream ? "SSE" : "JSON"} preserves replay and settles one fixed charge`, async t => {
  const f = await fixture(t), body = { model, max_tokens: 256, stream, messages: replay,
    system: [{ type: "text", text: "synthetic-system", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }] };
  const wire = frame({ type: "message_start", message: { ...result, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } })
    + frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic-answer" } })
    + frame({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }) + frame({ type: "message_stop" });
  let upstreamError;
  f.reply = async request => {
    try {
      assert.equal(request.url, "https://ai-gateway.vercel.sh/v1/messages");
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-gateway-key");
      assert.equal(request.headers.get("x-api-key"), null);
      assert.equal(request.headers.get("anthropic-version"), "2023-06-01");
      assert.equal(request.headers.get("anthropic-beta"), "fixture-beta");
      assert.deepEqual(await request.json(), body);
      assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
      if (!stream) return Response.json(result);
      const bytes = new TextEncoder().encode(wire); let offset = 0;
      return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }),
        { headers: { "content-type": "text/event-stream" } });
    } catch (e) { upstreamError = e; throw e; }
  };
  const r = await f.call(manifest ? `/v1/proxy/${id}/messages` : `/v1/native/${id}/v1/messages`, manifest ? { body: { ...body, model: `${id}/${model}` } } : body);
  assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
  if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), result);
  await f.drain(); assert.equal(f.sent.length, 1);
  const rows = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(rows.length, 1); assert.equal(rows[0].status, "success");
  assert.deepEqual([rows[0].input_tokens, rows[0].output_tokens, rows[0].total_tokens], [100, 20, 120]);
  assert.equal(rows[0].actual_cost_micros, 7); assert.doesNotMatch(JSON.stringify(rows), /synthetic-(?:thinking|signature|redacted|result|system|answer|gateway-key)/);
  const reservations = f.env.BUDGET_LEDGER.get("fixture:paid").reservations(); assert.equal(reservations.length, 1); assert.equal(reservations[0].settled, 1);
});

test("Vercel foreign policy and unknown price reject before egress", async t => {
  const f = await fixture(t), body = { model, max_tokens: 16, messages: [] };
  assert.equal((await f.call(`/v1/native/${id}/messages`, body, "foreign")).status, 403);
  assert.equal((await f.call(`/v1/native/${id}/messages`, body, "unpriced")).status, 400);
  assert.equal(f.sent.length, 0);
});

test("Vercel native SSE error retains error identity without fabricated usage", async t => {
  const f = await fixture(t);
  f.reply = () => new Response(frame({ type: "error", error: { type: "overloaded_error", message: "synthetic-upstream-error" } }), { headers: { "content-type": "text/event-stream" } });
  const r = await f.call(`/v1/native/${id}/messages`, { model, max_tokens: 16, messages: [], stream: true });
  const body = await r.text(); await f.drain(); assert.match(body, /overloaded_error/);
  const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(event.status, "provider_error"); assert.equal(event.total_tokens, null);
});

test("Vercel Messages disconnect cancels transport and leaves unknown usage", async t => {
  const f = await fixture(t); let cancelled = false;
  f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture" } }))); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const r = await f.call(`/v1/native/${id}/messages`, { model, max_tokens: 16, messages: [], stream: true }); assert.equal(r.status, 200);
  const reader = r.body.getReader(); await reader.read(); await reader.cancel(); await f.drain(); assert.equal(cancelled, true);
  const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(event.status, "client_error"); assert.equal(event.total_tokens, null);
});

test("Vercel dynamic catalog is policy-filtered without promoting upstream pricing into inference", async t => {
  const f = await fixture(t, [`${id}/${model}`]);
  const visible = { id: model, object: "model", pricing: { input: "0.00001" }, reasoning_options: { type: "budget", min: 1024 } };
  f.reply = request => { assert.equal(request.url, "https://ai-gateway.vercel.sh/v1/models"); assert.equal(request.headers.get("authorization"), "Bearer synthetic-gateway-key");
    return Response.json({ object: "list", data: [visible, { id: "other/hidden", object: "model" }] }); };
  const r = await f.call(`/v1/native/${id}/models`); assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { object: "list", data: [visible] }); await f.drain();
  assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations().length, 0); assert.equal(provider.models[0].pricing, null);
});
