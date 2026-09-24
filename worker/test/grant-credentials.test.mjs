import assert from "node:assert/strict";
import test from "node:test";
import { materializeGrantCredentials, putGrantCredentials, revokeGrantCredentials } from "../grant-credentials.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";

test("legacy grants migrate to the credential owner before KV secrets are scrubbed", async () => {
  const key = "oauth/policy/openai";
  const values = new Map([[key, legacyGrant()]]);
  const env = credentialEnv(values);

  const materialized = await materializeGrantCredentials(env, key, values.get(key), "openai", refreshConfig(), false);

  assert.equal(materialized.accessToken, "access-old");
  assert.equal(materialized.refreshToken, "refresh-old");
  const metadata = values.get(key);
  assert.equal(metadata.accessToken, undefined);
  assert.equal(metadata.refreshToken, undefined);
  assert.equal(metadata.credentialStore, "durable_object");
  assert.equal(metadata.hasAccessToken, true);
  assert.equal(metadata.hasRefreshToken, true);
});

test("legacy default grants without provider metadata retain their registered route", async () => {
  const key = "oauth/policy/openai", values = new Map([[key, legacyGrant({ provider: undefined })]]), env = credentialEnv(values);
  assert.equal((await materializeGrantCredentials(env, key, values.get(key), "openai", refreshConfig(), false)).accessToken, "access-old");
});

test("lineage is owner-issued, survives metadata updates and seeds old owner records once", async () => {
  const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
  const active = await putGrantCredentials(env, key, legacyGrant({ credentialLineage: "caller-supplied" }));
  assert.match(active.credentialLineage, /^[0-9a-f-]{36}$/);
  assert.notEqual(active.credentialLineage, "caller-supplied");
  const updated = await putGrantCredentials(env, key, { ...active, label: "renamed", credentialLineage: "caller-forged", enabled: false }, true);
  assert.equal(updated.credentialLineage, active.credentialLineage);
  const enabled = await putGrantCredentials(env, key, { ...updated, enabled: true }, true);
  assert.equal(enabled.credentialLineage, active.credentialLineage);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), record = owner.values.get("credential");
  const admissionRevision = record.poolAdmissionRevision;
  delete record.lineage;
  owner.values.set("credential", record);
  values.set(key, { ...enabled, credentialLineage: "kv-forged" });
  const migrated = await materializeGrantCredentials(env, key, enabled, "openai", refreshConfig(), false);
  assert.notEqual(migrated.credentialLineage, "kv-forged");
  assert.notEqual(migrated.credentialLineage, active.credentialLineage);
  assert.equal(owner.values.get("credential").poolAdmissionRevision, admissionRevision);
  const again = await materializeGrantCredentials(env, key, enabled, "openai", refreshConfig(), false);
  assert.equal(again.credentialLineage, migrated.credentialLineage);
  await revokeGrantCredentials(env, key);
  const reconnected = await putGrantCredentials(env, key, legacyGrant({ credentialLineage: migrated.credentialLineage }));
  assert.notEqual(reconnected.credentialLineage, migrated.credentialLineage);
});

test("materialization rejects changed provider and transport metadata before dispatch", async () => {
  const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
  const active = await putGrantCredentials(env, key, legacyGrant());
  await putGrantCredentials(env, key, { ...active, provider: "anthropic" }, true);
  await assert.rejects(() => materializeGrantCredentials(env, key, active, "openai", refreshConfig(), false), (error) => error.code === "upstream_grant_changed");
  await putGrantCredentials(env, key, { ...active, kind: "api_key" }, true);
  await assert.rejects(() => materializeGrantCredentials(env, key, active, "openai", refreshConfig(), false), (error) => error.code === "upstream_grant_changed");
});

test("concurrent rotating refreshes collapse to one provider exchange", async (context) => {
  const key = "oauth/policy/openai";
  const values = new Map([[key, legacyGrant({ expiresAt: "2020-01-01T00:00:00.000Z" })]]);
  const env = credentialEnv(values);
  let refreshes = 0;
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    refreshes += 1;
    assert.equal(new URLSearchParams(init.body).get("refresh_token"), "refresh-old");
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 });
  });

  const legacy = values.get(key);
  const results = await Promise.all([
    materializeGrantCredentials(env, key, legacy, "openai", refreshConfig(), true),
    materializeGrantCredentials(env, key, legacy, "openai", refreshConfig(), true),
  ]);

  assert.equal(refreshes, 1);
  assert.deepEqual(results.map((grant) => grant.accessToken), ["access-new", "access-new"]);
  assert.deepEqual(results.map((grant) => grant.refreshToken), ["refresh-new", "refresh-new"]);
  const record = env.GRANT_CREDENTIALS.objects.get(key).values.get("credential");
  assert.equal(record.generation, 2);
  assert.equal(record.accessToken, "access-new");
  assert.equal(record.refreshToken, "refresh-new");
});

test("permanent refresh rejection marks only metadata and never returns provider details", async (context) => {
  const key = "oauth/policy/openai";
  const values = new Map([[key, legacyGrant({ expiresAt: "2020-01-01T00:00:00.000Z" })]]);
  const env = credentialEnv(values);
  context.mock.method(globalThis, "fetch", async () => Response.json({ error: "invalid_grant", error_description: "private-provider-detail" }, { status: 400 }));

  await assert.rejects(
    () => materializeGrantCredentials(env, key, values.get(key), "openai", refreshConfig(), true),
    (error) => error?.code === "grant_reauthorization_required" && !error.message.includes("private-provider-detail"),
  );
  const metadata = values.get(key);
  assert.equal(metadata.credentialStatus, "reauth_required");
  assert.equal(JSON.stringify(metadata).includes("access-old"), false);
  assert.equal(JSON.stringify(metadata).includes("refresh-old"), false);
});

for (const outcome of ["success", "permanent", "transient"]) test(`legacy migration publishes only the final ${outcome} refresh state within the KV write limit`, async (context) => {
  const key = "oauth/policy/openai", values = new Map([[key, legacyGrant({ expiresAt: "2020-01-01T00:00:00.000Z" })]]), env = credentialEnv(values);
  const limit = rateLimitKv(env);
  context.mock.method(globalThis, "fetch", async () => outcome === "success"
    ? Response.json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 })
    : Response.json({ error: outcome === "permanent" ? "invalid_grant" : "unavailable" }, { status: outcome === "permanent" ? 400 : 503 }));
  const materialize = () => materializeGrantCredentials(env, key, values.get(key), "openai", refreshConfig(), false);
  if (outcome === "success") assert.equal((await materialize()).accessToken, "access-new");
  else await assert.rejects(materialize, (error) => error.code === (outcome === "permanent" ? "grant_reauthorization_required" : "grant_refresh_failed"));
  const record = env.GRANT_CREDENTIALS.objects.get(key).values.get("credential"), metadata = values.get(key);
  assert.equal(limit.writes(), 1);
  assert.equal(metadata.credentialGeneration, record.generation);
  assert.equal(metadata.credentialStatus, outcome === "permanent" ? "reauth_required" : "active");
  assert.equal(metadata.accessToken, undefined);
  assert.equal(metadata.refreshToken, undefined);
});

for (const action of ["disable", "revoke"]) test(`consecutive explicit ${action} remains authoritative when KV rate limits publication`, async () => {
  const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values), limit = rateLimitKv(env);
  const active = await putGrantCredentials(env, key, legacyGrant());
  await assert.rejects(() => action === "revoke" ? revokeGrantCredentials(env, key) : putGrantCredentials(env, key, { ...active, enabled: false }, true), (error) => error.code === "credential_owner_error");
  const owner = env.GRANT_CREDENTIALS.objects.get(key), record = owner.values.get("credential");
  assert.equal(record.enabled, false);
  assert.equal(owner.alarm(), null);
  assert.equal(values.get(key).enabled, true, "the rejected projection remains visibly stale");
  if (action === "revoke") { assert.ok(record.revokedAt); assert.equal(record.accessToken, undefined); assert.equal(record.refreshToken, undefined); }
  await assert.rejects(() => materializeGrantCredentials(env, key, active, "openai", refreshConfig(), false), (error) => error.code === "credential_owner_error");
  limit.advance();
  await assert.rejects(() => materializeGrantCredentials(env, key, active, "openai", refreshConfig(), false), (error) => error.code === "grant_disabled");
  assert.equal(values.get(key).enabled, false);
  assert.equal(values.get(key).credentialGeneration, record.generation);
});

test("paused grants can be revoked into a secretless tombstone and require fresh credentials to reconnect", async () => {
  const key = "oauth/policy/openai";
  const values = new Map();
  const env = credentialEnv(values);
  const stale = legacyGrant({ scopes: ["inference"], subscription: { plan: "fixture-plan", subject: "fixture-subject" }, maintenance: { keepWarm: false } });
  const active = await putGrantCredentials(env, key, stale);
  assert.ok(env.GRANT_CREDENTIALS.objects.get(key).values.get("credential"));
  const paused = await putGrantCredentials(env, key, { ...active, enabled: false }, true);
  assert.equal(paused.revokedAt, null);
  assert.equal(paused.hasAccessToken, true);
  assert.equal(paused.hasRefreshToken, true);
  await assert.rejects(() => materializeGrantCredentials(env, key, paused, "openai", refreshConfig(), false), (error) => error.code === "grant_disabled");
  const revoked = await revokeGrantCredentials(env, key);
  const owner = env.GRANT_CREDENTIALS.objects.get(key);
  const tombstone = owner.values.get("credential");
  assert.equal(tombstone.enabled, false);
  assert.ok(tombstone.revokedAt);
  assert.equal(tombstone.generation, paused.credentialGeneration + 1);
  for (const field of ["label", "accountId", "subscription", "scopes", "expiresAt", "maintenance", "createdAt"]) assert.deepEqual(revoked[field], active[field], `revocation preserves non-secret ${field}`);
  assert.equal(JSON.stringify(tombstone).includes("access-old"), false);
  assert.equal(JSON.stringify(tombstone).includes("refresh-old"), false);
  assert.equal(owner.alarm(), null);
  for (const old of [stale, active, paused]) await assert.rejects(() => materializeGrantCredentials(env, key, old, "openai", refreshConfig(), false), (error) => error.code === "grant_disabled");
  assert.equal((await revokeGrantCredentials(env, key)).credentialGeneration, revoked.credentialGeneration);
  await assert.rejects(() => putGrantCredentials(env, key, { ...revoked, enabled: true }, true), (error) => error.code === "invalid_upstream_grant");
  const reconnected = await putGrantCredentials(env, key, { ...revoked, enabled: true, accessToken: "replacement-fixture" }, true);
  assert.equal(reconnected.credentialGeneration, revoked.credentialGeneration + 1);
  assert.equal(reconnected.revokedAt, null);
  assert.equal(reconnected.hasRefreshToken, false);
  assert.equal((await materializeGrantCredentials(env, key, reconnected, "openai", refreshConfig(), false)).accessToken, "replacement-fixture");
});

test("stale materialization cannot undo disable or overwrite current lifecycle metadata", async () => {
  const key = "oauth/policy/anthropic", values = new Map(), env = credentialEnv(values);
  const active = await putGrantCredentials(env, key, legacyGrant({ provider: "anthropic", maintenance: { keepWarm: true } }));
  const disabled = await putGrantCredentials(env, key, { ...active, enabled: false, label: "paused", maintenance: { keepWarm: false } }, true);
  await assert.rejects(() => materializeGrantCredentials(env, key, active, "anthropic", refreshConfig(), false), (error) => error.code === "grant_disabled");
  const owner = env.GRANT_CREDENTIALS.objects.get(key);
  assert.equal(owner.values.get("credential").enabled, false);
  assert.equal(owner.alarm(), null);
  assert.deepEqual(values.get(key), disabled);
});

test("a delayed materialization response cannot publish over a later disable", async () => {
  const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
  const active = await putGrantCredentials(env, key, legacyGrant());
  const get = env.GRANT_CREDENTIALS.get.bind(env.GRANT_CREDENTIALS);
  let release, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  env.GRANT_CREDENTIALS.get = (id) => ({ fetch: async (url, init) => {
    const response = await get(id).fetch(url, init);
    if (new URL(url).pathname === "/materialize") { entered(); await held; }
    return response;
  } });
  const earlier = materializeGrantCredentials(env, key, { ...active, credentialGeneration: 0 }, "openai", refreshConfig(), false);
  await ready;
  const disabled = await putGrantCredentials(env, key, { ...active, enabled: false }, true);
  release();
  await earlier;
  assert.deepEqual(values.get(key), disabled);
});

test("existing owners seed metadata once without adopting stale caller lifecycle state", async () => {
  const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
  const active = await putGrantCredentials(env, key, legacyGrant());
  const disabled = await putGrantCredentials(env, key, { ...active, enabled: false, label: "owner metadata" }, true);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), record = owner.values.get("credential");
  delete record.metadata;
  owner.values.set("credential", record);
  await assert.rejects(() => materializeGrantCredentials(env, key, active, "openai", refreshConfig(), false), (error) => error.code === "grant_disabled");
  assert.equal(owner.values.get("credential").metadata.label, disabled.label);
  assert.equal(owner.values.get("credential").enabled, false);
});

test("a pre-owner KV revocation blocks stale legacy migration", async () => {
  const key = "oauth/policy/openai", stale = legacyGrant();
  const values = new Map([[key, { provider: "openai", kind: "subscription", enabled: false, revokedAt: "2026-09-01T00:00:00.000Z" }]]);
  const env = credentialEnv(values);
  await assert.rejects(() => materializeGrantCredentials(env, key, stale, "openai", refreshConfig(), false), (error) => error.code === "grant_disabled");
  assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.get("credential").accessToken, undefined);
});

test("revocation never restores secrets after failed pool or KV publication, and retry is idempotent", async () => {
  for (const failure of ["pool", "kv"]) {
    const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
    const active = await putGrantCredentials(env, key, legacyGrant());
    const owner = env.GRANT_CREDENTIALS.objects.get(key);
    let fail = true;
    const put = env.POLICY_KV.put;
    env.POLICY_KV.put = async (...args) => {
      if (failure === "kv" && fail) { fail = false; throw new Error("fixture KV failure"); }
      return put(...args);
    };
    const get = env.ACCESS_CONTROL.get;
    env.ACCESS_CONTROL.get = (id) => ({ fetch: async (url, init) => {
      if (failure === "pool" && fail) { fail = false; throw new Error("fixture index failure"); }
      return get(id).fetch(url, init);
    } });
    await assert.rejects(() => revokeGrantCredentials(env, key), (error) => error.code === "credential_owner_error");
    const tombstone = owner.values.get("credential");
    assert.equal(tombstone.enabled, false);
    assert.ok(tombstone.revokedAt);
    assert.equal(JSON.stringify(tombstone).includes("access-old"), false);
    assert.equal(JSON.stringify(tombstone).includes("refresh-old"), false);
    assert.equal(owner.alarm(), null);
    await assert.rejects(() => materializeGrantCredentials(env, key, active, "openai", refreshConfig(), false), (error) => error.code === "grant_disabled");
    const retry = await revokeGrantCredentials(env, key);
    assert.equal(retry.credentialGeneration, tombstone.generation);
    assert.deepEqual(values.get(key), retry);
  }
});

test("pool capacity rejection cannot install a credential", async () => {
  const key = "oauth/policy/full", values = new Map(), env = credentialEnv(values);
  for (let i = 0; i < 32; i++) env.grantAuthority.seedLegacy(`oauth/policy/legacy-${i}`, "openai");
  await assert.rejects(() => putGrantCredentials(env, key, legacyGrant()));
  assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.has("credential"), false);
  assert.equal(values.has(key), false);
});

test("a failed owner installation retains its old attachment until a later command reconciles", async () => {
  const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
  const active = await putGrantCredentials(env, key, legacyGrant());
  const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
  let fail = true, release, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  owner.state.storage.put = async (...args) => {
    if (fail) { fail = false; entered(); await held; throw new Error("fixture storage failure"); }
    return put(...args);
  };
  const failed = assert.rejects(() => putGrantCredentials(env, key, { ...active, provider: "anthropic" }, true));
  await ready;
  assert.deepEqual((await env.grantAuthority.call("resolve", { policyId: "policy", providerId: "openai" })).keys, [key]);
  assert.deepEqual((await env.grantAuthority.call("resolve", { policyId: "policy", providerId: "anthropic" })).keys, []);
  let laterFinished = false;
  const later = putGrantCredentials(env, key, { ...active, label: "later update" }, true).then((grant) => { laterFinished = true; return grant; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(laterFinished, false);
  release();
  await failed;
  const final = await later;
  assert.deepEqual((await env.grantAuthority.call("resolve", { policyId: "policy", providerId: "openai" })).keys, [key]);
  assert.equal((await env.grantAuthority.call("resolve", { policyId: "policy", providerId: "anthropic" })).hasAttachment, false);
  assert.equal(final.label, "later update");
  assert.deepEqual(values.get(key), final);
});

test("a committed owner update remains authoritative when KV publication fails", async () => {
  const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
  const active = await putGrantCredentials(env, key, legacyGrant());
  const put = env.POLICY_KV.put;
  let fail = true;
  env.POLICY_KV.put = async (...args) => { if (fail) { fail = false; throw new Error("fixture KV failure"); } return put(...args); };
  await assert.rejects(() => putGrantCredentials(env, key, { ...active, enabled: false }, true));
  await assert.rejects(() => materializeGrantCredentials(env, key, active, "openai", refreshConfig(), false), (error) => error.code === "grant_disabled");
  assert.equal(values.get(key).enabled, false);
  assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.get("credential").enabled, false);
});

test("metadata updates preserve an owned credential bundle", async () => {
  const key = "oauth/policy/aws";
  const values = new Map(), env = credentialEnv(values);
  const stored = await putGrantCredentials(env, key, { provider: "aws-bedrock", kind: "api_key", credentials: { accessKeyId: "access-fixture", secretAccessKey: "secret-fixture" }, accountId: "old-account", updatedAt: "2026-09-01T00:00:00.000Z" });
  const updated = await putGrantCredentials(env, key, { ...stored, credentials: {}, accountId: "new-account", updatedAt: "2026-09-02T00:00:00.000Z" });
  const materialized = await materializeGrantCredentials(env, key, updated, "aws-bedrock", null, false);
  assert.deepEqual(materialized.credentials, { accessKeyId: "access-fixture", secretAccessKey: "secret-fixture" });
  assert.equal(materialized.accountId, "new-account");
  assert.deepEqual(updated.credentialFields, ["accessKeyId", "secretAccessKey"]);
});

test("OAuth updates preserve an existing refresh token when the provider omits one", async () => {
  const key = "oauth/policy/openai";
  const values = new Map(), env = credentialEnv(values);
  await putGrantCredentials(env, key, legacyGrant());
  const updated = await putGrantCredentials(env, key, {
    provider: "openai",
    kind: "subscription",
    accessToken: "access-new",
    updatedAt: "2026-09-02T00:00:00.000Z",
  }, true);

  const materialized = await materializeGrantCredentials(env, key, updated, "openai", refreshConfig(), false);
  assert.equal(materialized.accessToken, "access-new");
  assert.equal(materialized.refreshToken, "refresh-old");
  assert.equal(updated.hasRefreshToken, true);
});

test("provider refresh metadata can require a JSON token request", async (context) => {
  const key = "oauth/policy/anthropic";
  const values = new Map([[key, legacyGrant({ provider: "anthropic", expiresAt: "2020-01-01T00:00:00.000Z" })]]);
  const env = credentialEnv(values);
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(new Headers(init.headers).get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(init.body), { grant_type: "refresh_token", refresh_token: "refresh-old", client_id: "claude-client" });
    return Response.json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 });
  });
  const refreshed = await materializeGrantCredentials(env, key, values.get(key), "anthropic", {
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    clientId: "claude-client",
    clientIdConfig: null,
    clientSecretConfig: null,
    requestFormat: "json",
    extraParams: {},
  }, true);
  assert.equal(refreshed.accessToken, "access-new");
  assert.equal(refreshed.refreshToken, "refresh-new");
});

test("transient refresh failures schedule one retry window instead of hammering the provider", async (context) => {
  const key = "oauth/policy/refresh-backoff";
  const values = new Map([[key, legacyGrant({ expiresAt: "2020-01-01T00:00:00.000Z" })]]);
  const env = credentialEnv(values);
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("offline"); });
  await assert.rejects(() => materializeGrantCredentials(env, key, values.get(key), "openai", refreshConfig(), false), (error) => error?.code === "grant_refresh_failed");
  assert.equal(values.get(key).accessToken, undefined, "failed legacy refresh still scrubs the migrated KV secret");
  await assert.rejects(() => materializeGrantCredentials(env, key, values.get(key), "openai", refreshConfig(), false), (error) => error?.code === "grant_refresh_failed");
  assert.equal(calls, 1);
  assert.ok(env.GRANT_CREDENTIALS.objects.get(key).alarm() > Date.now());
});

test("a pre-owner CLI tombstone migrates before an alarm can reuse secrets", async (context) => {
  const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
  const active = await putGrantCredentials(env, key, legacyGrant({ refresh: { tokenUrl: "https://token.example/token", extraParams: { audience: "fixture", client_secret: "nested-private" } } }));
  const owner = env.GRANT_CREDENTIALS.objects.get(key), old = owner.values.get("credential");
  delete old.metadata;
  old.nextRefreshAttemptAt = "2020-01-01T00:00:00.000Z";
  old.expiresAt = "2020-01-01T00:00:00.000Z";
  values.set(key, { ...active, enabled: false, revokedAt: "2026-09-01T01:00:00.000Z", provider: "wrong-provider", accountId: "wrong-account" });
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("revoked grant reached provider"); });

  await owner.object.alarm();
  const tombstone = owner.values.get("credential");
  assert.equal(tombstone.enabled, false);
  assert.equal(tombstone.generation, old.generation + 1);
  assert.equal(tombstone.revokedAt, "2026-09-01T01:00:00.000Z");
  assert.equal(tombstone.providerId, "openai");
  assert.equal(tombstone.accountId, "account-test");
  assert.deepEqual(tombstone.refresh.extraParams, { audience: "fixture" });
  assert.doesNotMatch(JSON.stringify(tombstone), /access-old|refresh-old|nested-private/);
  assert.equal(owner.alarm(), null);
  assert.equal(values.get(key).enabled, false);
  assert.equal(values.get(key).hasAccessToken, false);
  await assert.rejects(() => materializeGrantCredentials(env, key, active, "openai", refreshConfig(), true), (error) => error.code === "grant_disabled");
  assert.equal(calls, 0);
});

for (const failure of ["index", "storage"]) test(`negative upgrade migration retries a failed ${failure} before provider I/O`, async (context) => {
  const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
  const active = await putGrantCredentials(env, key, legacyGrant());
  const owner = env.GRANT_CREDENTIALS.objects.get(key);
  delete owner.values.get("credential").metadata;
  values.set(key, { ...active, enabled: false, revokedAt: "2026-09-01T01:00:00.000Z" });
  let syncs = 0, fail = true, providerCalls = 0;
  const get = env.ACCESS_CONTROL.get;
  env.ACCESS_CONTROL.get = (id) => ({ fetch: async (url, init) => {
    if (new URL(url).pathname === "/grant-pools/publish") {
      syncs += 1;
      if (failure === "index" && fail) { fail = false; throw new Error("fixture index unavailable"); }
    }
    return get(id).fetch(url, init);
  } });
  const put = owner.state.storage.put;
  owner.state.storage.put = async (...args) => {
    if (failure === "storage" && fail) { fail = false; throw new Error("fixture storage unavailable"); }
    return put(...args);
  };
  context.mock.method(globalThis, "fetch", async () => { providerCalls += 1; throw new Error("unexpected provider I/O"); });
  await assert.rejects(() => owner.object.alarm());
  if (failure === "storage") assert.equal(owner.values.get("credential").metadata, undefined);
  else {
    assert.equal(owner.values.get("credential").poolSyncPending, true);
    assert.equal(owner.values.get("credential").accessToken, undefined, "negative migration commits its tombstone before index publication");
  }
  assert.equal(values.get(key).enabled, false);
  await owner.object.alarm();
  // An inactive owner has no provider work: one complete finalizer retries
  // the failed index once, without a second no-op publication on the same alarm.
  assert.equal(syncs, failure === "index" ? 2 : 1);
  assert.equal(owner.values.get("credential").enabled, false);
  assert.equal(owner.values.get("credential").accessToken, undefined);
  assert.equal(owner.alarm(), null);
  assert.equal(providerCalls, 0);
});

test("upgrade migration adopts a legacy pause and never adopts a legacy re-enable", async () => {
  for (const [ownerEnabled, kvEnabled] of [[true, false], [false, true]]) {
    const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
    const active = await putGrantCredentials(env, key, legacyGrant());
    const owner = env.GRANT_CREDENTIALS.objects.get(key), old = owner.values.get("credential");
    delete old.metadata;
    old.enabled = ownerEnabled;
    env.grantAuthority.sql.exec("DELETE FROM upstream_grant_pool_versions");
    values.set(key, { ...active, enabled: kvEnabled });
    await owner.object.alarm();
    assert.equal(owner.values.get("credential").enabled, false);
    assert.equal(owner.values.get("credential").accessToken, "access-old", "pause retains secrets without allowing use");
    assert.equal(owner.alarm(), null);
  }
});

test("revocation ignores legacy hints for an existing owner even without KV metadata", async () => {
  const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
  await putGrantCredentials(env, key, legacyGrant({ label: "canonical label" }));
  values.delete(key);
  const tombstone = await revokeGrantCredentials(env, key, { provider: "retired-provider", kind: "api_key", label: "wrong label" });
  assert.equal(tombstone.provider, "openai");
  assert.equal(tombstone.kind, "subscription");
  assert.equal(tombstone.label, "canonical label");
  const repeated = await revokeGrantCredentials(env, key, { provider: "another-provider" });
  assert.deepEqual(repeated, tombstone);
});

test("legacy raw tokens can be replaced or revoked through the owner", async () => {
  const key = "oauth/policy/retired", values = new Map([[key, "raw-token-private"]]), env = credentialEnv(values);
  const tombstone = await revokeGrantCredentials(env, key, { provider: "retired-provider", kind: "oauth", label: "retired account" });
  assert.equal(tombstone.provider, "retired-provider");
  assert.equal(tombstone.label, "retired account");
  assert.equal(tombstone.enabled, false);
  assert.doesNotMatch(JSON.stringify(values.get(key)), /raw-token-private/);
  const replacementKey = "oauth/policy/replacement";
  values.set(replacementKey, "raw-token-private");
  const replacement = await putGrantCredentials(env, replacementKey, legacyGrant());
  assert.equal(replacement.hasAccessToken, true);
  await assert.rejects(() => revokeGrantCredentials(env, "oauth/policy/missing"), (error) => error.status === 404);
});

test("legacy revoke normalizes metadata and removes the previous provider from the pool", async () => {
  const key = "oauth/policy/retired", values = new Map([[key, { provider: "old-provider", account_id: "legacy-account", created_at: "2026-09-01T00:00:00.000Z", access_token: "legacy-private", refresh: { extraParams: { client_secret: "nested-private", audience: "fixture" } } }]]), env = credentialEnv(values);
  env.grantAuthority.seedLegacy(key, "old-provider");
  const tombstone = await revokeGrantCredentials(env, key, { provider: "retired-provider", kind: "oauth" });
  assert.equal((await env.grantAuthority.call("resolve", { policyId: "policy", providerId: "old-provider" })).hasAttachment, false);
  assert.equal((await env.grantAuthority.call("resolve", { policyId: "policy", providerId: "retired-provider" })).hasAttachment, false);
  assert.equal(tombstone.accountId, "legacy-account");
  assert.equal(tombstone.createdAt, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(tombstone.refresh.extraParams, { audience: "fixture" });
  assert.doesNotMatch(JSON.stringify(tombstone), /legacy-private|nested-private/);
});

for (const recovery of ["revoke", "reconnect"]) test(`legacy revoke keeps original pool cleanup after failure and ${recovery}`, async () => {
  const key = "oauth/policy/legacy", values = new Map([[key, legacyGrant({ provider: "old-provider" })]]), env = credentialEnv(values);
  env.grantAuthority.seedLegacy(key, "old-provider");
  let fail = true;
  const get = env.ACCESS_CONTROL.get;
  env.ACCESS_CONTROL.get = (id) => ({ fetch: async (url, init) => {
    if (new URL(url).pathname === "/grant-pools/publish" && fail) { fail = false; throw new Error("fixture pool unavailable"); }
    return get(id).fetch(url, init);
  } });
  await assert.rejects(() => revokeGrantCredentials(env, key, { provider: "retired-provider" }));
  const owner = env.GRANT_CREDENTIALS.objects.get(key), tombstone = owner.values.get("credential");
  assert.equal(tombstone.enabled, false);
  assert.equal(tombstone.providerId, "retired-provider");
  assert.doesNotMatch(JSON.stringify(tombstone), /access-old|refresh-old/);
  if (recovery === "revoke") {
    const retried = await revokeGrantCredentials(env, key, { provider: "ignored-provider" });
    assert.equal(retried.provider, "retired-provider");
    assert.equal(retried.credentialGeneration, tombstone.generation);
    assert.equal((await env.grantAuthority.call("attachment", { key })).attached, false);
  } else {
    await putGrantCredentials(env, key, legacyGrant({ provider: "anthropic", accessToken: "fresh-access" }));
    assert.deepEqual((await env.grantAuthority.call("resolve", { policyId: "policy", providerId: "anthropic" })).keys, [key]);
  }
  assert.equal((await env.grantAuthority.call("resolve", { policyId: "policy", providerId: "old-provider" })).hasAttachment, false);
});

for (const [name, original, usable] of [
  ["scalar", { credential: "scalar-private" }, true],
  ["bundle", { credentials: { apiKey: "bundle-private" } }, true],
  ["invalid", { credential: "" }, false],
  ["reauth", { credentialStore: "durable_object", credentialStatus: "reauth_required", hasAccessToken: true }, false],
]) test(`failed legacy ${name} replacement preserves its previous pool eligibility`, async () => {
  const key = "oauth/policy/custom-account", previous = { provider: "openai", kind: "api_key", enabled: true, ...original };
  const values = new Map([[key, previous]]), env = credentialEnv(values);
  if (usable) env.grantAuthority.seedLegacy(key, "openai");
  env.GRANT_CREDENTIALS.get(key);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
  let fail = true;
  owner.state.storage.put = async (...args) => { if (fail) { fail = false; throw new Error("fixture owner write failed"); } return put(...args); };
  await assert.rejects(() => putGrantCredentials(env, key, { provider: "anthropic", kind: "api_key", credential: "replacement-private" }));
  assert.deepEqual((await env.grantAuthority.call("resolve", { policyId: "policy", providerId: "openai" })).keys, usable ? [key] : []);
  assert.deepEqual((await env.grantAuthority.call("resolve", { policyId: "policy", providerId: "anthropic" })).keys, []);
  assert.equal(owner.values.has("credential"), false);
  assert.deepEqual(values.get(key), previous);
  await revokeGrantCredentials(env, key);
  assert.doesNotMatch(JSON.stringify(owner.values.get("credential")), /scalar-private|bundle-private|replacement-private/);
  assert.equal(values.get(key).hasCredential, false);
  assert.equal(values.get(key).hasAccessToken, false);
});

function credentialEnv(values) {
  return attachGrantCredentialNamespace({
    POLICY_KV: {
      async get(key, type) {
        const value = values.get(key) ?? null;
        return value === null ? null : type === "text" ? typeof value === "string" ? value : JSON.stringify(value) : typeof value === "string" ? JSON.parse(value) : structuredClone(value);
      },
      async put(key, value) { values.set(key, JSON.parse(value)); },
    },
  });
}

function rateLimitKv(env) {
  const put = env.POLICY_KV.put;
  let now = 0, lastWrite = -Infinity, writes = 0;
  env.POLICY_KV.put = async (...args) => {
    if (now - lastWrite < 1_000) throw new Error("KV PUT failed: 429 Too Many Requests");
    await put(...args);
    lastWrite = now; writes += 1;
  };
  return { advance() { now += 1_000; }, writes: () => writes };
}

function legacyGrant(overrides = {}) {
  return {
    version: 1,
    enabled: true,
    provider: "openai",
    kind: "subscription",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    accountId: "account-test",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function refreshConfig() {
  return { tokenUrl: "https://token.example/oauth/token", clientId: "client-test", clientIdConfig: null, clientSecretConfig: null, extraParams: {} };
}
