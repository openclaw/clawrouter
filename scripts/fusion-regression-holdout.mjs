import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

function inventory(content, path, parse, suiteWrappers) {
  const leaves = [], identities = new Set();
  function visit(nodes, parents = []) {
    for (const node of nodes) {
      if (node.type === 'BlockStatement') {
        visit(node.body, parents);
        continue;
      }
      const call = node.expression;
      const scope = call?.callee;
      if (call?.type === 'CallExpression' && call.arguments.length === 0
        && ['FunctionExpression', 'ArrowFunctionExpression'].includes(scope?.type)
        && !scope.async && !scope.generator && scope.body?.type === 'BlockStatement') {
        visit(scope.body.body, parents);
        continue;
      }
      const callee = call?.callee?.name;
      if (call?.type !== 'CallExpression' || !['describe', 'it', 'test'].includes(callee) && !suiteWrappers.has(callee)) continue;
      const wrapper = suiteWrappers.has(callee);
      const [name, fn] = call.arguments;
      const literal = name?.type === 'StringLiteral' || wrapper && (name?.type === 'NullLiteral'
        || name?.type === 'Identifier' && name.name === 'undefined');
      assert.ok(call.arguments.length === 2 && literal
        && ['FunctionExpression', 'ArrowFunctionExpression'].includes(fn?.type)
        && fn.body?.type === 'BlockStatement', 'unsupported_regression_registration');
      const identity = wrapper ? [callee, name.type, name.value ?? null] : name.value;
      const names = [...parents, identity];
      if (callee === 'describe' || wrapper) visit(fn.body.body, names);
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

function viewHash(files, field) {
  if (files.length === 1) return hash(files[0][field]);
  return hash(JSON.stringify(files.map(file => ({ path: file.path, content: file[field] }))));
}

// Changed source is a selection signal, not proof of a regression. Qualify the
// three views against both implementations before sending a public request.
export function splitRegressionTests(id, inputs, parse, { suiteWrappers = [] } = {}) {
  assert.ok(typeof id === 'string' && id.length > 0, 'invalid_holdout_id');
  assert.ok(Array.isArray(inputs) && inputs.length > 0 && typeof parse === 'function', 'invalid_holdout_input');
  assert.ok(Array.isArray(suiteWrappers) && suiteWrappers.every(name => typeof name === 'string'
    && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !['describe', 'it', 'test'].includes(name)), 'invalid_suite_wrappers');
  const wrappers = new Set(suiteWrappers);
  const paths = new Set();
  const files = inputs.map(file => {
    assert.ok(file && typeof file.path === 'string' && file.path.length > 0
      && typeof file.content === 'string' && typeof file.before === 'string', 'invalid_holdout_input');
    assert.ok(!paths.has(file.path), 'duplicate_regression_path');
    paths.add(file.path);
    const before = new Map(inventory(file.before, file.path, parse, wrappers).map(leaf => [leaf.key, leaf.text]));
    const full = inventory(file.content, file.path, parse, wrappers);
    return { ...file, full, changed: full.filter(leaf => before.get(leaf.key) !== leaf.text) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const changed = files.flatMap(file => file.changed.map(leaf => ({ ...leaf, path: file.path,
    rank: hash(`regression-holdout-v1:${id}:${file.path}:${leaf.key}:${leaf.text}`) })));
  assert.ok(changed.length >= 2, 'two_changed_regression_groups_required');
  const held = changed.sort((a, b) => a.rank.localeCompare(b.rank))[0];
  const views = files.map(file => {
    const selected = leaf => file.path === held.path && leaf.key === held.key;
    const content = without(file.content, file.full.filter(selected));
    const hiddenContent = without(file.content, file.full.filter(leaf => !selected(leaf)));
    const publicLeaves = inventory(content, file.path, parse, wrappers);
    const hiddenLeaves = inventory(hiddenContent, file.path, parse, wrappers);
    assert.equal(publicLeaves.length, file.full.length - Number(file.path === held.path), 'public_regression_inventory_changed');
    assert.ok(!publicLeaves.some(selected), 'hidden_regression_remains_public');
    assert.equal(hiddenLeaves.length, Number(file.path === held.path), 'hidden_regression_inventory_changed');
    if (hiddenLeaves.length) assert.equal(hiddenLeaves[0].key, held.key, 'hidden_regression_identity_changed');
    return { path: file.path, original: file.content, content, hiddenContent };
  });
  const expectedFull = files.reduce((sum, file) => sum + file.full.length, 0);
  return { files: views.map(({ original, ...file }) => file),
    originalSha256: viewHash(views, 'original'), publicSha256: viewHash(views, 'content'),
    hiddenSha256: viewHash(views, 'hiddenContent'), heldOutGroup: hash(held.text), heldPath: held.path,
    heldUnchanged: false, selection: 'changed-suite-child-v1',
    expectedFull, expectedPublic: expectedFull - 1, expectedHidden: 1 };
}

export function splitRegressionSuiteTest(id, file, parse, options) {
  const { files, ...split } = splitRegressionTests(id, [file], parse, options);
  return { ...files[0], ...split };
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
