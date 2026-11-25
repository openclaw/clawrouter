import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const contextName = '__fusionClockTest';
const timeName = '__fusionFixedNow';

// Explicit fixture preparation only. Never rewrite a live or frozen study.
export function freezeNodeTestClock(file, { title, sourceSha256 }) {
  assert.ok(file && typeof file.path === 'string' && typeof file.content === 'string');
  assert.ok(typeof title === 'string' && title.length > 0 && title.length <= 256 && !/[\r\n\x00-\x1f]/.test(title));
  assert.match(sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(hash(file.content), sourceSha256, 'clock_fixture_source_mismatch');
  assert.ok(!file.content.includes(contextName) && !file.content.includes(timeName), 'clock_fixture_identifier_collision');
  const single = "'" + title.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
  const candidates = [...new Set([single, JSON.stringify(title)])].map(value => `test(${value}, async () => {`);
  const matches = [];
  for (const needle of candidates) {
    let start = 0, index;
    while ((index = file.content.indexOf(needle, start)) !== -1) {
      matches.push({ needle, index }); start = index + needle.length;
    }
  }
  assert.equal(matches.length, 1, 'clock_fixture_requires_one_supported_test');
  const { needle, index } = matches[0];
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
