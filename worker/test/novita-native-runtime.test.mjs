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
const { snapshot, configuredUpstream, providerModel } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const provider = JSON.parse(execFileSync(process.execPath,
  ["scripts/compile-providers.mjs", "providers/novita.provider.yaml"], { encoding: "utf8" })).providers[0];
const base = "https://api.novita.ai/openai/v1";
const models = ["moonshotai/kimi-k3", "moonshotai/kimi-k2.7-code", "minimax/minimax-m3", "zai-org/glm-5.2", "deepseek/deepseek-v4-pro", "qwen/qwen3.7-max", "minimax/minimax-m2.7"];
const facts = [[1048576, 1048576], [262144, 262144], [1000000, 131072], [1048576, 131072], [1048576, 393216], [1000000, 65536], [204800, 131072]];
const thinking = models[2];
const vision = new Set(models.slice(0, 3));
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } };
const reasoning = model => ({ reasoning_content: "synthetic-reasoning", ...(model === thinking && {
  reasoning_details: [{ type: "reasoning.text", id: "reasoning-fixture", format: "openai-responses-v1", index: 0, text: "synthetic-reasoning-detail" }],
}) });
const response = model => ({ id: "chatcmpl_fixture", object: "chat.completion", model,
  choices: [{ index: 0, message: { role: "assistant", ...reasoning(model), content: "synthetic-answer" }, finish_reason: "stop" }], usage });

async function fixture(t, { ownGrant = true } = {}) {
  const previous = snapshot.providers.find(p => p.id === provider.id), row = structuredClone(provider);
  snapshot.providers.splice(snapshot.providers.indexOf(previous), 1, row);
  t.after(() => { snapshot.providers.splice(snapshot.providers.indexOf(row), 1, previous); });
  const values = new Map(), pending = [], events = [], sent = [];
  const env = { OPENAI_API_KEY: "synthetic-foreign-environment", ANTHROPIC_API_KEY: "synthetic-foreign-anthropic", OPENROUTER_API_KEY: "synthetic-foreign-router", POLICY_KV: {
    async get(k) { return Array.isArray(k) ? new Map(k.map(k => [k, values.get(k) ?? null])) : values.get(k) ?? null; },
    async put(k, v) { values.set(k, JSON.parse(v)); },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: ["novita"], models: models.map(m => `novita/${m}`), tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["openrouter"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "novita", enabled: true }]);
  await putGrantCredentials(env, "oauth/paid/openrouter", { provider: "openrouter", kind: "api_key", enabled: true, credential: "synthetic-foreign-grant" });
  for (const policyId of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${policyId}/novita`, {
    provider: "novita", kind: "api_key", enabled: true, credential: "synthetic-selected-novita" });
  const f = { env, events, sent, grantKey: "oauth/paid/novita", reply: async r => Response.json(response((await r.clone().json()).model)),
    call(body, { manifest = false, policyId = "paid", nativePrefix = "novita" } = {}) {
      const path = manifest ? "/v1/proxy/novita/chat_completions" : `/v1/native/${nativePrefix}/chat/completions`;
      return worker.fetch(new Request(`https://router.example${path}`, { method: "POST",
        headers: { authorization: `Bearer clawrouter-live-${policyId}-fixture-${policyId}`, "content-type": "application/json", "x-api-key": "synthetic-caller-key", "x-organization-id": "synthetic-unbound-org" },
        body: JSON.stringify(manifest ? { body } : body),
      }), env, { waitUntil: p => pending.push(p) });
    },
    catalog() { return worker.fetch(new Request("https://router.example/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-paid-fixture-paid" } }), env, { waitUntil: p => pending.push(p) }); },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain); return f;
}

test("Novita declaration preserves the seed and seven frozen identities with qualified native facts", () => {
  assert.deepEqual(provider.models.map(m => m.upstream), ["stepfun/step-3.7-flash", ...models]);
  const seed = provider.models[0];
  assert.equal(seed.nativeCapabilities, undefined); assert.equal(seed.requestParameters, undefined); assert.equal(seed.pricing, null);
  for (const [index, m] of provider.models.slice(1).entries()) {
    assert.equal(m.id, `novita/${m.upstream}`); assert.equal(m.pricing, null); assert.equal(m.availability, undefined);
    assert.equal(m.supportedReasoningEfforts, undefined);
    assert.equal(m.requestParameters?.chat_completions.toolCalling, "supported");
    assert.equal(m.requestParameters?.chat_completions.defaultReasoningEffort, undefined);
    const native = m.nativeCapabilities?.endpoints.chat_completions;
    assert.deepEqual(native?.input, vision.has(m.upstream) ? ["text", "image"] : ["text"]);
    assert.equal(native.contextWindow, facts[index][0]); assert.equal(native.maxOutputTokens, facts[index][1]);
  }
  assert.deepEqual(provider.endpoints.map(e => e.id), ["chat_completions"]);
  const opaque = providerModel(provider, "novita/synthetic-tenant-model", provider.endpoints.find(e => e.id === "chat_completions"));
  assert.equal(opaque.nativeCapabilities, undefined); assert.equal(opaque.requestParameters, undefined); assert.equal(opaque.pricing, null);
  assert.throws(() => configuredUpstream(provider, null, { ANTHROPIC_API_KEY: "synthetic-unselected-anthropic", OPENAI_API_KEY: "synthetic-foreign" }), e => e.code === "provider_not_configured");
  const upstream = configuredUpstream(provider, null, { NOVITA_API_KEY: "synthetic-explicit" });
  assert.equal(upstream.baseUrl, base); assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-explicit");
  assert.equal(upstream.headers.get("x-organization-id"), null); assert.deepEqual(provider.auth.grantTransports, {});
});

test("Novita actual catalog exposes only the original direct grant's eligible finite Chat offers", async t => {
  const f = await fixture(t), r = await f.catalog();
  assert.equal(r.status, 200, await r.clone().text()); assert.equal(r.headers.get("cache-control"), "no-store");
  const view = (await r.json()).providers.find(p => p.id === "novita");
  assert.deepEqual(view.models.map(m => m.id).sort(), models.map(m => `novita/${m}`).sort());
  for (const m of view.models) {
    assert.equal(m.requestParameters?.chat_completions.toolCalling, "supported");
    const offers = view.offers.filter(o => o.modelId === m.id);
    assert.ok(offers.length > 0); assert.ok(offers.every(o => o.endpoint === "chat_completions" && o.eligible));
  }
  await f.drain(); assert.equal(f.sent.length, 0);
});

for (const model of models) for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`Novita native ${model} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} preserves selected identity, opaque reasoning/tool replay and native usage`, async t => {
    const f = await fixture(t), body = { model, stream, max_tokens: 256,
      messages: [{ role: "assistant", content: "", ...reasoning(model), tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }], tool_choice: "auto" };
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", ...reasoning(model) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage },
    ];
    const wire = chunks.map(chunk => frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, ...chunk })).join("") + "data: [DONE]\n\n";
    let upstreamError;
    f.reply = async request => {
      try {
        assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-novita");
        assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.headers.get("x-organization-id"), null); assert.deepEqual(await request.json(), body);
        assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json(response(model));
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamError = e; throw e; }
    };
    const r = await f.call({ ...body, model: manifest ? `novita/${model}` : model }, { manifest });
    assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
    if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), response(model));
    await f.drain(); assert.equal(f.sent.length, 1);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [100, 20, 120, 40]);
    assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:selected|foreign|reasoning|tool-result|answer)/);
  });
}

test("Novita original grant does not rewrite model case, substitute products or allow ungranted models", async t => {
  const f = await fixture(t);
  for (const model of ["kimi-k3", "moonshotai/Kimi-K3", "minimax-m3", "synthetic-tenant-model"]) {
    for (const manifest of [false, true]) {
      const r = await f.call({ model: manifest ? `novita/${model}` : model, messages: [] }, { manifest });
      assert.equal(r.status, 403, await r.clone().text()); assert.equal((await r.json()).error.code, "model_not_allowed");
    }
  }
  await f.drain(); assert.equal(f.sent.length, 0);
});

test("Novita direct rejects foreign policy, missing/revoked credentials and unknown cost before egress", async t => {
  const f = await fixture(t, { ownGrant: false }), body = { model: models[0], messages: [] };
  assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
  assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, f.grantKey, { provider: "novita", kind: "api_key", enabled: true, credential: "synthetic-revoked" });
  await revokeGrantCredentials(f.env, f.grantKey); assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, "oauth/unpriced/novita", { provider: "novita", kind: "api_key", enabled: true, credential: "synthetic-unpriced" });
  assert.equal((await f.call(body, { policyId: "unpriced" })).status, 400); assert.equal(f.sent.length, 0);
});

for (const status of [400, 401, 403, 404, 410, 429, 500, 503, 504]) test(`Novita native ${status} never retries a product, model or credential`, async t => {
  const f = await fixture(t);
  f.reply = () => Response.json({ error: { type: "invalid_request_error", message: "synthetic-upstream-rejection" } }, { status });
  const r = await f.call({ model: models[0], messages: [] }); assert.equal(r.status, status, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal((await f.sent[0].json()).model, models[0]);
});

for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error", "late-error"]) test(`Novita native ${manifest ? "manifest" : "native"} ${outcome} preserves conservative settlement`, async t => {
  const f = await fixture(t), model = thinking;
  const wire = outcome === "embedded-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } })
    : frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { reasoning_content: "synthetic-partial-reasoning" }, finish_reason: null }] })
      + (outcome === "disconnect" ? "" : outcome === "late-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } }) : "data: [DONE]\n\n");
  let canceled = false;
  f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  const r = await f.call({ model: manifest ? `novita/${model}` : model, messages: [], stream: true }, { manifest }); assert.equal(r.status, 200);
  if (outcome === "disconnect") { const reader = r.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel("synthetic disconnect"); assert.equal(canceled, true); }
  else assert.equal(await r.text(), wire);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
  assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome.endsWith("error") ? "provider_error" : "success");
  assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7); assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-partial-reasoning/);
});


test("Novita terminal SSE usage stays independent from output content and policy pricing", async t => {
  const f = await fixture(t), model = models[0];
  const wire = frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model,
    choices: [{ index: 0, delta: { content: "synthetic-answer" }, finish_reason: "stop" }], usage }) + "data: [DONE]\n\n";
  f.reply = () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const r = await f.call({ model, messages: [], stream: true }); assert.equal(r.status, 200); assert.equal(await r.text(), wire);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [100, 20, 120, 40]);
  assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
});

for (const model of vision) for (const manifest of [false, true]) test(`Novita ${model} ${manifest ? "manifest" : "native"} preserves qualified inline image input`, async t => {
  const f = await fixture(t), body = { model, messages: [{ role: "user", content: [{ type: "text", text: "synthetic-input" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCuoAAAAASUVORK5CYII=" } }] }] };
  const r = await f.call({ ...body, model: manifest ? `novita/${model}` : model }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
});


for (const nativePrefix of ["clawrouter-novita", "novita-ai", "novitaai"]) test(`Novita routing alias ${nativePrefix} retains the canonical provider grant and exact native model`, async t => {
  const f = await fixture(t), body = { model: models[0], messages: [{ role: "user", content: "synthetic-input" }] };
  const r = await f.call(body, { nativePrefix }); assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-selected-novita"); assert.equal(f.sent[0].url, `${base}/chat/completions`);
});

for (const manifest of [false, true]) for (const enabled of [false, true]) test(`Novita ${manifest ? "manifest" : "native"} keeps explicit thinking ${enabled} separate from effort menus`, async t => {
  const f = await fixture(t), body = { model: models[4], messages: [{ role: "user", content: "synthetic-input" }],
    enable_thinking: enabled, separate_reasoning: true, stream: false, max_tokens: 256 };
  const reply = response(body.model); if (!enabled) delete reply.choices[0].message.reasoning_content;
  f.reply = () => Response.json(reply);
  const r = await f.call({ ...body, model: manifest ? `novita/${body.model}` : body.model }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), reply); await f.drain();
  const sent = await f.sent[0].json(); assert.deepEqual(sent, body); assert.equal(sent.reasoning_effort, undefined);
});

for (const manifest of [false, true]) test(`Novita MiniMax M3 ${manifest ? "manifest" : "native"} replays the complete interleaved tool response`, async t => {
  const f = await fixture(t), body = { model: thinking, reasoning_split: true, max_tokens: 512,
    messages: [{ role: "user", content: "synthetic-input" }, { role: "assistant", name: "fixture", content: "", ...reasoning(thinking),
      tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] };
  const r = await f.call({ ...body, model: manifest ? `novita/${thinking}` : thinking }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), response(thinking)); await f.drain();
  assert.deepEqual(await f.sent[0].json(), body); assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(f.events), /synthetic-reasoning|synthetic-tool-result/);
});

for (const manifest of [false, true]) test(`Novita ${manifest ? "manifest" : "native"} transports the qualified structured-output request without rewriting tool or schema fields`, async t => {
  const f = await fixture(t), body = { model: models[5], messages: [{ role: "user", content: "synthetic-input" }],
    tools: [{ type: "function", function: { name: "lookup", strict: true, parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } }],
    response_format: { type: "json_schema", json_schema: { name: "fixture", strict: true, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } } };
  const reply = response(body.model); reply.choices[0].message.content = '{"answer":"synthetic-answer"}';
  f.reply = () => Response.json(reply);
  const r = await f.call({ ...body, model: manifest ? `novita/${body.model}` : body.model }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), reply); await f.drain();
  assert.deepEqual(await f.sent[0].json(), body); assert.equal(f.sent.length, 1);
});
