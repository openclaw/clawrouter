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
  ["scripts/compile-providers.mjs", "providers/deepinfra.provider.yaml"], { encoding: "utf8" })).providers[0];
const base = "https://api.deepinfra.com/v1/openai";
const models = ["deepseek-ai/DeepSeek-V4-Flash", "deepseek-ai/DeepSeek-V4-Pro", "zai-org/GLM-5.2", "moonshotai/Kimi-K2.6",
  "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B", "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B", "deepseek-ai/DeepSeek-V3.2"];
const alias = "zai-org/GLM-5.1", seed = "Qwen/Qwen3.8-27B";
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } };
const response = model => ({ id: "chatcmpl_fixture", object: "chat.completion", model,
  choices: [{ index: 0, message: { role: "assistant", ...(model === "deepseek-ai/DeepSeek-V3.2" ? {} : { reasoning_content: "synthetic-reasoning" }), content: "synthetic-answer" }, finish_reason: "stop" }], usage });

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
  const policy = { enabled: true, generation: "fixture", providers: ["deepinfra"], models: [...models, seed, alias].map(m => `deepinfra/${m}`), tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["openai"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "deepinfra", enabled: true }]);
  await putGrantCredentials(env, "oauth/paid/openai", { provider: "openai", kind: "api_key", enabled: true, credential: "synthetic-foreign-grant" });
  for (const policyId of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${policyId}/deepinfra`, {
    provider: "deepinfra", kind: "api_key", enabled: true, credential: "synthetic-selected-deepinfra" });
  const f = { env, events, sent, grantKey: "oauth/paid/deepinfra", reply: async r => Response.json(response((await r.clone().json()).model)),
    call(body, { manifest = false, policyId = "paid", discovery = false, query = "" } = {}) {
      const path = discovery ? (manifest ? "/v1/proxy/deepinfra/models_list" : "/v1/native/deepinfra/models")
        : (manifest ? "/v1/proxy/deepinfra/chat_completions" : "/v1/native/deepinfra/chat/completions");
      return worker.fetch(new Request(`https://router.example${path}${query}`, { method: discovery ? "GET" : "POST",
        headers: { authorization: `Bearer clawrouter-live-${policyId}-fixture-${policyId}`, "content-type": "application/json", "x-api-key": "synthetic-caller-key" },
        ...(!discovery && { body: JSON.stringify(manifest ? { body } : body) }),
      }), env, { waitUntil: p => pending.push(p) });
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain); return f;
}

test("DeepInfra native declaration preserves finite selected identities and qualified facts", () => {
  assert.deepEqual(provider.models.map(m => m.upstream), [seed, ...models, alias]);
  for (const m of provider.models) {
    assert.equal(m.id, `deepinfra/${m.upstream}`); assert.equal(m.pricing, null);
    if (!models.includes(m.upstream)) continue;
    const facts = m.nativeCapabilities.endpoints.chat_completions;
    assert.equal(facts.maxOutputTokens, undefined);
    assert.deepEqual(facts.input, m.upstream === "moonshotai/Kimi-K2.6" ? ["text", "image"] : ["text"]);
    assert.equal(facts.contextWindow, m.upstream === "deepseek-ai/DeepSeek-V3.2" ? 163840 : models.indexOf(m.upstream) < 3 ? 1048576 : 262144);
  }
  const disposition = provider.models.find(m => m.upstream === alias);
  assert.deepEqual(disposition.capabilities, []); assert.equal(disposition.availability.status, "upstream_alias");
  assert.equal(disposition.availability.servingModel, "zai-org/GLM-5.3"); assert.equal(disposition.availability.effectiveAt, "2026-10-01");
  assert.equal(disposition.nativeCapabilities, undefined);
  assert.throws(() => configuredUpstream(provider, null, { OPENAI_API_KEY: "synthetic-foreign" }), e => e.code === "provider_not_configured");
  const upstream = configuredUpstream(provider, null, { DEEPINFRA_API_KEY: "synthetic-explicit" });
  assert.equal(upstream.baseUrl, base); assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-explicit");
  assert.deepEqual(provider.auth.grantTransports, {});
});

for (const model of models) for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`DeepInfra native ${model} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} preserves replay, tools and usage`, async t => {
    const f = await fixture(t), body = { model, stream, stream_options: { include_usage: true }, max_tokens: 256,
      prompt_cache_key: "synthetic-cache-affinity", messages: [
        { role: "assistant", content: null, ...(model === "deepseek-ai/DeepSeek-V3.2" ? {} : { reasoning_content: "synthetic-prior-reasoning" }), tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }], tool_choice: "auto" };
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", ...(model === "deepseek-ai/DeepSeek-V3.2" ? {} : { reasoning_content: "synthetic-reasoning" }) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }], usage },
    ];
    const wire = chunks.map(chunk => frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, ...chunk })).join("") + "data: [DONE]\n\n";
    let upstreamError;
    f.reply = async request => {
      try {
        assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-deepinfra");
        assert.equal(request.headers.get("x-api-key"), null); assert.deepEqual(await request.json(), body);
        assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json(response(model));
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamError = e; throw e; }
    };
    const r = await f.call({ ...body, model: manifest ? `deepinfra/${model}` : model }, { manifest });
    assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
    if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), response(model));
    await f.drain(); assert.equal(f.sent.length, 1);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [100, 20, 120, 40]);
    assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:selected|foreign|prior-reasoning|tool-result|answer)/);
  });
}

for (const manifest of [false, true]) test(`DeepInfra native ${manifest ? "manifest" : "native"} discovery fixes metadata query and original grant`, async t => {
  const f = await fixture(t), row = { id: models[0], object: "model", metadata: { tags: ["chat", "reasoning"], context_length: 1048576, max_tokens: 1048576 } };
  f.reply = () => Response.json({ object: "list", data: [row, { id: "unpermitted", object: "model" }] });
  const r = await f.call(null, { discovery: true, manifest }); assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { object: "list", data: [row] }); assert.match(r.headers.get("cache-control"), /private, no-store/);
  assert.equal(f.sent[0].url, `${base}/models?sort_by=openclaw&filter=with_meta`);
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-selected-deepinfra");
  assert.equal(f.sent[0].method, "GET"); assert.equal(f.sent[0].body, null);
  await f.drain(); assert.ok(f.events.filter(e => e.type === "clawrouter.usage.v1").every(e => e.actual_cost_micros === 0));
  const [reservation] = f.env.BUDGET_LEDGER.get("fixture:paid").reservations();
  assert.equal(reservation.reserved_micros, 0); assert.equal(reservation.settled, 1);
  f.reply = () => Response.json({ data: [row] });
  assert.equal((await f.call(null, { discovery: true, manifest })).status, 502);
  for (const query of ["?filter=all", "?sort_by=cost", "?after_id=unpermitted", "?api_key=synthetic-private"]) {
    const count = f.sent.length;
    assert.equal((await f.call(null, { discovery: true, manifest, query })).status, 400); assert.equal(f.sent.length, count);
  }
});

for (const manifest of [false, true]) test(`DeepInfra native ${manifest ? "manifest" : "native"} known alias cannot revive through Chat passthrough`, async t => {
  const f = await fixture(t);
  const r = await f.call({ model: manifest ? `deepinfra/${alias}` : alias, messages: [] }, { manifest });
  assert.equal(r.status, 400, await r.clone().text()); await r.text(); await f.drain(); assert.equal(f.sent.length, 0);
});

test("DeepInfra native preserves the existing seed and inline Kimi image transport", async t => {
  const f = await fixture(t);
  for (const model of [seed, "moonshotai/Kimi-K2.6"]) {
    const body = { model, messages: [{ role: "user", content: [{ type: "text", text: "synthetic-input" },
      ...(model === seed ? [] : [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCuoAAAAASUVORK5CYII=" } }])] }] };
    const r = await f.call(body); assert.equal(r.status, 200, await r.clone().text()); await r.text(); assert.deepEqual(await f.sent.at(-1).json(), body);
  }
  await f.drain(); assert.equal(f.sent.length, 2);
});

test("DeepInfra native denies foreign policy, missing/revoked credentials and unknown upstream cost", async t => {
  const f = await fixture(t, { ownGrant: false }), body = { model: models[0], messages: [] };
  assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
  assert.equal((await f.call(body)).status, 503); assert.equal((await f.call(null, { discovery: true })).status, 503);
  await putGrantCredentials(f.env, f.grantKey, { provider: "deepinfra", kind: "api_key", enabled: true, credential: "synthetic-revoked" });
  await revokeGrantCredentials(f.env, f.grantKey); assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, "oauth/unpriced/deepinfra", { provider: "deepinfra", kind: "api_key", enabled: true, credential: "synthetic-unpriced" });
  assert.equal((await f.call(body, { policyId: "unpriced" })).status, 400); assert.equal(f.sent.length, 0);
});

for (const status of [400, 401, 403, 404, 429]) test(`DeepInfra native ${status} never retries a replacement or credential`, async t => {
  const f = await fixture(t);
  f.reply = () => Response.json({ error: { type: "invalid_request_error", message: "synthetic-upstream-rejection" } }, { status });
  const r = await f.call({ model: models[0], messages: [] }); assert.equal(r.status, status, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal((await f.sent[0].json()).model, models[0]);
});

for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error"]) test(`DeepInfra native ${manifest ? "manifest" : "native"} ${outcome} preserves conservative settlement`, async t => {
  const f = await fixture(t), model = models[0];
  const wire = outcome === "embedded-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } })
    : frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "synthetic-partial" }, finish_reason: null }] }) + (outcome === "disconnect" ? "" : "data: [DONE]\n\n");
  let canceled = false;
  f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  const r = await f.call({ model: manifest ? `deepinfra/${model}` : model, messages: [], stream: true }, { manifest }); assert.equal(r.status, 200);
  if (outcome === "disconnect") { const reader = r.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel("synthetic disconnect"); assert.equal(canceled, true); }
  else assert.equal(await r.text(), wire);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
  assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome === "embedded-error" ? "provider_error" : "success");
  assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7); assert.equal(f.sent.length, 1);
});
