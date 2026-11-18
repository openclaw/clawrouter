import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {egressEvent,observeEgress} from '../worker/native-rehearsal/egress.ts';
import {hostedBoundaryFixture} from './helpers/native-rehearsal.mjs';
const worker='clawrouter-native-qualification-abcdef012345',origin='https://'+worker+'.fixture.workers.dev',sha='c'.repeat(64),identity={slot:0,generation:1,runtimeSha:sha};
const hash=x=>createHash('sha256').update(x).digest('hex');

test('actual egress entrypoint records first runtime forwarding outcome without secret content',async()=>{
 const hooks=registerHooks({resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.endsWith('.ts')&&!/\.[a-z]+$/i.test(s))return next(s+'.ts',c);if(s==='cloudflare:workers')return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}};export class WorkerEntrypoint extends DurableObject {}')};return next(s,c);}});
 let Egress;try{({NativeRehearsalEgress:Egress}=await import('../worker/native-rehearsal-entry.ts'));}finally{hooks.deregister();}
 const receipts=[],forwarded=[],env={LARGE_HTTP_ORIGIN:origin,CLAWROUTER_PUBLIC_ORIGIN:origin,LARGE_HTTP_CAPACITY:'8',LARGE_HTTP_TESTING:'1'};
 env.NATIVE_REHEARSAL=JSON.stringify({schema:1,worker,origin,createdAt:Date.now()-1000,expiresAt:Date.now()+600000,maxStarts:40,maxRequests:64});
 env.NATIVE_REHEARSAL_STATE={getByName:()=>({fetch:async(url,r)=>{receipts.push({op:new URL(url).pathname,...JSON.parse(r.body)});return Response.json({recorded:true});}})};
 const egress=new Egress({props:identity},env),original=globalThis.fetch,request=()=>new Request(origin+'/__large_http/runtime',{headers:{'x-large-http-token':'sensitive-fixture-token'}});
 try{
  globalThis.fetch=async(r,o)=>{forwarded.push({url:r.url,redirect:o.redirect,token:r.headers.get('x-large-http-token')});return new Response('native-fixture',{status:200});};
  const r=await egress.fetch(request());assert.equal(await r.text(),'native-fixture');assert.deepEqual(receipts.map(x=>x.event),['entered','forwarding','response']);assert.equal(receipts.at(-1).status,200);
  assert.deepEqual(forwarded,[{url:origin+'/__large_http/runtime',redirect:'manual',token:'sensitive-fixture-token'}]);
  receipts.length=0;const failure=Object.assign(new TypeError('sensitive-fixture-error'),{cause:{code:'ECONNRESET'}});
  globalThis.fetch=async()=>{throw failure;};await assert.rejects(egress.fetch(request()),e=>e===failure);
  assert.deepEqual(receipts.map(x=>x.event),['entered','forwarding','rejected']);assert.equal(receipts.at(-1).causeCode,'ECONNRESET');assert.equal(receipts.at(-1).reason,'other');
  receipts.length=0;assert.equal((await egress.fetch(new Request(origin+'/__large_http/runtime?secret=sensitive-fixture-query'))).status,403);
  assert.deepEqual(receipts.map(x=>x.event),['entered','response']);assert.equal(receipts[0].decorated,true);assert.equal(receipts.at(-1).status,403);
  assert.doesNotMatch(JSON.stringify(receipts),/sensitive-fixture|https:\/\//);
 }finally{globalThis.fetch=original;}
});

test('journal receipt failures are not mislabeled as forwarding failures',async()=>{
 const receipts=[],r=new Request(origin+'/__large_http/runtime');let forwarded=false;
 const env={NATIVE_REHEARSAL_STATE:{getByName:()=>({fetch:async(url,r)=>{const v=JSON.parse(r.body);receipts.push(v);return Response.json({recorded:true},{status:v.event==='forwarding'?503:200});}})}};
 await assert.rejects(observeEgress(env,identity,r,origin,async mark=>{await mark();forwarded=true;return new Response();}),/rehearsal_egress_refused/);
 assert.equal(forwarded,false);assert.deepEqual(receipts.map(x=>x.event),['entered','forwarding']);
 const terminalEnv={NATIVE_REHEARSAL_STATE:{getByName:()=>({fetch:async(url,r)=>Response.json({recorded:true},{status:JSON.parse(r.body).event==='response'?503:200})})}};
 const originalResponse=new Response('native-fixture',{status:200});
 const preserved=await observeEgress(terminalEnv,identity,r,origin,async mark=>{await mark();return originalResponse;});
 assert.equal(preserved,originalResponse);assert.equal(await preserved.text(),'native-fixture');
 for(const value of [{event:'rejected',name:'sensitive',causeCode:null},{event:'response',status:999},{event:'entered',ownedOrigin:true}])assert.equal(egressEvent(value),null);
 assert.deepEqual(egressEvent({event:'forwarding',token:'sensitive'}),{event:'forwarding'});
});

test('real workerd binding forwards owned runtime bytes and retains sanitized receipts',async t=>{
 const received=[];
 const f=await hostedBoundaryFixture(t,{outboundService:async r=>{received.push({method:r.method,url:r.url,token:r.headers.get('x-large-http-token')});return new Response('native-fixture',{headers:{'content-type':'application/javascript'}});}});assert.equal((await f.call('setup',{seedHash:hash('a'.repeat(64)),credentialHash:hash('synthetic-client')})).status,200);
 const ns=await f.mf.getDurableObjectNamespace('NATIVE_REHEARSAL_STATE','fixture'),stub=ns.get(ns.idFromName('native-rehearsal'));
 const internal=(v)=>stub.fetch('https://rehearsal/egress',{method:'POST',body:JSON.stringify({...identity,...v})});
 const entry={event:'entered',ownedOrigin:true,runtimePath:true,get:true,decorated:false,protocol:'https'};
 assert.equal((await f.call('egress',entry)).status,404);
 assert.deepEqual(await(await internal(entry)).json(),{recorded:false});
 await stub.fetch('https://rehearsal/start',{method:'POST',body:JSON.stringify(identity)});
 assert.deepEqual(await(await internal({event:'forwarding'})).json(),{recorded:false},'cannot skip entry');
 assert.deepEqual(await(await internal({...entry,runtimeSha:'b'.repeat(64)})).json(),{recorded:false});
 const response=await f.mf.dispatchFetch(f.origin+'/test-egress',{headers:{'x-test-url':origin+'/__large_http/runtime','x-large-http-token':'sensitive-fixture-token'}});
 assert.equal(response.status,200);assert.equal(await response.text(),'native-fixture');assert.equal(response.headers.get('content-type'),'application/javascript');
 const s=await(await f.call('snapshot')).json(),rows=s.starts[0].diagnostics.egress;
 assert.deepEqual(rows.map(x=>x.event),['entered','forwarding','response']);assert.equal(rows.at(-1).status,200);assert.equal(rows[0].ownedOrigin,true);
 assert.deepEqual(await(await internal(entry)).json(),{recorded:false});
 assert.deepEqual(await(await internal({event:'rejected',name:'Error',causeCode:null,reason:'other'})).json(),{recorded:false});
 assert.deepEqual(f.outbound,[origin+'/__large_http/runtime']);assert.deepEqual(received,[{method:'GET',url:origin+'/__large_http/runtime',token:'sensitive-fixture-token'}]);assert.doesNotMatch(JSON.stringify(rows),/https:\/\/|x-large-http|sensitive/);
 t.diagnostic(JSON.stringify({provider:'local workerd binding and controlled outbound service',events:rows.map(x=>x.event),status:rows.at(-1).status,outboundRequests:f.outbound.length,limits:'does not certify hosted TLS interceptor delivery'}));
});


test('real workerd binding rejects redirects without following Location or sending callback credentials there',async t=>{
 let status=302,target='https://unowned.invalid/capture';const received=[];
 const f=await hostedBoundaryFixture(t,{outboundService:async r=>{received.push({url:r.url,method:r.method,token:r.headers.get('x-large-http-token'),body:await r.text()});return new Response('sensitive-redirect-body',{status,headers:{location:target}});}});
 assert.equal((await f.call('setup',{seedHash:hash('a'.repeat(64)),credentialHash:hash('synthetic-client')})).status,200);
 const ns=await f.mf.getDurableObjectNamespace('NATIVE_REHEARSAL_STATE','fixture'),stub=ns.get(ns.idFromName('native-rehearsal'));
 await stub.fetch('https://rehearsal/start',{method:'POST',body:JSON.stringify(identity)});
 for(const next of [301,302,303,307,308])for(const location of ['https://unowned.invalid/capture',origin+'/capture'])for(const method of ['GET','POST']){
  status=next;target=location;const before=received.length,url=origin+'/__large_http/'+(method==='GET'?'runtime':'finish'),body=method==='GET'?'':JSON.stringify({id:'sensitive-callback-id',clean:true});
  const response=await f.mf.dispatchFetch(f.origin+'/test-egress',{method,headers:{'x-test-url':url,'x-large-http-token':'sensitive-fixture-token'},...(body?{body}:{})});
  assert.equal(response.status,500);assert.match(await response.text(),/rehearsal_redirect_refused/);
  assert.equal(received.length,before+1);assert.deepEqual(received.at(-1),{url,method,token:'sensitive-fixture-token',body});
 }
 const rows=(await(await f.call('snapshot')).json()).starts[0].diagnostics.egress;
 assert.deepEqual(rows.map(x=>x.event),['entered','forwarding','rejected']);assert.equal(rows.at(-1).reason,'other');
 assert.doesNotMatch(JSON.stringify(rows),/sensitive|unowned|capture|https:/);
 t.diagnostic(JSON.stringify({redirectsRejected:20,outboundRequests:received.length,redirectTargetRequests:received.filter(x=>!['/__large_http/runtime','/__large_http/finish'].includes(new URL(x.url).pathname)).length}));
});

test('real workerd binding preserves callback POST body and nonredirect error responses; rejects unowned input',async t=>{
 const received=[];
 const f=await hostedBoundaryFixture(t,{outboundService:async r=>{received.push({url:r.url,method:r.method,token:r.headers.get('x-large-http-token'),body:await r.text()});return new Response('origin-unavailable',{status:503,headers:{'x-origin-fixture':'preserved'}});}});
 assert.equal((await f.call('setup',{seedHash:hash('a'.repeat(64)),credentialHash:hash('synthetic-client')})).status,200);
 const ns=await f.mf.getDurableObjectNamespace('NATIVE_REHEARSAL_STATE','fixture'),stub=ns.get(ns.idFromName('native-rehearsal'));
 await stub.fetch('https://rehearsal/start',{method:'POST',body:JSON.stringify(identity)});
 const body=JSON.stringify({id:'sensitive-callback-id',clean:true});
 const response=await f.mf.dispatchFetch(f.origin+'/test-egress',{method:'POST',headers:{'x-test-url':origin+'/__large_http/finish','x-large-http-token':'sensitive-fixture-token'},body});
 assert.equal(response.status,503);assert.equal(await response.text(),'origin-unavailable');assert.equal(response.headers.get('x-origin-fixture'),'preserved');
 assert.deepEqual(received,[{url:origin+'/__large_http/finish',method:'POST',token:'sensitive-fixture-token',body}]);
 for(const url of ['https://unowned.invalid/__large_http/runtime',origin+'/unowned',origin+'/__large_http/runtime?token=sensitive']){
  const denied=await f.mf.dispatchFetch(f.origin+'/test-egress',{headers:{'x-test-url':url}});assert.equal(denied.status,403);
 }
 assert.equal(received.length,1);
 const snapshot=await(await f.call('snapshot')).json();assert.equal(snapshot.callbacks.length,1);assert.equal(snapshot.callbacks[0].status,503);
 assert.equal(snapshot.requests,0);assert.equal(snapshot.accounting.events.length,0);assert.doesNotMatch(JSON.stringify(snapshot),/sensitive/);
});
