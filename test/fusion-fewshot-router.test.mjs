import test from 'node:test';
import assert from 'node:assert/strict';
import { runRoutedAgent, validateRoutingExamples } from '../scripts/fusion-fewshot-router.mjs';
import { models } from '../scripts/fusion-benchmark-accounting.mjs';

const examples = [
  { taskId: 'local-guard', instruction: 'Fix a local guard.', worker: 'cheap' },
  { taskId: 'route-authorization', instruction: 'Preserve route authorization.', worker: 'strong' },
];
const task = { id: 'new-task', instruction: 'New requirements.' };

test('routing refuses training/evaluation overlap and invalid labels before model calls', () => {
  assert.match(validateRoutingExamples(examples, [task]), /^[a-f0-9]{64}$/);
  assert.throws(() => validateRoutingExamples(examples, [{ ...task, id: examples[0].taskId }]), /overlap/);
  assert.throws(() => validateRoutingExamples(examples, [{ ...task, instruction: examples[0].instruction + ' ' }]), /overlap/);
  assert.throws(() => validateRoutingExamples([{ ...examples[0], worker: 'oracle' }, examples[1]], [task]), /invalid/);
});

for (const worker of ['cheap', 'strong']) test(`the router selects ${worker} before execution and shares the deadline`, async () => {
  const calls = [], budget = { maxTurns: 11, outputTokens: 8192, deadlineMs: 10000 };
  const result = await runRoutedAgent(task, 'image', 'trial', budget, async (id, role, body) => {
    calls.push({ id, role, body });
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ worker }) } }] };
  }, async (seenTask, _image, strategy, id, settings, invoke) => {
    assert.equal(seenTask, task); assert.equal(strategy, 'strong'); assert.equal(id, 'trial');
    assert.equal(settings.maxTurns, 11); assert.ok(settings.deadlineMs <= budget.deadlineMs);
    await invoke(id, models.strong, { messages: [], max_tokens: 8192 }, new AbortController().signal);
    return { files: [], actions: [], agentMs: 1 };
  }, examples);
  assert.equal(calls.length, 2); assert.equal(calls[0].role, models.cheap);
  assert.equal(calls[1].role, models[worker]);
  assert.equal(calls[0].body.max_tokens, 64); assert.equal(result.routerChoice, worker);
  assert.ok(!JSON.stringify(result).includes(examples[0].instruction));
});

test('refused and malformed router answers never invoke a worker', async () => {
  for (const response of [
    { choices: [{ finish_reason: 'refusal', message: { content: '' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{"worker":"other"}' } }] },
  ]) {
    let workers = 0;
    await assert.rejects(runRoutedAgent(task, 'image', 'trial', { deadlineMs: 10000 }, async () => response,
      async () => { workers++; }, examples), /provider_refused|invalid_route/);
    assert.equal(workers, 0);
  }
});
