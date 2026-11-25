import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const raw = readFileSync(new URL('../docs/fusion-cheap-repair-study.json', import.meta.url), 'utf8');
const study = JSON.parse(raw);
const sum = (rows, field) => rows.reduce((n, row) => n + row[field], 0);
test('both audited trials retain every strategy and the qualification shortfall', () => {
  assert.equal(study.qualification.targetMet, false);
  assert.equal(study.qualification.qualified + study.qualification.rejected, study.qualification.candidates);
  assert.equal(study.qualification.qualified, 5);
  for (const s of study.studies) {
    assert.equal(s.audited, true); assert.equal(s.records.length, 15);
    assert.equal(new Set(s.records.map(r => `${r.caseId}/${r.strategy}`)).size, 15);
    for (const key of ['sourceSha', 'protocolSha256', 'resultSha256', 'auditSha256']) assert.match(s[key], key === 'sourceSha' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/);
    for (const strategy of ['strong', 'cascade', 'cheap']) {
      const rows = s.records.filter(r => r.strategy === strategy);
      assert.equal(rows.length, 5); assert.equal(sum(rows, 'passed'), s.summary[strategy].passed);
      assert.equal(sum(rows, 'costMicros'), s.summary[strategy].costMicros);
      assert.ok(Math.abs(sum(rows, 'elapsedMs') - s.summary[strategy].elapsedMs) < 1e-6);
      assert.equal(rows.filter(r => r.admitted).length, 3);
      for (const row of rows) {
        assert.equal(row.passed, row.publicPassed && row.fullValid && row.fullPassed);
        assert.ok(row.callCount >= 1 && row.callCount <= (strategy === 'cascade' && row.admitted ? s.draftAttempts + s.fallbackAttempts : 2));
      }
    }
  }
});
test('the later cost result preserves the earlier loss and does not claim independent collaboration', () => {
  const [before, after] = study.studies;
  assert.equal(before.previouslyExposed, false); assert.equal(after.previouslyExposed, true);
  assert.deepEqual([...new Set(before.records.map(r => r.caseId))].sort(), [...new Set(after.records.map(r => r.caseId))].sort());
  assert.ok(before.summary.costRatio > 1); assert.ok(before.summary.elapsedRatio > 1.2);
  assert.ok(after.summary.costRatio < 0.5); assert.ok(after.summary.elapsedRatio < 1.2);
  assert.equal(after.summary.escalations, 0); assert.equal(after.summary.liveDevelopmentLead, false);
  for (const s of study.studies) {
    assert.equal(s.summary.qualifiedProductionGain, false);
    assert.equal(s.summary.costRatio, s.summary.cascade.costMicros / s.summary.strong.costMicros);
    assert.equal(s.summary.elapsedRatio, s.summary.cascade.elapsedMs / s.summary.strong.elapsedMs);
  }
  assert.equal(sum(study.studies.flatMap(s => s.records), 'costMicros'), 97008);
  assert.ok(study.cumulativeCostMicros < study.budgetMicros);
  assert.ok(!/\/Users\/|\/home\/|sk-[A-Za-z0-9]{12}|@[^\s"/]+\.[a-z]{2}/.test(raw));
});
