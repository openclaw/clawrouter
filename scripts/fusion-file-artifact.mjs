// Caller-side source artifacts; no provider calls or file writes.
import assert from 'node:assert/strict';

export function replacementPaths(task) {
  const paths = task?.editPaths;
  assert.ok(Array.isArray(paths) && paths.length > 0 && paths.length <= 4
    && new Set(paths).size === paths.length, 'invalid_replacement_paths');
  for (const path of paths) assert.ok(typeof path === 'string'
    && /^(worker|shared|scripts)\/[A-Za-z0-9_./-]+\.(ts|mjs)$/.test(path)
    && !path.split('/').some(p => !p || p === '.' || p === '..' || /^(?:tests?|__tests__)$/i.test(p))
    && !/\.(?:test|spec)\./i.test(path), 'invalid_replacement_path');
  return [...paths];
}

export function normalizeReplacements(task, files) {
  const paths = replacementPaths(task);
  assert.ok(Array.isArray(files) && files.length === paths.length, 'incomplete_replacements');
  const byPath = new Map(); let bytes = 0;
  for (const file of files) {
    assert.ok(file && typeof file === 'object' && !Array.isArray(file), 'invalid_replacement');
    assert.deepEqual(Object.keys(file).sort(), ['content', 'path']);
    assert.ok(paths.includes(file.path) && !byPath.has(file.path), 'unexpected_replacement_path');
    assert.equal(typeof file.content, 'string');
    bytes += Buffer.byteLength(file.content);
    assert.ok(bytes <= 65536, 'replacement_bytes');
    byPath.set(file.path, { path: file.path, content: file.content });
  }
  return paths.map(path => byPath.get(path));
}

export function parseFileArtifact(task, value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'invalid_file_artifact');
  assert.deepEqual(Object.keys(value), ['files']);
  return { files: normalizeReplacements(task, value.files) };
}

export function fileArtifactSchema(task) {
  const paths = replacementPaths(task);
  return { type: 'object', additionalProperties: false, required: ['files'], properties: {
    files: { type: 'array', minItems: paths.length, maxItems: paths.length,
      items: { type: 'object', additionalProperties: false, required: ['path', 'content'],
        properties: { path: { type: 'string', enum: paths }, content: { type: 'string' } } } },
  } };
}
