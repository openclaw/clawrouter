import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { GrantCredentialObject, backfillGrantAttachment, materializeGrantCredentials, putGrantCredentials, reconcileGrantAttachment, revokeGrantCredentials } from "../grant-credentials.ts";
import { providerById, upstreamAuth } from "../providers.ts";
import { authorityCall } from "../authority.ts";
import { acceptGrantPoolBaseline, recoverGrantPools } from "../../scripts/grant-pool-recovery.mjs";
const { default: worker } = await import("../index.ts");

const primary = { provider: "openai", kind: "api_key", enabled: true, credential: "account-fixture" };
const key = "oauth/policy/account";
const identity = { policyId: "policy", policy: { enabled: true, providers: ["openai"], tenantId: "tenant" } };

test("empty and stale KV cannot authorize activation without an explicit current baseline", async () => {
  const env = fixture();
  await assert.rejects(() => recoverGrantPools({ request: env.request }), /baseline is not accepted/);
  for (const action of ["scan", "activate"]) await assert.rejects(() => env.request(`/v1/admin/grant-pools/${action}`, { method: "POST", body: { revision: 0 } }), error => error.status === 409);
  await assert.rejects(() => env.request("/v1/admin/grant-pools/baseline", { method: "POST", body: { revision: 0, baseline: "fresh" } }), error => error.status === 400);
  await acceptGrantPoolBaseline("fresh", { request: env.request });
  await assert.rejects(() => env.request("/v1/admin/grant-pools/baseline", { method: "POST", body: { revision: 0, baseline: "existing", confirmed: true } }), error => error.status === 409);
  const active = await recoverGrantPools({ request: env.request });
  assert.ok(active.activatedAt);
  const again = await recoverGrantPools({ request: env.request });
  assert.equal(again.revision, active.revision, "routine deploy never reaccepts or reactivates baseline");
});

test("ordinary repair stays unattached; explicit baseline backfill preserves account lineage and secrets", async () => {
  const env = fixture();
  env.values.set(key, primary);
  await materializeGrantCredentials(env, key, primary, "openai", null, false);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), before = owner.values.get("credential");
  assert.equal((await reconcileGrantAttachment(env, key)).outcome, "unattached");
  await assert.rejects(() => backfillGrantAttachment(env, key), error => error.status === 409);
  await acceptGrantPoolBaseline("existing", { request: env.request });
  const active = await recoverGrantPools({ request: env.request });
  assert.ok(active.activatedAt);
  const after = owner.values.get("credential");
  assert.equal(after.generation, before.generation + 1);
  assert.equal(after.lineage, before.lineage);
  assert.equal(after.credential, before.credential);
  assert.equal(typeof after.poolAdmissionRevision, "number");
  assert.equal((await pool(env)).hasAttachment, true);
});

test("paused named canonical owners omitted from the legacy index backfill beyond active capacity", async () => {
  const env = fixture();
  for (let i = 0; i < 40; i++) {
    const pausedKey = `oauth/policy/paused-${String(i).padStart(2, "0")}`;
    const paused = { ...primary, enabled: false };
    env.values.set(pausedKey, paused);
    await assert.rejects(() => materializeGrantCredentials(env, pausedKey, paused, "openai", null, false));
  }
  for (let i = 0; i < 32; i++) await putGrantCredentials(env, `oauth/policy/active-${i}`, primary);
  await acceptGrantPoolBaseline("existing", { request: env.request });
  await recoverGrantPools({ request: env.request });
  assert.equal((await pool(env)).keys.length, 32);
  assert.equal(env.grantAuthority.sql.exec("SELECT count(*) AS count FROM upstream_grant_pool_members WHERE status = 'paused'")[0].count, 40);
});

test("backfill generation exhaustion fails before admission without resetting owner fences", async () => {
  const env = fixture();
  env.values.set(key, primary);
  await materializeGrantCredentials(env, key, primary, "openai", null, false);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), record = owner.values.get("credential");
  record.generation = Number.MAX_SAFE_INTEGER - 1;
  await reconcileGrantAttachment(env, key);
  await acceptGrantPoolBaseline("existing", { request: env.request });
  await env.request("/v1/admin/grant-pools/scan", { method: "POST", body: { revision: (await status(env)).revision } });
  const before = await env.grantAuthority.call("attachment", { key });
  await assert.rejects(() => backfillGrantAttachment(env, key), error => error.code === "grant_generation_exhausted");
  assert.deepEqual(await env.grantAuthority.call("attachment", { key }), before);
  assert.equal(owner.values.get("credential").generation, record.generation);
});

test("raw-only legacy records stay unresolved until the established authenticated replace or revoke", async () => {
  const env = fixture();
  env.values.set(key, "legacy-raw-fixture");
  await acceptGrantPoolBaseline("existing", { request: env.request });
  await assert.rejects(() => recoverGrantPools({ request: env.request }), /cf:oauth:put/);
  const state = await status(env);
  assert.deepEqual(state.issues, [{ key, reason: "owner_missing" }]);
  assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.has("credential"), false);
  await env.request("/v1/admin/upstream-grants/policies/policy/account?mode=replace", { method: "PUT", body: primary });
  await recoverGrantPools({ request: env.request });
  assert.ok((await status(env)).activatedAt);
});

test("a missing KV value never clears ambiguous indexed legacy evidence", async () => {
  const env = fixture();
  env.grantAuthority.seedLegacy(key, "openai");
  await acceptGrantPoolBaseline("existing", { request: env.request });
  await assert.rejects(() => recoverGrantPools({ request: env.request }), /unresolved/);
  assert.deepEqual((await status(env)).issues, [{ key, reason: "identity_unresolved" }]);
  assert.equal((await pool(env)).hasAttachment, true);
});

test("indexed first-admission repair cancels only its proven proposal, without provider I/O", async context => {
  const env = fixture();
  context.mock.method(globalThis, "fetch", async () => assert.fail("recovery contacted an upstream"));
  env.GRANT_CREDENTIALS.get(key);
  env.GRANT_CREDENTIALS.objects.get(key).state.storage.put = async () => { throw new Error("owner write failed"); };
  await assert.rejects(() => putGrantCredentials(env, key, primary));
  await acceptGrantPoolBaseline("existing", { request: env.request });
  await recoverGrantPools({ request: env.request });
  assert.equal((await pool(env)).hasAttachment, false);
});

test("owner read failure remains unresolved and does not delete pending admission", async () => {
  const env = fixture();
  await env.grantAuthority.call("admit", { key, provider: "openai", status: "active", generation: 0, revision: 0 });
  env.GRANT_CREDENTIALS.get(key);
  env.GRANT_CREDENTIALS.objects.get(key).state.storage.get = async () => { throw new Error("unknown owner state"); };
  await acceptGrantPoolBaseline("existing", { request: env.request });
  await assert.rejects(() => recoverGrantPools({ request: env.request }), /unresolved/);
  assert.equal((await status(env)).issues[0].reason, "owner_unavailable");
  assert.equal((await env.grantAuthority.call("attachment", { key })).pending, true);
});

test("scan progress survives interruption, empty intermediate KV pages and stale page replay", async () => {
  const env = fixture();
  await acceptGrantPoolBaseline("existing", { request: env.request });
  const scan = await env.request("/v1/admin/grant-pools/scan", { method: "POST", body: { revision: (await status(env)).revision } });
  const list = env.POLICY_KV.list;
  env.POLICY_KV.list = async options => options.prefix === "oauth/" && !options.cursor ? { keys: [], list_complete: false, cursor: "empty-page" } : list({ ...options, cursor: undefined });
  const body = { scanRevision: scan.scanRevision, phase: scan.phase, cursor: scan.cursor };
  const page = await env.request("/v1/admin/grant-pools/advance", { method: "POST", body });
  assert.equal(page.readiness.phase, "kv");
  assert.equal(page.readiness.cursor, "empty-page");
  await assert.rejects(() => env.request("/v1/admin/grant-pools/advance", { method: "POST", body }), error => error.status === 409);
  assert.ok((await recoverGrantPools({ request: env.request })).activatedAt);
});

test("concurrent account mutation fences completed scans and stale activation", async () => {
  const env = fixture();
  await acceptGrantPoolBaseline("existing", { request: env.request });
  const completed = await completeScan(env);
  await putGrantCredentials(env, key, primary);
  await assert.rejects(() => env.request("/v1/admin/grant-pools/activate", { method: "POST", body: { revision: completed.revision } }), error => error.status === 409);
  await assert.rejects(async () => env.request("/v1/admin/grant-pools/activate", { method: "POST", body: { revision: (await status(env)).revision } }), error => error.status === 409);
  assert.ok((await recoverGrantPools({ request: env.request })).activatedAt);
});

test("bounded unresolved pages advance past the first prefix and overflow cannot activate", async () => {
  const env = fixture();
  for (let i = 0; i < 70; i++) env.values.set(`oauth/policy/raw-${String(i).padStart(2, "0")}`, "legacy-fixture");
  await acceptGrantPoolBaseline("existing", { request: env.request });
  await assert.rejects(() => recoverGrantPools({ request: env.request }), /unresolved/);
  const state = await status(env);
  assert.equal(state.phase, "complete");
  assert.equal(state.scanned, 70);
  assert.equal(state.issues.length, 64);
  assert.equal(state.overflow, true);
  await assert.rejects(() => env.request("/v1/admin/grant-pools/activate", { method: "POST", body: { revision: state.revision } }), error => error.status === 409);
});

for (const ref of ["openai", "named-account"]) test(`activated ${ref} pause blocks environment fallback until explicit last revoke`, async () => {
  const env = fixture(), item = `oauth/policy/${ref}`;
  await acceptGrantPoolBaseline("fresh", { request: env.request });
  await recoverGrantPools({ request: env.request });
  const active = await putGrantCredentials(env, item, primary);
  const paused = await putGrantCredentials(env, item, { ...active, enabled: false }, true);
  assert.equal(paused.credentialLineage, active.credentialLineage);
  await assert.rejects(() => upstreamAuth(providerById("openai"), identity, env), error => error.code === "upstream_grant_pool_unavailable");
  await revokeGrantCredentials(env, item);
  assert.equal((await upstreamAuth(providerById("openai"), identity, env)).headers.get("authorization"), "Bearer environment-fixture");
  const restricted = { ...identity, policy: { ...identity.policy, grantRouting: { eligibleGrants: { openai: [] } } } };
  await assert.rejects(() => upstreamAuth(providerById("openai"), restricted, env), error => error.code === "upstream_grant_pool_unavailable");
});

test("permanent refresh rejection preserves presence on both the first and subsequent route", async context => {
  const env = fixture();
  await acceptGrantPoolBaseline("fresh", { request: env.request });
  await recoverGrantPools({ request: env.request });
  await putGrantCredentials(env, key, { provider: "openai", kind: "oauth", accessToken: "expired-fixture", refreshToken: "refresh-fixture", expiresAt: "2020-01-01T00:00:00.000Z", refresh: { tokenUrl: "https://token.example/refresh", extraParams: {} } });
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: "invalid_grant" }, { status: 400 }); });
  await assert.rejects(() => upstreamAuth(providerById("openai"), identity, env), error => error.status === 401);
  await assert.rejects(() => upstreamAuth(providerById("openai"), identity, env), error => error.code === "upstream_grant_pool_unavailable");
  assert.equal(calls, 1);
});

for (const failure of ["before-write", "after-write"]) test(`backfill ${failure} failure preserves authoritative commit and recovers without rotating lineage`, async () => {
  const env = fixture();
  env.values.set(key, primary);
  await materializeGrantCredentials(env, key, primary, "openai", null, false);
  await acceptGrantPoolBaseline("existing", { request: env.request });
  await env.request("/v1/admin/grant-pools/scan", { method: "POST", body: { revision: (await status(env)).revision } });
  const owner = env.GRANT_CREDENTIALS.objects.get(key), before = owner.values.get("credential"), put = owner.state.storage.put;
  let fail = true;
  owner.state.storage.put = async (...args) => {
    if (!fail) return put(...args);
    fail = false;
    if (failure === "after-write") await put(...args);
    throw new Error("fixture failed acknowledgement");
  };
  await assert.rejects(() => backfillGrantAttachment(env, key));
  owner.object = new GrantCredentialObject(owner.state, env);
  const repaired = await reconcileGrantAttachment(env, key);
  assert.equal(repaired.outcome, failure === "before-write" ? "unattached" : "attached");
  assert.equal((await backfillGrantAttachment(env, key)).outcome, "attached");
  assert.equal(owner.values.get("credential").lineage, before.lineage);
  assert.equal(owner.values.get("credential").generation, before.generation + 1);
});

test("unknown readiness denies only environment fallback while admin auth, health and scoped grants work", async context => {
  const env = fixture();
  context.mock.method(globalThis, "fetch", async () => assert.fail("unexpected provider request"));
  await assert.rejects(() => upstreamAuth(providerById("openai"), identity, env), error => error.code === "grant_pool_not_ready" && error.status === 503);
  await env.request("/v1/admin/keys/client", { method: "PUT", body: { enabled: true, providers: ["openai"], secretSha256: createHash("sha256").update("proxy-fixture").digest("hex"), requestCostMicros: 0 } });
  const proxy = await env.dispatch("/v1/responses", { method: "POST", headers: { authorization: "Bearer clawrouter-live-client-proxy-fixture", "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture" }) });
  assert.equal(proxy.status, 503);
  assert.equal((await proxy.json()).error.code, "grant_pool_not_ready");
  assert.equal((await env.dispatch("/v1/health")).status, 200);
  assert.equal((await env.dispatch("/v1/admin/grant-pools/readiness")).status, 401);
  const login = await env.dispatch("/v1/session/login", { method: "POST", headers: { origin: "http://router.example", "content-type": "application/json" }, body: JSON.stringify({ token: "admin-fixture" }) });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await env.dispatch("/v1/admin/grant-pools/readiness", { headers: { cookie } })).status, 200);
  assert.equal((await env.dispatch("/v1/admin/grant-pools/baseline", { method: "POST", headers: { cookie, origin: "https://other.example" }, body: JSON.stringify({ revision: 0, baseline: "fresh", confirmed: true }) })).status, 403);
  const active = await putGrantCredentials(env, key, primary);
  assert.equal((await upstreamAuth(providerById("openai"), identity, env)).grant.credentialLineage, active.credentialLineage);
  await authorityCall(env, "/users/put", { email: "admin@local", record: { role: "user", enabled: true } });
  assert.equal((await env.dispatch("/v1/admin/grant-pools/readiness", { headers: { cookie } })).status, 403);
});

for (const activated of [false, true]) for (const failure of ["before-write", "after-write"]) test(`${activated ? "activated repair" : "migration"} completes an indexed owner's ${failure} KV publication failure`, async context => {
  const env = fixture();
  context.mock.method(globalThis, "fetch", async () => assert.fail("recovery contacted an upstream"));
  await acceptGrantPoolBaseline("fresh", { request: env.request });
  if (activated) await recoverGrantPools({ request: env.request });
  const put = env.POLICY_KV.put;
  let fail = true, writes = 0;
  env.POLICY_KV.put = async (...args) => {
    if (fail && failure === "before-write") throw new Error("fixture KV unavailable");
    assert.equal(writes++, 0, "same-key publication must not write twice within the fixture's one-second window");
    await put(...args);
    if (fail) throw new Error("fixture KV acknowledgement lost");
  };
  await assert.rejects(() => putGrantCredentials(env, key, primary));
  const owner = env.GRANT_CREDENTIALS.objects.get(key), committed = structuredClone(owner.values.get("credential"));
  assert.equal(committed.poolSyncPending, true);
  assert.equal((await env.grantAuthority.call("attachment", { key })).pending, false, "index commit already succeeded");
  owner.object = new GrantCredentialObject(owner.state, env);
  if (!activated && failure === "before-write") {
    await assert.rejects(() => recoverGrantPools({ request: env.request }), /unresolved/);
    assert.equal((await status(env)).activatedAt, null, "an unpublished projection cannot qualify activation");
  }
  fail = false;
  assert.ok((await recoverGrantPools({ request: env.request })).activatedAt);
  const repaired = owner.values.get("credential");
  assert.equal(repaired.poolSyncPending, false);
  assert.equal(repaired.generation, committed.generation);
  assert.equal(repaired.lineage, committed.lineage);
  assert.equal(repaired.poolAdmissionRevision, committed.poolAdmissionRevision);
  assert.equal(repaired.credential, primary.credential);
  assert.equal(env.values.get(key).credential, undefined);
  assert.equal((await upstreamAuth(providerById("openai"), identity, env)).headers.get("authorization"), `Bearer ${primary.credential}`);
  await recoverGrantPools({ request: env.request });
  await reconcileGrantAttachment(env, key);
  assert.equal(writes, 1, "verification and lost acknowledgements do not rewrite matching projections");
});

for (const corruption of ["missing", "invalid-json"]) test(`activated repair verifies a falsely clean owner's ${corruption} projection`, async () => {
  const env = fixture();
  await acceptGrantPoolBaseline("fresh", { request: env.request });
  await recoverGrantPools({ request: env.request });
  await putGrantCredentials(env, key, primary);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), before = structuredClone(owner.values.get("credential"));
  assert.equal(before.poolSyncPending, false);
  if (corruption === "missing") env.values.delete(key);
  else env.values.set(key, "{invalid fixture");
  owner.object = new GrantCredentialObject(owner.state, env);
  const put = env.POLICY_KV.put;
  let writes = 0;
  env.POLICY_KV.put = async (...args) => {
    assert.equal(owner.values.get("credential").poolSyncPending, true, "repair records its publication obligation before writing KV");
    writes++;
    return put(...args);
  };
  await recoverGrantPools({ request: env.request });
  await recoverGrantPools({ request: env.request });
  assert.equal(writes, 1);
  assert.deepEqual(owner.values.get("credential"), before);
  assert.equal(env.values.get(key).credentialGeneration, before.generation);
});

test("activated repair finds a detached tombstone after failed revoke projection without restoring secrets", async () => {
  const env = fixture();
  await acceptGrantPoolBaseline("fresh", { request: env.request });
  await recoverGrantPools({ request: env.request });
  await putGrantCredentials(env, key, primary);
  const put = env.POLICY_KV.put;
  env.POLICY_KV.put = async () => { throw new Error("fixture KV unavailable"); };
  await assert.rejects(() => revokeGrantCredentials(env, key));
  const owner = env.GRANT_CREDENTIALS.objects.get(key), tombstone = structuredClone(owner.values.get("credential"));
  assert.equal(tombstone.credential, undefined);
  assert.equal(tombstone.poolSyncPending, true);
  assert.equal((await pool(env)).hasAttachment, false);
  owner.object = new GrantCredentialObject(owner.state, env);
  env.POLICY_KV.put = put;
  await recoverGrantPools({ request: env.request });
  assert.deepEqual(owner.values.get("credential"), { ...tombstone, poolSyncPending: false });
  assert.equal(env.values.get(key).enabled, false);
  assert.ok(env.values.get(key).revokedAt);
});

test("activated recovery resumes bounded indexed pages without restarting at unchanged owners", async () => {
  const env = fixture();
  await acceptGrantPoolBaseline("fresh", { request: env.request });
  await assert.rejects(() => recoverGrantPools({ request: env.request, repairCursor: key }), /only valid after activation/);
  await recoverGrantPools({ request: env.request });
  for (let i = 0; i < 40; i++) await putGrantCredentials(env, `oauth/policy/paused-${String(i).padStart(2, "0")}`, { ...primary, enabled: false });
  env.values.delete("oauth/policy/paused-39");
  let resume;
  await assert.rejects(() => recoverGrantPools({ request: env.request, maxPages: 1 }), error => {
    resume = error.repairCursor;
    return error.message.includes("--repair-cursor") && resume === "oauth/policy/paused-31";
  });
  const pages = [];
  await recoverGrantPools({ request: env.request, maxPages: 1, repairCursor: resume, onPage: page => pages.push(page.keys) });
  assert.equal(pages[0].length, 8);
  assert.ok(env.values.has("oauth/policy/paused-39"));
});

function fixture() {
  const values = new Map();
  const env = attachGrantCredentialNamespace({
    values, USAGE_QUEUE: { async send() {} }, OPENAI_API_KEY: "environment-fixture", CLAWROUTER_LOCAL_AUTH: "enabled", CLAWROUTER_ADMIN_TOKEN_SHA256: createHash("sha256").update("admin-fixture").digest("hex"),
    POLICY_KV: {
      async get(key, type) {
        if (Array.isArray(key)) return new Map(await Promise.all(key.map(async item => [item, await this.get(item, type)])));
        const value = values.get(key) ?? null;
        return value === null ? null : type === "text" ? typeof value === "string" ? value : JSON.stringify(value) : typeof value === "string" ? JSON.parse(value) : structuredClone(value);
      },
      async put(key, value) { values.set(key, JSON.parse(value)); },
      async list({ prefix = "", cursor = "", limit = 1000 } = {}) {
        const keys = [...values.keys()].filter(key => key.startsWith(prefix) && key > cursor).sort();
        const page = keys.slice(0, limit);
        return { keys: page.map(name => ({ name })), list_complete: keys.length <= limit, cursor: page.at(-1) ?? cursor };
      },
    },
  });
  env.dispatch = (path, init = {}) => worker.fetch(new Request(`http://router.example${path}`, init), env, { waitUntil() {} });
  env.request = async (path, { method = "GET", body } = {}) => {
    const response = await env.dispatch(path, { method, headers: { authorization: "Bearer admin-fixture", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error.message), { status: response.status, code: result.error.code });
    return result;
  };
  return env;
}
function status(env) { return env.request("/v1/admin/grant-pools/readiness"); }
function pool(env) { return env.grantAuthority.call("resolve", { policyId: "policy", tenantId: "tenant", providerId: "openai" }); }
async function completeScan(env) {
  let state = await env.request("/v1/admin/grant-pools/scan", { method: "POST", body: { revision: (await status(env)).revision } });
  for (let i = 0; i < 10 && state.phase !== "complete"; i++) state = (await env.request("/v1/admin/grant-pools/advance", { method: "POST", body: { scanRevision: state.scanRevision, phase: state.phase, cursor: state.cursor } })).readiness;
  assert.equal(state.phase, "complete");
  return state;
}
