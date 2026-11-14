import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { nativeBindings, nativeReceipt, nativeSource, NATIVE_CLASSES } from './deploy-train-runtime.mjs';
import { prepareNativeRecovery } from './build-native-recovery.mjs';
import { prepareLargeHttpRelease, verifyLargeHttpRelease } from './prepare-large-http-release.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prepareNativeUpload({ state, blue, configPath = '.wrangler.generated.toml', directory, mode = 'rollout', prepareRecovery = prepareNativeRecovery }) {
  const receipt = nativeReceipt(blue);
  // Workflow dependencies are installed in candidate/, not the frozen control/
  // checkout which owns this module (same resolution rule as inspectSource).
  const { getStaticTOMLValue, parseTOML } = createRequire(resolve('package.json'))('toml-eslint-parser');
  const config = getStaticTOMLValue(parseTOML(await readFile(configPath, 'utf8')));
  const source = getStaticTOMLValue(parseTOML(await readFile('wrangler.toml', 'utf8')));
  const settings = c => ({ containers: c.containers, triggers: c.triggers, consumers: c.queues?.consumers, migrations: c.migrations, exports: c.exports, metadata: c.version_metadata });
  if (!isDeepStrictEqual(settings(config), settings(source))) throw new Error('Rendered native lifecycle or non-versioned settings changed');
  const bindings = new Map(nativeBindings(blue).map(b => [b.name, b]));
  for (const [name, value] of Object.entries(config.vars ?? {})) {
    const previous = bindings.get(name);
    if (previous?.type !== 'plain_text' || previous.text !== value) throw new Error('Rendered vars change the native configuration; use a separately reviewed release');
  }
  const actors = config.durable_objects?.bindings ?? [];
  if (actors.length !== Object.keys(NATIVE_CLASSES).length || Object.entries(NATIVE_CLASSES).some(([name, className]) =>
    actors.filter(b => b.name === name && b.class_name === className && !b.script_name).length !== 1)) throw new Error('Rendered canonical actor bindings changed');
  const requireOwner = (rows, name, field, expected) => {
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].binding !== name || rows[0][field] !== expected)
      throw new Error('Rendered persistent owner changed');
  };
  requireOwner(config.kv_namespaces, 'POLICY_KV', 'id', bindings.get('POLICY_KV').namespace_id);
  requireOwner(config.r2_buckets, 'CONTENT_ARCHIVE', 'bucket_name', bindings.get('CONTENT_ARCHIVE').bucket_name);
  requireOwner(config.queues?.producers, 'USAGE_QUEUE', 'queue', bindings.get('USAGE_QUEUE').queue_name);
  if (config.assets?.binding !== 'ASSETS' || config.assets.run_worker_first !== true || config.no_bundle !== true || config.keep_vars !== true ||
      config.vars?.LARGE_HTTP_ENABLED !== '1' || config.vars?.LARGE_HTTP_INGRESS_ENABLED !== '1') throw new Error('Rendered native lifecycle, ingress or assets disabled');
  const worker = resolve(dirname(configPath), config.main), assets = resolve(dirname(configPath), config.assets.directory);
  const manifest = JSON.parse(await readFile(resolve(dirname(worker), 'manifest.json'), 'utf8'));
  const runtimeSha = manifest.runtime?.sha256;
  if (manifest.schema !== 1 || !/^[a-f0-9]{64}$/.test(runtimeSha ?? '') ||
      manifest.runtime.assetPath !== `__large_http/artifact/${runtimeSha}.mjs`) throw new Error('Invalid native runtime manifest');
  const changed = runtimeSha !== receipt.runtimeSha;
  if (changed && mode !== 'native-cutover') throw new Error('Different native runtime fingerprint; use a separately rehearsed cutover');
  if (mode === 'native-cutover' && (!changed || state.unsafe || state.migration)) throw new Error('Native cutover requires a different, rollback-compatible payload');
  const native = await readFile(resolve(assets, manifest.runtime.assetPath)), edge = await readFile(worker);
  if (hash(native) !== runtimeSha || native.length !== manifest.runtime.bytes || hash(edge) !== manifest.worker?.sha256 || edge.length !== manifest.worker.bytes)
    throw new Error('Native build artifact drift');
  if (!manifest.files || !Object.keys(manifest.files).length) throw new Error('Native build inputs missing');
  for (const [path, digest] of Object.entries(manifest.files)) {
    if (hash(await readFile(path)) !== digest) throw new Error('Native build input drift');
  }
  if (blue.id !== state.blue) throw new Error('Native release source differs from train');
  state.native = { schema: 1, runtimeSha };
  if (changed) {
    state.cutover = { schema: 1, blueRuntimeSha: receipt.runtimeSha, nativeSource: nativeSource(blue), phase: 'prepared' };
    await prepareRecovery({ state, configPath, directory: directory + '-recovery' });
  }
  const release = await prepareLargeHttpRelease({ configPath, directory });
  if (release.sha !== state.sha) throw new Error('Native release source differs from train');
  state.releaseManifest = release.path;
  state.releaseManifestSha256 = release.sha256;
  return release;
}
export async function nativeUploadConfig(state, { account = process.env.CLOUDFLARE_ACCOUNT_ID } = {}) {
  if (!state.releaseManifest || hash(await readFile(state.releaseManifest)) !== state.releaseManifestSha256) throw new Error('Frozen native release receipt missing or changed');
  const manifest = await verifyLargeHttpRelease(state.releaseManifest);
  if (!account || manifest.account !== account || manifest.sha !== state.sha || manifest.worker !== 'clawrouter-edge') throw new Error('Frozen native release target mismatch');
  return manifest.stages.green.path; // Never upload bootstrap or ingress-closed blue.
}
