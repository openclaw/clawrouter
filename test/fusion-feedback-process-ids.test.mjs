import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { check } from '../scripts/fusion-workloads.mjs';

const tap = 'TAP version 13\n# Subtest: example\nok 1 - example\n  ---\n  duration_ms: 1\n  ...\n'
  + '1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 2\n';
const warning = pid => `# (node:${pid}) [UNDICI-ES] Warning: EventSource is experimental, expect them to change at any time.\n`;
const fixture = (stdout, stderr = '') => ({ exec: async () => ({ code: 0, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) }) });

test('opt-in warning PID normalization makes saved feedback replayable without changing verdicts', async () => {
  const raw = await check(fixture(warning(161) + tap), ['test/example.js']);
  assert.ok(raw.feedback.includes('(node:161)'));
  const options = { normalizeFeedbackProcessIds: true };
  const first = await check(fixture(warning(161) + tap), ['test/example.js'], 120000, options);
  const replay = await check(fixture(warning(160) + tap), ['test/example.js'], 120000, options);
  assert.equal(first.feedback, replay.feedback);
  assert.notEqual(first.digest, replay.digest, 'raw evidence digest must remain unchanged');
  const { feedback: _raw, ...rawVerdict } = raw, { feedback: _normalized, ...normalizedVerdict } = first;
  assert.deepEqual(rawVerdict, normalizedVerdict);
  assert.ok(first.feedback.includes('(node:<pid>) [UNDICI-ES] Warning: EventSource'));
  assert.ok(first.feedback.includes('duration_ms: 1'));
});

test('preserves warning messages, codes, stacks and PID-shaped assertion values', async () => {
  const evidence = '    (node:161) [UNDICI-ES] Warning: assertion value\n'
    + '# pid=161\n# (node:161) an ordinary diagnostic\n# (node:161) [custom] Warning: custom text\n';
  const stderr = '(node:321) [DEP0001] DeprecationWarning: preserve this message\r\n    at file.js:1:2\r\n';
  const result = await check(fixture(tap + evidence, stderr), ['test/example.js'], 120000,
    { normalizeFeedbackProcessIds: true, normalizeFeedbackTimings: true });
  assert.ok(result.feedback.includes(evidence));
  assert.ok(result.feedback.includes('(node:<pid>) [DEP0001] DeprecationWarning: preserve this message\r\n    at file.js:1:2\r\n'));
  assert.ok(result.feedback.includes('duration_ms: <elapsed>'));
  const changed = await check(fixture(warning(161).replace('experimental', 'different') + tap), ['test/example.js'], 120000,
    { normalizeFeedbackProcessIds: true });
  assert.ok(changed.feedback.includes('different'));
});

test('normalizes an actual Node warning and validates the option before execution', async () => {
  const child = spawnSync(process.execPath, ['-e', "process.emitWarning('native warning', {code:'FUSION-TEST'})"], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.match(child.stderr, /\(node:[0-9]+\) \[FUSION-TEST\] Warning: native warning/);
  const result = await check(fixture(tap, child.stderr), ['test/example.js'], 120000, { normalizeFeedbackProcessIds: true });
  assert.match(result.feedback, /\(node:<pid>\) \[FUSION-TEST\] Warning: native warning/);
  await assert.rejects(check({ exec: () => { throw Error('must not execute'); } }, ['test/example.js'], 120000,
    { normalizeFeedbackProcessIds: 'yes' }), /invalid_feedback_process_id_option/);
});
