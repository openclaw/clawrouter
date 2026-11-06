import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../scripts/fusion-workloads.mjs';
import { models as roles } from '../scripts/fusion-benchmark-accounting.mjs';
import { localRoutes, localActionRequest, validateLocalQualification, runLocalRepository, groundedSampling } from '../scripts/fusion-local-repository.mjs';

const pins = [{ model: 'general-local', digest: 'a'.repeat(64) }, { model: 'coder-local', digest: 'b'.repeat(64) }];
const body = { max_tokens: 1536, messages: [{ role: 'user', content: 'private prompt sentinel' }],
  response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } } };
const response = (model, content = 'private response sentinel', extra = {}) => ({ ok: true, json: async () => ({ model,
  done: true, done_reason: 'stop', prompt_eval_count: 17, eval_count: 9, message: { content }, ...extra }) });

test('fixed baselines and handoff resolve only to the pinned local models', () => {
  assert.equal(localRoutes('general', pins)[roles.strong], pins[0].model);
  assert.equal(localRoutes('coder', pins)[roles.strong], pins[1].model);
  assert.equal(localRoutes('handoff', pins)[roles.strong], pins[1].model);
  assert.equal(localRoutes('handoff', pins)[roles.critic], pins[0].model);
  assert.throws(() => localRoutes('panel', pins), /invalid_local_strategy/);
});

test('adapter sends the same action schema through loopback with fixed limits', async () => {
  let sent;
  const result = await localActionRequest({ endpoint: 'http://127.0.0.1:11435', model: pins[0].model, pin: pins[0], body,
    signal: new AbortController().signal, seed: 42000,
    fetcher: async (url, options) => { sent = { url, options, body: JSON.parse(options.body) }; return response(pins[0].model); } });
  assert.equal(sent.url, 'http://127.0.0.1:11435/api/chat');
  assert.equal(sent.options.redirect, 'error');
  assert.deepEqual(sent.body.format, body.response_format.json_schema.schema);
  assert.equal(sent.body.options.num_ctx, 32768); assert.equal(sent.body.options.num_predict, 1536);
  assert.equal(result.result.choices[0].message.content, 'private response sentinel');
  assert.equal(result.outputTokens, 9);
  assert.equal(sent.body.options.temperature, 0);
});

test('grounded sampling is explicit and does not change legacy requests', async () => {
  let options;
  await localActionRequest({ endpoint: 'http://127.0.0.1:11435', model: pins[0].model, pin: pins[0], body,
    signal: new AbortController().signal, seed: 4, profile: 'grounded',
    fetcher: async (_url, request) => { options = JSON.parse(request.body).options; return response(pins[0].model); } });
  for (const [key, value] of Object.entries(groundedSampling)) assert.equal(options[key], value);
  assert.equal(options.seed, 4); assert.equal(options.num_predict, 1536);
});

test('context overflow is rejected before fetch and identity/usage errors stop the route', async () => {
  const options = { endpoint: 'http://127.0.0.1:11435', model: pins[0].model, pin: pins[0], body, signal: new AbortController().signal, seed: 1 };
  let calls = 0;
  await assert.rejects(localActionRequest({ ...options, body: { ...body, messages: [{ role: 'user', content: 'x'.repeat(32768) }] },
    fetcher: async () => { calls++; } }), /provider_context_limit/);
  assert.equal(calls, 0);
  await assert.rejects(localActionRequest({ ...options, fetcher: async () => response('wrong-model') }), /invalid_local_response/);
  await assert.rejects(localActionRequest({ ...options, fetcher: async () => response(pins[0].model, 'x', { eval_count: -1 }) }), /invalid_local_response/);
  await assert.rejects(localActionRequest({ ...options, endpoint: 'https://example.test' }), /local_endpoint/);
});

test('qualification requires matching task digests, passing oracle and failing baseline', () => {
  const task = { id: 'example' }, receipt = { taskId: task.id, taskDigest: hash(JSON.stringify(task)), image: 'sha256:' + 'a'.repeat(64),
    qualified: true, visible: { passed: true }, oracle: { valid: true, passed: true, tests: 3, skipped: 0 }, broken: { valid: true, passed: false } };
  const q = { nodeImage: 'node@sha256:' + 'b'.repeat(64), receipts: [receipt] };
  assert.equal(validateLocalQualification([task], q).length, 1);
  for (const change of [{ qualified: 'true' }, { taskDigest: 'wrong' }, { broken: { valid: true, passed: true } },
    { oracle: { passed: false } }, { oracle: { valid: true, passed: true, tests: 0, skipped: 0 } },
    { oracle: { valid: true, passed: true, tests: 3, skipped: -1 } }]) {
    assert.throws(() => validateLocalQualification([task], { ...q, receipts: [{ ...receipt, ...change }] }), /unqualified_local_task/);
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'local-repository-test-'));
  const task = { id: 'test-task', split: 'development', base: 'a'.repeat(40), oracle: 'b'.repeat(40),
    editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'], hiddenTests: ['worker/test/example.test.mjs'], instruction: 'Fix the example.' };
  await mkdir(join(root, 'benchmarks/fusion'), { recursive: true });
  await writeFile(join(root, 'benchmarks/fusion/validation-workloads.json'), JSON.stringify({ version: 1, tasks: [task] }));
  const qualificationPath = join(root, 'qualification.json');
  await writeFile(qualificationPath, JSON.stringify({ nodeImage: 'node@sha256:' + 'c'.repeat(64), receipts: [{ taskId: task.id,
    taskDigest: hash(JSON.stringify(task)), image: 'sha256:' + 'd'.repeat(64), qualified: true,
    visible: { passed: true }, oracle: { valid: true, passed: true, tests: 3, skipped: 0 }, broken: { valid: true, passed: false } }] }));
  return { root, options: { repo: root, qualificationPath, out: join(root, 'result'), sourceSha: 'e'.repeat(40),
    models: pins.map(row => row.model), inspectImage: async () => {}, preflight: async () => ({ pins, verifyPins: async () => {} }) } };
}

test('complete campaign attributes real models and retains no generated source or messages', async () => {
  const { root, options } = await fixture();
  try {
    const actualModels = [];
    const result = await runLocalRepository({ ...options,
      fetcher: async (_url, request) => { const model = JSON.parse(request.body).model; actualModels.push(model); return response(model); },
      agent: async (_task, _image, strategy, trialId, config, invoke) => {
        assert.equal(config.maxTurns, 8);
        await invoke(trialId, roles.strong, body, new AbortController().signal);
        if (strategy === 'handoff') await invoke(trialId, roles.critic, body, new AbortController().signal);
        return { files: [{ path: 'worker/example.ts', content: 'private generated source sentinel' }], patchDigest: 'f'.repeat(64), outcome: 'submitted', actions: [], handoffUsed: strategy === 'handoff' };
      }, grade: async () => ({ valid: true, passed: true, tests: 3, skipped: 0, digest: 'a'.repeat(64) }) });
    assert.deepEqual(actualModels, ['general-local', 'coder-local', 'coder-local', 'general-local']);
    assert.equal(result.complete, true); assert.equal(result.records.length, 3); assert.equal(result.calls.length, 4);
    assert.equal(result.apiSpendMicros, 0);
    const raw = await readFile(join(options.out, 'local-repository.json'), 'utf8');
    for (const sentinel of ['private prompt sentinel', 'private response sentinel', 'private generated source sentinel']) assert.ok(!raw.includes(sentinel));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('passing grades require the qualified test and skipped counts', async () => {
  const { root, options } = await fixture(); let calls = 0;
  try {
    const result = await runLocalRepository({ ...options,
      agent: async () => ({ files: [], outcome: 'submitted' }),
      grade: async () => ({ valid: true, passed: true, ...[
        { tests: 3, skipped: 0 }, { tests: 2, skipped: 0 }, { tests: 3, skipped: 1 },
      ][calls++] }) });
    assert.deepEqual(result.records.map(row => row.score), [1, 0, 0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('transport failure checkpoints once and does not silently try another model', async () => {
  const { root, options } = await fixture(); let calls = 0;
  try {
    await assert.rejects(runLocalRepository({ ...options, fetcher: async () => { calls++; return { ok: false }; },
      agent: async (_t, _i, _s, id, _c, invoke) => invoke(id, roles.strong, body, new AbortController().signal) }), /local_repository_incomplete/);
    const state = JSON.parse(await readFile(join(options.out, 'local-repository.json'), 'utf8'));
    assert.equal(calls, 1); assert.equal(state.complete, false); assert.equal(state.failureCode, 'local_transport_failed');
    assert.equal(state.records.length, 0); assert.equal(state.calls[0].status, 'failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('context-limited trials are recorded without pretending that a request was dispatched', async () => {
  const { root, options } = await fixture(); let dispatched = 0;
  try {
    const result = await runLocalRepository({ ...options, fetcher: async () => { dispatched++; },
      agent: async (_t, _i, _s, id, _c, invoke) => invoke(id, roles.strong,
        { ...body, messages: [{ role: 'user', content: 'x'.repeat(32768) }] }, new AbortController().signal) });
    assert.equal(dispatched, 0); assert.equal(result.complete, true);
    assert.ok(result.records.every(row => row.outcome === 'context_limit' && row.calls === 0 && !row.usageIncomplete));
    assert.ok(result.calls.every(row => !row.dispatched && row.inputTokens === 0));
  } finally { await rm(root, { recursive: true, force: true }); }
});
