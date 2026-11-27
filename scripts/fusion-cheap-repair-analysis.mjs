import assert from 'node:assert/strict';

const arms = ['cascade', 'baseline', 'strong'];

function summarize(rows) {
  return Object.fromEntries(arms.map(arm => {
    const selected = rows.filter(row => row.strategy === arm);
    assert.ok(selected.length);
    return [arm, {
      workflows: selected.length,
      passed: selected.filter(row => row.fullPassed).length,
      falseAccepts: selected.filter(row => row.publicPassed && !row.fullPassed).length,
      costMicros: selected.reduce((sum, row) => sum + row.costMicros, 0),
      meanWorkflowMs: selected.reduce((sum, row) => sum + row.workflowMs, 0) / selected.length,
    }];
  }));
}

function comparison(summary) {
  const candidate = summary.cascade, baseline = summary.baseline;
  assert.ok(baseline.costMicros > 0 && baseline.meanWorkflowMs > 0);
  return {
    costSavingsPercent: 100 * (1 - candidate.costMicros / baseline.costMicros),
    slowdownPercent: 100 * (candidate.meanWorkflowMs / baseline.meanWorkflowMs - 1),
    qualityDifferencePoints: 100 * (candidate.passed / candidate.workflows - baseline.passed / baseline.workflows),
  };
}

// Resample repositories together, retaining every paired task and arm.
export function analyzeCheapRepair(study) {
  const cases = new Map(study.cases.map(row => [row.id, row]));
  assert.equal(cases.size, study.cases.length);
  const paired = new Map();
  for (const row of study.workflows) {
    assert.ok(cases.has(row.caseId) && arms.includes(row.strategy));
    assert.ok(Number.isSafeInteger(row.costMicros) && row.costMicros >= 0);
    assert.ok(Number.isFinite(row.workflowMs) && row.workflowMs > 0);
    assert.equal(typeof row.fullPassed, 'boolean');
    assert.equal(typeof row.publicPassed, 'boolean');
    if (!paired.has(row.caseId)) paired.set(row.caseId, new Map());
    assert.ok(!paired.get(row.caseId).has(row.strategy));
    paired.get(row.caseId).set(row.strategy, row);
  }
  assert.equal(paired.size, cases.size);
  for (const group of paired.values()) assert.equal(group.size, arms.length);
  const summary = summarize(study.workflows), point = comparison(summary);
  const regressions = [...paired].filter(([, group]) => !group.get('cascade').fullPassed
    && (group.get('baseline').fullPassed || group.get('strong').fullPassed)).map(([id]) => id);
  const clusters = new Map();
  for (const row of study.workflows) {
    const repository = cases.get(row.caseId).repository;
    if (!clusters.has(repository)) clusters.set(repository, []);
    clusters.get(repository).push(row);
  }
  const groups = [...clusters].sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => rows);
  let state = 20261128;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
  const draws = Array.from({ length: 10000 }, () => comparison(summarize(
    Array.from({ length: groups.length }, () => groups[Math.floor(random() * groups.length)]).flat(),
  )));
  const intervals = Object.fromEntries(Object.keys(point).map(key => {
    const values = draws.map(draw => draw[key]).sort((a, b) => a - b);
    return [key, [values[Math.floor(0.025 * (values.length - 1))], values[Math.floor(0.975 * (values.length - 1))]]];
  }));
  return {
    arms: summary, comparisonToBaseline: point, regressionCaseIds: regressions,
    passesDevelopmentGate: regressions.length === 0 && summary.cascade.falseAccepts === 0
      && point.costSavingsPercent >= 20 && point.slowdownPercent <= 20,
    bootstrap: { unit: 'repository', clusters: groups.length, draws: draws.length,
      seed: 20261128, generator: 'xorshift32', percentile95: intervals },
    productionQualified: false,
  };
}
