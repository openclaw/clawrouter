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
async function barriers(){
 const waiting=new Map(),released=new Set(),arrived=new Set();
 const server=createServer((request,response)=>{
  const path=request.url;if(request.method!=='GET'||request.headers.authorization||!/^\/[a-z0-9-]+\/(abort|read|cancel|fetch|crypto)$/.test(path)){response.writeHead(400).end();return;}
  arrived.add(path);if(released.has(path))response.end('released');else waiting.set(path,response);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return{origin:`http://127.0.0.1:${server.address().port}`,arrived:(m,p)=>arrived.has(`/${m}/${p}`),
 release(m,p){const path=`/${m}/${p}`;released.add(path);waiting.get(path)?.end('released');waiting.delete(path);},
 releaseAll(){for(const [path,response]of waiting){released.add(path);response.end('released');}waiting.clear();},
 close:()=>new Promise((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());})};
}
const router=String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
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
    a.nativeReads++;const part=await reader.read(view);
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
const state=()=>active?{mode:active.mode,fetches:active.fetches,cache:active.cache,cacheHit:active.cacheHit,acquired:active.acquired,reads:active.reads,nativeReads:active.nativeReads,nativeEof:active.nativeEof,
 imports:active.imports,verifies:active.verifies,cancels:active.cancels,cancelHeld:active.cancelHeld,cancelSettled:active.cancelSettled,readHeld:active.readHeld,
 readSettled:active.readSettled,fetchHeld:active.fetchHeld,cryptoHeld:active.cryptoHeld,aborted:active.abort.signal.aborted,finished:active.finished,
 status:active.status,authenticated:active.authenticated,code:active.code,unlocked:active.unlocked,locked:active.source?.locked??false,unlockAttempts:active.unlockAttempts,
 readAtUnlock:active.readAtUnlock,cancelAtUnlock:active.cancelAtUnlock}:{};
export default{async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.pathname==='/state')return Response.json(state());
 if(url.pathname==='/setup'){
  await authorityCall(env,'/users/put',{email:'access-owned@example.invalid',record:{enabled:true,role:'user',groups:[],contentRetentionDisabled:false,
   assignmentState:{version:1,revision:'[]',assignments:{},updatedAt:null}}});return Response.json({ready:true});
 }
 if(url.pathname!=='/start')return new Response(null,{status:404});
 const data=await request.json();clockOffset=0;
 const a=active={mode:data.mode,fetches:0,acquired:0,reads:0,nativeReads:0,imports:0,verifies:0,cancels:0,unlockAttempts:0,finished:false,abort:new AbortController()};
 if(['read','reject','late','unlock','import','verify'].includes(a.mode))ctx.waitUntil(gate(a,'abort').then(()=>a.abort.abort({cleanupFailed:true})));
 const req=new Request('https://router.example/v1/session',{headers:{'cf-access-jwt-assertion':data.token},signal:a.abort.signal});
 const work=worker.fetch(req,env,ctx).then(async response=>{const body=await response.json();a.status=response.status;a.authenticated=body.authenticated===true;a.code=body.error?.code;a.finished=true;},()=>{a.code='unexpected-fixture-error';a.finished=true;});
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
  const response=new Response(JSON.stringify({keys:[key]}),{headers:{'content-type':'application/json','cache-control':'public,max-age=300'}});
  await cache.put(request.url,response.clone());return response;
 }
 if(mode==='huge'){
  const prefix=JSON.stringify({keys:[key]}).slice(0,-1)+',"ignored":"';let offset=0;
  return new Response(new ReadableStream({pull(c){if(offset===0){c.enqueue(new TextEncoder().encode(prefix));offset++;}
   else if(offset<=2112){c.enqueue(new Uint8Array(16384).fill(120));offset++;}else{c.enqueue(new TextEncoder().encode('"}'));c.close();}}),{headers:{'content-type':'application/json'}});
 }
 if(mode==='keys33')text=JSON.stringify({keys:[key,...Array(32).fill({})]});
 else if(mode==='duplicates')text='{"keys":['+Array(32).fill(JSON.stringify({kid:'ignored'})).join(',')+'],"keys":['+JSON.stringify(key)+']}';
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
 const dir=await mkdtemp(join(tmpdir(),'access-owned-workerd-')),io=await barriers(),signed=await fixtureKey();let runtime;
 t.after(async()=>{io.releaseAll();try{await runtime?.dispose();}finally{await io.close();await rm(dir,{recursive:true,force:true});}});
 runtime=await startWorkerdFixture(dir,router,upstream(signed.jwk,io.origin),{preventEviction:true,bindings:{CLAWROUTER_ACCESS_TEAM_DOMAIN:issuer,CLAWROUTER_ACCESS_AUD:'owned'}});
 const call=async(path,body)=>{const response=await runtime.dispatchFetch('https://router.example'+path,body?{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'}}:undefined);assert.equal(response.status,200,await response.clone().text());return response.json();};
 const until=async(mode,predicate)=>{let value;for(let i=0;i<300;i++){value=await call('/state');if(value.mode===mode&&predicate(value))return value;await delay(10);}assert.fail(JSON.stringify(value));};
 await call('/setup');const valid=await signed.token();
 for(const mode of ['valid','cache-fill','cache-hit','maximum','reads8192']){
  await call('/start',{mode,token:valid});const state=await until(mode,s=>s.finished);assert.equal(state.status,200,JSON.stringify(state));assert.equal(state.authenticated,true,JSON.stringify(state));assert.equal(state.imports,1);assert.equal(state.verifies,1);assert.equal(state.unlocked,true);assert.equal(state.cache,true);
  if(mode==='cache-hit')assert.equal(state.cacheHit,true);
  if(mode==='reads8192'){assert.equal(state.reads,8192);assert.equal(state.nativeEof,true);assert.ok(state.nativeReads<8192);}
 }
 for(const mode of ['huge','keys33','duplicates','maximum-plus','backing','reads8193','mime','encoding','range','utf8','length','cleanup']){
  await call('/start',{mode,token:valid});const state=await until(mode,s=>s.finished);assert.equal(state.authenticated,false,JSON.stringify(state));assert.ok(state.status>=400,JSON.stringify(state));assert.equal(state.imports,0);assert.equal(state.locked,false);assert.equal(state.unlockAttempts,1);
  if(mode==='huge')assert.ok(state.nativeReads<=18); // Incremental rejection, not a33MiB text allocation.
  if(mode==='reads8193'){assert.equal(state.reads,8192);assert.equal(state.cancels,1);assert.equal(state.nativeEof,true);}
 }
 for(const mode of ['key-ops','key-alg','wrong-kid']){
  await call('/start',{mode,token:valid});const state=await until(mode,s=>s.finished);assert.equal(state.authenticated,false);assert.equal(state.imports,mode==='wrong-kid'?0:1);assert.equal(state.verifies,0);
 }
 for(const [mode,token]of [['issuer',await signed.token({iss:'https://foreign.example'})],['audience',await signed.token({aud:'foreign'})],['expired',await signed.token({exp:1})],['alg',await signed.token({}, {alg:'HS256'})]]){
  await call('/start',{mode,token});const state=await until(mode,s=>s.finished);assert.equal(state.authenticated,false);assert.equal(state.fetches,0);
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
 state=await until('unlock',s=>s.unlockAttempts===1);assert.equal(state.locked,true);assert.equal(state.finished,false);assert.equal(state.readAtUnlock,true);assert.equal(state.cancelAtUnlock,true);
});
