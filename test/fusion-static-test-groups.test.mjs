import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { splitRegressionTests, qualifyRegressionHoldout } from '../scripts/fusion-regression-holdout.mjs';

const preserved = "it('zero', () => { assert.equal(fix(0), 0); });";
const positive = 'for (const n of [1, 2]) { it(`positive ${n}`, () => { assert.equal(fix(n), n); }); }';
const negative = 'for (const n of [1, 2]) { it(`negative ${n}`, () => { assert.equal(fix(-n), -n); }); }';
const nested = 'for (const n of [1, 2]) { for (const v of [false, undefined]) { it(`nested ${n} ${v}`, () => { assert.equal(fix(n), n); }); } }';
const positiveTuple = "for (const [label, n, adjust] of [['one', 1, value => value], ['two', 2, value => value]]) it('positive ' + label, () => { assert.equal(adjust(fix(n)), n); });";
const negativeTuple = "for (const [label, n, adjust] of [['one', 1, value => value], ['two', 2, value => value]]) { it('negative ' + label, () => { assert.equal(adjust(fix(-n)), -n); }); }";
const fn = () => ({ type: 'ArrowFunctionExpression', body: { type: 'BlockStatement', body: [] } });
const registration = names => ({ type: 'ExpressionStatement', expression: { type: 'CallExpression',
  callee: { name: 'it' }, arguments: [{ type: 'TemplateLiteral', expressions: names.map(name => ({ type: 'Identifier', name })) }, fn()] } });
const loop = (name, body) => ({ type: 'ForOfStatement', await: false,
  left: { type: 'VariableDeclaration', kind: 'const', declarations: [{ id: { type: 'Identifier', name }, init: null }] },
  right: { type: 'ArrayExpression', elements: [{ type: 'NumericLiteral', value: 1 }, { type: 'NumericLiteral', value: 2 }] },
  body: { type: 'BlockStatement', body } });

function tupleLoop(direct) {
  const node = loop('unused', [registration(['label'])]);
  node.left.declarations[0].id = { type: 'ArrayPattern', elements: ['label', 'n', 'adjust'].map(name => ({ type: 'Identifier', name })) };
  node.right.elements = [1, 2].map(value => ({ type: 'ArrayExpression', elements: [
    { type: 'StringLiteral', value: String(value) }, { type: 'NumericLiteral', value }, fn(),
  ] }));
  node.body.body[0].expression.arguments[0] = { type: 'BinaryExpression', operator: '+',
    left: { type: 'StringLiteral', value: 'case ' }, right: { type: 'Identifier', name: 'label' } };
  if (direct) node.body = node.body.body[0];
  return node;
}

// Exact fixture AST spans; the VM below independently executes the unchanged
// JavaScript in all three views and checks the predicted registration totals.
function parse(source) {
  new Script(source);
  const nodes = [];
  for (const text of [preserved, positive, negative, nested, positiveTuple, negativeTuple]) {
    const start = source.indexOf(text);
    if (start < 0) continue;
    const node = text === preserved ? { ...registration([]), expression: { type: 'CallExpression',
      callee: { name: 'it' }, arguments: [{ type: 'StringLiteral', value: 'zero' }, fn()] } }
      : text === positiveTuple || text === negativeTuple ? tupleLoop(text === positiveTuple)
        : text === nested ? loop('n', [loop('v', [registration(['n', 'v'])])]) : loop('n', [registration(['n'])]);
    nodes.push({ ...node, start, end: start + text.length });
  }
  return { program: { body: nodes.sort((a, b) => a.start - b.start) } };
}

function split(content = [preserved, positive, negative].join('\n'), parser = parse) {
  return splitRegressionTests('static-loops', [{ path: 'test/example.js', before: preserved, content }], parser,
    { staticForOfGroups: true });
}

function execute(content, testsSha256, fix) {
  let assertions = 0, failedAssertions = 0;
  new Script(content).runInNewContext({ assert, fix, it: (_name, callback) => {
    assertions++;
    try { callback(); } catch { failedAssertions++; }
  } });
  return { testsSha256, valid: true, passed: failedAssertions === 0, assertions,
    failedAssertions, skipped: 0, cancelled: 0 };
}

test('static loops stay intact and all native registrations enter holdout counts', () => {
  const original = [preserved, positive, negative].join('\n'), result = split(original);
  assert.equal(result.selection, 'changed-static-groups-v1');
  assert.equal(result.expectedFull, 5);
  assert.equal(result.expectedPublic, 3);
  assert.equal(result.expectedHidden, 2);
  const [file] = result.files;
  assert.ok(file.content.includes(preserved));
  assert.equal(Number(file.content.includes(positive)) + Number(file.content.includes(negative)), 1);
  assert.equal(Number(file.hiddenContent.includes(positive)) + Number(file.hiddenContent.includes(negative)), 1);
  const run = fix => Object.fromEntries([
    ['full', original, result.originalSha256], ['public', file.content, result.publicSha256],
    ['hidden', file.hiddenContent, result.hiddenSha256],
  ].map(([view, content, digest]) => [view, execute(content, digest, fix)]));
  const receipts = { reference: run(value => value), baseline: run(() => 0) };
  assert.equal(qualifyRegressionHoldout(result, receipts), true);
  assert.equal(qualifyRegressionHoldout({ ...result, selection: 'changed-suite-child-v1' }, receipts), false);
  receipts.reference.hidden.assertions++;
  assert.equal(qualifyRegressionHoldout(result, receipts), false);
  assert.deepEqual(split(original), result);
});

test('nested finite loops multiply counts and preserve outer lexical bindings', () => {
  const content = [preserved, nested, negative].join('\n'), result = split(content);
  assert.equal(result.expectedFull, 7);
  assert.equal(result.expectedPublic + result.expectedHidden, 7);
  assert.equal(execute(result.files[0].content, '', value => value).assertions, result.expectedPublic);
  assert.equal(execute(result.files[0].hiddenContent, '', value => value).assertions, result.expectedHidden);
});

test('literal tuple groups preserve callable values and count direct registration bodies', () => {
  const content = [preserved, positiveTuple, negativeTuple].join('\n'), result = split(content);
  assert.equal(result.expectedFull, 5);
  assert.equal(result.expectedPublic, 3); assert.equal(result.expectedHidden, 2);
  const run = fix => Object.fromEntries([
    ['full', content, result.originalSha256], ['public', result.files[0].content, result.publicSha256],
    ['hidden', result.files[0].hiddenContent, result.hiddenSha256],
  ].map(([view, source, digest]) => [view, execute(source, digest, fix)]));
  assert.equal(qualifyRegressionHoldout(result, { reference: run(value => value), baseline: run(() => 0) }), true);
  assert.ok(result.files[0].content.includes('value => value'));
  assert.ok(result.files[0].hiddenContent.includes('value => value'));
  assert.deepEqual(split(content), result);
});

test('tuple groups reject dynamic initialization, destructuring and test names', () => {
  const content = [preserved, positiveTuple, negativeTuple].join('\n');
  const mutations = [
    node => { node.left.declarations[0].id.elements[0] = { type: 'AssignmentPattern' }; },
    node => { node.left.declarations[0].id.elements[0] = { type: 'RestElement' }; },
    node => { node.left.declarations[0].id.elements[0] = null; },
    node => { node.left.declarations[0].id.elements[1].name = 'label'; },
    node => { node.right.elements[0].elements[1] = { type: 'CallExpression' }; },
    node => { node.right.elements[0].elements[1] = { type: 'MemberExpression' }; },
    node => { node.right.elements[0].elements[1] = { type: 'SpreadElement' }; },
    node => { node.right.elements[0].elements[1] = null; },
    node => { node.right.elements[0].elements.pop(); },
    node => { node.body.expression.arguments[0].right = { type: 'Identifier', name: 'unbound' }; },
    node => { node.body.expression.arguments[0].operator = '-'; },
  ];
  for (const mutate of mutations) {
    assert.throws(() => split(content, source => {
      const ast = parse(source), node = ast.program.body.find(value => value.type === 'ForOfStatement');
      if (node) mutate(node);
      return ast;
    }), /unsupported_static_regression_loop/);
  }
});

test('function-valued tuple bindings cannot shadow direct or nested registration APIs', () => {
  const content = [preserved, positiveTuple, negativeTuple].join('\n');
  for (const callee of ['it', 'test']) for (const nestedScope of [false, true]) {
    assert.throws(() => split(content, source => {
      const ast = parse(source), node = ast.program.body.find(value => value.type === 'ForOfStatement');
      if (node) {
        node.left.declarations[0].id.elements[2].name = callee;
        const call = node.body.expression;
        call.callee.name = callee;
        if (nestedScope) node.body = { type: 'BlockStatement', body: [loop('inner', [{ type: 'ExpressionStatement', expression: call }])] };
      }
      return ast;
    }), /unsupported_static_regression_loop/);
  }
});

test('dynamic or effectful registration loops fail closed before execution', () => {
  const mutations = [
    node => { node.await = true; },
    node => { node.left.kind = 'let'; },
    node => { node.right = { type: 'Identifier', name: 'values' }; },
    node => { node.right.elements = [null]; },
    node => { node.right.elements = [{ type: 'SpreadElement' }]; },
    node => { node.right.elements = Array(257).fill({ type: 'NumericLiteral', value: 1 }); },
    node => { node.body.body = []; },
    node => { node.body.body = [{ type: 'IfStatement' }]; },
    node => { node.body.body[0].expression.callee = { type: 'MemberExpression' }; },
    node => { node.body.body[0].expression.arguments[0].expressions = [{ type: 'CallExpression' }]; },
    node => { node.body.body[0].expression.arguments[0].expressions = [{ type: 'Identifier', name: 'unbound' }]; },
  ];
  for (const mutate of mutations) {
    assert.throws(() => split(undefined, source => {
      const ast = parse(source);
      ast.program.body.filter(node => node.type === 'ForOfStatement').forEach(mutate);
      return ast;
    }), /unsupported_static_regression_loop/);
  }
});

test('static registration support is explicit and still requires two changed groups', () => {
  assert.throws(() => splitRegressionTests('off', [{ path: 'x', before: preserved,
    content: [preserved, positive, negative].join('\n') }], parse), /two_changed/);
  assert.throws(() => split([preserved, positive].join('\n')), /two_changed/);
  assert.throws(() => splitRegressionTests('bad', [], parse, { staticForOfGroups: 'yes' }), /invalid_holdout_input/);
  assert.throws(() => splitRegressionTests('bad', [{ path: 'x', before: preserved, content: positive }], parse,
    { staticForOfGroups: 'yes' }), /invalid_static_regression_groups/);
});
