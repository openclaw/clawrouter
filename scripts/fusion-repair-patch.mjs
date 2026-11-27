import { mkdtemp, mkdir, writeFile, open, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { command, hash, validateTask, validateEdits } from './fusion-workloads.mjs';

export async function writeRepairPatch({ repo, task, files, patchPath, run = command }) {
  validateTask(task);
  validateEdits(task, files);
  if (!files.length || files.length > 32 || typeof patchPath !== 'string' || !patchPath) throw new Error('invalid_repair_patch');
  const root = await mkdtemp(join(tmpdir(), 'fusion-repair-patch-'));
  try {
    const modes = new Map((await run('git', ['ls-tree', '--format=%(objectmode) %(path)', task.base, '--', ...files.map(file => file.path)],
      { cwd: repo })).stdout.toString().trim().split('\n').map(line => {
      const [mode, path] = line.split(' ');
      return [path, mode];
    }));
    for (const file of files) {
      const mode = modes.get(file.path);
      if (!['100644', '100755'].includes(mode)) throw new Error('invalid_repair_patch');
      const original = (await run('git', ['--no-pager', 'show', `${task.base}:${file.path}`],
        { cwd: repo, maxBytes: 256 * 1024 })).stdout;
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original);
      if (text.includes('\0') || file.content.includes('\0')) throw new Error('invalid_repair_patch');
      for (const [side, content] of [['a', original], ['b', file.content]]) {
        const path = join(root, side, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, { mode: mode === '100755' ? 0o700 : 0o600 });
      }
    }
    const diff = await run('git', ['--no-pager', '-c', 'core.attributesFile=/dev/null', '-c', 'core.autocrlf=false', 'diff',
      '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--text', '--full-index',
      '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', '--src-prefix=', '--dst-prefix=', '--', 'a', 'b'],
    { cwd: root, allowFailure: true, maxBytes: 16 * 1024 * 1024 });
    if (diff.code !== 1 || !diff.stdout.length) throw new Error('invalid_repair_patch');
    const target = resolve(patchPath), temporary = target + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(diff.stdout);
      await handle.close();
      await link(temporary, target);
    } finally { await handle.close(); await rm(temporary, { force: true }); }
    return { file: basename(target), bytes: diff.stdout.length, sha256: hash(diff.stdout) };
  } finally { await rm(root, { recursive: true, force: true }); }
}
