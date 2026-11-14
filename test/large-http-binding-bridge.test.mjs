import '../worker/test/typescript-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {largeHttpService} from '../worker/large-http/service.ts';
const require=createRequire(import.meta.resolve('wrangler/package.json'));

test('native binding bridge preserves control profiles, error responses and bounded KV streams',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'large-binding-proof-')),token='a'.repeat(64),calls=[],finishes=[];
 let child,output='',stderr='';
 const env={LARGE_HTTP_TOKEN:token,LARGE_HTTP_POOL:{},LARGE_HTTP_SLOTS:{getByName:()=>({fetch:async()=>Response.json({authorized:true,boot:ready?.boot,phase:'ready'})})},
  ACCESS_CONTROL:{idFromName:n=>n,get:name=>({fetch:async(input,init)=>{const r=new Request(input,init);calls.push({name,path:new URL(r.url).pathname,headers:[...r.headers],body:await r.text()});return new Response('{"error":{"code":"identity_limit"}}',{status:429,headers:{'content-type':'application/json','x-profile-result':'bounded','retry-after':'3'}});}})},
  POLICY_KV:{get:async(key,type)=>{assert.equal(type,'stream');if(key==='missing')return null;return new ReadableStream({type:'bytes',start(c){if(key!=='empty')c.enqueue(new TextEncoder().encode('{"bounded":true}'));c.close();}});}}
 };
 // Empty records remain distinct from missing records; canonical parsers own
 // the raw stream and its byte/complexity limits.
 let ready;
 const bridge=createServer(async(req,res)=>{
  try{
   if(req.url==='/__large_http/settings'){res.end('{}');return;}
   const parts=[];for await(const p of req)parts.push(p);const body=Buffer.concat(parts);
   if(req.url==='/__large_http/finish'){finishes.push(JSON.parse(body));res.end('{}');return;}
   const request=new Request(origin+req.url,{method:req.method,headers:req.headers,...(body.length?{body}: {})});
   const response=await largeHttpService(request,env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){stderr+=String(e);res.writeHead(500);res.end();}
 });
 await new Promise(r=>bridge.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+bridge.address().port;
 t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}bridge.closeAllConnections();await new Promise(r=>bridge.close(r));await rm(directory,{recursive:true,force:true});});
 await require('esbuild').build({stdin:{contents:`import {startRuntime} from ${JSON.stringify(resolve('runtime/large-http/server.mjs'))};const r=await startRuntime({route:async(request,env)=>{await request.arrayBuffer();const response=await env.ACCESS_CONTROL.get('fixture').fetch('https://clawrouter.internal/admission/resolve',{method:'POST',headers:{'x-clawrouter-identity-admission':'v1','x-profile-test':'exact'},body:'{}'});const present=await env.POLICY_KV.get('present','stream'),empty=await env.POLICY_KV.get('empty','stream'),missing=await env.POLICY_KV.get('missing','stream');return Response.json({status:response.status,profile:response.headers.get('x-profile-result'),retry:response.headers.get('retry-after'),error:await response.json(),present:await new Response(present).text(),empty:empty!==null&&await new Response(empty).text(),missing:missing===null});}});console.log(JSON.stringify({port:r.server.address().port,boot:r.boot}));`,resolveDir:process.cwd(),sourcefile:'binding-proof.mjs'},bundle:true,format:'esm',platform:'node',target:'node24',outfile:directory+'/runtime.mjs',logLevel:'silent'});
 child=spawn(process.execPath,[directory+'/runtime.mjs'],{env:{...process.env,TMPDIR:directory,PORT:'0',LARGE_HTTP_SLOT:'0',LARGE_HTTP_GENERATION:'1',LARGE_HTTP_RUNTIME_TOKEN:token,LARGE_HTTP_RUNTIME_SHA:'b'.repeat(64),LARGE_HTTP_ORIGIN:origin},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr+=b);
 const wait=async fn=>{for(let i=0;i<300;i++){const v=await fn();if(v)return v;await delay(10);}throw Error('binding_proof_deadline:'+stderr);};
 ready=await wait(()=>{try{return JSON.parse(output.trim());}catch{return false;}});
 const response=await fetch('http://127.0.0.1:'+ready.port+'/v1/responses',{method:'POST',headers:{'x-container-token':token,'x-large-http-grant':JSON.stringify({slot:0,generation:1,boot:ready.boot,fence:1,id:'prf_'+'1'.repeat(32)})},body:'{}'});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:429,profile:'bounded',retry:'3',error:{error:{code:'identity_limit'}},present:'{"bounded":true}',empty:'',missing:true});
 assert.equal(calls.length,1);assert.equal(calls[0].name,'fixture');assert.equal(calls[0].path,'/admission/resolve');assert.equal(new Headers(calls[0].headers).get('x-clawrouter-identity-admission'),'v1');assert.equal(new Headers(calls[0].headers).get('x-profile-test'),'exact');assert.equal(calls[0].body,'{}');
 await wait(()=>finishes.length===1);assert.equal(finishes[0].clean,true);assert.equal(stderr,'');
 const health=await(await fetch('http://127.0.0.1:'+ready.port+'/health',{headers:{'x-container-token':token}})).json();assert.equal(health.spoolBytes+health.spoolFiles+health.bodyBytesLeased+health.backgroundFailures,0);
});
