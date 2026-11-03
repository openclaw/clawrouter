import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { Log, LogLevel } = require("miniflare");
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

// Real Worker + SQLite DOs. Only provider egress, clock, and named storage
// failures are controlled. No real credentials or upstream requests.
const now = Date.parse("2030-01-01T00:00:00Z");
const router = `
  export * from "./worker/index.ts";
  import handler from "./worker/index.ts";
  import { GrantCredentialObject as Owner } from "./worker/grant-credentials.ts";
  import { sha256Hex } from "./worker/utils.ts";
  import { providerById } from "./worker/providers.ts";
  providerById("anthropic").auth.authorization = { authorizeUrl: "https://fixture/authorize", tokenUrl: "https://fixture/token", clientId: "fixture-client", grantKind: "subscription", scopes: ["inference"], extraAuthorizeParams: {}, extraTokenParams: {}, accountIdJsonPointer: null, subscriptionPlanJsonPointer: null };
  let clock = ${now}, reconnectStarted = false; Date.now = () => clock;
  export class GrantCredentialObject extends Owner {
    constructor(state, env) {
      const storage = new Proxy(state.storage, { get(target, name) {
        if (name === "put") return async (key, value) => {
          if (key === "credential" && value?.accessToken === "fixture-rotated" && await env.POLICY_KV.get("fixture/fail-write") === "yes") throw new Error("fixture write failure");
          return target.put(key, value);
        };
        const value = target[name]; return typeof value === "function" ? value.bind(target) : value;
      }});
      super(new Proxy(state, { get(target, name) { if (name === "storage") return storage; const value = target[name]; return typeof value === "function" ? value.bind(target) : value; }}), env);
      this.fixtureStorage = state.storage;
    }
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/clear-index") { await this.fixtureStorage.deleteAll(); return new Response("ok"); }
      if (path === "/fixture/pending") { const record = await this.fixtureStorage.get("credential"); await this.fixtureStorage.put("credential", { ...record, refreshAttempt: { id: "fixture-abandoned", generation: record.generation } }); return new Response("ok"); }
      if (path === "/fixture/state") {
        const record = await this.fixtureStorage.get("credential");
        return Response.json({ alarm: await this.fixtureStorage.getAlarm(), generation: record?.generation, accessToken: record?.accessToken, nextRefreshAttemptAt: record?.nextRefreshAttemptAt });
      }
      if (path === "/fixture/alarm") { await this.alarm(); return new Response("ok"); }
      // Simulates a separately committed newer generation at the durable boundary.
      // Used in addition to the public reconnect race, never as its replacement.
      if (path === "/fixture/newer") { const record = await this.fixtureStorage.get("credential"); await this.fixtureStorage.put("credential", { ...record, generation: record.generation + 1, accessToken: "fixture-reconnected", refreshToken: "fixture-new-login", refreshAttempt: null }); return new Response("ok"); }
      return super.fetch(request);
    }
  }
  export default { async fetch(request, env, ctx) {
    env.CLAWROUTER_LOCAL_AUTH = "enabled"; env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("fixture-admin");
    const path = new URL(request.url).pathname;
    if (path === "/fixture/json-legacy") { const { corrupt } = await request.json(); await env.POLICY_KV.put("oauth/legacy/json", corrupt ? "{broken" : JSON.stringify({ provider: "anthropic", kind: "subscription", accessToken: "fixture-legacy-access", refreshToken: "fixture-legacy-refresh" })); return new Response("ok"); }
    if (path === "/fixture/raw-legacy") { await env.POLICY_KV.put("oauth/legacy/raw", "fixture-raw-access"); return new Response("ok"); }
    if (path === "/fixture/provider") return fetch("https://fixture/control", request);
    if (path === "/fixture/reconnect-started") return Response.json(reconnectStarted);
    if (path === "/v1/admin/upstream-grants/policies/pool/claude" && request.method === "PUT" && new URL(request.url).searchParams.get("mode") === "replace") reconnectStarted = true;
    if (path === "/fixture/clock") { clock = (await request.json()).now; return new Response("ok"); }
    if (path === "/fixture/fail-write") { await env.POLICY_KV.put("fixture/fail-write", "yes"); return new Response("ok"); }
    if (path === "/fixture/clear-index") return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName("clawrouter:refresh-ownership:v1")).fetch(request);
    if (["/fixture/state", "/fixture/alarm", "/fixture/newer", "/fixture/pending"].includes(path)) return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName("oauth/pool/claude")).fetch(request);
    return handler.fetch(request, env, ctx);
  }};
`;
// A Durable Object keeps held egress alive across separate control requests.
const upstream = `
  export class Upstream {
    config = {}; calls = 0; release;
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/control") {
        if (request.method === "POST") {
          const next = await request.json();
          if (next.release) { const resume = this.release; this.release = undefined; resume?.(); return Response.json({ released: !!resume }); }
          this.config = next; this.calls = 0;
        }
        return Response.json({ calls: this.calls });
      }
      if (!path.endsWith("/token")) return this.config.quota401 ? new Response(null, { status: 401 }) : Response.json({});
      this.calls++;
      if (this.config.hold) await new Promise(resolve => { this.release = resolve; });
      if (this.config.lost) return new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture lost response")); } }));
      if (this.config.malformed) return new Response("fixture-private-body");
      if (this.config.status) return Response.json({ error: this.config.code ?? "server_error", error_description: "fixture-private-body" }, { status: this.config.status, headers: this.config.retry ? { "retry-after": this.config.retry } : {} });
      return Response.json({ access_token: "fixture-rotated", refresh_token: "fixture-rotated-refresh", expires_in: 3600 });
    }
  }
  export default { fetch(request, env) { return env.UPSTREAM.get(env.UPSTREAM.idFromName("fixture")).fetch(request); } };
`;
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "clawrouter-owner-"));
  const logs = [];
  class FixtureLog extends Log { log(message) { logs.push(message); } }
  const log = new FixtureLog(LogLevel.VERBOSE);
  const options = { persistencePath: join(dir, "state"), log, upstreamDurableObjects: { UPSTREAM: { className: "Upstream", useSQLite: true } } };
  let mf = await startWorkerdFixture(dir, router, upstream, options);
  t.after(async () => { await mf.dispose(); await rm(dir, { recursive: true, force: true }); assert.doesNotMatch(logs.join("\n"), /fixture-(?:access|refresh|rotated|private)|fingerprint|[a-f0-9]{64}/, "no token, private provider body or fingerprint in runtime logs"); });
  const request = (path, method = "GET", body, headers = {}) => mf.dispatchFetch(`https://router.example${path}`, { method, headers: { authorization: "Bearer fixture-admin", "content-type": "application/json", origin: "https://router.example", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const base = "/v1/admin/upstream-grants/policies/pool/claude";
  const grant = { provider: "anthropic", kind: "subscription", accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: new Date(now + 300000).toISOString(), maintenance: { keepWarm: false } };
  const put = await request(base, "PUT", grant); assert.equal(put.status, 200, await put.clone().text());
  const row = async () => { const response = await request("/v1/admin/upstream-grants"); assert.equal(response.status, 200); const text = await response.text(); assert.doesNotMatch(text, /fixture-(?:access|refresh|rotated|private)|fingerprint|[a-f0-9]{64}/); return JSON.parse(text).grants.find(g => g.tokenRef === "claude"); };
  return { request, base, grant, row, state: async () => (await request("/fixture/state", "POST")).json(), configure: config => request("/fixture/provider", "POST", config), release: async () => { const response = await request("/fixture/provider", "POST", { release: true }); assert.equal((await response.json()).released, true, "provider response was held until release"); }, calls: async () => (await (await request("/fixture/provider")).json()).calls, rotate: () => request(base + "/refresh", "POST"), restart: async () => { await mf.dispose(); mf = await startWorkerdFixture(dir, router, upstream, options); }, http: () => mf.ready };
}
async function until(check, message) {
  const deadline = Date.now() + 5000;
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  assert.fail(message);
}
async function sent(f) { await until(async () => await f.calls() > 0, "provider request not sent"); }

test("workerd refuses the same refresh authority across policy and tenant scopes without leaking its fingerprint", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const scope of ["policies/other/copy", "tenants/other/copy"]) {
    const response = await f.request("/v1/admin/upstream-grants/" + scope, "PUT", f.grant);
    assert.equal(response.status, 409);
    assert.match(await response.text(), /already owned|dedicated login/);
  }
  assert.equal((await f.row()).credentialProvenance, "imported");
});

test("workerd stale refresh settlement cannot overwrite a newer durable generation", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ hold: true });
  const rotation = f.rotate(); await sent(f);
  await f.request("/fixture/newer", "POST"); await f.release(); assert.equal((await rotation).status, 200);
  assert.equal((await f.state()).accessToken, "fixture-reconnected");
});

test("workerd caller disconnect does not lose an already-started rotated pair", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ hold: true });
  const controller = new AbortController();
  const response = fetch(new URL(f.base + "/refresh", await f.http()), { method: "POST", headers: { authorization: "Bearer fixture-admin" }, signal: controller.signal }).catch(error => error);
  await sent(f); controller.abort();
  assert.equal((await response).name, "AbortError", "caller disconnected before the provider response");
  await f.release();
  await until(async () => (await f.state()).accessToken === "fixture-rotated", "rotation did not persist after caller disconnect");
  assert.equal((await f.state()).accessToken, "fixture-rotated");
  assert.ok((await f.row()).refreshDiagnosis.lastSuccessfulRefreshAt);
});

test("workerd ambiguous outcome never replays a possibly consumed refresh token, including after restart", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ malformed: true });
  assert.equal((await f.rotate()).status, 502);
  await f.rotate(); assert.equal(await f.calls(), 1);
  assert.equal((await f.row()).refreshDiagnosis.failure.failureClass, "ambiguous");
  await f.restart(); await f.rotate(); assert.equal(await f.calls(), 0);
});

test("workerd transient retry uses a jittered pre-expiry budget rather than the entire five-minute margin", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ status: 503 });
  assert.equal((await f.rotate()).status, 502);
  const retry = Date.parse((await f.row()).refreshDiagnosis.failure.nextRetryAt);
  assert.ok(retry >= now + 1000 && retry < now + 60000);
  assert.ok((await f.state()).alarm < now + 300000);
});


test("workerd simultaneous imports reserve exactly one owner; different logins for the same account remain independent", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const paths = ["policies/a/one", "tenants/b/two"];
  const responses = await Promise.all(paths.map(path => f.request("/v1/admin/upstream-grants/" + path, "PUT", { ...f.grant, refreshToken: "fixture-another-login", accountId: "same-account" })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const independent = await f.request("/v1/admin/upstream-grants/policies/c/three", "PUT", { ...f.grant, refreshToken: "fixture-independent-login", accountId: "same-account" });
  assert.equal(independent.status, 200);
});

test("workerd rejects duplicate replacement without changing the previous grant and protects rotated tokens", { timeout: 60000 }, async t => {
  const f = await fixture(t), path = "/v1/admin/upstream-grants/tenants/other/login";
  assert.equal((await f.request(path, "PUT", { ...f.grant, refreshToken: "fixture-independent" })).status, 200);
  const replaced = await f.request(path + "?mode=replace", "PUT", f.grant);
  assert.equal(replaced.status, 409);
  assert.doesNotMatch(await replaced.text(), /fixture-|fingerprint|[a-f0-9]{64}/);
  assert.equal((await f.rotate()).status, 200);
  assert.equal((await f.request(path + "?mode=replace", "PUT", { ...f.grant, refreshToken: "fixture-rotated-refresh" })).status, 409);
  await f.restart();
  assert.equal((await f.request(path + "?mode=replace", "PUT", f.grant)).status, 409, "old tokens do not become transferable after rotation or restart");
});

test("workerd discovers pre-index owners, including disabled grants, rather than trusting an empty fingerprint index", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request(f.base, "PUT", { provider: "anthropic", kind: "subscription", enabled: false })).status, 200);
  await f.request("/fixture/clear-index", "POST");
  const duplicate = await f.request("/v1/admin/upstream-grants/policies/copy/login", "PUT", f.grant);
  assert.equal(duplicate.status, 409);
});

for (const retry of ["90", "Tue, 01 Jan 2030 00:01:30 GMT"]) test(`workerd Retry-After ${retry} is a floor for forced, quota and alarm refresh`, { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ status: 429, retry, quota401: true });
  assert.equal((await f.rotate()).status, 502);
  const row = await f.row();
  assert.equal(row.refreshDiagnosis.failure.failureClass, "retry_after");
  assert.equal(Date.parse(row.refreshDiagnosis.failure.nextRetryAt), now + 90000);
  await f.rotate(); await f.request(f.base + "/quota-refresh", "POST"); await f.request("/fixture/alarm", "POST");
  assert.equal(await f.calls(), 1);
  await f.request("/fixture/clock", "POST", { now: now + 90000 });
  await f.request("/fixture/alarm", "POST");
  assert.equal(await f.calls(), 2);
});

test("workerd repeated transient failures back off with jitter, cap retries, and recover via idle alarm", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ status: 503 });
  let clock = now;
  const intervals = [];
  for (let i = 0; i < 5; i++) {
    await f.rotate();
    const row = await f.row();
    assert.equal(row.refreshDiagnosis.failure.attemptCount, i + 1);
    const next = Date.parse(row.refreshDiagnosis.failure.nextRetryAt);
    assert.ok(next > clock && next - clock <= 120000);
    intervals.push(next - clock); clock = next;
    await f.request("/fixture/clock", "POST", { now: clock });
  }
  assert.ok(intervals[0] >= 15000 && intervals[0] <= 30000);
  assert.ok(intervals[1] >= 30000 && intervals[1] <= 60000);
  await f.configure({}); await f.request("/fixture/alarm", "POST");
  assert.equal((await f.state()).accessToken, "fixture-rotated");
  assert.equal((await f.row()).refreshDiagnosis.failure, null);
  assert.ok((await f.state()).alarm > clock);
});

for (const outcome of ["lost", "malformed"]) test(`workerd ${outcome} response fences refresh across quota, manual replacement and alarms`, { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ [outcome]: true, quota401: true });
  await f.rotate();
  assert.equal((await f.row()).refreshDiagnosis.failure.failureClass, "ambiguous");
  await f.request(f.base + "/quota-refresh", "POST");
  await f.request("/fixture/clock", "POST", { now: now + 3600000 });
  await f.request("/fixture/alarm", "POST");
  assert.equal((await f.request(f.base + "?mode=replace", "PUT", f.grant)).status, 409);
  await f.rotate(); assert.equal(await f.calls(), 1);
  assert.equal((await f.row()).refreshDiagnosis.failure.failureClass, "ambiguous");
  assert.equal((await f.request(f.base + "?mode=replace", "PUT", { ...f.grant, refreshToken: "fixture-new-login" })).status, 200);
  await f.configure({}); assert.equal((await f.rotate()).status, 200);
});

test("workerd provider success followed by a persistence failure is durable, secretless, and never replays", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({}); await f.request("/fixture/fail-write", "POST");
  assert.equal((await f.rotate()).status, 502);
  assert.equal((await f.state()).accessToken, "fixture-access");
  const row = await f.row();
  assert.equal(row.refreshDiagnosis.failure.failureClass, "provider_ok_persist_failed");
  assert.equal(row.refreshDiagnosis.lastSuccessfulRefreshAt, null);
  assert.equal(row.refreshDiagnosis.failure.nextRetryAt, null);
  await f.rotate(); assert.equal(await f.calls(), 1);
  await f.restart(); await f.rotate(); assert.equal(await f.calls(), 0);
  assert.deepEqual((await f.row()).refreshDiagnosis, row.refreshDiagnosis);
});

test("workerd abandoned pre-send fence becomes an at-risk diagnosis after owner restart without egress", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.request("/fixture/pending", "POST"); await f.restart();
  assert.equal((await f.row()).refreshDiagnosis.failure.failureClass, "ambiguous");
  await f.rotate(); await f.request("/fixture/alarm", "POST");
  assert.equal(await f.calls(), 0);
});

test("workerd stale permanent failure cannot condemn a newer durable credential", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ hold: true, status: 400, code: "invalid_grant" });
  const rotation = f.rotate(); await sent(f); await f.request("/fixture/newer", "POST"); await f.release(); assert.equal((await rotation).status, 200);
  const row = await f.row();
  assert.equal(row.credentialStatus, "active"); assert.equal(row.refreshDiagnosis, null);
  assert.equal((await f.state()).accessToken, "fixture-reconnected");
});

test("workerd OAuth provenance is issued by the callback, not forged through an admin import", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request(f.base, "PUT", { ...f.grant, credentialProvenance: "clawrouter_oauth" })).status, 200);
  assert.equal((await f.row()).credentialProvenance, "imported");
  const login = await f.request("/v1/session/login", "POST", { token: "fixture-admin" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const started = await f.request(f.base + "/authorize", "POST", { provider: "anthropic" }, { cookie });
  assert.equal(started.status, 200);
  const state = new URL((await started.json()).authorizationUrl).searchParams.get("state");
  const callback = await f.request("/v1/oauth/callback?code=fixture-code&state=" + state, "GET", undefined, { cookie });
  assert.equal(callback.status, 200, await callback.clone().text());
  assert.equal((await f.row()).credentialProvenance, "clawrouter_oauth");
  await f.rotate(); assert.equal((await f.row()).credentialProvenance, "clawrouter_oauth");
});


test("workerd removing or revoking an ambiguous token does not make its consumed fingerprint reusable", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ malformed: true }); await f.rotate();
  assert.equal((await f.request(f.base + "?mode=replace", "PUT", { ...f.grant, refreshToken: null })).status, 200);
  assert.equal((await f.request(f.base + "?mode=replace", "PUT", f.grant)).status, 409);
  assert.equal((await f.request(f.base + "/revoke", "POST")).status, 200);
  assert.equal((await f.request(f.base + "?mode=replace", "PUT", f.grant)).status, 409);
  assert.equal(await f.calls(), 1);
});


test("workerd public reconnect overlapping a refresh wins after serialized settlement", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ hold: true });
  const rotation = f.rotate(); await sent(f);
  const reconnect = f.request(f.base + "?mode=replace", "PUT", { ...f.grant, accessToken: "fixture-reconnected", refreshToken: "fixture-new-login" });
  await until(async () => (await f.request("/fixture/reconnect-started")).json(), "public reconnect did not arrive while refresh was held");
  await f.release();
  assert.equal((await rotation).status, 200);
  assert.equal((await reconnect).status, 200);
  assert.equal((await f.state()).accessToken, "fixture-reconnected");
  assert.equal((await f.row()).refreshDiagnosis, null);
  assert.equal(await f.calls(), 1);
});

for (const operation of ["import", "rotate"]) test(`workerd unmigrated raw access-only grant cannot block unrelated ${operation}`, { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.request("/fixture/raw-legacy", "POST");
  const response = operation === "rotate" ? await f.rotate() : await f.request("/v1/admin/upstream-grants/policies/new/login", "PUT", { ...f.grant, refreshToken: "fixture-independent-login" });
  assert.equal(response.status, 200, await response.clone().text());
  if (operation === "rotate") assert.equal((await f.state()).accessToken, "fixture-rotated");
});

for (const update of ["replace", "access-only"]) test(`workerd same-authority ${update} cannot bypass a provider Retry-After`, { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ status: 429, retry: "120", quota401: true });
  await f.rotate();
  const deadline = (await f.row()).refreshDiagnosis.failure.nextRetryAt;
  const response = update === "replace" ? await f.request(f.base + "?mode=replace", "PUT", f.grant)
    : await f.request(f.base, "PUT", { provider: "anthropic", kind: "subscription", accessToken: "fixture-new-access" });
  assert.equal(response.status, 200);
  await f.rotate(); await f.request(f.base + "/quota-refresh", "POST");
  assert.equal(await f.calls(), 1);
  assert.equal((await f.row()).refreshDiagnosis.failure.nextRetryAt, deadline);
});

for (const corrupt of [false, true]) test(`workerd KV-only legacy ${corrupt ? "corruption fails closed" : "refresh ownership is detected"}`, { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.request("/fixture/json-legacy", "POST", { corrupt });
  const response = await f.request("/v1/admin/upstream-grants/tenants/new/login", "PUT", { ...f.grant, refreshToken: "fixture-legacy-refresh" });
  assert.equal(response.status, corrupt ? 503 : 409);
  assert.doesNotMatch(await response.text(), /fixture-|fingerprint|[a-f0-9]{64}/);
  assert.equal(await f.calls(), 0);
});
