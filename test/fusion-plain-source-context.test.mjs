import assert from 'node:assert/strict';
import test from 'node:test';
import { plainSourceContext, plainSourceRequest } from '../scripts/fusion-plain-source-context.mjs';

const input = () => ({ task: 'Preserve backslashes and quotes.',
  files: [{ path: 'lib/a.js', sha256: 'a'.repeat(64), content: '1|const s = "\\\\\\\\";\n2|const quote = "\\\"";\n' }],
  publicTests: [{ path: 'test/a.js', content: "assert.equal(s, '\\\\');\n// ```\n" }],
  additionalSource: { instruction: 'Read-only original source.', snippets: [{ path: 'index.js', content: "module.exports = require('./lib/a');\n" }] } });

test('all source bytes remain literal with metadata, task and read-only instructions intact', () => {
  const value = input(), copy = structuredClone(value), text = plainSourceContext(value);
  for (const file of [...value.files, ...value.publicTests, ...value.additionalSource.snippets]) {
    assert.ok(text.includes(file.content)); assert.ok(text.includes(file.path));
  }
  assert.ok(text.includes(value.files[0].sha256));
  assert.ok(text.includes(value.task)); assert.ok(text.includes(value.additionalSource.instruction));
  assert.deepEqual(value, copy);
  const boundary = text.match(/FUSION_SOURCE_[a-f0-9]{64}_*/)[0];
  assert.ok(!JSON.stringify(value).includes(boundary));
  assert.equal(text.split(boundary).length - 1, 6);
});

test('request rendering changes only the user content', () => {
  const request = { id: 'sample', model: 'model', body: { model: 'model', max_output_tokens: 4096,
    text: { format: { type: 'json_schema' } }, input: [{ role: 'system', content: 'Return guarded edits.' },
      { role: 'user', content: JSON.stringify(input()) }] } };
  const before = structuredClone(request), result = plainSourceRequest(request);
  assert.notEqual(result.body.input[1].content, request.body.input[1].content);
  result.body.input[1].content = request.body.input[1].content;
  assert.deepEqual(result, request); assert.deepEqual(request, before);
});

test('unsupported metadata and oversized inputs fail rather than disappear', () => {
  const extra = input(); extra.files[0].hidden = 'must not silently drop';
  assert.throws(() => plainSourceContext(extra), /unexpected_source_context_fields/);
  const long = input(); long.files[0].content = 'x'.repeat(200001);
  assert.throws(() => plainSourceContext(long));
});
