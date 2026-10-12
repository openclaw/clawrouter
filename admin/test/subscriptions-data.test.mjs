import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { extname } from "node:path";
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { canProbeGrant, modelHeadroom, planLabel, policyGrants, quotaFree, resetLabel, subscriptionFamilies } = await import("../src/subscriptions-data.ts");

const now = Date.parse("2026-10-11T12:00:00Z");
const policy = { policyId: "pool", tenantId: "tenant", providers: ["anthropic"], grantRouting: { eligibleGrants: {}, staleAfterSeconds: 300, staleState: "allow", includedQuotaReservePercent: 10 } };
const grant = { key: "oauth/pool/max", scope: "policies", scopeId: "pool", tokenRef: "max", kind: "subscription", provider: "anthropic", enabled: true, usable: true, credentialStatus: "active", quotaObservedAt: new Date(now).toISOString(), quotaWindows: [
  { id: "weekly", limit: 100, remaining: 60, resetAt: "2026-10-12T12:00:00Z" },
  { id: "fable", limit: 100, remaining: 0, resetAt: "2026-10-12T12:00:00Z", models: ["fable"] },
] };

test("subscriptions show model-specific free quota and reserve eligibility", () => {
  assert.deepEqual(modelHeadroom(grant, "sonnet", policy, now), { free: 60, eligible: true, stale: false });
  assert.deepEqual(modelHeadroom(grant, "fable", policy, now), { free: 0, eligible: false, stale: false });
  assert.equal(modelHeadroom({ ...grant, quotaWindows: [{ limit: 100, remaining: 10, resetAt: null }] }, "opus", policy, now).eligible, false);
  assert.equal(modelHeadroom({ ...grant, credentialStatus: "reauth_required" }, "sonnet", policy, now).eligible, false);
  assert.equal(modelHeadroom({ ...grant, enabled: false }, "sonnet", policy, now).eligible, false);
  assert.equal(modelHeadroom(grant, "sonnet", { ...policy, grantRouting: { ...policy.grantRouting, staleState: "deny" } }, now + 600000).eligible, false);
});

test("expired and unobserved windows stay unknown; family labels and reset times are readable", () => {
  assert.equal(quotaFree({ limit: 100, remaining: 0, resetAt: "2026-10-10T00:00:00Z" }, now), null);
  assert.equal(quotaFree({ limit: null, remaining: null, resetAt: null }, now), null);
  assert.equal(planLabel("default_claude_max_20x"), "Max 20x");
  assert.equal(planLabel("default_claude_pro"), "Pro");
  assert.deepEqual(subscriptionFamilies([grant]), ["fable", "opus", "sonnet"]);
  assert.equal(resetLabel("2026-10-11T12:30:00Z", now), "in 30m");
  assert.equal(resetLabel(null, now), "Reset unknown");
});

test("policy inventory includes its tenant pool and honors provider and explicit grant restrictions", () => {
  const shared = { ...grant, scope: "tenants", scopeId: "tenant", tokenRef: "shared" };
  const foreign = { ...shared, scopeId: "other-tenant" };
  assert.deepEqual(policyGrants(policy, [grant, shared, foreign]), [grant, shared]);
  assert.deepEqual(policyGrants({ ...policy, grantRouting: { ...policy.grantRouting, eligibleGrants: { anthropic: ["max"] } } }, [grant, shared]), [grant]);
});

test("probe availability follows the manifest rather than assuming refresh tokens", () => {
  const noRefresh = { ...grant, hasRefreshToken: false };
  assert.equal(canProbeGrant(noRefresh, { quota: { probes: [{ grantKinds: ["subscription"], requiresRefreshToken: false }] } }), true);
  assert.equal(canProbeGrant(noRefresh, { quota: { probes: [{ grantKinds: ["subscription"], requiresRefreshToken: true }] } }), false);
  assert.equal(canProbeGrant(noRefresh, undefined), false);
});

test("model freshness uses retained window timestamps rather than recent unrelated traffic", () => {
  const retained = { ...grant, quotaObservedAt: new Date(now).toISOString(), quotaWindows: grant.quotaWindows.map(window => ({ ...window, remaining: 60, observedAt: new Date(now - (window.models ? 600000 : 0)).toISOString() })) };
  const strict = { ...policy, grantRouting: { ...policy.grantRouting, staleState: "deny" } };
  assert.equal(modelHeadroom(retained, "fable", strict, now).eligible, false);
  assert.equal(modelHeadroom(retained, "sonnet", strict, now).eligible, true);
});

test("fail-closed family eligibility requires an applicable live window", () => {
  const strict = { ...policy, grantRouting: { ...policy.grantRouting, staleState: "deny" } };
  const scoped = { ...grant, quotaWindows: [grant.quotaWindows[1]] };
  assert.equal(modelHeadroom(scoped, "sonnet", strict, now).eligible, false);
  assert.equal(modelHeadroom({ ...grant, quotaWindows: [{ limit: 100, remaining: 100, resetAt: "2020-01-01T00:00:00Z" }] }, "sonnet", strict, now).eligible, false);
});
