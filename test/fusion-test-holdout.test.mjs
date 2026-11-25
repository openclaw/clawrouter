import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { splitUnchangedSuiteTest } from '../scripts/fusion-test-holdout.mjs';

const old = "test('preservation', () => preserve());";
const added = "test('regression', () => verifyLimit(128));";
const wrap = text => `describe('suite', () => { ${text} });`;
// The helper accepts a caller-supplied Babel-compatible parser. This fixture
// supplies exact statement spans and independently checks resulting JS syntax.
function parse(source) {
  new Script(source);
  const body = [old, added].flatMap(text => {
    const start = source.indexOf(text);
    return start < 0 ? [] : [{ type: 'ExpressionStatement', start, end: start + text.length,
      expression: { type: 'CallExpression', callee: { name: 'test' }, arguments: [] } }];
  });
  return { program: { body: [{ expression: { type: 'CallExpression', callee: { name: 'describe' },
    arguments: [{ start: source.indexOf("'suite'"), end: source.indexOf("'suite'") + 7 }, { type: 'ArrowFunctionExpression', body: { type: 'BlockStatement', body } }] } }] } };
}

test('suite holdouts retain new regressions and leave source inputs intact', () => {
  const file = { path: 'test/example.js', before: wrap(old), content: wrap(old + added) };
  const result = splitUnchangedSuiteTest('repair', file, parse);
  assert.ok(result.content.includes(added));
  assert.ok(!result.content.includes(old));
  assert.equal(result.heldUnchanged, true);
  assert.equal(file.content, wrap(old + added));
  assert.deepEqual(splitUnchangedSuiteTest('repair', file, parse), result);
  assert.notEqual(result.originalSha256, result.publicSha256);
});

test('nested describe suites retain new regressions in executable public source', () => {
  const nested = source => {
    const ast = parse(source);
    ast.program.body = [{ expression: { type: 'CallExpression', callee: { name: 'describe' },
      arguments: [{ start: source.indexOf("'suite'"), end: source.indexOf("'suite'") + 7 }, { type: 'FunctionExpression', body: { type: 'BlockStatement', body: ast.program.body } }] } }];
    return ast;
  };
  const file = { path: 'test/nested.js', before: wrap(wrap(old)), content: wrap(wrap(old + added)) };
  const result = splitUnchangedSuiteTest('nested-repair', file, nested);
  const calls = [];
  new Script(result.content).runInNewContext({
    describe: (_name, run) => run(),
    test: (name, run) => { calls.push(name); run(); },
    preserve: () => assert.fail('held-out test executed'),
    verifyLimit: limit => assert.equal(limit, 128),
  });
  assert.deepEqual(calls, ['regression']);
});

test('missing baseline tests, invalid syntax and invalid spans fail closed', () => {
  const file = { path: 'test/example.js', before: wrap(''), content: wrap(old + added) };
  assert.throws(() => splitUnchangedSuiteTest('repair', file, parse), /no_unchanged_nested_holdout/);
  assert.throws(() => splitUnchangedSuiteTest('repair', { ...file, content: '(' }, parse), SyntaxError);
  assert.throws(() => splitUnchangedSuiteTest('', file, parse), /invalid_holdout_id/);
  assert.throws(() => splitUnchangedSuiteTest('repair', { ...file, before: wrap(old), content: wrap(old) }, parse), /no_unchanged_nested_holdout/);
  const badParser = source => { const ast = parse(source); ast.program.body[0].expression.arguments[1].body.body[0].end = source.length + 1; return ast; };
  assert.throws(() => splitUnchangedSuiteTest('repair', { ...file, before: wrap(old) }, badParser), /invalid_test_span/);
});

// Distinct suite contexts may contain byte-identical test statements.
test('new suites and ambiguous duplicate occurrences are never held out', () => {
  const suite = (name, body) => `describe('${name}', () => { ${body} });`;
  const contextual = source => {
    new Script(source);
    return { program: { body: ['new', 'old'].flatMap(name => {
      const title = source.indexOf(`'${name}'`);
      if (title < 0) return [];
      const start = source.indexOf(old, title);
      const children = [];
      const next = source.indexOf('describe(', title);
      const end = next < 0 ? source.length : next;
      for (let at = start; at >= 0 && at < end; at = source.indexOf(old, at + old.length)) {
        children.push({ start: at, end: at + old.length, expression: { type: 'CallExpression', callee: { name: 'test' } } });
      }
      return [{ expression: { type: 'CallExpression', callee: { name: 'describe' }, arguments: [
        { start: title, end: title + name.length + 2 },
        { type: 'ArrowFunctionExpression', body: { type: 'BlockStatement', body: children } },
      ] } }];
    }) } };
  };
  const before = suite('old', old);
  const file = { path: 'test/context.js', before, content: suite('new', old) + before };
  const result = splitUnchangedSuiteTest('context', file, contextual);
  assert.ok(result.content.startsWith(suite('new', old)));
  assert.equal(result.content.split(old).length - 1, 1);
  const duplicate = { ...file, content: suite('old', old + old) };
  assert.throws(() => splitUnchangedSuiteTest('context', duplicate, contextual), /no_unchanged_nested_holdout/);
});
