import assert from 'node:assert/strict';
import test from 'node:test';
import { firstTestFailureFeedback as first } from '../scripts/fusion-failure-feedback.mjs';

const failure = (name, type = 'testCodeFailure') => `not ok 2 - ${name}\n  ---\n  duration_ms: <elapsed>\n  type: 'test'\n  failureType: '${type}'\n  error: 'Store should not be full after eviction'\n  expected: false\n  actual: true\n  stack: |-\n    at fixture.js:12:3\n  ...`;

test('retains first complete assertion while discarding variable cancellation tails', () => {
  const assertion = failure('cache eviction');
  const prefix = 'TAP version 13\nok 1 - passing test\n';
  assert.equal(first(prefix + assertion + '\n' + failure('cancelled', 'testAborted')), assertion);
  assert.equal(first(prefix + assertion + '\n' + failure('later assertion') + '\n# tests 3'), assertion);
  assert.match(first(assertion), /expected: false\n  actual: true/);
  assert.notEqual(first(assertion), first(assertion.replace('actual: true', 'actual: false')));
});

test('handles nested indentation and CRLF without changing diagnostic content', () => {
  const nested = failure('nested').split('\n').map(line => '    ' + line).join('\n');
  assert.equal(first('# Subtest: suite\n' + nested.replaceAll('\n', '\r\n')), nested);
});

test('ignores TODO, SKIP, wrapper failures and comment-shaped output', () => {
  for (const directive of ['TODO', 'SKIP']) {
    assert.equal(first(failure('ignored').replace('ignored', `ignored # ${directive}`) + '\n' + failure('real')), failure('real'));
  }
  for (const type of ['testAborted', 'cancelledByParent', 'subtestsFailed', 'unknown']) {
    assert.equal(first(failure('wrapper', type) + '\n' + failure('real')), failure('real'));
  }
  assert.equal(first(failure('comment').split('\n').map(line => '# ' + line).join('\n')), null);
});

test('rejects incomplete or malformed blocks and preserves supported failure types', () => {
  const input = failure('broken');
  for (const value of [input.slice(0, -5), input.replace('  ---', '---'), input.replace('  actual: true', 'actual: true'),
    input.replace("  failureType: 'testCodeFailure'", "  failureType: 'testCodeFailure'\n  failureType: 'testAborted'")]) {
    assert.equal(first(value), null);
  }
  for (const type of ['uncaughtException', 'unhandledRejection', 'testTimeoutFailure']) assert.equal(first(failure(type, type)), failure(type, type));
  assert.equal(first(''), null);
  for (const value of [null, undefined, {}, 42]) assert.throws(() => first(value), TypeError);
});

test('retains raw syntax/import diagnostics instead of selecting generic process wrappers', () => {
  for (const field of ['exitCode: 1', 'signal: SIGTERM']) {
    const wrapper = failure('file.test.mjs').replace("error: 'Store should not be full after eviction'", "error: 'test failed'")
      .replace('  stack: |-', `  ${field}\n  stack: |-`);
    assert.equal(first('# SyntaxError: invalid token\n' + wrapper), null);
    assert.equal(first(wrapper + '\n' + failure('real assertion')), failure('real assertion'));
  }
});
