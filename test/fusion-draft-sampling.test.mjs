import test from 'node:test';
import assert from 'node:assert/strict';
import { runDraftSampling } from '../scripts/fusion-draft-sampling.mjs';
import { models } from '../scripts/fusion-benchmark-accounting.mjs';

const task = { editPaths: ['worker/example.ts'] };
const config = { maxTurns: 4, deadlineMs: 10000, outputTokens: 4096 };
const candidate = index => ({ files: [{ path: task.editPaths[0], content: `private candidate ${index}` }],
  outcome: 'draft_submitted', publicPassed: true, toolMs: 2, invalidActions: index, actions: [{ action: 'draft', status: 'ok' }] });

function fixture(outcomes = [true, true]) {
  const calls = [], phases = [];
  let index = 0;
  const deps = {
    draft: async (input, _image, _strategy, id, settings, invoke, _unused, opts) => {
      const number = index++;
      phases.push({ input, settings, opts });
      await invoke(id, models.strong, {}, opts.signal);
      return { ...candidate(number + 1), publicPassed: outcomes[number] };
    },
    agent: async (input, _image, _strategy, id, settings, invoke, _unused, opts) => {
      phases.push({ input, settings, opts });
      for (let i = 0; i < settings.maxTurns; i++) await invoke(id, models.strong, {}, opts.signal);
      return { ...candidate(3), outcome: 'submitted' };
    },
  };
  const invoke = async (id, role) => { calls.push({ id, role }); return {}; };
  return { deps, calls, phases, invoke };
}

test('sampling takes the first visible-pass draft and never consults acceptance or a judge', async () => {
  for (const outcomes of [[true, true], [false, true], [true, false]]) {
    const f = fixture(outcomes);
    const result = await runDraftSampling(task, 'image', 'one-ledger', config, f.invoke, f.deps);
    const selected = outcomes.indexOf(true) + 1;
    assert.equal(result.draftSampling.selectedCandidate, selected);
    assert.deepEqual(result.files, candidate(selected).files);
    assert.equal(result.turns, 2);
    assert.equal(result.escalated, false);
    assert.ok(f.phases.every(phase => phase.input === task && phase.settings.maxTurns === 1));
    assert.ok(f.calls.every(call => call.id === 'one-ledger' && call.role === models.cheap));
    assert.deepEqual(result.actions.map(action => action.phase), ['candidate-1', 'candidate-2']);
    const { files, ...trace } = result;
    assert.ok(!JSON.stringify(trace).includes('private candidate'));
  }
});

test('visible failures and unsubmitted drafts use only the remaining cheap allowance', async () => {
  for (const incomplete of [false, true]) {
    const f = fixture(incomplete ? [true, true] : [false, false]);
    if (incomplete) {
      const draft = f.deps.draft;
      f.deps.draft = async (...args) => ({ ...await draft(...args), outcome: 'turn_limit' });
    }
    const result = await runDraftSampling(task, 'image', 'one-ledger', config, f.invoke, f.deps);
    assert.equal(result.escalated, true);
    assert.equal(result.draftSampling.selectedCandidate, null);
    assert.equal(result.turns, 4);
    assert.equal(result.invalidActions, 6);
    assert.equal(result.toolMs, 6);
    assert.equal(f.phases.at(-1).settings.maxTurns, 2);
    assert.equal(f.phases.at(-1).input, task);
    assert.ok(f.calls.every(call => call.role === models.cheap));
  }
});

test('sampling cannot evade per-phase calls or the shared deadline', async () => {
  await assert.rejects(runDraftSampling(task, 'image', 'trial', { ...config, maxTurns: 2 }, async () => {}), /three_calls/);
  const f = fixture(), draft = f.deps.draft;
  f.deps.draft = async (...args) => { await draft(...args); return draft(...args); };
  await assert.rejects(runDraftSampling(task, 'image', 'trial', config, f.invoke, f.deps), /trial_budget/);
  assert.equal(f.calls.length, 1);
  const slow = fixture();
  slow.deps.draft = async () => {
    await new Promise(resolve => setTimeout(resolve, 15));
    return candidate(1);
  };
  await assert.rejects(runDraftSampling(task, 'image', 'trial', { ...config, deadlineMs: 1 }, slow.invoke, slow.deps), /command_timeout/);
});

test('uncertain cost or refusal stops sampling without replacement', async () => {
  for (const reason of ['unknown_cost', 'provider_refused']) {
    const f = fixture();
    await assert.rejects(runDraftSampling(task, 'image', 'trial', config, async (...args) => {
      await f.invoke(...args); throw new Error(reason);
    }, f.deps), new RegExp(reason));
    assert.equal(f.calls.length, 1);
    assert.equal(f.phases.length, 1);
  }
});

test('native sampling preserves a wrong first draft even when the second passes acceptance', {
  skip: !process.env.FUSION_PROVIDED_QUALIFICATION,
}, async () => {
  const { readFile } = await import('node:fs/promises');
  const { loadTasks, sandbox, readSource, command, verify } = await import('../scripts/fusion-workloads.mjs');
  const task = (await loadTasks('benchmarks/fusion/provided-reproducer-workloads.json')).find(task => task.id === 'provided-responses-path');
  const receipt = JSON.parse(await readFile(process.env.FUSION_PROVIDED_QUALIFICATION)).receipts.find(row => row.taskId === task.id);
  const box = await sandbox(receipt.image);
  let original;
  try { original = await readSource(box, task.editPaths); } finally { await box.close(); }
  const repaired = await Promise.all(task.editPaths.map(async path => ({ path,
    content: (await command('git', ['show', `${task.oracle}:${path}`])).stdout.toString() })));
  let index = 0, calls = 0;
  const result = await runDraftSampling(task, receipt.image, 'native-control', config, async () => { calls++; }, {
    draft: async (_task, _image, _strategy, id, _settings, invoke, _unused, opts) => {
      await invoke(id, models.cheap, {}, opts.signal);
      return { ...candidate(1), files: [original, repaired][index++] };
    },
    agent: async () => { assert.fail('a visible-pass draft exists'); },
  });
  assert.equal(calls, 2);
  assert.equal(result.draftSampling.selectedCandidate, 1);
  assert.equal((await verify(task, receipt.image, result.files, process.cwd())).passed, false);
  assert.equal((await verify(task, receipt.image, repaired, process.cwd())).passed, true);
});
