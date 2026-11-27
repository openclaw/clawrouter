import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { externalTaskBrief, TASK_BRIEF_REVISION } from '../scripts/fusion-task-brief.mjs';

const source = body => ({ title: 'Cancel unused connections', body, url: 'https://github.com/example/library/pull/42' });
test('preserves author requirements while excluding acceptance-test and status sections', () => {
  const input = source('## Problem\nA cancelled attempt holds a slot.\n\n## Changes\nPublish an informational diagnostic, without a connectionError event.\n\n## Tests\n### Diagnostic\nHIDDEN_ASSERTION\n\n## Not covered\nActive connections stay open.\n\n## Status\n- [x] Tested');
  const brief = externalTaskBrief(input);
  assert.match(brief.instruction, /Publish an informational diagnostic/);
  assert.match(brief.instruction, /Active connections stay open/);
  assert.doesNotMatch(brief.instruction, /HIDDEN_ASSERTION|\[x\]/);
  assert.deepEqual(brief.provenance.omittedSections, ['Tests', 'Status']);
  assert.equal(brief.provenance.revision, TASK_BRIEF_REVISION);
  assert.equal(brief.provenance.bodySha256, createHash('sha256').update(input.body).digest('hex'));
  assert.equal(brief.provenance.instructionSha256, createHash('sha256').update(brief.instruction).digest('hex'));
});
test('retains unheaded descriptions and inline API names', () => {
  const brief = externalTaskBrief(source('Keep empty strings in `FormData`.\n\n## Status\nTemplate'));
  assert.equal(brief.instruction, 'Cancel unused connections\n\nKeep empty strings in `FormData`.');
});
test('fenced source and its apparent headings cannot reopen excluded sections', () => {
  const brief = externalTaskBrief(source('Expected behavior.\n```js\n## Changes\nORACLE_SOURCE\n````\n## Tests\n~~~\n## Problem\nHIDDEN_SOURCE\n~~~\n## Scope\nKeep compatibility.'));
  assert.doesNotMatch(brief.instruction, /ORACLE_SOURCE|HIDDEN_SOURCE/);
  assert.match(brief.instruction, /Keep compatibility/);
  assert.equal(brief.provenance.fencedBlocksOmitted, 2);
});
test('strips template comments and preserves input bytes in provenance', () => {
  const input = source('<!-- hidden template -->\r\nExpected behavior.\r\n<!-- unfinished');
  const original = structuredClone(input), brief = externalTaskBrief(input);
  assert.equal(brief.instruction, 'Cancel unused connections\n\nExpected behavior.');
  assert.deepEqual(input, original);
});
test('rejects title-only and placeholder-only tasks rather than silently accepting them', () => {
  for (const body of ['', '## Changes\nN/A\n## Status\n- [x] Tested', '## Tests\nassert(false)']) {
    assert.throws(() => externalTaskBrief(source(body)), /missing_task_brief_narrative/);
  }
});
test('rejects unclosed fences and oversize instructions without truncation', () => {
  assert.throws(() => externalTaskBrief(source('Description\n```js\ncode')), /unclosed_task_brief_fence/);
  assert.throws(() => externalTaskBrief(source('Long description'), { maxBytes: 12 }), /task_brief_too_large/);
  assert.throws(() => externalTaskBrief(source('x'.repeat(262145))), /invalid_task_brief_input/);
});
test('requires a canonical public issue or PR URL and valid bounded text', () => {
  for (const url of ['file:///tmp/task', 'https://github.com/example/library/pull/42?token=secret', 'https://github.com/example/library/blob/main/a', 'https://github.com.evil.test/example/library/pull/42']) {
    assert.throws(() => externalTaskBrief({ ...source('Description'), url }), /invalid_task_brief_input/);
  }
  assert.throws(() => externalTaskBrief(source('Description\0')), /invalid_task_brief_text/);
});
