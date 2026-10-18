import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { credential, digest, fixture, policy, session, sha256 } from "./credential-fixture.mjs";
const { credentialExpiry, credentialExpired } = await import("../credential-lifecycle.ts");
const { authenticateProxyKey, proxyCredentialFailure, proxyKeyVerification } = await import("../proxy-auth.ts");
const { assertControlCallerLive, publicControlAuthorization, authorizeResponseControl } = await import("../response-control-authorization.ts");
const { planBudgetReservation, reserveBudget, markBudgetDispatched, settleBudget } = await import("../accounting.ts");
const { budgetStatus } = await import("../ledgers.ts");
const { dailyBudgetLedgerAddress } = await import("../budget-scope.ts");
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
const { assertPolicyModel } = await import("../policy-models.ts");
const { normalizePolicy } = await import("../admin.ts");

const now = Date.parse("2026-10-18T12:00:00Z"), day = 86_400_000;
const body = { credentialId: "member_key", policyId: "maintainer_access", secretSha256: digest };
const cost = { reserveMicros: 60, basis: "policy_fixed", inputTokens: null, outputTokens: null };
const auth = { policyId: "member", credentialId: "first_key", principalId: "member@example.com", authType: "proxy_key", policy: { ...policy, monthlyBudgetMicros: 500, dailyBudgetMicros: 100, limitHint: "Use the team server." } };
const selection = (tier, model = "openai/gpt-6.1-sol", format = "openai.responses") => ({ endpoint: { request_format: format }, model: { id: model }, body: tier === undefined ? {} : { service_tier: tier } });

test("TTL defaults, personal/admin bounds, configuration, and UTC syntax", () => {
  assert.equal(credentialExpiry(undefined, {}, "personal", now), new Date(now + 180 * day).toISOString());
  for (const [scope, days] of [["personal", 180], ["admin", 366]]) {
    assert.equal(credentialExpiry(new Date(now + days * day).toISOString(), {}, scope, now), new Date(now + days * day).toISOString());
    for (const value of [null, new Date(now).toISOString(), new Date(now + (days + 1) * day).toISOString(), "2027-02-30T00:00:00Z", "2026-11-01T00:00:00+00:00"]) assert.throws(() => credentialExpiry(value, {}, scope, now));
  }
  assert.equal(credentialExpiry(undefined, { CLAWROUTER_CREDENTIAL_DEFAULT_TTL_DAYS: "90", CLAWROUTER_CREDENTIAL_MAX_TTL_DAYS: "60" }, "personal", now), new Date(now + 60 * day).toISOString());
  assert.equal(credentialExpired({}), false);
});

test("expiry rejects entry, authority selection, delayed admission and inspect; rotation renews expired enabled keys", async t => {
  t.mock.method(Date, "now", () => now);
  const secret = "synthetic-member-secret", past = new Date(now - 1).toISOString();
  const env = await fixture(t, [["member_key", { ...credential(), secretSha256: await sha256(secret), expiresAt: past }]]);
  const headers = new Headers({ authorization: `Bearer clawrouter-live-member_key-${secret}` });
  const entry = await authenticateProxyKey(headers, env);
  assert.equal(entry.status, 401);
  assert.equal((await entry.json()).error.code, "proxy_key_expired");
  const inspect = await env.http("/v1/key/inspect", "GET", undefined, { headers: Object.fromEntries(headers) });
  assert.equal(inspect.status, 401);
  assert.deepEqual(await inspect.json(), { error: { code: "proxy_key_expired", message: `Proxy key expired on ${past}; create a new key in the ClawRouter dashboard.` }, expiresAt: past, expired: true, active: false });
  const admission = await env.call("/admission/resolve", { credentialId: "member_key", secretSha256: await sha256(secret), providers: [{ id: "openai" }] });
  assert.equal(admission.selection, undefined);
  assert.deepEqual(admission.pools, {});
  assert.equal(proxyCredentialFailure(admission.credential.credential, admission.policy).code, "proxy_key_expired");
  const listed = await (await env.http("/v1/session/credentials", "GET", undefined, { auth: "session" })).json();
  assert.equal(listed.credentials[0].expired, true);
  assert.equal(listed.credentials[0].active, false);
  assert.equal(listed.credentials[0].expiresAt, past);
  const renewal = await env.http("/v1/session/credentials/member_key/rotate", "POST", { secretSha256: await sha256(secret) }, { auth: "session" });
  assert.equal(renewal.status, 200);
  assert.equal((await renewal.json()).expiresAt, new Date(now + 180 * day).toISOString());
  const verified = await authenticateProxyKey(headers, env);
  const control = publicControlAuthorization(verified);
  await env.call("/credentials/mutate", { credentialId: "member_key", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "token-admin" }, operation: "put", credential: { ...credential(), secretSha256: await sha256(secret), expiresAt: new Date(now + 1).toISOString() } });
  t.mock.method(Date, "now", () => now + 2);
  await assert.rejects(authorizeResponseControl(env, control, { policyGeneration: policy.generation, providerId: "openai" }, new AbortController().signal), error => error.code === "proxy_key_expired");
  t.mock.method(Date, "now", () => now + 181 * day);
  assert.throws(() => assertControlCallerLive(control), error => error.code === "proxy_key_expired");
  assert.ok(proxyKeyVerification(verified));
});

test("new HTTP keys expire; admin updates preserve expiry and secret, stamp legacy keys; personal TTL cannot widen", async t => {
  t.mock.method(Date, "now", () => now);
  const env = await fixture(t, [["legacy_key", credential()]]);
  assert.equal((await env.http("/v1/admin/credentials", "POST", body)).status, 201);
  const expiry = env.credentials.get("member_key").expiresAt;
  assert.equal(expiry, new Date(now + 180 * day).toISOString());
  assert.equal((await env.http("/v1/admin/credentials/member_key", "PUT", { policyId: body.policyId })).status, 200);
  assert.equal(env.credentials.get("member_key").expiresAt, expiry);
  assert.equal(env.credentials.get("member_key").secretSha256, digest);
  assert.equal((await env.http("/v1/admin/credentials/legacy_key", "PUT", { policyId: body.policyId, expiresAt: expiry })).status, 200);
  assert.equal(env.credentials.get("legacy_key").expiresAt, expiry);
  for (const [scope, days, expected] of [["session", 180, 201], ["session", 181, 400], ["admin", 366, 201], ["admin", 367, 400]]) {
    const response = await env.http(`/v1/${scope}/credentials`, "POST", { ...body, credentialId: `key_${scope}_${days}`, expiresAt: new Date(now + days * day).toISOString() }, { auth: scope === "admin" ? "admin" : "session" });
    assert.equal(response.status, expected);
  }
});

