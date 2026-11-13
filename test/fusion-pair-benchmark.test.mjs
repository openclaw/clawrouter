import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from '../scripts/fusion-workloads.mjs';
import { models as roles } from '../scripts/fusion-benchmark-accounting.mjs';
import { pairDefaults, validatePair, pairModel, pairExecution, scopeStrategy, runPairBenchmark } from '../scripts/fusion-pair-benchmark.mjs';
import { analyzePairRun } from '../scripts/fusion-pair-analysis.mjs';
import { runProbeSelection } from '../scripts/fusion-probe-selection.mjs';

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
const grade = async () => ({ valid: true, passed: true, tests: 3, skipped: 0 });
const success = async (url, request) => url.includes('/v1/models/') ? Response.json({ id: url.split('/').at(-1) })
  : Response.json({ model: JSON.parse(request.body).model, service_tier: 'default', usage: { prompt_tokens: 20, completion_tokens: 30 },
    choices: [{ finish_reason: 'stop', message: { content: 'private completion sentinel' } }] });

for (const phase of ['agent', 'grade-failed', 'grade-passed', 'grade-missing-valid']) {
  test(`incomplete ${phase} stops the campaign before another paid arm`, async () => {
    const { root, options } = await fixture();
    let agents = 0, grades = 0;
    try {
      await assert.rejects(runPairBenchmark({ ...options, policy: 'edit-handoff', fetcher: success,
        agent: async (_task, _image, _strategy, id, _settings, invoke) => {
          agents++;
          await invoke(id, roles.strong, body, signal);
          if (phase === 'agent') throw new Error('incomplete_test_run');
          return repaired();
        },
        grade: async () => {
          grades++;
          return { ...(phase === 'grade-missing-valid' ? {} : { valid: false }),
            passed: phase !== 'grade-failed', tests: 3, skipped: 0 };
        },
      }), /pair_benchmark_incomplete/);
      const saved = JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8'));
      assert.equal(agents, 1);
      assert.equal(grades, Number(phase !== 'agent'));
      assert.equal(saved.complete, false);
      assert.equal(saved.failure, 'incomplete_test_run');
      assert.equal(saved.records.length, 1);
      assert.equal(saved.records[0].status, 'error');
      assert.equal(saved.records[0].errorCode, 'incomplete_test_run');
      assert.equal(saved.records[0].score, 0);
      assert.equal(saved.calls.length, 1);
      assert.ok(Number.isSafeInteger(saved.calls[0].costMicros));
      assert.ok(!JSON.stringify(saved).includes('sentinel'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const failure of ['none', 'agent', 'grade']) test(`execution timing excludes slow acceptance grading: ${failure}`, async t => {
  const { root, options } = await fixture();
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  try {
    const state = await runPairBenchmark({ ...options, policy: 'edit-handoff', includeControls: false,
      fetcher: success,
      agent: async () => {
        clock += 17;
        if (failure === 'agent') throw new Error('agent failed');
        return { ...repaired(), agentElapsedMs: 999, gradingElapsedMs: 999 };
      },
      grade: async () => {
        clock += 30000;
        if (failure === 'grade') throw new Error('grader failed');
        return grade();
      },
    });
    const [row] = state.records;
    assert.equal(row.agentElapsedMs, 17);
    assert.equal(row.gradingElapsedMs, failure === 'agent' ? null : 30000);
    assert.equal(row.elapsedMs, failure === 'agent' ? 17 : 30017);
    assert.equal(row.score, Number(failure === 'none'));
    assert.equal(row.status, failure === 'none' ? 'complete' : 'error');
    const saved = JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8')).records[0];
    assert.equal(saved.agentElapsedMs, row.agentElapsedMs);
    assert.equal(saved.gradingElapsedMs, row.gradingElapsedMs);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const armOffset of [0, 1, 2]) test(`pair arm offset ${armOffset} rotates actual execution and retains canonical strategy labels`, async () => {
  const { root, options } = await fixture();
  try {
    const order = ['cheap', 'strong', 'edit-handoff'];
    const expected = [...order.slice(armOffset), ...order.slice(0, armOffset)];
    const state = await runPairBenchmark({ ...options, policy: 'matched-handoff', armOffset,
      grade, fetcher: success,
      agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal); return repaired();
      },
    });
    assert.deepEqual(state.strategies, order);
    assert.deepEqual(state.records.map(row => row.strategy), expected);
    assert.deepEqual(state.calls.map(call => call.trialId.split(':')[1]), expected);
    assert.equal(state.armOffset, armOffset);
    const saved = JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8'));
    assert.equal(saved.armOffset, armOffset);
    assert.deepEqual(analyzePairRun(state).totals.map(row => row.solved), [1, 1, 1]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid arm offsets stop before provider preflight or output creation', async () => {
  const { root, options } = await fixture();
  let preflights = 0;
  try {
    for (const armOffset of [-1, 3, 1.5, null, '1', NaN, Infinity]) {
      await assert.rejects(runPairBenchmark({ ...options, armOffset,
        preflight: async () => { preflights++; },
      }), /invalid_arm_offset/);
    }
    await assert.rejects(runPairBenchmark({ ...options, policy: 'edit-handoff', includeControls: false, armOffset: 1 }), /invalid_arm_offset/);
    await assert.rejects(runPairBenchmark({ ...options, controlsOnly: true, armOffset: 2 }), /invalid_arm_offset/);
    assert.equal(preflights, 0);
    assert.ok(!(await readdir(root)).includes('result'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test('probe selection meters cheap proposals and author before a strong fallback', async () => {
  const { root, options } = await fixture();
  try {
    await assert.rejects(runPairBenchmark({ ...options, policy: 'probe-selection' }), /four_calls/);
    const state = await runPairBenchmark({ ...options, policy: 'probe-selection',
      config: { ...config, maxCalls: 4 }, grade, fetcher: success,
      agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal); return repaired();
      },
      probeAgent: async (_task, _image, id, settings, invoke, dependencies) => {
        assert.equal(settings.maxTurns, 4);
        assert.equal(typeof dependencies.agent, 'function');
        for (const role of [roles.cheap, roles.cheap, roles.cheap, roles.strong]) await invoke(id, role, body, signal);
        return { ...repaired(), probeSelection: { outcome: 'ambiguous', selectedCandidate: null } };
      },
    });
    assert.deepEqual(state.strategies, ['cheap', 'strong', 'probe-selection']);
    assert.deepEqual(state.calls.map(call => call.model), [config.cheap, config.strong,
      config.cheap, config.cheap, config.cheap, config.strong]);
    assert.equal(state.records[2].calls, 4);
    assert.equal(state.records[2].probeSelection.outcome, 'ambiguous');
    assert.ok(state.records.every(row => row.score === 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pair persists post-selection diagnostics after final grading without additional inference', async () => {
  const { root, options } = await fixture();
  let drafts = 0, requests = 0;
  const grades = [];
  try {
    const state = await runPairBenchmark({ ...options, policy: 'probe-selection',
      config: { ...config, maxCalls: 4 },
      fetcher: async (url, request) => {
        const response = await success(url, request);
        if (url.includes('/v1/models/')) return response;
        requests++;
        const data = await response.json();
        data.choices[0].message.content = JSON.stringify({ probe: 'private probe sentinel' });
        return Response.json(data);
      },
      agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal);
        return repaired();
      },
      probeAgent: (...args) => runProbeSelection(...args.slice(0, 5), {
        draft: async (_task, _image, _strategy, id, _settings, invoke, _engine, opts) => {
          await invoke(id, roles.cheap, body, opts.signal);
          return { ...repaired(), files: [{ path: 'worker/example.ts', content: `candidate ${++drafts}` }],
            outcome: 'draft_submitted', toolMs: 0 };
        },
        makeSandbox: async () => ({ files: [], close: async () => {} }),
        read: async () => [{ path: 'worker/example.ts', content: 'original' }],
        write: async (box, files) => { box.files = files; },
        intact: async () => true,
        runProbe: async box => ({ passed: box.files[0].content === 'candidate 2', assertionFailed: true }),
      }),
      grade: async (_task, _image, files) => {
        grades.push({ source: files[0].content, requests });
        return { valid: true, passed: files[0].content !== 'candidate 1', tests: 3, skipped: 0 };
      },
    });
    const row = state.records[2];
    assert.equal(row.score, 1);
    assert.equal(row.calls, 3);
    assert.equal(row.probeDiagnostics.referenceProbe, 'error'); // Fixture has no Git reference.
    assert.deepEqual(row.probeDiagnostics.candidates.map(candidate => candidate.accepted), [false, true]);
    assert.deepEqual(grades.slice(-3).map(item => item.source), ['candidate 2', 'candidate 1', 'candidate 2']);
    assert.ok(grades.slice(-3).every(item => item.requests === 5));
    const saved = JSON.parse(await readFile(join(options.out, 'pair.json')));
    assert.deepEqual(saved.records[2].probeDiagnostics, row.probeDiagnostics);
    for (const text of ['candidate 1', 'candidate 2', 'private probe sentinel']) {
      assert.ok(!JSON.stringify(saved).includes(text));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('sampling preserves fixed controls and routes every candidate phase to cheap', async () => {
  const { root, options } = await fixture();
  try {
    await assert.rejects(runPairBenchmark({ ...options, policy: 'draft-sampling', config: { ...config, maxCalls: 2 } }), /three_calls/);
    const state = await runPairBenchmark({ ...options, policy: 'draft-sampling', grade, fetcher: success,
      agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal);
        return repaired();
      },
      samplingAgent: async (_task, _image, id, settings, invoke) => {
        assert.equal(settings.maxTurns, 3);
        for (let i = 0; i < 3; i++) await invoke(id, roles.strong, body, signal);
        return { ...repaired(), draftSampling: { selectedCandidate: null } };
      },
    });
    assert.deepEqual(state.strategies, ['cheap', 'strong', 'draft-sampling']);
    assert.deepEqual(state.calls.map(call => call.model), [config.cheap, config.strong, config.cheap, config.cheap, config.cheap]);
    assert.equal(state.records[2].calls, 3);
    assert.equal(state.records[2].draftSampling.selectedCandidate, null);
    assert.equal(analyzePairRun(state).candidate, 'draft-sampling');
  } finally { await rm(root, { recursive: true, force: true }); }
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

for (const policy of ['edit-handoff', 'matched-handoff', 'completion-handoff']) for (const handoffEvidence of [false, true]) for (const handoffMaxTurns of policy === 'completion-handoff' ? [null] : [null, 1]) test(`${policy} keeps the same allowance and routes both handoff phases explicitly: evidence=${handoffEvidence}, cap=${handoffMaxTurns}`, async () => {
  const { root, options } = await fixture();
  try {
    const seen = [];
    const state = await runPairBenchmark({ ...options, policy, handoffEvidence, handoffMaxTurns, grade, fetcher: success,
      agent: async (_task, _image, strategy, id, settings, invoke, _engine, agentOptions) => {
        seen.push({ strategy, settings, agentOptions });
        await invoke(id, roles.strong, body, signal);
        if (strategy === 'handoff') await invoke(id, roles.critic, body, signal);
        return { ...repaired(), handoffUsed: strategy === 'handoff' };
      },
    });
    assert.deepEqual(state.calls.map(call => call.model), policy === 'matched-handoff'
      ? [config.cheap, config.strong, config.strong, config.strong, config.cheap]
      : [config.cheap, config.strong, config.strong, config.cheap]);
    assert.equal(seen[2].strategy, 'handoff');
    assert.equal(seen[2].settings.maxTurns, config.maxCalls);
    assert.deepEqual(seen[2].agentOptions, { preloadSource: true,
      ...(handoffEvidence ? { handoffEvidence: true } : {}),
      ...(policy === 'completion-handoff' ? { handoffOnFinish: true } : { handoffAfterEdit: true, ...(handoffMaxTurns === null ? {} : { handoffMaxTurns }) }) });
    assert.deepEqual(seen[0].agentOptions, { preloadSource: true });
    assert.deepEqual(seen[1].agentOptions, { preloadSource: true, ...(policy === 'matched-handoff' ? { handoffAfterEdit: true, ...(handoffMaxTurns === null ? {} : { handoffMaxTurns }),
      ...(handoffEvidence ? { handoffEvidence: true } : {}) } : {}) });
    assert.equal(seen[1].strategy, policy === 'matched-handoff' ? 'handoff' : 'strong');
    assert.equal(seen[1].settings.maxTurns, config.maxCalls);
    assert.equal(state.records[1].handoffUsed, policy === 'matched-handoff');
    assert.equal(state.policy, policy);
    assert.equal(state.handoffEvidence, handoffEvidence);
    assert.equal(state.handoffMaxTurns, handoffMaxTurns);
    assert.equal(state.records[2].handoffUsed, true);
    assert.equal(analyzePairRun(state).candidateModelUse.mixedAttempts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('handoff evidence rejects unrelated policies and invalid options before provider access', async () => {
  for (const options of [{ policy: 'architect', handoffEvidence: true },
    { policy: 'matched-handoff', controlsOnly: true, handoffEvidence: true },
    { policy: 'edit-handoff', handoffEvidence: 'true' }]) {
    await assert.rejects(runPairBenchmark({ sourceSha: 'e'.repeat(40), ...options }), /invalid_handoff_evidence/);
  }
});

test('forged error traces never enter pair receipts', async () => {
  const { root, options } = await fixture();
  try {
    const error = new Error('private-error-message');
    error.failureTrace = { messages: ['private-prompt'], files: ['private-source'] };
    const state = await runPairBenchmark({ ...options, grade, fetcher: success, agent: async () => { throw error; } });
    assert(state.records.every(row => row.status === 'error' && row.score === 0 && !Object.hasOwn(row, 'failureTrace')));
    assert.doesNotMatch(await readFile(join(options.out, 'pair.json'), 'utf8'), /private-/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an uncertain native call retains prior actions without resuming or accepting the trial', {
  skip: !process.env.FUSION_PROVIDED_QUALIFICATION,
}, async () => {
  const { runAgent } = await import('../scripts/fusion-agent-benchmark.mjs');
  const { loadTasks } = await import('../scripts/fusion-workloads.mjs');
  const { root, options } = await fixture();
  try {
    const task = (await loadTasks('benchmarks/fusion/provided-reproducer-workloads.json'))
      .find(task => task.id === 'provided-responses-path');
    await writeFile(options.taskManifest, JSON.stringify({ version: 1, tasks: [task] }));
    await writeFile(options.qualificationPath, await readFile(process.env.FUSION_PROVIDED_QUALIFICATION));
    let posts = 0, grades = 0;
    await assert.rejects(runPairBenchmark({ ...options, agent: runAgent, grade: async () => { grades++; },
      fetcher: async (url, request) => {
        if (url.includes('/v1/models/')) return success(url, request);
        if (posts++ > 0) throw new Error('private-transport-error');
        return Response.json({ model: JSON.parse(request.body).model, service_tier: 'default',
          usage: { prompt_tokens: 20, completion_tokens: 30 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            action: 'read', paths: task.editPaths, query: '', edits: [], memory: 'private-working-notes',
          }) } }] });
      },
    }), /pair_benchmark_incomplete/);
    const state = JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8'));
    assert.equal(posts, 2);
    assert.equal(grades, 0);
    assert.equal(state.complete, false);
    assert.equal(state.failure, 'unknown_cost');
    assert.equal(state.records.length, 1);
    const row = state.records[0];
    assert.equal(row.status, 'error');
    assert.equal(row.score, 0);
    assert.deepEqual(row.failureTrace.actions, [{ turn: 1, action: 'read', status: 'ok' }]);
    assert.equal(row.failureTrace.turns, 1);
    assert.equal(row.calls, 2);
    assert.equal(state.calls[1].costMicros, null);
    assert.equal(row.costMicros, state.calls[0].costMicros + state.calls[1].reservationMicros);
    assert.equal(state.spentOrReservedMicros, config.priorCostMicros + row.costMicros);
    assert.doesNotMatch(JSON.stringify(state), /private-working-notes|private-transport-error/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fixed-controls selection rejects ambiguous or invalid options before provider access', async () => {
  for (const controlsOnly of ['true', null, 1]) {
    await assert.rejects(runPairBenchmark({ sourceSha: 'e'.repeat(40), controlsOnly }), /invalid_control_selection/);
  }
  await assert.rejects(runPairBenchmark({ sourceSha: 'e'.repeat(40), controlsOnly: true,
    includeControls: false, policy: 'contract-provided' }), /invalid_control_selection/);
  await assert.rejects(runPairBenchmark({ sourceSha: 'e'.repeat(40),
    includeControls: false, policy: 'matched-handoff' }), /invalid_control_selection/);
});

for (const accepted of [true, false]) test(`handoff-only runs one budgeted policy and retains acceptance=${accepted}`, async () => {
  const { root, options } = await fixture();
  try {
    let executions = 0, verifications = 0;
    const state = await runPairBenchmark({ ...options, policy: 'edit-handoff', includeControls: false,
      config: { ...config, campaignBudgetMicros: config.priorCostMicros + config.trialBudgetMicros },
      fetcher: success,
      agent: async (_task, _image, strategy, id, settings, invoke, _engine, agentOptions) => {
        executions++;
        assert.equal(strategy, 'handoff');
        assert.equal(settings.maxTurns, config.maxCalls);
        assert.deepEqual(agentOptions, { preloadSource: true, handoffAfterEdit: true });
        await invoke(id, roles.strong, body, signal);
        await invoke(id, roles.critic, body, signal);
        return { ...repaired(), handoffUsed: true };
      },
      grade: async (_task, _image, files) => {
        verifications++;
        assert.deepEqual(files, repaired().files);
        return { valid: true, passed: accepted, tests: 3, skipped: 0 };
      },
    });
    assert.equal(executions, 1);
    assert.equal(verifications, 1);
    assert.equal(state.complete, true);
    assert.equal(state.kind, 'native-policy-repository');
    assert.deepEqual(state.strategies, ['edit-handoff']);
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].score, Number(accepted));
    assert.deepEqual(state.calls.map(call => call.model), [config.strong, config.cheap]);
    assert.equal(state.spentOrReservedMicros, config.priorCostMicros + state.records[0].costMicros);
    assert(state.limitations.some(message => message.includes('No fixed-model controls ran')));
    assert.throws(() => analyzePairRun(state), /incomplete_pair_run/);
    const saved = await readFile(join(options.out, 'pair.json'), 'utf8');
    assert.deepEqual(JSON.parse(saved), state);
    assert(!saved.includes('private prompt sentinel'));
    assert(!saved.includes('private generated source sentinel'));
    assert.deepEqual((await readdir(options.out)).sort(), ['pair.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repair export requires explicit handoff-only execution before provider access', async () => {
  for (const exportRepairs of ['true', null, 1]) {
    await assert.rejects(runPairBenchmark({ sourceSha: 'e'.repeat(40), exportRepairs }), /invalid_repair_export/);
  }
  for (const settings of [{ policy: 'edit-handoff' }, { policy: 'contract', includeControls: false }]) {
    await assert.rejects(runPairBenchmark({ sourceSha: 'e'.repeat(40), ...settings, exportRepairs: true }), /invalid_repair_export/);
  }
});

for (const accepted of [true, false]) test(`repair export retains source only when acceptance=${accepted}`, async () => {
  const { root, options } = await fixture();
  try {
    const state = await runPairBenchmark({ ...options, policy: 'edit-handoff', includeControls: false,
      exportRepairs: true, fetcher: success,
      agent: async () => repaired(), grade: async () => ({ valid: true, passed: accepted, tests: 3, skipped: 0 }),
    });
    assert.equal(state.exportRepairs, true);
    assert.equal(state.records[0].score, Number(accepted));
    assert(!JSON.stringify(state).includes('private generated source sentinel'));
    if (!accepted) {
      assert.deepEqual(await readdir(options.out), ['pair.json']);
      assert.equal(state.records[0].repairExport, undefined);
      return;
    }
    const receipt = state.records[0].repairExport;
    assert.equal(receipt.file, 'pair-example.repair.json');
    const path = join(options.out, receipt.file), raw = await readFile(path, 'utf8'), bundle = JSON.parse(raw);
    assert.equal(receipt.sha256, hash(raw));
    assert.equal(receipt.bytes, Buffer.byteLength(raw));
    assert.deepEqual(bundle, { version: 1, kind: 'accepted-repository-repair', taskId: 'pair-example',
      base: 'a'.repeat(40), sourceSha: options.sourceSha,
      taskDigest: state.receipts[0].taskDigest, qualificationDigest: state.qualificationDigest,
      filesDigest: hash(JSON.stringify(repaired().files)), files: repaired().files });
    assert.deepEqual((await readdir(options.out)).sort(), ['pair-example.repair.json', 'pair.json']);
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(options.out)).mode & 0o777, 0o700);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repair export failure stops the run without overwriting an existing file or hiding acceptance', async () => {
  const { root, options } = await fixture();
  try {
    await assert.rejects(runPairBenchmark({ ...options, policy: 'edit-handoff', includeControls: false,
      exportRepairs: true, fetcher: success, grade,
      agent: async () => {
        await writeFile(join(options.out, 'pair-example.repair.json'), 'existing file');
        return repaired();
      },
    }), /pair_benchmark_incomplete/);
    const saved = JSON.parse(await readFile(join(options.out, 'pair.json')));
    assert.equal(saved.complete, false);
    assert.equal(saved.failure, 'repair_export_failed');
    assert.equal(saved.records[0].score, 1);
    assert.equal(saved.records[0].status, 'complete');
    assert.equal(saved.records[0].repairExportFailed, true);
    assert.equal(saved.records[0].repairExport, undefined);
    assert.equal(await readFile(join(options.out, 'pair-example.repair.json'), 'utf8'), 'existing file');
    assert.deepEqual((await readdir(options.out)).sort(), ['pair-example.repair.json', 'pair.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [name, files] of [['empty', []], ['unsafe', [{ path: '../escape.ts', content: 'bad path' }]],
  ['oversized', [{ path: 'worker/example.ts', content: 'x'.repeat(256 * 1024 + 1) }]]]) {
  test(`repair export rejects ${name} generated files`, async () => {
    const { root, options } = await fixture();
    try {
      await assert.rejects(runPairBenchmark({ ...options, policy: 'edit-handoff', includeControls: false,
        exportRepairs: true, fetcher: success, grade, agent: async () => ({ ...repaired(), files }),
      }), /pair_benchmark_incomplete/);
      const saved = JSON.parse(await readFile(join(options.out, 'pair.json')));
      assert.equal(saved.failure, 'repair_export_failed');
      assert.deepEqual(await readdir(options.out), ['pair.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const [name, count, size] of [['file count', 33, 1], ['bundle bytes', 32, 140 * 1024]]) {
  test(`repair export bounds ${name} across individually allowed files`, async () => {
    const { root, options } = await fixture();
    try {
      const manifest = JSON.parse(await readFile(options.taskManifest));
      const files = Array.from({ length: count }, (_, i) => ({ path: `worker/file-${i}.ts`, content: 'x'.repeat(size) }));
      manifest.tasks[0].editPaths = files.map(file => file.path);
      await writeFile(options.taskManifest, JSON.stringify(manifest));
      const qualification = JSON.parse(await readFile(options.qualificationPath));
      qualification.receipts[0].taskDigest = hash(JSON.stringify(manifest.tasks[0]));
      await writeFile(options.qualificationPath, JSON.stringify(qualification));
      await assert.rejects(runPairBenchmark({ ...options, policy: 'edit-handoff', includeControls: false,
        exportRepairs: true, fetcher: success, grade, agent: async () => ({ ...repaired(), files }),
      }), /pair_benchmark_incomplete/);
      const saved = JSON.parse(await readFile(join(options.out, 'pair.json')));
      assert.equal(saved.failure, 'repair_export_failed');
      assert.deepEqual(await readdir(options.out), ['pair.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('handoff-only keeps an unknown charge reserved and stops before its successor', async () => {
  const { root, options } = await fixture();
  try {
    let dispatches = 0;
    await assert.rejects(runPairBenchmark({ ...options, policy: 'edit-handoff', includeControls: false, exportRepairs: true,
      fetcher: async (url, request) => {
        if (url.includes('/v1/models/')) return success(url, request);
        dispatches++;
        throw new Error('transport failed');
      }, grade,
      agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal);
        assert.fail('unknown charge must stop execution');
      },
    }), /pair_benchmark_incomplete/);
    const saved = JSON.parse(await readFile(join(options.out, 'pair.json')));
    assert.equal(dispatches, 1);
    assert.equal(saved.complete, false);
    assert.equal(saved.failure, 'unknown_cost');
    assert.equal(saved.calls.length, 1);
    assert.equal(saved.calls[0].costMicros, null);
    assert(saved.calls[0].reservationMicros > 0);
    assert.equal(saved.spentOrReservedMicros, config.priorCostMicros + saved.calls[0].reservationMicros);
    assert.deepEqual(await readdir(options.out), ['pair.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test('saved paired calls retain disjoint usage buckets used for native pricing', async () => {
  const { root, options } = await fixture();
  try {
    await runPairBenchmark({ ...options, grade,
      fetcher: async (url, request) => {
        if (url.includes('/v1/models/')) return success(url, request);
        return Response.json({ model: JSON.parse(request.body).model,
          usage: { prompt_tokens: 20, completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 } },
          choices: [{ finish_reason: 'stop', message: { content: 'private completion sentinel' } }] });
      },
      agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal); return repaired();
      },
    });
    const saved = JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8'));
    for (const call of saved.calls) {
      assert.deepEqual(call.usageBreakdown, { uncachedInputTokens: 5, cacheReadInputTokens: 10,
        cacheWriteInputTokens: 5, cacheWrite1hInputTokens: 0, outputTokens: 30 });
      const price = saved.pins[call.model].usagePrice;
      assert.equal(call.costMicros, Math.ceil((5 * Math.round(price.input * 1e9)
        + 10 * Math.round(price.cached * 1e9) + 5 * Math.round(price.write * 1e9)
        + 30 * Math.round(price.output * 1e9)) / 1000));
    }
    assert.equal(saved.spentOrReservedMicros, config.priorCostMicros + saved.calls.reduce((sum, call) => sum + call.costMicros, 0));
    assert.ok(!JSON.stringify(saved).includes('sentinel'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const failure of ['http', 'transport']) test(`${failure} failures retain request fingerprints before dispatch and stop once`, async () => {
  const { root, options } = await fixture();
  const input = { ...body, messages: [{ role: 'user', content: 'private prompt sentinel λ' }] };
  try {
    let dispatched = 0, checkpoint, serializedBody;
    await assert.rejects(runPairBenchmark({ ...options, grade,
      fetcher: async (url, request) => {
        if (url.includes('/v1/models/')) return success(url, request);
        dispatched++;
        checkpoint = JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8'));
        serializedBody = request.body;
        if (failure === 'transport') throw new Error('synthetic transport failure');
        return Response.json({ error: { type: 'rate_limit_error', message: 'private prompt sentinel' } }, { status: 429 });
      }, agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, input, signal); return repaired();
      } }), /pair_benchmark_incomplete/);
    const state = JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8'));
    assert.equal(checkpoint.calls[0].requestDigest, hash(serializedBody));
    assert.equal(checkpoint.calls[0].requestBytes, Buffer.byteLength(serializedBody));
    assert.notEqual(checkpoint.calls[0].requestBytes, serializedBody.length);
    assert.equal(checkpoint.calls[0].promptDigest, hash(JSON.stringify(input.messages)));
    assert.equal(state.calls[0].requestDigest, checkpoint.calls[0].requestDigest);
    assert.equal(dispatched, 1); assert.equal(state.complete, false); assert.equal(state.failure, 'unknown_cost');
    assert.equal(state.records[0].errorCode, 'unknown_cost');
    assert.equal(state.calls[0].costMicros, null);
    assert.match(state.calls[0].requestDigest, /^[a-f0-9]{64}$/);
    assert.equal(state.calls[0].promptDigest, hash(JSON.stringify(input.messages)));
    assert.equal(state.spentOrReservedMicros, config.priorCostMicros + state.calls[0].reservationMicros);
    assert.ok(!JSON.stringify(state).includes('sentinel'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('qualified acceptance counts and call limits cannot be bypassed', async () => {
  const { root, options } = await fixture();
  try {
    const state = await runPairBenchmark({ ...options, fetcher: success,
      grade: async () => ({ valid: true, passed: true, tests: 2, skipped: 0 }),
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


test('regression gates apply to all paired arms and unverified repairs score zero', async () => {
  const { root, options } = await fixture();
  try {
    const seen = [];
    const state = await runPairBenchmark({ ...options, policy: 'matched-handoff', probeRegressionGate: true, grade, fetcher: success,
      agent: async (_task, _image, _strategy, id, _settings, invoke, _engine, agentOptions) => {
        seen.push(agentOptions.probeRegressionGate);
        await invoke(id, roles.strong, body, signal);
        return { ...repaired(), probeRegressionPassed: seen.length === 1 };
      } });
    assert.deepEqual(seen, [true, true, true]);
    assert.deepEqual(state.records.map(row => row.score), [1, 0, 0]);
    assert.equal(analyzePairRun(state).probeRegressionGate, true);
  } finally { await rm(root, { recursive: true, force: true }); }
  for (const options of [{ policy: 'probe-selection', probeRegressionGate: true },
    { policy: 'matched-handoff', executor: 'single-draft', probeRegressionGate: true },
    { probeRegressionGate: 'true' }]) {
    await assert.rejects(runPairBenchmark({ sourceSha: 'e'.repeat(40), ...options }), /invalid_pair_executor|invalid_probe_regression_gate/);
  }
});


test('a supplied-guard manifest cannot start an ungated paid run', async () => {
  const { root, options } = await fixture();
  try {
    const manifest = JSON.parse(await readFile(options.taskManifest));
    manifest.tasks[0].preservationProbes = ['assert(true)'];
    await writeFile(options.taskManifest, JSON.stringify(manifest));
    let calls = 0;
    await assert.rejects(runPairBenchmark({ ...options, fetcher: async () => { calls++; } }), /preservation_requires_regression_gate/);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('handoff turn limits reject invalid policies and allowances before provider access', async () => {
  for (const options of [{ policy: 'architect', handoffMaxTurns: 1 },
    { policy: 'completion-handoff', handoffMaxTurns: 1 },
    { policy: 'edit-handoff', controlsOnly: true, handoffMaxTurns: 1 },
    ...[0, -1, 1.5, '1', NaN, 3].map(handoffMaxTurns => ({ policy: 'edit-handoff', handoffMaxTurns }))]) {
    await assert.rejects(runPairBenchmark({ sourceSha: 'e'.repeat(40), config, ...options }), /invalid_handoff_turn_limit/);
  }
});

test('probe-qualified handoff requires a regression-gated handoff policy before provider access', async () => {
  for (const extra of [{}, { policy: 'completion-handoff', probeRegressionGate: true },
    { policy: 'edit-handoff' }, { policy: 'edit-handoff', probeRegressionGate: true, controlsOnly: true },
    { policy: 'matched-handoff', probeRegressionGate: true, handoffProbeGate: 'true' }]) {
    await assert.rejects(runPairBenchmark({ sourceSha: 'e'.repeat(40), config,
      handoffProbeGate: true, ...extra }), /invalid_handoff_probe_gate/);
  }
});

for (const policy of ['edit-handoff', 'matched-handoff']) test(`probe-qualified handoff reaches only handoff workers: ${policy}`, async () => {
  const { root, options } = await fixture();
  try {
    const seen = [];
    const state = await runPairBenchmark({ ...options, policy, handoffProbeGate: true, probeRegressionGate: true,
      grade, fetcher: success, agent: async (_task, _image, strategy, id, _settings, invoke, _engine, agentOptions) => {
        seen.push({ strategy, agentOptions });
        await invoke(id, roles.strong, body, signal);
        return { ...repaired(), probeRegressionPassed: true };
      } });
    assert.equal(state.handoffProbeGate, true);
    assert.deepEqual(seen.map(row => row.agentOptions.handoffProbeGate),
      [undefined, policy === 'matched-handoff' ? true : undefined, true]);
    assert.equal(analyzePairRun(state).handoffProbeGate, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});


for (const failure of ['none', 'http', 'json', 'transport']) test(`native correlation survives ${failure} and is saved before dispatch`, async () => {
  const { root, options } = await fixture();
  const ids = [];
  let paidCalls = 0;
  try {
    const running = runPairBenchmark({ ...options, policy: 'edit-handoff', includeControls: false, grade,
      fetcher: async (url, request) => {
        if (url.includes('/v1/models/')) return success(url, request);
        paidCalls++;
        const saved = JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8'));
        const attempt = saved.calls.at(-1);
        const id = request.headers['X-Client-Request-Id'];
        assert.equal(attempt.clientRequestId, id);
        assert.equal(attempt.costMicros, null);
        assert.ok(attempt.reservationMicros > 0);
        assert.ok(!ids.includes(id));
        ids.push(id);
        if (failure === 'transport') throw new Error('private transport sentinel');
        const headers = { 'x-request-id': 'req_test-123', 'x-private': 'private header sentinel' };
        if (failure === 'http') return Response.json({ error: { type: 'invalid_request_error', message: 'private error sentinel' } }, { status: 400, headers });
        if (failure === 'json') return new Response('private invalid json sentinel', { headers });
        const response = await success(url, request);
        response.headers.set('x-request-id', headers['x-request-id']);
        return response;
      },
      agent: async (_task, _image, _strategy, id, _settings, invoke) => {
        await invoke(id, roles.strong, body, signal);
        await invoke(id, roles.cheap, body, signal);
        return repaired();
      },
    });
    if (failure === 'none') await running;
    else await assert.rejects(running, /pair_benchmark_incomplete/);
    const saved = JSON.parse(await readFile(join(options.out, 'pair.json'), 'utf8'));
    assert.equal(saved.failure, failure === 'none' ? undefined : 'unknown_cost');
    assert.equal(paidCalls, failure === 'none' ? 2 : 1);
    assert.equal(saved.complete, failure === 'none');
    for (const call of saved.calls) {
      assert.match(call.clientRequestId, /^[0-9a-f-]{36}$/);
      assert.equal(call.providerRequestId, failure === 'transport' ? undefined : 'req_test-123');
      if (failure === 'none') assert.ok(Number.isSafeInteger(call.costMicros));
      else assert.equal(call.costMicros, null);
    }
    assert.ok(!JSON.stringify(saved).includes('sentinel'));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('source paging reaches every matched arm and rejects unsupported modes before dispatch', async () => {
  const { root, options } = await fixture();
  try {
    let called = false;
    for (const value of [0, -1, 401, 1.5, '200', false]) {
      await assert.rejects(runPairBenchmark({ ...options, sourcePageLines: value, fetcher: async () => { called = true; } }), /invalid_source_page_lines/);
    }
    await assert.rejects(runPairBenchmark({ ...options, sourcePageLines: 200, policy: 'scope', fetcher: async () => { called = true; } }), /unsupported_source_paging/);
    await assert.rejects(runPairBenchmark({ ...options, sourcePageLines: 200, policy: 'architect', fetcher: async () => { called = true; } }), /unsupported_source_paging/);
    assert.equal(called, false);
    const seen = [];
    const state = await runPairBenchmark({ ...options, policy: 'matched-handoff', sourcePageLines: 200, grade, fetcher: success,
      agent: async (_task, _image, _strategy, _id, _settings, _invoke, _engine, agentOptions) => {
        seen.push(agentOptions.sourcePageLines); return repaired();
      } });
    assert.deepEqual(seen, [200, 200, 200]);
    assert.equal(state.sourcePageLines, 200);
  } finally { await rm(root, { recursive: true, force: true }); }
});
