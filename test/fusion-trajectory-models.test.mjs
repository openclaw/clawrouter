import test from 'node:test';
import assert from 'node:assert/strict';
import { runModelTrajectory, runSingleModelTrajectory, runAdaptiveModelTrajectory } from '../scripts/fusion-trajectory-models.mjs';

const answer = content => ({ action: { type: 'final', content } });
const response = value => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
function fixture(invoke) {
  return { task: 'Look up a value.', runId: 'trajectory-test', draftModel: 'draft-model', reviewModel: 'review-model',
    tools: [{ name: 'read', effect: 'read',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
      validate: args => typeof args.key === 'string', execute: async args => ({ value: args.key }) }], invoke };
}

test('all model roles use the injected metered transport with strict structured responses', async () => {
  const calls = [];
  const options = fixture(async (trial, model, body, signal) => {
    assert.equal(trial, 'trajectory-test'); assert.ok(signal instanceof AbortSignal);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    calls.push(model);
    if (calls.length === 1) return response({ action: { type: 'tool', name: 'read', arguments: { key: 'wrong' } } });
    if (calls.length === 2) return response(answer('wrong answer'));
    if (calls.length === 3) {
      const request = JSON.parse(body.messages[1].content);
      assert.equal(request.segment[0].observation.value, 'wrong');
      assert.equal(request.segment[1].observation, null);
      assert.equal(body.max_tokens, 768);
      return response({ accepted: 0, reason: 'Wrong lookup.', replacement: null });
    }
    const repair = JSON.parse(body.messages[1].content);
    assert.deepEqual(repair.history, []); assert.equal(Object.hasOwn(repair, 'segment'), false);
    assert.equal(body.max_tokens, 1024);
    return response(answer('repaired'));
  });
  const result = await runModelTrajectory(options);
  assert.equal(result.content, 'repaired');
  assert.deepEqual(calls, ['draft-model', 'draft-model', 'review-model', 'review-model']);
  assert.equal(result.stats.modelCalls, calls.length);
});

test('truncated and malformed responses stop without retries', async () => {
  for (const result of [
    { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(answer('partial')) } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{bad' } }] },
    response({ action: answer('nested'), extra: true }),
  ]) {
    let calls = 0;
    await assert.rejects(runModelTrajectory(fixture(async () => { calls++; return result; })), /provider_truncated|invalid_trajectory_model_json/);
    assert.equal(calls, 1);
  }
});

test('metering failures propagate and preflight rejects malformed tools without calling models', async () => {
  await assert.rejects(runModelTrajectory(fixture(async () => { throw new Error('campaign_budget'); })), /campaign_budget/);
  const options = fixture(async () => { throw new Error('must_not_call'); });
  options.tools[0].parameters.additionalProperties = true;
  await assert.rejects(runModelTrajectory(options), /invalid_trajectory_parameters/);
});

test('optional fields and non-strict nested objects fail before a paid call', async () => {
  for (const parameters of [
    { type: 'object', properties: { key: { type: 'string' }, limit: { type: 'integer' } }, required: ['key'], additionalProperties: false },
    { type: 'object', properties: { child: { type: 'object', properties: {}, required: [] } }, required: ['child'], additionalProperties: false },
    { type: 'object', properties: { child: { $ref: '#/$defs/Child' } }, required: ['child'], additionalProperties: false },
    { type: 'object', properties: { child: { type: 'array', items: { type: 'object', properties: {} } } }, required: ['child'], additionalProperties: false },
  ]) {
    let calls = 0;
    const options = fixture(async () => { calls++; throw new Error('must_not_call'); });
    options.tools[0].parameters = parameters;
    await assert.rejects(runModelTrajectory(options), /invalid_trajectory_parameters/);
    assert.equal(calls, 0);
  }
});

test('explicit nullable fields preserve null and support strict nested schema alternatives', async () => {
  const options = fixture(async (_trial, _model, body) => body.response_format.json_schema.name === 'trajectory_action'
    ? response(answer('done')) : response({ accepted: 1, reason: '', replacement: null }));
  options.tools[0].parameters = { type: 'object', properties: {
    key: { type: ['string', 'null'] },
    rows: { type: 'array', items: { anyOf: [{ type: 'null' },
      { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false }] } },
  }, required: ['key', 'rows'], additionalProperties: false };
  assert.equal((await runModelTrajectory(options)).content, 'done');
});

test('fixed-model control never invokes a verifier or changes the selected model', async () => {
  let calls = 0;
  const options = fixture(async (_trial, model, body) => {
    assert.equal(model, 'control-model');
    assert.equal(body.response_format.json_schema.name, 'trajectory_action');
    assert.ok(!body.messages[0].content.includes('held for review'));
    return response(calls++ ? answer('done') : { action: { type: 'tool', name: 'read', arguments: { key: 'value' } } });
  });
  const result = await runSingleModelTrajectory({ ...options, model: 'control-model' });
  assert.equal(calls, 2);
  assert.equal(result.stats.modelCalls, 2);
  assert.equal(result.stats.reviews, 0);
});

test('adaptive selection is restricted to the pinned pair and cannot mutate the request', async () => {
  let calls = 0;
  const options = fixture(async (_trial, model, body) => {
    calls++; assert.equal(model, 'review-model');
    assert.equal(JSON.parse(body.messages[1].content).task, 'Look up a value.');
    return response(answer('done'));
  });
  const output = await runAdaptiveModelTrajectory({ ...options,
    selectModel: request => { request.task = 'changed'; return 'review-model'; } });
  assert.equal(output.content, 'done'); assert.equal(calls, 1);
  await assert.rejects(runAdaptiveModelTrajectory({ ...options, selectModel: () => 'unconfigured-model' }),
    /invalid_trajectory_selected_model/);
  assert.equal(calls, 1);
});


test('adaptive tool feedback switches the pinned model and checks the corrected final result', async () => {
  let value = false;
  const calls = [];
  const output = await runAdaptiveModelTrajectory({
    task: 'Set the value to true.', runId: 'feedback-routing', draftModel: 'small', reviewModel: 'strong',
    maxModelCalls: 3, maxToolCalls: 3, finalCheckTool: 'check',
    tools: [
      { name: 'set_value', effect: 'write', parameters: {
        type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'], additionalProperties: false },
        validate: args => Object.keys(args).length === 1 && typeof args.value === 'boolean',
        execute: async args => { value = args.value; return { applied: true }; } },
      { name: 'check', effect: 'write', parameters: {
        type: 'object', properties: {}, required: [], additionalProperties: false },
        validate: args => Object.keys(args).length === 0, execute: async () => ({ passed: value }) },
    ],
    selectModel: request => request.history.some(step => step.observation.passed === false) ? 'strong' : 'small',
    invoke: async (id, model, body, signal) => {
      assert.equal(id, 'feedback-routing'); assert.ok(signal instanceof AbortSignal); calls.push(model);
      const request = JSON.parse(body.messages[1].content);
      if (calls.length === 2) {
        assert.equal(request.history[0].observation.passed, false);
        return response({ action: { type: 'tool', name: 'set_value', arguments: { value: true } } });
      }
      return response(answer('done'));
    },
  });
  assert.deepEqual(calls, ['small', 'strong', 'strong']);
  assert.equal(output.history.at(-1).observation.passed, true);
  assert.equal(output.stats.modelCalls, 3); assert.equal(output.stats.toolCalls, 3);
});


test('schema dependencies fail preflight at the root and in nested parameters', async () => {
  for (const keyword of ['dependentRequired', 'dependentSchemas']) for (const nested of [false, true]) {
    let calls = 0;
    const options = fixture(async () => { calls++; throw new Error('must_not_call'); });
    const dependency = { type: 'object', properties: {}, required: [], additionalProperties: false, [keyword]: {} };
    options.tools[0].parameters = nested ? { type: 'object', properties: { child: dependency }, required: ['child'], additionalProperties: false } : dependency;
    await assert.rejects(runModelTrajectory(options), /invalid_trajectory_parameters/);
    assert.equal(calls, 0);
  }
});
