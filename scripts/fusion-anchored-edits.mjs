// Opt-in edits against a frozen source inventory. Callers still verify the result.
import assert from 'node:assert/strict';
import { hash, validateEdits } from './fusion-workloads.mjs';

const linesOf = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export function anchoredSources(task, files) {
  validateEdits(task, files);
  return files.map(({ path, content }) => ({ path, sha256: hash(content),
    content: linesOf(content).map((line, index) => `${index + 1}|${line}`).join('') }));
}

export function createAnchoredEditSchema(task) {
  assert.ok(Array.isArray(task.editPaths) && task.editPaths.length > 0);
  return { type: 'object', required: ['edits'], additionalProperties: false, properties: {
    edits: { type: 'array', minItems: 1, maxItems: 8, items: {
      type: 'object', required: ['path', 'startLine', 'search', 'replace'], additionalProperties: false,
      properties: { path: { type: 'string', enum: [...task.editPaths] },
        startLine: { type: 'integer', minimum: 1 },
        search: { type: 'string', minLength: 1, maxLength: 16000 },
        replace: { type: 'string', maxLength: 16000 } },
    } },
  } };
}

export function applyAnchoredEdits(task, files, expectedDigests, edits, { relocateUniqueSearch = false } = {}) {
  assert.equal(typeof relocateUniqueSearch, 'boolean', 'invalid_anchor_relocation_option');
  validateEdits(task, files);
  assert.ok(expectedDigests && typeof expectedDigests === 'object' && !Array.isArray(expectedDigests), 'invalid_source_digests');
  assert.deepEqual(Object.keys(expectedDigests).sort(), files.map(file => file.path).sort(), 'source_digest_inventory');
  assert.ok(Array.isArray(edits) && edits.length >= 1 && edits.length <= 8, 'invalid_anchored_edits');
  const originals = new Map(files.map(file => {
    assert.equal(hash(file.content), expectedDigests[file.path], 'source_digest_mismatch');
    let offset = 0;
    const starts = linesOf(file.content).map(line => { const start = offset; offset += line.length; return start; });
    return [file.path, { content: file.content, starts }];
  }));
  const grouped = new Map();
  for (const edit of edits) {
    assert.ok(edit && typeof edit === 'object' && !Array.isArray(edit), 'invalid_anchored_edit');
    assert.deepEqual(Object.keys(edit).sort(), ['path', 'replace', 'search', 'startLine'], 'invalid_anchored_edit_keys');
    assert.ok(typeof edit.search === 'string' && edit.search.length > 0 && edit.search.length <= 16000
      && typeof edit.replace === 'string' && edit.replace.length <= 16000, 'invalid_anchored_edit_text');
    const original = originals.get(edit.path);
    assert.ok(original && Number.isSafeInteger(edit.startLine) && edit.startLine >= 1
      && edit.startLine <= original.starts.length, 'invalid_source_anchor');
    let start = original.starts[edit.startLine - 1], end = start + edit.search.length;
    if (relocateUniqueSearch && original.content.slice(start, end) !== edit.search) {
      const found = original.content.indexOf(edit.search);
      assert.ok(found >= 0 && original.content.indexOf(edit.search, found + 1) < 0
        && (found === 0 || original.content[found - 1] === '\n'), 'source_anchor_not_unique');
      start = found;
      end = start + edit.search.length;
    }
    assert.equal(original.content.slice(start, end), edit.search, 'source_anchor_mismatch');
    const group = grouped.get(edit.path) ?? [];
    group.push({ start, end, replace: edit.replace }); grouped.set(edit.path, group);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(edits)) <= 48000, 'edit_payload_too_large');
  // All coordinates refer to the original, never the output of an earlier edit.
  for (const group of grouped.values()) {
    group.sort((a, b) => a.start - b.start);
    for (let i = 1; i < group.length; i++) assert.ok(group[i - 1].end <= group[i].start, 'overlapping_anchored_edits');
  }
  return validateEdits(task, files.map(file => {
    let content = file.content;
    for (const edit of [...(grouped.get(file.path) ?? [])].reverse()) {
      content = content.slice(0, edit.start) + edit.replace + content.slice(edit.end);
    }
    return { path: file.path, content };
  }));
}
