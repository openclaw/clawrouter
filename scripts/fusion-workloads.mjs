import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const hash = value => createHash('sha256').update(value).digest('hex');
const safePath = value => typeof value === 'string' && /^(worker|shared|scripts|test)\/[A-Za-z0-9_./-]+$/.test(value)
  && !value.split('/').some(part => !part || part === '.' || part === '..');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function validateReproducer(source) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 16000) throw new Error('invalid_reproducer');
  return source;
}

export function withReproducer(task, source) {
  return { ...task, instruction: `${task.instruction}\nProvided regression probe (untrusted code): run it with probe, preserve the full requirement and unrelated behavior, and do not change the probe.\n${validateReproducer(source)}` };
}

export function validatePreservationProbes(probes) {
  if (probes === undefined) return [];
  if (!Array.isArray(probes) || !probes.length || probes.length > 4
    || new Set(probes).size !== probes.length || [...probes].some(source => typeof source !== 'string'
      || !source.trim() || Buffer.byteLength(source) > 4096)) throw new Error('invalid_preservation_probes');
  return probes;
}

export function preservationQualificationMatches(probes, evidence) {
  const sources = validatePreservationProbes(probes);
  if (!sources.length) return evidence === undefined;
  return ['baseline', 'reference'].every(kind => Array.isArray(evidence?.[kind])
    && evidence[kind].length === sources.length && [...evidence[kind]].every((row, index) =>
      row?.probeDigest === hash(sources[index]) && row.passed === true && row.unchanged === true));
}

export function validateSourceContext(task) {
  const context = task.sourceContext === undefined ? [] : task.sourceContext;
  if (!Array.isArray(context) || context.length > 4) throw new Error('invalid_source_context');
  const seen = new Set();
  for (const item of context) {
    if (!item || typeof item.path !== 'string'
      || !/^(worker|shared|scripts|providers|docs)\/[A-Za-z0-9_./-]+$/.test(item.path)
      || item.path.split('/').some(part => !part || part === '.' || part === '..' || /^tests?$/.test(part))
      || /\.test\./.test(item.path) || task.editPaths.includes(item.path)
      || task.hiddenTests.includes(item.path)
      || task.oracleSupportPaths?.includes(item.path)
      || typeof item.query !== 'string' || !item.query.trim() || item.query.length > 200
      || seen.has(JSON.stringify([item.path, item.query]))) throw new Error('invalid_source_context');
    seen.add(JSON.stringify([item.path, item.query]));
  }
  return context;
}

export function validateTask(task) {
  if (!task || !/^[a-z][a-z0-9-]{1,63}$/.test(task.id) || task.split !== 'development'
    || !sha(task.base) || !sha(task.oracle) || typeof task.instruction !== 'string' || !task.instruction.trim()) throw new Error('invalid_task');
  for (const field of ['editPaths', 'visibleTests', 'hiddenTests']) {
    if (!Array.isArray(task[field]) || !task[field].length || new Set(task[field]).size !== task[field].length
      || !task[field].every(safePath)) throw new Error('invalid_task_paths');
  }
  if (task.editPaths.some(path => /(^|\/)test(s)?\//.test(path) || !/\.(ts|mjs)$/.test(path))) throw new Error('test_edits_forbidden');
  validateNewPaths(task);
  if (![...task.visibleTests, ...task.hiddenTests].every(path => /\.test\.mjs$/.test(path))) throw new Error('invalid_test_path');
  if (task.oracleSupportPaths !== undefined && (!Array.isArray(task.oracleSupportPaths)
    || task.oracleSupportPaths.length > 12 || new Set(task.oracleSupportPaths).size !== task.oracleSupportPaths.length
    || task.oracleSupportPaths.some(path => !safePath(path) || !/^(worker\/test|test)\/.+\.mjs$/.test(path)
      || /\.test\.mjs$/.test(path) || [...task.editPaths, ...task.visibleTests, ...task.hiddenTests].includes(path)))) {
    throw new Error('invalid_oracle_support_paths');
  }
  validateSourceContext(task);
  validatePublicTestFiles(task);
  validatePreservationProbes(task.preservationProbes);
  if (task.reproducer !== undefined) validateReproducer(task.reproducer);
  return task;
}

export async function loadTasks(path = new URL('../benchmarks/fusion/workloads.json', import.meta.url)) {
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.tasks) || !data.tasks.length) throw new Error('invalid_workloads');
  const tasks = data.tasks.map(validateTask);
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('duplicate_task');
  return tasks;
}

/** Bounded subprocess output; never prints a provider response or inherits credentials. */
export function command(program, args, { cwd, input, timeout = 120000, maxBytes = 4 * 1024 * 1024, allowFailure = false, signal } = {}) {
  return new Promise((resolveResult, reject) => {
    signal?.throwIfAborted();
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
    const child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [], errors = []; let size = 0, failure;
    const timer = setTimeout(() => { failure = new Error('command_timeout'); child.kill('SIGKILL'); }, timeout);
    const abort = () => { failure = signal.reason instanceof Error ? signal.reason : new DOMException('Command aborted', 'AbortError'); child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const retire = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const collect = target => chunk => {
      size += chunk.length;
      if (size > maxBytes) { failure = new Error('command_output_limit'); child.kill('SIGKILL'); }
      else target.push(chunk);
    };
    child.stdout.on('data', collect(chunks)); child.stderr.on('data', collect(errors));
    child.stdin.on('error', () => {});
    child.on('error', error => { retire(); reject(error); });
    child.on('close', code => {
      retire();
      if (failure) return reject(failure);
      if (code !== 0 && !allowFailure) {
        const error = new Error('command_failed');
        error.stderr = Buffer.concat(errors).toString().slice(-4000);
        return reject(error);
      }
      resolveResult({ code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors) });
    });
    child.stdin.end(input);
  });
}

async function git(repo, args) { return (await command('git', args, { cwd: repo, maxBytes: 64 * 1024 * 1024 })).stdout; }

export function sandboxArgs(image) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('immutable_image_required');
  return ['create', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user=1000:1000', '--memory=2g', '--cpus=2', '--pids-limit=128',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000',
    '--tmpfs=/work:rw,nosuid,nodev,size=1024m,uid=1000,gid=1000', '--workdir=/work', image,
    'sh', '-c', 'cp -a --no-preserve=ownership /seed/. /work/ && rm -rf /work/node_modules && ln -s /seed/node_modules /work/node_modules && touch /work/.ready && exec sleep 3600'];
}

// No bind mounts, Docker socket, secrets, network, or caller-selected shell command.
export async function sandbox(image, run = command, options = {}) {
  const cleanup = options.cleanupRun ?? run;
  const args = sandboxArgs(image, options);
  const name = options.cleanupRun ? `fusion-sandbox-${randomUUID()}` : null;
  if (name) args.splice(1, 0, '--name', name);
  let id;
  try {
    id = (await run('docker', args)).stdout.toString().trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid_container_id');
  }
  catch (error) {
    if (name) {
      try {
        const result = await cleanup('docker', ['rm', '-f', name], { allowFailure: true });
        const absent = result.code === 1 && result.stdout.toString().trim() === ''
          && result.stderr.toString().trim() === `Error response from daemon: No such container: ${name}`;
        if (result.code !== 0 && !absent) throw new Error('sandbox_cleanup_rejected');
      }
      catch { throw new Error(`sandbox_cleanup_failed:${name}`, { cause: error }); }
    }
    throw error;
  }
  const close = async () => {
    try { return await cleanup('docker', ['rm', '-f', id]); }
    catch (error) {
      if (name) throw new Error(`sandbox_cleanup_failed:${name}`, { cause: error });
      throw error;
    }
  };
  const exec = (args, options = {}) => run('docker', ['exec', '-i', id, ...args], options);
  const execUnprivileged = (args, options = {}) => run('docker', ['exec', '--user', '65534:65534', '-i', id, ...args], options);
  try {
    await run('docker', ['start', id]);
    await exec(['node', '-e', `const fs=require('node:fs'); for(let i=0;i<200;i++){if(fs.existsSync('/work/.ready'))process.exit(0);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)}process.exit(1)`]);
    return { id, exec, execUnprivileged, close };
  } catch (error) { await close(); throw error; }
}

export function validateNewPaths(task) {
  const paths = task.newPaths ?? [];
  if (!Array.isArray(paths) || paths.length > 12 || new Set(paths).size !== paths.length
    || paths.some(path => !safePath(path) || /(^|\/)test(s)?\//.test(path)
      || !/\.(ts|mjs)$/.test(path) || !task.editPaths?.includes(path))) throw new Error('invalid_new_paths');
  return paths;
}

export function validatePublicTestFiles(task) {
  const files = task.publicTestFiles === undefined ? [] : task.publicTestFiles;
  if (!Array.isArray(files) || (task.publicTestFiles !== undefined && !files.length)
    || files.length > 12 || new Set(files.map(file => file?.path)).size !== files.length
    || files.some(file => !file || !safePath(file.path) || !/\.test\.mjs$/.test(file.path)
      || !task.visibleTests?.includes(file.path) || task.editPaths?.includes(file.path)
      || typeof file.content !== 'string' || !file.content.trim()
      || Buffer.byteLength(file.content) > 256 * 1024)
    || files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > 1024 * 1024) {
    throw new Error('invalid_public_test_files');
  }
  return files;
}

// Keep the immutable source image exact. Apply declared public tests and empty
// source additions only in disposable trials, before any model sees the tree.
export async function taskSandbox(task, image, run = command) {
  const paths = validateNewPaths(task), publicTests = validatePublicTestFiles(task);
  const box = await sandbox(image, run);
  try {
    if (paths.length) await box.exec(['node', '-e', `const fs=require('node:fs'),p=require('node:path');
for(const name of JSON.parse(process.argv[1])){const file=p.resolve('/work',name),dir=p.dirname(file);
if(!file.startsWith('/work/')||fs.realpathSync(dir)!==dir||!fs.statSync(dir).isDirectory())throw Error('invalid_new_parent');
fs.writeFileSync(file,'',{flag:'wx'});}`, JSON.stringify(paths)]);
    if (publicTests.length) {
      await box.exec(['node', '-e', `const fs=require('node:fs'),p=require('node:path');
for(const name of JSON.parse(process.argv[1])){const file=p.resolve('/work',name),dir=p.dirname(file);
if(!file.startsWith('/work/')||fs.realpathSync(dir)!==dir||!fs.statSync(dir).isDirectory())throw Error('invalid_public_test_parent');
try{fs.writeFileSync(file,'',{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}}`, JSON.stringify(publicTests.map(file => file.path))]);
      await writeFiles(box, publicTests);
    }
    return box;
  } catch (error) { await box.close(); throw error; }
}

export function validateEdits(task, edits) {
  if (!Array.isArray(edits) || edits.length > task.editPaths.length || new Set(edits.map(edit => edit?.path)).size !== edits.length) throw new Error('invalid_edits');
  if (edits.some(edit => !task.editPaths.includes(edit?.path) || typeof edit.content !== 'string' || Buffer.byteLength(edit.content) > 256 * 1024)) throw new Error('invalid_edit_path_or_size');
  return edits;
}

const writeProgram = `const fs=require('node:fs'),p=require('node:path');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{for(const f of JSON.parse(input)){const target=p.resolve('/work',f.path);if(!target.startsWith('/work/')||fs.lstatSync(target).isSymbolicLink()||fs.realpathSync(target)!==target)process.exit(2);fs.writeFileSync(target,f.content)}});`;
export async function writeFiles(box, files, timeout = 120000) { await box.exec(['node', '-e', writeProgram], { input: JSON.stringify(files), timeout }); }

export async function readSource(box, paths, timeout = 120000) {
  const readable = path => safePath(path) || (typeof path === 'string'
    && /^(providers|docs)\/[A-Za-z0-9_./-]+$/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..'))
    || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(path);
  if (!paths.every(readable) || paths.length > 12) throw new Error('invalid_read_paths');
  const program = `const fs=require('node:fs'),p=require('node:path');const paths=JSON.parse(process.argv[1]);console.log(JSON.stringify(paths.map(path=>{const target=p.resolve('/work',path);if(fs.realpathSync(target)!==target||!fs.statSync(target).isFile()||fs.statSync(target).size>262144)throw Error('invalid_read');return {path,content:fs.readFileSync(target,'utf8')}})));`;
  return JSON.parse((await box.exec(['node', '-e', program, JSON.stringify(paths)], { timeout })).stdout.toString());
}

// Original repository declarations, not answer material. A missing or ambiguous
// selector fails closed instead of silently supplying a guessed source window.
export async function readTaskContext(box, task, timeout = 120000, read = readSource) {
  const context = validateSourceContext(task);
  if (!context.length) return [];
  const files = await read(box, [...new Set(context.map(item => item.path))], timeout);
  const views = context.map(item => {
    const file = files.find(file => file.path === item.path);
    if (!file) throw new Error('missing_source_context');
    const lines = file.content.split('\n');
    const matches = lines.flatMap((line, index) => line.includes(item.query) ? [index] : []);
    if (matches.length !== 1) throw new Error('ambiguous_source_context');
    const start = Math.max(0, matches[0] - 8), end = Math.min(lines.length, matches[0] + 9);
    return { path: item.path, startLine: start + 1, endLine: end, content: lines.slice(start, end).join('\n') };
  });
  if (Buffer.byteLength(JSON.stringify(views)) > 24000) throw new Error('source_context_too_large');
  return views;
}
function failureFingerprints(text) {
  const scopes = [], digests = new Set();
  let truncated = false;
  for (const line of text.split('\n')) {
    const subtest = /^( *)# Subtest: (.+)\r?$/.exec(line);
    if (subtest) {
      const depth = subtest[1].length;
      while (scopes.length && scopes.at(-1).depth >= depth) scopes.pop();
      scopes.push({ depth, name: subtest[2].trimEnd() });
    }
    const failed = /^( *)not ok ([1-9][0-9]*) - (.+)\r?$/.exec(line);
    if (!failed) continue;
    const parents = scopes.filter(scope => scope.depth < failed[1].length).map(scope => scope.name);
    const digest = hash(JSON.stringify([...parents, `${failed[2]}:${failed[3].trimEnd()}`]));
    if (digests.size === 128 && !digests.has(digest)) { truncated = true; break; }
    digests.add(digest);
  }
  return { version: 1, kind: 'tap-label-path-sha256', digests: [...digests], truncated };
}

// Node counts a declared test timeout as cancellation. Opt in only for a flat,
// complete census; parent or runner cancellation remains invalid.
function declaredTestTimeouts(text, { tests, failed, passed, cancelled, skipped }) {
  if (cancelled < 1 || skipped !== 0 || failed + passed + cancelled !== tests) return 0;
  const rows = [...text.matchAll(/^(not )?ok ([1-9][0-9]*) - [^\r\n]+\r?$/gm)];
  if (rows.length !== tests || rows.some((row, i) => Number(row[2]) !== i + 1)
    || rows.filter(row => !row[1]).length !== passed) return 0;
  const summary = new RegExp(`^1\\.\\.${tests}\\r?\\n# tests ${tests}\\r?\\n# suites 0\\r?\\n# pass ${passed}\\r?\\n# fail ${failed}\\r?\\n# cancelled ${cancelled}\\r?\\n# skipped 0\\r?\\n# todo 0\\r?\\n# duration_ms [0-9]+(?:\\.[0-9]+)?\\r?\\n?$`, 'm');
  const tail = summary.exec(text);
  if (!tail || tail.index + tail[0].length !== text.length) return 0;
  let timeouts = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i][1]) continue;
    const block = text.slice(rows[i].index + rows[i][0].length, rows[i + 1]?.index ?? tail.index);
    if (!/^\r?\n  ---\r?\n/.test(block) || !/^  \.\.\.\r?$/m.test(block)) return 0;
    const types = [...block.matchAll(/^  failureType: ['"]?([A-Za-z]+)['"]?\r?$/gm)];
    if (types.length !== 1) return 0;
    if (types[0][1] === 'testTimeoutFailure') timeouts++;
    else if (types[0][1] !== 'testCodeFailure') return 0;
  }
  return timeouts === cancelled ? timeouts : 0;
}

export function testResult(result, { countTestTimeoutsAsFailures = false } = {}) {
  if (typeof countTestTimeoutsAsFailures !== 'boolean') throw new Error('invalid_test_timeout_accounting');
  const text = result.stdout.toString();
  const count = key => Number(text.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? -1);
  const tests = count('tests'), failed = count('fail'), passed = count('pass'), skipped = count('skipped'), cancelled = count('cancelled');
  const timeouts = countTestTimeoutsAsFailures && result.code === 1
    ? declaredTestTimeouts(text, { tests, failed, passed, cancelled, skipped }) : 0;
  const failures = failed + timeouts;
  const valid = tests > 0 && failed >= 0 && passed >= 0 && skipped >= 0
    && cancelled === timeouts && failures + passed + skipped === tests;
  return { valid, passed: valid && passed > 0 && result.code === 0 && failures === 0, tests, failures, skipped,
    ...(timeouts ? { testTimeoutFailures: timeouts } : {}),
    digest: hash(Buffer.concat([result.stdout, result.stderr])), failureFingerprints: failureFingerprints(text) };
}

function normalizeTapTimings(text) {
  const lines = text.split('\n');
  let diagnosticIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (diagnosticIndent !== null) {
      if (line === diagnosticIndent + '...') diagnosticIndent = null;
      continue;
    }
    const result = /^( *)(?:not )?ok [1-9][0-9]* - /.exec(line);
    if (!result) continue;
    const indent = result[1] + '  ';
    if (lines[i + 1]?.replace(/\r$/, '') !== indent + '---') continue;
    diagnosticIndent = indent;
    const duration = lines[i + 2];
    if (duration?.startsWith(indent + 'duration_ms: ')) {
      lines[i + 2] = duration.replace(/^( *duration_ms: )[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?(\r?)$/i, '$1<elapsed>$2');
    }
  }
  // Console diagnostics can also start with "# duration_ms". Only the final
  // complete reporter summary owns a duration outside a result's YAML block.
  return lines.join('\n').replace(/(^# tests [0-9]+\r?\n# suites [0-9]+\r?\n# pass [0-9]+\r?\n# fail [0-9]+\r?\n# cancelled [0-9]+\r?\n# skipped [0-9]+\r?\n# todo [0-9]+\r?\n# duration_ms )[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?((?:\r?\n)*)(?![\s\S])/mi, '$1<elapsed>$2');
}

function normalizeNodeWarningPids(text) {
  // Only the process identifier in a top-level Node warning header is metadata.
  // Indented assertion values, warning codes and messages remain evidence.
  return text.replace(/^(# )?\(node:[1-9][0-9]*\)( \[[A-Z][A-Z0-9_-]*\] (?:Warning|[A-Za-z]+Warning):)/gm,
    '$1(node:<pid>)$2');
}

function testFeedback(result, normalizeTimings, normalizeProcessIds = false) {
  const normalize = text => {
    if (normalizeTimings) text = normalizeTapTimings(text);
    return normalizeProcessIds ? normalizeNodeWarningPids(text) : text;
  };
  const stdout = normalize(result.stdout.toString());
  const text = normalizeTimings || normalizeProcessIds ? stdout + normalize(result.stderr.toString()) : Buffer.concat([result.stdout, result.stderr]).toString();
  if (text.length <= 12000) return text;
  const diagnostics = [];
  let failureDepth = -1;
  for (const line of stdout.split('\n')) {
    const failure = /^( *)not ok [1-9][0-9]* - /.exec(line);
    if (failure) failureDepth = failure[1].length;
    else if (line.trim() && line.search(/\S/) <= failureDepth) failureDepth = -1;
    if (failureDepth >= 0) diagnostics.push(line);
  }
  const marker = '\n[test output omitted; showing failure diagnostics and final output]\n';
  const tail = text.slice(-2000);
  const failures = diagnostics.join('\n');
  if (!failures) return marker + text.slice(-(12000 - marker.length));
  return failures.slice(0, 12000 - marker.length - tail.length) + marker + tail;
}

function namedTestPattern(testNamePrefix) {
  if (testNamePrefix === undefined) return undefined;
  if (typeof testNamePrefix !== 'string' || !testNamePrefix.trim() || testNamePrefix.length > 256
    || /[\r\n]/.test(testNamePrefix)) throw new Error('invalid_test_name_prefix');
  return testNamePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Match Node's TAP reporter encoding without interpreting generated output.
function tapTestName(name) {
  const escapes = { '\b': '\\\\b', '\f': '\\\\f', '\t': '\\\\t', '\n': '\\\\n', '\r': '\\\\r', '\v': '\\\\v',
    '\\': '\\\\', '#': '\\#' };
  return name.replace(/[\b\f\t\n\r\v\\#]/g, character => escapes[character]);
}

function nodeTestRuntimeArgs({ exposeGc = false }) {
  if (typeof exposeGc !== 'boolean') throw new Error('invalid_gc_runtime_option');
  return exposeGc ? ['--expose-gc'] : [];
}

export async function check(box, paths, timeout = 120000, { testNamePrefix, exposeGc = false, normalizeFeedbackTimings = false, normalizeFeedbackProcessIds = false, countTestTimeoutsAsFailures = false } = {}) {
  const runtimeArgs = nodeTestRuntimeArgs({ exposeGc });
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('invalid_test_timeout');
  if (typeof normalizeFeedbackTimings !== 'boolean') throw new Error('invalid_feedback_timing_option');
  if (typeof normalizeFeedbackProcessIds !== 'boolean') throw new Error('invalid_feedback_process_id_option');
  if (typeof countTestTimeoutsAsFailures !== 'boolean') throw new Error('invalid_test_timeout_accounting');
  // Kill the in-container process group before the Docker client deadline.
  // A killed client alone leaves the test runner and its children alive.
  const limit = timeout - Math.min(2000, Math.ceil(timeout / 10));
  const pattern = namedTestPattern(testNamePrefix);
  const selection = pattern === undefined ? [] : [`--test-name-pattern=^${pattern}`];
  const result = await box.exec(['timeout', '--signal=KILL', `${Math.max(1, limit) / 1000}s`,
    'node', ...runtimeArgs, '--test-reporter=tap', ...selection, '--test', ...paths], { allowFailure: true, timeout });
  const metrics = testResult(result, { countTestTimeoutsAsFailures });
  if (pattern === undefined) return { ...metrics, feedback: testFeedback(result, normalizeFeedbackTimings, normalizeFeedbackProcessIds) };
  // Node can report the test file itself as passing when no name matched.
  const encodedPrefix = tapTestName(testNamePrefix);
  const fileLabels = paths.map(path => tapTestName(path.replace(/^\.\//, '')));
  let selectedLabel;
  const matchedTestPrefix = result.stdout.toString().split('\n').some(rawLine => {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('# Subtest: ')) {
      const label = line.slice('# Subtest: '.length);
      selectedLabel = label.startsWith(encodedPrefix) && !fileLabels.some(path => label === path
        || label.endsWith(`/${path}`) || path.endsWith(`/${label}`)) ? label : undefined;
      return false;
    }
    const completed = /^(?:not )?ok \d+ - (.*)$/.exec(line);
    if (!completed) return false;
    // Exact equality excludes SKIP/TODO directives after the encoded name.
    const matched = selectedLabel !== undefined && completed[1] === selectedLabel;
    selectedLabel = undefined;
    return matched;
  });
  return { ...metrics, passed: metrics.passed && matchedTestPrefix, matchedTestPrefix,
    feedback: matchedTestPrefix ? testFeedback(result, normalizeFeedbackTimings, normalizeFeedbackProcessIds)
      : ('No test matched the required name prefix.\n' + testFeedback(result, normalizeFeedbackTimings, normalizeFeedbackProcessIds)).slice(0, 12000) };
}

/** Final acceptance cannot let candidate imports rewrite their own tests. */
export async function checkAcceptance(box, paths, supportPaths = [], timeout = 120000, options = {}) {
  nodeTestRuntimeArgs(options);
  namedTestPattern(options.testNamePrefix);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || !Array.isArray(paths) || !paths.length
    || !Array.isArray(supportPaths) || typeof box.execUnprivileged !== 'function') {
    throw new Error('invalid_acceptance_check');
  }
  const watched = [...new Set([...paths, ...supportPaths])];
  if (watched.length > 36 || !watched.every(safePath)) throw new Error('invalid_acceptance_check');
  const snapshot = async () => {
    const result = await box.exec(['node', '-e', `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
console.log(JSON.stringify(JSON.parse(process.argv[1]).map(name=>{const path=p.resolve('/work',name);if(!path.startsWith('/work/')||fs.realpathSync(path)!==path||!fs.statSync(path).isFile())throw Error('acceptance_path_changed');return c.createHash('sha256').update(fs.readFileSync(path)).digest('hex')})));`, JSON.stringify(watched)], { timeout });
    const hashes = JSON.parse(result.stdout.toString());
    if (!Array.isArray(hashes) || hashes.length !== watched.length || !hashes.every(value => /^[a-f0-9]{64}$/.test(value))) {
      throw new Error('invalid_acceptance_snapshot');
    }
    return JSON.stringify(hashes);
  };
  const before = await snapshot();
  await box.exec(['node', '-e', `const fs=require('node:fs'),p=require('node:path');
function protect(path){const s=fs.lstatSync(path);if(s.isSymbolicLink())return;if(s.uid!==1000)throw Error('unexpected_fixture_owner');fs.chmodSync(path,s.mode&~0o022);if(s.isDirectory())for(const name of fs.readdirSync(path))protect(p.join(path,name));}protect('/work');
fs.mkdirSync('/work/.artifacts',{recursive:true});fs.chmodSync('/work/.artifacts',0o1777);`], { timeout });
  const admission = await box.execUnprivileged(['node', '-e', `const fs=require('node:fs'),p=require('node:path');const path=p.resolve('/work',process.argv[1]);
const denied=fn=>{try{fn();return false}catch(e){if(!['EPERM','EACCES','EROFS'].includes(e.code))throw e;return true}};
if(process.getuid()!==65534||![denied(()=>fs.writeFileSync(path,'changed')),denied(()=>fs.chmodSync(path,0o666)),denied(()=>fs.renameSync(path,path+'.moved')),denied(()=>fs.renameSync(p.dirname(path),p.dirname(path)+'.moved'))].every(Boolean))throw Error('acceptance_write_access');console.log('protected');`, paths[0]], { timeout });
  if (admission.stdout.toString().trim() !== 'protected') throw new Error('acceptance_protection_failed');
  if (await snapshot() !== before) throw new Error('acceptance_integrity_changed');
  try {
    return await check({ exec: (...args) => box.execUnprivileged(...args) }, paths, timeout, options);
  } finally {
    if (await snapshot() !== before) throw new Error('acceptance_integrity_changed');
  }
}

export async function probe(box, source, timeout = 15000, { filterLoaderAssertions = false } = {}) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 16000) throw new Error('invalid_probe');
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('invalid_probe');
  if (typeof filterLoaderAssertions !== 'boolean') throw new Error('invalid_probe');
  const limit = Math.min(15000, timeout);
  // The in-container watchdog owns the process group; killing docker exec alone
  // would leave a hanging probe alive. Give the client time to collect its exit.
  const result = await box.exec(['timeout', '--signal=KILL', `${limit / 1000}s`, 'node', '--input-type=module'],
    { input: source, allowFailure: true, timeout: limit + 2000 });
  const output = Buffer.concat([result.stdout, result.stderr]).toString();
  const diagnostics = filterLoaderAssertions ? stripVTControlCharacters(output) : output;
  // Conservative opt-in for generated probes wrapping subprocess failures.
  // Diagnostics are not attestation; retain the legacy interpretation by default.
  const loaderError = /^(?:Error|TypeError) \[(?:ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_DIR_IMPORT)\]:[^\n]*(?:\nDid you mean to import [^\n]*)?\n\s+at [^\n]*\(node:internal\/modules\//m;
  const parserError = /^SyntaxError:[^\n]*\n\s+at compileSourceTextModule \(node:internal\/modules\//m;
  const filtered = filterLoaderAssertions && (loaderError.test(diagnostics) || parserError.test(diagnostics));
  return { passed: result.code === 0,
    // node:test can rethrow an uncaught assertion from its exception handler,
    // producing Node's exit code 7 instead of the usual uncaught exit code 1.
    // node:test reporters print caught assertion diagnostics on stdout.
    assertionFailed: [1, 7].includes(result.code) && /\bERR_ASSERTION\b/.test(output) && !filtered,
    feedback: output.slice(-12000) };
}

export async function buildTask(task, { repo, nodeImage, run = command }) {
  validateTask(task);
  if (!/^node@sha256:[a-f0-9]{64}$/.test(nodeImage)) throw new Error('pinned_node_image_required');
  const parent = (await git(repo, ['rev-parse', `${task.oracle}^`])).toString().trim();
  if (parent !== task.base) throw new Error('task_parent_mismatch');
  const temp = await mkdtemp(join(tmpdir(), 'fusion-build-'));
  const tag = `clawrouter-fusion-task:${randomUUID()}`;
  try {
    await writeFile(join(temp, 'source.tar'), await git(repo, ['archive', '--format=tar', task.base]));
    const inputs = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'admin/package.json'];
    for (const [i, file] of inputs.entries()) await writeFile(join(temp, `input${i}`), await git(repo, ['show', `${task.base}:${file}`]));
    // Trusted frozen dependencies are installed during image construction only.
    // Source remains outside /work until each unprivileged isolated trial starts.
    await writeFile(join(temp, 'Dockerfile'), `FROM ${nodeImage}\nWORKDIR /seed\nCOPY input0 package.json\nCOPY input1 pnpm-lock.yaml\nCOPY input2 pnpm-workspace.yaml\nCOPY input3 admin/package.json\nRUN corepack enable && corepack prepare pnpm@11.28.4 --activate && pnpm install --frozen-lockfile\nRUN node -e \"require('node:fs').writeFileSync('/seed/.fixture-ca.pem', require('node:tls').rootCertificates.join('\\n'))\"\nENV SSL_CERT_FILE=/seed/.fixture-ca.pem\nCOPY source.tar /tmp/source.tar\nRUN tar -xf /tmp/source.tar -C /seed && rm /tmp/source.tar && chmod -R a+rX /seed\n`);
    await run('docker', ['build', '--quiet', '--tag', tag, temp], { timeout: 600000, maxBytes: 4 * 1024 * 1024 });
    const image = (await run('docker', ['image', 'inspect', '--format={{.Id}}', tag])).stdout.toString().trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('invalid_image_id');
    return { image, tag };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function revisionFiles(repo, revision, paths) {
  return Promise.all(paths.map(async path => ({ path, content: (await git(repo, ['show', `${revision}:${path}`])).toString() })));
}

export function acceptanceTestFiles(task, oracleFiles) {
  const declared = new Map(validatePublicTestFiles(task).map(file => [file.path, file]));
  return oracleFiles.map(file => {
    const publicFile = declared.get(file.path);
    // Keep append-only public guards without replacing any oracle bytes.
    // Other public replacements must not override the hidden test contract.
    return task.hiddenTests.includes(file.path) && publicFile?.content.startsWith(file.content) ? publicFile : file;
  });
}

export async function verify(task, image, edits, repo) {
  validateEdits(task, edits);
  const box = await taskSandbox(task, image);
  try {
    await writeFiles(box, edits);
    // Files new in the oracle do not yet exist. Create their parent/empty file
    // only inside this fresh verifier before the same guarded write operation.
    const acceptancePaths = [...task.hiddenTests, ...(task.oracleSupportPaths ?? [])];
    const hidden = acceptanceTestFiles(task, await revisionFiles(repo, task.oracle, acceptancePaths));
    await box.exec(['node', '-e', `const fs=require('node:fs'),p=require('node:path');for(const f of JSON.parse(process.argv[1])){const x=p.resolve('/work',f);if(!fs.existsSync(x)){fs.mkdirSync(p.dirname(x),{recursive:true});fs.writeFileSync(x,'')}}`, JSON.stringify(acceptancePaths)]);
    await writeFiles(box, hidden);
    const result = await checkAcceptance(box, [...new Set([...task.visibleTests, ...task.hiddenTests])], task.oracleSupportPaths ?? []);
    const { feedback, ...receipt } = result;
    return receipt;
  } finally { await box.close(); }
}

// The repair must pass the original visible tests before acceptance tests replace
// any same-named files. Otherwise a benchmark can punish the correct repair.
export async function checkOracleVisible(task, image, edits, { makeSandbox = image => taskSandbox(task, image), write = writeFiles, test = check } = {}) {
  const box = await makeSandbox(image);
  try {
    await write(box, validateEdits(task, edits));
    const { feedback, ...receipt } = await test(box, task.visibleTests);
    return receipt;
  } finally { await box.close(); }
}

export function baselineVisibleQualified(task, visible) {
  const replacements = validatePublicTestFiles(task);
  return visible?.passed === true || (replacements.length > 0 && visible?.valid === true
    && visible.passed === false && Number.isSafeInteger(visible.failures) && visible.failures > 0);
}

export function qualificationSucceeded({ visible, oracleVisible, broken, oracle, reproduction, oracleReproduction }, task = {}) {
  return baselineVisibleQualified(task, visible) && oracleVisible?.valid === true && oracleVisible?.passed === true
    && broken?.valid === true && broken?.passed === false && oracle?.passed === true
    && (reproduction === undefined && oracleReproduction === undefined
      || reproduction?.assertionFailed === true && oracleReproduction?.passed === true);
}

export async function checkPreservationProbes(task, image, edits = []) {
  const results = [];
  for (const source of validatePreservationProbes(task.preservationProbes)) {
    const box = await taskSandbox(task, image);
    try {
      if (edits.length) await writeFiles(box, validateEdits(task, edits));
      const before = await readSource(box, task.editPaths);
      const result = await probe(box, source);
      const after = await readSource(box, task.editPaths);
      results.push({ probeDigest: hash(source), passed: result.passed,
        unchanged: hash(JSON.stringify(before)) === hash(JSON.stringify(after)) });
    } finally { await box.close(); }
  }
  return results;
}

export async function qualify(task, options) {
  const built = await buildTask(task, options);
  const box = await taskSandbox(task, built.image);
  let visible, reproduction, oracleReproduction;
  try {
    await readTaskContext(box, task);
    const { feedback, ...result } = await check(box, task.visibleTests); visible = result;
    if (task.reproducer !== undefined) {
      const { feedback, ...result } = await probe(box, task.reproducer); reproduction = result;
    }
  }
  finally { await box.close(); }
  const edits = await revisionFiles(options.repo, task.oracle, task.editPaths);
  const oracleVisible = await checkOracleVisible(task, built.image, edits);
  const broken = await verify(task, built.image, [], options.repo);
  const oracle = await verify(task, built.image, edits, options.repo);
  if (task.reproducer !== undefined) {
    const repaired = await taskSandbox(task, built.image);
    try {
      await writeFiles(repaired, edits);
      const { feedback, ...result } = await probe(repaired, task.reproducer); oracleReproduction = result;
    } finally { await repaired.close(); }
  }
  const preservation = task.preservationProbes === undefined ? undefined : {
    baseline: await checkPreservationProbes(task, built.image),
    reference: await checkPreservationProbes(task, built.image, edits),
  };
  const evidence = { visible, oracleVisible, broken, oracle,
    ...(preservation === undefined ? {} : { preservation }),
    ...(task.reproducer !== undefined ? { reproduction, oracleReproduction } : {}) };
  return { taskId: task.id, taskDigest: hash(JSON.stringify(task)), ...built, ...evidence,
    qualified: qualificationSucceeded(evidence, task) && preservationQualificationMatches(task.preservationProbes, preservation) };
}
