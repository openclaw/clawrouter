import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GrantCredentialObject, materializeGrantCredentials, putGrantCredentials, reconcileGrantAttachment, revokeGrantCredentials } from "../grant-credentials.ts";
import { attachGrantCredentialNamespace, rateLimitKv } from "./grant-credential-mock.mjs";
import { acceptGrantPoolBaseline, recoverGrantPools } from "../../scripts/grant-pool-recovery.mjs";
const { adminApi } = await import("../admin.ts");

const ref = "acct_12345678-1234-4123-8123-123456789abc";
const key = `oauth/policy/${ref}`;
const route = `/v1/admin/upstream-grants/policies/policy/${ref}`;
const primary = { provider: "openai", kind: "api_key", credential: "synthetic-primary" };
const edits = [
  { name: "legacy PUT", method: "PUT", path: route, body: { provider: "openai", kind: "api_key", enabled: false, label: "edited" } },
  { name: "legacy replace", method: "PUT", path: `${route}?mode=replace`, body: { ...primary, credential: "replacement-fixture", enabled: false, label: "edited" } },
  { name: "PATCH", method: "PATCH", path: route, body: { label: "edited" }, strict: true },
  { name: "replace", method: "POST", path: `${route}/replace`, body: { credential: "replacement-fixture", label: "edited" }, strict: true },
];

test("authenticated create echoes the pre-known identity and duplicate POST never upserts", async () => {
  const env = fixture();
  const denied = await env.request("POST", primary, { auth: false });
  assert.equal(denied.status, 401);
  assert.equal(owner(env).values.has("credential"), false);
  const created = await env.request("POST", primary);
  assert.equal(created.status, 201);
  assert.equal(created.body.outcome, "committed");
  assert.equal(created.body.grant.tokenRef, ref);
  assert.equal(created.body.grant.credentialGeneration, 1);
  assert.equal(created.body.grant.publication, "ready");
  assert.equal(created.headers.get("cache-control"), "no-store");
  const before = structuredClone(record(env)), index = await attachment(env);
  const duplicate = await env.request("POST", { ...primary, credential: "different-fixture" });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "grant_already_exists");
  assert.deepEqual(record(env), before);
  assert.deepEqual(await attachment(env), index);
  assert.doesNotMatch(JSON.stringify([created.body, duplicate.body]), /synthetic-primary|different-fixture|poolAdmissionRevision|credentialLineage/);
});

for (const invalid of ["openai", "acct_12345678-1234-1123-8123-123456789abc", "acct_12345678-1234-4123-7123-123456789abc"]) test(`create refuses non-v4 opaque identity ${invalid}`, async () => {
  const env = fixture();
  const result = await env.request("POST", primary, { path: route.replace(ref, invalid) });
  assert.equal(result.status, 400);
  assert.equal(env.reads.length, 0);
  assert.equal(env.writes.length, 0);
});

for (const collision of ["legacy", "corrupt", "tombstone", "legacy-index", "pending-index", "retained-version"]) test(`create refuses ${collision} identity evidence before admission`, async () => {
  const env = fixture();
  if (collision === "legacy") env.values.set(key, JSON.stringify(primary));
  if (collision === "corrupt") env.values.set(key, '{"credential":"private-legacy",');
  if (collision === "tombstone") { await putGrantCredentials(env, key, primary); await revokeGrantCredentials(env, key); }
  if (collision === "legacy-index") env.grantAuthority.seedLegacy(key, "openai");
  if (["pending-index", "retained-version"].includes(collision)) {
    await env.grantAuthority.call("admit", { key, generation: 0, revision: 0, provider: "openai", status: "active" });
    if (collision === "retained-version") await env.grantAuthority.call("cancel-pending", { key, revision: 1 });
  }
  const before = structuredClone(record(env)), index = await attachment(env);
  const result = await env.request("POST", primary);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "grant_already_exists");
  assert.deepEqual(record(env), before);
  assert.deepEqual(await attachment(env), index);
});

test("pure GET and stale CAS do not migrate, repair, read KV or contact a provider", async context => {
  const env = fixture();
  await env.request("POST", { ...primary, refresh: { tokenUrl: "https://token.example/refresh", extraParams: { private: "hidden-fixture" } } });
  const row = record(env);
  row.poolSyncPending = true;
  row.subscription = { subject: "visible-account", plan: { client_secret: "nested-secret-fixture" }, unknown: "unknown-private-fixture" };
  row.metadata.unknown = "unknown-private-fixture";
  env.values.set(key, '{"credential":"corrupt-private",');
  context.mock.method(globalThis, "fetch", async () => assert.fail("upstream I/O"));
  for (const name of ["put", "setAlarm", "deleteAlarm"]) context.mock.method(owner(env).state.storage, name, async () => assert.fail(`unexpected ${name}`));
  context.mock.method(env.POLICY_KV, "get", async () => assert.fail("pure read/CAS adopted KV"));
  context.mock.method(env.ACCESS_CONTROL, "get", () => assert.fail("pure read/CAS accessed attachment index"));
  const view = await env.request("GET");
  assert.equal(view.status, 200);
  assert.equal(view.body.publication, "pending");
  assert.equal(view.body.refreshTokenUrl, "https://token.example/refresh");
  for (const [method, path] of [["PATCH", route], ["POST", `${route}/replace`]]) {
    const stale = await env.request(method, { ...method === "POST" ? primary : { label: "changed" }, expectedCredentialGeneration: 99 }, { path });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "grant_generation_changed");
    assert.deepEqual(stale.body.error.detail.grant, view.body);
    assert.doesNotMatch(JSON.stringify(stale.body), /hidden-fixture|synthetic-primary|extraParams|corrupt-private|nested-secret-fixture|unknown-private-fixture/);
  }
  delete row.metadata;
  const old = await env.request("PATCH", { expectedCredentialGeneration: 99, label: "old" });
  assert.equal(old.body.error.code, "grant_generation_changed", "CAS refuses before migration of incomplete owners");
  const uninitialized = await env.request("PATCH", { expectedCredentialGeneration: row.generation, label: "old" });
  assert.equal(uninitialized.body.error.code, "grant_owner_initialization_required");
});

for (const failedRead of ["owner", "kv"]) test(`create treats a failed ${failedRead} read as unknown, never absence`, async () => {
  const env = fixture(), target = failedRead === "owner" ? owner(env).state.storage : env.POLICY_KV, get = target.get;
  target.get = async () => { throw new Error("fixture unavailable"); };
  const result = await env.request("POST", primary);
  assert.equal(result.status, 500);
  target.get = get;
  assert.equal(record(env), undefined);
  assert.deepEqual(await attachment(env), { generation: 0, revision: 0, attached: false, pending: false });
});

test("GET of an ownerless legacy identity does not import or inspect legacy bytes", async context => {
  const env = fixture();
  env.values.set(key, JSON.stringify(primary));
  context.mock.method(env.POLICY_KV, "get", async () => assert.fail("GET must use only the strong row"));
  const result = await env.request("GET");
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, "grant_credential_missing");
  assert.equal(record(env), undefined);
});

test("canonical pre-UUID accounts remain manageable through GET, PATCH and replace", async () => {
  const env = fixture(), legacyKey = "oauth/policy/openai", path = route.replace(ref, "openai");
  await putGrantCredentials(env, legacyKey, primary);
  assert.equal((await env.request("GET", undefined, { path })).status, 200);
  assert.equal((await env.request("PATCH", { expectedCredentialGeneration: 1, label: "legacy account" }, { path })).status, 200);
  const replaced = await env.request("POST", { expectedCredentialGeneration: 2, credential: "replacement-fixture" }, { path: `${path}/replace` });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.grant.tokenRef, "openai");
  assert.equal(replaced.body.grant.credentialGeneration, 3);
});

test("strict replacement reads corrupt KV bytes only to verify the committed projection", async () => {
  const env = fixture();
  await env.request("POST", { ...primary, accountId: "old-account" });
  const before = structuredClone(record(env)), get = env.POLICY_KV.get, reads = [];
  env.values.set(key, '{"credential":"corrupt-private",');
  env.POLICY_KV.get = async (name, type) => {
    assert.equal(record(env).generation, before.generation + 1, "no KV read before the authoritative replacement commit");
    assert.equal(record(env).credential, "replacement-fixture");
    assert.equal(record(env).accountId, undefined);
    assert.equal(type, "text");
    reads.push(name);
    return get(name, type);
  };
  const replaced = await env.request("POST", { expectedCredentialGeneration: before.generation, credential: "replacement-fixture" }, { path: `${route}/replace` });
  assert.equal(replaced.status, 200);
  assert.deepEqual(reads, [key]);
  assert.doesNotMatch(JSON.stringify(record(env)), /corrupt-private|old-account|synthetic-primary/);
});

test("PATCH preserves internal token-response and maintenance facts while changing editable expiry", async () => {
  const env = fixture();
  await env.request("POST", { provider: "openai", kind: "oauth", accessToken: "access-fixture", refreshToken: "refresh-fixture" });
  Object.assign(record(env), { status: "reauth_required", tokenType: "token-response-type", nextRefreshAttemptAt: "2099-01-01T00:00:00.000Z", quotaFailureCount: 4 });
  const before = structuredClone(record(env));
  const result = await env.request("PATCH", { expectedCredentialGeneration: before.generation, enabled: false, expiresAt: null, refreshToken: null });
  assert.equal(result.status, 200);
  for (const field of ["status", "tokenType", "accessToken", "nextRefreshAttemptAt", "quotaFailureCount", "createdAt"]) assert.deepEqual(record(env)[field], before[field], field);
  assert.equal(record(env).refreshToken, null);
  assert.equal(record(env).enabled, false);
  assert.equal(record(env).expiresAt, null);
});

test("concurrent CAS mutations serialize and the loser never admits capacity", async () => {
  const env = fixture();
  await env.request("POST", primary);
  const before = await attachment(env);
  const results = await Promise.all([env.request("PATCH", { expectedCredentialGeneration: 1, label: "first" }), env.request("PATCH", { expectedCredentialGeneration: 1, label: "second" })]);
  assert.deepEqual(results.map(result => result.status), [200, 409]);
  assert.equal(record(env).metadata.label, "first");
  assert.equal((await attachment(env)).revision, before.revision + 2, "only one admission/publication pair");
});

for (const state of ["paused", "reauth", "revoked"]) test(`PATCH preserves ${state} state and cosmetic lineage`, async () => {
  const env = fixture();
  await env.request("POST", { ...primary, label: "original", accountId: "account-fixture", scopes: ["scope"], expiresAt: "2099-01-01T00:00:00.000Z" });
  if (state === "revoked") await revokeGrantCredentials(env, key);
  else if (state === "paused") await env.request("PATCH", { expectedCredentialGeneration: 1, enabled: false });
  else record(env).status = "reauth_required";
  const before = structuredClone(record(env));
  const result = await env.request("PATCH", { expectedCredentialGeneration: before.generation, label: null, scopes: [], expiresAt: null, priority: 5, weight: 2 });
  assert.equal(result.status, 200);
  assert.equal(result.body.grant.label, null);
  assert.deepEqual(result.body.grant.scopes, []);
  assert.equal(result.body.grant.expiresAt, null);
  assert.equal(record(env).lineage, before.lineage);
  assert.equal(record(env).status, before.status);
  assert.equal(record(env).revokedAt, before.revokedAt);
  assert.equal(record(env).enabled, before.enabled);
  assert.equal(record(env).credential, before.credential);
  if (state === "revoked") {
    const enable = await env.request("PATCH", { expectedCredentialGeneration: record(env).generation, enabled: true });
    assert.equal(enable.status, 409);
    assert.equal(enable.body.error.code, "grant_reconnect_required");
  }
});

test("PATCH clear-only refresh token rotates lineage without clearing refresh override or healing reauth", async () => {
  const env = fixture();
  await env.request("POST", { provider: "openai", kind: "oauth", accessToken: "access-fixture", refreshToken: "refresh-fixture", refresh: { tokenUrl: "https://token.example/refresh" } });
  const before = structuredClone(record(env));
  record(env).status = "reauth_required";
  const result = await env.request("PATCH", { expectedCredentialGeneration: 1, refreshToken: null });
  assert.equal(result.status, 200);
  assert.equal(result.body.grant.hasRefreshToken, false);
  assert.equal(record(env).accessToken, before.accessToken);
  assert.equal(record(env).refreshToken, null);
  assert.equal(record(env).status, "reauth_required");
  assert.notEqual(record(env).lineage, before.lineage);
  assert.deepEqual(record(env).refresh, before.refresh);
  for (const change of [{ refreshToken: "replacement" }, { credential: "replacement" }, { accessToken: null }, { provider: "anthropic" }, { credentialStatus: "active" }, { enabled: null }, { priority: null }]) {
    const result = await env.request("PATCH", { expectedCredentialGeneration: 2, ...change });
    assert.equal(result.status, 400);
    assert.equal(record(env).generation, 2);
  }
});

for (const intent of ["create", "patch", "replace"]) for (const parameter of ["refresh_token", "client_secret", "accessToken", "credentials", "grant_type", "client_id"]) test(`${intent} refuses refresh authentication parameter ${parameter} before writes`, async context => {
  const env = fixture();
  if (intent !== "create") {
    await env.request("POST", primary);
    record(env).poolSyncPending = true;
  }
  const before = structuredClone(record(env)), indexed = await attachment(env), projection = env.values.get(key);
  const reads = env.reads.length, writes = env.writes.length;
  for (const name of ["put", "setAlarm", "deleteAlarm"]) context.mock.method(owner(env).state.storage, name, async () => assert.fail(`unexpected ${name}`));
  context.mock.method(env.ACCESS_CONTROL, "get", () => assert.fail("invalid refresh metadata reached the index"));
  const result = await env.request(intent === "patch" ? "PATCH" : "POST", {
    ...(intent === "patch" ? {} : primary),
    ...(intent === "create" ? {} : { expectedCredentialGeneration: before.generation }),
    refresh: { tokenUrl: "https://token.example/refresh", extraParams: { [parameter]: "blocked-auth-fixture" } },
  }, { path: intent === "replace" ? `${route}/replace` : route });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "invalid_upstream_grant");
  assert.deepEqual(record(env), before);
  assert.equal(env.values.get(key), projection);
  assert.equal(env.reads.length, reads);
  assert.equal(env.writes.length, writes);
  assert.doesNotMatch(JSON.stringify([record(env), projection, result.body]), /blocked-auth-fixture/);
  context.mock.restoreAll();
  assert.deepEqual(await attachment(env), indexed);
});

for (const requestFormat of ["form", "json"]) for (const clientConfigured of [true, false]) test(`${requestFormat} refresh preserves owner authentication with client configuration ${clientConfigured}`, async context => {
  const env = fixture();
  env.FIXTURE_OAUTH_SECRET = "configured-client-secret-fixture";
  const refresh = {
    tokenUrl: "https://token.example/refresh", requestFormat,
    ...(clientConfigured ? { clientId: "public-client-fixture", clientSecretConfig: "FIXTURE_OAUTH_SECRET" } : {}),
    extraParams: { scope: "inference", audience: "provider-api" },
  };
  await env.request("POST", { provider: "openai", kind: "oauth", accessToken: "access-fixture", refreshToken: "refresh-fixture" });
  assert.equal((await env.request("PATCH", { expectedCredentialGeneration: 1, refresh })).status, 200);
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (url, init) => {
    calls += 1;
    assert.equal(url, refresh.tokenUrl);
    assert.equal(new Headers(init.headers).get("content-type"), requestFormat === "json" ? "application/json" : "application/x-www-form-urlencoded");
    const body = requestFormat === "json" ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    assert.deepEqual(body, {
      grant_type: "refresh_token", refresh_token: record(env).refreshToken,
      ...(clientConfigured ? { client_id: "public-client-fixture", client_secret: env.FIXTURE_OAUTH_SECRET } : {}),
      scope: "inference", audience: "provider-api",
    });
    return Response.json({ access_token: `rotated-access-${calls}`, refresh_token: `rotated-refresh-${calls}`, expires_in: 3600 });
  });
  await materializeGrantCredentials(env, key, JSON.parse(env.values.get(key)), "openai", null, true);
  assert.equal((await env.request("PATCH", { expectedCredentialGeneration: record(env).generation, refresh: null })).status, 200);
  // Provider/legacy refresh configuration reaches the same form builder without
  // strict metadata admission; it still cannot replace canonical authentication.
  const legacyConfig = { ...refresh, extraParams: { ...refresh.extraParams, grant_type: "forged-grant", refresh_token: "forged-refresh", client_id: "forged-client", client_secret: "forged-secret", accessToken: "forged-access" } };
  await materializeGrantCredentials(env, key, JSON.parse(env.values.get(key)), "openai", legacyConfig, true);
  assert.equal(calls, 2);
  const view = await env.request("GET");
  assert.doesNotMatch(JSON.stringify([record(env), env.values.get(key), view.body]), /forged-|configured-client-secret-fixture/);
  assert.doesNotMatch(JSON.stringify(view.body), /rotated-access|rotated-refresh|extraParams/);
});

for (const state of ["paused", "revoked"]) test(`whole replacement clears omitted material and preserves ${state} disablement`, async () => {
  const env = fixture();
  await env.request("POST", { provider: "openai", kind: "oauth", accessToken: "access-fixture", refreshToken: "refresh-fixture", tokenType: "old-type", accountId: "old-account", scopes: ["old-scope"], subscription: { subject: "old-subject" }, expiresAt: "2099-01-01T00:00:00.000Z", refresh: { tokenUrl: "https://token.example/old" }, label: "retained", priority: 7, weight: 3, enabled: false });
  if (state === "revoked") await revokeGrantCredentials(env, key);
  const before = structuredClone(record(env));
  const result = await env.request("POST", { expectedCredentialGeneration: before.generation, accessToken: "new-access-fixture" }, { path: `${route}/replace` });
  assert.equal(result.status, 200);
  assert.equal(result.body.grant.enabled, false);
  assert.equal(result.body.grant.revokedAt, null);
  assert.equal(result.body.grant.hasRefreshToken, false);
  assert.equal(result.body.grant.tokenType, "Bearer");
  for (const field of ["accountId", "subscription", "expiresAt"]) assert.equal(result.body.grant[field], null);
  assert.deepEqual(result.body.grant.scopes, []);
  for (const field of ["refreshToken", "accountId", "subscription", "expiresAt", "refresh"]) assert.equal(record(env)[field], undefined);
  assert.equal(record(env).metadata.label, "retained");
  assert.equal(record(env).metadata.priority, 7);
  assert.equal(record(env).metadata.weight, 3);
  assert.notEqual(record(env).lineage, before.lineage);
  assert.equal(owner(env).alarm(), null);
  const enabled = await env.request("POST", { expectedCredentialGeneration: record(env).generation, accessToken: "explicit-enabled-fixture", enabled: true }, { path: `${route}/replace` });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.grant.enabled, true);
});

for (const intent of ["create", "replace"]) for (const [name, material] of [
  ["credential", { ...primary, credential: " \t\r\n " }],
  ["accessToken", { provider: "openai", kind: "oauth", accessToken: " \t\r\n " }],
  ["bundle member", { ...primary, credential: undefined, credentials: { api_key: "valid-fixture", auxiliary: " \t\r\n " } }],
  ["refreshToken", { provider: "openai", kind: "oauth", accessToken: "valid-fixture", refreshToken: " \t\r\n " }],
]) test(`${intent} refuses whitespace-only ${name} before admission or writes`, async context => {
  const env = fixture();
  if (intent === "replace") {
    await env.request("POST", primary);
    record(env).poolSyncPending = true;
  }
  const before = structuredClone(record(env)), index = await attachment(env), projection = env.values.get(key);
  const reads = env.reads.length, writes = env.writes.length;
  for (const method of ["put", "setAlarm", "deleteAlarm"]) context.mock.method(owner(env).state.storage, method, async () => assert.fail(`unexpected ${method}`));
  context.mock.method(env.ACCESS_CONTROL, "get", () => assert.fail("invalid secrets must not reach attachment admission"));
  const result = await env.request("POST", { ...material, ...(intent === "replace" ? { expectedCredentialGeneration: before.generation } : {}) }, { path: intent === "replace" ? `${route}/replace` : route });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "invalid_upstream_grant");
  assert.deepEqual(record(env), before);
  assert.equal(env.values.get(key), projection);
  assert.equal(env.reads.length, reads);
  assert.equal(env.writes.length, writes);
  context.mock.restoreAll();
  assert.deepEqual(await attachment(env), index);
});

for (const [name, material] of [
  ["credential", { ...primary, credential: " \tprimary-fixture\r\n " }],
  ["accessToken and refreshToken", { provider: "openai", kind: "oauth", accessToken: " \taccess-fixture\r\n ", refreshToken: " \trefresh-fixture\r\n " }],
  ["bundle", { ...primary, credential: undefined, credentials: { api_key: " \tbundle-fixture\r\n " } }],
]) test(`create and replace preserve nonblank ${name} bytes`, async () => {
  const env = fixture();
  for (const intent of ["create", "replace"]) {
    const result = await env.request("POST", { ...material, ...(intent === "replace" ? { expectedCredentialGeneration: 1 } : {}) }, { path: intent === "replace" ? `${route}/replace` : route });
    assert.equal(result.status, intent === "create" ? 201 : 200);
    for (const field of ["credential", "credentials", "accessToken", "refreshToken"]) assert.deepEqual(record(env)[field], material[field], field);
  }
});

test("bundle-to-scalar replacement never retains another primary form", async () => {
  const env = fixture();
  await env.request("POST", { ...primary, credential: undefined, credentials: { api_key: "bundle-fixture" } });
  const result = await env.request("POST", { expectedCredentialGeneration: 1, credential: "scalar-fixture" }, { path: `${route}/replace` });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.grant.credentialFields, []);
  assert.equal(record(env).credentials, undefined);
  assert.equal(record(env).credential, "scalar-fixture");
  const refused = await env.request("POST", { expectedCredentialGeneration: 2, hasCredential: true }, { path: `${route}/replace` });
  assert.equal(refused.status, 400);
});

for (const failure of ["before-write", "after-write", "different-row", "read-error"]) test(`owner ${failure} acknowledgment has an exact commit receipt boundary`, async () => {
  const env = fixture(), storage = owner(env).state.storage, put = storage.put, get = storage.get;
  let attempted = false;
  storage.put = async (name, row) => {
    attempted = true;
    if (failure !== "before-write") await put(name, failure === "different-row" ? { ...row, updatedAt: "2099-01-01T00:00:00.000Z" } : row);
    throw new Error("fixture lost write acknowledgement");
  };
  storage.get = async name => {
    if (attempted && failure === "read-error") throw new Error("fixture unknown read");
    return get(name);
  };
  const result = await env.request("POST", primary);
  assert.equal(result.status, failure === "after-write" ? 202 : 503);
  if (failure === "after-write") {
    assert.equal(result.body.outcome, "committed");
    assert.equal(result.body.grant.tokenRef, ref);
    assert.equal(result.body.grant.publication, "pending");
  } else assert.equal(result.body.error.code, "grant_mutation_unconfirmed");
  storage.get = get; storage.put = put;
  const before = structuredClone(record(env));
  const view = await env.request("GET");
  assert.equal(view.status, before ? 200 : 404);
  assert.deepEqual(record(env), before, "inspection does not retry or finalize the mutation");
});

for (const stage of ["schedule", "index", "kv-before", "kv-after", "ack"]) test(`committed ${stage} failure returns 202 and explicit repair completes all obligations`, async () => {
  const env = fixture(), storage = owner(env).state.storage;
  const restore = failFinalization(env, stage);
  const result = await env.request("POST", { ...primary, enabled: false });
  assert.equal(result.status, 202);
  assert.equal(result.body.grant.publication, "pending");
  const before = structuredClone(record(env));
  assert.equal(before.poolSyncPending, true);
  assert.equal(before.enabled, false);
  const pure = await env.request("GET");
  assert.equal(pure.body.publication, "pending");
  if (stage === "kv-after") {
    await reconcileGrantAttachment(env, key);
    assert.equal(env.writes.length, 1, "matching bytes recover a lost KV ACK without another put");
  } else await assert.rejects(() => reconcileGrantAttachment(env, key));
  restore();
  owner(env).object = new GrantCredentialObject(owner(env).state, env);
  const repaired = await env.request("POST", {}, { path: "/v1/admin/grant-pools/repair" });
  assert.equal(repaired.status, 200);
  assert.equal(repaired.body.outcomes[0].outcome, "attached");
  assert.deepEqual(record(env), { ...before, poolSyncPending: false });
  assert.equal(await storage.getAlarm(), null);
  assert.equal((await env.request("GET")).body.publication, "ready");
  const puts = env.writes.length;
  await reconcileGrantAttachment(env, key);
  assert.equal(env.writes.length, puts, "unchanged projection verification makes no duplicate KV put");
});

for (const edit of edits) for (const state of edit.strict ? ["pending"] : ["pending", "missing-lineage"]) test(`${edit.name} coalesces ${state} publication into its final generation`, async () => {
  const env = fixture();
  if (state === "pending") await pendingEdit(env);
  else {
    await env.request("POST", { ...primary, enabled: false });
    delete record(env).lineage;
  }
  const before = structuredClone(record(env)), limit = rateLimitKv(env);
  const result = await editAccount(env, edit, before.generation);
  assert.equal(result.status, 200);
  assert.equal(limit.writes(), 1, "no intermediate projection consumes the per-key write interval");
  const after = record(env), projected = JSON.parse(env.values.get(key));
  assert.equal(after.generation, before.generation + 1);
  assert.equal(after.poolSyncPending, false);
  assert.equal(after.enabled, false);
  assert.equal(after.metadata.label, "edited");
  assert.equal(projected.credentialGeneration, after.generation);
  assert.equal(projected.credentialLineage, after.lineage);
  assert.equal(after.credential, edit.name.includes("replace") ? "replacement-fixture" : before.credential);
  if (state === "missing-lineage") assert.match(after.lineage, /^[0-9a-f-]{36}$/);
  else if (!edit.name.includes("replace")) assert.equal(after.lineage, before.lineage);
  assert.equal((await attachment(env)).generation, after.generation);
  assert.equal((await attachment(env)).pending, false);
});

for (const edit of edits) for (const failure of ["admission", "store"]) test(`${edit.name} preserves pending obligations after a subsequent ${failure} failure`, async () => {
  const env = fixture();
  await pendingEdit(env);
  const before = structuredClone(record(env)), limit = rateLimitKv(env);
  const storage = owner(env).state.storage, put = storage.put, authority = env.ACCESS_CONTROL.get;
  if (failure === "admission") env.ACCESS_CONTROL.get = id => ({ fetch: (url, init) => new URL(url).pathname === "/grant-pools/admit"
    ? Promise.resolve(Response.json({ error: { code: "fixture_admission_failure", message: "fixture admission unavailable" } }, { status: 503 })) : authority(id).fetch(url, init) });
  else storage.put = async (name, row) => {
    if (row.generation === before.generation + 1 && row.poolAdmissionRevision !== before.poolAdmissionRevision) throw new Error("fixture mutation store unavailable");
    return put(name, row);
  };
  if (edit.strict) {
    const result = await editAccount(env, edit, before.generation);
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, failure === "admission" ? "fixture_admission_failure" : "grant_mutation_unconfirmed");
  } else await assert.rejects(() => editAccount(env, edit, before.generation), error => error.status === (failure === "admission" ? 503 : 500));
  assert.deepEqual(record(env), before, "preparation never acknowledges or replaces the pending owner");
  assert.equal(limit.writes(), 0);
  assert.equal((await env.request("GET")).body.publication, "pending");
  storage.put = put; env.ACCESS_CONTROL.get = authority;
  await reconcileGrantAttachment(env, key);
  assert.deepEqual(record(env), { ...before, poolSyncPending: false });
  assert.equal(limit.writes(), 1);
  assert.equal(JSON.parse(env.values.get(key)).credentialGeneration, before.generation);
  assert.equal((await attachment(env)).generation, before.generation);
  assert.equal((await attachment(env)).attached, true);
  assert.equal((await attachment(env)).pending, false);
});

test("released PUT and erase-first revoke keep non-2xx pending outcomes", async () => {
  const env = fixture();
  await env.request("POST", primary);
  const storage = owner(env).state.storage, removeAlarm = storage.deleteAlarm;
  storage.deleteAlarm = async () => { throw new Error("fixture schedule unavailable"); };
  await assert.rejects(() => env.request("PUT", { ...primary, enabled: false }), error => error.status === 500 && error.code === "credential_owner_error");
  assert.equal(record(env).enabled, false);
  await assert.rejects(() => env.request("POST", {}, { path: `${route}/revoke` }), error => error.status === 500 && error.code === "credential_owner_error");
  assert.equal(record(env).credential, undefined);
  assert.ok(record(env).revokedAt);
  assert.equal(record(env).poolSyncPending, true);
  storage.deleteAlarm = removeAlarm;
  await env.request("POST", {}, { path: "/v1/admin/grant-pools/repair" });
  assert.equal(record(env).poolSyncPending, false);
  assert.equal((await attachment(env)).attached, false);
});

test("active scheduling failure remains pending until explicit repair installs the alarm", async context => {
  const env = fixture(), storage = owner(env).state.storage, setAlarm = storage.setAlarm;
  context.mock.method(globalThis, "fetch", async () => assert.fail("finalization must not contact a provider"));
  storage.setAlarm = async () => { throw new Error("fixture alarm unavailable"); };
  const result = await env.request("POST", { provider: "openai", kind: "oauth", accessToken: "access-fixture", refreshToken: "refresh-fixture", expiresAt: "2099-01-01T00:00:00.000Z" });
  assert.equal(result.status, 202);
  assert.equal(record(env).poolSyncPending, true);
  assert.equal(env.values.has(key), false);
  assert.equal((await attachment(env)).pending, true);
  storage.setAlarm = setAlarm;
  await reconcileGrantAttachment(env, key);
  assert.ok(owner(env).alarm() > Date.now());
  assert.equal(record(env).poolSyncPending, false);
});

test("lost final acknowledgement returns the captured pending receipt while pure GET can observe completion", async () => {
  const env = fixture(), storage = owner(env).state.storage, put = storage.put;
  storage.put = async (name, row) => { await put(name, row); if (row.poolSyncPending === false) throw new Error("fixture final ACK lost"); };
  const result = await env.request("POST", primary);
  assert.equal(result.status, 202);
  assert.equal(result.body.grant.publication, "pending");
  assert.equal((await env.request("GET")).body.publication, "ready");
  assert.equal(env.writes.length, 1);
  storage.put = put;
  await reconcileGrantAttachment(env, key);
  assert.equal(env.writes.length, 1);
});

for (const stage of ["schedule", "kv-before", "ack"]) test(`backfill cannot activate while committed ${stage} finalization is incomplete`, async () => {
  const env = fixture();
  await acceptGrantPoolBaseline("fresh", { request: env.recoveryRequest });
  const restore = failFinalization(env, stage);
  const created = await env.request("POST", { ...primary, enabled: false });
  assert.equal(created.status, 202);
  await assert.rejects(() => recoverGrantPools({ request: env.recoveryRequest }), /unresolved/);
  const readiness = await env.recoveryRequest("/v1/admin/grant-pools/readiness");
  assert.equal(readiness.activatedAt, null);
  assert.equal(record(env).poolSyncPending, true);
  const before = structuredClone(record(env));
  restore();
  assert.ok((await recoverGrantPools({ request: env.recoveryRequest })).activatedAt);
  assert.deepEqual(record(env), { ...before, poolSyncPending: false });
});

test("refresh changes the generation and defeats a previously read edit", async context => {
  const env = fixture();
  await env.request("POST", { provider: "openai", kind: "oauth", accessToken: "access-fixture", refreshToken: "refresh-fixture", refresh: { tokenUrl: "https://token.example/refresh" } });
  const before = structuredClone(record(env));
  context.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "rotated-fixture", expires_in: 3600 }));
  const projected = JSON.parse(env.values.get(key));
  await materializeGrantCredentials(env, key, projected, "openai", null, true);
  assert.equal(record(env).lineage, before.lineage);
  const edit = await env.request("PATCH", { expectedCredentialGeneration: before.generation, label: "stale" });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.error.detail.grant.credentialGeneration, before.generation + 1);
});


for (const [label, patch] of [
  ["label", { label: "changed" }],
  ["explicit normalized nulls", { label: "changed", tokenType: null, scopes: null }],
  ["refresh replacement", { refreshToken: "operator-refresh-fixture" }],
  ["refresh clear", { refreshToken: null }],
  ["primary replacement", { accessToken: "operator-access-fixture" }],
  ["forged internal patch", { label: "changed", credentialInput: { accessToken: "forged-primary" } }],
]) test(`legacy PUT ${label} keeps canonical intent after a rotated pair failed KV publication`, async context => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  context.mock.method(Date, "now", () => now);
  const env = fixture(), legacy = { provider: "openai", kind: "oauth", accessToken: "legacy-access-fixture", refreshToken: "legacy-refresh-fixture", tokenType: "Custom", scopes: ["retained"], expiresAt: new Date(now + 3_600_000).toISOString() };
  env.values.set(key, JSON.stringify(legacy));
  const fetch = context.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "rotated-access-fixture", refresh_token: "rotated-refresh-fixture", expires_in: "bad" }));
  const put = env.POLICY_KV.put;
  env.POLICY_KV.put = async () => { throw new Error("fixture publication failure"); };
  await assert.rejects(() => materializeGrantCredentials(env, key, legacy, "openai", { tokenUrl: "https://token.example/refresh" }, true));
  const rotated = structuredClone(record(env));
  assert.equal(rotated.tokenResponseError, "invalid_expiry");
  assert.equal(rotated.poolSyncPending, true);
  assert.deepEqual(JSON.parse(env.values.get(key)), legacy);
  env.POLICY_KV.put = put;
  const result = await env.request("PUT", patch);
  assert.equal(result.status, 200);
  const row = record(env), fresh = label === "primary replacement";
  assert.equal(row.accessToken, fresh ? patch.accessToken : rotated.accessToken);
  assert.equal(row.refreshToken, Object.hasOwn(patch, "refreshToken") ? patch.refreshToken : rotated.refreshToken);
  assert.equal(row.tokenResponseError, fresh ? null : "invalid_expiry");
  assert.equal(row.nextRefreshAttemptAt, fresh ? null : rotated.nextRefreshAttemptAt);
  assert.equal(row.expiresAt, null);
  assert.equal(row.tokenType, label === "explicit normalized nulls" ? "Bearer" : "Custom");
  assert.deepEqual(row.scopes, label === "explicit normalized nulls" ? [] : ["retained"]);
  assert.equal(row.generation, rotated.generation + 1);
  if (!fresh && !Object.hasOwn(patch, "refreshToken")) assert.equal(row.lineage, rotated.lineage);
  assert.equal(row.poolSyncPending, false);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.body.usable, fresh);
  assert.doesNotMatch(JSON.stringify(result.body), /legacy-access-fixture|legacy-refresh-fixture|rotated-access-fixture|rotated-refresh-fixture|forged-primary/);
  for (const value of [row.metadata, JSON.parse(env.values.get(key)), result.body]) {
    assert.equal(Object.hasOwn(value, "credentialInput"), false);
    assert.doesNotMatch(JSON.stringify(value), /forged-primary/);
  }
});

test("legacy metadata PUT still initializes an unowned raw grant", async () => {
  const env = fixture();
  env.values.set(key, JSON.stringify({ provider: "openai", kind: "oauth", accessToken: "legacy-access-fixture", refreshToken: "legacy-refresh-fixture" }));
  const result = await env.request("PUT", { label: "migrated" });
  assert.equal(result.status, 200);
  assert.equal(record(env).accessToken, "legacy-access-fixture");
  assert.equal(record(env).refreshToken, "legacy-refresh-fixture");
  assert.equal(record(env).metadata.label, "migrated");
  assert.equal(record(env).tokenResponseError ?? null, null);
  assert.equal(JSON.parse(env.values.get(key)).accessToken, undefined);
});

for (const credentials of [null, {}]) test(`legacy explicit credentials ${JSON.stringify(credentials)} retains the canonical bundle`, async () => {
  const env = fixture(), old = { provider: "aws-bedrock", kind: "api_key", credentials: { accessKeyId: "old-id", secretAccessKey: "old-key" } };
  env.values.set(key, JSON.stringify(old));
  const put = env.POLICY_KV.put;
  env.POLICY_KV.put = async () => { throw new Error("fixture publication failure"); };
  await assert.rejects(() => putGrantCredentials(env, key, { ...old, credentials: { accessKeyId: "new-id", secretAccessKey: "new-key" } }));
  env.POLICY_KV.put = put;
  const result = await env.request("PUT", { kind: "api_key", credentials, label: "kept" });
  assert.equal(result.status, 200);
  assert.deepEqual(record(env).credentials, { accessKeyId: "new-id", secretAccessKey: "new-key" });
});


for (const enabled of [false, true]) test(`legacy label PUT retains canonical provider, kind and ${enabled ? "active" : "paused"} routing after replacement publication fails`, async () => {
  const env = fixture();
  await env.request("POST", { ...primary, label: "old-A", priority: 99, weight: 1 });
  const oldKv = env.values.get(key), put = env.POLICY_KV.put;
  env.POLICY_KV.put = async () => { throw new Error("fixture KV publication failure"); };
  const replaced = await env.request("POST", {
    expectedCredentialGeneration: record(env).generation, provider: "anthropic", kind: "subscription",
    accessToken: "provider-b-access", refreshToken: "provider-b-refresh", label: "canonical-B",
    priority: 17, weight: 3, enabled, maintenance: { keepWarm: true },
  }, { path: `${route}/replace` });
  assert.equal(replaced.status, 202);
  const before = structuredClone(record(env));
  assert.equal(before.providerId, "anthropic");
  assert.equal(before.kind, "subscription");
  assert.equal(before.poolSyncPending, true);
  assert.equal(env.values.get(key), oldKv);
  env.POLICY_KV.put = put;
  const result = await env.request("PUT", { label: "new label" });
  assert.equal(result.status, 200);
  const row = record(env), published = JSON.parse(env.values.get(key));
  assert.equal(row.providerId, "anthropic");
  assert.equal(row.kind, "subscription");
  assert.equal(row.accessToken, "provider-b-access");
  assert.equal(row.refreshToken, "provider-b-refresh");
  assert.equal(row.credential, undefined);
  assert.equal(row.enabled, enabled);
  assert.equal(row.metadata.priority, 17);
  assert.equal(row.metadata.weight, 3);
  assert.equal(row.metadata.label, "new label");
  assert.deepEqual(row.maintenance, { keepWarm: true });
  assert.equal(row.createdAt, before.createdAt);
  assert.equal(row.lineage, before.lineage);
  assert.equal(row.generation, before.generation + 1);
  assert.equal(published.provider, "anthropic");
  assert.equal(published.kind, "subscription");
  assert.equal(published.enabled, enabled);
  assert.deepEqual(env.grantAuthority.sql.exec("SELECT provider_id, status FROM upstream_grant_pool_members WHERE scope_id = ? AND token_ref = ?", "policy", ref).map(row => ({ ...row })), [{ provider_id: "anthropic", status: enabled ? "active" : "paused" }]);
  const explicit = await env.request("PUT", { provider: "openai", kind: "oauth", enabled: true, maintenance: { keepWarm: false }, priority: 8, weight: 2, tokenType: null, scopes: null });
  assert.equal(explicit.status, 200);
  assert.equal(record(env).providerId, "openai");
  assert.equal(record(env).kind, "oauth");
  assert.equal(record(env).enabled, true);
  assert.deepEqual(record(env).maintenance, { keepWarm: false });
  assert.equal(record(env).metadata.priority, 8);
  assert.equal(record(env).metadata.weight, 2);
  assert.equal(record(env).tokenType, "Bearer");
  assert.deepEqual(record(env).scopes, []);
});

test("legacy replace keeps fresh defaults while ordinary PUT preserves first-import metadata", async () => {
  const env = fixture();
  env.values.set(key, JSON.stringify({ provider: "anthropic", kind: "subscription", enabled: false, priority: 27, weight: 4, maintenance: { keepWarm: true }, accessToken: "legacy-primary", refreshToken: "legacy-refresh" }));
  const migrated = await env.request("PUT", { label: "imported" });
  assert.equal(migrated.status, 200);
  assert.equal(record(env).providerId, "anthropic");
  assert.equal(record(env).kind, "subscription");
  assert.equal(record(env).enabled, false);
  assert.equal(record(env).metadata.priority, 27);
  assert.deepEqual(record(env).maintenance, { keepWarm: true });
  const replaced = await env.request("PUT", { provider: "openai", accessToken: "replacement-primary" }, { path: `${route}?mode=replace` });
  assert.equal(replaced.status, 200);
  assert.equal(record(env).providerId, "openai");
  assert.equal(record(env).kind, "oauth");
  assert.equal(record(env).enabled, true);
  assert.equal(record(env).metadata.priority, 100);
  assert.equal(record(env).metadata.weight, 1);
  assert.deepEqual(record(env).maintenance, { keepWarm: false });
  assert.equal(record(env).refreshToken, undefined);
});

function fixture() {
  const values = new Map(), reads = [], writes = [];
  const env = attachGrantCredentialNamespace({
    values, reads, writes,
    CLAWROUTER_LOCAL_AUTH: "enabled", CLAWROUTER_ADMIN_TOKEN_SHA256: createHash("sha256").update("admin-fixture").digest("hex"),
    POLICY_KV: {
      async get(name, type) { reads.push({ name, type }); const value = values.get(name) ?? null; return value === null || type === "text" ? value : JSON.parse(value); },
      async put(name, value) { writes.push(name); values.set(name, value); },
      async list({ prefix = "", cursor = "", limit = 1000 } = {}) {
        const names = [...values.keys()].filter(name => name.startsWith(prefix) && name > cursor).sort();
        const page = names.slice(0, limit);
        return { keys: page.map(name => ({ name })), list_complete: names.length <= limit, cursor: page.at(-1) ?? cursor };
      },
    },
  });
  env.request = async (method, body, { path = route, auth = true } = {}) => {
    const request = new Request(`https://router.example${path}`, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer admin-fixture" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await adminApi(request, env, new URL(request.url).pathname);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  env.recoveryRequest = async (path, { method = "GET", body } = {}) => {
    const result = await env.request(method, body, { path });
    if (result.status >= 400) throw Object.assign(new Error(result.body.error.message), { status: result.status, code: result.body.error.code });
    return result.body;
  };
  return env;
}

function owner(env) { env.GRANT_CREDENTIALS.get(key); return env.GRANT_CREDENTIALS.objects.get(key); }
function record(env) { return owner(env).values.get("credential"); }
function attachment(env) { return env.grantAuthority.call("attachment", { key }); }
function editAccount(env, edit, generation) {
  return env.request(edit.method, { ...edit.body, ...(edit.strict ? { expectedCredentialGeneration: generation } : {}) }, { path: edit.path });
}
async function pendingEdit(env) {
  await env.request("POST", { ...primary, enabled: false });
  const projection = env.values.get(key), restore = failFinalization(env, "kv-before");
  const result = await env.request("PATCH", { expectedCredentialGeneration: 1, label: "pending" });
  assert.equal(result.status, 202);
  assert.equal(record(env).poolSyncPending, true);
  assert.equal(env.values.get(key), projection);
  restore();
}
function failFinalization(env, stage) {
  const storage = owner(env).state.storage, put = storage.put, removeAlarm = storage.deleteAlarm, kvPut = env.POLICY_KV.put, authority = env.ACCESS_CONTROL.get;
  if (stage === "schedule") storage.deleteAlarm = async () => { throw new Error("fixture schedule failure"); };
  if (stage === "ack") storage.put = async (name, row) => { if (row.poolSyncPending === false) throw new Error("fixture acknowledgement failure"); return put(name, row); };
  if (stage.startsWith("kv")) env.POLICY_KV.put = async (...args) => { if (stage === "kv-after") await kvPut(...args); throw new Error("fixture KV failure"); };
  if (stage === "index") env.ACCESS_CONTROL.get = id => ({ fetch: (url, init) => new URL(url).pathname === "/grant-pools/publish" ? Promise.resolve(Response.json({ error: { code: "fixture_index_failure", message: "fixture index unavailable" } }, { status: 503 })) : authority(id).fetch(url, init) });
  return () => { storage.put = put; storage.deleteAlarm = removeAlarm; env.POLICY_KV.put = kvPut; env.ACCESS_CONTROL.get = authority; };
}
