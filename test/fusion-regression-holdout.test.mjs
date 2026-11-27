import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { splitRegressionSuiteTest, splitRegressionTests, splitRegressionAssertions, qualifyRegressionHoldout } from '../scripts/fusion-regression-holdout.mjs';

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


test('regressions spread across files qualify as one task without leaking the hidden group', () => {
  const files = [
    { ...file, path: 'test/positive.js', content: wrap(preservation + positive) },
    { ...file, path: 'test/negative.js', content: wrap(preservation + negative) },
  ];
  const split = splitRegressionTests('multifile', files, parse);
  assert.deepEqual(splitRegressionTests('multifile', [...files].reverse(), parse), split);
  assert.deepEqual(split.files.map(view => view.path), ['test/negative.js', 'test/positive.js']);
  assert.equal(split.expectedFull, 4);
  assert.equal(split.expectedPublic, 3);
  assert.equal(split.expectedHidden, 1);
  const digest = entries => createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  assert.equal(split.originalSha256, digest([...files].sort((a, b) => a.path < b.path ? -1 : 1).map(({ path, content }) => ({ path, content }))));
  assert.equal(split.publicSha256, digest(split.files.map(({ path, content }) => ({ path, content }))));
  assert.equal(split.hiddenSha256, digest(split.files.map(({ path, hiddenContent }) => ({ path, content: hiddenContent }))));
  assert.equal(split.files.filter(view => view.hiddenContent.includes(positive) || view.hiddenContent.includes(negative)).length, 1);
  assert.equal(split.files.filter(view => view.content.includes(positive) || view.content.includes(negative)).length, 1);
  const run = (field, digest, fix) => {
    const receipts = split.files.map(view => execute(field === 'original'
      ? files.find(file => file.path === view.path).content : view[field], digest, fix));
    return { ...receipts[0], assertions: receipts.reduce((sum, row) => sum + row.assertions, 0),
      failedAssertions: receipts.reduce((sum, row) => sum + row.failedAssertions, 0),
      passed: receipts.every(row => row.passed) };
  };
  const roles = Object.fromEntries([['reference', value => value], ['baseline', () => 0]].map(([role, fix]) =>
    [role, Object.fromEntries([['full', 'original', split.originalSha256],
      ['public', 'content', split.publicSha256], ['hidden', 'hiddenContent', split.hiddenSha256]]
      .map(([name, field, digest]) => [name, run(field, digest, fix)]))]));
  assert.equal(qualifyRegressionHoldout(split, roles), true);
  assert.throws(() => splitRegressionTests('multifile', [files[0], files[0]], parse), /duplicate_regression_path/);
});


test('explicit literal suite wrappers preserve context and reject dynamic identities', () => {
  const wrapped = source => {
    const ast = parse(source);
    ast.program.body[0].expression.callee.name = 'whenHeader';
    return ast;
  };
  const options = { suiteWrappers: ['whenHeader'] };
  const split = splitRegressionSuiteTest('wrapped', file, wrapped, options);
  assert.equal(split.expectedFull, 3);
  assert.equal(split.expectedPublic, 2);
  assert.equal(split.expectedHidden, 1);
  assert.throws(() => splitRegressionSuiteTest('wrapped', file, wrapped), /two_changed/);
  const dynamic = source => {
    const ast = wrapped(source);
    ast.program.body[0].expression.arguments[0] = { type: 'Identifier', name: 'environment' };
    return ast;
  };
  assert.throws(() => splitRegressionSuiteTest('wrapped', file, dynamic, options), /unsupported_regression_registration/);
  assert.throws(() => splitRegressionSuiteTest('wrapped', file, parse, { suiteWrappers: ['test'] }), /invalid_suite_wrappers/);
});

const tapeAssertions = [
  't.equal(fix(0), 0);',
  't.equal(fix(2), 2);',
  't.equal(fix(-2), -2);',
  't.end();',
];
const tapeWrap = body => `test('numbers', function (t) { ${body} });`;
const tapeFile = { path: 'test/assertions.js', before: tapeWrap(tapeAssertions[0] + tapeAssertions[3]),
  content: tapeWrap(tapeAssertions.join('\n')) };

function parseTape(source) {
  new Script(source);
  const body = tapeAssertions.flatMap(text => {
    const nodes = [];
    for (let start = source.indexOf(text); start >= 0; start = source.indexOf(text, start + text.length)) {
      nodes.push({ type: 'ExpressionStatement', start, end: start + text.length, expression: {
        type: 'CallExpression', arguments: text === 't.end();' ? [] : [{}, {}], callee: {
          type: 'MemberExpression', computed: false, object: { type: 'Identifier', name: 't' },
          property: { name: text === 't.end();' ? 'end' : 'equal' },
        },
      } });
    }
    return nodes;
  }).sort((a, b) => a.start - b.start);
  return { program: { body: [{ expression: { type: 'CallExpression', callee: { name: 'test' }, arguments: [
    { type: 'StringLiteral', value: 'numbers' }, { type: 'FunctionExpression', params: [{ type: 'Identifier', name: 't' }],
      body: { type: 'BlockStatement', body } },
  ] } }] } };
}

function executeTape(content, testsSha256, fix) {
  let assertions = 0, failedAssertions = 0, ended = 0;
  new Script(content).runInNewContext({ fix, test: (_name, run) => run({
    equal(actual, expected) { assertions++; if (actual !== expected) failedAssertions++; },
    end() { ended++; },
  }) });
  assert.equal(ended, 1);
  return { testsSha256, valid: true, passed: failedAssertions === 0, assertions, failedAssertions,
    skipped: 0, cancelled: 0 };
}

test('Tape assertions preserve completion and qualify a separate hidden regression', () => {
  const snapshot = structuredClone(tapeFile);
  const split = splitRegressionAssertions('tape-numbers', [tapeFile], parseTape);
  assert.deepEqual(tapeFile, snapshot);
  assert.deepEqual(splitRegressionAssertions('tape-numbers', [tapeFile], parseTape), split);
  assert.equal(split.selection, 'changed-tape-assertion-v1');
  assert.equal(split.expectedFull, 3);
  assert.equal(split.expectedPublic, 2);
  assert.equal(split.expectedHidden, 1);
  assert.ok(split.files[0].content.includes(tapeAssertions[0]));
  const run = fix => Object.fromEntries([
    ['full', tapeFile.content, split.originalSha256],
    ['public', split.files[0].content, split.publicSha256],
    ['hidden', split.files[0].hiddenContent, split.hiddenSha256],
  ].map(([view, content, digest]) => [view, executeTape(content, digest, fix)]));
  const reference = run(value => value);
  assert.equal(qualifyRegressionHoldout(split, { reference, baseline: run(() => 0) }), true);
  const hiddenPositive = split.files[0].hiddenContent.includes(tapeAssertions[1]);
  const baseline = run(value => (hiddenPositive ? value >= 0 : value <= 0) ? value : 0);
  assert.equal(baseline.public.passed, false);
  assert.equal(baseline.hidden.passed, true);
  assert.equal(qualifyRegressionHoldout(split, { reference, baseline }), false);
});

test('Tape assertion splitting rejects ambiguous and unsupported callbacks', () => {
  assert.throws(() => splitRegressionAssertions('tape', [{ ...tapeFile, before: tapeFile.content }], parseTape), /two_changed/);
  assert.throws(() => splitRegressionAssertions('tape', [{ ...tapeFile,
    content: tapeWrap(tapeAssertions[1] + tapeAssertions[1] + tapeAssertions[2] + tapeAssertions[3]) }], parseTape), /duplicate_regression_identity/);
  for (const mutate of [
    fn => { fn.async = true; },
    fn => { fn.params = []; },
    fn => { fn.body.body[0].expression.callee.computed = true; },
    fn => { fn.body.body[0].expression.callee.property.name = 'plan'; },
    fn => { fn.body.body.unshift({ type: 'VariableDeclaration' }); },
    fn => { fn.body.body.at(-1).expression.arguments.push({}); },
    fn => { fn.body.body.unshift(fn.body.body.pop()); },
    fn => { fn.body.body.pop(); },
  ]) {
    const unsupported = source => { const ast = parseTape(source); mutate(ast.program.body[0].expression.arguments[1]); return ast; };
    assert.throws(() => splitRegressionAssertions('tape', [tapeFile], unsupported), /unsupported_assertion/);
  }
});
