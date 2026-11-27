// Build the DEPLOYED control source for the isolated blue. Recovery deliberately
// uses current compatible control instead. Confusing these skips upgrade proof.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fullSha } from './deploy-train-policy.mjs';
import { prepareLargeHttpRelease } from './prepare-large-http-release.mjs';
import { versionedSetting } from './deploy-train-runtime.mjs';
import { archiveDeploymentSource } from './archive-deployment-source.mjs';
export async function prepareNativeBaseline({ controlSource, runtimeSha, runtimeBytes, configPath, directory, baselineSettings={} }) {
  fullSha(controlSource);
  if (!/^[a-f0-9]{64}$/.test(runtimeSha) || !Number.isSafeInteger(runtimeBytes) || runtimeBytes <= 0) throw new Error('Invalid deployed baseline artifact');
  const source = resolve(directory + '-source'); await mkdir(source,{mode:0o700});
  const {build} = createRequire(import.meta.resolve('wrangler/package.json'))('esbuild');
  let edge;
  try {
    const paths = ['worker','runtime','shared','package.json'];
    if (execFileSync('git',['ls-tree','--name-only',controlSource,'--','packages/provider-plugin-contract'],{encoding:'utf8',timeout:30_000}).trim()) paths.push('packages/provider-plugin-contract');
    archiveDeploymentSource(controlSource,source,paths);
    edge = await build({absWorkingDir:source,nodePaths:[resolve('node_modules')],entryPoints:['worker/native-rehearsal-entry.ts'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],
      define:{__LARGE_HTTP_RUNTIME_SHA__:JSON.stringify(runtimeSha),__LARGE_HTTP_RUNTIME_BYTES__:String(runtimeBytes)},logLevel:'silent'});
  } finally { await rm(source,{recursive:true,force:true}); }
  const worker = resolve(directory + '-worker.mjs'), config = resolve(directory + '-source.toml');
  const bytes = edge.outputFiles[0].contents;
  await writeFile(worker,bytes,{flag:'wx',mode:0o600});
  let text=(await readFile(configPath,'utf8')).replace(/^main\s*=.*$/m,'main = '+JSON.stringify(worker));
  for(const [name,value] of Object.entries(baselineSettings)){
    if(!versionedSetting(name,value)||!text.includes('\n'+name+' = '))throw new Error('Unsupported isolated baseline setting');
    text=text.replace(new RegExp('^'+name+' =.*$','m'),name+' = '+JSON.stringify(value));
  }
  await writeFile(config,text,{flag:'wx',mode:0o600});
  const release = await prepareLargeHttpRelease({configPath:config,directory});
  return {...release,controlSource,workerSha256:createHash('sha256').update(bytes).digest('hex')};
}
