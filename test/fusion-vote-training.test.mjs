import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trainVotePolicy } from '../scripts/train-fusion-vote-policy.mjs';
import { createVotePolicy } from '../scripts/fusion-vote-policy.mjs';
import { replayFusionVote } from '../scripts/replay-fusion-vote.mjs';

const training = () => ({ version: 1, choices: ['A', 'B'], workers:
  ['expensive', 'cheap-a', 'cheap-b'].map((id, priority) => ({ id, weight: 1, priority })),
  cases: ['A', 'B'].map(answer => ({ answers: [answer, answer, answer], costs: [10, 1, 1] })) });

test('training finds cheaper exact-vote order and emits a loadable policy', async () => {
  const input = training(), policy = await trainVotePolicy(input);
  const selectNext = await createVotePolicy(input, policy);
  assert.equal(selectNext({ observed: [], remaining: input.workers.map(w => w.id) }), 'cheap-a');
  assert.equal(policy.training.fixedMeanCost, 11); assert.equal(policy.training.adaptiveMeanCost, 2);
  assert.equal((await replayFusionVote(input, { selectNext })).answerMismatches, 0);
  const unseen = { ...input, cases: [{ answers: ['A', null, 'B'], costs: [10, 1, 1] }] };
  assert.equal((await replayFusionVote(unseen, { selectNext })).answerMismatches, 0);
});

test('training snapshots inputs and ignores correctness labels', async () => {
  const input = training(), expected = await trainVotePolicy(training());
  input.cases.forEach(row => { row.correctAnswer = 'B'; });
  const pending = trainVotePolicy(input);
  input.workers[0].weight = 100; input.choices.reverse(); input.cases[0].answers.fill(null); input.cases[1].costs.fill(0);
  assert.deepEqual(await pending, expected);
});

test('abstentions and zero-cost traces remain valid', async () => {
  const input = training(); input.cases = [{ answers: [null, null, null], costs: [0, 0, 0] }];
  const policy = await trainVotePolicy(input);
  assert.equal(policy.training.adaptiveMeanCost, 0);
  assert.equal((await replayFusionVote(input, { selectNext: await createVotePolicy(input, policy) })).meanCalls, 3);
});

test('invalid traces and exhausted work limits fail without a partial policy', async () => {
  for (const change of [x => { x.cases[0].answers[0] = 'outside'; }, x => { x.cases[0].costs[0] = -1; },
    x => { x.cases[0].costs.pop(); }, x => { x.workers = Array(9).fill(x.workers[0]); }]) {
    const input = training(); change(input); await assert.rejects(trainVotePolicy(input));
  }
  await assert.rejects(trainVotePolicy(training(), { maxStates: 1 }), /vote_training_limit/);
  await assert.rejects(trainVotePolicy(training(), { maxRowVisits: 1 }), /vote_training_limit/);
  await assert.rejects(trainVotePolicy(training(), { maxStates: 50001 }), /invalid_vote_training/);
});

test('CLI writes a private policy once and refuses to overwrite it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-vote-training-'));
  try {
    const inputPath = join(directory, 'training.json'), outputPath = join(directory, 'policy.json');
    await writeFile(inputPath, JSON.stringify(training()));
    const run = () => spawnSync(process.execPath, ['scripts/train-fusion-vote-policy.mjs', inputPath, outputPath], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    const saved = await readFile(outputPath, 'utf8'); assert.equal(JSON.parse(saved).training.adaptiveMeanCost, 2);
    const rejected = run(); assert.equal(rejected.status, 1); assert.equal(rejected.stdout, '');
    assert.match(rejected.stderr, /fusion_vote_training_failed/); assert.equal(await readFile(outputPath, 'utf8'), saved);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
