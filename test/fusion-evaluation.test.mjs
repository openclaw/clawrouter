import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFusion } from "../scripts/evaluate-fusion.mjs";

function fixture() {
  const records = [];
  for (const [caseId, domain, single, panel] of [["a", "code", 1, 0], ["b", "research", 0, 1], ["c", "research", 0, 1]]) {
    for (const [strategy, score] of [["single", single], ["panel", panel]]) records.push({
      caseId, domain, trial: 1, strategy, configurationId: strategy + "-v1",
      score, costMicros: strategy === "single" ? 10 : 30, latencyMs: strategy === "single" ? 100 : 300,
      callCount: strategy === "single" ? 1 : 3, status: "completed",
    });
  }
  return { version: 1, evaluationId: "synthetic-test", datasetRevision: "synthetic-v1", graderRevision: "exact-v1", split: "test", records };
}

test('development evaluation requires explicit opt-in and retains its label', () => {
  const input = { ...fixture(), split: 'development' };
  assert.throws(() => evaluateFusion(input, 'single'), /held-out/);
  assert.equal(evaluateFusion(input, 'single', 'development').split, 'development');
  assert.throws(() => evaluateFusion(fixture(), 'single', 'development'), /development/);
});

test("paired evaluation exposes domain regressions, cost, latency and uncertainty", () => {
  const report = evaluateFusion(fixture(), "single"), panel = report.strategies.find((row) => row.strategy === "panel");
  assert.equal(panel.meanScore, 2 / 3);
  assert.equal(panel.worstDomainScore, 0);
  assert.equal(panel.totalCostMicros, 90);
  assert.equal(panel.p95LatencyMs, 300);
  assert.deepEqual(panel.domains, [{ domain: "code", cases: 1, meanScore: 0 }, { domain: "research", cases: 2, meanScore: 1 }]);
  const comparison = report.comparisons[0];
  assert.equal(comparison.wins, 2);
  assert.equal(comparison.losses, 1);
  assert.equal(comparison.meanScoreDelta, 1 / 3);
  assert.ok(comparison.scoreDelta95.low < 0);
  assert.ok(comparison.scoreDelta95.high > 0);
  assert.equal(comparison.meanCostDeltaMicros, 20);
  assert.equal(comparison.meanCostRatio, 3);
  assert.equal(comparison.meanLatencyDeltaMs, 200);
  assert.equal(comparison.meanLatencyRatio, 3);
  assert.deepEqual([comparison.costRatio95.low, comparison.costRatio95.high], [3, 3]);
  assert.deepEqual([comparison.latencyDelta95.low, comparison.latencyDelta95.high], [200, 200]);
  assert.deepEqual(report, evaluateFusion(fixture(), "single"), "bootstrap is reproducible");
});

test("failed calls retain their spend, latency and zero score", () => {
  const input = fixture(), row = input.records.at(-1);
  Object.assign(row, { status: "error", score: 0, latencyMs: 900 });
  const panel = evaluateFusion(input, "single").strategies.find((row) => row.strategy === "panel");
  assert.equal(panel.errorRate, 1 / 3);
  assert.equal(panel.totalCostMicros, 90);
  assert.equal(panel.p95LatencyMs, 900);
});

test("uneven repeat counts cannot overweight one easy case", () => {
  const input = fixture();
  for (let trial = 2; trial <= 10; trial++) input.records.push(...input.records.slice(0, 2).map((row) => ({ ...row, trial })));
  const report = evaluateFusion(input, "single");
  assert.equal(report.strategies[0].meanScore, 1 / 3);
  assert.equal(report.comparisons[0].meanScoreDelta, 1 / 3);
});

for (const [name, change, pattern] of [
  ["missing pair", (x) => x.records.pop(), /Incomplete paired/],
  ["duplicate", (x) => x.records.push({ ...x.records[0] }), /Duplicate/],
  ["mixed configuration", (x) => x.records[0].configurationId = "different", /mix configurations/],
  ["domain drift", (x) => x.records[0].domain = "other", /change domains/],
  ["training split", (x) => x.split = "train", /held-out/],
  ["raw content", (x) => x.records[0].prompt = "private", /fields/],
  ["unknown score", (x) => x.records[0].score = NaN, /score/],
  ["infinite latency", (x) => x.records[0].latencyMs = Infinity, /latency/],
  ["negative spend", (x) => x.records[0].costMicros = -1, /cost/],
  ["precision loss", (x) => x.records[0].costMicros = Number.MAX_SAFE_INTEGER, /precision/],
  ["nonzero error score", (x) => x.records[0].status = "error", /score/],
]) test("rejects " + name, () => {
  const input = fixture(); change(input);
  assert.throws(() => evaluateFusion(input, "single"), pattern);
});

test("a one-case result does not manufacture a confidence interval", () => {
  const input = fixture(); input.records = input.records.slice(0, 2);
  assert.equal(evaluateFusion(input, "single").comparisons[0].scoreDelta95, null);
  assert.equal(evaluateFusion(input, "single").comparisons[0].costRatio95, null);
  assert.equal(evaluateFusion(input, "single").comparisons[0].latencyDelta95, null);
  assert.throws(() => evaluateFusion(input, "missing"), /baseline/);
});

test("resource ratios compare case means instead of averaging per-case ratios", () => {
  const input = fixture(); input.records = input.records.slice(0, 4);
  for (const row of input.records) {
    row.costMicros = row.strategy === 'single' ? (row.caseId === 'a' ? 1 : 9) : 2;
    row.latencyMs = row.costMicros;
  }
  const comparison = evaluateFusion(input, 'single').comparisons[0];
  assert.equal(comparison.meanCostRatio, .4);
  assert.equal(comparison.meanLatencyRatio, .4);
  assert.equal(comparison.costRatio95.low, 2 / 9);
  assert.equal(comparison.costRatio95.high, 2);
  for (let trial = 2; trial <= 10; trial++) input.records.push(...input.records.slice(0, 2).map(row => ({ ...row, trial })));
  assert.deepEqual(evaluateFusion(input, 'single').comparisons[0], comparison);
});

test("zero baselines retain deltas and make undefined ratios explicit", () => {
  const input = fixture();
  for (const row of input.records) if (row.strategy === 'single') { row.costMicros = 0; row.latencyMs = 0; }
  let comparison = evaluateFusion(input, 'single').comparisons[0];
  assert.equal(comparison.meanCostRatio, null);
  assert.equal(comparison.costRatio95, null);
  assert.equal(comparison.latencyRatio95, null);
  assert.equal(comparison.costDelta95.low, 30);
  assert.equal(comparison.latencyDelta95.low, 300);
  input.records[0].costMicros = 10; input.records[0].latencyMs = 100;
  comparison = evaluateFusion(input, 'single').comparisons[0];
  assert.equal(comparison.meanCostRatio, 9);
  assert.equal(comparison.costRatio95, null, 'a zero-denominator resample is not dropped');
  assert.equal(comparison.latencyRatio95, null);
});

test("resource uncertainty preserves paired failures and does not imply savings", () => {
  const input = fixture();
  for (const row of input.records) if (row.strategy === 'panel') {
    row.costMicros = row.caseId === 'a' ? 1 : 20;
    row.latencyMs = row.caseId === 'a' ? 10 : 200;
    if (row.caseId === 'c') { row.status = 'error'; row.score = 0; }
  }
  const comparison = evaluateFusion(input, 'single').comparisons[0];
  assert.equal(comparison.meanCostRatio, 41 / 30);
  assert.ok(comparison.costRatio95.low < 1);
  assert.ok(comparison.costRatio95.high > 1);
  assert.ok(comparison.latencyRatio95.low < 1);
  assert.ok(comparison.latencyRatio95.high > 1);
});

test("unrepresentable latency ratios remain unknown instead of serializing Infinity", () => {
  const input = fixture();
  for (const row of input.records) row.latencyMs = row.strategy === 'single' ? Number.MIN_VALUE : Number.MAX_SAFE_INTEGER;
  const comparison = evaluateFusion(input, 'single').comparisons[0];
  assert.equal(comparison.meanLatencyRatio, null);
  assert.equal(comparison.latencyRatio95, null);
  assert.ok(Number.isFinite(comparison.meanLatencyDeltaMs));
});
