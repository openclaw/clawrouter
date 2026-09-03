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

test("revocation deletes owned credential material", async () => {
  const key = "oauth/policy/openai";
  const values = new Map();
  const env = credentialEnv(values);
  await putGrantCredentials(env, key, legacyGrant());
  assert.ok(env.GRANT_CREDENTIALS.objects.get(key).values.get("credential"));
  await revokeGrantCredentials(env, key);
  assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.has("credential"), false);
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
