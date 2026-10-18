import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { credential, digest, fixture, policy, session, sha256 } from "./credential-fixture.mjs";
const { credentialExpiry, credentialExpired } = await import("../credential-lifecycle.ts");
const { authenticateProxyKey, proxyCredentialFailure, proxyKeyVerification } = await import("../proxy-auth.ts");
const { assertControlCallerLive, publicControlAuthorization, authorizeResponseControl } = await import("../response-control-authorization.ts");
const { planBudgetReservation, reserveBudget, markBudgetDispatched, settleBudget } = await import("../accounting.ts");
const { budgetStatus } = await import("../ledgers.ts");
const { dailyBudgetLedgerAddress, weeklyBudgetLedgerAddress } = await import("../budget-scope.ts");
const { nextWeeklyReset } = await import("../policy-limits.ts");
const { operationAffordability } = await import("../operation-budget.ts");
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { usageEnv, proxyKey } from "./usage-budget-fixture.mjs";
import { memberAccessDiff, provisionMemberAccess, ultrafastPolicyRequest } from "../../scripts/provision-member-access.mjs";
const { assertServiceTier, normalizePolicyTiers } = await import("../service-tiers.ts");
const { assertPolicyModel } = await import("../policy-models.ts");
const { normalizePolicy } = await import("../admin.ts");

const now = Date.parse("2026-10-18T12:00:00Z"), day = 86_400_000;
const body = { credentialId: "member_key", policyId: "maintainer_access", secretSha256: digest };
const cost = { reserveMicros: 60, basis: "policy_fixed", inputTokens: null, outputTokens: null };
const auth = { policyId: "member", credentialId: "first_key", principalId: "member@example.com", authType: "proxy_key", policy: { ...policy, monthlyBudgetMicros: 500, dailyBudgetMicros: 100, limitHint: "Use the team server." } };
const selection = (tier, model = "openai/gpt-6.1-sol", format = "openai.responses") => ({ provider: { id: model.split("/")[0] }, endpoint: { request_format: format }, model: { id: model }, body: tier === undefined ? {} : { service_tier: tier } });

test("existing all-provider policy patches pass the real admin validator and remain idempotent", () => {
  const existing = { ...normalizePolicy({ allProviders: true, providers: [], enabled: false, weeklyBudgetMicros: 5000, tenantId: "stable" }, undefined, false), policyId: "openclaw_stable" };
  const request = ultrafastPolicyRequest(existing);
  const patched = normalizePolicy(request.body, existing, false);
  const { policyId, ...before } = existing;
  assert.deepEqual(patched, { ...before, serviceTiers: request.body.serviceTiers });
  assert.deepEqual(memberAccessDiff([ultrafastPolicyRequest({ ...patched, policyId })], new Map([[request.path, { ...patched, policyId }]])), []);
});

test("Stable and team patches pass the real admin API; other policies and Astra stay restricted", async t => {
  const env = await fixture(t);
  for (const policyId of ["team_server", "openclaw_stable", "members"]) {
    for (const model of ["openai/gpt-6.1-sol", "openai/gpt-6-astra"]) {
      const request = ultrafastPolicyRequest({ ...policy, policyId, providers: [], models: null });
      request.body.serviceTiers.models = { [model]: ["default", "flex", "priority", "ultrafast"] };
      const response = await env.http(request.path, "PUT", request.body);
      assert.equal(response.status, policyId !== "members" && model.endsWith("gpt-6.1-sol") ? 200 : 400);
    }
    const global = await env.http(`/v1/admin/policies/${policyId}`, "PUT", { ...policy, serviceTiers: { allowed: ["default", "ultrafast"] } });
    assert.equal(global.status, 400);
  }
  await env.http("/v1/admin/policies/openclaw_stable", "PUT", { ...policy, providers: [], allProviders: true, weeklyBudgetMicros: 5000, serviceTiers: null });
  let writes = 0;
  const options = { env: { CLAWROUTER_URL: "https://clawrouter.example", CLAWROUTER_ADMIN_TOKEN: "synthetic-admin" }, log() {}, fetchImpl: (url, init) => {
    if (init.method !== "GET") writes++;
    return env.http(new URL(url).pathname, init.method, init.body ? JSON.parse(init.body) : undefined);
  } };
  const args = ["--apply", "--ultrafast-policy", "openclaw_stable"];
  assert.equal((await provisionMemberAccess(args, options)).length, 1);
  assert.deepEqual(await provisionMemberAccess(args, options), []);
  assert.equal(writes, 1);
  const stored = (await (await env.http("/v1/admin/policies")).json()).policies.find(entry => entry.policyId === "openclaw_stable");
  assert.equal(stored.weeklyBudgetMicros, 5000);
  assert.deepEqual(stored.providers, []);
});

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

test("daily leg uses same shard, preserves monthly key, settles both; UTC rollover and principal isolation", async t => {
  t.mock.method(Date, "now", () => now);
  const namespace = sqlBudgetNamespace(t), env = { BUDGET_LEDGER: namespace, USAGE_QUEUE: { send() { throw new Error("unexpected recovery"); } } };
  const plan = planBudgetReservation(auth, "llm.chat", cost);
  assert.deepEqual(plan.legs.map(leg => leg.kind), ["policy", "daily"]);
  assert.equal(plan.legs[0].objectName, plan.legs[1].objectName);
  assert.equal(plan.legs[0].request.windowKey, "default/member/member@example.com/2026-10");
  assert.equal(plan.legs[1].request.windowKey, "default/member/member@example.com/day/2026-10-18");
  const reserved = await reserveBudget(env, auth, "llm.chat", cost);
  await assert.rejects(reserveBudget(env, { ...auth, credentialId: "second_key" }, "llm.chat", cost), error => error.code === "daily_budget_exhausted" && error.message.includes("2026-10-19T00:00:00.000Z") && error.message.includes("Use the team server."));
  assert.equal((await budgetStatus(env, auth.policyId, auth.policy, auth.principalId)).spentMicros, 60, "daily denial releases the earlier monthly hold");
  await markBudgetDispatched(env, reserved);
  await settleBudget(env, reserved, 20);
  const status = await budgetStatus(env, auth.policyId, auth.policy, auth.principalId);
  assert.equal(status.spentMicros, 20);
  assert.equal(status.daily.spentMicros, 20);
  assert.equal(status.daily.remainingMicros, 80);
  await reserveBudget(env, { ...auth, principalId: "another@example.com" }, "llm.chat", cost);
  t.mock.method(Date, "now", () => Date.parse("2026-10-19T00:00:00Z"));
  assert.equal((await budgetStatus(env, auth.policyId, auth.policy, auth.principalId)).daily.spentMicros, 0);
  assert.notEqual(dailyBudgetLedgerAddress("member", auth.policy, auth.principalId, now).windowKey, dailyBudgetLedgerAddress("member", auth.policy, auth.principalId).windowKey);
});

test("daily rollback releases all prior legs on provider rejection or transport failure", async t => {
  for (const failure of ["refuse", "throw"]) {
    const namespace = sqlBudgetNamespace(t);
    const env = { USAGE_QUEUE: { send() { throw new Error("unexpected recovery"); } }, BUDGET_LEDGER: { idFromName: name => name, get: name => name.startsWith("provider:") ? { fetch() { if (failure === "throw") throw new Error("synthetic unavailable"); return Response.json({ allowed: false }); } } : namespace.get(name) } };
    await assert.rejects(reserveBudget(env, auth, "llm.chat", cost, { providerId: "openai", monthlyBudgetMicros: 100 }));
    const status = await budgetStatus(env, auth.policyId, auth.policy, auth.principalId);
    assert.equal(status.spentMicros, 0);
    assert.equal(status.daily.spentMicros, 0);
  }
});

test("weekly ISO windows cross week-years and reset only at Monday midnight UTC", () => {
  for (const [at, week, reset] of [
    ["2020-12-28T00:00:00Z", "2020-W53", "2021-01-04T00:00:00.000Z"],
    ["2021-01-03T23:59:59Z", "2020-W53", "2021-01-04T00:00:00.000Z"],
    ["2021-01-04T00:00:00Z", "2021-W01", "2021-01-11T00:00:00.000Z"],
    ["2024-12-30T00:00:00Z", "2025-W01", "2025-01-06T00:00:00.000Z"],
  ]) {
    const address = weeklyBudgetLedgerAddress("member", auth.policy, auth.principalId, Date.parse(at));
    assert.equal(address.windowKey, `default/member/member@example.com/week/${week}`);
    assert.equal(nextWeeklyReset(Date.parse(at)), reset);
  }
});

test("weekly reservations share the shard, roll back earlier legs, settle and isolate principals", async t => {
  t.mock.method(Date, "now", () => now);
  const weeklyAuth = { ...auth, policy: { ...auth.policy, dailyBudgetMicros: 500, weeklyBudgetMicros: 100 } };
  const namespace = sqlBudgetNamespace(t), env = { BUDGET_LEDGER: namespace };
  const plan = planBudgetReservation(weeklyAuth, "llm.chat", cost);
  assert.deepEqual(plan.legs.map(leg => leg.kind), ["policy", "daily", "weekly"]);
  assert.equal(new Set(plan.legs.map(leg => leg.objectName)).size, 1);
  assert.equal(plan.legs[2].request.windowKey, "default/member/member@example.com/week/2026-W42");
  const reserved = await reserveBudget(env, weeklyAuth, "llm.chat", cost);
  await assert.rejects(reserveBudget(env, { ...weeklyAuth, credentialId: "second_key" }, "llm.chat", cost), error => error.status === 402 && error.code === "weekly_budget_exhausted" && error.message.includes("$0.000100") && error.message.includes("2026-10-19T00:00:00.000Z") && error.message.includes("Use the team server."));
  const held = await budgetStatus(env, auth.policyId, weeklyAuth.policy, auth.principalId);
  assert.deepEqual([held.spentMicros, held.daily.spentMicros, held.weekly.spentMicros], [60, 60, 60]);
  await markBudgetDispatched(env, reserved);
  await settleBudget(env, reserved, 20);
  const settled = await budgetStatus(env, auth.policyId, weeklyAuth.policy, auth.principalId);
  assert.equal(settled.weekly.remainingMicros, 80);
  await reserveBudget(env, { ...weeklyAuth, principalId: "another@example.com" }, "llm.chat", cost);
  t.mock.method(Date, "now", () => Date.parse("2026-10-19T00:00:00Z"));
  const fresh = await budgetStatus(env, auth.policyId, weeklyAuth.policy, auth.principalId);
  assert.equal(fresh.weekly.spentMicros, 0);
  assert.equal(fresh.spentMicros, 20, "monthly spend survives weekly rollover");
});

test("weekly holds roll back on later provider refusal and transport failure", async t => {
  for (const failure of ["refuse", "throw"]) {
    const namespace = sqlBudgetNamespace(t);
    const env = { BUDGET_LEDGER: { idFromName: name => name, get: name => name.startsWith("provider:") ? { fetch() { if (failure === "throw") throw new Error("synthetic unavailable"); return Response.json({ allowed: false }); } } : namespace.get(name) } };
    const weeklyAuth = { ...auth, policy: { ...auth.policy, weeklyBudgetMicros: 100 } };
    await assert.rejects(reserveBudget(env, weeklyAuth, "llm.chat", cost, { providerId: "openai", monthlyBudgetMicros: 100 }));
    const result = await budgetStatus(env, auth.policyId, weeklyAuth.policy, auth.principalId);
    assert.deepEqual([result.spentMicros, result.daily.spentMicros, result.weekly.spentMicros], [0, 0, 0]);
  }
});

test("weekly-only limits enforce pricing, zero and discovery affordability", () => {
  const weeklyAuth = { ...auth, policy: { ...auth.policy, dailyBudgetMicros: null, monthlyBudgetMicros: null, weeklyBudgetMicros: 100, requestCostMicros: 60 } };
  for (const bad of [{ ...cost, basis: "flat_fallback" }, { ...cost, pricingGap: "hosted_tool_fee" }, { ...cost, basis: "unpriced_service_tier" }]) assert.throws(() => planBudgetReservation(weeklyAuth, "llm.chat", bad), error => error.code === "pricing_required");
  assert.throws(() => planBudgetReservation({ ...weeklyAuth, policy: { ...weeklyAuth.policy, weeklyBudgetMicros: 0 } }, "llm.count_tokens", cost), error => error.code === "weekly_budget_exhausted");
  const observation = { policyRemaining: null, providerRemaining: null, weeklyRemaining: 50 };
  assert.deepEqual(operationAffordability(weeklyAuth, {}, null, "llm.chat", {}, observation), { status: "exact-blocked", reasonCode: "weekly_budget_exhausted" });
  assert.equal(operationAffordability(weeklyAuth, {}, null, "llm.chat", {}, { ...observation, weeklyRemaining: 100 }).status, "exact-covered");
  for (const value of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalizePolicy({ providers: ["openai"], weeklyBudgetMicros: value }, undefined, false));
  assert.equal(normalizePolicy({ providers: ["openai"], weeklyBudgetMicros: 5_000_000_000 }, undefined, false).weeklyBudgetMicros, 5_000_000_000);
});

test("daily pricing guard blocks unpriced/gap requests and zero budget; policy hint reaches monthly/model failures", () => {
  const dailyOnly = { ...auth, policy: { ...auth.policy, monthlyBudgetMicros: null } };
  for (const bad of [{ ...cost, basis: "flat_fallback" }, { ...cost, pricingGap: "hosted_tool_fee" }]) assert.throws(() => planBudgetReservation(dailyOnly, "llm.chat", bad), error => error.code === "pricing_required");
  assert.throws(() => planBudgetReservation({ ...dailyOnly, policy: { ...dailyOnly.policy, dailyBudgetMicros: 0 } }, "llm.chat", cost), error => error.code === "daily_budget_exhausted" && error.message.includes("Use the team server."));
  assert.throws(() => planBudgetReservation({ ...auth, policy: { ...auth.policy, monthlyBudgetMicros: 0 } }, "llm.chat", cost), error => error.code === "budget_exhausted" && error.message.includes("Use the team server."));
  assert.throws(() => assertPolicyModel({ ...auth.policy, models: [] }, selection()), error => error.code === "model_not_allowed" && error.message.includes("Use the team server."));
});

test("default tier admission, model override, per-key narrowing, non-OpenAI formats", () => {
  for (const tier of [undefined, "default", "auto", "flex", "fast", "priority", "FAST"]) assert.doesNotThrow(() => assertServiceTier(auth, selection(tier)));
  for (const tier of ["ultrafast", "unknown", 2]) assert.throws(() => assertServiceTier(auth, selection(tier)), error => error.status === 400 && error.code === "service_tier_not_allowed" && error.message.includes("Use the team server."));
  const team = { ...auth, policy: { ...auth.policy, serviceTiers: { allowed: ["default", "flex", "priority"], models: { "openai/gpt-6.1-sol": ["default", "flex", "priority", "ultrafast"] } } } };
  assert.doesNotThrow(() => assertServiceTier(team, selection("ultrafast")));
  assert.throws(() => assertServiceTier(team, selection("ultrafast", "openai/gpt-6-astra")));
  for (const tier of ["fast", "priority"]) assert.throws(() => assertServiceTier({ ...auth, serviceTiers: ["default", "flex"] }, selection(tier)));
  assert.doesNotThrow(() => assertServiceTier(auth, selection("ultrafast", "google/gemini", "google.generate_content")));
  assert.deepEqual(normalizePolicyTiers({ allowed: ["default", "default"] }, new Set()), { allowed: ["default"], models: {} });
  for (const value of [{ allowed: ["Priority"] }, { allowed: ["fast"] }, { allowed: [], models: { unknown: [] } }]) assert.throws(() => normalizePolicyTiers(value, new Set()));
  assert.equal(normalizePolicy({ providers: ["openai"], dailyBudgetMicros: 100, limitHint: "  Team  " }, undefined, false).limitHint, "Team");
  for (const value of [-1, 1.5, "1"]) assert.throws(() => normalizePolicy({ providers: ["openai"], dailyBudgetMicros: value }, undefined, false));
});

test("session key creation cannot widen and inspect returns effective per-model tiers", async t => {
  const env = await fixture(t);
  const rejected = await env.http("/v1/session/credentials", "POST", { ...body, serviceTiers: ["ultrafast"] }, { auth: "session" });
  assert.equal(rejected.status, 400);
  const secret = "synthetic-member-tier-secret";
  assert.equal((await env.http("/v1/session/credentials", "POST", { ...body, secretSha256: await sha256(secret), serviceTiers: ["default", "flex"] }, { auth: "session" })).status, 201);
  const response = await env.http("/v1/key/inspect", "GET", undefined, { headers: { authorization: `Bearer clawrouter-live-member_key-${secret}` } });
  assert.equal(response.status, 200);
  const inspected = await response.json();
  assert.deepEqual(inspected.serviceTiers, ["default", "flex"]);
  assert.ok(Object.keys(inspected.effectiveServiceTiers).length);
  assert.ok(Object.values(inspected.effectiveServiceTiers).every(tiers => !tiers.includes("priority")));
  assert.equal(inspected.expired, false);
  for (const tier of ["fast", "priority"]) {
    const denied = await env.http("/v1/responses", "POST", { model: "openai/gpt-6-astra", service_tier: tier, input: "synthetic" }, { headers: { authorization: `Bearer clawrouter-live-member_key-${secret}` } });
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).error.code, "service_tier_not_allowed");
  }
});

test("key inspection and usage expose the same weekly principal window", async t => {
  const { default: handler } = await import("../index.ts");
  t.mock.method(Date, "now", () => Date.parse("2026-10-18T12:00:00Z"));
  for (const path of ["/v1/key/inspect", "/v1/usage"]) {
    const env = usageEnv([], { limit: null, providerLimit: null, weeklyLimit: 5_000_000_000 });
    const response = await handler.fetch(new Request(`https://clawrouter.example${path}`, { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.budget.weekly, { configured: true, ledger: "durable_object", windowKey: "tenant/maintainer_access/owner@example.com/week/2026-W42", limitMicros: 5_000_000_000, spentMicros: 10, remainingMicros: 90, resetsAt: "2026-10-19T00:00:00.000Z" });
    if (path.endsWith("inspect")) assert.equal(body.weeklyBudgetMicros, 5_000_000_000);
  }
});
