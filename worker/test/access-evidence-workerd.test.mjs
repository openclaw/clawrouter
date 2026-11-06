import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const issuer='https://evidence.cloudflareaccess.com',email='evidence@example.invalid';
const identity=()=>({email,idp:{type:'github'},orgs:[{id:'1',name:'example'}],teams:[{org_id:'1',name:'maintainers'}]});
async function signing(){
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'evidence'};
  const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const value=enc({alg:'RS256',kid:jwk.kid})+'.'+enc({iss:issuer,aud:'evidence',email,exp:Math.floor(Date.now()/1000)+600});
  return{jwk,token:value+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(value))).toString('base64url')};
}
function body(mode){
  const value=identity();
  if(mode==='empty')return JSON.stringify({...value,orgs:[],teams:[]});
  if(mode==='unknown')return '{';
  if(mode==='wrong-email')return JSON.stringify({...value,email:'foreign@example.invalid'});
  if(mode==='non-github')return JSON.stringify({...value,idp:{type:'other'}});
  if(mode==='jwks-metadata')return JSON.stringify({...value,ignored:{keys:Array(33).fill({kid:'k'.repeat(257),e:'e'.repeat(16)})}});
  if(mode.startsWith('org-')||mode.startsWith('team-')){
    const key=mode.startsWith('org-')?'orgs':'teams',maximum=key==='orgs'?128:256;
    // Discarded primitive rows make the exact count reachable while the final
    // parsed value remains a valid identity; every occurrence must still count.
    return '{"'+(key==='orgs'?'\\u006frgs':key)+'":['+Array(maximum-(mode.endsWith('plus')?0:1)).fill('0').join(',')+'],'+JSON.stringify(value).slice(1);
  }
  if(mode==='text'||mode==='text-plus'||mode==='text-multibyte'){const text=JSON.stringify(mode==='text-multibyte'?{...value,ignored:Array(63).fill('漢'.repeat(1000))}:value);return text+' '.repeat(65536-text.length+(mode==='text-plus'?1:0));}
  if(mode==='scalar')return JSON.stringify({...value,ignored:'x'.repeat(1025)});
  if(mode==='members')return '{'+Array(2049).fill('"ignored":0').join(',')+'}';
  return JSON.stringify(value);
}
async function network(jwk){
  const held=new Map(),released=new Set(),arrived=new Set(),calls=new Map(),errors=[];let allReleased=false,foreignCookies=0;
  const writable=res=>new Promise((resolve,reject)=>{
    const clear=()=>{res.off('drain',drain);res.off('close',close);res.off('error',error);};
    const drain=()=>{clear();resolve(true);},close=()=>{clear();resolve(false);},error=e=>{clear();reject(e);};
    res.once('drain',drain);res.once('close',close);res.once('error',error);
  });
  const server=createServer({maxHeaderSize:65536},(req,res)=>{
    const path=req.url;calls.set(path,(calls.get(path)??0)+1);res.once('error',error=>errors.push(error));
    if(path==='/jwks'){assert.equal(req.headers.cookie,undefined);res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({keys:[jwk]}));return;}
    if(path==='/foreign'){if(req.headers.cookie)foreignCookies++;res.end('foreign');return;}
    if(path.startsWith('/gate/')){arrived.add(path);if(allReleased||released.has(path))res.end('released');else held.set(path,()=>res.end('released'));return;}
    if(!path.startsWith('/identity/')){res.writeHead(404).end();return;}
    const mode=path.slice('/identity/'.length);assert.ok(req.headers.cookie);assert.equal(req.headers.authorization,undefined);
    if(mode==='redirect'){res.writeHead(302,{location:'https://foreign-evidence.example/foreign','content-type':'application/json'}).end('{}');return;}
    const headers={'content-type':mode==='mime'?'text/event-stream':'application/json'};
    if(mode==='header-limit')headers['x-padding']='x'.repeat(4096);
    if(mode==='wire-declared')headers['content-length']='262145';
    res.writeHead(mode==='partial'?206:mode==='failure'?503:mode==='created'?201:200,headers);
    if(mode==='wire-declared'){res.flushHeaders();held.set(path,()=>res.destroy());return;}
    if(['held','cancel-reject','caller10','timeout','timeout-reject','unknown-lock'].includes(mode)){
      const text=body(mode);res.write(text.slice(0,-1));res.flushHeaders();arrived.add(path);
      const finish=()=>res.end('}');if(allReleased||released.has(path))finish();else held.set(path,finish);return;
    }
    if(mode==='huge'){
      void(async()=>{
        if(!res.write(JSON.stringify(identity()).slice(0,-1)+',"ignored":"')&&!await writable(res))return;
        const chunk=Buffer.alloc(16384,120);
        for(let bytes=0;bytes<33*1024*1024;bytes+=chunk.length){if(res.destroyed)return;if(!res.write(chunk)&&!await writable(res))return;}
        if(!res.destroyed)res.end('"}');
      })().catch(error=>{errors.push(error);res.destroy();});return;
    }
    if(mode==='utf8'){res.end(Buffer.from([123,255,125]));return;}
    res.end(body(mode));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return{origin:'http://127.0.0.1:'+server.address().port,calls,errors,arrived,foreignCookies:()=>foreignCookies,
    release(path){released.add(path);held.get(path)?.();held.delete(path);},
    releaseAll(){allReleased=true;for(const finish of held.values())finish();held.clear();},
    close:()=>new Promise((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());})};
}

const router=String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {sha256Hex} from './worker/utils.ts';
const nativeFetch=globalThis.fetch.bind(globalThis),nativeTimeout=AbortSignal.timeout.bind(AbortSignal);
let active;const gate=(a,name)=>nativeFetch('https://evidence-gate.example/gate/'+a.mode+'/'+name,{redirect:'manual'}).then(async r=>{if(!r.ok)throw Error('gate rejected');await r.text();});
AbortSignal.timeout=ms=>{if(active)active.timeouts.push(ms);return nativeTimeout(ms);};
const snap=()=>active?{mode:active.mode,finished:active.finished,status:active.status,code:active.code,published:active.published,groups:active.groups,
  certs:active.certs,evidence:active.evidence,configReads:active.configReads,adminReads:active.adminReads,reads:active.reads,nativeReads:active.nativeReads,nativePending:active.nativePending,
  bytes:active.bytes,backing:active.backing,cancels:active.cancels,cancelHeld:active.cancelHeld,cancelSettled:active.cancelSettled,unlockAttempts:active.unlockAttempts,
  locked:active.source?.locked??false,unlocked:active.unlocked,readAtUnlock:active.readAtUnlock,cancelAtUnlock:active.cancelAtUnlock,fetchHeld:active.fetchHeld,
  aborted:active.signal?.aborted??false,evidenceAborted:active.evidenceSignal?.aborted??false,reconcileHeld:active.reconcileHeld,timeouts:active.timeouts,failure:active.failure}:{};
globalThis.fetch=async(input,init)=>{
  const target=String(input),a=active;
  if(target==='https://evidence.cloudflareaccess.com/cdn-cgi/access/certs'){a.certs++;return nativeFetch(input,init);}
  if(target!=='https://router.example/cdn-cgi/access/get-identity')throw Error('unexpected destination');
  a.evidence++;a.evidenceSignal=init.signal;
  const headers=new Headers(init.headers);headers.set('x-evidence-mode',a.mode);
  const response=await nativeFetch(input,{...init,headers,...(a.mode==='late'?{signal:undefined}:{})});a.source=response.body;
  if(a.mode==='late'){a.fetchHeld=true;await gate(a,'fetch');}
  if(response.body){const get=response.body.getReader.bind(response.body);let first,nativeEof=false;
    response.body.getReader=options=>{const reader=get(options);return{
      async read(view){
        a.reads++;
        if(nativeEof){if(a.reads<(a.mode==='reads8192'?8192:8193))return{done:false,value:new Uint8Array(view.buffer,0,0)};return{done:true,value:new Uint8Array(view.buffer,0,0)};}
        a.nativeReads++;a.nativePending++;
        let result;try{result=await reader.read(view);}finally{a.nativePending--;}
        a.bytes+=result.value?.byteLength??0;a.backing=Math.max(a.backing,result.value?.buffer.byteLength??0);
        if((a.mode==='reads8192'||a.mode==='reads8193')&&result.done){nativeEof=true;return{done:false,value:new Uint8Array(new ArrayBuffer(16384),0,0)};}
        if(a.mode==='backing')return{done:false,value:new Uint8Array(new ArrayBuffer(16385),0,2)};
        if(a.mode==='read-error')throw {cause:['synthetic untrusted read failure']};
        return result;
      },
      cancel(reason){if(!first){let resolve,reject;first=new Promise((yes,no)=>{resolve=yes;reject=no;});
        Promise.resolve().then(async()=>{a.cancels++;try{await reader.cancel(reason);}finally{
          if(['held','cancel-reject','caller10','timeout-reject','late','unknown-lock'].includes(a.mode)){a.cancelHeld=true;await gate(a,'cancel');}
          a.cancelSettled=true;if(['cancel-reject','timeout-reject'].includes(a.mode))throw Error('deliberate FIRST cancellation rejection');
        }}).then(resolve,reject);
      }return first;},
      releaseLock(){a.unlockAttempts++;a.readAtUnlock=a.nativePending===0;a.cancelAtUnlock=a.cancelSettled;
        if(a.mode==='unknown-lock')throw Error('injected unknown lock');reader.releaseLock();a.unlocked=!response.body.locked;
        if(a.mode==='cleanup')throw Error('injected failure after actual unlock');
      }
    };};
  }
  return response;
};
export default{async fetch(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname==='/state')return Response.json(snap());
  if(url.pathname==='/user')return Response.json((await authorityCall(env,'/users/resolve',{emails:['evidence@example.invalid']})).users[0].record);
  if(url.pathname==='/setup'){
    await authorityCall(env,'/users/put',{email:'evidence@example.invalid',record:{enabled:true,role:'user',groups:['manual'],tenantId:'fixture'}});
    for(const [id,index]of [['org',0],['team',1]])await env.POLICY_KV.put('access/assignment-rules/'+id,JSON.stringify({version:1,enabled:true,kind:index?'github_team':'github_org',subject:index?'example/maintainers':'example',groups:[index?'retained':'revocable'],policyIds:[],priority:index,revokeOnLoss:!index,provenance:'cloudflare_access'}));
    await env.POLICY_KV.put('local/sessions/'+await sha256Hex('a'.repeat(64)),JSON.stringify({email:'evidence@example.invalid',role:'admin',expiresAtMs:Date.now()+600000}));
    return Response.json({ready:true});
  }
  if(url.pathname!=='/start')return new Response(null,{status:404});
  const data=await request.json();
  const a=active={mode:data.mode,finished:false,published:false,certs:0,evidence:0,configReads:0,adminReads:0,reads:0,nativeReads:0,nativePending:0,bytes:0,backing:0,cancels:0,unlockAttempts:0,timeouts:[],abort:new AbortController()};
  a.signal=a.mode==='caller10'?AbortSignal.any([a.abort.signal,AbortSignal.timeout(10000)]):a.abort.signal;
  // Register the original-signal continuation in the originating request. This
  // is an injected signal seam, not production client-disconnect evidence.
  if(['held','cancel-reject','reconcile','reconcile-admin','unknown-lock'].includes(a.mode))ctx.waitUntil(gate(a,'abort').then(()=>a.abort.abort({cleanupFailed:true})));
  const fixtureEnv={...env,CLAWROUTER_ACCESS_ADMIN_EMAILS:data.admin?'evidence@example.invalid':''};
  Object.defineProperty(fixtureEnv,'CLAWROUTER_ACCESS_TEAM_DOMAIN',{get(){a.configReads++;return env.CLAWROUTER_ACCESS_TEAM_DOMAIN;}});
  Object.defineProperty(fixtureEnv,'CLAWROUTER_ADMIN_TOKEN_SHA256',{get(){a.adminReads++;return env.CLAWROUTER_ADMIN_TOKEN_SHA256;}});
  const namespace=env.ACCESS_CONTROL;fixtureEnv.ACCESS_CONTROL={idFromName:n=>namespace.idFromName(n),get:id=>{const stub=namespace.get(id);return{async fetch(input,init){const response=await stub.fetch(input,init);
    if(new URL(input).pathname==='/users/reconcile-assignments'&&a.mode.startsWith('reconcile')){a.reconcileHeld=true;await gate(a,'reconcile');}return response;
  }}}};
  const prefix='https://router.example'+(data.admin?'/v1/admin/users':'/v1/session'),target=data.urlLength?prefix+'?padding='+'x'.repeat(data.urlLength-prefix.length-9):prefix;
  const req=new Request(target,{signal:a.signal,headers:{'cf-access-jwt-assertion':data.token,cookie:data.cookieLength?'x'.repeat(data.cookieLength):'CF_Authorization=synthetic; clawrouter_session='+'a'.repeat(64),authorization:'Bearer synthetic-evidence-admin'}});
  const work=worker.fetch(req,fixtureEnv,ctx).then(async response=>{
    const body=await response.json();a.status=response.status;a.code=body.error?.code;a.groups=body.groups;
    a.published=response.status===200&&(data.admin||body.authenticated===true);
  }).catch(()=>{a.failure=true;}).finally(()=>{a.finished=true;});
  ctx.waitUntil(work);return Response.json(snap());
}};`;
const upstream=origin=>String.raw`
export default{async fetch(request){
 const url=new URL(request.url);
 if(url.origin==='https://evidence-gate.example')return fetch(${JSON.stringify(origin)}+url.pathname,{redirect:'manual',signal:request.signal});
 if(request.url==='https://evidence.cloudflareaccess.com/cdn-cgi/access/certs')return fetch(${JSON.stringify(origin)}+'/jwks',{redirect:'manual',signal:request.signal});
 if(url.origin==='https://foreign-evidence.example')return fetch(${JSON.stringify(origin)}+'/foreign',{headers:request.headers,redirect:'manual',signal:request.signal});
 if(request.url!=='https://router.example/cdn-cgi/access/get-identity')return new Response(null,{status:400});
 return fetch(${JSON.stringify(origin)}+'/identity/'+request.headers.get('x-evidence-mode'),{headers:request.headers,redirect:'manual',signal:request.signal});
}};`;

test('actual public Access evidence: network limits, SQLite assignments and physical retirement', {timeout:180000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'access-evidence-workerd-')),signed=await signing(),io=await network(signed.jwk);
  let runtime,unknownVerified=false;const clients=new Set(),clientFailures=[];
  const call=(path,data)=>{
    const work=(async()=>{const response=await runtime.dispatchFetch('https://router.example'+path,data?{method:'POST',body:JSON.stringify(data),headers:{'content-type':'application/json'}}:undefined);assert.equal(response.status,200,await response.clone().text());return response.json();})();
    clients.add(work);work.then(()=>clients.delete(work),error=>{clients.delete(work);clientFailures.push(error);});return work;
  };
  // Registered before runtime or clients. Failed-path cleanup releases current
  // AND future barriers, joins all clients and reports every unexpected error.
  t.after(async()=>{
    io.releaseAll();const errors=[];
    for(const result of await Promise.allSettled([...clients]))if(result.status==='rejected')errors.push(result.reason);
    if(runtime&&!unknownVerified)try{for(let i=0;i<300;i++){const s=await call('/state');if(s.failure)throw Error('original session work failed');if(!s.mode||s.finished)break;if(i===299)throw Error('original session work did not retire');await delay(10);}}catch(error){errors.push(error);}
    try{await runtime?.dispose();}catch(error){errors.push(error);}try{await io.close();}catch(error){errors.push(error);}
    await rm(dir,{recursive:true,force:true});errors.push(...clientFailures,...io.errors);if(errors.length)throw new AggregateError(errors,'evidence fixture cleanup failed');
  });
  runtime=await startWorkerdFixture(dir,router,upstream(io.origin),{preventEviction:true,bindings:{CLAWROUTER_ACCESS_TEAM_DOMAIN:issuer,CLAWROUTER_ACCESS_AUD:'evidence',CLAWROUTER_LOCAL_AUTH:'enabled',CLAWROUTER_ADMIN_TOKEN_SHA256:Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('synthetic-evidence-admin'))).toString('hex')}});
  const until=async(mode,predicate,{seconds=5,terminal=false}={})=>{let state;for(let i=0;i<seconds*100;i++){state=await call('/state');if(state.mode===mode&&predicate(state))return state;if(state.mode===mode&&state.finished&&!terminal)assert.fail('finished before expected witness: '+JSON.stringify(state));await delay(10);}assert.fail(JSON.stringify(state));};
  const start=(mode,extra={})=>call('/start',{mode,token:signed.token,...extra});
  const completed=async mode=>{const state=await until(mode,s=>s.finished,{terminal:true});assert.notEqual(state.failure,true,JSON.stringify(state));return state;};
  await call('/setup');await start('valid');let s=await completed('valid');assert.equal(s.published,true,JSON.stringify(s));assert.deepEqual(s.groups,['manual','retained','revocable']);assert.deepEqual((await call('/user')).groups,s.groups);
  for(const mode of ['unknown','wrong-email','non-github','failure','partial','redirect','utf8','mime','read-error']){
    await start(mode);s=await completed(mode);assert.equal(s.published,true,JSON.stringify(s));assert.deepEqual(s.groups,['manual','retained','revocable']);assert.equal(s.unlocked,true);
    if(['failure','partial','redirect','mime'].includes(mode)){assert.equal(s.reads,0);assert.equal(s.cancels,1);}assert.equal(io.foreignCookies(),0);assert.equal(io.calls.get('/foreign')??0,0);
  }
  await start('empty');s=await completed('empty');assert.deepEqual(s.groups,['manual','retained']);assert.deepEqual((await call('/user')).groups,s.groups);
  for(const mode of ['jwks-metadata','org-exact','team-exact','text','text-multibyte','created','reads8192']){
    await start(mode);s=await completed(mode);assert.equal(s.published,true,JSON.stringify(s));assert.deepEqual(s.groups,['manual','retained','revocable']);assert.equal(s.unlocked,true);
    if(mode==='reads8192'){assert.equal(s.reads,8192);assert.ok(s.nativeReads<8192);}
  }
  // Positive fallback control: configured Access disables local auth, but the
  // real admin bearer still works. Its configuration branch is observable.
  await start('invalid-jwt',{admin:true,token:'a.b.c'});s=await completed('invalid-jwt');
  assert.equal(s.published,true,JSON.stringify(s));assert.equal(s.configReads,2);assert.equal(s.adminReads,1);assert.equal(s.evidence,0);
  for(const mode of ['huge','org-plus','team-plus','text-plus','scalar','members','header-limit','wire-declared','backing','reads8193','cleanup']){
    await start(mode,{admin:true});s=await completed(mode);assert.equal(s.published,false,JSON.stringify(s));assert.equal(s.code,mode==='cleanup'?'access_cleanup':'access_limit');assert.equal(s.configReads,1);assert.equal(s.adminReads,0);assert.equal(s.unlockAttempts,1);assert.equal(s.locked,false);
    if(mode==='huge'){assert.equal(io.calls.get('/identity/huge'),1);assert.ok(s.bytes>0&&s.bytes<=65536+16384,JSON.stringify(s));assert.ok(s.backing<=16384);assert.equal(s.cancels,1);}
    if(mode==='reads8193')assert.equal(s.reads,8192);
  }
  for(const [mode,extra,accepted]of [['cookie-exact',{cookieLength:32768},true],['cookie-plus',{cookieLength:32769},false],['url-exact',{urlLength:16384},true],['url-plus',{urlLength:16385},false]]){
    await start(mode,extra);s=await completed(mode);assert.equal(s.published,accepted,JSON.stringify(s));if(!accepted){assert.equal(s.code,'access_limit');assert.equal(s.evidence,0);assert.equal(s.configReads,1);}
  }
  for(const mode of ['held','cancel-reject','caller10','timeout','timeout-reject']){
    await start(mode);s=await until(mode,s=>s.nativePending===1&&s.nativeReads>=2);assert.equal(s.finished,false);assert.equal(s.published,false);
    if(mode.startsWith('timeout'))s=await until(mode,s=>s.evidenceAborted,{seconds:35});
    else if(mode==='caller10')s=await until(mode,s=>s.aborted,{seconds:12});
    else{io.release('/gate/'+mode+'/abort');s=await until(mode,s=>s.aborted);}
    if(mode!=='timeout'){
      s=await until(mode,s=>s.cancelHeld&&io.arrived.has('/gate/'+mode+'/cancel'));assert.equal(s.cancels,1);assert.equal(s.finished,false);assert.equal(s.unlockAttempts,0);assert.equal(s.locked,true);assert.equal(s.adminReads,0);io.release('/gate/'+mode+'/cancel');
    }
    s=await completed(mode);assert.equal(s.published,mode==='timeout',JSON.stringify(s));assert.equal(s.cancels,1);assert.equal(s.unlockAttempts,1);assert.equal(s.readAtUnlock,true);assert.equal(s.cancelAtUnlock,true);assert.equal(s.locked,false);
    if(mode.endsWith('reject'))assert.equal(s.code,'access_cleanup');else if(mode==='held'||mode==='caller10')assert.equal(s.code,'access_deadline');assert.deepEqual(s.timeouts,mode==='caller10'?[10000,30000,30000]:[30000,30000]);
  }
  await start('late');await until('late',s=>s.fetchHeld);await until('late',s=>s.evidenceAborted,{seconds:35});io.release('/gate/late/fetch');
  s=await until('late',s=>s.cancelHeld&&io.arrived.has('/gate/late/cancel'));assert.equal(s.reads,0);assert.equal(s.finished,false);io.release('/gate/late/cancel');s=await completed('late');assert.equal(s.published,true);assert.equal(s.reads,0);assert.equal(s.cancels,1);assert.equal(s.unlocked,true);
  for(const mode of ['reconcile','reconcile-admin']){
    await start(mode,{admin:mode.endsWith('admin')});await until(mode,s=>s.reconcileHeld&&io.arrived.has('/gate/'+mode+'/reconcile'));io.release('/gate/'+mode+'/abort');
    s=await until(mode,s=>s.aborted);assert.equal(s.finished,false);assert.equal(s.published,false);io.release('/gate/'+mode+'/reconcile');s=await completed(mode);assert.equal(s.code,'access_deadline');assert.equal(s.published,false);assert.equal(s.configReads,1);assert.equal(s.adminReads,0);
  }
  // Last only: injected unknown unlock deliberately retains the facade forever.
  // Runtime disposal is test teardown, never proof of production retirement.
  await start('unknown-lock');await until('unknown-lock',s=>s.nativePending===1&&s.nativeReads>=2);io.release('/gate/unknown-lock/abort');await until('unknown-lock',s=>s.cancelHeld&&io.arrived.has('/gate/unknown-lock/cancel'));io.release('/gate/unknown-lock/cancel');
  s=await until('unknown-lock',s=>s.unlockAttempts===1);assert.equal(s.finished,false);assert.equal(s.published,false);assert.equal(s.locked,true);assert.equal(s.readAtUnlock,true);assert.equal(s.cancelAtUnlock,true);unknownVerified=true;
});
