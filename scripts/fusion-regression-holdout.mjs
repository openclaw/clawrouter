import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

function inventory(content, path, parse) {
  const leaves = [], identities = new Set();
  function visit(nodes, parents = []) {
    for (const node of nodes) {
      const call = node.expression;
      if (call?.type !== 'CallExpression' || !['describe', 'it', 'test'].includes(call.callee?.name)) continue;
      const [name, fn] = call.arguments;
      assert.ok(call.arguments.length === 2 && name?.type === 'StringLiteral'
        && ['FunctionExpression', 'ArrowFunctionExpression'].includes(fn?.type)
        && fn.body?.type === 'BlockStatement', 'unsupported_regression_registration');
      const names = [...parents, name.value];
      if (call.callee.name === 'describe') visit(fn.body.body, names);
      else {
        assert.ok(Number.isSafeInteger(node.start) && Number.isSafeInteger(node.end)
          && node.start >= 0 && node.end > node.start && node.end <= content.length, 'invalid_regression_span');
        const key = JSON.stringify(names);
        assert.ok(!identities.has(key), 'duplicate_regression_identity');
        identities.add(key);
        leaves.push({ key, start: node.start, end: node.end, text: content.slice(node.start, node.end) });
      }
    }
  }
  visit(parse(content, path).program.body);
  return leaves;
}

function without(content, leaves) {
  return [...leaves].sort((a, b) => b.start - a.start).reduce((text, leaf) =>
    text.slice(0, leaf.start) + '\n// Withheld test group.\n' + text.slice(leaf.end), content);
}

// Changed source is a selection signal, not proof of a regression. Qualify the
// three views against both implementations before sending a public request.
export function splitRegressionSuiteTest(id, file, parse) {
  assert.ok(typeof id === 'string' && id.length > 0, 'invalid_holdout_id');
  assert.ok(file && typeof file.path === 'string' && file.path.length > 0
    && typeof file.content === 'string' && typeof file.before === 'string'
    && typeof parse === 'function', 'invalid_holdout_input');
  const before = new Map(inventory(file.before, file.path, parse).map(leaf => [leaf.key, leaf.text]));
  const full = inventory(file.content, file.path, parse);
  const changed = full.filter(leaf => before.get(leaf.key) !== leaf.text);
  assert.ok(changed.length >= 2, 'two_changed_regression_groups_required');
  const held = changed.map(leaf => ({ ...leaf,
    rank: hash(`regression-holdout-v1:${id}:${file.path}:${leaf.key}:${leaf.text}`) }))
    .sort((a, b) => a.rank.localeCompare(b.rank))[0];
  const content = without(file.content, [held]);
  const hiddenContent = without(file.content, full.filter(leaf => leaf.key !== held.key));
  const publicLeaves = inventory(content, file.path, parse);
  const hiddenLeaves = inventory(hiddenContent, file.path, parse);
  assert.equal(publicLeaves.length, full.length - 1, 'public_regression_inventory_changed');
  assert.ok(!publicLeaves.some(leaf => leaf.key === held.key), 'hidden_regression_remains_public');
  assert.equal(hiddenLeaves.length, 1, 'hidden_regression_inventory_changed');
  assert.equal(hiddenLeaves[0].key, held.key, 'hidden_regression_identity_changed');
  return { path: file.path, content, hiddenContent,
    originalSha256: hash(file.content), publicSha256: hash(content), hiddenSha256: hash(hiddenContent),
    heldOutGroup: hash(held.text), heldUnchanged: false, selection: 'changed-suite-child-v1',
    expectedFull: full.length, expectedPublic: publicLeaves.length, expectedHidden: 1 };
}

// These are caller-owned complete native receipts, never model verdicts.
// Test-source digests bind each receipt to its exact frozen view.
export function qualifyRegressionHoldout(split, { reference, baseline }) {
  if (!split || split.selection !== 'changed-suite-child-v1' || split.heldUnchanged !== false) return false;
  const views = [
    ['full', 'originalSha256', 'expectedFull'],
    ['public', 'publicSha256', 'expectedPublic'],
    ['hidden', 'hiddenSha256', 'expectedHidden'],
  ];
  if (split.expectedFull !== split.expectedPublic + 1 || split.expectedHidden !== 1) return false;
  for (const [view, digest, count] of views) {
    if (!Number.isSafeInteger(split[count]) || split[count] < 1
      || !/^[a-f0-9]{64}$/.test(split[digest])) return false;
    for (const [receipts, passed] of [[reference, true], [baseline, false]]) {
      const row = receipts?.[view];
      if (!row || row.testsSha256 !== split[digest] || row.valid !== true || row.passed !== passed
        || row.assertions !== split[count] || row.skipped !== 0 || row.cancelled !== 0
        || !Number.isSafeInteger(row.failedAssertions) || row.failedAssertions < 0
        || row.failedAssertions > row.assertions || (row.failedAssertions === 0) !== passed) return false;
    }
  }
  return true;
}
