import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { observeUsage } = await import("../proxy-response.ts");
const providerId = "native-fixture", grantKey = "oauth/fixture/native-fixture";
const chatPath = `/v1/native/${providerId}/api/chat`, tagsPath = `/v1/native/${providerId}/api/tags`;
const final = { model: "fixture", message: { role: "assistant", content: "answer" }, done: true, prompt_eval_count: 17, prompt_eval_cached_count: 3, eval_count: 4 };
const partial = { message: { role: "assistant", content: "", thinking: "synthetic 🦊", tool_calls: [{ function: { name: "forecast", arguments: { city: "Paris" } } }] }, done: false };
const line = value => JSON.stringify(value) + "\n";
const input = { model: "fixture", messages: [{ role: "user", content: "fixture" }], tools: [{ type: "function", function: { name: "forecast", parameters: { type: "object" } } }], think: "high", options: { num_predict: 8 }, stream: true };

async function fixture(t, { fixed = 7, models = null } = {}) {
  // A synthetic provider proves dispatch depends on formats, not provider IDs.
  // Source declarations and their generated snapshot remain independently owned.
  const provider = structuredClone(snapshot.providers.find(p => p.id === "openai"));
  Object.assign(provider, { id: providerId, class: "native", config_keys: ["FIXTURE_NATIVE_BASE_URL", "FIXTURE_NATIVE_API_KEY"], optional_config_keys: [], base_urls: { default: "${FIXTURE_NATIVE_BASE_URL}" },
    routing: { nativePrefixes: ["/api"], modelPrefixes: [`${providerId}/`], baseUrlParam: null, serviceParam: null }, native_prefixes: ["/api"],
    models: [{ id: `${providerId}/fixture`, upstream: "fixture", capabilities: ["llm.chat"], pricing: null, pricing_ref: null }],
    capabilities: [{ id: "llm.chat", endpoint: "chat", methods: ["POST"] }, { id: "models.list", endpoint: "tags", methods: ["GET"] }] });
  const chat = provider.endpoints.find(e => e.id === "chat_completions"), tags = provider.endpoints.find(e => e.id === "models_list");
  Object.assign(chat, { id: "chat", path: "/api/chat", request_format: "ollama.chat", response_format: "ollama.chat", streaming: "ndjson" });
  Object.assign(tags, { id: "tags", path: "/api/tags", request_format: "ollama.models", response_format: "ollama.models" });
  provider.endpoints = [chat, tags]; provider.auth.grantTransports = {};
  provider.adapter.requestTransforms.renameFields = []; provider.adapter.passthroughHeaders = [];
  snapshot.providers.push(provider); t.after(() => snapshot.providers.splice(snapshot.providers.indexOf(provider), 1));
  const values = new Map(), pending = [], events = [], sent = [], budgetCalls = [];
  const env = { FIXTURE_NATIVE_BASE_URL: "https://native.example", POLICY_KV: {
    async get(key) { return Array.isArray(key) ? new Map(key.map(name => [name, structuredClone(values.get(name) ?? null)])) : structuredClone(values.get(key) ?? null); },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  }, USAGE_QUEUE: { async send(event) { events.push(event); } } };
  const budgets = sqlBudgetNamespace(t);
  env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ fetch(url, init) { budgetCalls.push(new URL(url).pathname); return budgets.get(name).fetch(url, init); } }) };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const authority = async (path, value) => {
    const r = await env.ACCESS_CONTROL.get("policy-bindings").fetch(`https://authority${path}`, { method: "POST", body: JSON.stringify(value) });
    assert.equal(r.status, 200, await r.clone().text());
  };
  const policy = { enabled: true, generation: "g1", providers: [providerId], models, tenantId: "fixture-tenant", monthlyBudgetMicros: 1000, requestCostMicros: fixed, retainRequestContent: false };
  await authority("/policies/initialize-all", [{ policyId: "fixture", policy }]);
  await authority("/credentials/initialize-all", [{ credentialId: "fixture", credential: { enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: "fixture", policyGeneration: "g1", principalId: "fixture-principal" } }]);
  await authority("/connections/initialize-all", [{ providerId, enabled: true }]);
  await putGrantCredentials(env, grantKey, { provider: providerId, kind: "api_key", enabled: true, credential: "synthetic-native-key" });
  const f = { env, events, sent, budgetCalls, policy, authority,
    reply: () => Response.json(final),
    call(path = chatPath, body = input, headers = {}) {
      return worker.fetch(new Request(`https://router.example${path}`, { method: body == null ? "GET" : "POST", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", ...headers }, ...(body == null ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil: promise => pending.push(promise) });
    },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  return f;
}

for (const manifest of [false, true]) for (const streaming of [false, true]) test(`native Ollama ${manifest ? "manifest" : "native"} ${streaming ? "NDJSON" : "JSON"} preserves tools and settles once`, async t => {
  const f = await fixture(t), body = { ...input, stream: streaming };
  const wire = Buffer.from(streaming ? line(partial) + line(final) : JSON.stringify(final, null, 2));
  let offset = 0;
  f.reply = () => new Response(new ReadableStream({ pull(c) { if (offset === wire.length) c.close(); else c.enqueue(wire.subarray(offset, ++offset)); } }, { highWaterMark: 0 }), { headers: { "content-type": streaming ? "application/x-ndjson" : "application/json" } });
  const r = await f.call(manifest ? `/v1/proxy/${providerId}/chat` : chatPath, manifest ? { body: { ...body, model: `${providerId}/fixture` } } : body);
  assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(Buffer.from(await r.arrayBuffer()), wire);
  await f.drain(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, "https://native.example/api/chat");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-native-key"); assert.deepEqual(await f.sent[0].json(), body);
  assert.equal(f.events.length, 1); const event = f.events[0];
  assert.equal(event.status, "success"); assert.deepEqual([event.input_tokens, event.output_tokens, event.cached_input_tokens, event.total_tokens], [17, 4, 3, 21]);
  assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.grant_key, grantKey);
  assert.equal(event.tenant_id, "fixture-tenant"); assert.equal(event.credential_id, "fixture"); assert.equal(event.principal_id, "fixture-principal");
  assert.equal(f.budgetCalls.filter(path => path === "/reserve").length, 1); assert.equal(f.budgetCalls.filter(path => path === "/settle").length, 1);
});

test("native error bodies stay byte-exact; partial/error/unknown streams cannot become free or successful", async t => {
  const f = await fixture(t);
  for (const [wire, type, status, expected, tokens] of [
    [line(partial) + line({ error: "fixture failure" }), "application/x-ndjson", 200, "provider_error", null],
    [line(partial), "application/x-ndjson", 200, "provider_error", null],
    [line(final) + "{broken\n", "application/x-ndjson", 200, "provider_error", null],
    [line(final), "text/plain", 200, "provider_error", null],
    [JSON.stringify({ error: "fixture rejection", detail: "preserved" }, null, 2), "application/json", 400, "client_error", null],
  ]) {
    f.reply = () => new Response(wire, { status, headers: { "content-type": type } });
    const r = await f.call(); assert.equal(r.status, status); assert.equal(await r.text(), wire); await f.drain();
    const event = f.events.at(-1); assert.equal(event.status, expected); assert.equal(event.total_tokens, tokens);
    assert.equal(event.actual_cost_micros, status === 400 ? 0 : 7);
  }
  assert.equal(f.events.length, 5);
});

test("native delivery retains demand and cancellation without draining or inventing terminal usage", async t => {
  const f = await fixture(t); let pulls = 0, canceled;
  const bytes = Buffer.from(line(partial));
  f.reply = () => new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(bytes); }, cancel(reason) { canceled = reason; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/x-ndjson" } });
  const r = await f.call(); assert.equal(r.status, 200); assert.equal(pulls, 0);
  const reader = r.body.getReader(); assert.deepEqual((await reader.read()).value, bytes); assert.equal(pulls, 1);
  await reader.cancel("fixture cancellation"); await f.drain();
  assert.equal(canceled, "fixture cancellation"); assert.equal(pulls, 1); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].status, "client_error"); assert.equal(f.events[0].total_tokens, null); assert.equal(f.events[0].actual_cost_micros, 7);
});

test("unknown price, denied models and invalid native bodies fail before egress", async t => {
  const f = await fixture(t, { fixed: null, models: [`${providerId}/fixture`] });
  assert.equal((await f.call()).status, 400); assert.equal(f.sent.length, 0);
  for (const patch of [{ stream: "true" }, { messages: [] }, { tools: {} }, { think: 2 }, { options: [] }]) {
    const r = await f.call(chatPath, { ...input, ...patch }); assert.equal(r.status, 400); assert.equal((await r.json()).error.code, "invalid_ollama_chat_request");
  }
  assert.equal((await f.call(chatPath, { ...input, model: "hidden" })).status, 403);
  assert.equal((await f.call(chatPath, input, { authorization: "Bearer invalid" })).status, 401);
  assert.equal(f.sent.length, 0); await f.drain();
});

test("native tags preserve permitted metadata on the same grant without inference charges", async t => {
  const f = await fixture(t, { models: [`${providerId}/fixture`] });
  const allowed = { name: "fixture", model: "fixture", size: 42, details: { family: "synthetic" } };
  f.reply = () => Response.json({ models: [{ name: "hidden", model: "hidden" }, allowed] }, { headers: { etag: "obsolete", "cache-control": "public" } });
  for (const path of [tagsPath, `/v1/proxy/${providerId}/tags`]) {
    const r = await f.call(path, null); assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), { models: [allowed] });
    assert.equal(r.headers.get("etag"), null); assert.equal(r.headers.get("cache-control"), "private, no-store");
  }
  await f.drain(); assert.equal(f.events.length, 2);
  assert.ok(f.events.every(e => e.actual_cost_micros === 0 && e.reserved_cost_micros === 0 && e.cost_basis === "none" && e.grant_key === grantKey));
  assert.ok(f.sent.every(r => r.url === "https://native.example/api/tags" && r.method === "GET" && r.headers.get("authorization") === "Bearer synthetic-native-key"));
  assert.equal((await f.call(tagsPath + "?limit=10", null)).status, 400); assert.equal(f.sent.length, 2);
  f.reply = () => Response.json({ models: [{ name: "fixture", model: "hidden" }] });
  assert.equal((await f.call(tagsPath, null)).status, 502); await f.drain();
});

test("native format cannot inherit generic OpenAI usage or treat an empty response as success", async () => {
  for (const body of [null, JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2 }, done: true })]) {
    const observed = observeUsage(new Response(body, { headers: { "content-type": "application/json" } }), undefined, undefined, "ollama.chat");
    await observed.response.text(); assert.deepEqual(await observed.result, { tokens: null, outcome: "provider_error", delivery: "complete" });
  }
});
