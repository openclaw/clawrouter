import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fallbackArm, replayCohort, replayStudy } from '../scripts/fusion-fallback-replay.mjs';

const outcome = (passed, publicPassed, costMicros) => ({ passed, publicPassed, costMicros });
const fixtures = () => [
  { id: 'false-accept', outcomes: { weak: outcome(false, true, 10), strong: outcome(true, true, 100),
    fusion: outcome(true, true, 40) } },
  { id: 'truncated', outcomes: { weak: outcome(false, false, 20), strong: outcome(true, true, 200),
    fusion: outcome(false, false, 60) } },
];

test('public fallback keeps hidden failures and charges failed attempts before escalation', () => {
  const result = replayCohort(fixtures());
  assert.deepEqual(result.policies['weak-public-fallback'].rows.map(row => row.selected), ['weak', 'strong']);
  assert.equal(result.policies['weak-public-fallback'].passed, 1);
  assert.equal(result.policies['weak-public-fallback'].costMicros, 230);
  assert.equal(result.policies['weak-public-fallback'].lostStrongSuccesses, 1);
  assert.deepEqual(result.policies['weak-public-fallback'].falseAccepts, ['false-accept']);
  assert.equal(result.policies['fusion-public-fallback'].costMicros, 300);
  assert.equal(result.policies['fusion-public-fallback'].passed, 2);
  assert.equal(result.hiddenLabelDiagnostic.costMicros, 330);
  assert.equal(result.hiddenLabelDiagnostic.deployable, false);
  assert.equal(result.qualifiedFusionGain, false);
});

test('changing hidden truth cannot change public-policy selections or costs', () => {
  const tasks = fixtures(), before = replayCohort(tasks);
  tasks[0].outcomes.weak.passed = true;
  const after = replayCohort(tasks);
  for (const key of Object.keys(before.policies)) {
    assert.deepEqual(after.policies[key].rows.map(({ selected, costMicros }) => ({ selected, costMicros })),
      before.policies[key].rows.map(({ selected, costMicros }) => ({ selected, costMicros })));
  }
  assert.equal(fallbackArm('weak', false), 'strong');
  assert.throws(() => fallbackArm('weak', undefined), /missing_public_verdict/);
});

test('malformed matrices and unsafe cost arithmetic fail closed', () => {
  for (const mutate of [
    tasks => tasks.push(tasks[0]),
    tasks => delete tasks[0].outcomes.strong,
    tasks => delete tasks[0].outcomes.weak.publicPassed,
    tasks => { tasks[0].outcomes.weak.costMicros = -1; },
    tasks => { tasks[0].outcomes.weak.costMicros = 1.5; },
    tasks => { tasks[0].outcomes.fusion.costMicros = 0; },
    tasks => { tasks[1].outcomes.weak.passed = true; },
    tasks => { tasks[0].outcomes.strong.costMicros = Number.MAX_SAFE_INTEGER; },
  ]) {
    const tasks = fixtures(); mutate(tasks);
    assert.throws(() => replayCohort(tasks));
  }
  assert.throws(() => replayCohort([]), /empty_cohort/);
});

test('published cohorts reproduce audited totals without pooling defective fixtures', async () => {
  const study = JSON.parse(await readFile(new URL('../docs/fusion-livecodebench-study.json', import.meta.url)));
  const result = replayStudy(study);
  assert.equal(result.development.policies['weak-public-fallback'].costMicros, 59129);
  assert.equal(result.development.policies['weak-public-fallback'].passed, 12);
  assert.equal(result.inputValidated.policies['weak-public-fallback'].costMicros, 60767);
  assert.equal(result.inputValidated.policies['weak-public-fallback'].passed, 10);
  assert.equal(result.inputValidated.policies['fusion-public-fallback'].costMicros, 138083);
  assert.equal(result.inputValidated.policies['fusion-public-fallback'].passed, 11);
  assert.deepEqual(result.confirmation.semanticQualification, study.confirmation.semanticQualification);
  const bad = structuredClone(study); bad.validatedFollowup.arms.strong.costMicros++;
  assert.throws(() => replayStudy(bad), /summary_mismatch/);
  const overlapping = structuredClone(study); overlapping.validatedFollowup.tasks[0].id = study.tasks[0].id;
  assert.throws(() => replayStudy(overlapping), /overlapping_cohorts/);
});
