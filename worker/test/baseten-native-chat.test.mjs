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
const provider = JSON.parse(execFileSync(process.execPath,
  ["scripts/compile-providers.mjs", "providers/baseten.provider.yaml"], { encoding: "utf8" })).providers[0];
const base = "https://inference.baseten.co/v1";
const models = ["deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-ai/DeepSeek-V4-Pro-0813", "zai-org/GLM-5.2",
  "zai-org/GLM-5.2-Fast", "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B", "openai/gpt-oss-120b"];
const decisions = ["decision-models/baseten-elephant-9b-latest", "decision-models/baseten-mammoth-27b-latest", "decision-models/baseten-joey-2b-latest"];
const vision = new Set([models[0], models[2], models[3]]), seed = "zai-org/GLM-5.3";
const thinking = model => model === models[1] ? { reasoning_effort: "high", thinking: { type: "enabled" } }
  : model === models[2] || model === models[3] || model === models[4]
    ? { reasoning_effort: "high", chat_template_args: { enable_thinking: true } } : { reasoning_effort: "high" };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } };
const response = model => ({ id: "chatcmpl_fixture", object: "chat.completion", model,
  choices: [{ index: 0, message: { role: "assistant", reasoning_content: "synthetic-reasoning", content: "synthetic-answer" }, finish_reason: "stop" }], usage });

async function fixture(t, { ownGrant = true } = {}) {
  const previous = snapshot.providers.find(p => p.id === provider.id), row = structuredClone(provider);
  snapshot.providers.splice(snapshot.providers.indexOf(previous), 1, row);
  t.after(() => { snapshot.providers.splice(snapshot.providers.indexOf(row), 1, previous); });
  const values = new Map(), pending = [], events = [], sent = [];
  const env = { OPENAI_API_KEY: "synthetic-foreign-environment", POLICY_KV: {
    async get(k) { return Array.isArray(k) ? new Map(k.map(k => [k, values.get(k) ?? null])) : values.get(k) ?? null; },
    async put(k, v) { values.set(k, JSON.parse(v)); },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: ["baseten"], models: [...models, seed, ...decisions].map(m => `baseten/${m}`), tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["openai"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "baseten", enabled: true }]);
  await putGrantCredentials(env, "oauth/paid/openai", { provider: "openai", kind: "api_key", enabled: true, credential: "synthetic-foreign-grant" });
  for (const policyId of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${policyId}/baseten`, {
    provider: "baseten", kind: "api_key", enabled: true, credential: "synthetic-selected-baseten" });
  const f = { env, events, sent, grantKey: "oauth/paid/baseten", reply: async r => Response.json(response((await r.clone().json()).model)),
    call(body, { manifest = false, policyId = "paid" } = {}) {
      const path = (manifest ? "/v1/proxy/baseten/chat_completions" : "/v1/native/baseten/chat/completions");
      return worker.fetch(new Request(`https://router.example${path}`, { method: "POST",
        headers: { authorization: `Bearer clawrouter-live-${policyId}-fixture-${policyId}`, "content-type": "application/json", "x-api-key": "synthetic-caller-key", "x-session-affinity": "synthetic-opaque-affinity" },
        body: JSON.stringify(manifest ? { body } : body),
      }), env, { waitUntil: p => pending.push(p) });
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain); return f;
}

test("Baseten native declaration preserves finite selected identities and qualified facts", () => {
  assert.deepEqual(provider.models.map(m => m.upstream), [seed, ...models, ...decisions]);
  for (const m of provider.models) {
    assert.equal(m.id, `baseten/${m.upstream}`); assert.equal(m.pricing, null);
    if (!models.includes(m.upstream)) continue;
    const facts = m.nativeCapabilities.endpoints.chat_completions;
    assert.equal(facts.contextWindow, undefined); assert.equal(facts.maxOutputTokens, undefined);
    assert.deepEqual(facts.input, vision.has(m.upstream) ? ["text", "image"] : ["text"]);
    assert.equal(m.requestParameters.chat_completions.toolCalling, "supported");
    assert.ok(m.supportedReasoningEfforts.includes("high"));
    if (m.upstream === models[4]) assert.deepEqual(m.supportedReasoningEfforts, ["none", "high"]);
  }
  for (const model of decisions) {
    const row = provider.models.find(m => m.upstream === model);
    assert.deepEqual(row.capabilities, []); assert.equal(row.nativeCapabilities, undefined); assert.equal(row.availability, undefined);
  }
  assert.equal(provider.endpoints.some(e => e.id === "systemone"), false);
  assert.throws(() => configuredUpstream(provider, null, { OPENAI_API_KEY: "synthetic-foreign" }), e => e.code === "provider_not_configured");
  const upstream = configuredUpstream(provider, null, { BASETEN_API_KEY: "synthetic-explicit" });
  assert.equal(upstream.baseUrl, base); assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-explicit");
  assert.deepEqual(provider.auth.grantTransports, {});
});

for (const model of models) for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`Baseten native ${model} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} preserves replay, tools and usage`, async t => {
    const f = await fixture(t), body = { model, stream, stream_options: { include_usage: true }, max_tokens: 256,
      ...thinking(model), messages: [
        { role: "assistant", content: null, reasoning_content: "synthetic-prior-reasoning", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }], tool_choice: "auto" };
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "synthetic-reasoning" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }], usage },
    ];
    const wire = chunks.map(chunk => frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, ...chunk })).join("") + "data: [DONE]\n\n";
    let upstreamError;
    f.reply = async request => {
      try {
        assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-baseten");
        assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.headers.get("x-session-affinity"), "synthetic-opaque-affinity"); assert.deepEqual(await request.json(), body);
        assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json(response(model));
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamError = e; throw e; }
    };
    const r = await f.call({ ...body, model: manifest ? `baseten/${model}` : model }, { manifest });
    assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
    if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), response(model));
    await f.drain(); assert.equal(f.sent.length, 1);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [100, 20, 120, 40]);
    assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:selected|foreign|prior-reasoning|tool-result|answer)/);
  });
}

for (const model of decisions) for (const manifest of [false, true]) test(`Baseten native ${model} ${manifest ? "manifest" : "native"} cannot revive through Chat passthrough`, async t => {
  const f = await fixture(t);
  const r = await f.call({ model: manifest ? `baseten/${model}` : model, messages: [] }, { manifest });
  assert.equal(r.status, 400, await r.clone().text()); await r.text(); await f.drain(); assert.equal(f.sent.length, 0);
});

test("Baseten native preserves the existing seed and all three qualified inline image transports", async t => {
  const f = await fixture(t);
  for (const model of [seed, ...vision]) {
    const body = { model, messages: [{ role: "user", content: [{ type: "text", text: "synthetic-input" },
      ...(model === seed ? [] : [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCuoAAAAASUVORK5CYII=" } }])] }] };
    const r = await f.call(body); assert.equal(r.status, 200, await r.clone().text()); await r.text(); assert.deepEqual(await f.sent.at(-1).json(), body);
  }
  await f.drain(); assert.equal(f.sent.length, 4);
});

test("Baseten native denies foreign policy, missing/revoked credentials and unknown upstream cost", async t => {
  const f = await fixture(t, { ownGrant: false }), body = { model: models[0], messages: [] };
  assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
  assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, f.grantKey, { provider: "baseten", kind: "api_key", enabled: true, credential: "synthetic-revoked" });
  await revokeGrantCredentials(f.env, f.grantKey); assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, "oauth/unpriced/baseten", { provider: "baseten", kind: "api_key", enabled: true, credential: "synthetic-unpriced" });
  assert.equal((await f.call(body, { policyId: "unpriced" })).status, 400); assert.equal(f.sent.length, 0);
});

for (const status of [400, 401, 403, 404, 429]) test(`Baseten native ${status} never retries a replacement or credential`, async t => {
  const f = await fixture(t);
  f.reply = () => Response.json({ error: { type: "invalid_request_error", message: "synthetic-upstream-rejection" } }, { status });
  const r = await f.call({ model: models[0], messages: [] }); assert.equal(r.status, status, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal((await f.sent[0].json()).model, models[0]);
});

for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error"]) test(`Baseten native ${manifest ? "manifest" : "native"} ${outcome} preserves conservative settlement`, async t => {
  const f = await fixture(t), model = models[0];
  const wire = outcome === "embedded-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } })
    : frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "synthetic-partial" }, finish_reason: null }] }) + (outcome === "disconnect" ? "" : "data: [DONE]\n\n");
  let canceled = false;
  f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  const r = await f.call({ model: manifest ? `baseten/${model}` : model, messages: [], stream: true }, { manifest }); assert.equal(r.status, 200);
  if (outcome === "disconnect") { const reader = r.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel("synthetic disconnect"); assert.equal(canceled, true); }
  else assert.equal(await r.text(), wire);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
  assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome === "embedded-error" ? "provider_error" : "success");
  assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7); assert.equal(f.sent.length, 1);
});

test("Baseten native preserves explicit reasoning-off envelopes without rewriting selected slugs", async t => {
  const f = await fixture(t);
  for (const model of models) {
    const control = model === models[1] ? { thinking: { type: "disabled" } }
      : [models[2], models[3], models[4]].includes(model) ? { chat_template_args: { enable_thinking: false } } : {};
    const body = { model, messages: [{ role: "user", content: "synthetic-input" }], reasoning_effort: "none", ...control };
    const r = await f.call(body); assert.equal(r.status, 200, await r.clone().text()); await r.text();
    assert.deepEqual(await f.sent.at(-1).json(), body);
  }
  await f.drain(); assert.equal(f.sent.length, models.length);
});
