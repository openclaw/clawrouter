import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceWindows, groundedEdits, runGroundedAgent } from '../scripts/fusion-grounded-agent.mjs';
import { models } from '../scripts/fusion-benchmark-accounting.mjs';

test('source windows are bounded and explicit inspection reaches later lines', () => {
  const file = { path: 'worker/example.ts', content: Array.from({ length: 600 }, (_, n) => `const value${n} = ${n};`).join('\n') };
  const views = sourceWindows([file], 'Fix value520', { path: file.path, line: 521, query: '' }, 3000);
  assert.ok(views[0].startLine > 400);
  assert.ok(views[0].content.includes('value520'));
  assert.ok(Buffer.byteLength(views[0].content) <= 3000);
  assert.ok(views[0].endLine - views[0].startLine < 160);
});

test('edits must match an observed unique source anchor', () => {
  const task = { editPaths: ['worker/example.ts'] };
  const files = [{ path: task.editPaths[0], content: 'const x = false;\nconst y = false;' }];
  const views = [{ path: task.editPaths[0], content: 'const x = false;' }];
  const action = { path: task.editPaths[0], search: 'const x = false;', replace: 'const x = true;' };
  assert.match(groundedEdits(task, files, views, action)[0].content, /x = true/);
  assert.throws(() => groundedEdits(task, files, views, { ...action, search: 'const y = false;' }), /unseen_edit/);
  assert.throws(() => groundedEdits(task, files, views, { ...action, search: 'false' }), /search_must_match_once/);
});

test('handoff sees actual edited source and never acceptance files', async () => {
  const task = { instruction: 'Set enabled to true.', editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'], hiddenTests: ['worker/test/hidden.test.mjs'] };
  let source = 'export const enabled = false;', closed = false, invocation = 0;
  const action = (kind, extra = {}) => ({ action: kind, path: '', line: 0, search: '', replace: '', query: '', ...extra });
  const result = await runGroundedAgent(task, 'unused', 'handoff', 'trial', { maxTurns: 8, outputTokens: 1536, deadlineMs: 10000 },
    async (_id, model, body) => {
      assert.ok(!JSON.stringify(body).includes('hidden.test'));
      if (invocation === 0) { assert.equal(model, models.strong); assert.ok(JSON.stringify(body).includes('enabled = false')); }
      if (invocation === 2) { assert.equal(model, models.critic); assert.ok(JSON.stringify(body).includes('enabled = true')); }
      const value = invocation++ === 0 ? action('edit', { path: task.editPaths[0], search: source, replace: 'export const enabled = true;' }) : action('finish');
      return { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] };
    }, undefined, {
      makeSandbox: async () => ({ close: async () => { closed = true; } }),
      read: async (_box, paths) => paths.map(path => { assert.ok(!task.hiddenTests.includes(path)); return { path, content: path === task.editPaths[0] ? source : 'import "../example.ts";' }; }),
      write: async (_box, files) => { source = files[0].content; },
      test: async () => ({ passed: true, feedback: 'visible checks passed' }),
    });
  assert.equal(invocation, 3); assert.equal(result.handoffUsed, true); assert.equal(result.outcome, 'submitted');
  assert.equal(result.invalidActions, 0); assert.equal(result.files[0].content, 'export const enabled = true;');
  assert.equal(closed, true);
});
