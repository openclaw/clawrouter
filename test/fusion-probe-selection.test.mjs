import assert from 'node:assert/strict';
import test from 'node:test';
import { runProbeSelection, probeSelectionRequest } from '../scripts/fusion-probe-selection.mjs';
import { models } from '../scripts/fusion-benchmark-accounting.mjs';

const task = { instruction: 'Repair behavior.', editPaths: ['worker/a.ts'], visibleTests: [] };
const config = { maxTurns: 6, outputTokens: 4096, deadlineMs: 10000 };
const source = content => [{ path: 'worker/a.ts', content }];
const passed = { passed: true, assertionFailed: false, feedback: 'private output' };
const failed = { passed: false, assertionFailed: true, feedback: 'private assertion' };
const invalid = { passed: false, assertionFailed: false, feedback: 'private import error' };

function fixture(results = [failed, failed, passed]) {
  const calls = [], boxes = [], phases = [], pending = [...results];
  let drafts = 0;
  const dependencies = {
    makeSandbox: async () => {
      const box = { files: source('original'), async close() { this.closed = true; } };
      boxes.push(box); return box;
    },
    read: async box => box.files,
    write: async (box, files) => { box.files = files; },
    intact: async (box, files) => JSON.stringify(box.files) === JSON.stringify(files),
    runProbe: async () => pending.shift(),
    draft: async (_task, _image, _strategy, id, settings, invoke, _engine, options) => {
      phases.push({ type: 'draft', task: _task, settings, options });
      await invoke(id, models.strong, { messages: [], max_tokens: 128 }, options.signal);
      return { files: source(`private candidate source ${++drafts}`), outcome: 'draft_submitted', publicPassed: true,
        actions: [{ action: 'draft', status: 'ok' }], toolMs: 0 };
    },
    agent: async (_task, _image, _strategy, id, settings, invoke, _engine, options) => {
      phases.push({ type: 'fallback', task: _task, settings, options });
      await invoke(id, models.cheap, { messages: [], max_tokens: 128 }, options.signal);
      return { files: source('fallback'), outcome: 'submitted', publicPassed: true,
        actions: [{ action: 'finish', status: 'ok' }], toolMs: 0 };
    },
  };
  const invoke = async (id, role, body, signal) => {
    calls.push({ id, role, body, signal });
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ probe: 'private probe sentinel' }) } }] };
  };
  return { calls, boxes, phases, dependencies, invoke };
}

test('unique behavioral witness selects a draft without a judge or fallback', async () => {
  const f = fixture();
  const result = await runProbeSelection(task, 'image', 'same-trial', config, f.invoke, f.dependencies);
  assert.equal(result.probeSelection.outcome, 'selected');
  assert.equal(result.probeSelection.selectedCandidate, 2);
  assert.deepEqual(result.files, source('private candidate source 2'));
  assert.equal(result.escalated, false);
  assert.equal(result.turns, 3);
  assert.deepEqual(f.calls.map(c => c.role), [models.cheap, models.cheap, models.cheap]);
  assert.ok(f.calls.every(c => c.id === 'same-trial'));
  assert.ok(f.boxes.every(box => box.closed));
  assert.deepEqual(result.probeSelection.observations.map(item => item.status), ['assertion_failed', 'assertion_failed', 'passed']);
  const { files, ...trace } = result;
  for (const value of ['private probe', 'private output', 'private assertion', 'private candidate source']) assert.ok(!JSON.stringify(trace).includes(value));
});

for (const [name, outcomes, reason] of [
  ['vacuous', [passed, failed, passed], 'baseline_not_reproduced'],
  ['original import failure', [invalid, failed, passed], 'baseline_not_reproduced'],
  ['candidate import failure', [failed, invalid, passed], 'invalid_comparison'],
  ['both pass', [failed, passed, passed], 'ambiguous'],
  ['both fail', [failed, failed, failed], 'ambiguous'],
]) test(`${name} evidence abstains and preserves strong fallback allowance`, async () => {
  const f = fixture(outcomes);
  const result = await runProbeSelection(task, 'image', 'same-trial', config, f.invoke, f.dependencies);
  assert.equal(result.probeSelection.outcome, reason);
  assert.equal(result.probeSelection.selectedCandidate, null);
  assert.equal(result.escalated, true);
  assert.deepEqual(result.files, source('fallback'));
  assert.equal(result.turns, 4);
  assert.deepEqual(f.calls.map(c => c.role), [models.cheap, models.cheap, models.cheap, models.strong]);
  const fallback = f.phases.at(-1);
  assert.equal(fallback.settings.maxTurns, 3);
  assert.equal(fallback.task, task);
  assert.ok(f.boxes.every(box => box.closed));
});

test('a probe that rewrites source cannot manufacture a passing comparison', async () => {
  const f = fixture(); let index = 0;
  f.dependencies.runProbe = async box => {
    if (++index === 3) box.files = source('mutated');
    return index === 3 ? passed : failed;
  };
  const result = await runProbeSelection(task, 'image', 'trial', config, f.invoke, f.dependencies);
  assert.equal(result.probeSelection.outcome, 'invalid_comparison');
  assert.equal(result.probeSelection.observations[2].status, 'source_changed');
  assert.equal(result.escalated, true);
});

test('integrity infrastructure failures propagate instead of accepting or falling back', async () => {
  const f = fixture();
  f.dependencies.intact = async () => { throw new Error('command_timeout'); };
  await assert.rejects(runProbeSelection(task, 'image', 'trial', config, f.invoke, f.dependencies), /command_timeout/);
  assert.equal(f.phases.filter(p => p.type === 'fallback').length, 0);
  assert.ok(f.boxes.every(box => box.closed));
});

test('duplicate or incomplete drafts skip the author call', async () => {
  for (const incomplete of [false, true]) {
    const f = fixture(), draft = f.dependencies.draft;
    f.dependencies.draft = async (...args) => ({ ...await draft(...args), files: source('same'),
      ...(incomplete ? { outcome: 'draft_rejected' } : {}) });
    const result = await runProbeSelection(task, 'image', 'trial', config, f.invoke, f.dependencies);
    assert.equal(result.probeSelection.outcome, incomplete ? 'incomplete_candidates' : 'duplicate_candidates');
    assert.deepEqual(f.calls.map(c => c.role), [models.cheap, models.cheap, models.strong]);
    assert.equal(f.phases.at(-1).settings.maxTurns, 4);
  }
});

test('uncertain provider failures stop the trial without changing provider', async () => {
  for (const failAt of [1, 3, 4]) {
    const f = fixture([failed, passed, passed]);
    await assert.rejects(runProbeSelection(task, 'image', 'trial', config, async (...args) => {
      const response = await f.invoke(...args);
      if (f.calls.length === failAt) throw new Error('unknown_cost');
      return response;
    }, f.dependencies), /unknown_cost/);
    assert.equal(f.calls.length, failAt);
    assert.ok(f.boxes.every(box => box.closed));
  }
});

test('one shared deadline prevents another phase after a slow draft', async () => {
  const f = fixture(), draft = f.dependencies.draft;
  f.dependencies.draft = async (...args) => {
    const result = await draft(...args);
    await new Promise(resolve => setTimeout(resolve, 15));
    return result;
  };
  await assert.rejects(runProbeSelection(task, 'image', 'trial', { ...config, deadlineMs: 5 }, f.invoke, f.dependencies), /command_timeout/);
  assert.equal(f.calls.length, 1);
});

test('the coordinator enforces phase caps even if a draft asks for another call', async () => {
  const f = fixture(), draft = f.dependencies.draft;
  f.dependencies.draft = async (...args) => {
    await draft(...args);
    await args[5]('trial', models.cheap, {}, args[7].signal);
  };
  await assert.rejects(runProbeSelection(task, 'image', 'trial', config, f.invoke, f.dependencies), /trial_budget/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(runProbeSelection(task, 'image', 'trial', { ...config, maxTurns: 3 }, f.invoke), /four_calls/);
});

test('author sees declared context and bounded previews, never acceptance tests', () => {
  const request = probeSelectionRequest({ ...task, hiddenTests: ['private-hidden-test'] }, source('original'),
    source('declared-context'), [source('first'), source('second')], 8192);
  assert.equal(request.max_tokens, 4096);
  assert.match(JSON.stringify(request), /declared-context/);
  assert.ok(!JSON.stringify(request).includes('private-hidden-test'));
});

for (const [name, response, reason] of [
  ['malformed', { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }, 'invalid_probe'],
  ['truncated', { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }, 'provider_truncated'],
]) test(`${name} author response falls back within the same call cap`, async () => {
  const f = fixture();
  const result = await runProbeSelection(task, 'image', 'trial', { ...config, maxTurns: 4 }, async (...args) => {
    const normal = await f.invoke(...args);
    return f.calls.length === 3 ? response : normal;
  }, f.dependencies);
  assert.equal(result.probeSelection.outcome, reason);
  assert.equal(f.phases.at(-1).settings.maxTurns, 1);
  assert.equal(result.turns, 4);
  assert.ok(f.boxes.every(box => box.closed));
});

test('native sandbox selects the independently accepted repair with the supplied behavioral probe', {
  skip: !process.env.FUSION_PROVIDED_QUALIFICATION,
}, async () => {
  const { readFile } = await import('node:fs/promises');
  const { loadTasks, command, sandbox, readSource, verify } = await import('../scripts/fusion-workloads.mjs');
  const task = (await loadTasks('benchmarks/fusion/provided-reproducer-workloads.json'))
    .find(task => task.id === 'provided-responses-path');
  const receipt = JSON.parse(await readFile(process.env.FUSION_PROVIDED_QUALIFICATION))
    .receipts.find(row => row.taskId === task.id);
  assert.equal(receipt.qualified, true);
  const box = await sandbox(receipt.image);
  let original;
  try { original = await readSource(box, task.editPaths); } finally { await box.close(); }
  const repaired = await Promise.all(task.editPaths.map(async path => ({ path,
    content: (await command('git', ['show', `${task.oracle}:${path}`])).stdout.toString() })));
  const candidates = [original, repaired]; let drafts = 0, calls = 0;
  const result = await runProbeSelection(task, receipt.image, 'native-selection',
    { ...config, deadlineMs: 120000 }, async () => {
      calls++;
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ probe: task.reproducer }) } }] };
    }, {
      draft: async (_task, _image, _strategy, id, _config, invoke, _engine, { signal }) => {
        await invoke(id, models.cheap, {}, signal);
        return { files: candidates[drafts++], outcome: 'draft_submitted', publicPassed: true, actions: [], toolMs: 0 };
      },
      agent: async () => { assert.fail('valid unique witness must not fall back'); },
    });
  assert.equal(result.probeSelection.selectedCandidate, 2);
  assert.equal(calls, 3);
  const verdict = await verify(task, receipt.image, result.files, process.cwd());
  assert.equal(verdict.passed, true);
  assert.equal(verdict.tests, receipt.oracle.tests);

  let maliciousDraft = 0;
  const damaged = await runProbeSelection(task, receipt.image, 'native-source-damage',
    { ...config, deadlineMs: 120000 }, async () => ({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ probe: `import { unlinkSync } from 'node:fs'; import assert from 'node:assert/strict'; unlinkSync(${JSON.stringify(task.editPaths[0])}); assert.fail('invalid probe deleted source');` }),
    } }] }), {
      draft: async (_task, _image, _strategy, id, _config, invoke, _engine, { signal }) => {
        await invoke(id, models.cheap, {}, signal);
        return { files: candidates[maliciousDraft++], outcome: 'draft_submitted', publicPassed: true, actions: [], toolMs: 0 };
      },
      agent: async () => ({ files: original, publicPassed: true, outcome: 'submitted', actions: [], toolMs: 0 }),
    });
  assert.equal(damaged.escalated, true);
  assert.equal(damaged.probeSelection.selectedCandidate, null);
  assert.ok(damaged.probeSelection.observations.every(item => item.status === 'source_changed'));
});
