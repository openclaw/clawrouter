import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const contextName = '__fusionClockTest';
const timeName = '__fusionFixedNow';

// Explicit fixture preparation only. Never rewrite a live or frozen study.
export function freezeNodeTestClock(file, { title, sourceSha256, parse }) {
  assert.ok(file && typeof file.path === 'string' && typeof file.content === 'string');
  assert.ok(typeof title === 'string' && title.length > 0 && title.length <= 256 && !/[\r\n\x00-\x1f]/.test(title));
  assert.match(sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(hash(file.content), sourceSha256, 'clock_fixture_source_mismatch');
  assert.ok(!file.content.includes(contextName) && !file.content.includes(timeName), 'clock_fixture_identifier_collision');
  assert.equal(typeof parse, 'function', 'clock_fixture_parser_required');
  const ast = parse(file.content, file.path);
  assert.ok(ast && (ast.type === 'File' || ast.type === 'Program'), 'clock_fixture_invalid_ast');
  assert.ok(!ast.errors?.length, 'clock_fixture_invalid_ast');
  const matches = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ExpressionStatement') {
      const call = node.expression;
      if (call?.type === 'CallExpression' && call.callee?.type === 'Identifier' && call.callee.name === 'test'
        && ['StringLiteral', 'Literal'].includes(call.arguments?.[0]?.type) && call.arguments[0].value === title) {
        matches.push(call);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'extra'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  assert.equal(matches.length, 1, 'clock_fixture_requires_one_supported_test');
  const call = matches[0], callbackNode = call.arguments[1];
  assert.ok(call.arguments.length === 2 && callbackNode?.type === 'ArrowFunctionExpression'
    && callbackNode.async === true && callbackNode.params.length === 0
    && callbackNode.body?.type === 'BlockStatement', 'clock_fixture_requires_one_supported_test');
  const index = call.start, callbackStart = callbackNode.start, bodyStart = callbackNode.body.start;
  assert.ok([index, callbackStart, bodyStart].every(Number.isSafeInteger)
    && index >= 0 && callbackStart > index && bodyStart > callbackStart && bodyStart < file.content.length,
  'clock_fixture_invalid_ast');
  assert.equal(file.content.slice(callbackStart, bodyStart + 1), 'async () => {', 'clock_fixture_requires_one_supported_test');
  const needle = file.content.slice(index, bodyStart + 1);
  const indent = file.content.slice(file.content.lastIndexOf('\n', index) + 1, index);
  assert.match(indent, /^[\t ]*$/, 'clock_fixture_requires_standalone_registration');
  const callback = 'async () => {';
  const replacement = needle.slice(0, -callback.length) + `async (${contextName}) => {`
    + `\n${indent}  const ${timeName} = Date.now();`
    + `\n${indent}  ${contextName}.mock.method(Date, 'now', () => ${timeName});\n`;
  const content = file.content.slice(0, index) + replacement + file.content.slice(index + needle.length);
  return { file: { ...file, content }, evidence: { policy: 'node-test-frozen-date-now-v1',
    path: file.path, title, sourceSha256, fixtureSha256: hash(content) } };
}
