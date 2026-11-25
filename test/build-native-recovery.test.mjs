import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildLargeHttp } from '../scripts/build-large-http.mjs';
import { prepareNativeRecovery } from '../scripts/build-native-recovery.mjs';
import { verifyLargeHttpRelease } from '../scripts/prepare-large-http-release.mjs';

// A small generated source/artifact tree under the task repo resolves the one
// existing dependency graph. No private install or historical checkout.
test('recovery reproduces pinned native source, freezes current edge, detects drift and removes source staging',async t=>{
  const directory=await mkdtemp(resolve('.native-recovery-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const build=join(directory,'build');const manifest=await buildLargeHttp(build);
  const nativeFile=join(build,'assets',manifest.runtime.assetPath);
  const expected=await readFile(nativeFile);
  await rm(nativeFile); // the recovery builder must reproduce, not reuse, these bytes
  const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const configPath=join(directory,'source.toml');
  const source=(await readFile('wrangler.toml','utf8'))
    .replace(/^name =.*$/m,'name = "clawrouter-edge"'+String.fromCharCode(10)+'account_id = "'+'a'.repeat(32)+'"')
    .replace(/^main =.*$/m,'main = '+JSON.stringify(join(build,'worker.mjs')))
    .replace(/^directory =.*$/m,'directory = '+JSON.stringify(join(build,'assets')));
  await writeFile(configPath,source+`
[vars]
LARGE_HTTP_ORIGIN = "https://clawrouter.openclaw.ai"
`);
  const state={sha,cutover:{nativeSource:sha,blueRuntimeSha:manifest.runtime.sha256}};
  await prepareNativeRecovery({state,configPath,directory:join(directory,'release')});
  assert.deepEqual(await readFile(nativeFile),expected);
  const frozen=await verifyLargeHttpRelease(state.recoveryReleaseManifest);
  const recoveryConfig=await readFile(frozen.stages.green.path,'utf8');
  assert.match(recoveryConfig,/recovery-worker[.]mjs/);
  assert.equal(frozen.files[nativeFile],createHash('sha256').update(expected).digest('hex'));
  await assert.rejects(access(join(build,'recovery-source')),e=>e.code==='ENOENT');
  await writeFile(nativeFile,'drift');await assert.rejects(verifyLargeHttpRelease(state.recoveryReleaseManifest),/artifact drift/);
});
