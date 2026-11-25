import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { choose, probes, outcome } from './fusion-behavior-majority.local.mjs';

const row = (arm, digit, extra = {}) => ({ arm, public: { valid: true, passed: true },
  trace: { valid: true, passed: true, fingerprints: Array(24).fill(digit.repeat(64)) }, ...extra });

test('majority ignores full labels and fails closed without valid agreement', () => {
  const rows = [row('first', 'a'), row('second', 'b'), row('third', 'b')];
  assert.equal(choose(rows), 'second');
  assert.equal(choose(rows.map(x => ({ ...x, full: { passed: false } }))), 'second');
  assert.equal(choose([row('first', 'a'), row('second', 'b'), row('third', 'c')]), 'medium');
  assert.equal(choose([row('first', 'a'), row('second', 'b'), row('third', 'b', { public: { valid: false, passed: true } })]), 'medium');
});

test('probes are deterministic and satisfy every public domain', () => {
  for (const name of ['minMaxSubarraySum', 'maxScore', 'lenOfVDiagonal', 'maxSubarrays', 'minOperations', 'longestSpecialPath']) {
    const task = { id: name, contract: { name } }, inputs = probes(task);
    assert.deepEqual(inputs, probes(task)); assert.equal(inputs.length, 24);
    for (const args of inputs) {
      if (name === 'minMaxSubarraySum') assert.ok(args[1] >= 1 && args[1] <= args[0].length);
      if (name === 'maxScore') assert.ok(args[0].length >= 2 && args[1] >= 1);
      if (name === 'maxSubarrays') assert.ok(args[1].every(([a, b]) => a >= 1 && b >= 1 && a <= args[0] && b <= args[0] && a !== b));
      if (name === 'minOperations') assert.ok(args[1] >= 2 && args[2] >= 1 && args[1] * args[2] <= args[0].length);
      if (name === 'longestSpecialPath') assert.equal(args[0].length, args[1].length - 1);
      if (name === 'lenOfVDiagonal') assert.ok(args[0].every(line => line.length === args[0][0].length && line.every(v => [0, 1, 2].includes(v))));
    }
  }
  assert.throws(() => probes({ id: 'unknown', contract: { name: 'unknown' } }));
});

test('equal quality from one cheap sample defeats the development gate', () => {
  const rows = Array.from({ length: 6 }, (_, id) => ['first', 'second', 'third', 'medium'].map(arm => ({
    ...row(arm, 'a'), id, passed: true, costMicros: arm === 'medium' ? 100 : 10,
  }))).flat();
  const result = outcome(rows);
  assert.equal(result.arms.majority.costMicros, 180);
  assert.equal(result.qualifiedDevelopmentGain, false);
  assert.throws(() => outcome(rows.slice(1)));
});

test('published observations reproduce the frozen probes, selections and accounting', () => {
  const report = JSON.parse(readFileSync(new URL('../docs/fusion-behavior-majority-study.json', import.meta.url)));
  assert.deepEqual(outcome(report.rows), report.outcome);
  for (const task of report.tasks) {
    assert.deepEqual(probes(task), task.probes);
    assert.equal(choose(['first', 'second', 'third'].map(arm => report.rows.find(row => row.id === task.id && row.arm === arm))), report.selections[task.id]);
  }
  assert.equal(report.rows.reduce((sum, row) => sum + row.costMicros, 0), report.uniqueStudyCostMicros);
  for (const pair of report.posthocPairs) {
    let passed = 0, costMicros = 0;
    for (const task of report.tasks) {
      const candidates = pair.arms.map(arm => report.rows.find(row => row.id === task.id && row.arm === arm));
      const selected = choose([...candidates, { arm: 'unused', public: { valid: false } }]);
      const result = report.rows.find(row => row.id === task.id && row.arm === selected);
      passed += Number(result.passed);
      costMicros += candidates.reduce((sum, row) => sum + row.costMicros, 0) + (selected === 'medium' ? result.costMicros : 0);
    }
    assert.deepEqual({ passed, costMicros }, { passed: pair.passed, costMicros: pair.costMicros });
  }
});
