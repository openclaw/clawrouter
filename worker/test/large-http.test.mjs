import './typescript-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {default:handler}=await import('../index.ts');
const {largeHttp}=await import('../large-http/admission.ts');
const {clearHotCaches}=await import('../hot-cache.ts');
const {probeCharged}=await import('../large-http/probe.ts');
const {fixture:responseFixture}=await import('./http-continuation-fixture.mjs');
const {mediaJsonBytes,bodyBudgetBytes}=await import('../large-http/runtime-limits.ts');
const {usageEnv,proxyKey}=await import('./usage-budget-fixture.mjs');
const token='a'.repeat(64),deadline=String(Date.now()+60000);
function fixture(status=200,admissionReply){
 const calls=[],env={...usageEnv([],{admissionReply}),LARGE_HTTP_ENABLED:'1',LARGE_HTTP_TOKEN:token,LARGE_HTTP_DEADLINE:deadline,
  LARGE_HTTP_POOL:{getByName:name=>({fetch:async(url,init)=>{const v=JSON.parse(init.body);calls.push({kind:'admit',name,tenant:v.tenant});return Response.json({status,...(status===200?{grant:{id:v.id,slot:0,fence:1,boot:'boot'}}:{})},{status});}})},
  LARGE_HTTP_SLOTS:{getByName:name=>({fetch:async r=>{calls.push({kind:'forward',name,headers:r.headers});return Response.json({ok:true});}})}};
 return {env,calls};
}
function request(length='32000001',extra={}){return new Request('https://router.example/v1/responses',{method:'POST',headers:{authorization:'Bearer '+proxyKey(),...(length===null?{}:{'content-length':length}),...extra}});}
test('implicit, null and explicit default policies share one tenant capacity key',async t=>{
 t.after(clearHotCaches);
 const tenants=[];for(const tenantId of [undefined,null,'default','another-tenant']){
  clearHotCaches();
  const f=fixture(200,value=>{value.policy.policy.tenantId=tenantId;return value;});
  assert.equal((await largeHttp(request(),f.env)).status,200);tenants.push(f.calls.find(c=>c.kind==='admit').tenant);
 }
 assert.equal(new Set(tenants.slice(0,3)).size,1);assert.notEqual(tenants[0],tenants[3]);
});
test('default route and small requests never access large bindings',async()=>{
 const env={LARGE_HTTP_ENABLED:'0'};Object.defineProperty(env,'LARGE_HTTP_POOL',{get(){assert.fail('ordinary pool access');}});
 assert.equal(largeHttp(request(),env),undefined);
 env.LARGE_HTTP_ENABLED='1';
 for(const length of ['0','1024','32000000'])assert.equal(largeHttp(request(length),env),undefined,'known small request bypasses async admission');
 assert.equal(largeHttp(new Request('https://router.example/v1/native/openai/v1/responses'),env),undefined);
 let pulls=0;const body=new ReadableStream({pull(){pulls++;}},{highWaterMark:0});
 const ordinary=new Request('https://router.example/v1/native/openai/v1/responses',{method:'POST',headers:{'content-length':'1024'},body,duplex:'half'});
 assert.equal(largeHttp(ordinary,env),undefined);assert.equal(ordinary.bodyUsed,false);assert.equal(pulls,0);
 assert.equal(mediaJsonBytes,32000000);assert.equal(bodyBudgetBytes,96*1024**2);
 const r=await handler.fetch(new Request('https://router.example/v1/health'),env,{waitUntil(){}});assert.equal(r.status,200);
});
test('public requests cannot inject runtime credentials, grants, trace or force-small routing',async()=>{
 const f=fixture();const r=await largeHttp(request('32000001',{'x-canary-openai-key':'untrusted','x-canary-trace-id':'prf_'+'b'.repeat(32),'x-canary-pool-grant':'untrusted','x-container-token':'untrusted','x-large-http-control':'untrusted'}),f.env);assert.equal(r.status,200);assert.deepEqual(f.calls.map(x=>x.kind),['admit','forward']);const h=f.calls[1].headers;assert.equal(h.get('x-canary-openai-key'),null);assert.notEqual(h.get('x-canary-trace-id'),'prf_'+'b'.repeat(32));assert.equal(h.get('x-container-token'),token);assert.equal(h.get('x-large-http-control'),null);
 assert.equal(await largeHttp(request('1024',{'x-canary-force-container':'1'}),f.env),undefined);
});
test('ingress-only release gate restores the Worker envelope without touching native bindings or bodies',async()=>{
 for(const length of [null,'1024','32000001','67108864']){
  const env={LARGE_HTTP_ENABLED:'1',LARGE_HTTP_INGRESS_ENABLED:'0'};
  for(const key of ['LARGE_HTTP_POOL','LARGE_HTTP_SLOTS','LARGE_HTTP_TOKEN'])Object.defineProperty(env,key,{get(){assert.fail('closed ingress accessed '+key);}});
  let pulls=0;const body=new ReadableStream({pull(){pulls++;}},{highWaterMark:0});
  const r=new Request('https://router.example/v1/responses',{method:'POST',headers:length?{'content-length':length}:{},body,duplex:'half'});
  assert.equal(largeHttp(r,env,{reserve(){assert.fail('closed ingress probed body');}}),undefined);
  assert.equal(r.bodyUsed,false);assert.equal(pulls,0);
 }
 const f=fixture();f.env.LARGE_HTTP_INGRESS_ENABLED='1';assert.equal((await largeHttp(request(),f.env)).status,200);
});
for(const status of [429,503,409])test('admission refusal never forwards: '+status,async()=>{const f=fixture(status),r=await largeHttp(request(),f.env);assert.equal(r.status,status);assert.equal(f.calls.length,1);assert.equal(r.headers.get('x-should-retry'),status===409?'false':'true');});
test('unknown admission and canceled request never forward or retry',async()=>{
 const f=fixture();f.env.LARGE_HTTP_POOL.getByName=()=>({fetch(){throw Error('ack lost');}});const r=await largeHttp(request(),f.env);assert.equal(r.status,424);assert.equal(r.headers.get('x-should-retry'),'false');assert.equal(f.calls.length,0);
 const abort=new AbortController();abort.abort();const canceled=new Request(request(),{signal:abort.signal});assert.equal((await largeHttp(canceled,f.env)).status,499);
});
test('unknown lengths use bounded route; invalid sizes and encodings cannot dispatch',async()=>{
 const f=fixture();assert.equal(largeHttp(request(null),f.env),undefined);assert.ok(await largeHttp(request(null),f.env,{reserve:async()=>{}}) instanceof Request);const before=f.calls.length;
 assert.equal((await largeHttp(request('67108865'),f.env)).status,413);assert.equal((await largeHttp(request('32000001',{'content-encoding':'gzip'}),f.env)).status,415);assert.equal((await largeHttp(request('NaN'),f.env)).status,400);assert.equal(f.calls.length,before);
});
test('lost slot acknowledgement retains the grant and cannot become a retryable router 500',async()=>{
 const f=fixture();let forwards=0;f.env.LARGE_HTTP_SLOTS.getByName=()=>({fetch:async()=>{forwards++;throw Error('delivery acknowledgement lost');}});
 const response=await handler.fetch(request(),f.env,{waitUntil(){}});assert.equal(response.status,424);assert.equal(response.headers.get('x-should-retry'),'false');assert.equal((await response.json()).error.code,'upstream_delivery_unknown');assert.equal(forwards,1);assert.deepEqual(f.calls.map(c=>c.kind),['admit']);
});
for(const path of ['/v1/responses','/v1/responses/compact','/v1/native/openai/v1/responses','/v1/native/openai/v1/responses/compact','/v1/proxy/openai/responses','/v1/proxy/openai/responses_compact'])test(`canonical admission forwards a known large body once: ${path}`,async t=>{
 t.after(clearHotCaches);
 const f=fixture();
 const response=await handler.fetch(new Request('https://router.example'+path,{method:'POST',headers:{authorization:'Bearer '+proxyKey(),'content-length':'32000001','content-type':'application/json'}}),f.env,{waitUntil(){}});
 assert.equal(response.status,200);assert.deepEqual(f.calls.map(c=>c.kind),['admit','forward']);
 assert.match(response.headers.get('x-request-id'),/^req_[a-f0-9]{32}$/);
 assert.equal(f.calls[1].headers.get('x-request-id'),response.headers.get('x-request-id'));
});
test('unknown native body handoff forwards the generated ingress request ID',async()=>{
 const f=fixture(),r=new Request('https://router.example/v1/responses',{method:'POST',headers:{authorization:'Bearer '+proxyKey()},body:new ReadableStream({type:'bytes',start(c){c.enqueue(new Uint8Array(32000001));c.close();}}),duplex:'half'});
 const response=await handler.fetch(r,f.env,{waitUntil(){}});assert.equal(response.status,200);
 const forwarded=f.calls.find(c=>c.kind==='forward');assert.ok(forwarded);assert.match(response.headers.get('x-request-id'),/^req_[a-f0-9]{32}$/);assert.equal(forwarded.headers.get('x-request-id'),response.headers.get('x-request-id'));
});

for(const native of [false,true])for(const known of [false,true])test(`small ${known?'known':'unknown'} ${native?'native':'managed'} requests use one canonical admission`,async t=>{
 const f=await responseFixture(t,false),pending=[];let admissions=0;
 f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS='0';
 f.env.LARGE_HTTP_TOKEN=token;f.env.LARGE_HTTP_DEADLINE=deadline;
 const denied={getByName(){assert.fail('small request entered native capacity');}};
 f.env.LARGE_HTTP_POOL=denied;f.env.LARGE_HTTP_SLOTS=denied;
 const get=f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL);
 f.env.ACCESS_CONTROL.get=name=>{const stub=get(name);return{fetch(url,init){if(name==='policy-bindings'&&new URL(url).pathname==='/admission/resolve')admissions++;return stub.fetch(url,init);}};};
 const bytes=new TextEncoder().encode(JSON.stringify({model:native?'gpt-6-astra':'openai/gpt-6-astra',input:'fixture'}));
 const body=new ReadableStream({type:'bytes',start(c){c.enqueue(bytes);c.close();}});
 const response=await handler.fetch(new Request('https://router.example'+(native?'/v1/native/openai/v1/responses':'/v1/responses'),{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json',...(known?{'content-length':String(bytes.length)}:{})},body,duplex:'half'}),f.env,{waitUntil(p){pending.push(p);}});
 assert.equal(response.status,200);await response.text();await Promise.all(pending);await f.drain();
 assert.equal(admissions,1);assert.equal(f.sent.length,1);assert.equal(f.events.length,1);assert.equal(probeCharged(),0);
});

for(const outcome of ['denied','auth_failure','encoding','capacity'])test(`unknown large prefix retires after ${outcome}`,async t=>{
 t.after(clearHotCaches);const f=fixture(429);let canceled=0;
 f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS='0';
 const headers={authorization:outcome==='denied'?'Bearer invalid':'Bearer '+proxyKey(),...(outcome==='encoding'?{'content-encoding':'gzip'}:{})};
 if(outcome==='auth_failure')f.env.ACCESS_CONTROL.get=()=>({fetch(){throw Error('authoritative admission failed');}});
 const r=new Request('https://router.example/v1/responses',{method:'POST',headers,body:new ReadableStream({type:'bytes',start(c){c.enqueue(new Uint8Array(32000001));},cancel(){canceled++;}}),duplex:'half'});
 if(outcome==='auth_failure')await assert.rejects(largeHttp(r,f.env,{reserve:async()=>{}}),/Identity admission failed \(transport\)/);
 else{const response=await largeHttp(r,f.env,{reserve:async()=>{}});assert.equal(response.status,outcome==='denied'?401:outcome==='encoding'?415:429);}
 assert.equal(probeCharged(),0);assert.equal(canceled,1);assert.equal(f.calls.filter(c=>c.kind==='forward').length,0);assert.equal(f.calls.filter(c=>c.kind==='admit').length,outcome==='capacity'?1:0);
});

for(const native of [false,true])test(`unknown 1MiB ${native?'native':'managed'} retains canonical Worker admission`,async t=>{
 const f=await responseFixture(t,false),pending=[];
 f.env.LARGE_HTTP_TOKEN=token;f.env.LARGE_HTTP_DEADLINE=deadline;
 const denied={getByName(){assert.fail('previously supported unknown body entered native capacity');}};
 f.env.LARGE_HTTP_POOL=denied;f.env.LARGE_HTTP_SLOTS=denied;
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const body=JSON.parse(typeof init.body==='string'?init.body:await new Response(init.body).text());
  const forwarded={url:String(url),body,headers:new Headers(init.headers),signal:init.signal,redirect:init.redirect};
  f.sent.push(forwarded);return f.response(forwarded,f.sent.length);
 });
 const value=JSON.stringify({model:native?'gpt-6-astra':'openai/gpt-6-astra',input:'x'.repeat(1024*1024)}),bytes=new TextEncoder().encode(value);
 const body=new ReadableStream({type:'bytes',start(c){c.enqueue(bytes);c.close();}});
 const response=await handler.fetch(new Request('https://router.example'+(native?'/v1/native/openai/v1/responses':'/v1/responses'),{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},body,duplex:'half'}),f.env,{waitUntil(p){pending.push(p);}});
 assert.equal(response.status,200);await response.text();await Promise.all(pending);await f.drain();
 assert.equal(f.sent.length,1);assert.equal(f.events.length,1);assert.equal(probeCharged(),0);
 const {bodyBudgetCharged}=await import('../body-budget.ts');assert.equal(bodyBudgetCharged(),0);
});

for(const native of [false,true])for(const refusal of ['unauthorized','overloaded'])test(`unknown ${native?'native':'managed'} classification preserves ${refusal} status`,async t=>{
 const f=await responseFixture(t,false),pending=[];
 f.env.LARGE_HTTP_TOKEN=token;f.env.LARGE_HTTP_DEADLINE=deadline;
 f.env.LARGE_HTTP_POOL=f.env.LARGE_HTTP_SLOTS={getByName(){assert.fail('canonical refusal must not dispatch native');}};
 const {BodyLease,bodyBudgetCharged}=await import('../body-budget.ts');const held=new BodyLease();
 if(refusal==='overloaded')assert.ok(held.grow(48*1024*1024));
 try{
  const bytes=new TextEncoder().encode(JSON.stringify({model:native?'gpt-6-astra':'openai/gpt-6-astra',input:'x'.repeat(1024*1024)}));
  const body=new ReadableStream({type:'bytes',start(c){c.enqueue(bytes);c.close();}});
  const response=await handler.fetch(new Request('https://router.example'+(native?'/v1/native/openai/v1/responses':'/v1/responses'),{method:'POST',headers:{authorization:refusal==='unauthorized'?'Bearer invalid':'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},body,duplex:'half'}),f.env,{waitUntil(p){pending.push(p);}});
  assert.equal(response.status,refusal==='unauthorized'?401:503);if(refusal==='overloaded')assert.equal(response.headers.get('retry-after'),'1');
  await response.text();await Promise.all(pending);assert.equal(f.sent.length,0);assert.equal(probeCharged(),0);
 }finally{held.release();}
 assert.equal(bodyBudgetCharged(),0);
});

for(const known of [false,true])for(const status of [202,502])test(`${known?'known':'unknown'} native handoff preserves its trusted background recovery locator on ${status}`,async()=>{
 const f=fixture(),locator='a'.repeat(64)+'.bg_'+'b'.repeat(32);
 f.env.LARGE_HTTP_SLOTS={getByName:()=>({fetch:async()=>new Response('native',{status,headers:{'x-clawrouter-background-recovery':locator}})})};
 const headers={authorization:'Bearer '+proxyKey(),'x-clawrouter-background-recovery':'c'.repeat(64)+'.bg_'+'d'.repeat(32),...(known?{'content-length':'32000001'}:{})};
 const r=new Request('https://router.example/v1/responses',{method:'POST',headers,body:new ReadableStream({type:'bytes',start(c){c.enqueue(new Uint8Array(32000001));c.close();}}),duplex:'half'});
 const response=await handler.fetch(r,f.env,{waitUntil(){}});
 assert.equal(response.status,status);assert.equal(response.headers.get('x-clawrouter-background-recovery'),locator);
});

test('native handoff cannot restore caller or malformed recovery metadata',async()=>{
 for(const returned of [null,'invalid-native-value']){
  const f=fixture();f.env.LARGE_HTTP_SLOTS={getByName:()=>({fetch:async()=>new Response('native',{headers:returned?{'x-clawrouter-background-recovery':returned}:{}})})};
  const response=await handler.fetch(request('32000001',{'x-clawrouter-background-recovery':'a'.repeat(64)+'.bg_'+'b'.repeat(32)}),f.env,{waitUntil(){}});
  assert.equal(response.status,200);assert.equal(response.headers.get('x-clawrouter-background-recovery'),null);
 }
});

for(const native of [false,true])test(`held unknown native transfer cannot exhaust ordinary ${native?'native':'managed'} body capacity`,async t=>{
 const f=await responseFixture(t,false),pending=[],ready=Promise.withResolvers(),release=Promise.withResolvers();
 const {bodyBudgetCharged}=await import('../body-budget.ts');let forwards=0;
 f.env.LARGE_HTTP_TOKEN=token;f.env.LARGE_HTTP_DEADLINE=String(Date.now()+60000);
 f.env.LARGE_HTTP_POOL={getByName:()=>({fetch:async()=>Response.json({status:200,grant:{slot:0}})})};
 f.env.LARGE_HTTP_SLOTS={getByName:()=>({fetch:async r=>{forwards++;assert.equal(bodyBudgetCharged(),64_000_002);await new Response(r.body).arrayBuffer();ready.resolve();await release.promise;return Response.json({ok:true});}})};
 t.mock.method(globalThis,'fetch',async(url,init)=>{const body=JSON.parse(typeof init.body==='string'?init.body:await new Response(init.body).text());const sent={url:String(url),body,headers:new Headers(init.headers),signal:init.signal,redirect:init.redirect};f.sent.push(sent);return f.response(sent,f.sent.length);});
 const call=bytes=>handler.fetch(new Request('https://router.example'+(native?'/v1/native/openai/v1/responses':'/v1/responses'),{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},body:new ReadableStream({type:'bytes',start(c){c.enqueue(bytes);c.close();}}),duplex:'half'}),f.env,{waitUntil:p=>pending.push(p)});
 const large=call(new TextEncoder().encode(JSON.stringify({model:native?'gpt-6-astra':'openai/gpt-6-astra',input:'x'.repeat(32_000_001)})));
 try{
  await ready.promise;assert.equal(bodyBudgetCharged(),0);assert.equal(probeCharged(),0);
  const bytes=new TextEncoder().encode(JSON.stringify({model:native?'gpt-6-astra':'openai/gpt-6-astra',input:'x'.repeat(1024*1024)}));
  const statuses=await Promise.all(Array.from({length:32},async()=>{const r=await call(bytes.slice());await r.text();return r.status;}));
  assert.deepEqual(statuses,Array(32).fill(200));assert.equal(f.sent.length,32);assert.equal(forwards,1);
 }finally{release.resolve();const r=await large;assert.equal(r.status,200);await r.text();while(pending.length)await Promise.all(pending.splice(0));await f.drain();}
 assert.equal(bodyBudgetCharged(),0);assert.equal(probeCharged(),0);assert.equal(f.events.length,32);
});
