import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const router = String.raw`
import {PolicyBindingIndexObject as Base,authorityCall,resolveUsers} from './worker/authority.ts';
import {evaluateUserAssignments} from './worker/assignment-evaluator.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
const header={'x-clawrouter-user-materialization':'v1'},email='source@example.invalid',record={role:'user',tenantId:'fixture',enabled:true,groups:[' A ','a'],contentRetentionDisabled:false};
const raw=globalThis.fetch.bind(globalThis),states=new Map();
const fresh=()=>({reads:0,settled:0,pending:0,cancels:0,unlocks:0,unlockAttempts:0,bytes:0,maxBacking:0,eof:false,byob:false,locked:false,readHeld:false,cancelHeld:false,actualCancel:false});
function observe(body,a,mode,id){
 const get=body.getReader.bind(body);
 body.getReader=options=>{
  const reader=get(options),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),unlock=reader.releaseLock.bind(reader);a.byob=options?.mode==='byob';a.locked=body.locked;let first;
  reader.read=(...args)=>{
   a.reads++;a.pending++;const actual=read(...args);
   // Same native promise is returned; this observer retains only scalar facts.
   void actual.then(part=>{a.pending--;a.settled++;if(part.value){a.bytes+=part.value.byteLength;a.maxBacking=Math.max(a.maxBacking,part.value.buffer.byteLength);}if(part.done)a.eof=true;},()=>{a.pending--;a.settled++;});
   return actual;
  };
  reader.cancel=(...args)=>{
   if(!first){a.cancels++;first=(async()=>{
    let failed=false,error;try{await cancel(...args);a.actualCancel=true;}catch(e){failed=true;error=e;}
    if(mode==='cleanup'){a.cancelHeld=true;await gate(id,'cancel');a.cancelHeld=false;if(failed)throw error;throw undefined;}
    if(failed)throw error;
   })();}return first;
  };
  reader.releaseLock=()=>{a.unlockAttempts++;a.rootsSettled=a.pending===0&&!a.cancelHeld;
   if(mode==='unknown')throw Error('injected unknown unlock');
   unlock();a.unlocked=!body.locked;a.locked=body.locked;a.unlocks++;
  };
  return reader;
 };return body;
}
async function probe(body){
 const a=fresh();if(!body)return {supported:false};observe(body,a,'','');let r,eof=false,result,primary,hasPrimary=false;const cleanup=[];
 try{
  try{r=body.getReader({mode:'byob'});}catch{result={supported:false};}
  if(r){let backing=new Uint8Array(16384),text='';const decoder=new TextDecoder();
   for(let n=0;;n++){if(n>=8192)throw Error('probe reads');const part=await r.read(backing);
    if(part.value){if(part.value.buffer.byteLength>16384)throw Error('probe backing');text+=decoder.decode(part.value,{stream:!part.done});backing=new Uint8Array(part.value.buffer);}
    if(part.done){if(!part.value)text+=decoder.decode();eof=true;break;}}
   result={supported:true,a,text};}
 }catch(error){hasPrimary=true;primary=error;}
 finally{
  if(!eof)try{if(r)await r.cancel();else await body.cancel();}catch(error){cleanup.push(error);}
  if(r)try{r.releaseLock();}catch(error){cleanup.push(error);}
 }
 if(cleanup.length)throw new AggregateError(hasPrimary?[primary,...cleanup]:cleanup,'probe primary and cleanup');
 if(hasPrimary)throw primary;return result;
}
export class PolicyBindingIndexObject extends Base{
 constructor(ctx,env){super(ctx,env);this.s=ctx.storage.sql;this.metrics={query:0,init:0};this.failAt=0;this.writes=0;
  const exec=this.s.exec.bind(this.s);this.sql={exec:(query,...args)=>{if(query.startsWith('INSERT OR REPLACE INTO access_users')){this.writes++;if(this.failAt===this.writes)throw Error('labelled SQL failure after preceding commit');}return exec(query,...args);}};}
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/fixture/sql'){const x=await request.json();return Response.json([...this.s.exec(x.query,...(x.args??[]))]);}
  if(path==='/fixture/fail'){this.failAt=this.writes+2;return new Response('set');}
  if(path==='/fixture/stats')return Response.json({...this.metrics,writes:this.writes});
  if(request.headers.get('x-fixture-capability')==='original'){
   const body=request.body,result=await probe(body);return Response.json({...result,sameBody:body===request.body,path});
  }
  if(request.headers.has('x-clawrouter-user-materialization')){
   const a=fresh();if(path==='/users/resolve'){this.metrics.query++;this.metrics.lastQuery=a;}else if(path==='/users/initialize'){this.metrics.init++;this.metrics.lastInit=a;}
   if(request.body)observe(request.body,a,'','');
  }
  return super.fetch(request);
 }
}
async function gate(id,phase){const r=await raw('https://material-fixture.example/gate/'+id+'/'+phase);await r.text();if(!r.ok)throw Error('gate status');}
function current(env,id,a,mode){
 const stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('material-'+id)),prefix='material/'+id+'/';
 const call=(path,body,headers)=>stub.fetch('https://clawrouter.internal'+path,{method:'POST',body:typeof body==='string'?body:JSON.stringify(body),headers});
 const sql=async(query,args=[])=>{const r=await call('/fixture/sql',{query,args});if(!r.ok)throw Error('fixture SQL failed');return r.json();};
 return {stub,call,sql,env:{...env,ACCESS_CONTROL:{idFromName:n=>n,get:()=>stub},POLICY_KV:{async get(key,type){
  if(type!=='stream')throw Error('unexpected KV type');a.gets++;
  let body;
  if(['cleanup','unknown'].includes(mode)){const response=await raw('https://material-fixture.example/source/'+id+'/'+mode);body=response.body;}
  else if(mode==='default')body=new ReadableStream({},{highWaterMark:0});
  else body=await env.POLICY_KV.get(prefix+key,'stream');
  if(body)observe(body,a,mode,id);
  if(mode==='late'){a.getHeld=true;await gate(id,'late');a.getHeld=false;}
  if(mode==='race')await (await call('/users/put',{email,record:{...record,enabled:false,groups:['canonical']} })).text();
  return body;
 }}}};
}
export default {async fetch(request,env,ctx){
 const u=new URL(request.url),id=u.searchParams.get('id')??'cap',mode=u.searchParams.get('mode')??'cold';
 if(u.pathname==='/state')return Response.json(states.get(id)??{absent:true});
 const a={...fresh(),id,gets:0,done:false,published:false,failed:false,reason:null,operationSettled:false},x=current(env,id,a,mode);
 if(u.pathname==='/capability'){
  await env.POLICY_KV.put('material/cap/access/users/'+email,JSON.stringify(record));
  const body=await env.POLICY_KV.get('material/cap/access/users/'+email,'stream'),kv=await probe(body);
  const results=[];
  for(const [path,value]of[['/users/resolve',{emails:[email]}],['/users/initialize',[{email,record}]]]){
   const response=await x.call(path,value,{...header,'x-fixture-capability':'original'});results.push(await response.json());
  }
  return Response.json({kv,requests:results});
 }
 if(u.pathname==='/setup'){
  const put=(key,value)=>env.POLICY_KV.put('material/'+id+'/access/users/'+key,typeof value==='string'?value:JSON.stringify(value));
  if(mode==='legacy'){
   const rules=Array.from({length:1000},(_,i)=>({ruleId:'absent-'+i,version:1,enabled:true,kind:'email_domain',subject:'absent-'+i+'.invalid',groups:[],policyIds:[],generatedGroup:'assignment.'+i,priority:i,revokeOnLoss:true,provenance:'cloudflare_access'}));
   const legacy=evaluateUserAssignments({email,record},rules).user.record;await put(email,legacy);return Response.json({legacyBytes:new TextEncoder().encode(legacy.assignmentState.revision).length});
  }
  await put(email,mode==='race'?{groups:[42]}:record);
  if(mode==='kv-aggregate'){await put(email,' '.repeat(1100000)+JSON.stringify(record));await put('other@example.invalid',' '.repeat(1000000)+JSON.stringify(record));}
  if(mode==='warm')await x.sql('INSERT INTO access_users(email,user_json) VALUES(?,?)',[email,JSON.stringify({...record,extra:{kid:'k'.repeat(300),['k'.repeat(100)]:true}})]);
  if(mode==='sql-exact')await x.sql('INSERT INTO access_users(email,user_json) VALUES(?,?)',[email,' '.repeat(2097150)+'{}']);
  if(mode==='kv-exact')await put(email,' '.repeat(2097152-JSON.stringify(record).length)+JSON.stringify(record));
  if(mode==='sql-limit')await x.sql('INSERT INTO access_users(email,user_json) VALUES(?,?)',[email,' '.repeat(2097152)+'{}']);
  if(mode==='sql-aggregate')for(const [key,n]of[[email,1100000],['other@example.invalid',1000000]])await x.sql('INSERT INTO access_users(email,user_json) VALUES(?,?)',[key,' '.repeat(n)+'{}']);
  if(mode==='malformed')await x.sql('INSERT INTO access_users(email,user_json) VALUES(?,?)',[email,'{']);
  if(mode==='canonical-null')await x.sql('INSERT INTO access_users(email,user_json) VALUES(?,?)',[email,'null']);
  if(mode==='sql-fail')await (await x.call('/fixture/fail',{})).text();
  return Response.json({ready:true});
 }
 if(u.pathname!=='/start')return new Response(null,{status:404});
 states.set(id,a);
 const operation=(async()=>{
  if(['cold','warm','legacy','race','late','default','cleanup','unknown','kv-aggregate','kv-exact'].includes(mode)){
   const emails=mode==='kv-aggregate'?[email,'other@example.invalid']:[' SOURCE@example.invalid ',email,'invalid'];
   const users=await resolveUsers(x.env,emails);a.published=true;
   const again=mode==='cold'||mode==='legacy'?await resolveUsers(x.env,emails):users;
   const stored=await x.sql('SELECT user_json FROM access_users WHERE email=?',[email]);
   return {users:users.length,enabled:users[0]?.record.enabled,groups:users[0]?.record.groups,unknown:users[0]?.record.extra?.kid.length,
    legacyBytes:users[0]?.record.assignmentState?.revision.length,legacySame:users[0]?.record.assignmentState?.revision===again[0]?.record.assignmentState?.revision,
    persistedSame:stored.length===1&&JSON.parse(stored[0].user_json).assignmentState?.revision===users[0]?.record.assignmentState?.revision};
  }
  let path='/users/initialize',input,headers=header;
  if(mode==='query-occurrences') {path='/users/resolve';input='{"emails":['+'"a@b",'.repeat(4095)+'"a@b"],"emails":["a@b"]}';}
  else if(mode==='query-exact') {path='/users/resolve';const text=JSON.stringify({emails:[email]});input=' '.repeat(2097152-text.length)+text;}
  else if(mode==='query-plus') {path='/users/resolve';input=' '.repeat(2097152)+JSON.stringify({emails:[email]});}
  else if(mode==='query-order') {path='/users/resolve';input={emails:[' B@C ','a@b','b@c','invalid']};}
  else if(mode==='query-emails-exact') {path='/users/resolve';input={emails:Array(4096).fill('a@b')};}
  else if(mode==='query-raw-email') {path='/users/resolve';input={emails:['x'.repeat(1025)]};}
  else if(mode==='unmarked') {path='/users/initialize-all';input=' '.repeat(2097153)+'[]';headers={};}
  else if(mode==='marked-other') {path='/users/initialize-all';input='invalid';}
  else if(mode==='version') {path='/users/resolve';input='invalid';headers={'x-clawrouter-user-materialization':'v2'};}
  else if(mode==='sql-limit'||mode==='sql-exact') {path='/users/resolve';input={emails:[email]};}
  else if(mode==='sql-aggregate') input=[{email:'new@example.invalid',record},{email,record},{email:'other@example.invalid',record}];
  else if(mode==='batch-limit') input=[{email:'new@example.invalid',record},{email:'big@example.invalid',record:{...record,assignmentState:{revision:'x'.repeat(1048576)}}}];
  else if(mode==='malformed') input=[{email:'new@example.invalid',record},{email,record}];
  else if(mode==='validation') input=[{email:'new@example.invalid',record},{email,record:{groups:[42]}}];
  else if(mode==='canonical-null') input=[{email,record:{groups:[42]}}];
  else if(mode==='duplicate') input=[{email,record},{email,record:{groups:[42]}}];
  else if(mode==='sql-fail') input=[{email:'one@example.invalid',record},{email:'two@example.invalid',record}];
  else throw Error('unknown fixture mode');
  const response=await x.call(path,input,headers),text=await response.text();
  const value=response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text;
  return {status:response.status,code:value?.error?.code,reason:value?.error?.message,missing:value?.missingEmails};
 })();
 let outcome;const observed=operation.then(value=>{a.operationSettled=true;outcome={failed:false,value};return outcome;},error=>{
  a.operationSettled=true;a.failed=true;a.reason=['limit','protocol','transport','cleanup'].find(k=>error?.message==='User materialization failed ('+k+')')??'unexpected';
  outcome={failed:true,error};return outcome;
 });
 // Deliberately unknown owner is retained, not classified as retired by HTTP EOF.
 ctx.waitUntil(observed.then(()=>undefined));
 if(mode==='unknown'){
  let gateFailed=false,gateError;try{await gate(id,'lifetime');}catch(error){gateFailed=true;gateError=error;}
  if(outcome){if(outcome.failed){if(gateFailed)throw new AggregateError([outcome.error,gateError],'operation and gate');throw outcome.error;}
   throw new AggregateError([Error('unknown owner unexpectedly fulfilled'),...(gateFailed?[gateError]:[])],'unexpected outcome');}
  if(gateFailed)throw gateError;
  if(!a.locked||a.operationSettled||a.done||a.published||a.pending||a.cancelHeld)throw Error('unknown-owner held invariant');
  return Response.json({fixtureDiagnostic:true,...a});
 }
 const result=await observed;
 let extra,stats,cleanupFailed=false,cleanupError;
 try{stats=await (await x.call('/fixture/stats',{})).json();extra=await x.sql('SELECT email,user_json FROM access_users ORDER BY email');}
 catch(error){cleanupFailed=true;cleanupError=error;}
 if(cleanupFailed)throw new AggregateError(result.failed?[result.error,cleanupError]:[cleanupError],'primary and independent inspection');
 a.done=true;
 return Response.json({...a,result:result.failed?null:result.value,stats,stored:extra.map(x=>({email:x.email,bytes:x.user_json.length}))});
}};
`;

const upstream = `export default { fetch(request) { const u=new URL(request.url); return fetch('http://127.0.0.1:PORT'+u.pathname,{method:request.method,headers:request.headers,body:request.body,duplex:'half'}); } };`;

test('selected user materialization: ORIGINAL KV/request BYOB then actual SQLite/KV admission and retirement', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'user-materialization-')), waiting = new Map(), tails = new Map(), released = new Set(), arrived = new Set(), outcomes = [], serverErrors = [];
  let runtime, server, releaseFuture = false, primary, hasPrimary = false;
  const release = key => { released.add(key); const response = waiting.get(key); if (response) { waiting.delete(key); response.end('released'); } };
  const releaseTail = id => { const response = tails.get(id); if (response) { tails.delete(id); response.end(' '.repeat(2097153)); } };
  const releaseAll = () => { releaseFuture = true; for (const key of waiting.keys()) release(key); for (const key of tails.keys()) releaseTail(key); };
  const stop = () => releaseAll(); t.signal.addEventListener('abort', stop, { once: true });
  t.after(async () => {
    releaseAll(); const failures = [];
    for (const result of await Promise.all(outcomes)) if (result.failed && (!hasPrimary || !Object.is(result.error, primary))) failures.push(result.error);
    // Only the labelled unknown-lock owner may remain. Disposal is fixture teardown,
    // never evidence of physical retirement or a successful materialization.
    try { if (runtime) await runtime.dispose(); } catch (error) { failures.push(error); }
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    t.signal.removeEventListener('abort', stop); failures.push(...serverErrors);
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'primary and independent fixture cleanup');
  });
  const track = actual => { const state = { settled: false, failed: false, error: undefined };
    outcomes.push(actual.then(value => { state.settled = true; return { failed: false, value }; }, error => { state.settled = true; state.failed = true; state.error = error; return { failed: true, error }; }));
    return { actual, state }; };
  try {
    server = createServer((request, response) => {
      response.on('error', error => serverErrors.push(error)); const path = new URL(request.url, 'http://fixture.invalid').pathname;
      if (path.startsWith('/gate/')) { const key = path.slice(6); arrived.add(key); if (releaseFuture || released.has(key)) response.end('released'); else waiting.set(key, response); return; }
      if (path.startsWith('/source/')) { const [, , id, mode] = path.split('/'); response.writeHead(200, { 'content-type': 'application/json' });
        if (mode === 'unknown') { response.end(' '.repeat(2097153)); return; }
        response.write('{'); if (releaseFuture) response.end(' '.repeat(2097153)); else tails.set(id, response); return; }
      response.writeHead(404); response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    runtime = await startWorkerdFixture(directory, router, upstream.replace('PORT', String(server.address().port)), { preventEviction: true });
    const call = path => { const { actual } = track((async () => { const response = await runtime.dispatchFetch('https://fixture.invalid' + path); const value = await response.json(); assert.equal(response.status, 200); return value; })()); return actual; };
    const start = (id, mode) => track(call('/start?id=' + id + '&mode=' + mode));
    const wait = async (id, pending, predicate) => {
      const until = Date.now() + 10000; let last;
      while (Date.now() < until) {
        if (pending.state.settled) { if (pending.state.failed) throw pending.state.error; throw Error('origin completed before required phase'); }
        last = await call('/state?id=' + id);
        if (last.operationSettled) throw Error('operation settled before phase: ' + (last.reason ?? 'fulfilled'));
        if (predicate(last)) return last;
        await Promise.race([delay(10), pending.actual.then(() => { throw Error('origin completed before arrival'); }, error => { throw error; })]);
      }
      assert.fail('missing bounded phase: ' + JSON.stringify(last));
    };
    const capability = await call('/capability');
    assert.equal(capability.kv.supported, true, 'STOP: ORIGINAL KV.get stream BYOB prerequisite');
    assert.equal(capability.requests.length, 2);
    for (const proof of [capability.kv, ...capability.requests]) {
      assert.equal(proof.supported, true, 'STOP: ORIGINAL incoming DO body must support BYOB');
      assert.equal(proof.a.byob, true); assert.equal(proof.a.eof, true); assert.equal(proof.a.unlocked, true); assert.equal(proof.a.cancels, 0); assert.equal(proof.a.unlocks, 1); assert.ok(proof.a.maxBacking <= 16384);
    }
    assert.deepEqual(capability.requests.map(x => x.path), ['/users/resolve', '/users/initialize']); assert.ok(capability.requests.every(x => x.sameBody));
    assert.equal(JSON.parse(capability.kv.text).enabled, true);
    for (const mode of ['cold', 'warm', 'legacy', 'race', 'kv-exact', 'sql-exact', 'duplicate', 'canonical-null', 'validation', 'malformed', 'batch-limit', 'kv-aggregate', 'sql-limit', 'sql-aggregate', 'sql-fail', 'query-exact', 'query-plus', 'query-occurrences', 'query-emails-exact', 'query-raw-email', 'query-order', 'version', 'marked-other', 'unmarked', 'default']) {
      const setup = await call('/setup?id=' + mode + '&mode=' + mode), result = await call('/start?id=' + mode + '&mode=' + mode);
      assert.equal(result.done, true, mode);
      if (['cold', 'warm', 'legacy', 'race', 'kv-exact'].includes(mode)) {
        assert.equal(result.failed, false, mode); assert.equal(result.result.users, 1); assert.equal(result.published, true);
        assert.equal(result.stats.lastQuery.eof, true); assert.equal(result.stats.lastQuery.unlocked, true);
        if (mode !== 'warm') { assert.equal(result.gets, 1); assert.equal(result.eof, true); assert.equal(result.unlocked, true); assert.equal(result.stats.lastInit.eof, true); assert.equal(result.stats.lastInit.unlocked, true); }
        if (mode === 'race') { assert.equal(result.result.enabled, false); assert.deepEqual(result.result.groups, ['canonical']); }
        if (mode === 'warm') { assert.equal(result.gets, 0); assert.equal(result.result.unknown, 300); }
        if (mode === 'legacy') { assert.ok(setup.legacyBytes > 65536); assert.equal(result.result.legacySame, true); assert.equal(result.result.persistedSame, true); }
      } else if (['kv-aggregate', 'default'].includes(mode)) {
        assert.equal(result.failed, true); assert.equal(result.reason, mode === 'default' ? 'transport' : 'limit'); assert.equal(result.stats.init, 0); assert.equal(result.stats.writes, 0);
        if (mode === 'default') { assert.equal(result.reads, 0); assert.equal(result.cancels, 1); assert.equal(result.unlocked, true); }
      } else {
        const healthy = ['duplicate', 'canonical-null', 'sql-exact', 'query-exact', 'query-emails-exact', 'query-order', 'unmarked'].includes(mode);
        assert.equal(result.failed, false, mode); assert.equal(result.result.status, healthy ? 200 : 503, mode);
        if (!healthy) { assert.equal(result.result.code, 'user_materialization_unavailable'); assert.equal(result.stats.writes, mode === 'sql-fail' ? 2 : 0); }
        if (mode === 'sql-fail') assert.deepEqual(result.stored.map(x => x.email), ['one@example.invalid']);
        if (mode === 'query-order') assert.deepEqual(result.result.missing, ['b@c', 'a@b']);
        if (mode === 'duplicate') assert.equal(result.stats.writes, 1);
      }
    }
    await call('/setup?id=late&mode=late'); const late = start('late', 'late');
    const held = await wait('late', late, s => s.getHeld); assert.equal(held.reads, 0); assert.equal(held.operationSettled, false);
    release('late/late'); assert.equal((await late.actual).failed, false);
    await call('/setup?id=cleanup&mode=cleanup'); const cleanup = start('cleanup', 'cleanup');
    const reading = await wait('cleanup', cleanup, s => s.reads >= 2 && s.pending === 1 && s.bytes > 0);
    assert.equal(reading.operationSettled, false); // TRUE native pending read: HTTP producer has withheld the next bytes.
    releaseTail('cleanup');
    const cancelling = await wait('cleanup', cleanup, s => s.cancelHeld && arrived.has('cleanup/cancel'));
    assert.equal(cancelling.actualCancel, true); assert.equal(cancelling.cancels, 1); assert.equal(cancelling.unlocks, 0); assert.equal(cancelling.locked, true); assert.equal(cancelling.pending, 0); assert.equal(cancelling.published, false);
    release('cleanup/cancel'); const done = await cleanup.actual;
    assert.equal(done.reason, 'cleanup'); assert.equal(done.failed, true); assert.equal(done.unlocked, true); assert.equal(done.rootsSettled, true); assert.equal(done.stats.init, 0);
    await call('/setup?id=unknown&mode=unknown'); const unknown = start('unknown', 'unknown');
    const locked = await wait('unknown', unknown, s => s.unlockAttempts === 1 && arrived.has('unknown/lifetime'));
    assert.equal(locked.locked, true); assert.equal(locked.pending, 0); assert.equal(locked.done, false); assert.equal(locked.published, false); assert.equal(locked.operationSettled, false);
    release('unknown/lifetime'); const diagnostic = await unknown.actual;
    assert.equal(diagnostic.fixtureDiagnostic, true); assert.equal(diagnostic.locked, true); assert.equal(diagnostic.operationSettled, false);
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});
