import assert from "node:assert/strict";
import test from "node:test";
import { niceChartMaximum, syntheticUsageTimeline, usageDayMs, usageTimeline } from "../src/usage-analytics.ts";

const summary = { requestCount: 10, successCount: 9, errorCount: 1, inputTokens: 80, outputTokens: 20, totalTokens: 100, actualCostMicros: 500 };

test("usage timeline fills missing UTC days without inventing activity", () => {
  const now = Date.UTC(2026, 5, 24, 18);
  const today = Math.floor(now / usageDayMs) * usageDayMs;
  const timeline = usageTimeline({
    ledger: "ready",
    summary,
    providers: [],
    daily: [{ dayStartMs: today - usageDayMs, requestCount: 10, successCount: 9, errorCount: 1, totalTokens: 100, actualCostMicros: 500 }],
    events: [],
  }, 3, now);

  assert.deepEqual(timeline.map((point) => point.requestCount), [0, 10, 0]);
  assert.deepEqual(timeline.map((point) => point.dayStartMs), [today - 2 * usageDayMs, today - usageDayMs, today]);
});

test("usage timeline does not present the latest event sample as a 30-day series", () => {
  const now = Date.UTC(2026, 5, 24, 18);
  const timeline = usageTimeline({
    ledger: "legacy",
    summary,
    providers: [],
    events: [{ id: "recent", type: "clawrouter.usage.v1", occurred_at_ms: now, tenant_id: "tenant", provider: "openai", reserved_cost_micros: 500, actual_cost_micros: 500, status: "success" }],
  }, 3, now);

  assert.deepEqual(timeline.map((point) => point.requestCount), [0, 0, 0]);
});

test("chart maximum rounds to readable tick intervals", () => {
  assert.equal(niceChartMaximum(0), 4);
  assert.equal(niceChartMaximum(88), 100);
  assert.equal(niceChartMaximum(1), 4);
  assert.equal(niceChartMaximum(11), 16);
  assert.equal(niceChartMaximum(1_284), 1_600);
});

test("synthetic usage timelines preserve their scoped summary totals", () => {
  const timeline = syntheticUsageTimeline(Date.UTC(2026, 5, 24, 18), summary);
  assert.equal(timeline.length, 30);
  assert.equal(timeline.reduce((total, point) => total + point.requestCount, 0), summary.requestCount);
  assert.equal(timeline.reduce((total, point) => total + point.successCount, 0), summary.successCount);
  assert.equal(timeline.reduce((total, point) => total + point.errorCount, 0), summary.errorCount);
  assert.equal(timeline.reduce((total, point) => total + point.totalTokens, 0), summary.totalTokens);
  assert.equal(timeline.reduce((total, point) => total + point.actualCostMicros, 0), summary.actualCostMicros);
});
