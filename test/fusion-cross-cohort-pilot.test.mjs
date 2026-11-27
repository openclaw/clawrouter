import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const data = JSON.parse(await readFile(new URL('../docs/fusion-cross-cohort-pilot.json', import.meta.url), 'utf8'));
test('published pilot preserves every case and reconciles three complete arms', () => {
  assert.equal(data.status, 'audited');
  assert.match(data.terminalAuditSha256, /^[a-f0-9]{64}$/);
  assert.equal(data.cases.length, 12); assert.equal(new Set(data.cases.map(c => c.id)).size, 12);
  assert.equal(new Set(data.cases.map(c => c.source)).size, 10); assert.equal(data.records.length, 36);
  for (const c of data.cases) assert.deepEqual(data.records.filter(r => r.id === c.id).map(r => r.strategy).sort(), ['cascade', 'cheap', 'strong']);
  for (const strategy of ['strong', 'cascade', 'cheap']) {
    const rows = data.records.filter(r => r.strategy === strategy), expected = data.summary[strategy];
    assert.equal(rows.filter(r => r.passed).length, expected.passed);
    assert.equal(rows.reduce((n, r) => n + r.costMicros, 0), expected.costMicros);
    assert.equal(rows.reduce((n, r) => n + r.elapsedMs, 0), expected.elapsedMs);
  }
  for (const row of data.records) assert.equal(row.passed, row.publicPassed && row.fullValid && row.fullPassed);
  assert.equal(data.records.reduce((n, r) => n + r.attempts, 0), data.actualCalls);
  assert.equal(data.records.reduce((n, r) => n + r.costMicros, 0), data.newCostMicros);
  assert.equal(data.priorCostMicros + data.newCostMicros, data.cumulativeCostMicros);
  assert.ok(data.cumulativeCostMicros <= data.campaignBudgetMicros);
});
test('the near miss remains a failed cost gate with explicit quality and time results', () => {
  const s = data.summary;
  assert.equal(s.strong.passed, 12); assert.equal(s.cascade.passed, 12); assert.equal(s.cheap.passed, 6);
  assert.equal(s.falseAccepts, 0); assert.equal(s.strongLosses, 0);
  assert.ok(s.costRatio > 0.8 && s.costComparison.normalizedCostRatio > 0.8);
  assert.ok(s.elapsedRatio <= 1.2); assert.equal(s.costComparison.costScreen, false);
  assert.equal(s.routingLead, false); assert.equal(s.qualifiedProductionGain, false);
});
