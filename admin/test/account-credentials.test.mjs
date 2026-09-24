import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import { accountFromInventory, accountKey, accountMutationBody, accountPath, demoAccountView, mergeAccountInventory, readAccountReceipt, readAccountView, upstreamGrantFormFromGrant } from "../src/account-credentials.ts";

registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });

const row = { key: "oauth/team/a", scope: "policies", scopeId: "team", tokenRef: "a", version: 1, provider: "test-provider", kind: "subscription", enabled: false, label: "Old", priority: 100, weight: 1, maintenance: { keepWarm: true }, tokenType: "Bearer", scopes: ["scope"], expiresAt: "2030-01-01T00:00:00Z", accountId: "old-account", subscription: { plan: "old" }, createdAt: null, updatedAt: null, revokedAt: null, hasCredential: false, credentialFields: [], hasAccessToken: true, hasRefreshToken: true, refreshConfigured: true, credentialStatus: "active", usable: false, selectedCount: 19, lastSelectedAt: null, quotaStatus: "limited", quotaObservedAt: "2026-09-01T00:00:00Z", cooldownUntil: null, quotaSource: null, lastProviderSignal: null, quotaWindows: [] };
const form = upstreamGrantFormFromGrant(row);

test("metadata PATCH is field-scoped: omitted keeps, blank explicitly clears", () => {
  assert.deepEqual(accountMutationBody(form, "edit", new Set(), 7), { expectedCredentialGeneration: 7 });
  assert.deepEqual(accountMutationBody({ ...form, label: "", accountId: "", expiresAt: "", removeRefreshToken: true }, "edit", new Set(["label", "accountId", "expiresAt", "removeRefreshToken"]), 7),
    { label: null, accountId: null, expiresAt: null, refreshToken: null, expectedCredentialGeneration: 7 });
  assert.deepEqual(accountMutationBody({ ...form, enabled: true }, "edit", new Set(["enabled"]), 7), { enabled: true, expectedCredentialGeneration: 7 });
});

test("details never send primary material even if a draft contains unsubmitted secrets", () => {
  const body = accountMutationBody({ ...form, accessToken: "synthetic", refreshToken: "synthetic" }, "edit", new Set(["accessToken", "refreshToken"]), 2);
  assert.deepEqual(body, { expectedCredentialGeneration: 2 });
});

test("whole replacement requires fresh primary and resets omitted competing material", () => {
  assert.throws(() => accountMutationBody(form, "replace", new Set(), 7), /fresh primary/);
  const body = accountMutationBody({ ...form, accessToken: "synthetic-new", accountId: "", expiresAt: "" }, "replace", new Set(), 7);
  assert.equal(body.accessToken, "synthetic-new"); assert.equal(body.enabled, false);
  assert.equal(body.accountId, null); assert.equal(body.expiresAt, null);
  for (const field of ["refreshToken", "scopes", "subscription", "refresh", "credentials", "tokenType", "version"]) assert.equal(Object.hasOwn(body, field), false, field);
  assert.equal(body.expectedCredentialGeneration, 7);
});

test("create and legacy recovery have no CAS field; create path remains exact opaque identity", () => {
  const value = { ...form, tokenRef: "acct_b8e6cdab-96fb-4af4-8bc0-e887c82c6af0", accessToken: "synthetic" };
  for (const intent of ["create", "legacy-replace"]) assert.equal(accountMutationBody(value, intent, new Set(), null).expectedCredentialGeneration, undefined);
  assert.equal(accountPath(value), "/v1/admin/upstream-grants/policies/team/acct_b8e6cdab-96fb-4af4-8bc0-e887c82c6af0");
  assert.notEqual(accountKey(value), accountKey({ ...value, scope: "tenants" }));
});

test("API key bundle is exclusive and whitespace-only values are rejected", () => {
  const value = { ...form, kind: "api_key", credential: "", credentialBundle: '{"apiKey":"synthetic"}' };
  assert.deepEqual(accountMutationBody(value, "replace", new Set(), 2).credentials, { apiKey: "synthetic" });
  assert.throws(() => accountMutationBody({ ...value, credential: "synthetic-other" }, "replace", new Set(), 2), /not both/);
  assert.throws(() => accountMutationBody({ ...value, credentialBundle: '{"apiKey":" "}' }, "replace", new Set(), 2), /non-empty/);
  assert.throws(() => accountMutationBody({ ...value, credentialBundle: '{"apiKey":"synthetic-secret' }, "replace", new Set(), 2), error => error.message === "credential bundle must be valid JSON");
  assert.throws(() => accountMutationBody({ ...form, priority: "" }, "edit", new Set(["priority"]), 2), /priority must/);
});

test("owner views and receipts are distinct from optional reporting observations", () => {
  const inventory = accountFromInventory(row), view = demoAccountView(inventory);
  assert.equal(view.selectedCount, undefined); assert.equal(view.quotaStatus, undefined);
  assert.equal(inventory.observations.selectedCount, 19);
  assert.equal(readAccountView(view, row), view);
  assert.equal(readAccountReceipt({ outcome: "committed", grant: view }, row), view);
  assert.throws(() => readAccountReceipt(view, row), /not confirmed/);
  for (const patch of [{ credentialGeneration: 0 }, { publication: "unknown" }, { scope: "tenants" }, { tokenRef: "wrong" }]) assert.throws(() => readAccountView({ ...view, ...patch }, row));
});

test("bootstrap can update only observations on owner rows and cannot erase missing receipts", () => {
  const owner = { ...demoAccountView(accountFromInventory(row)), source: "owner", label: "committed", publication: "pending" };
  const [merged] = mergeAccountInventory([owner], [{ ...row, selectedCount: 22 }]);
  assert.equal(merged.label, "committed"); assert.equal(merged.publication, "pending");
  assert.equal(merged.observations.selectedCount, 22);
  assert.deepEqual(mergeAccountInventory([owner], []), [owner]);
  const bare = { ...accountFromInventory(row), source: "mutation", label: "legacy committed" };
  assert.equal(mergeAccountInventory([bare], [row])[0].label, "legacy committed");
});

test("malformed error detail never bypasses safe owner identity/generation parsing", async () => {
  const { DashboardRequestError } = await import("../src/dashboard-fetch.ts");
  const detail = { grant: { ...demoAccountView(accountFromInventory(row)), credentialGeneration: 8 } };
  const error = new DashboardRequestError(JSON.stringify({ error: { code: "grant_generation_changed", message: "changed", detail } }), 409);
  assert.equal(error.code, "grant_generation_changed"); assert.deepEqual(error.detail, detail);
  assert.equal(new DashboardRequestError("grant_generation_changed", 409).code, null);
  assert.equal(new DashboardRequestError("grant_generation_changed", 409).detail, null);
});

test("inventory never acknowledges an unknown creation or upgrades reporting into an owner read", () => {
  const creation = { status: "unconfirmed", requested: { provider: "test-provider", label: "Requested" }, inspection: "unread", error: "" };
  const attempt = { source: "attempt", key: row.key, scope: row.scope, scopeId: row.scopeId, tokenRef: row.tokenRef, creation };
  assert.deepEqual(mergeAccountInventory([attempt], []), [attempt]);
  const [reported] = mergeAccountInventory([attempt], [row]);
  assert.equal(reported.source, "inventory");
  assert.equal(reported.creation, creation);
  assert.equal(reported.credentialGeneration, undefined);
  assert.equal(reported.publication, undefined);
  assert.deepEqual(mergeAccountInventory([reported], []), [reported]);
  const known = { ...demoAccountView(accountFromInventory(row)), source: "owner", creation };
  const [merged] = mergeAccountInventory([known], [{ ...row, selectedCount: 32 }]);
  assert.equal(merged.creation, creation);
  assert.equal(merged.observations.selectedCount, 32);
  assert.equal("creation" in demoAccountView(known), false);
});
