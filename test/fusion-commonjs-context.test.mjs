import assert from 'node:assert/strict';
import test from 'node:test';
import { commonJsFunctionContext } from '../scripts/fusion-commonjs-context.mjs';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/fusion-commonjs-context-ast.json', import.meta.url), 'utf8'));
const trees = new Map(fixture.cases.map(row => [row.source, row.ast]));
function parse(source) {
  assert.ok(trees.has(source), 'missing AST fixture');
  return structuredClone(trees.get(source));
}
const source = "function copy(value) { return JSON.parse(JSON.stringify(value)) }\nfunction unused() {}\nmodule.exports = { deepClone: copy, unused };";
const file = content => ({ path: 'lib/dispatcher/agent.js', content });
const options = extra => ({ parse, readSource: path => path === 'lib/core/util.js' ? source : null, ...extra });

test('extracts exact exported function source from namespace and named aliases', () => {
  const input = [file("const util = require('../core/util'); util.deepClone(value); const { deepClone: clone } = require('../core/util'); clone(value)")];
  const original = structuredClone(input), reads = [];
  const result = commonJsFunctionContext(input, options({ readSource: path => { reads.push(path); return source; } }));
  assert.deepEqual(reads, ['lib/core/util.js']);
  assert.deepEqual(result.declarations, [{ path: 'lib/core/util.js', name: 'deepClone', content: source.split('\n')[0] }]);
  assert.equal(result.bytes, Buffer.byteLength(source.split('\n')[0]));
  assert.deepEqual(input, original);
});

test('skips dynamic imports, computed names, escaped roots, and shadowed bindings', () => {
  for (const text of [
    "const util = require('../core/util'); function f(util) { return util.deepClone(x) }",
    "const util = require('../core/util'); const object = { f(util) { return util.deepClone(x) } };",
    "const util = require('../core/util'); util[name](x)",
    "const util = require(path); util.deepClone(x)",
    "const util = require('../../../outside'); util.deepClone(x)",
    "const util = require('../core/util'); function require() {} util.deepClone(x)",
  ]) {
    const result = commonJsFunctionContext([file(text)], options({ readSource: () => assert.fail('unexpected read') }));
    assert.deepEqual(result.declarations, []);
  }
});

test('enforces whole declaration budgets, explicit exports, and read failures', () => {
  const files = [file("const util = require('../core/util'); util.deepClone(x); util.missing(x)")];
  const bounded = commonJsFunctionContext(files, options({ maxBytes: 1 }));
  assert.deepEqual(bounded.declarations, []);
  assert.equal(bounded.omitted.length, 2);
  const hidden = commonJsFunctionContext(files, options({ readSource: () => 'function deepClone(x) { return x }' }));
  assert.deepEqual(hidden.declarations, []);
  assert.throws(() => commonJsFunctionContext(files, options({ readSource: () => { throw Error('read failed'); } })), /read failed/);
  assert.throws(() => commonJsFunctionContext(files, options({ maxDeclarations: 0 })));
  assert.throws(() => commonJsFunctionContext([...files, ...files], options()));
});
