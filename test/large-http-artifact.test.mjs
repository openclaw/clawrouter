import {getStaticTOMLValue,parseTOML} from 'toml-eslint-parser';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {buildLargeHttp} from '../scripts/build-large-http.mjs';
const require=createRequire(import.meta.resolve('wrangler/package.json'));
const {build}=require('esbuild'),{Miniflare,convertV4MiniflareOptions}=require('miniflare');
const runtimeConfig=getStaticTOMLValue(parseTOML(await readFile(new URL('../wrangler.toml',import.meta.url),'utf8')));
const digest=b=>createHash('sha256').update(b).digest('hex');

test('native artifact uses versioned assets without changing main runtime flags or exposing direct URLs',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'native-artifact-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const manifest=await buildLargeHttp(dir),native=await readFile(join(dir,'assets',manifest.runtime.assetPath)),worker=await readFile(join(dir,'worker.mjs'),'utf8');
 assert.equal(manifest.runtime.type,'Asset');
 assert.equal(manifest.runtime.assetPath,'__large_http/artifact/'+digest(native)+'.mjs');
 assert.equal(native.length,manifest.runtime.bytes);assert.equal(digest(native),manifest.runtime.sha256);
 assert.deepEqual(runtimeConfig.compatibility_flags,['enable_request_signal']);
 assert.equal(runtimeConfig.assets.run_worker_first,true);
 assert.equal(runtimeConfig.assets.directory,'.wrangler/large-http/assets');
 assert.doesNotMatch(worker,/native-runtime\.txt/);
 assert.ok(!worker.includes(JSON.stringify(native.toString())), 'native source must not be a JavaScript literal');
 const entry=join(dir,'service.mjs');
 await build({stdin:{contents:`import h from ${JSON.stringify(resolve('worker/index.ts'))};export default {fetch(r,e,c){return h.fetch(r,{...e,LARGE_HTTP_TOKEN:'fixture',LARGE_HTTP_POOL:{},LARGE_HTTP_SLOTS:{getByName(){return {fetch(){return Response.json({authorized:r.headers.get('x-fixture-authorized')==='1'});}}}}},c);}};`,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],define:{__LARGE_HTTP_RUNTIME_SHA__:JSON.stringify(manifest.runtime.sha256)},outfile:entry,logLevel:'silent'});
 const run=async(assets,fn)=>{const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'artifact-proof',modulesRoot:dir,modules:[{type:'ESModule',path:entry}],compatibilityDate:runtimeConfig.compatibility_date,compatibilityFlags:runtimeConfig.compatibility_flags,...(assets?{assets:{directory:assets,binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true}}}:{})}]}));try{await fn(mf);}finally{await mf.dispose();}};
 const headers={'x-large-http-slot':'0','x-large-http-generation':'1','x-large-http-token':'a'.repeat(64),'x-fixture-authorized':'1'};
 await run(join(dir,'assets'),async mf=>{
  const response=await mf.dispatchFetch('https://fixture/__large_http/runtime',{headers});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),native);
  for(const refused of [{...headers,'x-fixture-authorized':'0'},{...headers,'x-large-http-token':'invalid'}])assert.equal((await mf.dispatchFetch('https://fixture/__large_http/runtime',{headers:refused})).status,403);
  assert.equal((await mf.dispatchFetch('https://fixture/'+manifest.runtime.assetPath)).status,403,'Worker-first routing must guard the artifact itself');
  assert.equal((await mf.dispatchFetch('https://fixture/'+manifest.runtime.assetPath,{headers})).status,405,'only the authorized runtime operation serves the artifact');
  for(const alias of ['/assets/%2e%2e%2f'+manifest.runtime.assetPath,'/assets/..%2f'+manifest.runtime.assetPath,'/assets/%252e%252e%252f'+manifest.runtime.assetPath,'/%5f%5flarge_http/artifact/'+manifest.runtime.sha256+'.mjs']){const r=await mf.dispatchFetch('https://fixture'+alias);assert.notDeepEqual(Buffer.from(await r.arrayBuffer()),native,'alternate public path must never serve native source: '+alias);}
  assert.equal((await mf.dispatchFetch('https://fixture/v1/health')).status,200);
 });
 // An absent artifact/binding closes native bootstrap, while denial and the
 // ordinary path remain independent of asset availability.
 const missing=join(dir,'missing');await mkdir(missing);
 for(const assets of [missing,null])await run(assets,async mf=>{
  assert.equal((await mf.dispatchFetch('https://fixture/__large_http/runtime',{headers:{...headers,'x-fixture-authorized':'0'}})).status,403);
  assert.equal((await mf.dispatchFetch('https://fixture/__large_http/runtime',{headers})).status,503);
  assert.equal((await mf.dispatchFetch('https://fixture/v1/health')).status,200);
 });
});
