import assert from 'node:assert/strict';
import test from 'node:test';
import { SpendLedger, defaultExperiment, validateExperiment, replaceEdits, sourceView, escalateSubmission, toolErrorCode, finishReason, agentContext, executorModel, advisoryBody, actionFeedback, runAgent } from '../scripts/fusion-agent-benchmark.mjs';
import { nativeRequest } from '../scripts/fusion-native-provider.mjs';

test('tool feedback explains recovery without revealing final acceptance paths', () => {
  const task = { editPaths: ['worker/a.ts'], visibleTests: ['worker/test/a.test.mjs'], hiddenTests: ['worker/test/private.test.mjs'] };
  const navigation = actionFeedback('invalid_read_paths', 'search', task);
  assert.match(navigation, /leave paths empty/);
  assert.ok(navigation.includes(task.editPaths[0]));
  assert.ok(navigation.includes(task.visibleTests[0]));
  assert.ok(!navigation.includes(task.hiddenTests[0]));
  assert.match(actionFeedback('invalid_edits', 'edit', task), /1–8 edits/);
  assert.match(actionFeedback('search_must_match_once', 'edit', task), /current source/);
});

test('an invalid directory search recovers using a real file within the shared call budget', {
  skip: !process.env.FUSION_PROVIDED_QUALIFICATION,
}, async () => {
  const { readFile } = await import('node:fs/promises');
  const { loadTasks } = await import('../scripts/fusion-workloads.mjs');
  const task = (await loadTasks('benchmarks/fusion/provided-reproducer-workloads.json'))
    .find(task => task.id === 'provided-responses-path');
  const receipt = JSON.parse(await readFile(process.env.FUSION_PROVIDED_QUALIFICATION))
    .receipts.find(receipt => receipt.taskId === task.id);
  let calls = 0;
  const result = await runAgent(task, receipt.image, 'strong', 'navigation-fixture',
    { maxTurns: 3, deadlineMs: 120000, outputTokens: 256 }, async (_id, _role, body) => {
      const turn = calls++;
      if (turn === 0) assert.match(body.messages[0].content, /FILE paths only/);
      if (turn === 1) {
        assert.match(body.messages.at(-1).content, /leave paths empty/);
        assert.ok(body.messages.at(-1).content.includes(task.editPaths[0]));
      }
      if (turn === 2) assert.match(body.messages.at(-1).content, /matches/);
      const action = { action: turn === 2 ? 'finish' : 'search', paths: turn === 0 ? ['.'] : [],
        edits: [], query: turn === 2 ? '' : 'configuredEndpointPath', memory: '' };
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(action) } }] };
    });
  assert.equal(calls, 3);
  assert.deepEqual(result.actions.map(action => action.status), ['invalid_read_paths', 'ok', 'ok']);
  assert.equal(result.publicPassed, true);
});

test('every arm fits the predeclared campaign ceiling including previous uncertainty', () => {
  assert.equal(validateExperiment(defaultExperiment, 4), 3390914);
  assert.throws(() => validateExperiment({ ...defaultExperiment, trials: 3 }, 4), /campaign_budget/);
  assert.throws(() => validateExperiment({ ...defaultExperiment, priorCostMicros: -1 }, 4));
  assert.throws(() => validateExperiment({ ...defaultExperiment, strategies: ['strong', 'strong'] }, 4));
});

test('a charged truncated action is discarded before one bounded recovery in a real sandbox', {
  skip: !process.env.FUSION_PROVIDED_QUALIFICATION,
}, async () => {
  const { readFile } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const { loadTasks } = await import('../scripts/fusion-workloads.mjs');
  const task = (await loadTasks('benchmarks/fusion/provided-reproducer-workloads.json'))
    .find(task => task.id === 'provided-responses-path');
  const receipt = JSON.parse(await readFile(process.env.FUSION_PROVIDED_QUALIFICATION))
    .receipts.find(receipt => receipt.taskId === task.id);
  const original = execFileSync('git', ['show', `${task.base}:${task.editPaths[0]}`], { encoding: 'utf8' });
  const ledger = new SpendLedger({ trialBudgetMicros: 30, campaignBudgetMicros: 30, priorCostMicros: 0 }, async () => {});
  let calls = 0;
  const result = await runAgent(task, receipt.image, 'strong', 'truncated-fixture',
    { maxTurns: 2, deadlineMs: 120000, outputTokens: 256 }, async (id, role, body) => {
      const attempt = await ledger.reserve(id, role, 10);
      await ledger.settle(attempt, 7, 200);
      if (calls++ === 0) return { choices: [{ finish_reason: 'length', message: {
        content: JSON.stringify({ action: 'edit', paths: [], query: '', memory: 'partial-output-sentinel',
          edits: [{ path: task.editPaths[0], search: original, replace: 'partial-output-sentinel' }] }),
      } }] };
      assert.match(body.messages.at(-1).content, /discarded without applying edits/);
      assert.ok(!JSON.stringify(body.messages).includes('partial-output-sentinel'));
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        action: 'finish', paths: [], query: '', memory: '', edits: [],
      }) } }] };
    });
  assert.equal(calls, 2);
  assert.equal(ledger.total(), 14);
  assert.equal(result.truncationRetries, 1);
  assert.equal(result.files.find(file => file.path === task.editPaths[0]).content, original);
  assert.equal(result.publicPassed, true);
  assert.deepEqual(result.actions.map(action => action.action), ['truncated_output', 'finish']);
});

test('truncation recovery never exceeds its allowance or retries uncertain charges and refusals', {
  skip: !process.env.FUSION_PROVIDED_QUALIFICATION,
}, async () => {
  const { readFile } = await import('node:fs/promises');
  const { loadTasks } = await import('../scripts/fusion-workloads.mjs');
  const task = (await loadTasks('benchmarks/fusion/provided-reproducer-workloads.json'))
    .find(task => task.id === 'provided-responses-path');
  const receipt = JSON.parse(await readFile(process.env.FUSION_PROVIDED_QUALIFICATION))
    .receipts.find(receipt => receipt.taskId === task.id);
  for (const [maxTurns, error, expectedCalls] of [[1, 'provider_truncated', 1],
    [3, 'provider_truncated', 2], [3, 'unknown_cost', 1], [3, 'provider_refused', 1]]) {
    let calls = 0;
    await assert.rejects(runAgent(task, receipt.image, 'strong', 'bounded-truncation',
      { maxTurns, deadlineMs: 120000, outputTokens: 256 }, async () => {
        calls++; throw new Error(error);
      }), new RegExp(error));
    assert.equal(calls, expectedCalls);
  }
});

test('concurrent reservations cannot overspend; settled savings remain available to the same baseline', async () => {
  let persisted = 0;
  const ledger = new SpendLedger({ trialBudgetMicros: 100, campaignBudgetMicros: 130, priorCostMicros: 10 }, async () => { persisted++; });
  const first = ledger.reserve('a', 'model', 80);
  await assert.rejects(ledger.reserve('a', 'model', 30), /trial_budget/);
  await assert.rejects(ledger.reserve('b', 'model', 50), /campaign_budget/);
  await ledger.settle(await first, 10, 200);
  const second = await ledger.reserve('a', 'model', 90);
  assert.equal(ledger.total('a'), 100);
  await ledger.settle(second, 20, 200);
  assert.equal(ledger.total(), 30);
  assert.equal(persisted, 4);
});

test('unknown/underestimated charges block later calls without dropping the reserved cost', async () => {
  const ledger = new SpendLedger({ trialBudgetMicros: 100, campaignBudgetMicros: 200, priorCostMicros: 0 }, async () => {});
  const attempt = await ledger.reserve('a', 'model', 80);
  await assert.rejects(ledger.settle(attempt, NaN, 200), /unknown_cost/);
  assert.equal(ledger.total(), 80);
  await assert.rejects(ledger.reserve('b', 'model', 10), /unknown_cost/);
  const second = new SpendLedger({ trialBudgetMicros: 100, campaignBudgetMicros: 200, priorCostMicros: 0 }, async () => {});
  await assert.rejects(second.settle(await second.reserve('a', 'model', 80), 81, 200), /unknown_cost/);
  assert.equal(second.total(), 81);
});

test('targeted edits reject ambiguity and preserve untouched source', () => {
  const task = { editPaths: ['worker/example.ts'] }, files = [{ path: task.editPaths[0], content: 'before\nwrong\nafter\n' }];
  const edits = replaceEdits(task, files, [{ path: task.editPaths[0], search: 'wrong', replace: 'correct' }]);
  assert.equal(edits[0].content, 'before\ncorrect\nafter\n');
  assert.throws(() => replaceEdits(task, files, [{ path: task.editPaths[0], search: '\n', replace: '' }]), /match_once/);
  assert.throws(() => replaceEdits(task, files, [{ path: 'test/hidden.mjs', search: 'wrong', replace: '' }]), /invalid_edit/);
});

test('native JSON schema actions remain identical across providers', () => {
  const schema = { type: 'object', properties: { action: { type: 'string' } } };
  const body = { messages: [], max_tokens: 2048, response_format: { type: 'json_schema', json_schema: { name: 'action', strict: true, schema } } };
  assert.deepEqual(nativeRequest('anthropic/claude-sonnet-5.5', body, {}).body.output_config.format.schema, schema);
  assert.deepEqual(nativeRequest('openai/gpt-6.1-sol', body, {}).body.response_format.json_schema.schema, schema);
});


test('large-file source navigation preserves line locations and literal search', () => {
  const files = [{ path: 'scripts/compile.mjs', content: Array.from({length: 1200}, (_, i) => `line ${i + 1}`).join('\n') }];
  assert.match(sourceView(files, ['scripts/compile.mjs:1100-1110'])[0].content, /line 1100/);
  assert.equal(sourceView(files, ['scripts/compile.mjs'], 'line 1100')[0].matches[0].line, 1100);
  assert.equal(sourceView(files, ['scripts/compile.mjs:1-1000'])[0].truncated, true);
  assert.equal(sourceView(files, ['scripts/compile.mjs'])[0].content, files[0].content);
  assert.throws(() => sourceView(files, ['scripts/compile.mjs:0-1000']), /line_range/);
});

test('failed cheap submissions escalate; accepted or already-strong submissions can finish', () => {
  assert.equal(escalateSubmission('cascade', false, false), true);
  assert.equal(escalateSubmission('cascade', false, true), false);
  assert.equal(escalateSubmission('cascade', true, false), false);
  assert.equal(escalateSubmission('strong', false, false), false);
});


test('diagnostics retain bounded labels without raw error or response content', () => {
  assert.equal(toolErrorCode(new Error('search_must_match_once')), 'search_must_match_once');
  assert.equal(toolErrorCode(new Error('private path or generated source')), 'execution_failed');
  assert.equal(finishReason('length'), 'length');
  assert.equal(finishReason('private response'), 'other');
});


test('larger explicitly configured runs remain bounded by the authorized campaign ceiling', () => {
  const config = { ...defaultExperiment, outputTokens: 8192, maxTurns: 30, deadlineMs: 600000,
    campaignBudgetMicros: 100000000, priorCostMicros: 934028, trialBudgetMicros: 1000000 };
  assert.equal(validateExperiment(config, 4), 16934028);
  assert.throws(() => validateExperiment({ ...config, campaignBudgetMicros: 100000001 }, 4));
  assert.throws(() => validateExperiment({ ...config, priorCostMicros: 99000000 }, 4), /campaign_budget/);
});


test('working notes survive bounded context eviction without unbounded repeated source', () => {
  const fixed = [{ role: 'system', content: 'repair' }, { role: 'user', content: 'task' }];
  const context = agentContext([...fixed, {role:'user',content:'old source'.repeat(25000)},
    {role:'assistant',content:'old read'}, {role:'user',content:'new source'.repeat(25000)}], 'location and plan');
  assert.deepEqual(context.slice(0, 2), fixed);
  assert.match(context[2].content, /location and plan/);
  assert.equal(context.at(-1).content, 'new source'.repeat(25000));
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 384000);
  assert.equal(context.some(m => m.content.startsWith('old source')), false);
});


test('independent Claude baseline uses the same loop without changing cascade selection', () => {
  assert.equal(executorModel('claude', 0), 'anthropic/claude-sonnet-5.5');
  assert.equal(executorModel('strong', 0), 'openai/gpt-6.1-sol');
  assert.equal(executorModel('cascade', 0), 'openai/gpt-6-luna');
  assert.equal(executorModel('cascade', 0, true), 'openai/gpt-6.1-sol');
  assert.equal(executorModel('cascade', 2), 'openai/gpt-6.1-sol');
  assert.doesNotThrow(() => validateExperiment({...defaultExperiment, strategies:['claude']}, 4));
});


test('complementary arms retain the intended executor and separate adviser instructions', () => {
  assert.equal(executorModel('planned', 0), 'anthropic/claude-sonnet-5.5');
  assert.equal(executorModel('critique', 0), 'openai/gpt-6.1-sol');
  const task={instruction:'repair invariant'}, files=[{path:'worker/a.ts',content:'before'}];
  const plan=advisoryBody(task, files, 'plan', {...defaultExperiment, outputTokens:16384});
  const review=advisoryBody(task, files, 'review', defaultExperiment);
  assert.equal(plan.max_tokens,8192);
  assert.match(plan.messages[0].content,/replacement anchors/);
  assert.match(review.messages[0].content,/remaining bugs/);
  assert.equal(plan.response_format,undefined);
  assert.match(plan.messages[1].content,/worker\/a.ts/);
  assert.throws(()=>advisoryBody(task,files,'other',defaultExperiment),/invalid_advisory_role/);
});


test('handoff requires room for both executors within the same turn budget', () => {
  assert.throws(() => validateExperiment({...defaultExperiment, strategies:['handoff'], maxTurns:1}, 4), /two_turns/);
  assert.doesNotThrow(() => validateExperiment({...defaultExperiment, strategies:['handoff'], maxTurns:2}, 4));
  assert.equal(executorModel('handoff', 0), 'openai/gpt-6.1-sol');
});
