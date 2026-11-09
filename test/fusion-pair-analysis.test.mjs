import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePairRun, analyzePairRepeats } from '../scripts/fusion-pair-analysis.mjs';

function fixture(outcomes = [[1, 1, 1], [0, 1, 1]], costs = [10, 100, 40]) {
  const strategies = ['cheap', 'strong', 'scope'];
  const run = { version: 1, kind: 'native-pair-repository', complete: true,
    sourceSha: 'a'.repeat(40), datasetDigest: 'b'.repeat(64), qualificationDigest: 'c'.repeat(64),
    config: { cheap: 'cheap-model', strong: 'strong-model', priorCostMicros: 1000 },
    strategies, receipts: [], records: [], calls: [] };
  outcomes.forEach((scores, i) => {
    const taskId = `case-${i}`;
    run.receipts.push({ taskId, oracleTests: 2, oracleSkipped: 0 });
    strategies.forEach((strategy, j) => {
      run.records.push({ taskId, strategy, status: 'complete', score: scores[j], calls: 1,
        costMicros: costs[j], publicPassed: true, verdict: { passed: Boolean(scores[j]), tests: 2, skipped: 0 },
        privateSource: 'do not copy this sentinel' });
      run.calls.push({ trialId: `${taskId}:${strategy}`, model: j === 0 ? 'cheap-model' : 'strong-model', costMicros: costs[j] });
    });
  });
  run.spentOrReservedMicros = 1000 + run.calls.reduce((sum, call) => sum + call.costMicros, 0);
  return run;
}

test('paired analysis separates quality, cost and a matched-cost random mixture', () => {
  const report = analyzePairRun(fixture());
  assert.deepEqual(report.totals.map(({ solved, costMicros }) => [solved, costMicros]), [[1, 20], [2, 200], [2, 80]]);
  assert.deepEqual(report.comparisons, [{ reference: 'cheap', wins: 1, losses: 0, ties: 1 },
    { reference: 'strong', wins: 0, losses: 0, ties: 2 }]);
  assert.equal(report.matchedCostRandomMixture.strongProbability, 1 / 3);
  assert.ok(Math.abs(report.matchedCostRandomMixture.expectedSolved - 4 / 3) < 1e-12);
  assert.equal(report.observedCostSavingWithoutStrongRegressions, true);
  assert.equal(report.observedQualityGainOverBestFixed, false);
  assert.equal(report.controlComplementarity, 0);
  assert.ok(!JSON.stringify(report).includes('sentinel'));
});

test('equal aggregate score cannot hide a lost strong-model repair', () => {
  const report = analyzePairRun(fixture([[0, 1, 0], [1, 0, 1]]));
  assert.deepEqual(report.comparisons[1], { reference: 'strong', wins: 1, losses: 1, ties: 0 });
  assert.equal(report.observedCostSavingWithoutStrongRegressions, false);
  assert.equal(report.controlComplementarity, 1);
  assert.equal(report.controlOracleSolved, 2);
});

test('incomplete, missing, duplicate and unverified outcomes cannot yield a gain', () => {
  for (const mutate of [
    run => { run.complete = false; },
    run => { run.failure = 'unknown_cost'; },
    run => { run.records.pop(); },
    run => { run.records.push(run.records[0]); },
    run => { run.records[0].publicPassed = false; },
    run => { run.records[0].verdict.tests = 1; },
    run => { run.records[0].status = 'running'; },
    run => { run.receipts.push(run.receipts[0]); },
  ]) {
    const run = fixture(); mutate(run); assert.throws(() => analyzePairRun(run));
  }
});

test('unknown charges and dropped or altered ledger entries fail closed', () => {
  for (const mutate of [
    run => { run.calls[0].costMicros = null; },
    run => { run.calls.pop(); },
    run => { run.calls[0].trialId = 'different:cheap'; },
    run => { run.calls[0].model = 'unregistered-model'; },
    run => { run.records[0].costMicros++; },
    run => { run.spentOrReservedMicros++; },
    run => { run.records[0].calls++; },
    run => { run.config.priorCostMicros = Number.MAX_SAFE_INTEGER; },
  ]) {
    const run = fixture(); mutate(run); assert.throws(() => analyzePairRun(run));
  }
});

test('known-cost failed trials remain scored failures and never become successes', () => {
  const run = fixture([[0, 1, 0]]);
  run.records[2].status = 'error'; delete run.records[2].verdict;
  assert.equal(analyzePairRun(run).totals[2].solved, 0);
  run.records[2].score = 1;
  assert.throws(() => analyzePairRun(run), /invalid_or_duplicate/);
});

test('mixture does not extrapolate outside control costs or divide by equal prices', () => {
  for (const costs of [[10, 100, 5], [10, 100, 110], [10, 10, 10]]) {
    assert.equal(analyzePairRun(fixture(undefined, costs)).matchedCostRandomMixture, null);
  }
});

test('observed strong cost may be lower when it finishes in fewer calls', () => {
  const mixture = analyzePairRun(fixture(undefined, [100, 10, 40])).matchedCostRandomMixture;
  assert.equal(mixture.strongProbability, 2 / 3);
  assert.ok(Math.abs(mixture.expectedSolved - 5 / 3) < 1e-12);
});

test('unsafe provenance is not copied into the summary', () => {
  const run = fixture(); run.sourceSha = '/home/private/source';
  assert.throws(() => analyzePairRun(run), /invalid_pair_run/);
  run.sourceSha = 'a'.repeat(40); run.receipts[0].taskId = '../private';
  assert.throws(() => analyzePairRun(run), /invalid_pair_receipt/);
});

function repeats(outcomes, costs) {
  const first = fixture(outcomes, costs);
  first.records.forEach(row => { row.elapsedMs = 100; });
  const second = structuredClone(first);
  second.config.priorCostMicros = first.spentOrReservedMicros;
  second.spentOrReservedMicros = second.config.priorCostMicros + second.calls.reduce((sum, call) => sum + call.costMicros, 0);
  return [first, second];
}

test('repeat analysis counts distinct tasks, preserves rescues and applies every pilot criterion', () => {
  const report = analyzePairRepeats(repeats());
  assert.equal(report.blocks, 2);
  assert.equal(report.distinctTasks, 2);
  assert.equal(report.attemptsPerStrategy, 4);
  assert.equal(report.pilotScreen.passed, true);
  assert.equal(report.comparisons[0].wins, 2);
  assert.equal(report.latencyRatioVersusStrong, 1);
  assert.equal(report.cheapDominatesCandidate, false);
  assert.ok(!JSON.stringify(report).includes('sentinel'));
});

test('same total score cannot conceal a regression in a repeated block', () => {
  const report = analyzePairRepeats(repeats([[0, 1, 0], [1, 0, 1]]));
  assert.equal(report.comparisons[1].losses, 2);
  assert.equal(report.pilotScreen.passed, false);
  assert.equal(report.pilotScreen.noStrongRegressions, false);
});

test('cheap dominance and latency failures prevent a positive repeat screen', () => {
  const runs = repeats([[1, 1, 1]]);
  assert.equal(analyzePairRepeats(runs).cheapDominatesCandidate, true);
  assert.equal(analyzePairRepeats(runs).pilotScreen.passed, false);
  for (const run of runs) run.records.find(row => row.strategy === 'scope').elapsedMs = 201;
  assert.equal(analyzePairRepeats(runs).pilotScreen.withinLatencyLimit, false);
});

test('repeat analysis rejects changed protocols, duplicate blocks, missing time and broken ledgers', () => {
  for (const mutate of [
    runs => { runs[1] = structuredClone(runs[0]); },
    runs => { runs[1].sourceSha = 'd'.repeat(40); },
    runs => { runs[1].config.maxCalls = 20; },
    runs => { runs[1].cheapReasoning = 'high'; },
    runs => { runs[1].pins = { changed: true }; },
    runs => { runs[1].receipts[0].taskDigest = 'e'.repeat(64); },
    runs => { delete runs[1].records[0].elapsedMs; },
    runs => { runs[1].records[0].elapsedMs = -1; },
    runs => { runs[1].config.priorCostMicros++; runs[1].spentOrReservedMicros++; },
    runs => { runs[1].calls[0].costMicros = null; },
  ]) {
    const runs = repeats(); mutate(runs);
    assert.throws(() => analyzePairRepeats(runs));
  }
});

test('repeat protocol comparisons ignore object and receipt ordering', () => {
  const runs = repeats();
  runs[1].config = Object.fromEntries(Object.entries(runs[1].config).reverse());
  runs[1].receipts.reverse(); runs[1].strategies.reverse();
  assert.equal(analyzePairRepeats(runs).pilotScreen.passed, true);
});

test('exactly twenty percent saving meets the cost threshold without rounding drift', () => {
  const report = analyzePairRepeats(repeats(undefined, [10, 100, 80]));
  assert.equal(report.pilotScreen.enoughCostSaving, true);
  assert.equal(report.pilotScreen.passed, true);
});

test('false accepts include a passing verdict with mismatched qualified test counts', () => {
  const runs = repeats();
  const rejected = runs[1].records.find(row => row.strategy === 'scope');
  rejected.score = 0;
  rejected.verdict.tests = 1;
  const report = analyzePairRepeats(runs);
  assert.equal(report.totals.find(row => row.strategy === 'scope').falseAccepts, 1);
  assert.equal(report.pilotScreen.passed, false);
});
