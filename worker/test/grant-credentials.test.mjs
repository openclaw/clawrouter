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

test("revocation retains a secretless tombstone and requires fresh credentials to reconnect", async () => {
  const key = "oauth/policy/openai";
  const values = new Map();
  const env = credentialEnv(values);
  const stale = legacyGrant();
  const active = await putGrantCredentials(env, key, stale);
  assert.ok(env.GRANT_CREDENTIALS.objects.get(key).values.get("credential"));
  const revoked = await revokeGrantCredentials(env, key);
  const owner = env.GRANT_CREDENTIALS.objects.get(key);
  const tombstone = owner.values.get("credential");
  assert.equal(tombstone.enabled, false);
  assert.ok(tombstone.revokedAt);
  assert.equal(tombstone.generation, active.credentialGeneration + 1);
  assert.equal(JSON.stringify(tombstone).includes("access-old"), false);
  assert.equal(JSON.stringify(tombstone).includes("refresh-old"), false);
  assert.equal(owner.alarm(), null);
  for (const old of [stale, active]) await assert.rejects(() => materializeGrantCredentials(env, key, old, "openai", refreshConfig(), false), (error) => error.code === "grant_disabled");
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
    env.ACCESS_CONTROL.get = () => ({ fetch: async () => {
      if (failure === "pool" && fail) { fail = false; throw new Error("fixture index failure"); }
      return new Response("updated");
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
  env.ACCESS_CONTROL.get = () => ({ fetch: async () => new Response("pool full", { status: 400 }) });
  await assert.rejects(() => putGrantCredentials(env, key, legacyGrant()));
  assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.has("credential"), false);
  assert.equal(values.has(key), false);
});

test("a failed owner installation completes pool compensation before a later command", async () => {
  const key = "oauth/policy/openai", values = new Map(), env = credentialEnv(values);
  const active = await putGrantCredentials(env, key, legacyGrant());
  const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
  let fail = true, compensating = false, release, entered, membership = true;
  const ready = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  owner.state.storage.put = async (...args) => {
    if (fail) { fail = false; compensating = true; throw new Error("fixture storage failure"); }
    return put(...args);
  };
  env.ACCESS_CONTROL.get = () => ({ fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (compensating) { compensating = false; entered(); await held; }
    membership = body.enabled;
    return new Response("updated");
  } });
  const failed = assert.rejects(() => putGrantCredentials(env, key, { ...active, enabled: false }, true));
  await ready;
  let laterFinished = false;
  const later = putGrantCredentials(env, key, { ...active, label: "later update" }, true).then((grant) => { laterFinished = true; return grant; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(laterFinished, false);
  release();
  await failed;
  const final = await later;
  assert.equal(membership, true);
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

function credentialEnv(values) {
  return attachGrantCredentialNamespace({
    POLICY_KV: {
      async get(key) { return structuredClone(values.get(key) ?? null); },
      async put(key, value) { values.set(key, JSON.parse(value)); },
    },
  });
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
