import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { adminApi } from "../admin.ts";
import { GrantCredentialObject, putGrantCredentials, revokeGrantCredentials } from "../grant-credentials.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";

const key = "oauth/policy/account", route = "/v1/admin/upstream-grants/policies/policy/account/models";
const primary = { provider: "openai", kind: "api_key", credential: "synthetic-account-key" };
const listed = ids => Response.json({ object: "list", data: ids.map(id => ({ id, object: "model", created: 1_700_000_000, owned_by: "organization-fixture" })) });

test("account model inspection is pure, bounded to the exact owner and admin-only", async context => {
  const env = fixture(context);
  env.values.set(key, JSON.stringify(primary));
  assert.equal((await env.request("GET")).status, 404, "GET does not migrate an ownerless KV account");
  await putGrantCredentials(env, key, primary);
  const row = owner(env).values.get("credential");
  row.poolSyncPending = true;
  const before = structuredClone(row);
  context.mock.method(globalThis, "fetch", async () => assert.fail("provider I/O during inspect"));
  for (const method of ["put", "delete", "setAlarm", "deleteAlarm"]) context.mock.method(owner(env).state.storage, method, async () => assert.fail(`owner ${method}`));
  context.mock.method(env.POLICY_KV, "get", async () => assert.fail("legacy read"));
  context.mock.method(env.ACCESS_CONTROL, "get", () => assert.fail("attachment read"));
  for (const method of ["GET", "POST"]) assert.equal((await env.request(method, { auth: false })).status, 401);
  const view = await env.request("GET");
  assert.equal(view.status, 200);
  assert.equal(view.headers.get("cache-control"), "no-store");
  assert.deepEqual(view.body, { key, providerId: "openai", credentialGeneration: 1, adapter: "openai.models", attempt: null, snapshot: null, sourceMatches: false, stale: true });
  assert.deepEqual(owner(env).values.get("credential"), before);
  assert.equal((await env.request("PUT")).status, 405);
  assert.deepEqual(owner(env).state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'"), [], "GET creates no tables");
  assert.equal((await env.request("GET", { path: route.replace("account/models", "neighbor/models") })).status, 404);
});

test("complete-only snapshots retain failures and only the latest same-source removals", async context => {
  const env = fixture(context);
  await putGrantCredentials(env, key, primary);
  let response = () => listed(["unknown-upstream-model", "removed"]), calls = 0;
  context.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.openai.com/v1/models");
    assert.deepEqual([...init.headers], [["authorization", "Bearer synthetic-account-key"]]);
    return response();
  });
  const before = structuredClone(owner(env).values.get("credential")), kv = [...env.values];
  const first = await env.request("POST");
  assert.equal(first.status, 200);
  assert.equal(first.body.attempt.status, "succeeded");
  assert.equal(first.body.snapshot.snapshotGeneration, 1);
  assert.equal(first.body.stale, false);
  assert.deepEqual(first.body.snapshot.models.map(model => model.id), ["removed", "unknown-upstream-model"]);
  assert.equal(first.body.snapshot.adapter, "openai.models");
  assert.equal(first.body.snapshot.credentialGeneration, 1);
  response = () => new Response("private-error-with-key", { status: 403 });
  const failure = await env.request("POST");
  assert.equal(failure.status, 502);
  assert.equal(failure.body.attempt.attemptGeneration, 2);
  assert.equal(failure.body.attempt.error, "upstream_rejected");
  assert.equal(failure.body.stale, true);
  assert.deepEqual(failure.body.snapshot, first.body.snapshot);
  response = () => listed(["unknown-upstream-model"]);
  const next = await env.request("POST");
  assert.equal(next.body.snapshot.snapshotGeneration, 2);
  assert.equal(next.body.snapshot.attemptGeneration, 3);
  assert.deepEqual(next.body.snapshot.removedIds, ["removed"]);
  assert.deepEqual((await env.request("POST")).body.snapshot.removedIds, []);
  assert.equal(calls, 4);
  assert.deepEqual(owner(env).values.get("credential"), before, "discovery never changes credentials or quota");
  assert.deepEqual([...env.values], kv, "no KV catalog, eligibility or cooldown writes");
  for (const table of ["model_discovery_attempt", "model_discovery_snapshot"]) assert.equal(owner(env).state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`)[0].n, 1);
  const instance = owner(env);
  instance.object = new GrantCredentialObject(instance.state, env);
  assert.equal((await env.request("GET")).body.snapshot.snapshotGeneration, 3, "inventory survives owner recreation");
  assert.doesNotMatch(JSON.stringify([first.body, failure.body, next.body]), /synthetic-account-key|private-error|credentialLineage|accessToken|pricing|capabilities/);
});

test("snapshot and completion commit atomically and a failed write retains the prior observation", async context => {
  const env = fixture(context);
  await putGrantCredentials(env, key, primary);
  context.mock.method(globalThis, "fetch", async () => listed(["first"]));
  const first = await env.request("POST");
  const sql = owner(env).state.storage.sql, exec = sql.exec;
  sql.exec = (query, ...bindings) => {
    if (query.startsWith("INSERT INTO model_discovery_attempt") && JSON.parse(bindings[0]).status === "succeeded") throw new Error("private-store-error");
    return exec(query, ...bindings);
  };
  const failed = await env.request("POST");
  assert.equal(failed.status, 500);
  assert.doesNotMatch(JSON.stringify(failed.body), /private-store-error/);
  sql.exec = exec;
  const retained = await env.request("GET");
  assert.deepEqual(retained.body.snapshot, first.body.snapshot);
  assert.equal(retained.body.attempt.attemptGeneration, 2);
  assert.equal(retained.body.attempt.completedAt, null);
  assert.equal(retained.body.stale, true);
});

for (const state of ["disabled", "revoked", "reauth", "expired", "oauth", "subscription", "unsupported", "missing-secret", "generation", "body-url"]) test(`discovery refuses ${state} before fetch or attempt creation`, async context => {
  const env = fixture(context);
  await putGrantCredentials(env, key, state === "unsupported" ? { ...primary, provider: "deepseek" } : primary);
  const row = owner(env).values.get("credential");
  if (state === "disabled") row.enabled = false;
  if (state === "reauth") row.status = "reauth_required";
  if (state === "expired") row.expiresAt = "2000-01-01T00:00:00.000Z";
  if (state === "oauth" || state === "subscription") row.kind = state;
  if (state === "missing-secret") { delete row.credential; env.OPENAI_API_KEY = "environment-key-must-not-be-used"; }
  if (state === "revoked") await revokeGrantCredentials(env, key);
  context.mock.method(globalThis, "fetch", async () => assert.fail("disallowed discovery made a provider call"));
  const result = await env.request("POST", { body: { expectedCredentialGeneration: state === "generation" ? 99 : owner(env).values.get("credential").generation, ...(state === "body-url" ? { url: "https://other.example" } : {}) } });
  assert.ok(result.status >= 400);
  assert.equal((await env.request("GET")).body.attempt, null);
});

test("revocation is not queued behind discovery and late completion cannot replace the snapshot", async context => {
  const env = fixture(context);
  await putGrantCredentials(env, key, primary);
  let release, started;
  const seen = new Promise(resolve => { started = resolve; });
  context.mock.method(globalThis, "fetch", async () => { started(); return new Promise(resolve => { release = resolve; }); });
  const pending = env.request("POST");
  await seen;
  assert.equal((await env.request("GET")).body.attempt.status, "running");
  await revokeGrantCredentials(env, key);
  assert.equal(owner(env).values.get("credential").credential, undefined, "revoke commits before provider completion");
  release(listed(["late"]));
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.attempt.error, "source_changed");
  assert.equal(result.body.snapshot, null);
});

test("newest refresh wins and account replacement makes retained observations stale", async context => {
  const env = fixture(context);
  await putGrantCredentials(env, key, primary);
  let release, started, calls = 0;
  const seen = new Promise(resolve => { started = resolve; });
  context.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) { started(); return new Promise(resolve => { release = resolve; }); }
    return listed(["current"]);
  });
  const old = env.request("POST");
  await seen;
  const current = await env.request("POST");
  release(listed(["superseded"]));
  assert.equal((await old).body.error.code, "model_discovery_superseded");
  assert.deepEqual((await env.request("GET")).body.snapshot, current.body.snapshot);
  await putGrantCredentials(env, key, { provider: "google-gemini", kind: "api_key", credential: "synthetic-new-key" }, false, "replace");
  const changed = await env.request("GET");
  assert.equal(changed.body.providerId, "google-gemini");
  assert.equal(changed.body.sourceMatches, false);
  assert.equal(changed.body.stale, true);
  assert.deepEqual(changed.body.snapshot, current.body.snapshot);
});

for (const change of ["key", "provider", "paused"]) test(`a ${change} change during I/O rejects the captured result`, async context => {
  const env = fixture(context);
  await putGrantCredentials(env, key, primary);
  let release, started;
  const seen = new Promise(resolve => { started = resolve; });
  context.mock.method(globalThis, "fetch", async () => { started(); return new Promise(resolve => { release = resolve; }); });
  const pending = env.request("POST");
  await seen;
  if (change === "paused") {
    const paused = await env.request("PATCH", { path: route.replace(/\/models$/, ""), body: { expectedCredentialGeneration: 1, enabled: false } });
    assert.equal(paused.status, 200);
  } else await putGrantCredentials(env, key, { ...primary, provider: change === "provider" ? "google-gemini" : "openai", credential: "synthetic-replacement" }, false, "replace");
  release(listed(["late"]));
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.attempt.error, "source_changed");
  assert.equal(result.body.snapshot, null);
  assert.equal(result.body.credentialGeneration, 2);
});

test("a credential deadline crossed during discovery invalidates completion without mutating credentials", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const env = fixture(context);
  await putGrantCredentials(env, key, { ...primary, expiresAt: new Date(Date.now() + 1000).toISOString() });
  const before = structuredClone(owner(env).values.get("credential"));
  context.mock.method(globalThis, "fetch", async () => {
    context.mock.timers.tick(1000);
    return listed(["late"]);
  });
  const result = await env.request("POST");
  assert.equal(result.status, 409);
  assert.equal(result.body.attempt.error, "source_changed");
  assert.equal(result.body.snapshot, null);
  assert.deepEqual(owner(env).values.get("credential"), before);
});

test("tenant-scoped Google key uses the same owner flow and accepts an empty complete inventory", async context => {
  const env = fixture(context), tenantKey = "oauth/tenants/team/account", path = "/v1/admin/upstream-grants/tenants/team/account/models";
  await putGrantCredentials(env, tenantKey, { provider: "google-gemini", kind: "api_key", credential: "synthetic-google-key" });
  context.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
    assert.deepEqual([...init.headers], [["x-goog-api-key", "synthetic-google-key"]]);
    return Response.json({ models: null });
  });
  const result = await env.request("POST", { path });
  assert.equal(result.status, 200);
  assert.equal(result.body.key, tenantKey);
  assert.deepEqual(result.body.snapshot.models, []);
  assert.equal(result.body.stale, false);
  assert.equal((await env.request("GET")).status, 404, "a sibling policy account is not implicitly selected");
});

function fixture(context) {
  const values = new Map();
  const env = attachGrantCredentialNamespace({ values,
    CLAWROUTER_LOCAL_AUTH: "enabled", CLAWROUTER_ADMIN_TOKEN_SHA256: createHash("sha256").update("admin-fixture").digest("hex"),
    POLICY_KV: {
      async get(name, type) { const value = values.get(name) ?? null; return value === null || type === "text" ? value : JSON.parse(value); },
      async put(name, value) { values.set(name, value); },
    },
  });
  const get = env.GRANT_CREDENTIALS.get;
  env.GRANT_CREDENTIALS.get = id => {
    const stub = get(id), storage = env.GRANT_CREDENTIALS.objects.get(id).state.storage;
    if (!storage.sql) {
      const db = new DatabaseSync(":memory:");
      context.after(() => db.close());
      storage.sql = { exec(query, ...bindings) { const statement = db.prepare(query); if (statement.columns().length) return statement.all(...bindings); statement.run(...bindings); return []; } };
      storage.transactionSync = action => { db.exec("BEGIN"); try { const result = action(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
    }
    return stub;
  };
  env.request = async (method, { path = route, auth = true, body = { expectedCredentialGeneration: 1 } } = {}) => {
    const response = await adminApi(new Request(`https://router.example${path}`, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer admin-fixture" } : {}) }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }), env, path);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return env;
}
function owner(env) { env.GRANT_CREDENTIALS.get(key); return env.GRANT_CREDENTIALS.objects.get(key); }
