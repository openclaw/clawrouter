import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const issuer='https://access-owned.cloudflareaccess.com',certs=issuer+'/cdn-cgi/access/certs',email='access-owned@example.invalid';
async function fixtureKey(){
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'owned'};
 const token=async(changes={},header={})=>{
  const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned=enc({alg:'RS256',kid:'owned',...header})+'.'+enc({iss:issuer,aud:'owned',email,sub:'fixture',exp:Math.floor(Date.now()/1000)+600,...changes});
  return unsigned+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(unsigned))).toString('base64url');
 };return{jwk,token};
}
async function barriers(jwk){
 const waiting=new Map(),released=new Set(),arrived=new Set(),network=new Map(),errors=[];
 const nextWrite=response=>new Promise((resolve,reject)=>{
  const clear=()=>{response.off('drain',drain);response.off('close',close);response.off('error',error);};
  const drain=()=>{clear();resolve(true);},close=()=>{clear();resolve(false);},error=e=>{clear();reject(e);};
  response.once('drain',drain);response.once('close',close);response.once('error',error);
 });
 const server=createServer((request,response)=>{
  const path=request.url;
  if(['/jwks/valid','/jwks/huge','/jwks/partial'].includes(path)){
   assert.equal(request.method,'GET');assert.equal(request.headers.authorization,undefined);network.set(path,(network.get(path)??0)+1);
   response.once('error',error=>errors.push(error));
   response.writeHead(path==='/jwks/partial'?206:200,{'content-type':'application/json','cache-control':'public,max-age=300'});
   if(path!=='/jwks/huge'){response.end(JSON.stringify({keys:[jwk]}));return;}
   void(async()=>{
    const prefix=JSON.stringify({keys:[jwk]}).slice(0,-1)+',"ignored":"';
    if(!response.write(prefix)&&!await nextWrite(response))return;
    const chunk=Buffer.alloc(16384,120);
    for(let bytes=0;bytes<33*1024*1024;bytes+=chunk.length){if(response.destroyed)return;if(!response.write(chunk)&&!await nextWrite(response))return;}
    if(!response.destroyed)response.end('"}');
   })().catch(error=>{errors.push(error);response.destroy();});return;
  }
  if(request.method!=='GET'||request.headers.authorization||!/^\/[a-z0-9-]+\/(abort|read|cancel|fetch|crypto)$/.test(path)){response.writeHead(400).end();return;}
  arrived.add(path);if(released.has(path))response.end('released');else waiting.set(path,response);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return{origin:`http://127.0.0.1:${server.address().port}`,network,errors,arrived:(m,p)=>arrived.has(`/${m}/${p}`),
 release(m,p){const path=`/${m}/${p}`;released.add(path);waiting.get(path)?.end('released');waiting.delete(path);},
 releaseAll(){for(const [path,response]of waiting){released.add(path);response.end('released');}waiting.clear();},
 close:()=>new Promise((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());})};
}
const router=String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {sha256Hex} from './worker/utils.ts';
const certs='https://access-owned.cloudflareaccess.com/cdn-cgi/access/certs';
let active,clockOffset=0;const now=Date.now.bind(Date);Date.now=()=>now()+clockOffset;
const gate=(a,phase)=>fetch('https://access-gate.example/'+a.mode+'/'+phase,{redirect:'manual'}).then(async r=>{if(!r.ok)throw Error('fixture gate');await r.text();});
const realFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 if(String(input)!==certs)return realFetch(input,init);
 const a=active;a.fetches++;a.cache=init.cf?.cacheTtl===300&&init.cf?.cacheEverything===true;
 const headers=new Headers(init.headers);headers.set('x-access-fixture',a.mode);
 // Late-response mode deliberately ignores cancellation at this test boundary.
 const response=await realFetch(input,{...init,headers,...(a.mode==='late'?{signal:undefined}:{})});a.source=response.body;a.cacheHit=response.headers.get('x-fixture-cache-hit')==='1';
 if(a.mode==='late'){a.fetchHeld=true;await gate(a,'fetch');}
 if(response.body){
  const get=response.body.getReader.bind(response.body);let first,nativeEof=false;
  response.body.getReader=options=>{a.acquired++;const reader=get(options);return{
   async read(view){a.reads++;
    if(nativeEof){if(a.reads<(a.mode==='reads8192'?8192:8193))return{done:false,value:new Uint8Array(view.buffer,0,0)};return{done:true,value:new Uint8Array(view.buffer,0,0)};}
    a.nativeReads++;const part=await reader.read(view);a.nativeBytes+=part.value?.byteLength??0;a.nativeBacking=Math.max(a.nativeBacking,part.value?.buffer.byteLength??0);
    if((a.mode==='reads8192'||a.mode==='reads8193')&&part.done){nativeEof=true;a.nativeEof=true;return{done:false,value:new Uint8Array(new ArrayBuffer(16384),0,0)};}
    if(a.mode==='backing')return{done:false,value:new Uint8Array(new ArrayBuffer(16385),0,2)};
    if(['read','reject','unlock'].includes(a.mode)){a.readHeld=true;await gate(a,'read');a.readSettled=true;}
    return part;
   },
   cancel(reason){if(!first){let resolve,reject;first=new Promise((yes,no)=>{resolve=yes;reject=no;});
    Promise.resolve().then(async()=>{a.cancels++;try{await reader.cancel(reason);}finally{
     if(['read','reject','late','unlock'].includes(a.mode)){a.cancelHeld=true;await gate(a,'cancel');}a.cancelSettled=true;
     if(a.mode==='reject')throw Error('synthetic FIRST cancellation rejection');
    }}).then(resolve,reject);
   }return first;},
   releaseLock(){a.unlockAttempts++;a.readAtUnlock=a.readSettled;a.cancelAtUnlock=a.cancelSettled;
    if(a.mode==='unlock')throw Error('synthetic unknown original lock');
    reader.releaseLock();a.unlocked=!response.body.locked;
    if(a.mode==='cleanup')throw Error('synthetic error after actual unlock');
   }
  };};
 }
 return response;
};
for(const name of ['importKey','verify']){
 const original=crypto.subtle[name].bind(crypto.subtle);
 crypto.subtle[name]=async(...args)=>{
  const a=active;if(a){if(name==='importKey')a.imports++;else a.verifies++;}
  const result=await original(...args);
  if(a&&((name==='importKey'&&a.mode==='import')||(name==='verify'&&['verify','expiry'].includes(a.mode)))){
   a.cryptoHeld=true;await gate(a,'crypto');if(a.mode==='expiry')clockOffset=11000;
  }
  return result;
 };
}
const state=()=>active?{mode:active.mode,fallback:active.fallback,fetches:active.fetches,cache:active.cache,cacheHit:active.cacheHit,acquired:active.acquired,reads:active.reads,nativeReads:active.nativeReads,nativeBytes:active.nativeBytes,nativeBacking:active.nativeBacking,nativeEof:active.nativeEof,
 imports:active.imports,verifies:active.verifies,cancels:active.cancels,cancelHeld:active.cancelHeld,cancelSettled:active.cancelSettled,readHeld:active.readHeld,
 readSettled:active.readSettled,fetchHeld:active.fetchHeld,cryptoHeld:active.cryptoHeld,aborted:active.abort.signal.aborted,finished:active.finished,
 status:active.status,authenticated:active.authenticated,code:active.code,unlocked:active.unlocked,locked:active.source?.locked??false,unlockAttempts:active.unlockAttempts,
 readAtUnlock:active.readAtUnlock,cancelAtUnlock:active.cancelAtUnlock}:{};
export default{async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.pathname==='/state')return Response.json(state());
 if(url.pathname==='/setup'){
  await authorityCall(env,'/users/put',{email:'access-owned@example.invalid',record:{enabled:true,role:'user',groups:[],contentRetentionDisabled:false,
   assignmentState:{version:1,revision:'[]',assignments:{},updatedAt:null}}});
  await env.POLICY_KV.put('local/sessions/'+await sha256Hex('a'.repeat(64)),JSON.stringify({email:'access-owned@example.invalid',role:'user',expiresAtMs:Date.now()+600000}));return Response.json({ready:true});
 }
 if(url.pathname!=='/start')return new Response(null,{status:404});
 const data=await request.json();clockOffset=0;
 const a=active={mode:data.mode,fallback:0,fetches:0,acquired:0,reads:0,nativeReads:0,nativeBytes:0,nativeBacking:0,imports:0,verifies:0,cancels:0,unlockAttempts:0,finished:false,abort:new AbortController()};
 if(['read','reject','late','unlock','import','verify'].includes(a.mode))ctx.waitUntil(gate(a,'abort').then(()=>a.abort.abort({cleanupFailed:true})));
 const fixtureEnv={...env};
 Object.defineProperty(fixtureEnv,'CLAWROUTER_ADMIN_TOKEN_SHA256',{get(){a.fallback++;return env.CLAWROUTER_ADMIN_TOKEN_SHA256;}});
 if(a.mode.startsWith('no-config')){
  fixtureEnv.CLAWROUTER_ACCESS_TEAM_DOMAIN=undefined;fixtureEnv.CLAWROUTER_ACCESS_AUD=undefined;fixtureEnv.CLAWROUTER_LOCAL_AUTH='enabled';
  fixtureEnv.POLICY_KV={get(...args){a.fallback++;return env.POLICY_KV.get(...args);},list:(...args)=>env.POLICY_KV.list(...args)};
 }
 if(a.mode==='no-config-aborted')a.abort.abort({cleanupFailed:true});
 const req=new Request('https://router.example'+(a.mode==='partial'?'/v1/admin/fixture':'/v1/session'),{headers:{'cf-access-jwt-assertion':data.token,authorization:'Bearer synthetic-access-admin',cookie:'clawrouter_session='+'a'.repeat(64)},signal:a.abort.signal});
 const work=worker.fetch(req,fixtureEnv,ctx).then(async response=>{const body=await response.json();a.status=response.status;a.authenticated=body.authenticated===true;a.code=body.error?.code;a.finished=true;},()=>{a.code='unexpected-fixture-error';a.finished=true;});
 ctx.waitUntil(work);return Response.json(state());
}};`;
const upstream=(jwk,origin)=>String.raw`
const key=${JSON.stringify(jwk)};
export default{async fetch(request){
 const url=new URL(request.url);
 if(url.origin==='https://access-gate.example')return fetch(${JSON.stringify(origin)}+url.pathname,{redirect:'manual',signal:request.signal});
 if(request.url!=='https://access-owned.cloudflareaccess.com/cdn-cgi/access/certs'||request.method!=='GET'||request.headers.has('authorization'))return new Response(null,{status:400});
 const mode=request.headers.get('x-access-fixture');let text;
 if(mode==='cache-fill'||mode==='cache-hit'){
  const cache=caches.default,hit=await cache.match(request.url);
  if(hit){const headers=new Headers(hit.headers);headers.set('x-fixture-cache-hit','1');return new Response(hit.body,{headers});}
  const response=await fetch(${JSON.stringify(origin)}+'/jwks/valid',{redirect:'manual',signal:request.signal});
  await cache.put(request.url,response.clone());return response;
 }
 if(['valid','huge','partial','read','reject','late','unlock','import','verify','expiry','cleanup','reads8192','reads8193','backing'].includes(mode))
  return fetch(${JSON.stringify(origin)}+'/jwks/'+(mode==='huge'?'huge':mode==='partial'?'partial':'valid'),{redirect:'manual',signal:request.signal});
 if(mode==='keys33')text=JSON.stringify({keys:[key,...Array(32).fill({})]});
 else if(mode==='duplicates')text='{"keys":['+Array(32).fill(JSON.stringify({kid:'ignored'})).join(',')+'],"keys":['+JSON.stringify(key)+']}';
 else if(mode==='duplicate-n'||mode==='duplicate-e'){const field=mode==='duplicate-n'?'n':'e',size=field==='n'?1025:9;text='{"keys":[{"'+field+'":"'+btoa('a'.repeat(size)).replace(/=+$/,'')+'",'+JSON.stringify(key).slice(1)+']}';}
 else if(mode==='key-ops')text=JSON.stringify({keys:[{...key,key_ops:['sign']},key]});
 else if(mode==='key-alg')text=JSON.stringify({keys:[{...key,alg:'RSA-OAEP'},key]});
 else if(mode==='wrong-kid')text=JSON.stringify({keys:[{...key,kid:'foreign'}]});
 else if(mode==='maximum'||mode==='maximum-plus'){
  // All32 rows, every complete row's8KiB source span, aggregate UTF16/values and
  // the256KiB wire limit are independently guarded. This wire case has32 rows.
  text=JSON.stringify({keys:[...Array(31).fill({kid:'ignored'}),key]});text+=' '.repeat(262144-text.length+(mode==='maximum-plus'?1:0));
 }else text=JSON.stringify({keys:[{...key,kid:'other'},key]});
 const headers={'content-type':mode==='mime'?'text/event-stream':'application/json'};
 if(mode==='encoding')headers['content-encoding']='gzip';
 if(mode==='length')headers['content-length']='262145';
 if(mode==='range')headers['content-range']='bytes 0-1/2';
 if(mode==='utf8')return new Response(new Uint8Array([123,255,125]),{headers});
 return new Response(text,{headers});
}};`;

test('actual Workerd public Access reader/crypto limits and retirement-blocking facade', {timeout:180000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'access-owned-workerd-')),signed=await fixtureKey(),io=await barriers(signed.jwk);let runtime;
 t.after(async()=>{io.releaseAll();try{await runtime?.dispose();}finally{await io.close();await rm(dir,{recursive:true,force:true});}});
 runtime=await startWorkerdFixture(dir,router,upstream(signed.jwk,io.origin),{preventEviction:true,bindings:{CLAWROUTER_ACCESS_TEAM_DOMAIN:issuer,CLAWROUTER_ACCESS_AUD:'owned',CLAWROUTER_ADMIN_TOKEN_SHA256:Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('synthetic-access-admin'))).toString('hex')}});
 const call=async(path,body)=>{const response=await runtime.dispatchFetch('https://router.example'+path,body?{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'}}:undefined);assert.equal(response.status,200,await response.clone().text());return response.json();};
 const until=async(mode,predicate)=>{let value;for(let i=0;i<300;i++){value=await call('/state');if(value.mode===mode&&predicate(value))return value;await delay(10);}assert.fail(JSON.stringify(value));};
 await call('/setup');const valid=await signed.token();
 for(const mode of ['valid','cache-fill','cache-hit','maximum','reads8192']){
  await call('/start',{mode,token:valid});const state=await until(mode,s=>s.finished);assert.equal(state.status,200,JSON.stringify(state));assert.equal(state.authenticated,true,JSON.stringify(state));assert.equal(state.imports,1);assert.equal(state.verifies,1);assert.equal(state.unlocked,true);assert.equal(state.cache,true);
  if(mode==='valid')assert.equal(io.network.get('/jwks/valid'),1);
  if(mode==='cache-hit')assert.equal(state.cacheHit,true);
  if(mode==='reads8192'){assert.equal(state.reads,8192);assert.equal(state.nativeEof,true);assert.ok(state.nativeReads<8192);}
 }
 for(const mode of ['huge','keys33','duplicates','maximum-plus','backing','reads8193','mime','encoding','range','utf8','length','cleanup','partial','duplicate-n','duplicate-e']){
  await call('/start',{mode,token:valid});const state=await until(mode,s=>s.finished);assert.equal(state.authenticated,false,JSON.stringify(state));assert.ok(state.status>=400,JSON.stringify(state));assert.equal(state.imports,0);assert.equal(state.locked,false);assert.equal(state.unlockAttempts,1);
  if(mode==='huge'){
   assert.equal(state.code,'access_limit');assert.equal(state.imports,0);assert.equal(state.verifies,0);assert.equal(state.cancels,1);
   assert.ok(state.nativeBytes>0&&state.nativeBytes<=256*1024+16*1024,JSON.stringify(state));
   assert.ok(state.nativeBacking<=16*1024,JSON.stringify(state));assert.equal(io.network.get('/jwks/huge'),1);
  }
  if(mode==='partial'){assert.equal(state.code,'access_transport');assert.equal(state.fallback,0);assert.equal(state.cancels,1);assert.equal(state.verifies,0);} // Incremental rejection, not a33MiB text allocation.
  if(mode==='reads8193'){assert.equal(state.reads,8192);assert.equal(state.cancels,1);assert.equal(state.nativeEof,true);}
 }
 for(const mode of ['key-ops','key-alg','wrong-kid']){
  await call('/start',{mode,token:valid});const state=await until(mode,s=>s.finished);assert.equal(state.authenticated,false);assert.equal(state.imports,mode==='wrong-kid'?0:1);assert.equal(state.verifies,0);
 }
 for(const [mode,token]of [['issuer',await signed.token({iss:'https://foreign.example'})],['audience',await signed.token({aud:'foreign'})],['expired',await signed.token({exp:1})],['alg',await signed.token({}, {alg:'HS256'})]]){
  await call('/start',{mode,token});const state=await until(mode,s=>s.finished);assert.equal(state.authenticated,false);assert.equal(state.fetches,0);
 }
 const enc=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
 for(const [mode,token]of [
  ['no-config-baseline','a.b.c'],
  ['no-config-size','!.'+enc('x'.repeat(8193))+'.c2ln'],
  ['no-config-padding','a===.'+enc('x'.repeat(8193))+'.c2ln'],
  ['no-config-kid',enc({alg:'RS256',kid:'x'.repeat(257)})+'.e30.c2ln'],
  ['no-config-structure',enc('{'+Array(33).fill('"kid":"k"').join(',')+'}')+'.e30.c2ln'],
  ['no-config-aborted','a.b.c']]){
   await call('/start',{mode,token});const state=await until(mode,s=>s.finished);
   if(mode==='no-config-baseline'){assert.equal(state.authenticated,true);assert.ok(state.fallback>0);}
   else{assert.equal(state.authenticated,false);assert.equal(state.code,mode==='no-config-aborted'?'access_deadline':'access_limit');assert.equal(state.fallback,0);}
   assert.equal(state.fetches,0);assert.equal(state.imports,0);assert.equal(state.verifies,0);
 }
 for(const mode of ['read','reject','late','import','verify']){
  await call('/start',{mode,token:valid});let state=await until(mode,s=>s.readHeld||s.fetchHeld||s.cryptoHeld||s.finished);assert.equal(state.finished,false,JSON.stringify(state));
  io.release(mode,'abort');state=await until(mode,s=>s.aborted);assert.equal(state.finished,false);
  if(mode==='late'){io.release(mode,'fetch');state=await until(mode,s=>s.cancelHeld);assert.equal(state.reads,0);}
  if(mode==='import'||mode==='verify'){assert.equal(state.locked,false);io.release(mode,'crypto');}
  else{
   state=await until(mode,s=>s.cancelHeld);assert.equal(state.cancels,1);assert.equal(state.locked,true);assert.equal(state.finished,false);
   io.release(mode,'cancel');state=await until(mode,s=>s.cancelSettled);
   if(mode!=='late'){assert.equal(state.finished,false);assert.equal(state.locked,true);io.release(mode,'read');}
  }
  state=await until(mode,s=>s.finished);assert.equal(state.authenticated,false);assert.equal(state.locked,false);assert.equal(state.unlockAttempts,1);
 }
 await call('/start',{mode:'expiry',token:await signed.token({exp:Math.floor(Date.now()/1000)+10})});await until('expiry',s=>s.cryptoHeld);io.release('expiry','crypto');let state=await until('expiry',s=>s.finished);assert.equal(state.authenticated,false);
 // Last: an injected releaseLock failure retains an UNKNOWN physical root. It
 // never becomes success; fixture runtime disposal is not production retirement.
 await call('/start',{mode:'unlock',token:valid});await until('unlock',s=>s.readHeld);io.release('unlock','abort');await until('unlock',s=>s.cancelHeld);io.release('unlock','cancel');await until('unlock',s=>s.cancelSettled);io.release('unlock','read');
 assert.deepEqual(io.errors,[]);
 state=await until('unlock',s=>s.unlockAttempts===1);assert.equal(state.locked,true);assert.equal(state.finished,false);assert.equal(state.readAtUnlock,true);assert.equal(state.cancelAtUnlock,true);
});
