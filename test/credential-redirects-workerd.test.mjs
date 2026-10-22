import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

// Real workerd fetch, SQL authority, credential owner and OAuth callback. Only
// provider configuration/time are synthetic; all egress terminates in upstream.
const routerScript = `
  import handler from "./worker/index.ts";
  import { GrantCredentialObject as Credentials } from "./worker/grant-credentials.ts";
  import { oauthCallback } from "./worker/oauth.ts";
  import { providerById } from "./worker/providers.ts";
  export * from "./worker/index.ts";
  providerById("openai").auth.authorization = {
    tokenUrl: "https://token.example/oauth/token", clientId: "fixture-client",
    clientSecretConfig: "FIXTURE_CLIENT_SECRET", scopes: ["openid"], extraTokenParams: {},
    grantKind: "oauth", accountIdJsonPointer: null, subscriptionPlanJsonPointer: null,
  };
  export class GrantCredentialObject extends Credentials {
    constructor(state, env) { super(state, { ...env, FIXTURE_CLIENT_SECRET: "fixture-client-secret" }); this.fixtureStorage = state.storage; }
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/state") return Response.json({ record: await this.fixtureStorage.get("credential"), alarm: await this.fixtureStorage.getAlarm() });
      if (path === "/fixture/keep-warm") {
        const record = await this.fixtureStorage.get("credential");
        record.nextQuotaProbeAt = new Date(Date.now() + 3600000).toISOString();
        record.nextKeepWarmAt = new Date(Date.now() - 1000).toISOString();
        await this.fixtureStorage.put("credential", record);
        await super.alarm();
        return new Response("maintained");
      }
      return super.fetch(request);
    }
  }
  export default { ...handler, fetch(request, env, context) {
    if (new URL(request.url).pathname === "/v1/oauth/callback") return oauthCallback(request, { ...env, CLAWROUTER_LOCAL_AUTH: "enabled", FIXTURE_CLIENT_SECRET: "fixture-client-secret" });
    return handler.fetch(request, env, context);
  } };
`;
const upstreamScript = `
  const calls = []; let config = {};
  export default { async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/config") { config = await request.json(); calls.length = 0; return new Response("configured"); }
    if (url.pathname === "/fixture/calls") return Response.json(calls);
    calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
    if (url.pathname === "/redirect-target") return Response.json({ access_token: "fixture-stolen", error: "invalid_grant" }, { status: 400 });
    if (config.status && (!config.onlyPath || config.onlyPath === url.pathname)) {
      const location = config.crossOrigin ? "https://redirect.example/redirect-target" : "/redirect-target";
      return new Response(config.status === 304 ? null : JSON.stringify({ error: "invalid_grant" }), { status: config.status, headers: {
        ...(config.noLocation ? {} : { location }),
        // Redirect metadata is not authoritative inference quota feedback.
        "anthropic-ratelimit-unified-5h-utilization": "1", "retry-after": "300",
      } });
    }
    if (url.pathname.endsWith("/token")) return Response.json({ access_token: "fixture-access-new", refresh_token: "fixture-refresh-new", expires_in: 3600 });
    if (url.pathname.endsWith("/usage")) return Response.json({ five_hour: { utilization: 25 }, rate_limit: { primary_window: { used_percent: 25 } } });
    if (url.pathname.endsWith("/profile")) return Response.json({ account: { email: "fixture@example.com" } });
    return Response.json({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }, { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.25" } });
  } };
`;

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-credential-redirects-"));
  let mf;
  t.after(async () => { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); });
  mf = await startWorkerdFixture(temporary, routerScript, upstreamScript);
  const namespace = await mf.getDurableObjectNamespace("GRANT_CREDENTIALS", "router");
  const authorities = await mf.getDurableObjectNamespace("ACCESS_CONTROL", "router");
  const authority = authorities.get(authorities.idFromName("policy-bindings"));
  const upstream = await mf.getWorker("upstream"), kv = await mf.getKVNamespace("POLICY_KV", "router");
  const post = (stub, path, body) => stub.fetch("https://fixture" + path, { method: "POST", body: JSON.stringify(body) });
  const configure = async config => { assert.equal((await post(upstream, "/fixture/config", config)).status, 200); };
  const calls = async () => (await upstream.fetch("https://fixture/fixture/calls")).json();
  let sequence = 0;
  async function grant(provider, extra = {}) {
    const key = `oauth/fixture/grant-${++sequence}`, owner = namespace.get(namespace.idFromName(key));
    const response = await post(owner, "/put", { key, grant: { provider, kind: "subscription", enabled: true, accessToken: "fixture-access-old", refreshToken: "fixture-refresh-old", accountId: "fixture-account", expiresAt: new Date(Date.now() + 3600000).toISOString(), ...extra }, preserveUnspecifiedSecrets: false });
    assert.equal(response.status, 200, await response.clone().text());
    return { key, owner, projection: (await response.json()).grant, state: async () => (await owner.fetch("https://fixture/fixture/state")).json() };
  }
  const runtime = async key => (await (await post(authority, "/grant-pools/states", { keys: [key] })).json()).states[key];
  return { mf, kv, authority, post, configure, calls, grant, runtime };
}

const redirects = [301, 302, 303, 307, 308].flatMap(status => [false, true].map(crossOrigin => ({ status, crossOrigin })));
redirects.push(...[300, 304, 399].map(status => ({ status, noLocation: true })));
async function noReplay(f, expectedCalls = 1) {
  const calls = await f.calls();
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/redirect-target").length, 0, "redirect target must receive neither a request nor credentials");
  assert.equal(calls.length, expectedCalls, "only declared provider endpoint(s) contacted");
  return calls;
}

for (const requestFormat of ["form", "json"]) test(`workerd ${requestFormat} refresh redirects stay transient, preserve credentials and defer retry`, { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  for (const config of redirects) await t.test(JSON.stringify(config), async () => {
    await f.configure(config);
    const g = await f.grant("openai", { expiresAt: new Date(Date.now() + 60000).toISOString(), refresh: { tokenUrl: "https://token.example/refresh/token", clientSecretConfig: "FIXTURE_CLIENT_SECRET", requestFormat } });
    const input = { key: g.key, grant: g.projection, providerId: "openai", force: false };
    const response = await f.post(g.owner, "/materialize", input);
    const calls = await noReplay(f);
    const sent = requestFormat === "json" ? JSON.parse(calls[0].body) : Object.fromEntries(new URLSearchParams(calls[0].body));
    assert.equal(sent.refresh_token, "fixture-refresh-old"); assert.equal(sent.client_secret, "fixture-client-secret");
    assert.equal(response.status, 502); assert.equal((await response.json()).error.code, "grant_refresh_failed");
    const { record, alarm } = await g.state();
    assert.equal(record.status, "active"); assert.equal(record.enabled, true); assert.equal(record.revokedAt, null);
    assert.equal(record.generation, g.projection.credentialGeneration); assert.equal(record.lineage, g.projection.credentialLineage);
    assert.equal(record.accessToken, "fixture-access-old"); assert.equal(record.refreshToken, "fixture-refresh-old");
    assert.ok(Date.parse(record.nextRefreshAttemptAt) > Date.now() + 290000); assert.ok(alarm > Date.now());
    assert.equal(await f.runtime(g.key), undefined, "redirect is not authentication/rate-limit feedback");
    const retry = await f.post(g.owner, "/materialize", input);
    assert.equal((await retry.json()).error.code, "grant_refresh_failed"); await noReplay(f);
  });
  await t.test("successful refresh still rotates once", async () => {
    await f.configure({});
    const g = await f.grant("openai", { refresh: { tokenUrl: "https://token.example/refresh/token", requestFormat } });
    const response = await f.post(g.owner, "/materialize", { key: g.key, grant: g.projection, providerId: "openai", force: true });
    assert.equal(response.status, 200); const updated = (await response.json()).grant;
    assert.equal(updated.accessToken, "fixture-access-new"); assert.equal(updated.refreshToken, "fixture-refresh-new");
    assert.equal(updated.credentialGeneration, g.projection.credentialGeneration + 1); assert.equal(updated.credentialLineage, g.projection.credentialLineage);
    assert.equal((await g.state()).record.nextRefreshAttemptAt, null); await noReplay(f);
  });
});

test("workerd quota redirects retain previous quota and never invalidate credentials", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  for (const config of redirects) await t.test(JSON.stringify(config), async () => {
    const g = await f.grant("openai");
    await f.configure({});
    assert.equal((await f.post(g.owner, "/quota-refresh", { key: g.key })).status, 200);
    const before = await f.runtime(g.key); assert.equal(before.windows[0].remaining, 75);
    await f.configure(config);
    const response = await f.post(g.owner, "/quota-refresh", { key: g.key });
    const calls = await noReplay(f);
    assert.equal(calls[0].headers.authorization, "Bearer fixture-access-old"); assert.equal(calls[0].headers["chatgpt-account-id"], "fixture-account");
    assert.equal(response.status, 502); assert.equal((await response.json()).error.code, "grant_quota_probe_failed");
    assert.equal((await g.state()).record.status, "active"); assert.deepEqual(await f.runtime(g.key), before);
  });
  await t.test("optional profile redirect leaves successful required quota intact", async () => {
    const g = await f.grant("anthropic"); await f.configure({ status: 307, crossOrigin: true, onlyPath: "/api/oauth/profile" });
    assert.equal((await f.post(g.owner, "/quota-refresh", { key: g.key })).status, 200);
    const calls = await noReplay(f, 2); assert.ok(calls.every(call => call.headers.authorization === "Bearer fixture-access-old"));
    const runtime = await f.runtime(g.key); assert.equal(runtime.windows[0].remaining, 75); assert.equal(runtime.account, undefined);
    assert.equal((await g.state()).record.status, "active");
  });
});

test("workerd keep-warm redirects cannot replay tokens or publish redirect quota headers", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  for (const config of redirects) await t.test(JSON.stringify(config), async () => {
    await f.configure(config); const g = await f.grant("anthropic", { maintenance: { keepWarm: true } });
    assert.equal((await f.post(g.owner, "/fixture/keep-warm", {})).status, 200);
    const calls = await noReplay(f); assert.equal(calls[0].headers.authorization, "Bearer fixture-access-old");
    assert.equal(JSON.parse(calls[0].body).max_tokens, 1);
    assert.equal(await f.runtime(g.key), undefined);
    const { record, alarm } = await g.state(); assert.equal(record.status, "active");
    assert.ok(Date.parse(record.nextKeepWarmAt) > Date.now() + 17600000); assert.ok(alarm > Date.now());
  });
  await t.test("successful keep-warm still observes quota and schedules the next interval", async () => {
    await f.configure({}); const g = await f.grant("anthropic", { maintenance: { keepWarm: true } });
    assert.equal((await f.post(g.owner, "/fixture/keep-warm", {})).status, 200); await noReplay(f);
    assert.equal((await f.runtime(g.key)).windows[0].remaining, 75);
    assert.ok(Date.parse((await g.state()).record.nextKeepWarmAt) > Date.now());
  });
});

test("workerd OAuth exchange redirects cannot replay code, verifier or client secret", { timeout: 60_000 }, async t => {
  const f = await fixture(t), token = "a".repeat(64), email = "fixture@example.com";
  await f.kv.put("local/sessions/" + createHash("sha256").update(token).digest("hex"), JSON.stringify({ email, role: "admin", expiresAtMs: Date.now() + 3600000 }));
  assert.equal((await f.post(f.authority, "/users/create", { email, record: { role: "admin", enabled: true, groups: [] } })).status, 200);
  let sequence = 0;
  async function callback() {
    const state = "fixture-state-" + ++sequence, grantKey = "oauth/fixture/callback-" + sequence;
    assert.equal((await f.post(f.authority, "/oauth-states/put", { state, verifier: "fixture-verifier", actorEmail: email, grantKey, provider: "openai", priority: 100, weight: 1, redirectUri: "https://router.example/v1/oauth/callback", expiresAtMs: Date.now() + 60000 })).status, 200);
    const url = new URL("/v1/oauth/callback?state=" + state + "&code=fixture-auth-code", await f.mf.ready);
    return { grantKey, response: await fetch(url, { headers: { cookie: "clawrouter_session=" + token }, redirect: "manual" }) };
  }
  for (const config of redirects) await t.test(JSON.stringify(config), async () => {
    await f.configure(config); const { grantKey, response } = await callback();
    const calls = await noReplay(f), sent = new URLSearchParams(calls[0].body);
    assert.equal(sent.get("code"), "fixture-auth-code"); assert.equal(sent.get("code_verifier"), "fixture-verifier"); assert.equal(sent.get("client_secret"), "fixture-client-secret");
    assert.equal(response.status, 400); assert.match(await response.text(), /Provider token exchange failed/);
    assert.equal(await f.kv.get(grantKey), null);
  });
  await t.test("successful exchange still saves the connection", async () => {
    await f.configure({}); const { grantKey, response } = await callback(); await noReplay(f);
    assert.equal(response.status, 200); assert.match(await response.text(), /connection saved/);
    const projection = await f.kv.get(grantKey, "json"); assert.equal(projection.credentialStatus, "active"); assert.equal(projection.hasAccessToken, true); assert.equal(projection.hasRefreshToken, true);
    assert.equal(projection.accessToken, undefined); assert.equal(projection.refreshToken, undefined);
  });
});
