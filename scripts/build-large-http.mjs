// Build only. No deployment/config mutation or credentials are involved.
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {nativeProviderSnapshotPlugin} from './large-http-provider-snapshot.mjs';
const require=createRequire(import.meta.resolve('wrangler/package.json')),{build}=require('esbuild');
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function buildLargeHttp(directory,{syntheticRehearsal=false}={}){
 await mkdir(directory,{mode:0o700,recursive:true});
 const node=await build({entryPoints:['runtime/large-http/main.ts'],bundle:true,write:false,metafile:true,minify:true,keepNames:true,format:'esm',platform:'node',target:'node24',define:{__CLAWROUTER_LARGE_RUNTIME__:'true'},plugins:[nativeProviderSnapshotPlugin()],logLevel:'silent'});
 const runtime=node.outputFiles[0].contents;if(runtime.length>2097152)throw Error('runtime_bundle_limit');
 const edge=await build({entryPoints:[syntheticRehearsal?'worker/native-rehearsal-entry.ts':'worker/large-http-entry.ts'],bundle:true,write:false,metafile:true,format:'esm',platform:'browser',external:['cloudflare:workers'],define:{__LARGE_HTTP_RUNTIME_SHA__:JSON.stringify(hash(runtime)),__LARGE_HTTP_RUNTIME_BYTES__:String(runtime.length)},logLevel:'silent'});
 const files={};for(const p of new Set([...Object.keys(node.metafile.inputs),...Object.keys(edge.metafile.inputs),'scripts/build-large-http.mjs','scripts/large-http-provider-snapshot.mjs']))files[p]=hash(await readFile(p));
 const assetPath='__large_http/artifact/'+hash(runtime)+'.mjs';
 const manifest={schema:1,runtime:{sha256:hash(runtime),bytes:runtime.length,assetPath,type:'Asset'},worker:{sha256:hash(edge.outputFiles[0].contents),bytes:edge.outputFiles[0].contents.length},files};
 await mkdir(directory+'/assets/__large_http/artifact',{recursive:true,mode:0o700});
 for(const [name,bytes] of [['assets/'+assetPath,runtime],['worker.mjs',edge.outputFiles[0].contents],['manifest.json',JSON.stringify(manifest,null,2)+'\n']])await writeFile(directory+'/'+name,bytes,{flag:'wx',mode:0o600});return manifest;
}
if(process.argv[1]===new URL(import.meta.url).pathname)console.log(JSON.stringify(await buildLargeHttp(process.argv[2])));
