import assert from 'node:assert/strict';
import { posix } from 'node:path';

const sourcePath = path => /^lib\/[A-Za-z0-9_./-]+\.js$/.test(path)
  && !path.split('/').some(part => ['.', '..', 'test', 'tests', '__tests__'].includes(part));
const property = node => node?.type === 'Identifier' ? node.name : node?.type === 'StringLiteral' ? node.value : null;
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'comments', 'extra'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
function names(pattern) {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern.name];
  if (pattern.type === 'AssignmentPattern') return names(pattern.left);
  if (pattern.type === 'RestElement') return names(pattern.argument);
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(names);
  if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap(p => names(p.value ?? p.argument));
  return [];
}

// One-hop, explicitly exported function declarations from the immutable source.
// This does not infer runtime binding or include transitive dependencies.
export function commonJsFunctionContext(files, { parse, readSource, maxBytes = 8192, maxFiles = 8, maxDeclarations = 8 }) {
  assert.equal(typeof parse, 'function'); assert.equal(typeof readSource, 'function');
  for (const [value, limit] of [[maxBytes, 16384], [maxFiles, 16], [maxDeclarations, 16]]) {
    assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= limit, 'context_limit');
  }
  const wanted = new Map(), supplied = new Set(files.map(f => f.path));
  assert.equal(supplied.size, files.length, 'duplicate_source_path');
  for (const file of files) {
    assert.ok(sourcePath(file.path), 'context_source_path');
    const ast = parse(file.content, file.path), counts = new Map();
    const count = pattern => names(pattern).forEach(name => counts.set(name, (counts.get(name) ?? 0) + 1));
    walk(ast, node => {
      if (node.type === 'VariableDeclarator') count(node.id);
      if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'].includes(node.type)) {
        if (node.id) count(node.id);
        node.params.forEach(count);
      }
      if (node.type === 'CatchClause') count(node.param);
      if (node.type === 'ClassDeclaration') count(node.id);
    });
    if (counts.has('require')) continue;
    for (const statement of ast.program.body) {
      if (statement.type !== 'VariableDeclaration') continue;
      for (const declaration of statement.declarations) {
        const call = declaration.init;
        if (call?.type !== 'CallExpression' || call.callee?.name !== 'require'
          || call.arguments.length !== 1 || call.arguments[0].type !== 'StringLiteral') continue;
        const specifier = call.arguments[0].value;
        if (!specifier.startsWith('.')) continue;
        let path = posix.normalize(posix.join(posix.dirname(file.path), specifier));
        if (!posix.extname(path)) path += '.js';
        if (!sourcePath(path) || supplied.has(path)) continue;
        const bindings = new Map();
        if (declaration.id.type === 'Identifier' && counts.get(declaration.id.name) === 1) {
          walk(ast, node => {
            if (node.type === 'MemberExpression' && node.object?.name === declaration.id.name) {
              const name = node.computed ? property(node.property?.type === 'StringLiteral' ? node.property : null) : property(node.property);
              if (name) bindings.set(name, true);
            }
          });
        } else if (declaration.id.type === 'ObjectPattern') {
          for (const p of declaration.id.properties) {
            if (p.type === 'ObjectProperty' && !p.computed && p.value.type === 'Identifier' && counts.get(p.value.name) === 1) {
              const name = property(p.key);
              if (name) bindings.set(name, true);
            }
          }
        }
        for (const name of bindings.keys()) wanted.set(JSON.stringify([path, name]), { path, name });
      }
    }
  }
  const loaded = new Map(), declarations = [], omitted = [];
  let bytes = 0;
  for (const item of [...wanted.values()].sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name))) {
    if (!loaded.has(item.path)) {
      if (loaded.size >= maxFiles) { omitted.push({ ...item, reason: 'file_budget' }); continue; }
      const content = readSource(item.path);
      let entry = null;
      if (typeof content === 'string' && Buffer.byteLength(content) <= 256000) {
        const body = parse(content, item.path).program.body;
        const exports = body.filter(n => n.type === 'ExpressionStatement' && n.expression?.type === 'AssignmentExpression'
          && n.expression.operator === '=' && n.expression.left?.type === 'MemberExpression'
          && n.expression.left.object?.name === 'module' && !n.expression.left.computed
          && n.expression.left.property?.name === 'exports');
        if (exports.length === 1 && exports[0].expression.right.type === 'ObjectExpression') {
          entry = { content, body, exports: exports[0].expression.right.properties };
        }
      }
      loaded.set(item.path, entry);
    }
    const entry = loaded.get(item.path);
    const matches = entry?.exports.filter(p => p.type === 'ObjectProperty' && !p.computed && property(p.key) === item.name && p.value.type === 'Identifier') ?? [];
    const definitions = matches.length === 1 ? entry.body.filter(n => n.type === 'FunctionDeclaration' && n.id?.name === matches[0].value.name) : [];
    if (definitions.length !== 1) { omitted.push({ ...item, reason: 'unsupported_or_unavailable' }); continue; }
    const node = definitions[0], content = entry.content.slice(node.start, node.end), size = Buffer.byteLength(content);
    if (declarations.length >= maxDeclarations || bytes + size > maxBytes) { omitted.push({ ...item, reason: 'declaration_budget' }); continue; }
    declarations.push({ ...item, content }); bytes += size;
  }
  return { declarations, omitted, bytes, reads: loaded.size };
}
