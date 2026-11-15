import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { startWorkerdFixture } from "./helpers/workerd.mjs";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

export const bifrostPin = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
export const bifrostModels = ["tenant/opaque-a", "tenant/opaque-b"];
export const bifrostKey = id => `clawrouter-live-${id}-fixture-secret`;
export const bifrostDiscoveryKey = id => bifrostKey(id+"_discovery");
export const bifrostCases = ["eof", "preabort", "partial", "provider_error"].flatMap(mode => ["stream", "simple"].map(api => ({ id: `bifrost_${api}_${mode}`, mode, api })))
  .concat(["account_a", "account_b", "profile", "empty", "malformed", "loose", "error401", "error403", "redirect", "rotation", "revoked", "missing_owner", "invalid_owner", "unpriced"].map(mode => ({id:`bifrost_${mode}`,mode,api:"simple"})));

export async function finishBifrostOwned(body, cleanups) {
  const failures = []; let result;
  try { result = await body(); } catch (error) { failures.push(error); }
  for (const cleanup of cleanups) try { await cleanup(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Bifrost body and original cleanup failed");
  return result;
}

// These functions are embedded unchanged in the real Worker fixture and tested
// below. Rejection records retain the original reason, including undefined.
export function observeBifrostOperation(s, kind, start, details = {}) {
  const record = {...details, kind, ordinal:s.ops.length, invoke:++s.sequence, state:"pending"};
  s.ops.push(record);
  let pending;
  try { pending = start(); }
  catch (error) { record.state="threw"; record.error=error; record.settle=++s.sequence; s.sync.push(error); throw error; }
  record.pending=pending;
  s.roots.push(pending.then(value => { record.value=value; record.state="fulfilled"; record.settle=++s.sequence; }, error => {
    record.error=error; record.state="rejected"; record.settle=++s.sequence;
    record.abortedAtSettle=record.signal?.aborted===true;
    record.sameSignalReasonAtSettle=record.signal?.aborted===true && error===record.signal.reason;
  }));
  return pending;
}
export async function collectBifrostOperations(s) {
  let at=0;
  while(at<s.roots.length){const batch=s.roots.slice(at);at=s.roots.length;for(const outcome of await Promise.allSettled(batch))if(outcome.status==="rejected")s.observerFailures.push(outcome.reason);}
  return s.ops.filter(r=>r.state!=="fulfilled");
}
export function bifrostDeadlineQualified(f) {
  // This is a post-join data-outcome disposition, not a cause classifier. A
  // concurrent read fault observed after the deadline can satisfy it too.
  const required=["workerOnly","uniqueBinding","deadlineBrand","callerUnaborted","prefix","pendingAtAbort","noEarlierFailure",
    "readReasonDefined","readAbortedAtSettle","observerSameReadReason","cancelSameSignalReason","receiverIdentity",
    "fetchFulfilled","cancelFulfilled","closedFulfilled","bodyUnlocked","otherOperationsFulfilled","sourceRetired","singleGet",
    "handler502","accountingZero"];
  return required.every(key=>f[key]===true) && f.observerFailures===0 && f.syncFailures===0 && f.rejected===2 && f.unlocks===1 &&
    [f.prefixSettled,f.readInvoked,f.abortObserved,f.readSettled,f.cancelInvoked,f.cancelSettled,f.closedSettled,f.unlockObserved].every(v=>Number.isSafeInteger(v)&&v>0) &&
    f.prefixSettled<f.readInvoked && f.readInvoked<f.abortObserved && f.abortObserved<f.readSettled && f.abortObserved<f.cancelInvoked &&
    Math.max(f.readSettled,f.cancelInvoked,f.cancelSettled,f.closedSettled)<f.unlockObserved;
}
export function bifrostDeadlineWitness(s, InternalAbort, usage, charged) {
  const rejected=s.ops.filter(o=>o.state==="rejected"), reads=rejected.filter(o=>o.kind==="read"),
    read=reads.length===1?reads[0]:undefined, r=read?.reader, t=r?.transport;
  const observers=rejected.filter(o=>o.kind==="read_observer"&&o.originalRead===read?.pending&&o.reader===r);
  const observer=observers.length===1?observers[0]:undefined;
  const cancels=s.ops.filter(o=>o.kind==="cancel"&&o.reader===r), cancel=cancels.length===1?cancels[0]:undefined;
  const closed=s.ops.find(o=>o.kind==="closed"&&o.reader===r);
  const prefix=s.ops.find(o=>o.kind==="read"&&o.reader===r&&o.state==="fulfilled"&&o.value?.done===false&&o.value.value?.byteLength>0);
  const reason=t?.signal?.reason, cause=reason && typeof reason==="object"?Object.getOwnPropertyDescriptor(reason,"cause"):undefined;
  const source=s.source, event=usage?.events?.length===1?usage.events[0]:undefined;
  return {
    workerOnly:s.workerDeadline===true && s.mode==="deadline",
    uniqueBinding:!!r && s.readers.length===1 && s.readers[0]===r && s.transports.length===1 && s.requests.length===1 && t===s.transports[0] && t.request===s.requests[0] && t.signal!==t.request.signal,
    deadlineBrand:reason instanceof InternalAbort && cause?.value==="deadline",
    callerUnaborted:!!t && !t.request.signal.aborted && t.callerAbortedAtAbort===false,
    prefix:!!prefix && r.eof===false,
    pendingAtAbort:!!read && read.signalAborted===false && t?.pendingAtAbort?.length===1 && t.pendingAtAbort[0]===read,
    noEarlierFailure:t?.noEarlierFailure===true,
    readReasonDefined:!!read && read.error!==undefined,
    readAbortedAtSettle:!!read && read.abortedAtSettle===true,
    readSameSignalReason:!!read && read.sameSignalReasonAtSettle===true && read.error===reason,
    observerSameReadReason:!!observer && !!read && observer.error===read.error,
    cancelSameSignalReason:!!cancel && cancel.operandPresent===true && cancel.reason===reason && cancel.signalAborted===true,
    receiverIdentity:!!r && r.unlockReceiver===true && s.ops.filter(o=>o.reader===r).every(o=>o.receiverIdentity===true),
    fetchFulfilled:!!t && s.ops.some(o=>o.kind==="fetch"&&o.transport===t&&o.state==="fulfilled"),
    cancelFulfilled:cancel?.state==="fulfilled",closedFulfilled:closed?.state==="fulfilled",bodyUnlocked:r?.body?.locked===false,
    otherOperationsFulfilled:!!read&&!!observer&&s.ops.every(o=>o===read||o===observer||o.state==="fulfilled"),
    sourceRetired:!!source&&source.held===0&&source.canceled===1&&source.settled===1&&source.expired===0,
    singleGet:s.calls.length===1&&s.calls[0].method==="GET"&&s.calls[0].bodyAbsent===true&&s.calls[0].noCaller===true&&s.calls[0].original===true&&s.calls[0].redirect==="manual"&&s.calls[0].url==="https://gateway.fixture/openai/v1/models"&&source?.calls?.length===1&&source.calls[0].method==="GET"&&source.calls[0].query===false&&source.calls[0].chat===false,
    handler502:s.ops.filter(o=>o.kind==="handler").length===1&&s.ops.find(o=>o.kind==="handler")?.value?.status===502,
    accountingZero:charged===0&&!!event&&event.provider==="bifrost"&&event.policy_id===s.id&&event.credential_id===s.id&&event.capability==="models.list"&&event.model===null&&event.actual_cost_micros===0&&event.reserved_cost_micros===0&&event.input_tokens===null&&event.output_tokens===null&&event.total_tokens===null&&event.status_code===502&&event.status==="timeout",
    observerFailures:s.observerFailures.length,syncFailures:s.sync.length,rejected:rejected.length,unlocks:r?.unlocks??0,
    prefixSettled:prefix?.settle??null,readInvoked:read?.invoke??null,abortObserved:t?.abortSequence??null,
    readSettled:read?.settle??null,cancelInvoked:cancel?.invoke??null,cancelSettled:cancel?.settle??null,closedSettled:closed?.settle??null,unlockObserved:r?.unlockSequence??null,
    readOrdinal:read?.ordinal??null,observerOrdinal:observer?.ordinal??null
  };
}

const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {ingestUsage,usageSnapshot} from './worker/ledgers.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {sha256Hex} from './worker/utils.ts';
import {InternalHttpAbort} from './worker/http-operation.ts';
${observeBifrostOperation.toString()}
${collectBifrostOperations.toString()}
${bifrostDeadlineQualified.toString()}
${bifrostDeadlineWitness.toString()}
import {resolveGrantCandidates,grantRoutingPolicy} from './worker/grant-selection.ts';
const nativeFetch=globalThis.fetch,states=new Map(),base='https://gateway.fixture/openai/v1';
function invoke(s,kind,run,details){return observeBifrostOperation(s,kind,run,details);}
function observe(s,p,kind,details){return invoke(s,kind,()=>p,details);}
async function drain(s){return collectBifrostOperations(s);}
function publicOperations(s){return s.ops.map(o=>({kind:o.kind,ordinal:o.ordinal,state:o.state,invoke:o.invoke,settle:o.settle??null}));}
async function control(s,path){const r=await observe(s,Reflect.apply(nativeFetch,globalThis,['https://bifrost-control.fixture/'+path+'/'+s.id,{method:'POST',body:JSON.stringify({mode:s.mode,models:s.ids})}]),'control_fetch');return observe(s,r.json(),'control_body');}
async function mutate(s,kind){
 if(kind==='arm_revoke'||kind==='arm_destination'){s.armed=kind.slice(4);return;}
 if(kind==='revoke'||kind==='warm_revoke')await revokeGrantCredentials(s.env,s.grantKey);
 else if(kind==='rotation')await putGrantCredentials(s.env,s.grantKey,{provider:'bifrost',kind:'api_key',enabled:true,credential:'synthetic-rotated-'+s.id});
 else if(kind==='caller_revoke')await authorityCall(s.env,'/credentials/mutate',{credentialId:s.id,scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'},operation:'revoke'}).then(()=>authorityCall(s.env,'/credentials/mutate',{credentialId:s.id+'_discovery',scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'},operation:'revoke'}));
 else if(kind==='destination'||kind==='warm_destination')s.env.BIFROST_BASE_URL='https://foreign.fixture/openai/v1';
 else {const next={...s.policy,models:kind==='broaden'?null:kind==='subset'?['bifrost/'+s.ids[0]]:[]};await authorityCall(s.env,'/policies/put',{policyId:s.id,policy:next});}
 s.mutated=true;
}
globalThis.fetch=function(input,init){
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url,headers=new Headers(init?.headers??input.headers),secret=headers.get('authorization');
 const matches=[...states.values()].filter(s=>secret==='Bearer synthetic-owner-'+s.id||secret==='Bearer synthetic-rotated-'+s.id);
 if(matches.length!==1)throw Error('missing unique original Bifrost owner');
 const s=matches[0],method=init?.method??input.method??'GET';
 s.calls.push({url,method,original:secret==='Bearer synthetic-owner-'+s.id,rotated:secret==='Bearer synthetic-rotated-'+s.id,
  noCaller:!headers.has('x-api-key')&&!headers.has('x-upstream-url'),bodyAbsent:(init?.body??input.body??null)===null,redirect:init?.redirect??input.redirect});
 const signal=init?.signal!==undefined?init.signal:input instanceof Request?input.signal:null;
 const t={signal,request:s.requests.at(-1)};s.transports.push(t);
 if(signal){const aborted=()=>{t.abortSequence=++s.sequence;t.callerAbortedAtAbort=t.request?.signal.aborted;
  t.pendingAtAbort=s.ops.filter(o=>o.kind==='read'&&o.reader.transport===t&&o.state==='pending');
  t.noEarlierFailure=s.sync.length===0&&s.ops.every(o=>o.state!=='rejected'&&o.state!=='threw');};
  if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});}
 const p=invoke(s,'fetch',()=>Reflect.apply(nativeFetch,this,arguments),{transport:t});
 observe(s,p.then(response=>{
  if(!response.body)return;const body=response.body,getReader=body.getReader,cancel=body.cancel;
  body.cancel=function(){return invoke(s,'body_cancel',()=>Reflect.apply(cancel,this,arguments));};
  body.getReader=function(){let reader;try{reader=Reflect.apply(getReader,this,arguments);}catch(e){s.sync.push(e);throw e;}
   const r={body,reader,transport:t,unlocks:0,eof:false};s.readers.push(r);
   observe(s,reader.closed,'closed',{reader:r,receiverIdentity:this===body});
   for(const kind of ['read','cancel']){const original=reader[kind];reader[kind]=function(){
    const pending=invoke(s,kind,()=>Reflect.apply(original,this,arguments),{reader:r,signal,receiverIdentity:this===reader,operandPresent:arguments.length>0,reason:arguments[0],signalAborted:signal?.aborted===true});
    if(kind==='read')observe(s,pending.then(async chunk=>{if(chunk.done){r.eof=true;return;}if(!chunk.value.byteLength||s.prefix||!s.mode.startsWith('held_'))return;
     s.prefix=true;await mutate(s,s.mode.slice(5));await control(s,'complete');}),'read_observer',{reader:r,originalRead:pending,receiverIdentity:this===reader});return pending;};}
   const unlock=reader.releaseLock;reader.releaseLock=function(){try{const v=Reflect.apply(unlock,this,arguments);r.unlockReceiver=this===reader;r.unlocks++;r.unlockSequence=++s.sequence;return v;}catch(e){s.sync.push(e);throw e;}};return reader;};
 }),'fetch_observer');return p;
};
export default {async fetch(request,bindings,originalContext){
 const url=new URL(request.url);
 if(url.pathname==='/__bifrost/setup'){
  const input=await request.json();if(states.has(input.id))throw Error('duplicate fixture owner');
  const s={...input,roots:[],ops:[],sync:[],observerFailures:[],readers:[],calls:[],requests:[],transports:[],sequence:0,prefix:false,mutated:false,retirement:undefined};
  s.ids=input.mode==='account_b'?['tenant/opaque-b']:['tenant/opaque-a','tenant/opaque-b'];
  // Discovery filters the router-qualified ID; native passthrough authorizes
  // the original opaque ID. Grant both explicitly, never mutate the SDK model.
  s.policy={enabled:true,generation:'g1',providers:['bifrost'],models:input.mode==='account_b'?['bifrost/tenant/opaque-b','tenant/opaque-b']:['bifrost/tenant/opaque-a','tenant/opaque-a'],tenantId:'fixture',
   monthlyBudgetMicros:10000,...(input.mode==='unpriced'?{}:{requestCostMicros:7}),retainRequestContent:false,
   grantRouting:{eligibleGrants:{bifrost:['bifrost']},environmentFallback:true,failover:true}};
  s.grantKey='oauth/'+input.id+'/bifrost';
  s.env={...bindings,BIFROST_BASE_URL:input.base??base,BIFROST_MODEL:'tenant/opaque-a',BIFROST_API_KEY:'synthetic-poison-env',OPENAI_API_KEY:'synthetic-other-provider',
   USAGE_QUEUE:{send:event=>ingestUsage(bindings,event)}};
  await authorityCall(s.env,'/policies/initialize-all',[]);await authorityCall(s.env,'/credentials/initialize-all',[]);
  await authorityCall(s.env,'/policies/put',{policyId:s.id,policy:s.policy});
  const created=await authorityCall(s.env,'/credentials/mutate',{credentialId:s.id,scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'},operation:'put',
   credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:s.id,policyGeneration:'g1'}});
  if(created.outcome!=='updated')throw Error('credential setup refused');
  const discovery=await authorityCall(s.env,'/credentials/mutate',{credentialId:s.id+'_discovery',scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'},operation:'put',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:s.id,policyGeneration:'g1'}});
  if(discovery.outcome!=='updated')throw Error('discovery credential setup refused');
  await authorityCall(s.env,'/connections/initialize-all',[{providerId:'bifrost',enabled:true,monthlyBudgetMicros:10000}]);
  if(input.mode!=='missing_owner')await putGrantCredentials(s.env,s.grantKey,{provider:'bifrost',kind:'api_key',enabled:input.mode!=='invalid_owner',credential:'synthetic-owner-'+s.id});
  if(!['missing_owner','invalid_owner'].includes(input.mode)){const candidates=await resolveGrantCandidates('bifrost',s.id,'fixture','bifrost',s.env,new Set(),grantRoutingPolicy(s.policy.grantRouting));if(candidates.available.length!==1||candidates.available[0].key!==s.grantKey)throw Error('fixture selected owner not available: '+JSON.stringify({available:candidates.available.length,configured:candidates.hasConfiguredGrant}));}
  // Fault injection only for the two pre-dispatch race tests. The real SQLite
  // credential owner still serves the unchanged original inspection request.
  if(input.mode.startsWith('warm_')){const ns=s.env.GRANT_CREDENTIALS;s.env.GRANT_CREDENTIALS={idFromName:ns.idFromName.bind(ns),get(id){const original=ns.get(id);return {async fetch(input,init){if(new URL(typeof input==='string'?input:input.url).pathname==='/inspect'&&s.armed){const action=s.armed;s.armed=null;s.inspected=true;await mutate(s,action);}return original.fetch(input,init);}};}};}
  states.set(s.id,s);await control(s,'setup');return Response.json({ready:true});
 }
 const parts=url.pathname.split('/'); const match=parts.length===4&&parts[1]==='__bifrost'&&['state','join','mutate'].includes(parts[2])&&/^[a-zA-Z0-9_]+$/.test(parts[3])?[null,parts[2],parts[3]]:null;
 if(match){const s=states.get(match[2]);if(!s)return Response.json({absent:true});
  if(match[1]==='mutate'){await mutate(s,(await request.json()).kind);return Response.json({mutated:true});}
  if(match[1]==='join'){
   if(!s.retirement)s.retirement=(async()=>{
    const failures=[];try{await drain(s);}catch(e){failures.push(e);}
    try{s.source=await control(s,'proof');}catch(e){failures.push(e);}
    let usage;try{usage=await invoke(s,'usage',()=>usageSnapshot(bindings,'fixture',s.id,{kind:'admin'}));}catch(e){failures.push(e);}
    try{await drain(s);}catch(e){failures.push(e);}
    const charged=bodyBudgetCharged(),deadline=bifrostDeadlineWitness(s,InternalHttpAbort,usage,charged);
    const candidate=bifrostDeadlineQualified(deadline);
    for(const o of s.ops)if(o.state!=='fulfilled'&&!(candidate&&(o.ordinal===deadline.readOrdinal||o.ordinal===deadline.observerOrdinal)))failures.push(o.error);
    failures.push(...s.sync,...s.observerFailures);
    const proof={calls:s.calls,operations:publicOperations(s),readers:s.readers.map(r=>({unlocks:r.unlocks,eof:r.eof,locked:r.body.locked})),source:s.source??null,events:usage?.events??[],charged,prefix:s.prefix,mutated:s.mutated,inspected:!!s.inspected,deadline,
      disposition:candidate?'provisional_worker_deadline_read':'strict',retired:failures.length===0,syncFailures:s.sync.length};
    s.retirementFailures=failures;return proof;
   })();
   const proof=await s.retirement;return Response.json(proof,{status:proof.retired?200:500});
  }return Response.json({calls:s.calls.length,prefix:s.prefix,mutated:s.mutated,inspected:!!s.inspected});
 }
 const authorization=request.headers.get('authorization')??'',s=[...states.values()].find(s=>(authorization.startsWith('Bearer clawrouter-live-'+s.id+'-')||authorization.startsWith('Bearer clawrouter-live-'+s.id+'_discovery-')));
 if(!s)throw Error('unbound original Bifrost request');
 if(s.retirement)throw Error('request after original retirement');
 s.requests.push(request);
 const context={waitUntil:p=>{observe(s,p,'waitUntil');originalContext.waitUntil(p);}};
 return observe(s,worker.fetch(request,s.env,context),'handler');
},queue:worker.queue};`;

const upstream = `
const states=new Map();
export default {async fetch(request){const url=new URL(request.url);
 if(url.hostname==='bifrost-control.fixture'){
  const [,kind,id]=url.pathname.split('/');
  if(kind==='setup'){const cfg=await request.json();states.set(id,{...cfg,id,calls:[],held:0,expired:0,canceled:0,settled:0});return Response.json({ready:true});}
  const s=states.get(id);if(!s)throw Error('missing upstream owner');
  if(kind==='complete'){if(!s.complete)throw Error('missing producer');s.complete();return Response.json({accepted:true});}
  if(kind==='proof'){if(s.producer){await s.producer;s.settled=1;}return Response.json({calls:s.calls,held:s.held,canceled:s.canceled,expired:s.expired,settled:s.settled});}
 }
 const secret=request.headers.get('authorization')??'',s=[...states.values()].find(s=>secret==='Bearer synthetic-owner-'+s.id||secret==='Bearer synthetic-rotated-'+s.id);
 if(!s)throw Error('foreign upstream credential');
 if(url.origin!=='https://gateway.fixture'||url.search||!['/openai/v1/models','/custom/openai/models','/openai/v1/chat/completions'].includes(url.pathname))throw Error('foreign upstream destination');
 const chat=url.pathname.endsWith('/chat/completions'),body=chat?await request.json():null;
 s.calls.push({method:request.method,path:url.pathname,query:!!url.search,chat,model:body?.model??null,stream:body?.stream??null});
 if(s.mode==='redirect')return new Response(null,{status:302,headers:{location:'https://foreign.fixture/models'}});
 if(s.mode==='error401'||s.mode==='error403')return Response.json({error:{message:'sanitized fixture rejection'}},{status:Number(s.mode.slice(5))});
 if(!chat){
  const data=(s.mode==='empty'?[]:s.models).map(id=>({id,object:'model'}));
  const value=s.mode==='malformed'?{object:'list',data:[{}]}:s.mode==='loose'?{data}:s.mode==='wrong_object'?{object:'wrong',data}:{object:'list',data};
  if(!s.mode.startsWith('held_')&&s.mode!=='deadline')return Response.json(value);
  const bytes=JSON.stringify(value),prefix='{"object":"list","data":[';
  return new Response(new ReadableStream({start(c){s.held=1;c.enqueue(new TextEncoder().encode(prefix));},pull(c){
   if(s.producer)return s.producer;s.producer=new Promise((resolve,reject)=>{s.resolve=resolve;const timer=setTimeout(()=>{s.expired++;s.held=0;c.error(Error('producer expired'));reject(Error('producer expired'));},s.mode==='deadline'?35000:5000);s.timer=timer;
    s.complete=()=>{clearTimeout(timer);c.enqueue(new TextEncoder().encode(bytes.slice(prefix.length)));c.close();s.held=0;resolve();};});return s.producer;
  },cancel(){s.canceled++;clearTimeout(s.timer);s.held=0;s.resolve?.();}}),{headers:{'content-type':'application/json'}});
 }
 const frame=v=>'data: '+JSON.stringify(v)+'\\n\\n',chunk=delta=>({id:'chat_fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]}),prefix=frame(chunk({role:'assistant',content:'synthetic-prefix'}));
 if(s.mode==='provider_error')return new Response(prefix+frame({error:{message:'synthetic-provider-error',type:'server_error'}}),{headers:{'content-type':'text/event-stream'}});
 if(s.mode!=='partial')return new Response(prefix+frame({id:'chat_fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}})+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
 return new Response(new ReadableStream({start(c){s.held=1;c.enqueue(new TextEncoder().encode(prefix));},pull(c){if(s.producer)return s.producer;
  s.producer=new Promise((resolve,reject)=>{s.resolve=resolve;s.timer=setTimeout(()=>{s.expired++;s.held=0;c.error(Error('producer expired'));reject(Error('producer expired'));},10000);});return s.producer;
 },cancel(){s.canceled++;clearTimeout(s.timer);s.held=0;s.resolve?.();}}),{headers:{'content-type':'text/event-stream'}});
}};`;

export async function startBifrostFixture({hotCache=false}={}) {
  const directory = await mkdtemp(join(tmpdir(), "bifrost-contract-")); let runtime;
  try { runtime = await startWorkerdFixture(directory, router, upstream, {hotCache,bindings:{BIFROST_BASE_URL:'https://gateway.fixture/openai/v1',BIFROST_MODEL:'tenant/opaque-a',BIFROST_API_KEY:'synthetic-poison-env'}}); }
  catch (error) { await finishBifrostOwned(() => { throw error; }, [() => rm(directory,{recursive:true,force:true})]); }
  const origin = (await runtime.ready).origin;
  const json = async (path, body) => {
    const response = await fetch(origin+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body??{})});
    const text = await response.text(); let value;try{value=JSON.parse(text);}catch{throw Error('fixture control returned non-JSON');}assert.equal(response.status,200,JSON.stringify(value)); return value;
  };
  return { origin, runtime, setup:row=>json('/__bifrost/setup',row), mutate:(id,kind)=>json('/__bifrost/mutate/'+id,{kind}),
    join:id=>json('/__bifrost/join/'+id), state:id=>json('/__bifrost/state/'+id),
    close:()=>finishBifrostOwned(()=>{},[()=>runtime.dispose(),()=>rm(directory,{recursive:true,force:true})]) };
}

export function assertBifrostRetired(proof, {workerDeadline=false, application}={}) {
  assert.equal(proof.retired,true);
  if(workerDeadline){
    assert.equal(bifrostDeadlineQualified(proof.deadline),true,JSON.stringify(proof.deadline));
    assert.equal(proof.disposition,"provisional_worker_deadline_read");
    assert.equal(application?.status,502);
    assert.deepEqual(application.body,{error:{code:"provider_unavailable",message:"upstream request to provider bifrost failed"}});
    assert.deepEqual(proof.operations.filter(r=>r.state!=="fulfilled").map(r=>[r.ordinal,r.kind,r.state]),[
      [proof.deadline.readOrdinal,"read","rejected"],[proof.deadline.observerOrdinal,"read_observer","rejected"]]);
  }else assert.ok(proof.operations.every(r=>r.state==='fulfilled'));
  assert.ok(proof.readers.every(r=>r.unlocks===1&&!r.locked));
  assert.equal(proof.charged,0);assert.equal(proof.source.held,0);assert.equal(proof.source.expired,0);
  for(const call of proof.calls){assert.equal(call.noCaller,true);assert.equal(call.redirect,'manual');assert.ok(call.original||call.rotated);}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  test("Bifrost shipping compilation, native aliases and frozen consumer row", () => {
    const manifests=readdirSync('providers').filter(f=>f.endsWith('.provider.yaml')).sort().map(f=>parse(readFileSync('providers/'+f,'utf8')));
    assert.ok(manifests.length>0);assert.equal(new Set(manifests.map(p=>p.id)).size,manifests.length);
    assert.deepEqual(manifests.map(p=>p.id).sort(),snapshot.providers.map(p=>p.id).sort());assert.deepEqual(compileProviderSnapshot(manifests),snapshot);
    const p=snapshot.providers.find(p=>p.id==='bifrost');
    for(const [id,path] of [['models_list_v1','/models'],['chat_completions_v1','/chat/completions']])assert.equal(p.endpoints.find(e=>e.id===id).upstreamPath,path);
    const rows=parse(readFileSync('.github/workflows/openclaw-contract.yml','utf8')).jobs.consumer.strategy.matrix.include;
    assert.equal(new Set(rows.map(r=>r.consumer)).size,rows.length);
    assert.deepEqual(rows.filter(r=>r.consumer==='bifrost'),[{consumer:'bifrost',ref:bifrostPin,test:'test/openclaw-bifrost.test.mjs'}]);
  });
  test("Bifrost deadline observer preserves original returns, receivers, undefined and dynamic joins",async()=>{
    const s={ops:[],roots:[],sync:[],observerFailures:[],sequence:0}, receiver={};let calls=0,settle;
    const original=new Promise(resolve=>{settle=resolve;});
    function method(value){assert.equal(this,receiver);assert.equal(value,7);calls++;return original;}
    assert.equal(observeBifrostOperation(s,"read",()=>Reflect.apply(method,receiver,[7])),original);
    assert.equal(calls,1);assert.equal(s.ops[0].state,"pending");settle({done:false,value:new Uint8Array([1])});
    const rejected=Promise.reject(undefined);assert.equal(observeBifrostOperation(s,"cancel",()=>rejected),rejected);
    let caught=false;try{observeBifrostOperation(s,"closed",()=>{throw undefined;});}catch(e){caught=true;assert.equal(e,undefined);}
    assert.equal(caught,true);
    s.roots.push(Promise.resolve().then(()=>observeBifrostOperation(s,"control",()=>Promise.resolve())));
    const observerError={};s.roots.push(Promise.reject(observerError));
    const failed=await collectBifrostOperations(s);
    assert.deepEqual(failed.map(o=>o.kind),["cancel","closed"]);assert.equal(failed[0].error,undefined);assert.equal(failed[1].error,undefined);
    assert.equal(s.ops.at(-1).state,"fulfilled");assert.deepEqual(s.observerFailures,[observerError]);assert.deepEqual(s.sync,[undefined]);
  });
  test("Bifrost deadline observer keeps signal-at-settlement separate from reason identity",async()=>{
    const s={ops:[],roots:[],sync:[],observerFailures:[],sequence:0},signalOwner=new AbortController(),reason={},dataReason={};
    signalOwner.abort(reason);
    const original=Promise.reject(dataReason);
    assert.equal(observeBifrostOperation(s,"read",()=>original,{signal:signalOwner.signal}),original);
    await collectBifrostOperations(s);
    assert.equal(s.ops[0].error,dataReason);assert.equal(s.ops[0].abortedAtSettle,true);assert.equal(s.ops[0].sameSignalReasonAtSettle,false);
    const later=new AbortController();
    observeBifrostOperation(s,"read",()=>Promise.reject(reason),{signal:later.signal});await collectBifrostOperations(s);later.abort(reason);
    assert.equal(s.ops[1].abortedAtSettle,false);assert.equal(s.ops[1].sameSignalReasonAtSettle,false);
  });
  // Synthetic counterfactual records test the actual Worker adjudicator; they
  // are not evidence of a native deadline or physical retirement.
  function deadlineRecords(){
    class InternalAbort extends Error {cause="deadline";}
    const controller=new AbortController(),caller=new AbortController(),reason=new InternalAbort();controller.abort(reason);
    const request={signal:caller.signal},transport={signal:controller.signal,request,callerAbortedAtAbort:false,abortSequence:8,noEarlierFailure:true};
    const reader={body:{locked:false},transport,unlocks:1,eof:false,unlockSequence:14,unlockReceiver:true};
    const read={kind:"read",ordinal:3,reader,signal:controller.signal,receiverIdentity:true,signalAborted:false,state:"rejected",invoke:6,settle:10,error:reason,pending:Promise.resolve(),abortedAtSettle:true,sameSignalReasonAtSettle:true};
    const observer={kind:"read_observer",ordinal:4,reader,originalRead:read.pending,receiverIdentity:true,state:"rejected",error:reason,invoke:7,settle:11};
    const ops=[{kind:"fetch",ordinal:0,transport,state:"fulfilled"},
      {kind:"closed",ordinal:1,reader,receiverIdentity:true,state:"fulfilled",settle:12},
      {kind:"read",ordinal:2,reader,receiverIdentity:true,state:"fulfilled",settle:5,value:{done:false,value:new Uint8Array([1])}},read,observer,
      {kind:"cancel",ordinal:5,reader,receiverIdentity:true,operandPresent:true,reason,signalAborted:true,state:"fulfilled",invoke:9,settle:13},
      {kind:"handler",ordinal:6,state:"fulfilled",value:{status:502}}, {kind:"waitUntil",ordinal:7,state:"fulfilled"}];
    transport.pendingAtAbort=[read];
    const s={id:"fixture",workerDeadline:true,mode:"deadline",ops,sync:[],observerFailures:[],readers:[reader],transports:[transport],requests:[request],
      calls:[{method:"GET",url:"https://gateway.fixture/openai/v1/models",bodyAbsent:true,noCaller:true,original:true,redirect:"manual"}],
      source:{held:0,canceled:1,settled:1,expired:0,calls:[{method:"GET",query:false,chat:false}]}};
    const usage={events:[{provider:"bifrost",policy_id:"fixture",credential_id:"fixture",capability:"models.list",model:null,actual_cost_micros:0,reserved_cost_micros:0,input_tokens:null,output_tokens:null,total_tokens:null,status_code:502,status:"timeout"}]};
    return {s,InternalAbort,usage,charged:0,reader,transport,read,observer,caller,reason};
  }
  const counterfactuals={
    "SDK default strict":c=>{c.s.workerDeadline=false;},"nondeadline strict":c=>{c.s.mode="eof";},
    "undefined read":c=>{c.read.error=c.observer.error=undefined;},"unpaired read":c=>{c.read.error={};},"independent observer":c=>{c.observer.error={};},
    "caller abort":c=>{c.caller.abort();},"provider error":c=>{c.reason.cause="upstream";},"lookalike brand":c=>{Object.setPrototypeOf(c.reason,Error.prototype);},
    "no abort":c=>{c.transport.signal=new AbortController().signal;},"late abort":c=>{c.transport.abortSequence=15;},
    "not aborted at read rejection":c=>{c.read.abortedAtSettle=false;},"read rejection before observed deadline":c=>{c.read.settle=7;},
    "no pending read":c=>{c.transport.pendingAtAbort=[];},"already aborted at read":c=>{c.read.signalAborted=true;},"earlier failure":c=>{c.transport.noEarlierFailure=false;},
    "prefix missing":c=>{c.s.ops[2].value.value=new Uint8Array();},"prefix EOF":c=>{c.s.ops[2].value.done=true;},
    "wrong request":c=>{c.transport.request={signal:new AbortController().signal};},"ambiguous request":c=>{c.s.requests.push({});},
    "wrong receiver":c=>{c.read.receiverIdentity=false;},"wrong reader":c=>{c.read.reader={};},
    "cancel rejection undefined":c=>{c.s.ops[5].state="rejected";c.s.ops[5].error=undefined;},"cancel wrong reason":c=>{c.s.ops[5].reason={};},
    "cancel absent":c=>{c.s.ops.splice(5,1);},"cancel before abort":c=>{c.s.ops[5].invoke=7;},"closed rejection":c=>{c.s.ops[1].state="rejected";},
    "early unlock":c=>{c.reader.unlockSequence=10;},"duplicate unlock":c=>{c.reader.unlocks=2;},"locked body":c=>{c.reader.body.locked=true;},
    "waitUntil pending":c=>{c.s.ops[7].state="pending";},"control failure":c=>{c.s.ops.push({kind:"control_body",state:"rejected",error:undefined});},
    "synchronous undefined":c=>{c.s.sync.push(undefined);},"observer failure":c=>{c.s.observerFailures.push(undefined);},
    "producer unjoined":c=>{c.s.source.settled=0;},"source expiry":c=>{c.s.source.expired=1;},"source uncanceled":c=>{c.s.source.canceled=0;},
    "replay":c=>{c.s.source.calls.push(c.s.source.calls[0]);},"POST":c=>{c.s.calls[0].method="POST";},
    "capacity charge":c=>{c.charged=1;},"wrong accounting":c=>{c.usage.events[0].actual_cost_micros=7;},"wrong handler":c=>{c.s.ops[6].value.status=200;},
    "reserved cost":c=>{c.usage.events[0].reserved_cost_micros=7;},"wrong provider":c=>{c.usage.events[0].provider="other";},
    "wrong credential":c=>{c.usage.events[0].credential_id="other";},"wrong policy":c=>{c.usage.events[0].policy_id="other";},
    "wrong capability":c=>{c.usage.events[0].capability="llm.chat";},"model accounting":c=>{c.usage.events[0].model="other";},
    "missing accounting":c=>{c.usage.events=[];},"duplicate accounting":c=>{c.usage.events.push({...c.usage.events[0]});},
    "non-timeout accounting":c=>{c.usage.events[0].status="provider_error";},"wrong accounting status":c=>{c.usage.events[0].status_code=200;},
    ...Object.fromEntries(["input_tokens","output_tokens","total_tokens"].flatMap(field=>[
      [field+" counted",c=>{c.usage.events[0][field]=0;}],
      [field+" missing",c=>{delete c.usage.events[0][field];}]
    ]))
  };
  test("Bifrost deadline adjudication retains both original rejected outcomes",()=>{
    const c=deadlineRecords(),f=bifrostDeadlineWitness(c.s,c.InternalAbort,c.usage,c.charged);
    assert.equal(bifrostDeadlineQualified(f),true);assert.equal(c.read.error,c.reason);assert.equal(c.observer.error,c.reason);
    assert.equal(c.read.state,"rejected");assert.equal(c.observer.state,"rejected");
    const proof={retired:true,deadline:f,disposition:"provisional_worker_deadline_read",operations:c.s.ops.map(o=>({kind:o.kind,state:o.state,ordinal:o.ordinal})),readers:[{unlocks:1,locked:false}],charged:0,source:c.s.source,calls:c.s.calls};
    const application={status:502,body:{error:{code:"provider_unavailable",message:"upstream request to provider bifrost failed"}}};
    assertBifrostRetired(proof,{workerDeadline:true,application});assert.throws(()=>assertBifrostRetired(proof));
    assert.throws(()=>assertBifrostRetired(proof,{workerDeadline:true,application:{status:502,body:{data:[]}}}));
    assert.throws(()=>assertBifrostRetired(proof,{workerDeadline:true}));
  });
  test("Bifrost deadline adjudication accepts a distinct paired data reason after observed abort",()=>{
    const c=deadlineRecords(),dataReason={};
    c.read.error=c.observer.error=dataReason;c.read.sameSignalReasonAtSettle=false;
    const f=bifrostDeadlineWitness(c.s,c.InternalAbort,c.usage,c.charged);
    assert.equal(bifrostDeadlineQualified(f),true);assert.equal(f.readSameSignalReason,false);assert.equal(f.readAbortedAtSettle,true);
    assert.notEqual(c.read.error,c.reason);assert.equal(c.observer.error,c.read.error);assert.equal(c.s.ops[5].reason,c.reason);
    assert.equal(c.read.state,"rejected");assert.equal(c.observer.state,"rejected");
  });
  for(const [name,mutate] of Object.entries(counterfactuals))test("Bifrost deadline counterfactual rejects "+name,()=>{
    const c=deadlineRecords();mutate(c);assert.equal(bifrostDeadlineQualified(bifrostDeadlineWitness(c.s,c.InternalAbort,c.usage,c.charged)),false);
  });
  test("Bifrost cleanup always attempts every original operation and retains undefined", async()=>{
    const secondary={},order=[];await assert.rejects(finishBifrostOwned(()=>{throw undefined;},[()=>{order.push(1);throw secondary;},()=>{order.push(2);}]),e=>e instanceof AggregateError&&e.errors.length===2&&e.errors[0]===undefined&&e.errors[1]===secondary);assert.deepEqual(order,[1,2]);
  });
  test("registered Bifrost catalog and public inference through Worker SQLite", {skip:!process.env.CLAWROUTER_OPENCLAW_CHECKOUT,timeout:300000},async t=>{
    const f=await startBifrostFixture(), created=[];
    await finishBifrostOwned(async()=>{
      for(const row of bifrostCases){await f.setup(row);created.push(row);}
      await runOpenClawConsumer(t,{source:process.env.CLAWROUTER_OPENCLAW_CHECKOUT,sourceHead:bifrostPin,fixture:fileURLToPath(new URL('./fixtures/openclaw-bifrost-contract.test.ts',import.meta.url)),testPath:'extensions/bifrost/clawrouter-contract.test.ts',
        env:{CLAWROUTER_CONTRACT_ORIGIN:f.origin,CLAWROUTER_CONTRACT_SOURCE_HEAD:bifrostPin,CLAWROUTER_BIFROST_CASES:JSON.stringify(bifrostCases)}});
    },[...bifrostCases.map(row=>async()=>{
      if(!created.includes(row))return;
      const proof=await f.join(row.id);assertBifrostRetired(proof);
      assert.equal(proof.source.calls.filter(c=>c.chat).length,['eof','provider_error','partial','account_a','account_b','profile','rotation'].includes(row.mode)?1:0);
      assert.equal(proof.source.calls.filter(c=>!c.chat).length,['missing_owner','invalid_owner'].includes(row.mode)?0:1);
      if(row.mode==='partial'){assert.equal(proof.source.canceled,1);assert.equal(proof.source.settled,1);}
      assert.ok(proof.events.length>=1);
      for(const event of proof.events){assert.equal(event.provider,'bifrost');assert.equal(event.policy_id,row.id);
        if(event.capability==='models.list'){assert.equal(event.model,null);assert.equal(event.actual_cost_micros,0);assert.equal(event.reserved_cost_micros,0);}
        else if(event.status==='success'){assert.equal(event.actual_cost_micros,7);assert.equal(event.input_tokens,4);assert.equal(event.output_tokens,3);}
      }
    }),()=>f.close()]);
  });
}
