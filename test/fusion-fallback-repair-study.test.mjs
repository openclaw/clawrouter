import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = name => readFileSync(new URL('../docs/' + name, import.meta.url));
const bytes = read('fusion-fallback-repair-study.json');
const study = JSON.parse(bytes);
const originalBytes = read(study.originalStudy.file), original = JSON.parse(originalBytes);
const key = row => JSON.stringify([row.caseId, row.trial, row.strategy]);
const admitted = new Set(original.partition.assignments.filter(row => row.stratum === 'admitted').map(row => row.caseId));
const originalRows = new Map(original.evaluation.records.map(row => [key(row), row]));
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);

test('extra repairs cover all and only admitted public failures, retaining every original row', () => {
  assert.equal(createHash('sha256').update(originalBytes).digest('hex'), study.originalStudy.sha256);
  const selected = original.workflowOutcomes.filter(row => row.strategy === 'cascade' && admitted.has(row.caseId) && !row.publicPassed);
  const repairs = study.fallbackRepair.rows;
  const identity = row => JSON.stringify([row.caseId, row.trial]);
  assert.deepEqual(repairs.map(identity).sort(), selected.map(identity).sort());
  assert.equal(new Set(repairs.map(identity)).size, 3);
  const updated = original.evaluation.records.map(row => {
    const repair = row.strategy === 'cascade' && repairs.find(r => identity(r) === identity(row));
    if (!repair) return row;
    assert.equal(row.callCount, 2);
    assert.equal(repair.passed, repair.publicPassed && repair.fullValid && repair.fullPassed);
    return { ...row, score: Number(repair.passed), costMicros: row.costMicros + repair.newCostMicros, callCount: 3 };
  });
  assert.equal(updated.length, 270);
  const cascade = updated.filter(row => row.strategy === 'cascade');
  assert.equal(sum(cascade, 'score'), 83);
  assert.equal(sum(cascade.filter(row => admitted.has(row.caseId)), 'score'), 59);
  assert.equal(sum(cascade.filter(row => admitted.has(row.caseId)), 'costMicros'), 329459);
  assert.equal(sum(updated.filter(row => row.strategy === 'strong'), 'score'), 85);
  assert.equal(sum(repairs, 'newCostMicros'), study.fallbackRepair.newCostMicros);
});

test('the feedback comparison retains opposite task effects and every failed call', () => {
  const rows = study.feedbackSmoke.rows;
  assert.equal(rows.length, 12);
  assert.equal(new Set(rows.map(row => JSON.stringify([row.caseId, row.repeat, row.arm]))).size, 12);
  const effects = [];
  for (const id of new Set(rows.map(row => row.caseId))) {
    const task = rows.filter(row => row.caseId === id);
    assert.equal(new Set(task.map(row => row.model)).size, 1);
    const successes = {};
    for (const arm of ['generic', 'diagnostic']) {
      const paired = task.filter(row => row.arm === arm);
      assert.deepEqual(paired.map(row => row.repeat).sort(), [1, 2, 3]);
      successes[arm] = paired.filter(row => row.passed).length;
    }
    effects.push(successes.diagnostic - successes.generic);
  }
  assert.deepEqual(effects.sort((a, b) => a - b), [-2, 3]);
  for (const row of rows) assert.equal(row.passed, row.publicPassed && row.fullValid && row.fullPassed);
  assert.equal(sum(rows, 'costMicros'), 33083);
  assert.equal(sum(rows, 'costMicros'), study.feedbackSmoke.newCostMicros);
});

test('fresh workflow replay covers all sixty admitted trials and charges reused traces once', () => {
  const replay = study.freshStrongWorkflowReplay;
  assert.equal(replay.kind, 'offline-shared-trace-replay');
  assert.equal(replay.newCalls, 0); assert.equal(replay.newCostMicros, 0);
  assert.equal(replay.rows.length, 60);
  const identities = new Set(); let score = 0, cost = 0, normalized = 0, calls = 0, escalations = 0;
  for (const row of replay.rows) {
    assert.ok(admitted.has(row.caseId));
    assert.ok(!identities.has(JSON.stringify([row.caseId, row.trial])));
    identities.add(JSON.stringify([row.caseId, row.trial]));
    assert.equal(row.equalInitialRequest, true);
    assert.match(row.initialRequestSha256, /^[a-f0-9]{64}$/);
    const lookup = strategy => originalRows.get(key({ ...row, strategy }));
    const cascade = lookup('cascade'), strong = lookup('strong'); assert.ok(cascade && strong);
    const outcome = original.workflowOutcomes.find(r => key(r) === key(cascade));
    assert.equal(row.useStrongControl, outcome.escalated);
    assert.ok(Number.isSafeInteger(row.draftCostMicros) && row.draftCostMicros >= 0 && row.draftCostMicros <= cascade.costMicros);
    if (!row.useStrongControl) assert.equal(row.draftCostMicros, cascade.costMicros);
    cost += row.draftCostMicros + (row.useStrongControl ? strong.costMicros : 0);
    const strongOutcome = original.workflowOutcomes.find(r => key(r) === key(strong));
    normalized += row.draftNormalizedMicros + (row.useStrongControl ? strongOutcome.normalizedCostMicros : 0);
    score += row.useStrongControl ? strong.score : cascade.score;
    calls += 1 + (row.useStrongControl ? strong.callCount : 0);
    escalations += Number(row.useStrongControl);
  }
  assert.equal(score, 60); assert.equal(cost, 263387); assert.equal(normalized, 263392);
  assert.equal(calls, 84); assert.equal(escalations, 22);
});

test('campaign costs retain both experiments and evidence contains no private payloads', () => {
  assert.equal(study.campaign.newCostMicros, study.feedbackSmoke.newCostMicros + study.fallbackRepair.newCostMicros);
  assert.equal(study.campaign.newCostMicros, 73743);
  assert.equal(study.campaign.priorSpentOrReservedMicros + study.campaign.newCostMicros, study.campaign.spentOrReservedMicros);
  assert.ok(study.campaign.spentOrReservedMicros <= study.campaign.limitMicros);
  assert.equal(study.qualifiedProductionGain, false);
  for (const experiment of [study.feedbackSmoke, study.fallbackRepair]) {
    for (const field of ['protocolSha256', 'resultSha256', 'auditSha256']) assert.match(experiment[field], /^[a-f0-9]{64}$/);
  }
  assert.doesNotMatch(bytes.toString(), /\/Users\/|op:\/\/|\bsk-[A-Za-z0-9_-]{10,}\b/);
});
