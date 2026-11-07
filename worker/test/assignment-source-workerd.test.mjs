import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const router = String.raw`
import worker from './worker/index.ts';
import {PolicyBindingIndexObject as Base,authorityCall} from './worker/authority.ts';
import {listAssignmentRules,reconcileUserAssignments} from './worker/assignments.ts';
import {assignmentRulesRevision,evaluateUserAssignments} from './worker/assignment-evaluator.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
const email='member@example.invalid',header={'x-clawrouter-assignment-materialization':'v1'};
const record={enabled:true,role:'user',tenantId:'fixture',groups:['manual'],contentRetentionDisabled:false};
const rule=(version=1,extra={})=>({ruleId:'member',generatedGroup:'assignment.member',version,enabled:true,kind:'email_domain',subject:'example.invalid',groups:['automatic'],policyIds:[],priority:10,revokeOnLoss:true,provenance:'fixture',...extra});
const raw=globalThis.fetch.bind(globalThis),states=new Map();
const fresh=()=>({reads:0,nativeSettled:0,pending:0,bytes:0,maxBacking:0,byob:false,eof:false,locked:false,cancels:0,actualCancel:false,cancelHeld:false,unlocks:0,unlockAttempts:0,readHeld:false});
async function gate(id,phase){const response=await raw('https://assignment-source.example/gate/'+id+'/'+phase);await response.text();if(!response.ok)throw Error('fixture gate failed');const a=states.get(id);if(a)a.releaseObserved=true;}
function observe(body,a,id,mode=''){
 const get=body.getReader.bind(body);body.getReader=options=>{
  const reader=get(options),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),unlock=reader.releaseLock.bind(reader);a.byob=options?.mode==='byob';a.locked=body.locked;let first;
  reader.read=(...args)=>{a.reads++;a.pending++;const actual=read(...args);void actual.then(part=>{a.nativeSettled++;a.pending--;if(part.value){a.bytes+=part.value.byteLength;a.maxBacking=Math.max(a.maxBacking,part.value.buffer.byteLength);}if(part.done)a.eof=true;},()=>{a.nativeSettled++;a.pending--;});
   if(mode==='intake'&&a.reads===1)return actual.then(async value=>{a.readHeld=true;await gate(id,'intake');a.readHeld=false;return value;}); // native read ALREADY settled; owned wrapper hold.
   return actual;};
  reader.cancel=(...args)=>{if(!first){a.cancels++;first=(async()=>{let failed=false,error;try{await cancel(...args);a.actualCancel=true;}catch(e){failed=true;error=e;}
   if(mode==='cleanup'){a.cancelHeld=true;let gateFailed=false,gateError;try{await gate(id,'cancel');}catch(e){gateFailed=true;gateError=e;}a.cancelHeld=false;if(gateFailed)throw new AggregateError(failed?[error,gateError]:[gateError],'FIRST cancel and independent gate failure');if(failed)throw error;throw undefined;}if(failed)throw error;})();}return first;};
  reader.releaseLock=()=>{a.unlockAttempts++;a.rootsSettled=a.pending===0&&!a.cancelHeld&&!a.readHeld;if(mode==='unknown')throw Error('labelled unknown unlock');unlock();a.locked=body.locked;a.unlocked=!body.locked;a.unlocks++;};return reader;
 };return body;
}
async function probe(body){
 if(!body)return {supported:false};const a=fresh();observe(body,a,'probe');let reader,eof=false,text='',hasPrimary=false,primary;const cleanup=[];
 try{try{reader=body.getReader({mode:'byob'});}catch{}if(reader){let backing=new Uint8Array(16384);const decoder=new TextDecoder();
  for(let i=0;;i++){if(i>=8192)throw Error('probe read limit');const part=await reader.read(backing);if(part.value){if(part.value.buffer.byteLength>16384)throw Error('probe whole backing');text+=decoder.decode(part.value,{stream:!part.done});backing=new Uint8Array(part.value.buffer);}if(part.done){if(!part.value)text+=decoder.decode();eof=true;break;}}}
 }catch(error){hasPrimary=true;primary=error;}finally{if(!eof)try{if(reader)await reader.cancel();else await body.cancel();}catch(e){cleanup.push(e);}if(reader)try{reader.releaseLock();}catch(e){cleanup.push(e);}}
 if(cleanup.length)throw new AggregateError(hasPrimary?[primary,...cleanup]:cleanup,'probe cleanup');if(hasPrimary)throw primary;return {supported:!!reader,a,text};
}
const digest=crypto.subtle.digest.bind(crypto.subtle),plans=[101,102,103,104].map(version=>({version,bytes:new TextEncoder().encode(assignmentRulesRevision([rule(version)]))}));
crypto.subtle.digest=function(algorithm,data){const bytes=data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength),plan=plans.find(p=>p.bytes.length===bytes.length&&p.bytes.every((b,i)=>b===bytes[i]));
 const actual=digest(algorithm,data);if(!plan)return actual;const id='d'+plan.version,state=states.get(id);return actual.then(async value=>{state.hashSettled++;state.hashHeld=true;await gate(id,'hash');state.hashHeld=false;return value;});};
export class PolicyBindingIndexObject extends Base{
 constructor(state,env){super(state,env);this.fixtureSql=state.storage.sql;this.writes=0;this.failAfter=false;
  const exec=this.fixtureSql.exec.bind(this.fixtureSql);this.sql={exec:(query,...args)=>{const result=exec(query,...args);if(query.startsWith('INSERT OR REPLACE INTO access_users')){this.writes++;if(this.failAfter)throw Error('labelled SQL after-commit failure');}return result;}};
  const original=this.reconcileUserAssignments.bind(this);this.reconcileUserAssignments=(input,...args)=>{const a=states.get('d'+input.rules?.[0]?.version);if(a)a.enrolled++;return original(input,...args);};
 }
 async fetch(request){const path=new URL(request.url).pathname;
  if(path==='/fixture/sql'){const x=await request.json();return Response.json([...this.fixtureSql.exec(x.query,...(x.args??[]))]);}
  if(path==='/fixture/stats')return Response.json({admissions:this.assignmentAdmissions,writes:this.writes});
  if(path==='/fixture/fail'){this.failAfter=true;return new Response('set');}
  if(request.headers.get('x-fixture-capability')==='original'){const body=request.body,result=await probe(body);return Response.json({...result,sameBody:body===request.body});}
  if(request.headers.has('x-clawrouter-assignment-materialization')){const id=request.headers.get('x-fixture-id'),a=states.get(id);if(a&&request.body)observe(request.body,a.intake,id,a.mode==='intake'?'intake':'');}
  return super.fetch(request);
 }
}
function current(bindings,id,caseId,a){
 const prefix='assignment-source/'+caseId+'/',kv=bindings.POLICY_KV,ns=bindings.ACCESS_CONTROL;
 const native=ns.get(ns.idFromName('assignment-source/'+caseId));
 const call=(path,value,headers)=>native.fetch('https://clawrouter.internal'+path,{method:'POST',headers,body:typeof value==='string'?value:JSON.stringify(value)});
 const sql=async(query,args=[])=>{const r=await call('/fixture/sql',{query,args});if(!r.ok)throw Error('fixture SQL failed');return r.json();};
 const env={...bindings,ACCESS_CONTROL:{idFromName:n=>n,get:()=>({async fetch(url,init){const selected=new URL(url).pathname==='/users/reconcile-assignments'&&new Headers(init.headers).has('x-clawrouter-assignment-materialization');
  const response=await native.fetch(url,selected?{...init,headers:{...init.headers,'x-fixture-id':id}}:init);
  if(selected&&response.body)observe(response.body,a.reply,id);return response; // SAME healthy Response/body.
 }})},POLICY_KV:{put:(key,...args)=>kv.put(prefix+key,...args),delete:key=>kv.delete(prefix+key),
  async list(options){a.lists++;if(a.mode==='empty-pages')return {keys:[],list_complete:false,cursor:'again'};
   if(a.mode==='null-keys')return {keys:Array(64).fill(null),list_complete:a.lists===64,cursor:'again'};
   if(a.mode==='null-plus')return {keys:Array(64).fill(null),list_complete:a.lists===65,cursor:'again'};
   const page=await kv.list({...options,prefix:prefix+(options.prefix??'')});return {...page,keys:page.keys.map(key=>({...key,name:key.name.slice(prefix.length)}))};},
  async get(key,type){if(type!=='stream')return kv.get(prefix+key,type);a.gets++;let body;
   if(['cleanup','unknown'].includes(a.mode)){const r=await raw('https://assignment-source.example/source/'+id);body=r.body;}else body=await kv.get(prefix+key,'stream');
   if(body)observe(body,a.source,id,a.mode);if(a.mode==='late'){a.getHeld=true;await gate(id,'late');a.getHeld=false;}return body;
  }}};return {call,sql,env};
}
export default {async fetch(request,bindings,ctx){const u=new URL(request.url),id=u.searchParams.get('id')??'cap',caseId=u.searchParams.get('case')??id,mode=u.searchParams.get('mode')??'normal';
 if(u.pathname==='/state')return Response.json(states.get(id)??{absent:true});
 const a={id,mode,intake:fresh(),reply:fresh(),source:fresh(),gets:0,lists:0,done:false,published:false,operationSettled:false,operationFailed:false,hashSettled:0,hashHeld:false,enrolled:0,getHeld:false,releaseObserved:false};
 const x=current(bindings,id,caseId,a);
 if(u.pathname==='/sql')return Response.json(await x.sql('SELECT email,user_json FROM access_users ORDER BY email'));
 if(u.pathname==='/stats')return x.call('/fixture/stats',{});
 if(u.pathname==='/capability'){
  await bindings.POLICY_KV.put('assignment-source/cap/access/assignment-rules/member',JSON.stringify(rule()));
  const kv=await probe(await bindings.POLICY_KV.get('assignment-source/cap/access/assignment-rules/member','stream'));
  const input={email,rules:[rule()],legacy:null,force:false},r=await x.call('/users/reconcile-assignments',input,{...header,'x-fixture-capability':'original'}),incoming=await r.json();
  await (await x.call('/users/put',{email,record})).text();const response=await x.call('/users/reconcile-assignments',input,header),body=response.body,reply=await probe(body);
  return Response.json({kv,incoming,reply:{...reply,sameBody:body===response.body,emptyUrl:response.url==='',status:response.status}});
 }
 if(u.pathname==='/seed'){
  const input=await request.json();if(input.failAfter)await (await x.call('/fixture/fail',{})).text();
  if(input.record!==undefined)await x.sql('INSERT OR REPLACE INTO access_users(email,user_json) VALUES(?,?)',[email,typeof input.record==='string'?input.record:JSON.stringify(input.record)]);
  return Response.json({seeded:true});
 }
 if(u.pathname.startsWith('/v1/')){
  states.set(id,a);const background=[];let hasPrimary=false,primary,response;
  const track=p=>{const outcome=Promise.resolve(p).then(()=>({failed:false}),error=>({failed:true,error}));background.push(outcome);ctx.waitUntil(outcome);};
  try{response=await worker.fetch(request,x.env,{waitUntil:track});}catch(error){hasPrimary=true;primary=error;}
  const errors=[];for(let i=0;i<background.length;i++){const outcome=await background[i];if(outcome.failed)errors.push(outcome.error);}
  if(errors.length)throw new AggregateError(hasPrimary?[primary,...errors]:errors,'public primary and background');if(hasPrimary)throw primary;return response;
 }
 if(u.pathname!=='/start')return new Response(null,{status:404});states.set(id,a);
 const operation=(async()=>{
  if(['late','cleanup','unknown','aggregate','empty-pages','null-keys','null-plus'].includes(mode)){const rules=await listAssignmentRules(x.env);a.published=true;return {count:rules.length};}
  let rules=[rule(Number(u.searchParams.get('version')??1))],legacy=null;
  if(mode==='malformed-groups'||mode==='malformed-policies')rules=[rule(1,{[mode==='malformed-groups'?'groups':'policyIds']:'x'.repeat(300000)})];
  if(mode==='legacy'){rules=Array.from({length:1000},(_,i)=>rule(1,{ruleId:'absent-'+i,generatedGroup:'assignment.'+i,subject:'absent-'+i+'.invalid'}));}
  const result=await authorityCall(x.env,'/users/reconcile-assignments',{email,rules,legacy,force:mode==='legacy'});a.published=true;
  return {changed:result.changed,unknown:result.user.record.unknown,enabled:result.user.record.enabled,tenantId:result.user.record.tenantId,groups:result.user.record.groups,revision:result.user.record.assignmentState?.revision,matched:result.matchedRuleIds.length};
 })();
 const outcome=operation.then(result=>{a.operationSettled=true;return {failed:false,result};},error=>{a.operationSettled=true;a.operationFailed=true;return {failed:true,error};});ctx.waitUntil(outcome);
 if(mode==='unknown'){
  let gateFailed=false,gateError;const lifetime=gate(id,'lifetime').then(()=>{},error=>{gateFailed=true;gateError=error;});ctx.waitUntil(lifetime);await lifetime;
  const errors=[];if(gateFailed)errors.push(gateError);if(a.operationSettled){const actual=await outcome;if(actual.failed)errors.push(actual.error);else errors.push(Error('unknown owner unexpectedly fulfilled'));}
  if(errors.length)throw new AggregateError(errors,'unknown fixture primary and finite control');
  if(!a.source.locked||a.source.unlockAttempts!==1)throw Error('unknown lock witness missing');
  return Response.json({...a,fixtureDiagnostic:true}); // ONLY nonterminating production owner remains. No retirement claim.
 }
 const actual=await outcome;a.done=true;
 // Failure reports are explicit assertions, never an arbitrary error discard.
 if(actual.failed){const primary=actual.error;if((['late','cleanup','intake'].includes(mode)||Number(u.searchParams.get('version'))>=101&&Number(u.searchParams.get('version'))<=104)&&!a.releaseObserved)throw primary;if(primary?.code!=='assignment_materialization_unavailable'&&primary?.code!=='unknown_user')throw primary;return Response.json({...a,error:{status:primary.status,code:primary.code,message:primary.message}});}
 return Response.json({...a,result:actual.result});
},queue:worker.queue};`;

test('actual assignment source admission: original streams, public SQLite/KV semantics, capacity and retirement', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'assignment-source-'));
  const controls = new Map(), tails = new Map(), released = new Set(), arrived = new Set(), outcomes = [], serverErrors = [];
  let runtime, server, releaseFuture = false, hasPrimary = false, primary;
  const release = label => { released.add(label); controls.get(label)?.end('released'); controls.delete(label); };
  const tail = id => { tails.get(id)?.end(' '.repeat(2097153)); tails.delete(id); };
  const releaseAll = () => { releaseFuture = true; for (const label of controls.keys()) release(label); for (const id of tails.keys()) tail(id); };
  t.signal.addEventListener('abort', releaseAll, { once: true });
  t.after(async () => {
    releaseAll(); const errors = [];
    for (const state of await Promise.all(outcomes)) if (state.failed && !(hasPrimary && Object.is(state.error, primary))) errors.push(state.error);
    // The unknown-lock owner intentionally remains unsettled. Disposal below is
    // fixture cleanup only, after ALL finite driver/control/body roots joined.
    try { if (runtime) await runtime.dispose(); } catch (error) { errors.push(error); }
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    t.signal.removeEventListener('abort', releaseAll); errors.push(...serverErrors);
    if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors, 'primary and independent fixture cleanup');
  });
  const track = actual => { const state = { settled: false, failed: false, error: undefined };
    outcomes.push(actual.then(value => { state.settled = true; return { failed: false, value }; }, error => { state.settled = true; state.failed = true; state.error = error; return { failed: true, error }; })); return { actual, state }; };
  try {
    server = createServer((request, response) => {
      response.on('error', error => serverErrors.push(error)); const path = new URL(request.url, 'http://fixture.invalid').pathname;
      if (path.startsWith('/gate/')) { const label = path.slice(6); arrived.add(label); if (releaseFuture || released.has(label)) response.end('released'); else controls.set(label, response); return; }
      if (path.startsWith('/source/')) { const id = path.slice(8); response.writeHead(200, { 'content-type': 'application/json' });
        if (id === 'unknown') { response.end(' '.repeat(2097153)); return; } response.write('{'); if (releaseFuture) response.end(' '.repeat(2097153)); else tails.set(id, response); return; }
      response.writeHead(404); response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const upstream = `export default {fetch(request){const u=new URL(request.url);if(u.origin!=='https://assignment-source.example')throw Error('unexpected fixture egress');return fetch('http://127.0.0.1:${server.address().port}'+u.pathname,{signal:request.signal});}};`;
    runtime = await startWorkerdFixture(directory, router, upstream, { preventEviction: true, bindings: { CLAWROUTER_ADMIN_TOKEN_SHA256: createHash('sha256').update('synthetic-assignment-admin').digest('hex') } });
    const call = (path, body, method = body === undefined ? 'GET' : 'POST') => track((async () => {
      const r = await runtime.dispatchFetch('https://router.example' + path, { method, headers: { authorization: 'Bearer synthetic-assignment-admin', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: await r.json() };
    })());
    const wait = async (id, original, predicate) => {
      const premature = original.actual.then(() => { throw Error('origin fulfilled before required phase'); }); void premature.catch(() => {});
      let last;
      for (let i = 0; i < 1000; i++) {
        const reply = await Promise.race([call('/state?id=' + id).actual, premature]); last = reply.body;
        if (original.state.failed) throw original.state.error;
        if (last.operationSettled) { releaseAll(); const value = await original.actual; assert.equal(value.status, 200, 'origin failed before required phase'); assert.fail('unexpected successful early operation'); }
        if (predicate(last)) return last;
        await Promise.race([delay(10), premature]);
      }
      assert.fail('missing phase: ' + JSON.stringify(last));
    };
    const cap = (await call('/capability').actual).body;
    for (const [name, proof] of Object.entries(cap)) {
      assert.equal(proof.supported, true, 'STOP: ORIGINAL ' + name + ' BYOB prerequisite'); assert.equal(proof.a.eof, true); assert.equal(proof.a.unlocked, true); assert.equal(proof.a.cancels, 0); assert.equal(proof.a.unlocks, 1); assert.ok(proof.a.maxBacking <= 16384);
    }
    assert.equal(cap.incoming.sameBody, true); assert.equal(cap.reply.sameBody, true); assert.equal(cap.reply.status, 200); assert.equal(JSON.parse(cap.reply.text).changed, true);
    const kv = await runtime.getKVNamespace('POLICY_KV', 'router'), email = 'member@example.invalid';
    const base = { enabled: true, role: 'user', tenantId: 'fixture', groups: ['manual'], contentRetentionDisabled: false };
    const rawRule = (i = 1) => ({ version: i, enabled: true, kind: 'email_domain', subject: 'example.invalid', groups: ['automatic'], policyIds: [], priority: 10, revokeOnLoss: true, provenance: 'fixture' });
    const put = (id, key, value) => track(kv.put('assignment-source/' + id + '/' + key, typeof value === 'string' ? value : JSON.stringify(value))).actual;
    const seed = async id => { await put(id, 'access/users/' + email, base); await put(id, 'access/assignment-rules/member', rawRule()); };
    const seedSql = (id, record = base) => call('/seed?id=' + id, { record }).actual;
    const stats = async id => (await call('/stats?case=' + id).actual).body;
    const sql = async id => (await call('/sql?case=' + id).actual).body;
    await seed('public'); let publicReply = await call('/v1/admin/assignment-rules/reconcile?id=public', { all: true }).actual;
    assert.equal(publicReply.status, 200); assert.deepEqual(publicReply.body.results[0].groups, ['automatic', 'manual']);
    const before = (await sql('public'))[0].user_json; assert.equal((await call('/v1/admin/assignment-rules/reconcile?id=public', { email }).actual).status, 200); assert.equal((await sql('public'))[0].user_json, before);
    await seedSql('unknown-fields', { ...base, unknown: 'full reply' });
    const full = (await call('/start?id=unknown-fields').actual).body; assert.equal(full.result.unknown, 'full reply'); assert.equal(JSON.parse((await sql('unknown-fields'))[0].user_json).unknown, undefined);
    const missing = (await call('/start?id=missing').actual).body; assert.equal(missing.error.status, 404); assert.equal(missing.error.code, 'unknown_user');
    for (const mode of ['malformed-groups', 'malformed-policies']) { await seedSql(mode); const reply = (await call('/start?id=' + mode + '&mode=' + mode).actual).body; assert.equal(reply.error.message, 'Assignment materialization failed (protocol)'); assert.equal((await stats(mode)).writes, 0); assert.equal((await stats(mode)).admissions, 0); }
    await seed('large'); await kv.delete('assignment-source/large/access/assignment-rules/member');
    for (let i = 0; i < 1000; i += 32) await Promise.all(Array.from({ length: Math.min(32, 1000 - i) }, (_, n) => put('large', 'access/assignment-rules/absent-' + (i + n), { ...rawRule(), subject: 'absent-' + (i + n) + '.invalid' })));
    publicReply = await call('/v1/admin/assignment-rules/reconcile?id=large', { all: true }).actual; assert.equal(publicReply.status, 200); assert.deepEqual(publicReply.body.results[0].groups, ['manual']);
    const largeState = (await call('/state?id=large').actual).body; assert.ok(largeState.lists >= 16); assert.equal(largeState.source.eof, true); assert.equal(largeState.source.unlocked, true);
    // Existing writer fixture separately proves unchanged >64KiB legacy bytes,
    // UNKNOWN/empty membership, digest order and post-hash current-profile reads.
    for (const mode of ['empty-pages', 'null-keys', 'null-plus']) { const reply = (await call('/start?id=' + mode + '&mode=' + mode).actual).body;
      if (mode === 'null-keys') { assert.equal(reply.result.count, 0); assert.equal(reply.lists, 64); } else { assert.equal(reply.error.message, 'Assignment materialization failed (limit)'); assert.equal(reply.lists, mode === 'empty-pages' ? 128 : 65); } }
    await put('aggregate', 'access/assignment-rules/a', ' '.repeat(1100000) + JSON.stringify(rawRule())); await put('aggregate', 'access/assignment-rules/b', ' '.repeat(1000000) + JSON.stringify(rawRule()));
    const aggregate = (await call('/start?id=aggregate&mode=aggregate').actual).body; assert.equal(aggregate.error.message, 'Assignment materialization failed (limit)'); assert.equal(aggregate.published, false);
    await seedSql('intakes'); const intakes = [];
    for (let i = 0; i < 4; i++) { const id = 'i' + i, work = call('/start?id=' + id + '&case=intakes&mode=intake'); intakes.push(work); const held = await wait(id, work, s => s.intake.readHeld && arrived.has(id + '/intake')); assert.equal(held.intake.nativeSettled, 1); assert.equal(held.intake.pending, 0); }
    assert.equal((await stats('intakes')).admissions, 4); const fifth = (await call('/start?id=i5&case=intakes').actual).body;
    assert.equal(fifth.error.message, 'Assignment materialization failed (limit)'); assert.equal(fifth.intake.reads, 0); assert.equal(fifth.intake.cancels, 1); assert.equal(fifth.intake.unlocked, true);
    for (let i = 0; i < 4; i++) release('i' + i + '/intake'); for (const work of intakes) assert.equal((await work.actual).body.operationFailed, false); assert.equal((await stats('intakes')).admissions, 0);
    await seedSql('fifo'); const hashes = [];
    for (let version = 101; version <= 104; version++) { const id = 'd' + version, work = call('/start?id=' + id + '&case=fifo&version=' + version); hashes.push(work); await wait(id, work, s => s.enrolled === 1); }
    assert.equal((await stats('fifo')).admissions, 4); assert.equal((await call('/state?id=d102').actual).body.hashSettled, 0); assert.equal((await stats('fifo')).writes, 0);
    await seedSql('fifo', { ...base, enabled: false, tenantId: 'current', groups: ['new-manual'] });
    const hashFifth = (await call('/start?id=d105&case=fifo').actual).body; assert.equal(hashFifth.intake.reads, 0); assert.equal(hashFifth.error.status, 503);
    for (let version = 101; version <= 104; version++) { await wait('d' + version, hashes[version - 101], s => s.hashHeld && arrived.has('d' + version + '/hash')); release('d' + version + '/hash'); const reply = (await hashes[version - 101].actual).body; assert.equal(reply.result.enabled, false); assert.equal(reply.result.tenantId, 'current'); }
    assert.equal((await stats('fifo')).admissions, 0);
    await seedSql('sql-after'); await call('/seed?id=sql-after', { failAfter: true }).actual;
    const uncertain = (await call('/start?id=sql-after').actual).body; assert.equal(uncertain.error.message, 'Assignment materialization failed (transport)'); assert.equal((await stats('sql-after')).writes, 1); assert.ok(JSON.parse((await sql('sql-after'))[0].user_json).assignmentState);
    for (const id of ['late', 'cleanup', 'unknown']) await seed(id);
    const late = call('/start?id=late&mode=late'); const lateState = await wait('late', late, s => s.getHeld && arrived.has('late/late')); assert.equal(lateState.source.reads, 0); release('late/late'); assert.equal((await late.actual).body.operationFailed, false);
    const cleanup = call('/start?id=cleanup&mode=cleanup'); const pending = await wait('cleanup', cleanup, s => s.source.reads >= 2 && s.source.pending === 1 && s.source.bytes > 0); assert.equal(pending.published, false);
    tail('cleanup'); const cancel = await wait('cleanup', cleanup, s => s.source.cancelHeld && arrived.has('cleanup/cancel'));
    assert.equal(cancel.source.actualCancel, true); assert.equal(cancel.source.cancels, 1); assert.equal(cancel.source.unlocked, undefined); assert.equal(cancel.source.locked, true); assert.equal(cancel.source.pending, 0); release('cleanup/cancel');
    const rejected = (await cleanup.actual).body; assert.equal(rejected.error.message, 'Assignment materialization failed (cleanup)'); assert.equal(rejected.source.unlocked, true); assert.equal(rejected.source.rootsSettled, true);
    const unknown = call('/start?id=unknown&mode=unknown'); const held = await wait('unknown', unknown, s => s.source.unlockAttempts === 1 && arrived.has('unknown/lifetime'));
    assert.equal(held.source.locked, true); assert.equal(held.operationSettled, false); assert.equal(held.done, false); assert.equal(held.published, false); release('unknown/lifetime');
    const diagnostic = (await unknown.actual).body; assert.equal(diagnostic.fixtureDiagnostic, true); assert.equal(diagnostic.operationSettled, false); assert.equal(diagnostic.source.locked, true);
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});
