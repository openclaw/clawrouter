import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const router = String.raw`
import worker from './worker/index.ts';
import {PolicyBindingIndexObject as Base} from './worker/authority.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {authorityCall,resolveUsers} from './worker/authority.ts';
import {evaluateUserAssignments} from './worker/assignment-evaluator.ts';
import {sha256Hex} from './worker/utils.ts';
// LABELLED fixture-only raw SQL seed/inspection; real production query handlers.
export class PolicyBindingIndexObject extends Base {
 constructor(ctx,env){super(ctx,env);this.fixtureSql=ctx.storage.sql;}
 async fetch(request){
  if(new URL(request.url).pathname!=='/fixture/sql')return super.fetch(request);
  const {query,args=[]}=await request.json();
  return Response.json([...this.fixtureSql.exec(query,...args)]);
 }
}
const raw=globalThis.fetch.bind(globalThis),email='reader@example.invalid',states=new Map();
const gate=(id,part)=>raw('https://user-reply-fixture.example/gate/'+id+'/'+part).then(async r=>{if(!r.ok)throw Error('fixture gate failed');await r.text();});
function environment(env,id,a,kind,mode,signal){
 const stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('user-reply-'+id)),prefix='user-reply/'+id+'/';
 const original=(path,body)=>stub.fetch('https://clawrouter.internal'+path,{method:'POST',body:JSON.stringify(body)});
 const sql=(query,args=[])=>original('/fixture/sql',{query,args}).then(r=>r.json());
 const result={...env,CLAWROUTER_LOCAL_AUTH:'enabled',CLAWROUTER_LOCAL_ADMIN_EMAIL:email,
  CLAWROUTER_ADMIN_TOKEN_SHA256:env.FIXTURE_ADMIN_HASH,
  ...(kind==='access'||kind==='admin'?{CLAWROUTER_ACCESS_TEAM_DOMAIN:'user-reply.cloudflareaccess.com',CLAWROUTER_ACCESS_AUD:'reader'}:{}),
  POLICY_KV:{
   get(key,type){if(key.startsWith('local/sessions/'))a.localReads++;return env.POLICY_KV.get(prefix+key,type);},
   put(key,value,options){if(key.startsWith('local/sessions/'))a.sessions++;return env.POLICY_KV.put(prefix+key,value,options);},
   async list(options){const value=await env.POLICY_KV.list({...options,prefix:prefix+(options?.prefix??'')});
    return {...value,keys:value.keys.map(k=>({...k,name:k.name.slice(prefix.length)}))};},
  },
  ACCESS_CONTROL:{idFromName:name=>name,get:()=>({async fetch(url,init){
   const path=new URL(url).pathname;
   if(path==='/users/create')a.creates++;
   if(path==='/users/reconcile-assignments')a.reconciles++;
   if(path==='/users/initialize')a.initializes++;
   if(path!=='/users/resolve')return stub.fetch(url,init);
   a.queries++;
   if(mode==='throw')throw {cause:'private transport sentinel'};
   let response;
   if(['healthy','mixed','missing','disabled','late','pre-abort','final-abort','cleanup','reads','reads-over','backing'].includes(mode))response=await stub.fetch(url,init);
   else if(mode==='default')response=new Response(new ReadableStream({}));
   else response=await raw('https://user-reply-fixture.example/fault/'+mode);
   response=observe(response,a,mode,signal);
   if(mode==='late'){a.lateHeld=true;await gate(id,'late');}
   return response;
  }})}
 };
 return {env:result,original,sql};
}
function observe(response,a,mode,signal){
 const body=response.body;if(!body)return response;
 a.sameBody=response.body===body;a.emptyUrl=response.url==='';a.locked=body.locked;
 const get=body.getReader.bind(body);
 body.getReader=options=>{
  const r=get(options),read=r.read.bind(r),cancel=r.cancel.bind(r),unlock=r.releaseLock.bind(r);
  a.byob=options?.mode==='byob';a.locked=body.locked;let first,padding=false;
  r.read=(...args)=>{
   a.reads++;a.pending++;
   if(['read','read-reject'].includes(mode)&&a.bytes>0)a.nativePending=true;
   let actual;try{actual=padding?Promise.resolve({done:false,value:args[0].subarray(0,0)}):read(...args);}catch(error){a.pending--;throw error;}
   return actual.then(part=>{
    a.pending--;a.settled++;a.nativePending=false;
    if(part.value){a.bytes+=part.value.byteLength;a.maxBacking=Math.max(a.maxBacking,part.value.buffer.byteLength);}
    if(part.done)a.eof=true;
    // Controlled OWNED empty calls only after the actual native EOF settles.
    if(['reads','reads-over'].includes(mode)&&a.eof){padding=true;part={done:a.reads===(mode==='reads'?8192:8193),value:part.value??new Uint8Array(16384).subarray(0,0)};}
    if(mode==='backing')part={done:false,value:new Uint8Array(new ArrayBuffer(16385),0,1)};
    return part;
   },error=>{a.pending--;a.settled++;a.nativePending=false;throw error;});
  };
  r.cancel=(...args)=>{
   if(!first){a.cancels++;first=(async()=>{
    await cancel(...args);a.actualCancel=true;
    if(mode==='read-reject'){a.cancelHeld=true;await gate(a.id,'cleanup');a.cancelHeld=false;a.cancelRejected=true;throw Error('deliberate cleanup rejection');}
   })();}
   return first;
  };
  r.releaseLock=()=>{
   a.unlockAttempts++;a.unlockAfterRoots=a.pending===0&&!a.cancelHeld;
   if(mode==='unknown-lock'){a.unknownLock=true;throw Error('injected unknown unlock');}
   unlock();a.unlocks++;a.locked=body.locked;
   if(mode==='cleanup')throw Error('deliberate unlocked cleanup failure');
   if(mode==='final-abort')signal.abort();
  };
  return r;
 };
 return response;
}
const fresh=id=>({id,done:false,queries:0,creates:0,reconciles:0,initializes:0,sessions:0,localReads:0,reads:0,pending:0,settled:0,
 bytes:0,maxBacking:0,cancels:0,unlocks:0,unlockAttempts:0,locked:false,cancelHeld:false,cancelRejected:false,actualCancel:false,
 nativePending:false,lateHeld:false,eof:false,code:null,reason:null,publicStatus:null,published:false,
 operationKind:null,operationSettled:false,operationFailed:false,controlSettled:false,controlFailed:false});
export default {async fetch(request,env,ctx){
 const u=new URL(request.url),id=u.searchParams.get('id')??'producer';
 if(u.pathname==='/state')return Response.json(states.get(id)??{id,absent:true});
 if(u.pathname==='/setup'){
  const a=fresh(id),x=environment(env,id,a,'query','healthy');
  const user={email,record:{role:'user',tenantId:'fixture',enabled:true,groups:['manual'],contentRetentionDisabled:false,
   assignmentState:{version:1,revision:'[]',assignments:{},updatedAt:null}}};
  await x.original('/users/initialize',[user]);
  // Seed existing unknown fields directly: this test does not change producer normalization.
  user.record.extra={kid:'k'.repeat(300),['k'.repeat(100)]:{untouched:null}};
  await x.sql('UPDATE access_users SET user_json=? WHERE email=?',[JSON.stringify(user.record),email]);
  const legacy={email:'legacy@example.invalid',record:{...user.record,enabled:false}};
  const rules=Array.from({length:1000},(_,i)=>({ruleId:'absent-'+i,version:1,enabled:true,kind:'email_domain',subject:'absent-'+i+'.invalid',
   groups:[],policyIds:[],generatedGroup:'assignment.'+i,priority:i,revokeOnLoss:true,provenance:'cloudflare_access'}));
  const assigned=evaluateUserAssignments(legacy,rules).user;
  await env.POLICY_KV.put('user-reply/'+id+'/access/users/'+legacy.email,JSON.stringify(assigned.record));
  await env.POLICY_KV.put('user-reply/'+id+'/access/users/'+email,JSON.stringify({...user.record,enabled:false,groups:['stale']}));
  await env.POLICY_KV.put('user-reply/'+id+'/local/sessions/'+await sha256Hex('a'.repeat(64)),JSON.stringify({email,role:'admin',expiresAtMs:Date.now()+600000}));
  return Response.json({ready:true,legacyBytes:new TextEncoder().encode(assigned.record.assignmentState.revision).length});
 }
 if(u.pathname==='/producer'){
  const a=fresh(id),x=environment(env,id,a,'query','healthy');
  const response=await x.original('/users/resolve',{emails:[email]}),body=response.body;
  let reader;
  try{reader=body.getReader({mode:'byob'});}catch{await body.cancel();return Response.json({byob:false});}
  let buffer=new Uint8Array(16384),bytes=0,reads=0,text='',eof=false,unlocks=0,cancels=0,maxBacking=0;const decoder=new TextDecoder();
  try{for(;;){
   if(reads++>=8192)throw Error('producer read limit');const part=await reader.read(buffer);
   if(part.value){if(part.value.buffer.byteLength>16384)throw Error('producer backing');maxBacking=Math.max(maxBacking,part.value.buffer.byteLength);
    bytes+=part.value.byteLength;text+=decoder.decode(part.value,{stream:!part.done});buffer=new Uint8Array(part.value.buffer);}
   if(part.done){if(!part.value)text+=decoder.decode();eof=true;break;}
  }}finally{try{if(!eof){cancels++;await reader.cancel();}}finally{reader.releaseLock();unlocks++;}}
  const value=JSON.parse(text);return Response.json({byob:true,sameBody:response.body===body,emptyUrl:response.url==='',eof,unlocked:!body.locked,
   reads,bytes,maxBacking,cancels,unlocks,users:value.users.length,unknown:value.users[0].record.extra.kid.length===300});
 }
 if(u.pathname!=='/start')return new Response(null,{status:404});
 const mode=u.searchParams.get('mode')??'healthy',kind=u.searchParams.get('kind')??'query',a=fresh(id),abort=new AbortController();
 a.operationKind=kind==='query'?'query':'public';
 states.set(id,a);
 const x=environment(env,id,a,kind,mode,abort);
 // All I/O promises/handles below belong only to THIS originating request.
 let abortRoot;
 if(['read','read-reject','late','unknown-lock'].includes(mode))abortRoot=gate(id,mode==='unknown-lock'?'lifetime':'abort').then(()=>{
  if(mode!=='unknown-lock'){a.aborted=true;abort.abort();}
 }).then(
  ()=>{a.controlSettled=true;return {failed:false};},
  error=>{a.controlSettled=true;a.controlFailed=true;return {failed:true,error};});
 // Explicit fixture lifetime support, not a production physical-retirement claim.
 if(mode==='unknown-lock')ctx.waitUntil(abortRoot);
 if(mode==='pre-abort')abort.abort();
 const background=[];
 const work=(async()=>{
  let hasPrimary=false,primary;
  try{
   if(kind==='query'){
    if(mode==='mixed'){
     const before=await x.sql('SELECT user_json FROM access_users WHERE email=?',[email]);
     const result=await resolveUsers(x.env,[email,' LEGACY@example.invalid ',email,'missing@example.invalid']);
     const again=await resolveUsers(x.env,['legacy@example.invalid']);
     const after=await x.sql('SELECT user_json FROM access_users WHERE email=?',[email]);
     a.mixed=result.map(row=>row.email).join(',')===email+',legacy@example.invalid';
     a.canonical=before[0].user_json===after[0].user_json&&result[0].record.enabled===true&&result[0].record.extra.kid.length===300;
     a.legacyBytes=new TextEncoder().encode(result[1].record.assignmentState.revision).length;
     a.legacyUnchanged=JSON.stringify(again[0])===JSON.stringify(result[1]);a.disabled=result[1].record.enabled===false;
    }else{
     const value=await authorityCall(x.env,'/users/resolve',{emails:[mode==='missing'?'missing@example.invalid':email]},'policy-bindings',abort.signal);
     a.users=value.users.length;a.unknown=value.users[0]?.record.extra?.kid.length===300;
    }
    a.published=true;
   }else{
    const path=kind==='local'?'/v1/session/login':kind==='admin'?'/v1/admin/users':'/v1/session';
    const routed=new Request('https://router.example'+path,{method:kind==='local'?'POST':'GET',signal:abort.signal,
     headers:{origin:'https://router.example',authorization:'Bearer synthetic-user-reader-admin',
      cookie:'clawrouter_session='+'a'.repeat(64),...(kind==='local'?{}:{'cf-access-jwt-assertion':env.FIXTURE_JWT})},
     ...(kind==='local'?{body:JSON.stringify({token:'synthetic-user-reader-admin'})}:{})});
    const response=await worker.fetch(routed,x.env,{waitUntil(p){background.push(Promise.resolve(p).then(()=>({failed:false}),error=>({failed:true,error})));}});
    a.publicStatus=response.status;a.operationFailed=!response.ok;a.setCookie=response.headers.has('set-cookie');
    const value=await response.json();a.publicCode=value.error?.code??null;a.published=response.ok;
    if(!response.ok){hasPrimary=true;primary={kind:'public',status:response.status,code:a.publicCode==='internal_error'?'internal_error':'unexpected'};}
   }
  }catch(error){hasPrimary=true;primary=error;a.operationFailed=true;a.code=error?.code==='authority_user_query_failed'?error.code:'unexpected';a.reason=['aborted','transport','status','limit','protocol','cleanup'].includes(error?.reason)?error.reason:'unexpected';}
  finally{
   a.operationSettled=true; // Observable before a held control/cleanup join.
   const drained=await Promise.all([abortRoot??{failed:false},...background]);
   a.backgroundClean=drained.slice(1).every(x=>!x.failed);a.done=true;
   // Original reasons, including undefined, stay in this invocation only.
   const failures=drained.filter(x=>x.failed).map(x=>x.error);
   if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'user-reply primary and independent cleanup failures');
  }
 })();
 ctx.waitUntil(work);await work;return Response.json(a);
},queue:worker.queue};
`;

async function signedIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'reader' };
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = enc({ alg: 'RS256', kid: 'reader' }) + '.' + enc({ iss: 'https://user-reply.cloudflareaccess.com',
    aud: 'reader', email: 'reader@example.invalid', sub: 'fixture', exp: Math.floor(Date.now() / 1000) + 600 });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(unsigned));
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('synthetic-user-reader-admin'))).toString('hex');
  return { jwk, jwt: unsigned + '.' + Buffer.from(signature).toString('base64url'), hash };
}

test('actual user-query producer, public authentication and owned network faults', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'authority-user-workerd-'));
  const identity = await signedIdentity(), waiting = new Map(), arrived = new Set(), released = new Set(), tails = new Map(), outcomes = [], serverErrors = [];
  let runtime, server, releaseFuture = false, primary, hasPrimary = false, unknownOutcome, drainUnknownLifetime;
  const release = key => { released.add(key); const response = waiting.get(key); if (response) { waiting.delete(key); response.end('released'); } };
  const releaseAll = () => { releaseFuture = true; for (const key of waiting.keys()) release(key); for (const r of tails.values()) if (!r.destroyed) r.end('true,"users":[],"missingEmails":[]}'); };
  const stop = () => releaseAll();
  t.signal.addEventListener('abort', stop, { once: true });
  t.after(async () => {
    releaseAll(); const failures = [];
    try { if (drainUnknownLifetime) await drainUnknownLifetime(); } catch (error) { failures.push(error); }
    for (const result of await Promise.all(outcomes)) if (!result.ok && (!hasPrimary || result.error !== primary)) failures.push(result.error);
    failures.push(...serverErrors);
    try { if (runtime) await runtime.dispose(); } catch (error) { failures.push(error); }
    if (unknownOutcome) await unknownOutcome;
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    t.signal.removeEventListener('abort', stop);
    if (failures.length) throw new AggregateError(failures, 'independent user-reply cleanup failures');
  });
  const track = actual => { outcomes.push(actual.then(() => ({ ok: true }), error => ({ ok: false, error }))); return actual; };
  try {
    server = createServer((request, response) => {
      response.once('error', error => serverErrors.push(error));
      const path = new URL(request.url, 'http://fixture').pathname;
      if (path.startsWith('/gate/')) {
        const key = path.slice(6); arrived.add(key);
        if (releaseFuture || released.has(key)) response.end('released'); else waiting.set(key, response);
        return;
      }
      if (path === '/jwks') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ keys: [identity.jwk] })); return; }
      const mode = path.slice('/fault/'.length), headers = { 'content-type': 'text/plain' };
      if (mode === 'headers') for (let i = 0; i < 33; i++) headers['x-' + i] = 'a';
      if (mode === 'header-bytes') headers['x-large'] = 'a'.repeat(4096);
      response.writeHead(mode === 'status' ? 503 : 200, headers);
      if (['read', 'read-reject'].includes(mode)) { response.write('{"initialized":'); tails.set(mode, response); if (releaseFuture) response.end('true,"users":[],"missingEmails":[]}'); return; }
      const normal = '{"initialized":true,"users":[],"missingEmails":[]}';
      const body = mode === 'wire' ? normal + ' '.repeat(1048576 - normal.length)
        : mode === 'wire-plus' ? normal + ' '.repeat(1048577 - normal.length)
          : mode === 'duplicates' ? '{"initialized":true,"users":[],"missingEmails":[],' + Array(4094).fill('"x":0').join(',') + '}'
            : mode === 'key' ? JSON.stringify({ initialized: true, users: [], missingEmails: [], ['k'.repeat(1024)]: { kid: 'k'.repeat(300), n: 'n'.repeat(2000), e: 'e'.repeat(32) } })
              : mode === 'key-plus' ? JSON.stringify({ initialized: true, users: [], missingEmails: [], ['k'.repeat(1025)]: 0 })
            : mode === 'status' ? 'private record sentinel' : mode === 'unknown-lock' ? '{' : mode === 'malformed' ? '{' : normal;
      response.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    runtime = await startWorkerdFixture(directory, router, `export default {fetch(request){
      const u=new URL(request.url);if(u.hostname==='user-reply.cloudflareaccess.com')return fetch('http://127.0.0.1:${port}/jwks');
      if(u.hostname==='user-reply-fixture.example')return fetch('http://127.0.0.1:${port}'+u.pathname);
      throw Error('unexpected outbound request');
    }};`, { preventEviction: true, bindings: { FIXTURE_JWT: identity.jwt, FIXTURE_ADMIN_HASH: identity.hash } });
    const call = path => track(runtime.dispatchFetch('https://router.example' + path).then(async r => { assert.equal(r.status, 200); return r.json(); }));
    const setup = async id => { const s = await call('/setup?id=' + id); assert.equal(s.ready, true); assert.ok(s.legacyBytes > 65536 && s.legacyBytes < 1048576); };
    const wait = async (id, predicate, actual) => {
      let last, stopped = false, failed = false, failure;
      const poll = async () => {
        for (let i = 0; i < 500; i++) {
          if (stopped) return;
          last = await call('/state?id=' + id);
          if (stopped) return;
          if (last.operationSettled || last.operationFailed || last.controlFailed) throw Error('user-reply operation ended before phase: ' + JSON.stringify({
            id, operationKind: last.operationKind, operationSettled: last.operationSettled, operationFailed: last.operationFailed,
            code: last.code, reason: last.reason, publicStatus: last.publicStatus, controlFailed: last.controlFailed }));
          if (predicate(last)) return last;
          if (last.done) throw Error('user-reply operation ended before expected phase');
          await delay(10);
        }
        assert.fail('user-reply phase missing: ' + JSON.stringify({ id, done: last?.done, reads: last?.reads, pending: last?.pending, cancels: last?.cancels }));
      };
      const polling = poll(), observed = polling.then(() => ({ ok: true }), error => ({ ok: false, error }));
      try { return await Promise.race([polling, actual.then(() => { throw Error('client completed before phase'); }, error => { throw error; })]); }
      catch (error) { failed = true; failure = error; throw error; }
      finally {
        stopped = true; const result = await observed;
        if (!result.ok && (!failed || result.error !== failure)) throw new AggregateError(failed ? [failure, result.error] : [result.error], 'phase and poll failures');
      }
    };
    await setup('producer');
    const producer = await call('/producer');
    assert.equal(producer.byob, true, 'STOP: unchanged /users/resolve producer must provide original BYOB');
    assert.equal(producer.sameBody, true); assert.equal(producer.eof, true); assert.equal(producer.unlocked, true);
    assert.equal(producer.users, 1); assert.equal(producer.unknown, true); assert.equal(producer.cancels, 0); assert.equal(producer.unlocks, 1);
    assert.ok(producer.bytes > 0 && producer.maxBacking <= 16384); // Empty DO URL is admitted, not required.

    for (const [mode, kind] of [['healthy', 'query'], ['mixed', 'query'], ['missing', 'query'], ['healthy', 'access'], ['healthy', 'local'],
      ...['wire', 'wire-plus', 'key', 'key-plus', 'duplicates', 'malformed', 'status', 'headers', 'header-bytes', 'default', 'pre-abort', 'final-abort', 'reads', 'reads-over', 'backing'].map(mode => [mode, 'query']),
      ...['wire-plus', 'duplicates', 'malformed', 'status', 'default', 'cleanup', 'throw'].flatMap(mode => [['access', mode], ['local', mode], ['admin', mode]].map(([kind, mode]) => [mode, kind]))]) {
      const id = mode + '-' + kind; await setup(id);
      const s = await call('/start?id=' + id + '&mode=' + mode + '&kind=' + kind);
      assert.equal(s.done, true); assert.equal(s.backgroundClean, true);
      const healthy = ['healthy', 'mixed', 'missing', 'wire', 'key', 'reads'].includes(mode);
      if (healthy) {
        assert.equal(s.code, null); assert.equal(s.published, true);
        if (kind !== 'query') assert.equal(s.publicStatus, 200);
        if (mode === 'mixed') { assert.equal(s.mixed, true); assert.equal(s.canonical, true); assert.equal(s.disabled, true); assert.equal(s.legacyUnchanged, true); assert.ok(s.legacyBytes > 65536); }
        if (kind === 'local') assert.equal(s.sessions, 1);
      } else {
        assert.equal(s.published, false);
        if (kind === 'query') {
          const reasons = { 'wire-plus': 'limit', 'key-plus': 'limit', duplicates: 'limit', malformed: 'protocol',
            status: 'status', headers: 'limit', 'header-bytes': 'limit', default: 'transport',
            'pre-abort': 'aborted', 'final-abort': 'aborted', 'reads-over': 'limit', backing: 'limit' };
          assert.equal(Object.hasOwn(reasons, mode), true, 'negative query must name its expected guard');
          assert.equal(s.code, 'authority_user_query_failed'); assert.equal(s.reason, reasons[mode]);
        }
        else { assert.equal(s.publicStatus, 500); assert.equal(s.publicCode, 'internal_error'); assert.equal(s.setCookie, false); }
        assert.equal(s.creates, 0); assert.equal(s.reconciles, 0); assert.equal(s.sessions, 0); assert.equal(s.localReads, 0);
        if (['status', 'headers', 'header-bytes', 'default'].includes(mode)) { assert.equal(s.reads, 0); assert.equal(s.cancels, 1); }
      }
      if (!['pre-abort', 'throw'].includes(mode)) { assert.equal(s.locked, false); assert.ok(s.unlocks >= 1); assert.equal(s.unlockAfterRoots, true); }
      if (mode === 'pre-abort') assert.equal(s.queries, 0);
      if (['reads', 'reads-over'].includes(mode)) { assert.equal(s.reads, 8192); assert.equal(s.eof, true); }
    }
    for (const mode of ['read', 'read-reject', 'late']) {
      const id = mode; await setup(id);
      const actual = call('/start?id=' + id + '&mode=' + mode);
      const before = await wait(id, s => mode === 'late' ? s.lateHeld : s.nativePending && s.pending === 1, actual);
      assert.equal(before.done, false); assert.equal(before.published, false);
      release(id + '/abort');
      if (mode === 'late') release(id + '/late');
      if (mode === 'read-reject') {
        const held = await wait(id, s => s.cancelHeld && arrived.has(id + '/cleanup'), actual);
        assert.equal(held.actualCancel, true); assert.equal(held.cancels, 1); assert.equal(held.unlocks, 0);
        assert.equal(held.locked, true); assert.equal(held.published, false); assert.equal(held.done, false);
        release(id + '/cleanup');
      }
      const s = await actual;
      assert.equal(s.code, 'authority_user_query_failed'); assert.equal(s.reason, mode === 'read-reject' ? 'cleanup' : 'aborted');
      assert.equal(s.cancels, 1); assert.equal(s.pending, 0); assert.equal(s.unlocks, 1); assert.equal(s.locked, false);
      if (mode === 'late') assert.equal(s.reads, 0);
    }
    // Unknown unlock is a deliberately nonterminating physical owner. Isolate
    // disposal below ends the fixture; it is NOT retirement or successful auth.
    await setup('unknown');
    let lifetimeDrain;
    drainUnknownLifetime = () => lifetimeDrain ??= (async () => {
      let control;
      for (let i = 0; i < 500; i++) {
        control = await call('/state?id=unknown');
        if (control.controlSettled) break;
        await delay(10);
      }
      assert.equal(control.controlSettled, true, 'original-request fixture lifetime root must settle before disposal');
      assert.equal(control.controlFailed, false);
    })();
    const unknown = runtime.dispatchFetch('https://router.example/start?id=unknown&mode=unknown-lock');
    let unknownSettled = false;
    unknownOutcome = unknown.then(() => { unknownSettled = true; return { ok: true }; }, () => { unknownSettled = true; return { ok: false }; });
    await wait('unknown', s => s.unknownLock && arrived.has('unknown/lifetime'), unknownOutcome);
    const held = await call('/state?id=unknown');
    assert.equal(unknownSettled, false); assert.equal(held.locked, true); assert.equal(held.done, false); assert.equal(held.published, false);
    release('unknown/lifetime');
    await drainUnknownLifetime();
    await runtime.dispose(); runtime = undefined; await unknownOutcome;
  } catch (error) { primary = error; hasPrimary = true; throw error; }
});
