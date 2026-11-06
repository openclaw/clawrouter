import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionTasks, executionPrompt } from '../benchmarks/fusion/execution-smoke.mjs';
import { parseModule, gradeCandidate, buildExecutionImage, qualifyExecution, summarizeExecution, runExecutionSmoke, localGenerator } from '../scripts/fusion-execution-smoke.mjs';

test('fresh corpus references match independent edge expectations and prompts omit grading data', () => {
  const tasks = executionTasks(), byId = Object.fromEntries(tasks.map(task => [task.id, task]));
  assert.equal(new Set(tasks.map(task => task.id)).size, 8);
  assert.deepEqual(byId['rotate-right'].reference([1, 2, 3], -1), [2, 3, 1]);
  assert.equal(byId['csv-row'].reference(['a"b', 'x\ny']), '"a""b","x\ny"');
  assert.deepEqual(byId['run-length'].reference('😀😀x'), [['😀', 2], ['x', 1]]);
  assert.deepEqual(byId['merge-intervals'].reference([[5, 6], [1, 5], [2, 3]]), [[1, 6]]);
  assert.deepEqual(byId.transpose.reference([[], []]), []);
  assert.equal(byId['query-component'].reference("!'()*"), '%21%27%28%29%2A');
  assert.deepEqual(byId['word-counts'].reference(['__proto__', 'constructor', '__proto__']), [['__proto__', 2], ['constructor', 1]]);
  assert.deepEqual(byId['chunk-array'].reference([1, 2, 3], 2), [[1, 2], [3]]);
  for (const task of tasks) {
    const prompt = executionPrompt(task);
    assert.ok(prompt.includes(JSON.stringify(task.visible.slice(0, 2))));
    assert.ok(!prompt.includes(task.reference.toString()));
    assert.ok(!prompt.includes(task.mutant));
    for (const row of [...task.visible, ...task.hidden]) {
      const args = structuredClone(row.args);
      assert.deepEqual(task.reference(...args), row.expected);
      assert.deepEqual(args, row.args);
    }
  }
});

test('module parser rejects malformed and oversized payloads', () => {
  assert.equal(parseModule('{"code":"export default x=>x"}'), 'export default x=>x');
  for (const value of ['{}', 'null', '[]', '{"code":1}', '{"code":" "}', '{"code":"x","extra":1}', '```js']) assert.equal(parseModule(value), null);
  assert.equal(parseModule(JSON.stringify({ code: 'x'.repeat(16385) })), null);
});

test('policy selection uses public checks only, counts failed attempts, and compares equal-size pools', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }], models = ['tiny', 'small'];
  const record = (caseId, model, sample, publicPassed, hiddenPassed) => ({ caseId, model, sample, publicPassed, hiddenPassed, status: 'valid', inputTokens: 10, outputTokens: 20 });
  const rows = [record('a', 'tiny', 0, true, false), record('a', 'small', 0, true, true), record('a', 'small', 1, true, true),
    record('b', 'tiny', 0, false, false), record('b', 'small', 0, false, true), record('b', 'small', 1, true, true)];
  const [single, repeat, mixed] = summarizeExecution(tasks, rows, models);
  assert.equal(single.solved, 1); assert.equal(repeat.solved, 2); assert.equal(mixed.solved, 0);
  assert.equal(single.replayCalls, 2); assert.equal(repeat.replayCalls, 3); assert.equal(mixed.replayCalls, 3);
  assert.equal(mixed.falseAcceptance, 1); assert.equal(mixed.abstained, 1);
  assert.throws(() => summarizeExecution(tasks, rows.slice(1), models), /incomplete/);
  assert.throws(() => summarizeExecution(tasks, [...rows, rows[0]], models), /duplicate/);
  assert.throws(() => summarizeExecution(tasks, [{ ...rows[0], status: 'invalid' }, ...rows.slice(1)], models), /invalid/);
});

test('parent grader checks values rather than a child self-reported pass', async () => {
  let closed = 0, invocation = 0;
  const makeBox = output => async () => ({ exec: async () => (++invocation % 2 ? { code: 0 } : { code: 0, stdout: Buffer.from(output) }), close: async () => { closed++; } });
  const examples = [{ args: [2], expected: 4 }];
  assert.equal((await gradeCandidate('unused', 'not executed', examples, makeBox('{"passed":true}'))).passed, false);
  assert.equal((await gradeCandidate('unused', 'not executed', examples, makeBox('[{"value":4,"args":[2]}]'))).passed, true);
  assert.equal((await gradeCandidate('unused', 'not executed', examples, makeBox('[{"value":4,"args":[3]}]'))).passed, false);
  assert.equal(closed, 3);
});

test('transport failure checkpoints without persisting generated source or raw errors', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'fusion-execution-test-')), out = join(parent, 'run');
  const task = { id: 'sample', instruction: 'double', reference: x => x * 2, mutant: 'x=>x', visible: [{ args: [1], expected: 2 }], hidden: [{ args: [2], expected: 4 }] };
  let calls = 0, grades = 0;
  const generator = { pins: [{ model: 'tiny' }, { model: 'small' }], verifyPins: async () => {}, generate: async () => {
    calls++; throw Error('private raw provider error');
  } };
  try {
    await assert.rejects(runExecutionSmoke({ out, image: 'sha256:' + 'a'.repeat(64), sourceSha: 'b'.repeat(40), tasks: [task], generator,
      grade: async () => ({ passed: ++grades % 4 !== 0, outcome: 'test' }) }), /execution_smoke_incomplete/);
    const raw = await readFile(join(out, 'execution-smoke.json'), 'utf8'), state = JSON.parse(raw);
    assert.equal(calls, 1); assert.equal(state.complete, false); assert.equal(state.records.length, 0);
    assert.ok(!raw.includes('private raw')); assert.ok(!raw.includes('x=>x'));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('local generator refuses cloud identities and stops on a failed HTTP request', async () => {
  await assert.rejects(localGenerator(['x:cloud', 'y']), /two_local/);
  await assert.rejects(localGenerator(['x', 'y'], 'https://example.test'), /local_endpoint/);
  let calls = 0;
  await assert.rejects(localGenerator(['x', 'y'], undefined, async () => { calls++; return { ok: false }; }), /transport/);
  assert.equal(calls, 1);
});

test('Docker qualification distinguishes weak public passes from hidden failures and kills hanging code', { skip: !process.env.FUSION_EXECUTION_NODE_IMAGE, timeout: 120000 }, async () => {
  const image = await buildExecutionImage(process.env.FUSION_EXECUTION_NODE_IMAGE);
  assert.equal((await qualifyExecution(image)).length, 8);
  const examples = [{ args: [1], expected: 1 }];
  assert.equal((await gradeCandidate(image, 'export default x=>x;', examples)).passed, true);
  assert.equal((await gradeCandidate(image, 'export default ()=>{while(true){}};', examples)).outcome, 'timeout');
  assert.equal((await gradeCandidate(image, 'export default ()=>process.stdout.write(JSON.stringify({passed:true}));', examples)).passed, false);
});
