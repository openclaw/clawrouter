import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const { default: worker } = await import("../index.ts");
const { PolicyBindingIndexObject, authorityCall } = await import("../authority.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { sha256Hex } = await import("../utils.ts");

const email = "owner@example.com", secret = "fixture-principal-secret", adminToken = "fixture-admin-token";
const authorization = `Bearer clawrouter-live-fixture-${secret}`;

test("canonical owner disable and re-enable apply to issued keys without changing credentials", async (t) => {
  const { env, setUser } = await authorityFixture(t);
  const headers = new Headers({ authorization });
  const enabled = await authenticateProxyKey(headers, env);
  assert.equal(enabled.principalId, email);
  assert.equal(enabled.contentRetentionDisabled, true);
  await setUser(false);
  const disabled = await authenticateProxyKey(headers, env);
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json()).error.code, "principal_disabled");
  await setUser(true);
  assert.equal((await authenticateProxyKey(headers, env)).principalId, email);
});

for (const principalId of [null, "unmaterialized@example.com"]) {
  test(`keys with ${principalId ?? "no owner"} keep their existing authorization contract`, async (t) => {
    const { env } = await authorityFixture(t, principalId);
    const auth = await authenticateProxyKey(new Headers({ authorization }), env);
    assert.ok(!(auth instanceof Response));
    assert.equal(auth.principalId, principalId);
    assert.equal(auth.contentRetentionDisabled, false);
    const response = await worker.fetch(new Request("https://router.example/v1/admin/credentials", { headers: { authorization: `Bearer ${adminToken}` } }), env, {});
    const credential = (await response.json()).credentials[0];
    assert.equal(credential.principalEnabled, true);
    assert.equal(credential.active, true);
  });
}

test("disabled owners are denied before HTTP, discovery, and WebSocket work", async (t) => {
  const { env, setUser } = await authorityFixture(t);
  await setUser(false);
  t.mock.method(globalThis, "fetch", () => assert.fail("disabled principal reached upstream"));
  const context = { waitUntil() { assert.fail("disabled principal started background work"); } };
  for (const [method, path, upgrade] of [
    ["GET", "/v1/models"], ["GET", "/v1/catalog"], ["GET", "/v1/me"], ["GET", "/v1/usage"], ["GET", "/v1/key/inspect"],
    ["POST", "/v1/chat/completions"], ["POST", "/v1/responses"], ["POST", "/v1/messages"],
    ["POST", "/v1/native/openai/v1/responses"], ["POST", "/v1/proxy/openai/responses"],
    ["GET", "/v1/responses", "websocket"], ["GET", "/v1/native/openai/v1/responses", "websocket"],
  ]) {
    const response = await worker.fetch(new Request(`https://router.example${path}`, {
      method, headers: { authorization, ...(upgrade ? { upgrade } : {}), "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture" }) } : {}),
    }), env, context);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal((await response.json()).error.code, "principal_disabled");
  }
});

test("legacy owner IDs agree across admission, credential, overview, tenant, and bootstrap projections", async (t) => {
  const { env, setUser } = await authorityFixture(t, " Owner@Example.com ");
  await setUser(false);
  assert.equal((await authenticateProxyKey(new Headers({ authorization }), env)).status, 403);
  async function get(path) {
    const response = await worker.fetch(new Request(`https://router.example/v1/admin/${path}`, { headers: { authorization: `Bearer ${adminToken}` } }), env, {});
    assert.equal(response.status, 200, path);
    return response.json();
  }
  const credential = (await get("credentials")).credentials[0];
  assert.equal(credential.enabled, true);
  assert.equal(credential.principalEnabled, false);
  assert.equal(credential.active, false);
  assert.equal((await get("overview")).keysActive, 0);
  assert.equal((await get("tenants")).tenants[0].activeKeys, 0);
  const bootstrap = await get("bootstrap");
  assert.deepEqual(bootstrap.credentials[0], credential);
  assert.equal(bootstrap.overview.keysActive, 0);
  assert.equal(bootstrap.tenants[0].activeKeys, 0);
});

async function authorityFixture(t, principalId = email) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = { exec(query, ...bindings) {
    const statement = db.prepare(query);
    if (statement.columns().length) return statement.all(...bindings);
    statement.run(...bindings);
    return [];
  } };
  const authority = new PolicyBindingIndexObject({ storage: { sql } });
  const env = {
    CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256Hex(adminToken),
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: (url, init) => authority.fetch(new Request(url, init)) }) },
    POLICY_KV: { async get() { return null; }, async list() { return { keys: [], list_complete: true }; } },
  };
  const setUser = (enabled) => authorityCall(env, "/users/put", { email, record: { enabled, contentRetentionDisabled: true } });
  await setUser(true);
  await authorityCall(env, "/policies/put", { policyId: "fixture", policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: null } });
  await authorityCall(env, "/credentials/mutate", { credentialId: "fixture", operation: "put", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "token-admin" }, credential: { enabled: true, policyId: "fixture", secretSha256: await sha256Hex(secret), principalId } });
  return { env, setUser };
}
