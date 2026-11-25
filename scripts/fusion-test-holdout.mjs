// Partition caller-owned tests without hiding newly added regression requirements.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');

function span(source, node) {
  assert.ok(Number.isSafeInteger(node?.start) && Number.isSafeInteger(node?.end)
    && node.start >= 0 && node.end > node.start && node.end <= source.length, 'invalid_test_span');
  return source.slice(node.start, node.end);
}

function suiteTests(ast, source) {
  const tests = [];
  function visit(body, ancestry = []) {
    for (const node of body ?? []) {
      const call = node.expression;
      if (call?.type !== 'CallExpression') continue;
      if (call.callee?.name === 'describe') {
        const fn = call.arguments.find(arg => ['ArrowFunctionExpression', 'FunctionExpression'].includes(arg.type));
        if (fn?.body?.type === 'BlockStatement') {
          visit(fn.body.body, [...ancestry, span(source, call.arguments[0])]);
        }
      } else if (ancestry.length && ['test', 'it'].includes(call.callee?.name)) {
        tests.push({ node, key: JSON.stringify([...ancestry, span(source, node)]) });
      }
    }
  }
  visit(ast.program.body);
  return tests;
}

export function splitUnchangedSuiteTest(id, file, parse) {
  assert.ok(typeof id === 'string' && id.length > 0, 'invalid_holdout_id');
  assert.ok(file && typeof file.path === 'string' && typeof file.content === 'string'
    && typeof file.before === 'string' && typeof parse === 'function', 'invalid_holdout_input');
  const original = suiteTests(parse(file.before, file.path), file.before);
  const candidates = suiteTests(parse(file.content, file.path), file.content);
  const counts = rows => {
    const result = new Map();
    for (const { key } of rows) result.set(key, (result.get(key) ?? 0) + 1);
    return result;
  };
  const beforeCounts = counts(original), afterCounts = counts(candidates);
  const unchanged = candidates.filter(({ key }) => beforeCounts.get(key) === 1 && afterCounts.get(key) === 1);
  assert.ok(candidates.length > 1 && unchanged.length > 0, 'no_unchanged_nested_holdout');
  const held = unchanged.map(({ node: n }) => ({ n, rank: hash(`nested-public-v1:${id}:${file.path}:${span(file.content, n)}`) }))
    .sort((a, b) => a.rank.localeCompare(b.rank))[0].n;
  const content = file.content.slice(0, held.start) + '\n// Frozen final-only baseline test.\n' + file.content.slice(held.end);
  parse(content, file.path);
  return { path: file.path, content, originalSha256: hash(file.content), publicSha256: hash(content),
    heldOutGroup: hash(span(file.content, held)), heldUnchanged: true, selection: 'unchanged-suite-child' };
}
