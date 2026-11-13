import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationTasks, calibrationRequest, gradeCalibration, summarizeCalibration, runCalibration } from '../scripts/fusion-edit-calibration.mjs';

const literal = calibrationTasks()[0];
const response = content => ({ result: { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }, inputTokens: 200, outputTokens: 30 });

test('calibration source and expected outputs stay out of the grading prompt', () => {
  for (const task of calibrationTasks()) {
    assert.notEqual(task.expected, task.files[0].content);
    assert.ok(task.files[0].content.split('\n').length >= 30);
    for (const format of ['search-replace', 'line-range']) {
      const request = calibrationRequest(task, format);
      const user = JSON.parse(request.messages[1].content);
      assert.equal(user.instruction, task.instruction);
      assert.equal('expected' in user, false);
      assert.equal(request.max_tokens, 1024);
      assert.ok(user.source[0].numberedSource.startsWith('1|'));
    }
  }
});

test('both existing executors apply a precise requested edit', () => {
  assert.equal(gradeCalibration(literal, 'search-replace', JSON.stringify({ edits: [
    { path: literal.editPaths[0], search: 'retryDelayMs = 100', replace: 'retryDelayMs = 250' },
  ] })).outcome, 'exact');
  assert.equal(gradeCalibration(literal, 'line-range', JSON.stringify({ path: literal.editPaths[0], line: 1, endLine: 1,
    replace: 'export const retryDelayMs = 250;' })).outcome, 'exact');
});

test('grading separates rejection from wrong applied changes and unchanged output', () => {
  const search = (from, to) => gradeCalibration(literal, 'search-replace', JSON.stringify({ edits: [
    { path: literal.editPaths[0], search: from, replace: to },
  ] })).outcome;
  assert.equal(search('return 1;', 'return 2;'), 'anchor_rejected');
  assert.equal(search('absent source', 'replacement'), 'anchor_rejected');
  assert.equal(search('retryDelayMs = 100', 'retryDelayMs = 300'), 'wrong_applied');
  assert.equal(search('retryDelayMs = 100', 'retryDelayMs = 100'), 'unchanged');
  assert.equal(gradeCalibration(literal, 'line-range', JSON.stringify({ path: literal.editPaths[0], line: 999, endLine: 999,
    replace: 'other' })).outcome, 'range_rejected');
  assert.equal(gradeCalibration(literal, 'line-range', JSON.stringify({ path: 'test/private.ts', line: 1, endLine: 1,
    replace: 'other' })).outcome, 'range_rejected');
});

test('malformed and extra-field responses cannot become graded edits', () => {
  for (const format of ['search-replace', 'line-range']) {
    for (const content of ['bad json', 'null', '[]', '{}', '{"edits":[],"extra":true}']) {
      assert.equal(gradeCalibration(literal, format, content).outcome, 'malformed');
    }
  }
});

const records = () => calibrationTasks().flatMap(task => ['search-replace', 'line-range'].map(format => ({
  caseId: task.id, format, status: 'complete', outcome: 'exact', inputTokens: 100, outputTokens: 20, elapsedMs: 1,
})));

test('confirmation requires complete unique coverage and no wrong applied edits', () => {
  assert.ok(summarizeCalibration(records()).every(row => row.eligibleForConfirmation));
  const bad = records(); bad[0].outcome = 'wrong_applied';
  assert.equal(summarizeCalibration(bad)[0].eligibleForConfirmation, false);
  const rejected = records(); rejected[0].outcome = 'anchor_rejected';
  assert.equal(summarizeCalibration(rejected)[0].eligibleForConfirmation, true);
  rejected[2].outcome = 'malformed';
  assert.equal(summarizeCalibration(rejected)[0].eligibleForConfirmation, false);
  assert.throws(() => summarizeCalibration(records().slice(1)), /incomplete/);
  const duplicate = records(); duplicate[0] = duplicate[1];
  assert.throws(() => summarizeCalibration(duplicate), /invalid/);
  const pending = records(); pending[0].status = 'pending';
  assert.throws(() => summarizeCalibration(pending), /invalid/);
});

test('runner rotates formats, uses paired seeds, and records all twelve calls', async () => {
  const calls = [];
  const state = await runCalibration(async (_body, info) => {
    calls.push({ format: info.format, seed: info.seed });
    return response({});
  });
  assert.equal(state.complete, true);
  assert.equal(state.records.length, 12);
  assert.deepEqual(calls.slice(0, 4).map(row => row.format), ['search-replace', 'line-range', 'line-range', 'search-replace']);
  assert.equal(calls[0].seed, calls[1].seed);
  assert.equal(calls[2].seed, calls[3].seed);
  assert.ok(state.records.every(row => row.outcome === 'malformed' && row.status === 'complete'));
});

test('truncated response terminates without retries and retains incomplete state', async () => {
  let calls = 0, state;
  await assert.rejects(runCalibration(async () => {
    calls++;
    const result = response({}); result.result.choices[0].finish_reason = 'length'; return result;
  }, { checkpoint: async value => { state = structuredClone(value); } }), /provider_truncated/);
  assert.equal(calls, 1);
  assert.equal(state.complete, false);
  assert.equal(state.records[0].status, 'pending');
  assert.equal(state.failure, 'calibration_incomplete');
});

test('abort and invalid usage cannot produce a complete calibration', async () => {
  const control = new AbortController(); let calls = 0;
  await assert.rejects(runCalibration(async () => {
    calls++; control.abort(); return response({});
  }, { signal: control.signal }), /abort/i);
  assert.equal(calls, 1);
  await assert.rejects(runCalibration(async () => ({ ...response({}), outputTokens: 1025 })), /invalid_calibration_usage/);
});
