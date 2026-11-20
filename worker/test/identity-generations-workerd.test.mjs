import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const router = String.raw`
import {PolicyBindingIndexObject as Base} from './worker/authority.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {preflightCredential,releaseCredentialPreflight,prepareCredentialGeneration,completeCredentialGeneration,borrowCredentialGeneration,evictCredentialGeneration} from './worker/credential-preflight.ts';
import {ExactBodyCharge,bodyBudgetCharged,bodyBudgetBytes} from './worker/body-budget.ts';
import {PreflightTicket,preflightPayloadBytes} from './worker/credential-preflight-arena.ts';
import {PrivateCacheReservation,privateCacheCharged,privateCacheLimits,setHotCacheClock} from './worker/hot-cache.ts';
import {isIdentityFailure} from './worker/identity-admission.ts';
import {measureGenerationGraph,freezeGenerationGraph} from './worker/identity-generations.ts';
const digest='ab'.repeat(32),rotated='cd'.repeat(32),kid='nativegeneration';
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
  this.reset=()=>{for(const table of ['proxy_credentials','access_policies','policy_binding_meta'])sql.exec('DELETE FROM '+table);trace.intakes=0;trace.preflights=0;trace.kv=[];};
  this.rotate=()=>sql.exec('UPDATE proxy_credentials SET credential_json=? WHERE credential_id=?',JSON.stringify(record(rotated)),kid);
  this.snapshot=()=>({trace,charged:this.preflightArena?.charged??0,credentials:[...sql.exec('SELECT credential_json FROM proxy_credentials')].length,policies:[...sql.exec('SELECT policy_json FROM access_policies')].length});
  this.trace=trace;
 }
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/fixture/reset'){this.reset();return new Response('reset');}
  if(path==='/fixture/rotate'){this.rotate();return new Response('rotated');}
  if(path==='/fixture/result')return Response.json(this.snapshot());
  if(path==='/admission/credential-preflight')this.trace.preflights++;
  if(path==='/admission/resolve')this.trace.intakes++;
  return super.fetch(request);
 }
}
export default {async fetch(request,env){
 const mode=new URL(request.url).pathname.slice(1),stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings'));
 const roots=[],releases=[];let proof,prep,a,b,hit,pressure,hasPrimary=false,primary,result,generationEnv=env,graph,originalFreeze,freezes=0;
 const own=promise=>{const root={outcome:promise.then(value=>({failed:false,value}),error=>({failed:true,error})),used:false};roots.push(root);return root;};
 const take=async root=>{const outcome=await root.outcome;root.used=true;if(outcome.failed)throw outcome.error;return outcome.value;};
 const rpc=async path=>{const response=await take(own(stub.fetch('https://authority'+path))),body=await take(own(response.text()));check(response.status===200,'fixture RPC');return body?body:null;};
 const baseline=bodyBudgetCharged();
 try{
  await rpc('/fixture/reset');
  await env.POLICY_KV.put('credentials/'+kid,JSON.stringify(record(digest)));
  await env.POLICY_KV.put('policies/native-generation-policy',JSON.stringify({enabled:true,generation:'legacy',providers:[],requestCostMicros:7}));
  if(mode==='unknown-hold'){
   const ticket=PreflightTicket.reserve();ticket.holdUnknown();let denied=false;
   try{PrivateCacheReservation.transfer({serializedBytes:2,payloadBytes:2,structure:1},ticket);}catch(error){denied=isIdentityFailure(error);}
   ticket.release();check(denied&&ticket.bytes===preflightPayloadBytes,'UNKNOWN retains source funding');
   // Deliberate isolate-local UNKNOWN hold. No ACK/retirement/release claim.
   return Response.json({mode,held:bodyBudgetCharged()-baseline,unknown:true});
  }
  if(mode==='preverify'){
   const missing=await take(own(preflightCredential(env,'absent-generation',digest)));if(missing.outcome==='matched')proof=missing.proof;check(missing.outcome==='unknown','unknown preliminary result');
   const wrong=await take(own(preflightCredential(env,kid,rotated)));if(wrong.outcome==='matched')proof=wrong.proof;check(wrong.outcome==='invalid','invalid preliminary result');
   check(bodyBudgetCharged()===baseline,'no generation funding');
   result={mode,preverify:true};
  }else if(mode==='fence-evict'||mode==='fence-expire'||mode==='fence-failed'){
   const entered=deferred(),release=deferred(),caller=new AbortController();let now=1000,held=false,unlocked=false;
   releases.push(()=>caller.abort(),()=>release.resolve());setHotCacheClock(()=>now);
   const binding=env.ACCESS_CONTROL;
   generationEnv={ACCESS_CONTROL:{idFromName(name){return binding.idFromName(name);},get(id){
    const original=binding.get(id);
    return {async fetch(url,init){
     const response=await original.fetch(url,init);
     if(url.endsWith('/admission/resolve')&&!held){
      held=true;const acquire=response.body.getReader.bind(response.body);
      response.body.getReader=options=>{const reader=acquire(options),read=reader.read.bind(reader),unlock=reader.releaseLock.bind(reader);
       reader.read=async(...args)=>{const value=await read(...args);if(value.done){entered.resolve();await release.promise;}return value;};
       reader.releaseLock=()=>{unlock();unlocked=true;};return reader;};
     }return response;
    }};
   }}};
   let preflight=await take(own(preflightCredential(generationEnv,kid,digest)));if(preflight.outcome==='matched')proof=preflight.proof;check(!!proof,'A preflight');
   prep=prepareCredentialGeneration(proof);proof=undefined;
   const first=own(completeCredentialGeneration(prep,{providers:[]},on,caller.signal).then(value=>{a=value;return value;}));prep=undefined;
   const arrival=await Promise.race([entered.promise.then(()=>({entered:true})),first.outcome.then(outcome=>({entered:false,outcome}))]);
   if(!arrival.entered){first.used=true;if(arrival.outcome.failed)throw arrival.outcome.error;throw Error('A settled before original EOF hold');}
   check(!unlocked,'A ORIGINAL unlock held');
   preflight=await take(own(preflightCredential(generationEnv,kid,digest)));if(preflight.outcome==='matched')proof=preflight.proof;check(!!proof,'B preflight');
   prep=prepareCredentialGeneration(proof);proof=undefined;
   const second=own(completeCredentialGeneration(prep,mode==='fence-failed'?{providers:[],credentialId:'other'}:{providers:[]},on).then(value=>{b=value;return value;}));prep=undefined;
   if(mode==='fence-failed'){
    const outcome=await second.outcome;second.used=true;check(outcome.failed&&isIdentityFailure(outcome.error),'B ordinary prevalidation denial');
   }else{
    await take(second);hit=borrowCredentialGeneration(generationEnv,kid,digest,on);check(!!hit,'B published');hit.dispose();hit=undefined;
    const live=bodyBudgetCharged();
    if(mode==='fence-expire'){now=61000;hit=borrowCredentialGeneration(generationEnv,kid,digest,on);check(!hit,'B expired');now=1000;}
    else evictCredentialGeneration(generationEnv,kid);
    check(bodyBudgetCharged()===live,'B remains borrowed/funded after publication removal');
   }
   release.resolve();await take(first);check(unlocked,'A ORIGINAL unlock joined');
   hit=borrowCredentialGeneration(generationEnv,kid,digest,on);
   check(!!hit===(mode==='fence-failed'),'successful-publication watermark only');
   if(hit){hit.dispose();hit=undefined;}
   if(mode!=='fence-failed'){
    check(bodyBudgetCharged()-baseline>=preflightPayloadBytes,'A uncached under its full owner');
    const third=await take(own(preflightCredential(generationEnv,kid,digest)));if(third.outcome==='matched')proof=third.proof;check(!!proof,'C preliminary match');
    let denied=false;try{prep=prepareCredentialGeneration(proof);proof=undefined;}catch(error){if(!isIdentityFailure(error)||error.message!=='Identity admission failed (limit)')throw error;denied=true;}
    check(denied,'both borrowed slots block C before hydration');releaseCredentialPreflight(proof);proof=undefined;
    b.dispose();b=undefined;check(bodyBudgetCharged()-baseline>=preflightPayloadBytes,'A survives B retirement');
   }
   const actual=JSON.parse(await rpc('/fixture/result'));
   check(actual.trace.intakes===(mode==='fence-failed'?1:2)&&actual.trace.preflights===(mode==='fence-failed'?2:3),'actual native A/B, zero C hydration');
   check(actual.charged===0&&actual.trace.kv.every(row=>row.byob&&row.reads>0&&row.eof&&row.unlocked&&row.backing<=16384),'native source/SQL roots joined');
   result={mode,nativeReads:actual.trace.kv.length,intakes:actual.trace.intakes};
  }else{
   const preflight=await take(own(preflightCredential(env,kid,digest)));check(preflight.outcome==='matched','preflight');proof=preflight.proof;
   prep=prepareCredentialGeneration(proof);proof=undefined;
   if(mode==='full-arena'){pressure=ExactBodyCharge.reserve(bodyBudgetBytes-bodyBudgetCharged());check(!!pressure&&bodyBudgetCharged()===bodyBudgetBytes,'full arena');}
   if(mode==='cache-pressure'){pressure=PrivateCacheReservation.reserve({serializedBytes:1,payloadBytes:8388608,structure:1});check(!!pressure,'cache pressure');}
   if(mode==='rotation')await rpc('/fixture/rotate');
   const hitPressure=mode==='hit-payload'||mode==='hit-structure';let used,vector;
   if(hitPressure){
    originalFreeze=Object.freeze;
    Object.freeze=function(value){if(value&&Object.hasOwn(value,'credential')&&Object.hasOwn(value,'connections')&&Object.hasOwn(value,'pools')){graph=value;freezes++;}return Reflect.apply(originalFreeze,Object,[value]);};
   }
   const operation=completeCredentialGeneration(prep,{providers:[]},mode==='off'?off:on);prep=undefined;
   a=await take(own(operation));check(Object.isFrozen(a)&&Object.keys(a).join(',')==='dispose','opaque borrower');
   const before=JSON.parse(await rpc('/fixture/result'));
   if(hitPressure){
    used=privateCacheCharged();vector={serializedBytes:0,payloadBytes:1,structure:1};
    const coordinate=mode==='hit-payload'?'payloadBytes':'structure';vector[coordinate]=privateCacheLimits[coordinate]-used[coordinate];
    pressure=PrivateCacheReservation.reserve(vector);check(!!pressure&&privateCacheCharged()[coordinate]===privateCacheLimits[coordinate],'exact optional pressure');
    check(bodyBudgetBytes-bodyBudgetCharged()>preflightPayloadBytes,'ample common backing before hit');
   }
   b=borrowCredentialGeneration(env,kid,digest,on);
   const promoted=mode!=='cache-pressure'&&mode!=='off'&&mode!=='rotation';
   check(!!b===promoted,'matching promotion state');
   const after=JSON.parse(await rpc('/fixture/result'));
   check(before.trace.intakes===1&&after.trace.intakes===1&&after.trace.preflights===1,'borrow is RPC-free');
   check(before.trace.kv.length>=(mode==='rotation'?1:2)&&before.trace.kv.every(row=>row.byob&&row.reads>0&&row.eof&&row.unlocked&&row.backing<=16384),'ORIGINAL native KV joins');
   check(before.charged===0&&before.credentials===1&&before.policies===(mode==='rotation'?0:1),'actual SQLite/DO completion');
   if(mode==='full-arena')check(bodyBudgetCharged()<bodyBudgetBytes-16777216,'atomic source replacement');
   if(mode==='cache-pressure'||mode==='off'||mode==='rotation')check(bodyBudgetCharged()-baseline>=preflightPayloadBytes,'uncached source ticket');
   const live=bodyBudgetCharged();evictCredentialGeneration(env,kid);check(bodyBudgetCharged()===live,'eviction only removes publication');
   if(hitPressure){
    check(!!graph&&Object.isFrozen(graph)&&Object.isFrozen(graph.credential.credential)&&freezes===1,'original graph frozen once, no hit replacement');
    check(privateCacheCharged().structure===used.structure+vector.structure-measureGenerationGraph(graph).structure,'old metadata receipts stay funded');
    hit=borrowCredentialGeneration(env,kid,digest,on);check(!hit,'demoted publication absent');
    check(live-baseline>=preflightPayloadBytes+vector.payloadBytes,'same graph now has full temporary backing');
    a.dispose();a=undefined;check(bodyBudgetCharged()===live-230,'only first borrower metadata retired');
   }
   result={mode,promoted:promoted&&!hitPressure,demoted:hitPressure,nativeReads:before.trace.kv.length,intakes:after.trace.intakes};
  }
 }catch(error){hasPrimary=true;primary=error;}
 const failures=[];
 for(const release of releases)try{release();}catch(error){failures.push(error);}
 // Original transport/body outcomes are observed immediately and joined before
 // any borrower/proof release. Every independent origin is retained, even undefined.
 for(let i=0;i<roots.length;i++){const outcome=await roots[i].outcome;if(outcome.failed&&!roots[i].used){roots[i].used=true;failures.push(outcome.error);}}
 for(const release of [()=>{graph=undefined;if(originalFreeze){Object.freeze=originalFreeze;originalFreeze=undefined;}},()=>evictCredentialGeneration(generationEnv,kid),()=>{hit?.dispose();hit=undefined;},()=>{b?.dispose();b=undefined;},()=>{a?.dispose();a=undefined;},()=>{prep?.dispose();prep=undefined;},()=>{if(proof){releaseCredentialPreflight(proof);proof=undefined;}},()=>{pressure?.release();pressure=undefined;},()=>setHotCacheClock()])try{release();}catch(error){failures.push(error);}
 if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'generation fixture roots');
 if(hasPrimary)throw primary;
 check(bodyBudgetCharged()===baseline,'all original owners released');
 const cache=privateCacheCharged();check(!cache.serializedBytes&&!cache.payloadBytes&&!cache.structure,'all optional coordinates released');
 const sample=JSON.parse('{"__proto__":{"kept":true},"unknown":["\\u0001","\\ud800",7,null,false]}'),same=sample.__proto__,wire=JSON.stringify(sample),vector=measureGenerationGraph(sample);
 freezeGenerationGraph(sample);check(sample.__proto__===same&&Object.isFrozen(same)&&new TextEncoder().encode(wire).byteLength===vector.serializedBytes,'native SAME graph/escaped wire');
 return Response.json({...result,charged:bodyBudgetCharged(),cache});
}};
`;
const upstream = `export default {fetch(){throw Error('unexpected provider dispatch')}}`;

test('inactive generations use actual Workerd native KV/SQLite/RPC and exact common-arena handoff', { timeout: 120000 }, async t => {
  const roots = []; let directory, runtime, cleanupPromise, finished = false, hasPrimary = false, primary;
  const own = promise => { const root = { outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })), used: false }; roots.push(root); return root; };
  const take = async root => { const value = await root.outcome; root.used = true; if (value.failed) throw value.error; return value.value; };
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (let i = 0; i < roots.length; i++) { const outcome = await roots[i].outcome; if (outcome.failed && !roots[i].used) { roots[i].used = true; failures.push(outcome.error); } }
    if (runtime) try { await runtime.dispose(); } catch (error) { failures.push(error); }
    if (directory) try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (!finished) { const failures = await cleanup(); if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures); } });
  try {
    directory = await mkdtemp(join(tmpdir(), 'identity-generations-'));
    runtime = await take(own(startWorkerdFixture(directory, router, upstream, { preventEviction: true })));
    for (const mode of ['healthy', 'full-arena', 'cache-pressure', 'off', 'rotation', 'preverify', 'fence-evict', 'fence-expire', 'fence-failed', 'hit-payload', 'hit-structure', 'unknown-hold']) {
      const response = await take(own(runtime.dispatchFetch('https://fixture/' + mode)));
      const body = await take(own(response.text())); assert.equal(response.status, 200, mode);
      const result = JSON.parse(body);
      const log = typeof t.log === 'function' ? t.log : t.diagnostic;
      try { if (typeof log === 'function') Reflect.apply(log, t, [JSON.stringify({ fixture: 'identity-generations', case: mode, status: response.status, nativeReads: result.nativeReads ?? 0, intakes: result.intakes ?? 0 })]); } catch {}
      if (mode === 'unknown-hold') { assert.equal(result.unknown, true); assert.equal(result.held, 32 * 1024 * 1024); }
      else { assert.equal(result.charged, 0); assert.deepEqual(result.cache, { serializedBytes: 0, payloadBytes: 0, structure: 0 }); }
    }
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'native generation roots');
  if (hasPrimary) throw primary;
});
