import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, hash } from '../scripts/fusion-workloads.mjs';
import { writeRepairPatch } from '../scripts/fusion-repair-patch.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fusion-patch-test-'));
  try {
    const repo = join(root, 'repo');
    await mkdir(join(repo, 'worker'), { recursive: true });
    await mkdir(join(repo, 'scripts'));
    const before = '\ufeffconst text = "old 🦊";';
    await writeFile(join(repo, 'worker/example.ts'), before);
    await writeFile(join(repo, 'scripts/example.mjs'), 'console.log("old");\n', { mode: 0o700 });
    const git = args => command('git', args, { cwd: repo });
    await git(['init', '-q', '--template=']);
    await git(['add', 'worker/example.ts', 'scripts/example.mjs']);
    await git(['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const base = (await git(['rev-parse', 'HEAD'])).stdout.toString().trim();
    const task = { id: 'patch-example', split: 'development', base, oracle: 'b'.repeat(40),
      editPaths: ['worker/example.ts', 'scripts/example.mjs'], visibleTests: ['test/example.test.mjs'],
      hiddenTests: ['test/hidden.test.mjs'], instruction: 'Update the example.' };
    const files = [{ path: 'worker/example.ts', content: '\ufeffconst text = "new 🦊";\n' },
      { path: 'scripts/example.mjs', content: 'console.log("new");' }];
    await fn({ root, repo, task, files, before, patchPath: join(root, 'review.patch') });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('review patch applies exactly, preserving UTF-8, EOF newlines and executable files', () => fixture(async options => {
  const receipt = await writeRepairPatch(options), patch = await readFile(options.patchPath);
  assert.deepEqual(receipt, { file: 'review.patch', bytes: patch.length, sha256: hash(patch) });
  if (process.platform !== 'win32') assert.equal((await stat(options.patchPath)).mode & 0o777, 0o600);
  assert.ok(!patch.toString().includes(options.root));
  assert.match(patch.toString(), /diff --git a\/worker\/example.ts b\/worker\/example.ts/);
  assert.match(patch.toString(), /No newline at end of file/);
  assert.equal(await readFile(join(options.repo, 'worker/example.ts'), 'utf8'), options.before);
  await command('git', ['apply', '--check', options.patchPath], { cwd: options.repo });
  await command('git', ['apply', options.patchPath], { cwd: options.repo });
  for (const file of options.files) assert.equal(await readFile(join(options.repo, file.path), 'utf8'), file.content);
  if (process.platform !== 'win32') assert.notEqual((await stat(join(options.repo, 'scripts/example.mjs'))).mode & 0o100, 0);
}));

test('host newline conversion cannot change verified CRLF bytes', () => fixture(async options => {
  const path = join(options.repo, 'worker/example.ts');
  await writeFile(path, 'first\r\nold\r\nlast\r\n');
  await command('git', ['-c', 'core.autocrlf=false', 'add', 'worker/example.ts'], { cwd: options.repo });
  await command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'CRLF fixture'], { cwd: options.repo });
  options.task.base = (await command('git', ['rev-parse', 'HEAD'], { cwd: options.repo })).stdout.toString().trim();
  options.files = [{ path: 'worker/example.ts', content: 'first\r\nnew\r\nlast\r\n' }];
  const run = (program, args, settings) => command(program, ['-c', 'core.autocrlf=true', ...args], settings);
  await writeRepairPatch({ ...options, run });
  await command('git', ['-c', 'core.autocrlf=false', 'apply', options.patchPath], { cwd: options.repo });
  assert.equal(await readFile(path, 'utf8'), options.files[0].content);
}));

test('patch check refuses conflicting target source', () => fixture(async options => {
  await writeRepairPatch(options);
  await writeFile(join(options.repo, 'worker/example.ts'), 'conflicting source\n');
  const checked = await command('git', ['apply', '--check', options.patchPath], { cwd: options.repo, allowFailure: true });
  assert.notEqual(checked.code, 0);
  assert.equal(await readFile(join(options.repo, 'worker/example.ts'), 'utf8'), 'conflicting source\n');
}));

test('patch publication never overwrites output or another temporary file', () => fixture(async options => {
  await writeFile(options.patchPath, 'existing output');
  await assert.rejects(writeRepairPatch(options));
  assert.equal(await readFile(options.patchPath, 'utf8'), 'existing output');
  await assert.rejects(access(options.patchPath + '.tmp'));
  await writeFile(options.patchPath + '.tmp', 'another writer');
  await assert.rejects(writeRepairPatch(options));
  assert.equal(await readFile(options.patchPath + '.tmp', 'utf8'), 'another writer');
}));

test('patch output excludes unchanged files and rejects binary source', () => fixture(async options => {
  options.files[1].content = 'console.log("old");\n';
  await writeRepairPatch(options);
  assert.ok(!(await readFile(options.patchPath, 'utf8')).includes('scripts/example.mjs'));
  options.files[0].content = 'binary\0source';
  await assert.rejects(writeRepairPatch({ ...options, patchPath: join(options.root, 'binary.patch') }), /invalid_repair_patch/);
  await assert.rejects(access(join(options.root, 'binary.patch')));
}));
