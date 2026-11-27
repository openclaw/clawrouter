import assert from 'node:assert/strict';
import test from 'node:test';
import { decision, probes, selections, outcome } from './fusion-confirmation-policy.local.mjs';

const row = (arm, digit, extra = {}) => ({ arm, public: { valid: true, passed: true },
  trace: { valid: true, passed: true, fingerprints: Array(24).fill(digit.repeat(64)) }, ...extra });

test('adaptive buys a third only after pair disagreement and ignores hidden grades', () => {
  const rows = [row('first', 'a'), row('second', 'a'), row('third', 'b')];
  assert.deepEqual(decision(rows, 'adaptive'), { arm: 'first', paid: ['first', 'second'] });
  rows[1] = row('second', 'b');
  assert.deepEqual(decision(rows, 'adaptive'), { arm: 'second', paid: ['first', 'second', 'third'] });
  assert.deepEqual(decision(rows.map(r => ({ ...r, full: { passed: false }, passed: false })), 'adaptive'), decision(rows, 'adaptive'));
  assert.equal(decision(rows, 'pair12').arm, 'medium');
  assert.equal(decision(rows, 'pair23').arm, 'second');
  assert.equal(decision(rows, 'pair13').arm, 'medium');
  rows[2].trace.valid = false; assert.equal(decision(rows, 'adaptive').arm, 'medium');
});

test('conditional costs retain every purchased call including rejected drafts', () => {
  const rows = Array.from({ length: 6 }, (_, id) => ['first', 'second', 'third', 'medium'].map(arm => ({
    ...row(arm, arm === 'first' && id === 0 ? 'a' : 'b'), id, passed: arm !== 'first' || id !== 0,
    costMicros: arm === 'medium' ? 100 : 10,
  }))).flat();
  const fixed = selections(rows), r = outcome(rows, fixed);
  assert.equal(r.arms.adaptive.costMicros, 130); assert.equal(r.arms.adaptive.passed, 6);
  assert.equal(r.arms.pair12.costMicros, 220); assert.equal(r.arms.pair13.costMicros, 220);
  assert.equal(r.arms.pair23.costMicros, 120); assert.equal(r.arms.majority.costMicros, 180);
  assert.equal(r.arms['public-cascade'].passed, 5);
  assert.equal(r.qualifiedConfirmationGain.adaptive, false); // Other individual cheap arms already solve all six.
  fixed[0].adaptive.arm = 'first'; assert.throws(() => outcome(rows, fixed));
});

test('all six public-domain probe generators are deterministic and bounded', () => {
  const names = ['countNonDecreasingSubarrays', 'maxDistance', 'assignElements', 'minOperations', 'longestCommonPrefix', 'maxActiveSectionsAfterTrade'];
  for (const name of names) {
    const t = { id: name, contract: { name, arguments: ['unused'] } }, inputs = probes(t);
    assert.deepEqual(inputs, probes(t)); assert.equal(inputs.length, 24);
    for (const a of inputs) {
      if (name === 'countNonDecreasingSubarrays') assert.ok(a[0].length >= 1 && a[0].every(x => x >= 1) && a[1] >= 1);
      if (name === 'maxDistance') assert.ok(/^[NSEW]+$/.test(a[0]) && a[1] >= 0 && a[1] <= a[0].length);
      if (name === 'assignElements') assert.ok(a.every(xs => xs.length >= 1 && xs.every(x => x >= 1 && x <= 100000)));
      if (name === 'minOperations') assert.ok(a.length === 1 && a[0].every(([l, r]) => l >= 1 && l < r && r <= 1000000000));
      if (name === 'longestCommonPrefix') assert.ok(a[0].every(x => /^[a-z]+$/.test(x)) && a[1] >= 1 && a[1] <= a[0].length);
      if (name === 'maxActiveSectionsAfterTrade') assert.ok(/^[01]+$/.test(a[0]));
    }
  }
  assert.throws(() => probes({ id: 'bad', contract: { name: 'minOperations', arguments: [1, 2, 3] } }));
});

test('confirmation requires better quality than every cheap sample and public fallback', () => {
  const names = ['first', 'second', 'third', 'medium'];
  const rows = Array.from({ length: 6 }, (_, id) => names.map((arm, i) => ({
    ...row(arm, id < 3 && i === id ? 'b' : 'a'), id, passed: !(id < 3 && i === id),
    costMicros: arm === 'medium' ? 100 : 10,
  }))).flat();
  const r = outcome(rows, selections(rows));
  assert.equal(r.qualifiedConfirmationGain.adaptive, true);
  assert.equal(r.qualifiedProductionGain, false);
  rows.find(r => r.id === 3 && r.arm === 'first').costMicros = 1000;
  assert.equal(outcome(rows, selections(rows)).qualifiedConfirmationGain.adaptive, false);
});


test('published confirmation replays probes, frozen choices, costs and failed gates', async () => {
  const { readFile } = await import('node:fs/promises');
  const report = JSON.parse(await readFile(new URL('../docs/fusion-fresh-confirmation-study.json', import.meta.url), 'utf8'));
  assert.equal(report.rows.length, report.newCalls);
  assert.equal(report.rows.reduce((sum, row) => sum + row.costMicros, 0), report.newCostMicros);
  for (const task of report.tasks) assert.deepEqual(probes(task), report.probes[task.id]);
  assert.deepEqual(selections(report.rows), report.selections);
  const replay = outcome(report.rows, report.selections);
  for (const key of ['arms', 'accepted', 'qualifiedConfirmationGain', 'qualifiedProductionGain']) assert.deepEqual(replay[key], report[key]);
  assert.equal(report.qualifiedConfirmationGain[report.primaryPolicy], false);
  const replayRows = structuredClone(report.rows);
  for (const diff of report.auditReplay.differences) {
    const row = replayRows.find(row => row.id === diff.id && row.arm === diff.arm);
    row.full = diff.replayedFull;
    row.passed = row.public.passed === true && row.full.passed === true;
  }
  const repeated = outcome(replayRows, selections(replayRows));
  for (const key of ['arms', 'accepted', 'qualifiedConfirmationGain', 'qualifiedProductionGain']) assert.deepEqual(repeated[key], report.auditReplay[key]);
});
