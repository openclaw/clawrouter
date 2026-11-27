import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const raw = readFileSync(new URL('../docs/fusion-retained-repair-followup.json', import.meta.url), 'utf8');
const study = JSON.parse(raw);

test('follow-up accounts for failed repairs and the same cached strong controls', () => {
  assert.equal(study.cases.length, 2);
  let newCost = 0, newCalls = 0, withRepair = 0, withoutRepair = 0;
  for (const row of study.cases) {
    const [initial, repair, strong] = row.calls;
    assert.deepEqual(row.calls.map(call => call.id), ['initial-cheap', 'cheap-repair', 'fresh-strong-control']);
    assert.deepEqual(row.calls.map(call => call.publicPassed), [false, false, true]);
    assert.deepEqual(row.calls.map(call => call.newInReplay), [false, true, false]);
    assert.equal(initial.model, repair.model);
    assert.notEqual(repair.model, strong.model);
    assert.equal(row.retainedRepairCostMicros, initial.costMicros + repair.costMicros + strong.costMicros);
    assert.equal(row.skipRepairCostMicros, initial.costMicros + strong.costMicros);
    assert.equal(row.fullPassed, true);
    assert.ok(row.fullTests > 0);
    newCost += repair.costMicros; newCalls++;
    withRepair += row.retainedRepairCostMicros; withoutRepair += row.skipRepairCostMicros;
  }
  assert.equal(newCost, study.newModelCostMicros); assert.equal(newCost, 1226);
  assert.equal(newCalls, study.newModelCalls);
  assert.equal(withRepair - withoutRepair, newCost);
  assert.equal(study.reconstructed.costMicros - study.skipRepairCounterfactual.costMicros, newCost);
  assert.equal(study.reconstructed.costMicros, 60184);
  assert.equal(study.skipRepairCounterfactual.costMicros, 58958);
});

test('cached-control threshold crossing does not establish independent qualification', () => {
  assert.equal(study.original.passed, 29);
  for (const key of ['baseline', 'strong', 'reconstructed', 'skipRepairCounterfactual', 'priorFreshFallbackReplay']) {
    assert.equal(study[key].tasks, 30); assert.equal(study[key].passed, 30);
    assert.equal(study[key].falseAccepts, 0);
  }
  assert.ok(study.reconstructed.costMicros <= study.baseline.costMicros * 0.8);
  assert.ok(study.priorFreshFallbackReplay.costMicros > study.baseline.costMicros * 0.8);
  assert.equal(study.skipRepairCounterfactual.prospective, false);
  assert.equal(study.skipRepairCounterfactual.selectedAfterReplay, true);
  assert.equal(study.previouslyExposed, true);
  for (const key of ['populationQualified', 'productionQualified', 'collaborationGainEstablished',
    'timingComparable', 'expandedSemanticAuditRun']) assert.equal(study[key], false);
  for (const digest of Object.values(study.provenance)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(raw, /\/Users\/|\/home\/|api[_-]?key|authorization/i);
});
