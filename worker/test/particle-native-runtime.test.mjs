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
  ["scripts/compile-providers.mjs", "providers/particle.provider.yaml"], { encoding: "utf8" })).providers[0];
const base = "https://api.particle.ai/v1";
const wireId = "particle-1", publicId = "particle-ai/particle-1", routerId = `particle/${publicId}`;
const models = [wireId], thinking = wireId, vision = new Set(models);
const efforts = ["none", "low", "high", "max"];
const discoveryRow = { id: publicId, object: "model", created: 1793108609, owned_by: "particle", name: "Particle-1",
  context_window: 1048576, max_output_tokens: 131072, default_max_output_tokens: 32000,
  input_modalities: ["text", "image"], output_modalities: ["text"],
  capabilities: { reasoning: true, tool_calling: true, structured_outputs: false },
  reasoning: { default_effort: "high", supported_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], can_disable: true } };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 6 } };
const reasoning = () => ({ reasoning_content: "synthetic-reasoning" });
const response = model => ({ id: "chatcmpl_fixture", object: "chat.completion", model: publicId,
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
  const policy = { enabled: true, generation: "fixture", providers: ["particle"], models: [routerId], tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["openrouter"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "particle", enabled: true }]);
  await putGrantCredentials(env, "oauth/paid/openrouter", { provider: "openrouter", kind: "api_key", enabled: true, credential: "synthetic-foreign-grant" });
  for (const policyId of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${policyId}/particle`, {
    provider: "particle", kind: "api_key", enabled: true, credential: "synthetic-selected-particle" });
  const f = { env, events, sent, grantKey: "oauth/paid/particle", reply: async r => Response.json(response((await r.clone().json()).model)),
    call(body, { manifest = false, policyId = "paid", discovery = false, query = "", nativePrefix = "particle", unified = false } = {}) {
      const path = unified ? "/v1/chat/completions" : discovery ? (manifest ? "/v1/proxy/particle/models_list" : `/v1/native/${nativePrefix}/models`)
        : (manifest ? "/v1/proxy/particle/chat_completions" : `/v1/native/${nativePrefix}/chat/completions`);
      return worker.fetch(new Request(`https://router.example${path}${query}`, { method: discovery ? "GET" : "POST",
        headers: { authorization: `Bearer clawrouter-live-${policyId}-fixture-${policyId}`, "content-type": "application/json", "x-api-key": "synthetic-caller-key", "x-organization-id": "synthetic-unbound-org" },
        ...(!discovery && { body: JSON.stringify(manifest ? { body } : body) }),
      }), env, { waitUntil: p => pending.push(p) });
    },
    catalog() { return worker.fetch(new Request("https://router.example/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-paid-fixture-paid" } }), env, { waitUntil: p => pending.push(p) }); },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain); return f;
}

test("Particle declaration keeps one public ID, its documented wire alias and finite native facts", () => {
  assert.equal(provider.models.length, 1);
  const [m] = provider.models;
  assert.equal(m.id, routerId); assert.equal(m.upstream, wireId); assert.equal(m.pricing, null); assert.equal(m.availability, undefined);
  assert.deepEqual(m.supportedReasoningEfforts, efforts);
  assert.equal(m.requestParameters.chat_completions.toolCalling, "supported");
  assert.equal(m.requestParameters.chat_completions.defaultReasoningEffort, "high");
  const native = m.nativeCapabilities.endpoints.chat_completions;
  assert.deepEqual(native.input, ["text", "image"]); assert.equal(native.contextWindow, 1048576); assert.equal(native.maxOutputTokens, 131072);
  assert.deepEqual(provider.endpoints.map(e => e.id).sort(), ["chat_completions", "models_list"]);
  const opaque = providerModel(provider, "particle/synthetic-tenant-model", provider.endpoints.find(e => e.id === "chat_completions"));
  assert.equal(opaque.nativeCapabilities, undefined); assert.equal(opaque.requestParameters, undefined); assert.equal(opaque.pricing, null);
  assert.throws(() => configuredUpstream(provider, null, { OPENAI_API_KEY: "synthetic-foreign" }), e => e.code === "provider_not_configured");
  const upstream = configuredUpstream(provider, null, { PARTICLE_API_KEY: "synthetic-explicit" });
  assert.equal(upstream.baseUrl, base); assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-explicit");
  assert.deepEqual(provider.auth.grantTransports, {});
});

test("Particle actual catalog advertises the original grant's sole frozen Chat card and explicit effort default", async t => {
  const f = await fixture(t), r = await f.catalog();
  assert.equal(r.status, 200, await r.clone().text()); assert.equal(r.headers.get("cache-control"), "no-store");
  const view = (await r.json()).providers.find(p => p.id === "particle");
  assert.deepEqual(view.models.map(m => m.id), [routerId]);
  assert.deepEqual(view.models[0].supportedReasoningEfforts, efforts);
  assert.equal(view.models[0].requestParameters.chat_completions.defaultReasoningEffort, "high");
  const offers = view.offers.filter(o => o.modelId === routerId);
  assert.ok(offers.length > 0); assert.ok(offers.every(o => o.endpoint === "chat_completions" && o.eligible));
  await f.drain(); assert.equal(f.sent.length, 0);
});

for (const model of models) for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`Particle native ${model} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} preserves selected identity, opaque reasoning/tool replay and native usage`, async t => {
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
    const wire = ": keep-alive\n\n" + chunks.map(chunk => frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model: publicId, ...chunk })).join("") + "data: [DONE]\n\n";
    let upstreamError;
    f.reply = async request => {
      try {
        assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-particle");
        assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.headers.get("x-organization-id"), null); assert.deepEqual(await request.json(), body);
        assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json(response(model));
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamError = e; throw e; }
    };
    const r = await f.call({ ...body, model: manifest ? routerId : model }, { manifest });
    assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
    if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), response(model));
    await f.drain(); assert.equal(f.sent.length, 1);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [100, 20, 120, 40]);
    assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:selected|foreign|reasoning|tool-result|answer)/);
  });
}

test("Particle original grant does not rewrite model case, substitute products or allow ungranted models", async t => {
  const f = await fixture(t);
  for (const model of ["Particle-1", "particle-ai/Particle-1", "deepseek-ai/deepseek-v41-flash-1017", "glm-5.3-flash", "synthetic-tenant-model"]) {
    for (const manifest of [false, true]) {
      const r = await f.call({ model: manifest ? `particle/${model}` : model, messages: [] }, { manifest });
      assert.equal(r.status, 403, await r.clone().text()); assert.equal((await r.json()).error.code, "model_not_allowed");
    }
  }
  await f.drain(); assert.equal(f.sent.length, 0);
});

test("Particle direct rejects foreign policy, missing/revoked credentials and unknown cost before egress", async t => {
  const f = await fixture(t, { ownGrant: false }), body = { model: models[0], messages: [] };
  assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
  assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, f.grantKey, { provider: "particle", kind: "api_key", enabled: true, credential: "synthetic-revoked" });
  await revokeGrantCredentials(f.env, f.grantKey); assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, "oauth/unpriced/particle", { provider: "particle", kind: "api_key", enabled: true, credential: "synthetic-unpriced" });
  assert.equal((await f.call(body, { policyId: "unpriced" })).status, 400); assert.equal(f.sent.length, 0);
});

for (const status of [400, 401, 402, 403, 404, 410, 429, 500, 502, 503]) test(`Particle native ${status} never retries a product, model or credential`, async t => {
  const f = await fixture(t);
  f.reply = () => Response.json({ error: { type: "invalid_request_error", message: "synthetic-upstream-rejection" } }, { status });
  const r = await f.call({ model: models[0], messages: [] }); assert.equal(r.status, status, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal((await f.sent[0].json()).model, models[0]);
});

for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error", "late-error"]) test(`Particle native ${manifest ? "manifest" : "native"} ${outcome} preserves conservative settlement`, async t => {
  const f = await fixture(t), model = thinking;
  const wire = outcome === "embedded-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } })
    : frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model: publicId, choices: [{ index: 0, delta: { reasoning_content: "synthetic-partial-reasoning" }, finish_reason: null }] }) + (outcome === "disconnect" ? "" : outcome === "late-error" ? frame({ error: { type: "server_error", code: "invalid_model_output", message: "synthetic-stream-error" } }) : "data: [DONE]\n\n");
  let canceled = false;
  f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  const r = await f.call({ model: manifest ? routerId : model, messages: [], stream: true }, { manifest }); assert.equal(r.status, 200);
  if (outcome === "disconnect") { const reader = r.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel("synthetic disconnect"); assert.equal(canceled, true); }
  else assert.equal(await r.text(), wire);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
  assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome.endsWith("error") ? "provider_error" : "success");
  assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7); assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-partial-reasoning/);
});


test("Particle observed SSE usage is counted when supplied without assuming every stream contains it", async t => {
  const f = await fixture(t), model = models[0];
  const wire = frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model: publicId,
    choices: [{ index: 0, delta: { content: "synthetic-answer" }, finish_reason: "stop" }], usage }) + "data: [DONE]\n\n";
  f.reply = () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const r = await f.call({ model, messages: [], stream: true }); assert.equal(r.status, 200); assert.equal(await r.text(), wire);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [100, 20, 120, 40]);
  assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
});

for (const model of vision) for (const manifest of [false, true]) test(`Particle ${model} ${manifest ? "manifest" : "native"} preserves qualified inline image input`, async t => {
  const f = await fixture(t), body = { model, messages: [{ role: "user", content: [{ type: "text", text: "synthetic-input" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCuoAAAAASUVORK5CYII=" } }] }] };
  const r = await f.call({ ...body, model: manifest ? routerId : model }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
});

for (const manifest of [false, true]) test(`Particle ${manifest ? "manifest" : "native"} keyed discovery filters the original grant without inference pricing`, async t => {
  const f = await fixture(t), row = discoveryRow;
  f.reply = () => Response.json({ object: "list", data: [row, { id: "unpermitted", object: "model" }] });
  const r = await f.call(null, { discovery: true, manifest }); assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { object: "list", data: [row] }); assert.match(r.headers.get("cache-control"), /private, no-store/);
  assert.equal(f.sent[0].url, `${base}/models`); assert.equal(f.sent[0].method, "GET"); assert.equal(f.sent[0].body, null);
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-selected-particle");
  assert.equal(f.sent[0].headers.get("x-organization-id"), null); assert.equal(f.sent[0].headers.get("x-api-key"), null);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.equal(event.actual_cost_micros, 0); assert.equal(event.reserved_cost_micros, 0);
  f.reply = () => Response.json({ object: "list", data: [] });
  const empty = await f.call(null, { discovery: true, manifest }); assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), { object: "list", data: [] });
});

for (const manifest of [false, true]) test(`Particle ${manifest ? "manifest" : "native"} discovery rejects malformed envelopes and caller query remapping`, async t => {
  const f = await fixture(t);
  for (const payload of [{ data: [] }, { object: "wrong", data: [] }, { object: "list", data: [{}] }, { object: "list", data: [{ id: "bad\u0000id" }] }]) {
    f.reply = () => Response.json(payload); const r = await f.call(null, { discovery: true, manifest });
    assert.equal(r.status, 502, await r.clone().text()); assert.equal((await r.json()).error.code, "invalid_model_discovery_response");
  }
  const count = f.sent.length;
  for (const query of ["?limit=1", "?after_id=unpermitted", "?url=https://other.example", "?api_key=synthetic-private"]) {
    const r = await f.call(null, { discovery: true, manifest, query }); assert.equal(r.status, 400, await r.clone().text());
  }
  assert.equal(f.sent.length, count);
});

for (const manifest of [false, true]) test(`Particle ${manifest ? "manifest" : "native"} discovery cannot replace denied or revoked credentials with public inventory`, async t => {
  const f = await fixture(t);
  f.reply = () => Response.json({ error: "synthetic-private-rejection" }, { status: 403 });
  const r = await f.call(null, { discovery: true, manifest }); assert.equal(r.status, 403);
  assert.doesNotMatch(await r.text(), /synthetic-private-rejection/); assert.equal(f.sent.length, 1);
  await revokeGrantCredentials(f.env, f.grantKey);
  const denied = await f.call(null, { discovery: true, manifest }); assert.equal(denied.status, 503, await denied.clone().text());
  assert.equal(f.sent.length, 1);
});

test("Particle unified selected ID retains the documented wire alias and original grant", async t => {
  const f = await fixture(t), body = { model: wireId, messages: [{ role: "user", content: "synthetic-input" }] };
  const r = await f.call({ ...body, model: routerId }, { unified: true });
  assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-selected-particle"); assert.equal(f.sent[0].url, `${base}/chat/completions`);
});

test("Particle undeclared native URL alias remains closed without egress", async t => {
  const f = await fixture(t), r = await f.call({ model: wireId, messages: [] }, { nativePrefix: "clawrouter-particle" });
  assert.equal(r.status, 404); assert.equal((await r.json()).error.code, "provider_not_found");
  await f.drain(); assert.equal(f.sent.length, 0);
});

for (const manifest of [false, true]) test(`Particle ${manifest ? "manifest" : "native"} preserves all four frozen canonical efforts and counts reasoning within output`, async t => {
  const f = await fixture(t);
  for (const effort of efforts) {
    const body = { model: wireId, messages: [{ role: "user", content: "synthetic-input" }], reasoning_effort: effort, max_tokens: 128 };
    const reply = response(wireId); if (effort === "none") delete reply.choices[0].message.reasoning_content;
    f.reply = () => Response.json(reply);
    const r = await f.call({ ...body, model: manifest ? routerId : wireId }, { manifest });
    assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), reply); await f.drain();
    assert.deepEqual(await f.sent.at(-1).json(), body);
    const event = f.events.filter(e => e.type === "clawrouter.usage.v1").at(-1);
    assert.equal(event.output_tokens, 20); assert.equal(event.total_tokens, 120); assert.equal(event.actual_cost_micros, 7);
  }
});

for (const manifest of [false, true]) test(`Particle ${manifest ? "manifest" : "native"} leaves upstream defaults and cache affinity unchanged`, async t => {
  const f = await fixture(t), body = { model: wireId, messages: [{ role: "developer", content: "synthetic-instruction" }, { role: "user", content: "synthetic-input" }],
    prompt_cache_key: "synthetic-cache-affinity", max_tokens: 256, max_completion_tokens: 256 };
  const r = await f.call({ ...body, model: manifest ? routerId : wireId }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
  const sent = await f.sent[0].json(); assert.deepEqual(sent, body); assert.equal(sent.reasoning_effort, undefined); assert.equal(sent.prompt_cache_retention, undefined);
  assert.doesNotMatch(JSON.stringify(f.events), /synthetic-cache-affinity|synthetic-instruction/);
});

for (const manifest of [false, true]) test(`Particle ${manifest ? "manifest" : "native"} distinguishes a requested tier from the served tier without inventing a discount`, async t => {
  const f = await fixture(t), body = { model: wireId, messages: [{ role: "user", content: "synthetic-input" }], service_tier: "flex" };
  const reply = { ...response(wireId), service_tier: "default" };
  f.reply = () => Response.json(reply, { headers: { "x-particle-service-tier": "default" } });
  const r = await f.call({ ...body, model: manifest ? routerId : wireId }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); assert.equal(r.headers.get("x-particle-service-tier"), "default");
  assert.deepEqual(await r.json(), reply); await f.drain();
  assert.deepEqual(await f.sent[0].json(), body);
  const event = f.events.find(e => e.type === "clawrouter.usage.v1"); assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
  assert.equal(event.requested_service_tier, "flex"); assert.equal(event.served_service_tier, "default");
});

for (const manifest of [false, true]) test(`Particle ${manifest ? "manifest" : "native"} discovery needs the original key but no inference tariff`, async t => {
  const f = await fixture(t); f.reply = () => Response.json({ object: "list", data: [discoveryRow] });
  const r = await f.call(null, { discovery: true, manifest, policyId: "unpriced" });
  assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), { object: "list", data: [discoveryRow] }); await f.drain();
  const event = f.events.find(e => e.type === "clawrouter.usage.v1"); assert.equal(event.actual_cost_micros, 0); assert.equal(event.reserved_cost_micros, 0);
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-selected-particle"); assert.equal(f.sent.length, 1);
});

for (const manifest of [false, true]) test(`Particle ${manifest ? "manifest" : "native"} preserves a best-effort schema request without claiming schema enforcement`, async t => {
  const f = await fixture(t), body = { model: wireId, messages: [{ role: "user", content: "synthetic-input" }],
    response_format: { type: "json_schema", json_schema: { name: "fixture", strict: true,
      schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } } };
  const reply = response(wireId); reply.choices[0].message.content = '{"different":"synthetic-answer"}';
  f.reply = () => Response.json(reply);
  const r = await f.call({ ...body, model: manifest ? routerId : wireId }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), reply); await f.drain();
  assert.deepEqual(await f.sent[0].json(), body); assert.equal(discoveryRow.capabilities.structured_outputs, false);
});
