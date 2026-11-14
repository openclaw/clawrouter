import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { authorityCall } = await import("../authority.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const { sha256Hex } = await import("../utils.ts");
const { overrideHotCacheConfig, HOT_CACHE_DISABLED } = await import("../hot-cache.ts");

const bases = { baseten: "https://inference.baseten.co/v1", arcee: "https://api.arcee.ai/api/v1", novita: "https://api.novita.ai/openai/v1" };
const row = (provider, id) => provider === "arcee" ? { id, name: id, context_length: 1024, max_output_length: 512,
  input_modalities: ["text"], output_modalities: ["text"] } : provider === "novita" ? { id, object: "model", created: 1, context_size: 1024 } : { id };

async function fixture(t, id, { restricted = true, timeout = 10000 } = {}) {
  const original = snapshot.providers, template = structuredClone(original.find(provider => provider.id === "openai"));
  const provider = { ...template, id, config_keys: ["CATALOG_API_KEY"], optional_config_keys: [], base_urls: { default: bases[id] },
    native_prefixes: [id], routing: { nativePrefixes: [id], modelPrefixes: [`${id}/`], baseUrlParam: null, serviceParam: null },
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: {} },
    adapter: { ...template.adapter, injectHeaders: {}, injectQuery: {}, passthroughHeaders: [] },
    capabilities: [{ id: "models.list", endpoint: "models_list", methods: ["GET"] }],
    models: [{ id: `${id}/allowed`, upstream: "allowed", capabilities: [], pricing: null, pricing_ref: null },
      { id: `${id}/stopped`, upstream: "stopped", capabilities: [], pricing: null, pricing_ref: null,
        availability: { version: "clawrouter.model-availability.v1", status: "stopped" } }],
    endpoints: [{ ...template.endpoints.find(endpoint => endpoint.id === "models_list"), id: "models_list", method: "GET", methods: ["GET"],
      path: "/models", path_params: [], query: {}, headers: {}, request_format: `${id}.models`, response_format: `${id}.models`, timeout_ms: timeout, native_proxy: true }],
  };
  snapshot.providers = [...original.filter(provider => provider.id !== id), provider]; t.after(() => { snapshot.providers = original; });
  const values = new Map(), pending = [], sent = [], events = [], responses = [];
  const env = { CATALOG_API_KEY: "synthetic-environment-must-not-replace-grant", POLICY_KV: {
    async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, values.get(k) ?? null])) : values.get(key) ?? null; },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(event) { events.push(event); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env); attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: [id], models: restricted ? [`${id}/allowed`] : null,
    tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: 7, retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "fixture", policy }]);
  await authorityCall(env, "/credentials/initialize-all", [{ credentialId: "fixture", credential: {
    enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: "fixture", policyGeneration: "fixture" } }]);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: id, enabled: true }]);
  const key = `oauth/fixture/${id}`;
  await putGrantCredentials(env, key, { provider: id, kind: "api_key", enabled: true, credential: "synthetic-original-key" });
  const f = { provider, env, policy, key, sent, events,
    reply: () => Response.json({ data: ["allowed", "hidden", "stopped", ...(id === "baseten" ? ["decision-models/foreign"] : [])].map(value => row(id, value)) }),
    async call(manifest = false, query = "", options = {}) {
      const response = await worker.fetch(new Request(`https://router.example${manifest ? `/v1/proxy/${id}/models_list` : `/v1/native/${id}/models`}${query}`,
        { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "x-api-key": "synthetic-caller-key", "x-account": "foreign" }, ...options }),
      env, { waitUntil: promise => pending.push(promise) }); responses.push(response); return response;
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
  t.mock.method(globalThis, "fetch", async (input, init) => { const request = new Request(input, init); sent.push(request); return f.reply(request); });
  t.after(async () => { for (const response of responses) if (!response.bodyUsed) await response.body?.cancel(); await f.drain(); });
  return f;
}

for (const id of Object.keys(bases)) {
  for (const restricted of [false, true]) test(`${id} native and manifest metadata preserve original credentials, units and caller filtering (${restricted})`, { timeout: 10000 }, async t => {
    const f = await fixture(t, id, { restricted });
    for (const manifest of [false, true]) {
      const response = await f.call(manifest), body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(body, { data: (restricted ? ["allowed"] : ["allowed", "hidden"]).map(value => row(id, value)) });
      assert.match(response.headers.get("cache-control"), /private, no-store/);
      assert.equal("pricing" in body.data[0], false); assert.equal("input_token_price_per_m" in body.data[0], false);
    }
    await f.drain(); assert.equal(f.sent.length, 2);
    for (const request of f.sent) {
      assert.equal(request.url, `${bases[id]}/models`); assert.equal(request.method, "GET"); assert.equal(request.body, null);
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key"); assert.equal(request.redirect, "manual");
      assert.equal(request.headers.has("x-api-key"), false); assert.equal(request.headers.has("x-account"), false);
    }
    assert.ok(f.events.length >= 2); assert.ok(f.events.every(event => event.actual_cost_micros === 0 && event.reserved_cost_micros === 0));
  });

  test(`${id} rejects query, destination and static credential substitutions before egress`, { timeout: 10000 }, async t => {
    const f = await fixture(t, id);
    for (const query of ["?page=2", "?url=https://other.example", "?api_key=synthetic", "?model=hidden"]) {
      const response = await f.call(false, query); assert.equal(response.status, 400, await response.text());
    }
    f.provider.base_urls.default = "https://other.example";
    let response = await f.call(); assert.equal(response.status, 503, await response.text());
    f.provider.base_urls.default = bases[id]; f.provider.adapter.injectHeaders.Authorization = "Bearer synthetic-static-substitute";
    response = await f.call(); assert.equal(response.status, 503, await response.text()); assert.equal(f.sent.length, 0);
  });

  test(`${id} original owner revocation defeats warm admission and credential caches without environment fallback`, { timeout: 10000 }, async t => {
    const f = await fixture(t, id); overrideHotCacheConfig({ maxAgeMs: 60000, freshMs: 10000 }); t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
    const warm = await f.call(); assert.equal(warm.status, 200, await warm.clone().text()); await warm.json(); await f.drain();
    await revokeGrantCredentials(f.env, f.key);
    const denied = await f.call(); assert.ok([403, 503].includes(denied.status), await denied.text()); assert.equal(f.sent.length, 1);
  });

  test(`${id} owner loss during final inspection denies fetch rather than refreshing another account`, { timeout: 10000 }, async t => {
    const f = await fixture(t, id), get = f.env.GRANT_CREDENTIALS.get;
    f.env.GRANT_CREDENTIALS.get = key => { const stub = get(key); return { fetch(url, init) {
      return new URL(url).pathname === "/inspect" ? new Response("unavailable", { status: 503 }) : stub.fetch(url, init);
    } }; };
    const response = await f.call(); assert.equal(response.status, 503, await response.text()); assert.equal(f.sent.length, 0);
  });

  test(`${id} bounded complete JSON rejects partial/error/redirect and does not publish upstream diagnostics`, { timeout: 10000 }, async t => {
    const f = await fixture(t, id, { restricted: false });
    for (const reply of [
      () => new Response("synthetic-private-error", { status: 401 }),
      () => new Response(null, { status: 302, headers: { location: "https://other.example" } }),
      () => Response.json({ data: [row(id, "allowed")] }, { status: 206 }),
      () => new Response('{"data":[]}', { headers: { "content-type": "application/json", "content-length": "100" } }),
      () => new Response(" ".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }),
    ]) {
      f.reply = reply; const response = await f.call(), body = await response.text();
      assert.ok([401, 502].includes(response.status), body); assert.doesNotMatch(body, /synthetic-private-error|other\.example/);
    }
    assert.equal(f.sent.length, 5);
  });
}

test("keyed discovery rechecks caller policy after preflight and cancels incomplete metadata on deadline", { timeout: 10000 }, async t => {
  const f = await fixture(t, "baseten", { timeout: 50 }), get = f.env.GRANT_CREDENTIALS.get;
  let revoked = false;
  f.env.GRANT_CREDENTIALS.get = key => { const stub = get(key); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/materialize" && !revoked) {
      revoked = true; await authorityCall(f.env, "/policies/put", { policyId: "fixture", policy: { ...f.policy, enabled: false } });
    }
    return response;
  } }; };
  let response = await f.call(); assert.equal(response.status, 403, await response.text()); assert.equal(f.sent.length, 0);
  await authorityCall(f.env, "/policies/put", { policyId: "fixture", policy: f.policy });
  let canceled = false;
  f.reply = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
  response = await f.call(); assert.equal(response.status, 502, await response.text()); assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});
