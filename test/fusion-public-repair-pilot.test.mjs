import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const raw = readFileSync(new URL('../docs/fusion-public-repair-pilot.json', import.meta.url), 'utf8');
const study = JSON.parse(raw);
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);

test('fresh pilot retains all cases, exclusions, strategies and bounded attempts', () => {
  assert.equal(study.previouslyExposed, false);
  assert.equal(study.audited, true);
  assert.equal(study.qualification.targetMet, true);
  assert.equal(study.qualification.attempted + study.qualification.unattempted, 12);
  assert.equal(study.qualification.eligibleIds.length, 6);
  assert.equal(study.qualification.exclusions.length, 2);
  assert.equal(study.records.length, 18);
  assert.equal(new Set(study.records.map(row => `${row.caseId}/${row.strategy}`)).size, 18);
  for (const id of study.qualification.eligibleIds) {
    const rows = study.records.filter(row => row.caseId === id);
    assert.deepEqual(rows.map(row => row.strategy).sort(), ['cascade', 'cheap', 'strong']);
    for (const row of rows) {
      assert.equal(row.passed, row.publicPassed && row.fullValid && row.fullPassed);
      assert.ok(row.callCount >= 1 && row.callCount <= (row.strategy === 'cascade' && row.admitted ? 4 : 2));
      assert.equal(row.fullSkipped, 0);
    }
  }
  for (const key of ['protocolSha256', 'resultSha256', 'auditSha256', 'screenProtocolSha256', 'screenQualificationSha256']) {
    assert.match(study[key], /^[a-f0-9]{64}$/);
  }
  assert.match(study.sourceSha, /^[a-f0-9]{40}$/);
});

test('published totals and routing gate derive from the complete paired rows', () => {
  for (const strategy of ['strong', 'cascade', 'cheap']) {
    const rows = study.records.filter(row => row.strategy === strategy);
    assert.equal(sum(rows, 'passed'), study.summary[strategy].passed);
    assert.equal(sum(rows, 'costMicros'), study.summary[strategy].costMicros);
    assert.ok(Math.abs(sum(rows, 'elapsedMs') - study.summary[strategy].elapsedMs) < 1e-6);
    assert.equal(sum(rows, 'callCount'), study.callCounts[strategy]);
    assert.equal(rows.filter(row => row.admitted).length, 3);
  }
  const byId = new Map(study.qualification.eligibleIds.map(id => [id,
    Object.fromEntries(study.records.filter(row => row.caseId === id).map(row => [row.strategy, row]))]));
  assert.equal(study.summary.strongLosses,
    [...byId.values()].filter(row => row.strong.passed && !row.cascade.passed).length);
  assert.equal(study.summary.falseAccepts,
    study.records.filter(row => row.strategy === 'cascade' && row.publicPassed && !row.passed).length);
  assert.equal(study.summary.costRatio, study.summary.cascade.costMicros / study.summary.strong.costMicros);
  assert.equal(study.summary.elapsedRatio, study.summary.cascade.elapsedMs / study.summary.strong.elapsedMs);
  const qualified = study.summary.cascade.passed >= study.summary.strong.passed
    && study.summary.cascade.passed > study.summary.cheap.passed
    && study.summary.strongLosses === 0 && study.summary.falseAccepts === 0
    && study.summary.costRatio <= 0.8 && study.summary.elapsedRatio <= 1.2;
  assert.equal(study.routingPilotLead, qualified);
  assert.equal(study.summary.qualifiedProductionGain, false);
});

test('cost accounting and disclosure preserve the small pilot limits', () => {
  assert.equal(sum(study.records, 'costMicros'), study.newCostMicros);
  assert.equal(study.priorCostMicros + study.newCostMicros, study.cumulativeCostMicros);
  assert.equal(study.budgetMicros - study.cumulativeCostMicros, study.remainingMicros);
  assert.equal(study.budgetMicros, 400000000);
  assert.ok(study.remainingMicros > 0);
  assert.equal(study.summary.escalations, 0);
  assert.equal(study.summary.rescues, 0);
  assert.equal(study.summary.liveDevelopmentLead, false);
  assert.ok(!/\/Users\/|\/home\/|sk-[A-Za-z0-9]{12}|@[^\s"/]+\.[a-z]{2}/.test(raw));
  assert.ok(!/"(?:artifact|prompt|completion|body)"\s*:/.test(raw));
});
