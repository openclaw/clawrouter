import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {hostedBoundaryFixture} from './helpers/native-rehearsal.mjs';
import {prepareNativeRehearsal} from '../scripts/prepare-native-rehearsal.mjs';
import {NATIVE_ANCHOR} from '../scripts/deploy-train-runtime.mjs';
import {until,workloadBody} from '../scripts/native-rehearsal-client.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex'),token='d'.repeat(64),seed='a'.repeat(64);
// Exact bundled old/current native modules, real native HTTP/spool/router and
// fixture DO/SQLite accounting. Local transport substitution only: NOT a test of
// Cloudflare interception or eight real containers; allocator ACKs are controlled.
test('exact old and current payloads use fixture old state and real accounting, never retry uncertainty',{timeout:120000},async t=>{
 const d=await mkdtemp(resolve('.native-rehearsal-runtime-'));t.after(()=>rm(d,{recursive:true,force:true}));
 const f=await hostedBoundaryFixture(t);assert.equal((await f.call('setup',{seedHash:hash(seed),credentialHash:hash('synthetic-client')})).status,200);
 await mkdir(join(d,'assets'));await writeFile(join(d,'assets/index.html'),'fixture');
 let config=(await readFile('wrangler.toml','utf8')).replace(/^name =.*$/m,'name = "clawrouter-native-qualification-abcdef012345"\naccount_id = "'+'a'.repeat(32)+'"').replace('clawrouter-edge-large-http','clawrouter-native-qualification-abcdef012345-large-http').replace(/^directory =.*$/m,'directory = "assets"').replace(/\n\[\[routes\]\][\s\S]*$/,'');
 config+='\n[vars]\nLARGE_HTTP_ORIGIN = '+JSON.stringify(f.origin)+'\nCLAWROUTER_PUBLIC_ORIGIN = '+JSON.stringify(f.origin)+'\nLARGE_HTTP_TESTING = "1"\nLARGE_HTTP_CAPACITY = "8"\n';
 await writeFile(join(d,'source.toml'),config);
 const p=await prepareNativeRehearsal({configPath:join(d,'source.toml'),directory:join(d,'package'),nativeSource:NATIVE_ANCHOR.sha,blueRuntimeSha:NATIVE_ANCHOR.runtimeSha});
 const calls=[],finishes=[];let dispatches=0,child;
 const bridge=createServer(async(req,res)=>{
  try{
   if(['/__large_http/dispatch','/__large_http/finish'].includes(req.url)){
    let text='';for await(const part of req)text+=part;const v=JSON.parse(text);
    if(req.url.endsWith('/finish'))finishes.push(v);else dispatches++;
    res.end('{}');return;
   }
   let body;if(req.method!=='GET'){const parts=[];for await(const part of req)parts.push(part);body=Buffer.concat(parts);if(req.url==='/__large_http/do'){const v=JSON.parse(body);calls.push({binding:v.binding,url:v.url,slot:req.headers['x-large-http-slot'],generation:req.headers['x-large-http-generation'],tokenLength:req.headers['x-large-http-token']?.length});}}
   const r=await f.mf.dispatchFetch(f.origin+req.url,{method:req.method,headers:req.headers,...(body?{body}: {})});
   calls.push({path:req.url,status:r.status});res.writeHead(r.status,Object.fromEntries(r.headers));if(r.body)for await(const part of r.body)res.write(part);res.end();
  }catch{res.destroy();}
 });
 await new Promise(r=>bridge.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+bridge.address().port;
 const stop=async()=>{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(timer);}child=undefined;};
 t.after(async()=>{await stop();bridge.closeAllConnections();await new Promise(r=>bridge.close(r));});
 const hook=join(d,'local-transport.mjs');await writeFile(hook,'const real=globalThis.fetch,R=globalThis.Request;globalThis.fetch=(input,init)=>{const r=new R(input,init),u=new URL(r.url);if(u.origin==="https://api.openai.com"&&u.pathname==="/v1/responses")return real(new R('+JSON.stringify(base+'/test-upstream')+',r));if(u.origin==='+JSON.stringify(f.origin)+'&&u.pathname.startsWith("/__large_http/"))return real(new R('+JSON.stringify(base)+'+u.pathname,r));throw Error("Unexpected local egress");};');
 let count=0,finished=0;
 for(const runtimeSha of [p.blueRuntimeSha,p.greenRuntimeSha]){
  const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  const spools=join(d,'spools-'+count);await mkdir(spools);const native=join(d,'package/build/assets/__large_http/artifact',runtimeSha+'.mjs');assert.equal(hash(await readFile(native)),runtimeSha);
  let stderr='';child=spawn(process.execPath,['--import',pathToFileURL(hook).href,native],{env:{PATH:process.env.PATH,TMPDIR:spools,PORT:String(port),LARGE_HTTP_SLOT:'0',LARGE_HTTP_GENERATION:'1',LARGE_HTTP_RUNTIME_TOKEN:token,LARGE_HTTP_RUNTIME_SHA:runtimeSha,LARGE_HTTP_ORIGIN:f.origin},stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>stderr=(stderr+b).slice(-1000));
  const health=()=>fetch('http://127.0.0.1:'+port+'/health',{headers:{'x-container-token':token}}).then(r=>r.json());
  const h=await until(async()=>{if(child.exitCode!==null)throw Error('native startup failed: '+stderr);try{return await health();}catch{return false;}},15000);
  for(const mode of ['success','reject','max','overflow','lost']){
   count++;const caseId=count.toString(16).padStart(32,'0'),grant={slot:0,generation:1,boot:h.boot,fence:count,id:'prf_'+caseId};
   const r=await fetch('http://127.0.0.1:'+port+'/v1/responses',{method:'POST',headers:{authorization:'Bearer clawrouter-live-rehearsal-synthetic-client','content-type':'application/json','x-container-token':token,'x-large-http-grant':JSON.stringify(grant)},body:workloadBody({caseId,mode,seed})});
   const text=await r.text(),value=text?JSON.parse(text):{};if(!text)t.diagnostic(JSON.stringify({mode,status:r.status,calls}));if(r.status===500)t.diagnostic(JSON.stringify({calls,stderr}));assert.equal(r.status,mode==='reject'?400:mode==='lost'?424:mode==='overflow'?413:200,JSON.stringify(value));if(mode==='overflow'){assert.equal(finishes.length,finished);continue;}finished++;await until(()=>finishes.length===finished);
   assert.equal(finishes.at(-1).clean,mode!=='lost');const cleaned=await health();assert.equal(cleaned.spoolBytes,0);assert.equal(cleaned.spoolFiles,0);assert.equal(cleaned.bodyBytesLeased,0);
  }
  await stop();assert.equal(hash(await readFile(native)),runtimeSha);
 }
 const s=await until(async()=>{const s=await(await f.call('snapshot')).json();return s.accounting.events.length===8?s:false;});
 assert.equal(dispatches,8);assert.equal(s.cases.length,8);assert.equal(s.replays,0);assert.equal(s.accounting.policySpentMicros,42);assert.equal(s.accounting.providerSpentMicros,42);assert.equal(s.accounting.events.reduce((sum,x)=>sum+x.actualCostMicros,0),42);assert.ok(s.accounting.events.every(x=>x.contentRetained===false));assert.deepEqual(f.outbound,[]);
});
