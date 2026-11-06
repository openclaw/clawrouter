import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from '../scripts/fusion-workloads.mjs';
import { models as roles } from '../scripts/fusion-benchmark-accounting.mjs';
import { pairDefaults, validatePair, pairModel, pairExecution, runPairBenchmark } from '../scripts/fusion-pair-benchmark.mjs';

const body = { messages: [{ role: 'user', content: 'private prompt sentinel' }], max_tokens: 256 };
const signal = new AbortController().signal;
const config = { ...pairDefaults, maxCalls: 3, outputTokens: 256, priorCostMicros: 100 };
const env = { OPENAI_API_KEY: 'synthetic-test-credential' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fusion-pair-test-'));
  const task = { id: 'pair-example', split: 'development', base: 'a'.repeat(40), oracle: 'b'.repeat(40),
    editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'], hiddenTests: ['worker/test/hidden.test.mjs'], instruction: 'Fix the example.' };
  const taskManifest = join(root, 'tasks.json'), qualificationPath = join(root, 'qualification.json');
  await writeFile(taskManifest, JSON.stringify({ version: 1, tasks: [task] }));
  await writeFile(qualificationPath, JSON.stringify({ nodeImage: 'node@sha256:' + 'c'.repeat(64), receipts: [{
    taskId: task.id, taskDigest: hash(JSON.stringify(task)), image: 'sha256:' + 'd'.repeat(64), qualified: true,
    visible: { passed: true }, oracleVisible: { valid: true, passed: true }, oracle: { valid: true, passed: true, tests: 3, skipped: 0 }, broken: { valid: true, passed: false },
  }] }));
  return { root, options: { repo: root, out: join(root, 'result'), taskManifest, qualificationPath, sourceSha: 'e'.repeat(40), config, env } };
}
const repaired = () => ({ files: [{ path: 'worker/example.ts', content: 'private generated source sentinel' }],
  actions: [], publicPassed: true, patchDigest: 'f'.repeat(64), outcome: 'submitted' });
const grade = async () => ({ passed: true, tests: 3, skipped: 0 });
const success = async (url, request) => url.includes('/v1/models/') ? Response.json({ id: url.split('/').at(-1) })
  : Response.json({ model: JSON.parse(request.body).model, service_tier: 'default', usage: { prompt_tokens: 20, completion_tokens: 30 },
    choices: [{ finish_reason: 'stop', message: { content: 'private completion sentinel' } }] });

test('architect spends one of the shared calls on the strong planner', () => {
  validatePair(config, 1);
  assert.equal(pairModel('architect', roles.cheap, config), config.strong);
  assert.equal(pairModel('architect', roles.critic, config), config.cheap);
  assert.equal(pairModel('cheap', roles.strong, config), config.cheap);
  assert.equal(pairExecution('architect', config).settings.maxTurns + 1, pairExecution('strong', config).settings.maxTurns);
  assert.throws(() => validatePair({ ...config, cheap: config.strong }, 1), /invalid_pair/);
  assert.throws(() => validatePair({ ...config, priorCostMicros: 99999999 }, 1), /campaign_budget/);
});

test('both controls and the pair account for real roles without persisting content', async () => {
  const { root, options } = await fixture();
  try {
    const seen = [];
    const state = await runPairBenchmark({ ...options, grade, fetcher: async (url, request) => {
      if (!url.includes('/v1/models/')) seen.push(JSON.parse(request.body));
      return success(url, request);
    }, agent: async (_task, _image, strategy, id, _settings, invoke) => {
      if (strategy === 'planned') await invoke(id, roles.cheap, body, signal);
      await invoke(id, strategy === 'planned' ? roles.critic : roles.strong, body, signal);
      return repaired();
    } });
    assert.equal(state.complete, true);
    assert.deepEqual(state.records.map(row => row.score), [1, 1, 1]);
    assert.deepEqual(state.calls.map(call => call.model), [config.cheap, config.strong, config.strong, config.cheap]);
    assert.equal(state.spentOrReservedMicros, config.priorCostMicros + state.calls.reduce((sum, call) => sum + call.costMicros, 0));
    assert.ok(seen.filter(call => call.model === 'gpt-6-luna').every(call => call.reasoning_effort === 'none'));
    const saved = await readFile(join(options.out, 'pair.json'), 'utf8');
    assert.ok(!saved.includes('sentinel')); assert.ok(!saved.includes(env.OPENAI_API_KEY));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown charges stop the campaign once and retain the reservation', async () => {
  const { root, options } = await fixture();
  try {
    let dispatched = 0;
    await assert.rejects(runPairBenchmark({ ...options, grade,
      fetcher: async (url, request) => {
        if (url.includes('/v1/models/')) return success(url, request);
        dispatched++;
        return Response.json({ error: { type: 'rate_limit_error', message: 'private prompt sentinel' } }, { status: 429 });
      }, agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal); return repaired();
      } }), /pair_benchmark_incomplete/);
    const state = JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8'));
    assert.equal(dispatched, 1); assert.equal(state.complete, false); assert.equal(state.failure, 'unknown_cost');
    assert.equal(state.calls[0].costMicros, null);
    assert.equal(state.spentOrReservedMicros, config.priorCostMicros + state.calls[0].reservationMicros);
    assert.ok(!JSON.stringify(state).includes('sentinel'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('qualified acceptance counts and call limits cannot be bypassed', async () => {
  const { root, options } = await fixture();
  try {
    const state = await runPairBenchmark({ ...options, fetcher: success,
      grade: async () => ({ passed: true, tests: 2, skipped: 0 }),
      agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        for (let i = 0; i < config.maxCalls; i++) await invoke(id, roles.strong, body, signal);
        await assert.rejects(invoke(id, roles.strong, body, signal), /trial_budget/);
        return repaired();
      } });
    assert.ok(state.records.every(row => row.score === 0 && row.calls === config.maxCalls));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider refusal settles known usage and stops before another model is called', async () => {
  const { root, options } = await fixture();
  try {
    let calls = 0;
    await assert.rejects(runPairBenchmark({ ...options, grade,
      fetcher: async (url, request) => {
        if (url.includes('/v1/models/')) return success(url, request);
        calls++;
        return Response.json({ model: JSON.parse(request.body).model, usage: { prompt_tokens: 20, completion_tokens: 1 },
          choices: [{ finish_reason: 'content_filter', message: { content: '' } }] });
      }, agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal); return repaired();
      } }), /pair_benchmark_incomplete/);
    const state = JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8'));
    assert.equal(calls, 1); assert.equal(state.complete, false);
    assert.equal(state.failure, 'provider_refused');
    assert.equal(typeof state.calls[0].costMicros, 'number');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('known-cost output truncation fails its trial without skipping the other controls', async () => {
  const { root, options } = await fixture();
  try {
    let calls = 0;
    const state = await runPairBenchmark({ ...options, grade,
      fetcher: async (url, request) => {
        if (url.includes('/v1/models/')) return success(url, request);
        calls++;
        return Response.json({ model: JSON.parse(request.body).model, usage: { prompt_tokens: 20, completion_tokens: 256 },
          choices: [{ finish_reason: 'length', message: { content: '{' } }] });
      }, agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal); return repaired();
      } });
    assert.equal(calls, 3); assert.equal(state.complete, true);
    assert.ok(state.records.every(row => row.status === 'error' && row.errorCode === 'provider_truncated' && row.score === 0));
    assert.ok(state.calls.every(call => typeof call.costMicros === 'number'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cheap reasoning calibration is explicit, recorded and validated before inference', async () => {
  const { root, options } = await fixture();
  try {
    let calls = 0;
    await assert.rejects(runPairBenchmark({ ...options, cheapReasoning: 'invalid', fetcher: async () => { calls++; } }), /invalid_cheap_reasoning/);
    assert.equal(calls, 0);
    const sent = [];
    const state = await runPairBenchmark({ ...options, cheapReasoning: 'medium', grade,
      fetcher: async (url, request) => {
        if (!url.includes('/v1/models/')) sent.push(JSON.parse(request.body));
        return success(url, request);
      }, agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal); return repaired();
      } });
    assert.equal(state.cheapReasoning, 'medium');
    assert.ok(sent.filter(request => request.model === 'gpt-6-luna').every(request => request.reasoning_effort === 'medium'));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('source preload applies equally to every comparison arm and rejects invalid configuration', async () => {
  const { root, options } = await fixture();
  try {
    let called = false;
    await assert.rejects(runPairBenchmark({ ...options, preloadSource: 'yes', fetcher: async () => { called = true; } }), /invalid_source_preload/);
    assert.equal(called, false);
    const seen = [];
    const state = await runPairBenchmark({ ...options, preloadSource: true, grade, fetcher: success,
      agent: async (_task, _image, strategy, _id, _settings, _invoke, _engine, agentOptions) => {
        seen.push([strategy, agentOptions.preloadSource]); return repaired();
      } });
    assert.deepEqual(seen, [['strong', true], ['strong', true], ['planned', true]]);
    assert.equal(state.preloadSource, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review policy keeps both controls and maps the cheap author and strong reviewer', async () => {
  const { root, options } = await fixture();
  try {
    await assert.rejects(runPairBenchmark({ ...options, policy: 'unknown' }), /invalid_pair_policy/);
    await assert.rejects(runPairBenchmark({ ...options, policy: 'review', config: { ...config, maxCalls: 2 } }), /review_requires_three_calls/);
    const state = await runPairBenchmark({ ...options, policy: 'review', grade,
      fetcher: async (url, request) => {
        if (url.includes('/v1/models/')) return success(url, request);
        const value = JSON.parse(request.body);
        if (value.response_format?.json_schema?.name !== 'repair_review') return success(url, request);
        return Response.json({ model: value.model, usage: { prompt_tokens: 20, completion_tokens: 30 },
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'accept', findings: '' }) } }] });
      }, agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal); return repaired();
      } });
    assert.deepEqual(state.strategies, ['cheap', 'strong', 'review']);
    assert.equal(state.preloadSource, true);
    assert.deepEqual(state.records.map(row => row.score), [1, 1, 1]);
    assert.deepEqual(state.calls.map(call => call.model), [config.cheap, config.strong, config.cheap, config.strong]);
    assert.equal(state.records[2].reviewAccepted, true);
    assert.equal(pairExecution('review', config).settings.maxTurns, config.maxCalls);
    assert.equal(pairModel('review', roles.cheap, config), config.cheap);
  } finally { await rm(root, { recursive: true, force: true }); }
});
