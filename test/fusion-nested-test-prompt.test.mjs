import assert from 'node:assert/strict';
import test from 'node:test';
import { compactNestedTestContext } from '../scripts/fusion-nested-test-prompt.mjs';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/fusion-nested-prompt-ast.json', import.meta.url), 'utf8'));
const trees = new Map(fixture.cases.map(row => [row.source, row.ast]));
function parse(source) {
  new Script(source);
  const ast = trees.get(source);
  if (ast) return structuredClone(ast);
  // The final parse only validates generated syntax; its AST is not inspected.
  if (source.includes('Unchanged public groups omitted from prompt only; all still execute.')) return { program: { body: [] } };
  throw new Error('missing AST fixture');
}
const file = content => ({ path: 'test.js', content });
const compact = (before, after) => compactNestedTestContext([file(after)], [file(before)], parse)[0].content;

test('keeps changed nested tests, hooks, comments, setup, and directives', () => {
  const original = `'use strict'; const x = 1; describe('outer', () => {
    beforeEach(() => setup()); // setup stays
    test('old', () => assert.equal(x, 1));
    describe('inner', () => { const y = 2; test('changed', () => assert.equal(y, 2)); test('same', () => same()); });
  });`;
  const after = original.replace('assert.equal(y, 2)', 'assert.equal(y, 3)');
  const output = compact(original, after);
  assert.ok(!output.includes("test('old'"));
  assert.ok(!output.includes("test('same'"));
  for (const text of ["'use strict'", 'const x = 1', 'beforeEach(() => setup())', '// setup stays', 'const y = 2', 'assert.equal(y, 3)']) assert.ok(output.includes(text));
  assert.equal(after.includes("test('old'"), true);
});

test('keeps duplicate identities, dynamic registrations, and changed wrappers', () => {
  const duplicate = "describe('same', () => { test('x', () => x()); }); describe('same', () => { test('x', () => x()); }); test(name, () => x());";
  assert.equal(compact(duplicate, duplicate), duplicate);
  const before = "describe('outer', () => { test('same', () => x()); });";
  const after = before.replace('() => {', 'async () => {');
  assert.equal(compact(before, after), after);
  const timed = "describe('outer', () => { test('same', () => x()); }, 1000);";
  const changedTimeout = timed.replace('1000', '2000');
  assert.equal(compact(timed, changedTimeout), changedTimeout);
});

test('keeps suite wrappers and preserves new files', () => {
  const same = "describe('outer', () => { describe('inner', () => { test('x', () => x()); }); });";
  assert.equal((compact(same, same).match(/omitted from prompt/g) ?? []).length, 1);
  assert.deepEqual(compactNestedTestContext([file(same)], [], parse), [file(same)]);
  assert.throws(() => compactNestedTestContext([file(same), file(same)], [], parse));
});

test('preserves hooks and dynamic registrations inside unchanged suites', () => {
  const same = "describe('outer', () => { beforeEach(setup); test(name, handler); test('static', () => x()); });";
  const result = compact(same, same);
  assert.ok(result.includes("describe('outer'"));
  assert.ok(result.includes('beforeEach(setup)'));
  assert.ok(result.includes('test(name, handler)'));
  assert.ok(!result.includes("test('static'"));
});

test('preserves test parents containing static or dynamic subtests', () => {
  for (const child of ["await t.test(name, handler)", "await t['test']('child', handler)", "test('child', handler)",
    "await test.only('child', handler)", "it.skip('child', handler)", "describe.only('child', handler)",
    "const register = test; await register(name, handler)", "t?.['test']?.(name, handler)"]) {
    const same = `test('parent', async t => { ${child}; });`;
    assert.equal(compact(same, same), same);
  }
});

test('counts duplicate labels across aliases, modifiers, and static templates', () => {
  for (const same of [
    "test('same', a); it('same', b);",
    "test('same', a); test.only('same', b);",
    "test('same', a); test.each([1])('same', b);",
    "test('same', a); test.each`x`('same', b);",
    "test('same', a); test(`same`, b);",
  ]) assert.equal(compact(same, same), same);
});

test('preserves parents containing template property registrations', () => {
  const same = "test('parent', async t => { await t[`test`](name, handler); });";
  assert.equal(compact(same, same), same);
});
