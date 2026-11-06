import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { accessBytesResponse, accessCertsResponse } from './access-byte-fixture.mjs';
import { createGrantAuthority } from './grant-authority-fixture.mjs';
const { verifiedAccessSession, authorizeAdmin } = await import('../access.ts');
const { parseAccessJson } = await import('../access-json.ts');
const { authorityCall } = await import('../authority.ts');
const { sha256Hex } = await import('../utils.ts');
const issuer='https://evidence.cloudflareaccess.com',certs=issuer+'/cdn-cgi/access/certs';
const email='evidence@example.invalid',identityUrl='https://router.example/cdn-cgi/access/get-identity';
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'evidence'};
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function token(){const value=encode({alg:'RS256',kid:jwk.kid})+'.'+encode({iss:issuer,aud:'evidence',email,exp:Math.floor(Date.now()/1000)+600});return value+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(value))).toString('base64url');}
const valid=()=>({email,idp:{type:'github'},orgs:[{id:'1',name:'example'}],teams:[{org_id:'1',name:'maintainers'}]});
async function arrival(entry,work){let timer;try{await Promise.race([entry,work.then(()=>{throw Error('operation completed before barrier');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('barrier did not arrive')),2000);})]);}finally{clearTimeout(timer);}}
const drainExpected=async work=>{await work?.catch(error=>{if(!['access_deadline','access_cleanup'].includes(error?.code))throw error;});};
async function setup(t){
  const rules=new Map(['org','team'].map((id,i)=>['access/assignment-rules/'+id,{version:1,enabled:true,kind:i?'github_team':'github_org',subject:i?'example/maintainers':'example',groups:[i?'retained':'revocable'],policyIds:[],priority:i,revokeOnLoss:!i,provenance:'cloudflare_access'}]));
  const f={identityCalls:0,configReads:0,adminReads:0,value:valid(),user:null};
  const env={CLAWROUTER_ACCESS_AUD:'evidence',POLICY_KV:{list:async()=>({keys:[...rules.keys()].map(name=>({name})),list_complete:true}),get:async key=>rules.get(key)??null}};
  Object.defineProperty(env,'CLAWROUTER_ACCESS_TEAM_DOMAIN',{get(){f.configReads++;return issuer;}});
  Object.defineProperty(env,'CLAWROUTER_ADMIN_TOKEN_SHA256',{get(){f.adminReads++;return '0'.repeat(64);}});
  const authority=createGrantAuthority(undefined,env);env.ACCESS_CONTROL={idFromName:n=>n,get:()=>({fetch:(url,init)=>authority.fetch(url,init)})};
  await authorityCall(env,'/users/put',{email,record:{enabled:true,role:'user',groups:['manual'],tenantId:'fixture'}});
  f.env=env;f.current=async()=>(await authorityCall(env,'/users/resolve',{emails:[email]})).users[0].record;
  f.assertion=await token();f.request=(signal,cookie='CF_Authorization=synthetic',url='https://router.example/v1/session')=>new Request(url,{signal,headers:{'cf-access-jwt-assertion':f.assertion,cookie,authorization:'Bearer synthetic-admin'}});
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(String(url)===certs)return accessCertsResponse({keys:[jwk]},certs);
    f.identityCalls++;assert.equal(String(url),identityUrl);assert.equal(init.redirect,'manual');assert.equal(init.cf,undefined);
    return f.respond?f.respond(init):accessBytesResponse(typeof f.value==='string'?f.value:JSON.stringify(f.value),identityUrl);
  });
  return f;
}

test('evidence dedicated scalar/row guards count discarded occurrences without JWKS restrictions',()=>{
  const text=JSON.stringify({...valid(),metadata:{keys:Array(33).fill({kid:'k'.repeat(257),e:'e'.repeat(16)})}});
  assert.deepEqual(parseAccessJson(text,'evidence'),JSON.parse(text));
  for(const [field,max]of [['orgs',128],['teams',256]]){
    const accepted='{"'+field+'":['+Array(max).fill('0').join(',')+']}';
    assert.equal(parseAccessJson(accepted,'evidence')[field].length,max);
    assert.throws(()=>parseAccessJson(accepted.slice(0,-1)+',"'+field+'":[0]}','evidence'),{code:'access_limit'});
  }
  for(const [key,max]of [['metadata',1024],['email',320]]){
    assert.equal(parseAccessJson(JSON.stringify({[key]:'x'.repeat(max)}),'evidence')[key].length,max);
    assert.throws(()=>parseAccessJson(JSON.stringify({[key]:'x'.repeat(max+1)}),'evidence'),{code:'access_limit'});
  }
  assert.ok(parseAccessJson('{"'+'x'.repeat(64)+'":0}','evidence'));
  assert.throws(()=>parseAccessJson('{"'+'x'.repeat(65)+'":0}','evidence'),{code:'access_limit'});
  assert.ok(parseAccessJson('{}'+' '.repeat(65534),'evidence'));
  assert.throws(()=>parseAccessJson('{}'+' '.repeat(65535),'evidence'),{code:'access_limit'});
  assert.throws(()=>parseAccessJson('{'+Array(2049).fill('"x":0').join(',')+'}','evidence'),{code:'access_limit'});
  for(const [accepted,rejected]of [
    ['['.repeat(8)+'0'+']'.repeat(8),'['.repeat(9)+'0'+']'.repeat(9)],
    ['['+Array(255).fill('{}').join(',')+']','['+Array(256).fill('{}').join(',')+']'],
    ['['+Array(1024).fill('0').join(',')+']','['+Array(1025).fill('0').join(',')+']'],
    ['{'+Array(2048).fill('"x":0').join(',')+'}','{'+Array(2049).fill('"x":0').join(',')+'}'],
    ['1'.repeat(64),'1'.repeat(65)],
  ]){assert.doesNotThrow(()=>parseAccessJson(accepted,'evidence'));assert.throws(()=>parseAccessJson(rejected,'evidence'),{code:'access_limit'});}
});

test('matching evidence persists; UNKNOWN retains; valid empty revokes only revocable assignments',async t=>{
  const f=await setup(t);assert.deepEqual((await verifiedAccessSession(f.request(),f.env)).groups,['manual','retained','revocable']);
  assert.deepEqual((await f.current()).groups,['manual','retained','revocable']);
  for(const value of ['{', {...valid(),email:'wrong@example.invalid'}, {...valid(),idp:{type:'other'}}, {...valid(),orgs:[null]}]){
    f.value=value;assert.deepEqual((await verifiedAccessSession(f.request(),f.env)).groups,['manual','retained','revocable']);
  }
  f.value={email,idp:{type:'github'},orgs:[],teams:[]};
  assert.deepEqual((await verifiedAccessSession(f.request(),f.env)).groups,['manual','retained']);
  assert.deepEqual((await f.current()).groups,['manual','retained']);
});

test('public entry enforces text, headers and original cookie/URL bounds with no fallback',async t=>{
  const f=await setup(t);const base=JSON.stringify(valid());
  f.value=base+' '.repeat(65536-base.length);assert.equal((await verifiedAccessSession(f.request(),f.env)).email,email);
  for(const body of [f.value+' ',JSON.stringify({...valid(),ignored:'x'.repeat(1025)}),'{'+Array(2049).fill('"x":0').join(',')+'}']){
    f.value=body;f.configReads=0;await assert.rejects(authorizeAdmin(f.request(),f.env),{code:'access_limit'});assert.equal(f.configReads,1);assert.equal(f.adminReads,0);
  }
  f.value=valid();await verifiedAccessSession(f.request(undefined,'x'.repeat(32768)),f.env);
  const url='https://router.example/v1/session?padding=';
  await verifiedAccessSession(f.request(undefined,undefined,url+'x'.repeat(16384-url.length)),f.env);
  for(const request of [f.request(undefined,'x'.repeat(32769)),f.request(undefined,undefined,url+'x'.repeat(16385-url.length))]){
    const before=f.identityCalls;await assert.rejects(verifiedAccessSession(request,f.env),{code:'access_limit'});assert.equal(f.identityCalls,before,'zero evidence fetch before outbound preparation');
  }
  f.respond=()=>accessBytesResponse(base,identityUrl,{headers:{'content-type':'application/json','x-padding':'x'.repeat(4096)}});
  await assert.rejects(verifiedAccessSession(f.request(),f.env),{code:'access_limit'});
  for(const count of [32,33]){
    const headers={'content-type':'application/json',...Object.fromEntries(Array.from({length:count-1},(_,i)=>['x-'+i,'x']))};
    f.respond=()=>accessBytesResponse(base,identityUrl,{headers});
    if(count===32)assert.equal((await verifiedAccessSession(f.request(),f.env)).email,email);
    else await assert.rejects(verifiedAccessSession(f.request(),f.env),{code:'access_limit'});
  }
  for(const bytes of [4096,4097]){
    const fixed='content-type'.length+'application/json'.length+'x-padding'.length;
    f.respond=()=>accessBytesResponse(base,identityUrl,{headers:{'content-type':'application/json','x-padding':'x'.repeat(bytes-fixed)}});
    if(bytes===4096)assert.equal((await verifiedAccessSession(f.request(),f.env)).email,email);
    else await assert.rejects(verifiedAccessSession(f.request(),f.env),{code:'access_limit'});
  }
});

test('non-success, partial, redirect and unusable media are UNKNOWN only after actual disposal',async t=>{
  const f=await setup(t);await verifiedAccessSession(f.request(),f.env);
  for(const status of [302,401,403,500,206]){
    let cancels=0,unlocks=0;const response=accessBytesResponse('ignored',identityUrl,{status}),get=response.body.getReader.bind(response.body);
    response.body.getReader=options=>{const reader=get(options);return{read:()=>{throw Error('must not read');},cancel:r=>{cancels++;return reader.cancel(r);},releaseLock:()=>{unlocks++;reader.releaseLock();}};};
    f.respond=()=>response;assert.deepEqual((await verifiedAccessSession(f.request(),f.env)).groups,['manual','retained','revocable']);
    assert.equal(cancels,1);assert.equal(unlocks,1);assert.equal(response.body.locked,false);
  }
});

test('non-BYOB evidence is cancellation-only, with no default-reader read',async t=>{
  const f=await setup(t);let cancels=0,reads=0,unlocks=0;
  const response=Response.json(valid());Object.defineProperty(response,'url',{value:identityUrl});
  const get=response.body.getReader.bind(response.body);
  response.body.getReader=options=>{const reader=get(options);return{read(){reads++;throw Error('default read forbidden');},cancel:r=>{cancels++;return reader.cancel(r);},releaseLock:()=>{unlocks++;reader.releaseLock();}};};
  f.respond=()=>response;assert.equal((await verifiedAccessSession(f.request(),f.env)).email,email);
  assert.equal(reads,0);assert.equal(cancels,1);assert.equal(unlocks,1);assert.equal(response.body.locked,false);
});

test('transport exception properties cannot forge an operational denial',async t=>{
  const f=await setup(t);f.respond=()=>{throw{code:'access_limit',cleanupFailed:true,cause:['caller-owned']};};
  assert.equal((await verifiedAccessSession(f.request(),f.env)).email,email);
});

for(const rejected of [false,true])test(`evidence timeout joins FIRST cancellation; rejection terminal=${rejected}`,async t=>{
  const f=await setup(t),entered=Promise.withResolvers(),release=Promise.withResolvers(),nativeTimeout=AbortSignal.timeout.bind(AbortSignal);
  let timeouts=0,cancels=0,unlocks=0,finished=false;
  t.mock.method(AbortSignal,'timeout',ms=>{assert.equal(ms,30000);return nativeTimeout(++timeouts===1?5000:20);});
  const response=accessBytesResponse(JSON.stringify(valid()),identityUrl),get=response.body.getReader.bind(response.body);
  response.body.getReader=options=>{const reader=get(options);return{read:()=>new Promise(()=>{}),cancel:async reason=>{cancels++;await reader.cancel(reason);entered.resolve();await release.promise;if(rejected)throw {cause:['untrusted']};},releaseLock:()=>{unlocks++;reader.releaseLock();}};};
  // Resolve the controlled original read on cancellation, independently of the
  // held FIRST cleanup. This is wrapper evidence, not a native pending read.
  const read=Promise.withResolvers(),wrapped=response.body.getReader;
  response.body.getReader=options=>{const reader=wrapped(options);return{...reader,read:()=>read.promise,cancel:reason=>{read.resolve({done:true,value:new Uint8Array()});return reader.cancel(reason);}};};
  f.respond=()=>response;
  let work;t.after(async()=>{release.resolve();read.resolve({done:true,value:new Uint8Array()});await drainExpected(work);});
  work=verifiedAccessSession(f.request(),f.env).finally(()=>{finished=true;});void work.catch(()=>{});
  await arrival(entered.promise,work);assert.equal(finished,false);assert.equal(response.body.locked,true);assert.equal(unlocks,0);release.resolve();
  if(rejected)await assert.rejects(work,{code:'access_cleanup'});else assert.equal((await work).email,email);
  assert.equal(cancels,1);assert.equal(unlocks,1);assert.equal(response.body.locked,false);
});

test('caller abort during completed SQL reconciliation denies session and admin publication',async t=>{
  const f=await setup(t);
  for(const admin of [false,true]){
    const entered=Promise.withResolvers(),release=Promise.withResolvers(),abort=new AbortController(),get=f.env.ACCESS_CONTROL.get;
    f.env.ACCESS_CONTROL.get=id=>{const stub=get(id);return{async fetch(url,init){const response=await stub.fetch(url,init);if(new URL(url).pathname==='/users/reconcile-assignments'){entered.resolve();await release.promise;}return response;}};};
    const start=admin?authorizeAdmin:verifiedAccessSession;let work;
    t.after(async()=>{release.resolve();await drainExpected(work);});
    work=start(f.request(abort.signal),f.env);void work.catch(()=>{});
    await arrival(entered.promise,work);abort.abort({cleanupFailed:true});release.resolve();await assert.rejects(work,{code:'access_deadline'});
    assert.equal(f.adminReads,0);f.env.ACCESS_CONTROL.get=get;
  }
});

test('local and admin fallback publication rechecks the original caller after awaited work',async t=>{
  for(const admin of [false,true]){
    const entered=Promise.withResolvers(),release=Promise.withResolvers(),abort=new AbortController();let work;
    t.after(async()=>{release.resolve();await drainExpected(work);});
    const env={CLAWROUTER_LOCAL_AUTH:admin?'disabled':'enabled',CLAWROUTER_ADMIN_TOKEN_SHA256:await sha256Hex('synthetic-admin'),
      POLICY_KV:{async get(){entered.resolve();await release.promise;return{email,expiresAtMs:Date.now()+60000};}},
      ACCESS_CONTROL:{idFromName:n=>n,get:()=>({fetch:async()=>Response.json({initialized:true,missingEmails:[],users:[{email,record:{enabled:true,role:'admin'}}]})})}};
    const original=crypto.subtle.digest.bind(crypto.subtle);
    if(admin)t.mock.method(crypto.subtle,'digest',async(...args)=>{const result=await original(...args);entered.resolve();await release.promise;return result;});
    const request=new Request('https://router.example/v1/session',{signal:abort.signal,headers:{cookie:'clawrouter_session='+'a'.repeat(64),authorization:'Bearer synthetic-admin'}});
    work=(admin?authorizeAdmin:verifiedAccessSession)(request,env);void work.catch(()=>{});
    await arrival(entered.promise,work);abort.abort();release.resolve();await assert.rejects(work,{code:'access_deadline'});
    if(admin)t.mock.restoreAll();
  }
});
