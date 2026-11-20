import assert from "node:assert/strict";
import test from "node:test";
import { mergeGrantRuntimeState, normalizeGrantRuntimeState } from "../grant-runtime.ts";
import { grantQuotaExhausted, grantQuotaRatio, quotaRuntime } from "../grant-quota.ts";

const now = Date.parse("2030-01-01T00:00:00Z"), iso = offset => new Date(now + offset).toISOString();
const window = (id, remaining = 0, offset = 0) => ({ id, kind: "subscription", unit: "percent", window: id, limit: 100, remaining, resetAt: null, observedAt: iso(offset) });
const state = (windows, offset = 0, extra = {}) => ({ ...quotaRuntime(windows, "provider_response", now + offset), grantRevision: iso(-1000), ...extra });
const weeklyOnly = (offset = 1000) => state([window("weekly", 80, offset)], offset, { source: "provider_probe", windowSnapshots: {
  "five-hour": { observedAt: iso(offset), ids: [] }, weekly: { observedAt: iso(offset), ids: ["weekly"] },
  "weekly-*": { observedAt: iso(offset), ids: [] },
} });

// Fixtures are normalized synthetic observations, not stand-ins for selection or
// merge behavior. No provider traffic, credentials, timers or shared state.
test("a scoped snapshot retires omitted exhaustion and leaves unrelated response limits intact", () => {
  const before = state([window("five-hour"), { ...window("weekly-fable"), models: ["fable"] }, window("rpm", 75)]);
  const merged = mergeGrantRuntimeState(before, weeklyOnly(), now + 1000);
  assert.deepEqual(merged.windows.map(w => [w.id, w.remaining, w.resetAt]), [["rpm", 75, null], ["weekly", 80, null]]);
  assert.equal(merged.status, "available");
  assert.equal(merged.cooldownUntil, null);
  assert.equal(grantQuotaExhausted(merged, "claude-fable"), false);
  assert.equal(grantQuotaRatio(merged, now + 1000), .75);
});

test("persisted snapshot watermarks reject delayed response and probe windows in either delivery order", () => {
  const snapshot = normalizeGrantRuntimeState(JSON.parse(JSON.stringify(weeklyOnly())));
  for (const source of ["provider_response", "provider_probe"]) {
    const delayed = state([window("five-hour"), window("weekly-fable"), window("weekly", 0)], 0, { source });
    for (const [first, second] of [[snapshot, delayed], [delayed, snapshot]]) {
      const result = normalizeGrantRuntimeState(mergeGrantRuntimeState(first, second, now + 1000));
      assert.deepEqual(result.windows.map(w => [w.id, w.remaining]), [["weekly", 80]]);
      assert.equal(result.status, "available");
      const again = mergeGrantRuntimeState(result, delayed, now + 1000);
      assert.deepEqual(again.windows, result.windows);
    }
  }
});

test("a newer response can report a five-hour window again; an older probe cannot erase it", () => {
  const recent = state([window("five-hour", 0, 2000)], 2000);
  for (const [first, second] of [[weeklyOnly(), recent], [recent, weeklyOnly()]]) {
    const result = mergeGrantRuntimeState(first, second, now + 2000);
    assert.equal(result.windows.find(w => w.id === "five-hour").remaining, 0);
    assert.equal(grantQuotaExhausted(result, "claude-sonnet"), true);
    assert.equal(result.status, "cooldown");
  }
});

test("partial response headers and facts-only probes do not clear existing windows or renew their freshness", () => {
  const before = state([window("five-hour"), window("weekly", 80)]);
  for (const incoming of [state([window("weekly", 75, 1000)], 1000), state([], 1000, { source: "provider_probe", account: { displayName: "Fixture" } })]) {
    const result = mergeGrantRuntimeState(before, incoming, now + 1000);
    assert.equal(result.windows.find(w => w.id === "five-hour").remaining, 0);
    assert.equal(result.windows.find(w => w.id === "five-hour").observedAt, iso(0));
    assert.equal(grantQuotaExhausted(result, "claude-sonnet"), true);
  }
});

test("a snapshot still enforces its reported five-hour and model-specific weekly windows", () => {
  const snapshot = state([window("five-hour", 0, 1000), { ...window("weekly-fable", 0, 1000), models: ["fable"] }], 1000, {
    source: "provider_probe", windowSnapshots: { "five-hour": { observedAt: iso(1000), ids: ["five-hour"] }, "weekly-*": { observedAt: iso(1000), ids: ["weekly-fable"] } },
  });
  const result = mergeGrantRuntimeState(weeklyOnly(0), snapshot, now + 1000);
  assert.equal(grantQuotaExhausted(result, "claude-sonnet"), true);
  const noShared = { ...result, windows: result.windows.filter(w => w.id !== "five-hour") };
  assert.equal(grantQuotaExhausted(noShared, "claude-sonnet"), false);
  assert.equal(grantQuotaExhausted(noShared, "claude-fable"), true);
});

test("snapshot replacement never clears an independent active rejection cooldown", () => {
  const rejected = state([], 0, { status: "cooldown", lastSignal: "rate_limited", cooldownUntil: iso(60000) });
  const result = mergeGrantRuntimeState(rejected, weeklyOnly(), now + 1000);
  assert.equal(result.lastSignal, "rate_limited");
  assert.equal(result.cooldownUntil, iso(60000));
  assert.equal(result.status, "cooldown");
});

test("credential replacement drops old snapshot watermarks and old revisions cannot revive them", () => {
  const current = state([window("five-hour", 50, 2000)], 2000, { grantRevision: iso(1500) });
  const result = mergeGrantRuntimeState(weeklyOnly(), current, now + 2000);
  assert.deepEqual(result, current);
  assert.deepEqual(mergeGrantRuntimeState(result, weeklyOnly(), now + 2000), current);
});

test("snapshot normalization rejects invalid scopes, dates, member IDs and unbounded metadata", () => {
  for (const snapshots of [null, [], { "*": { observedAt: iso(0), ids: [] } }, { weekly: null },
    { weekly: { observedAt: "invalid", ids: [] } }, { weekly: { observedAt: iso(0), ids: ["other"] } },
    { "weekly-*": { observedAt: iso(0), ids: ["weekly"] } }, { weekly: { observedAt: iso(0), ids: [42] } },
    { weekly: { observedAt: iso(0), ids: Array(129).fill("weekly") } },
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => ["scope-" + i, { observedAt: iso(0), ids: [] }])),
  ]) assert.throws(() => normalizeGrantRuntimeState(state([], 0, { windowSnapshots: snapshots })), { code: "invalid_authority_request" });
  assert.deepEqual(normalizeGrantRuntimeState(state([], 0, { windowSnapshots: { constructor: { observedAt: iso(0), ids: [] } } })).windowSnapshots.constructor.ids, []);
});
