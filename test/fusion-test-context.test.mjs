import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { compactTestContext } from '../scripts/fusion-test-context.mjs';

const old = "test('old', () => checkOld());";
const added = "test('new', () => checkNew());";
const suite = "describe('suite', () => { test('inside', () => checkInside()); });";
const setup = 'const value = 1;';
const changedSetup = 'const value = 2;';
function parse(source) {
  new Script(source);
  const body = [];
  for (const content of [old, added, suite, setup, changedSetup]) {
    let start = source.indexOf(content);
    while (start >= 0) {
      const group = [old, added, suite].includes(content);
      body.push({ type: group ? 'ExpressionStatement' : 'VariableDeclaration', start, end: start + content.length,
        ...(group ? { expression: { type: 'CallExpression', callee: { name: content === suite ? 'describe' : 'test' } } } : {}) });
      start = source.indexOf(content, start + content.length);
    }
  }
  return { program: { body: body.sort((a, b) => a.start - b.start) } };
}
const file = content => ({ path: 'test/example.js', content });

test('prompt compaction keeps changed groups and original verifier inputs', () => {
  const baseline = [file(setup + old + suite)];
  const current = [file(setup + old + suite + added)];
  const [result] = compactTestContext(current, baseline, parse);
  assert.ok(result.content.includes(setup));
  assert.ok(result.content.includes(added));
  assert.ok(!result.content.includes('checkOld'));
  assert.ok(!result.content.includes('checkInside'));
  assert.equal(current[0].content, setup + old + suite + added);
  assert.equal(result.content.match(/all still execute/g).length, 1);
});

test('changed scaffolding preserves tests whose meaning may have changed', () => {
  const current = [file(changedSetup + old)];
  assert.deepEqual(compactTestContext(current, [file(setup + old)], parse), current);
  assert.deepEqual(compactTestContext(current, [], parse), current);
  const moved = [file(setup + old)];
  assert.deepEqual(compactTestContext(moved, [file(old + setup)], parse), moved);
});

test('duplicate additions remain visible and malformed inputs fail closed', () => {
  const [result] = compactTestContext([file(old + old + added)], [file(old)], parse);
  assert.equal(result.content.match(/checkOld/g).length, 1);
  assert.ok(result.content.includes(added));
  assert.throws(() => compactTestContext([file('(')], [], parse), SyntaxError);
  assert.throws(() => compactTestContext([file(old), file(old)], [], parse), /invalid_test_file/);
  const invalid = source => { const ast = parse(source); if (ast.program.body.length) ast.program.body[0].end = source.length + 1; return ast; };
  assert.throws(() => compactTestContext([file(old)], [file(old)], invalid), /invalid_test_span/);
});
