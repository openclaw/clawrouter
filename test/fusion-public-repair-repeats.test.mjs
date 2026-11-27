import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { summarizeRepeatability } from '../scripts/fusion-repeatability-summary.mjs';

const raw = readFileSync(new URL('../docs/fusion-public-repair-repeats.json', import.meta.url), 'utf8');
const study = JSON.parse(raw);

test('repeat report derives its verdict from every paired outcome', () => {
  assert.deepEqual(study.summary, summarizeRepeatability(study.records, study.taskIds));
  assert.equal(study.previouslyExposed, true);
  assert.equal(study.originalPilotIncluded, false);
  assert.equal(study.audited, true);
  assert.equal(study.summary.qualifiedProductionGain, false);
  assert.equal(study.repeats.length, 3);
  assert.equal(new Set(study.repeats.map(row => row.repeat)).size, 3);
  for (const row of study.records) {
    if (row.fullTests === null) {
      assert.equal(row.fullValid, false);
      assert.equal(row.passed, false);
      assert.equal(row.fullSkipped, null);
    } else {
      assert.ok(Number.isSafeInteger(row.fullTests) && row.fullTests >= 0);
      assert.ok(Number.isSafeInteger(row.fullSkipped) && row.fullSkipped >= 0);
      if (row.fullValid) {
        assert.ok(row.fullTests > 0);
        assert.equal(row.fullSkipped, 0);
      }
    }
    assert.ok(Number.isSafeInteger(row.callCount) && row.callCount >= 1 && row.callCount <= 4);
  }
});

test('every repeat has pinned audit evidence and chained accounting', () => {
  assert.match(study.sourceSha, /^[a-f0-9]{40}$/);
  assert.match(study.protocolSha256, /^[a-f0-9]{64}$/);
  let prior = study.priorCostMicros;
  for (const repeat of study.repeats) {
    for (const field of ['protocolSha256', 'resultSha256', 'auditSha256']) {
      assert.match(repeat[field], /^[a-f0-9]{64}$/);
    }
    assert.equal(repeat.priorCostMicros, prior);
    const rows = study.records.filter(row => row.repeat === repeat.repeat);
    assert.equal(rows.length, 18);
    assert.equal(repeat.newCostMicros, rows.reduce((sum, row) => sum + row.costMicros, 0));
    assert.equal(repeat.callCount, rows.reduce((sum, row) => sum + row.callCount, 0));
    assert.equal(repeat.cumulativeCostMicros, prior + repeat.newCostMicros);
    prior = repeat.cumulativeCostMicros;
  }
  assert.equal(study.cumulativeCostMicros, prior);
  assert.equal(study.newCostMicros, prior - study.priorCostMicros);
  assert.equal(study.budgetMicros, 400000000);
  assert.equal(study.remainingMicros, study.budgetMicros - prior);
  assert.ok(study.newCostMicros <= study.maximumReservedMicros);
  assert.ok(study.remainingMicros > 0);
});

test('published repeat evidence excludes private paths and model payloads', () => {
  assert.ok(!/\/Users\/|\/home\/|sk-[A-Za-z0-9]{12}|@[^\s"/]+\.[a-z]{2}/.test(raw));
  assert.ok(!/"(?:artifact|prompt|completion|body)"\s*:/.test(raw));
});
