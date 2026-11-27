import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { localHistoryTaskBrief } from '../scripts/fusion-task-brief.mjs';

const input = { title: 'fix: report invalid ranges', commit: 'a'.repeat(40),
  before: '# Changelog\n\n- Existing behavior.\n',
  after: '# Changelog\n\n- Invalid inputs report the field and accepted range.\n\n- Existing behavior.\n' };

test('local brief retains author requirement and pins actual changelog provenance', () => {
  const result = localHistoryTaskBrief(input);
  assert.equal(result.instruction, input.title + '\n\nInvalid inputs report the field and accepted range.');
  assert.equal(result.provenance.commit, input.commit);
  assert.equal(result.provenance.source, 'CHANGELOG.md');
  assert.equal(result.provenance.afterSha256, createHash('sha256').update(input.after).digest('hex'));
  assert.equal(result.provenance.url, undefined);
});

test('local brief rejects title-only, replacements, and ambiguous multiple entries', () => {
  for (const after of [input.before, input.before.replace('Existing', 'Changed'),
    input.after.replace('\n\n- Existing', '\n\n- Another new behavior.\n\n- Existing'),
    input.after.replace('Invalid inputs report the field and accepted range.', 'New behavior.\n```js\ncode\n```')]) {
    assert.throws(() => localHistoryTaskBrief({ ...input, after }));
  }
  for (const commit of ['HEAD', 'abc', 'a'.repeat(39)]) {
    assert.throws(() => localHistoryTaskBrief({ ...input, commit }), /invalid_local_history_brief_input/);
  }
});

test('local brief permits a single wrapped paragraph at the end and rejects oversized prose', () => {
  const before = '# Changelog\n';
  assert.equal(localHistoryTaskBrief({ ...input, before, after: before + '\n- Report errors\n  with their accepted range.\n' }).instruction,
    input.title + '\n\nReport errors\n  with their accepted range.');
  assert.throws(() => localHistoryTaskBrief({ ...input, after: input.after.replace('Invalid inputs', 'x'.repeat(8192)) }),
    /ambiguous_local_history_narrative/);
});

test('local brief rejects quotes, dividers, and heading underlines as narrative', () => {
  const before = '# Changelog\n';
  for (const entry of ['- > Compatibility note.', '- Report errors.\n> Compatibility note.',
    '- Report errors.\n  > Nested quote.', '- Report errors.\n---\nCompatibility note.',
    '- Report errors.\n***', '- Report errors.\n_ _ _', '- Report errors.\n  ===']) {
    assert.throws(() => localHistoryTaskBrief({ ...input, before, after: before + '\n' + entry + '\n' }),
      /ambiguous_local_history_narrative/, entry);
  }
  const prose = 'Accept values > 0\nand preserve the inline `---` marker.';
  assert.equal(localHistoryTaskBrief({ ...input, before, after: before + '\n- ' + prose + '\n' }).instruction,
    input.title + '\n\n' + prose);
});
