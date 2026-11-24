import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arms = ['weak', 'strong', 'fusion'];
const add = (a, b) => {
  const value = a + b;
  assert.ok(Number.isSafeInteger(value) && value >= 0, 'invalid_cost');
  return value;
};

// Selection receives only the public verdict; hidden labels are scored later.
export function fallbackArm(first, publicPassed) {
  assert.ok(first === 'weak' || first === 'fusion', 'invalid_first_arm');
  assert.equal(typeof publicPassed, 'boolean', 'missing_public_verdict');
  return publicPassed ? first : 'strong';
}

export function replayCohort(tasks) {
  assert.ok(Array.isArray(tasks) && tasks.length > 0, 'empty_cohort');
  const ids = new Set();
  for (const task of tasks) {
    assert.ok(typeof task.id === 'string' && task.id && !ids.has(task.id), 'invalid_task_identity');
    ids.add(task.id);
    for (const arm of arms) {
      const row = task.outcomes?.[arm];
      assert.ok(row && typeof row.passed === 'boolean' && typeof row.publicPassed === 'boolean', 'invalid_outcome');
      assert.ok(!row.passed || row.publicPassed, 'inconsistent_outcome');
      assert.ok(Number.isSafeInteger(row.costMicros) && row.costMicros >= 0, 'invalid_cost');
    }
    assert.ok(task.outcomes.fusion.costMicros >= task.outcomes.weak.costMicros, 'fusion_omits_seed_cost');
  }
  const summarize = rows => ({
    passed: rows.filter(row => row.passed).length,
    costMicros: rows.reduce((sum, row) => add(sum, row.costMicros), 0),
    lostStrongSuccesses: rows.filter((row, i) => tasks[i].outcomes.strong.passed && !row.passed).length,
  });
  const baselines = Object.fromEntries(arms.map(arm => [arm, summarize(tasks.map(task => task.outcomes[arm]))]));
  const policies = Object.fromEntries(['weak', 'fusion'].map(first => {
    const rows = tasks.map(task => {
      const initial = task.outcomes[first];
      const selected = fallbackArm(first, initial.publicPassed);
      const final = task.outcomes[selected];
      return { id: task.id, selected, passed: final.passed,
        falseAccept: selected === first && !final.passed,
        costMicros: add(initial.costMicros, selected === 'strong' ? final.costMicros : 0) };
    });
    return [`${first}-public-fallback`, { ...summarize(rows),
      falseAccepts: rows.filter(row => row.falseAccept).map(row => row.id),
      escalations: rows.filter(row => row.selected === 'strong').length, rows }];
  }));
  // This uses hidden truth and is deliberately separate from callable policies.
  const oracle = summarize(tasks.map(task => {
    const { weak, strong } = task.outcomes;
    return { passed: weak.passed || strong.passed,
      costMicros: add(weak.costMicros, weak.passed ? 0 : strong.costMicros) };
  }));
  return { tasks: tasks.length, baselines, policies,
    hiddenLabelDiagnostic: { ...oracle, deployable: false }, qualifiedFusionGain: false };
}

export function replayStudy(study) {
  assert.equal(study.version, 1, 'unsupported_study');
  const cohorts = [
    ['development', study],
    ['confirmation', study.confirmation],
    ['inputValidated', study.validatedFollowup],
  ];
  const allIds = new Set();
  return Object.fromEntries(cohorts.map(([name, cohort]) => {
    const result = replayCohort(cohort.tasks);
    for (const task of cohort.tasks) {
      assert.ok(!allIds.has(task.id), 'overlapping_cohorts');
      allIds.add(task.id);
    }
    for (const arm of arms) {
      assert.equal(result.baselines[arm].passed, cohort.arms[arm].passed, 'summary_mismatch');
      assert.equal(result.baselines[arm].costMicros, cohort.arms[arm].costMicros, 'summary_mismatch');
    }
    const audit = name === 'development' ? cohort.provenance.terminalAuditSha256 : cohort.terminalAuditSha256;
    assert.match(audit, /^[a-f0-9]{64}$/, 'invalid_audit_hash');
    return [name, { terminalAuditSha256: audit,
      ...(name === 'confirmation' ? { semanticQualification: cohort.semanticQualification } : {}), ...result }];
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length <= 3, 'usage: node scripts/fusion-fallback-replay.mjs [study.json]');
  const bytes = await readFile(process.argv[2] ?? new URL('../docs/fusion-livecodebench-study.json', import.meta.url));
  console.log(JSON.stringify({ comparison: 'retrospective-fixed-responses',
    inputSha256: createHash('sha256').update(bytes).digest('hex'),
    additionalModelCalls: 0, projectedLatency: null,
    cohorts: replayStudy(JSON.parse(bytes)), qualifiedFusionGain: false }, null, 2));
}
