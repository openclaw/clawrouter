import assert from "node:assert/strict";
import test from "node:test";
import { niceChartMaximum, providerChartRows, syntheticUsageTimeline, usageDayMs, usageEventGroups, usageTimeline } from "../src/usage-analytics.ts";

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

test("compound Fusion calls collapse into one request with aggregate cost and wall time", () => {
  const base = { type: "clawrouter.usage.v1", tenant_id: "tenant", provider: "openai", reserved_cost_micros: 0, status: "success", compound_request_id: "req_fusion", compound_request_size: 3, compound_request_started_at_ms: 900 };
  const groups = usageEventGroups([
    { ...base, id: "synth", occurred_at_ms: 2_000, duration_ms: 400, actual_cost_micros: 30, compound_request_stage: "fusion_synthesizer", compound_request_index: null },
    { ...base, id: "adviser-2", occurred_at_ms: 1_500, duration_ms: 300, actual_cost_micros: 20, compound_request_stage: "fusion_adviser", compound_request_index: 2 },
    { ...base, id: "adviser-1", occurred_at_ms: 1_450, duration_ms: 350, actual_cost_micros: 10, compound_request_stage: "fusion_adviser", compound_request_index: 1 },
    { ...base, id: "ordinary", occurred_at_ms: 900, duration_ms: 50, actual_cost_micros: 5, compound_request_id: null },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].primary.id, "synth");
  assert.deepEqual(groups[0].events.map((event) => event.id), ["adviser-1", "adviser-2", "synth"]);
  assert.equal(groups[0].actualCostMicros, 60);
  assert.equal(groups[0].durationMs, 1100);
  assert.equal(groups[0].complete, true);
  assert.equal(groups[1].compound, false);
});

test("truncated Fusion groups are explicitly partial", () => {
  const base = { type: "clawrouter.usage.v1", tenant_id: "tenant", provider: "openai", reserved_cost_micros: 10, actual_cost_micros: 10, status: "success", compound_request_id: "req_partial", compound_request_size: 4 };
  const [group] = usageEventGroups([
    { ...base, id: "synth", occurred_at_ms: 2_000, compound_request_stage: "fusion_synthesizer" },
    { ...base, id: "adviser", occurred_at_ms: 1_000, compound_request_stage: "fusion_adviser", compound_request_index: 1 },
  ]);
  assert.equal(group.complete, false);
  assert.equal(group.expectedCallCount, 4);
  assert.equal(group.actualCostMicros, 20);
});

test("unavailable prices remain distinct from known zero and mixed accounted totals", () => {
  const base = { type: "clawrouter.usage.v1", tenant_id: "tenant", provider: "openai", occurred_at_ms: 1_000, actual_cost_micros: 0, reserved_cost_micros: 0, status: "success" };
  const [unknown, knownZero, mixed] = usageEventGroups([
    { ...base, id: "unknown", cost_basis: "unpriced_usage" },
    { ...base, id: "zero", cost_basis: "manifest_pricing" },
    { ...base, id: "mixed-unknown", compound_request_id: "mixed", cost_basis: "unpriced_usage" },
    { ...base, id: "mixed-known", compound_request_id: "mixed", actual_cost_micros: 5, cost_basis: "manifest_pricing" },
  ]);
  assert.equal(unknown.unpricedRequestCount, 1);
  assert.equal(knownZero.unpricedRequestCount, 0);
  assert.equal(mixed.unpricedRequestCount, 1);
  assert.equal(mixed.actualCostMicros, 5);
  const [historicalDenial] = usageEventGroups([{ ...base, id: "old-denial", status: "client_error", status_code: 400, cost_basis: "unpriced_service_tier" }]);
  assert.equal(historicalDenial.unpricedRequestCount, 0);
  const dayStartMs = Math.floor(Date.now() / usageDayMs) * usageDayMs;
  const daily = { dayStartMs, requestCount: 2, successCount: 2, errorCount: 0, totalTokens: 2, actualCostMicros: 5, unpricedRequestCount: 1 };
  assert.equal(usageTimeline({ summary, events: [], providers: [], daily: [daily, daily] }, 1)[0].unpricedRequestCount, 2);
  const providers = ["a", "b", "c"].map(provider => ({ ...daily, provider }));
  const other = providerChartRows(providers, 2)[1];
  assert.equal(other.provider, "other-providers");
  assert.equal(other.unpricedRequestCount, 2);
  assert.equal(other.actualCostMicros, 10);
  const synthetic = syntheticUsageTimeline(Date.now(), { ...summary, unpricedRequestCount: 3 });
  assert.equal(synthetic.reduce((total, day) => total + day.unpricedRequestCount, 0), 3);
});
