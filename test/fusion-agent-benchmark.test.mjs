import assert from 'node:assert/strict';
import test from 'node:test';
import { SpendLedger, defaultExperiment, validateExperiment, replaceEdits, sourceView, escalateSubmission, toolErrorCode, finishReason } from '../scripts/fusion-agent-benchmark.mjs';
import { nativeRequest } from '../scripts/fusion-native-provider.mjs';

test('every arm fits the predeclared campaign ceiling including previous uncertainty', () => {
  assert.equal(validateExperiment(defaultExperiment, 4), 3390914);
  assert.throws(() => validateExperiment({ ...defaultExperiment, trials: 3 }, 4), /campaign_budget/);
  assert.throws(() => validateExperiment({ ...defaultExperiment, priorCostMicros: -1 }, 4));
  assert.throws(() => validateExperiment({ ...defaultExperiment, strategies: ['strong', 'strong'] }, 4));
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
  assert.throws(() => sourceView(files, ['scripts/compile.mjs:1-1000']), /line_range/);
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
