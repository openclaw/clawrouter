import assert from "node:assert/strict";
import test from "node:test";
import { mergeUsageSnapshots, usageShardName } from "../usage-sharding.ts";

test("usage shards are isolated by tenant and policy", () => {
  assert.equal(usageShardName("tenant_a", "policy"), "policy:tenant_a:policy");
  assert.notEqual(usageShardName("tenant_a", "policy"), usageShardName("tenant_b", "policy"));
});

test("usage snapshots aggregate counters, daily buckets, and deduplicate ordered events", () => {
  const first = { ledger: "legacy", summary: { requestCount: 1, totalTokens: 10 }, providers: [{ provider: "openai", requestCount: 1, totalTokens: 10 }], daily: [{ dayStartMs: 86_400_000, requestCount: 1, totalTokens: 10 }], events: [{ id: "a", occurred_at_ms: 1 }] };
  const second = { ledger: "shard", summary: { requestCount: 2, totalTokens: 20 }, providers: [{ provider: "openai", requestCount: 2, totalTokens: 20 }], daily: [{ dayStartMs: 86_400_000, requestCount: 2, totalTokens: 20 }, { dayStartMs: 172_800_000, requestCount: 1, totalTokens: 5 }], events: [{ id: "b", occurred_at_ms: 3 }, { id: "a", occurred_at_ms: 1 }] };
  const merged = mergeUsageSnapshots([first, second]);
  assert.equal(merged.summary.requestCount, 3);
  assert.equal(merged.summary.totalTokens, 30);
  assert.equal(merged.providers[0].requestCount, 3);
  assert.deepEqual(merged.daily, [
    { dayStartMs: 86_400_000, requestCount: 3, successCount: 0, errorCount: 0, totalTokens: 30, actualCostMicros: 0 },
    { dayStartMs: 172_800_000, requestCount: 1, successCount: 0, errorCount: 0, totalTokens: 5, actualCostMicros: 0 },
  ]);
  assert.deepEqual(merged.events.map((event) => event.id), ["b", "a"]);
});

test("usage snapshots with mixed daily support preserve unavailable rollout semantics", () => {
  const current = { ledger: "shard", summary: { requestCount: 1 }, providers: [], daily: [{ dayStartMs: 86_400_000, requestCount: 1 }], events: [] };
  const legacy = { ledger: "legacy", summary: { requestCount: 2 }, providers: [], events: [] };
  assert.equal(mergeUsageSnapshots([current, legacy]).daily, undefined);
  assert.equal(mergeUsageSnapshots([legacy]).daily, undefined);
  assert.deepEqual(mergeUsageSnapshots([current]).daily, [{ dayStartMs: 86_400_000, requestCount: 1, successCount: 0, errorCount: 0, totalTokens: 0, actualCostMicros: 0 }]);
});
