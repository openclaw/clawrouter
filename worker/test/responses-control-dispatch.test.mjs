import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { materializeGrantCredentials, putGrantCredentials, revokeGrantCredentials } from "../grant-credentials.ts";
const { snapshot, configuredUpstream, copyRequestHeaders, upstreamPath } = await import("../providers.ts");
const { responseRouteDigest, dispatchResponseControl } = await import("../responses-control-dispatch.ts");

async function fixture(t, oauth = false) {
  let now = Date.parse("2026-09-25T00:00:00Z"); t.mock.method(Date, "now", () => now);
  const template = snapshot.providers.find(provider => provider.id === "openai");
  const create = { ...structuredClone(template.endpoints.find(endpoint => endpoint.id === "responses")), id: "begin", responsesLifecycle: { retrieve: "inspect", cancel: "stop" } };
  const control = (id, method, path) => ({ ...create, id, method, methods: [method], path, path_params: ["response_id"], path_param_styles: { response_id: "opaque_segment" }, responsesLifecycle: undefined, websocket: undefined, modelPassthrough: undefined, request_headers: [] });
  const provider = { ...structuredClone(template), id: "background-fixture", base_urls: { default: "https://responses.example" }, endpoints: [create, control("inspect", "GET", "/v1/responses/${response_id}"), control("stop", "POST", "/v1/responses/${response_id}/cancel")], auth: { ...structuredClone(template.auth), grantTransports: {} } };
  snapshot.providers.push(provider); t.after(() => snapshot.providers.splice(snapshot.providers.indexOf(provider), 1));
  const values = new Map(), kv = { reads: 0 };
  const env = attachGrantCredentialNamespace({ POLICY_KV: {
    async get(key, type) { kv.reads++; const value = values.get(key); return value === undefined ? null : type === "text" ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  } });
  await env.grantAuthority.fetch("https://authority/connections/initialize-all", { method: "POST", body: JSON.stringify([{ providerId: provider.id, enabled: true }]) });
  const key = "oauth/policy/background-fixture";
  const metadata = await putGrantCredentials(env, key, { provider: provider.id, kind: oauth ? "oauth" : "api_key", enabled: true, ...(oauth ? { accessToken: "fixture-secret", refreshToken: "refresh-fixture", refresh: { tokenUrl: "https://refresh.example/token" } } : { credential: "fixture-secret" }), expiresAt: new Date(now + 600_000).toISOString() });
  const grant = await materializeGrantCredentials(env, key, metadata, provider.id, null, false);
  const incoming = new Headers({ "openai-organization": "org-fixture", "openai-project": "project-fixture" });
  const upstream = configuredUpstream(provider, grant, env), headers = new Headers(upstream.headers);
  copyRequestHeaders(incoming, provider, create, headers, env);
  const url = new URL(`${upstream.baseUrl}${upstreamPath(provider, create, {}, env, upstream)}`);
  const input = { owner: { providerId: provider.id, endpointId: create.id, grantKey: key, lineage: grant.credentialLineage, routeSha256: await responseRouteDigest(provider, upstream, url, headers, key), policyGeneration: "g1" }, route: { pathParams: {}, organization: "org-fixture", project: "project-fixture" }, responseId: "response/fixture", action: "retrieve", query: "include%5B%5D=one&include%5B%5D=two", stream: true };
  kv.reads = 0;
  const calls = [], fetchGate = { response: () => Response.json({ id: "response/fixture", object: "response", status: "queued" }) };
  t.mock.method(globalThis, "fetch", async (request, init) => { calls.push({ request, init }); return fetchGate.response(request); });
  return { env, provider, metadata, key, input, calls, kv, fetchGate, advance(ms) { now += ms; }, dispatch(signal = new AbortController().signal, override = {}) { return dispatchResponseControl(env, { ...input, ...override }, signal); },
    gateConnection() {
      const entered = Promise.withResolvers(), release = Promise.withResolvers(), get = env.ACCESS_CONTROL.get;
      env.ACCESS_CONTROL.get = name => ({ fetch: async (url, init) => { if (new URL(url).pathname === "/connections/resolve") { entered.resolve(); await release.promise; } return get(name).fetch(url, init); } });
      return { entered: entered.promise, release: () => release.resolve() };
    },
  };
}

test("closed owner dispatch preserves the create pin, repeated query and bodyless cancel without legacy reads", async t => {
  const f = await fixture(t);
  assert.equal((await f.dispatch()).status, 200);
  const first = f.calls[0].request;
  assert.equal(first.url, "https://responses.example/v1/responses/response%2Ffixture?include%5B%5D=one&include%5B%5D=two");
  assert.equal(first.headers.get("authorization"), "Bearer fixture-secret");
  assert.equal(first.headers.get("openai-organization"), "org-fixture"); assert.equal(first.headers.get("openai-project"), "project-fixture");
  assert.equal(first.method, "GET"); assert.equal(first.body, null); assert.equal(first.redirect, "manual");
  assert.equal((await f.dispatch(undefined, { action: "cancel", query: "" })).status, 200);
  assert.equal(f.calls[1].request.method, "POST"); assert.equal(f.calls[1].request.body, null);
  assert.equal(f.kv.reads, 0, "new jobs poll canonical owner state without importing KV");
});

for (const mutation of ["revoke", "replace", "disable", "reauth_required", "expired"]) test(`${mutation} committed before the next control prevents egress`, async t => {
  const f = await fixture(t);
  if (mutation === "revoke") await revokeGrantCredentials(f.env, f.key);
  else if (mutation === "replace") await putGrantCredentials(f.env, f.key, { provider: f.provider.id, kind: "api_key", enabled: true, credential: "replacement-fixture" }, false, "replace");
  else if (mutation === "disable") await putGrantCredentials(f.env, f.key, { ...f.metadata, enabled: false }, true);
  else if (mutation === "expired") f.advance(600_000);
  else { const values = f.env.GRANT_CREDENTIALS.objects.get(f.key).values; values.set("credential", { ...values.get("credential"), status: "reauth_required" }); }
  const response = await f.dispatch(); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "response_owner_unavailable"); assert.equal(f.calls.length, 0);
});

test("same-lineage credential rotation remains usable but route and provider changes do not repick", async t => {
  const f = await fixture(t, true);
  f.fetchGate.response = () => Response.json({ access_token: "refreshed-fixture", refresh_token: "new-refresh-fixture", expires_in: 3600 });
  const refreshed = await materializeGrantCredentials(f.env, f.key, f.metadata, f.provider.id, null, true);
  assert.equal(refreshed.credentialLineage, f.input.owner.lineage);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].request, "https://refresh.example/token"); f.calls.length = 0;
  assert.equal((await f.dispatch()).status, 200); assert.equal(f.calls[0].request.headers.get("authorization"), "Bearer refreshed-fixture");
  f.provider.base_urls.default = "https://changed.example";
  assert.equal((await f.dispatch()).status, 409); assert.equal(f.calls.length, 1);
});

test("expiry during preparation is checked after the awaited connection lookup", async t => {
  const f = await fixture(t), gate = f.gateConnection();
  const pending = f.dispatch(); await gate.entered; f.advance(600_000); gate.release();
  const response = await pending; assert.equal(response.status, 409); assert.equal(f.calls.length, 0);
});

for (const cause of ["aborted", "timed out"]) test(`${cause} preparation releases the owner tail; late lookup cannot dispatch after revocation`, { timeout: 2000 }, async t => {
  const f = await fixture(t), gate = f.gateConnection(), controller = new AbortController();
  if (cause === "timed out") t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.dispatch(controller.signal); await gate.entered;
  if (cause === "aborted") controller.abort(); else t.mock.timers.tick(10_000);
  assert.equal((await pending).status, 503);
  await revokeGrantCredentials(f.env, f.key);
  gate.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.dispatch()).status, 409);
});

test("upstream response wait is outside the credential tail and redirects remain unfollowed", { timeout: 2000 }, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.fetchGate.response = () => { entered.resolve(); return release.promise; };
  const pending = f.dispatch(); await entered.promise;
  await revokeGrantCredentials(f.env, f.key);
  release.resolve(new Response(null, { status: 302, headers: { location: "https://redirect.example/forbidden" } }));
  assert.equal((await pending).status, 302); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].request.redirect, "manual");
  assert.equal((await f.dispatch()).status, 409); assert.equal(f.calls.length, 1);
});

for (const environment of [false, true]) test(`automatic deadline crossed during ${environment ? "environment" : "credential-owner"} preparation prevents egress; public controls remain available`, async t => {
  const f = await fixture(t);
  if (environment) {
    f.env.OPENAI_API_KEY = "environment-fixture";
    const upstream = configuredUpstream(f.provider, null, f.env), headers = new Headers(upstream.headers);
    const create = f.provider.endpoints[0];
    copyRequestHeaders(new Headers({ "openai-organization": "org-fixture", "openai-project": "project-fixture" }), f.provider, create, headers, f.env);
    f.input.owner = { ...f.input.owner, grantKey: null, lineage: null, routeSha256: await responseRouteDigest(f.provider, upstream, new URL(`${upstream.baseUrl}${upstreamPath(f.provider, create, {}, f.env, upstream)}`), headers, null) };
  }
  const gate = f.gateConnection(), deadline = Date.now() + 1000;
  const pending = f.dispatch(undefined, { deadline });
  const result = pending.catch(error => error);
  await gate.entered; f.advance(1000); gate.release();
  const rejected = await result;
  if (environment) assert.equal(rejected.code, "response_observation_expired");
  else { assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error.code, "response_observation_expired"); }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.dispatch()).status, 200); assert.equal(f.calls.length, 1);
});
