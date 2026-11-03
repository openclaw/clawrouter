import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { snapshot, configuredUpstream } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const { providers: [provider] } = JSON.parse(execFileSync(process.execPath,
  ["scripts/compile-providers.mjs", "providers/synthetic.provider.yaml"], { encoding: "utf8" }));
const models = ["syn:large:text", "hf:openai/gpt-oss-120b", "hf:zai-org/GLM-4.7-Flash"], model = models[1];
const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const usage = { input_tokens: 100, output_tokens: 20 };
const result = selected => ({ id: "msg_fixture", type: "message", role: "assistant", model: selected,
  content: [{ type: "text", text: "synthetic-answer" }], stop_reason: "end_turn", stop_sequence: null, usage });
const replay = [
  { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-thinking", signature: "synthetic-signature" },
    { type: "redacted_thinking", data: "synthetic-redacted" }, { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_fixture", content: "synthetic-tool-result" }] },
];
const catalogRow = (id = model) => ({ id, name: "Synthetic fixture model", context_length: 131072, max_output_length: 65536,
  input_modalities: ["text"], output_modalities: ["text"], supported_features: ["tools", "reasoning"],
  reasoning_parameters: { efforts: ["none", "low", "high"] } });

async function fixture(t, { ownGrant = true, permitted = models } = {}) {
  const index = snapshot.providers.findIndex(p => p.id === "synthetic"), previous = snapshot.providers[index];
  assert.ok(index >= 0); snapshot.providers[index] = structuredClone(provider);
  t.after(() => { snapshot.providers[index] = previous; });
  const values = new Map(), pending = [], events = [], sent = [];
  const env = { ANTHROPIC_API_KEY: "synthetic-foreign-lab", OPENAI_API_KEY: "synthetic-foreign-openai", POLICY_KV: {
    async get(k) { return Array.isArray(k) ? new Map(k.map(k => [k, values.get(k) ?? null])) : values.get(k) ?? null; },
    async put(k, v) { values.set(k, JSON.parse(v)); }, async list() { return { keys: [], list_complete: true }; },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: ["synthetic"], models: permitted?.map(m => `synthetic/${m}`) ?? null,
    tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["anthropic"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async id => ({ credentialId: id,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${id}`), policyId: id, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "synthetic", enabled: true }]);
  await putGrantCredentials(env, "oauth/paid/anthropic", { provider: "anthropic", kind: "api_key", enabled: true, credential: "synthetic-other-grant" });
  for (const p of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${p}/synthetic`, {
    provider: "synthetic", kind: "api_key", enabled: true, credential: "synthetic-selected" });
  const f = { env, events, sent, reply: () => Response.json(result(model)),
    call(path, body, policyId = "paid") {
      return worker.fetch(new Request(`https://router.example${path}`, {
        method: body == null ? "GET" : "POST", headers: { authorization: `Bearer clawrouter-live-${policyId}-fixture-${policyId}`,
          "content-type": "application/json", "x-api-key": "synthetic-caller-key", "anthropic-version": "2023-06-01", "anthropic-beta": "fixture-beta" },
        ...(body == null ? {} : { body: JSON.stringify(body) }),
      }), env, { waitUntil: p => pending.push(p) });
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain); return f;
}

const messagePath = manifest => manifest ? "/v1/proxy/synthetic/messages" : "/v1/native/synthetic/v1/messages";
const messageBody = (body, manifest) => manifest ? { body: { ...body, model: `synthetic/${body.model}` } } : body;

test("Synthetic manifest separates public path identity from literal upstream dispatch", () => {
  assert.equal(provider.base_urls.default, "https://api.synthetic.new");
  assert.deepEqual(provider.models.map(m => m.upstream), models);
  const endpoint = id => provider.endpoints.find(e => e.id === id);
  assert.deepEqual([endpoint("messages").path, endpoint("messages").upstreamPath], ["/v1/messages", "/anthropic/v1/messages"]);
  assert.deepEqual([endpoint("chat_completions").path, endpoint("chat_completions").upstreamPath], ["/chat/completions", "/openai/v1/chat/completions"]);
  assert.deepEqual([endpoint("models_list").path, endpoint("models_list").upstreamPath, endpoint("models_list").request_format], ["/models", "/openai/v1/models", "synthetic.models"]);
  assert.ok(provider.models.every(m => m.pricing === null));
  assert.throws(() => configuredUpstream(provider, null, { ANTHROPIC_API_KEY: "synthetic-lab", OPENAI_API_KEY: "synthetic-openai" }), e => e.code === "provider_not_configured");
});

for (const selected of models) for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`Synthetic ${selected} ${manifest ? "manifest" : "native"} Messages ${stream ? "SSE" : "JSON"} preserves replay, selected credential and accounting`, async t => {
    const f = await fixture(t), body = { model: selected, max_tokens: 256, stream, messages: replay,
      system: [{ type: "text", text: "synthetic-system" }], tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }], tool_choice: { type: "auto" } };
    const wire = frame({ type: "message_start", message: { ...result(selected), content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } })
      + frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })
      + frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "synthetic-thinking" } })
      + frame({ type: "content_block_stop", index: 0 })
      + frame({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_next", name: "lookup", input: {} } })
      + frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{" } })
      + frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "}" } })
      + frame({ type: "content_block_stop", index: 1 })
      + frame({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } })
      + frame({ type: "message_stop" });
    let upstreamError;
    f.reply = async r => {
      try {
        assert.equal(r.url, "https://api.synthetic.new/anthropic/v1/messages"); assert.equal(r.headers.get("authorization"), "Bearer synthetic-selected");
        assert.equal(r.headers.get("x-api-key"), null); assert.equal(r.headers.get("anthropic-version"), "2023-06-01"); assert.equal(r.headers.get("anthropic-beta"), "fixture-beta");
        assert.deepEqual(await r.json(), body); assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json(result(selected));
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) {
          if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; }
        } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamError = e; throw e; }
    };
    const r = await f.call(messagePath(manifest), messageBody(body, manifest));
    assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
    if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), result(selected));
    await f.drain(); assert.equal(f.sent.length, 1);
    const events = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(events.length, 1);
    assert.deepEqual([events[0].input_tokens, events[0].output_tokens, events[0].total_tokens, events[0].cached_input_tokens, events[0].actual_cost_micros], [100, 20, 120, null, 7]);
    assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].settled, 1);
    assert.doesNotMatch(JSON.stringify(events), /synthetic-(?:selected|thinking|signature|redacted|tool-result|system|answer)/);
  });
}

for (const manifest of [false, true]) test(`Synthetic ${manifest ? "manifest" : "native"} Chat seed retains its original upstream path and moving alias`, async t => {
  const f = await fixture(t), body = { model: models[0], messages: [{ role: "user", content: "synthetic-input" }], reasoning_effort: "high" };
  const observed = { id: "chatcmpl_fixture", model: "synthetic-serving-model", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "synthetic-answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
  f.reply = () => Response.json(observed);
  const r = await f.call(manifest ? "/v1/proxy/synthetic/chat_completions" : "/v1/native/synthetic/chat/completions", messageBody(body, manifest));
  assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), observed);
  assert.equal(f.sent[0].url, "https://api.synthetic.new/openai/v1/chat/completions"); assert.deepEqual(await f.sent[0].json(), body);
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-selected"); await f.drain(); assert.equal(f.sent.length, 1);
});

test("Synthetic data-only discovery filters the original policy without inference charges", async t => {
  const f = await fixture(t, { permitted: [model] }), visible = catalogRow();
  f.reply = () => Response.json({ data: [visible, catalogRow(models[2]), { ...catalogRow("hf:other/embedding"), output_modalities: ["embedding"] }] });
  const r = await f.call("/v1/native/synthetic/models"); assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { data: [visible] }); assert.equal(r.headers.get("cache-control"), "private, no-store"); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, "https://api.synthetic.new/openai/v1/models");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-selected");
  for (const reservation of f.env.BUDGET_LEDGER.get("fixture:paid").reservations()) assert.equal(reservation.reserved_micros, 0);
  assert.equal(f.events.find(e => e.type === "clawrouter.usage.v1").actual_cost_micros, 0);
});

test("Synthetic discovery rejects malformed envelopes and unsupported cursors", async t => {
  const f = await fixture(t);
  for (const query of ["after_id=hidden", "before_id=hidden", "limit=1", "upstreamPath=other"]) {
    assert.equal((await f.call(`/v1/native/synthetic/models?${query}`)).status, 400);
  }
  assert.equal(f.sent.length, 0);
  f.reply = () => Response.json({ object: "list", models: [] });
  const r = await f.call("/v1/native/synthetic/models"); assert.equal(r.status, 502);
  assert.equal((await r.json()).error.code, "invalid_model_discovery_response");
});

test("Synthetic public caller route cannot be replaced with its dispatch-only upstream path", async t => {
  const f = await fixture(t);
  const r = await f.call("/v1/native/synthetic/anthropic/v1/messages", { model, max_tokens: 16, messages: [] });
  assert.equal(r.status, 404); assert.equal(f.sent.length, 0);
});

test("Synthetic foreign policy and unpriced hard budget reject before egress", async t => {
  const f = await fixture(t), body = { model, max_tokens: 16, messages: [] };
  assert.equal((await f.call(messagePath(false), body, "foreign")).status, 403);
  assert.equal((await f.call(messagePath(false), body, "unpriced")).status, 400); assert.equal(f.sent.length, 0);
});

test("Synthetic missing or revoked original grant cannot borrow a lab credential", async t => {
  const f = await fixture(t, { ownGrant: false }), body = { model, max_tokens: 16, messages: [] };
  assert.equal((await f.call(messagePath(false), body)).status, 503);
  await putGrantCredentials(f.env, "oauth/paid/synthetic", { provider: "synthetic", kind: "api_key", enabled: true, credential: "synthetic-revoked" });
  await revokeGrantCredentials(f.env, "oauth/paid/synthetic"); assert.equal((await f.call(messagePath(false), body)).status, 503); assert.equal(f.sent.length, 0);
});

for (const status of [401, 403, 429]) test(`Synthetic Messages ${status} preserves the native error without Chat or account fallback`, async t => {
  const f = await fixture(t); const error = { type: "error", error: { type: "synthetic_rejection", message: "synthetic-error" } };
  f.reply = () => Response.json(error, { status });
  const r = await f.call(messagePath(false), { model, max_tokens: 16, messages: [] });
  assert.equal(r.status, status); assert.deepEqual(await r.json(), error); await f.drain(); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].url, "https://api.synthetic.new/anthropic/v1/messages");
});

for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error"]) {
  test(`Synthetic ${manifest ? "manifest" : "native"} Messages ${outcome} keeps usage unknown and cancels delivery`, async t => {
    const f = await fixture(t); let canceled = false;
    const chunk = frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic-partial" } });
    const wire = outcome === "embedded-error" ? frame({ type: "error", error: { type: "overloaded_error", message: "synthetic-error" } })
      : chunk + (outcome === "disconnect" ? "" : frame({ type: "message_stop" }));
    f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); },
      cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
    const r = await f.call(messagePath(manifest), messageBody({ model, max_tokens: 16, messages: [], stream: true }, manifest));
    assert.equal(r.status, 200);
    if (outcome === "disconnect") { const reader = r.body.getReader(); await reader.read(); await reader.cancel(); assert.equal(canceled, true); }
    else assert.equal(await r.text(), wire);
    await f.drain(); assert.equal(f.sent.length, 1);
    const events = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(events.length, 1);
    assert.deepEqual([events[0].input_tokens, events[0].output_tokens, events[0].total_tokens], [null, null, null]);
    assert.equal(events[0].status, outcome === "disconnect" ? "client_error" : outcome === "embedded-error" ? "provider_error" : "success");
    assert.equal(events[0].actual_cost_micros, outcome === "embedded-error" ? 0 : 7);
  });
}
