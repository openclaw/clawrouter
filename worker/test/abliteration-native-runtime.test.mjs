import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { accessBytesResponse } from "./access-byte-fixture.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { snapshot, configuredUpstream, providerModel } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const provider = JSON.parse(execFileSync(process.execPath,
  ["scripts/compile-providers.mjs", "providers/abliteration.provider.yaml"], { encoding: "utf8" })).providers[0];
const base = "https://api.abliteration.ai/v1";
const models = ["abliterated-model-large-flash", "abliterated-model-large-v2", "abliterated-model", "abliterated-model-large"];
const thinking = models[1];
const vision = new Set([models[0], models[2]]);
const toolFacts = new Set(models);
const efforts = [["none", "low", "high", "max"], ["low", "high", "max"], ["none", "minimal", "low", "medium", "high", "xhigh", "max"], ["none", "high", "max"]];
const defaults = ["high", "max", undefined, "high"];
const contexts = [1048576, 1000000, 262144, 1000000];
const outputs = [262144, 999990, 262134, 999990];
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 6 } };
const reasoning = () => ({ reasoning_content: "synthetic-reasoning" });
const response = model => ({ id: "chatcmpl_fixture", object: "chat.completion", model,
  choices: [{ index: 0, message: { role: "assistant", ...reasoning(model), content: "synthetic-answer" }, finish_reason: "stop" }], usage });

async function fixture(t, { ownGrant = true } = {}) {
  const previous = snapshot.providers.find(p => p.id === provider.id), row = structuredClone(provider);
  snapshot.providers.splice(snapshot.providers.indexOf(previous), 1, row);
  t.after(() => { snapshot.providers.splice(snapshot.providers.indexOf(row), 1, previous); });
  const values = new Map(), pending = [], events = [], sent = [];
  const env = { OPENAI_API_KEY: "synthetic-foreign-environment", ANTHROPIC_API_KEY: "synthetic-foreign-anthropic", OPENROUTER_API_KEY: "synthetic-foreign-router", POLICY_KV: {
    async get(key, type) {
      const read = name => {
        const value = values.get(name) ?? null;
        return value !== null && type === "stream" ? accessBytesResponse(JSON.stringify(value), "").body : value;
      };
      return Array.isArray(key) ? new Map(key.map(name => [name, read(name)])) : read(key);
    },
    async put(k, v) { values.set(k, JSON.parse(v)); },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: ["abliteration"], models: models.map(m => `abliteration/${m}`), tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["openrouter"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "abliteration", enabled: true }]);
  await putGrantCredentials(env, "oauth/paid/openrouter", { provider: "openrouter", kind: "api_key", enabled: true, credential: "synthetic-foreign-grant" });
  for (const policyId of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${policyId}/abliteration`, {
    provider: "abliteration", kind: "api_key", enabled: true, credential: "synthetic-selected-abliteration" });
  const f = { env, events, sent, grantKey: "oauth/paid/abliteration", reply: async r => Response.json(response((await r.clone().json()).model)),
    call(body, { manifest = false, policyId = "paid", discovery = false, query = "", nativePrefix = "abliteration" } = {}) {
      const path = discovery ? (manifest ? "/v1/proxy/abliteration/models_list" : `/v1/native/${nativePrefix}/models`)
        : (manifest ? "/v1/proxy/abliteration/chat_completions" : `/v1/native/${nativePrefix}/chat/completions`);
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

test("Abliteration declaration keeps four exact frozen identities, canonical efforts and native facts", () => {
  assert.deepEqual(provider.models.map(m => m.upstream), models);
  for (const [i, m] of provider.models.entries()) {
    assert.equal(m.id, `abliteration/${m.upstream}`); assert.equal(m.pricing, null);
    assert.equal(m.availability?.status, i === 3 ? "deprecated" : undefined);
    if (i === 3) assert.equal(m.availability.effectiveAt, "2026-11-03");
    assert.deepEqual(m.supportedReasoningEfforts, efforts[i]);
    assert.equal(m.requestParameters?.chat_completions.toolCalling, toolFacts.has(m.upstream) ? "supported" : undefined);
    assert.equal(m.requestParameters?.chat_completions.defaultReasoningEffort, defaults[i]);
    const native = m.nativeCapabilities?.endpoints.chat_completions;
    assert.deepEqual(native?.input, vision.has(m.upstream) ? ["text", "image"] : ["text"]);
    assert.equal(native?.contextWindow, contexts[i]); assert.equal(native?.maxOutputTokens, outputs[i]);
  }
  assert.deepEqual(provider.endpoints.map(e => e.id).sort(), ["chat_completions", "models_list"]);
  const metadata = provider.endpoints.find(e => e.id === "models_list");
  assert.equal(metadata.method, "GET"); assert.equal(metadata.streaming, null);
  const opaque = providerModel(provider, "abliteration/synthetic-tenant-model", provider.endpoints.find(e => e.id === "chat_completions"));
  assert.equal(opaque.nativeCapabilities, undefined); assert.equal(opaque.requestParameters, undefined); assert.equal(opaque.pricing, null);
  assert.throws(() => configuredUpstream(provider, null, { ANTHROPIC_API_KEY: "synthetic-unselected-anthropic", OPENAI_API_KEY: "synthetic-foreign" }), e => e.code === "provider_not_configured");
  const upstream = configuredUpstream(provider, null, { ABLITERATION_API_KEY: "synthetic-explicit" });
  assert.equal(upstream.baseUrl, base); assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-explicit");
  assert.equal(upstream.headers.get("x-organization-id"), null); assert.deepEqual(provider.auth.grantTransports, {});
  const canonical = configuredUpstream(provider, null, { ABLIT_KEY: "synthetic-canonical", ABLITERATION_API_KEY: "synthetic-legacy" });
  assert.equal(canonical.baseUrl, base); assert.equal(canonical.headers.get("authorization"), "Bearer synthetic-canonical");
});

test("Abliteration actual catalog exposes only the original direct grant's eligible finite Chat offers", async t => {
  const f = await fixture(t), r = await f.catalog();
  assert.equal(r.status, 200, await r.clone().text()); assert.equal(r.headers.get("cache-control"), "no-store");
  const view = (await r.json()).providers.find(p => p.id === "abliteration");
  assert.deepEqual(view.models.map(m => m.id).sort(), models.map(m => `abliteration/${m}`).sort());
  for (const m of view.models) {
    assert.equal(m.requestParameters?.chat_completions.toolCalling, toolFacts.has(m.id.slice("abliteration/".length)) ? "supported" : undefined);
    const offers = view.offers.filter(o => o.modelId === m.id);
    assert.ok(offers.length > 0); assert.ok(offers.every(o => o.endpoint === "chat_completions" && o.eligible));
  }
  await f.drain(); assert.equal(f.sent.length, 0);
});

for (const model of models) for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`Abliteration native ${model} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} preserves selected identity, opaque reasoning/tool replay and native usage`, async t => {
    const f = await fixture(t), tools = toolFacts.has(model);
    const body = { model, stream, max_tokens: 256,
      ...(stream && { stream_options: { include_usage: true } }),
      messages: tools ? [{ role: "assistant", content: "", ...reasoning(model),
        tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" }]
        : [{ role: "user", content: "synthetic-input" }],
      ...(tools && { tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }], tool_choice: "auto" }) };
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", ...reasoning(model) }, finish_reason: null }] },
      ...(tools ? [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] },
      ] : [{ choices: [{ index: 0, delta: { content: "synthetic-answer" }, finish_reason: "stop" }] }]),
      { choices: [], usage },
    ];
    const wire = chunks.map(chunk => frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, ...chunk })).join("") + "data: [DONE]\n\n";
    let upstreamError;
    f.reply = async request => {
      try {
        assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-abliteration");
        assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.headers.get("x-organization-id"), null); assert.deepEqual(await request.json(), body);
        assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json(response(model));
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamError = e; throw e; }
    };
    const r = await f.call({ ...body, model: manifest ? `abliteration/${model}` : model }, { manifest });
    assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
    if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), response(model));
    await f.drain(); assert.equal(f.sent.length, 1);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [100, 20, 120, 40]);
    assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:selected|foreign|reasoning|tool-result|answer)/);
  });
}

test("Abliteration original grant does not rewrite model case, substitute products or allow ungranted models", async t => {
  const f = await fixture(t);
  for (const model of ["Abliterated-Model", "abliterated-model-latest", "synthetic-tenant-model"]) {
    for (const manifest of [false, true]) {
      const r = await f.call({ model: manifest ? `abliteration/${model}` : model, messages: [] }, { manifest });
      assert.equal(r.status, 403, await r.clone().text()); assert.equal((await r.json()).error.code, "model_not_allowed");
    }
  }
  await f.drain(); assert.equal(f.sent.length, 0);
});

test("Abliteration direct rejects foreign policy, missing/revoked credentials and unknown cost before egress", async t => {
  const f = await fixture(t, { ownGrant: false }), body = { model: models[0], messages: [] };
  assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
  assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, f.grantKey, { provider: "abliteration", kind: "api_key", enabled: true, credential: "synthetic-revoked" });
  await revokeGrantCredentials(f.env, f.grantKey); assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, "oauth/unpriced/abliteration", { provider: "abliteration", kind: "api_key", enabled: true, credential: "synthetic-unpriced" });
  assert.equal((await f.call(body, { policyId: "unpriced" })).status, 400); assert.equal(f.sent.length, 0);
});

for (const status of [400, 401, 402, 403, 404, 409, 410, 422, 429, 500, 503]) test(`Abliteration native ${status} never retries a product, model or credential`, async t => {
  const f = await fixture(t);
  f.reply = () => Response.json({ error: { type: "invalid_request_error", message: "synthetic-upstream-rejection" } }, { status });
  const r = await f.call({ model: models[0], messages: [] }); assert.equal(r.status, status, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal((await f.sent[0].json()).model, models[0]);
});

for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error", "late-error"]) test(`Abliteration native ${manifest ? "manifest" : "native"} ${outcome} preserves conservative settlement`, async t => {
  const f = await fixture(t), model = thinking;
  const wire = outcome === "embedded-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } })
    : frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { reasoning_content: "synthetic-partial-reasoning" }, finish_reason: null }] })
      + (outcome === "late-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } })
        : outcome === "disconnect" ? "" : "data: [DONE]\n\n");
  let canceled = false;
  f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  const r = await f.call({ model: manifest ? `abliteration/${model}` : model, messages: [], stream: true }, { manifest }); assert.equal(r.status, 200);
  if (outcome === "disconnect") { const reader = r.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel("synthetic disconnect"); assert.equal(canceled, true); }
  else assert.equal(await r.text(), wire);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
  assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome.endsWith("error") ? "provider_error" : "success");
  assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7); assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-partial-reasoning/);
});


for (const [i, model] of models.entries()) for (const manifest of [false, true]) test(`Abliteration ${model} ${manifest ? "manifest" : "native"} preserves its frozen canonical effort ladder`, async t => {
  const f = await fixture(t);
  for (const reasoning_effort of efforts[i]) {
    const body = { model, reasoning_effort, max_tokens: 256, messages: [{ role: "user", content: "synthetic-input" }] };
    const r = await f.call({ ...body, model: manifest ? `abliteration/${model}` : model }, { manifest });
    assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
    assert.deepEqual(await f.sent.at(-1).json(), body);
  }
  assert.equal(f.sent.length, efforts[i].length);
});

for (const manifest of [false, true]) test(`Abliteration ${manifest ? "manifest" : "native"} omits default controls and preserves the deprecated exact ID`, async t => {
  const f = await fixture(t);
  for (const model of models) {
    const body = { model, messages: [{ role: "user", content: "synthetic-input" }] };
    const r = await f.call({ ...body, model: manifest ? `abliteration/${model}` : model }, { manifest });
    assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
    assert.deepEqual(await f.sent.at(-1).json(), body);
  }
});

for (const manifest of [false, true]) test(`Abliteration Large v2 ${manifest ? "manifest" : "native"} hiding reasoning retains independently reported token usage`, async t => {
  const f = await fixture(t), model = models[1];
  for (const controls of [{ reasoning_effort: "none" }, { thinking: false }, { include_reasoning: false }]) {
    const body = { model, ...controls, messages: [{ role: "user", content: "synthetic-input" }] };
    f.reply = () => { const value = response(model); delete value.choices[0].message.reasoning_content; return Response.json(value); };
    const r = await f.call({ ...body, model: manifest ? `abliteration/${model}` : model }, { manifest });
    assert.equal(r.status, 200, await r.clone().text()); assert.equal((await r.json()).choices[0].message.reasoning_content, undefined);
    await f.drain(); assert.deepEqual(await f.sent.at(-1).json(), body);
    const event = f.events.filter(e => e.type === "clawrouter.usage.v1").at(-1);
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [100, 20, 120]);
    assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
  }
});

for (const manifest of [false, true]) test(`Abliteration ${manifest ? "manifest" : "native"} cache routing hint does not imply a hit or a tariff`, async t => {
  const f = await fixture(t), model = thinking;
  for (const cached of [undefined, 0, 40]) {
    f.reply = () => { const value = response(model); value.usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }) }; return Response.json(value); };
    const body = { model, messages: [{ role: "user", content: "synthetic-input" }], prompt_cache_key: "synthetic-cache-hint" };
    const r = await f.call({ ...body, model: manifest ? `abliteration/${model}` : model }, { manifest });
    assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain(); assert.deepEqual(await f.sent.at(-1).json(), body);
    const event = f.events.filter(e => e.type === "clawrouter.usage.v1").at(-1);
    assert.equal(event.cached_input_tokens, cached ?? null); assert.equal(event.actual_cost_micros, 7);
    assert.equal(event.cost_basis, "policy_fixed"); assert.doesNotMatch(JSON.stringify(event), /synthetic-cache-hint/);
  }
});

for (const manifest of [false, true]) test(`Abliteration ${manifest ? "manifest" : "native"} preserves native JSON mode and JSON Schema requests`, async t => {
  const f = await fixture(t), model = models[0];
  for (const response_format of [{ type: "json_object" }, { type: "json_schema", json_schema: { name: "answer", strict: true,
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } }]) {
    const body = { model, messages: [{ role: "user", content: "Return a JSON object with an answer field." }], response_format };
    f.reply = () => { const value = response(model); value.choices[0].message.content = '{"answer":"synthetic-answer"}'; return Response.json(value); };
    const r = await f.call({ ...body, model: manifest ? `abliteration/${model}` : model }, { manifest });
    assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(JSON.parse((await r.json()).choices[0].message.content), { answer: "synthetic-answer" });
    await f.drain(); assert.deepEqual(await f.sent.at(-1).json(), body);
  }
});

for (const model of vision) for (const manifest of [false, true]) test(`Abliteration ${model} ${manifest ? "manifest" : "native"} preserves qualified inline image input`, async t => {
  const f = await fixture(t), body = { model, messages: [{ role: "user", content: [{ type: "text", text: "synthetic-input" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCuoAAAAASUVORK5CYII=" } }] }] };
  const r = await f.call({ ...body, model: manifest ? `abliteration/${model}` : model }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
});

for (const model of [models[1], models[3]]) for (const manifest of [false, true]) test(`Abliteration text-only ${model} ${manifest ? "manifest" : "native"} does not switch models after an image rejection`, async t => {
  const f = await fixture(t), body = { model, messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: "https://image.example/synthetic.png" } },
  ] }] };
  f.reply = () => Response.json({ error: { type: "invalid_request_error", code: "unsupported_image_input", message: "synthetic-image-rejection" } }, { status: 400 });
  const r = await f.call({ ...body, model: manifest ? `abliteration/${model}` : model }, { manifest });
  assert.equal(r.status, 400, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
  assert.equal(f.sent[0].url, `${base}/chat/completions`);
});

for (const manifest of [false, true]) test(`Abliteration ${manifest ? "manifest" : "native"} keyed discovery filters the original grant without inference pricing`, async t => {
  const f = await fixture(t), row = { id: models[3], object: "model", created: 1687530000, owned_by: "abliteration.ai",
    access: { required_checks: ["account_access"], available: false, locked: true, missing_requirements: ["account_access"] },
    is_ready: true, context_length: 1000000, max_output_length: 999990 };
  f.reply = () => Response.json({ object: "list", data: [row, { id: "unpermitted", object: "model" }] });
  const r = await f.call(null, { discovery: true, manifest }); assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { object: "list", data: [row] }); assert.match(r.headers.get("cache-control"), /private, no-store/);
  assert.equal(f.sent[0].url, `${base}/models`); assert.equal(f.sent[0].method, "GET"); assert.equal(f.sent[0].body, null);
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-selected-abliteration");
  assert.equal(f.sent[0].headers.get("x-organization-id"), null); assert.equal(f.sent[0].headers.get("x-api-key"), null);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.equal(event.actual_cost_micros, 0); assert.equal(event.reserved_cost_micros, 0);
  f.reply = () => Response.json({ object: "list", data: [] });
  const empty = await f.call(null, { discovery: true, manifest }); assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), { object: "list", data: [] });
});

for (const manifest of [false, true]) test(`Abliteration ${manifest ? "manifest" : "native"} discovery rejects malformed envelopes and caller query remapping`, async t => {
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

for (const manifest of [false, true]) test(`Abliteration ${manifest ? "manifest" : "native"} discovery cannot replace denied or revoked credentials with public inventory`, async t => {
  const f = await fixture(t);
  f.reply = () => Response.json({ error: "synthetic-private-rejection" }, { status: 403 });
  const r = await f.call(null, { discovery: true, manifest }); assert.equal(r.status, 403);
  assert.doesNotMatch(await r.text(), /synthetic-private-rejection/); assert.equal(f.sent.length, 1);
  await revokeGrantCredentials(f.env, f.grantKey);
  const denied = await f.call(null, { discovery: true, manifest }); assert.equal(denied.status, 503, await denied.clone().text());
  assert.equal(f.sent.length, 1);
});

test("Abliteration undeclared native URL aliases stay closed without egress", async t => {
  const f = await fixture(t), body = { model: models[0], messages: [{ role: "user", content: "synthetic-input" }] };
  const r = await f.call(body, { nativePrefix: "clawrouter-abliteration" });
  assert.equal(r.status, 404); assert.equal((await r.json()).error.code, "provider_not_found");
  await f.drain(); assert.equal(f.sent.length, 0); assert.equal(f.events.length, 0);
});
