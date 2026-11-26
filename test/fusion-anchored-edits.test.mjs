import assert from 'node:assert/strict';
import test from 'node:test';
import { anchoredSources, applyAnchoredEdits, createAnchoredEditSchema } from '../scripts/fusion-anchored-edits.mjs';
import { hash } from '../scripts/fusion-workloads.mjs';

const task = { editPaths: ['src/a.js', 'src/b.js'] };
const files = [{ path: 'src/a.js', content: 'same();\nkeep();\nsame();\n' }, { path: 'src/b.js', content: 'unchanged();\n' }];
const digests = source => Object.fromEntries(source.map(file => [file.path, hash(file.content)]));
const edit = (startLine, search, replace = 'fixed();\n') => ({ path: 'src/a.js', startLine, search, replace });

test('anchors distinguish identical snippets without changing other files', () => {
  const result = applyAnchoredEdits(task, files, digests(files), [edit(3, 'same();\n')]);
  assert.equal(result[0].content, 'same();\nkeep();\nfixed();\n');
  assert.deepEqual(result[1], files[1]);
  assert.equal(files[0].content, 'same();\nkeep();\nsame();\n');
  assert.deepEqual(anchoredSources(task, files)[0], { path: 'src/a.js', sha256: hash(files[0].content),
    content: '1|same();\n2|keep();\n3|same();\n' });
});

test('adjacent edits use frozen positions even when a replacement changes line count', () => {
  const result = applyAnchoredEdits(task, files, digests(files), [edit(2, 'keep();\n', ''), edit(1, 'same();\n', 'one();\ntwo();\n')]);
  assert.equal(result[0].content, 'one();\ntwo();\nsame();\n');
});

test('preserves CRLF, unicode and the final line without a newline', () => {
  const source = [{ path: 'src/a.js', content: '😀();\r\nsame();\r\nsame();' }];
  assert.equal(applyAnchoredEdits(task, source, digests(source), [edit(3, 'same();', 'last();')])[0].content,
    '😀();\r\nsame();\r\nlast();');
});

test('rejects stale inventory, wrong line and text mismatch without guessing', () => {
  assert.throws(() => applyAnchoredEdits(task, files, { ...digests(files), 'src/a.js': hash('stale') }, [edit(3, 'same();\n')]), /source_digest_mismatch/);
  assert.throws(() => applyAnchoredEdits(task, files, {}, [edit(3, 'same();\n')]), /source_digest_inventory/);
  for (const start of [0, 4, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => applyAnchoredEdits(task, files, digests(files), [edit(start, 'same();\n')]), /invalid_source_anchor/);
  }
  assert.throws(() => applyAnchoredEdits(task, files, digests(files), [edit(2, 'same();\n')]), /source_anchor_mismatch/);
  assert.throws(() => applyAnchoredEdits(task, files, digests(files), [edit(1, 'ame();')]), /source_anchor_mismatch/);
});

test('rejects overlapping or repeated ranges atomically', () => {
  const before = structuredClone(files);
  for (const edits of [[edit(1, 'same();\nkeep();\n'), edit(2, 'keep();\n')], [edit(3, 'same();\n'), edit(3, 'same();\n')]]) {
    assert.throws(() => applyAnchoredEdits(task, files, digests(files), edits), /overlapping_anchored_edits/);
    assert.deepEqual(files, before);
  }
  assert.throws(() => applyAnchoredEdits(task, files, digests(files), [edit(1, 'same();\n'), edit(2, 'missing')]), /source_anchor_mismatch/);
  assert.deepEqual(files, before);
});

test('enforces declared paths and bounded structured output', () => {
  const good = edit(1, 'same();\n');
  for (const edits of [[], Array(9).fill(good), [null], [{ ...good, extra: true }], [{ ...good, search: '' }],
    [{ ...good, path: 'test/a.js' }], [{ ...good, replace: 'x'.repeat(16001) }]]) {
    assert.throws(() => applyAnchoredEdits(task, files, digests(files), edits));
  }
  const schema = createAnchoredEditSchema(task);
  assert.deepEqual(schema.properties.edits.items.properties.path.enum, task.editPaths);
  assert.equal(schema.properties.edits.items.additionalProperties, false);
  assert.throws(() => anchoredSources(task, [{ path: 'test/a.js', content: '' }]));
});

test('opt-in relocation requires a unique exact search at a line boundary', () => {
  const edits = [edit(1, 'keep();\n')];
  assert.throws(() => applyAnchoredEdits(task, files, digests(files), edits), /source_anchor_mismatch/);
  const result = applyAnchoredEdits(task, files, digests(files), edits, { relocateUniqueSearch: true });
  assert.equal(result[0].content, 'same();\nfixed();\nsame();\n');
  assert.equal(edits[0].startLine, 1);
  for (const search of ['same();\n', 'eep();\n', 'missing();\n']) {
    assert.throws(() => applyAnchoredEdits(task, files, digests(files), [edit(2, search)],
      { relocateUniqueSearch: true }), /source_anchor_not_unique/);
  }
});

test('relocation retains hash, overlap and explicit duplicate-anchor protections', () => {
  const options = { relocateUniqueSearch: true };
  assert.throws(() => applyAnchoredEdits(task, files, { ...digests(files), 'src/a.js': hash('stale') },
    [edit(1, 'keep();\n')], options), /source_digest_mismatch/);
  assert.throws(() => applyAnchoredEdits(task, files, digests(files),
    [edit(1, 'keep();\n'), edit(2, 'keep();\n')], options), /overlapping_anchored_edits/);
  assert.equal(applyAnchoredEdits(task, files, digests(files), [edit(3, 'same();\n')], options)[0].content,
    'same();\nkeep();\nfixed();\n');
  assert.throws(() => applyAnchoredEdits(task, files, digests(files), [], { relocateUniqueSearch: 'yes' }), /invalid_anchor_relocation_option/);
});

test('relocation preserves unicode, CRLF and an unterminated final line', () => {
  const source = [{ path: 'src/a.js', content: '😀();\r\nkeep();\r\nlast();' }];
  const result = applyAnchoredEdits(task, source, digests(source),
    [edit(1, 'last();', 'done();')], { relocateUniqueSearch: true });
  assert.equal(result[0].content, '😀();\r\nkeep();\r\ndone();');
});
