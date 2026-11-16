import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trainVotePolicy } from '../scripts/train-fusion-vote-policy.mjs';

test('replay CLI evaluates a trained policy against separate traces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-vote-replay-'));
  try {
    const panel = { version: 1, choices: ['A', 'B'], workers:
      ['expensive', 'cheap-a', 'cheap-b'].map((id, priority) => ({ id, weight: 1, priority, model: id })) };
    const policy = await trainVotePolicy({ ...panel, cases: [
      { answers: ['A', 'A', 'A'], costs: [10, 1, 1] },
      { answers: ['B', 'B', 'B'], costs: [10, 1, 1] },
    ] });
    const evaluation = { ...panel, cases: [{ answers: ['B', 'B', 'B'], costs: [10, 1, 1] }] };
    const inputPath = join(directory, 'evaluation.json'), policyPath = join(directory, 'policy.json');
    await writeFile(inputPath, JSON.stringify(evaluation));
    await writeFile(policyPath, JSON.stringify(policy));
    const childEnv = { ...process.env }; delete childEnv.FORCE_COLOR;
    const run = args => spawnSync(process.execPath, ['scripts/replay-fusion-vote.mjs', inputPath, ...args],
      { encoding: 'utf8', timeout: 10000, env: childEnv });
    const fixed = run([]), adaptive = run([policyPath]);
    assert.equal(fixed.status, 0, fixed.stderr); assert.equal(adaptive.status, 0, adaptive.stderr);
    assert.equal(JSON.parse(fixed.stdout).meanCost, 11);
    const result = JSON.parse(adaptive.stdout);
    assert.equal(result.meanCost, 2); assert.equal(result.answerMismatches, 0);
    policy.panel.workers[0].model = 'changed-model';
    await writeFile(policyPath, JSON.stringify(policy));
    const mismatch = run([policyPath]);
    assert.equal(mismatch.status, 1); assert.equal(mismatch.stdout, '');
    assert.equal(mismatch.stderr.trim(), 'fusion_vote_replay_failed');
    await writeFile(policyPath, ' '.repeat(4 * 1024 * 1024 + 1));
    const oversized = run([policyPath]);
    assert.equal(oversized.status, 1); assert.equal(oversized.stdout, '');
    assert.equal(oversized.stderr.trim(), 'fusion_vote_replay_failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
