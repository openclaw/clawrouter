import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckDrivenSelector } from '../scripts/fusion-check-routing.mjs';
import { runAdaptiveModelTrajectory } from '../scripts/fusion-trajectory-models.mjs';

const config = { draftModel: 'small', repairModel: 'large', checkTool: 'check' };
const checked = passed => ({ action: { type: 'tool', name: 'check' }, observation: { passed } });
const read = { action: { type: 'tool', name: 'read' }, observation: { passed: false } };

test('check-driven routing uses only the named check and returns after a passing check', () => {
  const select = createCheckDrivenSelector(config);
  assert.equal(select({ history: [] }), 'small');
  assert.equal(select({ history: [read, checked('false'), { observation: { passed: false } }] }), 'small');
  assert.equal(select({ history: [checked(false)] }), 'large');
  assert.equal(select({ history: [checked(false), checked(true)] }), 'small');
  assert.equal(select({ history: [checked(false), checked(true), checked(false)] }), 'large');
});

test('repair windows are bounded and repeated failed checks extend them up to eight steps', () => {
  const select = createCheckDrivenSelector({ ...config, repairSteps: 2 });
  assert.equal(select({ history: [checked(false), read] }), 'large');
  assert.equal(select({ history: [checked(false), read, read] }), 'small');
  const repeated = Array.from({ length: 6 }, () => checked(false));
  assert.equal(select({ history: [...repeated, ...Array(7).fill(read)] }), 'large');
  assert.equal(select({ history: [...repeated, ...Array(8).fill(read)] }), 'small');
});

test('routing rejects invalid configuration and missing history', () => {
  for (const options of [undefined, { ...config, draftModel: '' }, { ...config, checkTool: 'bad name' },
    { ...config, repairSteps: 0 }, { ...config, repairSteps: 9 }, { ...config, repairSteps: 1.5 }]) {
    assert.throws(() => createCheckDrivenSelector(options), /invalid_check_routing/);
  }
  assert.throws(() => createCheckDrivenSelector(config)({}), /invalid_check_history/);
});

test('adaptive execution repairs a failed check and keeps its independent final check', async () => {
  let value = 'initial', revision = 0, checkedRevision = 0, checks = 0;
  const calls = [];
  const empty = { type: 'object', properties: {}, required: [], additionalProperties: false };
  const result = await runAdaptiveModelTrajectory({
    task: 'Set a correct value.', runId: 'check-routing-test', draftModel: 'small', reviewModel: 'large',
    selectModel: createCheckDrivenSelector(config), maxModelCalls: 3, maxToolCalls: 5, finalCheckTool: 'check',
    nextAction: () => revision > checkedRevision ? { type: 'tool', name: 'check', arguments: {} } : null,
    tools: [
      { name: 'edit', effect: 'write', parameters: empty, validate: args => Object.keys(args).length === 0, execute: async () => {
        value = calls.length === 1 ? 'incorrect' : 'correct'; revision++; return { applied: true };
      } },
      { name: 'check', effect: 'read', parameters: empty, validate: args => Object.keys(args).length === 0, execute: async () => {
        checks++; checkedRevision = revision; return { passed: value === 'correct' };
      } },
    ],
    invoke: async (_id, model) => {
      calls.push(model);
      const action = calls.length < 3 ? { type: 'tool', name: 'edit', arguments: {} }
        : { type: 'final', content: 'Fixed.' };
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ action }) } }] };
    },
  });
  assert.deepEqual(calls, ['small', 'large', 'small']);
  assert.equal(checks, 3);
  assert.equal(result.content, 'Fixed.');
  assert.equal(result.stats.modelCalls, 3);
});
