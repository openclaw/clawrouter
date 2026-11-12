// Local packaging only. Infrastructure/secret preparation is a separate deployment,
// never an exception to the version train's source or secret-lineage guards.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';

const digest = b => createHash('sha256').update(b).digest('hex');
const parse = text => getStaticTOMLValue(parseTOML(text));
export const releaseStages = Object.freeze({
  bootstrap: { enabled: '0', ingress: '0' },
  blue: { enabled: '1', ingress: '0' },
  green: { enabled: '1', ingress: '1' },
});
async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(path));
    else if (entry.isFile()) result.push(path);
    else throw new Error('Release assets must be regular files');
  }
  return result.sort();
}
export async function prepareLargeHttpRelease({ configPath, directory }) {
  const sourcePath = resolve(configPath), source = await readFile(sourcePath, 'utf8'), config = parse(source);
  if (config.no_bundle !== true || config.keep_vars !== true || !/^[a-f0-9]{32}$/.test(config.account_id ?? '') ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name ?? '') || config.assets?.run_worker_first !== true)
    throw new Error('Expected rendered large-HTTP deployment config');
  const origin = new URL(config.vars?.LARGE_HTTP_ORIGIN);
  if (origin.origin !== config.vars.LARGE_HTTP_ORIGIN || origin.protocol !== 'https:') throw new Error('Invalid release origin');
  if (!config.migrations?.some(m => m.tag === 'v6-large-http' && ['LargeHttpPool', 'LargeHttpSlot'].every(c => m.new_sqlite_classes?.includes(c))))
    throw new Error('Large HTTP migration missing');
  const worker = await realpath(resolve(dirname(sourcePath), config.main)), assets = await realpath(resolve(dirname(sourcePath), config.assets.directory));
  const files = Object.fromEntries(await Promise.all([worker, ...await filesIn(assets)].map(async p => [p, digest(await readFile(p))])));
  // Require a new package directory. Existing release evidence is never replaced.
  await mkdir(directory, { mode: 0o700 });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30000 }).trim();
  const manifest = { schema: 1, sha, account: config.account_id, worker: config.name, origin: origin.origin, files, stages: {},
    order: ['bootstrap', 'provision-secret-once', 'blue', 'green-upload', '0', '10', '50', '100'],
    recovery: 'post-migration blue; preserve native assets, token and owners; stop admission then drain',
    limits: { automaticRetries: false, maximumMinutes: 30, cleanupReserveMinutes: 10 } };
  for (const [stage, flags] of Object.entries(releaseStages)) {
    const vars = { ...config.vars, LARGE_HTTP_ENABLED: flags.enabled, LARGE_HTTP_INGRESS_ENABLED: flags.ingress };
    // Rewrite whole vars/build blocks. No build during upload can change a frozen artifact.
    let text = source.replace(/^\[build\][\s\S]*?(?=^\[|$(?![\s\S]))/m, '')
      .replace(/^\[vars\][\s\S]*?(?=^\[|$(?![\s\S]))/m, '');
    text = text.replace(/^main\s*=.*$/m, `main = ${JSON.stringify(worker)}`)
      .replace(/^directory\s*=.*$/m, `directory = ${JSON.stringify(assets)}`);
    text += '\n[vars]\n' + Object.entries(vars).map(([k,v]) => `${k} = ${JSON.stringify(v)}`).join('\n') + '\n';
    const path = resolve(directory, stage + '.toml');
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
    manifest.stages[stage] = { path, sha256: digest(text), flags };
  }
  const path = resolve(directory, 'manifest.json');
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await verifyLargeHttpRelease(path);
  return { path, sha256: digest(await readFile(path)), sha, worker: config.name };
}
export async function verifyLargeHttpRelease(path) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest.schema !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sha ?? '') || !manifest.files ||
      Object.keys(manifest.stages ?? {}).sort().join() !== 'blue,bootstrap,green') throw new Error('Invalid release manifest');
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (!isAbsolute(file) || await realpath(file) !== file || digest(await readFile(file)) !== hash) throw new Error('Release artifact drift');
  }
  let lifecycle;
  for (const [name, flags] of Object.entries(releaseStages)) {
    const stage = manifest.stages[name], bytes = await readFile(stage.path);
    if (digest(bytes) !== stage.sha256) throw new Error('Release configuration drift');
    const c = parse(bytes.toString()), v = c.vars;
    if (c.name !== manifest.worker || c.account_id !== manifest.account || v?.LARGE_HTTP_ORIGIN !== manifest.origin ||
        v.LARGE_HTTP_ENABLED !== flags.enabled || v.LARGE_HTTP_INGRESS_ENABLED !== flags.ingress || c.build ||
        c.no_bundle !== true || c.keep_vars !== true || c.assets?.run_worker_first !== true ||
        !manifest.files[c.main]) throw new Error('Release stage contract mismatch');
    const assets = await filesIn(c.assets.directory);
    if (assets.some(p => !manifest.files[p]) || Object.keys(manifest.files).length !== assets.length + 1) throw new Error('Release asset inventory drift');
    // All bindings, runtime settings, cron and classes must match across stages.
    const comparable = structuredClone(c); delete comparable.vars.LARGE_HTTP_ENABLED; delete comparable.vars.LARGE_HTTP_INGRESS_ENABLED;
    const value = JSON.stringify(comparable);
    if (lifecycle && value !== lifecycle) throw new Error('Release lifecycle configuration differs');
    lifecycle = value;
  }
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'prepare' && a && b) console.log(JSON.stringify(await prepareLargeHttpRelease({ configPath: a, directory: b })));
  else if (mode === 'verify' && a && !b) {
    const m = await verifyLargeHttpRelease(a); console.log(JSON.stringify({ verified: true, sha: m.sha, worker: m.worker }));
  } else throw new Error('Usage: prepare-large-http-release.mjs prepare <rendered-config> <new-directory> | verify <manifest>');
}
