import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const raw = readFileSync(new URL('../docs/fusion-syntax-repair-study.json', import.meta.url), 'utf8');
const study = JSON.parse(raw);
const calls = new Map(study.calls.map(call => [call.id, call]));
const variants = new Map(study.variants.map(variant => [variant.id, variant]));

test('syntax repair accounting charges shared calls once and retains each policy cost', () => {
  assert.equal(calls.size, study.calls.length);
  assert.equal(calls.size, 4);
  for (const variant of study.variants) {
    assert.equal(new Set(variant.callIds).size, variant.callIds.length);
    assert.equal(variant.costMicros, variant.callIds.reduce((sum, id) => sum + calls.get(id).costMicros, 0));
  }
  const fresh = study.calls.filter(call => call.newInRepairReplay);
  assert.equal(fresh.length, study.newModelCalls);
  assert.equal(study.newModelCalls, 1);
  assert.equal(fresh.reduce((sum, call) => sum + call.costMicros, 0), study.newModelCostMicros);
  assert.equal(study.calls.reduce((sum, call) => sum + call.costMicros, 0), study.uniqueRecordedCallCostMicros);
  assert.equal(study.uniqueRecordedCallCostMicros, 36133);
  assert.equal(study.newModelCostMicros, 2053);
  assert.deepEqual(variants.get('retained-artifact-repair').callIds, ['initial-cheap', 'retained-cheap-repair']);
  assert.equal(calls.get('initial-cheap').publicPassed, false);
  assert.equal(calls.get('initial-cheap').model, calls.get('retained-cheap-repair').model);
});

test('syntax repair keeps the negative comparison and cannot imply a latency or population win', () => {
  const old = variants.get('original-cascade'), control = variants.get('direct-strong');
  const repaired = variants.get('retained-artifact-repair');
  assert.ok(old.costMicros > control.costMicros && old.workflowMs > control.workflowMs);
  assert.ok(repaired.costMicros < control.costMicros);
  assert.equal(repaired.workflowMs, null);
  assert.equal(repaired.timingComparable, false);
  assert.equal(study.repairTimingComparable, false);
  assert.equal(study.previouslyExposed, true);
  for (const field of ['populationQualified', 'productionQualified', 'collaborationGainEstablished']) {
    assert.equal(study[field], false);
  }
  for (const variant of study.variants) {
    assert.equal(variant.publicPassed, true);
    assert.equal(variant.publicTests, study.task.testViews.expectedPublic);
    assert.equal(variant.fullPassed, true);
    assert.equal(variant.fullTests, study.task.testViews.expectedFull);
    assert.equal(variant.fullFailures, 0);
    assert.equal(variant.fullSkipped, 0);
  }
  assert.equal(study.task.testViews.expectedFull,
    study.task.testViews.expectedPublic + study.task.testViews.expectedHidden);
  for (const digest of Object.values(study.provenance)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(raw, /\/Users\/|\/home\/|api[_-]?key|authorization/i);
});
