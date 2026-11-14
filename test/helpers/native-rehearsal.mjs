import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const worker='clawrouter-native-qualification-abcdef012345',origin='https://'+worker+'.fixture.workers.dev';
const sha='c'.repeat(64),seed='a'.repeat(64),hash=x=>createHash('sha256').update(x).digest('hex');
const config=()=>({schema:1,worker,origin,createdAt:Date.now()-1000,expiresAt:Date.now()+600000,maxStarts:24,maxRequests:8});
const env=()=>({NATIVE_REHEARSAL:JSON.stringify(config()),NATIVE_REHEARSAL_STATE:{},LARGE_HTTP_ORIGIN:origin,CLAWROUTER_PUBLIC_ORIGIN:origin,LARGE_HTTP_CAPACITY:'8',LARGE_HTTP_TESTING:'1'});
const require=createRequire(import.meta.resolve('wrangler/package.json')),{build}=require('esbuild'),{Miniflare,convertV4MiniflareOptions}=require('miniflare');
export async function hostedBoundaryFixture(t){
 const directory=await mkdtemp(join(tmpdir(),'native-rehearsal-test-'));let mf;
 t.after(async()=>{await mf?.dispose();await rm(directory,{recursive:true,force:true});});
 const bundle=await build({stdin:{contents:
  "export * from './worker/native-rehearsal-entry.ts';import handler from './worker/native-rehearsal-entry.ts';import {largeHttpService} from './worker/large-http/service.ts';import {upstreamKey} from './worker/native-rehearsal/contract.ts';export default {queue:handler.queue,async fetch(r,e,c){const p=new URL(r.url).pathname;if(p.startsWith('/__large_http/'))return largeHttpService(r,{...e,LARGE_HTTP_TOKEN:'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',LARGE_HTTP_POOL:{},LARGE_HTTP_SLOTS:{getByName:()=>({fetch:()=>Response.json({authorized:true,boot:'fixture',phase:'ready'})})}});if(p==='/test-upstream'||p==='/v1/native/openai/v1/responses'){const h=new Headers(r.headers);h.set('authorization','Bearer '+upstreamKey);return c.exports.NativeRehearsalEgress({props:{slot:0,generation:1,runtimeSha:'"+sha+"'}}).fetch(new Request('https://api.openai.com/v1/responses',new Request(r,{headers:h})));}if(p==='/test-denied'){return c.exports.NativeRehearsalEgress({props:{slot:0,generation:1,runtimeSha:'"+sha+"'}}).fetch(new Request(r.headers.get('x-test-url'),r));}return handler.fetch(r,e,c);}};",
  resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',write:false,platform:'browser',external:['cloudflare:workers'],logLevel:'silent'});
 const outbound=[];
 mf=new Miniflare(convertV4MiniflareOptions({resourceTmpPath:directory,workers:[{name:'fixture',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-06-05',compatibilityFlags:['enable_request_signal'],bindings:{...Object.fromEntries(Object.entries(env()).filter(([k])=>k!=='NATIVE_REHEARSAL_STATE')),CLAWROUTER_ADMIN_TOKEN_SHA256:hash('synthetic-admin'),LARGE_HTTP_ENABLED:'0'},kvNamespaces:['POLICY_KV'],durableObjects:{NATIVE_REHEARSAL_STATE:{className:'NativeRehearsalState',useSQLite:true},ACCESS_CONTROL:{className:'PolicyBindingIndexObject',useSQLite:true},BUDGET_LEDGER:{className:'BudgetLedgerObject',useSQLite:true},USAGE_LEDGER:{className:'UsageLedgerObject',useSQLite:true},GRANT_CREDENTIALS:{className:'GrantCredentialObject',useSQLite:true}},queueProducers:{USAGE_QUEUE:'usage'},queueConsumers:{usage:{maxBatchSize:1,maxBatchTimeout:0}},outboundService:async r=>{outbound.push(r.url);return new Response(null,{status:403});}}]}));
 await mf.ready;
 const call=(op,value={},auth='synthetic-admin')=>mf.dispatchFetch(origin+'/__native_rehearsal/'+op,{method:'POST',headers:{authorization:'Bearer '+auth},body:JSON.stringify(value)});
 return {mf,call,outbound,directory,origin};
}
