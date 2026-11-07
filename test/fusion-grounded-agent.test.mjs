import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceWindows, sourceDependencies, groundedEdits, runGroundedAgent } from '../scripts/fusion-grounded-agent.mjs';
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

test('literal inspection reports missing queries without substituting unrelated source', () => {
  const file = { path: 'worker/example.ts', content: 'const enabled = false;\nconst other = true;' };
  const missing = sourceWindows([file], 'Fix enabled', { path: file.path, query: 'enabled|other' })[0];
  assert.equal(missing.queryMatched, false);
  assert.equal(missing.content, '');
  assert.equal(missing.endLine, 0);
  assert.throws(() => groundedEdits({ editPaths: [file.path] }, [file], [missing],
    { path: file.path, line: 1, endLine: 1, replace: 'const enabled = true;' }), /unseen_edit/);
  const found = sourceWindows([file], 'Fix enabled', { path: file.path, query: 'enabled' })[0];
  assert.equal(found.queryMatched, true);
  assert.match(found.content, /enabled/);
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

test('checked handoff isolates probes and repairs against the same failing reproduction', async () => {
  const task = { instruction: 'Set enabled to true.', editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'] };
  const boxes = [], seenProbes = [], roles = [];
  const reproducer = 'import assert from "node:assert/strict"; import * as source0 from "./worker/example.ts"; assert.equal(source0.enabled, true);';
  let call = 0;
  const result = await runGroundedAgent(task, 'image', 'handoff', 'trial',
    { maxTurns: 8, outputTokens: 1536, deadlineMs: 10000, requireReproducer: true },
    async (_id, role, body) => {
      roles.push(role);
      const message = JSON.parse(body.messages[1].content);
      assert.deepEqual(message.probeModules, [{ binding: 'source0', path: './worker/example.ts' }]);
      const action = { action: 'probe', path: '', line: 0, endLine: 0, query: reproducer, replace: '' };
      if (call++ === 1) {
        assert.equal(message.phase, 'repair'); assert.equal(message.reproduction, reproducer);
        Object.assign(action, { action: 'edit', path: task.editPaths[0], line: 1, endLine: 1, query: '', replace: 'export const enabled = true;' });
      }
      return { choices: [{ message: { content: JSON.stringify(action) }, finish_reason: 'stop' }] };
    }, undefined, {
      makeSandbox: async () => { const box = { source: 'export const enabled = false;', closed: false, close: async () => { box.closed = true; } }; boxes.push(box); return box; },
      read: async (box, paths) => paths.map(path => ({ path, content: path === task.editPaths[0] ? box.source : 'test example' })),
      write: async (box, files) => { box.source = files[0].content; },
      test: async () => ({ passed: true, feedback: '' }),
      runProbe: async (box, source) => {
        assert.notEqual(box, boxes[0]); seenProbes.push(source);
        const module = source.replaceAll(JSON.stringify('./worker/example.ts'),
          JSON.stringify('data:text/javascript,' + encodeURIComponent(box.source)));
        let passed = false;
        try { await import('data:text/javascript,' + encodeURIComponent(module)); passed = true; }
        catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); }
        finally { delete globalThis.assert; delete globalThis.source0; }
        box.source = 'probe side effect must not reach the repair workspace';
        return { passed, assertionFailed: !passed, feedback: passed ? '' : 'ERR_ASSERTION' };
      },
    });
  assert.deepEqual(roles, [models.strong, models.critic]);
  assert.equal(seenProbes.length, 2); assert.equal(seenProbes[0], seenProbes[1]);
  assert.ok(seenProbes[0].includes('globalThis.assert = (await import("node:assert/strict")).default;'));
  assert.ok(seenProbes[0].includes('globalThis.source0 = await import("./worker/example.ts");'));
  assert.ok(seenProbes[0].endsWith(reproducer));
  assert.equal(result.outcome, 'verified'); assert.equal(result.reproducerQualified, true);
  assert.equal(result.probePassed, true); assert.equal(result.files[0].content, 'export const enabled = true;');
  assert.ok(boxes.every(box => box.closed));
});

test('checked repair rejects premature finish, passing probes and runtime errors within its reproduction budget', async () => {
  let calls = 0, writes = 0;
  const task = { instruction: 'Fix.', editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'] };
  const result = await runGroundedAgent(task, 'image', 'handoff', 'trial',
    { maxTurns: 8, outputTokens: 1536, deadlineMs: 10000, requireReproducer: true },
    async (_id, role) => {
      assert.equal(role, models.strong);
      const action = { action: calls++ === 0 ? 'finish' : 'probe', path: '', line: 0, endLine: 0, query: 'test', replace: '' };
      return { choices: [{ message: { content: JSON.stringify(action) }, finish_reason: 'stop' }] };
    }, undefined, {
      makeSandbox: async () => ({ close: async () => {} }),
      read: async (_box, paths) => paths.map(path => ({ path, content: 'original' })),
      write: async () => { writes++; },
      runProbe: async () => ({ passed: calls === 2, assertionFailed: false, feedback: 'not a failing assertion' }),
    });
  assert.equal(calls, 3); assert.equal(writes, 0);
  assert.equal(result.outcome, 'no_reproducer'); assert.equal(result.handoffUsed, false);
  assert.equal(result.reproducerQualified, false); assert.equal(result.probePassed, false);
});

for (const repair of [false, true]) test(`independent review ${repair ? 'repairs an omitted invariant' : 'accepts a correct candidate'} before submission`, async () => {
  const task = { instruction: 'Enable the feature and preserve the existing flag.', editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'] };
  const roles = [], phases = [], boxes = [];
  let invocation = 0;
  const result = await runGroundedAgent(task, 'image', 'review', 'trial',
    { maxTurns: 8, outputTokens: 1536, deadlineMs: 10000, requireReproducer: true },
    async (_id, role, body) => {
      roles.push(role); phases.push(JSON.parse(body.messages[1].content).phase);
      const action = { action: 'probe', path: '', line: 0, endLine: 0, query: 'assert.equal(source0.enabled, true)', replace: '' };
      if (invocation === 1) Object.assign(action, { action: 'edit', path: task.editPaths[0], line: 1, endLine: 2,
        replace: `export const enabled = true;\nexport const preserved = ${!repair};` });
      if (invocation === 2) {
        assert.match(body.messages[0].content, /ENTIRE issue/);
        Object.assign(action, repair
          ? { action: 'edit', path: task.editPaths[0], line: 2, endLine: 2, replace: 'export const preserved = true;' }
          : { action: 'finish' });
      }
      invocation++;
      return { choices: [{ message: { content: JSON.stringify(action) }, finish_reason: 'stop' }] };
    }, undefined, {
      makeSandbox: async () => {
        const box = { source: 'export const enabled = false;\nexport const preserved = true;', closed: false,
          close: async () => { box.closed = true; } }; boxes.push(box); return box;
      },
      read: async (box, paths) => paths.map(path => ({ path, content: path === task.editPaths[0] ? box.source : 'visible test' })),
      write: async (box, files) => { box.source = files[0].content; },
      test: async () => ({ passed: true, feedback: '' }),
      runProbe: async box => ({ passed: box.source.includes('enabled = true'),
        assertionFailed: !box.source.includes('enabled = true'), feedback: '' }),
    });
  assert.deepEqual(roles, [models.strong, models.strong, models.critic]);
  assert.deepEqual(phases, ['reproduce', 'repair', 'review']);
  assert.equal(result.reviewed, true); assert.equal(result.outcome, 'verified');
  assert.match(result.files[0].content, /preserved = true/);
  assert.ok(boxes.every(box => box.closed));
});

test('independent review requires the checked interface before allocating a sandbox', async () => {
  await assert.rejects(runGroundedAgent({}, 'image', 'review', 'trial', {}, async () => {}, undefined,
    { makeSandbox: async () => { throw Error('must not allocate'); } }), /review_requires_reproducer/);
});

test('independent reviewer rescues a three-action author failure within the shared budget', async () => {
  const task = { instruction: 'Enable the feature.', editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'] };
  const roles = []; let probes = 0;
  const result = await runGroundedAgent(task, 'image', 'review', 'trial',
    { maxTurns: 8, outputTokens: 1536, deadlineMs: 10000, requireReproducer: true },
    async (_id, role, body) => {
      roles.push(role);
      const action = { action: 'probe', path: '', line: 0, endLine: 0, query: 'probe', replace: '' };
      if (roles.length === 5) {
        assert.equal(JSON.parse(body.messages[1].content).phase, 'review');
        Object.assign(action, { action: 'edit', path: task.editPaths[0], line: 1, endLine: 1, replace: 'export const enabled = true;' });
      }
      return { choices: [{ message: { content: JSON.stringify(action) }, finish_reason: 'stop' }] };
    }, undefined, {
      makeSandbox: async () => { const box = { source: 'export const enabled = false;', close: async () => {} }; return box; },
      read: async (box, paths) => paths.map(path => ({ path, content: path === task.editPaths[0] ? box.source : '' })),
      write: async (box, files) => { box.source = files[0].content; },
      test: async () => ({ passed: true, feedback: '' }),
      runProbe: async box => { probes++; return { passed: probes < 4 || box.source.includes('enabled = true'), assertionFailed: probes === 4, feedback: '' }; },
    });
  assert.deepEqual(roles, [models.strong, models.strong, models.strong, models.critic, models.critic]);
  assert.equal(result.turns, 5); assert.equal(result.reviewed, true); assert.equal(result.outcome, 'verified');
});

test('source dependency discovery is bounded to static source imports outside test paths', () => {
  const files = [{ path: 'worker/example.ts', content: `
    import { helper } from "./helper.ts";
    import type { Shared } from "../shared/types.ts";
    import "./test/hidden.test.mjs";
    import "../../private/secret.ts";
    import "./credentials.json";
    import "./hidden.ts";
  ` }];
  assert.deepEqual(sourceDependencies(files, { hiddenTests: ['worker/hidden.ts'] }), ['worker/helper.ts', 'shared/types.ts']);
  const many = [{ path: 'worker/example.ts', content: Array.from({length: 40}, (_, i) => `import "./helper${i}.ts";`).join('\n') }];
  assert.equal(sourceDependencies(many, {}).length, 32);
});

test('workers can inspect declared source dependencies but cannot edit them', async () => {
  const task = { instruction: 'Fix enabled.', editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'], hiddenTests: ['worker/test/hidden.test.mjs'] };
  const sources = { 'worker/example.ts': 'import { enabled } from "./helper.ts";', 'worker/helper.ts': 'export const enabled = true;' };
  let calls = 0, writes = 0;
  const result = await runGroundedAgent(task, 'image', 'strong', 'trial', { maxTurns: 3, outputTokens: 1536, deadlineMs: 10000 },
    async (_id, _role, body) => {
      const message = JSON.parse(body.messages[1].content);
      assert.ok(message.readable.includes('worker/helper.ts'));
      assert.ok(body.response_format.json_schema.schema.properties.path.enum.includes('worker/helper.ts'));
      assert.ok(!message.readable.includes(task.hiddenTests[0]));
      const action = { action: 'inspect', path: 'worker/helper.ts', line: 1, endLine: 1, replace: '', query: '', memory: 'helper inspection requested; original file is read-only' };
      if (calls === 1) {
        assert.equal(message.workingMemory, 'helper inspection requested; original file is read-only');
        assert.ok(message.currentSource.some(view => view.path === 'worker/helper.ts' && view.numberedSource.includes('enabled = true')));
        Object.assign(action, { action: 'edit', replace: 'export const enabled = false;' });
      }
      if (calls === 2) action.action = 'finish';
      calls++;
      return { choices: [{ message: { content: JSON.stringify(action) }, finish_reason: 'stop' }] };
    }, undefined, {
      makeSandbox: async () => ({ close: async () => {} }),
      read: async (_box, paths) => paths.map(path => ({ path, content: sources[path] ?? '' })),
      write: async () => { writes++; }, test: async () => ({ passed: true, feedback: '' }),
    });
  assert.equal(writes, 0); assert.equal(result.invalidActions, 1); assert.equal(result.actions[1].status, 'unseen_edit');
  assert.ok(!JSON.stringify(result).includes('helper inspection requested'));
});


for (const invalidMemory of ['', ' ', 'x'.repeat(2001)]) test(`invalid working memory of length ${invalidMemory.length} cannot enter the next model context`, async () => {
  let calls = 0;
  const result = await runGroundedAgent({ instruction: 'Fix.', editPaths: ['worker/example.ts'], visibleTests: [] },
    'image', 'strong', 'trial', { maxTurns: 2, outputTokens: 1536, deadlineMs: 10000 },
    async (_id, _role, body) => {
      assert.equal(JSON.parse(body.messages[1].content).workingMemory, '');
      const action = calls++ === 0 ? { action: 'finish', memory: invalidMemory } : { action: 'finish', memory: 'Completed.' };
      return { choices: [{ message: { content: JSON.stringify(action) }, finish_reason: 'stop' }] };
    }, undefined, {
      makeSandbox: async () => ({ close: async () => {} }),
      read: async (_box, paths) => paths.map(path => ({ path, content: 'export const x = 1;' })),
      test: async () => ({ passed: true, feedback: '' }),
    });
  assert.equal(result.invalidActions, 1); assert.equal(result.actions[0].action, 'invalid_memory');
});
