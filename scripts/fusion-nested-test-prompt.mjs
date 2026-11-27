import assert from 'node:assert/strict';

function containsRegistration(value) {
  if (!value || typeof value !== 'object') return false;
  // Conservatively retain references too: this covers modifiers, aliases,
  // optional chains and computed properties without classifying call shapes.
  if (value.type === 'Identifier' && ['describe', 'it', 'test'].includes(value.name)) return true;
  if (value.type === 'StringLiteral' && ['describe', 'it', 'test'].includes(value.value)) return true;
  if (value.type === 'TemplateLiteral' && value.expressions.length === 0
    && value.quasis.some(part => ['describe', 'it', 'test'].includes(part.value.cooked))) return true;
  return Object.values(value).some(child => Array.isArray(child)
    ? child.some(containsRegistration) : containsRegistration(child));
}

function registrations(file, parse) {
  const rows = [];
  function visit(body, ancestry) {
    const rootName = call => {
      let callee = call.callee;
      while (callee) {
        if (['MemberExpression', 'OptionalMemberExpression'].includes(callee.type)) callee = callee.object;
        else if (['CallExpression', 'OptionalCallExpression'].includes(callee.type)) callee = callee.callee;
        else if (callee.type === 'TaggedTemplateExpression') callee = callee.tag;
        else break;
      }
      return callee?.type === 'Identifier' ? callee.name : null;
    };
    const label = call => {
      const name = call.arguments[0];
      if (name?.type === 'StringLiteral') return name.value;
      if (name?.type === 'TemplateLiteral' && name.expressions.length === 0) return name.quasis[0]?.value.cooked;
      return null;
    };
    const groups = body.filter(node => node.type === 'ExpressionStatement'
      && ['CallExpression', 'OptionalCallExpression'].includes(node.expression?.type)
      && ['describe', 'it', 'test'].includes(rootName(node.expression)));
    const names = new Map();
    for (const node of groups) {
      const call = node.expression;
      const name = label(call);
      if (typeof name !== 'string') continue;
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    for (const node of groups) {
      const call = node.expression;
      // Modifier calls affect uniqueness but are not omission candidates.
      if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier'
        || call.arguments[0]?.type !== 'StringLiteral') continue;
      const name = label(call);
      if (typeof name !== 'string') continue;
      const key = JSON.stringify([call.callee.name, name]);
      if (names.get(name) !== 1) continue;
      const path = [...ancestry, key];
      assert.ok(Number.isSafeInteger(node.start) && Number.isSafeInteger(node.end)
        && node.start >= 0 && node.end > node.start && node.end <= file.content.length);
      if (call.callee.name !== 'describe') {
        if (call.arguments.some(containsRegistration)) continue;
        rows.push({ key: JSON.stringify(path), start: node.start, end: node.end,
          source: file.content.slice(node.start, node.end) });
        continue;
      }
      const callback = call.arguments.find(argument => ['ArrowFunctionExpression', 'FunctionExpression'].includes(argument.type));
      if (callback?.body?.type !== 'BlockStatement') continue;
      // Include the complete registration header: changed wrappers keep children.
      const header = file.content.slice(node.start, callback.body.start);
      const footer = file.content.slice(callback.body.end, node.end);
      visit(callback.body.body, [...path, header, footer]);
    }
  }
  visit(parse(file.content, file.path).program.body, []);
  return rows;
}

// This is prompt retrieval only. Callers must execute the untouched test files.
export function compactNestedTestContext(files, baseline, parse) {
  assert.equal(typeof parse, 'function');
  const originals = new Map(baseline.map(file => [file.path, file]));
  assert.equal(originals.size, baseline.length, 'duplicate_baseline_path');
  assert.equal(new Set(files.map(file => file.path)).size, files.length, 'duplicate_test_path');
  return files.map(file => {
    const before = originals.get(file.path);
    if (!before) return { ...file };
    const old = new Map(registrations(before, parse).map(row => [row.key, row.source]));
    const same = registrations(file, parse).filter(row => old.get(row.key) === row.source);
    const omit = same.filter(row => !same.some(parent => parent.start < row.start && parent.end > row.end));
    let content = file.content;
    for (const [index, row] of omit.sort((a, b) => b.start - a.start).entries()) {
      const marker = index === omit.length - 1
        ? '; /* Unchanged public groups omitted from prompt only; all still execute. */' : ';';
      content = content.slice(0, row.start) + marker + content.slice(row.end);
    }
    parse(content, file.path);
    return { ...file, content };
  });
}
