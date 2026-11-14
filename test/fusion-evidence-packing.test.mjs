import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packEvidence } from '../scripts/fusion-evidence-packing.mjs';

function input(count = 5, probabilities = new Map()) {
  const pairs = [];
  for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) {
    pairs.push({ indices: [a, b], features: [Math.log(probabilities.get(`${a},${b}`) ?? 1)] });
  }
  return { version: 1, documentCount: count, head: { weights: [1], mean: [0], scale: [1] }, pairs };
}

test('packing maximizes retained pair mass rather than selecting the highest marginal documents', () => {
  // 0 is individually strongest, but its edges are spread across five partners.
  // The dense 1..4 set retains 60; any set containing 0 retains at most 54.
  const weights = new Map();
  for (let i = 1; i < 6; i++) weights.set(`0,${i}`, 8);
  for (let a = 1; a < 5; a++) for (let b = a + 1; b < 5; b++) weights.set(`${a},${b}`, 10);
  const request = input(6, weights);
  assert.deepEqual(packEvidence(request).selectedIndices, [1, 2, 3, 4]);
  assert.ok(Math.abs(packEvidence(request).retainedPairMass - 60 / 104) < 1e-12);
});

test('standardization is applied before weighting, with stable input-order independent ties', () => {
  const request = input();
  request.head = { weights: [2], mean: [100], scale: [2] };
  for (const pair of request.pairs) pair.features = [100];
  const original = structuredClone(request);
  assert.deepEqual(packEvidence(request), { selectedIndices: [0, 1, 2, 3], retainedPairMass: 0.6 });
  assert.deepEqual(request, original);
  request.pairs.reverse();
  assert.deepEqual(packEvidence(request), { selectedIndices: [0, 1, 2, 3], retainedPairMass: 0.6 });
  request.limit = 5;
  assert.deepEqual(packEvidence(request), { selectedIndices: [0, 1, 2, 3, 4], retainedPairMass: 1 });
});

test('softmax remains finite for extreme logits and default sets retain all small inputs', () => {
  const request = input(3);
  request.pairs[0].features = [10_000];
  request.pairs[1].features = [-10_000];
  assert.deepEqual(packEvidence(request), { selectedIndices: [0, 1, 2], retainedPairMass: 1 });
  request.limit = 2;
  assert.deepEqual(packEvidence(request), { selectedIndices: [0, 1], retainedPairMass: 1 });
});

test('feature scales affect the selected pair', () => {
  const request = input(3);
  request.limit = 2;
  request.head = { weights: [1, 1], mean: [0, 0], scale: [10, 1] };
  request.pairs.forEach((pair, index) => { pair.features = [[10, 0], [0, 3], [0, 0]][index]; });
  assert.deepEqual(packEvidence(request).selectedIndices, [0, 2]);
});

test('incomplete, duplicate, malformed and nonfinite caller data fail closed', () => {
  const mutations = [
    value => { value.documentCount = 11; },
    value => { value.limit = 1; },
    value => { value.limit = null; },
    value => { value.limit = 6; },
    value => { value.pairs.pop(); },
    value => { value.pairs[1] = value.pairs[0]; },
    value => { value.pairs[0].indices = [1, 0]; },
    value => { value.pairs[0].indices = [0, 5]; },
    value => { value.pairs[0].features = [Infinity]; },
    value => { value.pairs[0].features = new Array(1); },
    value => { value.head.weights = [NaN]; },
    value => { value.head.scale = [0]; },
    value => { value.head.scale = [-1]; },
    value => { value.head.mean = []; },
    value => { value.pairs[0].features = [1e308]; value.head.weights = [1e308]; },
    value => { value.prompt = 'unrecognized'; },
    value => { value.head.note = 'unrecognized'; },
  ];
  for (const mutate of mutations) {
    const request = input(); mutate(request);
    assert.throws(() => packEvidence(request), /evidence/);
  }
});

test('CLI reads a bounded numeric-only contract and reports malformed input without echoing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-packing-test-'));
  const script = fileURLToPath(new URL('../scripts/fusion-evidence-packing.mjs', import.meta.url));
  const run = path => spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 5000 });
  try {
    const file = join(root, 'input.json');
    await writeFile(file, JSON.stringify(input(2)));
    const success = run(file);
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(JSON.parse(success.stdout), { selectedIndices: [0, 1], retainedPairMass: 1 });
    await writeFile(file, '{private malformed data');
    const invalid = run(file);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.equal(invalid.stderr, 'invalid_evidence_json\n');
    await writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1));
    assert.equal(run(file).stderr, 'evidence_input_too_large\n');
    if (process.platform !== 'win32') {
      const fifo = join(root, 'input.fifo');
      assert.equal(spawnSync('mkfifo', [fifo], { encoding: 'utf8' }).status, 0);
      const special = run(fifo);
      assert.equal(special.status, 1);
      assert.equal(special.stderr, 'evidence_input_not_file\n');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
