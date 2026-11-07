import assert from 'node:assert/strict';
import test from 'node:test';
import { contractRequest, runContractAgent } from '../scripts/fusion-contract-agent.mjs';
import { models } from '../scripts/fusion-benchmark-accounting.mjs';

const task = { instruction: 'Repair both admission and settlement.', editPaths: ['worker/a.ts'], visibleTests: ['worker/test/a.test.mjs'] };
const config = { maxTurns: 8, outputTokens: 8192, deadlineMs: 10000 };
const actionBody = { messages: [], max_tokens: 256 };
const result = () => ({ files: [{ path: 'worker/a.ts', content: 'private source sentinel' }], publicPassed: true,
  actions: [{ action: 'finish', status: 'ok' }], toolMs: 2, turns: 1 });

function fixture(probes, responses = [{ probe: 'private probe sentinel' }]) {
  const seen = [], boxes = [], pending = [...probes], generated = [...responses];
  return { seen, boxes, dependencies: {
    makeSandbox: async () => { const box = { closed: false, async close() { this.closed = true; } }; boxes.push(box); return box; },
    read: async () => [{ path: 'worker/a.ts', content: 'original' }],
    write: async () => {},
    runProbe: async () => pending.shift(),
    agent: async (_task, _image, _strategy, id, settings, invoke, _engine, options) => {
      seen.push({ settings, options, instruction: _task.instruction });
      await invoke(id, models.strong, actionBody, options.signal);
      return result();
    },
  }, invoke: async (_id, role, body) => {
    seen.push({ role, body });
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(generated.shift() ?? {}) } }] };
  } };
}
const failed = { passed: false, assertionFailed: true, feedback: 'invariant failed' };
const passed = { passed: true, assertionFailed: false, feedback: '' };

test('a reproduced frozen check accepts the cheap candidate without strong repair', async () => {
  const f = fixture([failed, passed]);
  const output = await runContractAgent(task, 'image', 'case:contract', config, f.invoke, f.dependencies);
  assert.deepEqual(f.seen.filter(x => x.role).map(x => x.role), [models.strong, models.cheap]);
  assert.equal(output.escalated, false); assert.equal(output.contractQualified, true); assert.equal(output.contractPassed, true);
  assert.equal(output.turns, 2); assert.equal(output.contractAttempts, 1);
  assert.deepEqual(output.actions.map(x => x.action), ['contract', 'finish', 'contract_check']);
  assert.ok(f.seen.find(x => x.instruction).instruction.includes('private probe sentinel'));
  const { files, ...trace } = output;
  assert.ok(!JSON.stringify(trace).includes('sentinel'));
  assert.ok(f.boxes.every(box => box.closed));
});

test('a failed cheap check escalates within the same shared allowance', async () => {
  const f = fixture([failed, failed, passed]);
  const output = await runContractAgent(task, 'image', 'case:contract', config, f.invoke, f.dependencies);
  assert.deepEqual(f.seen.filter(x => x.role).map(x => x.role), [models.strong, models.cheap, models.strong]);
  assert.equal(output.escalated, true); assert.equal(output.contractPassed, true);
  const settings = f.seen.filter(x => x.settings).map(x => x.settings.maxTurns);
  assert.deepEqual(settings, [6, 6]);
  assert.ok(f.seen.filter(x => x.options).every(x => x.options.preloadSource));
  assert.equal(output.turns, 3);
  assert.deepEqual(output.actions.map(x => x.action), ['contract', 'finish', 'contract_check', 'finish', 'contract_check']);
  assert.ok(f.boxes.every(box => box.closed));
});

test('invalid or non-reproducing checks cannot certify a cheap repair', async () => {
  const f = fixture([passed], [{ probe: '' }, { probe: 'non-reproducing' }]);
  const output = await runContractAgent(task, 'image', 'case:contract', config, f.invoke, f.dependencies);
  assert.equal(output.contractQualified, false); assert.equal(output.contractAttempts, 2);
  assert.equal(output.escalated, true); assert.equal(output.contractPassed, false);
  assert.deepEqual(f.seen.filter(x => x.role).map(x => x.role), [models.strong, models.strong, models.strong]);
  assert.ok(f.boxes.every(box => box.closed));
});

test('settled unusable test-author outputs consume attempts before strong fallback', async () => {
  for (const reason of ['provider_truncated', 'provider_empty']) {
    const f = fixture([]);
    let calls = 0;
    const output = await runContractAgent(task, 'image', 'case:contract', config, async (...args) => {
      if (++calls <= 2) throw new Error(reason);
      return f.invoke(...args);
    }, f.dependencies);
    assert.equal(output.contractQualified, false);
    assert.equal(output.contractAttempts, 2);
    assert.equal(output.escalated, true);
    assert.equal(output.turns, 3);
    assert.deepEqual(output.actions.slice(0, 2).map(action => action.status), [reason, reason]);
    assert.equal(f.seen.find(entry => entry.settings).settings.maxTurns, 6);
    assert.ok(f.boxes.every(box => box.closed));
  }
});

test('a complete second probe can recover from an incomplete first response', async () => {
  const f = fixture([failed, passed]);
  let calls = 0;
  const output = await runContractAgent(task, 'image', 'case:contract', config, async (...args) => {
    if (++calls === 1) throw new Error('provider_truncated');
    return f.invoke(...args);
  }, f.dependencies);
  assert.equal(output.contractAttempts, 2);
  assert.equal(output.contractQualified, true);
  assert.equal(output.escalated, false);
  assert.equal(output.turns, 3);
  assert.match(f.seen.find(entry => entry.body?.messages?.[1]).body.messages[1].content, /shorter probe/);
});

test('unknown costs and refusals stop before fallback, without leaking a sandbox', async () => {
  for (const code of ['unknown_cost', 'provider_refused']) {
    const f = fixture([]);
    await assert.rejects(runContractAgent(task, 'image', 'case:contract', config, async () => { throw new Error(code); }, f.dependencies), new RegExp(code));
    assert.ok(f.boxes.every(box => box.closed)); assert.equal(f.seen.length, 0);
  }
});

test('all stages share the call ceiling even if an executor asks for more', async () => {
  const f = fixture([failed]);
  f.dependencies.agent = async (_task, _image, _strategy, id, settings, invoke, _engine, options) => {
    for (let i = 0; i <= config.maxTurns; i++) await invoke(id, models.strong, actionBody, options.signal);
    return result();
  };
  await assert.rejects(runContractAgent(task, 'image', 'case:contract', config, f.invoke, f.dependencies), /trial_budget/);
  assert.equal(f.seen.filter(x => x.role).length, config.maxTurns);
  await assert.rejects(runContractAgent(task, 'image', 'case:contract', { ...config, maxTurns: 3 }, f.invoke, f.dependencies), /four_calls/);
});

test('fresh verification rejects test edits and always retires its own sandbox', async () => {
  const f = fixture([failed]);
  f.dependencies.agent = async () => ({ ...result(), files: [{ path: task.visibleTests[0], content: 'weakened' }] });
  await assert.rejects(runContractAgent(task, 'image', 'case:contract', config, f.invoke, f.dependencies), /invalid_edit_path/);
  assert.ok(f.boxes.every(box => box.closed));
  const request = contractRequest(task, [], 8192);
  assert.equal(request.max_tokens, 4096); assert.equal(request.response_format.json_schema.name, 'repair_contract');
});
