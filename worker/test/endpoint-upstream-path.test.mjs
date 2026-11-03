import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
const { default: worker } = await import("../index.ts");
const { snapshot, upstreamPath, configuredUpstream } = await import("../providers.ts");
const { configuredEndpointPath } = await import("../endpoint-path.ts");
const { assertOperationConfiguration } = await import("../provider-auth.ts");
const { authorityCall } = await import("../authority.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const { sha256Hex } = await import("../utils.ts");
const definitions = [
  ["chat", "POST", "/v1/chat/completions", "/openai/v1/chat/completions", "openai.chat_completions", "llm.chat"],
  ["messages", "POST", "/v1/messages", "/anthropic/v1/messages", "anthropic.messages", "llm.messages"],
  ["models", "GET", "/v1/models", "/openai/v1/models", "openai.models", "models.list"],
  ["anthropic_models", "GET", "/anthropic/models", "/anthropic/v1/models", "anthropic.models", "models.list"],
];

async function fixture(t, { pooled = true, models = ["mapped/allowed"] } = {}) {
  const provider = structuredClone(snapshot.providers.find(p => p.id === "openai"));
  Object.assign(provider, { id: "mapped", config_keys: ["PATH_FIXTURE_API_KEY"], optional_config_keys: [],
    base_urls: { default: "https://mapped.example" }, native_prefixes: ["mapped"],
    routing: { nativePrefixes: ["mapped"], modelPrefixes: ["mapped/"], baseUrlParam: null, serviceParam: null },
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: {} },
    models: [{ id: "mapped/allowed", upstream: "allowed", capabilities: ["llm.chat", "llm.messages"], pricing: null, pricing_ref: null }],
    capabilities: definitions.map(([endpoint, method, , , , id]) => ({ id, endpoint, methods: [method] })),
    endpoints: definitions.map(([id, method, path, upstreamPath, format]) => ({ id, method, methods: [method], path, upstreamPath,
      native_proxy: true, auth: null, headers: {}, query: {}, request_headers: [], response_headers: [], path_params: [], path_param_styles: {},
      request_format: format, response_format: format, streaming: null, timeout_ms: 1000 })),
  });
  provider.adapter.injectHeaders = {}; provider.adapter.injectQuery = {}; provider.adapter.passthroughHeaders = [];
  snapshot.providers.push(provider); t.after(() => snapshot.providers.splice(snapshot.providers.indexOf(provider), 1));
  const values = new Map(), pending = [], sent = [], events = [];
  const env = { PATH_FIXTURE_API_KEY: "synthetic-environment-key", POLICY_KV: {
    async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, values.get(k) ?? null])) : values.get(key) ?? null; },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(event) { events.push(event); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: ["mapped"], models, tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "fixture", policy }]);
  await authorityCall(env, "/credentials/initialize-all", [{ credentialId: "fixture", credential: {
    enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: "fixture", policyGeneration: "fixture" } }]);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "mapped", enabled: true }]);
  const grantKey = "oauth/fixture/mapped";
  if (pooled) await putGrantCredentials(env, grantKey, { provider: "mapped", kind: "api_key", enabled: true, credential: "synthetic-original-key" });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = new Request(url, init), body = request.method === "GET" ? null : await request.json();
    sent.push({ request, body });
    if (request.url.includes("/models")) return Response.json(request.url.includes("/anthropic/")
      ? { data: [{ id: "allowed" }, { id: "hidden" }], first_id: "allowed", last_id: "hidden", has_more: false }
      : { object: "list", data: [{ id: "allowed" }, { id: "hidden" }] });
    return Response.json(request.url.includes("/messages")
      ? { type: "message", model: "allowed", content: [{ type: "text", text: "synthetic result" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
      : { choices: [{ message: { role: "assistant", content: "synthetic result" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  const f = { provider, env, grantKey, sent, events,
    call(id, { manifest = false, query = "", path, extra = {} } = {}) {
      const endpoint = provider.endpoints.find(e => e.id === id), body = { model: manifest ? "mapped/allowed" : "allowed", messages: [{ role: "user", content: "synthetic input" }], max_tokens: 16, ...extra };
      const route = path ?? (manifest ? `/v1/proxy/mapped/${id}` : `/v1/native/mapped${endpoint.path}`);
      return worker.fetch(new Request(`https://router.example${route}${query}`, { method: endpoint.method,
        headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json" },
        ...(endpoint.method === "POST" ? { body: JSON.stringify(manifest ? { body } : body) } : {}) }), env, { waitUntil: p => pending.push(p) });
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
  t.after(f.drain, { timeout: 10000 }); return f;
}

for (const pooled of [false, true]) test(`mapped native and manifest routes keep their ${pooled ? "original grant" : "environment credential"}, wire and policy accounting`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { pooled });
  for (const [id, method, path, upstream] of definitions) for (const manifest of [false, true]) {
    const before = f.sent.length, response = await f.call(id, { manifest });
    if (!pooled && method === "GET") {
      assert.equal(response.status, 503, await response.clone().text()); await response.text(); assert.equal(f.sent.length, before); continue;
    }
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json(), sent = f.sent.at(-1);
    assert.equal(sent.request.url, "https://mapped.example" + upstream); assert.equal(sent.request.method, method);
    assert.equal(sent.request.redirect, "manual");
    assert.equal(sent.request.headers.get("authorization"), `Bearer synthetic-${pooled ? "original" : "environment"}-key`);
    assert.equal(f.provider.endpoints.find(e => e.id === id).path, path);
    if (method === "GET") { assert.equal(sent.body, null); assert.deepEqual(body.data, [{ id: "allowed" }]); }
    else assert.deepEqual(sent.body, { model: "allowed", messages: [{ role: "user", content: "synthetic input" }], max_tokens: 16 });
  }
  await f.drain(); assert.equal(f.sent.length, pooled ? 8 : 4);
  const usage = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(usage.length, 8);
  assert.ok(usage.every(e => e.provider === "mapped" && e.actual_cost_micros === (e.capability === "models.list" ? 0 : 7)));
});

test("mapped routes do not become alternate caller paths or query-selected targets", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const options of [{ path: "/v1/native/mapped/openai/v1/chat/completions" }, { query: "?upstreamPath=/other" }, { manifest: true, query: "?url=https://other.example" }]) {
    const response = await f.call("chat", options); assert.ok(response.status >= 400); await response.text();
  }
  const metadata = await f.call("models", { query: "?url=https://other.example" }); assert.equal(metadata.status, 400); await metadata.text();
  assert.equal(f.sent.length, 0);
  const page = await f.call("anthropic_models", { query: "?limit=2&after_id=allowed" }); assert.equal(page.status, 200); await page.text();
  assert.equal(f.sent[0].request.url, "https://mapped.example/anthropic/v1/models?limit=2&after_id=allowed");
});

test("mapped inference retains caller model denial", { timeout: 10000 }, async t => {
  const denied = await fixture(t, { models: ["mapped/other"] });
  const response = await denied.call("chat"); assert.equal(response.status, 403); await response.text(); assert.equal(denied.sent.length, 0);
});

test("mapped dispatch cannot revive a revoked original grant with the environment key", { timeout: 10000 }, async t => {
  const f = await fixture(t); await revokeGrantCredentials(f.env, f.grantKey);
  const response = await f.call("messages"); assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
});

test("invalid configured mappings fail before egress without echoing their value", { timeout: 10000 }, async t => {
  const f = await fixture(t), endpoint = f.provider.endpoints[0];
  for (const path of ["https://other.example/private", "//other.example", "/a/../private", "/a/%2e%2e/private", "/a\\private", "/a?secret=fixture", "/a#fragment", "/${secret}", "/a//b", "/a/", "", null]) {
    endpoint.upstreamPath = path;
    const response = await f.call("chat"); assert.ok(response.status >= 400, String(path));
    assert.equal((await response.text()).includes("other.example/private"), false); assert.equal(f.sent.length, 0);
  }
});

test("trailing CR, LF and CRLF fail preflight, path dispatch and native/manifest requests", { timeout: 10000 }, async t => {
  const f = await fixture(t), endpoint = f.provider.endpoints[0], auth = configuredUpstream(f.provider, null, f.env);
  const original = endpoint.upstreamPath;
  for (const ending of ["\r", "\n", "\r\n"]) {
    endpoint.upstreamPath = original + ending;
    assert.throws(() => configuredEndpointPath(endpoint), /not qualified/);
    assert.throws(() => assertOperationConfiguration({ provider: f.provider, endpoint, mode: "http" }, null, f.env), /not qualified/);
    assert.throws(() => upstreamPath(f.provider, endpoint, {}, f.env, auth), /not qualified/);
    for (const manifest of [false, true]) {
      const response = await f.call("chat", { manifest }); assert.ok(response.status >= 400); await response.text();
      assert.equal(f.sent.length, 0);
    }
    assert.throws(() => configuredEndpointPath({ ...endpoint, upstreamPath: original, path: endpoint.path + ending }), /not qualified/);
  }
});

test("path preflight and dispatch share exact validation while legacy transport paths remain unchanged", { timeout: 10000 }, async t => {
  const f = await fixture(t), endpoint = f.provider.endpoints[0];
  const auth = configuredUpstream(f.provider, null, f.env);
  assert.equal(upstreamPath(f.provider, endpoint, {}, f.env, auth), "/openai/v1/chat/completions");
  assert.equal(configuredEndpointPath(endpoint, endpoint.upstreamPath, "https://mapped.example/prefix"), endpoint.upstreamPath);
  for (const changes of [{ path_params: ["model"] }, { path_param_styles: { model: "segment" } }, { path: "/a/../b" }, { request_format: "openai.responses" }, { response_format: "anthropic.messages" }, { method: "DELETE" }, { websocket: "openai.responses" }, { lifecycle: {} }, { responsesLifecycle: {} }, { requestPricing: {} }, { toolPricing: {} }])
    assert.throws(() => configuredEndpointPath({ ...endpoint, ...changes }), /not qualified/);
  const metadata = f.provider.endpoints.find(e => e.id === "models");
  for (const changes of [{ streaming: "sse" }, { modelPassthrough: {} }]) assert.throws(() => configuredEndpointPath({ ...metadata, ...changes }), /not qualified/);
  for (const base of ["https://mapped.example?next=", "https://mapped.example#fragment", "https://user:fixture@mapped.example", "file:///tmp"])
    assert.throws(() => configuredEndpointPath(endpoint, undefined, base), /not qualified/);
  assert.throws(() => upstreamPath(f.provider, endpoint, {}, f.env, { ...auth, transportPaths: { chat: "/other" } }), /not qualified/);
  const legacy = { ...endpoint }; delete legacy.upstreamPath;
  assert.equal(configuredEndpointPath(legacy, "/existing/qualified/transport"), "/existing/qualified/transport");
  assert.equal(configuredEndpointPath(legacy), endpoint.path);
});
