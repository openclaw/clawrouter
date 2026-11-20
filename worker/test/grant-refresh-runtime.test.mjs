import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

// Real credential/authority DOs and admin routes; only provider egress is synthetic.
const router = `
  export * from "./worker/index.ts";
  import handler from "./worker/index.ts";
  let clock = ${Date.now() + 86400000}; Date.now = () => clock;
  import { GrantCredentialObject as CredentialOwner } from "./worker/grant-credentials.ts";
  // Inject one failure at a storage boundary; owner logic, SQLite persistence,
  // serialization, refresh exchange and admin routes remain real.
  export class GrantCredentialObject extends CredentialOwner {
    constructor(state, env) {
      const storage = new Proxy(state.storage, { get(target, name) {
        if (name === "put") return async (...args) => {
          if (args[0] === "credential" && args[1]?.accessToken === "fixture-rotated" && await env.POLICY_KV.get("fixture/fail-rotation-write") === "yes") {
            await env.POLICY_KV.delete("fixture/fail-rotation-write");
            throw new Error("fixture rotation write unavailable");
          }
          return target.put(...args);
        };
        const value = target[name]; return typeof value === "function" ? value.bind(target) : value;
      } });
      super(new Proxy(state, { get(target, name) {
        if (name === "storage") return storage;
        const value = target[name]; return typeof value === "function" ? value.bind(target) : value;
      } }), { ...env, POLICY_KV: new Proxy(env.POLICY_KV, { get(target, name) {
        if (name === "put") return async (...args) => {
          if (args[0].startsWith("oauth/") && await target.get("fixture/fail-projection") === "yes") throw new Error("fixture projection unavailable");
          return target.put(...args);
        };
        const value = target[name]; return typeof value === "function" ? value.bind(target) : value;
      } }) });
      this.fixtureStorage = state.storage;
    }
    async fetch(request) {
      if (new URL(request.url).pathname === "/fixture/alarm-state") return Response.json({ alarm: await this.fixtureStorage.getAlarm(), nextRefreshAttemptAt: (await this.fixtureStorage.get("credential"))?.nextRefreshAttemptAt });
      return super.fetch(request);
    }
  }
  import { sha256Hex } from "./worker/utils.ts";
  export default { async fetch(request, env, ctx) {
    env.CLAWROUTER_LOCAL_AUTH = "enabled";
    env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("fixture-admin");
    if (new URL(request.url).pathname === "/fixture/fail-rotation-write") { await env.POLICY_KV.put("fixture/fail-rotation-write", "yes"); return new Response("ok"); }
    if (new URL(request.url).pathname === "/fixture/alarm-state") return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName("oauth/pool/claude")).fetch(request);
    if (new URL(request.url).pathname === "/fixture/fail-projection") { await env.POLICY_KV.put("fixture/fail-projection", "yes"); return new Response("ok"); }
    if (new URL(request.url).pathname === "/fixture/clock") { clock = (await request.json()).now; return new Response("ok"); }
    if (new URL(request.url).pathname === "/fixture/provider") return fetch("https://fixture/control", request);
    return handler.fetch(request, env, ctx);
  } };
`;
const upstream = `
  let config = {}, calls = [];
  export default { async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/control") {
      if (request.method === "POST") { config = await request.json(); calls = []; }
      return Response.json(calls);
    }
    const auth = request.headers.get("authorization");
    calls.push({ path, auth });
    if (path.endsWith("/token")) {
      const body = await request.json();
      if (body.refresh_token !== "fixture-refresh") return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (config.malformed) return new Response("fixture-provider-private", { status: 200 });
      if (config.oversized) return new Response("x".repeat(140000), { status: 502 });
      return config.failure ? Response.json({ error: config.failure, error_description: "fixture-provider-private fixture-refresh fixture-access", access_token: "fixture-response-private" }, { status: config.status ?? 400 })
        : Response.json({ access_token: "fixture-rotated", refresh_token: "fixture-refresh", expires_in: 3600 });
    }
    if ((config.probe === "profile" ? path.endsWith("/profile") : path.endsWith("/usage")) && (auth !== "Bearer fixture-rotated" || config.repeat401)) return new Response(null, { status: 401 });
    return Response.json(path.endsWith("/usage") ? { five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00Z" } } : { account: { display_name: "Fixture" } });
  } };
`;
async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-refresh-"));
  let mf = await startWorkerdFixture(temporary, router, upstream, { persistencePath: join(temporary, "state") });
  t.after(async () => { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); });
  const request = (path, method = "GET", body, authorized = true) => mf.dispatchFetch(`https://router.example${path}`, { method, headers: { ...(authorized ? { authorization: "Bearer fixture-admin" } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const base = "/v1/admin/upstream-grants/policies/pool/claude";
  const grant = { provider: "anthropic", kind: "subscription", enabled: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: "2099-01-01T00:00:00Z", maintenance: { keepWarm: false } };
  const installed = await request(base, "PUT", grant);
  assert.equal(installed.status, 200, await installed.clone().text());
  const row = async () => {
    const response = await request("/v1/admin/upstream-grants");
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /fixture-access|fixture-refresh|fixture-rotated|fixture-provider-private|fixture-response-private/);
    return JSON.parse(text).grants.find(grant => grant.tokenRef === "claude");
  };
  return { request, base, grant, row, restart: async () => { await mf.dispose(); mf = await startWorkerdFixture(temporary, router, upstream, { persistencePath: join(temporary, "state") }); }, configure: config => request("/fixture/provider", "POST", config), calls: async () => (await request("/fixture/provider")).json() };
}

for (const probe of ["usage", "profile"]) test(`workerd ${probe} 401 refreshes once and retries with committed credentials`, { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ probe });
  const response = await f.request(`${f.base}/quota-refresh`, "POST");
  assert.equal(response.status, 200, await response.clone().text());
  const row = await f.row();
  assert.equal(row.credentialStatus, "active");
  assert.equal(row.quotaWindows[0].remaining, 90);
  assert.ok(row.refreshDiagnosis.lastSuccessfulRefreshAt);
  assert.equal(row.refreshDiagnosis.failure, null);
  const calls = await f.calls();
  assert.equal(calls.filter(call => call.path.endsWith("/token")).length, 1);
  assert.deepEqual(calls.filter(call => call.path.endsWith(`/${probe}`)).map(call => call.auth), ["Bearer fixture-access", "Bearer fixture-rotated"]);
});

test("workerd permanent rejection persists safe diagnosis, metadata edits preserve denial, replacement clears it", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ failure: "invalid_grant" });
  const response = await f.request(`${f.base}/quota-refresh`, "POST");
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /fixture-refresh|fixture-access|fixture-provider-private/);
  const row = await f.row();
  assert.equal(row.credentialStatus, "reauth_required");
  assert.equal(row.refreshDiagnosis.failure.oauthError, "invalid_grant");
  assert.equal(row.refreshDiagnosis.failure.httpStatus, 400);
  assert.equal(row.refreshDiagnosis.failure.failureClass, "permanent");
  assert.equal(row.refreshDiagnosis.failure.attemptCount, 1);
  assert.equal(row.refreshDiagnosis.failure.firstFailureAt, row.refreshDiagnosis.failure.lastFailureAt);
  assert.equal(row.refreshDiagnosis.failure.nextRetryAt, null);
  await f.restart();
  assert.deepEqual((await f.row()).refreshDiagnosis, row.refreshDiagnosis);
  const edited = await f.request(f.base, "PUT", { provider: "anthropic", kind: "subscription", label: "renamed", credentialStatus: "active", refreshDiagnosis: { failure: null } });
  assert.equal(edited.status, 200, await edited.clone().text());
  const after = await f.row();
  assert.equal(after.credentialStatus, "reauth_required");
  assert.deepEqual(after.refreshDiagnosis, row.refreshDiagnosis);
  const denied = await f.request(`${f.base}/quota-refresh`, "POST");
  assert.equal(denied.status, 401);
  assert.equal((await f.calls()).length, 0, "restart and metadata edits cannot re-enable provider I/O");
  const unauthorized = await f.request("/v1/admin/upstream-grants", "GET", undefined, false);
  assert.equal(unauthorized.status, 401);
  const replaced = await f.request(`${f.base}?mode=replace`, "PUT", { ...f.grant, refreshToken: "fixture-fresh-authorization" });
  assert.equal(replaced.status, 200);
  assert.equal((await f.row()).credentialStatus, "active");
  assert.equal((await f.row()).refreshDiagnosis, null);
});

test("workerd refresh failures retain bounded secretless diagnosis across attempts and successful recovery", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ failure: "temporarily_unavailable", status: 503 });
  assert.equal((await f.request(`${f.base}/quota-refresh`, "POST")).status, 502);
  const first = await f.row();
  assert.equal(first.credentialStatus, "active");
  assert.equal(first.refreshDiagnosis.failure.failureClass, "transient");
  assert.equal(first.refreshDiagnosis.failure.httpStatus, 503);
  assert.ok(Date.parse(first.refreshDiagnosis.failure.nextRetryAt) > Date.now());
  await f.request("/fixture/clock", "POST", { now: Date.parse(first.refreshDiagnosis.failure.nextRetryAt) });
  await f.configure({ failure: "fixture-refresh".repeat(100), status: 503 });
  assert.equal((await f.request(`${f.base}/quota-refresh`, "POST")).status, 502);
  const second = await f.row();
  assert.equal(second.refreshDiagnosis.failure.oauthError, "unknown_error");
  assert.equal(second.refreshDiagnosis.failure.firstFailureAt, first.refreshDiagnosis.failure.firstFailureAt);
  assert.equal(second.refreshDiagnosis.failure.attemptCount, 2);
  await f.request("/fixture/clock", "POST", { now: Date.parse(second.refreshDiagnosis.failure.nextRetryAt) });
  await f.configure({});
  assert.equal((await f.request(`${f.base}/quota-refresh`, "POST")).status, 200);
  assert.equal((await f.row()).refreshDiagnosis.failure, null);
  assert.ok((await f.row()).refreshDiagnosis.lastSuccessfulRefreshAt);
});

test("workerd repeated access 401 does not revoke a successfully refreshed grant", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ repeat401: true });
  assert.equal((await f.request(`${f.base}/quota-refresh`, "POST")).status, 502);
  assert.equal((await f.row()).credentialStatus, "active");
  assert.equal((await f.calls()).filter(call => call.path.endsWith("/token")).length, 1);
});

test("workerd metadata-only PUT cannot cosmetically resurrect a terminal owner", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ failure: "invalid_grant" });
  assert.equal((await f.request(`${f.base}/refresh`, "POST")).status, 401);
  assert.equal((await f.row()).credentialStatus, "reauth_required");
  // A stale UI projection must not clear the authoritative denial.
  const edited = await f.request(f.base, "PUT", { provider: "anthropic", kind: "subscription", label: "renamed", credentialStatus: "active" });
  assert.equal(edited.status, 200, await edited.clone().text());
  assert.equal((await f.row()).credentialStatus, "reauth_required");
});

test("workerd explicit refresh rejection retains the provider reason without its body", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ failure: "invalid_grant" });
  assert.equal((await f.request(`${f.base}/refresh`, "POST")).status, 401);
  const row = await f.row();
  assert.equal(row.refreshDiagnosis?.failure?.oauthError, "invalid_grant");
});

for (const [name, config, code, status] of [
  ["rate limit", { failure: "temporarily_unavailable", status: 429 }, "temporarily_unavailable", 429],
  ["configuration rejection", { failure: "invalid_client", status: 401 }, "invalid_client", 401],
  ["malformed response", { malformed: true }, "invalid_response", 200],
  ["oversized response", { oversized: true }, "invalid_response", 502],
]) test(`workerd ${name} is diagnosed without requiring reauthorization`, { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure(config);
  assert.equal((await f.request(`${f.base}/quota-refresh`, "POST")).status, 502);
  const row = await f.row();
  assert.equal(row.credentialStatus, "active");
  assert.equal(row.refreshDiagnosis.failure.oauthError, code);
  assert.equal(row.refreshDiagnosis.failure.httpStatus, status);
  assert.equal(row.refreshDiagnosis.failure.failureClass, status === 429 ? "retry_after" : status === 200 ? "ambiguous" : "transient");
  assert.equal((await f.calls()).filter(call => call.path.endsWith("/token")).length, 1);
});

test("workerd setup-token and disabled grants never call quota or refresh providers", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({});
  assert.equal((await f.request(`${f.base}?mode=replace`, "PUT", { ...f.grant, refreshToken: undefined })).status, 200);
  assert.equal((await f.request(`${f.base}/quota-refresh`, "POST")).status, 400);
  assert.equal((await f.row()).credentialStatus, "active");
  assert.equal((await f.request(`${f.base}?mode=replace`, "PUT", { ...f.grant, enabled: false })).status, 200);
  assert.equal((await f.request(`${f.base}/quota-refresh`, "POST")).status, 409);
  assert.deepEqual(await f.calls(), []);
});

test("workerd admin diagnosis reads the owner after a failed KV projection, including restart", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ failure: "invalid_grant" });
  await f.request("/fixture/fail-projection", "POST");
  assert.equal((await f.request(`${f.base}/quota-refresh`, "POST")).status, 500);
  const row = await f.row();
  assert.equal(row.credentialStatus, "reauth_required");
  assert.equal(row.usable, false);
  assert.equal(row.refreshDiagnosis.failure.oauthError, "invalid_grant");
  await f.restart();
  assert.deepEqual((await f.row()).refreshDiagnosis, row.refreshDiagnosis);
});

test("workerd a failed rotation write schedules local settlement while fencing consumed-token replay", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({});
  await f.request("/fixture/fail-rotation-write", "POST");
  assert.equal((await f.request(`${f.base}?mode=replace`, "PUT", { ...f.grant, expiresAt: "2020-01-01T00:00:00Z" })).status, 200);
  assert.equal((await f.request(`${f.base}/refresh`, "POST")).status, 502);
  const { alarm, nextRefreshAttemptAt } = await (await f.request("/fixture/alarm-state")).json();
  assert.ok(Date.parse(nextRefreshAttemptAt) > Date.now(), "retained replacement schedules local-only settlement");
  assert.ok(alarm > Date.now() + 10000, "the shared quota alarm must not turn the retry delay into a one-second refresh loop");
  assert.equal((await f.row()).credentialStatus, "active");
  assert.equal((await f.row()).refreshDiagnosis.lastSuccessfulRefreshAt, null, "uncommitted rotation is not a successful refresh");
  assert.equal((await f.row()).refreshDiagnosis.failure.failureClass, "provider_ok_persist_failed");
});

test("workerd reordering an unchanged credential bundle cannot clear terminal state", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ failure: "invalid_grant" });
  assert.equal((await f.request(`${f.base}?mode=replace`, "PUT", { ...f.grant, credentials: { first: "fixture-one", second: "fixture-two" } })).status, 200);
  assert.equal((await f.request(`${f.base}/refresh`, "POST")).status, 401);
  const edited = await f.request(f.base, "PUT", { provider: "anthropic", kind: "subscription", credentials: { second: "fixture-two", first: "fixture-one" } });
  assert.equal(edited.status, 200);
  assert.equal((await f.row()).credentialStatus, "reauth_required");
});
