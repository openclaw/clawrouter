import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskSandbox } from '../scripts/fusion-workloads.mjs';

const image = `sha256:${'a'.repeat(64)}`, id = 'b'.repeat(64);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fusion-public-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'test'));
  const calls = [];
  const run = async (_program, args, options) => {
    calls.push(args);
    if (args[0] === 'create') return { stdout: Buffer.from(id) };
    if (options?.input) {
      assert.deepEqual(args.slice(0, 5), ['exec', '-i', id, 'node', '-e']);
      assert.equal(args[6], '/work');
      execFileSync(process.execPath, ['-e', args[5], root], { input: options.input, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    return { stdout: Buffer.alloc(0) };
  };
  const stage = files => taskSandbox({ visibleTests: files.map(f => f.path), editPaths: [], publicTestFiles: files }, image, run);
  return { root, calls, stage };
}

test('creates and replaces public tests in one command, preserving exact bytes', async t => {
  const { root, calls, stage } = await fixture(t);
  await writeFile(join(root, 'test/existing.test.mjs'), 'old');
  const files = [{ path: 'test/existing.test.mjs', content: "const text = '\u2603';\n" },
    { path: 'test/new.test.mjs', content: 'new\n' }];
  const box = await stage(files);
  try {
    assert.equal(calls.filter(c => c[0] === 'exec').length, 2); // Readiness plus one staging command.
    for (const file of files) assert.equal(await readFile(join(root, file.path), 'utf8'), file.content);
  } finally { await box.close(); }
  assert.deepEqual(calls.at(-1), ['rm', '-f', id]);
});

test('rejects linked files, linked parents, missing parents and directories without changing targets', async t => {
  for (const kind of ['file', 'parent', 'missing', 'directory']) {
    const { root, calls, stage } = await fixture(t);
    await writeFile(join(root, 'kept'), 'kept');
    let path = 'test/new.test.mjs';
    if (kind === 'file') await symlink(join(root, 'kept'), join(root, path));
    if (kind === 'parent') { await symlink(join(root, 'test'), join(root, 'test/linked')); path = 'test/linked/new.test.mjs'; }
    if (kind === 'missing') path = 'test/missing/new.test.mjs';
    if (kind === 'directory') await mkdir(join(root, path));
    await assert.rejects(stage([{ path, content: 'replacement' }]));
    assert.equal(await readFile(join(root, 'kept'), 'utf8'), 'kept');
    if (kind === 'parent') await assert.rejects(readFile(join(root, 'test/new.test.mjs')), { code: 'ENOENT' });
    assert.deepEqual(calls.at(-1), ['rm', '-f', id]);
  }
});
