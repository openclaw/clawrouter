import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {Readable} from 'node:stream';
import {startWorkerdFixture} from './helpers/workerd.mjs';

const require=createRequire(import.meta.resolve('wrangler/package.json'));
const token='a'.repeat(64),secret='synthetic-runtime-accounting',cost=7;
const wait=async fn=>{for(let i=0;i<500;i++){const value=await fn();if(value)return value;await delay(10);}throw Error('runtime_accounting_deadline');};

// Real child runtime, canonical router, HTTP provider and workerd/SQLite ledgers.
// Allocator acknowledgments are controlled; Docker/Cloudflare are not exercised.
for(const mode of ['reject-401','reject-429','dispatch-rejected','dispatch-lost','dispatch-timeout','dispatch-late','dispatch-caller','provider-lost','success','soft-missing','soft-no-tier','soft-tier-only','soft-complete'])test('native accounting preserves authoritative outcome: '+mode,{timeout:20000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'large-http-accounting-'));await mkdir(directory+'/spools');
 const soft=mode.startsWith('soft-'),knownTier=soft&&!['soft-missing','soft-no-tier'].includes(mode),complete=mode==='soft-complete',cacheKnown=complete||mode==='soft-no-tier';
 let mf,child,output='',attempts=0,dispatches=0,releaseDispatch;const finishes=[];
 const released=new Promise(r=>releaseDispatch=r);
 const bridge=createServer(async(req,res)=>{
  try{
   if(req.url==='/v1/responses'){
    attempts++;for await(const chunk of req){};
    if(mode==='provider-lost'){req.socket.destroy();return;}
    const rejection=/^reject-(\d+)$/.exec(mode);
    res.writeHead(rejection?Number(rejection[1]):200,{'content-type':'application/json','retry-after':'0'});
    res.end(JSON.stringify(rejection?{error:{code:'synthetic_rejection',message:'synthetic rejection'}}:{id:'resp_fixture',object:'response',status:'completed',model:'gpt-6-astra',output:[],...(knownTier?{service_tier:'default'}:{}),usage:soft?{input_tokens:10,output_tokens:2,total_tokens:12,...(cacheKnown?{input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}:{})}:{input_tokens:1,output_tokens:1,total_tokens:2}}));return;
   }
   if(req.url==='/__large_http/dispatch'){
    dispatches++;for await(const chunk of req){};
    if(mode==='dispatch-lost'){req.socket.destroy();return;}
    if(mode==='dispatch-timeout')return;
    if(mode==='dispatch-late'||mode==='dispatch-caller')await released;
    res.writeHead(mode==='dispatch-rejected'?503:200);res.end('{}');return;
   }
   if(req.url==='/__large_http/finish'){
    let body='';for await(const chunk of req)body+=chunk;finishes.push(JSON.parse(body));res.end('{}');return;
   }
   const result=await mf.dispatchFetch('https://router.example'+req.url,{method:req.method,headers:req.headers,...(req.method==='GET'?{}:{body:Readable.toWeb(req),duplex:'half'})});
   res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
  }catch{res.destroy();}
 });
 await new Promise(r=>bridge.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+bridge.address().port;
 t.after(async()=>{
  releaseDispatch();
  if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(timer);}
  bridge.closeAllConnections();await new Promise(r=>bridge.close(r));await mf?.dispose();await rm(directory,{recursive:true,force:true});
 });
 mf=await startWorkerdFixture(directory+'/workerd',`
  import handler from './worker/index.ts';
  import {BudgetLedgerObject as BaseBudget} from './worker/ledgers.ts';
  import {largeHttpService} from './worker/large-http/service.ts';
  import {putGrantCredentials} from './worker/grant-credentials.ts';
  export * from './worker/index.ts';
  export class BudgetLedgerObject extends BaseBudget {
   constructor(state){super(state);this.fixtureSql=state.storage.sql;}
   fetch(r){return new URL(r.url).pathname==='/fixture-rows'?Response.json([...this.fixtureSql.exec('SELECT reserved_micros, settled, dispatch_started FROM budget_reservations')]):super.fetch(r);}
  }
  const events=[];
  export default {queue:handler.queue,async fetch(r,e,c){
   const p=new URL(r.url).pathname;
   if(p==='/fixture-events')return Response.json(events);
   if(p==='/fixture-setup'){
    for(const id of ['primary','alternate'])await putGrantCredentials(e,'oauth/fixture/'+id,{provider:'openai',kind:'api_key',enabled:true,credential:'synthetic-'+id});
    return Response.json({ok:true});
   }
   if(p.startsWith('/__large_http/')){
    if(p.endsWith('/queue'))events.push((await r.clone().json()).body);
    return largeHttpService(r,{...e,CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS:'0',LARGE_HTTP_TOKEN:${JSON.stringify(token)},LARGE_HTTP_POOL:{},LARGE_HTTP_SLOTS:{getByName:()=>({fetch:()=>Response.json({authorized:true,boot:'fixture',phase:'ready'})})}});
   }
   return handler.fetch(r,e,c);
  }};
 `,'export default {fetch(){throw Error("unexpected fixture egress")}};');
 const kv=await mf.getKVNamespace('POLICY_KV','router');
 await kv.put('policies/fixture',JSON.stringify({enabled:true,generation:'g1',providers:['openai'],tenantId:'default',budgetMode:soft?'soft':'reserve',monthlyBudgetMicros:soft?1e12:1000,requestCostMicros:soft?null:cost,retainRequestContent:false,grantRouting:{strategy:'priority',stickiness:'none',failover:true,environmentFallback:false}}));
 await kv.put('credentials/fixture',JSON.stringify({enabled:true,secretSha256:createHash('sha256').update(secret).digest('hex'),policyId:'fixture',policyGeneration:'g1'}));
 await kv.put('connections/openai',JSON.stringify({providerId:'openai',enabled:true,monthlyBudgetMicros:soft?1e12:1000}));
 assert.equal((await mf.dispatchFetch('https://router.example/fixture-setup')).status,200);
 const {build}=require('esbuild');
 await build({stdin:{contents:`import handler from ${JSON.stringify(resolve('worker/index.ts'))};import {providerById} from ${JSON.stringify(resolve('worker/providers.ts'))};import {startRuntime} from ${JSON.stringify(resolve('runtime/large-http/server.mjs'))};providerById('openai').base_urls.default=${JSON.stringify(origin)};${mode==='dispatch-late'?"providerById('openai').endpoints.find(e=>e.id==='responses').timeout_ms=500;":''}const nativeTimeout=AbortSignal.timeout;AbortSignal.timeout=ms=>nativeTimeout(ms===30000?1000:ms);const r=await startRuntime({providerOrigin:${JSON.stringify(origin)},route:(r,e,c)=>handler.fetch(r,e,c)});console.log(JSON.stringify({port:r.server.address().port,boot:r.boot}));`,resolveDir:process.cwd(),sourcefile:'native-accounting-proof.mjs'},bundle:true,format:'esm',platform:'node',target:'node24',define:{__CLAWROUTER_LARGE_RUNTIME__:'true'},outfile:directory+'/runtime.mjs',logLevel:'silent'});
 child=spawn(process.execPath,[directory+'/runtime.mjs'],{env:{...process.env,TMPDIR:directory+'/spools',PORT:'0',LARGE_HTTP_SLOT:'0',LARGE_HTTP_GENERATION:'1',LARGE_HTTP_RUNTIME_TOKEN:token,LARGE_HTTP_RUNTIME_SHA:'b'.repeat(64),LARGE_HTTP_ORIGIN:origin},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',()=>{});
 const ready=await wait(()=>{try{return JSON.parse(output.trim());}catch{return false;}});
 const caller=new AbortController();
 const pending=fetch('http://127.0.0.1:'+ready.port+'/v1/responses',{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-'+secret,'content-type':'application/json','x-container-token':token,'x-large-http-grant':JSON.stringify({slot:0,generation:1,boot:ready.boot,fence:1,id:'prf_'+'1'.repeat(32)})},body:JSON.stringify({model:'openai/gpt-6-astra',input:'synthetic accounting proof',max_output_tokens:32}),signal:AbortSignal.any([AbortSignal.timeout(5000),caller.signal])});
 const outcome=pending.catch(error=>{if(mode==='dispatch-caller'&&caller.signal.aborted)return null;throw error;});
 if(mode==='dispatch-caller'){await wait(()=>dispatches===1);caller.abort();}
 const response=await outcome,body=response?await response.json():{};await wait(()=>finishes.length===1);releaseDispatch();await delay(50);
 const rejected=mode.startsWith('reject-'),uncertain=mode==='provider-lost';
 const events=await(await mf.dispatchFetch('https://router.example/fixture-events')).json();
 const budgets=await mf.getDurableObjectNamespace('BUDGET_LEDGER','router'),ledgerRows=[];
 for(const name of ['default:fixture','provider:openai'])ledgerRows.push(await(await budgets.get(budgets.idFromName(name)).fetch('https://budget/fixture-rows')).json());
 const health=await(await fetch('http://127.0.0.1:'+ready.port+'/health',{headers:{'x-container-token':token}})).json();
 t.diagnostic(JSON.stringify({mode,providerAttempts:attempts,dispatches,status:response?.status??'disconnected',actualCostMicros:events[0]?.actual_cost_micros,clean:finishes[0].clean,ledgerRows,spoolBytes:health.spoolBytes,bodyBytesLeased:health.bodyBytesLeased}));
 assert.equal(attempts,rejected||uncertain||mode==='success'||soft?1:0,'only a definite provider attempt may carry cost');
 assert.equal(dispatches,1,'one dispatch RPC, never an automatic replay');
 assert.equal(response?.status??null,mode==='dispatch-caller'?null:rejected?Number(mode.slice(7)):uncertain?424:mode==='success'||soft?200:mode==='dispatch-late'?502:503,JSON.stringify(body));
 assert.equal(finishes[0].clean,!uncertain&&mode!=='dispatch-caller','known delivered outcomes retire cleanly; uncertainty or canceled delivery stays quarantined');
 if(rejected)assert.equal(body.error.code,'synthetic_rejection');
 assert.ok(!response?.headers.has('x-clawrouter-grant-failover'));
 assert.equal(events.length,1);assert.equal(events[0].actual_cost_micros,soft?(complete?200:0):uncertain||mode==='success'?cost:0);if(soft)assert.equal(events[0].cost_basis,complete?'manifest_pricing':'unpriced_usage');
 for(const rows of ledgerRows){
  assert.equal(rows.length,1);assert.equal(rows[0].settled,1);assert.equal(rows[0].reserved_micros,soft?(complete?200:0):uncertain||mode==='success'?cost:0);
 }
 assert.equal(health.spoolBytes,0);assert.equal(health.spoolFiles,0);assert.equal(health.bodyBytesLeased,0);
});
