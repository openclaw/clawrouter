import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { managedCreateAdmission, requireManagedCreateAdmission } = await import("../upstream-retention-admission.ts");
const { normalizePolicy } = await import("../admin.ts");
const { normalizePolicyRecord } = await import("../authority-policy.ts");
const now = Date.parse("2026-11-03T00:00:00Z"), protocol = "openrouter.video";
const permission = { version: "clawrouter.upstream-retention.v1", allow: [{ providerId: "openrouter", protocol }] };
const owner = { providerId: "openrouter", endpointId: "video", grantKey: "oauth/fixture/original", lineage: "original", routeSha256: "a".repeat(64), policyGeneration: "g1" };
function setup() {
  const policy = { enabled: true, generation: "g1", providers: ["openrouter"], retainRequestContent: false, upstreamRetention: structuredClone(permission) };
  const binding = { providerId: "openrouter", protocol, grantKey: owner.grantKey, routeSha256: owner.routeSha256,
    retention: "allow", expiresAt: new Date(now + 60_000).toISOString() };
  const config = { version: "clawrouter.upstream-retention-bindings.v1", bindings: [binding] };
  return { policy, binding, config, admission(selected = owner, at = now) {
    return managedCreateAdmission(policy, { CLAWROUTER_UPSTREAM_RETENTION_BINDINGS: JSON.stringify(config) }, selected, protocol, at);
  } };
}
test("retention admission intersects exact policy and original grant route without exposing either receipt", () => {
  const f = setup(), result = f.admission(); assert.deepEqual(result, { upstreamRetention: "allowed" }); assert.equal(Object.isFrozen(result), true);
  for (const logging of [false, true]) { f.policy.retainRequestContent = logging; assert.equal(f.admission().upstreamRetention, "allowed"); }
  delete f.policy.upstreamRetention; assert.equal(f.admission().upstreamRetention, "denied");
});
for (const scenario of ["no-policy", "no-binding", "disabled", "provider", "protocol", "generation", "grant", "route", "expired", "duplicate", "unknown-version", "malformed-date", "line-ending", "extra-field"]) {
  test(`retention ${scenario} is denied without a grant/config fallback`, () => {
    const f = setup(); let selected = { ...owner }, at = now;
    if (scenario === "no-policy") delete f.policy.upstreamRetention;
    if (scenario === "no-binding") f.config.bindings = [];
    if (scenario === "disabled") f.policy.enabled = false;
    if (scenario === "provider") f.policy.providers = ["other"];
    if (scenario === "protocol") f.policy.upstreamRetention.allow[0].protocol = "other.video";
    if (scenario === "generation") selected.policyGeneration = "other";
    if (scenario === "grant") selected.grantKey = "oauth/fixture/replacement";
    if (scenario === "route") selected.routeSha256 = "b".repeat(64);
    if (scenario === "expired") at += 60_000;
    if (scenario === "duplicate") f.config.bindings.push(structuredClone(f.binding));
    if (scenario === "unknown-version") f.config.version = "next";
    if (scenario === "malformed-date") f.binding.expiresAt = "forever";
    if (scenario === "line-ending") f.binding.routeSha256 += "\n";
    if (scenario === "extra-field") f.binding.retentionAllowed = true;
    assert.deepEqual(f.admission(selected, at), { upstreamRetention: "denied" });
  });
}
test("environment qualification is explicit and cannot borrow a pooled grant receipt", () => {
  const f = setup(), environment = { ...owner, grantKey: null, lineage: null };
  assert.equal(f.admission(environment).upstreamRetention, "denied");
  f.binding.grantKey = null; assert.equal(f.admission(environment).upstreamRetention, "allowed");
});
test("malformed or absent server configuration and missing original ownership remain default-deny", () => {
  const f = setup();
  for (const config of [undefined, "", "true", "{", "x".repeat(32 * 1024 + 1)]) {
    const env = { CLAWROUTER_UPSTREAM_RETENTION_BINDINGS: config };
    assert.equal(managedCreateAdmission(f.policy, env, owner, protocol, now).upstreamRetention, "denied");
    assert.throws(() => requireManagedCreateAdmission(f.policy, env, owner, protocol), error => error.status === 403 && error.code === "upstream_retention_unqualified");
  }
  assert.equal(managedCreateAdmission(f.policy, {}, undefined, protocol, now).upstreamRetention, "denied");
});
test("admin updates preserve, explicitly clear and validate upstream permission separately from logging", () => {
  const existing = { ...setup().policy, models: null };
  assert.deepEqual(normalizePolicy({ providers: ["openrouter"] }, existing, true).upstreamRetention, permission);
  assert.equal(normalizePolicy({ providers: ["openrouter"], upstreamRetention: null }, existing, true).upstreamRetention, undefined);
  assert.throws(() => normalizePolicy({ providers: ["openrouter"], upstreamRetention: true }, existing, true), error => error.code === "invalid_policy");
  assert.deepEqual(normalizePolicyRecord(existing, false).upstreamRetention, permission);
  assert.equal(normalizePolicyRecord({ ...existing, upstreamRetention: { allow: true } }, false).upstreamRetention, undefined);
});
