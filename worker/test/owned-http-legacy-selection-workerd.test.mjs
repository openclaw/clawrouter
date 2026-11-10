import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

// Real KV byte bodies and SQLite selection effects. Fixture metadata requests
// have their own original bodies; they are not selection/retirement receipts.
const router = String.raw`
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {PolicyBindingIndexObject as Base} from './worker/authority.ts';
import {resolveOwnedHttpAuthentication,queueOwnedHttpSelectionRuntime,evictCredentialGeneration} from './worker/credential-preflight.ts';
import {beginOwnedHttpRequest,finishOwnedHttpRequest} from './worker/http-identity-owner.ts';
import {selectOwnedHttpProvider,snapshot} from './worker/providers.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
const kid='native-http-legacy',policyId='native-http-policy',digest='ab'.repeat(32),revision='2026-01-01T00:00:00.000Z';
const provider=snapshot.providers.find(value=>value.id==='openai'),endpoint=provider.endpoints.find(value=>value.request_format==='openai.chat_completions');
const tokenRef=provider.auth.schemes.find(value=>value.type==='oauth')?.tokenRef??provider.id;
const key='oauth/'+policyId+'/'+tokenRef,tenant='oauth/tenants/default/'+tokenRef;
const staleA='oauth/'+policyId+'/a',staleB='oauth/'+policyId+'/b';
const modern=()=>({provider:provider.id,kind:'api_key',enabled:true,credentialStore:'durable_object',credentialStatus:'active',credentialGeneration:1,credentialLineage:'fixture-native-tenant',hasCredential:true,unknown:{retained:['native',null,11]}});
const check=(value,label)=>{if(!value)throw Error(label);};
export class PolicyBindingIndexObject extends Base {
 constructor(state,env){super(state,env);this.fixtureSql=state.storage.sql;this.fixtureRoots=[];
  const originalStore=this.admissionStore,originalFinal=this.finalPrivateAdmission;
  this.admissionStore=(...args)=>{
   const store=Reflect.apply(originalStore,this,args),finish=store.finishSelection;
   if(this.fixtureMode==='stale')store.finishSelection=(...items)=>{
    const original=Reflect.apply(finish,store,items);
    const observed=original.then(prior=>{
     this.fixturePriorA=prior.selection?.selected?.key===staleA;
     const published=this.publishGrantAttachment({key:staleB,generation:1,revision:8,admissionRevision:8,provider:'openai',status:'active',projection:{...modern(),priority:0}});
     check(published.revision===8&&!published.pending,'same-generation publication');
    });
    this.fixtureRoots.push(observed.then(()=>({failed:false}),error=>({failed:true,error})));return original;
   };
   return store;
  };
  this.finalPrivateAdmission=(...args)=>{
   const value=Reflect.apply(originalFinal,this,args);
   this.fixtureOmitted=!Object.hasOwn(value,'selection')&&!Object.hasOwn(value,'snapshots');return value;
  };
 }
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/fixture/reset'){
   for(const table of ['proxy_credentials','access_policies','policy_binding_meta','upstream_grant_pool_versions','upstream_grant_pool_members','upstream_grant_projections','upstream_grant_selection','upstream_grant_pool_cursors','upstream_grant_runtime'])this.fixtureSql.exec('DELETE FROM '+table);
   const mode=new URL(request.url).searchParams.get('mode');
   this.fixtureMode=mode;this.fixturePriorA=false;this.fixtureOmitted=false;
   if(mode==='stale'){
    for(const [name,token,priority]of[[staleA,'a',2],[staleB,'b',5]]){
     this.fixtureSql.exec('INSERT INTO upstream_grant_pool_versions(grant_key,generation,revision) VALUES(?,?,?)',name,1,7);
     this.fixtureSql.exec('INSERT INTO upstream_grant_pool_members(scope,scope_id,provider_id,token_ref,status) VALUES(?,?,?,?,?)','policies',policyId,'openai',token,'active');
     this.fixtureSql.exec('INSERT INTO upstream_grant_projections(grant_key,projection_json,legacy) VALUES(?,?,0)',name,JSON.stringify({...modern(),priority}));
    }
    check(this.admitGrantAttachment({key:staleB,generation:1,revision:7,provider:'openai',status:'active'}).revision===8,'native publication admission');
   }
   if(mode==='mixed'||mode==='covered-nonrecord'){
    const selected=mode==='mixed'?tenant:key;
    this.fixtureSql.exec('INSERT INTO upstream_grant_pool_versions(grant_key,generation,revision) VALUES(?,?,?)',selected,1,7);
    this.fixtureSql.exec('INSERT INTO upstream_grant_projections(grant_key,projection_json,legacy) VALUES(?,?,0)',selected,JSON.stringify(modern()));
   }
   return new Response('reset');
  }
  if(path==='/fixture/state')return Response.json({count:[...this.fixtureSql.exec('SELECT COALESCE(SUM(selected_count),0) AS n FROM upstream_grant_selection')][0].n,runtimes:[...this.fixtureSql.exec('SELECT grant_key FROM upstream_grant_runtime')].length,priorA:this.fixturePriorA,omitted:this.fixtureOmitted});
  const response=await super.fetch(request),failures=[];
  for(let i=0;i<this.fixtureRoots.length;i++){const outcome=await this.fixtureRoots[i];if(outcome.failed)failures.push(outcome.error);}
  this.fixtureRoots.length=0;
  if(failures.length){try{await response.body?.cancel();}catch(error){failures.push(error);}throw new AggregateError(failures,'native publication fixture roots');}
  return response;
 }
}
export default {async fetch(request,env){
 const mode=new URL(request.url).pathname.slice(1),baseline=bodyBudgetCharged(),roots=[],bodies=new WeakMap(),owners=[],rows=[],calls=[];
 let hasPrimary=false,primary,finished=false,cleanupPromise;
 const own=promise=>{const root={used:false,outcome:promise.then(value=>({failed:false,value}),error=>({failed:true,error}))};roots.push(root);return root;};
 const take=async root=>{const result=await root.outcome;root.used=true;if(result.failed)throw result.error;return result.value;};
 const body=response=>{let root=bodies.get(response);if(!root){root=own(response.text());bodies.set(response,root);}return root;};
 const stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings'));
 const metadata=async path=>{const original=stub.fetch('https://authority'+path),root=own(original);own(original.then(response=>{body(response);},()=>{}));const response=await take(root);const text=await take(body(response));check(response.status===200,'fixture metadata status');return text;};
 const originalKv=env.POLICY_KV,get=originalKv.get.bind(originalKv);
 const kv=new Proxy(originalKv,{get(target,name){if(name==='get')return async(k,type)=>{
  const original=await get(k,type);if(type!=='stream'||!original)return original;
  const row={kind:k===key?'selected':k===tenant?'tenant':'other',byob:false,reads:0,eof:false,unlock:false,backing:0};rows.push(row);
  const acquire=original.getReader.bind(original);original.getReader=options=>{
   row.byob=options?.mode==='byob';const reader=acquire(options),read=reader.read.bind(reader),unlock=reader.releaseLock.bind(reader);
   reader.read=(...args)=>{const pending=read(...args);row.reads++;void pending.then(result=>{if(result.done)row.eof=true;if(result.value)row.backing=Math.max(row.backing,result.value.buffer.byteLength);},()=>{});return pending;};
   reader.releaseLock=()=>{unlock();row.unlock=!original.locked;};return reader;
  };return original;
 };const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
 const authority={idFromName:name=>env.ACCESS_CONTROL.idFromName(name),get:id=>{const native=env.ACCESS_CONTROL.get(id);return {fetch(url,init){calls.push(new URL(url).pathname);return native.fetch(url,init);}};}};
 const scoped=new Proxy(env,{get(target,name,receiver){return name==='POLICY_KV'?kv:name==='ACCESS_CONTROL'?authority:Reflect.get(target,name,receiver);}});
 const finish=item=>item.terminal??=own(finishOwnedHttpRequest(item.cap));
 const cleanup=()=>cleanupPromise??=(async()=>{
  const failures=[];
  for(let i=0;i<roots.length;i++)await roots[i].outcome;
  for(const item of owners)try{await take(finish(item));}catch(error){failures.push(error);}
  for(let i=0;i<roots.length;i++)await roots[i].outcome;
  for(const root of roots){const result=await root.outcome;if(result.failed&&!root.used){root.used=true;failures.push(result.error);}}
  try{evictCredentialGeneration(scoped,kid);}catch(error){failures.push(error);}
  try{check(bodyBudgetCharged()===baseline,'last native application debit');}catch(error){failures.push(error);}
  return failures;
 })();
 try{
  check(['record','nonrecord','mixed','covered-nonrecord','runtime','stale','empty'].includes(mode),'fixed mode');
  await metadata('/fixture/reset?mode='+mode);
  await take(own(env.POLICY_KV.put('credentials/'+kid,JSON.stringify({enabled:true,secretSha256:digest,policyId,policyGeneration:'legacy',principalId:null}))));
  await take(own(env.POLICY_KV.put('policies/'+policyId,JSON.stringify({enabled:true,generation:'legacy',providers:['openai'],tenantId:'default',grantRouting:{strategy:'round_robin',stickiness:'none',environmentFallback:false}}))));
  if(mode==='stale'||mode==='empty')await take(own(env.POLICY_KV.delete(key)));
  else await take(own(env.POLICY_KV.put(key,JSON.stringify(mode==='covered-nonrecord'?modern():{provider:'openai',kind:'api_key',credential:'fixture-native-legacy',enabled:true,updatedAt:revision,unknown:{retained:['complete',null,7]}}))));
  for(const [name,priority]of[[staleA,2],[staleB,0]]){
   if(mode==='stale')await take(own(env.POLICY_KV.put(name,JSON.stringify({...modern(),priority}))));
   else await take(own(env.POLICY_KV.delete(name)));
  }
  if(mode==='mixed')await take(own(env.POLICY_KV.put(tenant,JSON.stringify(modern()))));else await take(own(env.POLICY_KV.delete(tenant)));
  const required={providerId:provider.id,endpointId:endpoint.id,mode:'http',capability:'llm.chat',model:'gpt-fixture',catalogModelId:null};
  const open=async()=>{const cap=beginOwnedHttpRequest(request,scoped),item={cap};owners.push(item);
   const response=await take(own(resolveOwnedHttpAuthentication(cap,request,scoped,kid,digest,{providers:[{id:provider.id,tokenRef}],allConnections:false,snapshot:mode==='covered-nonrecord'?'only':'select',selection:required})));
   if(response){await take(body(response));check(false,'native authentication failed');}return item;};
  const first=await open(),before=calls.length;
  if(mode==='stale'){const state=JSON.parse(await metadata('/fixture/state'));check(state.priorA&&state.omitted&&state.count===0,'native final stale selection drop');}
  const chosen=await take(own(selectOwnedHttpProvider(first.cap,request,scoped,required,mode!=='nonrecord'&&mode!=='covered-nonrecord')));
  check(mode==='empty'?!chosen.selected()&&!chosen.hasConfiguredGrant():chosen.selected()&&chosen.matchesKey(mode==='stale'?staleB:key),'current ordered choice');
  const after=JSON.parse(await metadata('/fixture/state'));
  check(after.count===(mode==='nonrecord'||mode==='covered-nonrecord'||mode==='empty'?0:1),'exact initial count');
  if(mode==='covered-nonrecord'||mode==='empty')check(calls.length===before,'covered zero RPC');
  if(mode==='stale')check(calls.filter(path=>path==='/grant-pools/select').length===1,'one post-omission selection');
  if(mode==='mixed'){
   const next=await take(own(selectOwnedHttpProvider(first.cap,request,scoped,required)));
   check(next.matchesKey(tenant),'second mixed key');check(JSON.parse(await metadata('/fixture/state')).count===2,'second count');
  }
  if(mode==='runtime'){
   queueOwnedHttpSelectionRuntime(first.cap,request,scoped,chosen,{grantRevision:revision,updatedAt:new Date().toISOString(),cooldownUntil:new Date(Date.now()+60000).toISOString()});
   const second=await open(),blocked=await take(own(selectOwnedHttpProvider(second.cap,request,scoped,required)));
   check(!blocked.selected()&&blocked.hasConfiguredGrant(),'pending revision-bound cooldown');
   check(JSON.parse(await metadata('/fixture/state')).count===1,'no blocked count');
  }
  check(!calls.includes('/grant-pools/record'),'no duplicate record');
  if(mode!=='covered-nonrecord'&&mode!=='empty')check(rows.some(row=>(mode==='stale'?row.kind==='other':row.kind==='selected')&&row.byob&&row.reads>0&&row.eof&&row.unlock&&row.backing<=16384),'original worker KV BYOB EOF unlock');
 }catch(error){hasPrimary=true;primary=error;}
 const failures=await cleanup();finished=true;
 if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'native legacy outcomes');
 if(hasPrimary)throw primary;
 return Response.json({mode,ok:finished,charged:bodyBudgetCharged(),baseline});
}};
`;
const upstream = `export default {fetch(){throw Error('legacy fixture has no provider egress');}};`;

test('owned legacy selection uses actual native KV bodies and SQLite counters', { timeout: 120000 }, async t => {
  const roots = [], bodies = new WeakMap(); let directory, runtime, finished = false, cleanupPromise, hasPrimary = false, primary;
  const own = promise => { const root = { used: false, outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })) }; roots.push(root); return root; };
  const take = async root => { const result = await root.outcome; root.used = true; if (result.failed) throw result.error; return result.value; };
  const body = response => { let root = bodies.get(response); if (!root) { root = own(response.text()); bodies.set(response, root); } return root; };
  const dispatch = url => { const original = runtime.dispatchFetch(url), root = own(original); own(original.then(response => { body(response); }, () => {})); return root; };
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    for (const root of roots) { const result = await root.outcome; if (result.failed && !root.used) { root.used = true; failures.push(result.error); } }
    if (runtime) try { await runtime.dispose(); } catch (error) { failures.push(error); }
    if (directory) try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (!finished) { const failures = await cleanup(); if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures); } });
  try {
    directory = await mkdtemp(join(tmpdir(), 'owned-http-legacy-'));
    runtime = await take(own(startWorkerdFixture(directory, router, upstream, { preventEviction: true })));
    for (const mode of ['record', 'nonrecord', 'mixed', 'covered-nonrecord', 'runtime', 'stale', 'empty']) {
      const response = await take(dispatch('https://fixture/' + mode)), text = await take(body(response));
      assert.equal(response.status, 200, 'native legacy mode ' + mode);
      const report = JSON.parse(text); assert.equal(report.ok, true); assert.equal(report.charged, report.baseline);
    }
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'legacy native fixture cleanup');
  if (hasPrimary) throw primary;
});
