import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const router = String.raw`
import worker from './worker/index.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {PolicyBindingIndexObject as Base,authorityCall} from './worker/authority.ts';
import {authenticateProxyKey,admittedGrantSelection,proxyAdmission} from './worker/proxy-auth.ts';
import {readIdentityResponse,isIdentityFailure} from './worker/identity-admission.ts';
import {providerById} from './worker/providers.ts';
import {normalizePolicyRecord} from './worker/authority-policy.ts';
import {clearHotCaches} from './worker/hot-cache.ts';
import {sha256Hex} from './worker/utils.ts';
const faultStates=new Map();
const originalTransport=globalThis.fetch.bind(globalThis);
const check=(ok,label)=>{if(!ok)throw Error(label);};
function observe(body,record){
 const get=body.getReader.bind(body);
 body.getReader=options=>{
  const reader=get(options),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),release=reader.releaseLock.bind(reader);
  record.byob=options?.mode==='byob';record.locked=body.locked;
  reader.read=(...args)=>{record.reads++;const actual=read(...args);void actual.then(part=>{
   if(part.value)record.maxBacking=Math.max(record.maxBacking,part.value.buffer.byteLength);if(part.done)record.eof=true;
  },()=>{record.readFailed=true;});return actual;};
  reader.cancel=(...args)=>{record.cancels++;return cancel(...args);};
  reader.releaseLock=()=>{release();record.locked=body.locked;record.unlocked=!body.locked;};
  return reader;
 };return body;
}
const observation=()=>({byob:false,eof:false,locked:false,unlocked:false,maxBacking:0,reads:0,cancels:0,readFailed:false});
async function probe(body){
 const record=observation();observe(body,record);let reader,primary,hasPrimary=false,eof=false;const failures=[];
 try{reader=body.getReader({mode:'byob'});let backing=new Uint8Array(16384);
  for(;;){const part=await reader.read(backing);if(part.value){check(part.value.buffer.byteLength<=16384,'whole backing');backing=new Uint8Array(part.value.buffer);}if(part.done){eof=true;break;}}
 }catch(error){hasPrimary=true;primary=error;}
 finally{
  if(reader){if(!eof)try{await reader.cancel();}catch(error){failures.push(error);}try{reader.releaseLock();}catch(error){failures.push(error);}}
  else if(!body.locked){try{await body.cancel();}catch(error){failures.push(error);}}
  else failures.push(Error('capability probe: original lock owner unknown; disposal is not retirement'));
 }
 if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'probe cleanup');if(hasPrimary)throw primary;
 return record;
}
export class PolicyBindingIndexObject extends Base{
 constructor(state,env){
  const trace={sizes:0,values:0,writes:0,selectedRequests:[],kv:[]},sql=state.storage.sql;
  const nativeKv=env.POLICY_KV,getKv=nativeKv.get.bind(nativeKv);
  const observedKv=new Proxy(nativeKv,{get(target,key){
   if(key==='get')return async(...args)=>{
    const body=await getKv(...args);
    if(args[1]==='stream'&&body instanceof ReadableStream){
     const kind=typeof args[0]==='string'&&args[0].startsWith('credentials/')?'credential':typeof args[0]==='string'&&args[0].startsWith('policies/')?'policy':'other';
     const row={kind,...observation()};trace.kv.push(row);observe(body,row);
    }return body;
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const observedEnv=new Proxy(env,{get(target,key,receiver){return key==='POLICY_KV'?observedKv:Reflect.get(target,key,receiver);}});
  const wrapped=new Proxy(state.storage,{get(target,key){if(key==='sql')return {exec(query,...args){
   if(query.startsWith('SELECT length')||query.startsWith('SELECT count'))trace.sizes++;
   if(/^SELECT (?:credential_json|policy_json|user_json|connection_json|projection_json|json_object)/.test(query))trace.values++;
   if(/^(INSERT|UPDATE|DELETE)/.test(query))trace.writes++;
   return sql.exec(query,...args);
  }};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  super({storage:wrapped},observedEnv);this.fixtureSql=sql;this.fixtureTrace=trace;
 }
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/fixture/sql'){const input=await request.json();return Response.json([...this.fixtureSql.exec(input.query,...input.args)]);}
  if(path==='/fixture/trace'){const value={...this.fixtureTrace,selectedRequests:this.fixtureTrace.selectedRequests};if(new URL(request.url).searchParams.has('reset')){this.fixtureTrace.sizes=0;this.fixtureTrace.values=0;this.fixtureTrace.writes=0;this.fixtureTrace.selectedRequests=[];this.fixtureTrace.kv=[];}return Response.json(value);}
  if(path==='/fixture/request-capability')return Response.json(await probe(request.body));
  if(request.headers.has('x-clawrouter-identity-admission')){const row=observation();this.fixtureTrace.selectedRequests.push(row);observe(request.body,row);}
  return super.fetch(request);
 }
}
export default {async fetch(request,bindings,context){
 const path=new URL(request.url).pathname;
 if(path==='/probe-reject'){
  await request.text();const outcomes=[];
  for(const reason of [undefined,Error('synthetic shared probe reason')]){
   let cancels=0;const body=new ReadableStream({cancel(){cancels++;throw reason;}});
   // Deliberately unsupported fixture producer; the SAME capability helper must
   // join its ORIGINAL unlocked body's cancellation, including identical reasons.
   body.getReader=()=>{throw reason;};let failed=false;
   try{await probe(body);}catch(error){failed=true;check(error instanceof AggregateError&&error.errors.length===2,'both probe outcomes');check(Object.is(error.errors[0],reason)&&Object.is(error.errors[1],reason),'original outcome identities');}
   check(failed&&cancels===1&&!body.locked,'probe FIRST cleanup joined');outcomes.push({failed,cancels,unlocked:!body.locked});
  }
  return Response.json({label:'synthetic unsupported BYOB producer; not a healthy platform capability',outcomes});
 }
 if(path==='/fault-state')return Response.json(faultStates.get('current')??null);
 if(path==='/fault'){
  await request.text();
  const state={pending:0,reads:0,cancels:0,actualCancel:false,cancelHeld:false,unlocks:0,locked:false,done:false};faultStates.set('current',state);
  const roots=[];let primary,hasPrimary=false;const cleanup=[];
  const observe=actual=>{roots.push(Promise.resolve(actual).then(()=>({failed:false}),error=>({failed:true,error})));return actual;};
  const start=async()=>{
   const response=await originalTransport('https://fault.example/source'),body=response.body,get=body.getReader.bind(body);
   body.getReader=options=>{
    const reader=get(options),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),unlock=reader.releaseLock.bind(reader);state.locked=body.locked;
    reader.read=(...args)=>{state.reads++;state.pending++;const actual=read(...args);void actual.then(()=>{state.pending--;},()=>{state.pending--;});return actual;};
    let first;reader.cancel=(...args)=>{if(!first){state.cancels++;first=(async()=>{
      let failed=false,error;try{await cancel(...args);state.actualCancel=true;}catch(reason){failed=true;error=reason;}
      state.cancelHeld=true;let gateFailure=false,gateError;
      try{const gate=await originalTransport('https://fault.example/gate');await gate.text();}catch(reason){gateFailure=true;gateError=reason;}finally{state.cancelHeld=false;}
      if(gateFailure)throw new AggregateError(failed?[error,gateError]:[gateError],'cancel and gate');if(failed)throw error;throw undefined;
    })();void first.catch(()=>undefined);}return first;};
    reader.releaseLock=()=>{state.unlocks++;unlock();state.locked=body.locked;};return reader;
   };return response;
  };
  const operation=readIdentityResponse(start);
  // Expected terminal cleanup denial is checked on the actually awaited path.
  const verdict=operation.then(()=>{throw Error('fault unexpectedly fulfilled');},error=>{check(isIdentityFailure(error)&&error.message.endsWith('(cleanup)'),'actual cleanup classification');});
  observe(verdict);
  try{await verdict;state.done=true;}catch(error){hasPrimary=true;primary=error;}
  finally{for(const result of await Promise.all(roots))if(result.failed)cleanup.push(result.error);}
  if(cleanup.length)throw new AggregateError(hasPrimary?[primary,...cleanup]:cleanup,'fault and independent roots');if(hasPrimary)throw primary;
  return Response.json({label:'native pending read; FIRST cancel continuation held AFTER actual cancel; not physical retirement',...state});
 }
 const mode=new URL(request.url).pathname.slice(1),id='identity'+mode.replaceAll('-','');
 await request.text(); // Explicit small originating fixture ingress support.
 const ns=bindings.ACCESS_CONTROL,stub=ns.get(ns.idFromName(id)),kv=bindings.POLICY_KV;
 const traces={kv:[],reply:[],admissions:0,providerPosts:0},outcomes=[];let next=0,closed=false;
 const track=actual=>{const outcome=Promise.resolve(actual).then(()=>({failed:false}),error=>({failed:true,error}));outcomes.push(outcome);context.waitUntil(outcome);return actual;};
 const drain=async()=>{const errors=[];while(next<outcomes.length){const result=await outcomes[next++];if(result.failed)errors.push(result.error);}if(errors.length)throw new AggregateError(errors,'independent originating roots');};
 const call=async(path,value)=>{const response=await stub.fetch('https://fixture.example'+path,{method:'POST',body:JSON.stringify(value)});const text=await response.text();check(response.ok,'fixture owner control');return response.headers.get('content-type')?.includes('json')?JSON.parse(text):text;};
 const sql=(query,...args)=>call('/fixture/sql',{query,args});
 const env={...bindings,ANTHROPIC_API_KEY:'synthetic-identity-key',ACCESS_CONTROL:{idFromName:name=>name,get:()=>({async fetch(input,init){
  if(new URL(input).pathname==='/admission/resolve')traces.admissions++;
  const response=await stub.fetch(input,init);if(response.body&&new Headers(init?.headers).has('x-clawrouter-identity-admission')){const row=observation();traces.reply.push(row);observe(response.body,row);}return response;
 }})},POLICY_KV:{get:async(key,type)=>{
  const body=await kv.get(id+'/'+key,type);if(type==='stream'&&body){const row=observation();traces.kv.push(row);observe(body,row);}return body;
 },put:(key,value)=>kv.put(id+'/'+key,value)}};
 const originalFetch=globalThis.fetch,cache=caches.default,put=cache.put.bind(cache);let cacheKey;
 globalThis.fetch=(input,init)=>{if(String(input)==='https://api.anthropic.com/v1/messages')traces.providerPosts++;return originalFetch(input,init);};
 cache.put=(key,response)=>{cacheKey=String(key);return track(put(key,response));};
 let primary,hasPrimary=false,result;const cleanup=[];
 try{
  clearHotCaches();
  const record={enabled:true,generation:'g1',providers:['anthropic'],models:['anthropic/claude-sonnet-5'],tenantId:'fixture',monthlyBudgetMicros:null,retainRequestContent:false,grantRouting:{environmentFallback:true,eligibleGrants:{}}};
  const credential={enabled:true,secretSha256:await sha256Hex('synthetic-identity-secret'),policyId:id,policyGeneration:'g1',principalId:'owner@example.invalid'};
  const headers={authorization:'Bearer clawrouter-live-'+id+'-synthetic-identity-secret','content-type':'application/json'};
  const putKv=(key,value)=>kv.put(id+'/'+key,typeof value==='string'?value:JSON.stringify(value));
  await putKv('capability',{ok:true});const kvCapability=await probe(await kv.get(id+'/capability','stream'));
  const requestCapability=await call('/fixture/request-capability',{credentialId:id,providers:[{id:'anthropic',tokenRef:'anthropic'}]});
  await call('/policies/initialize-all',[{policyId:id,policy:record}]);
  await call('/credentials/initialize-all',[{credentialId:id,credential}]);
  await call('/users/initialize-all',[{email:'owner@example.invalid',record:{enabled:true,groups:[],assignmentRevision:JSON.stringify(Array.from({length:1000},(_,i)=>({id:'rule-'+i,subject:'nonmatching-'+i+'x'.repeat(60)}))),unknown:{policyId:'x'.repeat(1025),__proto__:null}}}]);
  await call('/connections/initialize-all',[{providerId:'anthropic',enabled:true}]);
  const legacy=JSON.stringify(Array.from({length:1000},(_,i)=>({id:'rule-'+i,subject:'nonmatching-'+i+'x'.repeat(60)})));
  const canonicalUser=JSON.stringify({enabled:true,groups:[],assignmentRevision:legacy,unknown:JSON.parse('{"__proto__":{"kept":true},"policyId":"'+ 'x'.repeat(1025)+'"}')});
  await sql('UPDATE access_users SET user_json = ? WHERE email = ?',canonicalUser,'owner@example.invalid');
  if(mode==='cold'){
   await sql('DELETE FROM proxy_credentials');await sql('DELETE FROM policy_binding_meta WHERE meta_key = ?','credentials_global_initialized');await kv.put('credentials/'+id,JSON.stringify(credential));
  }
  let coldRoutingBytes;
  if(mode==='cold-routing'){
   record.grantRouting=JSON.parse('{"eligibleGrants":{"__proto__":["token"]},"sharedGrants":{"__proto__":'+JSON.stringify(Array.from({length:32},(_,i)=>'oauth/shared/key'+i))+',"anthropic":["oauth/shared/later"]}}');
   const raw=JSON.stringify(record);coldRoutingBytes=JSON.stringify(normalizePolicyRecord(record,false));
   check(JSON.stringify(record)===raw,'normalizer leaves RAW policy unchanged');
   await sql('DELETE FROM access_policies');await sql('DELETE FROM policy_binding_meta WHERE meta_key = ?','policies_global_initialized');await kv.put('policies/'+id,raw);
  }
  if(mode==='sql-limit')await sql('UPDATE proxy_credentials SET credential_json = ? WHERE credential_id = ?',' '.repeat(1048576)+'{}',id);
  if(mode==='kv-limit'){
   await sql('DELETE FROM proxy_credentials');await sql('DELETE FROM policy_binding_meta WHERE meta_key = ?','credentials_global_initialized');await kv.put('credentials/'+id,' '.repeat(1048576)+'{}');
  }
  await call('/fixture/trace?reset',{});
  const send=async()=>{const response=await worker.fetch(new Request('https://router.example/v1/messages',{method:'POST',headers,body:JSON.stringify({model:'anthropic/claude-sonnet-5',max_tokens:16,messages:[]})}),env,{waitUntil:track});
   const text=await response.text();await drain();return {status:response.status,body:JSON.parse(text)};};
  const first=await send();
  const diagnosticMode=['healthy','cold','cold-routing','pool-commit','sql-limit','kv-limit','colo','refresh'].includes(mode)?mode:'unknown';
  const errorCode=first.body?.error?.code??first.body?.error?.type;
  const errorClass=['identity_admission_unavailable','invalid_proxy_key','access_denied','provider_unavailable','internal_error','api_error','authentication_error','invalid_request_error'].includes(errorCode)?errorCode:first.body?.error?'unexpected':'none';
  try{console.log(JSON.stringify({phase:'identity-public-status',mode:diagnosticMode,status:first.status,errorClass}));}catch{}
  const limited=mode==='sql-limit'||mode==='kv-limit';check(first.status===(limited?503:200),'actual public status');
  if(limited){check(first.body.error.code==='identity_admission_unavailable','terminal public profile code');check(traces.providerPosts===0,'no provider after denial');}
  const firstTrace=await call('/fixture/trace',{});
  if(!limited){
   const admission=await authorityCall(env,'/admission/resolve',{credentialId:id,secretSha256:credential.secretSha256,providers:[{id:'anthropic',tokenRef:'anthropic'}]});
   if(mode==='cold-routing'){
    const storedPolicy=await sql('SELECT policy_json FROM access_policies WHERE policy_id = ?',id);
    check(storedPolicy[0].policy_json===coldRoutingBytes&&JSON.stringify(admission.policy.policy)===coldRoutingBytes,'actual cold routing canonical JSON bytes');
    check(admission.policy.policy.grantRouting.sharedGrants.anthropic.length===0,'raw prototype shared quota consumed');
   }
   check(admission.owner.record.assignmentRevision===legacy&&legacy.length>65536,'actual complete legacy reply');
   check(Object.hasOwn(admission.owner.record.unknown,'__proto__')&&admission.owner.record.unknown.policyId.length===1025,'actual unknown SQL fields');
   const stored=await sql('SELECT user_json FROM access_users WHERE email = ?','owner@example.invalid');check(stored[0].user_json===canonicalUser,'canonical bytes unchanged');
  }
  if(mode==='sql-limit'){check(firstTrace.sizes===1&&firstTrace.values===0&&firstTrace.writes===0,'metadata before SQL values/writes');}
  if(mode==='kv-limit'){check(firstTrace.writes===0,'no cold resource import');}
  const poolCommits=[];
  if(mode==='pool-commit'){
   // SQL-seeded secretless projections exercise the REAL selected admission
   // commit after its planning transaction, not the direct selection endpoint.
   const keys=['oauth/'+id+'/anthropic','oauth/tenants/fixture/anthropic'],poolKey='anthropic/'+id+'/fixture';
   await sql('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?',JSON.stringify({...record,grantRouting:{...record.grantRouting,strategy:'round_robin',stickiness:'none'}}),id);
   for(const key of keys)await sql('INSERT OR REPLACE INTO upstream_grant_projections (grant_key,projection_json,legacy) VALUES (?,?,0)',key,JSON.stringify({provider:'anthropic',kind:'api_key',enabled:true,credentialStore:'durable_object',credentialGeneration:1,hasCredential:true}));
   const input={credentialId:id,secretSha256:credential.secretSha256,providers:[{id:'anthropic',tokenRef:'anthropic'}],snapshot:'select',selection:{providerId:'anthropic',endpointId:'messages',mode:'http',model:'claude-sonnet-5',catalogModelId:'anthropic/claude-sonnet-5',capability:'llm.messages'}};
   for(let turn=0;turn<4;turn++){
    const reply=await authorityCall(env,'/admission/resolve',input),key=keys[turn%2],snapshot=reply.snapshots?.anthropic;
    check(reply.selection?.selected?.key===key&&reply.selection.hasConfiguredGrant,'nonempty selected pool');
    check(snapshot?.cursorKey===key&&snapshot.counts[key].count===Math.floor(turn/2)+1,'admitted planned selection state');
    // A separate DO request rereads committed SQLite state after every response.
    const counts=await sql('SELECT grant_key,selected_count FROM upstream_grant_selection WHERE pool_key = ? ORDER BY grant_key',poolKey);
    const cursor=await sql('SELECT grant_key FROM upstream_grant_pool_cursors WHERE pool_key = ?',poolKey);
    check(counts.length===Math.min(turn+1,2)&&counts.reduce((sum,row)=>sum+row.selected_count,0)===turn+1,'ONE counter increment per admission');
    for(const row of counts)check(row.selected_count===(row.grant_key===keys[0]?Math.ceil((turn+1)/2):Math.floor((turn+1)/2)),'canonical repeated counter reread');
    check(cursor.length===1&&cursor[0].grant_key===key,'canonical repeated cursor reread');
    poolCommits.push({key,count:snapshot.counts[key].count,total:turn+1});
   }
  }
  let coloCapability=null,adopted=false,refreshUnchanged=false;
  if(mode==='colo'){
   check(!!cacheKey,'actual colo publication');coloCapability=await probe((await cache.match(cacheKey)).body);
   clearHotCaches();const before=traces.admissions;const second=await send();check(second.status===200&&traces.admissions===before,'actual colo adoption');adopted=true;
   // Read a HEALTHY ORIGINAL entry through the selected reader before constructing
   // the deliberately oversized fixture entry. No diagnostic clone/json of it.
   const healthy=await readIdentityResponse(()=>cache.match(cacheKey));
   await put(cacheKey,new Response(JSON.stringify({...healthy,ignored:'x'.repeat(2097152)}),{headers:{'content-type':'application/json','cache-control':'max-age=60'}}));
   clearHotCaches();const originalCalls=traces.admissions,posts=traces.providerPosts;const denied=await send();
   check(denied.status===503&&denied.body.error.code==='identity_admission_unavailable','actual cache denial');check(traces.admissions===originalCalls&&traces.providerPosts===posts,'no cache authority/provider rescue');
  }
  if(mode==='refresh'){
   const auth=await authenticateProxyKey(new Headers(headers),env,[{id:'anthropic',tokenRef:'anthropic'}]),oldPolicy=auth.policy,oldAdmission=proxyAdmission(auth),oldPrincipal=auth.principalId,oldTiers=auth.serviceTiers;
   await sql('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?',' '.repeat(1048576)+'{}',id);
   const provider=providerById('anthropic'),endpoint=provider.endpoints.find(item=>item.id==='messages');let failed=false;
   try{await admittedGrantSelection(auth,env,{provider,endpoint,mode:'http',model:'claude-sonnet-5'},new Set(['oauth/fixture/rejected']));}catch(error){check(isIdentityFailure(error),'genuine private brand');failed=true;}
   check(failed&&auth.policy===oldPolicy&&proxyAdmission(auth)===oldAdmission&&auth.principalId===oldPrincipal&&auth.serviceTiers===oldTiers,'atomic failed publication');refreshUnchanged=true;
   await sql('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?',JSON.stringify(record),id);
   await admittedGrantSelection(auth,env,{provider,endpoint,mode:'http',model:'claude-sonnet-5'},new Set(['oauth/fixture/rejected']));check(auth.policy!==oldPolicy&&proxyAdmission(auth)!==oldAdmission,'successful replacement');
  }
  closed=true;await drain();
  result={label:'originating-request diagnostic; no retirement/heap claim',mode,status:first.status,kvCapability,requestCapability,coloCapability,traces,sql:firstTrace,adopted,refreshUnchanged,poolCommits,closed};
 }catch(error){hasPrimary=true;primary=error;}
 finally{closed=true;try{await drain();}catch(error){cleanup.push(error);}globalThis.fetch=originalFetch;cache.put=put;}
 if(cleanup.length)throw new AggregateError(hasPrimary?[primary,...cleanup]:cleanup,'primary and independent fixture cleanup');if(hasPrimary)throw primary;
 return Response.json(result);
},queue:worker.queue};`;
const upstream = `export default {async fetch(request){if(new URL(request.url).hostname==='fault.example')return fetch('http://127.0.0.1:PORT'+new URL(request.url).pathname);if(request.url!=='https://api.anthropic.com/v1/messages')throw Error('unexpected fixture egress');await request.text();return Response.json({id:'synthetic-response',type:'message',content:[{type:'text',text:'fixture'}],usage:{input_tokens:1,output_tokens:1}});}};`;

test('identity profile: ORIGINAL KV/DO/Cache bodies then real public SQLite/KV/colo and atomic refresh', { timeout: 180000 }, async t => {
  let runtime, directory, server, tail, gate, primary, hasPrimary = false, releaseFuture = false; const roots = [], serverErrors = [];
  const releaseTail = () => { if (tail) { tail.end(' '.repeat(2097153)); tail = undefined; } };
  const releaseGate = () => { if (gate) { gate.end('released'); gate = undefined; } };
  const releaseAll = () => { releaseFuture = true; releaseTail(); releaseGate(); };
  t.signal.addEventListener('abort', releaseAll, { once: true });
  t.after(async () => {
    releaseAll(); const failures = [];
    for (const result of await Promise.all(roots)) if (result.failed) failures.push(result.error);
    try { await runtime?.dispose(); } catch (error) { failures.push(error); }
    if (server) try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { failures.push(error); }
    t.signal.removeEventListener('abort', releaseAll); failures.push(...serverErrors);
    try { if (directory) await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'primary and independent host cleanup');
  });
  const send = mode => {
    const work = (async () => { const response = await runtime.dispatchFetch('https://router.example/' + mode, { method: 'POST', body: '{}' }); const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text); })();
    roots.push(work.then(() => ({ failed: false }), error => ({ failed: true, error })));
    return work;
  };
  try {
    server = createServer({ maxHeaderSize: 65536 }, (request, response) => {
      response.on('error', error => serverErrors.push(error));
      if (request.url === '/source') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); tail = response; if (releaseFuture) releaseTail(); }
      else if (request.url === '/gate') { gate = response; if (releaseFuture) releaseGate(); }
      else { response.writeHead(404); response.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    directory = await mkdtemp(join(tmpdir(), 'identity-profile-workerd-'));
    runtime = await startWorkerdFixture(directory, router, upstream.replace('PORT', String(server.address().port)), { hotCache: true, preventEviction: true });
    for (const mode of ['healthy', 'cold', 'cold-routing', 'pool-commit', 'sql-limit', 'kv-limit', 'colo', 'refresh']) {
      const result = await send(mode); assert.equal(result.closed, true);
      for (const capability of [result.kvCapability, result.requestCapability, ...(result.coloCapability ? [result.coloCapability] : [])]) {
        assert.equal(capability.byob, true); assert.equal(capability.eof, true); assert.equal(capability.unlocked, true); assert.equal(capability.locked, false); assert.ok(capability.maxBacking <= 16384);
      }
      assert.equal(result.status, mode.endsWith('limit') ? 503 : 200);
      const denied = mode.endsWith('limit');
      if (!denied) {
        assert.ok(result.sql.selectedRequests.length > 0, 'actual marked public request');
        assert.ok(result.traces.reply.length > 0, 'actual marked public reply');
        assert.ok(result.traces.providerPosts > 0, 'actual healthy provider POST');
        for (const row of [...result.sql.selectedRequests, ...result.traces.reply]) {
          assert.equal(row.byob, true); assert.ok(row.reads > 0); assert.equal(row.eof, true);
          assert.equal(row.unlocked, true); assert.equal(row.locked, false); assert.ok(row.maxBacking > 0 && row.maxBacking <= 16384);
        }
      } else {
        assert.equal(result.traces.providerPosts, 0);
        for (const row of result.traces.reply) { assert.equal(row.byob, true); assert.equal(row.unlocked, true); assert.ok(row.maxBacking <= 16384); }
      }
      if (mode === 'cold' || mode === 'cold-routing') {
        // Outer traces.kv records caller reads; cold imports belong to the DO.
        const rows = result.sql.kv.filter(row => row.kind === (mode === 'cold' ? 'credential' : 'policy'));
        assert.ok(rows.length > 0, 'actual owner cold KV stream');
        for (const row of rows) {
          assert.equal(row.byob, true); assert.ok(row.reads > 0); assert.equal(row.eof, true);
          assert.equal(row.unlocked, true); assert.equal(row.locked, false); assert.ok(row.maxBacking > 0 && row.maxBacking <= 16384);
        }
      }
      if (mode === 'colo') assert.equal(result.adopted, true);
      if (mode === 'refresh') assert.equal(result.refreshUnchanged, true);
      if (mode === 'pool-commit') assert.deepEqual(result.poolCommits, [
        { key: 'oauth/identitypoolcommit/anthropic', count: 1, total: 1 },
        { key: 'oauth/tenants/fixture/anthropic', count: 1, total: 2 },
        { key: 'oauth/identitypoolcommit/anthropic', count: 2, total: 3 },
        { key: 'oauth/tenants/fixture/anthropic', count: 2, total: 4 },
      ]);
    }
    const unsupported = await send('probe-reject');
    assert.deepEqual(unsupported.outcomes, [{ failed: true, cancels: 1, unlocked: true }, { failed: true, cancels: 1, unlocked: true }]);
    let settled = false; const fault = send('fault'); const outcome = fault.then(value => { settled = true; return { failed: false, value }; }, error => { settled = true; return { failed: true, error }; });
    const wait = async predicate => {
      for (let attempts = 0; attempts < 500; attempts++) {
        if (settled) { const result = await outcome; if (result.failed) throw result.error; throw Error('premature originating fulfillment'); }
        const probe = send('fault-state');
        const state = await Promise.race([probe, fault.then(() => { throw Error('premature originating fulfillment'); }, error => { throw error; })]);
        if (predicate(state)) return state;
        await delay(10);
      }
      throw Error('missing bounded original-source phase');
    };
    const pending = await wait(state => state?.pending === 1 && state.reads >= 2 && !!tail);
    assert.equal(pending.done, false); assert.equal(pending.cancels, 0); // Native read is pending on held HTTP bytes.
    releaseTail();
    const cancelling = await wait(state => state?.cancelHeld && !!gate);
    assert.equal(cancelling.actualCancel, true); assert.equal(cancelling.cancels, 1); assert.equal(cancelling.unlocks, 0); assert.equal(cancelling.locked, true);
    releaseGate(); const done = await fault;
    assert.equal(done.done, true); assert.equal(done.cancels, 1); assert.equal(done.unlocks, 1); assert.equal(done.locked, false);
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});
