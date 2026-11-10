import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const router = String.raw`
import {PolicyBindingIndexObject as Base} from './worker/authority.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {preflightCredential,releaseCredentialPreflight,prepareCredentialGeneration,completeCredentialGeneration,completeConsumableCredentialGeneration,authenticateCredentialGeneration,borrowCredentialGeneration,evictCredentialGeneration} from './worker/credential-preflight.ts';
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
 const roots=[];let proof,prep,borrow,auth,pressure,hasPrimary=false,primary,result;
 const own=promise=>{const root={outcome:promise.then(value=>({failed:false,value}),error=>({failed:true,error})),used:false};roots.push(root);return root;};
 const take=async root=>{const outcome=await root.outcome;root.used=true;if(outcome.failed)throw outcome.error;return outcome.value;};
 const rpc=async path=>{const response=await take(own(stub.fetch('https://authority'+path))),body=await take(own(response.text()));check(response.status===200,'fixture RPC');return body;};
 const baseline=bodyBudgetCharged();
 try{
  await rpc('/fixture/reset');
  await env.POLICY_KV.put('credentials/'+kid,JSON.stringify({...record(digest),...(mode==='disabled'?{enabled:false}:{})}));
  await env.POLICY_KV.put('policies/native-generation-policy',JSON.stringify({enabled:true,generation:'legacy',providers:[],requestCostMicros:7}));
  const preflight=await take(own(preflightCredential(env,kid,digest)));if(preflight.outcome==='matched')proof=preflight.proof;
  check(!!proof,'correct secret is preliminary match even when disabled');
  let denied=false;try{authenticateCredentialGeneration(proof,env,{providers:[],allConnections:false});}catch(error){denied=isIdentityFailure(error);}
  check(denied,'preverification is not authentication');
  prep=prepareCredentialGeneration(proof);proof=undefined;
  const operation=completeConsumableCredentialGeneration(prep,{providers:[]},on);prep=undefined;
  borrow=await take(own(operation));
  if(mode==='coverage-denied'){
   denied=false;try{authenticateCredentialGeneration(borrow,env,{providers:[],allConnections:true});}catch(error){denied=isIdentityFailure(error);}
   check(denied,'missing trusted facet denies');
  }
  if(mode==='pressure'){
   pressure=ExactBodyCharge.reserve(bodyBudgetBytes-bodyBudgetCharged()-4095);check(!!pressure,'common pressure');
   denied=false;try{authenticateCredentialGeneration(borrow,env,{providers:[],allConnections:false});}catch(error){denied=isIdentityFailure(error);}
   check(denied,'common capacity before derived auth');pressure.release();pressure=undefined;
  }
  auth=authenticateCredentialGeneration(borrow,env,{providers:[],allConnections:false});
  check(auth.status()===(mode==='disabled'?403:200),'ordinary lifecycle verdict');
  check(auth.code()===(mode==='disabled'?'proxy_key_revoked':undefined),'ordinary lifecycle classification');
  borrow.dispose();borrow=undefined;evictCredentialGeneration(env,kid);
  check(bodyBudgetCharged()>baseline,'derived owner retains generation after eviction');
  const observed=JSON.parse(await rpc('/fixture/result'));
  check(observed.trace.intakes===1,'auth is RPC free');check(observed.trace.kv.length>0,'actual cold KV');
  for(const row of observed.trace.kv)check(row.byob&&row.reads>0&&row.eof&&row.unlocked&&row.backing<=16384,'original native KV custody');
  result={mode,intakes:observed.trace.intakes,nativeReads:observed.trace.kv.length};
 }catch(error){hasPrimary=true;primary=error;}
 const failures=[];
 pressure?.release();evictCredentialGeneration(env,kid);
 for(let i=0;i<roots.length;i++){const outcome=await roots[i].outcome;if(outcome.failed&&!roots[i].used){roots[i].used=true;failures.push(outcome.error);}}
 for(const release of [()=>auth?.dispose(),()=>borrow?.dispose(),()=>prep?.dispose(),()=>{if(proof)releaseCredentialPreflight(proof);}])try{release();}catch(error){failures.push(error);}
 if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'owned native roots');if(hasPrimary)throw primary;
 check(bodyBudgetCharged()===baseline,'last actual consumer clears funding');
 return Response.json({...result,charged:bodyBudgetCharged()});
}};
`;
const upstream = `export default {fetch(){throw Error('unexpected provider dispatch')}}`;

test('inactive owned generation authentication uses actual native KV/SQLite/RPC and last-child custody', { timeout: 120000 }, async t => {
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
    for (const mode of ['owned-auth', 'coverage-denied', 'disabled', 'pressure']) {
      const response = await take(own(runtime.dispatchFetch('https://fixture/' + mode)));
      const body = await take(own(response.text())); assert.equal(response.status, 200, mode);
      const result = JSON.parse(body);
      const log = typeof t.log === 'function' ? t.log : t.diagnostic;
      try { if (typeof log === 'function') Reflect.apply(log, t, [JSON.stringify({ fixture: 'identity-generations', case: mode, status: response.status, nativeReads: result.nativeReads ?? 0, intakes: result.intakes ?? 0 })]); } catch {}
      assert.equal(result.charged, 0); assert.ok(result.nativeReads > 0); assert.equal(result.intakes, 1);
    }
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'native generation roots');
  if (hasPrimary) throw primary;
});
