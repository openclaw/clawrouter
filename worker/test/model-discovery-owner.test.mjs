import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig } = await import("../hot-cache.ts");
const { bodyBudgetCharged, BodyLease } = await import("../body-budget.ts");
const id = "catalog-fixture", capacity = 32 * 1024 * 1024;
const catalog = { object: "list", data: [{ id: "allowed", object: "model" }, { id: "hidden", object: "model" }] };

async function setup(t) {
  const source = structuredClone(snapshot.providers.find(provider => provider.id === "openai"));
  const f = await fixture(t, { providerId: id, pooled: true, configure(provider) {
    Object.assign(provider, source, { id, native_prefixes: [id], base_urls: { default: "https://catalog.example/v1" },
      routing: { nativePrefixes: [id], modelPrefixes: [id + "/"], baseUrlParam: null, serviceParam: null },
      auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: {} },
      models: ["allowed", "hidden"].map(upstream => ({ id: id + "/" + upstream, upstream, capabilities: [], pricing: null, pricing_ref: null })),
      endpoints: source.endpoints.filter(endpoint => endpoint.id === "models_list"),
      capabilities: [{ id: "models.list", endpoint: "models_list", methods: ["GET"] }],
    });
    provider.adapter.injectHeaders = {}; provider.adapter.passthroughHeaders = [];
    provider.endpoints[0].path = "/models";
  } });
  f.env.CATALOG_FIXTURE_API_KEY = "synthetic-environment-key";
  f.policy.grantRouting = { eligibleGrants: { [id]: ["replicate"] }, environmentFallback: true, failover: true };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = () => Response.json(catalog);
  f.request = (manifest = false, init = {}) => f.call(manifest ? `/v1/proxy/${id}/models_list` : `/v1/native/${id}/models`, null, init);
  f.replace = extra => putGrantCredentials(f.env, grantKey, { provider: id, kind: "api_key", enabled: true, credential: "synthetic-original-key", ...extra });
  f.policyUpdate = async extra => { Object.assign(f.policy, extra); await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); };
  overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 });
  return f;
}
async function consume(f, response) { const body = await response.json(); await f.drain(); assert.equal(bodyBudgetCharged(), 0); return body; }

for (const manifest of [false, true]) {
  test(`generic ${manifest ? "manifest" : "native"} catalog pins original key, destination, bodyless request and unknown facts`, async t => {
    const f = await setup(t);
    f.upstream = request => {
      assert.equal(bodyBudgetCharged(), capacity); assert.equal(request.url, "https://catalog.example/v1/models");
      assert.equal(request.method, "GET"); assert.equal(request.body, null); assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key"); assert.equal(request.headers.has("x-api-key"), false);
      assert.ok(request.signal instanceof AbortSignal); return Response.json(catalog);
    };
    const response = await f.request(manifest, { headers: { "x-api-key": "synthetic-caller-key" } });
    assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await consume(f, response), catalog);
    assert.equal(f.sent.length, 1); const events = await f.events(); assert.equal(events.length, 1);
    assert.equal(events[0].actual_cost_micros, 0); assert.equal(events[0].cost_basis, "none"); assert.equal(events[0].grant_key, grantKey);
  });

  for (const change of ["revoke", "rotate", "policy", "caller", "routing", "destination"]) test(`generic ${manifest ? "manifest" : "native"} warm catalog ${change} during final owner wait denies before fetch`, async t => {
    const f = await setup(t); await consume(f, await f.request(manifest));
    const policyChange = ["policy", "caller", "routing"].includes(change);
    const binding = policyChange ? "ACCESS_CONTROL" : "GRANT_CREDENTIALS", namespace = f.env[binding]; let armed = true, checked = false;
    f.env[binding] = { ...namespace, get(name) { const owner = namespace.get(name); return { async fetch(url, init) {
      if (new URL(url).pathname === (policyChange ? "/authorization/snapshot" : "/inspect") && armed) {
        armed = false; checked = true;
        if (change === "revoke") await revokeGrantCredentials(f.env, grantKey);
        if (change === "rotate") await f.replace({ credential: "synthetic-new-key" });
        if (change === "policy") await f.policyUpdate({ enabled: false });
        if (change === "caller") await f.authority("/credentials/mutate", { credentialId: "fixture", operation: "revoke", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "fixture@example.com" } });
        if (change === "routing") await f.policyUpdate({ grantRouting: { eligibleGrants: { [id]: [] }, environmentFallback: true, failover: true } });
        if (change === "destination") f.provider.base_urls.default = "https://other.example/v1";
      }
      return owner.fetch(url, init);
    } }; } };
    const response = await f.request(manifest);
    assert.ok(response.status >= 400, await response.clone().text()); await consume(f, response);
    assert.equal(checked, true); assert.equal(f.sent.length, 1); assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
  });

  for (const change of ["revoke", "rotate", "policy", "caller", "routing"]) test(`generic ${manifest ? "manifest" : "native"} ${change} while reading metadata prevents publication`, async t => {
    const f = await setup(t); await consume(f, await f.request(manifest)); let consumed = false;
    f.upstream = () => new Response(new ReadableStream({ async pull(controller) {
      assert.equal(bodyBudgetCharged(), capacity); consumed = true;
      if (change === "revoke") await revokeGrantCredentials(f.env, grantKey);
      if (change === "rotate") await f.replace({ credential: "synthetic-new-key" });
      if (change === "policy") await f.policyUpdate({ enabled: false });
      if (change === "caller") await f.authority("/credentials/mutate", { credentialId: "fixture", operation: "revoke", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "fixture@example.com" } });
      if (change === "routing") await f.policyUpdate({ grantRouting: { eligibleGrants: { [id]: [] }, environmentFallback: true } });
      controller.enqueue(new TextEncoder().encode(JSON.stringify(catalog))); controller.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    const response = await f.request(manifest); assert.ok(response.status >= 400); assert.equal(consumed, true);
    const result = await consume(f, response); assert.doesNotMatch(JSON.stringify(result), /"hidden"|synthetic-original-key/); assert.equal(f.sent.length, 2);
  });

  for (const models of [[`${id}/allowed`], []]) test(`generic ${manifest ? "manifest" : "native"} final policy intersects complete metadata (${models.length})`, async t => {
    const f = await setup(t); await consume(f, await f.request(manifest));
    f.upstream = async () => { await f.policyUpdate({ models }); return Response.json(catalog); };
    const response = await f.request(manifest); assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await consume(f, response), { object: "list", data: models.length ? [catalog.data[0]] : [] });
  });
}

test("catalog policy broadening cannot widen the originally admitted inventory", async t => {
  const f = await setup(t); await f.policyUpdate({ models: [`${id}/allowed`] });
  f.upstream = async () => { await f.policyUpdate({ models: null }); return Response.json(catalog); };
  assert.deepEqual(await consume(f, await f.request()), { object: "list", data: [catalog.data[0]] });
});

test("catalog rejects caller pagination, bodies, credential and destination overrides before fetch", async t => {
  const f = await setup(t);
  for (const suffix of ["?limit=1", "?page=1", "?after_id=allowed", "?url=https://other.example", "?api_key=synthetic-caller-key"]) {
    const response = await f.call(`/v1/proxy/${id}/models_list${suffix}`, null); assert.equal(response.status, 400); await consume(f, response);
  }
  const response = await f.call(`/v1/proxy/${id}/models_list`, { body: { model: "allowed" } }); assert.equal(response.status, 400); await consume(f, response);
  f.provider.adapter.injectHeaders.Authorization = "Bearer synthetic-static-key";
  assert.equal((await f.request()).status, 503); assert.equal(f.sent.length, 0); await f.drain();
});

test("catalog missing original owner never borrows an available environment key", async t => {
  const f = await setup(t); await revokeGrantCredentials(f.env, grantKey);
  const response = await f.request(); assert.equal(response.status, 503); await consume(f, response); assert.equal(f.sent.length, 0);
});

test("catalog capacity refuses before physical fetch and releases at complete producer EOF", async t => {
  const f = await setup(t), held = new BodyLease(); assert.ok(held.grow(40 * 1024 * 1024));
  try { const response = await f.request(); assert.equal(response.status, 503); await response.text(); assert.equal(f.sent.length, 0); }
  finally { held.release(); }
  await consume(f, await f.request()); assert.equal(f.sent.length, 1);
});

for (const failure of ["abort", "timeout", "overflow"]) test(`catalog ${failure} cancels the original physical reader and releases capacity`, { timeout: 5000 }, async t => {
  const f = await setup(t); if (failure === "timeout") f.provider.endpoints[0].timeout_ms = 20;
  const controller = new AbortController(); let cancel = false, pulled; const reached = new Promise(resolve => { pulled = resolve; });
  f.upstream = () => new Response(new ReadableStream({ pull(stream) { assert.equal(bodyBudgetCharged(), capacity); pulled(); if (failure === "overflow") stream.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { cancel = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const pending = f.request(false, { signal: controller.signal }); await reached; if (failure === "abort") controller.abort();
  const response = await pending; assert.ok(response.status >= 400); await consume(f, response);
  assert.equal(cancel, true); assert.equal(f.sent.length, 1); assert.equal((await f.events())[0].actual_cost_micros, 0);
});


test("catalog bounds even empty chunks before retaining unbounded metadata objects", async t => {
  const f = await setup(t); let reads = 0, canceled = false;
  f.upstream = () => new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array()); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const response = await f.request(); assert.equal(response.status, 502); await consume(f, response);
  assert.equal(reads, 8192); assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});
