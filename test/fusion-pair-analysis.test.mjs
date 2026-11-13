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
        costMicros: costs[j], publicPassed: true, verdict: { valid: true, passed: Boolean(scores[j]), tests: 2, skipped: 0 },
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

for (const score of [0, 1]) {
  for (const valid of [false, undefined]) {
    test(`incomplete grade cannot enter pair analysis (score=${score}, valid=${valid})`, () => {
      const run = fixture([[1, 1, score]]);
      if (valid === undefined) delete run.records[2].verdict.valid;
      else run.records[2].verdict.valid = valid;
      assert.throws(() => analyzePairRun(run), /incomplete_pair_grade/);
    });
  }
}

test('an error row cannot hide an incomplete grading attempt', () => {
  const run = fixture([[1, 1, 0]]);
  run.records[2].status = 'error';
  run.records[2].verdict.valid = false;
  assert.throws(() => analyzePairRun(run), /incomplete_pair_grade/);
});

test('repeat analysis rejects an incomplete grade before reporting a pilot gain', () => {
  const runs = repeats();
  runs[1].records[2].verdict.valid = false;
  assert.throws(() => analyzePairRepeats(runs), /incomplete_pair_grade/);
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

test('fixed-control calls cannot use the other registered model', () => {
  for (const [strategy, model] of [['cheap', 'strong-model'], ['strong', 'cheap-model']]) {
    const run = fixture();
    run.calls.find(call => call.trialId.endsWith(`:${strategy}`)).model = model;
    assert.throws(() => analyzePairRun(run), /mismatched_pair_control_model/);
  }
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
    runs => { runs[1].handoffEvidence = true; },
    runs => { runs[1].probeRegressionGate = true; },
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

test('probe-qualified handoff is a distinct validated repeat protocol', () => {
  const runs = repeats();
  for (const run of runs) {
    run.policy = 'edit-handoff'; run.probeRegressionGate = true;
    for (const row of run.records) row.probeRegressionPassed = true;
  }
  runs[0].handoffProbeGate = true;
  assert.throws(() => analyzePairRepeats(runs), /mismatched_pair_protocol/);
  runs[1].handoffProbeGate = true;
  assert.equal(analyzePairRepeats(runs).handoffProbeGate, true);
  for (const value of [null, 1, 'true']) {
    runs[0].handoffProbeGate = value;
    assert.throws(() => analyzePairRun(runs[0]), /invalid_pair_run/);
  }
  runs[0].handoffProbeGate = true;
  runs[0].probeRegressionGate = false;
  assert.throws(() => analyzePairRun(runs[0]), /invalid_pair_run/);
});

test('handoff evidence protocols stay distinct while older notes-only receipts remain compatible', () => {
  const runs = repeats();
  runs[1].handoffEvidence = false;
  assert.equal(analyzePairRepeats(runs).handoffEvidence, false);
  for (const run of runs) run.handoffEvidence = true;
  assert.equal(analyzePairRepeats(runs).handoffEvidence, true);
  assert.equal(analyzePairRun(runs[0]).handoffEvidence, true);
  for (const invalid of [null, 'true', 1]) {
    runs[1].handoffEvidence = invalid;
    assert.throws(() => analyzePairRepeats(runs), /invalid_pair_run/);
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
  rejected.outcome = 'submitted';
  rejected.verdict.tests = 1;
  const report = analyzePairRepeats(runs);
  assert.equal(report.totals.find(row => row.strategy === 'scope').falseAccepts, 1);
  assert.equal(report.pilotScreen.passed, false);
});

test('submission failures stay distinct from budget stops and passing partial patches', () => {
  const runs = repeats([[0, 1, 0], [0, 1, 0]]);
  const rows = runs.flatMap(run => run.records.filter(row => row.strategy === 'scope'));
  rows[0].outcome = 'submitted';
  rows[1].outcome = 'turn_limit';
  rows[2].outcome = 'budget'; rows[2].verdict.passed = true;
  // An older receipt without an outcome cannot establish submission.
  const signals = report => report.totals.find(row => row.strategy === 'scope');
  assert.equal(signals(analyzePairRun(runs[0])).falseAccepts, 1);
  assert.equal(signals(analyzePairRun(runs[1])).falseAccepts, 0);
  const result = signals(analyzePairRepeats(runs));
  assert.equal(result.visiblePassFailures, 4);
  assert.equal(result.falseAccepts, 1);
  assert.equal(result.acceptancePassesWithoutSubmission, 1);
  assert.equal(result.solved, 0);
  assert.equal(analyzePairRepeats(runs).pilotScreen.passed, false);
  rows[2].verdict.tests = 1;
  assert.equal(signals(analyzePairRepeats(runs)).acceptancePassesWithoutSubmission, 0);
});

test('an arm win from another single-model sample is not counted as a mixed-model win', () => {
  const runs = repeats();
  const first = analyzePairRepeats(runs);
  assert.equal(first.comparisons[0].wins, 2);
  assert.deepEqual(first.candidateModelUse, { cheapOnlyAttempts: 0, strongOnlyAttempts: 4,
    mixedAttempts: 0, noCallAttempts: 0, mixedWinsOverCheap: 0 });
  const call = runs[0].calls.find(call => call.trialId === 'case-1:scope');
  call.costMicros -= 10;
  runs[0].calls.push({ ...call, model: 'cheap-model', costMicros: 10 });
  runs[0].records.find(row => row.taskId === 'case-1' && row.strategy === 'scope').calls++;
  const mixed = analyzePairRepeats(runs);
  assert.equal(mixed.candidateModelUse.mixedAttempts, 1);
  assert.equal(mixed.candidateModelUse.mixedWinsOverCheap, 1);
  assert.equal(mixed.candidateModelUse.strongOnlyAttempts, 3);
});


test('single-block savings expose cheap dominance and summed latency', () => {
  const run = fixture([[1, 1, 1]]);
  for (const row of run.records) row.elapsedMs = row.strategy === 'scope' ? 250 : 100;
  const report = analyzePairRun(run);
  assert.equal(report.observedCostSavingWithoutStrongRegressions, true);
  assert.equal(report.costSavingVersusStrong, 0.6);
  assert.equal(report.latencyRatioVersusStrong, 2.5);
  assert.equal(report.cheapDominatesCandidate, true);
  assert.equal(report.totals[2].elapsedMs, 250);
});

test('single-block missing or invalid time cannot establish latency or cheap dominance', () => {
  for (const elapsed of [undefined, null, -1, NaN, '100']) {
    const run = fixture([[1, 1, 1]]);
    for (const row of run.records) row.elapsedMs = 100;
    run.records[2].elapsedMs = elapsed;
    const report = analyzePairRun(run);
    assert.equal(report.totals[2].elapsedMs, null);
    assert.equal(report.latencyRatioVersusStrong, null);
    assert.equal(report.cheapDominatesCandidate, null);
  }
  const run = fixture([[1, 1, 1]]);
  for (const row of run.records) row.elapsedMs = 0;
  assert.equal(analyzePairRun(run).latencyRatioVersusStrong, null);
});

test('agent-time analysis excludes cold grading without changing the legacy default', () => {
  const run = fixture([[1, 1, 1]]);
  for (const row of run.records) {
    row.agentElapsedMs = { cheap: 36, strong: 69, scope: 55 }[row.strategy];
    row.elapsedMs = row.agentElapsedMs + (row.strategy === 'cheap' ? 46 : 1);
  }
  assert.equal(analyzePairRun(run).latencyMetric, 'elapsedMs');
  assert.equal(analyzePairRun(run).cheapDominatesCandidate, false);
  const report = analyzePairRun(run, { latencyMetric: 'agentElapsedMs' });
  assert.equal(report.latencyMetric, 'agentElapsedMs');
  assert.equal(report.cheapDominatesCandidate, true);
  assert.equal(report.latencyRatioVersusStrong, 55 / 69);
  assert.equal(report.totals[0].elapsedMs, 82);
  assert.equal(report.totals[0].agentElapsedMs, 36);
});

test('selected agent time never falls back to total time for missing or invalid measurements', () => {
  for (const value of [undefined, null, -1, NaN, '100']) {
    const run = fixture([[1, 1, 1]]);
    for (const row of run.records) { row.elapsedMs = 100; row.agentElapsedMs = 100; }
    run.records[2].agentElapsedMs = value;
    const report = analyzePairRun(run, { latencyMetric: 'agentElapsedMs' });
    assert.equal(report.totals[2].agentElapsedMs, null);
    assert.equal(report.latencyRatioVersusStrong, null);
    assert.equal(report.cheapDominatesCandidate, null);
  }
  assert.throws(() => analyzePairRun(fixture(), { latencyMetric: 'gradingElapsedMs' }), /invalid_pair_latency_metric/);
});

test('repeated blocks apply the same selected metric to dominance and the pilot screen', () => {
  const runs = repeats([[1, 1, 1]]);
  for (const run of runs) for (const row of run.records) {
    row.agentElapsedMs = row.strategy === 'scope' ? 250 : 100;
    row.elapsedMs = row.strategy === 'cheap' ? 1000 : 100;
  }
  assert.equal(analyzePairRepeats(runs).cheapDominatesCandidate, false);
  const report = analyzePairRepeats(runs, { latencyMetric: 'agentElapsedMs' });
  assert.equal(report.latencyMetric, 'agentElapsedMs');
  assert.equal(report.latencyRatioVersusStrong, 2.5);
  assert.equal(report.cheapDominatesCandidate, true);
  assert.equal(report.pilotScreen.withinLatencyLimit, false);
  assert.equal(report.totals[2].agentElapsedMs, 500);
  delete runs[1].records[0].agentElapsedMs;
  assert.throws(() => analyzePairRepeats(runs, { latencyMetric: 'agentElapsedMs' }), /invalid_pair_elapsed/);
});

test('single-block model use distinguishes rescues, single-model samples and no-call attempts', () => {
  const run = fixture([[0, 1, 1], [1, 1, 1], [0, 0, 0], [0, 1, 1]]);
  const mixed = run.calls.find(call => call.trialId === 'case-0:scope');
  mixed.costMicros -= 10;
  run.calls.push({ ...mixed, model: 'cheap-model', costMicros: 10 });
  run.records.find(row => row.taskId === 'case-0' && row.strategy === 'scope').calls++;
  run.calls.find(call => call.trialId === 'case-1:scope').model = 'cheap-model';
  run.calls = run.calls.filter(call => call.trialId !== 'case-2:scope');
  const empty = run.records.find(row => row.taskId === 'case-2' && row.strategy === 'scope');
  empty.calls = 0; empty.costMicros = 0;
  run.spentOrReservedMicros -= 40;
  assert.deepEqual(analyzePairRun(run).candidateModelUse, { cheapOnlyAttempts: 1, strongOnlyAttempts: 1,
    mixedAttempts: 1, noCallAttempts: 1, mixedWinsOverCheap: 1 });
});


test('probe-gated success requires observed gate passage and preserves legacy repeat compatibility', () => {
  const runs = repeats();
  runs[1].probeRegressionGate = false;
  assert.equal(analyzePairRepeats(runs).probeRegressionGate, false);
  for (const run of runs) {
    run.probeRegressionGate = true;
    for (const row of run.records) row.probeRegressionPassed = true;
  }
  assert.equal(analyzePairRepeats(runs).probeRegressionGate, true);
  runs[0].records[0].probeRegressionPassed = false;
  assert.throws(() => analyzePairRun(runs[0]), /unverified_pair_score/);
  for (const invalid of [null, 1, 'true']) {
    runs[0].probeRegressionGate = invalid;
    assert.throws(() => analyzePairRun(runs[0]), /invalid_pair_run/);
  }
});


test('handoff turn limits are validated and separate repeat protocols', () => {
  const runs = repeats();
  runs[1].handoffMaxTurns = null;
  assert.equal(analyzePairRepeats(runs).handoffMaxTurns, null);
  for (const run of runs) { run.policy = 'edit-handoff'; run.config.maxCalls = 4; run.handoffMaxTurns = 2; }
  assert.equal(analyzePairRepeats(runs).handoffMaxTurns, 2);
  runs[1].handoffMaxTurns = 1;
  assert.throws(() => analyzePairRepeats(runs), /mismatched_pair_protocol/);
  for (const invalid of [0, -1, 4, 1.5, '2']) {
    runs[0].handoffMaxTurns = invalid;
    assert.throws(() => analyzePairRun(runs[0]), /invalid_pair_run/);
  }
});
