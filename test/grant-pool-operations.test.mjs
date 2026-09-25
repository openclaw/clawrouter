import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { adminRequest } from "../scripts/admin-api.mjs";
import { grantPoolOperationsMain, inventorySummary } from "../scripts/grant-pool-operations.mjs";

const privateValue = "private-account-secret-fixture";
const stamp = "2026-09-01T00:00:00.000Z";
const grant = { key: `oauth/policy/${privateValue}`, provider: "openai", kind: "oauth", enabled: false, updatedAt: stamp, revokedAt: null, credentialStatus: "reauth_required", label: privateValue, accountId: privateValue, credential: privateValue, refreshToken: privateValue, quotaWindows: [{ note: privateValue }], refreshTokenUrl: `https://${privateValue}.example` };
const inventory = { grants: [grant] };
const baseEnv = {
  CLAWROUTER_BASE_URL: "https://clawrouter.openclaw.ai",
  CLAWROUTER_ADMIN_TOKEN: privateValue, CF_ACCESS_CLIENT_ID: privateValue, CF_ACCESS_CLIENT_SECRET: privateValue,
};

async function invoke(request, extra = {}) {
  const lines = [];
  const exitCode = await grantPoolOperationsMain({ env: { ...baseEnv, ...extra }, request, write: line => lines.push(line) });
  const output = lines.join("\n");
  assert.equal(lines.length, 1);
  assert.ok(!output.includes(privateValue), "public output excludes private fixture data");
  assert.ok(!output.includes("Error:"), "public output excludes stacks");
  return { exitCode, output, receipt: JSON.parse(output) };
}

test("operator inventory makes exactly one GET without hosted identity or a readiness endpoint", async () => {
  const calls = [];
  const result = await invoke(async (path, options) => {
    calls.push({ path, ...options });
    return inventory;
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [{ path: "/v1/admin/upstream-grants", method: "GET" }]);
  assert.equal(result.receipt.inventory.disabled, 1);
  assert.equal(result.receipt.operation, "inventory");
  assert.equal(result.receipt.execution, "operator");
  assert.equal(result.receipt.result, "inventory_read");
  assert.deepEqual(Object.keys(result.receipt), ["schema", "operation", "execution", "target", "inventory", "result"]);
});

test("versioned inventory digest is sorted, stable and binds only the specified projection", () => {
  const other = { ...grant, key: "oauth/tenants/tenant/named", enabled: true };
  assert.deepEqual(inventorySummary({ grants: [other, grant] }), inventorySummary({ grants: [grant, other] }));
  const { key, provider, kind, enabled, updatedAt, revokedAt, credentialStatus } = grant;
  const projection = { key, provider, kind, enabled, updatedAt, revokedAt, credentialStatus };
  const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal(inventorySummary(inventory).sha256, sha({ schema: "clawrouter.api-visible-grants.v1", grants: [projection] }));
  assert.equal(inventorySummary(inventory).keyNamesSha256, sha({ schema: "clawrouter.api-visible-grant-keys.v1", keys: [key] }));
  for (const field of ["label", "accountId", "credential", "refreshToken", "refreshTokenUrl", "quotaWindows", "lastSelectedAt", "selectedCount"]) {
    assert.deepEqual(inventorySummary({ grants: [{ ...grant, [field]: "changed-private-observation" }] }), inventorySummary(inventory));
  }
  for (const change of [{ key: "oauth/policy/other" }, { provider: "anthropic" }, { kind: "api_key" }, { enabled: true }, { updatedAt: "2026-09-02T00:00:00.000Z" }, { revokedAt: stamp }, { credentialStatus: "active" }]) {
    assert.notEqual(inventorySummary({ grants: [{ ...grant, ...change }] }).sha256, inventorySummary(inventory).sha256);
  }
  assert.equal(inventorySummary({ grants: [{ key, enabled }] }).sha256, inventorySummary({ grants: [{ key, enabled, provider: null, kind: null, updatedAt: null, revokedAt: null, credentialStatus: null }] }).sha256);
  assert.equal(inventorySummary({ grants: [] }).count, 0);
});

test("malformed or duplicate inventory cannot produce a receipt", async () => {
  const invalid = [null, [], {}, { grants: null }, { grants: [null] }, { grants: [grant, grant] }];
  for (const change of [{ key: "oauth/tenants/name" }, { key: "oauth/policy/account/extra" }, { key: "oauth//account" }, { key: "oauth/policy/\u0000" }, { key: `oauth/policy/${"x".repeat(257)}` }, { enabled: "false" }, { provider: {} }, { kind: [] }, { updatedAt: true }, { credentialStatus: 1 }]) invalid.push({ grants: [{ ...grant, ...change }] });
  for (const value of invalid) {
    const result = await invoke(async () => value);
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.code, "invalid_inventory");
  }
});

test("legacy metadata strings remain observable without imposing current write formats", async () => {
  const legacy = { ...grant, kind: "legacy-kind", credentialStatus: "legacy-status", updatedAt: "2024-01-01T00:00:00Z", revokedAt: "2024-01-02T08:00:00+08:00" };
  const result = await invoke(async () => ({ grants: [legacy] }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt.inventory.revoked, 1);
  assert.notEqual(inventorySummary({ grants: [legacy] }).sha256, inventorySummary({ grants: [{ ...legacy, updatedAt: "2024-01-01T00:00:00.000Z" }] }).sha256, "timestamp bytes are preserved without normalization");
  assert.equal(inventorySummary({ grants: [legacy] }).keyNamesSha256, inventorySummary(inventory).keyNamesSha256);
});

test("revoked count matches owner truthiness while the digest retains empty timestamp bytes", () => {
  for (const [revokedAt, expected] of [[null, 0], ["", 0], [stamp, 1]]) {
    assert.equal(inventorySummary({ grants: [{ ...grant, revokedAt }] }).revoked, expected);
  }
  assert.notEqual(inventorySummary({ grants: [{ ...grant, revokedAt: "" }] }).sha256, inventorySummary({ grants: [{ ...grant, revokedAt: null }] }).sha256);
});

test("the fixed destination is validated before any request", async () => {
  for (const change of [{ CLAWROUTER_BASE_URL: undefined }, { CLAWROUTER_BASE_URL: "https://other.example" }, { CLAWROUTER_BASE_URL: "http://clawrouter.openclaw.ai" }, { CLAWROUTER_BASE_URL: "https://clawrouter.openclaw.ai/extra" }]) {
    let calls = 0;
    const result = await invoke(async () => { calls++; return inventory; }, change);
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.code, "invalid_target");
    assert.equal(calls, 0);
  }
});

test("the shared admin transport carries operator credentials on a GET with no body", async () => {
  let count = 0;
  const result = await invoke((path, options) => adminRequest(path, { ...options, env: baseEnv, fetchImpl: async (url, init) => {
    count++;
    assert.equal(url, "https://clawrouter.openclaw.ai/v1/admin/upstream-grants");
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.authorization, `Bearer ${privateValue}`);
    assert.equal(init.headers["CF-Access-Client-Id"], privateValue);
    assert.equal(init.headers["CF-Access-Client-Secret"], privateValue);
    return Response.json(inventory);
  } }));
  assert.equal(result.exitCode, 0);
  assert.equal(count, 1);
});

test("admin redirects, auth errors, malformed and oversized bodies fail without retries", async () => {
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: `https://${privateValue}.example` } }),
    () => Response.json({ error: { message: privateValue } }, { status: 401 }),
    () => Response.json({ error: { message: privateValue } }, { status: 500 }),
    () => new Response(privateValue, { status: 200 }),
    () => Response.json({ privateValue, padding: "x".repeat(128 * 1024) }),
  ]) {
    let count = 0;
    const request = (path, options) => adminRequest(path, { ...options, env: baseEnv, fetchImpl: async () => { count++; return response(); } });
    const result = await invoke(request);
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.code, "inventory_failed");
    assert.equal(count, 1);
  }
  assert.equal((await invoke(async () => { throw new Error(privateValue, { cause: new Error(privateValue) }); })).receipt.code, "inventory_failed");
});

test("missing operator credentials fail before the default transport sends any request", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => assert.fail("missing credentials must not send a request"));
  for (const change of [{ CLAWROUTER_ADMIN_TOKEN: undefined }, { CF_ACCESS_CLIENT_SECRET: undefined }, { CF_ACCESS_CLIENT_ID: undefined }]) {
    const result = await invoke(undefined, change);
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.code, "inventory_failed");
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});
