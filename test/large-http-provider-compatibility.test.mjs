import '../worker/test/typescript-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
const {runtimeFields}=await import('../worker/large-http/config.ts');
const {default:handler}=await import('../worker/index.ts');
const require=createRequire(import.meta.resolve('wrangler/package.json'));

// Actual production native entry and canonical Worker. Only Cloudflare bindings
// and the provider wire transport are local fixtures; no paid upstream calls.
test('chunked unified Responses retains provider selection across the actual native handoff',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'large-provider-proof-')),token='a'.repeat(64),providers=['openai','openrouter','azure-openai','meta'];
 const secret='fixture-provider-secret',pending=[],sent=[],finishes=[],admissions=[],backgrounds=[],parentUsage=[],held=Promise.withResolvers(),releaseHeld=Promise.withResolvers();
 const policy={enabled:true,generation:'g1',providers,tenantId:'fixture',monthlyBudgetMicros:null,requestCostMicros:null,retainRequestContent:false};
 const credential={enabled:true,secretSha256:createHash('sha256').update(secret).digest('hex'),policyId:'fixture',policyGeneration:'g1'};
 const connections=providers.map(providerId=>({providerId,enabled:true,monthlyBudgetMicros:null}));
 const settings={CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS:'0',OPENAI_API_KEY:'fixture-openai',OPENROUTER_API_KEY:'fixture-openrouter',OPENROUTER_SITE_URL:'https://fixture.client.example',AZURE_OPENAI_API_KEY:'fixture-azure',AZURE_OPENAI_ENDPOINT:'https://fixture.openai.azure.com',MODEL_API_KEY:'fixture-meta'};
 const authority=async(url,init,name)=>{
  const path=new URL(url).pathname;
  if(path==='/admission/resolve'){admissions.push(JSON.parse(init.body));return Response.json({credential:{credentialId:'fixture',credential},policy:{policyId:'fixture',policy},owner:null,connections,pools:Object.fromEntries(providers.map(id=>[id,{keys:[],states:{}}]))});}
  if(path==='/responses-background'){
   const value=JSON.parse(init.body);backgrounds.push({name,value});
   // Lost admission acknowledgement: the canonical owner stamps its genuine
   // recovery locator before returning this definitive unsent error.
   return Response.json({admitted:false});
  }
  if(path==='/connections/resolve')return Response.json({initialized:true,connections,missingProviderIds:[]});
  if(path==='/grant-pools/resolve')return Response.json({keys:[],states:{}});
  throw Error('unexpected_fixture_authority:'+path);
 };
 let child,stderr='';
 const bridge=createServer(async(req,res)=>{
  try{
   if(req.url==='/__large_http/settings'){res.end(JSON.stringify(Object.fromEntries(runtimeFields.filter(k=>typeof settings[k]==='string').map(k=>[k,settings[k]]))));return;}
   let body='';for await(const chunk of req)body+=chunk;
   if(req.url==='/provider'){
    const value=JSON.parse(body);sent.push({url:req.headers['x-fixture-upstream'],headers:req.headers,body:value});
    if(value.metadata?.qualification_id==='hold_mixed'){held.resolve();await releaseHeld.promise;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'completed',output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));return;
   }
   const v=JSON.parse(body||'{}');
   if(req.url==='/__large_http/do'){const r=await authority(v.url,{method:v.method,body:v.body},v.name);res.writeHead(r.status,Object.fromEntries(r.headers));res.end(await r.text());return;}
   if(req.url==='/__large_http/kv'){res.end(JSON.stringify(Array.isArray(v.key)?{entries:v.key.map(k=>[k,null])}:{value:null}));return;}
   if(req.url==='/__large_http/finish')finishes.push(v);
   res.end('{}');
  }catch{res.writeHead(500);res.end('{}');}
 });
 await new Promise(r=>bridge.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+bridge.address().port;
 const portProbe=createServer();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
 t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}bridge.closeAllConnections();await new Promise(r=>bridge.close(r));await rm(directory,{recursive:true,force:true});});
 await require('esbuild').build({entryPoints:[resolve('runtime/large-http/main.ts')],bundle:true,format:'esm',platform:'node',target:'node24',define:{__CLAWROUTER_LARGE_RUNTIME__:'true'},outfile:directory+'/runtime.mjs',logLevel:'silent',plugins:[]});
 await writeFile(directory+'/wire.mjs',`const wire=globalThis.fetch;globalThis.fetch=(input,init={})=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol==='https:'){const headers=new Headers(init.headers);headers.set('x-fixture-upstream',url.href);return wire(${JSON.stringify(origin+'/provider')},{...init,headers});}return wire(input,init);};await import('./runtime.mjs');`);
 child=spawn(process.execPath,[directory+'/wire.mjs'],{env:{...process.env,TMPDIR:directory,PORT:String(port),LARGE_HTTP_SLOT:'0',LARGE_HTTP_GENERATION:'1',LARGE_HTTP_RUNTIME_TOKEN:token,LARGE_HTTP_RUNTIME_SHA:'b'.repeat(64),LARGE_HTTP_ORIGIN:origin},stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>stderr+=b);
 const wait=async fn=>{for(let i=0;i<500;i++){const result=await fn();if(result)return result;if(child.exitCode!==null)throw Error('fixture_native_exit:'+stderr);await delay(10);}throw Error('fixture_deadline');};
 const base='http://127.0.0.1:'+port,healthHeaders={'x-container-token':token};
 const ready=await wait(async()=>{try{const r=await fetch(base+'/startup-health',{headers:healthHeaders});return r.ok&&await r.json();}catch{return false;}});
 let fence=0,slotError;
 const env={...settings,POLICY_KV:{get:async keys=>Array.isArray(keys)?new Map(keys.map(k=>[k,null])):null},ACCESS_CONTROL:{idFromName:n=>n,get:()=>({fetch:authority})},USAGE_QUEUE:{send:async event=>{parentUsage.push(event);}},LARGE_HTTP_TOKEN:token,LARGE_HTTP_DEADLINE:String(Date.now()+120000),
  LARGE_HTTP_POOL:{getByName:()=>({fetch:async(url,init)=>{const {id}=JSON.parse(init.body);return Response.json({status:200,grant:{id,slot:0,generation:1,boot:ready.boot,fence:++fence}});}})},
  LARGE_HTTP_SLOTS:{getByName:()=>({fetch:async request=>{const h=new Headers(request.headers);h.set('x-large-http-grant',h.get('x-canary-pool-grant'));try{return await fetch(base+new URL(request.url).pathname,{method:'POST',headers:h,body:request.body,duplex:'half'});}catch(e){slotError=e.cause?.code??e.message;throw e;}}})}};
 const cases=[];
 for(const provider of providers)for(const mode of ['probe-size','probe-delayed-size',...(provider==='openrouter'?['64m']:[])]){
  // Model follows input beyond the canonical Worker envelope.
  const model=provider==='azure-openai'?'fixture-deployment':provider==='meta'?'llama-fixture':'gpt-6-astra';
  const body={input:'x'.repeat(32_000_001),model:provider+'/'+(provider==='openrouter'?'openai/':'')+model};
  if(mode==='64m')body.input='x'.repeat(64*1024*1024-Buffer.byteLength(JSON.stringify({...body,input:''})));
  const bytes=Buffer.from(JSON.stringify(body)),byteLength=bytes.length;
  const stream=new ReadableStream({type:'bytes',async start(c){if(mode==='probe-delayed-size'){c.enqueue(new Uint8Array(bytes.subarray(0,10)));await delay(75);c.enqueue(new Uint8Array(bytes.subarray(10)));}else c.enqueue(bytes);c.close();}});
  const response=await handler.fetch(new Request('https://router.example/v1/responses',{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-'+secret,'content-type':'application/json'},body:stream,duplex:'half'}),env,{waitUntil:p=>pending.push(p)});
  const result=await response.json();assert.equal(response.status,200,provider+':'+mode+':'+result.error?.code+':'+slotError);
  await wait(()=>finishes.length===cases.length+1);while(pending.length)await Promise.all(pending.splice(0));
  const upstream=sent.at(-1);assert.ok(upstream);assert.equal(upstream.body.input,body.input);assert.equal(upstream.body.model,provider==='openrouter'?'openai/'+model:model);assert.equal(finishes.at(-1).clean,true);
  const expected={openai:['https://api.openai.com/v1/responses','authorization','Bearer fixture-openai'],openrouter:['https://openrouter.ai/api/v1/responses','authorization','Bearer fixture-openrouter'],'azure-openai':['https://fixture.openai.azure.com/openai/v1/responses','api-key','fixture-azure'],meta:['https://api.meta.ai/v1/responses','authorization','Bearer fixture-meta']}[provider];
  assert.equal(upstream.url,expected[0]);assert.equal(upstream.headers[expected[1]],expected[2]);if(provider==='openrouter')assert.equal(upstream.headers['http-referer'],settings.OPENROUTER_SITE_URL);
  cases.push({provider,mode,status:response.status,bytes:byteLength,dispatches:sent.length,clean:finishes.at(-1).clean});
 }
 assert.equal(sent.length,cases.length);assert.ok(admissions.some(a=>a.providers.length===0),'ingress_auth_must_not_preselect_openai');
 const denials=[];
 for(const mode of ['policy-denied','connection-disabled']){
  if(mode==='policy-denied')policy.providers=['openai'];else {policy.providers=providers;connections.find(c=>c.providerId==='openrouter').enabled=false;}
  const value=Buffer.from(JSON.stringify({input:'x'.repeat(32_000_001),model:'openrouter/openai/gpt-6-astra'}));
  const response=await handler.fetch(new Request('https://router.example/v1/responses',{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-'+secret,'content-type':'application/json'},body:new ReadableStream({type:'bytes',start(c){c.enqueue(value);c.close();}}),duplex:'half'}),env,{waitUntil:p=>pending.push(p)});
  const result=await response.json();assert.equal(response.status,mode==='policy-denied'?403:503);assert.equal(result.error.code,mode==='policy-denied'?'provider_not_allowed':'provider_disabled');
  await wait(()=>finishes.length===cases.length+denials.length+1);while(pending.length)await Promise.all(pending.splice(0));assert.equal(sent.length,cases.length);assert.equal(finishes.at(-1).clean,true);
  denials.push({mode,status:response.status,code:result.error.code,providerDispatched:false});
 }
 const recovery=[];
 for(const known of [true,false]){
  const bytes=Buffer.from(JSON.stringify({input:'x'.repeat(32_000_001),model:'openai/gpt-6-astra',background:true}));
  const response=await handler.fetch(new Request('https://router.example/v1/responses',{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-'+secret,'content-type':'application/json','x-clawrouter-background-recovery':'c'.repeat(64)+'.bg_'+'d'.repeat(32),...(known?{'content-length':String(bytes.length)}:{})},body:new ReadableStream({type:'bytes',start(c){c.enqueue(bytes);c.close();}}),duplex:'half'}),env,{waitUntil:p=>pending.push(p)});
  assert.equal(response.status,503,await response.clone().text());
  const actual=backgrounds.at(-1),scope=actual.name;
  assert.equal(actual.value.action,'admit');
  const locator=scope.slice('http-continuations:'.length)+'.'+actual.value.admission.id;
  assert.match(locator,/^[a-f0-9]{64}\.bg_[a-f0-9]{32}$/);
  assert.equal(response.headers.get('x-clawrouter-background-recovery'),locator);
  await response.text();await wait(()=>finishes.length===cases.length+denials.length+recovery.length+1);while(pending.length)await Promise.all(pending.splice(0));
  assert.equal(finishes.at(-1).clean,true);assert.equal(sent.length,cases.length);
  recovery.push({known,status:response.status,locatorMatchesNativeAdmission:true,providerDispatched:false,clean:true});
 }
 // Real native socket delivery holds provider headers after its upload has
 // transferred. Ordinary Worker requests must not inherit a phantom prefix
 // charge for the duration of that provider operation.
 const wire=globalThis.fetch;
 t.mock.method(globalThis,'fetch',(input,init={})=>{
  const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(u.protocol!=='https:')return wire(input,init);
  assert.equal(u.origin,'https://api.openai.com','no_unexpected_provider_egress');
  const headers=new Headers(init.headers);headers.set('x-fixture-upstream',u.href);
  return wire(origin+'/provider',{...init,headers,duplex:'half'});
 });
 const {bodyBudgetCharged}=await import('../worker/body-budget.ts');
 const big=Buffer.from(JSON.stringify({input:'x'.repeat(32_000_001),model:'openai/gpt-6-astra',metadata:{qualification_id:'hold_mixed'}}));
 const large=handler.fetch(new Request('https://router.example/v1/responses',{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-'+secret,'content-type':'application/json'},body:new ReadableStream({type:'bytes',start(c){c.enqueue(big);c.close();}}),duplex:'half'}),env,{waitUntil:p=>pending.push(p)});
 let mixed;
 try{
  await held.promise;assert.equal(bodyBudgetCharged(),0);
  const beforeUsage=parentUsage.length;
  const small=Buffer.from(JSON.stringify({input:'x'.repeat(1024*1024),model:'openai/gpt-6-astra'}));
  const statuses=await Promise.all(Array.from({length:32},async()=>{const r=await handler.fetch(new Request('https://router.example/v1/responses',{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-'+secret,'content-type':'application/json','content-length':String(small.length)},body:small}),env,{waitUntil:p=>pending.push(p)});await r.text();return r.status;}));
  assert.deepEqual(statuses,Array(32).fill(200));while(pending.length)await Promise.all(pending.splice(0));assert.equal(parentUsage.length-beforeUsage,32);
  mixed={ordinaryRequests:32,statuses,workerBodyBudgetWhileNativeHeld:bodyBudgetCharged(),actualNativeTransport:true};
 }finally{releaseHeld.resolve();const r=await large;assert.equal(r.status,200);await r.text();}
 await wait(()=>finishes.length===cases.length+denials.length+recovery.length+1);while(pending.length)await Promise.all(pending.splice(0));
 assert.equal(finishes.at(-1).clean,true);assert.equal(sent.length,cases.length+33);assert.equal(bodyBudgetCharged(),0);
 const h=await (await fetch(base+'/health',{headers:healthHeaders})).json();assert.equal(h.spoolBytes+h.spoolFiles+h.bodyBytesLeased+h.backgroundFailures,0);
 assert.equal(stderr,'');
 if(process.env.PAYLOAD_PROVIDER_PROOF)await writeFile(process.env.PAYLOAD_PROVIDER_PROOF,JSON.stringify({completed:true,entry:'runtime/large-http/main.ts',worker:'worker/index.ts',cases,denials,recovery,mixed,dispatches:sent.length,cleanFinishes:finishes.length,resources:{spoolBytes:h.spoolBytes,spoolFiles:h.spoolFiles,bodyBytesLeased:h.bodyBytesLeased,backgroundFailures:h.backgroundFailures},limits:'Local Node native runtime and actual canonical Worker; synthetic Cloudflare bindings and provider wire transport. No hosted Cloudflare execution, paid inference or latency qualification.'},null,2)+'\n',{flag:'wx'});
});
