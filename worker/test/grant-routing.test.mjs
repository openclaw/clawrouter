import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_GRANT_ROUTING, grantRoutingPolicy } from "../grant-routing.ts";
import { normalizePolicyRecord } from "../authority-policy.ts";

test("shared membership preserves full owner keys and bounds the total inventory", () => {
  const sharedGrants = { anthropic: ["oauth/source/claude", "oauth/tenants/team/account", "oauth/source/claude", "oauth/source/", "oauth/tenants/account", "oauth/source/account/extra", "oauth/source/bad\u0000" ] };
  const normalized = grantRoutingPolicy({ sharedGrants });
  assert.deepEqual(normalized.sharedGrants, { anthropic: ["oauth/source/claude", "oauth/tenants/team/account"] });
  assert.deepEqual(normalizePolicyRecord({ grantRouting: normalized }, false).grantRouting.sharedGrants, normalized.sharedGrants);
  const many = grantRoutingPolicy({ sharedGrants: { anthropic: Array.from({ length: 32 }, (_, i) => `oauth/source/account-${i}`), openai: ["oauth/source/openai"] } });
  assert.equal(Object.values(many.sharedGrants).flat().length, 32);
});

test("stored policies and runtime routing share defaults for malformed records", () => {
  for (const value of [undefined, null, false, 1, "priority", [], { strategy: "invalid", stickiness: "invalid", staleAfterSeconds: 29, switchAtUsedPercent: NaN, hysteresisPercent: 101, includedQuotaReservePercent: 51, eligibleGrants: [] }]) {
    assert.deepEqual(grantRoutingPolicy(value), DEFAULT_GRANT_ROUTING);
    assert.deepEqual(normalizePolicyRecord({ grantRouting: value }, false).grantRouting, DEFAULT_GRANT_ROUTING);
  }
  const first = grantRoutingPolicy(null);
  first.eligibleGrants.openai = ["changed"];
  assert.deepEqual(grantRoutingPolicy(undefined), DEFAULT_GRANT_ROUTING);
});

test("routing preserves boundary values and restricted empty pools", () => {
  const routing = grantRoutingPolicy({ strategy: "threshold", stickiness: "session", failover: false, environmentFallback: true, staleState: "deny", staleAfterSeconds: 86400, switchAtUsedPercent: 0, hysteresisPercent: 100, includedQuotaReservePercent: 50,
    eligibleGrants: { openai: ["b", "a", "a", "bad/ref", "bad\u0000", 42], anthropic: [], "bad/provider": ["a"], invalid: "a" } });
  assert.deepEqual(routing, { strategy: "threshold", stickiness: "none", failover: false, environmentFallback: true, staleState: "deny", staleAfterSeconds: 86400, switchAtUsedPercent: 0, hysteresisPercent: 100, includedQuotaReservePercent: 50, eligibleGrants: { openai: ["a", "b"], anthropic: [] } });
  assert.deepEqual(normalizePolicyRecord({ grantRouting: routing }, false).grantRouting, routing);
  const refs = Array.from({ length: 40 }, (_, i) => `grant-${i}`);
  assert.deepEqual(grantRoutingPolicy({ eligibleGrants: { openai: refs } }).eligibleGrants.openai, refs.slice(0, 32).sort());
});
