import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const now = Date.parse("2030-01-01T00:00:00Z");
// Real admission/selection, credential owners, proxy, continuation and ledgers.
// Only time, provider egress and explicitly named storage failures are controlled.
const router = `
  import worker from "./worker/index.ts";
  export * from "./worker/index.ts";
  import { PolicyBindingIndexObject as Authority } from "./worker/authority.ts";
  import { GrantCredentialObject as Owner } from "./worker/grant-credentials.ts";
  import { resolveGrantSelection, grantRoutingPolicy } from "./worker/grant-selection.ts";
  import { sha256Hex } from "./worker/utils.ts";
  let clock = ${now}; Date.now = () => clock;
  export class PolicyBindingIndexObject extends Authority {
    constructor(state, env) { super(state, env); this.sql = state.storage.sql; }
    async fetch(request) {
      if (new URL(request.url).pathname === "/fixture/pre-routing") {
        const key = "oauth/fixture/a", row = [...this.sql.exec("SELECT projection_json FROM upstream_grant_projections WHERE grant_key = ?", key)][0];
        const projection = JSON.parse(row.projection_json); delete projection.credentialRefreshBlockedUntil;
        this.sql.exec("UPDATE upstream_grant_projections SET projection_json = ? WHERE grant_key = ?", JSON.stringify(projection), key);
        return new Response("ok");
      }
      return super.fetch(request);
    }
  }
  export class GrantCredentialObject extends Owner {
    constructor(state, env) {
      const kv = env.POLICY_KV;
      env = { ...env, POLICY_KV: new Proxy(kv, { get(target, name) {
        if (name === "put") return async (...args) => {
          if (args[0] === "oauth/fixture/a" && await target.get("fixture/fail-projection-once")) {
            await target.delete("fixture/fail-projection-once"); throw Error("fixture projection failure");
          }
          return target.put(...args);
        };
        const value = target[name]; return typeof value === "function" ? value.bind(target) : value;
      }}) };
      const storage = new Proxy(state.storage, { get(target, name) {
        if (name === "put") return async (key, value) => {
          if (key === "credential" && value?.accessToken === "fixture-rotated" && await env.POLICY_KV.get("fixture/fail-write")) throw Error("fixture persistence failure");
          return target.put(key, value);
        };
        const value = target[name]; return typeof value === "function" ? value.bind(target) : value;
      }});
      super(new Proxy(state, { get(target, name) { if (name === "storage") return storage; const value = target[name]; return typeof value === "function" ? value.bind(target) : value; }}), env);
      this.storage = state.storage; this.fixtureEnv = env;
    }
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/pre-routing") {
        const record = await this.storage.get("credential"); delete record.refreshRoutingPublished; record.poolSyncPending = false;
        await this.storage.put("credential", record); return new Response("ok");
      }
      if (path === "/fixture/revoke-after-materialize") { await this.storage.put("fixture/revoke-after-materialize", true); return new Response("ok"); }
      if (path === "/fixture/lose-on-second") { await this.storage.put("fixture/reads-before-loss", 1); return new Response("ok"); }
      if (path === "/fixture/lose-owner") { await this.storage.put("fixture/lose-owner", true); return new Response("ok"); }
      if (path === "/fixture/abandoned") { await this.storage.put("fixture/abandoned", true); return new Response("ok"); }
      if (path === "/materialize") {
        const { key } = await request.clone().json();
        await fetch("https://fixture/materialized", { method: "POST", body: JSON.stringify({ key }) });
        const remaining = await this.storage.get("fixture/reads-before-loss");
        if (remaining === 0) { await this.storage.delete("credential"); await this.storage.delete("fixture/reads-before-loss"); }
        else if (remaining !== undefined) await this.storage.put("fixture/reads-before-loss", remaining - 1);
      }
      if (path === "/materialize" && await this.storage.get("fixture/abandoned")) {
        const record = await this.storage.get("credential");
        await this.storage.put("credential", { ...record, refreshAttempt: { id: "fixture-abandoned", generation: record.generation } });
        await this.storage.delete("fixture/abandoned");
      }
      if (path === "/materialize" && await this.storage.get("fixture/lose-owner")) await this.storage.delete("credential");
      const response = await super.fetch(request);
      if (path === "/materialize" && response.ok && await this.storage.get("fixture/revoke-after-materialize")) {
        await this.storage.delete("fixture/revoke-after-materialize");
        const authority = this.fixtureEnv.ACCESS_CONTROL.get(this.fixtureEnv.ACCESS_CONTROL.idFromName("policy-bindings"));
        const revoked = await authority.fetch("https://owner/credentials/mutate", { method: "POST", body: JSON.stringify({ operation: "revoke", credentialId: "fixture", scope: "admin", actor: { auth: "admin_token", email: "fixture-admin@example.com", role: "admin" } }) });
        if ((await revoked.json()).outcome !== "updated") throw Error("fixture caller revocation failed");
      }
      return response;
    }
  }
  export default { ...worker, async fetch(request, env, ctx) {
    env.CLAWROUTER_LOCAL_AUTH = "enabled"; env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("fixture-admin");
    const path = new URL(request.url).pathname;
    if (path === "/fixture/setup") {
      const routing = await request.json();
      const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));
      for (const [path, body] of [
        ["/policies/initialize-all", [{ policyId: "fixture", policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId: "tenant", monthlyBudgetMicros: 10000000, retainRequestContent: false, grantRouting: { strategy: "threshold", ...routing } } }]],
        ["/credentials/initialize-all", [{ credentialId: "fixture", credential: { enabled: true, secretSha256: await sha256Hex("fixture-key"), policyId: "fixture", policyGeneration: "g1" } }]],
        ["/connections/initialize-all", [{ providerId: "openai", enabled: true, monthlyBudgetMicros: 10000000 }]],
      ]) { const r = await stub.fetch("https://owner" + path, { method: "POST", body: JSON.stringify(body) }); if (!r.ok) return r; }
      return new Response("ok");
    }
    if (["/fixture/lose-on-second", "/fixture/revoke-after-materialize"].includes(path)) { const { key } = await request.clone().json(); return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key)).fetch(request); }
    if (path === "/fixture/clock") { clock = (await request.json()).now; return new Response("ok"); }
    if (path === "/fixture/provider") return fetch("https://fixture/control", request);
    if (path === "/fixture/kv-selection") {
      const result = await resolveGrantSelection("openai", "fixture", "tenant", "openai", env, new Set(), grantRoutingPolicy({ strategy: "priority" }), null, false);
      return Response.json({ key: result.selected?.key ?? null });
    }
    if (path === "/fixture/fail-projection-once") { await env.POLICY_KV.put("fixture/fail-projection-once", "yes"); return new Response("ok"); }
    if (path === "/fixture/fail-write") { await env.POLICY_KV.put("fixture/fail-write", "yes"); return new Response("ok"); }
    if (path === "/fixture/pre-routing") {
      const key = "oauth/fixture/a", projection = await env.POLICY_KV.get(key, "json"); delete projection.credentialRefreshBlockedUntil;
      await env.POLICY_KV.put(key, JSON.stringify(projection));
      await env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key)).fetch(request.clone());
      return env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings")).fetch(request);
    }
    if (["/fixture/lose-owner", "/fixture/abandoned"].includes(path)) return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName("oauth/fixture/a")).fetch(request);
    return worker.fetch(request, env, ctx);
  }};
`;
const upstream = `
  let config = {}, refreshes = 0, dispatches = [], materializations = [];
  export default { async fetch(request) {
    if (new URL(request.url).pathname === "/control") { if (request.method === "POST") { config = await request.json(); if (config.reset) { refreshes = 0; dispatches = []; materializations = []; } } return Response.json({ refreshes, dispatches, materializations }); }
    if (new URL(request.url).pathname === "/materialized") { materializations.push((await request.json()).key); return new Response("ok"); }
    if (new URL(request.url).pathname.endsWith("/token")) {
      refreshes++;
      if (config.malformed) return new Response("fixture-invalid-response");
      if (config.status) return Response.json({ error: config.code ?? "server_error" }, { status: config.status, headers: config.retry ? { "retry-after": config.retry } : {} });
      return Response.json({ access_token: "fixture-rotated", refresh_token: "fixture-next-refresh", expires_in: 3600 });
    }
    const credential = request.headers.get("authorization"); dispatches.push(credential);
    if (config.dispatchStatus && credential !== config.healthy) return Response.json({ error: { message: "fixture rejection" } }, { status: config.dispatchStatus });
    return Response.json({ id: "resp_fixture_" + dispatches.length, object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, servedBy: credential });
  }};
`;
async function fixture(t, { second = true, routing = {}, expiresAt = now - 1000, hotCache = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "clawrouter-refresh-routing-"));
  const mf = await startWorkerdFixture(dir, router, upstream, { hotCache });
  t.after(async () => { await mf.dispose(); await rm(dir, { recursive: true, force: true }); });
  const request = (path, method = "GET", body, proxy = false) => mf.dispatchFetch("https://router.example" + path, {
    method, headers: { authorization: proxy ? "Bearer clawrouter-live-fixture-fixture-key" : "Bearer fixture-admin", "content-type": "application/json", origin: "https://router.example" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await request("/fixture/setup", "POST", routing)).status, 200);
  const base = "/v1/admin/upstream-grants/policies/fixture/";
  const grant = { provider: "openai", kind: "oauth", accessToken: "fixture-a", refreshToken: "fixture-refresh-a", expiresAt: new Date(expiresAt).toISOString() };
  const put = await request(base + "a", "PUT", grant); assert.equal(put.status, 200, await put.clone().text());
  if (second) assert.equal((await request(base + "b", "PUT", { ...grant, accessToken: "fixture-b", refreshToken: "fixture-refresh-b", expiresAt: new Date(now + 7200000).toISOString() })).status, 200);
  return { request, base, grant, configure: config => request("/fixture/provider", "POST", config), stats: async () => (await request("/fixture/provider")).json(),
    row: async () => (await (await request("/v1/admin/upstream-grants")).json()).grants.find(g => g.tokenRef === "a"),
    rotate: () => request(base + "a/refresh", "POST"),
    proxy: body => request("/v1/responses", "POST", { model: "openai/gpt-6-astra", input: "synthetic fixture", max_output_tokens: 16, ...body }, true),
  };
}
async function served(response, token = "fixture-b") { assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).servedBy, "Bearer " + token); }

for (const failure of ["ambiguous", "at-risk", "transient", "persist", "permanent", "missing"]) test(`real pooled pre-dispatch ${failure} failure serves the healthy alternate`, { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.configure(failure === "ambiguous" ? { malformed: true } : failure === "transient" ? { status: 503 } : failure === "permanent" ? { status: 400, code: "invalid_grant" } : {});
  if (failure === "persist") await f.request("/fixture/fail-write", "POST");
  if (failure === "at-risk") await f.request("/fixture/abandoned", "POST");
  if (failure === "missing") await f.request("/fixture/lose-owner", "POST");
  const response = await f.proxy(); await served(response);
  assert.equal(response.headers.get("x-clawrouter-grant-failover"), "1");
  assert.deepEqual((await f.stats()).dispatches, ["Bearer fixture-b"]);
});

for (const failure of ["ambiguous", "transient", "persist"]) test(`known ${failure} projection is excluded without losing diagnosis or marking permanent reauth`, { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.configure(failure === "ambiguous" ? { malformed: true } : failure === "transient" ? { status: 503 } : {});
  if (failure === "persist") await f.request("/fixture/fail-write", "POST");
  assert.equal((await f.rotate()).status, 502);
  await served(await f.proxy()); await served(await f.proxy());
  const after = await f.row();
  assert.equal(after.selectedCount, 0, "blocked grant must not even be selected; no admin inspection repairs it first");
  assert.equal(after.credentialStatus, "active"); assert.equal(after.usable, false);
  assert.equal(after.refreshDiagnosis.failure.failureClass, failure === "persist" ? "provider_ok_persist_failed" : failure);
  assert.equal((await f.stats()).refreshes, 1);
});

test("future retry-held credential becomes ineligible at refresh margin without another owner publication", { timeout: 60000 }, async t => {
  const f = await fixture(t, { expiresAt: now + 600000 }); await f.configure({ status: 503, retry: "600" }); await f.rotate();
  await served(await f.proxy(), "fixture-a");
  await f.request("/fixture/clock", "POST", { now: now + 300000 });
  await served(await f.proxy()); assert.equal((await f.stats()).refreshes, 1);
});

for (const routing of [{}, { failover: false }]) test(`pre-dispatch failure preserves original error with ${routing.failover === false ? "failover disabled" : "no alternate"}`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { second: routing.failover === false, routing }); await f.configure({ status: 503 });
  const response = await f.proxy(); assert.equal(response.status, 502); assert.equal((await response.json()).error.code, "grant_refresh_failed");
  assert.deepEqual((await f.stats()).dispatches, []);
});

test("pre-dispatch and response rejections share a bounded no-repeat grant budget", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ status: 503, dispatchStatus: 429 });
  assert.equal((await f.request(f.base + "c", "PUT", { ...f.grant, accessToken: "fixture-c", refreshToken: "fixture-refresh-c", expiresAt: new Date(now + 7200000).toISOString() })).status, 200);
  assert.equal((await f.proxy()).status, 429);
  assert.deepEqual((await f.stats()).dispatches, ["Bearer fixture-b", "Bearer fixture-c"]);
  assert.equal((await f.row()).selectedCount, 1);
});

for (const recovery of ["refresh", "replacement"]) test(`blocked grant re-enters selection after ${recovery}`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy: "priority" } });
  await f.request(f.base + "b", "PUT", { provider: "openai", kind: "oauth", priority: 200 });
  await f.configure(recovery === "refresh" ? { status: 503 } : { malformed: true }); await f.rotate();
  await served(await f.proxy());
  if (recovery === "refresh") {
    const deadline = Date.parse((await f.row()).refreshDiagnosis.failure.nextRetryAt);
    await f.request("/fixture/clock", "POST", { now: deadline }); await f.configure({});
    await served(await f.proxy(), "fixture-rotated");
  } else {
    const response = await f.request(f.base + "a?mode=replace", "PUT", { ...f.grant, accessToken: "fixture-replaced", refreshToken: "fixture-new-login", expiresAt: new Date(now + 7200000).toISOString() });
    assert.equal(response.status, 200); await served(await f.proxy(), "fixture-replaced");
  }
  const row = await f.row(); assert.equal(row.usable, true); assert.equal(row.refreshDiagnosis?.failure ?? null, null);
});

test("pinned continuation never switches to a healthy alternate after its owner refresh fails", { timeout: 60000 }, async t => {
  const f = await fixture(t, { expiresAt: now + 600000 });
  const first = await f.proxy(); assert.equal(first.status, 200); const body = await first.json(); assert.equal(body.servedBy, "Bearer fixture-a");
  await f.request("/fixture/clock", "POST", { now: now + 600000 }); await f.configure({ status: 503 });
  const next = await f.proxy({ previous_response_id: body.id });
  assert.equal(next.status, 409); assert.equal((await next.json()).error.code, "continuation_restart_required");
  assert.deepEqual((await f.stats()).dispatches, ["Bearer fixture-a"]);
});

for (const environmentFallback of [false, true]) test(`known blocked pool respects environmentFallback=${environmentFallback}`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { second: false, routing: { environmentFallback } });
  await f.configure({ malformed: true }); await f.rotate();
  const response = await f.proxy();
  if (environmentFallback) await served(response, "fixture-upstream-key");
  else { assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "upstream_grant_pool_unavailable"); assert.deepEqual((await f.stats()).dispatches, []); }
});

test("failed alternate preparation surfaces the original credential failure, not its replacement error", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.request(f.base + "b", "PUT", { provider: "openai", kind: "oauth", expiresAt: new Date(now - 1000).toISOString() });
  await f.request("/fixture/abandoned", "POST"); await f.configure({ status: 503 });
  const response = await f.proxy(); assert.equal(response.status, 502); assert.equal((await response.json()).error.code, "grant_refresh_at_risk");
  assert.deepEqual((await f.stats()).dispatches, []); assert.equal((await f.stats()).refreshes, 1);
});

test("uncertain refresh blocks a future-dated access credential immediately", { timeout: 60000 }, async t => {
  const f = await fixture(t, { expiresAt: now + 7200000 }); await f.configure({ malformed: true }); await f.rotate();
  await served(await f.proxy()); assert.equal((await f.row()).selectedCount, 0);
});

test("fusion reservation carries consumed preflight failover into synthesizer dispatch", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.configure({ status: 503, dispatchStatus: 429 });
  assert.equal((await f.request(f.base + "c", "PUT", { ...f.grant, accessToken: "fixture-c", refreshToken: "fixture-refresh-c", expiresAt: new Date(now + 7200000).toISOString() })).status, 200);
  // The local adviser is intentionally unauthorized by this OpenAI-only policy;
  // its failure leaves the real synthesizer reservation/dispatch path intact.
  assert.equal((await f.request("/v1/admin/fusion", "PUT", { enabled: true, adviserModels: ["local/qwen3:8b"], aggregatorModel: "openai/gpt-4.1-mini" })).status, 200);
  const response = await f.request("/v1/chat/completions", "POST", { model: "clawrouter/fusion", messages: [{ role: "user", content: "synthetic fixture" }], max_tokens: 16 }, true);
  assert.equal(response.status, 429, await response.clone().text());
  assert.deepEqual((await f.stats()).dispatches, ["Bearer fixture-b", "Bearer fixture-c"]);
});

for (const failure of ["ambiguous", "persist", "transient"]) test(`upgrade republishes previously settled ${failure} routing blocks even with failover disabled`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy: "priority", failover: false } });
  await f.request(f.base + "b", "PUT", { provider: "openai", kind: "oauth", priority: 200 });
  await f.configure(failure === "ambiguous" ? { malformed: true } : failure === "transient" ? { status: 503 } : {});
  if (failure === "persist") await f.request("/fixture/fail-write", "POST");
  assert.equal((await f.rotate()).status, 502);
  // Emulate the exact pre-availability persisted shape: recognized diagnosis,
  // no pending publication, and no block in either secretless routing index.
  assert.equal((await f.request("/fixture/pre-routing", "POST")).status, 200);
  assert.equal((await f.proxy()).status, 502, "first stale projection reaches its existing owner");
  await served(await f.proxy()); await served(await f.proxy());
  assert.equal((await (await f.request("/fixture/kv-selection")).json()).key, "oauth/fixture/b", "KV selection is repaired as well as optimized admission");
  assert.equal((await f.row()).selectedCount, 1, "old blocked projection is repaired once, not selected forever");
  assert.equal((await f.stats()).refreshes, 1);
});

for (const failure of ["ambiguous", "persist"]) test(`pinned ${failure} credential failure signals a full-input restart without switching owners`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { expiresAt: now + 600000 });
  const first = await f.proxy(); assert.equal(first.status, 200); const original = await first.json();
  if (failure === "ambiguous") { await f.configure({ malformed: true }); await f.rotate(); }
  else { await f.request("/fixture/fail-write", "POST"); await f.request("/fixture/clock", "POST", { now: now + 600000 }); }
  const response = await f.proxy({ previous_response_id: original.id });
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "continuation_restart_required");
  assert.deepEqual((await f.stats()).dispatches, ["Bearer fixture-a"]);
});

test("upgrade retries a lost KV projection write rather than acknowledging a partial migration", { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy: "priority", failover: false } });
  await f.configure({ malformed: true }); await f.rotate();
  await f.request("/fixture/pre-routing", "POST"); await f.request("/fixture/fail-projection-once", "POST");
  assert.equal((await f.proxy()).status, 500, "projection publication failed after authoritative index committed");
  assert.equal((await (await f.request("/fixture/kv-selection")).json()).key, "oauth/fixture/a", "KV still has the old routing shape");
  const row = await f.row(); assert.equal(row.usable, false, "an owner read retries unacknowledged migration");
  assert.equal((await (await f.request("/fixture/kv-selection")).json()).key, "oauth/fixture/b");
  await served(await f.proxy()); assert.equal((await f.stats()).refreshes, 1);
});

test("newly diagnosed abandoned refresh publishes its block to KV before returning the credential error", { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy: "priority", failover: false } });
  await f.request("/fixture/abandoned", "POST");
  const response = await f.proxy(); assert.equal(response.status, 502); assert.equal((await response.json()).error.code, "grant_refresh_at_risk");
  assert.equal((await (await f.request("/fixture/kv-selection")).json()).key, "oauth/fixture/b");
  await served(await f.proxy()); assert.equal((await f.row()).selectedCount, 1); assert.equal((await f.stats()).refreshes, 0);
});

test("recovery keeps publication pending until the fresh credential reaches KV as well as authority", { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy: "priority" } });
  await f.configure({ malformed: true }); await f.rotate();
  await f.request("/fixture/fail-projection-once", "POST");
  const replace = await f.request(f.base + "a?mode=replace", "PUT", { ...f.grant, accessToken: "fixture-replaced", refreshToken: "fixture-new-login", expiresAt: new Date(now + 7200000).toISOString() });
  assert.equal(replace.status, 500);
  assert.equal((await (await f.request("/fixture/kv-selection")).json()).key, "oauth/fixture/b", "old KV still excludes A");
  assert.equal((await f.row()).usable, true);
  assert.equal((await (await f.request("/fixture/kv-selection")).json()).key, "oauth/fixture/a", "owner read retries the pending recovery publication");
  await served(await f.proxy(), "fixture-replaced");
});

for (const shape of ["unchanged", "moved-to-credential"]) test(`removing refresh authority cannot revive ${shape} uncertain access credentials`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy: "priority" }, expiresAt: now + 7200000 });
  await f.request(f.base + "b", "PUT", { provider: "openai", kind: "oauth", priority: 200 });
  await f.configure({ malformed: true }); await f.rotate();
  const diagnosis = (await f.row()).refreshDiagnosis;
  const replacement = shape === "unchanged" ? { ...f.grant, refreshToken: null }
    : { ...f.grant, refreshToken: null, accessToken: null, credential: f.grant.accessToken };
  const removed = await f.request(f.base + "a?mode=replace", "PUT", replacement);
  assert.equal(removed.status, 200);
  const row = await removed.json(); assert.equal(row.usable, false); assert.deepEqual(row.refreshDiagnosis, diagnosis);
  await served(await f.proxy());
  assert.equal((await f.row()).selectedCount, 0);
  const fresh = await f.request(f.base + "a?mode=replace", "PUT", { ...f.grant, accessToken: "fixture-fresh-access", refreshToken: null });
  assert.equal(fresh.status, 200); assert.equal((await fresh.json()).usable, true);
  await served(await f.proxy(), "fixture-fresh-access");
});

for (const failure of ["ambiguous", "permanent"]) test(`${failure} removal preserves failed authorization until a fresh access-only incremental update`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy: "priority" }, expiresAt: now + 7200000 });
  await f.request(f.base + "b", "PUT", { provider: "openai", kind: "oauth", priority: 200 });
  await f.configure(failure === "ambiguous" ? { malformed: true } : { status: 400, code: "invalid_grant" }); await f.rotate();
  const before = await f.row();
  const removed = await f.request(f.base + "a?mode=replace", "PUT", { ...f.grant, refreshToken: null });
  assert.equal(removed.status, 200); const blocked = await removed.json();
  assert.equal(blocked.usable, false); assert.equal(blocked.credentialStatus, before.credentialStatus); assert.deepEqual(blocked.refreshDiagnosis, before.refreshDiagnosis);
  await served(await f.proxy());
  const updated = await f.request(f.base + "a", "PUT", { provider: "openai", kind: "oauth", accessToken: "fixture-fresh-incremental", expiresAt: new Date(now + 7200000).toISOString() });
  assert.equal(updated.status, 200); const recovered = await updated.json(); assert.equal(recovered.usable, true); assert.equal(recovered.credentialStatus, "active"); assert.equal(recovered.refreshDiagnosis, null);
  await served(await f.proxy(), "fixture-fresh-incremental");
});

for (const phase of ["preparation", "response", "mixed"]) test(`bounded pool traversal reaches the fourth eligible account after ${phase} failures`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy: "priority" }, expiresAt: phase === "response" ? now + 7200000 : now - 1000 });
  for (const [index, name] of ["b", "c", "d"].entries()) {
    const expiresAt = phase === "preparation" && name !== "d" ? now - 1000 : now + 7200000;
    assert.equal((await f.request(f.base + name, "PUT", { ...f.grant, accessToken: "fixture-" + name, refreshToken: "fixture-refresh-" + name, priority: 101 + index, expiresAt: new Date(expiresAt).toISOString() })).status, 200);
  }
  await f.configure({ status: 503, dispatchStatus: 429, healthy: "Bearer fixture-d" });
  await served(await f.proxy(), "fixture-d");
  const stats = await f.stats();
  assert.equal(stats.refreshes, phase === "preparation" ? 3 : phase === "mixed" ? 1 : 0);
  assert.deepEqual(stats.dispatches, (phase === "preparation" ? ["d"] : phase === "mixed" ? ["b", "c", "d"] : ["a", "b", "c", "d"]).map(name => "Bearer fixture-" + name));
});

test("pool traversal stops after four distinct failed accounts without enabling environment fallback", { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy: "priority" }, expiresAt: now + 7200000 });
  for (const [index, name] of ["b", "c", "d", "e"].entries()) assert.equal((await f.request(f.base + name, "PUT", { ...f.grant, accessToken: "fixture-" + name, refreshToken: "fixture-refresh-" + name, priority: 101 + index, expiresAt: new Date(now + 7200000).toISOString() })).status, 200);
  await f.configure({ dispatchStatus: 429, healthy: "Bearer fixture-e" });
  const response = await f.proxy(); assert.equal(response.status, 429); assert.match(await response.text(), /fixture rejection/);
  assert.deepEqual((await f.stats()).dispatches, ["a", "b", "c", "d"].map(name => "Bearer fixture-" + name));
});

for (const strategy of ["round_robin", "least_used"]) test("healthy fusion selects once at reservation using " + strategy, { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy, stickiness: "none" }, expiresAt: now + 7200000 });
  await served(await f.proxy(), "fixture-a"); // Real selection makes B the next policy choice, not first eligible A.
  const counts = async () => (await (await f.request("/v1/admin/upstream-grants")).json()).grants
    .map(({ tokenRef, selectedCount }) => [tokenRef, selectedCount]).sort();
  assert.deepEqual(await counts(), [["a", 1], ["b", 0]]);
  await f.configure({ reset: true });
  assert.equal((await f.request("/v1/admin/fusion", "PUT", { enabled: true, adviserModels: ["local/qwen3:8b"], aggregatorModel: "openai/gpt-4.1-mini" })).status, 200);
  const response = await f.request("/v1/chat/completions", "POST", { model: "clawrouter/fusion", messages: [{ role: "user", content: "synthetic fixture" }], max_tokens: 16 }, true);
  const stats = await f.stats();
  assert.equal(stats.materializations[0], "oauth/fixture/b", "reservation must apply the configured policy before materializing an owner");
  await served(response, "fixture-b");
  assert.deepEqual(stats.materializations, ["oauth/fixture/b", "oauth/fixture/b"], "dispatch revalidates the reserved owner without selecting another");
  assert.deepEqual(stats.dispatches, ["Bearer fixture-b"]);
  assert.equal(stats.refreshes, 0);
  assert.deepEqual(await counts(), [["a", 1], ["b", 1]], "reservation and dispatch record one selection, not two");
  await served(await f.proxy(), "fixture-a");
  assert.deepEqual(await counts(), [["a", 2], ["b", 1]], "subsequent routing sees the single completed selection");
});

for (const mode of ["divergent-response", "divergent-mixed", "reuse", "reuse-at-cap"]) test("fusion counts successful reservation materialization in its four-grant budget: " + mode, { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy: "round_robin", stickiness: "none" }, expiresAt: mode === "reuse-at-cap" ? now - 1000 : now + 7200000 });
  for (const name of ["b", "c", "d", "e"]) assert.equal((await f.request(f.base + name, "PUT", { ...f.grant, accessToken: "fixture-" + name, refreshToken: "fixture-refresh-" + name,
    expiresAt: new Date((mode === "divergent-mixed" && name === "c" || mode === "reuse-at-cap" && ["b", "c"].includes(name)) ? now - 1000 : now + 7200000).toISOString() })).status, 200);
  if (mode.startsWith("divergent")) await served(await f.proxy(), "fixture-a"); // real round-robin cursor advances to B
  await f.configure({ reset: true, status: 503, dispatchStatus: 429, healthy: "Bearer fixture-" + (mode.startsWith("reuse") ? "d" : "a") });
  assert.equal((await f.request("/v1/admin/fusion", "PUT", { enabled: true, adviserModels: ["local/qwen3:8b"], aggregatorModel: "openai/gpt-4.1-mini" })).status, 200);
  const response = await f.request("/v1/chat/completions", "POST", { model: "clawrouter/fusion", messages: [{ role: "user", content: "synthetic fixture" }], max_tokens: 16 }, true);
  const stats = await f.stats();
  const attempted = mode.startsWith("divergent") ? ["b", "c", "d", "e"] : ["a", "b", "c", "d"];
  assert.equal(stats.materializations[0], "oauth/fixture/" + attempted[0], "reservation follows the real routing cursor");
  assert.deepEqual([...new Set(stats.materializations)], attempted.map(name => "oauth/fixture/" + name), "no fifth credential owner is touched, including wraparound to A");
  assert.equal(response.status, mode.startsWith("reuse") ? 200 : 429, await response.clone().text());
  assert.deepEqual(stats.dispatches, (mode === "reuse-at-cap" ? ["d"] : mode === "divergent-mixed" ? ["b", "d", "e"] : attempted).map(name => "Bearer fixture-" + name));
  assert.equal(stats.refreshes, mode === "reuse-at-cap" ? 3 : mode === "divergent-mixed" ? 1 : 0);
  const grants = (await (await f.request("/v1/admin/upstream-grants")).json()).grants;
  for (const row of grants) assert.equal(row.selectedCount, attempted.includes(row.tokenRef) || mode.startsWith("divergent") && row.tokenRef === "a" ? 1 : 0, "each distinct attempted owner is recorded once: " + row.tokenRef);
  if (mode === "reuse-at-cap") assert.deepEqual(stats.materializations.slice(-2), ["oauth/fixture/d", "oauth/fixture/d"], "a successful fourth owner is legitimately reused");
});

for (const hotCache of [false, true]) test("fusion reuse retains caller revocation checks after reservation failover, hotCache=" + hotCache, { timeout: 60000 }, async t => {
  const f = await fixture(t, { hotCache }); await f.configure({ status: 503 });
  // A fails; successful reservation materialization of B revokes the caller.
  assert.equal((await f.request("/fixture/revoke-after-materialize", "POST", { key: "oauth/fixture/b" })).status, 200);
  assert.equal((await f.request("/v1/admin/fusion", "PUT", { enabled: true, adviserModels: ["local/qwen3:8b"], aggregatorModel: "openai/gpt-4.1-mini" })).status, 200);
  const response = await f.request("/v1/chat/completions", "POST", { model: "clawrouter/fusion", messages: [{ role: "user", content: "synthetic fixture" }], max_tokens: 16 }, true);
  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, "proxy_key_revoked");
  const stats = await f.stats();
  assert.deepEqual(stats.materializations, ["oauth/fixture/a", "oauth/fixture/b"], "caller is revalidated before reusing the reserved credential");
  assert.deepEqual(stats.dispatches, []); assert.equal(stats.refreshes, 1);
});

for (const full of [false, true]) test("fusion reserved credential failure " + (full ? "cannot open a fifth account" : "uses the remaining failover budget"), { timeout: 60000 }, async t => {
  const f = await fixture(t, { routing: { strategy: "priority" }, expiresAt: full ? now - 1000 : now + 7200000 });
  for (const [index, name] of ["b", "c", "d", "e"].entries()) assert.equal((await f.request(f.base + name, "PUT", { ...f.grant, accessToken: "fixture-" + name, refreshToken: "fixture-refresh-" + name,
    priority: 101 + index, expiresAt: new Date(full && ["b", "c"].includes(name) ? now - 1000 : now + 7200000).toISOString() })).status, 200);
  assert.equal((await f.request("/fixture/lose-on-second", "POST", { key: "oauth/fixture/" + (full ? "d" : "a") })).status, 200);
  await f.configure({ status: 503 });
  assert.equal((await f.request("/v1/admin/fusion", "PUT", { enabled: true, adviserModels: ["local/qwen3:8b"], aggregatorModel: "openai/gpt-4.1-mini" })).status, 200);
  const response = await f.request("/v1/chat/completions", "POST", { model: "clawrouter/fusion", messages: [{ role: "user", content: "synthetic fixture" }], max_tokens: 16 }, true);
  if (full) { assert.equal(response.status, 404); assert.equal((await response.json()).error.code, "grant_credential_missing"); }
  else await served(response, "fixture-b");
  const stats = await f.stats();
  assert.deepEqual(stats.materializations, (full ? ["a", "b", "c", "d", "d"] : ["a", "a", "b"]).map(name => "oauth/fixture/" + name));
  assert.deepEqual(stats.dispatches, full ? [] : ["Bearer fixture-b"]);
  assert.equal(stats.refreshes, full ? 3 : 0);
});
