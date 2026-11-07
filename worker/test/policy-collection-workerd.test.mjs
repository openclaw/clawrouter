import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

async function signing() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'policy-collection' };
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const value = part({ alg: 'RS256', kid: jwk.kid }) + '.' + part({ iss: 'https://policy-fixture.cloudflareaccess.com', aud: 'policy-fixture', email: 'policy@example.invalid', exp: Math.floor(Date.now() / 1000) + 600 });
  return { jwk, token: value + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(value))).toString('base64url') };
}

const router = String.raw`
import worker from './worker/index.ts';
import {PolicyBindingIndexObject as Base,authorityCall} from './worker/authority.ts';
import {sessionPolicies} from './worker/access.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
const header={'x-clawrouter-policy-collection':'v1'},email='policy@example.invalid',raw=globalThis.fetch.bind(globalThis),states=new Map();
const fresh=()=>({reads:0,nativeSettled:0,pending:0,bytes:0,maxBacking:0,byob:false,eof:false,locked:false,cancels:0,actualCancel:false,cancelHeld:false,unlocks:0,unlockAttempts:0,readHeld:false});
async function gate(id,phase){const response=await raw('https://policy-source.example/gate/'+id+'/'+phase);await response.text();if(!response.ok)throw Error('fixture gate failed');const a=states.get(id);if(a&&phase!=='abort')a.releaseObserved=true;}
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
const policy=(extra={})=>({enabled:true,generation:'fixture',providers:[],budgetScope:'principal',retainRequestContent:false,...extra});
const binding=(id,type='group',principal='team',priority=5,enabled=true)=>({policyId:id,principalType:type,principalId:principal,priority,enabled});
export class PolicyBindingIndexObject extends Base{
 constructor(ctx,env){super(ctx,env);this.fixtureSql=ctx.storage.sql;this.metrics={writes:0,markers:0,queries:0,inits:0};this.failAfter=false;
  const exec=this.fixtureSql.exec.bind(this.fixtureSql);this.sql={exec:(query,...args)=>{const result=exec(query,...args);
   if(/^INSERT OR REPLACE INTO (access_policies|policy_binding_entries)/.test(query)){this.metrics.writes++;if(this.failAfter)throw Error('labelled SQL after-commit failure');}
   if(/^INSERT OR IGNORE INTO policy_binding_(principals|meta)/.test(query))this.metrics.markers++;
   return result;}};
 }
 async fetch(request){const path=new URL(request.url).pathname;
  if(path==='/fixture/sql'){const x=await request.json();return Response.json([...this.fixtureSql.exec(x.query,...(x.args??[]))]);}
  if(path==='/fixture/stats')return Response.json(this.metrics);
  if(path==='/fixture/fail'){this.failAfter=true;return new Response('set');}
  if(request.headers.get('x-fixture-capability')==='original'){const body=request.body,result=await probe(body);return Response.json({...result,sameBody:body===request.body,path});}
  if(request.headers.has('x-clawrouter-policy-collection')){
   const a=fresh();if(path==='/resolve'||path==='/policies/resolve'){this.metrics.queries++;this.metrics.query=a;}else{this.metrics.inits++;this.metrics.init=a;}
   if(request.body)observe(request.body,a,'','');
  }
  return super.fetch(request);
 }
}
function current(bindings,id,a,mode){
 const kv=bindings.POLICY_KV,ns=bindings.ACCESS_CONTROL,prefix='policy-source/'+id+'/',stub=ns.get(ns.idFromName('policy-source/'+id));
 const call=(path,value,headers)=>stub.fetch('https://clawrouter.internal'+path,{method:'POST',body:typeof value==='string'?value:JSON.stringify(value),headers});
 const sql=async(query,args=[])=>{const r=await call('/fixture/sql',{query,args});const value=await r.json();if(!r.ok)throw Error('fixture SQL failed');return value;};
 const env={...bindings,ACCESS_CONTROL:{idFromName:n=>n,get:()=>({async fetch(url,init){
  const selected=new Headers(init.headers).has('x-clawrouter-policy-collection'),response=await stub.fetch(url,init);
  if(selected&&response.body){a.reply=fresh();observe(response.body,a.reply,id);}
  if(selected&&mode==='late-reply'){a.fetchHeld=true;await gate(id,'late');a.fetchHeld=false;}
  return response; // ORIGINAL healthy DO Response/body, never a relay/substitute.
 }})},POLICY_KV:{
  put:(key,...args)=>kv.put(prefix+key,...args),delete:key=>kv.delete(prefix+key),
  async list(options){if(options.prefix?.startsWith('access/bindings/'))a.lists++;
   const page=await kv.list({...options,prefix:prefix+(options.prefix??'')});
   return {...page,keys:page.keys.map(key=>({...key,name:key.name.slice(prefix.length)}))};
  },
  async get(key,type){if(key.startsWith('local/'))a.localReads++;if(type!=='stream')return kv.get(prefix+key,type);
   a.gets++;if(key.startsWith('keys/'))a.legacyReads++;
   let body;
   if(['cleanup','unknown'].includes(mode)){const response=await raw('https://policy-source.example/source/'+id);body=response.body;}
   else if(mode==='default')body=new ReadableStream({},{highWaterMark:0});
   else body=await kv.get(prefix+key,'stream');
   if(body){a.source=fresh();observe(body,a.source,id,mode);}
   if(mode==='late-kv'){a.getHeld=true;await gate(id,'late');a.getHeld=false;}
   if(mode==='canonical'&&key==='policies/p')await sql('INSERT INTO access_policies(policy_id,policy_json) VALUES(?,?)',['p',JSON.stringify(policy({generation:'canonical',unknown:{policyId:'x'.repeat(1025),principalId:'x'.repeat(1025),policyIds:'x'.repeat(1025)}}))]);
   return body;
  }
 }};
 return {env,call,sql,prefix};
}
export default {async fetch(request,bindings,ctx){
 const u=new URL(request.url),id=u.searchParams.get('id')??'cap',mode=u.searchParams.get('mode')??'cold';
 if(u.pathname==='/state')return Response.json(states.get(id)??{absent:true});
 const a={id,mode,source:fresh(),reply:fresh(),gets:0,lists:0,legacyReads:0,localReads:0,done:false,published:false,operationSettled:false,failed:false,reason:null,releaseObserved:false,fetchHeld:false,getHeld:false,aborted:false};
 const x=current(bindings,id,a,mode);
 if(u.pathname==='/capability'){
  const sample=policy();await bindings.POLICY_KV.put(x.prefix+'policies/p',JSON.stringify(sample));
  const kv=await probe(await bindings.POLICY_KV.get(x.prefix+'policies/p','stream')),requests=[];
  for(const[path,body]of[['/resolve',{principals:[]}],['/initialize',[]],['/policies/resolve',{policyIds:[]}],['/policies/initialize',[]]]){
   const response=await x.call(path,body,{...header,'x-fixture-capability':'original'});requests.push(await response.json());
  }
  const response=await x.call('/policies/resolve',{policyIds:[]},header),body=response.body,reply=await probe(body);
  return Response.json({kv,requests,reply:{...reply,sameBody:body===response.body,status:response.status,emptyUrl:response.url===''}});
 }
 if(u.pathname==='/setup'){
  const put=(key,value)=>bindings.POLICY_KV.put(x.prefix+key,typeof value==='string'?value:JSON.stringify(value));
  const groups=mode==='principals-plus'?Array.from({length:1024},(_,i)=>'team-'+i):['team','other'];
  await (await x.call('/users/initialize-all',[{email,record:{enabled:true,role:'user',groups,contentRetentionDisabled:false,
   assignmentState:{version:1,revision:'[]',assignments:{},updatedAt:null},budgetOverrides:{p:{dailyBudgetMicros:0,weeklyBudgetMicros:null,unknown:{policyId:'x'.repeat(1025)}}}}}])).text();
  if(['legacy-false','legacy-zero','legacy-null'].includes(mode)){
   await put('access/bindings/group/team/p',binding('p'));await put('policies/p',mode==='legacy-false'?'false':mode==='legacy-zero'?'0':'null');await put('keys/p',policy({generation:'legacy'}));
  }else if(mode==='aggregate'){
   for(const[principal,key]of[['team','a'],['other','b']])await put('access/bindings/group/'+principal+'/'+key,' '.repeat(1500000)+JSON.stringify(binding('p','group',principal)));
   await put('access/bindings/user/'+encodeURIComponent(email)+'/c',' '.repeat(1500000)+JSON.stringify(binding('p','user',email)));
  }else{
   await put('access/bindings/user/'+encodeURIComponent(email)+'/p',binding('p','user',email,10));
   await put('access/bindings/group/team/p',binding('p','group','team',20));
   await put('access/bindings/group/team/q',binding('q'));await put('access/bindings/group/team/r',binding('r'));
   for(let i=0;i<64;i++)await put('access/bindings/group/team/disabled-'+i,binding('disabled-'+i,'group','team',0,false));
   for(const key of ['p','q','r'])await put('policies/'+key,policy(key==='p'&&mode==='canonical'?{requestCostsMicros:'ignored-invalid'}:{}));
  }
  if(mode==='sql-limit')await x.sql('INSERT INTO access_policies(policy_id,policy_json) VALUES(?,?)',['p',' '.repeat(2097152)+'{}']);
  if(mode==='unknown-sql')await x.sql('INSERT INTO access_policies(policy_id,policy_json) VALUES(?,?)',['p',JSON.stringify(policy({unknown:{policyId:'x'.repeat(1025),principalId:'x'.repeat(1025),policyIds:'x'.repeat(1025)}}))]);
  if(mode==='sql-fail')await(await x.call('/fixture/fail',{})).text();
  const stats=await(await x.call('/fixture/stats',{})).json();return Response.json({ready:true,markers:stats.markers});
 }
 if(u.pathname!=='/start')return new Response(null,{status:404});
 states.set(id,a);
 const controller=new AbortController();let controlOutcome;
 const control=mode==='late-reply'?gate(id,'abort').then(()=>{controller.abort();a.aborted=true;}).then(()=>{controlOutcome={failed:false};},error=>{controlOutcome={failed:true,error};}):Promise.resolve();
 ctx.waitUntil(control);
 const operation=(async()=>{
  if(mode==='late-reply')return await authorityCall(x.env,'/policies/resolve',{policyIds:[]},'policy-bindings',controller.signal);
  if(mode==='init-limit')return await authorityCall(x.env,'/policies/initialize',{entries:[{policyId:'p',policy:{providers:Array(32760).fill('x')}}],retainRequestContentDefault:false});
  if(mode==='sql-fail')return await authorityCall(x.env,'/policies/initialize',[{policyId:'one',policy:policy()},{policyId:'two',policy:policy()}]);
  if(mode==='public'||mode==='principals-plus'){
   const background=[];let hasPrimary=false,primary,result;
   const track=p=>{const observed=Promise.resolve(p).then(()=>({failed:false}),error=>({failed:true,error}));background.push(observed);ctx.waitUntil(observed);};
   try{const response=await worker.fetch(new Request('https://router.example/v1/session/usage?budgets_only=true',{headers:{'cf-access-jwt-assertion':request.headers.get('x-fixture-token')}}),x.env,{waitUntil:track});
    const body=await response.json();result={status:response.status,code:body.error?.code,ids:body.policies?.map(p=>p.policyId),daily:body.policies?.find(p=>p.policyId==='p')?.dailyBudgetMicros,weekly:body.policies?.find(p=>p.policyId==='p')?.weeklyBudgetMicros};
   }catch(error){hasPrimary=true;primary=error;}
   const errors=[];for(let i=0;i<background.length;i++){const state=await background[i];if(state.failed)errors.push(state.error);}
   if(errors.length)throw new AggregateError(hasPrimary?[primary,...errors]:errors,'public primary and background');if(hasPrimary)throw primary;
   a.published=result.status===200;return result;
  }
  const session={email,groups:['team','other'],budgetOverrides:{p:{dailyBudgetMicros:0,weeklyBudgetMicros:null,unknown:{policyId:'x'.repeat(1025)}}}};
  const policies=await sessionPolicies(session,x.env);a.published=true;
  const p=policies.find(p=>p.policyId==='p')?.policy;
  return {ids:policies.map(p=>p.policyId),daily:p?.dailyBudgetMicros,weekly:p?.weeklyBudgetMicros,overrideUnknown:p?.budgetOverride?.unknown?.policyId.length,
   unknown:p?.unknown?.policyId.length,unknownPrincipal:p?.unknown?.principalId.length,unknownIds:p?.unknown?.policyIds.length,generation:p?.generation};
 })();
 let settled;
 const observed=operation.then(value=>{a.operationSettled=true;settled={failed:false,value};return settled;},error=>{
  a.operationSettled=true;a.failed=true;a.reason=['limit','protocol','transport','cleanup'].find(k=>error?.message==='Policy collection failed ('+k+')')??(error?.code==='authority_ack_failed'?'ack':error?.code==='policy_collection_query_failed'?'query':'unexpected');
  settled={failed:true,error};return settled;
 });ctx.waitUntil(observed.then(()=>undefined));
 if(mode==='unknown'){
  let gateFailed=false,gateError;try{await gate(id,'lifetime');}catch(error){gateFailed=true;gateError=error;}
  await control;const errors=[];if(gateFailed)errors.push(gateError);if(controlOutcome?.failed)errors.push(controlOutcome.error);
  if(settled){if(settled.failed)errors.unshift(settled.error);else errors.unshift(Error('unknown owner unexpectedly fulfilled'));}
  if(errors.length)throw new AggregateError(errors,'unknown primary and finite control');
  if(!a.source.locked||a.source.unlockAttempts!==1||a.operationSettled||a.published||a.source.pending||a.source.cancelHeld)throw Error('unknown owner held invariant');
  return Response.json({fixtureDiagnostic:true,...a}); // NO production retirement or successful query claim.
 }
 const result=await observed,held=['late-kv','late-reply','cleanup'].includes(mode),early=held&&!a.releaseObserved;
 // Capture the ORIGINAL early reason before control/inspection can hide it.
 let hasPrimary=early,primary=early?(result.failed?result.error:Error('held work completed before release')):undefined;
 const errors=[];await control;if(controlOutcome?.failed)errors.push(controlOutcome.error);
 let stats,stored;try{const r=await x.call('/fixture/stats',{});stats=await r.json();stored=await x.sql('SELECT policy_id FROM access_policies ORDER BY policy_id');}catch(error){errors.push(error);}
 if(errors.length)throw new AggregateError(hasPrimary?[primary,...errors]:result.failed?[result.error,...errors]:errors,'operation and independent inspection/control');
 if(hasPrimary)throw primary;
 if(result.failed&&a.reason==='unexpected')throw result.error;
 a.done=true;
 return Response.json({...a,result:result.failed?null:result.value,code:result.failed?result.error?.code:undefined,outcome:result.failed?result.error?.outcome:undefined,stats,stored:stored.map(p=>p.policy_id)});
}};
`;

const upstream = `export default {fetch(request){const u=new URL(request.url);return fetch('http://127.0.0.1:PORT'+(u.pathname.endsWith('/certs')?'/jwks':u.pathname),{method:request.method,headers:request.headers,body:request.body,duplex:'half',redirect:'manual'});}};`;

test('policy collection ORIGINAL KV/request/reply prerequisites and real public/SQLite/KV materialization', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'policy-collection-')), waiting = new Map(), tails = new Map(), released = new Set(), arrived = new Set(), outcomes = [], serverErrors = [];
  let runtime, server, releaseFuture = false, primary, hasPrimary = false;
  const release = key => { released.add(key); const response = waiting.get(key); if (response) { waiting.delete(key); response.end('released'); } };
  const releaseTail = id => { const response = tails.get(id); if (response) { tails.delete(id); response.end(' '.repeat(2097153)); } };
  const releaseHeld = id => { for (const phase of ['abort', 'late', 'cancel', 'lifetime']) release(id + '/' + phase); releaseTail(id); };
  const releaseAll = () => { releaseFuture = true; for (const key of waiting.keys()) release(key); for (const id of tails.keys()) releaseTail(id); };
  t.signal.addEventListener('abort', releaseAll, { once: true });
  t.after(async () => {
    releaseAll(); const errors = [];
    for (const result of await Promise.all(outcomes)) if (result.failed) errors.push(result.error);
    // All finite client/control/body/read/cancel roots have joined. Only the
    // explicitly unknown production owner may remain; disposal is fixture cleanup.
    try { if (runtime) await runtime.dispose(); } catch (error) { errors.push(error); }
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    t.signal.removeEventListener('abort', releaseAll); errors.push(...serverErrors);
    if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors, 'primary and independent fixture cleanup');
  });
  const track = actual => {
    const state = { settled: false, failed: false, error: undefined };
    outcomes.push(actual.then(value => { state.settled = true; return { failed: false, value }; }, error => { state.settled = true; state.failed = true; state.error = error; return { failed: true, error }; }));
    return { actual, state };
  };
  try {
    const signed = await signing();
    server = createServer((request, response) => {
      response.on('error', error => serverErrors.push(error)); const path = new URL(request.url, 'http://fixture.invalid').pathname;
      if (path === '/jwks') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ keys: [signed.jwk] })); return; }
      if (path.startsWith('/gate/')) { const key = path.slice(6); arrived.add(key); if (releaseFuture || released.has(key)) response.end('released'); else waiting.set(key, response); return; }
      if (path.startsWith('/source/')) {
        const id = path.slice(8); response.writeHead(200, { 'content-type': 'application/json' });
        if (id === 'unknown') { response.end(' '.repeat(2097153)); return; }
        response.write(' '); if (releaseFuture) response.end(' '.repeat(2097153)); else tails.set(id, response); return;
      }
      response.writeHead(404); response.end();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    runtime = await startWorkerdFixture(directory, router, upstream.replace('PORT', String(server.address().port)), { preventEviction: true,
      bindings: { CLAWROUTER_ACCESS_TEAM_DOMAIN: 'https://policy-fixture.cloudflareaccess.com', CLAWROUTER_ACCESS_AUD: 'policy-fixture' } });
    const call = path => track((async () => {
      const response = await runtime.dispatchFetch('https://fixture.invalid' + path, { headers: { 'x-fixture-token': signed.token } });
      const value = await response.json(); assert.equal(response.status, 200); return value;
    })()).actual;
    const start = (id, mode) => track(call('/start?id=' + id + '&mode=' + mode));
    const wait = async (id, pending, predicate) => {
      const until = Date.now() + 10000; let last;
      while (Date.now() < until) {
        if (pending.state.settled) { if (pending.state.failed) throw pending.state.error; throw Error('origin completed before phase'); }
        last = await Promise.race([call('/state?id=' + id), pending.actual.then(() => { throw Error('origin completed before phase'); }, error => { throw error; })]);
        if (last.operationSettled) {
          releaseHeld(id);
          // The originating invocation rethrows the actual early failure, including
          // undefined, after its finite control/inspection joins. Never substitute it.
          await pending.actual; throw Error('origin unexpectedly completed before phase');
        }
        if (predicate(last)) return last;
        await Promise.race([delay(10), pending.actual.then(() => { throw Error('origin completed before phase'); }, error => { throw error; })]);
      }
      assert.fail('missing bounded phase: ' + JSON.stringify(last));
    };
    const capability = await call('/capability');
    for (const proof of [capability.kv, ...capability.requests, capability.reply]) {
      assert.equal(proof.supported, true, 'STOP: ORIGINAL producer BYOB prerequisite');
      assert.equal(proof.a.byob, true); assert.equal(proof.a.eof, true); assert.equal(proof.a.unlocked, true);
      assert.equal(proof.a.cancels, 0); assert.equal(proof.a.unlocks, 1); assert.ok(proof.a.maxBacking <= 16384);
    }
    assert.deepEqual(capability.requests.map(proof => proof.path), ['/resolve', '/initialize', '/policies/resolve', '/policies/initialize']);
    assert.ok(capability.requests.every(proof => proof.sameBody)); assert.equal(capability.reply.sameBody, true); assert.equal(capability.reply.status, 200);
    assert.equal(JSON.parse(capability.kv.text).enabled, true); assert.deepEqual(JSON.parse(capability.reply.text).policies, []);
    // Capability consumption above is separate from actual production semantics.
    for (const mode of ['cold', 'public', 'principals-plus', 'unknown-sql', 'canonical', 'legacy-false', 'legacy-zero', 'legacy-null', 'aggregate', 'sql-limit', 'init-limit', 'sql-fail', 'default']) {
      const setup = await call('/setup?id=' + mode + '&mode=' + mode), result = await call('/start?id=' + mode + '&mode=' + mode);
      assert.equal(setup.ready, true); assert.equal(result.done, true, mode);
      if (['cold', 'public', 'unknown-sql', 'canonical'].includes(mode)) {
        assert.equal(result.failed, false, mode); assert.deepEqual(result.result.ids, ['q', 'r', 'p']);
        assert.equal(result.result.daily, 0); assert.equal(result.result.weekly, null); assert.ok(result.lists >= 4);
        assert.equal(result.stats.query.byob, true); assert.equal(result.stats.query.eof, true); assert.equal(result.stats.query.unlocked, true);
        assert.equal(result.stats.init.byob, true); assert.equal(result.stats.init.eof, true); assert.equal(result.stats.init.unlocked, true);
        assert.equal(result.reply.eof, true); assert.equal(result.reply.unlocked, true);
        if (mode === 'public') assert.equal(result.result.status, 200);
        else assert.equal(result.result.overrideUnknown, 1025);
        if (mode === 'unknown-sql' || mode === 'canonical') for (const field of ['unknown', 'unknownPrincipal', 'unknownIds']) assert.equal(result.result[field], 1025);
        if (mode === 'canonical') assert.equal(result.result.generation, 'canonical');
      } else if (mode.startsWith('legacy-')) {
        assert.equal(result.failed, false); assert.deepEqual(result.result.ids, mode === 'legacy-null' ? ['p'] : []);
        assert.equal(result.legacyReads, mode === 'legacy-null' ? 1 : 0);
      } else if (mode === 'principals-plus') {
        assert.equal(result.failed, false); assert.equal(result.result.status, 503); assert.equal(result.result.code, 'policy_collection_unavailable');
        assert.equal(result.lists, 0); assert.equal(result.gets, 0); assert.equal(result.localReads, 0); assert.equal(result.stats.writes, 0);
      } else {
        assert.equal(result.failed, true, mode);
        assert.equal(result.reason, mode === 'aggregate' ? 'limit' : mode === 'sql-limit' ? 'query' : mode === 'default' ? 'transport' : 'ack');
        if (mode === 'aggregate') { assert.equal(result.gets, 3); assert.ok(result.source.bytes > 0, 'third aggregate record was read'); }
        if (mode === 'aggregate' || mode === 'init-limit' || mode === 'default') { assert.equal(result.stats.writes, 0); assert.equal(result.stats.markers, setup.markers); }
        if (mode === 'sql-fail') { assert.equal(result.stats.writes, 1); assert.deepEqual(result.stored, ['one']); }
        if (mode === 'init-limit' || mode === 'sql-fail') assert.equal(result.outcome, 'OUTCOME_UNKNOWN');
        if (mode === 'default') { assert.equal(result.source.reads, 0); assert.equal(result.source.cancels, 1); assert.equal(result.source.unlocked, true); }
      }
    }
    await call('/setup?id=late-kv&mode=late-kv'); const late = start('late-kv', 'late-kv');
    const lateState = await wait('late-kv', late, s => s.getHeld && arrived.has('late-kv/late'));
    assert.equal(lateState.source.reads, 0); assert.equal(lateState.published, false); release('late-kv/late');
    assert.equal((await late.actual).failed, false);
    const lateReply = start('late-reply', 'late-reply');
    await wait('late-reply', lateReply, s => s.fetchHeld && arrived.has('late-reply/late') && arrived.has('late-reply/abort'));
    release('late-reply/abort'); const aborted = await wait('late-reply', lateReply, s => s.aborted);
    assert.equal(aborted.reply.reads, 0); assert.equal(aborted.operationSettled, false);
    release('late-reply/late'); const disposed = await lateReply.actual;
    assert.equal(disposed.reason, 'transport'); assert.equal(disposed.reply.reads, 0); assert.equal(disposed.reply.cancels, 1); assert.equal(disposed.reply.unlocked, true);
    await call('/setup?id=cleanup&mode=cleanup'); const cleanup = start('cleanup', 'cleanup');
    const reading = await wait('cleanup', cleanup, s => s.source.reads >= 2 && s.source.pending === 1 && s.source.bytes > 0);
    assert.equal(reading.operationSettled, false); // TRUE native pending read: Node withheld the next bytes.
    releaseTail('cleanup');
    const cancelling = await wait('cleanup', cleanup, s => s.source.cancelHeld && arrived.has('cleanup/cancel'));
    assert.equal(cancelling.source.actualCancel, true); assert.equal(cancelling.source.cancels, 1); assert.equal(cancelling.source.pending, 0);
    assert.equal(cancelling.source.unlocks, 0); assert.equal(cancelling.source.locked, true); assert.equal(cancelling.published, false);
    release('cleanup/cancel'); const retired = await cleanup.actual;
    assert.equal(retired.reason, 'cleanup'); assert.equal(retired.source.unlocked, true); assert.equal(retired.source.rootsSettled, true); assert.equal(retired.stats.writes, 0);
    await call('/setup?id=unknown&mode=unknown'); const unknown = start('unknown', 'unknown');
    const held = await wait('unknown', unknown, s => s.source.unlockAttempts === 1 && arrived.has('unknown/lifetime'));
    assert.equal(held.source.locked, true); assert.equal(held.source.pending, 0); assert.equal(held.published, false); assert.equal(held.operationSettled, false);
    release('unknown/lifetime'); const diagnostic = await unknown.actual;
    assert.equal(diagnostic.fixtureDiagnostic, true); assert.equal(diagnostic.source.locked, true); assert.equal(diagnostic.operationSettled, false);
  } catch (error) { primary = error; hasPrimary = true; throw error; }
});
