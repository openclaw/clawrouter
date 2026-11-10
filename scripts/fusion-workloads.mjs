import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  if (![...task.visibleTests, ...task.hiddenTests].every(path => /\.test\.mjs$/.test(path))) throw new Error('invalid_test_path');
  validateSourceContext(task);
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
export function command(program, args, { cwd, input, timeout = 120000, maxBytes = 4 * 1024 * 1024, allowFailure = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
    const child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [], errors = []; let size = 0, failure;
    const timer = setTimeout(() => { failure = new Error('command_timeout'); child.kill('SIGKILL'); }, timeout);
    const collect = target => chunk => {
      size += chunk.length;
      if (size > maxBytes) { failure = new Error('command_output_limit'); child.kill('SIGKILL'); }
      else target.push(chunk);
    };
    child.stdout.on('data', collect(chunks)); child.stderr.on('data', collect(errors));
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
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
  return ['create', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user=1000:1000', '--memory=2g', '--cpus=2', '--pids-limit=128',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000',
    '--tmpfs=/work:rw,nosuid,nodev,size=1024m,uid=1000,gid=1000', '--workdir=/work', image,
    'sh', '-c', 'cp -a --no-preserve=ownership /seed/. /work/ && touch /work/.ready && exec sleep 3600'];
}

// No bind mounts, Docker socket, secrets, network, or caller-selected shell command.
export async function sandbox(image, run = command) {
  const id = (await run('docker', sandboxArgs(image))).stdout.toString().trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid_container_id');
  const exec = (args, options = {}) => run('docker', ['exec', '-i', id, ...args], options);
  try {
    await run('docker', ['start', id]);
    await exec(['node', '-e', `const fs=require('node:fs'); for(let i=0;i<200;i++){if(fs.existsSync('/work/.ready'))process.exit(0);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)}process.exit(1)`]);
    return { id, exec, close: () => run('docker', ['rm', '-f', id]) };
  } catch (error) { await run('docker', ['rm', '-f', id]); throw error; }
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

export function testResult(result) {
  const text = result.stdout.toString();
  const count = key => Number(text.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? -1);
  const tests = count('tests'), failed = count('fail'), passed = count('pass'), skipped = count('skipped'), cancelled = count('cancelled');
  const valid = tests > 0 && failed >= 0 && passed >= 0 && skipped >= 0 && cancelled === 0 && failed + passed + skipped === tests;
  return { valid, passed: valid && passed > 0 && result.code === 0 && failed === 0, tests, failures: failed, skipped,
    digest: hash(Buffer.concat([result.stdout, result.stderr])), failureFingerprints: failureFingerprints(text) };
}

export async function check(box, paths, timeout = 120000) {
  const result = await box.exec(['node', '--test-reporter=tap', '--test', ...paths], { allowFailure: true, timeout });
  return { ...testResult(result), feedback: Buffer.concat([result.stdout, result.stderr]).toString().slice(-12000) };
}

export async function probe(box, source, timeout = 15000) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 16000) throw new Error('invalid_probe');
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('invalid_probe');
  const limit = Math.min(15000, timeout);
  // The in-container watchdog owns the process group; killing docker exec alone
  // would leave a hanging probe alive. Give the client time to collect its exit.
  const result = await box.exec(['timeout', '--signal=KILL', `${limit / 1000}s`, 'node', '--input-type=module'],
    { input: source, allowFailure: true, timeout: limit + 2000 });
  return { passed: result.code === 0,
    // node:test can rethrow an uncaught assertion from its exception handler,
    // producing Node's exit code 7 instead of the usual uncaught exit code 1.
    // node:test reporters print caught assertion diagnostics on stdout.
    assertionFailed: [1, 7].includes(result.code) && /\bERR_ASSERTION\b/.test(Buffer.concat([result.stdout, result.stderr]).toString()),
    feedback: Buffer.concat([result.stdout, result.stderr]).toString().slice(-12000) };
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
    await writeFile(join(temp, 'Dockerfile'), `FROM ${nodeImage}\nWORKDIR /seed\nCOPY input0 package.json\nCOPY input1 pnpm-lock.yaml\nCOPY input2 pnpm-workspace.yaml\nCOPY input3 admin/package.json\nRUN corepack enable && corepack prepare pnpm@11.28.4 --activate && pnpm install --frozen-lockfile\nCOPY source.tar /tmp/source.tar\nRUN tar -xf /tmp/source.tar -C /seed && rm /tmp/source.tar && chmod -R a+rX /seed\n`);
    await run('docker', ['build', '--quiet', '--tag', tag, temp], { timeout: 600000, maxBytes: 4 * 1024 * 1024 });
    const image = (await run('docker', ['image', 'inspect', '--format={{.Id}}', tag])).stdout.toString().trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('invalid_image_id');
    return { image, tag };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function revisionFiles(repo, revision, paths) {
  return Promise.all(paths.map(async path => ({ path, content: (await git(repo, ['show', `${revision}:${path}`])).toString() })));
}

export async function verify(task, image, edits, repo) {
  validateEdits(task, edits);
  const box = await sandbox(image);
  try {
    await writeFiles(box, edits);
    // Files new in the oracle do not yet exist. Create their parent/empty file
    // only inside this fresh verifier before the same guarded write operation.
    const hidden = await revisionFiles(repo, task.oracle, task.hiddenTests);
    await box.exec(['node', '-e', `const fs=require('node:fs'),p=require('node:path');for(const f of JSON.parse(process.argv[1])){const x=p.resolve('/work',f);if(!fs.existsSync(x)){fs.mkdirSync(p.dirname(x),{recursive:true});fs.writeFileSync(x,'')}}`, JSON.stringify(task.hiddenTests)]);
    await writeFiles(box, hidden);
    const result = await check(box, [...new Set([...task.visibleTests, ...task.hiddenTests])]);
    const { feedback, ...receipt } = result;
    return receipt;
  } finally { await box.close(); }
}

// The repair must pass the original visible tests before acceptance tests replace
// any same-named files. Otherwise a benchmark can punish the correct repair.
export async function checkOracleVisible(task, image, edits, { makeSandbox = sandbox, write = writeFiles, test = check } = {}) {
  const box = await makeSandbox(image);
  try {
    await write(box, validateEdits(task, edits));
    const { feedback, ...receipt } = await test(box, task.visibleTests);
    return receipt;
  } finally { await box.close(); }
}

export function qualificationSucceeded({ visible, oracleVisible, broken, oracle, reproduction, oracleReproduction }) {
  return visible?.passed === true && oracleVisible?.valid === true && oracleVisible?.passed === true
    && broken?.valid === true && broken?.passed === false && oracle?.passed === true
    && (reproduction === undefined && oracleReproduction === undefined
      || reproduction?.assertionFailed === true && oracleReproduction?.passed === true);
}

export async function qualify(task, options) {
  const built = await buildTask(task, options);
  const box = await sandbox(built.image);
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
    const repaired = await sandbox(built.image);
    try {
      await writeFiles(repaired, edits);
      const { feedback, ...result } = await probe(repaired, task.reproducer); oracleReproduction = result;
    } finally { await repaired.close(); }
  }
  const evidence = { visible, oracleVisible, broken, oracle,
    ...(task.reproducer !== undefined ? { reproduction, oracleReproduction } : {}) };
  return { taskId: task.id, taskDigest: hash(JSON.stringify(task)), ...built, ...evidence,
    qualified: qualificationSucceeded(evidence) };
}
