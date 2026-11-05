import assert from 'node:assert/strict';
import test from 'node:test';
import { runCandidateEnsemble } from '../scripts/fusion-candidate-ensemble.mjs';
import { defaultExperiment, validateExperiment } from '../scripts/fusion-agent-benchmark.mjs';

test('independent candidates and synthesis share the trial budget and total turn cap', async () => {
  const calls = [], config = { ...defaultExperiment, maxTurns: 12 };
  const invoke = () => {};
  const result = await runCandidateEnsemble({}, 'image', 'same-trial', config, invoke, {},
    async (task, image, strategy, trialId, phaseConfig, call, engine, options) => {
      calls.push({ strategy, trialId, phaseConfig, call, options });
      const index = calls.length;
      return { files: [{ path: 'source', content: String(index) }], actions: [{ action: 'finish' }],
        turns: index === 1 ? 2 : phaseConfig.maxTurns, invalidActions: 1, adviserFailures: 0,
        toolMs: 1, outcome: 'submitted', patchDigest: String(index), publicPassed: true };
    });
  assert.deepEqual(calls.map(call => call.strategy), ['strong', 'claude', 'claude']);
  assert.deepEqual(calls.map(call => call.phaseConfig.maxTurns), [4, 4, 6]);
  assert.ok(calls.every(call => call.trialId === 'same-trial' && call.call === invoke));
  assert.ok(calls.every(call => call.phaseConfig.trialBudgetMicros === config.trialBudgetMicros));
  assert.ok(calls.every(call => call.options.signal === calls[0].options.signal));
  assert.equal(calls[0].options.candidates, undefined);
  assert.equal(calls[1].options.candidates, undefined);
  assert.deepEqual(calls[2].options.candidates.map(files => files[0].content), ['1', '2']);
  assert.equal(result.turns, 12);
  assert.equal(result.invalidActions, 3);
  assert.equal(result.toolMs, 3);
  assert.equal(JSON.stringify(result.candidates).includes('content'), false);
});

test('a failed candidate stops synthesis and propagates unknown charges', async () => {
  let calls = 0;
  await assert.rejects(runCandidateEnsemble({}, 'image', 'trial', defaultExperiment, () => {}, {}, async () => {
    calls++; throw new Error('unknown_cost');
  }), /unknown_cost/);
  assert.equal(calls, 1);
  assert.throws(() => validateExperiment({ ...defaultExperiment, strategies: ['candidate-ensemble'], maxTurns: 2 }, 1), /three_turns/);
});

test('isolated ensemble installs the second candidate and passes the fresh verifier', {
  skip: !process.env.FUSION_DOCKER_QUALIFICATION,
}, async () => {
  const { readFile } = await import('node:fs/promises');
  const { runAgent } = await import('../scripts/fusion-agent-benchmark.mjs');
  const { loadTasks, command, verify } = await import('../scripts/fusion-workloads.mjs');
  const task = (await loadTasks()).find(task => task.id === 'music-response-lifetime');
  const receipt = JSON.parse(await readFile(process.env.FUSION_DOCKER_QUALIFICATION)).receipts.find(receipt => receipt.taskId === task.id);
  assert.equal(receipt.qualified, true);
  const source = async revision => (await command('git', ['show', `${revision}:${task.editPaths[0]}`])).stdout.toString();
  const action = (name, values = {}) => ({ action: name, paths: [], edits: [], query: '', memory: '', ...values });
  const queue = [action('finish'), action('edit', { edits: [{ path: task.editPaths[0],
    search: await source(task.base), replace: await source(task.oracle) }] }), action('finish'),
  action('finish'), action('compare', { query: `import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; import assert from 'node:assert/strict'; assert.equal(createHash('sha256').update(readFileSync(${JSON.stringify(task.editPaths[0])})).digest('hex'), ${JSON.stringify((await import('../scripts/fusion-workloads.mjs')).hash(await source(task.oracle)))});` }),
  action('candidate', { query: '2' }), action('finish')];
  const trialIds = [];
  const result = await runCandidateEnsemble(task, receipt.image, 'fixture', {
    ...defaultExperiment, maxTurns: 9, deadlineMs: 120000,
  }, async trialId => {
    trialIds.push(trialId);
    return { choices: [{ message: { content: JSON.stringify(queue.shift()) }, finish_reason: 'stop' }] };
  }, {}, runAgent);
  const grade = await verify(task, receipt.image, result.files, process.cwd());
  assert.equal(grade.passed, true);
  assert.equal(grade.tests, receipt.oracle.tests);
  assert.equal(result.selectedCandidate, 2);
  assert.equal(result.turns, 7);
  assert.equal(result.candidatesCompared, true);
  assert.deepEqual(result.actions.find(action => action.action === 'compare').passed, [false, true]);
  assert.equal(queue.length, 0);
  assert.equal(new Set(trialIds).size, 1);
});
