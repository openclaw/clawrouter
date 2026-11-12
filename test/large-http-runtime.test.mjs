import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.resolve('wrangler/package.json'));

test('real runtime releases a canceled upload after cleanup, but retains dispatched uncertainty',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'large-runtime-test-')),finishes=[];
 let attempts=0,child,output='';
 const bridge=createServer(async(req,res)=>{
  if(req.url==='/__large_http/settings'){res.end('{}');return;}
  if(req.url==='/provider'){attempts++;if(attempts===2){req.socket.destroy();return;}res.end('{"ok":true}');return;}
  let body='';for await(const chunk of req)body+=chunk;
  if(req.url==='/__large_http/finish')finishes.push(JSON.parse(body));
  res.end('{}');
 });
 await new Promise(r=>bridge.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+bridge.address().port;
 t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}bridge.closeAllConnections();await new Promise(r=>bridge.close(r));await rm(directory,{recursive:true,force:true});});
 const {build}=require('esbuild');
 await build({stdin:{contents:`import {startRuntime} from ${JSON.stringify(resolve('runtime/large-http/server.mjs'))};const r=await startRuntime({providerOrigin:${JSON.stringify(origin)},route:async request=>{await request.arrayBuffer();return fetch(${JSON.stringify(origin+'/provider')},{signal:request.signal});}});console.log(JSON.stringify({port:r.server.address().port,boot:r.boot}));`,resolveDir:process.cwd(),sourcefile:'runtime-proof.mjs'},bundle:true,format:'esm',platform:'node',target:'node24',outfile:directory+'/runtime.mjs',logLevel:'silent'});
 const token='a'.repeat(64);child=spawn(process.execPath,[directory+'/runtime.mjs'],{env:{...process.env,PORT:'0',LARGE_HTTP_SLOT:'0',LARGE_HTTP_GENERATION:'1',LARGE_HTTP_RUNTIME_TOKEN:token,LARGE_HTTP_RUNTIME_SHA:'b'.repeat(64),LARGE_HTTP_ORIGIN:origin},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>output+=b);child.stderr.on('data',()=>{});
 const wait=async fn=>{for(let i=0;i<300;i++){const value=await fn();if(value)return value;await delay(10);}throw Error('runtime_proof_deadline');};
 const ready=await wait(()=>{try{return JSON.parse(output.trim());}catch{return false;}}),base='http://127.0.0.1:'+ready.port;
 const health=()=>fetch(base+'/health',{headers:{'x-container-token':token}}).then(r=>r.json());
 const headers=n=>({'x-container-token':token,'x-large-http-grant':JSON.stringify({slot:0,generation:1,boot:ready.boot,fence:n,id:'prf_'+String(n).padStart(32,'0')}),'content-type':'application/json'});
 const upload=request(base+'/v1/responses',{method:'POST',headers:{...headers(1),'content-length':String(64*1024*1024)}});upload.on('error',()=>{});upload.write(Buffer.alloc(65536,32));
 await wait(async()=>{const h=await health();return h.busy&&h.spoolBytes>0;});upload.destroy();
 await wait(()=>finishes.length===1);assert.equal(finishes[0].clean,true);assert.equal(attempts,0);
 const cleaned=await health();assert.equal(cleaned.boot,ready.boot);assert.equal(cleaned.spoolBytes,0);assert.equal(cleaned.spoolFiles,0);assert.equal(cleaned.bodyBytesLeased,0);
 const success=await fetch(base+'/v1/responses',{method:'POST',headers:headers(2),body:'{}'});assert.equal(success.status,200);await success.arrayBuffer();await wait(()=>finishes.length===2);assert.equal(finishes[1].clean,true);assert.equal(attempts,1);
 const uncertain=await fetch(base+'/v1/responses',{method:'POST',headers:headers(3),body:'{}'});assert.equal(uncertain.status,424);await uncertain.arrayBuffer();await wait(()=>finishes.length===3);assert.equal(finishes[2].clean,false);assert.equal(attempts,2);
 // The fake bridge only observes transport finish calls. Generation quarantine,
 // canonical reservations and native reuse are exercised by the canary proof.
});

test('real runtime bounds stalled RPC headers and bodies despite default Request signals',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'large-runtime-rpc-')),finishes=[];let child,output='';
 const bridge=createServer(async(req,res)=>{
  if(req.url==='/__large_http/settings'){res.end('{}');return;}
  let body='';for await(const chunk of req)body+=chunk;
  if(req.url==='/__large_http/finish'){finishes.push(JSON.parse(body));res.end('{}');return;}
  if(req.url==='/__large_http/do'){
   if(new URL(JSON.parse(body).url).pathname==='/body'){res.writeHead(200,{'content-type':'application/json'});res.write('{"pending":');}
   return; // Deliberately hold either headers or the partial response body.
  }
  res.writeHead(500);res.end();
 });
 await new Promise(r=>bridge.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+bridge.address().port;
 t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}bridge.closeAllConnections();await new Promise(r=>bridge.close(r));await rm(directory,{recursive:true,force:true});});
 const {build}=require('esbuild');
 // Accelerate only the production 30-second RPC timer in this child. Real
 // sockets, Request default signals, response reads and spool cleanup remain real.
 await build({stdin:{contents:`import {startRuntime} from ${JSON.stringify(resolve('runtime/large-http/server.mjs'))};const nativeTimeout=AbortSignal.timeout;let rpcTimeoutCalls=0,rpcTimeoutMs=75;AbortSignal.timeout=ms=>{if(ms===30000){rpcTimeoutCalls++;return nativeTimeout(rpcTimeoutMs);}return nativeTimeout(ms);};const r=await startRuntime({healthExtra:()=>({rpcTimeoutCalls}),route:async(request,env)=>{await request.arrayBuffer();const mode=new URL(request.url).searchParams.get('mode'),cancel=new AbortController();rpcTimeoutMs=mode==='caller'?5000:75;let timer;if(mode==='caller')timer=setTimeout(()=>cancel.abort(),10);try{const result=await env.ACCESS_CONTROL.get('fixture').fetch('https://authority.invalid/'+mode,{method:'POST',body:'{}',...(mode==='caller'?{signal:cancel.signal}:{})});await result.json();return Response.json({unexpected:true});}finally{clearTimeout(timer);}}});console.log(JSON.stringify({port:r.server.address().port,boot:r.boot}));`,resolveDir:process.cwd(),sourcefile:'runtime-rpc-proof.mjs'},bundle:true,format:'esm',platform:'node',target:'node24',outfile:directory+'/runtime.mjs',logLevel:'silent'});
 const token='a'.repeat(64);child=spawn(process.execPath,[directory+'/runtime.mjs'],{env:{...process.env,PORT:'0',LARGE_HTTP_SLOT:'0',LARGE_HTTP_GENERATION:'1',LARGE_HTTP_RUNTIME_TOKEN:token,LARGE_HTTP_RUNTIME_SHA:'b'.repeat(64),LARGE_HTTP_ORIGIN:origin},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>output+=b);child.stderr.on('data',()=>{});
 const wait=async fn=>{for(let i=0;i<300;i++){const value=await fn();if(value)return value;await delay(10);}throw Error('runtime_rpc_proof_deadline');};
 const ready=await wait(()=>{try{return JSON.parse(output.trim());}catch{return false;}}),base='http://127.0.0.1:'+ready.port,health=()=>fetch(base+'/health',{headers:{'x-container-token':token}}).then(r=>r.json());
 for(const [index,mode] of ['headers','body','caller'].entries()){
  const grant={slot:0,generation:1,boot:ready.boot,fence:index+1,id:'prf_'+String(index+1).padStart(32,'0')};
  const response=await fetch(base+'/v1/responses?mode='+mode,{method:'POST',headers:{'x-container-token':token,'x-large-http-grant':JSON.stringify(grant)},body:'{}',signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,424);assert.equal(response.headers.get('x-should-retry'),'false');await response.arrayBuffer();
  await wait(()=>finishes.length===index+1);assert.equal(finishes[index].clean,false);
  const state=await wait(async()=>{const h=await health();return !h.busy&&h;});assert.equal(state.spoolBytes,0);assert.equal(state.spoolFiles,0);assert.equal(state.bodyBytesLeased,0);
 }
 assert.ok((await health()).diagnostics.rpcTimeoutCalls>=6);
});
