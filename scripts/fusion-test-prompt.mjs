import assert from 'node:assert/strict';

const registration = node => node.type === 'ExpressionStatement'
  && node.expression?.type === 'CallExpression'
  && ['test', 'it', 'describe'].includes(node.expression.callee?.name);

function statements(file, parse) {
  const program = parse(file.content, file.path).program;
  assert.ok(Array.isArray(program.body), 'invalid_test_ast');
  const nodes = [...(program.interpreter ? [program.interpreter] : []), ...(program.directives ?? []), ...program.body];
  const rows = [], ordered = nodes.sort((a, b) => a.start - b.start);
  let end = 0;
  const gap = until => {
    const content = file.content.slice(end, until).trim();
    if (content) rows.push({ content, group: false });
  };
  for (const node of ordered) {
    assert.ok(Number.isSafeInteger(node.start) && Number.isSafeInteger(node.end)
      && node.start >= end && node.end > node.start && node.end <= file.content.length, 'invalid_test_span');
    gap(node.start);
    rows.push({ node, content: file.content.slice(node.start, node.end), group: registration(node) });
    end = node.end;
  }
  gap(file.content.length);
  return rows;
}

function fileMap(files) {
  assert.ok(Array.isArray(files), 'invalid_test_files');
  const map = new Map();
  for (const file of files) {
    assert.ok(file && typeof file.path === 'string' && file.path.length > 0
      && typeof file.content === 'string' && !map.has(file.path), 'invalid_test_file');
    map.set(file.path, file);
  }
  return map;
}

// Return prompt context only. Verification must keep the original file bytes.
export function compactTestContext(files, baseline, parse) {
  assert.equal(typeof parse, 'function', 'test_parser_required');
  const originals = fileMap(baseline);
  return [...fileMap(files).values()].map(file => {
    const current = statements(file, parse);
    const original = statements(originals.get(file.path) ?? { ...file, content: '' }, parse);
    const counts = new Map();
    for (const row of original.filter(row => row.group)) counts.set(row.content, (counts.get(row.content) ?? 0) + 1);
    const available = new Map();
    for (const row of current.filter(row => row.group)) available.set(row.content, (available.get(row.content) ?? 0) + 1);
    const shared = new Map([...counts].map(([source, count]) => [source, Math.min(count, available.get(source) ?? 0)]));
    // Preserve setup text and its position relative to shared registrations.
    // New/removed groups are not anchors, so ordinary new tests still compact.
    const scaffolding = rows => {
      const remaining = new Map(shared), sequence = [];
      for (const row of rows) {
        const count = remaining.get(row.content) ?? 0;
        if (!row.group) sequence.push(['setup', row.content]);
        else if (count) { sequence.push(['group', row.content]); remaining.set(row.content, count - 1); }
      }
      return sequence;
    };
    if (JSON.stringify(scaffolding(current)) !== JSON.stringify(scaffolding(original))) return { ...file };
    const omitted = current.filter(row => {
      const count = row.group ? counts.get(row.content) ?? 0 : 0;
      if (!count) return false;
      counts.set(row.content, count - 1);
      return true;
    }).reverse();
    let content = file.content;
    for (const [index, { node }] of omitted.entries()) {
      const marker = index === omitted.length - 1
        ? '\n// Unchanged baseline tests omitted from prompt only; all still execute.\n;' : ';';
      content = content.slice(0, node.start) + marker + content.slice(node.end);
    }
    parse(content, file.path);
    return { ...file, content };
  });
}
