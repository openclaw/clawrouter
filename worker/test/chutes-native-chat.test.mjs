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
  ["scripts/compile-providers.mjs", "providers/chutes.provider.yaml"], { encoding: "utf8" })).providers[0];
const base = "https://llm.chutes.ai/v1";
const models = ["deepseek-ai/DeepSeek-V3.2-TEE", "moonshotai/Kimi-K2.6-TEE", "zai-org/GLM-5.2-TEE", "Qwen/Qwen3.6-27B-TEE", "Qwen/Qwen3.5-397B-A17B-TEE"];
const seed = "deepseek-ai/DeepSeek-V4-Flash-0731-TEE", thinking = models[1];
const vision = new Set([models[1], models[3], models[4]]);
const bounds = [[131072, 65536], [262144, 65535], [1048576, 65535], [262144, 65536], [262144, 65536]];
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } };
const reasoning = () => ({ reasoning_content: "synthetic-reasoning" });
const response = model => ({ id: "chatcmpl_fixture", object: "chat.completion", model,
  choices: [{ index: 0, message: { role: "assistant", ...reasoning(model), content: "synthetic-answer" }, finish_reason: "stop" }], usage });

async function fixture(t, { ownGrant = true } = {}) {
  const previous = snapshot.providers.find(p => p.id === provider.id), row = structuredClone(provider);
  snapshot.providers.splice(snapshot.providers.indexOf(previous), 1, row);
  t.after(() => { snapshot.providers.splice(snapshot.providers.indexOf(row), 1, previous); });
  const values = new Map(), pending = [], events = [], sent = [];
  const env = { OPENAI_API_KEY: "synthetic-foreign-environment", CHUTES_OAUTH_TOKEN: "synthetic-foreign-oauth", OPENROUTER_API_KEY: "synthetic-foreign-router", POLICY_KV: {
    async get(k) { return Array.isArray(k) ? new Map(k.map(k => [k, values.get(k) ?? null])) : values.get(k) ?? null; },
    async put(k, v) { values.set(k, JSON.parse(v)); },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: ["chutes"], models: [seed, ...models].map(m => `chutes/${m}`), tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["openrouter"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "chutes", enabled: true }]);
  await putGrantCredentials(env, "oauth/paid/openrouter", { provider: "openrouter", kind: "api_key", enabled: true, credential: "synthetic-foreign-grant" });
  for (const policyId of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${policyId}/chutes`, {
    provider: "chutes", kind: "api_key", enabled: true, credential: "synthetic-selected-chutes" });
  const f = { env, events, sent, grantKey: "oauth/paid/chutes", reply: async r => Response.json(response((await r.clone().json()).model)),
    call(body, { manifest = false, policyId = "paid" } = {}) {
      const path = manifest ? "/v1/proxy/chutes/chat_completions" : "/v1/native/chutes/chat/completions";
      return worker.fetch(new Request(`https://router.example${path}`, { method: "POST",
        headers: { authorization: `Bearer clawrouter-live-${policyId}-fixture-${policyId}`, "content-type": "application/json", "x-api-key": "synthetic-caller-key" },
        body: JSON.stringify(manifest ? { body } : body),
      }), env, { waitUntil: p => pending.push(p) });
    },
    catalog() { return worker.fetch(new Request("https://router.example/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-paid-fixture-paid" } }), env, { waitUntil: p => pending.push(p) }); },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain); return f;
}

test("Chutes declaration preserves the existing seed and five frozen cards with independently qualified native limits", () => {
  assert.deepEqual(provider.models.map(m => m.upstream), [seed, ...models]);
  for (const m of provider.models) {
    assert.equal(m.id, `chutes/${m.upstream}`); assert.equal(m.pricing, null);
    assert.equal(m.supportedReasoningEfforts, undefined); assert.equal(m.availability, undefined);
    if (m.upstream === seed) { assert.equal(m.nativeCapabilities, undefined); continue; }
    const facts = m.nativeCapabilities.endpoints.chat_completions;
    assert.deepEqual([facts.contextWindow, facts.maxOutputTokens], bounds[models.indexOf(m.upstream)]);
    assert.deepEqual(facts.input, vision.has(m.upstream) ? ["text", "image"] : ["text"]);
    assert.equal(m.requestParameters.chat_completions.toolCalling, "supported");
    assert.equal(m.requestParameters.chat_completions.defaultReasoningEffort, undefined);
  }
  assert.deepEqual(provider.endpoints.map(e => e.id), ["chat_completions"]);
  const opaque = providerModel(provider, "chutes/synthetic-tenant-model", provider.endpoints[0]);
  assert.equal(opaque.nativeCapabilities, undefined); assert.equal(opaque.requestParameters, undefined); assert.equal(opaque.pricing, null);
  assert.throws(() => configuredUpstream(provider, null, { CHUTES_OAUTH_TOKEN: "synthetic-unselected-oauth", OPENAI_API_KEY: "synthetic-foreign" }), e => e.code === "provider_not_configured");
  const upstream = configuredUpstream(provider, null, { CHUTES_API_KEY: "synthetic-explicit" });
  assert.equal(upstream.baseUrl, base); assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-explicit");
  assert.deepEqual(provider.auth.grantTransports, {});
});

test("Chutes actual catalog exposes only the original direct grant's eligible finite Chat offers", async t => {
  const f = await fixture(t), r = await f.catalog();
  assert.equal(r.status, 200, await r.clone().text()); assert.equal(r.headers.get("cache-control"), "no-store");
  const view = (await r.json()).providers.find(p => p.id === "chutes");
  assert.deepEqual(view.models.map(m => m.id).sort(), [seed, ...models].map(m => `chutes/${m}`).sort());
  for (const m of view.models) {
    if (m.id === `chutes/${seed}`) continue;
    assert.equal(m.requestParameters.chat_completions.toolCalling, "supported");
    assert.deepEqual(m.nativeCapabilities.endpoints.chat_completions.input, vision.has(m.id.slice("chutes/".length)) ? ["text", "image"] : ["text"]);
    const offers = view.offers.filter(o => o.modelId === m.id);
    assert.ok(offers.length > 0); assert.ok(offers.every(o => o.endpoint === "chat_completions" && o.eligible));
  }
  await f.drain(); assert.equal(f.sent.length, 0);
});

for (const model of models) for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`Chutes native ${model} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} preserves replay and tools with optional usage`, async t => {
    const f = await fixture(t), body = { model, stream, max_tokens: 256,
      messages: [{ role: "assistant", content: "", ...reasoning(model), tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }], tool_choice: "auto" };
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", ...reasoning(model) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] },
    ];
    const wire = chunks.map(chunk => frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, ...chunk })).join("") + "data: [DONE]\n\n";
    let upstreamError;
    f.reply = async request => {
      try {
        assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-chutes");
        assert.equal(request.headers.get("x-api-key"), null); assert.deepEqual(await request.json(), body);
        assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json(response(model));
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamError = e; throw e; }
    };
    const r = await f.call({ ...body, model: manifest ? `chutes/${model}` : model }, { manifest });
    assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
    if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), response(model));
    await f.drain(); assert.equal(f.sent.length, 1);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], stream ? [null, null, null, null] : [100, 20, 120, 40]);
    assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:selected|foreign|reasoning|tool-result|answer)/);
  });
}

test("Chutes original grant does not infer aliases, remove TEE suffixes or allow ungranted models", async t => {
  const f = await fixture(t);
  for (const model of ["deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3.6-27B", "synthetic-tenant-model"]) {
    for (const manifest of [false, true]) {
      const r = await f.call({ model: manifest ? `chutes/${model}` : model, messages: [] }, { manifest });
      assert.equal(r.status, 403, await r.clone().text()); assert.equal((await r.json()).error.code, "model_not_allowed");
    }
  }
  await f.drain(); assert.equal(f.sent.length, 0);
});

test("Chutes direct rejects foreign policy, missing/revoked credentials and unknown cost before egress", async t => {
  const f = await fixture(t, { ownGrant: false }), body = { model: models[0], messages: [] };
  assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
  assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, f.grantKey, { provider: "chutes", kind: "api_key", enabled: true, credential: "synthetic-revoked" });
  await revokeGrantCredentials(f.env, f.grantKey); assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, "oauth/unpriced/chutes", { provider: "chutes", kind: "api_key", enabled: true, credential: "synthetic-unpriced" });
  assert.equal((await f.call(body, { policyId: "unpriced" })).status, 400); assert.equal(f.sent.length, 0);
});

for (const status of [400, 401, 403, 404, 429, 500, 503]) test(`Chutes native ${status} never retries a product, model or credential`, async t => {
  const f = await fixture(t);
  f.reply = () => Response.json({ error: { type: "invalid_request_error", message: "synthetic-upstream-rejection" } }, { status });
  const r = await f.call({ model: models[0], messages: [] }); assert.equal(r.status, status, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal((await f.sent[0].json()).model, models[0]);
});

for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error"]) test(`Chutes native ${manifest ? "manifest" : "native"} ${outcome} preserves conservative settlement`, async t => {
  const f = await fixture(t), model = thinking;
  const wire = outcome === "embedded-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } })
    : frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { reasoning_content: "synthetic-partial-reasoning" }, finish_reason: null }] }) + (outcome === "disconnect" ? "" : "data: [DONE]\n\n");
  let canceled = false;
  f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  const r = await f.call({ model: manifest ? `chutes/${model}` : model, messages: [], stream: true }, { manifest }); assert.equal(r.status, 200);
  if (outcome === "disconnect") { const reader = r.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel("synthetic disconnect"); assert.equal(canceled, true); }
  else assert.equal(await r.text(), wire);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
  assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome === "embedded-error" ? "provider_error" : "success");
  assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7); assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-partial-reasoning/);
});

test("Chutes Kimi preserves its documented thinking and preserve_thinking controls without effort aliases", async t => {
  const f = await fixture(t);
  for (const enabled of [false, true]) {
    const body = { model: thinking, chat_template_kwargs: { thinking: enabled, ...(enabled ? { preserve_thinking: true } : {}) },
      messages: [{ role: "assistant", content: "<think>synthetic-prior-reasoning</think>synthetic-answer",
        tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_fixture", content: "synthetic-result" }] };
    const r = await f.call(body); assert.equal(r.status, 200, await r.clone().text()); await r.text();
    assert.deepEqual(await f.sent.at(-1).json(), body);
  }
  await f.drain(); assert.equal(f.sent.length, 2);
});

test("Chutes observed SSE usage is counted when supplied without assuming every stream contains it", async t => {
  const f = await fixture(t), model = models[0];
  const wire = frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model,
    choices: [{ index: 0, delta: { content: "synthetic-answer" }, finish_reason: "stop" }], usage }) + "data: [DONE]\n\n";
  f.reply = () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const r = await f.call({ model, messages: [], stream: true }); assert.equal(r.status, 200); assert.equal(await r.text(), wire);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [100, 20, 120, 40]);
  assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
});

for (const model of vision) for (const manifest of [false, true]) test(`Chutes ${model} ${manifest ? "manifest" : "native"} preserves qualified inline image input`, async t => {
  const f = await fixture(t), body = { model, messages: [{ role: "user", content: [{ type: "text", text: "synthetic-input" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCuoAAAAASUVORK5CYII=" } }] }] };
  const r = await f.call({ ...body, model: manifest ? `chutes/${model}` : model }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
});

test("Chutes existing seed keeps its original selected identity and unpriced behavior", async t => {
  const f = await fixture(t), body = { model: seed, messages: [{ role: "user", content: "synthetic-input" }] };
  const r = await f.call(body); assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
});
