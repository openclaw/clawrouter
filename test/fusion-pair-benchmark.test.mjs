import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from '../scripts/fusion-workloads.mjs';
import { models as roles } from '../scripts/fusion-benchmark-accounting.mjs';
import { pairDefaults, validatePair, pairModel, pairExecution, scopeStrategy, runPairBenchmark } from '../scripts/fusion-pair-benchmark.mjs';
import { analyzePairRun } from '../scripts/fusion-pair-analysis.mjs';

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
  for (const count of [0, 4, 1.5, '2']) assert.throws(() => validatePair(config, 1, count), /campaign_budget/);
});

test('fixed controls receive identical supplied context without invoking or budgeting a candidate', async () => {
  const { root, options } = await fixture();
  try {
    const manifest = JSON.parse(await readFile(options.taskManifest));
    manifest.tasks[0].reproducer = "throw new Error('known regression');";
    await writeFile(options.taskManifest, JSON.stringify(manifest));
    const qualification = JSON.parse(await readFile(options.qualificationPath));
    qualification.receipts[0].taskDigest = hash(JSON.stringify(manifest.tasks[0]));
    qualification.receipts[0].reproduction = { assertionFailed: true };
    qualification.receipts[0].oracleReproduction = { passed: true };
    await writeFile(options.qualificationPath, JSON.stringify(qualification));
    const seen = [];
    const state = await runPairBenchmark({ ...options, controlsOnly: true, policy: 'contract-provided',
      config: { ...config, maxCalls: 2, campaignBudgetMicros: config.priorCostMicros + 2 * config.trialBudgetMicros },
      grade, fetcher: success,
      contractAgent: async () => { assert.fail('candidate must not run'); },
      agent: async (task, _image, _strategy, id, settings, invoke, _unused, agentOptions) => {
        seen.push({ instruction: task.instruction, settings, preloadSource: agentOptions.preloadSource });
        await invoke(id, roles.strong, body, signal);
        return repaired();
      },
    });
    assert.deepEqual(seen[0], seen[1]);
    assert.match(seen[0].instruction, /known regression/);
    assert.equal(seen[0].settings.maxTurns, 2);
    assert.equal(seen[0].preloadSource, true);
    assert.equal(state.kind, 'native-controls-repository');
    assert.equal(state.controlsOnly, true);
    assert.deepEqual(state.strategies, ['cheap', 'strong']);
    assert.deepEqual(state.calls.map(call => call.model), [config.cheap, config.strong]);
    assert.equal(state.spentOrReservedMicros, config.priorCostMicros + state.calls.reduce((sum, call) => sum + call.costMicros, 0));
    assert.equal(JSON.parse(await readFile(join(options.out, 'pair.json'))).kind, state.kind);
    assert.throws(() => analyzePairRun(state), /incomplete_pair_run/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fixed-controls selection rejects ambiguous or invalid options before provider access', async () => {
  for (const controlsOnly of ['true', null, 1]) {
    await assert.rejects(runPairBenchmark({ sourceSha: 'e'.repeat(40), controlsOnly }), /invalid_control_selection/);
  }
  await assert.rejects(runPairBenchmark({ sourceSha: 'e'.repeat(40), controlsOnly: true,
    includeControls: false, policy: 'contract-provided' }), /invalid_control_selection/);
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
    assert.equal(state.records[0].errorCode, 'unknown_cost');
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
    assert.ok(state.calls.every(call => call.finishReason === 'length' && call.responseDisposition === 'truncated'));
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


test('scope policy selects from declared edit paths before any inference', async () => {
  const { root, options } = await fixture();
  try {
    assert.equal(scopeStrategy({ editPaths: ['worker/a.ts'] }), 'cheap');
    assert.equal(scopeStrategy({ editPaths: ['worker/a.ts', 'worker/b.ts'] }), 'strong');
    await assert.rejects(runPairBenchmark({ ...options, policy: 'unknown' }), /invalid_pair_policy/);
    for (const count of [1, 2]) {
      const manifest = JSON.parse(await readFile(options.taskManifest, 'utf8'));
      if (count === 2) manifest.tasks[0].editPaths.push('worker/second.ts');
      await writeFile(options.taskManifest, JSON.stringify(manifest));
      const proof = JSON.parse(await readFile(options.qualificationPath, 'utf8'));
      proof.receipts[0].taskDigest = hash(JSON.stringify(manifest.tasks[0]));
      await writeFile(options.qualificationPath, JSON.stringify(proof));
      const seen = [];
      const state = await runPairBenchmark({ ...options, out: join(root, `scope-${count}`), policy: 'scope',
        grade, fetcher: success,
        agent: async (_task, _image, strategy, id, settings, invoke, _unused, agentOptions) => {
          seen.push({ strategy, turns: settings.maxTurns, preload: agentOptions.preloadSource });
          await invoke(id, roles.strong, body, signal); return repaired();
        } });
      assert.deepEqual(state.strategies, ['cheap', 'strong', 'scope']);
      assert.ok(seen.every(row => row.strategy === 'strong' && row.preload && row.turns === config.maxCalls));
      const routed = state.records.find(row => row.strategy === 'scope');
      assert.equal(routed.selectedStrategy, count === 1 ? 'cheap' : 'strong');
      assert.equal(routed.selectedModel, count === 1 ? config.cheap : config.strong);
      assert.equal(state.calls.at(-1).model, routed.selectedModel);
      assert.equal(routed.calls, 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('contract policy meters the test author and worker inside the same trial', async () => {
  const { root, options } = await fixture();
  try {
    await assert.rejects(runPairBenchmark({ ...options, policy: 'contract' }), /four_calls/);
    const state = await runPairBenchmark({ ...options, config: { ...config, maxCalls: 4 }, policy: 'contract',
      grade, fetcher: success,
      agent: async (_task, _image, _strategy, id, _settings, invoke, _engine, agentOptions) => {
        assert.equal(agentOptions.preloadSource, true);
        await invoke(id, roles.strong, body, signal); return repaired();
      },
      contractAgent: async (_task, _image, id, settings, invoke) => {
        assert.equal(settings.maxTurns, 4);
        await invoke(id, roles.strong, body, signal);
        await invoke(id, roles.cheap, body, signal);
        return { ...repaired(), contractQualified: true, contractPassed: true };
      } });
    assert.deepEqual(state.strategies, ['cheap', 'strong', 'contract']);
    assert.deepEqual(state.calls.map(call => call.model), [config.cheap, config.strong, config.strong, config.cheap]);
    assert.equal(state.records[2].calls, 2);
    assert.equal(state.records[2].contractQualified, true);
    assert.ok(state.records.every(row => row.score === 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('provided probes are equally visible to fixed controls and skip the test-author role', async () => {
  for (const policy of ['contract-provided', 'contract-draft', 'contract-refine', 'contract-provided-cheap', 'contract-provided-strong']) {
  const { root, options } = await fixture();
  try {
    await assert.rejects(runPairBenchmark({ ...options, config: { ...config, maxCalls: 4 }, policy }), /missing_reproducer/);
    const manifest = JSON.parse(await readFile(options.taskManifest));
    const task = manifest.tasks[0]; task.reproducer = 'provided probe sentinel';
    await writeFile(options.taskManifest, JSON.stringify(manifest));
    const qualification = JSON.parse(await readFile(options.qualificationPath));
    Object.assign(qualification.receipts[0], { taskDigest: hash(JSON.stringify(task)),
      reproduction: { assertionFailed: true }, oracleReproduction: { passed: true } });
    await writeFile(options.qualificationPath, JSON.stringify(qualification));
    const instructions = [];
    const state = await runPairBenchmark({ ...options, config: { ...config, maxCalls: 4 },
      policy, grade, fetcher: success,
      agent: async (task, _image, _strategy, id, _settings, invoke) => {
        instructions.push(task.instruction);
        await invoke(id, roles.strong, body, signal); return repaired();
      },
      contractAgent: async (_task, _image, id, _settings, invoke, agentOptions) => {
        assert.equal(agentOptions.providedProbe, task.reproducer);
        assert.equal(typeof agentOptions.cheapAgent, ['contract-draft', 'contract-refine'].includes(policy) ? 'function' : 'undefined');
        await invoke(id, roles.cheap, body, signal); return repaired();
      } });
    assert.equal(instructions.length, 2);
    assert.equal(instructions[0], instructions[1]);
    assert.match(instructions[0], /provided probe sentinel/);
    assert.deepEqual(state.calls.map(call => call.model), [config.cheap, config.strong, policy === 'contract-provided-strong' ? config.strong : config.cheap]);
  } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('private contract policy preserves fixed controls and mixed role accounting', async () => {
  const { root, options } = await fixture();
  try {
    const state = await runPairBenchmark({ ...options, config: { ...config, maxCalls: 4 },
      policy: 'contract-private', grade, fetcher: success,
      agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal); return repaired();
      },
      contractAgent: async (_task, _image, id, _settings, invoke, agentOptions) => {
        assert.equal(agentOptions.exposeProbe, false);
        await invoke(id, roles.strong, body, signal);
        await invoke(id, roles.cheap, body, signal);
        return repaired();
      } });
    assert.deepEqual(state.strategies, ['cheap', 'strong', 'contract-private']);
    assert.deepEqual(state.calls.map(call => call.model), [config.cheap, config.strong, config.strong, config.cheap]);
    assert.equal(state.records[2].calls, 2);
    assert.equal(state.spentOrReservedMicros,
      config.priorCostMicros + state.calls.reduce((sum, call) => sum + call.costMicros, 0));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the declared cheap allowance is validated, propagated and recorded', async () => {
  const { root, options } = await fixture();
  try {
    for (const cheapMaxCalls of [0, 60, 1.5, '20', NaN]) {
      await assert.rejects(runPairBenchmark({ ...options, cheapMaxCalls }), /invalid_cheap_call_allowance/);
    }
    const state = await runPairBenchmark({ ...options, config: { ...config, maxCalls: 40 },
      policy: 'contract', cheapMaxCalls: 20, grade, fetcher: success,
      agent: async () => repaired(),
      contractAgent: async (_task, _image, id, _settings, invoke, agentOptions) => {
        assert.equal(agentOptions.cheapMaxCalls, 20);
        await invoke(id, roles.cheap, body, signal);
        return repaired();
      } });
    assert.equal(state.cheapMaxCalls, 20);
    assert.equal(state.config.maxCalls, 40);
    assert.equal(JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8')).cheapMaxCalls, 20);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('contract ablations preserve the scaffold while routing every role to the declared model', async () => {
  const { root, options } = await fixture();
  try {
    for (const [policy, selected] of [['contract-cheap', config.cheap], ['contract-strong', config.strong]]) {
      await assert.rejects(runPairBenchmark({ ...options, policy }), /four_calls/);
      const state = await runPairBenchmark({ ...options, out: join(root, policy),
        config: { ...config, maxCalls: 4 }, policy, grade, fetcher: success,
        agent: async (_task, _image, _strategy, id, _settings, invoke) => {
          await invoke(id, roles.strong, body, signal); return repaired();
        },
        contractAgent: async (_task, _image, id, settings, invoke) => {
          assert.equal(settings.maxTurns, 4);
          for (const role of [roles.strong, roles.cheap, roles.strong, roles.cheap]) {
            await invoke(id, role, body, signal);
          }
          await assert.rejects(invoke(id, roles.strong, body, signal), /trial_budget/);
          return { ...repaired(), contractQualified: true, contractPassed: true };
        } });
      assert.equal(state.policy, policy);
      assert.deepEqual(state.strategies, ['cheap', 'strong', policy]);
      assert.deepEqual(state.calls.map(call => call.model), [config.cheap, config.strong, ...Array(4).fill(selected)]);
      assert.equal(state.records[2].calls, 4);
      assert.equal(state.spentOrReservedMicros,
        config.priorCostMicros + state.calls.reduce((sum, call) => sum + call.costMicros, 0));
      assert.ok(state.records.every(row => row.score === 1));
      const saved = JSON.parse(await readFile(join(root, policy, 'pair.json'), 'utf8'));
      assert.equal(saved.policy, policy);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('a policy-only ablation never calls baseline workers or claims a paired report', async () => {
  const { root, options } = await fixture();
  try {
    for (const includeControls of ['false', null, 0]) {
      await assert.rejects(runPairBenchmark({ ...options, includeControls }), /invalid_control_selection/);
    }
    await assert.rejects(runPairBenchmark({ ...options, includeControls: false }), /invalid_control_selection/);
    const state = await runPairBenchmark({ ...options, config: { ...config, maxCalls: 4 },
      policy: 'contract-strong', includeControls: false, grade, fetcher: success,
      agent: async () => { assert.fail('baseline worker must not run'); },
      contractAgent: async (_task, _image, id, _settings, invoke) => {
        await invoke(id, roles.cheap, body, signal);
        await invoke(id, roles.strong, body, signal);
        return repaired();
      } });
    assert.equal(state.kind, 'native-policy-repository');
    assert.equal(state.includeControls, false);
    assert.deepEqual(state.strategies, ['contract-strong']);
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].score, 1);
    assert.deepEqual(state.calls.map(call => call.model), [config.strong, config.strong]);
    assert.equal(state.spentOrReservedMicros, config.priorCostMicros + state.records[0].costMicros);
    assert.equal(JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8')).kind, 'native-policy-repository');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('single-draft executor is explicit, restricted to supplied checks, and persisted', async () => {
  const { root, options } = await fixture();
  try {
    for (const executor of ['unknown', null, 3]) await assert.rejects(runPairBenchmark({ ...options, executor }), /invalid_pair_executor/);
    await assert.rejects(runPairBenchmark({ ...options, executor: 'single-draft' }), /invalid_pair_executor/);
    const manifest = JSON.parse(await readFile(options.taskManifest));
    manifest.tasks[0].reproducer = 'supplied reproducer';
    await writeFile(options.taskManifest, JSON.stringify(manifest));
    const qualification = JSON.parse(await readFile(options.qualificationPath));
    qualification.receipts[0].taskDigest = hash(JSON.stringify(manifest.tasks[0]));
    qualification.receipts[0].reproduction = { assertionFailed: true };
    qualification.receipts[0].oracleReproduction = { passed: true };
    await writeFile(options.qualificationPath, JSON.stringify(qualification));
    const state = await runPairBenchmark({ ...options, config: { ...config, maxCalls: 4 },
      executor: 'single-draft', policy: 'contract-provided', grade, fetcher: success,
      agent: async (_task, _image, _strategy, id, _settings, invoke) => { await invoke(id, roles.strong, body, signal); return repaired(); },
      contractAgent: async (_task, _image, id, _settings, invoke) => { await invoke(id, roles.cheap, body, signal); return repaired(); },
    });
    assert.equal(state.executor, 'single-draft');
    assert.equal(JSON.parse(await readFile(join(options.out, 'pair.json'))).executor, 'single-draft');
    assert.equal(pairModel('contract-provided-strong', roles.cheap, config), config.strong);
    assert.equal(pairModel('contract-provided-cheap', roles.strong, config), config.cheap);
  } finally { await rm(root, { recursive: true, force: true }); }
});
