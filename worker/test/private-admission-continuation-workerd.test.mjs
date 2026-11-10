import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const router = String.raw`
import {PolicyBindingIndexObject as Base} from './worker/authority.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {preflightCredential,consumeCredentialPreflight,completeCredentialAdmission,releaseCredentialPreflight,releaseCredentialPreflightContinuation} from './worker/credential-preflight.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {identitySourceBudget,isIdentityFailure} from './worker/identity-admission.ts';
const digest='ab'.repeat(32),rotated='cd'.repeat(32),selectedKey='oauth/native-bridge-policy/anthropic';
const check=(ok,label)=>{if(!ok)throw Error(label);};
const dependencyA='oauth/native-bridge-policy/a',dependencyB='oauth/native-bridge-policy/b';
const projection=priority=>({provider:'anthropic',kind:'api_key',enabled:true,priority,credentialStore:'durable_object',credentialGeneration:1,credentialLineage:'synthetic',credentialStatus:'active',hasCredential:true});
const record=secret=>({enabled:true,secretSha256:secret,policyId:'native-bridge-policy',policyGeneration:'legacy',principalId:null});
function observe(body,row){
 const get=body.getReader.bind(body);
 body.getReader=options=>{row.byob=options?.mode==='byob';const reader=get(options),read=reader.read.bind(reader),unlock=reader.releaseLock.bind(reader);
  reader.read=(...args)=>{row.reads++;const actual=read(...args);void actual.then(part=>{if(part.done)row.eof=true;if(part.value)row.backing=Math.max(row.backing,part.value.buffer.byteLength);},()=>{});return actual;};
  reader.releaseLock=()=>{unlock();row.unlocked=!body.locked;};return reader;
 };return body;
}
export class PolicyBindingIndexObject extends Base {
 constructor(state,env){
  const sql=state.storage.sql,native=env.POLICY_KV,get=native.get.bind(native),trace={kv:[],writes:0,intakes:0};let mode='healthy';
  const kv=new Proxy(native,{get(target,key){if(key==='get')return async(name,type)=>{
   const result=await get(name,type);
   if(type==='stream'&&result){const row={byob:false,reads:0,eof:false,unlocked:false,backing:0};trace.kv.push(row);observe(result,row);
    if(mode==='rotation'&&name==='policies/native-bridge-policy')sql.exec('INSERT OR REPLACE INTO proxy_credentials(credential_id,credential_json) VALUES(?,?)','nativebridge',JSON.stringify(record(rotated)));
   }return result;
  };const result=Reflect.get(target,key,target);return typeof result==='function'?result.bind(target):result;}});
  const storage=new Proxy(state.storage,{get(target,key){if(key==='sql')return {exec(query,...args){if(/^(INSERT|UPDATE|DELETE)/.test(query))trace.writes++;return sql.exec(query,...args);}};
   const result=Reflect.get(target,key,target);return typeof result==='function'?result.bind(target):result;}});
  super({storage},new Proxy(env,{get(target,key,receiver){if(key==='CLAWROUTER_OPTIONAL_CONFIG_KEYS'&&mode==='configuration'){trace.configurationReads=(trace.configurationReads??0)+1;return 'A,'.repeat(1677721)+'A';}return key==='POLICY_KV'?kv:Reflect.get(target,key,receiver);}}));
  const intake=this.completePrivateAdmission;this.completePrivateAdmission=(...args)=>{trace.intakes++;return Reflect.apply(intake,this,args);};
  const finalize=this.finalPrivateAdmission;this.finalPrivateAdmission=(...args)=>{
   if(mode.startsWith('inert-')){const input=args[0];check(mode==='inert-top'?!Object.hasOwn(input,'extra'):mode==='inert-array'?input.extra.length===1&&input.extra[0]===null:Object.keys(input.extra).length===0,'inert wire omission/null');trace.inertWire=true;}
   if(mode==='symbols'){const input=args[0];check(Object.keys(input).join(',')==='providers,__proto__,unknown,credentialId,secretSha256'&&Object.hasOwn(input,'__proto__')&&input.__proto__.kept===true&&input.unknown.kept===7,'unchanged string wire');trace.stringWire=true;}
   if(mode.startsWith('dependency-')){
    const prior=args[1];
    check(mode.endsWith('choice')?prior.selection?.selected?.key===dependencyA:prior.snapshots?.anthropic?.revisions[dependencyB]===8,'candidate observed before pending publication');
    trace.dependencyObserved=true;
    const same=mode.includes('-same-');
    const published=this.publishGrantAttachment({key:dependencyB,generation:same?1:2,revision:8,admissionRevision:8,provider:'anthropic',status:'active',projection:{...projection(0),credentialGeneration:same?1:2}});
    trace.publishedRevision=published.revision;check(published.revision===(same?8:9)&&!published.pending,'actual pending publication');
   }
   return Reflect.apply(finalize,this,args);
  };

  this.snapshot=()=>({trace,charged:this.preflightArena?.charged??0,credentials:[...sql.exec('SELECT credential_json FROM proxy_credentials')].length,policies:[...sql.exec('SELECT policy_json FROM access_policies')].length,selection:[...sql.exec('SELECT selected_count FROM upstream_grant_selection')].map(row=>row.selected_count),cursors:[...sql.exec('SELECT grant_key FROM upstream_grant_pool_cursors')].length});
  this.configure=value=>{mode=value;sql.exec('DELETE FROM proxy_credentials');sql.exec('DELETE FROM access_policies');sql.exec('DELETE FROM policy_binding_meta');sql.exec('DELETE FROM provider_connections');sql.exec('DELETE FROM upstream_grant_projections');sql.exec('DELETE FROM upstream_grant_selection');sql.exec('DELETE FROM upstream_grant_pool_cursors');sql.exec('DELETE FROM upstream_grant_pool_versions');sql.exec('DELETE FROM upstream_grant_pool_members');if(mode==='selection'||mode==='snapshot-only'||mode==='snapshot-select'||mode==='configuration')sql.exec('INSERT INTO upstream_grant_pool_versions(grant_key,generation,revision) VALUES(?,?,?)',selectedKey,1,7);if(mode.startsWith('dependency-')){
   for(const [key,token,value] of [[dependencyA,'a',projection(2)],[dependencyB,'b',projection(5)]]){
    sql.exec('INSERT INTO upstream_grant_pool_versions(grant_key,generation,revision) VALUES(?,?,?)',key,1,7);
    sql.exec('INSERT INTO upstream_grant_pool_members(scope,scope_id,provider_id,token_ref,status) VALUES(?,?,?,?,?)','policies','native-bridge-policy','anthropic',token,'active');
    sql.exec('INSERT INTO upstream_grant_projections(grant_key,projection_json,legacy) VALUES(?,?,0)',key,JSON.stringify(value));
   }
   check(this.admitGrantAttachment({key:dependencyB,generation:1,revision:7,provider:'anthropic',status:'active'}).revision===8,'pending reservation');
  }
  trace.kv=[];trace.writes=0;trace.intakes=0;trace.configurationReads=0;trace.dependencyObserved=false;trace.publishedRevision=0;trace.stringWire=false;trace.inertWire=false;};
 }
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/fixture/configure'){this.configure(await request.text());return new Response('configured');}
  if(path==='/fixture/result')return Response.json(this.snapshot());
  return super.fetch(request);
 }
}
export default {async fetch(request,env){
 const mode=new URL(request.url).pathname.slice(1),dependency=mode.startsWith('dependency-'),stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings'));
 const roots=[];let proof,continuation,handle,restoreCopy,restoreDescriptor,hasPrimary=false,primary;
 const own=promise=>{const root={outcome:promise.then(value=>({failed:false,value}),error=>({failed:true,error})),used:false};roots.push(root);return root;};
 const take=async root=>{const result=await root.outcome;root.used=true;if(result.failed)throw result.error;return result.value;};
 const rpc=async(path,body,headers)=>{const response=await take(own(stub.fetch('https://authority'+path,{method:'POST',body,headers})));const text=await take(own(response.text()));return {status:response.status,body:text?JSON.parse(text):null};};
 let result;const baseline=bodyBudgetCharged();
 try{
  const configured=await take(own(stub.fetch('https://authority/fixture/configure',{method:'POST',body:mode})));await take(own(configured.text()));check(configured.status===200,'configure');
  await env.POLICY_KV.put('credentials/nativebridge',JSON.stringify({...record(digest),...(mode==='principal'?{principalId:' '.repeat(4096)+'FIXTURE@EXAMPLE.COM'+' '.repeat(4096)}:{})}));
  if(mode==='principal')await env.POLICY_KV.put('access/users/fixture@example.com',JSON.stringify({enabled:true,groups:[]}));
  await env.POLICY_KV.put('policies/native-bridge-policy',JSON.stringify({enabled:true,generation:'legacy',providers:[],requestCostMicros:7}));
  if(mode==='provider-only')await env.POLICY_KV.put('connections/anthropic',JSON.stringify({providerId:'anthropic',enabled:true}));
  if(mode==='selection'||mode==='snapshot-only'||mode==='snapshot-select'||mode==='configuration'||dependency){
   await env.POLICY_KV.put('connections/anthropic',JSON.stringify({providerId:'anthropic',enabled:true}));
   await env.POLICY_KV.put(selectedKey,JSON.stringify({provider:'anthropic',kind:'api_key',enabled:true,credentialStore:'durable_object',credentialGeneration:1,credentialLineage:'synthetic',credentialStatus:'active',hasCredential:true}));
  }
  if(mode==='healthy'||mode==='selection'||mode==='copy-pressure'||mode==='callable-pressure'||mode==='callables'||mode.startsWith('hook-')||mode.startsWith('inert-')||mode==='symbols'){
   const preflight=await take(own(preflightCredential(env,'nativebridge',digest)));check(preflight.outcome==='matched','preflight');proof=preflight.proof;
   continuation=consumeCredentialPreflight(proof,env,'nativebridge',digest);proof=undefined;
   let admission=mode==='selection'?{providers:[{id:'anthropic',tokenRef:'anthropic'}],selection:{providerId:'anthropic',endpointId:'messages',mode:'http',capability:'llm.messages'}}:{providers:[]};
   let copyFactories=0,symbolReads=0,callableReads=0,inertDescriptors=0,inertInvoked=0,lookupQualified=false;
   if(mode.startsWith('inert-')){
    const lookupGetter=Object.prototype.__lookupGetter__,lookupSetter=Object.prototype.__lookupSetter__;
    check(typeof lookupGetter==='function'&&typeof lookupSetter==='function','native accessor lookup availability');
    const parent=Object.create(Function.prototype),fn=()=>{inertInvoked++;throw undefined;};
    const getter=()=>{inertInvoked++;throw undefined;},setter=()=>{inertInvoked++;throw undefined;};
    Object.defineProperty(parent,'toJSON',{get:getter,set:setter,configurable:true});Object.setPrototypeOf(fn,parent);
    check(Reflect.apply(lookupGetter,parent,['toJSON'])===getter&&Reflect.apply(lookupSetter,parent,['toJSON'])===setter,'native active accessor identities');
    if(mode==='inert-object'||mode==='inert-empty')Object.defineProperty(parent,'toJSON',{value:getter});
    Object.defineProperty(fn,'toJSON',mode==='inert-empty'?{get:undefined,set:undefined}:{value:'x'.repeat(16777217)});
    check(Reflect.apply(lookupGetter,fn,['toJSON'])===undefined&&Reflect.apply(lookupSetter,fn,['toJSON'])===undefined,'native inert shadow semantics');lookupQualified=true;
    const saved=Object.getOwnPropertyDescriptor(Object,'getOwnPropertyDescriptor'),original=saved.value;
    restoreDescriptor=()=>Object.defineProperty(Object,'getOwnPropertyDescriptor',saved);
    Object.defineProperty(Object,'getOwnPropertyDescriptor',{...saved,value:function(target,key){if((target===fn||target===parent)&&key==='toJSON')inertDescriptors++;return Reflect.apply(original,this,[target,key]);}});
    admission.extra=mode==='inert-top'?fn:mode==='inert-array'?[fn]:{fn};
   }
   if(mode==='callables')for(let index=0;index<1025;index++)admission['callable'+index]=()=>{callableReads++;throw undefined;};
   if(mode==='copy-pressure'||mode==='callable-pressure'){
    if(mode==='copy-pressure')for(let index=0;index<16384;index++)admission[String(index).padStart(5,'0')+'x'.repeat(1019)]=undefined;
    else for(let index=0;index<1025;index++)admission[String(index).padStart(4,'0')+'x'.repeat(6396)]=()=>{throw Error('callable must not run');};
    const saved=Object.getOwnPropertyDescriptor(Object,'create'),original=saved.value;
    restoreCopy=()=>Object.defineProperty(Object,'create',saved); // registered BEFORE installation/start
    Object.defineProperty(Object,'create',{...saved,value:function(prototype,...args){if(prototype===null)copyFactories++;return Reflect.apply(original,this,[prototype,...args]);}});
   }
   if(mode==='symbols'){
    Object.defineProperty(admission,'__proto__',{value:{kept:true},enumerable:true});admission.unknown={kept:7};admission.omitted=undefined;admission.symbolValue=Symbol('omitted-value');
    const large={payload:'x'.repeat(4*1048576)};large.self=large;admission[Symbol('large')]=large;
    Object.defineProperty(admission,Symbol('getter'),{enumerable:true,get(){symbolReads++;throw undefined;}});
   }
   if(mode.startsWith('hook-')){
    let invoked=0,failed=false;const fn=()=>{invoked++;throw undefined;},holder=mode==='hook-array'?Object.create(Function.prototype):fn;
    Object.defineProperty(holder,'toJSON',mode==='hook-object'?{value(){invoked++;return 'X'.repeat(20000000);}}:{get(){invoked++;throw undefined;}});
    if(holder!==fn)Object.setPrototypeOf(fn,holder);
    admission.extra=mode==='hook-object'?{fn}:mode==='hook-array'?[fn]:fn;
    try{const operation=completeCredentialAdmission(continuation,admission);continuation=undefined;handle=await take(own(operation));}
    catch(error){if(!isIdentityFailure(error)||error.message!=='Identity admission failed (protocol)')throw error;failed=true;}
    check(failed&&invoked===0&&bodyBudgetCharged()-baseline===32*1024*1024,'prevalidation hook denial retains owner');
    releaseCredentialPreflightContinuation(continuation);continuation=undefined;result={status:503,invoked};
   }else{
   const consumed=continuation,operation=completeCredentialAdmission(consumed,admission);continuation=undefined;
   if(mode==='copy-pressure'||mode==='callable-pressure'){
    let failed=false;try{handle=await take(own(operation));}catch(error){if(!isIdentityFailure(error))throw error;failed=true;}
    check(failed&&copyFactories===0,'pre-copy capacity');result={status:503,copyFactories};
   }else{
    handle=await take(own(operation));
    check(bodyBudgetCharged()-baseline===32*1024*1024,'full result remains funded');check(Object.keys(handle).join(',')==='dispose'&&JSON.stringify(handle)==='{}','opaque');
    handle.dispose();handle=undefined;check(symbolReads===0,'no Symbol getter read');check(callableReads===0,'callables never invoked');check(inertDescriptors===0&&inertInvoked===0,'no inert descriptor carrier or callback');result={status:200,opaque:true,symbolReads,callableReads,inertDescriptors,inertInvoked,lookupQualified};
   }
   }
   admission=undefined;
  }else{
   const source=identitySourceBudget();if(mode==='limited')source.values=131050;
   const reply=await rpc('/admission/resolve',JSON.stringify({admission:{credentialId:'nativebridge',secretSha256:digest,providers:mode==='provider-only'||mode==='configuration'||mode==='snapshot-only'||mode==='snapshot-select'||dependency?[{id:'anthropic',tokenRef:dependency?'a':'anthropic'}]:[],...(mode==='configuration'||mode==='snapshot-only'||mode==='snapshot-select'||dependency?{selection:{providerId:'anthropic',endpointId:'messages',mode:'http',capability:'llm.messages'}}:{}),...(mode.endsWith('snapshot')||mode==='snapshot-only'?{snapshot:'only'}:mode==='snapshot-select'?{snapshot:'select'}:{})},source}),{'content-type':'application/json','x-clawrouter-private-admission':'v1'});
   check(reply.status===(mode==='limited'||mode==='configuration'?503:200),'private status');
   if(mode==='provider-only')check(!reply.body.admission.selection&&reply.body.admission.connections[0]?.providerId==='anthropic'&&reply.body.admission.pools.anthropic.keys.length>0,'nonempty provider no selection');
   if(mode==='principal')check(reply.body.admission.owner?.email==='fixture@example.com','padded principal');
   if(mode==='snapshot-only'||mode==='snapshot-select')check(reply.body.admission.snapshots?.anthropic?.candidates.length===2,'funded snapshot output');
   if(mode==='rotation')check(reply.body.admission.credential.credential.secretSha256===rotated&&!reply.body.admission.selection,'final canonical winner');
   if(dependency)check(!Object.hasOwn(reply.body.admission,'selection')&&!Object.hasOwn(reply.body.admission,'snapshots'),'all candidate dependencies revalidated');
   if(mode==='limited'||mode==='configuration')check(reply.body.error.code==='identity_admission_unavailable','capacity classification');
   result={status:reply.status,rotation:mode==='rotation'};
  }
 }catch(error){hasPrimary=true;primary=error;}
 const failures=[];
 for(let i=0;i<roots.length;i++){const outcome=await roots[i].outcome;if(outcome.failed&&!roots[i].used){roots[i].used=true;failures.push(outcome.error);}}
 try{if(handle)handle.dispose();else if(continuation)releaseCredentialPreflightContinuation(continuation);else if(proof)releaseCredentialPreflight(proof);}catch(error){failures.push(error);}
 try{restoreCopy?.();}catch(error){failures.push(error);}finally{restoreCopy=undefined;}
 try{restoreDescriptor?.();}catch(error){failures.push(error);}finally{restoreDescriptor=undefined;}
 if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'native bridge cleanup');if(hasPrimary)throw primary;
 const snapshot=await rpc('/fixture/result','');check(bodyBudgetCharged()===baseline,'worker charge retired');
 check(snapshot.body.charged===0,'DO original producer retired');
 if(dependency)check(snapshot.body.trace.dependencyObserved&&snapshot.body.trace.publishedRevision===(mode.includes('-same-')?8:9)&&snapshot.body.selection.length===0&&snapshot.body.cursors===0,'no stale selection effect');
 if(mode==='copy-pressure'||mode==='callable-pressure'||mode.startsWith('hook-'))check(snapshot.body.trace.intakes===0,'zero private RPC before copy');
 if(mode==='selection')check(snapshot.body.selection.length===1&&snapshot.body.selection[0]===1,'one actual selection effect');
 if(mode==='configuration')check(snapshot.body.trace.configurationReads===1&&snapshot.body.selection.length===0,'bounded configuration owner');
 if(mode==='limited'||mode==='configuration')check(snapshot.body.trace.writes===0&&snapshot.body.credentials===0&&snapshot.body.policies===0,'zero writes');
 for(const row of snapshot.body.trace.kv)check(row.byob&&row.reads>0&&row.eof&&row.unlocked&&row.backing<=16384,'original native KV owner');
 return Response.json({...result,charged:bodyBudgetCharged()-baseline,sql:snapshot.body});
}};
`;
const upstream = `export default {fetch(){throw Error('private bridge must not dispatch');}}`;
test('inactive private continuation through actual Workerd KV/RPC/SQLite and opaque original result custody', { timeout: 120000 }, async t => {
  let runtime, directory, hasPrimary = false, primary, finished = false, cleanupPromise;
  const roots = [];
  const own = promise => { const root = { outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })), used: false }; roots.push(root); return root; };
  const take = async root => { const result = await root.outcome; root.used = true; if (result.failed) throw result.error; return result.value; };
  const cleanup = () => cleanupPromise ??= (async () => {
    const errors = [];
    for (let i = 0; i < roots.length; i++) { const result = await roots[i].outcome; if (result.failed && !roots[i].used) { roots[i].used = true; errors.push(result.error); } }
    if (runtime) try { await runtime.dispose(); } catch (error) { errors.push(error); }
    if (directory) try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    return errors;
  })();
  t.after(async () => { if (!finished) { const errors = await cleanup(); if (errors.length) throw new AggregateError(errors, 'native fixture cleanup'); } });
  try {
    directory = await mkdtemp(join(tmpdir(), 'private-admission-workerd-'));
    runtime = await take(own(startWorkerdFixture(directory, router, upstream, { preventEviction: true })));
    for (const mode of ['healthy', 'provider-only', 'rotation', 'limited', 'selection', 'configuration', 'dependency-choice', 'dependency-snapshot', 'dependency-same-choice', 'dependency-same-snapshot', 'snapshot-only', 'snapshot-select', 'principal', 'copy-pressure', 'callable-pressure', 'callables', 'hook-top', 'hook-object', 'hook-array', 'inert-top', 'inert-object', 'inert-array', 'inert-empty', 'symbols']) {
      const response = await take(own(runtime.dispatchFetch('https://fixture/' + mode)));
      const text = await take(own(response.text())); assert.equal(response.status, 200);
      const result = JSON.parse(text); assert.equal(result.charged, 0); assert.equal(result.sql.charged, 0);
      assert.equal(result.sql.trace.intakes, mode === 'copy-pressure' || mode === 'callable-pressure' || mode.startsWith('hook-') ? 0 : 1); assert.equal(result.status, mode === 'limited' || mode === 'configuration' || mode === 'copy-pressure' || mode === 'callable-pressure' || mode.startsWith('hook-') ? 503 : 200);
      if (mode === 'healthy') { assert.equal(result.opaque, true); assert.equal(result.sql.credentials, 1); assert.equal(result.sql.policies, 1); }
      if (mode === 'selection') { assert.equal(result.opaque, true); assert.deepEqual(result.sql.selection, [1]); assert.ok(result.sql.trace.kv.length >= 3); }
      if (mode.startsWith('dependency-')) { assert.equal(result.sql.trace.dependencyObserved, true); assert.equal(result.sql.trace.publishedRevision, mode.includes('-same-') ? 8 : 9); assert.deepEqual(result.sql.selection, []); assert.equal(result.sql.cursors, 0); }
      if (mode === 'copy-pressure' || mode === 'callable-pressure') assert.equal(result.copyFactories, 0);
      if (mode.startsWith('hook-')) assert.equal(result.invoked, 0);
      if (mode === 'callables') assert.equal(result.callableReads, 0);
      if (mode.startsWith('inert-')) { assert.equal(result.lookupQualified, true); assert.equal(result.inertDescriptors, 0); assert.equal(result.inertInvoked, 0); assert.equal(result.sql.trace.inertWire, true); }
      if (mode === 'symbols') { assert.equal(result.symbolReads, 0); assert.equal(result.sql.trace.stringWire, true); }
      if (mode === 'rotation') assert.equal(result.rotation, true);
      if (mode === 'limited') assert.equal(result.sql.trace.writes, 0);
    }
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'native bridge outcomes');
  if (hasPrimary) throw primary;
});
