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
        if (name === "get") return async key => {
          if (key === "credential" && await env.POLICY_KV.get("fixture/read-armed")) {
            await env.POLICY_KV.delete("fixture/read-armed"); throw Error("fixture-private read failure");
          }
          return target.get(key);
        };
        if (name === "put") return async (key, value) => {
          if (key === "credential" && value?.accessToken === "fixture-rotated" && await env.POLICY_KV.get("fixture/fail-write") === "yes") throw new Error("fixture write failure");
          const failure = await env.POLICY_KV.get("fixture/failure");
          if (key === "refresh-result" && ["result_store", "result_and_diagnosis_write"].includes(failure)) throw Error("fixture-private result write failure");
          if (key === "credential" && value?.accessToken === "fixture-rotated" && ["credential_write", "diagnosis_write"].includes(failure)) throw Error("fixture-private credential write failure");
          if (key === "credential" && value?.refreshDiagnosis?.failure?.failureClass === "provider_ok_persist_failed" && ["diagnosis_write", "result_and_diagnosis_write", "diagnosis_only"].includes(failure)) throw Error("fixture-private diagnostic write failure");
          const result = await target.put(key, value);
          if (key === "refresh-result" && failure === "credential_read_before_claim") await env.POLICY_KV.put("fixture/read-armed", "yes");
          return result;
        };
        const value = target[name]; return typeof value === "function" ? value.bind(target) : value;
      }});
      super(new Proxy(state, { get(target, name) { if (name === "storage") return storage; const value = target[name]; return typeof value === "function" ? value.bind(target) : value; }}), env);
      this.fixtureStorage = state.storage; this.fixtureEnv = env;
    }
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/refresh-ownership/claim") {
        const input = await request.clone().json();
        if (input.token === "fixture-rotated-refresh") {
          const failure = await this.fixtureEnv.POLICY_KV.get("fixture/failure");
          if (failure === "ownership_claim") return new Response(null, { status: 503 });
          if (failure === "credential_read") await this.fixtureEnv.POLICY_KV.put("fixture/read-armed", "yes");
        }
      }
      if (path === "/fixture/clear-index") { await this.fixtureStorage.deleteAll(); return new Response("ok"); }
      if (path === "/fixture/pending") { const record = await this.fixtureStorage.get("credential"); await this.fixtureStorage.put("credential", { ...record, refreshAttempt: { id: "fixture-abandoned", generation: record.generation } }); return new Response("ok"); }
      if (path === "/fixture/stale-attempt") { const record = await this.fixtureStorage.get("credential"); await this.fixtureStorage.put("credential", { ...record, refreshAttempt: { ...record.refreshAttempt, id: "fixture-different-attempt" } }); return new Response("ok"); }
      if (path === "/fixture/state") {
        const record = await this.fixtureStorage.get("credential");
        return Response.json({ alarm: await this.fixtureStorage.getAlarm(), generation: record?.generation, accessToken: record?.accessToken, nextRefreshAttemptAt: record?.nextRefreshAttemptAt, refreshDiagnosis: record?.refreshDiagnosis, pending: !!(await this.fixtureStorage.get("refresh-result")) });
      }
      if (path === "/fixture/alarm") { await this.alarm(); return new Response("ok"); }
      // Simulates a separately committed newer generation at the durable boundary.
      // Used in addition to the public reconnect race, never as its replacement.
      if (path === "/fixture/newer") { const record = await this.fixtureStorage.get("credential"); await this.fixtureStorage.put("credential", { ...record, generation: record.generation + 1, accessToken: "fixture-reconnected", refreshToken: "fixture-new-login", refreshAttempt: null }); return new Response("ok"); }
      return super.fetch(request);
    }
  }
  export default { ...handler, async fetch(request, env, ctx) {
    env.CLAWROUTER_LOCAL_AUTH = "enabled"; env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("fixture-admin");
    const path = new URL(request.url).pathname;
    if (path === "/fixture/proxy-setup") {
      const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));
      for (const [path, body] of [
        ["/policies/initialize-all", [{ policyId: "pool", policy: { enabled: true, generation: "g1", providers: ["anthropic"], tenantId: "tenant", monthlyBudgetMicros: 10000000, retainRequestContent: false } }]],
        ["/credentials/initialize-all", [{ credentialId: "fixture", credential: { enabled: true, secretSha256: await sha256Hex("fixture-key"), policyId: "pool", policyGeneration: "g1" } }]],
        ["/connections/initialize-all", [{ providerId: "anthropic", enabled: true, monthlyBudgetMicros: 10000000 }]],
      ]) { const result = await stub.fetch("https://owner" + path, { method: "POST", body: JSON.stringify(body) }); if (!result.ok) return result; }
      return new Response("ok");
    }
    if (path === "/fixture/json-legacy") { const { corrupt } = await request.json(); await env.POLICY_KV.put("oauth/legacy/json", corrupt ? "{broken" : JSON.stringify({ provider: "anthropic", kind: "subscription", accessToken: "fixture-legacy-access", refreshToken: "fixture-legacy-refresh" })); return new Response("ok"); }
    if (path === "/fixture/raw-legacy") { await env.POLICY_KV.put("oauth/legacy/raw", "fixture-raw-access"); return new Response("ok"); }
    if (path === "/fixture/provider") return fetch("https://fixture/control", request);
    if (path === "/fixture/reconnect-started") return Response.json(reconnectStarted);
    if (path === "/v1/admin/upstream-grants/policies/pool/claude" && request.method === "PUT" && new URL(request.url).searchParams.get("mode") === "replace") reconnectStarted = true;
    if (path === "/fixture/clock") { clock = (await request.json()).now; return new Response("ok"); }
    if (path === "/fixture/failure") { const { stage } = await request.json(); if (stage) await env.POLICY_KV.put("fixture/failure", stage); else await env.POLICY_KV.delete("fixture/failure"); return new Response("ok"); }
    if (path === "/fixture/fail-write") { await env.POLICY_KV.put("fixture/fail-write", "yes"); return new Response("ok"); }
    if (path === "/fixture/quota-owner") return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName("oauth/pool/claude")).fetch("https://owner/quota-refresh", { method: "POST", body: JSON.stringify({ key: "oauth/pool/claude" }) });
    if (path === "/fixture/clear-index") return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName("clawrouter:refresh-ownership:v1")).fetch(request);
    if (["/fixture/state", "/fixture/alarm", "/fixture/newer", "/fixture/pending", "/fixture/stale-attempt"].includes(path)) return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName("oauth/pool/claude")).fetch(request);
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
      if (path.endsWith("/messages")) return Response.json({ id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "text", text: "synthetic fixture" }],
        usage: { input_tokens: 1, output_tokens: 1, speed: "standard", inference_geo: "global", service_tier: "standard" }, servedBy: request.headers.get("authorization") });
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
  return { request, base, grant, row,
    proxy: () => request("/v1/messages", "POST", { model: "anthropic/claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "synthetic fixture" }] }, { authorization: "Bearer clawrouter-live-fixture-fixture-key" }),
    state: async () => (await request("/fixture/state", "POST")).json(), configure: config => request("/fixture/provider", "POST", config), release: async () => { const response = await request("/fixture/provider", "POST", { release: true }); assert.equal((await response.json()).released, true, "provider response was held until release"); }, calls: async () => (await (await request("/fixture/provider")).json()).calls, rotate: () => request(base + "/refresh", "POST"), restart: async () => { await mf.dispose(); mf = await startWorkerdFixture(dir, router, upstream, options); }, http: () => mf.ready };
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
  assert.ok(Date.parse(row.refreshDiagnosis.failure.nextRetryAt) > now);
  assert.equal(row.refreshDiagnosis.failure.settlement.stage, "credential_write");
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

for (const stage of ["ownership_claim", "credential_read_before_claim", "credential_read", "credential_write"]) test("workerd local settlement recovers " + stage + " after owner reopen without another token exchange", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({}); await f.request("/fixture/failure", "POST", { stage });
  assert.equal((await f.rotate()).status, 502);
  const row = await f.row();
  assert.equal(row.usable, false);
  assert.equal(row.refreshDiagnosis.failure.failureClass, "provider_ok_persist_failed");
  assert.equal(row.refreshDiagnosis.failure.settlement.stage, stage === "credential_read_before_claim" ? "credential_read" : stage);
  assert.match(row.refreshDiagnosis.failure.settlement.correlationId, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(row.refreshDiagnosis.failure.nextRetryAt) > now);
  assert.equal((await f.state()).pending, true);
  await f.rotate(); assert.equal(await f.calls(), 1, "retry hold cannot send another upstream refresh");
  await f.request("/fixture/failure", "POST", {}); await f.restart();
  await f.request("/fixture/clock", "POST", { now: Date.parse(row.refreshDiagnosis.failure.nextRetryAt) });
  await f.request("/fixture/alarm", "POST");
  assert.equal((await f.state()).accessToken, "fixture-rotated");
  assert.equal((await f.state()).pending, false);
  assert.equal((await f.row()).refreshDiagnosis.failure, null);
  assert.equal((await f.row()).usable, true);
  assert.equal(await f.calls(), 0, "reopened owner settles locally, with zero token egress");
});

for (const reopen of [false, true]) test("workerd first result-retention write failure " + (reopen ? "stays fenced when the result is truly lost" : "recovers from owner memory without upstream replay"), { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.request("/fixture/failure", "POST", { stage: "result_store" });
  assert.equal((await f.rotate()).status, 502);
  const failed = await f.row();
  assert.equal(failed.refreshDiagnosis.failure.settlement.stage, "result_store");
  assert.equal((await f.state()).pending, false);
  await f.request("/fixture/failure", "POST", {});
  if (reopen) await f.restart();
  await f.request("/fixture/clock", "POST", { now: Date.parse(failed.refreshDiagnosis.failure.nextRetryAt) });
  await f.request("/fixture/alarm", "POST");
  const row = await f.row();
  assert.equal(await f.calls(), reopen ? 0 : 1);
  assert.equal(row.usable, !reopen);
  assert.equal((await f.state()).accessToken, reopen ? "fixture-access" : "fixture-rotated");
  assert.equal(row.refreshDiagnosis.failure?.nextRetryAt ?? null, null);
  if (reopen) {
    assert.equal((await f.state()).alarm, null);
    assert.equal((await f.rotate()).status, 502);
    assert.equal(await f.calls(), 0);
  }
});

for (const mutation of ["replace", "revoke", "stale-attempt"]) test("workerd retained result cannot resurrect " + mutation, { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.request("/fixture/failure", "POST", { stage: "credential_write" });
  assert.equal((await f.rotate()).status, 502);
  const retry = Date.parse((await f.row()).refreshDiagnosis.failure.nextRetryAt);
  await f.request("/fixture/failure", "POST", {});
  const response = mutation === "replace"
    ? await f.request(f.base + "?mode=replace", "PUT", { ...f.grant, accessToken: "fixture-new-access", refreshToken: "fixture-new-login", expiresAt: new Date(now + 86400000).toISOString() })
    : mutation === "revoke" ? await f.request(f.base + "/revoke", "POST") : await f.request("/fixture/stale-attempt", "POST");
  assert.equal(response.status, 200, await response.clone().text());
  await f.restart(); await f.request("/fixture/clock", "POST", { now: retry }); await f.request("/fixture/alarm", "POST");
  const state = await f.state();
  assert.equal(state.pending, false);
  assert.notEqual(state.accessToken, "fixture-rotated");
  assert.equal(await f.calls(), 0);
  if (mutation === "replace") assert.equal(state.accessToken, "fixture-new-access");
  else assert.equal((await f.row()).usable, false);
});

for (const stage of ["result_store", "ownership_claim", "credential_write"]) test("workerd pending replacement ownership rejects copies after " + stage, { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.request("/fixture/failure", "POST", { stage });
  assert.equal((await f.rotate()).status, 502);
  await f.request("/fixture/failure", "POST", {});
  const copy = await f.request("/v1/admin/upstream-grants/tenants/copy/login", "PUT", { ...f.grant, refreshToken: "fixture-rotated-refresh" });
  assert.equal(copy.status, 409);
  assert.doesNotMatch(await copy.text(), /fixture-|fingerprint|[a-f0-9]{64}/);
  assert.equal(await f.calls(), 1);
});

for (const reopen of [false, true]) test("workerd repeated interrupted diagnosis retains an autonomous settlement alarm" + (reopen ? " after reopen" : " in memory"), { timeout: 60000 }, async t => {
  const f = await fixture(t); assert.equal((await f.request("/fixture/proxy-setup", "POST")).status, 200);
  await f.request("/fixture/failure", "POST", { stage: "diagnosis_write" });
  assert.equal((await f.rotate()).status, 502);
  const interrupted = await f.state();
  assert.equal(interrupted.pending, true);
  assert.ok(interrupted.alarm > now && interrupted.alarm <= now + 120000, "retained result keeps a bounded wakeup despite diagnostic write failure");
  if (reopen) await f.restart();
  // Keep diagnosis AND installation broken over successive actual alarm-method
  // deliveries. Raw inspection cannot diagnose or rearm on the owner's behalf.
  for (let delivery = 0; delivery < 3; delivery++) {
    const clock = (await f.state()).alarm;
    await f.request("/fixture/clock", "POST", { now: clock });
    const alarm = await f.request("/fixture/alarm", "POST");
    const failed = await f.state();
    assert.ok(failed.alarm >= clock + 15000 && failed.alarm <= clock + 120000, "every failed alarm rearms a bounded future attempt");
    assert.equal(alarm.status, 200);
    assert.equal(failed.pending, true);
    assert.equal(failed.refreshDiagnosis?.failure ?? null, null, "diagnosis writes remain broken");
    assert.equal(failed.accessToken, "fixture-access");
    assert.equal(await f.calls(), reopen ? 0 : 1, "local retries never exchange another token");
  }
  await f.request("/fixture/failure", "POST", {});
  // Only raw fixture inspection and delivered alarms: no admin row read,
  // manual refresh, or materialization may diagnose/reschedule on our behalf.
  for (let attempt = 0; attempt < 2 && (await f.state()).pending; attempt++) {
    const state = await f.state();
    assert.ok(state.alarm > now);
    await f.request("/fixture/clock", "POST", { now: state.alarm });
    assert.equal((await f.request("/fixture/alarm", "POST")).status, 200);
  }
  const settled = await f.state();
  assert.equal(settled.pending, false);
  assert.equal(settled.accessToken, "fixture-rotated");
  const delivered = await f.proxy();
  assert.equal(delivered.status, 200, await delivered.clone().text());
  assert.equal((await delivered.json()).servedBy, "Bearer fixture-rotated", "ordinary pooled delivery resumes without an admin repair read");
  assert.equal(await f.calls(), reopen ? 0 : 1);
  assert.equal((await f.row()).usable, true);
});

for (const reopen of [false, true]) test("workerd interrupted result and diagnosis writes " + (reopen ? "leave truly lost credentials fenced" : "recover the live retained pair autonomously"), { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.request("/fixture/failure", "POST", { stage: "result_and_diagnosis_write" });
  assert.equal((await f.rotate()).status, 502);
  const interrupted = await f.state();
  assert.equal(interrupted.pending, false, "result write actually failed");
  assert.ok(interrupted.alarm > now && interrupted.alarm <= now + 120000);
  let nextAlarm = interrupted.alarm;
  if (!reopen) for (let delivery = 0; delivery < 3; delivery++) {
    await f.request("/fixture/clock", "POST", { now: nextAlarm });
    const alarm = await f.request("/fixture/alarm", "POST");
    const failed = await f.state();
    assert.ok(failed.alarm >= nextAlarm + 15000 && failed.alarm <= nextAlarm + 120000, "memory-only pair keeps a bounded retry across broken alarms");
    assert.equal(alarm.status, 200);
    assert.equal(failed.pending, false, "durable result writes remain broken");
    assert.equal(failed.refreshDiagnosis?.failure ?? null, null);
    assert.equal(failed.accessToken, "fixture-access");
    assert.equal(await f.calls(), 1);
    nextAlarm = failed.alarm;
  }
  await f.request("/fixture/failure", "POST", {});
  if (reopen) await f.restart();
  await f.request("/fixture/clock", "POST", { now: nextAlarm });
  assert.equal((await f.request("/fixture/alarm", "POST")).status, 200);
  if (!reopen) {
    const next = await f.state(); assert.ok(next.alarm > nextAlarm);
    await f.request("/fixture/clock", "POST", { now: next.alarm });
    assert.equal((await f.request("/fixture/alarm", "POST")).status, 200);
  }
  const settled = await f.state();
  assert.equal(settled.accessToken, reopen ? "fixture-access" : "fixture-rotated");
  assert.equal(await f.calls(), reopen ? 0 : 1);
  if (reopen) {
    assert.equal(settled.alarm, null);
    assert.equal(settled.refreshDiagnosis.failure.failureClass, "ambiguous");
    assert.equal((await f.rotate()).status, 502);
    assert.equal(await f.calls(), 0);
  } else assert.equal(settled.refreshDiagnosis.failure, null);
});

test("workerd alarm installs its retained replacement while only diagnosis persistence remains broken", { timeout: 60000 }, async t => {
  const f = await fixture(t); assert.equal((await f.request("/fixture/proxy-setup", "POST")).status, 200);
  await f.request("/fixture/failure", "POST", { stage: "diagnosis_write" });
  assert.equal((await f.rotate()).status, 502);
  const interrupted = await f.state();
  assert.equal(interrupted.pending, true);
  assert.equal(interrupted.refreshDiagnosis?.failure ?? null, null);
  await f.request("/fixture/failure", "POST", { stage: "diagnosis_only" });
  await f.request("/fixture/clock", "POST", { now: interrupted.alarm });
  const alarm = await f.request("/fixture/alarm", "POST");
  const settled = await f.state();
  assert.equal(settled.accessToken, "fixture-rotated", "diagnosis persistence cannot gate replacement installation");
  assert.equal(alarm.status, 200);
  assert.equal(settled.pending, false);
  assert.equal(settled.refreshDiagnosis.failure, null);
  const delivered = await f.proxy();
  assert.equal(delivered.status, 200, await delivered.clone().text());
  assert.equal((await delivered.json()).servedBy, "Bearer fixture-rotated");
  assert.equal(await f.calls(), 1);
});

test("workerd failed retry diagnosis retains a bounded local alarm instead of its already-due timestamp", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.request("/fixture/failure", "POST", { stage: "credential_write" });
  assert.equal((await f.rotate()).status, 502);
  const retry = (await f.state()).alarm;
  await f.request("/fixture/clock", "POST", { now: retry });
  await f.request("/fixture/failure", "POST", { stage: "diagnosis_write" });
  assert.equal((await f.rotate()).status, 502);
  const failed = await f.state();
  assert.ok(failed.alarm >= retry + 15000 && failed.alarm <= retry + 120000, "failed persistence must not make local recovery hot-loop every second");
  await f.request("/fixture/failure", "POST", {});
  await f.request("/fixture/clock", "POST", { now: failed.alarm });
  assert.equal((await f.request("/fixture/alarm", "POST")).status, 200);
  assert.equal((await f.state()).accessToken, "fixture-rotated");
  assert.equal(await f.calls(), 1);
});

// Call the actual DO entrypoint: the public admin wrapper materializes first,
// which masks this cleanup overwrite by throwing before quota-refresh is reached.
for (const collision of [false, true]) test("workerd quota-refresh preserves the latest settlement " + (collision ? "ownership stop" : "failure backoff"), { timeout: 60000 }, async t => {
  const f = await fixture(t);
  if (collision) assert.equal((await f.request("/v1/admin/upstream-grants/tenants/other/login", "PUT", { ...f.grant, refreshToken: "fixture-rotated-refresh" })).status, 200);
  await f.request("/fixture/failure", "POST", { stage: "ownership_claim" });
  assert.equal((await f.rotate()).status, 502);
  const first = await f.state();
  const retry = Date.parse(first.nextRefreshAttemptAt);
  assert.ok(retry > now);
  await f.request("/fixture/clock", "POST", { now: retry });
  if (collision) await f.request("/fixture/failure", "POST", {});
  const response = await f.request("/fixture/quota-owner", "POST");
  assert.equal(response.status, 502);
  const latest = await f.state();
  assert.equal(latest.refreshDiagnosis.failure.attemptCount, 2);
  assert.equal(latest.refreshDiagnosis.failure.settlement.code, collision ? "refresh_token_already_owned" : "refresh_ownership_unavailable");
  assert.equal(latest.nextRefreshAttemptAt, latest.refreshDiagnosis.failure.nextRetryAt);
  if (collision) { assert.equal(latest.nextRefreshAttemptAt, null); assert.equal(latest.alarm, null); }
  else { assert.ok(Date.parse(latest.nextRefreshAttemptAt) > retry); assert.equal(latest.alarm, Date.parse(latest.nextRefreshAttemptAt)); }
  assert.equal(await f.calls(), 1, "quota recovery never exchanges the consumed refresh token");
});

test("workerd replacement-token collision remains blocked and reports only the safe ownership code", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const other = await f.request("/v1/admin/upstream-grants/tenants/other/login", "PUT", { ...f.grant, refreshToken: "fixture-rotated-refresh" });
  assert.equal(other.status, 200);
  assert.equal((await f.rotate()).status, 502);
  const row = await f.row();
  assert.equal(row.refreshDiagnosis.failure.settlement.stage, "ownership_claim");
  assert.equal(row.refreshDiagnosis.failure.settlement.code, "refresh_token_already_owned");
  assert.equal(row.refreshDiagnosis.failure.nextRetryAt, null);
  assert.equal((await f.state()).alarm, null);
  assert.equal((await f.rotate()).status, 502);
  assert.equal(await f.calls(), 1);
  assert.equal((await f.row()).usable, false);
  assert.equal((await f.state()).accessToken, "fixture-access");
});
