import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// First qualify the unchanged producer. This is not a substituted JSON body or
// proof of the later public-provider observation/retirement composition.
const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
export default {async fetch(request,env){
 if(new URL(request.url).pathname!=='/producer')return new Response(null,{status:404});
 const stub=env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName('fixture-soft-status'));
 const policyId='fixture-soft',windowKey=new Date().toISOString().slice(0,7),scopeKey='fixture-scope';
 const charge=await stub.fetch('https://clawrouter.internal/charge',{method:'POST',body:JSON.stringify({
  chargeId:'fixture-charge',policyId,windowKey,scopeKey,amountMicros:17,capability:'llm.chat'})});
 if(!charge.ok)throw Error('real charge failed');
 const receipt=await charge.json();if(receipt.charged!==true||receipt.chargeId!=='fixture-charge')throw Error('real charge receipt');
 const url=new URL('https://clawrouter.internal/status');
 for(const [key,value]of Object.entries({policy_id:policyId,window_key:windowKey,scope_key:scopeKey,limit_micros:'100'}))url.searchParams.set(key,value);
 const response=await stub.fetch(url),body=response.body;
 if(!body)throw Error('real status has no body');
 let reader;
 try{reader=body.getReader({mode:'byob'});}catch{
  await body.cancel();return Response.json({byob:false,status:response.status,unlocked:!body.locked});
 }
 let backing=new Uint8Array(16384),reads=0,bytes=0,maxBacking=0,text='',eof=false,cancels=0,unlocks=0;
 const decoder=new TextDecoder('utf-8',{fatal:true});
 try{
  for(;;){
   if(reads===8192)throw Error('real status read limit');reads++;
   const part=await reader.read(backing),value=part.value;
   if(value){
    maxBacking=Math.max(maxBacking,value.buffer.byteLength);
    if(value.buffer.byteLength>16384||value.byteLength>16384-bytes)throw Error('real status byte limit');
    bytes+=value.byteLength;text+=decoder.decode(value,{stream:true});
    if(value.buffer.byteLength)backing=new Uint8Array(value.buffer);
   }
   if(part.done){eof=true;text+=decoder.decode();break;}
  }
 }finally{try{if(!eof){cancels++;await reader.cancel();}}finally{reader.releaseLock();unlocks++;}}
 return Response.json({byob:true,status:response.status,reads,bytes,maxBacking,eof,cancels,unlocks,
  sameBody:response.body===body,unlocked:!body.locked,value:JSON.parse(text),windowKey});
},queue:worker.queue};`;

test('actual SQLite BudgetLedger status exposes its original bounded BYOB body and charged spent', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'soft-status-workerd-'));
  let runtime, pending, primary;
  const abort = new AbortController();
  const cancel = () => abort.abort(t.signal.reason);
  t.signal.addEventListener('abort', cancel, { once: true });
  t.after(async () => {
    abort.abort(new Error('fixture cleanup'));
    const failures = [];
    try { if (pending) await pending; } catch (error) { if (error !== primary) failures.push(error); }
    try { if (runtime) await runtime.dispose(); } catch (error) { failures.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    t.signal.removeEventListener('abort', cancel);
    if (failures.length) throw new AggregateError(failures, 'status producer fixture cleanup');
  });
  try {
    runtime = await startWorkerdFixture(directory, router,
      `export default {fetch(){throw Error('producer proof forbids external fetch');}};`, { preventEviction: true });
    pending = runtime.dispatchFetch('https://router.example/producer', { signal: abort.signal }).then(async response => {
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    });
    const result = await pending;
    assert.equal(result.byob, true, 'unchanged real BudgetLedger DO status must support BYOB');
    assert.equal(result.status, 200); assert.equal(result.eof, true);
    assert.equal(result.sameBody, true); assert.equal(result.unlocked, true);
    assert.equal(result.cancels, 0); assert.equal(result.unlocks, 1);
    assert.ok(result.reads >= 2 && result.reads <= 8192);
    assert.ok(result.bytes > 0 && result.bytes <= 16384);
    assert.ok(result.maxBacking > 0 && result.maxBacking <= 16384);
    assert.deepEqual(result.value, { policyId: 'fixture-soft', windowKey: result.windowKey,
      limitMicros: 100, spentMicros: 17, remainingMicros: 83 });
  } catch (error) { primary = error; throw error; }
});

// Public-route composition. Healthy replies below are the ORIGINAL SQLite DO
// responses. Fault modes are explicitly substituted/instrumented test seams.
const cases = ['healthy', 'exhausted', 'late', 'zero', 'parallel', 'late-fetch', 'default', 'read-error', 'unknown',
  ...['full', 'partial', 'non-success', 'null', 'unusable', 'below', 'fetch', 'parse', 'resource', 'cleanup'].map(x => 'cache-' + x)];
const publicRouter = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {planBudgetReservation} from './worker/accounting.ts';
import {setHotCacheClock} from './worker/hot-cache.ts';
import {readSoftStatus} from './worker/soft-budget-response.ts';
import {admitSoftStatusRequest} from './worker/soft-budget-json.ts';
const nativeFetch=globalThis.fetch.bind(globalThis),rows=new Map();let initialized,cacheClock,background=0,dispatchPhase='none';
const policy=name=>({enabled:true,generation:'g1',providers:['anthropic'],models:['anthropic/claude-sonnet-5'],tenantId:'fixture',budgetScope:'policy',budgetMode:'soft',
 monthlyBudgetMicros:name==='zero'?0:100000,dailyBudgetMicros:100000,weeklyBudgetMicros:100000,requestCostMicros:1,retainRequestContent:false,
 grantRouting:{eligibleGrants:{anthropic:['soft']},environmentFallback:false,failover:false}});
const connection={providerId:'anthropic',enabled:true,monthlyBudgetMicros:100000};
const plans=name=>planBudgetReservation({policyId:name,policy:policy(name)},'llm.chat',{reserveMicros:0,basis:'none',inputTokens:null,outputTokens:null},connection,Date.now(),true).legs;
const barrier=(id,phase)=>nativeFetch('https://soft-gate.example/barrier/'+id+'/'+phase).then(async r=>{if(!r.ok)throw Error('barrier failure');await r.text();});
globalThis.fetch=(input,init)=>{
 if(String(input)==='https://api.anthropic.com/v1/messages'){
  dispatchPhase='body-parse';const id=JSON.parse(init.body).metadata.user_id;dispatchPhase='row-lookup';
  const row=rows.get(id);row.provider++;row.providerBeforeStatus=row.starts===0;dispatchPhase='invoke';
 }
 return nativeFetch(input,init);
};
function instrument(response,row,mode){
 const body=response.body;if(!body)return response;
 const get=body.getReader.bind(body);
 body.getReader=options=>{
  const reader=get(options),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),unlock=reader.releaseLock.bind(reader);
  row.readerOriginal=true;row.byob=options?.mode==='byob';
  reader.read=(...args)=>{row.reads++;row.readPending++;let p;
   try{p=read(...args);}catch(e){row.readPending--;throw e;}
   return p.then(part=>{row.readPending--;row.readSettled++;if(part.value){row.bytes+=part.value.byteLength;row.maxBacking=Math.max(row.maxBacking,part.value.buffer.byteLength);}return part;},e=>{row.readPending--;row.readSettled++;throw e;});};
  reader.cancel=(...args)=>{row.cancels++;return cancel(...args).then(async()=>{row.actualCancelSettled=true;
   if(mode==='parallel'){row.cancelHeld=true;await barrier(row.id,'cleanup');row.cancelHeld=false;throw Error('deliberate FIRST rejection');}
   if(mode==='cleanup')throw Error('deliberate FIRST rejection');
  });};
  reader.releaseLock=()=>{row.unlocks++;row.unlockAfterRoots=row.readPending===0&&!row.cancelHeld;
   if(mode==='unknown')throw Error('deliberate unknown lock');unlock();row.unlocked=!body.locked;};
  return reader;
 };
 return response;
}
const snapshot=()=>({background,dispatchPhase,rows:Object.fromEntries(rows)});
export default {async fetch(request,bindings,context){
 const env={...bindings},url=new URL(request.url),name=url.searchParams.get('case')??'healthy',id=url.searchParams.get('id')??name;
 cacheClock??=Date.now();setHotCacheClock(()=>cacheClock); // Cache clock only; auth/HTTP clocks keep advancing.
 initialized??=(async()=>{
  await authorityCall(env,'/users/initialize-all',[]);
  await authorityCall(env,'/policies/initialize-all',CASES.map(name=>({policyId:name,policy:policy(name)})));
  await authorityCall(env,'/credentials/initialize-all',CASES.map(name=>({credentialId:name.replaceAll('-','_'),credential:{enabled:true,secretSha256:DIGEST,policyId:name,policyGeneration:'g1'}})));
  await authorityCall(env,'/connections/initialize-all',[connection]);
  await putGrantCredentials(env,'oauth/fixture/soft',{provider:'anthropic',kind:'subscription',enabled:true,accessToken:'synthetic-soft-key',updatedAt:'2026-01-01T00:00:00Z'});
 })();await initialized;
 if(url.pathname==='/state')return Response.json(snapshot());
 if(url.pathname==='/seed'){
  const leg=plans(name).find(x=>x.kind==='policy'),stub=env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(leg.objectName));
  const r=await stub.fetch('https://clawrouter.internal/charge',{method:'POST',body:JSON.stringify({chargeId:'seed-'+name,policyId:leg.request.policyId,windowKey:leg.request.windowKey,scopeKey:leg.request.scopeKey,amountMicros:100000,capability:'llm.chat'})});
  if(!r.ok)throw Error('real seed failed');return Response.json(await r.json());
 }
 if(url.pathname==='/limits'){
  const mode=url.searchParams.get('mode'),row={id,reads:0,readPending:0,readSettled:0,bytes:0,maxBacking:0,cancels:0,unlocks:0};rows.set(id,row);
  if(mode==='query'){try{admitSoftStatusRequest('o','界'.repeat(1024),'界'.repeat(1024),'s','1');return Response.json({denied:false});}catch{return Response.json({denied:true,fetches:0});}}
  const stub=env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName('helper-status')),real=await stub.fetch('https://clawrouter.internal/status?policy_id=p&window_key=w&scope_key=s&limit_micros=1');await real.text();
  // Labelled resource producer; the healthy producer remains unchanged above.
  let text=mode==='wire'? ' '.repeat(16382)+'{}':mode==='wire-plus'?' '.repeat(16383)+'{}':mode==='duplicates'?'{' + Array(65).fill('"a":0').join(',')+'}'
   :mode==='scalar'?'"'+'x'.repeat(1025)+'"':mode==='depth'?'[[[[[]]]]]':mode==='units'?'['+Array(4).fill('"'+'x'.repeat(1024)+'"').join(',')+',"x"]':'{}';
  let response=mode==='huge'?await nativeFetch('https://soft-gate.example/huge'):await nativeFetch('https://soft-gate.example/bytes',{method:'POST',body:text});
  if(mode==='headers')for(let i=0;i<33;i++)response.headers.set('x-'+i,'x');
  if(mode==='header-bytes')response.headers.set('x-large','x'.repeat(4096));
  response=instrument(response,row,'helper');
  if(mode==='reads'||mode==='reads-plus'||mode==='backing'){
   const get=response.body.getReader.bind(response.body);response.body.getReader=options=>{const r=get(options),read=r.read.bind(r);let nativeDone=false,call=0,empty;
    r.read=async view=>{call++;row.ownedCalls=call;if(mode==='backing')return {done:false,value:new Uint8Array(new ArrayBuffer(16385),0,1)};
     if(!nativeDone){const part=await read(view);if(!part.done)return part;nativeDone=true;row.nativeEof=true;empty=part.value?.buffer.byteLength?new Uint8Array(part.value.buffer):new Uint8Array(16384);}
     return {done:call>=(mode==='reads'?8192:8193),value:new Uint8Array(empty.buffer,0,0)};
    };return r;};
  }
  let denied=false;try{await readSoftStatus(async()=>response);}catch{denied=true;}
  return Response.json({denied,row});
 }
 const row={id,case:name,provider:0,starts:0,statuses:[],reserves:0,dispatches:0,charges:0,reads:0,readPending:0,readSettled:0,bytes:0,maxBacking:0,cancels:0,unlocks:0,
  pending:0,done:false,checkRegistered:0,checkSettled:false,status:null,otherLegs:[]};rows.set(id,row);
 const expected=plans(name),ledger=env.BUDGET_LEDGER,mode=url.searchParams.get('mode')??name;
 env.BUDGET_LEDGER={idFromName:n=>ledger.idFromName(n),get:key=>{const stub=ledger.get(key);return {async fetch(input,init){
  const u=new URL(input),path=u.pathname;if(path==='/reserve')row.reserves++;if(path==='/dispatch')row.dispatches++;if(path==='/charge')row.charges++;
  if(path!=='/status')return stub.fetch(input,init);
  const index=row.starts++,leg=expected.find(x=>x.request.scopeKey===u.searchParams.get('scope_key')&&x.request.windowKey===u.searchParams.get('window_key'));
  if(!leg||String(ledger.idFromName(leg.objectName))!==String(key)||u.searchParams.get('policy_id')!==leg.request.policyId||u.searchParams.get('limit_micros')!==String(leg.request.limitMicros))throw Error('plan mismatch');
  row.statuses.push(leg.kind);const real=await stub.fetch(input,init);
  if(index!==0){const legState={id:id+'-'+index,reads:0,readPending:0,readSettled:0,bytes:0,maxBacking:0,cancels:0,unlocks:0};row.otherLegs.push(legState);
   if(mode==='parallel'&&index===1){await real.text();return instrument(await nativeFetch('https://soft-gate.example/bytes',{method:'POST',body:'!'}),legState,'parse');}
   return instrument(real,legState,'ordinary');}
  if(mode==='late-fetch'||mode==='late'||mode==='A'||mode.startsWith('B-')){row.fetchHeld=true;await barrier(id,'status');row.fetchHeld=false;}
  if(mode==='A'||mode==='late'||mode==='late-fetch'||mode==='healthy'||mode==='exhausted')return instrument(real,row,mode);
  await real.text(); // Substitution only AFTER the real SQLite producer completed.
  if(mode==='parallel')return instrument(await nativeFetch('https://soft-gate.example/stream/'+id),row,mode);
  if(mode==='default')return instrument(new Response(new ReadableStream({})),row,mode);
  if(mode==='read-error'){const response=instrument(await nativeFetch('https://soft-gate.example/bytes',{method:'POST',body:'{}'}),row,mode);
   const get=response.body.getReader.bind(response.body);response.body.getReader=opts=>{const r=get(opts);r.read=()=>Promise.reject(Error('injected read failure'));return r;};return response;}
  if(mode==='unknown')return instrument(await nativeFetch('https://soft-gate.example/bytes',{method:'POST',body:'{}'}),row,mode);
  const kind=mode.slice(2);
  if(kind==='fetch')throw Error('injected fetch failure');
  const text=kind==='full'?'{"policyId":"p","windowKey":"w","limitMicros":100000,"spentMicros":0,"remainingMicros":100000}'
    :kind==='partial'||kind==='below'?'{"spentMicros":0}':kind==='null'?'null':kind==='unusable'?'{}':kind==='parse'?'!'
      :kind==='resource'||kind==='cleanup'?' '.repeat(16385):'ignored';
  const response=await nativeFetch('https://soft-gate.example/bytes',{method:'POST',body:text,headers:{'x-status':kind==='non-success'?'503':'206','x-media':'text/plain'}});
  return instrument(response,row,kind);
 }}}};
 const track=p=>{
  row.pending++;background++;if(row.starts===4&&row.checkRegistered===0){row.checkRegistered++;void p.then(()=>{row.checkSettled=true;},()=>{row.checkSettled=true;row.checkRejected=true;});}
  context.waitUntil(p);context.waitUntil(p.then(()=>{row.pending--;background--;},()=>{row.pending--;background--;}));
 };
 try{const response=await worker.fetch(new Request('https://router.example/v1/messages',{method:'POST',headers:request.headers,body:request.body,signal:request.signal}),env,{waitUntil:track});
  row.status=response.status;row.timing=response.headers.get('server-timing');return response;
 }finally{row.done=true;}
},queue:worker.queue};`;

async function statusNetwork() {
  const held = new Map(), arrived = new Set(), released = new Set(), provider = new Map();
  let allReleased = false;
  const finishOrHold = (key, end) => { arrived.add(key); if (allReleased || released.has(key)) end(); else held.set(key, end); };
  const server = createServer(async (req, res) => {
    const path = req.url;
    if (path.startsWith('/barrier/')) { finishOrHold(path, () => res.end('released')); return; }
    if (path.startsWith('/stream/')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"spentMicros":');
      finishOrHold(path, () => res.end(Buffer.from([255]))); return;
    }
    if (path === '/huge') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ignored":"');
      const chunk = Buffer.alloc(16384, 120);
      for (let sent = 0; sent < 33 * 1024 * 1024 && !res.destroyed; sent += chunk.length) {
        if (!res.write(chunk)) await new Promise(resolve => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done); res.once('close', done);
        });
      }
      if (!res.destroyed) res.end('"}'); return;
    }
    if (path === '/bytes') {
      const parts = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 32768) throw Error('fixture request bound'); parts.push(chunk); }
      res.writeHead(Number(req.headers['x-status'] ?? 200), { 'content-type': req.headers['x-media'] ?? 'application/json' }); res.end(Buffer.concat(parts)); return;
    }
    if (path.startsWith('/provider/')) {
      const id = path.slice('/provider/'.length); let size = 0; for await (const chunk of req) size += chunk.length;
      if (size > 16384) throw Error('fixture provider request bound'); provider.set(id, (provider.get(id) ?? 0) + 1);
      const finish = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"synthetic","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}'); };
      if (id === 'parallel' || id === 'exhausted') finishOrHold(path, finish); else finish(); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: 'http://127.0.0.1:' + server.address().port, arrived, provider,
    release(key) { released.add(key); held.get(key)?.(); held.delete(key); },
    releaseAll() { allReleased = true; for (const key of [...held.keys()]) this.release(key); },
    close() { return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); } };
}

test('actual public soft status keeps four owners, cache classification and post-header grace', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'soft-status-public-')), io = await statusNetwork();
  const clients = new Set(), clientFailures = []; let runtime, primary;
  const abort = new AbortController(), cancel = () => { io.releaseAll(); abort.abort(t.signal.reason); };
  t.signal.addEventListener('abort', cancel, { once: true });
  // Register releases/drains before ANY client; future barriers are released too.
  t.after(async () => {
    io.releaseAll(); const errors = [];
    for (const r of await Promise.allSettled([...clients])) if (r.status === 'rejected' && r.reason !== primary) errors.push(r.reason);
    try { if (runtime) await until(async () => { const s = await state(); return s.background === (s.rows.unknown?.pending ?? 0); }); } catch (e) { errors.push(e); }
    try { await runtime?.dispose(); } catch (e) { errors.push(e); }
    try { await io.close(); } catch (e) { errors.push(e); }
    await rm(directory, { recursive: true, force: true }); t.signal.removeEventListener('abort', cancel);
    if (errors.length || clientFailures.some(e => e !== primary)) throw new AggregateError([...clientFailures.filter(e => e !== primary), ...errors], 'public status fixture cleanup');
  });
  const call = async path => { const r = await runtime.dispatchFetch('https://router.example' + path); const text = await r.text(); assert.equal(r.status, 200, text); return JSON.parse(text); };
  const state = () => call('/state');
  const until = async (predicate, originating) => {
    for (let n = 0; n < 600; n++) {
      if (await predicate()) return;
      if (originating?.failure) throw originating.failure;
      if (originating?.done) assert.fail('originating request completed before expected phase');
      await delay(10);
    }
    assert.fail('bounded status fixture arrival: ' + JSON.stringify(await state()));
  };
  const send = (name, id = name, mode = name) => {
    const record = { done: false, failure: null };
    const work = runtime.dispatchFetch('https://router.example/proxy?case=' + name + '&id=' + id + '&mode=' + mode, {
      method: 'POST', signal: abort.signal, headers: { authorization: 'Bearer clawrouter-live-' + name.replaceAll('-', '_') + '-synthetic-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 16, messages: [], metadata: { user_id: id } }),
    }).then(async r => ({ status: r.status, body: await r.text(), timing: r.headers.get('server-timing') }));
    clients.add(work); work.then(() => { record.done = true; clients.delete(work); }, e => { record.failure = e; clients.delete(work); clientFailures.push(e); });
    return { work, record };
  };
  const drain = id => until(async () => { const r = (await state()).rows[id]; return r?.done && r.pending === 0; });
  try {
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('synthetic-secret'))).toString('hex');
    const script = publicRouter.replace('CASES', JSON.stringify(cases)).replace('DIGEST', JSON.stringify(digest));
    const upstream = String.raw`export default {async fetch(request){const u=new URL(request.url);
      if(u.hostname==='soft-gate.example')return fetch(ORIGIN+u.pathname,{method:request.method,headers:request.headers,body:request.body,redirect:'manual'});
      if(u.href!=='https://api.anthropic.com/v1/messages'||request.headers.get('authorization')!=='Bearer synthetic-soft-key')throw Error('unexpected egress');
      const body=await request.json(),id=body.metadata.user_id;if(!/^[a-z0-9-]{1,64}$/.test(id))throw Error('fixture id');
      return fetch(ORIGIN+'/provider/'+id,{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'},redirect:'manual'});
    }};`.replaceAll('ORIGIN', JSON.stringify(io.origin));
    runtime = await startWorkerdFixture(directory, script, upstream, { hotCache: true, preventEviction: true });
    const healthy = await send('healthy').work;
    if(healthy.status!==200){let code='non-json';try{const value=JSON.parse(healthy.body);if(/^[a-z_]{1,64}$/.test(value?.error?.code??''))code=value.error.code;}catch{}
      const s=await state();t.diagnostic(JSON.stringify({phase:'healthy-public',status:healthy.status,code,dispatchPhase:s.dispatchPhase,row:s.rows.healthy}));}
    assert.equal(healthy.status, 200); await drain('healthy');
    let r = (await state()).rows.healthy;
    assert.equal(r.providerBeforeStatus, true); assert.equal(r.provider, 1); assert.equal(r.starts, 4); assert.equal(r.reserves, 0); assert.equal(r.dispatches, 0);
    assert.equal(r.charges, 4); assert.equal(r.checkRegistered, 1); assert.equal(r.checkSettled, true); assert.equal(r.byob, true); assert.equal(r.unlocked, true);
    assert.deepEqual(r.statuses, ['policy', 'daily', 'weekly', 'provider']);
    assert.equal((await send('zero').work).status, 402); await drain('zero'); r = (await state()).rows.zero; assert.equal(r.provider, 0); assert.equal(r.starts, 0);

    await call('/seed?case=exhausted'); const exhausted = send('exhausted');
    await until(async () => (await state()).rows.exhausted?.checkSettled, exhausted.record);
    io.release('/provider/exhausted'); assert.equal((await exhausted.work).status, 402); await drain('exhausted');
    r = (await state()).rows.exhausted; assert.equal(r.provider, 1); assert.equal(r.providerBeforeStatus, true);

    const parallel = send('parallel');
    await until(async () => { const r = (await state()).rows.parallel; return r?.readPending === 1 && r.readSettled >= 1 && r.checkRegistered === 1 && io.arrived.has('/provider/parallel'); }, parallel.record);
    await until(async () => (await state()).rows.parallel.otherLegs.filter(x => x.unlocked).length === 3, parallel.record);
    r = (await state()).rows.parallel; assert.equal(r.starts, 4); assert.equal(r.checkSettled, false); assert.equal(r.cancels, 0);
    io.release('/provider/parallel'); const delivered = await parallel.work; assert.equal(delivered.status, 200);
    assert.ok(Number(delivered.timing.match(/cr-budget;dur=([\d.]+)/)[1]) >= 40);
    r = (await state()).rows.parallel; assert.equal(r.checkSettled, false); assert.equal(r.readPending, 1);
    io.release('/stream/parallel'); await until(async () => { const r = (await state()).rows.parallel; return r.cancelHeld && io.arrived.has('/barrier/parallel/cleanup'); });
    r = (await state()).rows.parallel; assert.equal(r.actualCancelSettled, true); assert.equal(r.cancels, 1); assert.equal(r.unlocks, 0); assert.equal(r.checkSettled, false);
    io.release('/barrier/parallel/cleanup'); await drain('parallel'); r = (await state()).rows.parallel;
    assert.equal(r.cancels, 1); assert.equal(r.unlocks, 1); assert.equal(r.unlockAfterRoots, true); assert.equal(r.unlocked, true); assert.equal(r.checkSettled, true);

    for (const name of ['late-fetch', 'default', 'read-error']) {
      const run = send(name); assert.equal((await run.work).status, 200);
      if (name === 'late-fetch') { r = (await state()).rows[name]; assert.equal(r.checkSettled, false); assert.equal(r.reads, 0); io.release('/barrier/' + name + '/status'); }
      await drain(name); r = (await state()).rows[name]; assert.equal(r.unlocks, 1); assert.equal(r.unlocked, true);
      if (name === 'default') { assert.equal(r.reads, 0); assert.equal(r.cancels, 1); }
      if (name === 'read-error') assert.equal(r.cancels, 1);
    }
    await call('/seed?case=late'); const late = send('late'); assert.equal((await late.work).status, 200);
    assert.equal((await state()).rows.late.checkSettled, false); io.release('/barrier/late/status'); await drain('late');
    assert.equal((await send('late', 'late-next', 'healthy').work).status, 402); await drain('late-next'); assert.equal((await state()).rows['late-next'].provider, 0);

    for (const kind of ['full', 'partial', 'non-success', 'null', 'unusable', 'below', 'fetch', 'parse', 'resource', 'cleanup']) {
      const name = 'cache-' + kind, a = name + '-a', b = name + '-b', c = name + '-c';
      await call('/seed?case=' + name);
      const A = send(name, a, 'A'), B = send(name, b, 'B-' + kind);
      assert.equal((await A.work).status, 200); assert.equal((await B.work).status, 200);
      let s = await state(); assert.equal(s.rows[a].checkSettled, false); assert.equal(s.rows[b].checkSettled, false);
      io.release('/barrier/' + a + '/status'); await drain(a);
      io.release('/barrier/' + b + '/status'); await drain(b);
      const C = await send(name, c, 'healthy').work, retained = ['fetch', 'parse', 'resource', 'cleanup'].includes(kind);
      // Clean B permits a new dispatch; its real SQL observation can deny C at delivery.
      await drain(c); s = await state(); assert.equal(s.rows[c].provider, retained ? 0 : 1); if(retained)assert.equal(C.status,402);else assert.ok([200,402].includes(C.status));
      assert.equal(s.rows[a].provider, 1); assert.equal(s.rows[b].provider, 1); assert.equal(s.rows[b].checkRegistered, 1);
      if (kind === 'cleanup') { assert.equal(s.rows[b].cancels, 1); assert.equal(s.rows[b].unlocked, true); }
    }
    for (const mode of ['wire', 'wire-plus', 'duplicates', 'scalar', 'depth', 'units', 'reads', 'reads-plus', 'backing', 'headers', 'header-bytes', 'huge', 'query']) {
      const result = await call('/limits?id=limit-' + mode + '&mode=' + mode);
      assert.equal(result.denied, !['wire', 'reads'].includes(mode), mode);
      if (mode === 'query') assert.equal(result.fetches, 0);
      else { assert.equal(result.row.unlocked, true); assert.equal(result.row.unlocks, 1); if (mode.startsWith('reads')) { assert.equal(result.row.nativeEof, true); assert.equal(result.row.ownedCalls, 8192); }
        if(mode==='huge'){assert.ok(result.row.bytes<=32768);assert.ok(result.row.maxBacking<=16384);assert.equal(result.row.cancels,1);} }
    }
    // LAST: deliberately unknown lock remains owned, not "retired by dispose".
    assert.equal((await send('unknown').work).status, 200);
    await until(async () => (await state()).rows.unknown.unlocks === 1);
    r = (await state()).rows.unknown; assert.equal(r.checkSettled, false); assert.notEqual(r.unlocked, true); assert.ok(r.pending > 0);
  } catch (error) { primary = error; throw error; }
});
