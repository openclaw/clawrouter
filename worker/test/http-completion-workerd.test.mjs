import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startBundledWorkerdFixture } from '../../test/helpers/workerd.mjs';

const lifetime = { fixtureEntered: false, serverListening: false, runtimeStarted: false,
  teardownStarted: false, clientsJoined: false, runtimeDisposeStarted: false, runtimeDisposed: false,
  serverCloseStarted: false, serverClosed: false, teardownEnd: false, teardownFailed: false, fileAfter: false,
  clientsStarted: 0, clientsSettled: 0, pendingClients: 0, pendingGates: 0 };
function resourceCounts() {
  const types = Object.create(null); let retainedTypes = 0, overflow = 0, total = 0;
  for (const type of process.getActiveResourcesInfo()) {
    total++;
    if (Object.hasOwn(types, type)) types[type]++;
    else if (retainedTypes < 16) { types[type] = 1; retainedTypes++; }
    else overflow++;
  }
  return { types, overflow, total };
}
const resourceBaseline = resourceCounts(); let lifetimeDiagnosticFailures = 0;
const lifetimeDiagnostic = phase => {
  try { console.error('http-completion-lifetime', JSON.stringify({ phase, ...lifetime,
    baseline: resourceBaseline, resources: resourceCounts(), diagnosticFailures: lifetimeDiagnosticFailures })); }
  catch { lifetimeDiagnosticFailures++; }
};
process.once('beforeExit', () => lifetimeDiagnostic('before-exit'));
process.once('exit', () => lifetimeDiagnostic('exit'));
after(() => { lifetime.fileAfter = true; lifetimeDiagnostic('file-after'); });
lifetimeDiagnostic('module-start');

// Used unchanged by the originating Workerd request and synthetic outcome tests.
function heldSecondRead(original, hold, track, state) {
  const originalTag = {}, propagatedTag = {};
  let originalOutcome, propagatedOutcome, forwardedOriginal = false, cancelInvoked = false;
  state.nativeReadPending = true;
  const observed = original.then(value => {
    state.nativeReadPending = false; state.nativeReadSettled = true;
    return originalOutcome = { failed: false, value };
  }, error => {
    state.nativeReadPending = false; state.nativeReadSettled = true; state.nativeReadFailed = true;
    return originalOutcome = { failed: true, error };
  });
  track(original, 'read', originalTag);
  const work = observed.then(async outcome => {
    try { await hold(); state.readOutcomeReleased = true; }
    catch (error) {
      if (outcome.failed) throw new AggregateError([outcome.error, error], 'original read and independent continuation');
      throw error;
    }
    forwardedOriginal = true;
    if (outcome.failed) throw outcome.error;
    state.readReturned = true; return outcome.value;
  });
  const propagated = work.then(value => {
    state.propagatedReadSettled = true; return propagatedOutcome = { failed: false, value };
  }, error => {
    state.propagatedReadSettled = true; state.propagatedReadFailed = true;
    return propagatedOutcome = { failed: true, error };
  });
  track(work, 'read', propagatedTag);
  return {
    work, observed, propagated,
    firstCancel(intentional) {
      if (cancelInvoked) throw Error('second-read FIRST cancel invoked twice');
      cancelInvoked = true;
      state.readPendingAtFirstCancel = state.nativeReadPending;
      state.readCancelIntentional = intentional;
    },
    cancelSucceeded() { state.readCancelSucceeded = true; },
    expected(result) {
      return originalOutcome?.failed === true && state.readPendingAtFirstCancel === true
        && state.readCancelIntentional === true && state.readCancelSucceeded === true
        && (result.provenance === originalTag || result.provenance === propagatedTag && forwardedOriginal);
    },
    outcomes() { return { original: originalOutcome, propagated: propagatedOutcome }; },
  };
}

const cases = ['account-last', 'archive-last', 'delivery-last', 'cancel-reject',
  'sse-replay', 'sse-replay-cancel-reject', 'sse-normalization', 'sse-normalization-cancel-reject',
  'json-normalization', 'json-normalization-cancel-reject'];
const router = String.raw`
import worker from './worker/index.ts';
export {PolicyBindingIndexObject,GrantCredentialObject} from './worker/index.ts';
import {BudgetLedgerObject as Budget,UsageLedgerObject as Usage,ingestUsage} from './worker/ledgers.ts';
import {authorityCall} from './worker/authority.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {sha256Hex} from './worker/utils.ts';
export class BudgetLedgerObject extends Budget {
 constructor(state){super(state);this.fixtureSql=state.storage.sql;}
 fetch(request){return new URL(request.url).pathname==='/fixture-sql'?Response.json([...this.fixtureSql.exec('SELECT reservation_id,reserved_micros,settled,dispatch_started FROM budget_reservations')]):super.fetch(request);}
}
export class UsageLedgerObject extends Usage {
 constructor(state){super(state);this.fixtureSql=state.storage.sql;}
 fetch(request){return new URL(request.url).pathname==='/fixture-sql'?Response.json([...this.fixtureSql.exec('SELECT event_json FROM usage_events')].map(row=>JSON.parse(row.event_json))):super.fetch(request);}
}
const states=new Map(),nativeFetch=globalThis.fetch.bind(globalThis);
const check=(value,label)=>{if(!value)throw Error(label);};
__SECOND_READ_OBSERVER__
export default {async fetch(request,bindings,ctx){
 const url=new URL(request.url),id=url.searchParams.get('case');
 if(url.pathname==='/setup'){
  const secret=await sha256Hex('fixture-secret'),names=['wire',...__CASES__];
  await authorityCall(bindings,'/users/initialize-all',[]);
  await authorityCall(bindings,'/policies/initialize-all',names.map(name=>({policyId:name,policy:{enabled:true,generation:'g1',providers:['openai'],tenantId:name,
   monthlyBudgetMicros:1000000,dailyBudgetMicros:1000000,weeklyBudgetMicros:1000000,budgetScope:'policy',requestCostMicros:7,retainRequestContent:true}})));
  await authorityCall(bindings,'/credentials/initialize-all',names.map(name=>({credentialId:name.replaceAll('-','_'),credential:{enabled:true,secretSha256:secret,policyId:name,policyGeneration:'g1'}})));
  await authorityCall(bindings,'/connections/initialize-all',[{providerId:'openai',enabled:true,monthlyBudgetMicros:1000000}]);
  return Response.json({ready:true});
 }
 // Direct public wire control; no diagnostic Response replaces this result.
 if(url.pathname==='/v1/chat/completions'){
  const wire={done:false,failed:false,started:0,settled:0,failedRoots:0},roots=[];states.set('wire',wire);
  const track=work=>{wire.started++;roots.push(work.then(()=>{wire.settled++;return {failed:false};},error=>{wire.settled++;wire.failedRoots++;return {failed:true,error};}));return work;};
  let hasPrimary=false,primary,response;
  try{response=await track(worker.fetch(request,bindings,{waitUntil:track}));}catch(error){hasPrimary=true;primary=error;}
  // Outside the caller join: this original-context fixture drain is never enrolled
  // back into completion, and public body delivery can proceed while it waits.
  ctx.waitUntil((async()=>{const failures=[];let index=0;
   while(index<roots.length){const batch=roots.slice(index);index=roots.length;for(const result of await Promise.all(batch))if(result.failed)failures.push(result.error);}
   wire.failed=hasPrimary||failures.length>0;wire.done=true;
   if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'healthy wire roots');if(hasPrimary)throw primary;
  })());
  if(hasPrimary)throw primary;return response;
 }
 if(url.pathname==='/state'){const state=states.get(id);return Response.json(state?{...state,charged:bodyBudgetCharged()}:null);}
 if(url.pathname!=='/fixture'||!__CASES__.includes(id))return new Response(null,{status:404});
 await request.text(); // Explicit outer request lifetime support; no upload/readiness coupling.
 const normalization=id.includes('-normalization'),streaming=id.startsWith('sse-')||normalization,cancelReject=id.endsWith('cancel-reject');
 const s={response:false,first:false,bodyDone:false,bodyRejected:false,status:null,streaming,normalization,nativeReadPending:false,nativeReadSettled:false,nativeReadFailed:false,readReturned:false,
  nativeCancelPending:false,nativeCancelSettled:false,nativeCancelFailed:false,cancelReturned:false,cancels:0,unlocked:false,r2Native:false,r2Returned:false,accountEntered:false,accountDone:false,
   readOutcomeReleased:false,readPendingAtFirstCancel:false,readCancelIntentional:false,readCancelSucceeded:false,propagatedReadSettled:false,propagatedReadFailed:false,intentionalAbort:false,expectedReadFailures:0,independentRootFailures:0,
   completionSeen:0,completionDone:false,completionFailed:null,events:0,posts:0,reserves:0,closed:false,operationDone:false,operationFailed:false,phase:'dispatch',
  roots:Object.fromEntries(['fetch','read','first-cancel','archive','accounting','production-completion','input-finish','gate','background'].map(kind=>[kind,{started:0,settled:0,failed:0}])),
  gates:Object.fromEntries(['abort','archive','accounting','read-return','cancel'].map(phase=>[phase,{entered:false,released:false}]))};states.set(id,s);
 const roots=[],names=new Map(),reservationIds=[],usageNames=new Set(),caller=new AbortController();
  let hasPrimary=false,primary,closed=false,archiveKey,expectedBody,completion,secondRead;
  const track=(work,kind='background',provenance)=>{check(!closed,'fixture enrollment closed');const count=s.roots[kind];count.started++;
   const tagged=work.then(()=>{count.settled++;return {failed:false,provenance};},error=>{count.settled++;count.failed++;return {failed:true,error,provenance};});roots.push(tagged);return work;};
 const diagnostic=()=>{try{console.error('http-completion-origin',JSON.stringify({case:id,...s,charged:bodyBudgetCharged()}));}catch(error){roots.push(Promise.resolve({failed:true,error}));}};
 const gate=phase=>track((async()=>{s.gates[phase].entered=true;const response=await nativeFetch('https://completion-gate.example/gate/'+id+'/'+phase);check(response.ok,'fixture gate');await response.text();s.gates[phase].released=true;})(),'gate');
 const releaseAll=async()=>{const response=await nativeFetch('https://completion-gate.example/release-all/'+id);check(response.ok,'fixture release all');await response.text();};
 const env={...bindings,
  __fixtureCompletion(original){s.completionSeen++;completion=original;track(original.then(receipt=>{s.completionDone=true;s.completionFailed=receipt.failed;}),'production-completion');},
  __fixtureInputFinish(original){track(original,'input-finish');},
  BUDGET_LEDGER:{idFromName(name){const key=bindings.BUDGET_LEDGER.idFromName(name);names.set(String(key),name);return key;},get(key){const stub=bindings.BUDGET_LEDGER.get(key);return {fetch(input,init){
   if(new URL(String(input)).pathname==='/reserve'){s.reserves++;reservationIds.push(JSON.parse(init.body).reservationId);}return stub.fetch(input,init);}};}},
  CONTENT_ARCHIVE:{put(key,body,options){archiveKey=key;const original=track(bindings.CONTENT_ARCHIVE.put(key,body,options),'archive');
   return track(original.then(async result=>{s.r2Native=true;await gate('archive');s.r2Returned=true;return result;}),'archive');}},
  USAGE_LEDGER:{idFromName(name){usageNames.add(name);return bindings.USAGE_LEDGER.idFromName(name);},get:key=>bindings.USAGE_LEDGER.get(key)},
  USAGE_QUEUE:{send(event){s.events++;s.accountEntered=true;
   return track((async()=>{await gate('accounting');const receipt=await ingestUsage(env,event);check(receipt.eventId===event.id,'original usage receipt');s.accountDone=true;})(),'accounting');}}
 };
 // The fixture transport stays connected so routed abort reaches the ORIGINAL
 // reader FIRST cancel independently of fetch-signal cancellation. No body replacement.
 // The ORIGINAL reader and native promises are retained only in this request.
 // The separate read-return/cancel gates hold application continuations AFTER
 // native settlement; only nativeReadPending labels a genuinely pending read.
 globalThis.fetch=(input,init)=>{
  s.posts++;
  return track(nativeFetch('https://completion-gate.example/provider/'+id,{...init,signal:undefined}).then(response=>{
   const body=response.body,acquire=body.getReader.bind(body);
   body.getReader=(...args)=>{
    const reader=acquire(...args),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),unlock=reader.releaseLock.bind(reader);let reads=0,firstCancel;
    reader.read=(...args)=>{
      const index=++reads,original=read(...args);
      if(index!==2||normalization)return track(original,'read');
      check(!secondRead,'one ORIGINAL second read');
      secondRead=heldSecondRead(original,()=>gate('read-return'),track,s);return secondRead.work;
    };
    reader.cancel=(...args)=>firstCancel??=(async()=>{
     s.cancels++;s.nativeCancelPending=true;
      secondRead?.firstCancel(s.intentionalAbort);
      try{await track(cancel(...args),'first-cancel');secondRead?.cancelSucceeded();}catch(error){s.nativeCancelFailed=true;throw error;}
     finally{s.nativeCancelPending=false;s.nativeCancelSettled=true;}
     await gate('cancel');s.cancelReturned=true;
     if(cancelReject)throw undefined;
    })();
    const first=reader.cancel;
    reader.cancel=(...args)=>{
     const original=first(...args);
     // Deliberate post-native rejection is asserted, never an arbitrary ignore.
     if(!reader.fixtureObserved){reader.fixtureObserved=true;track(original.then(()=>{check(!cancelReject,'expected labelled cancel rejection');},error=>{
      if(!cancelReject||!s.nativeCancelSettled||!s.cancelReturned||error!==undefined)throw error;
     }),'first-cancel');}
     return original;
    };
    reader.releaseLock=()=>{unlock();s.unlocked=!body.locked;};
    return reader;
   };
   return response; // Healthy ORIGINAL response identity is preserved.
  }),'fetch');
 };
 // Controls are registered before dispatch, and never wait on the completion owner.
  if(!normalization)track(gate('abort').then(()=>{s.intentionalAbort=true;caller.abort(Error('fixture routed abort'));}));
 let reader,readOutcome;
 try{
  expectedBody={model:'openai/gpt-6-astra',messages:[{role:'user',content:'x'.repeat(1024*1024+16)}]};
  if(streaming)expectedBody.stream=true;
  const response=await track(worker.fetch(new Request('https://router.example/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer clawrouter-live-'+id.replaceAll('-','_')+'-fixture-secret','content-type':'application/json','x-request-id':'completion-'+id},body:JSON.stringify(expectedBody),signal:caller.signal}),env,{waitUntil:track}),'fetch');
  s.response=true;s.status=response.status;s.phase='public-body';reader=response.body?.getReader();check(reader,'actual public body');
  check(response.status===(normalization?429:200),'actual public response status');check(s.completionSeen===1,'one caller completion');
  const first=await track(reader.read(),'read');check(!first.done&&first.value.byteLength>0,'actual first public body read');s.first=true;
  if(normalization){
   const decoder=new TextDecoder();let text=decoder.decode(first.value,{stream:true});
   for(;;){const next=await track(reader.read(),'read');if(next.done)break;text+=decoder.decode(next.value,{stream:true});}
   text+=decoder.decode();check(!!JSON.parse(text).error,'actual normalized error body');s.bodyDone=true;
  }else{
   if(streaming)check(response.headers.get('content-type')?.includes('text/event-stream')&&new TextDecoder().decode(first.value).startsWith('data: '),'valid first SSE replay delivered');
   const reading=reader.read();readOutcome=track(reading.then(()=>{throw Error('held public read unexpectedly fulfilled');},error=>{
    check(caller.signal.aborted&&Object.is(error,caller.signal.reason),'original public abort reason');s.bodyRejected=true;s.bodyDone=true;
   }));
   await readOutcome;
  }
  reader.releaseLock();reader=undefined;
  // Result/accounting may be early; the original receipt is a distinct join.
  check(completion&&!s.completionDone,'public response/body do not retire caller');
 }catch(error){hasPrimary=true;primary=error;s.operationFailed=true;diagnostic();}
 finally{
  s.operationDone=true;
  if(hasPrimary){try{await releaseAll();}catch(error){roots.push(Promise.resolve({failed:true,error}));}}
  if(reader){try{await reader.cancel();}catch(error){roots.push(Promise.resolve({failed:true,error}));}try{reader.releaseLock();}catch(error){roots.push(Promise.resolve({failed:true,error}));}}
 }
 s.phase='root-join';diagnostic();
 const failures=[];let index=0;
 while(index<roots.length){const batch=roots.slice(index);index=roots.length;for(const result of await Promise.all(batch))if(result.failed){failures.push(result.error);if(secondRead?.expected(result))s.expectedReadFailures++;else s.independentRootFailures++;}}
 closed=true;s.closed=true;s.phase='receipt-assertions';globalThis.fetch=nativeFetch;
 if(s.independentRootFailures)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'original read and independent fixture roots');if(hasPrimary)throw primary;
 check(s.completionDone&&s.completionFailed===false&&bodyBudgetCharged()===0,'actual completion and caller charge release');
  if(!normalization){
   const outcomes=secondRead.outcomes();
   check(s.readPendingAtFirstCancel&&s.readCancelIntentional&&s.readCancelSucceeded&&s.readOutcomeReleased,'controlled pending-read FIRST cancel and released outcome');
   check(outcomes.original.failed&&outcomes.propagated.failed&&s.propagatedReadSettled&&s.propagatedReadFailed&&!s.readReturned,'actual rejected read is not fabricated success');
   check(Object.is(outcomes.original.error,outcomes.propagated.error),'IDENTICAL original read rejection forwarded');
  }
  check(s.cancels===1&&s.unlocked&&(normalization||s.readOutcomeReleased)&&s.cancelReturned,'actual read FIRST cancel and unlock');
 check(s.posts===1&&s.events===1&&s.reserves===4,'single provider and accounting with four original reservations');
 const rows=[];for(const [key] of names){const response=await bindings.BUDGET_LEDGER.get(bindings.BUDGET_LEDGER.idFromString(key)).fetch('https://clawrouter.internal/fixture-sql');rows.push(...(await response.json()).filter(row=>reservationIds.includes(row.reservation_id)));}
 check(rows.length===4&&rows.every(row=>reservationIds.includes(row.reservation_id)&&row.settled===1&&row.dispatch_started===1&&row.reserved_micros===(normalization?0:7)),'same original reservation IDs and terminal SQL');
 const usage=[];for(const name of usageNames){const response=await bindings.USAGE_LEDGER.get(bindings.USAGE_LEDGER.idFromName(name)).fetch('https://clawrouter.internal/fixture-sql');usage.push(...await response.json());}
 check(usage.length===1&&usage[0].request_id==='completion-'+id&&usage[0].actual_cost_micros===(normalization?0:7)&&usage[0].status_code===(normalization?429:200)&&usage[0].status==='client_error','one original cancellation or normalization receipt');
 const stored=await bindings.CONTENT_ARCHIVE.get(archiveKey),text=await stored.text(),record=JSON.parse(text);
 expectedBody.model='gpt-6-astra';expectedBody.service_tier='default';check(JSON.stringify(record.body)===JSON.stringify(expectedBody),'actual R2 complete admitted request bytes');
 const expectedArchive={version:'clawrouter.retained-request.v1',contentRef:record.contentRef,requestId:'completion-'+id,occurredAtMs:record.occurredAtMs,
  expiresAtMs:record.occurredAtMs+30*86400000,tenantId:id,policyId:id,credentialId:id.replaceAll('-','_'),principalId:null,provider:'openai',capability:'llm.chat',model:'openai/gpt-6-astra',body:expectedBody};
 check(text===JSON.stringify(expectedArchive)&&stored.size===new TextEncoder().encode(text).byteLength,'actual R2 COMPLETE byte oracle');
 check(record.requestId==='completion-'+id&&stored.httpMetadata.contentType==='application/json'&&stored.customMetadata.expiresAt===String(record.expiresAtMs),'actual R2 metadata');
 return Response.json({fixture:'originating-request completion join; post-native read/cancel/R2 holds',...s,charged:bodyBudgetCharged(),originalIds:rows.length,usage:usage.length,archiveBytes:stored.size});
},queue:worker.queue};`.replaceAll('__CASES__', JSON.stringify(cases)).replace('__SECOND_READ_OBSERVER__', () => heldSecondRead.toString());

async function fixture(directory, upstream) {
  const { build } = createRequire(import.meta.resolve('wrangler/package.json'))('esbuild');
  const anchor = 'if (completion) admission!.completion = completion.completion;';
  const bundled = await build({ stdin: { contents: router, resolveDir: process.cwd(), sourcefile: 'http-completion-fixture.ts', loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent', plugins: [{ name: 'observe-original-completion', setup(build) {
      build.onLoad({ filter: /[\\/]worker[\\/]proxy\.ts$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8'); assert.equal(source.split(anchor).length, 2);
        const finish = 'context.waitUntil((async () => {\n      try { await this.completion; }';
        assert.equal(source.split(finish).length, 2);
        const finishEnd = 'this.intakeOperation?.stop("complete"); this.intakeOperation = undefined;\n      }\n    })());';
        assert.equal(source.split(finishEnd).length, 2);
        const observed = source.replace(finish, 'const originalFinish = (async () => {\n      try { await this.completion; }')
          .replace(finishEnd, 'this.intakeOperation?.stop("complete"); this.intakeOperation = undefined;\n      }\n    })();\n    this.env.__fixtureInputFinish?.(originalFinish);\n    context.waitUntil(originalFinish);');
        return { contents: observed.replace(anchor, 'if (completion) { admission!.completion = completion.completion; env.__fixtureCompletion?.(completion.completion); }'), loader: 'ts', resolveDir: dirname(path) };
      });
    } }] });
  return startBundledWorkerdFixture(directory, bundled.outputFiles[0].text, upstream, { preventEviction: true, r2Buckets: ['CONTENT_ARCHIVE'] });
}

test('ordinary public HTTP joins original delivery, archive and accounting after publication', { timeout: 120_000 }, async t => {
  lifetime.fixtureEntered = true; lifetimeDiagnostic('fixture-start');
  const directory = await mkdtemp(join(tmpdir(), 'http-completion-'));
  const gates = new Map(), released = new Set(), clients = [], diagnosticFailures = [], controlFailures = []; let releaseFuture = false, runtime, server, hasPrimary = false, primary, wireStarted = false, drainWire;
  let activeCase = 'setup', hostPhase = 'setup', lastState = null;
  const phases = ['abort','archive','accounting','read-return','cancel','provider-eof'];
  const diagnostic = () => { try { console.error('http-completion-host', JSON.stringify({ case: activeCase, phase: hostPhase, lastState, clients: { started: clients.length, settled: clients.filter(row => row.done).length, failed: clients.filter(row => row.outcome?.failed).length }, gates: Object.fromEntries(phases.map(phase => [phase, { arrived: gates.has(activeCase+'/'+phase), released: released.has(activeCase+'/'+phase) }])) })); } catch (error) { diagnosticFailures.push(error); } };
  const release = key => { released.add(key); gates.get(key)?.end('released'); gates.delete(key); lifetime.pendingGates = gates.size; };
  const releaseKeys = keys => { const failures = []; for (const key of keys) try { release(key); } catch (error) { failures.push(error); } if (failures.length) throw new AggregateError(failures, 'independent host releases'); };
  const releaseAll = () => { releaseFuture = true; releaseKeys([...gates.keys()]); };
  const track = work => {
    const row = { done: false, outcome: undefined }; lifetime.clientsStarted++; lifetime.pendingClients++;
    row.observed = work.then(value => { row.done = true; lifetime.clientsSettled++; lifetime.pendingClients--; return row.outcome = { failed: false, value }; },
      error => { row.done = true; lifetime.clientsSettled++; lifetime.pendingClients--; return row.outcome = { failed: true, error }; });
    clients.push(row); return row;
  };
  const interrupted = () => { try { releaseAll(); } catch (error) { controlFailures.push(error); } }; t.signal.addEventListener('abort', interrupted, { once: true });
  t.after(async () => {
    lifetime.teardownStarted = true; lifetimeDiagnostic('teardown-start');
    hostPhase = 'host-cleanup'; diagnostic(); const diagnosticCount = diagnosticFailures.length, controlCount = controlFailures.length, failures = [...diagnosticFailures, ...controlFailures];
    try { releaseAll(); } catch (error) { failures.push(error); }
    for (const row of clients) { const result = await row.observed; if (result.failed) failures.push(result.error); }
    lifetime.clientsJoined = true; lifetimeDiagnostic('clients-joined');
    if (wireStarted && drainWire) try { await drainWire(); } catch (error) { failures.push(error); }
    if (runtime) try {
      lifetime.runtimeDisposeStarted = true; lifetimeDiagnostic('runtime-dispose-start');
      await runtime.dispose(); lifetime.runtimeDisposed = true; lifetimeDiagnostic('runtime-dispose-end');
    } catch (error) { failures.push(error); }
    if (server) try {
      lifetime.serverCloseStarted = true; lifetimeDiagnostic('server-close-start');
      server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      lifetime.serverClosed = true; lifetimeDiagnostic('server-close-end');
    } catch (error) { failures.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    t.signal.removeEventListener('abort', interrupted);
    failures.push(...diagnosticFailures.slice(diagnosticCount), ...controlFailures.slice(controlCount));
    lifetime.teardownEnd = true; lifetime.teardownFailed = hasPrimary || failures.length > 0; lifetimeDiagnostic('teardown-end');
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'host roots');
  });
  try {
    server = createServer((request, response) => {
      request.resume(); const parts = new URL(request.url, 'http://fixture').pathname.split('/').filter(Boolean);
      if (parts[0] === 'gate') { const key = parts.slice(1).join('/'); if (releaseFuture || released.has(key)) response.end('released'); else { gates.set(key, response); lifetime.pendingGates = gates.size; } }
      else if (parts[0] === 'provider') {
        const id = parts[1], normalization = id.includes('-normalization'), sse = id.startsWith('sse-');
        response.writeHead(normalization ? 429 : 200, { 'content-type': sse ? 'text/event-stream' : 'application/json' });
        response.write(sse ? 'data: '+JSON.stringify(normalization ? { error: { message: 'fixture rejection', type: 'rate_limit_error' } }
          : { id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'fixture' }, finish_reason: null }] })+'\n\n'
          : normalization ? '{"error":{"message":"'+'x'.repeat(70*1024)+'"}}' : '{"id":"fixture",');
        const key = parts[1] + '/provider-eof'; if (releaseFuture || released.has(key)) response.end(); else { gates.set(key, response); lifetime.pendingGates = gates.size; }
      } else if (parts[0] === 'release-all') {
        try { releaseKeys(phases.map(phase => parts[1]+'/'+phase)); response.end('released'); }
        catch (error) { controlFailures.push(error); response.writeHead(500); response.end('fixture release failed'); }
      }
      else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    lifetime.serverListening = true; lifetimeDiagnostic('server-listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const upstream = `export default {fetch(request){const u=new URL(request.url);if(u.origin==='https://completion-gate.example')return fetch(${JSON.stringify(origin)}+u.pathname,request);if(u.origin==='https://api.openai.com')return Response.json({id:'fixture',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'fixture'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});throw Error('unexpected egress');}};`;
    lifetimeDiagnostic('runtime-start'); runtime = await fixture(directory, upstream);
    lifetime.runtimeStarted = true; lifetimeDiagnostic('runtime-ready');
    const call = (path, options) => track(runtime.dispatchFetch('https://router.example'+path, options).then(async response => ({ status: response.status, text: await response.text() })));
    const value = async row => { const result = await row.observed; if (result.failed) throw result.error; assert.equal(result.value.status, 200); return JSON.parse(result.value.text); };
    await value(call('/setup'));
    drainWire = async () => {
      for (let n = 0; n < 500; n++) { const state = lastState = await value(call('/state?case=wire')); if (state?.done) { assert.equal(state.failed, false, 'original wire drain failed'); return; } await delay(10); }
      throw Error('healthy original-context drain did not finish');
    };
    wireStarted = true; activeCase = 'wire'; hostPhase = 'healthy-public-body';
    const healthy = await value(call('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer clawrouter-live-wire-fixture-secret', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'openai/gpt-6-astra', messages: [{ role: 'user', content: 'fixture' }] }) }));
    assert.equal(healthy.object, 'chat.completion'); hostPhase = 'healthy-root-join'; await drainWire(); wireStarted = false;
    for (const id of cases) {
      activeCase = id; hostPhase = 'initial-arrival'; lastState = null;
      const client = call('/fixture?case='+id, { method: 'POST', body: 'fixture' });
      const state = async () => lastState = await value(call('/state?case='+id));
      const wait = async predicate => {
        for (let n = 0; n < 500; n++) {
          if (client.done) { const result = await client.observed; if (result.failed) throw result.error; throw Error('originating diagnostic completed prematurely'); }
          const s = await state(); if (s?.operationFailed) {
            diagnostic(); const failures = []; try { releaseKeys(phases.map(phase => id+'/'+phase)); } catch (error) { failures.push(error); }
            const result = await client.observed;
            if (failures.length) throw new AggregateError(result.failed ? [result.error, ...failures] : failures, 'original client and independent release failures');
            if (result.failed) throw result.error; throw Error('originating operation failed');
          }
          if (s && predicate(s)) return s;
          await delay(10);
        }
        throw Error('bounded completion fixture arrival');
      };
      const normalization = id.includes('-normalization');
      let s;
      if(normalization){
        s = await wait(s => s.response && s.first && s.bodyDone && s.r2Native && s.accountEntered && s.nativeCancelSettled);
        assert.equal(s.status, 429); assert.equal(s.bodyRejected, false);
      }else{
        s = await wait(s => s.response && s.first && s.nativeReadPending && s.r2Native);
        assert.equal(s.completionDone, false); assert.ok(s.charged > 0); assert.equal(s.accountEntered, false);
        hostPhase = 'abort-arrival'; release(id+'/abort');
        s = await wait(s => s.bodyDone && s.accountEntered && s.nativeReadSettled && s.nativeCancelSettled);
        assert.equal(s.status, 200);
       assert.equal(s.nativeReadFailed, true); assert.equal(s.readPendingAtFirstCancel, true);
       assert.equal(s.readCancelIntentional, true); assert.equal(s.readCancelSucceeded, true);
       assert.equal(s.readOutcomeReleased, false); assert.equal(s.readReturned, false);
      }
      assert.equal(s.completionDone, false); assert.equal(s.unlocked, false); assert.equal(s.cancels, 1); assert.ok(s.charged > 0);
      const order = id === 'account-last' ? ['delivery','archive','accounting'] : id === 'archive-last' ? ['accounting','delivery','archive'] : ['archive','accounting','delivery'];
      for (const [index, phase] of order.entries()) {
        hostPhase = phase;
        if (phase === 'delivery') {
          release(id+'/read-return');
          if (id.startsWith('sse-') || normalization) {
             s = await wait(s => s.r2Returned && s.accountDone && (normalization || s.readOutcomeReleased));
            assert.equal(s.completionDone, false); assert.ok(s.charged > 0);
            assert.equal(s.unlocked, false); assert.equal(s.cancelReturned, false); assert.equal(s.cancels, 1);
          }
          release(id+'/cancel');
        } else release(id+'/'+phase);
        if (index < 2) {
          s = await wait(s => phase === 'delivery' ? s.unlocked : phase === 'archive' ? s.r2Returned : s.accountDone);
          assert.equal(s.completionDone, false); assert.ok(s.charged > 0);
          if (id.startsWith('sse-') || normalization) { assert.equal(s.unlocked, false); assert.equal(s.cancelReturned, false); assert.equal(s.cancels, 1); }
        }
      }
      release(id+'/provider-eof');
      hostPhase = 'originating-client-join'; diagnostic();
      const result = await value(client);
      assert.equal(result.closed, true); assert.equal(result.completionDone, true); assert.equal(result.completionFailed, false);
      assert.equal(result.expectedReadFailures, normalization ? 0 : 2); assert.equal(result.independentRootFailures, 0);
      for (const root of Object.values(result.roots)) assert.equal(root.settled, root.started, 'ALL original and child roots joined');
      assert.equal(result.charged, 0); assert.equal(result.originalIds, 4); assert.equal(result.usage, 1); assert.equal(result.posts, 1); assert.ok(result.archiveBytes > 1024*1024);
    }
  } catch (error) { hasPrimary = true; primary = error; diagnostic(); throw error; }
});

// Synthetic promise schedules exercise the SAME observer injected into Workerd.
// All finite promises settle and join before assertions; no native-I/O claim.
test('second-read fixture preserves independent failure before FIRST cancellation, including undefined', async () => {
  const shared = Error('synthetic shared read reason');
  for (const reason of [undefined, shared]) {
    const roots = [], state = {};
    const track = (work, kind, provenance) => { roots.push(work.then(() => ({ failed: false, kind, provenance }), error => ({ failed: true, error, kind, provenance }))); return work; };
    const read = heldSecondRead(Promise.reject(reason), () => Promise.resolve(), track, state);
    await read.observed; // The failure is observed BEFORE the controlled cancel.
    read.firstCancel(true); read.cancelSucceeded();
    await read.propagated; const outcomes = await Promise.all(roots);
    assert.equal(state.readPendingAtFirstCancel, false);
    assert.equal(outcomes.length, 2);
    for (const outcome of outcomes) {
      assert.equal(outcome.failed, true); assert.equal(read.expected(outcome), false);
      assert.ok(Object.hasOwn(outcome, 'error')); assert.ok(Object.is(outcome.error, reason));
    }
    assert.ok(Object.is(read.outcomes().original.error, reason));
    assert.ok(Object.is(read.outcomes().propagated.error, reason));
  }
});

test('second-read fixture gates BOTH actual outcomes and forwards the original value or reason', async () => {
  const value = { done: true, value: new Uint8Array([1]) }, shared = Error('synthetic shared read reason');
  for (const source of [{ failed: false, value }, { failed: true, error: undefined }, { failed: true, error: shared }]) {
    const roots = [], state = { readOutcomeReleased: false, readReturned: false, propagatedReadSettled: false };
    const track = (work, kind, provenance) => { roots.push(work.then(() => ({ failed: false, kind, provenance }), error => ({ failed: true, error, kind, provenance }))); return work; };
    let resolve, reject, release;
    const original = new Promise((yes, no) => { resolve = yes; reject = no; });
    const gate = new Promise(yes => { release = yes; });
    const read = heldSecondRead(original, () => track(gate, 'gate'), track, state);
    read.firstCancel(true); read.cancelSucceeded();
    if (source.failed) reject(source.error); else resolve(source.value);
    await read.observed; const held = { ...state };
    release(); await read.propagated; const outcomes = await Promise.all(roots);
    assert.equal(held.readPendingAtFirstCancel, true); assert.equal(held.nativeReadSettled, true);
    assert.equal(held.readOutcomeReleased, false); assert.equal(held.propagatedReadSettled, false);
    assert.equal(state.readOutcomeReleased, true); assert.equal(state.readReturned, !source.failed);
    const actual = read.outcomes();
    assert.equal(actual.original.failed, source.failed); assert.equal(actual.propagated.failed, source.failed);
    if (source.failed) {
      assert.ok(Object.is(actual.original.error, source.error)); assert.ok(Object.is(actual.propagated.error, source.error));
      assert.equal(outcomes.filter(outcome => outcome.failed && read.expected(outcome)).length, 2);
    } else {
      assert.strictEqual(actual.original.value, value); assert.strictEqual(actual.propagated.value, value);
      assert.equal(outcomes.some(outcome => outcome.failed), false);
    }
  }
});

test('second-read fixture retains continuation, other-read and cleanup occurrences alongside expected rejection', async () => {
  const shared = Error('synthetic shared read and cleanup reason');
  for (const reason of [undefined, shared]) {
    const roots = [], state = {};
    const track = (work, kind, provenance) => { roots.push(work.then(() => ({ failed: false, kind, provenance }), error => ({ failed: true, error, kind, provenance }))); return work; };
    let reject; const original = new Promise((_, no) => { reject = no; });
    const read = heldSecondRead(original, () => track(Promise.reject(reason), 'gate'), track, state);
    read.firstCancel(true); read.cancelSucceeded();
    track(Promise.reject(reason), 'other-read'); track(Promise.reject(reason), 'unlock');
    reject(reason); await read.propagated; const outcomes = await Promise.all(roots);
    assert.equal(outcomes.length, 5); assert.equal(outcomes.every(outcome => outcome.failed), true);
    assert.equal(outcomes.filter(outcome => read.expected(outcome)).length, 1, 'only the ORIGINAL expected read, not the failed continuation');
    assert.ok(Object.is(read.outcomes().original.error, reason));
    const propagated = read.outcomes().propagated;
    assert.equal(propagated.failed, true); assert.ok(propagated.error instanceof AggregateError);
    assert.equal(propagated.error.errors.length, 2);
    for (const error of propagated.error.errors) assert.ok(Object.is(error, reason));
    assert.strictEqual(outcomes[1].error, propagated.error);
    for (const index of [0, 2, 3, 4]) assert.ok(Object.is(outcomes[index].error, reason));
    for (const outcome of outcomes.slice(2)) assert.equal(read.expected(outcome), false);
  }
});

test('second-read fixture keeps FIRST-cancel failure independent from the read outcomes', async () => {
  for (const reason of [undefined, Error('synthetic shared cancel reason')]) {
    const roots = [], state = {};
    const track = (work, kind, provenance) => { roots.push(work.then(() => ({ failed: false, kind, provenance }), error => ({ failed: true, error, kind, provenance }))); return work; };
    let reject; const original = new Promise((_, no) => { reject = no; });
    const read = heldSecondRead(original, () => Promise.resolve(), track, state);
    read.firstCancel(true); // The actual cancel rejects: never mark it successful.
    track(Promise.reject(reason), 'first-cancel'); reject(reason);
    await read.propagated; const outcomes = await Promise.all(roots);
    assert.equal(outcomes.length, 3);
    for (const outcome of outcomes) {
      assert.equal(outcome.failed, true); assert.equal(read.expected(outcome), false);
      assert.ok(Object.is(outcome.error, reason));
    }
  }
});
