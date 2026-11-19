import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// Qualify the unchanged producer before introducing the bounded ACK consumer.
// Read the original default policy-bindings DO response, without a relay or clone.
const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
export default {async fetch(request,env){
 if(new URL(request.url).pathname!=='/producer')return new Response(null,{status:404});
 const stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings'));
 const response=await stub.fetch('https://clawrouter.internal/initialize-all',{method:'POST',body:'[]'}),body=response.body;
 if(!body)throw Error('real initialization ACK has no body');
 let reader;
 try{reader=body.getReader({mode:'byob'});}catch{
  await body.cancel();return Response.json({byob:false,status:response.status,unlocked:!body.locked});
 }
 let backing=new Uint8Array(128),reads=0,bytes=0,maxBacking=0,text='',eof=false,cancels=0,unlocks=0;
 const decoder=new TextDecoder();
 try{
  for(;;){
   if(reads===8192)throw Error('real ACK read limit');reads++;
   const part=await reader.read(backing),value=part.value;
   if(value){
    maxBacking=Math.max(maxBacking,value.buffer.byteLength);
    if(value.buffer.byteLength>128||value.byteLength>128-bytes)throw Error('real ACK byte limit');
    bytes+=value.byteLength;text+=decoder.decode(value,{stream:true});
    if(value.buffer.byteLength)backing=new Uint8Array(value.buffer);
   }
   if(part.done){eof=true;text+=decoder.decode();break;}
  }
 }finally{try{if(!eof){cancels++;await reader.cancel();}}finally{reader.releaseLock();unlocks++;}}
 return Response.json({byob:true,status:response.status,reads,bytes,maxBacking,eof,cancels,unlocks,
  sameBody:response.body===body,unlocked:!body.locked,value:text});
},queue:worker.queue};`;

test('actual SQLite policy-bindings initialization exposes its original 128-byte BYOB ACK', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'authority-ack-workerd-'));
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
    if (failures.length) throw new AggregateError(failures, 'ACK producer fixture cleanup');
  });
  try {
    runtime = await startWorkerdFixture(directory, router,
      `export default {fetch(){throw Error('producer proof forbids external fetch');}};`, { preventEviction: true });
    pending = runtime.dispatchFetch('https://router.example/producer', { signal: abort.signal }).then(async response => {
      assert.equal(response.status, 200);
      return response.json();
    });
    const result = await pending;
    assert.equal(result.byob, true, 'unchanged PolicyBindingIndexObject initialization ACK must support BYOB');
    assert.equal(result.status, 200); assert.equal(result.eof, true);
    assert.equal(result.sameBody, true); assert.equal(result.unlocked, true);
    assert.equal(result.cancels, 0); assert.equal(result.unlocks, 1);
    assert.ok(result.reads >= 1 && result.reads <= 8192);
    assert.equal(result.bytes, 11); assert.ok(result.maxBacking > 0 && result.maxBacking <= 128);
    assert.equal(result.value, 'initialized');
  } catch (error) { primary = error; throw error; }
});

const ownedRouter = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {resolveAdmission,flushSelections} from './worker/admission-cache.ts';
import {pendingBackgroundWork,backgroundMark} from './worker/hot-cache.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
const raw=globalThis.fetch.bind(globalThis);let active,initialized;
const gate=(a,part)=>raw('https://ack-fixture.example/gate/'+a.mode+'/'+part).then(async r=>{if(!r.ok)throw Error('gate failed');await r.text();});
const view=()=>active?{mode:active.mode,calls:active.calls,committed:active.committed,done:active.done,value:active.value,code:active.code,reason:active.reason,outcome:active.outcome,
 reads:active.reads,nativeReads:active.nativeReads,nativeEOF:active.nativeEOF,pending:active.pending,settled:active.settled,bytes:active.bytes,maxBacking:active.maxBacking,cancels:active.cancels,unlocks:active.unlocks,
 cancelHeld:active.cancelHeld,cancelRejected:active.cancelRejected,actualCancelSettled:active.actualCancelSettled,unlockAfterRoots:active.unlockAfterRoots,
 locked:active.body?.locked??false,nativePending:active.nativePending,aborted:active.abort.signal.aborted,baseline:active.baseline,after:active.after,cache:active.cache}:{};
function observe(response,a){const body=response.body;if(!body)return response;a.body=body;const get=body.getReader.bind(body);
 body.getReader=options=>{const reader=get(options),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),unlock=reader.releaseLock.bind(reader);let firstCancel,padding=false;
  reader.read=(...args)=>{a.reads++;a.pending++;let pending;
   try{if(padding)pending=Promise.resolve({done:false,value:args[0].subarray(0,0)});else{a.nativeReads++;pending=read(...args);}}catch(e){a.pending--;throw e;}
   if(['read','read-reject'].includes(a.mode)&&a.bytes>=3){a.nativePending=true;a.ready.resolve();}
   return pending.then(part=>{a.pending--;a.settled++;
    if(!padding&&part.done)a.nativeEOF=true;
    // Owned empty/EOF boundary AFTER observed native EOF; no extra native pull.
    if(['reads','reads-over'].includes(a.mode)&&a.nativeEOF){padding=true;part={done:a.reads===(a.mode==='reads'?8192:8193),value:part.value??new Uint8Array(128).subarray(0,0)};}
    if(a.mode==='backing')part={done:false,value:new Uint8Array(new ArrayBuffer(129),0,1)};
    if(part.value){a.bytes+=part.value.byteLength;a.maxBacking=Math.max(a.maxBacking,part.value.buffer.byteLength);}return part;},e=>{a.pending--;a.settled++;throw e;});
  };
  reader.cancel=(...args)=>{if(firstCancel)return firstCancel;let yes,no;firstCancel=new Promise((resolve,reject)=>{yes=resolve;no=reject;});a.cancels++;
   (async()=>{await cancel(...args);a.actualCancelSettled=true;
    if(['read','read-reject','late','flush'].includes(a.mode)){a.cancelHeld=true;a.ready.resolve();await gate(a,'cleanup');a.cancelHeld=false;
     if(['read-reject','flush'].includes(a.mode)){a.cancelRejected=true;throw Error('deliberate FIRST rejection');}}
   })().then(yes,no);return firstCancel;
  };
  reader.releaseLock=()=>{a.unlocks++;a.unlockAfterRoots=a.pending===0&&!a.cancelHeld;
   if(a.mode==='unknown'){a.ready.resolve();throw Error('deliberate unknown lock');}unlock();};
  return reader;
 };return response;
}
const stats=async(env,key)=>{const response=await env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings')).fetch('https://clawrouter.internal/grant-pools/stats',{method:'POST',body:JSON.stringify({keys:[key]})});
 if(!response.ok)throw Error('stats failed');return (await response.json()).stats[key].selectedCount;};
function controlled(env,a){const ns=env.ACCESS_CONTROL;return {...env,ACCESS_CONTROL:{idFromName:n=>ns.idFromName(n),get:id=>{const stub=ns.get(id);return {async fetch(input,init){
  if(new URL(input).pathname!=='/grant-pools/record')return stub.fetch(input,init);
  a.calls++;const response=await stub.fetch(input,init);if(!response.ok)throw Error('actual mutation failed');a.committed++;
  if(a.mode==='late'){a.ready.resolve();await gate(a,'arrival');return observe(response,a);}
  if(['healthy','unknown','reads','reads-over','backing'].includes(a.mode))return observe(response,a);
  // Explicit ACK fault AFTER the real additive SQL commit. Never a healthy substitute.
  await response.body.cancel();
  if(a.mode==='default')return observe(new Response(new ReadableStream({})),a);
  return observe(await raw('https://ack-fixture.example/fault/'+a.mode,{redirect:'manual'}),a);
 }}}}};}
async function setupFlush(env){initialized??=(async()=>{
 const policy={enabled:true,generation:'v1',providers:['anthropic'],models:['anthropic/claude-sonnet-5'],tenantId:'fixture',monthlyBudgetMicros:null,retainRequestContent:false,
  grantRouting:{eligibleGrants:{anthropic:['flush']},environmentFallback:false,failover:false}};
 await authorityCall(env,'/users/initialize-all',[]);
 await authorityCall(env,'/policies/initialize-all',[{policyId:'ack-fixture',policy}]);
 await authorityCall(env,'/credentials/initialize-all',[{credentialId:'ack_fixture',credential:{enabled:true,policyId:'ack-fixture',policyGeneration:'v1',secretSha256:await sha256Hex('synthetic-ack-secret')}}]);
 await authorityCall(env,'/connections/initialize-all',[{providerId:'anthropic',enabled:true}]);
 await putGrantCredentials(env,'oauth/ack-fixture/flush',{provider:'anthropic',kind:'subscription',enabled:true,accessToken:'synthetic-ack-key'});
})();await initialized;}
export default {async fetch(request,env,ctx){const u=new URL(request.url);
 if(u.pathname==='/state')return Response.json(view());
 if(u.pathname==='/flush-again'){await flushSelections(controlled(env,active));return Response.json(view());}
 if(u.pathname!=='/start')return new Response(null,{status:404});
 const mode=u.searchParams.get('mode'),a=active={mode,calls:0,committed:0,done:false,value:null,code:null,reason:null,outcome:null,reads:0,nativeReads:0,nativeEOF:false,pending:0,settled:0,bytes:0,maxBacking:0,
  cancels:0,unlocks:0,cancelHeld:false,cancelRejected:false,actualCancelSettled:false,unlockAfterRoots:false,nativePending:false,ready:Promise.withResolvers(),abort:new AbortController()};
 const key='oauth/ack-fixture/'+(mode==='wrong'?'record':mode);
 if(['read','read-reject','late'].includes(mode))ctx.waitUntil(gate(a,'abort').then(()=>a.abort.abort(Error('original-request abort'))));
 if(mode==='pre-abort')a.abort.abort(Error('already aborted'));
 const actual=(async()=>{
  if(mode==='flush'){
   await setupFlush(env);const e=controlled(env,a),mark=backgroundMark();
   const input={credentialId:'ack_fixture',secretSha256:await sha256Hex('synthetic-ack-secret'),providers:[{id:'anthropic',tokenRef:'anthropic'}],
    selection:{providerId:'anthropic',endpointId:'messages',mode:'http',model:'claude-sonnet-5',catalogModelId:'anthropic/claude-sonnet-5',capability:'llm.chat'}};
   await resolveAdmission(e,input);a.baseline=await stats(env,key);
   const selected=await resolveAdmission(e,input);a.cache=selected.cache;if(selected.cache!=='hit'||!selected.admission.selection?.selected)throw Error('cached selection required');
   // This is the ORIGINAL exported flush promise, not the bounded background facade.
   const flushing=flushSelections(e);const background=pendingBackgroundWork(mark);if(background)ctx.waitUntil(background);
   await flushing;a.value='advisory-complete';a.after=await stats(env,key);
  }else{
   a.baseline=await stats(env,key);
   a.value=await authorityCall(controlled(env,a),'/grant-pools/record',{records:[{poolKey:'ack-fixture',key,count:1,lastMs:1760000000000}]},'policy-bindings',a.abort.signal);
   a.after=await stats(env,key);
  }
 })().catch(async e=>{a.code=e.code==='authority_ack_failed'?e.code:'fixture_failure';a.reason=['aborted','transport','status','limit','protocol','cleanup'].includes(e.reason)?e.reason:null;
  a.outcome=['NOT_INVOKED','OUTCOME_UNKNOWN'].includes(e.outcome)?e.outcome:null;a.after=await stats(env,key);
 }).finally(()=>{a.done=true;a.ready.resolve();});
 ctx.waitUntil(actual);await a.ready.promise;return Response.json(view());
},queue:worker.queue};`;

test('actual committed authority ACK faults retain original readers and advisory flush ownership', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'authority-ack-owned-'));
  const gates = new Map(), released = new Set(), tails = new Map(), clients = [];
  let runtime, server, primary, releaseFuture = false;
  const abort = new AbortController();
  const release = key => { released.add(key); gates.get(key)?.end('released'); gates.delete(key); };
  const releaseAll = () => { releaseFuture = true; for (const key of gates.keys()) release(key); for (const r of tails.values()) if (!r.destroyed) r.end('orded'); tails.clear(); };
  const stop = () => { releaseAll(); abort.abort(t.signal.reason); };
  t.signal.addEventListener('abort', stop, { once: true });
  t.after(async () => {
    releaseAll(); abort.abort(new Error('fixture cleanup')); const failures = [];
    for (const result of await Promise.allSettled(clients)) if (result.status === 'rejected' && result.reason !== primary) failures.push(result.reason);
    try { if (runtime) await runtime.dispose(); } catch (error) { failures.push(error); }
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    t.signal.removeEventListener('abort', stop);
    if (failures.length) throw new AggregateError(failures, 'ACK client cleanup');
  });
  try {
    server = createServer((request, response) => {
      const path = new URL(request.url, 'http://fixture').pathname;
      if (path.startsWith('/gate/')) { const key = path.slice(6); if (releaseFuture || released.has(key)) response.end('released'); else gates.set(key, response); return; }
      const mode = path.slice('/fault/'.length), headers = { 'content-type': 'text/plain' };
      if (['read', 'read-reject'].includes(mode)) { response.writeHead(200, headers); response.write('rec'); tails.set(mode, response); if (releaseFuture) response.end('orded'); return; }
      if (mode === 'headers') for (let i = 0; i < 33; i++) headers['x-' + i] = 'x';
      if (mode === 'header-bytes') headers['x-large'] = 'x'.repeat(4096);
      if (['json', 'json-escape', 'json-bom', 'wire', 'wire-plus', 'object'].includes(mode)) headers['content-type'] = 'application/json';
      const body = mode === 'json' ? '"recorded"' : mode === 'json-escape' ? ' \n"\\u0072ecorded"\t'
        : mode === 'bom' ? '\ufeffrecorded' : mode === 'json-bom' ? '\ufeff"recorded"'
        : mode === 'wire' ? '"recorded"' + ' '.repeat(118) : ['wire-plus', 'flush'].includes(mode) ? ' '.repeat(129)
          : mode === 'object' ? '{"recorded":true}' : mode === 'empty' ? '' : 'wrong';
      response.writeHead(mode === 'status' ? 503 : 200, headers); response.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const upstream = `export default {fetch(request){const u=new URL(request.url);if(u.origin!=='https://ack-fixture.example')throw Error('unexpected egress');return fetch(${JSON.stringify(origin)}+u.pathname,{redirect:'manual',signal:request.signal});}};`;
    runtime = await startWorkerdFixture(directory, ownedRouter, upstream, { preventEviction: true, hotCache: true });
    const call = path => { const p = runtime.dispatchFetch('https://router.example' + path, { signal: abort.signal }).then(async r => { assert.equal(r.status, 200); return r.json(); }); clients.push(p); return p; };
    const state = async (mode, predicate, failed) => {
      for (let i = 0; i < 2000; i++) { const s = await (failed ? Promise.race([failed, call('/state')]) : call('/state')); if (s.mode === mode && predicate(s)) return s;
        if (s.mode === mode && s.done) assert.fail(JSON.stringify(s)); await (failed ? Promise.race([failed, delay(10)]) : delay(10)); }
      assert.fail('bounded original-owner observation expired: ' + mode);
    };
    for (const mode of ['healthy', 'wrong', 'json', 'json-escape', 'bom', 'json-bom', 'wire', 'wire-plus', 'object', 'empty', 'status', 'headers', 'header-bytes', 'default', 'pre-abort', 'reads', 'reads-over', 'backing']) {
      const s = await call('/start?mode=' + mode);
      assert.equal(s.mode, mode); assert.equal(s.done, true);
      assert.equal(s.calls, mode === 'pre-abort' ? 0 : 1); assert.equal(s.committed, s.calls);
      assert.equal(s.after, s.baseline + s.calls, 'one additive commit; ACK failure never replays or compensates');
      if (['healthy', 'json', 'json-escape', 'bom', 'json-bom', 'wire', 'reads'].includes(mode)) { assert.equal(s.value, 'recorded'); assert.equal(s.code, null); }
      else { assert.equal(s.code, 'authority_ack_failed'); assert.equal(s.outcome, mode === 'pre-abort' ? 'NOT_INVOKED' : 'OUTCOME_UNKNOWN'); }
      if (['status', 'headers', 'header-bytes', 'default'].includes(mode)) { assert.equal(s.reads, 0); assert.equal(s.cancels, 1); }
      if (mode !== 'pre-abort') { assert.equal(s.unlocks, 1); assert.equal(s.locked, false); assert.equal(s.unlockAfterRoots, true); }
      assert.ok(s.maxBacking <= (mode === 'backing' ? 129 : 128));
      if (['reads', 'reads-over'].includes(mode)) { assert.equal(s.reads, 8192); assert.equal(s.nativeEOF, true); assert.ok(s.nativeReads < s.reads); assert.equal(s.cancels, mode === 'reads' ? 0 : 1); }
      if (['wire-plus', 'headers', 'header-bytes', 'reads-over', 'backing'].includes(mode)) assert.equal(s.reason, 'limit');
    }
    for (const mode of ['read', 'read-reject', 'late']) {
      let s = await call('/start?mode=' + mode); assert.equal(s.done, false); assert.equal(s.committed, 1);
      if (mode !== 'late') { assert.equal(s.nativePending, true); assert.equal(s.pending, 1); }
      else assert.equal(s.reads, 0);
      release(mode + '/abort'); await state(mode, row => row.aborted);
      if (mode === 'late') { assert.equal((await call('/state')).done, false); release(mode + '/arrival'); }
      s = await state(mode, row => row.cancelHeld && gates.has(mode + '/cleanup'));
      assert.equal(s.done, false); assert.equal(s.cancels, 1); assert.equal(s.actualCancelSettled, true); assert.equal(s.unlocks, 0); assert.equal(s.locked, true);
      if (mode === 'late') assert.equal(s.reads, 0);
      release(mode + '/cleanup'); s = await state(mode, row => row.done);
      assert.equal(s.after, s.baseline + 1); assert.equal(s.calls, 1); assert.equal(s.cancels, 1); assert.equal(s.unlocks, 1); assert.equal(s.unlockAfterRoots, true); assert.equal(s.locked, false);
      assert.equal(s.code, 'authority_ack_failed'); assert.equal(s.outcome, 'OUTCOME_UNKNOWN'); assert.equal(s.cancelRejected, mode === 'read-reject');
    }
    let s = await call('/start?mode=flush');
    s = await state('flush', row => row.cancelHeld && gates.has('flush/cleanup'));
    assert.equal(s.cache, 'hit'); assert.equal(s.done, false); assert.equal(s.calls, 1); assert.equal(s.committed, 1); assert.equal(s.unlocks, 0);
    release('flush/cleanup'); s = await state('flush', row => row.done);
    assert.equal(s.value, 'advisory-complete'); assert.equal(s.code, null); assert.equal(s.cancelRejected, true); assert.equal(s.unlockAfterRoots, true);
    assert.equal(s.after, s.baseline + 1); assert.equal(s.calls, 1);
    assert.equal((await call('/flush-again')).calls, 1, 'empty flush cannot replay the committed attempt');
    // Deliberately unknown original unlock LAST. Disposal below is not retirement proof.
    const started = call('/start?mode=unknown');
    // Observe rejection BEFORE polling; success may precede the independent probe.
    const failed = started.then(() => new Promise(() => {}), error => { throw error; });
    s = await state('unknown', row => row.unlocks === 1, failed); assert.equal(s.locked, true); assert.equal(s.done, false); assert.equal(s.calls, 1);
    // The unlock hook releases only this public diagnostic reply; its physical root stays held.
    await started;
  } catch (error) { primary = error; throw error; }
});
