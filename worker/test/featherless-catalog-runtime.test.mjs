import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig } = await import("../hot-cache.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const path = "/v1/proxy/featherless/catalog", MiB = 1024 * 1024;
const page = (n, total, data = []) => ({ data, pagination: { current_page: n, per_page: 100, total_items: total, total_pages: Math.ceil(total / 100) }, total });
async function setup(t, { pooled = true, timeout = 10000 } = {}) {
  const original = [...snapshot.providers], template = structuredClone(original.find(p => p.id === "openai"));
  const endpoint = { ...template.endpoints.find(e => e.id === "models_list"), id: "catalog", path: "/models", method: "GET", methods: ["GET"],
    request_format: "featherless.catalog", response_format: "featherless.catalog", native_proxy: false, timeout_ms: timeout,
    path_params: [], path_param_styles: {}, query: {}, headers: { "x-static-private": "synthetic-private" } };
  const f = await fixture(t, { pooled, providerId: "featherless", configure(provider) {
    Object.assign(provider, template, { id: "featherless", config_keys: ["FEATHERLESS_API_KEY"], optional_config_keys: [], base_urls: { default: "https://api.featherless.ai/v1" },
      native_prefixes: ["featherless"], routing: { nativePrefixes: ["featherless"], modelPrefixes: ["featherless/"], baseUrlParam: null, serviceParam: null },
      auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: {} },
      adapter: { ...template.adapter, injectHeaders: { "x-private": "synthetic-static" }, injectQuery: {}, passthroughHeaders: ["x-account"] },
      capabilities: [{ id: "models.list", endpoint: "catalog", methods: ["GET"] }], endpoints: [endpoint],
      models: ["one", "two", "three"].map(upstream => ({ id: `featherless/${upstream}`, upstream, capabilities: [], pricing: null, pricing_ref: null })) });
  } });
  const provider = structuredClone(f.provider); snapshot.providers = snapshot.providers.map(p => p === f.provider ? provider : p); f.provider = provider;
  t.after(() => { snapshot.providers = original; });
  f.env.FEATHERLESS_API_KEY = "synthetic-environment-must-not-replace-owner";
  f.upstream = () => Response.json(page(1, 2, [{ id: "one" }, { id: "two" }]));
  f.catalog = (options = {}) => f.call(path, null, options);
  f.disable = () => putGrantCredentials(f.env, grantKey, { provider: "featherless", kind: "api_key", enabled: false, credential: "synthetic-original-key" });
  t.after(f.drain); return f;
}

test("real keyed catalog follows short and empty pages, preserves facts and emits one metadata receipt", async t => {
  const f = await setup(t);
  f.upstream = request => { const n = Number(new URL(request.url).searchParams.get("page"));
    assert.equal(bodyBudgetCharged(), 96 * MiB);
    return Response.json(page(n, 300, n === 2 ? [] : [{ id: n === 1 ? "one" : "two", ...(n === 1 ? { pricing: { prompt: "0.2" }, context_length: 8192 } : {}) }])); };
  const response = await f.catalog({ headers: { "x-account": "foreign", "x-organization-id": "foreign" } });
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.deepEqual(await response.json(), { providerId: "featherless", catalog: [{ id: "one", context_length: 8192, pricing: { prompt: "0.2" } }, { id: "two" }] });
  assert.equal(f.sent.length, 3);
  for (const [i, request] of f.sent.entries()) {
    assert.equal(request.url, `https://api.featherless.ai/v1/models?capabilities=chat&page=${i + 1}&per_page=100`);
    assert.equal(request.method, "GET"); assert.equal(request.body, null); assert.equal(request.redirect, "error"); assert.equal(request.credentials, "omit");
    assert.deepEqual([...request.headers], [["accept", "application/json"], ["authorization", "Bearer synthetic-original-key"]]);
  }
  await f.drain(); assert.equal(bodyBudgetCharged(), 0);
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 0); assert.equal(events[0].grant_key, grantKey); assert.equal(events[0].model, null);
});

test("catalog discovery is manifest-only and environment configuration is not owner authority", async t => {
  const f = await setup(t), response = await f.call("/v1/catalog", null), body = await response.json();
  const provider = body.providers.find(p => p.id === "featherless"), offers = provider.offers.filter(o => o.endpoint === "catalog");
  assert.ok(offers.length); assert.ok(offers.every(o => o.routeKind === "manifest" && o.route === path && o.eligible));
  assert.equal(provider.routes[0].requestFormat, "featherless.catalog"); assert.equal(f.sent.length, 0);
  const native = await f.call("/v1/native/featherless/models", null); assert.equal(native.status, 404); await native.text();
});

for (const nativeFlag of [false, true]) test(`native aggregate refusal is independent of malformed native flag ${nativeFlag}`, async t => {
  const f = await setup(t); f.provider.endpoints[0].native_proxy = nativeFlag;
  const response = await f.call("/v1/native/featherless/models", null); assert.equal(response.status, 404); await response.text(); assert.equal(f.sent.length, 0);
});

for (const override of [{}, { method: "GET" }, { body: {} }, { query: { page: 2 } }, { headers: { authorization: "foreign" } }]) test(`POST envelopes never become a keyed catalog ${JSON.stringify(override)}`, async t => {
  const f = await setup(t), response = await f.call(path, override); assert.equal(response.status, 400); await response.text(); assert.equal(f.sent.length, 0);
});
for (const query of ["?page=2", "?url=https://other.example", "?model=one", "?capabilities=chat"]) test(`catalog caller query denied ${query}`, async t => {
  const f = await setup(t), response = await f.call(path + query, null); assert.equal(response.status, 400); await response.text(); assert.equal(f.sent.length, 0);
});

test("environment alone cannot authorize a keyed scan", async t => {
  const f = await setup(t, { pooled: false }), response = await f.catalog(); assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
});

for (const mutation of ["disabled", "rotated", "account", "policy", "caller", "grant-list"]) test(`original ${mutation} after page one denies continuation without cached owner or alternate fallback`, async t => {
  const f = await setup(t); overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 });
  f.upstream = async () => {
    if (mutation === "disabled") await f.disable();
    if (mutation === "rotated" || mutation === "account") await putGrantCredentials(f.env, grantKey, { provider: "featherless", kind: "api_key", enabled: true,
      credential: mutation === "rotated" ? "synthetic-new-key" : "synthetic-original-key", ...(mutation === "account" ? { accountId: "other-account" } : {}) });
    if (mutation === "policy") { f.policy.enabled = false; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
    if (mutation === "caller") { await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "revoke", credentialId: "fixture" }); }
    if (mutation === "grant-list") { f.policy.grantRouting = { eligibleGrants: { featherless: [] }, environmentFallback: false }; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
    return Response.json(page(1, 200, [{ id: "one" }]));
  };
  const response = await f.catalog(); assert.ok(response.status >= 400); assert.doesNotMatch(await response.text(), /synthetic-original-key|synthetic-new-key|"catalog"/);
  assert.equal(f.sent.length, 1); await f.drain(); assert.equal(bodyBudgetCharged(), 0);
});

test("after-parse current policy filters earlier pages without widening original permitted IDs", async t => {
  const f = await setup(t); f.policy.models = ["featherless/one", "featherless/two"]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = request => {
    const n = Number(new URL(request.url).searchParams.get("page")), bytes = new TextEncoder().encode(JSON.stringify(page(n, 200, [{ id: n === 1 ? "one" : "two" }, ...(n === 2 ? [{ id: "three" }] : [])]))); let sent = false;
    return new Response(new ReadableStream({ async pull(controller) {
      if (!sent) { sent = true; controller.enqueue(bytes); return; }
      if (n === 2) { f.policy.models = ["featherless/two", "featherless/three"]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
      controller.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  };
  const response = await f.catalog(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { providerId: "featherless", catalog: [{ id: "two" }] }); assert.equal(f.sent.length, 2);
});

test("fresh empty scan is authoritative after prior rows", async t => {
  const f = await setup(t), first = await f.catalog(); assert.equal((await first.json()).catalog.length, 2); await f.drain();
  f.upstream = () => Response.json(page(1, 0)); const empty = await f.catalog(); assert.deepEqual(await empty.json(), { providerId: "featherless", catalog: [] }); assert.equal(f.sent.length, 2);
});

for (const invalid of ["duplicate", "totals", "malformed", "unauthorized", "redirect", "partial"]) test(`invalid second page ${invalid} cannot publish earlier rows or retry`, async t => {
  const f = await setup(t);
  f.upstream = request => {
    const n = Number(new URL(request.url).searchParams.get("page")); if (n === 1) return Response.json(page(1, 200, [{ id: "one" }]));
    if (invalid === "unauthorized") return new Response("synthetic-sensitive", { status: 401 });
    if (invalid === "redirect") return new Response(null, { status: 302, headers: { location: "https://other.example" } });
    if (invalid === "partial") return new Response('{"data":', { headers: { "content-type": "application/json" } });
    return Response.json(invalid === "malformed" ? { data: [] } : page(2, invalid === "totals" ? 300 : 200, [{ id: invalid === "duplicate" ? "one" : "two" }]));
  };
  const response = await f.catalog(); assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /synthetic-sensitive|"catalog"/); assert.equal(f.sent.length, 2); await f.drain(); assert.equal(bodyBudgetCharged(), 0);
});

for (const mutation of ["origin", "pair", "auth", "query", "upstream-path", "static-auth", "native", "path"]) test(`configured ${mutation} substitution denies egress`, async t => {
  const f = await setup(t), endpoint = f.provider.endpoints[0];
  if (mutation === "origin") f.provider.base_urls.default = "https://other.example/v1";
  if (mutation === "pair") endpoint.response_format = "openai.models";
  if (mutation === "auth") endpoint.auth = "none";
  if (mutation === "query") endpoint.query = { page: "2" };
  if (mutation === "upstream-path") endpoint.upstreamPath = "/other/models";
  if (mutation === "static-auth") f.provider.adapter.injectHeaders = { Authorization: "Bearer synthetic-foreign" };
  if (mutation === "native") endpoint.native_proxy = true;
  if (mutation === "path") endpoint.path = "/other";
  const response = await f.catalog(); assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
});

test("capacity refusal is zero-egress and releases no other request's lease", async t => {
  const f = await setup(t), held = new BodyLease(); assert.equal(held.grow(MiB), true); t.after(() => held.release());
  const response = await f.catalog(); assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "server_overloaded");
  assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 2 * MiB);
  held.release(); const next = await f.catalog(); assert.equal(next.status, 200); await next.json(); await f.drain(); assert.equal(bodyBudgetCharged(), 0);
});

test("capacity survives serialization until consumed and cancellation releases it", async t => {
  const f = await setup(t), response = await f.catalog(); assert.equal(response.status, 200); assert.equal(bodyBudgetCharged(), 96 * MiB);
  await response.body.cancel(); await f.drain(); assert.equal(bodyBudgetCharged(), 0);
});

test("caller cancellation reaches the original physical fetch and stops pagination", async t => {
  const f = await setup(t), controller = new AbortController(); let signal;
  f.upstream = request => new Promise((resolve, reject) => { signal = request.signal; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); controller.abort(); });
  const response = await f.catalog({ signal: controller.signal }); assert.ok(response.status >= 400); await response.text(); assert.equal(signal.aborted, true); assert.equal(f.sent.length, 1);
  await f.drain(); assert.equal(bodyBudgetCharged(), 0);
});
