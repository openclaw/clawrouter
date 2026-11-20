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
  ["scripts/compile-providers.mjs", "providers/venice.provider.yaml"], { encoding: "utf8" })).providers[0];
const base = "https://api.venice.ai/api/v1";
const facts = [
  ["zai-org-glm-5-2", 1000000, 131072, false, ["none", "high", "max"], "max"],
  ["zai-org-glm-4.7", 198000, 16384, false, ["low", "medium", "high"], "low"],
  ["venice-uncensored-1-2", 128000, 8192, true, [], null],
  ["google-gemma-4-31b-it", 256000, 16384, true, ["none", "low", "medium", "high"], "low"],
  ["kimi-k2-6", 256000, 65536, true, ["none", "low", "medium", "high"], "high"],
  ["deepseek-v3.2", 160000, 32768, false, ["none", "low", "medium", "high"], "low"],
  ["qwen3-235b-a22b-thinking-2507", 128000, 16384, false, ["low", "medium", "high"], "low"],
  ["qwen3-coder-480b-a35b-instruct-turbo", 256000, 65536, false, [], null],
  ["qwen3-vl-235b-a22b", 128000, 16384, true, [], null],
  ["grok-4-5", 500000, 32000, true, ["low", "medium", "high"], "high"],
  ["qwen-3-7-max", 1000000, 65536, true, [], null],
  ["qwen-3-7-plus", 1000000, 65536, true, [], null],
  ["claude-fable-5", 1000000, 128000, true, ["low", "medium", "high", "xhigh", "max"], "high"],
  ["claude-opus-5", 1000000, 128000, true, ["low", "medium", "high", "xhigh", "max"], "medium"],
  ["claude-sonnet-4-6", 1000000, 64000, true, ["low", "medium", "high", "max"], "high"],
  ["openai-gpt-56-sol", 1000000, 128000, true, ["none", "low", "medium", "high", "xhigh", "max"], "high"],
  ["zai-org-glm-4.6", 198000, 16384, false, ["low", "medium", "high"], "low"],
  ["google-gemma-3-27b-it", 198000, 16384, true, [], null],
  ["kimi-k2-5", 256000, 65536, true, ["none", "low", "medium", "high"], "high"],
];
const models = facts.map(row => row[0]), thinking = models[0];
const vision = new Set(facts.filter(row => row[3]).map(row => row[0]));
const nonReasoning = new Set([models[2], models[7], models[8], models[17]]);
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } };
const reasoning = model => nonReasoning.has(model) ? {} : { reasoning_content: "synthetic-reasoning" };
const response = model => ({ id: "chatcmpl_fixture", object: "chat.completion", model,
  choices: [{ index: 0, message: { role: "assistant", ...reasoning(model), content: "synthetic-answer" }, finish_reason: "stop" }], usage });

async function fixture(t, { ownGrant = true } = {}) {
  const previous = snapshot.providers.find(p => p.id === provider.id), row = structuredClone(provider);
  snapshot.providers.splice(snapshot.providers.indexOf(previous), 1, row);
  t.after(() => { snapshot.providers.splice(snapshot.providers.indexOf(row), 1, previous); });
  const values = new Map(), pending = [], events = [], sent = [];
  const env = { OPENAI_API_KEY: "synthetic-foreign-environment", ANTHROPIC_API_KEY: "synthetic-foreign-anthropic", OPENROUTER_API_KEY: "synthetic-foreign-router", POLICY_KV: {
    async get(k, type) {
      if (Array.isArray(k)) return new Map(k.map(k => [k, values.get(k) ?? null]));
      const value = values.get(k) ?? null;
      return value !== null && type === "stream" ? accessBytesResponse(JSON.stringify(value)).body : value;
    },
    async put(k, v) { values.set(k, JSON.parse(v)); },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: ["venice"], models: models.map(m => `venice/${m}`), tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["openrouter"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "venice", enabled: true }]);
  await putGrantCredentials(env, "oauth/paid/openrouter", { provider: "openrouter", kind: "api_key", enabled: true, credential: "synthetic-foreign-grant" });
  for (const policyId of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${policyId}/venice`, {
    provider: "venice", kind: "api_key", enabled: true, credential: "synthetic-selected-venice" });
  const f = { env, events, sent, grantKey: "oauth/paid/venice", reply: async r => Response.json(response((await r.clone().json()).model)),
    call(body, { manifest = false, policyId = "paid" } = {}) {
      const path = manifest ? "/v1/proxy/venice/chat_completions" : "/v1/native/venice/chat/completions";
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

test("Venice declaration preserves exactly nineteen frozen identities with independent limits and observed effort menus", () => {
  assert.deepEqual(provider.models.map(m => m.upstream), models);
  for (const [i, m] of provider.models.entries()) {
    const [, context, output, image, efforts, defaultEffort] = facts[i];
    assert.equal(m.id, `venice/${m.upstream}`); assert.equal(m.pricing, null); assert.equal(m.availability, undefined);
    assert.deepEqual(m.supportedReasoningEfforts, efforts.length ? efforts : undefined);
    const native = m.nativeCapabilities.endpoints.chat_completions;
    assert.deepEqual([native.contextWindow, native.maxOutputTokens], [context, output]);
    assert.deepEqual(native.input, image ? ["text", "image"] : ["text"]);
    assert.equal(m.requestParameters.chat_completions.toolCalling, "supported");
    assert.equal(m.requestParameters.chat_completions.defaultReasoningEffort, defaultEffort ?? undefined);
  }
  assert.deepEqual(provider.endpoints.map(e => [e.id, e.method, e.methods, e.path, e.request_format, e.response_format]), [
    ["chat_completions", "POST", ["POST"], "/chat/completions", "openai.chat_completions", "openai.chat_completions"],
    ["models_list", "GET", ["GET"], "/models", "venice.models", "venice.models"],
  ]);
  const opaque = providerModel(provider, "venice/synthetic-tenant-model", provider.endpoints[0]);
  assert.equal(opaque.nativeCapabilities, undefined); assert.equal(opaque.requestParameters, undefined); assert.equal(opaque.pricing, null);
  assert.throws(() => configuredUpstream(provider, null, { ANTHROPIC_API_KEY: "synthetic-unselected-anthropic", OPENAI_API_KEY: "synthetic-foreign" }), e => e.code === "provider_not_configured");
  const upstream = configuredUpstream(provider, null, { VENICE_API_KEY: "synthetic-explicit" });
  assert.equal(upstream.baseUrl, base); assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-explicit");
  assert.deepEqual(provider.auth.grantTransports, {});
});

test("Venice actual catalog exposes only the original direct grant's eligible finite Chat offers", async t => {
  const f = await fixture(t), r = await f.catalog();
  assert.equal(r.status, 200, await r.clone().text()); assert.equal(r.headers.get("cache-control"), "no-store");
  const view = (await r.json()).providers.find(p => p.id === "venice");
  assert.deepEqual(view.models.map(m => m.id).sort(), models.map(m => `venice/${m}`).sort());
  for (const m of view.models) {
    assert.equal(m.requestParameters.chat_completions.toolCalling, "supported");
    assert.deepEqual(m.nativeCapabilities.endpoints.chat_completions.input, vision.has(m.id.slice("venice/".length)) ? ["text", "image"] : ["text"]);
    const offers = view.offers.filter(o => o.modelId === m.id);
    assert.ok(offers.length > 0); assert.ok(offers.every(o => o.endpoint === "chat_completions" && o.eligible));
  }
  await f.drain(); assert.equal(f.sent.length, 0);
});

for (const model of models) for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`Venice native ${model} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} preserves replay and tools with optional usage`, async t => {
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
        assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-venice");
        assert.equal(request.headers.get("x-api-key"), null); assert.deepEqual(await request.json(), body);
        assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json(response(model));
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamError = e; throw e; }
    };
    const r = await f.call({ ...body, model: manifest ? `venice/${model}` : model }, { manifest });
    assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
    if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), response(model));
    await f.drain(); assert.equal(f.sent.length, 1);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], stream ? [null, null, null, null] : [100, 20, 120, 40]);
    assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:selected|foreign|reasoning|tool-result|answer)/);
  });
}

test("Venice original grant does not infer trait aliases, change provider products or allow ungranted models", async t => {
  const f = await fixture(t);
  for (const model of ["default", "default_code", "fastest", "openai/gpt-5.6-sol", "synthetic-tenant-model"]) {
    for (const manifest of [false, true]) {
      const r = await f.call({ model: manifest ? `venice/${model}` : model, messages: [] }, { manifest });
      assert.equal(r.status, 403, await r.clone().text()); assert.equal((await r.json()).error.code, "model_not_allowed");
    }
  }
  await f.drain(); assert.equal(f.sent.length, 0);
});

test("Venice direct rejects foreign policy, missing/revoked credentials and unknown cost before egress", async t => {
  const f = await fixture(t, { ownGrant: false }), body = { model: models[0], messages: [] };
  assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
  assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, f.grantKey, { provider: "venice", kind: "api_key", enabled: true, credential: "synthetic-revoked" });
  await revokeGrantCredentials(f.env, f.grantKey); assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, "oauth/unpriced/venice", { provider: "venice", kind: "api_key", enabled: true, credential: "synthetic-unpriced" });
  assert.equal((await f.call(body, { policyId: "unpriced" })).status, 400); assert.equal(f.sent.length, 0);
});

for (const status of [400, 401, 403, 404, 410, 429, 500, 503]) test(`Venice native ${status} never retries a product, model or credential`, async t => {
  const f = await fixture(t);
  f.reply = () => Response.json({ error: { type: "invalid_request_error", message: "synthetic-upstream-rejection" } }, { status });
  const r = await f.call({ model: models[0], messages: [] });
  // The strict selected-model response gate does not publish an unqualified
  // non-200 payload, even when its native status was a client-side rejection.
  assert.equal(r.status, 502); const text = await r.text();
  assert.equal(JSON.parse(text).error.code, "provider_unavailable"); assert.doesNotMatch(text, /synthetic-upstream-rejection/);
  await f.drain(); assert.equal(f.sent.length, 1); assert.equal((await f.sent[0].json()).model, models[0]);
  const events = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(events.length, 1);
  assert.equal(events[0].status, "provider_error"); assert.equal(events[0].actual_cost_micros, 7); assert.equal(events[0].cost_basis, "policy_fixed");
  assert.deepEqual([events[0].input_tokens, events[0].output_tokens, events[0].total_tokens], [null, null, null]);
});

for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error"]) test(`Venice native ${manifest ? "manifest" : "native"} ${outcome} preserves conservative settlement`, async t => {
  const f = await fixture(t), model = thinking;
  const wire = outcome === "embedded-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } })
    : frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { reasoning_content: "synthetic-partial-reasoning" }, finish_reason: null }] }) + (outcome === "disconnect" ? "" : "data: [DONE]\n\n");
  let canceled = false;
  f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  const r = await f.call({ model: manifest ? `venice/${model}` : model, messages: [], stream: true }, { manifest }); assert.equal(r.status, outcome === "embedded-error" ? 502 : 200);
  if (outcome === "disconnect") { const reader = r.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel("synthetic disconnect"); assert.equal(canceled, true); }
  else if (outcome === "embedded-error") {
    const text = await r.text(); assert.equal(JSON.parse(text).error.code, "provider_unavailable");
    assert.doesNotMatch(text, /synthetic-stream-error/);
  } else assert.equal(await r.text(), wire);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
  assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome === "embedded-error" ? "provider_error" : "success");
  assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-partial-reasoning/);
});

for (const [model, , , , efforts] of facts.filter(row => row[4].length)) test(`Venice ${model} preserves each qualified flat and nested reasoning effort`, async t => {
  const f = await fixture(t);
  for (const effort of efforts) for (const nested of [false, true]) {
    const body = { model, ...(nested ? { reasoning: { effort } } : { reasoning_effort: effort }),
      messages: [{ role: "assistant", content: "synthetic-answer", reasoning_content: "synthetic-prior-reasoning",
        tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_fixture", content: "synthetic-result" }] };
    const r = await f.call(body); assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
    assert.deepEqual(await f.sent.at(-1).json(), body);
  }
  assert.equal(f.sent.length, efforts.length * 2);
});

for (const manifest of [false, true]) test(`Venice ${manifest ? "manifest" : "native"} keeps disable, encrypted replay and output caps distinct`, async t => {
  const f = await fixture(t), model = "openai-gpt-56-sol";
  const body = { model, reasoning: { enabled: false }, max_tokens: 128, max_completion_tokens: 256,
    messages: [{ role: "assistant", content: "synthetic-answer", reasoning_content: "[Some reasoning content is encrypted]" }] };
  const native = { ...response(model), cost: { usd: 0.00002, diem: 0.00007 } };
  f.reply = () => Response.json(native);
  const r = await f.call({ ...body, model: manifest ? `venice/${model}` : model }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), native); await f.drain();
  assert.deepEqual(await f.sent[0].json(), body);
  const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
});

test("Venice observed SSE usage is counted when supplied without assuming every stream contains it", async t => {
  const f = await fixture(t), model = models[0];
  const wire = frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model,
    choices: [{ index: 0, delta: { content: "synthetic-answer" }, finish_reason: "stop" }], usage }) + "data: [DONE]\n\n";
  f.reply = () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const r = await f.call({ model, messages: [], stream: true }); assert.equal(r.status, 200); assert.equal(await r.text(), wire);
  await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [100, 20, 120, 40]);
  assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
});

for (const model of vision) for (const manifest of [false, true]) test(`Venice ${model} ${manifest ? "manifest" : "native"} preserves qualified inline image input`, async t => {
  const f = await fixture(t), body = { model, messages: [{ role: "user", content: [{ type: "text", text: "synthetic-input" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCuoAAAAASUVORK5CYII=" } }] }] };
  const r = await f.call({ ...body, model: manifest ? `venice/${model}` : model }, { manifest });
  assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
});

