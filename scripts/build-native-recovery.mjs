// Build a recovery Worker with CURRENT fenced control code and the exact deployed
// native payload. Never reinstall dependencies or use the legacy bootstrap stage.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { nativeProviderSnapshotPlugin } from './large-http-provider-snapshot.mjs';
import { prepareLargeHttpRelease } from './prepare-large-http-release.mjs';
import { fullSha } from './deploy-train-policy.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
export async function prepareNativeRecovery({ state, configPath = '.wrangler.generated.toml', directory, syntheticRehearsal = false }) {
  fullSha(state.cutover.nativeSource);
  const require = createRequire(resolve('package.json'));
  const { parseTOML, getStaticTOMLValue } = require('toml-eslint-parser');
  const config = getStaticTOMLValue(parseTOML(await readFile(configPath,'utf8')));
  const canonicalRequire = createRequire(require.resolve('wrangler/package.json'));
  const { build } = canonicalRequire('esbuild');
  // Only source required by the native handler; not another checkout, install,
  // full history or runtime tree. The archive's ancestors resolve the task's
  // existing shared global dependency graph. Always delete it after consumption.
  const source = resolve(dirname(config.main),'recovery-source');
  await mkdir(source,{mode:0o700});
  let runtime;
  try {
    const archive = execFileSync('git',['archive',fullSha(state.cutover.nativeSource),'worker','runtime','shared','package.json'],{maxBuffer:32*1024*1024,timeout:30_000});
    execFileSync('tar',['-x','-f','-','-C',source],{input:archive,timeout:30_000});
    const old = await build({absWorkingDir:source,entryPoints:['runtime/large-http/main.ts'],bundle:true,write:false,minify:true,keepNames:true,
      format:'esm',platform:'node',target:'node24',define:{__CLAWROUTER_LARGE_RUNTIME__:'true'},plugins:[nativeProviderSnapshotPlugin()],logLevel:'silent'});
    runtime=old.outputFiles[0].contents;
  } finally { await rm(source,{recursive:true,force:true}); }
  if (hash(runtime) !== state.cutover.blueRuntimeSha) throw new Error('Deployed native payload could not be reproduced; no recovery upload is safe');
  const edge = await build({entryPoints:[syntheticRehearsal?'worker/native-rehearsal-entry.ts':'worker/large-http-entry.ts'],bundle:true,write:false,metafile:true,format:'esm',platform:'browser',external:['cloudflare:workers'],
    define:{__LARGE_HTTP_RUNTIME_SHA__:JSON.stringify(hash(runtime)),__LARGE_HTTP_RUNTIME_BYTES__:String(runtime.length)},logLevel:'silent'});
  const worker = resolve(dirname(config.main),'recovery-worker.mjs');
  const assets = resolve(dirname(configPath),config.assets.directory);
  await writeFile(resolve(assets,'__large_http/artifact/'+hash(runtime)+'.mjs'),runtime,{flag:'wx',mode:0o600});
  await writeFile(worker,edge.outputFiles[0].contents,{flag:'wx',mode:0o600});
  const recoveryConfig=resolve(dirname(config.main),'recovery-source.toml');
  const text=(await readFile(configPath,'utf8')).replace(/^main =.*$/m,'main = '+JSON.stringify(worker)).replace(/^directory =.*$/m,'directory = '+JSON.stringify(assets));
  await writeFile(recoveryConfig,text,{flag:'wx',mode:0o600});
  const release=await prepareLargeHttpRelease({configPath:recoveryConfig,directory});
  if(release.sha!==state.sha)throw new Error('Recovery edge source differs from train');
  state.recoveryReleaseManifest=release.path;state.recoveryReleaseManifestSha256=release.sha256;
  return release;
}
