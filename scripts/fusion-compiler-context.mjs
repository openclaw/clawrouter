// Caller-side data helpers. Generation, budgets and isolated verification remain
// the caller's responsibility; this module does not read files or call models.
const fileBytes = 256 * 1024;
const size = value => Buffer.byteLength(value, 'utf8');

function pathName(path) {
  if (typeof path !== 'string') throw new Error('invalid_compiler_source_path');
  const normalized = path.replaceAll('\\', '/');
  if (normalized.length > 1024 || !normalized.endsWith('.ts') || normalized.startsWith('/')
    || normalized.includes(':') || /[\x00-\x1f\x7f]/.test(normalized)
    || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('invalid_compiler_source_path');
  }
  return normalized;
}

function sourceFiles(files, countLimit, byteLimit) {
  if (!Array.isArray(files) || files.length > countLimit) throw new Error('invalid_compiler_source_files');
  const found = new Map(); let bytes = 0;
  for (const file of files) {
    if (!file || typeof file.content !== 'string' || size(file.content) > fileBytes) throw new Error('invalid_compiler_source_file');
    const path = pathName(file.path); bytes += size(file.content);
    if (found.has(path) || bytes > byteLimit) throw new Error('invalid_compiler_source_files');
    found.set(path, { path, content: file.content });
  }
  return found;
}

/** Build a small, serializable payload for a compiler-only model repair. */
export function createCompilerRepairContext({ files, diagnostics, referenceFiles = [] }) {
  const sources = sourceFiles(files, 64, 1024 * 1024);
  const references = sourceFiles(referenceFiles, 32, 48 * 1024);
  if (typeof diagnostics !== 'string' || !diagnostics.trim() || size(diagnostics) > 12 * 1024) {
    throw new Error('invalid_compiler_diagnostics');
  }
  const paths = new Set();
  for (const line of diagnostics.trimEnd().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(.+?)\(([1-9]\d*),([1-9]\d*)\): error TS\d+: .+$/.exec(line);
    if (!match) {
      if (/^\s/.test(line)) continue;
      throw new Error('unsupported_compiler_diagnostic');
    }
    const path = pathName(match[1]), source = sources.get(path), row = Number(match[2]), column = Number(match[3]);
    if (!source || !Number.isSafeInteger(row) || !Number.isSafeInteger(column) || row > source.content.split('\n').length) {
      throw new Error('compiler_diagnostic_outside_source');
    }
    paths.add(path);
  }
  if (!paths.size || paths.size > 8) throw new Error('invalid_compiler_diagnostic_scope');
  for (const path of references.keys()) if (paths.has(path)) throw new Error('duplicate_compiler_reference_source');
  const freezeFiles = values => Object.freeze([...values].map(file => Object.freeze({ ...file })));
  return Object.freeze({
    instruction: 'Fix only the reported TypeScript compiler errors in the current saved source. Preserve runtime behavior and public interfaces. Use precise types or valid narrowing; do not disable checks. Return replacements only for editableFiles.',
    diagnostics,
    editableFiles: freezeFiles([...sources.values()].filter(file => paths.has(file.path))),
    referenceFiles: freezeFiles(references.values()),
  });
}

/** Merge model output only into the diagnosed files at their original content. */
export function applyCompilerRepairs({ context, files, replacements }) {
  const original = sourceFiles(files, 64, 1024 * 1024);
  const expected = sourceFiles(context?.editableFiles, 8, 1024 * 1024);
  const updates = sourceFiles(replacements, 8, 1024 * 1024);
  if (!expected.size || !updates.size) throw new Error('empty_compiler_repair');
  for (const [path, file] of expected) if (original.get(path)?.content !== file.content) throw new Error('stale_compiler_repair');
  for (const path of updates.keys()) if (!expected.has(path)) throw new Error('compiler_repair_outside_scope');
  return [...original.values()].map(file => ({ ...(updates.get(file.path) ?? file) }));
}
