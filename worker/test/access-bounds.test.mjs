import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { accessBytesResponse, accessCertsResponse } from './access-byte-fixture.mjs';
const { verifiedAccessSession, authorizeAdmin } = await import('../access.ts');
const { accessJwtParts, accessBase64Size, parseAccessJson } = await import('../access-json.ts');
const { sha256Hex } = await import('../utils.ts');
const team = 'bounded-access.cloudflareaccess.com', url = `https://${team}/cdn-cgi/access/certs`, email = 'access@example.invalid';
const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign','verify']);
const key = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'first' };
async function jwt(changes = {}, header = {}, raw) {
  const payload = { iss: `https://${team}`, aud: 'bounded', email, sub: 'subject', exp: Math.floor(Date.now()/1000)+300, ...changes };
  const signed = encode({ alg: 'RS256', kid: 'first', ...header }) + '.' + encode(raw ?? payload);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signed));
  return signed + '.' + Buffer.from(signature).toString('base64url');
}
function env() { return {
  CLAWROUTER_ACCESS_TEAM_DOMAIN: team, CLAWROUTER_ACCESS_AUD: 'bounded',
  POLICY_KV: { list: async () => ({ keys: [], list_complete: true }) },
  ACCESS_CONTROL: { idFromName: n => n, get: () => ({ fetch: async input => {
    assert.equal(new URL(input).pathname, '/users/resolve');
    return Response.json({ initialized: true, missingEmails: [], users: [{ email, record: { enabled: true, role: 'user', groups: [],
      assignmentState: { version: 1, revision: '[]', assignments: {}, updatedAt: null } } }] });
  } }) },
}; }
const request = (token, signal, headers = {}) => new Request('https://router.example/v1/session', { signal, headers: { 'cf-access-jwt-assertion': token, ...headers } });
const session = (token, signal) => verifiedAccessSession(request(token, signal), env());
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Limits are operational rejection boundaries, not allocations measured by these tests.
test('Access assertion and JSON guard exact boundaries count discarded/duplicate occurrences before parse', () => {
  assert.ok(accessJwtParts('a.b.'+'x'.repeat(16380)));
  assert.throws(() => accessJwtParts('a.b.'+'x'.repeat(16381)), { code: 'access_limit' });
  assert.throws(() => accessJwtParts('a.b.é'), { code: 'access_limit' });
  assert.equal(accessJwtParts('a.b.c.d'), null);
  assert.equal(accessBase64Size('a'.repeat(2731), 2048), 2048);
  assert.throws(() => accessBase64Size('a'.repeat(2732), 2048), { code: 'access_limit' });
  assert.deepEqual(parseAccessJson('{"keys":[]}'+' '.repeat(262133), 'jwks'), { keys: [] });
  assert.throws(() => parseAccessJson('{"keys":[]}'+' '.repeat(262134), 'jwks'), { code: 'access_limit' });
  assert.equal(parseAccessJson('{"kid":"old","kid":"new"}', 'header').kid, 'new');
  assert.throws(() => parseAccessJson('{'+Array(33).fill('"kid":"a"').join(',')+'}', 'header'), { code: 'access_limit' });
  assert.equal(parseAccessJson('{"keys":['+Array(32).fill('{}').join(',')+']}', 'jwks').keys.length, 32);
  assert.throws(() => parseAccessJson('{"keys":['+Array(33).fill('{}').join(',')+']}', 'jwks'), { code: 'access_limit' });
  assert.throws(() => parseAccessJson('{"keys":['+Array(20).fill('{}').join(',')+'],"keys":['+Array(13).fill('{}').join(',')+']}', 'jwks'), { code: 'access_limit' });
  const row = '{"n":"'+'x'.repeat(4000)+'","extra":"'+'y'.repeat(4000)+'"}';
  assert.ok(parseAccessJson('{"keys":['+row+' '.repeat(8192-row.length)+']}', 'jwks'));
  // Whitespace outside the complete row is not part of its source span.
  assert.throws(() => parseAccessJson('{"keys":['+row.slice(0,-1)+',"z":"'+'q'.repeat(200)+'"}]}', 'jwks'), { code: 'access_limit' });
  assert.throws(() => parseAccessJson('{"keys":[{"'+ 'k'.repeat(65)+'":0}]}','jwks'), { code:'access_limit' });
  assert.throws(() => parseAccessJson('{"exp":'+ '1'.repeat(65)+'}', 'payload'), {code:'access_limit'});
  assert.throws(() => parseAccessJson('{"aud":['+Array(33).fill('"a"').join(',')+']}', 'payload'), {code:'access_limit'});
});

test('present oversized assertion cannot fall back with missing Access config and valid local/admin credentials', async t => {
  const token = 'synthetic-local-admin', hash = await sha256Hex(token);
  let localReads = 0;
  const fallback = { CLAWROUTER_LOCAL_AUTH: 'enabled', CLAWROUTER_ADMIN_TOKEN_SHA256: hash, POLICY_KV: { get: async () => { localReads++; return { email, role:'admin', expiresAtMs: Date.now()+10000 }; } } };
  for (const assertion of ['a'.repeat(16385), encode('x'.repeat(2049))+'.e30.c2ln']) {
    const req = request(assertion, undefined, { authorization: 'Bearer '+token, cookie: 'clawrouter_session='+ 'a'.repeat(64) });
    await assert.rejects(verifiedAccessSession(req, fallback), {code:'access_limit'});
    await assert.rejects(authorizeAdmin(req, fallback), {code:'access_limit'});
  }
  assert.equal(localReads,0);
  assert.equal((await authorizeAdmin(new Request('https://router.example', {headers:{authorization:'Bearer '+token}}), {CLAWROUTER_ADMIN_TOKEN_SHA256:hash})).auth,'admin_token');
});

test('public Access verifies original encoded segments and complete first matching JWK without retry', async t => {
  let keys = [{...key, kid:'ignored'}, key], imports = 0;
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'importKey', (...args) => { imports++; return original(...args); });
  t.mock.method(globalThis,'fetch', async () => accessCertsResponse({keys},url));
  assert.equal((await session(await jwt())).email,email);
  // Duplicate JSON members retain the parsed last-wins semantics but the actual
  // original header/payload encoding is signed, not a canonical reconstruction.
  const raw = '{"iss":"https://'+team+'","aud":"wrong","aud":"bounded","email":"'+email+'","exp":'+(Math.floor(Date.now()/1000)+300)+'}';
  assert.equal((await session(await jwt({}, {}, raw))).email,email);
  for (const bad of [{key_ops:['sign']},{alg:'RSA-OAEP'},{n:'bad'}]) {
    keys = [{...key,...bad},key]; const before=imports;
    assert.equal(await session(await jwt()),null); assert.equal(imports,before+1);
  }
  keys=[{...key,kid:'wrong'}]; assert.equal(await session(await jwt()),null);
  keys=[key];
  for (const claims of [{iss:'https://foreign.example'},{aud:'wrong'},{exp:0},{exp:'9999999999'},{nbf:'0'},{iat:{}},{email:{}},{sub:[]}]) assert.equal(await session(await jwt(claims)),null);
  assert.equal(await session(await jwt({}, {alg:'HS256'})),null);
  const valid=await jwt();assert.equal(await session(valid.slice(0,valid.lastIndexOf('.')+1)+'AAAA'),null);
});

test('JWKS limits include ignored rows, metadata and cache-returned responses before import', async t => {
  let value, imports=0, calls=0;
  t.mock.method(crypto.subtle,'importKey', () => { imports++; throw Error('must not import'); });
  t.mock.method(globalThis,'fetch', async (_url,init) => { calls++;assert.equal(init.redirect,'manual');assert.deepEqual(init.cf,{cacheTtl:300,cacheEverything:true});return accessBytesResponse(value,url); });
  const token=await jwt();
  for (value of [JSON.stringify({keys:[key], ignored:'x'.repeat(33*1024*1024)}), JSON.stringify({keys:[key,...Array(32).fill({})]}), JSON.stringify({keys:[key,{kty:'RSA',n:'A'.repeat(1368),e:'AQAB'}]}), JSON.stringify({keys:[key,{kty:'RSA',n:'AQAB',e:'A'.repeat(12)}]})]) {
    await assert.rejects(session(token), {code:'access_limit'});
  }
  assert.equal(imports,0);assert.equal(calls,4);
});

test('expiry is checked again after actual verification settlement', async t => {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const token=await jwt({exp:Math.floor(now/1000)+1}), entered=deferred(), release=deferred();
  const verify=crypto.subtle.verify.bind(crypto.subtle);
  t.mock.method(globalThis,'fetch', async()=>accessCertsResponse({keys:[key]},url));
  t.mock.method(crypto.subtle,'verify', async(...args)=>{const valid=await verify(...args);entered.resolve();await release.promise;return valid;});
  const work=session(token);try{await entered.promise;now+=2000;release.resolve();assert.equal(await work,null);}finally{release.resolve();await work.catch(()=>{});}
});

for(const stage of ['import','verify']) test(`deadline stops work but joins held actual ${stage}`, async t=>{
  const entered=deferred(),release=deferred(),abort=new AbortController();let completed=false;
  t.mock.method(globalThis,'fetch',async()=>accessCertsResponse({keys:[key]},url));
  const method=stage==='import'?'importKey':'verify', original=crypto.subtle[method].bind(crypto.subtle);
  t.mock.method(crypto.subtle,method,async(...args)=>{entered.resolve();await release.promise;return original(...args);});
  const work=session(await jwt(),abort.signal).then(value=>{completed=true;return value;},error=>{completed=true;throw error;});void work.catch(()=>{});
  try{await entered.promise;abort.abort({cleanupFailed:true,cause:'caller-owned'});await tick();assert.equal(completed,false);release.resolve();await assert.rejects(work,{code:'access_deadline'});}
  finally{release.resolve();await work.catch(()=>{});}
});

for(const mode of ['read','cancel-reject','late','unlock']) test(`original ${mode} physical ownership remains joined`,async t=>{
  const response=accessCertsResponse({keys:[key]},url), entered=deferred(),readGate=deferred(),cancelGate=deferred(),fetchGate=deferred();
  const abort=new AbortController();let reads=0,cancels=0,unlocks=0,finished=false,releaseReader;
  const get=response.body.getReader.bind(response.body);
  response.body.getReader=options=>{const reader=get(options);releaseReader=()=>reader.releaseLock();return{
    async read(view){reads++;const result=await reader.read(view);entered.resolve();await readGate.promise;return result;},
    cancel(reason){cancels++;return reader.cancel(reason).then(async()=>{await cancelGate.promise;if(mode==='cancel-reject')throw {cause:new Array(1000).fill('synthetic')};});},
    releaseLock(){unlocks++;if(mode==='unlock')throw Error('fixture remains locked');reader.releaseLock();},
  };};
  t.mock.method(globalThis,'fetch',async()=>{if(mode==='late'){entered.resolve();await fetchGate.promise;}return response;});
  const work=session(await jwt(),abort.signal).then(value=>{finished=true;return value;},error=>{finished=true;throw error;});void work.catch(()=>{});
  try{
    await entered.promise;abort.abort();fetchGate.resolve();await tick();assert.equal(cancels,1);assert.equal(finished,false);assert.equal(response.body.locked,true);
    cancelGate.resolve();await tick();if(mode!=='late')assert.equal(finished,false);readGate.resolve();await tick();
    if(mode==='unlock'){assert.equal(unlocks,1);assert.equal(response.body.locked,true);assert.equal(finished,false);releaseReader(); /* The unknown root stays retained; no reclassification. */}
    else{await assert.rejects(work,error=>['access_deadline','access_cleanup'].includes(error.code));assert.equal(response.body.locked,false);assert.equal(unlocks,1);}
    if(mode==='late')assert.equal(reads,0);
  }finally{readGate.resolve();cancelGate.resolve();fetchGate.resolve();if(mode!=='unlock')await work.catch(()=>{});}
});

test('non-BYOB body is cancellation-only; status/header failures own bodies first',async t=>{
  const token=await jwt();let source,reads=0,cancels=0;
  t.mock.method(globalThis,'fetch',async()=>source);
  source=new Response(new ReadableStream({pull(){reads++;},cancel(){cancels++;}},{highWaterMark:0}),{headers:{'content-type':'application/json'}});Object.defineProperty(source,'url',{value:url});
  await assert.rejects(session(token),{code:'access_transport'});assert.equal(reads,0);assert.equal(cancels,1);assert.equal(source.body.locked,false);
  for(const headers of [{'content-type':'text/event-stream'},{'content-type':'application/json','content-encoding':'gzip'},{'content-type':'application/json','content-length':'262145'},{'content-type':'application/json','content-range':'bytes 0-1/2'}]){
    source=accessBytesResponse('{}',url,{headers});await assert.rejects(session(token));assert.equal(source.body.locked,false);
  }
});

test('valid JSON/JWT cannot authenticate after rejected cleanup even when physically unlocked',async t=>{
 const response=accessCertsResponse({keys:[key]},url),get=response.body.getReader.bind(response.body);let imports=0,unlocks=0;
 response.body.getReader=options=>{const reader=get(options);return{read:v=>reader.read(v),cancel:r=>reader.cancel(r),releaseLock(){reader.releaseLock();unlocks++;throw Error('synthetic post-unlock cleanup failure');}};};
 t.mock.method(globalThis,'fetch',async()=>response);t.mock.method(crypto.subtle,'importKey',()=>{imports++;throw Error('must not import');});
 await assert.rejects(session(await jwt()),{code:'access_cleanup'});assert.equal(response.body.locked,false);assert.equal(unlocks,1);assert.equal(imports,0);
});

for(const maximum of [8192,8193])test(`owned read budget includes empty and EOF calls: ${maximum}`,async t=>{
 const response=accessCertsResponse({keys:[key]},url),get=response.body.getReader.bind(response.body);let calls=0,nativeEof=false,cancels=0;
 response.body.getReader=options=>{const reader=get(options);return{async read(view){calls++;
  if(nativeEof)return{done:calls>=maximum,value:new Uint8Array(view.buffer,0,0)};
  const part=await reader.read(view);if(part.done){nativeEof=true;return{done:false,value:new Uint8Array(new ArrayBuffer(16384),0,0)};}return part;
 },cancel(r){cancels++;return reader.cancel(r);},releaseLock(){reader.releaseLock();}};};
 t.mock.method(globalThis,'fetch',async()=>response);
 if(maximum===8192)assert.equal((await session(await jwt())).email,email);else await assert.rejects(session(await jwt()),{code:'access_limit'});
 assert.equal(calls,8192);assert.equal(cancels,maximum===8192?0:1);assert.equal(nativeEof,true);assert.equal(response.body.locked,false);
});

test('preparse guards enforce depth, aggregate strings, scalars and every resource occurrence',()=>{
 for(const [profile,depth]of [['header',4],['payload',8],['jwks',8]]){
  assert.ok(parseAccessJson('['.repeat(depth)+'0'+']'.repeat(depth),profile));
  assert.throws(()=>parseAccessJson('['.repeat(depth+1)+'0'+']'.repeat(depth+1),profile),{code:'access_limit'});
 }
 for(const [profile,max]of [['header',16],['payload',128],['jwks',1024]]){
  assert.equal(parseAccessJson('['+Array(max).fill(0).join(',')+']',profile).length,max);
  assert.throws(()=>parseAccessJson('['+Array(max+1).fill(0).join(',')+']',profile),{code:'access_limit'});
 }
 const row='{"kid":"ignored","one":"'+'a'.repeat(4000)+'","two":"'+'b'.repeat(4000)+'"';
 assert.ok(parseAccessJson('{"keys":['+row+' '.repeat(8191-row.length)+'}]}','jwks'));
 assert.throws(()=>parseAccessJson('{"keys":['+row+' '.repeat(8192-row.length)+'}]}','jwks'),{code:'access_limit'});
 assert.throws(()=>parseAccessJson('{"extra":"'+'a'.repeat(4097)+'"}','jwks'),{code:'access_limit'});
 assert.throws(()=>parseAccessJson('{"extra":['+Array(17).fill('"'+'a'.repeat(4096)+'"').join(',')+']}','jwks'),{code:'access_limit'});
 assert.throws(()=>parseAccessJson('{"kid":"'+'a'.repeat(257)+'"}','header'),{code:'access_limit'});
 for(const [key,max]of [['iss',1024],['sub',1024],['aud',1024],['email',320]])assert.throws(()=>parseAccessJson('{"'+key+'":"'+'a'.repeat(max+1)+'"}','payload'),{code:'access_limit'});
});

test('exact decoded JWT header/payload boundaries are preflighted before missing-config fallback',async()=>{
 for(const [index,max]of [[0,2048],[1,8192],[2,1024]]){
  const parts=['e30','e30','c2ln'];parts[index]=Buffer.alloc(max,32).toString('base64url');
  assert.equal(await verifiedAccessSession(request(parts.join('.')),{}),null);
  parts[index]=Buffer.alloc(max+1,32).toString('base64url');
  await assert.rejects(verifiedAccessSession(request(parts.join('.')),{}),{code:'access_limit'});
 }
});
