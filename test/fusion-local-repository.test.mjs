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
    signal: new AbortController().signal, seed: 4, profile: 'checked',
    fetcher: async (_url, request) => { options = JSON.parse(request.body).options; return response(pins[0].model); } });
  for (const [key, value] of Object.entries(groundedSampling)) assert.equal(options[key], value);
  assert.equal(options.seed, 4); assert.equal(options.num_predict, 1536);
});

test('an explicit output allowance reaches generation without weakening response limits', async () => {
  const options = { endpoint: 'http://127.0.0.1:11435', model: pins[0].model, pin: pins[0],
    body: { ...body, max_tokens: 4096 }, signal: new AbortController().signal, seed: 1 };
  let calls = 0;
  const fetcher = async (_url, request) => {
    calls++;
    assert.equal(JSON.parse(request.body).options.num_predict, 4096);
    assert.equal(JSON.parse(request.body).options.num_ctx, 32768);
    return response(pins[0].model, 'complete', { eval_count: 2000 });
  };
  await assert.rejects(localActionRequest({ ...options, fetcher }), /invalid_local_action_request/);
  assert.equal(calls, 0);
  const result = await localActionRequest({ ...options, maxOutputTokens: 4096, fetcher });
  assert.equal(result.outputTokens, 2000);
  await assert.rejects(localActionRequest({ ...options, maxOutputTokens: 4096,
    fetcher: async () => response(pins[0].model, 'oversized', { eval_count: 4097 }) }), /invalid_local_response/);
});

test('invalid output allowances and oversized requests fail before dispatch', async () => {
  let dispatches = 0, calls = 0;
  const options = { endpoint: 'http://127.0.0.1:11435', model: pins[0].model, pin: pins[0], body,
    signal: new AbortController().signal, seed: 1, onDispatch: async () => { dispatches++; },
    fetcher: async () => { calls++; return response(pins[0].model); } };
  for (const maxOutputTokens of [0, -1, 1.5, NaN, Infinity, 8193, '4096', null]) {
    await assert.rejects(localActionRequest({ ...options, maxOutputTokens }), /invalid_local_output_tokens/);
  }
  await assert.rejects(localActionRequest({ ...options, maxOutputTokens: 4096,
    body: { ...body, max_tokens: 4097 } }), /invalid_local_action_request/);
  await assert.rejects(localActionRequest({ ...options, maxOutputTokens: 4096,
    body: { ...body, max_tokens: 4096, messages: [{ role: 'user', content: 'x'.repeat(27000) }] } }), /provider_context_limit/);
  assert.equal(dispatches, 0);
  assert.equal(calls, 0);
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

test('a provided reproducer requires both execution receipts before inference', () => {
  const task = { id: 'example', reproducer: 'assert(false)' };
  const receipt = { taskId: task.id, taskDigest: hash(JSON.stringify(task)), image: 'sha256:' + 'a'.repeat(64),
    qualified: true, visible: { passed: true }, oracleVisible: { valid: true, passed: true },
    oracle: { valid: true, passed: true, tests: 3, skipped: 0 }, broken: { valid: true, passed: false } };
  const q = { nodeImage: 'node@sha256:' + 'b'.repeat(64), receipts: [receipt] };
  assert.throws(() => validateLocalQualification([task], q), /unqualified_local_task/);
  receipt.reproduction = { assertionFailed: true };
  receipt.oracleReproduction = { passed: true };
  assert.equal(validateLocalQualification([task], q).length, 1);
});

test('qualification requires matching task digests, passing oracle and failing baseline', () => {
  const task = { id: 'example' }, receipt = { taskId: task.id, taskDigest: hash(JSON.stringify(task)), image: 'sha256:' + 'a'.repeat(64),
    qualified: true, visible: { passed: true }, oracleVisible: { valid: true, passed: true }, oracle: { valid: true, passed: true, tests: 3, skipped: 0 }, broken: { valid: true, passed: false } };
  const q = { nodeImage: 'node@sha256:' + 'b'.repeat(64), receipts: [receipt] };
  assert.equal(validateLocalQualification([task], q).length, 1);
  for (const change of [{ qualified: 'true' }, { oracleVisible: undefined }, { oracleVisible: { valid: true, passed: false } }, { taskDigest: 'wrong' }, { broken: { valid: true, passed: true } },
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
    visible: { passed: true }, oracleVisible: { valid: true, passed: true }, oracle: { valid: true, passed: true, tests: 3, skipped: 0 }, broken: { valid: true, passed: false } }] }));
  return { root, options: { repo: root, qualificationPath, out: join(root, 'result'), sourceSha: 'e'.repeat(40),
    models: pins.map(row => row.model), inspectImage: async () => {}, preflight: async () => ({ pins, verifyPins: async () => {} }) } };
}

test('campaigns record and enforce an explicit output allowance', async () => {
  const { root, options } = await fixture();
  try {
    const result = await runLocalRepository({ ...options, outputTokens: 4096,
      fetcher: async (_url, request) => {
        const sent = JSON.parse(request.body);
        assert.equal(sent.options.num_predict, 4096);
        return response(sent.model, 'complete', { eval_count: 2000 });
      },
      agent: async (_task, _image, _strategy, id, config, invoke) => {
        assert.equal(config.outputTokens, 4096);
        await invoke(id, roles.strong, { ...body, max_tokens: config.outputTokens }, new AbortController().signal);
        return { files: [], outcome: 'submitted' };
      }, grade: async () => ({ valid: true, passed: true, tests: 3, skipped: 0 }) });
    assert.equal(result.settings.outputTokens, 4096);
    assert.ok(result.calls.every(call => call.outputTokens === 2000));
    assert.equal(result.summary.reduce((sum, row) => sum + row.outputTokens, 0), 6000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid campaign output allowances fail before preflight or output creation', async () => {
  const { root, options } = await fixture();
  let preflights = 0;
  try {
    await assert.rejects(runLocalRepository({ ...options, outputTokens: 8193,
      preflight: async () => { preflights++; } }), /invalid_local_output_tokens/);
    assert.equal(preflights, 0);
    await assert.rejects(readFile(join(options.out, 'local-repository.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compact action profiles reach every arm and are recorded for replay', async () => {
  const { root, options } = await fixture();
  try {
    let arms = 0;
    const result = await runLocalRepository({ ...options, actionSchemaProfile: 'compact',
      agent: async (_task, _image, _strategy, _id, _config, _invoke, _engine, agentOptions) => {
        assert.equal(agentOptions.actionSchemaProfile, 'compact'); arms++;
        return { files: [], outcome: 'submitted', actions: [] };
      }, grade: async () => ({ valid: true, passed: true, tests: 3, skipped: 0 }) });
    assert.equal(arms, 3);
    assert.equal(result.settings.actionSchemaProfile, 'compact');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsupported action profiles stop before preflight or output creation', async () => {
  const { root, options } = await fixture();
  try {
    for (const [profile, actionSchemaProfile] of [['legacy', 'unknown'], ['checked', 'compact'], ['grounded', 'compact']]) {
      await assert.rejects(runLocalRepository({ ...options, profile, actionSchemaProfile,
        preflight: async () => assert.fail('must not preflight') }), /invalid_local_action_schema_profile/);
    }
    await assert.rejects(readFile(join(options.out, 'local-repository.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

for (const [profile, outcomes] of [
  ['legacy', ['turn_limit', 'verified', 'submitted']],
  ['grounded', ['deadline', undefined, 'submitted']],
  ['checked', ['turn_limit', 'submitted', 'verified']],
]) test(`${profile} scores only a completed submission even when every patch passes acceptance`, async () => {
  const { root, options } = await fixture(); let calls = 0;
  try {
    const result = await runLocalRepository({ ...options, profile,
      agent: async () => ({ files: [], outcome: outcomes[calls++], publicPassed: true,
        reproducerQualified: true, probePassed: true }),
      grade: async () => ({ valid: true, passed: true, tests: 3, skipped: 0 }) });
    assert.deepEqual(result.records.map(row => row.score), [0, 0, 1]);
    assert.deepEqual(result.records.map(row => row.outcome), outcomes);
    assert.ok(result.records.every(row => row.graderTests === 3));
    assert.equal(result.summary.reduce((sum, row) => sum + row.solved, 0), 1);
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

test('rejected local responses checkpoint a bounded reason without response content or another call', async () => {
  const cases = [
    ['unreadable_body', { json: async () => { throw new Error('private parse failure sentinel'); } }],
    ['invalid_envelope', { json: async () => null }],
    ['model_mismatch', response('private model sentinel')],
    ['incomplete', response(pins[0].model, undefined, { done: false })],
    ['missing_content', response(pins[0].model, undefined, { message: {} })],
    ['invalid_usage', response(pins[0].model, undefined, { eval_count: -1 })],
    ['output_limit', response(pins[0].model, undefined, { eval_count: 1537 })],
    ['context_limit', response(pins[0].model, undefined, { prompt_eval_count: 32768 })],
    ['invalid_stop_reason', response(pins[0].model, undefined, { done_reason: 'private stop sentinel' })],
  ];
  for (const [reason, invalid] of cases) {
    const { root, options } = await fixture(); let calls = 0;
    try {
      await assert.rejects(runLocalRepository({ ...options,
        fetcher: async () => { calls++; return { ok: true, ...invalid }; },
        agent: async (_t, _i, _s, id, _c, invoke) => invoke(id, roles.strong, body, new AbortController().signal),
        grade: async () => assert.fail('must not grade a rejected response'),
      }), /local_repository_incomplete/);
      const raw = await readFile(join(options.out, 'local-repository.json'), 'utf8'), state = JSON.parse(raw);
      assert.equal(state.failureCode, 'invalid_local_response', reason);
      assert.equal(state.calls[0].responseFailure, reason);
      assert.equal(state.calls[0].status, 'failed');
      assert.equal(state.calls[0].dispatched, true);
      assert.equal(state.calls[0].inputTokens, null);
      assert.equal(state.calls[0].outputTokens, null);
      assert.equal(state.records.length, 0); assert.equal(calls, 1);
      for (const sentinel of ['private prompt sentinel', 'private response sentinel', 'private model sentinel',
        'private parse failure sentinel', 'private stop sentinel']) assert.ok(!raw.includes(sentinel), reason);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
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


test('checked scoring requires both the public gate and hidden acceptance', async () => {
  const { root, options } = await fixture(); let calls = 0;
  try {
    const result = await runLocalRepository({ ...options, profile: 'checked',
      agent: async (_task, _image, _strategy, _id, config) => {
        assert.equal(config.requireReproducer, true);
        return { files: [], publicPassed: true, reproducerQualified: true,
          probePassed: calls++ === 0, outcome: 'verified' };
      }, grade: async () => ({ valid: true, passed: true, tests: 3, skipped: 0 }) });
    assert.deepEqual(result.records.map(row => row.score), [1, 0, 0]);
    assert.ok(result.records.every(row => row.graderPassed));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('supplied preservation checks require exact baseline and reference receipts before inference', () => {
  const task = { id: 'example', preservationProbes: ['assert(true)'] };
  const receipt = { taskId: task.id, taskDigest: hash(JSON.stringify(task)), image: 'sha256:' + 'a'.repeat(64),
    qualified: true, visible: { passed: true }, oracleVisible: { valid: true, passed: true },
    oracle: { valid: true, passed: true, tests: 3, skipped: 0 }, broken: { valid: true, passed: false } };
  const q = { nodeImage: 'node@sha256:' + 'b'.repeat(64), receipts: [receipt] };
  assert.throws(() => validateLocalQualification([task], q), /unqualified_local_task/);
  const result = { probeDigest: hash(task.preservationProbes[0]), passed: true, unchanged: true };
  receipt.preservation = { baseline: [{ ...result }], reference: [{ ...result }] };
  assert.equal(validateLocalQualification([task], q).length, 1);
  receipt.preservation.reference[0].probeDigest = 'stale';
  assert.throws(() => validateLocalQualification([task], q), /unqualified_local_task/);
});

test('request deadlines retain profile defaults and allow independent overrides', async t => {
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    deadlines.push(ms);
    return new AbortController().signal;
  });
  for (const [profile, requestTimeoutMs] of [['legacy', undefined], ['grounded', undefined], ['checked', undefined], ['legacy', 180000]]) {
    await localActionRequest({ endpoint: 'http://127.0.0.1:11435', model: pins[0].model, pin: pins[0], body,
      signal: new AbortController().signal, seed: 1, profile, requestTimeoutMs,
      fetcher: async (_url, request) => {
        assert.equal(JSON.parse(request.body).options.temperature, profile === 'legacy' ? 0 : groundedSampling.temperature);
        return response(pins[0].model);
      } });
  }
  assert.deepEqual(deadlines, [60000, 120000, 120000, 180000]);
});

test('invalid request deadlines fail before dispatch', async () => {
  let dispatches = 0;
  for (const requestTimeoutMs of [0, -1, 1.5, NaN, Infinity, 300001, '180000', null]) {
    await assert.rejects(localActionRequest({ endpoint: 'http://127.0.0.1:11435', model: pins[0].model, pin: pins[0], body,
      signal: new AbortController().signal, requestTimeoutMs,
      onDispatch: async () => { dispatches++; }, fetcher: async () => { throw new Error('unexpected_fetch'); } }), /invalid_local_request_timeout/);
  }
  assert.equal(dispatches, 0);
});

test('a longer request deadline still honors caller cancellation', async () => {
  const caller = new AbortController();
  await assert.rejects(localActionRequest({ endpoint: 'http://127.0.0.1:11435', model: pins[0].model, pin: pins[0], body,
    signal: caller.signal, requestTimeoutMs: 180000,
    fetcher: async (_url, request) => {
      caller.abort();
      assert.equal(request.signal.aborted, true);
      throw new Error('request_aborted');
    } }), /provider_local_deadline/);
});

test('campaigns record and use their explicit request deadline', async t => {
  const { root, options } = await fixture(), deadlines = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    deadlines.push(ms);
    return new AbortController().signal;
  });
  try {
    const result = await runLocalRepository({ ...options, requestTimeoutMs: 180000,
      fetcher: async (_url, request) => response(JSON.parse(request.body).model),
      agent: async (_task, _image, _strategy, id, _config, invoke) => {
        await invoke(id, roles.strong, body, new AbortController().signal);
        return { files: [], outcome: 'submitted' };
      }, grade: async () => ({ valid: true, passed: true, tests: 3, skipped: 0 }) });
    assert.equal(result.settings.requestTimeoutMs, 180000);
    assert.deepEqual(deadlines, [180000, 180000, 180000]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid campaign request deadlines fail before preflight or output creation', async () => {
  const { root, options } = await fixture();
  let preflights = 0;
  try {
    await assert.rejects(runLocalRepository({ ...options, requestTimeoutMs: 300001,
      preflight: async () => { preflights++; } }), /invalid_local_request_timeout/);
    assert.equal(preflights, 0);
    await assert.rejects(readFile(join(options.out, 'local-repository.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
