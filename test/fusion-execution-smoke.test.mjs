import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

test('a mixed policy cannot hide a stronger first-model control', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }], models = ['first', 'second'];
  const rows = tasks.flatMap(({ id }, index) => [
    { caseId: id, model: 'first', sample: 0, publicPassed: true, hiddenPassed: true },
    ...[0, 1].map(sample => ({ caseId: id, model: 'second', sample, publicPassed: index === 0, hiddenPassed: index === 0 })),
  ]).map(row => ({ ...row, status: 'valid', inputTokens: 10, outputTokens: 20 }));
  const policies = summarizeExecution(tasks, rows, models);
  const first = policies.find(row => row.policy === 'tiny-single');
  const second = policies.find(row => row.policy === 'small-single');
  const mixed = policies.find(row => row.policy === 'tiny-small-verified');
  assert.equal(first.solved, 2); assert.equal(second.solved, 1); assert.equal(mixed.solved, first.solved);
  assert.equal(first.replayCalls, 2); assert.equal(first.replayTokens, 60); assert.equal(first.selectionChecks, 0);
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

test('candidate output overflow fails that candidate, closes its container, and does not hide infrastructure errors', async () => {
  for (const reason of ['command_output_limit', 'command_timeout']) {
    let calls = 0, closed = 0;
    const makeBox = async () => ({ exec: async () => { if (++calls > 1) throw Error(reason); }, close: async () => { closed++; } });
    if (reason === 'command_output_limit') assert.deepEqual(await gradeCandidate('unused', 'unused', [], makeBox), { passed: false, outcome: 'output_limit' });
    else await assert.rejects(gradeCandidate('unused', 'unused', [], makeBox), /command_timeout/);
    assert.equal(closed, 1);
  }
});

test('local generator refuses cloud identities and stops on a failed HTTP request', async () => {
  await assert.rejects(localGenerator(['x:cloud', 'y']), /two_local/);
  await assert.rejects(localGenerator(['x', 'y'], 'https://example.test'), /local_endpoint/);
  let calls = 0;
  await assert.rejects(localGenerator(['x', 'y'], undefined, async () => { calls++; return { ok: false }; }), /transport/);
  assert.equal(calls, 1);
});

function localRuntimeFixture(info = {}) {
  const state = { version: '0.40.11', info: { template: '{{ .Prompt }}', capabilities: [], ...info },
    models: ['tiny', 'small'].map(name => ({ name, digest: 'a'.repeat(64), size: 10 })), chats: 0 };
  const fetcher = async url => {
    if (url.endsWith('/api/version')) return Response.json({ version: state.version });
    if (url.endsWith('/api/tags')) return Response.json({ models: state.models });
    if (url.endsWith('/api/show')) return Response.json(state.info);
    state.chats++; throw Error('unexpected_inference');
  };
  return { state, fetcher };
}

test('local pins capture named and legacy renderers without retaining template or default parameter text', async () => {
  for (const fields of [{}, { parameters: '' }, { renderer: 'qwen3-coder', parser: 'qwen3-coder', template_source: 'renderer_parser', parameters: 'presence_penalty 1.5\n' }]) {
    const { state, fetcher } = localRuntimeFixture(fields);
    const generator = await localGenerator(['tiny', 'small'], undefined, fetcher);
    assert.deepEqual(generator.pins[0].runtime, { serverVersion: '0.40.11', renderer: fields.renderer ?? null,
      parser: fields.parser ?? null, templateSource: fields.template_source ?? null,
      templateSha256: createHash('sha256').update(state.info.template).digest('hex'),
      parametersSha256: fields.parameters === undefined ? null : createHash('sha256').update(fields.parameters).digest('hex') });
    assert.ok(!JSON.stringify(generator.pins).includes(state.info.template));
    if (fields.parameters) assert.ok(!JSON.stringify(generator.pins).includes(fields.parameters.trim()));
    await generator.verifyPins();
    assert.equal(state.chats, 0);
  }
});

test('unchanged weights cannot hide server, renderer, template, default parameter or thinking drift', async () => {
  for (const mutate of [
    state => { state.version = '0.40.12'; },
    state => { state.info.renderer = 'other'; },
    state => { state.info.parser = 'other'; },
    state => { state.info.template_source = 'other'; },
    state => { state.info.template = '{{ .System }}{{ .Prompt }}'; },
    state => { state.info.parameters = 'presence_penalty 1.5'; },
    state => { state.info.capabilities = ['thinking']; },
  ]) {
    const { state, fetcher } = localRuntimeFixture();
    const generator = await localGenerator(['tiny', 'small'], undefined, fetcher);
    mutate(state);
    await assert.rejects(generator.verifyPins(), /^Error: local_runtime_changed$/);
    assert.equal(state.chats, 0);
  }
});

test('default parameter removal and value changes invalidate local pins', async () => {
  for (const parameters of [undefined, '', 'presence_penalty 0']) {
    const { state, fetcher } = localRuntimeFixture({ parameters: 'presence_penalty 1.5' });
    const generator = await localGenerator(['tiny', 'small'], undefined, fetcher);
    state.info.parameters = parameters;
    await assert.rejects(generator.verifyPins(), /^Error: local_runtime_changed$/);
    assert.equal(state.chats, 0);
  }
});

test('invalid runtime metadata fails before inference without echoing source', async () => {
  for (const mutate of [
    state => { state.version = null; },
    state => { state.version = 'private version with spaces'; },
    state => { delete state.info.template; },
    state => { state.info.template = ''; },
    state => { state.info.template = 'x'.repeat(1024 * 1024 + 1); },
    state => { state.info.renderer = { private: 'metadata' }; },
    state => { state.info.parser = 'x'.repeat(129); },
    state => { state.info.template_source = 'private\nsource'; },
    state => { state.info.parameters = null; },
    state => { state.info.parameters = { private: 'metadata' }; },
    state => { state.info.parameters = 'x'.repeat(1024 * 1024 + 1); },
  ]) {
    const { state, fetcher } = localRuntimeFixture(); mutate(state);
    await assert.rejects(localGenerator(['tiny', 'small'], undefined, fetcher), /^Error: unqualified_local_runtime$/);
    assert.equal(state.chats, 0);
  }
});

test('final model validation rejects changed or ambiguous local identities', async () => {
  for (const mutate of [
    state => { state.models[0].digest = 'b'.repeat(64); },
    state => { state.models[0].size++; },
    state => { state.models[0].remote_host = 'example.test'; },
    state => { state.models.push({ ...state.models[0] }); },
  ]) {
    const { state, fetcher } = localRuntimeFixture();
    const generator = await localGenerator(['tiny', 'small'], undefined, fetcher); mutate(state);
    await assert.rejects(generator.verifyPins(), /^Error: model_changed$/);
  }
});

test('Docker qualification distinguishes weak public passes from hidden failures and kills hanging code', { skip: !process.env.FUSION_EXECUTION_NODE_IMAGE, timeout: 120000 }, async () => {
  const image = await buildExecutionImage(process.env.FUSION_EXECUTION_NODE_IMAGE);
  assert.equal((await qualifyExecution(image)).length, 8);
  const examples = [{ args: [1], expected: 1 }];
  assert.equal((await gradeCandidate(image, 'export default x=>x;', examples)).passed, true);
  assert.equal((await gradeCandidate(image, 'export default ()=>{while(true){}};', examples)).outcome, 'timeout');
  assert.equal((await gradeCandidate(image, 'export default ()=>process.stdout.write(JSON.stringify({passed:true}));', examples)).passed, false);
  assert.equal((await gradeCandidate(image, 'export default ()=>{process.stdout.write("x".repeat(300000));return 1;};', examples)).outcome, 'output_limit');
});
