import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const router = String.raw`
import {PolicyBindingIndexObject as Base} from './worker/authority.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {preflightCredential,releaseCredentialPreflight,prepareCredentialGeneration,completeCredentialGeneration,completeConsumableCredentialGeneration,authenticateCredentialGeneration,selectCredentialGeneration,flushCredentialGenerationRuntime,retainCredentialGenerationHint,prepareCredentialGenerationPrefetch,borrowCredentialGeneration,evictCredentialGeneration} from './worker/credential-preflight.ts';
import {prefetchOwnedGrantCredentials,evictGrantCredentials} from './worker/credential-cache.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {ExactBodyCharge,bodyBudgetCharged,bodyBudgetBytes} from './worker/body-budget.ts';
import {PreflightTicket,preflightPayloadBytes} from './worker/credential-preflight-arena.ts';
import {PrivateCacheReservation,privateCacheCharged,privateCacheLimits,setHotCacheClock,tryRunInBackground,BACKGROUND_WORK_LIMIT} from './worker/hot-cache.ts';
import {isIdentityFailure} from './worker/identity-admission.ts';
import {measureGenerationGraph,freezeGenerationGraph} from './worker/identity-generations.ts';
const digest='ab'.repeat(32),rotated='cd'.repeat(32),kid='nativegeneration';
let releaseCohortBlockers;
const on={maxAgeMs:60000,freshMs:10000},off={maxAgeMs:0,freshMs:0};
const check=(ok,label)=>{if(!ok)throw Error(label);};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});void promise.then(()=>{},()=>{});return {promise,resolve};};
const record=secret=>({enabled:true,secretSha256:secret,policyId:'native-generation-policy',policyGeneration:'legacy',principalId:null});
export class PolicyBindingIndexObject extends Base {
 constructor(state,env){
  const trace={intakes:0,preflights:0,kv:[]},native=env.POLICY_KV,get=native.get.bind(native);
  const kv=new Proxy(native,{get(target,key){if(key==='get')return async(name,type)=>{
   const body=await get(name,type);
   if(type==='stream'&&body){const row={byob:false,reads:0,eof:false,unlocked:false,backing:0};trace.kv.push(row);
    const acquire=body.getReader.bind(body);body.getReader=options=>{row.byob=options?.mode==='byob';const reader=acquire(options),read=reader.read.bind(reader),unlock=reader.releaseLock.bind(reader);
     reader.read=(...args)=>{const original=read(...args);row.reads++;void original.then(value=>{if(value.done)row.eof=true;if(value.value)row.backing=Math.max(row.backing,value.value.buffer.byteLength);},()=>{});return original;};
     reader.releaseLock=()=>{unlock();row.unlocked=!body.locked;};return reader;};
   }return body;
  };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  super(state,new Proxy(env,{get(target,key,receiver){return key==='POLICY_KV'?kv:Reflect.get(target,key,receiver);}}));
  const sql=state.storage.sql;
  this.reset=()=>{for(const table of ['proxy_credentials','access_policies','policy_binding_meta','upstream_grant_pool_versions','upstream_grant_pool_members','upstream_grant_projections'])sql.exec('DELETE FROM '+table);trace.intakes=0;trace.preflights=0;trace.kv=[];};
  this.rotate=()=>sql.exec('UPDATE proxy_credentials SET credential_json=? WHERE credential_id=?',JSON.stringify(record(rotated)),kid);
  this.snapshot=()=>({trace,charged:this.preflightArena?.charged??0,credentials:[...sql.exec('SELECT credential_json FROM proxy_credentials')].length,policies:[...sql.exec('SELECT policy_json FROM access_policies')].length});
  this.cohortHeld=false;this.cohortArrived=false;this.holdRecord=false;trace.records=0;
  this.armCohort=()=>{this.cohortHeld=true;this.cohortArrived=false;this.holdRecord=true;trace.records=0;sql.exec('DELETE FROM upstream_grant_selection');};
  this.selectedCount=()=>[...sql.exec('SELECT COALESCE(SUM(selected_count),0) AS n FROM upstream_grant_selection')][0].n;
  this.trace=trace;
 }
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/fixture/reset'){this.reset();return new Response('reset');}
  if(path==='/fixture/rotate'){this.rotate();return new Response('rotated');}
  if(path==='/fixture/cohort-arm'){this.armCohort();return new Response('armed');}
  // Fixture gates share ONLY scalars. Each request creates and awaits its OWN
  // timer roots; a foreign request never resolves the ORIGINAL I/O continuation.
  if(path==='/fixture/cohort-arrival'){while(!this.cohortArrived&&this.cohortHeld)await new Promise(resolve=>setTimeout(resolve,1));return new Response('entered');}
  if(path==='/fixture/cohort-release'){this.cohortHeld=false;return new Response('released');}
  if(path==='/fixture/result')return Response.json({...this.snapshot(),selectedCount:this.selectedCount()});
  if(path==='/grant-pools/record'){const hold=this.holdRecord;this.holdRecord=false;this.trace.records++;const response=await super.fetch(request);if(hold){this.cohortArrived=true;while(this.cohortHeld)await new Promise(resolve=>setTimeout(resolve,1));}return response;}
  if(path==='/admission/credential-preflight')this.trace.preflights++;
  if(path==='/admission/resolve')this.trace.intakes++;
  return super.fetch(request);
 }
}
export default {async fetch(request,env){
 const mode=new URL(request.url).pathname.slice(1),stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings'));
 const roots=[],origins=new WeakMap();let proof,prep,borrow,auth,selected,hint,pressure,hasPrimary=false,primary,result;const releases=[];
 const cohortPrepare=mode==='cohort-prepare',prefetch=mode.startsWith('prefetch-'),poolMode=prefetch||cohortPrepare,key='oauth/native-generation-policy/prefetch';
 const selection={providerId:'anthropic',endpointId:'messages',mode:'http',capability:'llm.messages'};
 const input=poolMode?{providers:[{id:'anthropic',tokenRef:'anthropic'}],snapshot:'only',selection}:{providers:[]};
 const coverage={...input,allConnections:false};
 const own=promise=>{const existing=origins.get(promise);if(existing)return existing;const root={outcome:promise.then(value=>({failed:false,value}),error=>({failed:true,error})),used:false};roots.push(root);origins.set(promise,root);return root;};
 const take=async root=>{const outcome=await root.outcome;root.used=true;if(outcome.failed)throw outcome.error;return outcome.value;};
 const rpc=async(path,init)=>{const response=await take(own(stub.fetch('https://authority'+path,init))),body=await take(own(response.text()));check(response.status===200,'fixture RPC');return body;};

 if(mode==='cohort-arrival'){await rpc('/fixture/cohort-arrival');return new Response('entered');}
 if(mode==='cohort-release'){await rpc('/fixture/cohort-release');releaseCohortBlockers?.();releaseCohortBlockers=undefined;evictCredentialGeneration(env,kid);return new Response('released');}
 if(mode==='cohort-a'||mode==='cohort-b'){
  let hasFailure=false,failure,answer;
  try{
   const request={providers:[{id:'anthropic',tokenRef:'anthropic'}],snapshot:'only',selection};
   borrow=borrowCredentialGeneration(env,kid,digest,on);check(!!borrow,'genuine cohort generation hit');
   auth=authenticateCredentialGeneration(borrow,env,{...request,allConnections:false});
   selected=selectCredentialGeneration(auth,env,selection);check(selected?.selected()&&selected.flush.accepted===false,'saturated automatic registration starts nothing');
   // The explicit receipt is this request's fixed claimed cohort. B must finish
   // while A's original transport is still held inside the native authority.
   await take(own(flushCredentialGenerationRuntime(auth,env)));
   const observed=JSON.parse(await rpc('/fixture/result'));
   answer={mode,selectedCount:observed.selectedCount,records:observed.trace.records};
   if(mode==='cohort-b')evictCredentialGeneration(env,kid);
  }catch(error){hasFailure=true;failure=error;}
  const errors=[];
  for(let i=0;i<roots.length;i++){const outcome=await roots[i].outcome;if(outcome.failed&&!roots[i].used){roots[i].used=true;errors.push(outcome.error);}}
  for(const release of [()=>selected?.dispose(),()=>auth?.dispose(),()=>borrow?.dispose()])try{release();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(hasFailure?[failure,...errors]:errors,'cohort request cleanup');if(hasFailure)throw failure;
  return Response.json({...answer,charged:bodyBudgetCharged()});
 }
 const baseline=bodyBudgetCharged();
 try{
  await rpc('/fixture/reset');
  await env.POLICY_KV.put('credentials/'+kid,JSON.stringify({...record(digest),...(mode==='disabled'?{enabled:false}:{})}));
  await env.POLICY_KV.put('policies/native-generation-policy',JSON.stringify({enabled:true,generation:'legacy',providers:[],requestCostMicros:7}));
  if(poolMode){await take(own(putGrantCredentials(env,key,{provider:'anthropic',kind:'api_key',enabled:true,credential:'fixture-native-only'})));evictGrantCredentials(key);}
  if(cohortPrepare)await rpc('/fixture/cohort-arm');
  const preflight=await take(own(preflightCredential(env,kid,digest)));if(preflight.outcome==='matched')proof=preflight.proof;
  check(!!proof,'correct secret is preliminary match even when disabled');
  let denied=false;try{authenticateCredentialGeneration(proof,env,{providers:[],allConnections:false});}catch(error){denied=isIdentityFailure(error);}
  check(denied,'preverification is not authentication');
  prep=prepareCredentialGeneration(proof);proof=undefined;
  const operation=completeConsumableCredentialGeneration(prep,input,on);prep=undefined;
  borrow=await take(own(operation));
  if(mode==='coverage-denied'){
   denied=false;try{authenticateCredentialGeneration(borrow,env,{providers:[],allConnections:true});}catch(error){denied=isIdentityFailure(error);}
   check(denied,'missing trusted facet denies');
  }
  if(mode==='pressure'){
   pressure=ExactBodyCharge.reserve(bodyBudgetBytes-bodyBudgetCharged()-4095);check(!!pressure,'common pressure');
   denied=false;try{authenticateCredentialGeneration(borrow,env,coverage);}catch(error){denied=isIdentityFailure(error);}
   check(denied,'common capacity before derived auth');pressure.release();pressure=undefined;
  }
  auth=authenticateCredentialGeneration(borrow,env,coverage);
  check(auth.status()===(mode==='disabled'?403:200),'ordinary lifecycle verdict');
  check(auth.code()===(mode==='disabled'?'proxy_key_revoked':undefined),'ordinary lifecycle classification');
  if(prefetch){
   selected=selectCredentialGeneration(auth,env,selection);if(selected?.flush.accepted)await take(own(selected.flush.completed));check(!!selected?.selected(),'native local selection');
   hint=retainCredentialGenerationHint(selected);await take(own(flushCredentialGenerationRuntime(auth,env)));
   const entered=deferred(),release=deferred(),cancelEntered=deferred();releases.push(()=>release.resolve());
   const native=env.GRANT_CREDENTIALS,rows=[];let calls=0,first=true;
   const wrapped=new Proxy(native,{get(target,name){if(name==='get')return id=>{const object=target.get(id);return new Proxy(object,{get(stub,name){if(name==='fetch')return async(...args)=>{
    calls++;const response=await stub.fetch(...args),body=response.body;check(!!body,'materialization body');
    const row={byob:false,read:0,eof:false,cancel:0,unlock:false,backing:0},acquire=body.getReader.bind(body);rows.push(row);
    body.getReader=options=>{row.byob=options?.mode==='byob';const reader=acquire(options),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),unlock=reader.releaseLock.bind(reader);
     reader.read=(...args)=>{const original=read(...args);row.read++;return original.then(async value=>{if(value.done)row.eof=true;if(value.value)row.backing=Math.max(row.backing,value.value.buffer.byteLength);if(first){first=false;entered.resolve();if(mode==='prefetch-held-read')await release.promise;if(mode==='prefetch-held-cancel')throw undefined;}return value;});};
     reader.cancel=(...args)=>{row.cancel++;const original=cancel(...args);void original.then(()=>{},()=>{});return (async()=>{let failed=false,reason;try{await original;}catch(error){failed=true;reason=error;}cancelEntered.resolve();if(mode==='prefetch-held-cancel')await release.promise;if(failed)throw reason;})();};
     reader.releaseLock=()=>{unlock();row.unlock=!body.locked;if(mode==='prefetch-unlock-failure')throw Error('fixture post-native unlock failure');};return reader;};return response;
   };const value=Reflect.get(stub,name,stub);return typeof value==='function'?value.bind(stub):value;}});};const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
   const prefEnv=new Proxy(env,{get(target,name,receiver){return name==='GRANT_CREDENTIALS'?wrapped:Reflect.get(target,name,receiver);}});
   const receipt=prefetchOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint,prefEnv));check(receipt.accepted,'accepted native prefetch');const root=own(receipt.completed);
   if(mode==='prefetch-held-read'||mode==='prefetch-held-cancel'){
    const event=mode==='prefetch-held-cancel'?cancelEntered.promise:entered.promise;
    const arrival=await Promise.race([event.then(()=>({entered:true})),root.outcome.then(outcome=>({entered:false,outcome}))]);
    if(!arrival.entered){root.used=true;if(arrival.outcome.failed)throw arrival.outcome.error;throw Error('prefetch finished before post-native fixture hold');}
    hint.dispose();hint=undefined;selected.dispose();selected=undefined;auth.dispose();auth=undefined;borrow.dispose();borrow=undefined;evictCredentialGeneration(env,kid);evictGrantCredentials(key);
    check(bodyBudgetCharged()>=preflightPayloadBytes,'hint child retained through actual wrapper root');
    if(mode==='prefetch-held-cancel')check(rows[0].cancel===1&&!rows[0].unlock,'FIRSTcancel held before unlock');
   }
   release.resolve();let failed=false,reason;try{await take(root);}catch(error){failed=true;reason=error;}
   if(mode==='prefetch-held-cancel'||mode==='prefetch-unlock-failure')check(failed&&isIdentityFailure(reason),'injected post-native read/unlock failure');else if(failed)throw reason;
   check(calls===1,'one materialization');for(const row of rows)check(row.byob&&row.read>0&&row.backing<=16384&&row.unlock&&(mode==='prefetch-held-cancel'?row.cancel===1:row.eof),'original native response reader custody');
   result={mode,materializations:calls,materializationReads:rows[0].read,postNativeHold:mode==='prefetch-held-read'||mode==='prefetch-held-cancel'};
  }
  if(cohortPrepare){
   const release=deferred();releaseCohortBlockers=release.resolve;
   for(let i=0;i<BACKGROUND_WORK_LIMIT;i++){const original=release.promise.then(()=>undefined);void original.then(()=>{},()=>{});check(tryRunInBackground(()=>original),'fixture background saturation');}
  }
  if(borrow){borrow.dispose();borrow=undefined;}if(!cohortPrepare)evictCredentialGeneration(env,kid);
  if(auth)check(bodyBudgetCharged()>baseline,'derived owner retains generation after eviction');
  const observed=JSON.parse(await rpc('/fixture/result'));
  check(observed.trace.intakes===1,'auth is RPC free');check(observed.trace.kv.length>0,'actual cold KV');
  for(const row of observed.trace.kv)check(row.byob&&row.reads>0&&row.eof&&row.unlocked&&row.backing<=16384,'original native KV custody');
  result={...result,mode,intakes:observed.trace.intakes,nativeReads:observed.trace.kv.length};
 }catch(error){hasPrimary=true;primary=error;}
 const failures=[];
 for(const release of releases)try{release();}catch(error){failures.push(error);}
 pressure?.release();if(!cohortPrepare||hasPrimary)evictCredentialGeneration(env,kid);evictGrantCredentials(key);
 if(prefetch&&auth)try{own(flushCredentialGenerationRuntime(auth,env));}catch(error){failures.push(error);}
 for(let i=0;i<roots.length;i++){const outcome=await roots[i].outcome;if(outcome.failed&&!roots[i].used){roots[i].used=true;failures.push(outcome.error);}}
 for(const release of [()=>hint?.dispose(),()=>selected?.dispose(),()=>auth?.dispose(),()=>borrow?.dispose(),()=>prep?.dispose(),()=>{if(proof)releaseCredentialPreflight(proof);}])try{release();}catch(error){failures.push(error);}
 if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'owned native roots');if(hasPrimary)throw primary;
 check(cohortPrepare?bodyBudgetCharged()>baseline:bodyBudgetCharged()===baseline,'last actual consumer or retained publication funding');
 return Response.json({...result,charged:bodyBudgetCharged()});
}};
`;
const upstream = `export default {fetch(){throw Error('unexpected provider dispatch')}}`;

test('inactive owned generation consumption uses actual native KV/SQLite, prefetch cleanup and foreign-request cohorts', { timeout: 120000 }, async t => {
  const roots = [], releases = []; let directory, runtime, cleanupPromise, finished = false, hasPrimary = false, primary;
  const own = promise => { const root = { outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })), used: false }; roots.push(root); return root; };
  const take = async root => { const value = await root.outcome; root.used = true; if (value.failed) throw value.error; return value.value; };
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (const release of releases) try { await release(); } catch (error) { failures.push(error); }
    for (let i = 0; i < roots.length; i++) { const outcome = await roots[i].outcome; if (outcome.failed && !roots[i].used) { roots[i].used = true; failures.push(outcome.error); } }
    if (runtime) try { await runtime.dispose(); } catch (error) { failures.push(error); }
    if (directory) try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (!finished) { const failures = await cleanup(); if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures); } });
  try {
    directory = await mkdtemp(join(tmpdir(), 'identity-generations-'));
    runtime = await take(own(startWorkerdFixture(directory, router, upstream, { preventEviction: true })));
    for (const mode of ['owned-auth', 'coverage-denied', 'disabled', 'pressure', 'prefetch-healthy', 'prefetch-held-read', 'prefetch-held-cancel', 'prefetch-unlock-failure']) {
      const response = await take(own(runtime.dispatchFetch('https://fixture/' + mode)));
      const body = await take(own(response.text())); assert.equal(response.status, 200, mode);
      const result = JSON.parse(body);
      const log = typeof t.log === 'function' ? t.log : t.diagnostic;
      try { if (typeof log === 'function') Reflect.apply(log, t, [JSON.stringify({ fixture: 'identity-generations', case: mode, status: response.status, nativeReads: result.nativeReads ?? 0, intakes: result.intakes ?? 0 })]); } catch {}
      assert.equal(result.charged, 0); assert.ok(result.nativeReads > 0); assert.equal(result.intakes, 1); if (mode.startsWith('prefetch-')) { assert.equal(result.materializations, 1); assert.ok(result.materializationReads > 0); }
    }
    let cohortOpen = true;
    const releaseCohort = async () => { if (!cohortOpen) return; cohortOpen = false; const response = await take(own(runtime.dispatchFetch('https://fixture/cohort-release'))); await take(own(response.text())); assert.equal(response.status, 200); };
    releases.push(releaseCohort);
    const prepared = await take(own(runtime.dispatchFetch('https://fixture/cohort-prepare'))); await take(own(prepared.text())); assert.equal(prepared.status, 200);
    const first = own(runtime.dispatchFetch('https://fixture/cohort-a'));
    const barrier = own(runtime.dispatchFetch('https://fixture/cohort-arrival'));
    const arrived = await Promise.race([barrier.outcome.then(outcome => ({ entered: true, outcome })), first.outcome.then(outcome => ({ entered: false, outcome }))]);
    if (!arrived.entered) { const response = await take(first); const body = await take(own(response.text())); assert.fail('cohort A returned before hold: ' + response.status); }
    const arrivalResponse = await take(barrier); await take(own(arrivalResponse.text())); assert.equal(arrivalResponse.status, 200);
    const secondResponse = await take(own(runtime.dispatchFetch('https://fixture/cohort-b'))), secondBody = await take(own(secondResponse.text()));
    assert.equal(secondResponse.status, 200); const second = JSON.parse(secondBody); assert.equal(second.selectedCount, 2); assert.equal(second.records, 2); assert.ok(second.charged > 0);
    await releaseCohort();
    const firstResponse = await take(first), firstBody = await take(own(firstResponse.text())); assert.equal(firstResponse.status, 200);
    const final = JSON.parse(firstBody); assert.equal(final.selectedCount, 2); assert.equal(final.records, 2); assert.equal(final.charged, 0);
    const log = typeof t.log === 'function' ? t.log : t.diagnostic;
    try { if (typeof log === 'function') Reflect.apply(log, t, [JSON.stringify({ fixture: 'identity-generations', case: 'foreign-cohorts', status: 200, records: final.records, selectedCount: final.selectedCount, charged: final.charged })]); } catch {}
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'native generation roots');
  if (hasPrimary) throw primary;
});
