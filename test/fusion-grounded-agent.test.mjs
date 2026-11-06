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
  const pair = sourceWindows([file, { ...file, path: 'worker/second.ts' }], 'Fix value520', null, 3000);
  assert.ok(pair.every(view => view.content.length > 0));
  assert.ok(pair.reduce((sum, view) => sum + Buffer.byteLength(view.content), 0) <= 3000);
});

test('numbered edits require current observed lines and reject stale views', () => {
  const task = { editPaths: ['worker/example.ts'] };
  const files = [{ path: task.editPaths[0], content: 'const x = false;\nconst y = false;' }];
  const views = [{ path: task.editPaths[0], content: 'const x = false;', startLine: 1, endLine: 1 }];
  const action = { path: task.editPaths[0], line: 1, endLine: 1, replace: 'const x = true;' };
  assert.match(groundedEdits(task, files, views, action)[0].content, /x = true/);
  assert.throws(() => groundedEdits(task, files, views, { ...action, line: 2, endLine: 2 }), /unseen_edit/);
  assert.throws(() => groundedEdits(task, files, views, { ...action, replace: 'const x = false;' }), /unchanged_edit/);
  assert.throws(() => groundedEdits(task, [{ ...files[0], content: 'const x = 2;\nconst y = false;' }], views, action), /unseen_edit/);
});

test('handoff sees actual edited source and never acceptance files', async () => {
  const task = { instruction: 'Set enabled to true.', editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'], hiddenTests: ['worker/test/hidden.test.mjs'] };
  let source = 'export const enabled = false;', closed = false, invocation = 0;
  const action = (kind, extra = {}) => ({ action: kind, path: '', line: 0, endLine: 0, replace: '', query: '', ...extra });
  const result = await runGroundedAgent(task, 'unused', 'handoff', 'trial', { maxTurns: 8, outputTokens: 1536, deadlineMs: 10000 },
    async (_id, model, body) => {
      assert.ok(!JSON.stringify(body).includes('hidden.test'));
      if (invocation === 0) { assert.equal(model, models.strong); assert.ok(JSON.stringify(body).includes('enabled = false')); }
      if (invocation === 2) { assert.equal(model, models.critic); assert.ok(JSON.stringify(body).includes('enabled = true')); }
      const value = invocation++ === 0 ? action('edit', { path: task.editPaths[0], line: 1, endLine: 1, replace: 'export const enabled = true;' }) : action('finish');
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

test('an expired action deadline still allows bounded final patch collection', async () => {
  let calls = 0, finalTimeout;
  const task = { instruction: 'Fix.', editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'] };
  const result = await runGroundedAgent(task, 'unused', 'strong', 'trial', { maxTurns: 2, outputTokens: 1536, deadlineMs: 1 },
    async () => { throw new Error('must not call expired model'); }, undefined, {
      makeSandbox: async () => ({ close: async () => {} }),
      read: async (_box, paths, timeout) => {
        if (calls++ === 0) await new Promise(resolve => setTimeout(resolve, 10));
        else finalTimeout = timeout;
        return paths.map(path => ({ path, content: 'export const value = 1;' }));
      },
    });
  assert.equal(result.outcome, 'deadline'); assert.equal(finalTimeout, 10000);
});
