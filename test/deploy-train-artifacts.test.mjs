import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareNativeUpload, nativeUploadConfig } from '../scripts/deploy-train-artifacts.mjs';
import { nativeVersion } from './helpers/deploy-native-fixture.mjs';
import { uploadMessage } from '../scripts/deploy-train-secrets.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
export async function artifactFixture(directory) {
  const build = join(directory, '.wrangler/large-http'), assets = join(build, 'assets');
  const runtime = Buffer.from('export const syntheticNativeArtifact = true;\n'), worker = Buffer.from('export default {};\n');
  const runtimeSha = hash(runtime), input = join(directory, 'input.ts');
  await mkdir(join(assets, '__large_http/artifact'), { recursive: true });
  await writeFile(input, '// controlled build input\n');
  const nativeFile = join(assets, '__large_http/artifact', runtimeSha + '.mjs');
  await writeFile(nativeFile, runtime); await writeFile(join(build, 'worker.mjs'), worker);
  await writeFile(join(build, 'manifest.json'), JSON.stringify({ schema: 1, runtime: { sha256: runtimeSha, bytes: runtime.length, assetPath: '__large_http/artifact/' + runtimeSha + '.mjs' }, worker: { sha256: hash(worker), bytes: worker.length }, files: { [input]: hash(await readFile(input)) } }));
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const blue = nativeVersion('11111111-1111-1111-1111-111111111111', 'b'.repeat(40));
  blue.annotations['workers/message'] = uploadMessage({ run: '122', sha: 'b'.repeat(40), blue: '99999999-9999-9999-9999-999999999999', native: { schema: 1, runtimeSha } });
  const configPath = join(directory, 'source.toml'), source = await readFile('wrangler.toml', 'utf8');
  const vars = blue.resources.bindings.filter(b => b.type === 'plain_text').map(b => `${b.name} = ${JSON.stringify(b.text)}`).join('\n');
  await writeFile(configPath, source.replace(/^main =.*$/m, `main = ${JSON.stringify(join(build, 'worker.mjs'))}`).replace(/^directory =.*$/m, `directory = ${JSON.stringify(assets)}`).replace(/^name =.*$/m, 'name = "clawrouter-edge"\naccount_id = "' + 'a'.repeat(32) + '"') + '\n[[kv_namespaces]]\nbinding = "POLICY_KV"\nid = "' + 'a'.repeat(32) + '"\n\n[vars]\n' + vars + '\n');
  return { state: { blue: blue.id, sha, run: '123' }, blue, configPath, directory: join(directory, 'release'), nativeFile, input };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'train-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return artifactFixture(directory);
}
test('frozen controller imports without its own dependency installation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'train-controller-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp('scripts', join(directory, 'scripts'), { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(directory, 'scripts/deploy-train.mjs')).href)})`], { cwd: process.cwd(), stdio: 'pipe' });
});
test('native upload freezes the ingress-enabled package and rejects subsequent artifact drift', async t => {
  const f = await fixture(t);
  await prepareNativeUpload(f);
  const config = await nativeUploadConfig(f.state, { account: 'a'.repeat(32) }), bytes = await readFile(config, 'utf8');
  assert.ok(config.endsWith('/green.toml'));
  assert.doesNotMatch(bytes, /^\[build\]/m); assert.match(bytes, /LARGE_HTTP_INGRESS_ENABLED = "1"/);
  await writeFile(f.nativeFile, 'corrupted');
  await assert.rejects(nativeUploadConfig(f.state, { account: 'a'.repeat(32) }), /artifact drift/);
});
test('frozen native config cannot select a different account', async t => {
  const f = await fixture(t); await prepareNativeUpload(f);
  await assert.rejects(nativeUploadConfig(f.state, { account: 'b'.repeat(32) }), /target mismatch/);
});
for (const [name, mutate] of Object.entries({
  'disabled ingress': async f => writeFile(f.configPath, (await readFile(f.configPath, 'utf8')).replace('LARGE_HTTP_INGRESS_ENABLED = "1"', 'LARGE_HTTP_INGRESS_ENABLED = "0"')),
  'changed capacity': async f => writeFile(f.configPath, (await readFile(f.configPath, 'utf8')).replace('LARGE_HTTP_CAPACITY = "8"', 'LARGE_HTTP_CAPACITY = "7"')),
  'changed cron': async f => writeFile(f.configPath, (await readFile(f.configPath, 'utf8')).replace('*/5 * * * *', '* * * * *')),
  'changed container': async f => writeFile(f.configPath, (await readFile(f.configPath, 'utf8')).replace('scheduling_policy = "durable_object"', 'scheduling_policy = "other"')),
  'changed KV owner': async f => writeFile(f.configPath, (await readFile(f.configPath, 'utf8')).replace('id = "' + 'a'.repeat(32) + '"\n\n[vars]', 'id = "' + 'c'.repeat(32) + '"\n\n[vars]')),
  'changed build input': async f => writeFile(f.input, 'changed'),
  'changed native bytes': async f => writeFile(f.nativeFile, 'changed'),
  'different native digest': async f => { f.blue.annotations['workers/message'] = f.blue.annotations['workers/message'].replace(/:native-v1:[a-f0-9]{64}$/, ':native-v1:' + 'f'.repeat(64)); },
})) {
  test(`pre-upload freeze rejects ${name}`, async t => {
    const f = await fixture(t); await mutate(f); await assert.rejects(prepareNativeUpload(f));
    assert.equal(f.state.releaseManifest, undefined);
  });
}
