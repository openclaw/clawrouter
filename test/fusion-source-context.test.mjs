import assert from 'node:assert/strict';
import test from 'node:test';
import { readTaskContext, validateSourceContext } from '../scripts/fusion-workloads.mjs';
import { runGroundedAgent } from '../scripts/fusion-grounded-agent.mjs';

const task = { editPaths: ['worker/pricing.ts'], hiddenTests: ['worker/test/acceptance.test.mjs'],
  sourceContext: [{ path: 'scripts/compile-providers.mjs', query: 'function declaredFormats(' }] };

test('source context permits bounded declarations without expanding edit or test access', () => {
  assert.equal(validateSourceContext(task), task.sourceContext);
  assert.deepEqual(validateSourceContext({ ...task, sourceContext: undefined }), []);
  for (const path of ['worker/pricing.ts', 'worker/test/acceptance.test.mjs', '../secret', 'scripts/../secret',
    'scripts//source.mjs', 'scripts/example.test.mjs', 'test/helper.mjs', '/tmp/source']) {
    assert.throws(() => validateSourceContext({ ...task, sourceContext: [{ ...task.sourceContext[0], path }] }), /invalid_source_context/);
  }
  for (const query of ['', ' ', 'x'.repeat(201), null])
    assert.throws(() => validateSourceContext({ ...task, sourceContext: [{ ...task.sourceContext[0], query }] }), /invalid_source_context/);
  assert.throws(() => validateSourceContext({ ...task, sourceContext: Array(2).fill(task.sourceContext[0]) }), /invalid_source_context/);
});

test('a unique literal selector supplies only its bounded original-source window', async () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  lines[20] = 'function declaredFormats() {';
  let seen;
  const result = await readTaskContext('box', task, 123, async (...args) => {
    seen = args;
    return [{ path: task.sourceContext[0].path, content: lines.join('\n') }];
  });
  assert.deepEqual(seen, ['box', ['scripts/compile-providers.mjs'], 123]);
  assert.equal(result[0].startLine, 13); assert.equal(result[0].endLine, 29);
  assert.equal(result[0].content, lines.slice(12, 29).join('\n'));
  assert.deepEqual(await readTaskContext('box', { ...task, sourceContext: undefined }, 123,
    () => assert.fail('optional context must not read files')), []);
});

test('missing, ambiguous and oversized context cannot silently alter the experiment', async () => {
  for (const files of [[], [{ path: task.sourceContext[0].path, content: 'no match' }],
    [{ path: task.sourceContext[0].path, content: 'function declaredFormats(\nfunction declaredFormats(' }]]) {
    await assert.rejects(readTaskContext('box', task, 123, async () => files), /source_context/);
  }
  await assert.rejects(readTaskContext('box', task, 123, async () => [{ path: task.sourceContext[0].path,
    content: `function declaredFormats(${ 'x'.repeat(24000) }` }]), /source_context_too_large/);
});

test('grounded workers receive the original declaration without edit access', async () => {
  const request = { ...task, instruction: 'Repair pricing.', visibleTests: ['worker/test/pricing.test.mjs'] };
  let closed = false;
  await runGroundedAgent(request, 'image', 'strong', 'case', { maxTurns: 1, outputTokens: 256, deadlineMs: 10000 },
    async (_id, _role, body) => {
      const state = JSON.parse(body.messages[1].content);
      assert.match(state.sourceContext[0].content, /declaredFormats/);
      assert.deepEqual(state.editable, task.editPaths);
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ action: 'finish' }) } }] };
    }, undefined, {
      makeSandbox: async () => ({ close: async () => { closed = true; } }),
      read: async (_box, paths) => paths.map(path => ({ path, content: path === task.sourceContext[0].path ? 'function declaredFormats() {}' : 'export const value = 1;' })),
      test: async () => ({ passed: true, feedback: '' }),
    });
  assert.equal(closed, true);
});
