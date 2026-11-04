import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig } = await import("../hot-cache.ts");
const { bodyBudgetCharged, BodyLease } = await import("../body-budget.ts");
const capacity = 32 * 1024 * 1024;
const rows = [
  { id: " allowed ", api: "chat", input_price: "0.007", output_price: 0, cached_price: "0", caching_price: "2e-7", supports_vision: false },
  { id: "allowed", api: "chat", context_window: 999 },
  { id: "hidden", api: "chat" }, { id: "allowed@eu", api: "chat" }, { id: "embedding", api: "embeddings" },
];
const expected = { data: [{ ...rows[0], id: "allowed" }, rows[2]] };

async function setup(t) {
  const source = structuredClone(snapshot.providers.find(provider => provider.id === "openai"));
  const f = await fixture(t, { providerId: "requesty", pooled: true, configure(provider) {
    Object.assign(provider, source, { id: "requesty", config_keys: ["REQUESTY_API_KEY"], optional_config_keys: [],
      native_prefixes: ["requesty"], base_urls: { default: "https://router.requesty.ai/v1" },
      routing: { nativePrefixes: ["requesty"], modelPrefixes: ["requesty/"], baseUrlParam: null, serviceParam: null },
      auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: {} },
      models: ["allowed", "hidden"].map(upstream => ({ id: "requesty/" + upstream, upstream, capabilities: [], pricing: null, pricing_ref: null })),
      endpoints: [{ ...source.endpoints.find(endpoint => endpoint.id === "models_list"), id: "models_managed", path: "/models/managed",
        request_format: "requesty.models_managed", response_format: "requesty.models_managed", path_params: [], path_param_styles: {}, headers: {}, query: {} }],
      capabilities: [{ id: "models.list", endpoint: "models_managed", methods: ["GET"] }],
    });
    provider.adapter.injectHeaders = {}; provider.adapter.passthroughHeaders = [];
  } });
  f.env.REQUESTY_API_KEY = "synthetic-environment-key";
  f.policy.grantRouting = { eligibleGrants: { requesty: ["replicate"] }, environmentFallback: true, failover: true };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = () => Response.json({ data: rows });
  f.route = manifest => manifest ? "/v1/proxy/requesty/models_managed" : "/v1/native/requesty/models/managed";
  f.request = (manifest = false, init = {}) => f.call(f.route(manifest), null, init);
  f.replace = extra => putGrantCredentials(f.env, grantKey, { provider: "requesty", kind: "api_key", enabled: true, credential: "synthetic-original-key", ...extra });
  f.policyUpdate = async extra => { Object.assign(f.policy, extra); await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); };
  overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 });
  return f;
}
async function consume(f, response) {
  const body = await response.json(); await f.drain(); assert.equal(bodyBudgetCharged(), 0); return body;
}
async function changeAuthority(f, change) {
  if (change === "revoke") await revokeGrantCredentials(f.env, grantKey);
  if (change === "rotate") await f.replace({ credential: "synthetic-new-key" });
  if (change === "policy") await f.policyUpdate({ enabled: false });
  if (change === "caller") await f.authority("/credentials/mutate", { credentialId: "fixture", operation: "revoke", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "fixture@example.com" } });
  if (change === "routing") await f.policyUpdate({ grantRouting: { eligibleGrants: { requesty: [] }, environmentFallback: true, failover: true } });
  if (change === "destination") f.provider.base_urls.default = "https://other.example/v1";
}

for (const manifest of [false, true]) {
  test(`Requesty ${manifest ? "manifest" : "native"} preserves native observations under the original managed key`, async t => {
    const f = await setup(t);
    f.provider.adapter.injectHeaders["x-account"] = "synthetic-static-account";
    f.provider.adapter.passthroughHeaders = ["x-private"];
    f.upstream = request => {
      assert.equal(bodyBudgetCharged(), capacity); assert.equal(request.url, "https://router.requesty.ai/v1/models/managed");
      assert.equal(request.method, "GET"); assert.equal(request.body, null); assert.equal(request.redirect, "manual");
      assert.deepEqual([...request.headers], [["accept", "application/json"], ["authorization", "Bearer synthetic-original-key"]]);
      assert.ok(request.signal instanceof AbortSignal); return Response.json({ data: rows });
    };
    const response = await f.request(manifest, { headers: { "x-api-key": "synthetic-caller-key", "x-private": "synthetic-caller-value" } });
    assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await consume(f, response), expected); assert.equal(f.sent.length, 1);
    const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 0);
    assert.equal(events[0].cost_basis, "none"); assert.equal(events[0].grant_key, grantKey);
  });

  for (const change of ["revoke", "rotate", "policy", "caller", "routing", "destination"]) {
    test(`Requesty ${manifest ? "manifest" : "native"} warm ${change} during final authority wait denies before fetch`, async t => {
      const f = await setup(t); await consume(f, await f.request(manifest));
      const policyChange = ["policy", "caller", "routing"].includes(change);
      const binding = policyChange ? "ACCESS_CONTROL" : "GRANT_CREDENTIALS", namespace = f.env[binding]; let armed = true, checked = false;
      f.env[binding] = { ...namespace, get(name) { const owner = namespace.get(name); return { async fetch(url, init) {
        if (new URL(url).pathname === (policyChange ? "/authorization/snapshot" : "/inspect") && armed) {
          armed = false; checked = true; await changeAuthority(f, change);
        }
        return owner.fetch(url, init);
      } }; } };
      const response = await f.request(manifest); assert.ok(response.status >= 400, await response.clone().text());
      await consume(f, response); assert.equal(checked, true); assert.equal(f.sent.length, 1);
    });
    test(`Requesty ${manifest ? "manifest" : "native"} ${change} during metadata parse prevents publication`, async t => {
      const f = await setup(t); await consume(f, await f.request(manifest)); let consumed = false;
      f.upstream = () => new Response(new ReadableStream({ async pull(controller) {
        assert.equal(bodyBudgetCharged(), capacity); consumed = true; await changeAuthority(f, change);
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: rows }))); controller.close();
      } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
      const response = await f.request(manifest); assert.ok(response.status >= 400); assert.equal(consumed, true);
      assert.doesNotMatch(JSON.stringify(await consume(f, response)), /"hidden"|synthetic-original-key/); assert.equal(f.sent.length, 2);
    });
  }

  for (const models of [["requesty/allowed"], []]) test(`Requesty ${manifest ? "manifest" : "native"} final policy publishes authoritative ${models.length ? "filtered rows" : "empty data"}`, async t => {
    const f = await setup(t); await consume(f, await f.request(manifest));
    f.upstream = async () => { await f.policyUpdate({ models }); return Response.json({ data: rows }); };
    const response = await f.request(manifest); assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await consume(f, response), { data: models.length ? [expected.data[0]] : [] });
  });
}

test("Requesty policy broadening never widens the admitted inventory", async t => {
  const f = await setup(t); await f.policyUpdate({ models: ["requesty/allowed"] });
  f.upstream = async () => { await f.policyUpdate({ models: null }); return Response.json({ data: rows }); };
  assert.deepEqual(await consume(f, await f.request()), { data: [expected.data[0]] });
});

test("Requesty uses an original owner API-key bundle without environment substitution", async t => {
  const f = await setup(t); await f.replace({ credential: undefined, credentials: { API_KEY: "synthetic-bundle-key" } });
  f.upstream = request => { assert.equal(request.headers.get("authorization"), "Bearer synthetic-bundle-key"); return Response.json({ data: [] }); };
  assert.deepEqual(await consume(f, await f.request()), { data: [] }); assert.equal(f.sent.length, 1);
});

for (const source of ["revoked", "oauth", "foreign"]) test(`Requesty rejects ${source} owner without borrowing environment credentials`, async t => {
  const f = await setup(t);
  if (source === "revoked") await revokeGrantCredentials(f.env, grantKey);
  if (source === "oauth") await f.replace({ kind: "oauth", accessToken: "synthetic-oauth-key" });
  if (source === "foreign") await f.replace({ provider: "openai" });
  const response = await f.request(); assert.equal(response.status, 503, await response.clone().text()); await consume(f, response); assert.equal(f.sent.length, 0);
});

test("Requesty denies query, caller body and static credential overrides before egress", async t => {
  const f = await setup(t);
  for (const manifest of [false, true]) for (const suffix of ["?limit=1", "?page=1", "?after_id=allowed", "?url=https://other.example", "?api_key=synthetic-key"]) {
    const response = await f.call(f.route(manifest) + suffix, null); assert.equal(response.status, 400); await consume(f, response);
  }
  const body = await f.call(f.route(true), { body: { model: "allowed" } }); assert.equal(body.status, 400); await consume(f, body);
  f.provider.adapter.injectHeaders.Authorization = "Bearer synthetic-static-key";
  const response = await f.request(); assert.equal(response.status, 503); await consume(f, response); assert.equal(f.sent.length, 0);
});

for (const configuration of ["base", "path", "query", "mappedPath", "format"]) test(`Requesty rejects unqualified ${configuration} before physical fetch`, async t => {
  const f = await setup(t), endpoint = f.provider.endpoints[0];
  if (configuration === "base") f.provider.base_urls.default = "https://other.example/v1";
  if (configuration === "path") endpoint.path = "/models";
  if (configuration === "query") endpoint.query = { page: "1" };
  if (configuration === "mappedPath") endpoint.upstreamPath = "/models/managed";
  if (configuration === "format") endpoint.response_format = "openai.models";
  const response = await f.request(true); assert.ok(response.status >= 400); await consume(f, response); assert.equal(f.sent.length, 0);
});

for (const failure of ["redirect", "non200", "openaiEnvelope", "invalidJson", "invalidUtf8", "rows", "bytes", "length", "emptyChunks"]) test(`Requesty ${failure} rejects atomically without alternate or anonymous fetch`, async t => {
  const f = await setup(t); let reads = 0, canceled = false;
  f.upstream = () => {
    if (failure === "redirect") return new Response(null, { status: 302, headers: { location: "https://other.example" } });
    if (failure === "non200") return Response.json({ error: "synthetic metadata rejection" }, { status: 429 });
    if (failure === "openaiEnvelope") return Response.json({ object: "list", data: [] });
    if (failure === "invalidJson") return new Response('{"data":', { headers: { "content-type": "application/json" } });
    if (failure === "invalidUtf8") return new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } });
    if (failure === "rows") return Response.json({ data: Array.from({ length: 4097 }, () => rows[0]) });
    if (failure === "length") return new Response('{"data":[]}', { headers: { "content-type": "application/json", "content-length": "100" } });
    return new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(failure === "bytes" ? 2 * 1024 * 1024 + 1 : 0)); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  };
  const response = await f.request(); assert.equal(response.status, 502, await response.clone().text()); assert.equal(response.headers.has("location"), false);
  const result = await consume(f, response); assert.doesNotMatch(JSON.stringify(result), /synthetic metadata rejection|synthetic-original-key/);
  assert.equal(f.sent.length, 1); assert.equal((await f.events())[0].actual_cost_micros, 0);
  if (["bytes", "emptyChunks"].includes(failure)) { assert.equal(canceled, true); assert.ok(reads <= 8194); }
});

test("Requesty capacity refusal is known unsent and EOF releases the reservation", async t => {
  const f = await setup(t), held = new BodyLease(); assert.ok(held.grow(40 * 1024 * 1024));
  try { const response = await f.request(); assert.equal(response.status, 503); await response.text(); assert.equal(f.sent.length, 0); }
  finally { held.release(); }
  await consume(f, await f.request()); assert.equal(f.sent.length, 1);
});

for (const failure of ["abort", "deadline"]) test(`Requesty ${failure} cancels the physical pending reader and releases capacity`, { timeout: 5000 }, async t => {
  const f = await setup(t); if (failure === "deadline") f.provider.endpoints[0].timeout_ms = 25;
  const controller = new AbortController(); let canceled = false, pulled; const reached = new Promise(resolve => { pulled = resolve; });
  f.upstream = () => new Response(new ReadableStream({ pull() { assert.equal(bodyBudgetCharged(), capacity); pulled(); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const pending = f.request(false, { signal: controller.signal }); await reached; if (failure === "abort") controller.abort();
  const response = await pending; assert.equal(response.status, 502); await consume(f, response); assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});
