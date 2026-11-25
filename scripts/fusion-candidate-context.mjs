import assert from 'node:assert/strict';

function filesByPath(files) {
  assert.ok(Array.isArray(files), 'candidate_files_required');
  const map = new Map();
  for (const file of files) {
    assert.ok(file && typeof file.path === 'string' && file.path && typeof file.content === 'string' && !map.has(file.path), 'invalid_candidate_file');
    map.set(file.path, file.content);
  }
  return map;
}

// Diagnostic prompt context only. Keep the actual candidate for verification.
export function compactCandidateContext(original, candidate) {
  if (candidate === null) return null;
  const before = filesByPath(original), after = filesByPath(candidate);
  assert.deepEqual([...before.keys()].sort(), [...after.keys()].sort(), 'candidate_path_mismatch');
  const edits = [];
  for (const [path, source] of after) {
    const old = before.get(path);
    if (old === source) continue;
    const a = [...old], b = [...source];
    let prefix = 0, suffix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    edits.push({ path, offsetUtf16: a.slice(0, prefix).join('').length,
      search: a.slice(prefix, a.length - suffix).join(''), replace: b.slice(prefix, b.length - suffix).join('') });
  }
  const compact = { format: 'original-relative-edits-v1', edits };
  return Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(candidate))
    ? compact : structuredClone(candidate);
}
