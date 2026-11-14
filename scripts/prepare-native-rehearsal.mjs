// Local packaging only; NEVER reads credentials, provisions, uploads or dispatches.
import {readFile,writeFile,mkdir,cp,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {getStaticTOMLValue,parseTOML} from 'toml-eslint-parser';
import {buildLargeHttp} from './build-large-http.mjs';
import {prepareNativeRecovery} from './build-native-recovery.mjs';
import {prepareLargeHttpRelease,verifyLargeHttpRelease} from './prepare-large-http-release.mjs';
import {isolatedNativeTarget} from './deploy-native-target.mjs';
import {fullSha} from './deploy-train-policy.mjs';
import {nativeControlDigest} from './deploy-native-qualification.mjs';
export async function prepareNativeRehearsal({configPath,directory,nativeSource,blueRuntimeSha,minutes=60}){
 fullSha(nativeSource);
 if(!/^[a-f0-9]{64}$/.test(blueRuntimeSha)||!Number.isSafeInteger(minutes)||minutes<15||minutes>60)throw Error('Invalid rehearsal bounds');
 const source=await readFile(configPath,'utf8'),config=getStaticTOMLValue(parseTOML(source));
 const target=isolatedNativeTarget({worker:config.name,origin:config.vars?.LARGE_HTTP_ORIGIN,account:config.account_id});
 if(config.vars?.CLAWROUTER_PUBLIC_ORIGIN!==target.origin||config.vars?.LARGE_HTTP_DEADLINE!==undefined||config.vars?.LARGE_HTTP_RUNTIME_SHA!==undefined||config.vars?.LARGE_HTTP_RUNTIME_BYTES!==undefined||config.vars?.LARGE_HTTP_CAPACITY!=='8'||config.vars?.LARGE_HTTP_TESTING!=='1'||config.vars?.NATIVE_REHEARSAL!==undefined||config.durable_objects?.bindings?.some(b=>b.name==='NATIVE_REHEARSAL_STATE')||config.routes?.length||config.services?.length)throw Error('Expected inspected isolated continuous eight-slot config without fixture overrides');
 // No provider secret may be supplied as a plain-text build variable.
 if(config.containers?.length!==1||config.containers[0].name!==target.worker+'-large-http'||config.containers[0].class_name!=='LargeHttpSlot'||config.durable_objects?.bindings?.some(b=>b.script_name))throw Error('Expected owned isolated native container and local actors');
 if(Object.keys(config.vars).some(k=>/(?:API_KEY|TOKEN|SECRET)$/.test(k)))throw Error('Rehearsal config contains secret-like plaintext variables');
 const root=resolve(directory);await mkdir(root,{mode:0o700});
 const build=join(root,'build'),sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const manifest=await buildLargeHttp(build,{syntheticRehearsal:true});
 // Reuse the already-built console; no second dependency graph or admin build.
 const consoleAssets=resolve(dirname(configPath),config.assets.directory);
 for(const name of await readdir(consoleAssets))if(name!=='__large_http')await cp(join(consoleAssets,name),join(build,'assets',name),{recursive:true,errorOnExist:true,force:false});
 const createdAt=Date.now(),fixture={schema:1,worker:target.worker,origin:target.origin,createdAt,expiresAt:createdAt+minutes*60000,maxStarts:40,maxRequests:64};
 let text=source.replace(/^main\s*=.*$/m,'main = '+JSON.stringify(join(build,'worker.mjs'))).replace(/^directory\s*=.*$/m,'directory = '+JSON.stringify(join(build,'assets')))
  .replace(/^\[vars\]/m,'[vars]\nNATIVE_REHEARSAL = '+JSON.stringify(JSON.stringify(fixture)));
 text+='\n[[durable_objects.bindings]]\nname = "NATIVE_REHEARSAL_STATE"\nclass_name = "NativeRehearsalState"\n\n[[migrations]]\ntag = "native-rehearsal-only-v1"\nnew_sqlite_classes = ["NativeRehearsalState"]\n';
 const rendered=join(root,'source.toml');await writeFile(rendered,text,{flag:'wx',mode:0o600});
 const state={sha,cutover:{nativeSource,blueRuntimeSha}};
 // Freeze assets only AFTER both exact payloads exist, so inventories agree.
 await prepareNativeRecovery({state,configPath:rendered,directory:join(root,'old-release'),syntheticRehearsal:true});
 const green=await prepareLargeHttpRelease({configPath:rendered,directory:join(root,'green-release')});
 const old=await verifyLargeHttpRelease(state.recoveryReleaseManifest);await verifyLargeHttpRelease(green.path);
 const result={schema:1,source:sha,controlSha256:nativeControlDigest(),qualified:false,worker:target.worker,origin:target.origin,fixture,
  blueRuntimeSha,greenRuntimeSha:manifest.runtime.sha256,nativeSource,green:green.path,old:state.recoveryReleaseManifest,
  bootstrap:old.stages.bootstrap.path,blue:old.stages.green.path,recovery:old.stages.green.path};
 await writeFile(join(root,'preparation.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [configPath,directory,nativeSource,blueRuntimeSha]=process.argv.slice(2);
 if(!blueRuntimeSha)throw Error('Usage: prepare-native-rehearsal.mjs <isolated-rendered-config> <new-directory> <old-source-sha> <old-native-sha256>');
 console.log(JSON.stringify(await prepareNativeRehearsal({configPath,directory,nativeSource,blueRuntimeSha})));
}
