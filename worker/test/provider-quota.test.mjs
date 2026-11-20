import assert from "node:assert/strict";
import test from "node:test";
import { observeProviderGrantQuota } from "../provider-quota.ts";
import { observeGrantQuotaProbe, grantQuotaExhausted, grantQuotaRatio, validGrantQuotaSnapshot } from "../grant-quota.ts";
import { providerById } from "../providers.ts";

const now = Date.parse("2030-01-01T00:00:00Z"), iso = offset => new Date(now + offset).toISOString();
const provider = providerById("anthropic"), prefix = "anthropic-ratelimit-unified-";
const observe = (values = {}, { status = 429, model = "claude-fable-5-1", id = "anthropic" } = {}) => observeProviderGrantQuota(id,
  { status, headers: new Headers(Object.entries(values).map(([key, value]) => [key === "retry-after" ? key : prefix + key, value])) }, provider.quota, model, now);
const scopedHeaders = () => ({ status: "rejected", "7d-status": "allowed", "7d-utilization": "0.62", "7d-reset": iso(6 * 86400000),
  "7d_oi-status": "rejected", "7d_oi-reset": iso(3600000), "representative-claim": "seven_day_overage_included" });

// These assertions exercise the real compiled manifest, parser and eligibility
// predicates. All response headers/payloads are synthetic; no fetch is needed.
test("weekly-only success headers rank observed shared quota without manufacturing five-hour usage", () => {
  const result = observe({ "7d-utilization": "0.62" }, { status: 200 });
  assert.deepEqual(result.windows.map(w => [w.id, w.remaining, w.resetAt]), [["subscription-seven-day", 38, null]]);
  assert.equal(grantQuotaRatio(result, now), .38);
});

test("modern weekly_all collection overrides a legacy reading and preserves dynamic model scope", () => {
  const result = observeGrantQuotaProbe({ five_hour: null, seven_day: { utilization: 2 }, limits: [
    { kind: "weekly_all", percent: 62 }, { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 100 },
  ], extra_usage: { is_enabled: true, used_credits: 1 } }, provider.quota.probes[0], now);
  assert.deepEqual(result.windows.map(w => [w.id, w.remaining, w.models ?? null, w.resetAt]), [
    ["subscription-seven-day", 38, null, null], ["subscription-seven-day-fable", 0, ["fable"], null],
  ]);
  assert.equal(grantQuotaExhausted(result, "claude-sonnet-5"), false);
  assert.equal(grantQuotaExhausted(result, "claude-fable-5-1"), true);
  assert.equal(result.cooldownUntil, null);
});

test("unrecognized or malformed collection entries do not fabricate quota", () => {
  const probe = provider.quota.probes[0];
  for (const limits of [[{ kind: "unknown", percent: 100 }], [{ kind: "weekly_all", percent: -1 }], [{ kind: "weekly_all", percent: "invalid" }]]) {
    assert.equal(observeGrantQuotaProbe({ five_hour: null, limits }, probe, now), null);
  }
});

test("replacement validation distinguishes absent scopes from malformed present snapshots", () => {
  const probe = provider.quota.probes[0], weekly = { seven_day: { utilization: 20 } };
  for (const five_hour of [{ utilization: "bad" }, {}, "bad", { utilization: 20, resets_at: "bad" }]) {
    assert.equal(validGrantQuotaSnapshot({ ...weekly, five_hour }, probe, now), false);
  }
  for (const limits of [{}, [{ kind: "weekly_all" }], [{ kind: "weekly_all", percent: "bad" }],
    [{ kind: "weekly_scoped", scope: { model: { display_name: "bad/model" } }, percent: 20 }],
    Array(65).fill({ kind: "weekly_all", percent: 20 })]) {
    assert.equal(validGrantQuotaSnapshot({ ...weekly, limits }, probe, now), false);
  }
  for (const payload of [weekly, { ...weekly, five_hour: null }, { five_hour: { utilization: 20, resets_at: null } },
    { limits: [{ kind: "weekly_all", percent: 20 }, { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 90 }] }]) {
    assert.equal(validGrantQuotaSnapshot(payload, probe, now), true);
  }
});

test("model-only rejection uses its own deadline, not a healthy six-day shared reset", () => {
  const result = observe({ ...scopedHeaders(), "retry-after": "90" });
  assert.equal(result.cooldownUntil, null);
  assert.equal(result.lastSignal, "quota");
  assert.equal(grantQuotaExhausted(result, "claude-sonnet-5", 0, true, now), false);
  assert.equal(grantQuotaExhausted(result, "claude-fable-5-1", 0, true, now), true);
  const scoped = result.windows.find(w => w.models);
  assert.deepEqual(scoped.models, ["claude-fable-5-1"]);
  assert.equal(scoped.resetAt, iso(3600000));
  assert.equal(grantQuotaExhausted(result, "claude-fable-5-1", 0, true, now + 3600000), false);
});

test("claim-only and overage billing signals never invent a model-only rejection", () => {
  for (const claim of ["seven_day_overage_included", "seven_day_opus_overage", "unknown_overage"]) {
    const headers = scopedHeaders(); delete headers["7d_oi-status"]; delete headers["7d_oi-reset"];
    const result = observe({ ...headers, "representative-claim": claim, "overage-status": "rejected", "overage-reset": iso(30 * 86400000), "reset": iso(30 * 86400000), "retry-after": "90" });
    assert.equal(result.cooldownUntil, iso(90000));
    assert.equal(result.windows.some(w => w.models), false);
    const unknown = observe({ ...headers, "representative-claim": claim, "overage-reset": iso(30 * 86400000) });
    assert.equal(unknown.cooldownUntil, iso(60000));
    assert.equal(unknown.windows.some(w => w.models), false);
  }
});

test("reported shared rejection without utilization still blocks the account until its reset", () => {
  const result = observe({ ...scopedHeaders(), "5h-status": "rejected", "5h-reset": iso(7200000), "7d-status": "rejected", "7d-reset": iso(6 * 86400000) });
  assert.equal(grantQuotaExhausted(result, "claude-sonnet-5", 0, true, now), true);
  assert.equal(result.windows.find(w => w.id === "subscription-five-hour").remaining, 0);
  assert.equal(result.windows.find(w => w.id === "subscription-seven-day").remaining, 0);
  assert.equal(result.cooldownUntil, iso(86400000)); // Existing bounded cooldown; window retains the real later reset.
  assert.equal(grantQuotaExhausted(result, "claude-sonnet-5", 0, true, now + 86400000), true);
});

test("unknown, contradictory or malformed shared signals retain conservative account cooldown", () => {
  for (const edit of [{ "5h-status": "unknown" }, { "5h-utilization": "1" }, { "7d-utilization": "1" }, { "5h-utilization": "bad" }, { "7d-status": "unknown" }]) {
    const result = observe({ ...scopedHeaders(), ...edit });
    assert.ok(result.cooldownUntil);
    assert.equal(result.windows.some(w => w.models), false);
  }
  const unknownClaim = { ...scopedHeaders(), "7d_oi-status": "", "representative-claim": "unknown_overage", "retry-after": "90" };
  assert.equal(observe(unknownClaim).cooldownUntil, iso(90000));
  for (const model of [null, "unrepresentable/model"]) assert.ok(observe(scopedHeaders(), { model }).cooldownUntil);
  assert.equal(observe({ ...scopedHeaders(), "7d_oi-reset": "bad" }).cooldownUntil, iso(60000));
});

test("healthy shared reset alone is not a rejection deadline and ordinary Retry-After is unchanged", () => {
  assert.equal(observe({ "7d-utilization": "0.2", "7d-reset": iso(6 * 86400000) }).cooldownUntil, iso(60000));
  assert.equal(observe({ "7d-utilization": "0.2", "7d-reset": iso(6 * 86400000), "retry-after": "90" }).cooldownUntil, iso(90000));
  assert.equal(observe(scopedHeaders(), { id: "other" }).cooldownUntil, iso(60000));
  assert.equal(observe(scopedHeaders(), { status: 401 }).lastSignal, "authentication");
});


test("replacement validation rejects malformed ancestors at every configured pointer depth", () => {
  const probe = providerById("openai").quota.probes[0], credits = { balance: 12.5 };
  for (const rate_limit of ["bad", 0, false, [], { primary_window: "bad" }, { secondary_window: [] }]) {
    assert.equal(validGrantQuotaSnapshot({ rate_limit, credits }, probe, now), false, JSON.stringify(rate_limit));
  }
  for (const payload of [{ credits }, { rate_limit: null, credits }, { rate_limit: {}, credits },
    { rate_limit: { primary_window: null, secondary_window: null }, credits },
    { rate_limit: { primary_window: { used_percent: 100, reset_at: iso(3600000) } }, credits }]) {
    assert.equal(validGrantQuotaSnapshot(payload, probe, now), true, JSON.stringify(payload));
  }
  // Pointer components are decoded object keys, never array indices.
  const scalar = { ...probe, windows: [{ ...probe.windows[0], usedPointer: "/a~1b/c~0d/0/used", resetPointer: "/a~1b/c~0d/0/reset" }] };
  assert.equal(validGrantQuotaSnapshot({ "a/b": { "c~d": { "0": { used: 20 } } } }, scalar, now), true);
  for (const payload of [{ "a/b": "bad" }, { "a/b": { "c~d": [] } }, { "a/b": { "c~d": { "0": false } } }]) {
    assert.equal(validGrantQuotaSnapshot(payload, scalar, now), false);
  }
  const collection = { ...provider.quota.probes[0], windows: [provider.quota.probes[0].windows.find(window => window.collection)] };
  collection.windows = collection.windows.map(window => ({ ...window, collection: { ...window.collection, pointer: "/nested/limits" } }));
  assert.equal(validGrantQuotaSnapshot({ nested: "bad" }, collection, now), false);
  assert.equal(validGrantQuotaSnapshot({ nested: [] }, collection, now), false);
  assert.equal(validGrantQuotaSnapshot({ nested: null }, collection, now), true);
  assert.equal(validGrantQuotaSnapshot({ nested: { limits: [] } }, collection, now), true);
  const filtered = { ...collection, windows: collection.windows.map(window => ({ ...window, collection: { ...window.collection, filter: { pointer: "/metadata/kind", equals: "weekly_all" } } })) };
  assert.equal(validGrantQuotaSnapshot({ nested: { limits: [{ metadata: "bad", percent: 20 }] } }, filtered, now), false);
  assert.equal(validGrantQuotaSnapshot({ nested: { limits: [{ metadata: { kind: "unrelated" } }] } }, filtered, now), true);
  for (const field of ["limitPointer", "remainingPointer", "usedPointer", "resetPointer"]) {
    const pointer = { ...probe, windows: [{ ...probe.windows[0], [field]: "/nested/value" }] };
    assert.equal(validGrantQuotaSnapshot({ nested: false, rate_limit: { primary_window: { used_percent: 20 } } }, pointer, now), false);
  }
});
