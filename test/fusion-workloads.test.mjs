import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTasks, validateTask, validateEdits, sandboxArgs, sandbox, testResult, check, checkOracleVisible, qualificationSucceeded, validatePreservationProbes, preservationQualificationMatches, checkPreservationProbes, hash } from '../scripts/fusion-workloads.mjs';
import { taskSandbox, readSource, writeFiles, command, verify, validatePublicTestFiles, acceptanceTestFiles, checkAcceptance } from '../scripts/fusion-workloads.mjs';

const task = (await loadTasks())[0];
test('historical tasks have pinned distinct parents, source-only edits and development labels', async () => {
  const tasks = await loadTasks();
  assert.equal(tasks.length, 3);
  assert.equal(new Set(tasks.map(task => task.base)).size, tasks.length);
  for (const task of tasks) assert.equal(validateTask(task), task);
  for (const path of ['../test.js', '/tmp/escape.ts', 'worker/../test.js', 'worker//file.ts']) {
    assert.throws(() => validateTask({ ...task, editPaths: [path] }));
  }
  assert.throws(() => validateTask({ ...task, editPaths: ['worker/test/example.ts'] }));
  assert.throws(() => validateTask({ ...task, split: 'test' }));
});

test('agent edits cannot change graders, add executable paths or exceed file bounds', () => {
  assert.deepEqual(validateEdits(task, [{ path: task.editPaths[0], content: 'source' }]), [{ path: task.editPaths[0], content: 'source' }]);
  for (const edits of [[{ path: 'test/verifier.mjs', content: '' }], [{ path: task.editPaths[0], content: 'x'.repeat(262145) }],
    [{ path: task.editPaths[0], content: '' }, { path: task.editPaths[0], content: '' }]]) assert.throws(() => validateEdits(task, edits));
});

test('public test replacements are bounded visible files and invalid declarations cannot allocate', async () => {
  const file = { path: task.visibleTests[0], content: "import 'node:test';\n" };
  assert.deepEqual(validatePublicTestFiles({ ...task, publicTestFiles: [file] }), [file]);
  for (const files of [null, [], [null], [file, file], [{ ...file, path: task.editPaths[0] }],
    [{ ...file, path: 'test/undeclared.test.mjs' }], [{ ...file, path: '../escape.test.mjs' }],
    [{ ...file, content: '' }], [{ ...file, content: 42 }], [{ ...file, content: 'x'.repeat(262145) }]]) {
    const invalid = { ...task, publicTestFiles: files };
    assert.throws(() => validateTask(invalid), /invalid_public_test_files/);
    await assert.rejects(taskSandbox(invalid, `sha256:${'a'.repeat(64)}`, () => {
      throw Error('must not allocate');
    }), /invalid_public_test_files/);
  }
  assert.throws(() => validateEdits({ ...task, publicTestFiles: [file] }, [file]));
});

test('public test installation failure closes only the new sandbox', async () => {
  const calls = [], id = 'c'.repeat(64);
  await assert.rejects(taskSandbox({ ...task,
    publicTestFiles: [{ path: task.visibleTests[0], content: "import 'node:test';\n" }] },
  `sha256:${'a'.repeat(64)}`, async (_program, args, options) => {
    calls.push(args);
    if (args[0] === 'create') return { stdout: Buffer.from(id) };
    if (options?.input) throw Error('test installation failed');
    return { stdout: Buffer.alloc(0) };
  }), /test installation failed/);
  assert.deepEqual(calls.at(-1), ['rm', '-f', id]);
});

test('acceptance retains append-only public guards but never substitutes different oracle tests', () => {
  const path = task.visibleTests[0], original = { path, content: 'original oracle tests\n' };
  const fixture = { ...task, hiddenTests: [path] };
  const appended = { path, content: original.content + 'appended public guard\n' };
  assert.deepEqual(acceptanceTestFiles({ ...fixture, publicTestFiles: [appended] }, [original]), [appended]);
  assert.deepEqual(acceptanceTestFiles({ ...fixture, publicTestFiles: [{ path, content: 'different public tests\n' }] }, [original]), [original]);
  assert.deepEqual(acceptanceTestFiles(fixture, [original]), [original]);
  const support = { path: 'worker/test/fixture.mjs', content: 'oracle helper' };
  assert.deepEqual(acceptanceTestFiles({ ...fixture, publicTestFiles: [appended] }, [original, support]), [appended, support]);
});

test('append-only public guards survive actual candidate acceptance', {
  skip: !process.env.FUSION_NATIVE_IMAGE,
}, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'fusion-public-acceptance-'));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const source = 'worker/fusion-public-append-source.mjs', path = 'worker/test/fusion-public-append.test.mjs';
  const original = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../fusion-public-append-source.mjs';\ntest('original contract',()=>assert.equal(typeof value,'number'));\n";
  try {
    git('init', '--quiet'); await writeFile(join(repo, 'README.md'), 'isolated acceptance fixture\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'base'); const base = git('rev-parse', 'HEAD');
    await mkdir(join(repo, 'worker/test'), { recursive: true });
    await writeFile(join(repo, source), 'export const value = 42;\n'); await writeFile(join(repo, path), original);
    git('add', '.'); git('commit', '--quiet', '-m', 'oracle');
    const fixture = { id: 'public-append-acceptance', split: 'development', base, oracle: git('rev-parse', 'HEAD'),
      instruction: 'Export value 42.', editPaths: [source], newPaths: [source], visibleTests: [path], hiddenTests: [path],
      publicTestFiles: [{ path, content: original + "test('appended preservation guard',()=>assert.equal(value,42));\n" }] };
    const bad = await verify(fixture, process.env.FUSION_NATIVE_IMAGE, [{ path: source, content: 'export const value = 41;\n' }], repo);
    assert.equal(bad.valid, true); assert.equal(bad.passed, false); assert.equal(bad.tests, 2); assert.equal(bad.failures, 1);
    const good = await verify(fixture, process.env.FUSION_NATIVE_IMAGE, [{ path: source, content: 'export const value = 42;\n' }], repo);
    assert.equal(good.valid, true); assert.equal(good.passed, true); assert.equal(good.tests, 2);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('public test replacements are visible in trials while the source image remains unchanged', {
  skip: !process.env.FUSION_NATIVE_IMAGE,
}, async () => {
  const file = { path: task.visibleTests[0], content: "import test from 'node:test'; test('declared public contract',()=>{});\n" };
  const image = process.env.FUSION_NATIVE_IMAGE;
  const original = await taskSandbox(task, image);
  let before;
  try { before = await readSource(original, [file.path]); } finally { await original.close(); }
  assert.notEqual(before[0].content, file.content);
  const declared = await taskSandbox({ ...task, publicTestFiles: [file] }, image);
  try {
    assert.deepEqual(await readSource(declared, [file.path]), [file]);
    const result = await check(declared, [file.path]);
    assert.equal(result.valid, true); assert.equal(result.passed, true); assert.equal(result.tests, 1);
  } finally { await declared.close(); }
  const unchanged = await taskSandbox(task, image);
  try { assert.deepEqual(await readSource(unchanged, [file.path]), before); } finally { await unchanged.close(); }
});

test('new public test files are installed only in the disposable sandbox', {
  skip: !process.env.FUSION_NATIVE_IMAGE,
}, async () => {
  const file = { path: 'worker/test/fusion-new-public.test.mjs', content: "import test from 'node:test'; test('new public contract',()=>{});\n" };
  const image = process.env.FUSION_NATIVE_IMAGE;
  const fixture = { ...task, visibleTests: [file.path], publicTestFiles: [file] };
  const declared = await taskSandbox(fixture, image);
  try {
    assert.deepEqual(await readSource(declared, [file.path]), [file]);
    const result = await check(declared, [file.path]);
    assert.equal(result.valid, true); assert.equal(result.passed, true); assert.equal(result.tests, 1);
  } finally { await declared.close(); }
  const unchanged = await taskSandbox(task, image);
  try {
    await unchanged.exec(['node', '-e', "if(require('node:fs').existsSync(process.argv[1]))process.exit(1)", `/work/${file.path}`]);
  } finally { await unchanged.close(); }
});

test('public test installation rejects linked files, linked parents and missing parents', {
  skip: !process.env.FUSION_NATIVE_IMAGE,
}, async () => {
  for (const kind of ['file', 'parent', 'missing']) {
    const path = kind === 'file' ? 'worker/test/fusion-linked-public.test.mjs' : 'worker/fusion-public-parent/new.test.mjs';
    let prepared = false;
    const run = async (program, args, options) => {
      const result = await command(program, args, options);
      if (!prepared && args[0] === 'exec') {
        prepared = true;
        if (kind !== 'missing') await command('docker', ['exec', args[2], 'ln', '-s', '/tmp',
          kind === 'file' ? `/work/${path}` : '/work/worker/fusion-public-parent']);
      }
      return result;
    };
    await assert.rejects(taskSandbox({ ...task, visibleTests: [path],
      publicTestFiles: [{ path, content: "import 'node:test';\n" }] }, process.env.FUSION_NATIVE_IMAGE, run), /command_failed/);
  }
});

test('oracle support is bounded to distinct non-test helper modules and stays outside agent edits/context', () => {
  const helper = 'worker/test/usage-snapshot-fixture.mjs';
  assert.equal(validateTask({ ...task, oracleSupportPaths: [helper] }).oracleSupportPaths[0], helper);
  for (const paths of [helper, [helper, helper], Array.from({ length: 13 }, (_, i) => `test/helper-${i}.mjs`),
    ['worker/example.ts'], ['worker/test/../example.mjs'], ['worker/test/x.test.mjs'], ['worker/test/x.json'],
    ['/tmp/helper.mjs'], ['worker/test//helper.mjs']]) {
    assert.throws(() => validateTask({ ...task, oracleSupportPaths: paths }), /invalid_oracle_support_paths/);
  }
  assert.throws(() => validateEdits({ ...task, oracleSupportPaths: [helper] }, [{ path: helper, content: '' }]));
  assert.throws(() => validateTask({ ...task, oracleSupportPaths: [helper], sourceContext: [{ path: helper, query: 'fixture' }] }));
});

test('oracle support is installed only in isolated acceptance, for baseline and repaired source', {
  skip: !process.env.FUSION_NATIVE_IMAGE,
}, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'fusion-support-test-'));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const source = 'worker/fusion-support-source.mjs', helper = 'worker/test/fusion-support-helper.mjs';
  const checkPath = 'worker/test/fusion-support.test.mjs';
  try {
    git('init', '--quiet');
    await writeFile(join(repo, 'README.md'), 'isolated acceptance test\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'base'); const base = git('rev-parse', 'HEAD');
    await mkdir(join(repo, 'worker/test'), { recursive: true });
    await writeFile(join(repo, source), 'export const value = 42;\n');
    await writeFile(join(repo, helper), 'export const expected = 42;\n');
    await writeFile(join(repo, checkPath), "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../fusion-support-source.mjs'; import {expected} from './fusion-support-helper.mjs'; test('expected value',()=>assert.equal(value,expected));\n");
    git('add', '.'); git('commit', '--quiet', '-m', 'oracle');
    const fixture = { id: 'oracle-support-test', split: 'development', base, oracle: git('rev-parse', 'HEAD'),
      instruction: 'Export value 42.', editPaths: [source], newPaths: [source],
      visibleTests: [checkPath], hiddenTests: [checkPath], oracleSupportPaths: [helper] };
    const image = process.env.FUSION_NATIVE_IMAGE;
    const box = await taskSandbox(fixture, image);
    try {
      await box.exec(['node', '-e', `if(require('node:fs').existsSync('/work/${helper}'))throw Error('helper visible before grading')`]);
    } finally { await box.close(); }
    const baseline = await verify(fixture, image, [], repo);
    assert.equal(baseline.valid, true); assert.equal(baseline.passed, false);
    const repaired = await verify(fixture, image, [{ path: source, content: 'export const value = 42;\n' }], repo);
    assert.equal(repaired.valid, true); assert.equal(repaired.passed, true); assert.equal(repaired.tests, 1);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('new source paths must be unique declared edits and cannot name tests or escape the tree', async () => {
  const path = 'worker/fusion-new-module.ts';
  assert.equal(validateTask({ ...task, editPaths: [path], newPaths: [path] }).newPaths[0], path);
  for (const paths of [[path, path], ['worker/../escape.ts'], ['worker/test/hidden.ts'], ['worker/new.json'], ['worker/undeclared.ts'], 'worker/new.ts']) {
    const invalid = { ...task, editPaths: [path], newPaths: paths };
    assert.throws(() => validateTask(invalid), /invalid_new_paths/);
    await assert.rejects(taskSandbox(invalid, `sha256:${'a'.repeat(64)}`, () => { throw Error('must not allocate'); }), /invalid_new_paths/);
  }
});

test('declared new source files are empty, editable, and never replace existing source', {
  skip: !process.env.FUSION_NATIVE_IMAGE,
}, async () => {
  const path = 'worker/fusion-new-module.ts';
  const addition = { ...task, editPaths: [path], newPaths: [path] };
  const box = await taskSandbox(addition, process.env.FUSION_NATIVE_IMAGE);
  try {
    assert.deepEqual(await readSource(box, [path]), [{ path, content: '' }]);
    await writeFiles(box, validateEdits(addition, [{ path, content: 'export const answer = 42;\n' }]));
    assert.equal((await readSource(box, [path]))[0].content, 'export const answer = 42;\n');
  } finally { await box.close(); }
  await assert.rejects(taskSandbox({ ...task, newPaths: [task.editPaths[0]] }, process.env.FUSION_NATIVE_IMAGE), /command_failed/);
  const linked = 'worker/new-parent/new.ts';
  let prepared = false;
  const run = async (program, args, options) => {
    const result = await command(program, args, options);
    if (!prepared && args[0] === 'exec') {
      prepared = true;
      await command('docker', ['exec', args[2], 'ln', '-s', '/tmp', '/work/worker/new-parent']);
    }
    return result;
  };
  await assert.rejects(taskSandbox({ ...task, editPaths: [linked], newPaths: [linked] }, process.env.FUSION_NATIVE_IMAGE, run), /command_failed/);
});

test('sandbox requires immutable image and excludes host mounts, credentials and network', () => {
  assert.throws(() => sandboxArgs('node:latest'));
  const args = sandboxArgs(`sha256:${'a'.repeat(64)}`);
  for (const value of ['--network=none', '--read-only', '--cap-drop=ALL', '--user=1000:1000', '--security-opt=no-new-privileges']) assert.ok(args.includes(value));
  assert.ok(!args.some(value => value === '-v' || value.startsWith('--mount') || value.startsWith('--env')));
});

test('failed sandbox setup removes only the container it created', async () => {
  const calls = [], id = 'b'.repeat(64);
  await assert.rejects(sandbox(`sha256:${'a'.repeat(64)}`, async (_command, args) => {
    calls.push(args);
    if (args[0] === 'create') return { stdout: Buffer.from(id) };
    if (args[0] === 'start') throw new Error('fixture startup failure');
    return {};
  }), /fixture startup failure/);
  assert.deepEqual(calls.at(-1), ['rm', '-f', id]);
});

const tap = (pass, fail, skip = 0) => Buffer.from(`# tests ${pass + fail + skip}\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skip}\n`);
test('qualification rejects empty/malformed reports and distinguishes broken tests from passing ones', () => {
  assert.equal(testResult({ code: 0, stdout: tap(0, 0), stderr: Buffer.alloc(0) }).passed, false);
  assert.equal(testResult({ code: 0, stdout: tap(2, 0, 1), stderr: Buffer.alloc(0) }).passed, true);
  assert.equal(testResult({ code: 1, stdout: tap(2, 1), stderr: Buffer.alloc(0) }).valid, true);
  assert.equal(testResult({ code: 1, stdout: tap(2, 1), stderr: Buffer.alloc(0) }).passed, false);
  assert.equal(testResult({ code: 0, stdout: Buffer.from('success'), stderr: Buffer.alloc(0) }).valid, false);
});

test('long test feedback preserves early nested failure diagnostics and final output', async () => {
  const failure = '    not ok 1 - early regression\r\n      ---\r\n      error: expected one settlement\r\n      stack: |\r\n        repair.test.mjs:12:3\r\n      ...\r\n';
  const output = failure + '    ok 2 - later passing test\r\n'.repeat(1000);
  const report = { code: 1, stdout: Buffer.concat([Buffer.from(output), tap(1000, 1)]), stderr: Buffer.from('final diagnostic') };
  const result = await check({ exec: async () => report }, ['worker/test/repair.test.mjs']);
  assert.equal(result.valid, true);
  assert.equal(result.tests, 1001);
  assert.equal(result.failures, 1);
  assert.match(result.feedback, /early regression/);
  assert.match(result.feedback, /expected one settlement/);
  assert.match(result.feedback, /repair\.test\.mjs:12:3/);
  assert.match(result.feedback, /output omitted/);
  assert.ok(result.feedback.endsWith('final diagnostic'));
  assert.ok(result.feedback.length <= 12000);
  assert.equal(result.digest, testResult(report).digest);
});

test('test feedback keeps small reports unchanged and bounds oversized failures', async () => {
  const short = { code: 0, stdout: tap(1, 0), stderr: Buffer.from('diagnostic') };
  const result = await check({ exec: async () => short }, ['worker/test/repair.test.mjs']);
  assert.equal(result.feedback, Buffer.concat([short.stdout, short.stderr]).toString());
  const huge = Buffer.from('not ok 1 - large failure\n  ---\n  error: ' + 'x'.repeat(30000) + '\n  ...\n' + tap(0, 1));
  const bounded = await check({ exec: async () => ({ code: 1, stdout: huge, stderr: Buffer.alloc(0) }) }, ['worker/test/repair.test.mjs']);
  assert.equal(bounded.feedback.length, 12000);
  assert.ok(bounded.feedback.startsWith('not ok 1 - large failure'));
  assert.match(bounded.feedback, /output omitted/);
  assert.match(bounded.feedback, /# fail 1/);
});

test('timing-normalized feedback clips identical diagnostics at identical boundaries', async () => {
  const output = duration => Buffer.from(Array.from({ length: 30 }, (_, i) =>
    `not ok ${i + 1} - regression ${i}\n  ---\n  duration_ms: ${duration}\n  error: '${'x'.repeat(500)}'\n  ...\n`).join('')
    + `# tests 30\n# suites 0\n# pass 0\n# fail 30\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms ${duration}\n`);
  const short = { code: 1, stdout: output('1'), stderr: Buffer.alloc(0) };
  const long = { ...short, stdout: output('123456.789') };
  const run = (report, options) => check({ exec: async () => report }, ['worker/test/repair.test.mjs'], 120000, options);
  assert.notEqual((await run(short)).feedback, (await run(long)).feedback);
  const first = await run(short, { normalizeFeedbackTimings: true });
  const second = await run(long, { normalizeFeedbackTimings: true });
  assert.equal(first.feedback, second.feedback);
  assert.match(first.feedback, /duration_ms: <elapsed>/);
  assert.match(first.feedback, /# duration_ms <elapsed>/);
  assert.equal(first.feedback.length, 12000);
  assert.equal(first.tests, 30); assert.equal(first.failures, 30);
  assert.equal(first.digest, testResult(short).digest);
  assert.equal(second.digest, testResult(long).digest);
  assert.notEqual(first.digest, second.digest);
});

test('feedback timing normalization is opt-in and validates before execution', async () => {
  const text = '# Subtest: example\nok 1 - example\n  ---\n  duration_ms: 1.2e-3\n  ...\n# diagnostic duration_ms: 42\n' + tap(1, 0).toString();
  const box = { exec: async () => ({ code: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0) }) };
  assert.equal((await check(box, ['test.mjs'])).feedback, text);
  const normalized = await check(box, ['test.mjs'], 120000, { normalizeFeedbackTimings: true, testNamePrefix: 'example' });
  assert.equal(normalized.matchedTestPrefix, true);
  assert.match(normalized.feedback, /duration_ms: <elapsed>/);
  assert.match(normalized.feedback, /# diagnostic duration_ms: 42/);
  await assert.rejects(check({ exec: () => { throw Error('must not execute'); } }, ['test.mjs'], 120000,
    { normalizeFeedbackTimings: 'yes' }), /invalid_feedback_timing_option/);
});

test('timing-shaped assertion values and console diagnostics remain evidence', async () => {
  const text = 'not ok 1 - example\n  ---\n  duration_ms: 12\n  error: |-\n'
    + '    ok 1 - expected transcript\n      ---\n      duration_ms: 42\n      ...\n  ...\n'
    + '# duration_ms 42\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 123\n';
  const result = await check({ exec: async () => ({ code: 1, stdout: Buffer.from(text), stderr: Buffer.alloc(0) }) },
    ['test.mjs'], 120000, { normalizeFeedbackTimings: true });
  assert.match(result.feedback, /  duration_ms: <elapsed>/);
  assert.match(result.feedback, /      duration_ms: 42/);
  assert.match(result.feedback, /# duration_ms 42/);
  assert.ok(result.feedback.endsWith('# duration_ms <elapsed>\n'));
});

test('real Node TAP keeps the first failure after hundreds of passing tests', async () => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const child = spawnSync(process.execPath, ['--test-reporter=tap', '--input-type=module', '-e',
    "import {it} from 'node:test'; it('first regression',()=>{throw Error('settlement must happen once')}); for(let i=0;i<400;i++)it('later passing test '+i,()=>{});"],
  { timeout: 5000, env });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.ok(child.stdout.length > 12000);
  const result = await check({ exec: async () => ({ code: child.status, stdout: child.stdout, stderr: child.stderr }) }, ['worker/test/repair.test.mjs']);
  assert.equal(result.tests, 401);
  assert.equal(result.failures, 1);
  assert.match(result.feedback, /first regression/);
  assert.match(result.feedback, /settlement must happen once/);
  assert.match(result.feedback, /# pass 400/);
  assert.ok(result.feedback.length <= 12000);
});

test('long malformed test output retains its tail without inventing failures', async () => {
  const result = await check({ exec: async () => ({ code: 1, stdout: Buffer.from('x'.repeat(20000)), stderr: Buffer.from('import failed') }) }, ['worker/test/repair.test.mjs']);
  assert.equal(result.valid, false);
  assert.equal(result.feedback.length, 12000);
  assert.ok(result.feedback.endsWith('import failed'));
  assert.match(result.feedback, /output omitted/);
});

test('failed-test fingerprints distinguish nested labels without retaining content', () => {
  const output = `# Subtest: private suite one\n    # Subtest: private failure\n    not ok 1 - private failure\nnot ok 1 - private suite one\n# Subtest: private suite two\n    # Subtest: private failure\n    not ok 1 - private failure\nnot ok 2 - private suite two\n`;
  const receipt = testResult({ code: 1, stdout: Buffer.concat([Buffer.from(output), tap(0, 4)]), stderr: Buffer.from('private error details') });
  const fingerprints = receipt.failureFingerprints;
  assert.equal(fingerprints.kind, 'tap-label-path-sha256');
  assert.equal(fingerprints.digests.length, 4);
  assert.equal(new Set(fingerprints.digests).size, 4);
  assert.ok(fingerprints.digests.every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.equal(fingerprints.truncated, false);
  assert.ok(!JSON.stringify(receipt).includes('private'));
  const repeated = testResult({ code: 1, stdout: Buffer.concat([Buffer.from(output.replaceAll('\n', '\r\n')), tap(0, 4)]), stderr: Buffer.alloc(0) });
  assert.deepEqual(repeated.failureFingerprints, fingerprints);
});

test('failure fingerprints are bounded and do not change acceptance', () => {
  const lines = Array.from({ length: 129 }, (_, i) => `not ok ${i + 1} - failure ${i}`).join('\n') + '\n';
  const receipt = testResult({ code: 1, stdout: Buffer.concat([Buffer.from(lines), tap(0, 129)]), stderr: Buffer.alloc(0) });
  assert.equal(receipt.failureFingerprints.digests.length, 128);
  assert.equal(receipt.failureFingerprints.truncated, true);
  assert.equal(receipt.failures, 129);
  assert.equal(receipt.passed, false);
  const clean = testResult({ code: 0, stdout: tap(2, 0), stderr: Buffer.alloc(0) });
  assert.deepEqual(clean.failureFingerprints.digests, []);
  assert.equal(clean.passed, true);
});

test('real Node TAP failures produce stable fingerprints', () => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const child = spawnSync(process.execPath, ['--test-reporter=tap', '--input-type=module', '-e',
    "import {describe,it} from 'node:test'; import assert from 'node:assert/strict'; describe('fingerprint fixture',()=>{it('failed behavior',()=>assert.equal(1,2));});"],
  { timeout: 5000, env });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  const receipt = testResult({ code: child.status, stdout: child.stdout, stderr: child.stderr });
  assert.equal(receipt.valid, true);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.failureFingerprints.digests.length, 2);
  assert.ok(!JSON.stringify(receipt).includes('fingerprint fixture'));
});


test('behavior probes use bounded stdin in the task sandbox and retain no script in output', async () => {
  const { probe } = await import('../scripts/fusion-workloads.mjs');
  const calls = [];
  const box = { exec: async (args, options) => { calls.push({args, options}); return { code: 1, stdout: Buffer.from('assertion failed'), stderr: Buffer.alloc(0) }; } };
  const source = 'throw new Error("regression");';
  assert.deepEqual(await probe(box, source, 1000), { passed: false, assertionFailed: false, feedback: 'assertion failed' });
  assert.deepEqual(calls[0].args, ['timeout', '--signal=KILL', '1s', 'node', '--input-type=module']);
  assert.equal(calls[0].options.input, source);
  assert.equal(calls[0].options.timeout, 3000);
  await assert.rejects(probe(box, 'x'.repeat(16001)), /invalid_probe/);
  assert.equal(calls.length, 1);
});

test('only a normal failing assertion qualifies a reproduction', async () => {
  const { probe } = await import('../scripts/fusion-workloads.mjs');
  for (const [code, stderr, expected] of [[1, 'AssertionError [ERR_ASSERTION]', true],
    [7, 'AssertionError [ERR_ASSERTION]', true], [7, 'TypeError', false],
    [1, 'SyntaxError', false], [137, 'ERR_ASSERTION', false], [0, 'ERR_ASSERTION', false]]) {
    const result = await probe({ exec: async () => ({ code, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) }) }, 'test');
    assert.equal(result.assertionFailed, expected);
  }
});

test('a real assertion after node:test setup qualifies a reproduction', async () => {
  const { probe } = await import('../scripts/fusion-workloads.mjs');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { beforeEach } from 'node:test'; import assert from 'node:assert/strict'; beforeEach(() => {}); assert.equal(false, true);"],
  { timeout: 5000 });
  assert.equal(child.error, undefined);
  assert.ok([1, 7].includes(child.status));
  const result = await probe({ exec: async () => ({ code: child.status, stdout: child.stdout, stderr: child.stderr }) }, 'test');
  assert.equal(result.assertionFailed, true);
  assert.equal(result.passed, false);
});

test('an assertion caught by node:test qualifies when its reporter writes to stdout', async () => {
  const { probe } = await import('../scripts/fusion-workloads.mjs');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import test from 'node:test'; import assert from 'node:assert/strict'; test('reproduction', () => assert.equal(503, 200));"],
  { timeout: 5000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.match(child.stdout.toString(), /ERR_ASSERTION/);
  const result = await probe({ exec: async () => ({ code: child.status, stdout: child.stdout, stderr: child.stderr }) }, 'test');
  assert.equal(result.assertionFailed, true);
  assert.equal(result.passed, false);
});


test('probe loader filtering is opt-in and preserves assertion expectations', async () => {
  const { probe } = await import('../scripts/fusion-workloads.mjs');
  const diagnostics = [
    'Error [ERR_MODULE_NOT_FOUND]: missing fixture\n    at finalizeResolution (node:internal/modules/esm/resolve:272:11)',
    'TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown extension\n    at Object.getFileProtocolModuleFormat [as file:] (node:internal/modules/esm/get_format:243:9)',
    'Error [ERR_UNSUPPORTED_DIR_IMPORT]: directory import\nDid you mean to import "./fixture/index.js"?\n    at finalizeResolution (node:internal/modules/esm/resolve:260:11)',
    'SyntaxError: Unexpected identifier\n    at compileSourceTextModule (node:internal/modules/esm/utils:319:16)',
  ];
  for (const diagnostic of diagnostics.flatMap(value => [value,
    value.replaceAll('\n', '\n\u001b[90m') + '\u001b[39m'])) {
    const output = 'AssertionError [ERR_ASSERTION]: subprocess failed\n' + diagnostic;
    const box = { exec: async () => ({ code: 1, stdout: Buffer.from(output), stderr: Buffer.alloc(0) }) };
    assert.equal((await probe(box, 'test')).assertionFailed, true);
    const filtered = await probe(box, 'test', 15000, { filterLoaderAssertions: true });
    assert.equal(filtered.passed, false);
    assert.equal(filtered.assertionFailed, false);
    assert.equal(filtered.feedback, output);
  }
  const output = "\u001b[31mAssertionError [ERR_ASSERTION]: expected code 'ERR_MODULE_NOT_FOUND', actual 'ERR_NETWORK'\u001b[39m";
  const box = { exec: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(output) }) };
  assert.equal((await probe(box, 'test', 15000, { filterLoaderAssertions: true })).assertionFailed, true);
  await assert.rejects(probe(box, 'test', 15000, { filterLoaderAssertions: 1 }), /invalid_probe/);
});

test('probe filtering recognizes a real loader failure wrapped in an assertion', async () => {
  const { probe } = await import('../scripts/fusion-workloads.mjs');
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    const nested = spawnSync(process.execPath, ['--input-type=module', '-e',
      "await import('file:///missing-fusion-fixture.mjs')"], { encoding: 'utf8' });
    assert.equal(nested.status, 0, nested.stderr);
  `], { timeout: 5000, env });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  const box = { exec: async () => ({ code: child.status, stdout: child.stdout, stderr: child.stderr }) };
  assert.equal((await probe(box, 'test')).assertionFailed, true);
  const result = await probe(box, 'test', 15000, { filterLoaderAssertions: true });
  assert.equal(result.passed, false);
  assert.equal(result.assertionFailed, false);
  assert.match(result.feedback, /ERR_MODULE_NOT_FOUND/);
});

test('transfer validation uses distinct pinned tasks without changing the original corpus', async () => {
  const original = await loadTasks();
  const validation = await loadTasks(new URL('../benchmarks/fusion/validation-workloads.json', import.meta.url));
  assert.equal(validation.length, 4);
  const known = new Set(original.flatMap(task => [task.id, task.oracle]));
  for (const task of validation) {
    assert.equal(validateTask(task), task);
    assert.equal(known.has(task.id), false);
    assert.equal(known.has(task.oracle), false);
  }
});

test('qualification rejects a known repair that conflicts with the unchanged visible tests', async () => {
  const fixture = { editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'] };
  let content = 'old', closed = false;
  const oracleVisible = await checkOracleVisible(fixture, 'image', [{ path: fixture.editPaths[0], content: 'new' }], {
    makeSandbox: async () => ({ close: async () => { closed = true; } }),
    write: async (_box, files) => { content = files[0].content; },
    test: async (_box, paths) => {
      assert.deepEqual(paths, fixture.visibleTests);
      assert.equal(content, 'new');
      return { valid: true, passed: false, tests: 1, failures: 1, feedback: 'private output' };
    },
  });
  assert.equal(closed, true); assert.equal('feedback' in oracleVisible, false);
  const evidence = { visible: { passed: true }, broken: { valid: true, passed: false }, oracle: { passed: true }, oracleVisible };
  assert.equal(qualificationSucceeded(evidence), false);
  assert.equal(qualificationSucceeded({ ...evidence, oracleVisible: { valid: true, passed: true } }), true);
  assert.equal(qualificationSucceeded({ ...evidence, oracleVisible: undefined }), false);
});

test('provided reproducer qualification requires an original assertion and a repaired pass', () => {
  const evidence = { visible: { passed: true }, oracleVisible: { valid: true, passed: true },
    broken: { valid: true, passed: false }, oracle: { passed: true } };
  assert.equal(qualificationSucceeded({ ...evidence, reproduction: { assertionFailed: true }, oracleReproduction: { passed: true } }), true);
  assert.equal(qualificationSucceeded({ ...evidence, reproduction: { assertionFailed: true } }), false);
  assert.equal(qualificationSucceeded({ ...evidence, reproduction: { assertionFailed: false }, oracleReproduction: { passed: true } }), false);
  assert.equal(qualificationSucceeded({ ...evidence, reproduction: { assertionFailed: true }, oracleReproduction: { passed: false } }), false);
});

test('declared updated tests may fail on original source but must pass on the reference', () => {
  const declared = { ...task, publicTestFiles: [{ path: task.visibleTests[0], content: "import 'node:test';\n" }] };
  const evidence = { visible: { valid: true, passed: false, failures: 1 },
    oracleVisible: { valid: true, passed: true }, broken: { valid: true, passed: false }, oracle: { passed: true } };
  assert.equal(qualificationSucceeded(evidence), false);
  assert.equal(qualificationSucceeded(evidence, declared), true);
  for (const visible of [{ valid: false, passed: false, failures: 1 }, { valid: true, passed: false, failures: 0 }]) {
    assert.equal(qualificationSucceeded({ ...evidence, visible }, declared), false);
  }
  assert.equal(qualificationSucceeded({ ...evidence, oracleVisible: { valid: true, passed: false } }, declared), false);
  assert.equal(qualificationSucceeded({ ...evidence, broken: { valid: true, passed: true } }, declared), false);
});

test('fresh corpus excludes repairs contradicted by their original visible tests', async () => {
  const tasks = await loadTasks(new URL('../benchmarks/fusion/fresh-workloads.json', import.meta.url));
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every(task => !['cerebras-worker-redirect-mode', 'minimax-regional-availability'].includes(task.id)));
});

// Native fixtures must execute image-owned dependencies while edits remain noexec.
test('sandbox supports native fixtures without making edited source executable', {
  skip: !process.env.FUSION_NATIVE_IMAGE,
}, async () => {
  const box = await sandbox(process.env.FUSION_NATIVE_IMAGE);
  try {
    await box.exec(['node', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { execFileSync } from 'node:child_process';
      import { createRequire } from 'node:module';
      const projectRequire = createRequire('/work/package.json');
      const require = createRequire(projectRequire.resolve('wrangler/package.json'));
      assert.equal(require('esbuild').transformSync('const n: number = 1', { loader: 'ts' }).warnings.length, 0);
      fs.writeFileSync('/work/execution-probe.sh', '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
      assert.throws(() => execFileSync('/work/execution-probe.sh'), error => error.code === 'EACCES');
      assert.throws(() => fs.writeFileSync('/work/node_modules/.write-probe', ''), error => ['EROFS', 'EACCES'].includes(error.code));
      const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
      const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'fixture', modules: true, script: 'export default { fetch() { return new Response("native fixture") } }', compatibilityDate: '2026-01-01' }] }));
      try { assert.equal(await (await runtime.dispatchFetch('https://fixture.example')).text(), 'native fixture'); }
      finally { await runtime.dispose(); }
    `], { timeout: 30000 });
  } finally { await box.close(); }
});


test('test watchdog rejects incomplete TAP and kills descendant processes inside the sandbox', {
  skip: !process.env.FUSION_NATIVE_IMAGE,
}, async () => {
  const box = await sandbox(process.env.FUSION_NATIVE_IMAGE);
  try {
    const source = `import test from 'node:test';
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync('/tmp/watchdog-child.pid', String(child.pid));
      test('never finishes', () => new Promise(() => {}));
      setInterval(() => {}, 1000);`;
    await box.exec(['node', '-e', "require('node:fs').writeFileSync('/work/watchdog.test.mjs', process.argv[1])", source]);
    const result = await check(box, ['watchdog.test.mjs'], 2000);
    assert.equal(result.passed, false);
    assert.equal(result.valid, false);
    await box.exec(['node', '-e', `
      const fs = require('node:fs');
      const pid = fs.readFileSync('/tmp/watchdog-child.pid', 'utf8');
      try {
        const state = fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1][0];
        if (state !== 'Z') throw Error('test descendant survived watchdog');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    `]);
    await box.exec(['node', '-e', "require('node:fs').writeFileSync('/work/clean.test.mjs', \"import test from 'node:test'; test('clean', () => {});\")"]);
    const clean = await check(box, ['clean.test.mjs'], 10000);
    assert.equal(clean.passed, true);
  } finally { await box.close(); }
});


test('test watchdog preserves infrastructure errors and rejects invalid timeouts before execution', async () => {
  let calls = 0;
  const failure = new Error('command_failed');
  const box = { exec: async () => { calls++; throw failure; } };
  for (const timeout of [0, -1, 1.5, Infinity, NaN, '1000']) {
    await assert.rejects(check(box, ['test.mjs'], timeout), /invalid_test_timeout/);
  }
  assert.equal(calls, 0);
  await assert.rejects(check(box, ['test.mjs'], 1000), error => error === failure);
  assert.equal(calls, 1);
});


test('preservation qualification requires each exact bounded probe on both revisions', () => {
  const sources = ['assert(true)'];
  const row = { probeDigest: hash(sources[0]), passed: true, unchanged: true };
  const evidence = { baseline: [row], reference: [row] };
  assert.deepEqual(validatePreservationProbes(undefined), []);
  assert.equal(preservationQualificationMatches(sources, evidence), true);
  assert.equal(preservationQualificationMatches(sources, undefined), false);
  for (const probes of [[], Array(1), [''], ['x', 'x'], Array(5).fill('x'), ['界'.repeat(1366)], 'x'])
    assert.throws(() => validatePreservationProbes(probes), /invalid_preservation_probes/);
  for (const change of [{ passed: false }, { unchanged: false }, { probeDigest: 'wrong' }]) {
    assert.equal(preservationQualificationMatches(sources, { ...evidence, reference: [{ ...row, ...change }] }), false);
  }
  assert.equal(preservationQualificationMatches(sources, { ...evidence, baseline: [] }), false);
  assert.equal(preservationQualificationMatches(sources, { ...evidence, baseline: Array(1) }), false);
});

test('preservation qualification rejects source-mutating checks and isolates the next probe', {
  skip: !process.env.FUSION_PROVIDED_QUALIFICATION,
}, async () => {
  const { readFile } = await import('node:fs/promises');
  const task = (await loadTasks('benchmarks/fusion/provided-reproducer-workloads.json'))
    .find(task => task.id === 'provided-responses-path');
  const receipt = JSON.parse(await readFile(process.env.FUSION_PROVIDED_QUALIFICATION))
    .receipts.find(row => row.taskId === task.id);
  const path = JSON.stringify(task.editPaths[0]);
  task.preservationProbes = [
    `import {appendFileSync} from 'node:fs'; appendFileSync(${path}, '// guard-mutation');`,
    `import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict'; assert.ok(!readFileSync(${path},'utf8').includes('// guard-mutation'));`,
  ];
  const results = await checkPreservationProbes(task, receipt.image);
  assert.deepEqual(results.map(row => [row.passed, row.unchanged]), [[true, false], [true, true]]);
  assert.equal(JSON.stringify(results).includes('guard-mutation'), false);
});


test('named checks select a literal prefix and reject empty file-wrapper success', async () => {
  const prefix = 'probe.+: ';
  const encodedPrefix = 'probe #\\:\t ';
  const fixture = await mkdtemp(join(tmpdir(), 'fusion-named-check-'));
  try {
    await writeFile(join(fixture, 'fixture.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict';
test('original contract', () => assert.fail('unselected original'));
test('probeXX: unrelated', () => assert.fail('regex metacharacters must be literal'));
test('probe.+: selected', () => assert.ok(true));
test.skip('skipped: selected', () => assert.fail('must not count'));
test.todo('todo: selected');
test('failure: selected', () => assert.fail('selected assertion failed'));
test(${JSON.stringify(encodedPrefix + 'selected')}, () => assert.ok(true));
`);
    await writeFile(join(fixture, 'empty.test.mjs'), '');
    const box = { exec: async (args, options) => {
      assert.equal(args[0], 'timeout');
      assert.equal(options.allowFailure, true);
      const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
      const child = spawnSync(process.execPath, args.slice(4), { cwd: fixture, timeout: 10000, env });
      assert.equal(child.error, undefined);
      return { code: child.status, stdout: child.stdout, stderr: child.stderr };
    } };
    const pass = await check(box, ['fixture.test.mjs'], 15000, { testNamePrefix: prefix });
    assert.equal(pass.passed, true, pass.feedback);
    assert.equal(pass.matchedTestPrefix, true);
    const encoded = await check(box, ['fixture.test.mjs'], 15000, { testNamePrefix: encodedPrefix });
    assert.equal(encoded.passed, true, encoded.feedback);
    const filename = await check(box, ['fixture.test.mjs'], 15000, { testNamePrefix: 'fixture.test.mjs' });
    assert.equal(filename.passed, false);
    assert.equal(filename.matchedTestPrefix, false);
    const empty = await check(box, ['fixture.test.mjs'], 15000, { testNamePrefix: 'missing: ' });
    assert.equal(empty.passed, false);
    assert.equal(empty.matchedTestPrefix, false);
    assert.match(empty.feedback, /No test matched/);
    for (const testNamePrefix of ['skipped: ', 'todo: ']) {
      const skipped = await check(box, ['fixture.test.mjs', 'empty.test.mjs'], 15000, { testNamePrefix });
      assert.equal(skipped.passed, false, skipped.feedback);
      assert.equal(skipped.matchedTestPrefix, false);
    }
    const failure = await check(box, ['fixture.test.mjs'], 15000, { testNamePrefix: 'failure: ' });
    assert.equal(failure.passed, false);
    assert.equal(failure.matchedTestPrefix, true);
    assert.match(failure.feedback, /selected assertion failed/);
    assert.doesNotMatch(failure.feedback, /No test matched/);
    const defaultResult = await check(box, ['fixture.test.mjs'], 15000);
    assert.equal(defaultResult.passed, false);
    assert.equal('matchedTestPrefix' in defaultResult, false);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('invalid name prefixes fail before a test process or acceptance mutation', async () => {
  const box = { exec: () => { throw Error('must not execute'); }, execUnprivileged: () => { throw Error('must not execute'); } };
  for (const testNamePrefix of ['', ' ', '\nname', 'name\r', 123, 'x'.repeat(257)]) {
    await assert.rejects(check(box, ['fixture.test.mjs'], 1000, { testNamePrefix }), /invalid_test_name_prefix/);
    await assert.rejects(checkAcceptance(box, ['fixture.test.mjs'], [], 1000, { testNamePrefix }), /invalid_test_name_prefix/);
  }
});
