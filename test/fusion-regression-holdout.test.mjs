import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { splitRegressionSuiteTest, qualifyRegressionHoldout } from '../scripts/fusion-regression-holdout.mjs';

const preservation = "it('preserves zero', () => { assert.equal(fix(0), 0); });";
const positive = "it('fixes positive', () => { assert.equal(fix(2), 2); });";
const negative = "it('fixes negative', () => { assert.equal(fix(-2), -2); });";
const statements = [preservation, positive, negative];
const wrap = body => `describe('numbers', () => { ${body} });`;
const file = { path: 'test/numbers.js', before: wrap(preservation), content: wrap(statements.join('\n')) };

// Exact fixture spans plus an independent JS parser. Production callers supply
// their pinned Babel-compatible parser and complete native execution receipts.
function parse(source) {
  new Script(source);
  const body = statements.flatMap(text => {
    const nodes = [];
    for (let at = source.indexOf(text); at >= 0; at = source.indexOf(text, at + text.length)) {
      nodes.push({ type: 'ExpressionStatement', start: at, end: at + text.length, expression: {
        type: 'CallExpression', callee: { name: 'it' }, arguments: [
          { type: 'StringLiteral', value: text.split("'")[1] },
          { type: 'ArrowFunctionExpression', body: { type: 'BlockStatement', body: [] } },
        ],
      } });
    }
    return nodes;
  });
  return { program: { body: [{ expression: { type: 'CallExpression', callee: { name: 'describe' }, arguments: [
    { type: 'StringLiteral', value: 'numbers' },
    { type: 'ArrowFunctionExpression', body: { type: 'BlockStatement', body } },
  ] } }] } };
}

function execute(content, testsSha256, fix) {
  let assertions = 0, failedAssertions = 0;
  new Script(content).runInNewContext({ assert, fix, describe: (_name, run) => run(), it: (_name, run) => {
    assertions++;
    try { run(); } catch { failedAssertions++; }
  } });
  return { testsSha256, valid: true, passed: failedAssertions === 0, assertions,
    failedAssertions, skipped: 0, cancelled: 0 };
}

function evidence(split, baselineFix = () => 0) {
  const run = fix => Object.fromEntries([
    ['full', file.content, split.originalSha256],
    ['public', split.content, split.publicSha256],
    ['hidden', split.hiddenContent, split.hiddenSha256],
  ].map(([name, content, digest]) => [name, execute(content, digest, fix)]));
  return { reference: run(value => value), baseline: run(baselineFix) };
}

test('changed regression is held out while another regression and preservation stay public', () => {
  const snapshot = structuredClone(file);
  const split = splitRegressionSuiteTest('numbers', file, parse);
  assert.deepEqual(file, snapshot);
  assert.deepEqual(splitRegressionSuiteTest('numbers', file, parse), split);
  assert.equal(split.expectedFull, 3);
  assert.equal(split.expectedPublic, 2);
  assert.equal(split.expectedHidden, 1);
  assert.equal(split.heldUnchanged, false);
  assert.ok(split.content.includes(preservation));
  assert.equal(Number(split.content.includes(positive)) + Number(split.content.includes(negative)), 1);
  assert.equal(Number(split.hiddenContent.includes(positive)) + Number(split.hiddenContent.includes(negative)), 1);
  assert.ok(!split.hiddenContent.includes(preservation));
  assert.ok(qualifyRegressionHoldout(split, evidence(split)));
});

test('preservation-only and single-regression tasks are rejected before inference', () => {
  assert.throws(() => splitRegressionSuiteTest('numbers', { ...file, before: file.content }, parse), /two_changed/);
  assert.throws(() => splitRegressionSuiteTest('numbers', { ...file, content: wrap(preservation + positive) }, parse), /two_changed/);
  assert.throws(() => splitRegressionSuiteTest('', file, parse), /invalid_holdout_id/);
  assert.throws(() => splitRegressionSuiteTest('numbers', { ...file, content: '(' }, parse), SyntaxError);
  assert.throws(() => splitRegressionSuiteTest('numbers', { ...file, content: wrap(positive + positive + negative) }, parse), /duplicate_regression_identity/);
  const invalidSpan = source => { const ast = parse(source); ast.program.body[0].expression.arguments[1].body.body[0].end = source.length + 1; return ast; };
  assert.throws(() => splitRegressionSuiteTest('numbers', file, invalidSpan), /invalid_regression_span/);
});

test('text changes alone cannot qualify a hidden group that the baseline already passes', () => {
  const split = splitRegressionSuiteTest('numbers', file, parse);
  const hiddenPositive = split.hiddenContent.includes(positive);
  const rows = evidence(split, value => (hiddenPositive ? value >= 0 : value <= 0) ? value : 0);
  assert.equal(rows.baseline.public.passed, false);
  assert.equal(rows.baseline.hidden.passed, true);
  assert.equal(qualifyRegressionHoldout(split, rows), false);
});

test('qualification rejects stale, incomplete, skipped, cancelled and contradictory native receipts', () => {
  const split = splitRegressionSuiteTest('numbers', file, parse);
  for (const role of ['baseline', 'reference']) {
    for (const view of ['full', 'public', 'hidden']) {
      for (const patch of [
        { testsSha256: '0'.repeat(64) }, { valid: false }, { assertions: 0 },
        { skipped: 1 }, { cancelled: 1 }, { failedAssertions: -1 },
        { failedAssertions: 999 }, { failedAssertions: NaN },
        { passed: role === 'baseline' },
      ]) {
        const rows = evidence(split);
        Object.assign(rows[role][view], patch);
        assert.equal(qualifyRegressionHoldout(split, rows), false, `${role}/${view}/${Object.keys(patch)}`);
      }
      const missing = evidence(split);
      delete missing[role][view];
      assert.equal(qualifyRegressionHoldout(split, missing), false);
    }
  }
  assert.equal(qualifyRegressionHoldout({ ...split, expectedHidden: 0 }, evidence(split)), false);
  assert.equal(qualifyRegressionHoldout({ ...split, heldUnchanged: true }, evidence(split)), false);
});
