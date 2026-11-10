import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const router = String.raw`
import {PolicyBindingIndexObject as Base} from './worker/authority.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {preflightCredential,releaseCredentialPreflight,prepareCredentialGeneration,completeCredentialGeneration,completeConsumableCredentialGeneration,authenticateCredentialGeneration,selectCredentialGeneration,flushCredentialGenerationRuntime,queueCredentialGenerationRuntime,retainCredentialGenerationHint,prepareCredentialGenerationPrefetch,adoptCredentialGenerationDestination,borrowCredentialGeneration,evictCredentialGeneration} from './worker/credential-preflight.ts';
import {prefetchOwnedGrantCredentials,borrowOwnedGrantCredentials,evictOwnedGrantCredentials,evictGrantCredentials} from './worker/credential-cache.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {ExactBodyCharge,bodyBudgetCharged,bodyBudgetBytes} from './worker/body-budget.ts';
import {PreflightTicket,preflightPayloadBytes} from './worker/credential-preflight-arena.ts';
import {PrivateCacheReservation,privateCacheCharged,privateCacheLimits,setHotCacheClock,tryRunInBackground,BACKGROUND_WORK_LIMIT} from './worker/hot-cache.ts';
import {isIdentityFailure} from './worker/identity-admission.ts';
import {measureGenerationGraph,freezeGenerationGraph} from './worker/identity-generations.ts';
const digest='ab'.repeat(32),rotated='cd'.repeat(32),kid='nativegeneration';
let cohortBlockersReleased=false,cohortReady=false;
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
  this.reset=()=>{for(const table of ['proxy_credentials','access_policies','policy_binding_meta','upstream_grant_pool_versions','upstream_grant_pool_members','upstream_grant_projections','upstream_grant_selection','upstream_grant_runtime'])sql.exec('DELETE FROM '+table);trace.intakes=0;trace.preflights=0;trace.kv=[];};
  this.rotate=()=>sql.exec('UPDATE proxy_credentials SET credential_json=? WHERE credential_id=?',JSON.stringify(record(rotated)),kid);
  this.snapshot=()=>({trace,charged:this.preflightArena?.charged??0,credentials:[...sql.exec('SELECT credential_json FROM proxy_credentials')].length,policies:[...sql.exec('SELECT policy_json FROM access_policies')].length});
  this.cohortHeld=false;this.cohortArrived=false;this.holdRecord=false;trace.records=0;
  this.armCohort=()=>{this.cohortHeld=true;this.cohortArrived=false;this.holdRecord=true;trace.records=0;sql.exec('DELETE FROM upstream_grant_selection');};
  this.selectedCount=()=>[...sql.exec('SELECT COALESCE(SUM(selected_count),0) AS n FROM upstream_grant_selection')][0].n;
  this.selectionPair=()=>{for(const token of ['a','b']){const key='oauth/native-generation-policy/'+token;
   const grant={provider:'anthropic',kind:'api_key',enabled:true,priority:4,credentialStore:'durable_object',credentialStatus:'active',credentialGeneration:1,credentialLineage:'fixture_generation',hasCredential:true,unknownGenerationField:{token}};
   sql.exec('INSERT INTO upstream_grant_pool_versions(grant_key,generation,revision) VALUES(?,?,?)',key,1,7);
   sql.exec('INSERT INTO upstream_grant_pool_members(scope,scope_id,provider_id,token_ref,status) VALUES(?,?,?,?,?)','policies','native-generation-policy','anthropic',token,'active');
   sql.exec('INSERT INTO upstream_grant_projections(grant_key,projection_json,legacy) VALUES(?,?,0)',key,JSON.stringify(grant));
  }};
  this.feedbackHeld=false;this.feedbackArrived=false;
  this.trace=trace;
 }
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/fixture/reset'){this.reset();return new Response('reset');}
  if(path==='/fixture/rotate'){this.rotate();return new Response('rotated');}
  if(path==='/fixture/selection-pair'){this.selectionPair();return new Response('seeded');}
  if(path==='/fixture/feedback-arm'){this.feedbackHeld=true;this.feedbackArrived=false;return new Response('armed');}
  if(path==='/fixture/feedback-release'){this.feedbackHeld=false;return new Response('released');}
  if(path==='/fixture/feedback-arrival'){while(!this.feedbackArrived&&this.feedbackHeld)await new Promise(resolve=>setTimeout(resolve,1));return new Response('entered');}
  if(path==='/grant-pools/feedback'&&this.feedbackHeld){this.feedbackArrived=true;while(this.feedbackHeld)await new Promise(resolve=>setTimeout(resolve,1));}
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
 const roots=[],origins=new WeakMap();let proof,prep,borrow,auth,selected,hint,pressure,destinationBorrow,prefetchEnv,secondBorrow,secondAuth,secondSelected,hasPrimary=false,primary,result;const releases=[];
 const cohortPrepare=mode==='cohort-prepare',prefetch=mode.startsWith('prefetch-'),pairMode=mode==='origin-select'||mode==='shared-runtime',poolMode=prefetch||cohortPrepare||pairMode,key='oauth/native-generation-policy/prefetch';
 const selection={providerId:'anthropic',endpointId:'messages',mode:'http',capability:'llm.messages'};
 const input=poolMode?{providers:[{id:'anthropic',tokenRef:'anthropic'}],snapshot:mode==='origin-select'?'select':'only',selection}:{providers:[]};
 const coverage={...input,allConnections:false};
 const own=promise=>{const existing=origins.get(promise);if(existing)return existing;const root={outcome:promise.then(value=>({failed:false,value}),error=>({failed:true,error})),used:false};roots.push(root);origins.set(promise,root);return root;};
 const take=async root=>{const outcome=await root.outcome;root.used=true;if(outcome.failed)throw outcome.error;return outcome.value;};
 const rpc=async(path,init)=>{const response=await take(own(stub.fetch('https://authority'+path,init))),body=await take(own(response.text()));check(response.status===200,'fixture RPC');return body;};

 if(mode==='cohort-arrival'){await rpc('/fixture/cohort-arrival');return new Response('entered');}
 if(mode==='cohort-ready'){while(!cohortReady&&!cohortBlockersReleased)await new Promise(resolve=>setTimeout(resolve,1));return new Response(cohortReady?'ready':'released');}
 if(mode==='cohort-finished')return Response.json({charged:bodyBudgetCharged()});
 if(mode==='cohort-release'){cohortBlockersReleased=true;await rpc('/fixture/cohort-release');evictCredentialGeneration(env,kid);return new Response('released');}
 if(mode==='cohort-a'||mode==='cohort-b'){
  let hasFailure=false,failure,answer,pending;
  try{
   const request={providers:[{id:'anthropic',tokenRef:'anthropic'}],snapshot:'only',selection};
   borrow=borrowCredentialGeneration(env,kid,digest,on);check(!!borrow,'genuine cohort generation hit');
   auth=authenticateCredentialGeneration(borrow,env,{...request,allConnections:false});
   selected=selectCredentialGeneration(auth,env,selection);check(selected?.selected()&&selected.flush.accepted===false,'saturated automatic registration starts nothing');
   pending=selected.flush.pending;check(!!pending,'refused registration transfers pending ownership');
   selected.dispose();selected=undefined;auth.dispose();auth=undefined;borrow.dispose();borrow=undefined;
   if(mode==='cohort-b')evictCredentialGeneration(env,kid);
   // No public auth survives. This request's genuine cap owns its fixed cohort;
   // B still finishes while A's original native transport remains held.
   const drain=pending.drain();pending=undefined;await take(own(drain));
   const observed=JSON.parse(await rpc('/fixture/result'));
   answer={mode,selectedCount:observed.selectedCount,records:observed.trace.records};
   if(mode==='cohort-b')evictCredentialGeneration(env,kid);
  }catch(error){hasFailure=true;failure=error;}
  const errors=[];
  for(let i=0;i<roots.length;i++){const outcome=await roots[i].outcome;if(outcome.failed&&!roots[i].used){roots[i].used=true;errors.push(outcome.error);}}
  for(const release of [()=>pending?.dispose(),()=>{if(selected&&!selected.flush.accepted)selected.flush.pending?.dispose();},()=>selected?.dispose(),()=>auth?.dispose(),()=>borrow?.dispose()])try{release();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(hasFailure?[failure,...errors]:errors,'cohort request cleanup');if(hasFailure)throw failure;
  return Response.json({...answer,charged:bodyBudgetCharged()});
 }
 const baseline=bodyBudgetCharged();
 try{
  await rpc('/fixture/reset');
  await env.POLICY_KV.put('credentials/'+kid,JSON.stringify({...record(digest),...(mode==='disabled'?{enabled:false}:{})}));
  await env.POLICY_KV.put('policies/native-generation-policy',JSON.stringify({enabled:true,generation:'legacy',providers:[],requestCostMicros:7,...(pairMode?{grantRouting:{strategy:'round_robin'}}:{})}));
  if(pairMode){await env.POLICY_KV.delete(key);await rpc('/fixture/selection-pair');}
  if(poolMode&&!pairMode){await take(own(putGrantCredentials(env,key,{provider:'anthropic',kind:'api_key',enabled:true,credential:'fixture-native-only'})));evictGrantCredentials(key);}
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
  if(mode==='origin-select'){
   check(JSON.parse(await rpc('/fixture/result')).selectedCount===1,'authority counted original A once');
   selected=selectCredentialGeneration(auth,env,selection);check(selected?.matchesKey('oauth/native-generation-policy/a'),'origin keeps authority A');
   check(!selected.flush.accepted&&!selected.flush.pending,'origin adds no advisory count');
   secondBorrow=borrowCredentialGeneration(env,kid,digest,on);check(!!secondBorrow,'later native genuine hit');
   secondAuth=authenticateCredentialGeneration(secondBorrow,env,coverage);
   secondSelected=selectCredentialGeneration(secondAuth,env,selection);check(secondSelected?.matchesKey('oauth/native-generation-policy/b'),'later native borrower B');
   if(secondSelected.flush.accepted)await take(own(secondSelected.flush.completed));
   check(JSON.parse(await rpc('/fixture/result')).selectedCount===2,'two selections exactly two counts');
  }
  if(mode==='shared-runtime'){
   releases.push(()=>rpc('/fixture/feedback-release'));await rpc('/fixture/feedback-arm');
   const receipt=queueCredentialGenerationRuntime(auth,'oauth/native-generation-policy/a',{status:'cooldown',observedAt:new Date().toISOString(),source:'provider_response',cooldownUntil:new Date(Date.now()+60000).toISOString(),lastSignal:'rate_limited',grantRevision:null,windows:[]});
   check(receipt.accepted,'native pending runtime registered');const feedback=own(receipt.completed),arrival=own(rpc('/fixture/feedback-arrival'));
   const reached=await Promise.race([arrival.outcome.then(()=>true),feedback.outcome.then(()=>false)]);
   if(!reached){await take(feedback);throw Error('native feedback completed before hold');}await take(arrival);
   const nextRequest={...input,snapshot:'select'},nextCoverage={...nextRequest,allConnections:false};
   const nextProof=await take(own(preflightCredential(env,kid,digest)));check(nextProof.outcome==='matched','successor preverify');proof=nextProof.proof;
   prep=prepareCredentialGeneration(proof);proof=undefined;const next=completeConsumableCredentialGeneration(prep,nextRequest,on);prep=undefined;secondBorrow=await take(own(next));
   secondAuth=authenticateCredentialGeneration(secondBorrow,env,nextCoverage);
   check(JSON.parse(await rpc('/fixture/result')).selectedCount===0,'pending runtime defers authority choice');
   secondSelected=selectCredentialGeneration(secondAuth,env,selection);check(secondSelected?.matchesKey('oauth/native-generation-policy/b'),'successor sees pending cooldown');
   if(secondSelected.flush.accepted)await take(own(secondSelected.flush.completed));
   await rpc('/fixture/feedback-release');await take(feedback);
   selected=selectCredentialGeneration(auth,env,selection);check(selected?.matchesKey('oauth/native-generation-policy/b'),'old owner retains cooldown after ACK');
   if(selected.flush.accepted)await take(own(selected.flush.completed));
  }
  if(prefetch){
   selected=selectCredentialGeneration(auth,env,selection);if(selected?.flush.accepted)await take(own(selected.flush.completed));check(!!selected?.selected(),'native local selection');
   hint=retainCredentialGenerationHint(selected);await take(own(flushCredentialGenerationRuntime(auth,env)));
   const entered=deferred(),release=deferred(),cancelEntered=deferred();releases.push(()=>release.resolve());
   const native=env.GRANT_CREDENTIALS,rows=[];let calls=0,first=true;
   const wrapped=new Proxy(native,{get(target,name){if(name==='get')return id=>{const object=target.get(id);return new Proxy(object,{get(stub,name){if(name==='fetch')return async(...args)=>{
    calls++;const response=await stub.fetch(...args),body=response.body;check(!!body,'materialization body');
    const row={byob:false,read:0,eof:false,cancel:0,unlock:false,backing:0},acquire=body.getReader.bind(body);rows.push(row);
    body.getReader=options=>{row.byob=options?.mode==='byob';const reader=acquire(options),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),unlock=reader.releaseLock.bind(reader);
     reader.read=(...args)=>{const original=read(...args);row.read++;return original.then(async value=>{if(value.done)row.eof=true;if(value.value)row.backing=Math.max(row.backing,value.value.buffer.byteLength);if(first){first=false;entered.resolve();if(mode==='prefetch-held-read'||mode==='prefetch-joined')await release.promise;if(mode==='prefetch-held-cancel')throw undefined;}return value;});};
     reader.cancel=(...args)=>{row.cancel++;const original=cancel(...args);void original.then(()=>{},()=>{});return (async()=>{let failed=false,reason;try{await original;}catch(error){failed=true;reason=error;}cancelEntered.resolve();if(mode==='prefetch-held-cancel')await release.promise;if(failed)throw reason;})();};
     reader.releaseLock=()=>{unlock();row.unlock=!body.locked;if(mode==='prefetch-unlock-failure')throw Error('fixture post-native unlock failure');};return reader;};return response;
   };const value=Reflect.get(stub,name,stub);return typeof value==='function'?value.bind(stub):value;}});};const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
   const prefEnv=new Proxy(env,{get(target,name,receiver){return name==='GRANT_CREDENTIALS'?wrapped:Reflect.get(target,name,receiver);}});
   prefetchEnv=prefEnv;const beforePrefetch=bodyBudgetCharged();
   if(mode==='prefetch-admission-pressure'){
    const vector=JSON.stringify(privateCacheCharged());pressure=ExactBodyCharge.reserve(bodyBudgetBytes-beforePrefetch-preflightPayloadBytes+1);check(!!pressure,'temporary pressure');
    let refused=false;try{prepareCredentialGenerationPrefetch(hint,prefEnv);}catch(error){refused=isIdentityFailure(error);}
    check(refused&&calls===0&&JSON.stringify(privateCacheCharged())===vector,'capacity before traversal/index/materialization');pressure.release();pressure=undefined;
    check(bodyBudgetCharged()===beforePrefetch,'temporary refusal preserves debit');
   }
   const receipt=prefetchOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint,prefEnv));check(receipt.accepted,'accepted native prefetch');const root=own(receipt.completed);
   if(mode==='prefetch-joined'){
    const arrival=await Promise.race([entered.promise.then(()=>true),root.outcome.then(()=>false)]);
    if(!arrival){await take(root);throw Error('native prefetch settled before join hold');}
    const second=prefetchOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint,prefEnv));check(second.accepted,'own native joining request accepted');const joined=own(second.completed);
    release.resolve();await take(root);await take(joined);check(calls===1,'own scalar join did not duplicate materialization');
   }
   if(mode==='prefetch-held-read'||mode==='prefetch-held-cancel'){
    const event=mode==='prefetch-held-cancel'?cancelEntered.promise:entered.promise;
    const arrival=await Promise.race([event.then(()=>({entered:true})),root.outcome.then(outcome=>({entered:false,outcome}))]);
    if(!arrival.entered){root.used=true;if(arrival.outcome.failed)throw arrival.outcome.error;throw Error('prefetch finished before post-native fixture hold');}
    evictOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint,prefEnv));
    hint.dispose();hint=undefined;selected.dispose();selected=undefined;auth.dispose();auth=undefined;borrow.dispose();borrow=undefined;evictCredentialGeneration(env,kid);evictGrantCredentials(key);
    check(bodyBudgetCharged()>=preflightPayloadBytes,'hint child retained through actual wrapper root');
    if(mode==='prefetch-held-cancel')check(rows[0].cancel===1&&!rows[0].unlock,'FIRSTcancel held before unlock');
   }
   release.resolve();let failed=false,reason;try{await take(root);}catch(error){failed=true;reason=error;}
   if(mode==='prefetch-held-cancel'||mode==='prefetch-unlock-failure')check(failed&&isIdentityFailure(reason),'injected post-native read/unlock failure');else if(failed)throw reason;
   check(calls===1,'one original materialization');
   if(mode==='prefetch-healthy'||mode==='prefetch-joined'||mode==='prefetch-admission-pressure'||mode==='prefetch-payload-pressure'||mode==='prefetch-structure-pressure'||mode==='prefetch-replace'||mode==='prefetch-expiry'){
    check(bodyBudgetCharged()>beforePrefetch&&bodyBudgetCharged()<beforePrefetch+preflightPayloadBytes,'positive private destination after temporary retirement');
    destinationBorrow=borrowOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint,prefEnv));check(!!destinationBorrow,'genuine private borrower');
    check(Object.keys(destinationBorrow).join(',')==='dispose'&&JSON.stringify(destinationBorrow)==='{}','no public graph alias');
    check(!prefetchOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint,prefEnv)).accepted&&calls===1,'private HIT zero RPC');
    if(mode==='prefetch-admission-pressure'){
     const charged=bodyBudgetCharged(),vector=JSON.stringify(privateCacheCharged());pressure=ExactBodyCharge.reserve(bodyBudgetBytes-charged-preflightPayloadBytes-4095);check(!!pressure,'borrower metadata pressure');
     const held=bodyBudgetCharged();let refused=false;try{borrowOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint,prefEnv));}catch(error){refused=isIdentityFailure(error);}
     check(refused&&calls===1&&bodyBudgetCharged()===held&&JSON.stringify(privateCacheCharged())===vector,'borrower refusal before ref/factory effects');pressure.release();pressure=undefined;
     check(bodyBudgetCharged()===charged,'borrower refusal preserves destination');
    }
    if(mode==='prefetch-payload-pressure'||mode==='prefetch-structure-pressure'||mode==='prefetch-replace'){
     const charged=bodyBudgetCharged(),used=privateCacheCharged();setHotCacheClock(()=>Date.now()+10001);releases.push(()=>setHotCacheClock());
     if(mode!=='prefetch-replace'){pressure=PrivateCacheReservation.reserve({serializedBytes:0,payloadBytes:mode==='prefetch-payload-pressure'?privateCacheLimits.payloadBytes-used.payloadBytes:1,structure:mode==='prefetch-structure-pressure'?privateCacheLimits.structure-used.structure:1});check(!!pressure,'optional private vector pressure');}
     const held=bodyBudgetCharged(),refresh=prefetchOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint,prefEnv));check(refresh.accepted,'private stale refresh');await take(own(refresh.completed));
     check(calls===2,'second actual native materialization');
     if(mode!=='prefetch-replace'){check(bodyBudgetCharged()===held,'refused reply retired with old destination intact');pressure.release();pressure=undefined;check(bodyBudgetCharged()===charged,'optional pressure release');}
     else check(bodyBudgetCharged()>held,'old borrower and new destination both funded');
    }
    if(mode==='prefetch-expiry'){setHotCacheClock(()=>Date.now()+60001);releases.push(()=>setHotCacheClock());check(borrowOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint,prefEnv))===undefined,'expiry removes publication only');}
    adoptCredentialGenerationDestination(selected,prefEnv,destinationBorrow);const consumed=destinationBorrow;destinationBorrow=undefined;
    let denied=false;try{consumed.dispose();}catch(error){denied=isIdentityFailure(error);}check(denied,'single-use adoption');
    evictOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint,prefEnv));check(bodyBudgetCharged()>beforePrefetch,'selected child retains detached destination');
   }
   for(const row of rows)check(row.byob&&row.read>0&&row.backing<=16384&&row.unlock&&(mode==='prefetch-held-cancel'?row.cancel===1:row.eof),'original native response reader custody');
   result={mode,materializations:calls,materializationReads:rows[0].read,postNativeHold:mode==='prefetch-held-read'||mode==='prefetch-held-cancel'};
  }
  if(cohortPrepare){
   // ALL blockers originate and settle in THIS still-live native request. Other
   // requests mutate readiness/release SCALARS only; no foreign resolver exists.
   cohortReady=false;releases.push(()=>{cohortBlockersReleased=true;});
   const blockers=[];
   for(let i=0;i<BACKGROUND_WORK_LIMIT;i++){
    const original=(async()=>{while(!cohortBlockersReleased)await new Promise(resolve=>setTimeout(resolve,1));})();
    const root=own(original);blockers.push(root);check(tryRunInBackground(()=>original),'fixture background saturation');
   }
   cohortReady=true;
   for(const root of blockers)await take(root);
  }
  if(borrow){borrow.dispose();borrow=undefined;}if(!cohortPrepare)evictCredentialGeneration(env,kid);
  if(auth)check(bodyBudgetCharged()>baseline,'derived owner retains generation after eviction');
  const observed=JSON.parse(await rpc('/fixture/result'));
  check(observed.trace.intakes===(mode==='shared-runtime'?2:1),'auth is RPC free');check(observed.trace.kv.length>0,'actual cold KV');
  for(const row of observed.trace.kv)check(row.byob&&row.reads>0&&row.eof&&row.unlocked&&row.backing<=16384,'original native KV custody');
  result={...result,mode,intakes:observed.trace.intakes,nativeReads:observed.trace.kv.length};
 }catch(error){hasPrimary=true;primary=error;}
 const failures=[];
 if(cohortPrepare&&hasPrimary)cohortBlockersReleased=true;
 for(const release of releases)try{await release();}catch(error){failures.push(error);}
 if(hint&&prefetchEnv)try{evictOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint,prefetchEnv));}catch(error){failures.push(error);}
 pressure?.release();if(!cohortPrepare||hasPrimary)evictCredentialGeneration(env,kid);evictGrantCredentials(key);
 if(prefetch&&auth)try{own(flushCredentialGenerationRuntime(auth,env));}catch(error){failures.push(error);}
 for(let i=0;i<roots.length;i++){const outcome=await roots[i].outcome;if(outcome.failed&&!roots[i].used){roots[i].used=true;failures.push(outcome.error);}}
 for(const release of [()=>destinationBorrow?.dispose(),()=>secondSelected?.dispose(),()=>secondAuth?.dispose(),()=>secondBorrow?.dispose(),()=>hint?.dispose(),()=>{if(selected&&!selected.flush.accepted)selected.flush.pending?.dispose();},()=>selected?.dispose(),()=>auth?.dispose(),()=>borrow?.dispose(),()=>prep?.dispose(),()=>{if(proof)releaseCredentialPreflight(proof);}])try{release();}catch(error){failures.push(error);}
 if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'owned native roots');if(hasPrimary)throw primary;
 if(!cohortPrepare)check(bodyBudgetCharged()===baseline,'last actual consumer funding');
 return Response.json({...result,charged:bodyBudgetCharged()});
}};
`;
const upstream = `export default {fetch(){throw Error('unexpected provider dispatch')}}`;

// Host-owned originals: one Response body root is enrolled even if its fetch
// settles after the assertion path has failed. No native retirement is inferred.
function nativeFixtureRoots(dispatchOriginal) {
  const roots = [], origins = new WeakMap(), bodies = new WeakMap();
  const own = promise => { const prior = origins.get(promise); if (prior) return prior; const root = { outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })), used: false }; roots.push(root); origins.set(promise, root); return root; };
  const readBody = response => { let root = bodies.get(response); if (!root) { let original; try { original = response.text(); } catch (error) { original = Promise.reject(error); } root = own(original); bodies.set(response, root); } return root; };
  const dispatch = url => { let original; try { original = dispatchOriginal(url); } catch (error) { original = Promise.reject(error); } const root = own(original); own(root.outcome.then(outcome => { if (!outcome.failed) readBody(outcome.value); })); return root; };
  const take = async root => { const value = await root.outcome; root.used = true; if (value.failed) throw value.error; return value.value; };
  const join = async () => { const failures = []; for (let i = 0; i < roots.length; i++) { const outcome = await roots[i].outcome; if (outcome.failed && !roots[i].used) { roots[i].used = true; failures.push(outcome.error); } } return failures; };
  return { own, readBody, dispatch, take, join };
}

for (const primary of [undefined, new Error('fixture shared failure')]) test('host late Response body joins after early primary, retaining independent failure origins: ' + (primary === undefined ? 'undefined' : 'shared'), async () => {
  let resolveFetch, bodyReads = 0;
  const fetch = new Promise(resolve => { resolveFetch = resolve; });
  const owned = nativeFixtureRoots(() => fetch), response = new Response('late fixture body');
  response.text = () => { bodyReads++; return Promise.reject(primary); };
  owned.dispatch('https://fixture/late');
  // Control release fails independently AFTER it releases the original fetch.
  const failures = []; try { resolveFetch(response); throw primary; } catch (error) { failures.push(error); }
  failures.push(...await owned.join());
  assert.equal(bodyReads, 1); assert.equal(owned.readBody(response), owned.readBody(response));
  const outcome = new AggregateError([primary, ...failures], 'fixture primary and independent cleanup');
  assert.equal(outcome.errors.length, 3); for (const error of outcome.errors) assert.equal(error, primary);
  assert.deepEqual(await owned.join(), []);
});

test('inactive owned generation consumption uses actual native KV/SQLite, prefetch cleanup and foreign-request cohorts', { timeout: 120000 }, async t => {
  const releases = []; let directory, runtime, cleanupPromise, finished = false, hasPrimary = false, primary;
  const { own, readBody, dispatch, take, join: joinRoots } = nativeFixtureRoots(url => runtime.dispatchFetch(url));
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (const release of releases) try { await release(); } catch (error) { failures.push(error); }
    failures.push(...await joinRoots());
    if (runtime) try { await runtime.dispose(); } catch (error) { failures.push(error); }
    if (directory) try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (!finished) { const failures = await cleanup(); if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures); } });
  try {
    directory = await mkdtemp(join(tmpdir(), 'identity-generations-'));
    runtime = await take(own(startWorkerdFixture(directory, router, upstream, { preventEviction: true })));
    for (const mode of ['owned-auth', 'coverage-denied', 'disabled', 'pressure', 'origin-select', 'shared-runtime', 'prefetch-healthy', 'prefetch-joined', 'prefetch-admission-pressure', 'prefetch-payload-pressure', 'prefetch-structure-pressure', 'prefetch-replace', 'prefetch-expiry', 'prefetch-held-read', 'prefetch-held-cancel', 'prefetch-unlock-failure']) {
      const response = await take(dispatch('https://fixture/' + mode));
      const body = await take(readBody(response)); assert.equal(response.status, 200, mode);
      const result = JSON.parse(body);
      const log = typeof t.log === 'function' ? t.log : t.diagnostic;
      try { if (typeof log === 'function') Reflect.apply(log, t, [JSON.stringify({ fixture: 'identity-generations', case: mode, status: response.status, nativeReads: result.nativeReads ?? 0, intakes: result.intakes ?? 0 })]); } catch {}
      assert.equal(result.charged, 0); assert.ok(result.nativeReads > 0); assert.equal(result.intakes, mode === 'shared-runtime' ? 2 : 1); if (mode.startsWith('prefetch-')) { assert.equal(result.materializations, ['prefetch-payload-pressure', 'prefetch-structure-pressure', 'prefetch-replace'].includes(mode) ? 2 : 1); assert.ok(result.materializationReads > 0); }
    }
    let cohortOpen = true;
    const releaseCohort = async () => { if (!cohortOpen) return; cohortOpen = false; const response = await take(dispatch('https://fixture/cohort-release')); await take(readBody(response)); assert.equal(response.status, 200); };
    releases.push(releaseCohort);
    const prepareRoot = dispatch('https://fixture/cohort-prepare');
    const readyRoot = dispatch('https://fixture/cohort-ready');
    const readiness = await Promise.race([readyRoot.outcome.then(outcome => ({ ready: true, outcome })), prepareRoot.outcome.then(outcome => ({ ready: false, outcome }))]);
    if (!readiness.ready) { const early = await take(prepareRoot); await take(readBody(early)); assert.fail('saturation origin completed before readiness: ' + early.status); }
    const readyResponse = await take(readyRoot); assert.equal(await take(readBody(readyResponse)), 'ready'); assert.equal(readyResponse.status, 200);
    const first = dispatch('https://fixture/cohort-a');
    const barrier = dispatch('https://fixture/cohort-arrival');
    const arrived = await Promise.race([barrier.outcome.then(outcome => ({ entered: true, outcome })), first.outcome.then(outcome => ({ entered: false, outcome }))]);
    if (!arrived.entered) { const response = await take(first); const body = await take(readBody(response)); assert.fail('cohort A returned before hold: ' + response.status); }
    const arrivalResponse = await take(barrier); await take(readBody(arrivalResponse)); assert.equal(arrivalResponse.status, 200);
    const secondResponse = await take(dispatch('https://fixture/cohort-b')), secondBody = await take(readBody(secondResponse));
    assert.equal(secondResponse.status, 200); const second = JSON.parse(secondBody); assert.equal(second.selectedCount, 2); assert.equal(second.records, 2); assert.ok(second.charged > 0);
    await releaseCohort();
    const firstResponse = await take(first), firstBody = await take(readBody(firstResponse)); assert.equal(firstResponse.status, 200);
    const final = JSON.parse(firstBody); assert.equal(final.selectedCount, 2); assert.equal(final.records, 2);
    const prepared = await take(prepareRoot); await take(readBody(prepared)); assert.equal(prepared.status, 200);
    const completedResponse = await take(dispatch('https://fixture/cohort-finished'));
    const completed = JSON.parse(await take(readBody(completedResponse))); assert.equal(completedResponse.status, 200); assert.equal(completed.charged, 0);
    const log = typeof t.log === 'function' ? t.log : t.diagnostic;
    try { if (typeof log === 'function') Reflect.apply(log, t, [JSON.stringify({ fixture: 'identity-generations', case: 'foreign-cohorts', status: 200, records: final.records, selectedCount: final.selectedCount, charged: completed.charged })]); } catch {}
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'native generation roots');
  if (hasPrimary) throw primary;
});
