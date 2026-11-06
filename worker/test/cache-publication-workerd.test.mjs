import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { musicAccessFixture } from './minimax-music-admin-fixture.mjs';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

// IDs and model names here are fixture-only routing metadata, not vendor claims.
const A = 'anthropic/claude-sonnet-5', B = 'anthropic/claude-opus-5';
const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials,inspectGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {HotCache,setHotCacheClock} from './worker/hot-cache.ts';
const original=globalThis.fetch.bind(globalThis),realNow=Date.now.bind(Date);
let cacheClock=realNow(),wallOffset=0,initialized,background=0,cooldown=null,evictions=0,puts=0,hits=0;
Date.now=()=>realNow()+wallOffset;setHotCacheClock(()=>cacheClock);
const rows=new Map(),cache=caches.default,match=cache.match.bind(cache),put=cache.put.bind(cache);
cache.match=async(...args)=>{const r=await match(...args);if(r)hits++;return r;};
cache.put=async(...args)=>{await put(...args);puts++;};
const deleteKeys=HotCache.prototype.deleteKeys;
HotCache.prototype.deleteKeys=function(predicate){evictions++;return deleteKeys.call(this,predicate);};
const barrier=(id,phase)=>original('https://cache-gate.example/barrier/'+id+'/'+phase,{redirect:'manual'}).then(async r=>{if(!r.ok)throw new Error('barrier failed');await r.text();});
const report=()=>({rows:Object.fromEntries(rows),background,cacheClock,wall:Date.now(),cooldown,evictions,puts,hits});
export default {async fetch(request,bindings,context){
 const env={...bindings,...ACCESS_ENV},url=new URL(request.url),id=url.searchParams.get('id')??'control';
 initialized??=(async()=>{
  await authorityCall(env,'/users/initialize-all',[{email:'music-admin@example.invalid',record:{enabled:true,role:'admin',groups:[],tenantId:'fixture'}}]);
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['anthropic'],models:MODELS,tenantId:'fixture',monthlyBudgetMicros:null,retainRequestContent:false,
   grantRouting:{eligibleGrants:{anthropic:['cache']},environmentFallback:false,failover:false}}}]);
  await authorityCall(env,'/credentials/initialize-all',['positive','revoked','rejection'].map(credentialId=>({credentialId,credential:{enabled:true,secretSha256:SECRET_DIGEST,policyId:'fixture',policyGeneration:'g1'}})));
  await authorityCall(env,'/connections/initialize-all',[{providerId:'anthropic',enabled:true}]);
 })();await initialized;
 if(url.pathname==='/setup'){
  const old=await inspectGrantCredentials(env,'oauth/fixture/cache');
  if(!old)await putGrantCredentials(env,'oauth/fixture/cache',{provider:'anthropic',kind:'subscription',enabled:true,accessToken:'synthetic-cache-key',updatedAt:'2026-01-01T00:00:00Z'});
  const grant=await inspectGrantCredentials(env,'oauth/fixture/cache');
  return Response.json({generation:grant.credentialGeneration,revision:grant.credentialRevision??grant.updatedAt});
 }
 if(url.pathname==='/state')return Response.json(report());
 if(url.pathname==='/cache-expire'){cacheClock+=61001;return Response.json(report());}
 if(url.pathname==='/wall-after-cooldown'){
  if(background||[...rows.values()].some(r=>!r.done)||!cooldown)throw new Error('active work or missing real cooldown');
  wallOffset=Math.max(0,Date.parse(cooldown)+1-realNow());return Response.json(report());
 }
 const row={admissions:0,owners:0,admissionHeld:false,ownerHeld:false,upstream:0,pending:0,done:false,status:null,timing:null,identity:null};rows.set(id,row);
 const authority=env.ACCESS_CONTROL;env.ACCESS_CONTROL={idFromName:n=>authority.idFromName(n),get:key=>{const stub=authority.get(key);return {async fetch(input,init){
  const path=new URL(input).pathname;
  if(path==='/admission/resolve')row.admissions++;
  if(path==='/grant-pools/feedback'){const body=JSON.parse(init.body);cooldown=body.state?.cooldownUntil??cooldown;}
  const response=await stub.fetch(input,init);
  if(path==='/admission/resolve'&&url.searchParams.has('hold-admission')){row.admissionHeld=true;await barrier(id,'admission');}
  return response;
 }}}};
 const credentials=env.GRANT_CREDENTIALS;env.GRANT_CREDENTIALS={idFromName:n=>credentials.idFromName(n),get:key=>{const stub=credentials.get(key);return {async fetch(input,init){
  const path=new URL(input).pathname;if(path==='/materialize'){
   row.owners++;const body=JSON.parse(init.body);row.identity={key:body.key??String(key),generation:body.grant?.credentialGeneration??body.expectedGeneration??null,revision:body.grant?.credentialRevision??body.grant?.updatedAt??null};
  }
  const response=await stub.fetch(input,init);
  if(path==='/materialize'&&url.searchParams.has('hold-owner')){row.ownerHeld=true;await barrier(id,'owner');}
  return response;
 }}}};
 const track=p=>{background++;row.pending++;const observed=Promise.resolve(p).finally(()=>{background--;row.pending--;});context.waitUntil(observed);};
 try{
  const inner=url.pathname==='/proxy'?new Request('https://router.example/v1/messages',{method:'POST',headers:request.headers,body:request.body,signal:request.signal}):request;
  const response=await worker.fetch(inner,env,{waitUntil:track});row.status=response.status;row.timing=response.headers.get('server-timing');return response;
 }finally{row.done=true;}
},queue:worker.queue};`;

async function network() {
  const held = new Map(), released = new Set(), arrivals = new Set(), provider = new Map(), status = new Map();
  let allReleased = false;
  const server = createServer(async (req, res) => {
    const path = req.url;
    if (path.startsWith('/barrier/')) {
      arrivals.add(path);
      if (allReleased || released.has(path)) res.end('released'); else held.set(path, res);
      return;
    }
    if (!path.startsWith('/provider/')) { res.writeHead(404); res.end(); return; }
    const id = path.slice('/provider/'.length);let bytes=0;
    for await (const chunk of req) bytes+=chunk.length;
    assert.ok(bytes<65536);provider.set(id,(provider.get(id)??0)+1);
    const finish=()=>{const code=status.get(id)??200;res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(code===200?{id:'synthetic',type:'message',role:'assistant',content:[],usage:{input_tokens:1,output_tokens:1}}:{error:{type:'authentication_error',message:'synthetic rejection'}}));};
    if(!allReleased&&status.has(id)&&!released.has('/provider/'+id))held.set('/provider/'+id,{end:finish});else finish();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {origin:'http://127.0.0.1:'+server.address().port,arrivals,provider,status,
    release(path){released.add(path);held.get(path)?.end('released');held.delete(path);},
    releaseAll(){allReleased=true;for(const path of [...held.keys()])this.release(path);},
    close(){return new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});}};
}
function upstream(origin,jwk){return String.raw`
export default {async fetch(request){const url=new URL(request.url);
 if(url.href==='https://music-admin-fixture.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json({keys:[JWK]});
 if(url.hostname==='cache-gate.example')return fetch(ORIGIN+url.pathname,{redirect:'manual'});
 if(url.href!=='https://api.anthropic.com/v1/messages')throw new Error('unexpected fixture egress');
 const body=await request.json(),id=body.metadata?.user_id;
 if(!/^[a-zA-Z0-9_-]{1,32}$/.test(id??'')||request.headers.get('authorization')!=='Bearer synthetic-cache-key')throw new Error('fixture upstream identity');
 return fetch(ORIGIN+'/provider/'+id,{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'},redirect:'manual'});
}};`.replace('JWK',JSON.stringify(jwk)).replaceAll('ORIGIN',JSON.stringify(origin));}

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'cache-publication-workerd-')),io=await network(),access=await musicAccessFixture();
  const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('synthetic-secret'))).toString('hex');
  const script=router.replace('ACCESS_ENV',JSON.stringify(access.env)).replace('MODELS',JSON.stringify([A,B])).replace('SECRET_DIGEST',JSON.stringify(digest));
  let runtime;const clients=new Set(),failures=[];
  // Ownership is registered before the first client/request or observation.
  t.after(async()=>{const errors=[];io.releaseAll();
    for(const result of await Promise.allSettled([...clients]))if(result.status==='rejected')errors.push(result.reason);
    try{if(runtime)await until(async()=>{const s=await state();return s.background===0&&Object.values(s.rows).every(r=>r.done);});}catch(e){errors.push(e);}
    try{await runtime?.dispose();}catch(e){errors.push(e);}try{await io.close();}catch(e){errors.push(e);}await rm(dir,{recursive:true,force:true});
    if(errors.length||failures.length)throw new AggregateError([...failures,...errors],'fixture cleanup/client failures');
  });
  const startRuntime=async()=>{runtime=await startWorkerdFixture(dir,script,upstream(io.origin,access.jwk),{hotCache:true,preventEviction:true,persistencePath:join(dir,'state')});};
  await startRuntime();
  const call=async(path,options)=>{const r=await runtime.dispatchFetch('https://router.example'+path,options);const text=await r.text();assert.equal(r.status,200,text);return JSON.parse(text);};
  const state=()=>call('/state');
  const until=async predicate=>{for(let n=0;n<600;n++){if(await predicate())return;await delay(10);}assert.fail(JSON.stringify(await state()));};
  const drain=()=>until(async()=>{const s=await state();return s.background===0&&Object.values(s.rows).every(r=>r.done);});
  const send=(id,model=A,credential='rejection',flags='')=>{
    const work=(async()=>{const r=await runtime.dispatchFetch('https://router.example/proxy?id='+id+flags,{method:'POST',headers:{authorization:'Bearer clawrouter-live-'+credential+'-synthetic-secret','content-type':'application/json'},body:JSON.stringify({model,max_tokens:16,messages:[],metadata:{user_id:id}})});const body=await r.text();return {status:r.status,body,timing:r.headers.get('server-timing')};})();
    clients.add(work);work.then(()=>clients.delete(work),error=>{clients.delete(work);failures.push(error);});return work;
  };
  await call('/setup');
  return {io,access,call,state,until,drain,send,async restart(){await drain();await runtime.dispose();runtime=null;await startRuntime();},
    async revoke(){const r=await runtime.dispatchFetch('https://router.example/v1/admin/credentials/revoked/revoke?id=admin',{method:'POST',headers:access.headers});const body=await r.text();assert.equal(r.status,200,body);assert.equal(JSON.parse(body).enabled,false);}};
}

test('actual public revoke fences a held completed admission; real colo publication survives restart for a valid key', {timeout:120000}, async t=>{
  const f=await fixture(t);
  assert.equal((await f.send('positive1',A,'positive')).status,200);await f.drain();
  assert.ok((await f.state()).puts>0,'REAL Cache API publication');
  await f.restart();
  const adopted=await f.send('positive2',A,'positive');assert.equal(adopted.status,200,adopted.body);await f.drain();
  let s=await f.state();assert.equal(s.rows.positive2.admissions,0);assert.match(adopted.timing,/cr-cache;desc=colo/);assert.ok(s.hits>0);
  const old=f.send('old',A,'revoked','&hold-admission');
  await f.until(async()=>f.io.arrivals.has('/barrier/old/admission')&&(await f.state()).rows.old.admissionHeld);
  assert.equal((await f.state()).rows.old.owners,0);
  await f.revoke();f.io.release('/barrier/old/admission');await old;await f.drain();
  const before=[...f.io.provider.values()].reduce((a,b)=>a+b,0),next=await f.send('new',A,'revoked');await f.drain();
  assert.equal(next.status,403,next.body);s=await f.state();assert.equal(s.rows.new.admissions,1);assert.equal(s.rows.new.owners,0);
  assert.equal([...f.io.provider.values()].reduce((a,b)=>a+b,0),before,'new request cannot egress after successful revoke');
});

for(const rejection of [401,403])test(`actual ${rejection} eviction fences a pending-only foreground credential version`,{timeout:120000},async t=>{
  const f=await fixture(t);assert.equal((await f.send('warm')).status,200);await f.drain();
  const warm=await f.state();assert.equal(warm.rows.warm.owners,1);
  f.io.status.set('A',rejection);const a=f.send('A');
  await f.until(()=>f.io.provider.get('A')===1);
  assert.equal((await f.state()).rows.A.owners,0,'A uses a fresh credential hit');
  await f.call('/cache-expire');const b=f.send('B',B,'rejection','&hold-admission&hold-owner');
  await f.until(()=>f.io.arrivals.has('/barrier/B/admission'));
  let s=await f.state();assert.equal(s.rows.B.owners,0,'distinct never-hinted model B has zero speculative materialization');
  f.io.release('/barrier/B/admission');await f.until(()=>f.io.arrivals.has('/barrier/B/owner'));
  s=await f.state();assert.equal(s.rows.B.owners,1,'exactly one FOREGROUND materialization, no prior flight');
  assert.deepEqual(s.rows.B.identity,s.rows.warm.identity,'same grant version/revision');
  f.io.release('/provider/A');await a;
  await f.until(async()=>{const s=await f.state();return s.rows.A.done&&s.rows.A.pending===0&&s.evictions===1&&s.cooldown!==null;});
  f.io.release('/barrier/B/owner');await b;await f.drain();
  s=await f.state();assert.equal(s.rows.B.owners,1);assert.equal(s.evictions,1);assert.equal(s.background,0);
  const clock=s.cacheClock,advanced=await f.call('/wall-after-cooldown');assert.equal(advanced.cacheClock,clock);assert.ok(advanced.wall>Date.parse(advanced.cooldown));
  const c=f.send('C',B,'rejection','&hold-owner');await f.until(()=>f.io.arrivals.has('/barrier/C/owner'));
  s=await f.state();assert.equal(s.rows.C.owners,1,'C must reload after B drains; hypothetical B cache entry is still fresh');
  assert.deepEqual(s.rows.C.identity,s.rows.B.identity);assert.equal(f.io.provider.get('C')??0,0);
  f.io.release('/barrier/C/owner');assert.equal((await c).status,200);await f.drain();
  assert.equal((await f.send('D',B)).status,200);await f.drain();s=await f.state();assert.equal(s.rows.D.owners,0,'legitimate later cache hit');
  assert.equal(f.io.provider.get('C'),1);assert.equal(f.io.provider.get('D'),1);
});
