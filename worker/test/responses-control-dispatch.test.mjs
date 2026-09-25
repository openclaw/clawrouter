import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { materializeGrantCredentials, putGrantCredentials, revokeGrantCredentials } from "../grant-credentials.ts";
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { publicControlAuthorization } = await import("../response-control-authorization.ts");
const { verifiedAccessSession, sessionPolicyIdentity } = await import("../access.ts");
import { sha256Hex } from "../utils.ts";
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
    async list() { return { keys: [], list_complete: true }; },
  } });
  await env.grantAuthority.fetch("https://authority/connections/initialize-all", { method: "POST", body: JSON.stringify([{ providerId: provider.id, enabled: true }]) });
  for (const [path, body] of [
    ["/policies/initialize-all", [{ policyId: "policy", policy: { enabled: true, generation: "g1", providers: [provider.id] } }]],
    ["/credentials/initialize-all", [{ credentialId: "fixture", credential: { enabled: true, policyId: "policy", policyGeneration: "g1", principalId: null, secretSha256: await sha256Hex("abcdefgh") } }]],
  ]) assert.equal((await env.grantAuthority.fetch("https://authority"+path, { method: "POST", body: JSON.stringify(body) })).status, 200);
  const auth = await authenticateProxyKey(new Headers({ authorization: "Bearer clawrouter-live-fixture-abcdefgh" }), env);
  assert.equal(auth instanceof Response, false);
  const key = "oauth/policy/background-fixture";
  const metadata = await putGrantCredentials(env, key, { provider: provider.id, kind: oauth ? "oauth" : "api_key", enabled: true, ...(oauth ? { accessToken: "fixture-secret", refreshToken: "refresh-fixture", refresh: { tokenUrl: "https://refresh.example/token" } } : { credential: "fixture-secret" }), expiresAt: new Date(now + 600_000).toISOString() });
  const grant = await materializeGrantCredentials(env, key, metadata, provider.id, null, false);
  const incoming = new Headers({ "openai-organization": "org-fixture", "openai-project": "project-fixture" });
  const upstream = configuredUpstream(provider, grant, env), headers = new Headers(upstream.headers);
  copyRequestHeaders(incoming, provider, create, headers, env);
  const url = new URL(`${upstream.baseUrl}${upstreamPath(provider, create, {}, env, upstream)}`);
  const input = { owner: { providerId: provider.id, endpointId: create.id, grantKey: key, lineage: grant.credentialLineage, routeSha256: await responseRouteDigest(provider, upstream, url, headers, key), policyGeneration: "g1" }, route: { pathParams: {}, organization: "org-fixture", project: "project-fixture" }, responseId: "response/fixture", action: "retrieve", query: "include%5B%5D=one&include%5B%5D=two", stream: true };
  input.authorization = publicControlAuthorization(auth);
  kv.reads = 0;
  const calls = [], fetchGate = { response: () => Response.json({ id: "response/fixture", object: "response", status: "queued" }) };
  t.mock.method(globalThis, "fetch", async (request, init) => { calls.push({ request, init }); return fetchGate.response(request); });
  return { env, provider, metadata, key, input, auth, values, calls, kv, fetchGate, advance(ms) { now += ms; }, dispatch(signal = new AbortController().signal, override = {}) { return dispatchResponseControl(env, { ...input, ...override }, signal); },
    gateConnection() {
      const entered = Promise.withResolvers(), release = Promise.withResolvers(), get = env.ACCESS_CONTROL.get;
      env.ACCESS_CONTROL.get = name => ({ fetch: async (url, init) => { if (new URL(url).pathname === "/connections/resolve") { entered.resolve(); await release.promise; } return get(name).fetch(url, init); } });
      return { entered: entered.promise, release: () => release.resolve() };
    },
  };
}

test("public authorization requires the verifier's object and cannot default to internal collection", async t => {
  const f = await fixture(t);
  assert.throws(() => publicControlAuthorization({ ...f.auth }), { code: "response_caller_unavailable" });
  assert.throws(() => publicControlAuthorization({ ...f.auth, authType: "access", credentialId: null }), { code: "response_caller_unavailable" });
  assert.equal((await f.dispatch(undefined, { authorization: undefined })).status, 403);
  assert.equal((await f.dispatch(undefined, { authorization: { kind: "collection" } })).status, 409);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.dispatch()).status, 200, "an unowned verified service key remains supported");
});

for (const policyChange of [{ tenantId: "changed" }, { generation: "g2" }, { providers: ["other"] }, { enabled: false }]) {
  test(`final authority snapshot preserves original policy facts: ${JSON.stringify(policyChange)}`, async t => {
    const f = await fixture(t), gate = f.gateConnection(), pending = f.dispatch(); await gate.entered;
    const response = await f.env.grantAuthority.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "policy", policy: { ...f.auth.policy, ...policyChange } }) });
    assert.equal(response.status, 200); gate.release();
    assert.equal((await pending).status, 403); assert.equal(f.calls.length, 0);
  });
}

for (const mode of ["local", "cloudflare_access"]) test(`${mode} verifier proof survives original policy projection but expiry after the final snapshot denies egress`, async t => {
  const f = await fixture(t), email = "fixture@example.com", expiresAtMs = Date.now() + 1000;
  const call = async (path, body) => {
    const response = await f.env.grantAuthority.fetch(`https://authority${path}`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
  };
  await call("/users/initialize-all", [{ email, record: { enabled: true, role: "user", groups: [], assignmentState: { version: 1, revision: "[]", assignments: {}, updatedAt: null } } }]);
  await call("/initialize-all", [{ principalType: "user", principalId: email, policyId: "policy", priority: 10, enabled: true }]);
  let headers;
  if (mode === "local") {
    f.env.CLAWROUTER_LOCAL_AUTH = "enabled";
    const token = "b".repeat(64);
    f.values.set(`local/sessions/${await sha256Hex(token)}`, { email, role: "user", expiresAtMs });
    headers = { cookie: `clawrouter_session=${token}` };
  } else {
    const domain = "fixture.cloudflareaccess.com", kid = "fixture-key", audience = "fixture-audience";
    Object.assign(f.env, { CLAWROUTER_ACCESS_TEAM_DOMAIN: domain, CLAWROUTER_ACCESS_AUD: audience });
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid }, encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", kid })}.${encode({ aud: audience, iss: `https://${domain}`, email, exp: expiresAtMs / 1000 })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned));
    headers = { "cf-access-jwt-assertion": `${unsigned}.${Buffer.from(signature).toString("base64url")}` };
    f.fetchGate.response = request => { assert.equal(request, `https://${domain}/cdn-cgi/access/certs`); return Response.json({ keys: [jwk] }); };
  }
  const session = await verifiedAccessSession(new Request("https://router.example/control", { headers }), f.env);
  assert.ok(session); const identity = sessionPolicyIdentity(session, { policyId: "policy", policy: f.auth.policy });
  assert.throws(() => publicControlAuthorization(sessionPolicyIdentity({ ...session }, { policyId: "policy", policy: f.auth.policy })), { code: "response_caller_unavailable" });
  const authorization = publicControlAuthorization(identity);
  assert.equal(JSON.stringify(authorization).includes(headers.cookie ?? headers["cf-access-jwt-assertion"]), false);
  f.calls.length = 0; f.fetchGate.response = () => Response.json({ id: "response/fixture", status: "queued" });
  assert.equal((await f.dispatch(undefined, { authorization })).status, 200);
  const get = f.env.ACCESS_CONTROL.get;
  f.env.ACCESS_CONTROL.get = name => ({ fetch: async (url, init) => {
    const response = await get(name).fetch(url, init);
    if (new URL(url).pathname === "/authorization/snapshot") f.advance(1000);
    return response;
  } });
  assert.equal((await f.dispatch(undefined, { authorization })).status, 403); assert.equal(f.calls.length, 1);
});

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
  const pending = f.dispatch(undefined, { deadline, query: "", authorization: { kind: "collection" } });
  const result = pending.catch(error => error);
  await gate.entered; f.advance(1000); gate.release();
  const rejected = await result;
  if (environment) assert.equal(rejected.code, "response_observation_expired");
  else { assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error.code, "response_observation_expired"); }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.dispatch()).status, 200); assert.equal(f.calls.length, 1);
});
