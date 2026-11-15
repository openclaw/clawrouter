import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it, vi } from "vitest";
import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { createProviderApiKeyResolver, createProviderAuthResolver } from "../../src/agents/models-config.providers.secrets.js";
import * as guard from "../../src/infra/net/fetch-guard.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { AuthProfileStore } from "../../src/agents/auth-profiles/types.js";
import type { DispatcherAwareRequestInit } from "../../src/infra/net/runtime-fetch.js";

const pin = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
type Case = {id:string; mode:string; api:"stream"|"simple"; control?:"eof"|"preabort"|"partial"|"provider_error"};
const cases = JSON.parse(process.env.CLAWROUTER_BIFROST_CASES!) as Case[];
const nativeFetch = globalThis.fetch;
const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
const nativeUndiciFetch = undici.fetch;
const nativeGuard = guard.fetchWithSsrFGuard;
const key = (id:string) => `clawrouter-live-${id}-fixture-secret`;
const discoveryKey=(row:Case)=>key(row.mode==='profile'?row.id:row.id+"_discovery");
type Original={kind:string;pending?:Promise<unknown>;returned:unknown;state:"pending"|"fulfilled"|"rejected"|"threw";reason?:unknown;value?:unknown;invoke:number;settle:number;returnAt:number;[key:string]:any};
type Transport={method:string;path:string;credential:string|null;signal:AbortSignal|undefined;dispatcher:any;response?:Response;guardObserved:boolean;releases:number;releaseDone:boolean;[key:string]:any};
const nativeIdentity=Object.freeze({pin,node:process.version,platform:process.platform,arch:process.arch,
 undici:createRequire(import.meta.url)("undici/package.json").version,guard:nativeGuard,fetch:nativeUndiciFetch});
const controlReports=new Map<string,Map<string,any>>(),qualifications=new Map<string,any>();
const callerWitnesses=new WeakMap<AbortSignal,any>();
let diagnosticCount=0,diagnosticBytes=0;

// Invocation ownership, not signal equality or a claim about C1's cause.
// Every context is captured at the original call boundary; absent attachment fails closed.
export function createBifrostFetchObserver(fetcher:Function,capture:Function,observerFailures:unknown[]) {
 return function(this:unknown,...args:any[]) {
  const receipt=capture(this,args);let original;
  try{original=Reflect.apply(fetcher,this,args);}catch(reason){
   try{receipt.threw(reason);}catch(error){observerFailures.push(error);}throw reason;
  }
  try{receipt.returned(original);}catch(error){observerFailures.push(error);}return original;
 };
}
export function createBifrostInvocationOwnership(storage:any) {
 const invocations=new WeakSet<object>(),acquisitions=new WeakSet<object>(),transports=new WeakSet<object>(),responses=new WeakMap<object,any>();
 let active=true;
 const current=()=>{const value=storage.getStore();if(!active||!value||!invocations.has(value.invocation))throw Error("incomplete invocation context");return value;};
 const bound=(t:any)=>{const a=t.acquisition,i=t.invocation;
  return active&&transports.has(t)&&acquisitions.has(a)&&invocations.has(i)&&a.invocation===i&&t.context===a.context&&
   t.context?.invocation===i&&t.context?.acquisition===a&&a.transport===t&&t.caller===i.caller&&t.owner===i.owner;};
 return {
  invoke(caller:any,kind:string,fn:Function,receiver:unknown,args:any[]){
   if(!active||!["discovery","inference"].includes(kind)||args[kind==="discovery"?0:2]?.signal!==caller.signal)throw Error("incomplete public caller");
   const invocation=Object.freeze({caller,signal:caller.signal,owner:caller.owner,kind,fn,receiver,args:Object.freeze([...args])});invocations.add(invocation);
   return storage.run(Object.freeze({invocation}),()=>Reflect.apply(fn,receiver,args));
  },
  guard(fn:Function,receiver:unknown,args:any[],a:any){
   const outer=current();if(outer.acquisition||acquisitions.has(a)||a.input!==args[0]||a.guard!==fn)throw Error("incomplete guard ownership");
   acquisitions.add(a);a.invocation=outer.invocation;a.owner=outer.invocation.owner;
   a.context=Object.freeze({invocation:outer.invocation,acquisition:a});
   return storage.run(a.context,()=>Reflect.apply(fn,receiver,args));
  },
  transport(t:any){
   const context=current(),a=context.acquisition;
   if(!a||!acquisitions.has(a)||a.context!==context||a.transport||transports.has(t)||
    (t.method==="POST"?"inference":t.method==="GET"?"discovery":"invalid")!==context.invocation.kind)throw Error("incomplete transport ownership");
   t.context=context;t.invocation=context.invocation;t.acquisition=a;t.caller=context.invocation.caller;t.owner=context.invocation.owner;
   a.transport=t;transports.add(t);
  },
  response(t:any,response:any){if(!bound(t)||t.response||responses.has(response))throw Error("ambiguous original response");t.response=response;responses.set(response,t);},
  attach(a:any,result:any){const t=a.transport;if(!t||!bound(t)||a.result||responses.get(result.response)!==t||t.response!==result.response)throw Error("incomplete original guard attachment");
   a.result=result;a.response=result.response;t.guardObserved=true;},
  bound,
  restore(){if(!active)throw Error("duplicate invocation restoration");active=false;storage.disable();},
 };
}
export function bifrostInvocationBound(w:any,t:any):boolean {
 const a=t.acquisition,i=t.invocation;
 return !!a&&!!i&&Object.isFrozen(i)&&i.owner===w.owner&&i.caller===w.caller&&i.signal===w.caller.signal&&
  i.args?.[i.kind==="discovery"?0:2]?.signal===i.signal&&i.kind===(t.method==="POST"?"inference":t.method==="GET"?"discovery":"invalid")&&
  a.invocation===i&&a.context===t.context&&t.context?.invocation===i&&t.context?.acquisition===a&&a.transport===t&&t.caller===i.caller&&
  a.inputSignal===(a.input?.signal??a.input?.init?.signal);
}
export function sameBifrostDescriptor(a:any,b:any):boolean {
 return !!a&&!!b&&["value","get","set","writable","enumerable","configurable"].every(k=>a[k]===b[k]);
}
export function bifrostNativeContract(identity:any,provider:string,api:string):string|undefined {
 if(!identity||!Object.isFrozen(identity)||identity.pin!=="d8bb939408aa4d2be7df0161748edb52ebf3b1fb"||provider!=="bifrost"||!["stream","simple"].includes(api)||
  ![identity.node,identity.platform,identity.arch,identity.undici].every(v=>typeof v==="string"&&v.length>0)||typeof identity.guard!=="function"||typeof identity.fetch!=="function")return;
 return "stored-error-after-join-v2";
}
export function bifrostCancelOperand(read:any,cancel:any):string {
 if(!Array.isArray(cancel?.args)||cancel.args.length>1)return "invalid";
 if(cancel.args.length===0)return "absent";
 if(cancel.args[0]===undefined)return "undefined";
 return Object.is(cancel.args[0],read.reason)?"same-as-stored":"distinct-defined";
}
// Pure, predefined vector over the original graph. It does not consult a
// product verdict, learn an allowlist, compare error names or infer C1's cause.
export function bifrostStoredErrorVector(w:any):any[]|undefined {
 const ts=w.transports.filter((t:any)=>t.method==="POST");if(ts.length!==1||w.transports.filter((t:any)=>t.method==="GET").length!==1||w.evidenceJoined!==true)return;
 const t=ts[0],a=t.acquisition,c=w.caller;
 if(!c||!bifrostInvocationBound(w,t)||c.owner!==w.owner||t.owner!==w.owner||!a||a.owner!==w.owner||a.transport!==t||a.response!==t.response||
   a.guard!==w.identity.guard||a.operation?.state!=="fulfilled"||a.pending!==a.operation.pending||a.pending!==a.operation.returned||a.result?.response!==t.response||!a.input||a.inputSignal!==a.input.signal&&a.inputSignal!==a.input.init?.signal||
   !t.guardObserved||!t.response||t.bodies.length!==1||t.readers.length!==1||t.fetch.state!=="fulfilled"||!t.fetch.pending||t.fetch.pending!==t.fetch.returned)return;
 const r=t.readers[0];if(r.transport!==t||r.body!==t.response.body||r.body!==t.bodies[0]||r.owner!==w.owner)return;
 const reads=w.originals.filter((o:any)=>o.kind==="read"&&o.reader===r&&o.state==="rejected"),read=reads[0];
 const closes=w.originals.filter((o:any)=>o.kind==="closed"&&o.reader===r),closed=closes[0];
 const cancels=w.originals.filter((o:any)=>o.kind==="cancel"&&o.reader===r),cancel=cancels[0];
 const unlocks=w.originals.filter((o:any)=>o.kind==="unlock"&&o.reader===r),unlock=unlocks[0];
 const prefix=w.originals.find((o:any)=>o.kind==="read"&&o.reader===r&&o.state==="fulfilled"&&o.value?.done===false&&o.value.value?.byteLength>0);
 if(reads.length!==1||closes.length!==1||cancels.length!==1||unlocks.length!==1||!prefix||!read||!closed||!cancel||unlock.state!=="fulfilled"||
   (read.reason===undefined||read.reason===null||typeof read.reason!=="object")||closed.state!=="rejected"||cancel.state!=="rejected"||closed.reason!==read.reason||cancel.reason!==read.reason||
   ![read,closed,cancel,prefix,unlock].every(o=>o.owner===w.owner&&o.receiver===r.original)||
   ![read,closed,cancel,prefix].every(o=>!!o.pending&&o.pending===o.returned)||
   closed.pending!==r.closed||bifrostCancelOperand(read,cancel)==="invalid"||
   !c.abortCalled||!c.abortedAfter||!c.noEarlierFailure||c.pending.length!==1||c.pending[0]!==read||
   read.callerAbortedAtInvoke!==false||read.callerAbortedAtSettle!==true||read.effectiveAbortedAtSettle!==true||
   c.signal!==read.callerSignal||t.signal!==read.effectiveSignal||!c.delivered||c.result!=="aborted")return;
 const signals=[c.signal,a.inputSignal,t.signal].map(bifrostSignalEvidence);
 if(signals.some(s=>!s.observed||!s.aborted||s.reason===null||typeof s.reason!=="object"||!Object.is(s.reason,read.reason)))return;
 for(const key of ["caller","input","effective"]){
  if(read.evidenceInvoke?.[key]?.observed!==true||read.evidenceInvoke[key].aborted!==false||cancel.evidenceInvoke?.[key]?.observed!==true||cancel.evidenceInvoke[key].aborted!==true||!Object.is(cancel.evidenceInvoke[key].reason,read.reason))return;
  if([read,closed,cancel].some(o=>o.evidenceSettle?.[key]?.observed!==true||o.evidenceSettle[key].aborted!==true||!Object.is(o.evidenceSettle[key].reason,read.reason)))return;
 }
 const order=[r.acquired,closed.invoke,prefix.settle,read.invoke,c.delivered,c.abortInvoke,c.abortObserved,a.signalHistory?.abort,t.signalHistory?.abort,read.settle,closed.settle,cancel.invoke,cancel.returnAt,cancel.settle,unlock.invoke,unlock.returnAt,r.unlockAt];
 // These are observed invocation/reaction orders, not native promise state transitions.
 // Cancel and releaseLock can run before the queued rejection observers.
 if(!order.every(n=>Number.isSafeInteger(n)&&n>0)||!(r.acquired<closed.invoke&&closed.invoke<prefix.settle&&
   prefix.settle<read.invoke&&prefix.settle<c.delivered&&read.invoke<c.abortInvoke&&c.delivered<c.abortInvoke&&c.abortInvoke<=c.abortObserved&&
   c.abortObserved<read.settle&&c.abortObserved<closed.settle&&Math.max(c.abortObserved,a.signalHistory.abort,t.signalHistory.abort)<cancel.invoke&&
   cancel.invoke<cancel.returnAt&&cancel.returnAt<cancel.settle&&cancel.returnAt<unlock.invoke&&unlock.invoke<unlock.returnAt&&unlock.returnAt<r.unlockAt))return;
 if(r.unlocks!==1||r.unlockReceiver!==r.original||r.body.locked||r.unlockFailed||t.releases!==1||!t.releaseDone||
   t.release?.state!=="fulfilled"||t.release.acquisition!==a||t.release.receiver!==undefined||!Array.isArray(t.release.args)||t.release.args.length!==0||!t.release.pending||t.release.pending!==t.release.returned||
   !(t.release.returnAt>t.release.invoke&&t.release.settle>t.release.returnAt))return;
 const vector=[read,closed,cancel];
 if(w.originals.some((o:any)=>o.state!=="fulfilled"&&!vector.includes(o)))return;
 return vector;
}
export function evaluateBifrostNativeControl(w:any):any {
 const contract=bifrostNativeContract(w.identity,w.provider,w.api);
 const vector=bifrostStoredErrorVector(w),hard=!contract||!w.owner||typeof w.owner!=="object"||w.evidenceJoined!==true||w.failures.length||w.observerFailures.length||w.syncFailures.length||(w.reportingFailures?.length??1)||
  !w.restored||w.sourceExpired!==0||w.originals.some((o:any)=>o.state==="pending"||o.state==="threw")||
  w.transports.some((t:any)=>!bifrostInvocationBound(w,t)||!t.guardObserved||t.owner!==w.owner||t.acquisition?.owner!==w.owner||t.acquisition?.response!==t.response||
   t.acquisition?.transport!==t||t.acquisition?.guard!==w.identity.guard||t.acquisition?.operation?.state!=="fulfilled"||t.acquisition?.pending!==t.acquisition?.operation?.pending||t.acquisition?.result?.response!==t.response||t.readers.length!==1||t.bodies.length!==1||
   t.releases!==1||!t.releaseDone||t.release?.state!=="fulfilled"||t.readers.some((r:any)=>r.owner!==w.owner||r.transport!==t||r.body!==t.response?.body||
    r.body!==t.bodies[0]||r.unlocks!==1||r.unlockFailed||r.body.locked||r.unlockReceiver!==r.original||
    w.originals.filter((o:any)=>o.kind==="closed"&&o.reader===r&&o.pending===r.closed&&o.invoke<r.unlockAt).length!==1));
 const strict=w.originals.every((o:any)=>o.state==="fulfilled");
 const posts=w.transports.filter((t:any)=>t.method==="POST").length,gets=w.transports.filter((t:any)=>t.method==="GET").length;
 const role=w.role;
 const matched=role==="partial"?!!vector:role==="preabort"?strict&&w.preabortPostDelta===0&&w.caller?.abortCalled===true&&w.caller?.signal.aborted===true&&w.caller?.result==="error"&&w.caller?.emptyContent===true&&posts===0:
  (role==="eof"||role==="provider_error")&&strict&&posts===1&&w.caller?.abortCalled===false&&w.caller?.signal.aborted===false&&
   w.caller?.result===(role==="eof"?"stop":"error");
 return {qualified:!hard&&gets===1&&matched===true,contract,vector:vector?"stored_error":"strict",operand:vector?bifrostCancelOperand(vector[0],vector[2]):null,
  vectorObserved:!!vector,owner:w.owner,identity:w.identity,provider:w.provider,api:w.api,role};
}
export function bifrostQualification(reports:any[],identity:any,provider:string,api:string):any {
 const contract=bifrostNativeContract(identity,provider,api);if(!contract)return;
 const roles=["eof","preabort","partial","provider_error"];
 if(reports.length!==4||new Set(reports.map(r=>r.owner)).size!==4||!roles.every(role=>reports.filter(r=>r.role===role).length===1)||
  reports.some(r=>!r.qualified||!r.owner||typeof r.owner!=="object"||r.contract!==contract||r.identity!==identity||r.provider!==provider||r.api!==api))return;
 const partial=reports.find(r=>r.role==="partial");if(partial.vector!=="stored_error")return;
 return Object.freeze({identity,provider,api,contract,roles:Object.freeze(roles),vector:partial.vector});
}
export function bifrostProductExpected(w:any,q:any):any[] {
 if(!q||!q.contract||q.contract!==bifrostNativeContract(w.identity,w.provider,w.api)||q.identity!==w.identity||q.provider!==w.provider||q.api!==w.api||q.vector!=="stored_error"||
   q.roles?.join(",")!=="eof,preabort,partial,provider_error")return [];
 const raw=evaluateBifrostNativeControl({...w,role:"partial"});
 return raw.qualified?bifrostStoredErrorVector(w)??[]:[];
}
export function bifrostProgressQualified(f:any):boolean {
 const yes=["uniqueRequest","callerAborted","actualText","nativeQualified","workerRetired","inboundAborted","sourceCanceled",
  "sourceJoined","noExpiry","onePost","accounting","allOriginalsJoined","restored","singleProgress","nonterminal"];
 return yes.every(k=>f[k]===true)&&[f.delivered,f.abortInvoke,f.socketClosed,f.controlInvoke].every(v=>Number.isSafeInteger(v)&&v>0)&&
  f.delivered<f.abortInvoke&&f.abortInvoke<f.socketClosed&&f.socketClosed<f.controlInvoke&&f.failures===0;
}
export function bifrostProgressWitness(w:any,proof:any,allowed:any[],worker:boolean,workerFailures:unknown[]):any {
 const c=w.caller,vector=bifrostStoredErrorVector(w);
  const ts=w.transports.filter(t=>t.method==="POST"),t=ts.length===1?ts[0]:undefined,source=proof?.source;
  const events=proof?.events?.filter((e:any)=>e.capability==="llm.chat")??[],event=events[0];
  return {uniqueRequest:!!t?.socketRequest&&!!t.socket,callerAborted:c.abortedAfter===true,actualText:c.delivered>0,nativeQualified:allowed.length===3&&vector?.length===3&&allowed.every(o=>vector.includes(o)),
   workerRetired:worker,inboundAborted:proof?.inboundChatAborted===true,sourceCanceled:source?.canceled===1,sourceJoined:source?.settled===1,
   noExpiry:source?.expired===0,onePost:source?.calls?.filter((v:any)=>v.chat).length===1,accounting:events.length===1&&event.provider==="bifrost"&&event.policy_id===w.owner.id&&event.credential_id===w.owner.id&&event.model==="tenant/opaque-a"&&event.status==="client_error"&&event.status_code===499&&event.actual_cost_micros===7&&event.reserved_cost_micros===7&&event.input_tokens===null&&event.output_tokens===null&&event.total_tokens===null&&proof?.charged===0,
   allOriginalsJoined:w.originals.every(o=>o.state==="fulfilled"||allowed.includes(o)),restored:w.restored,singleProgress:source?.progressCalls===1,
   nonterminal:source?.progressTerminal===false&&source?.completed===0&&[0,1].includes(source?.progressEnqueued)&&c.progress?.accepted===true&&c.progress?.enqueued===(source?.progressEnqueued===1)&&c.progress?.alreadyCanceled===(source?.progressEnqueued===0),
   delivered:c.delivered,abortInvoke:c.abortInvoke,socketClosed:t?.socketClosedAt,controlInvoke:c.controlInvoke,failures:w.failures.length+w.observerFailures.length+w.syncFailures.length+workerFailures.length};
}
function emitControl(row:Case,w:any,result:any,worker:boolean):void {
 const record={v:1,pin,api:row.api,role:row.control,qualified:result.qualified,vector:result.vectorObserved,worker,restored:w.restored,
  rejected:w.originals.filter((o:Original)=>o.state==="rejected").length,pending:w.originals.filter((o:Original)=>o.state==="pending").length};
 const line="BIFROST_NATIVE_CONTROL "+JSON.stringify(record);
 if(diagnosticCount>=8||Buffer.byteLength(line)>400||diagnosticBytes+Buffer.byteLength(line)+1>4096)throw Error("native diagnostic quota exceeded");
 diagnosticCount++;diagnosticBytes+=Buffer.byteLength(line)+1;console.log(line);
}
// Closed diagnostics only. They report boundaries, never classify an error.
export function bifrostSetupPhase(phase:unknown):boolean {
 return typeof phase==="string"&&["caller_install","progress_subscribe","source_env_pin","source_git_pin","poison_env","fetch_hook","undici_hook","guard_hook","guard_descriptor","profile_write","discovery_env","api_key_resolver","auth_resolver","discovery_auth_check","inference_auth_check","facade_load","plugin_register","plugin_id_check","catalog_check"].includes(phase);
}
// Native accessors bypass instance getters. Reasons stay private and are never serialized.
export function bifrostSignalEvidence(signal:unknown):any {
 try{
  const aborted=Reflect.apply(Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")!.get!,signal,[]);
  const reason=Reflect.apply(Object.getOwnPropertyDescriptor(AbortSignal.prototype,"reason")!.get!,signal,[]);
  return {observed:true,aborted,reason};
 }catch{return {observed:false,aborted:null};}
}
export function bifrostOperationEvidence(o:any,originals:any[]):any {
 const t=o.reader?.transport;
 return {caller:bifrostSignalEvidence(o.callerSignal),input:bifrostSignalEvidence(t?.acquisition?.inputSignal),effective:bifrostSignalEvidence(o.effectiveSignal),
  readRejected:originals.some(p=>p.reader===o.reader&&p.kind==="read"&&p.state==="rejected"),
  closedRejected:originals.some(p=>p.reader===o.reader&&p.kind==="closed"&&p.state==="rejected"),
  pendingReads:originals.filter(p=>p.reader===o.reader&&p.kind==="read"&&p.state==="pending").length};
}
export function bifrostReasonMetadata(observed:boolean,reason:unknown):any {
 return {observed,defined:observed?reason!==undefined:null,object:observed?reason!==null&&typeof reason==="object":null};
}
export function bifrostCaseEvidence(index:number,w:any,proof:any,worker:boolean,workerFailures:unknown[]):any[] {
 const one=(values:any[])=>values.length===1?values[0]:undefined;
 const num=(n:any)=>Number.isSafeInteger(n)&&n>=0&&n<=1000000?n:null;
 const flag=(v:any)=>typeof v==="boolean"?v:null;
 const id=(values:any[],v:any)=>v&&values.includes(v)?values.indexOf(v):null;
 const state=(o:any)=>o&&["pending","fulfilled","rejected","threw"].includes(o.state)?o.state:"absent";
 const observed=(o:any)=>!!o&&["rejected","threw"].includes(o.state);
 const meta=(o:any)=>bifrostReasonMetadata(observed(o),o?.reason);
 const same=(a:any,b:any)=>observed(a)&&observed(b)?Object.is(a.reason,b.reason):null;
 const transports=w.transports.filter((t:any)=>t.method==="POST"),t=one(transports),a=t?.acquisition,c=w.caller,r=t?one(t.readers):undefined;
 const ops=(kind:string)=>r?w.originals.filter((o:any)=>o.reader===r&&o.kind===kind):[];
 const rejected=ops("read").filter((o:any)=>o.state==="rejected"),read=one(rejected),closes=ops("closed"),closed=one(closes),cancels=ops("cancel"),cancel=one(cancels);
 const prefix=ops("read").find((o:any)=>o.state==="fulfilled"&&o.value?.done===false&&o.value.value?.byteLength>0);
 const unlock=one(ops("unlock")),release=t?.release;
 const bindings={
  invocation:t?bifrostInvocationBound(w,t):null,
  guard:a?!!(w.acquisitions.filter((v:any)=>v===a).length===1&&a.owner===w.owner&&a.guard===w.identity.guard&&a.operation?.state==="fulfilled"&&a.pending===a.operation.pending):null,
  response:t&&a?!!(a.transport===t&&a.response===t.response&&a.result?.response===t.response&&t.guardObserved):null,
  reader:r?!!(r.owner===w.owner&&r.transport===t&&r.body===t.response?.body&&t.bodies.length===1&&r.body===t.bodies[0]):null,
  receivers:r&&read&&closed&&cancel?[read,closed,cancel].every(o=>o.owner===w.owner&&o.receiver===r.original):null,
  readPromise:read?!!read.pending&&read.pending===read.returned:null,
  closedPromise:closed?!!closed.pending&&closed.pending===closed.returned&&closed.pending===r.closed:null,
  cancelPromise:cancel?!!cancel.pending&&cancel.pending===cancel.returned:null,
  fetchArgs:t?.fetch?!!t.fetch.args&&t.fetch.args[0]===t.input&&t.fetch.args[1]===t.init:null,
  signals:read&&closed&&cancel?[read,closed,cancel].every(o=>["evidenceInvoke","evidenceSettle"].every(at=>["caller","input","effective"].every(k=>o[at]?.[k]?.observed===true))):null,
 };
 const signals=(o:any)=>["caller","input","effective"].map(k=>observed(o)&&o.evidenceSettle?.[k]?.observed===true?Object.is(o.reason,o.evidenceSettle[k].reason):null);
 const signalStates=(o:any,where:string)=>["caller","input","effective"].map(k=>flag(o?.[where]?.[k]?.aborted));
 // Complete means unique observed bindings, never accepted native outcomes.
 const complete=transports.length===1&&!!r&&rejected.length===1&&closes.length===1&&cancels.length===1&&Object.values(bindings).every(v=>v===true);
 const base={v:1,pin:"d8bb939408aa4d2be7df0161748edb52ebf3b1fb",lane:"sdk",case:index,evidence:true,complete};
 const source=proof?.source;
 return [
  {...base,part:"identity",ids:{transport:id(w.transports,t),acquisition:id(w.acquisitions,a),reader:t?id(t.readers,r):null,read:id(w.originals,read),closed:id(w.originals,closed),cancel:id(w.originals,cancel),release:id(w.originals,release)},
   counts:{posts:transports.length,gets:w.transports.filter((v:any)=>v.method==="GET").length,acquisitions:w.acquisitions.length,readers:t?t.readers.length:0,reads:ops("read").length,closed:closes.length,cancel:cancels.length},bindings,firstFailed:null,
   source:{canceled:num(source?.canceled),settled:num(source?.settled),expired:num(source?.expired),held:num(source?.held)},inbound:flag(proof?.inboundChatAborted)},
  {...base,part:"reasons",read:meta(read),closed:meta(closed),cancel:meta(cancel),readClosed:same(read,closed),readCancel:same(read,cancel),
   readSignals:signals(read),closedSignals:signals(closed),cancelSignals:signals(cancel),
   cancelArgs:cancel?num(cancel.args?.length):null,cancelRead:cancel?.args?.length>0&&observed(read)?Object.is(cancel.args[0],read.reason):null,
   cancelInput:["caller","input","effective"].map(k=>cancel?.args?.length>0&&cancel.evidenceInvoke?.[k]?.observed===true?Object.is(cancel.args[0],cancel.evidenceInvoke[k].reason):null),
   abortOperand:bifrostReasonMetadata(c?.abortArgumentCount>0,c?.reason),callerReason:bifrostReasonMetadata(c?.evidenceAbort?.observed===true,c?.evidenceAbort?.reason),
   operandSignal:c?.abortArgumentCount>0&&c?.evidenceAbort?.observed===true?Object.is(c.reason,c.evidenceAbort.reason):null},
  {...base,part:"order",acquired:num(r?.acquired),prefix:num(prefix?.settle),delivered:num(c?.delivered),abortInvoke:num(c?.abortInvoke),abortObserved:num(c?.abortObserved),abortReturn:num(c?.abortReturn),
   cancelOperand:{...bifrostReasonMetadata(Array.isArray(cancel?.args)&&cancel.args.length>0,cancel?.args?.[0]),kind:cancel&&observed(read)?bifrostCancelOperand(read,cancel):"unobserved"},
   readInvoke:num(read?.invoke),readSettle:num(read?.settle),closedInvoke:num(closed?.invoke),closedSettle:num(closed?.settle),cancelInvoke:num(cancel?.invoke),cancelReturn:num(cancel?.returnAt),cancelSettle:num(cancel?.settle),
   readRejectedAtCancel:flag(cancel?.evidenceInvoke?.readRejected),closedRejectedAtCancel:flag(cancel?.evidenceInvoke?.closedRejected),pendingReadsAtCancel:num(cancel?.evidenceInvoke?.pendingReads),
   readInvokeSignals:signalStates(read,"evidenceInvoke"),readSettleSignals:signalStates(read,"evidenceSettle"),cancelInvokeSignals:signalStates(cancel,"evidenceInvoke")},
  {...base,part:"retirement",states:{read:state(read),closed:state(closed),cancel:state(cancel),release:state(release),unlock:state(unlock),fetch:state(t?.fetch)},
   counts:{originals:w.originals.length,pending:w.originals.filter((o:any)=>o.state==="pending").length,rejected:w.originals.filter((o:any)=>o.state==="rejected").length,sync:w.syncFailures.length,observer:w.observerFailures.length,restoration:num(w.evidenceRestoreFailures),worker:workerFailures.length,unlocks:num(r?.unlocks)},
   release:{invoke:num(release?.invoke),returned:num(release?.returnAt),settle:num(release?.settle),promise:release?!!release.pending&&release.pending===release.returned:null,defined:observed(release)?release.reason!==undefined:null},
   unlock:{invoke:num(unlock?.invoke),returned:num(unlock?.returnAt)},unlockAt:num(r?.unlockAt),
   // Undefined failure counts: all, synchronous, observer, restoration/cleanup.
   undefined:[w.failures.filter((e:unknown)=>e===undefined).length,w.syncFailures.filter((e:unknown)=>e===undefined).length,w.observerFailures.filter((e:unknown)=>e===undefined).length,num(w.evidenceRestoreUndefined)],
   bodyUnlocked:r?flag(r.body.locked===false):null,restored:flag(w.restored),joins:flag(w.evidenceJoined),worker}
 ];
}
export function validateBifrostEvidence(record:any):void {
 const number=(v:any)=>v===null||Number.isSafeInteger(v)&&v>=0&&v<=1000000;
 const boolean=(v:any)=>v===null||typeof v==="boolean";
 const reason=(v:any)=>v&&Object.keys(v).sort().join(",")==="defined,object,observed"&&typeof v.observed==="boolean"&&
  (v.observed?typeof v.defined==="boolean"&&typeof v.object==="boolean"&&(!v.object||v.defined):v.defined===null&&v.object===null);
 const signals=(v:any)=>Array.isArray(v)&&v.length===3&&v.every(boolean);
 const fields:any={
  identity:{ids:"transport acquisition reader read closed cancel release",counts:"posts gets acquisitions readers reads closed cancel",bindings:"invocation guard response reader receivers readPromise closedPromise cancelPromise fetchArgs signals",firstFailed:null,source:"canceled settled expired held",inbound:boolean},
  reasons:{read:reason,closed:reason,cancel:reason,readClosed:boolean,readCancel:boolean,readSignals:signals,closedSignals:signals,cancelSignals:signals,cancelArgs:number,cancelRead:boolean,cancelInput:signals,abortOperand:reason,callerReason:reason,operandSignal:boolean},
  order:Object.fromEntries(("acquired prefix delivered abortInvoke abortObserved abortReturn readInvoke readSettle closedInvoke closedSettle cancelInvoke cancelReturn cancelSettle pendingReadsAtCancel").split(" ").map(k=>[k,number])),
  retirement:{states:"read closed cancel release unlock fetch",counts:"originals pending rejected sync observer restoration worker unlocks",release:(v:any)=>v&&Object.keys(v).sort().join(",")==="defined,invoke,promise,returned,settle"&&[v.invoke,v.returned,v.settle].every(number)&&[v.promise,v.defined].every(boolean),unlock:"invoke returned",unlockAt:number,undefined:(v:any)=>Array.isArray(v)&&v.length===4&&v.every(number),bodyUnlocked:boolean,restored:boolean,joins:boolean,worker:boolean},
 };
 Object.assign(fields.order,{readRejectedAtCancel:boolean,closedRejectedAtCancel:boolean,readInvokeSignals:signals,readSettleSignals:signals,cancelInvokeSignals:signals});
 fields.order.cancelOperand=(v:any)=>v&&Object.keys(v).sort().join(",")==="defined,kind,object,observed"&&reason({observed:v.observed,defined:v.defined,object:v.object})&&["absent","undefined","same-as-stored","distinct-defined","invalid","unobserved"].includes(v.kind);
 const schema=fields[record?.part],base=["v","pin","lane","case","evidence","complete","part"];
 if(!schema||!record||record.v!==1||record.pin!=="d8bb939408aa4d2be7df0161748edb52ebf3b1fb"||record.lane!=="sdk"||record.evidence!==true||
  typeof record.complete!=="boolean"||!Number.isSafeInteger(record.case)||record.case<0||record.case>=32||
  Object.keys(record).sort().join(",")!==[...base,...Object.keys(schema)].sort().join(","))throw Error("invalid Bifrost evidence");
 for(const [key,rule] of Object.entries(schema)){
  const value=record[key];
  if(rule===null){if(value!==null)throw Error("unsupported predicate attribution");}
  else if(typeof rule==="function"){if(!rule(value))throw Error("invalid evidence field");}
  else {
   if(!value||Object.keys(value).sort().join(",")!==(rule as string).split(" ").sort().join(","))throw Error("invalid evidence fields");
   const valid=key==="bindings"?boolean:key==="states"?(v:any)=>["absent","pending","fulfilled","rejected","threw"].includes(v):number;
   if(!Object.values(value).every(valid))throw Error("invalid evidence values");
  }
 }
 if(Buffer.byteLength("::notice title=Bifrost closed diagnostic::"+JSON.stringify(record)+"\n")>768)throw Error("evidence record quota exceeded");
}
export function validateBifrostCheckpoint(record:any):void {
 if(record?.evidence===true){validateBifrostEvidence(record);return;}
 const keys=["v","pin","lane","case","phase","state","defined","acq","op","count"];
 if(!record||Object.keys(record).sort().join(",")!==keys.sort().join(",")||record.v!==1||
  record.pin!=="d8bb939408aa4d2be7df0161748edb52ebf3b1fb"||!["outer","sdk"].includes(record.lane)||
  (!["module","setup","case_setup","case_result","child","body","original_join","read","closed","cancel","release","observer","worker_retirement","restoration","cleanup","control","assertions","final","overflow"].includes(record.phase)&&!bifrostSetupPhase(record.phase))||
  !["enter","fulfilled","rejected","threw","summary"].includes(record.state)||
  !(record.defined===null||typeof record.defined==="boolean")||
  ![record.case,record.acq,record.op].every((n:any)=>n===null||Number.isSafeInteger(n)&&n>=0&&n<4096)||
  !(record.case===null||record.case<32)||!Number.isSafeInteger(record.count)||record.count<0||record.count>65535||
  (bifrostSetupPhase(record.phase)&&(record.lane!=="sdk"||record.case===null||record.state!=="rejected"||record.acq!==null||record.op!==null||record.count!==0))||
  (["rejected","threw"].includes(record.state)?typeof record.defined!=="boolean":record.defined!==null))throw Error("invalid Bifrost checkpoint");
}
export function createBifrostCheckpointReporter(lane:string,emit:Function,withEvidence=false) {
 const records=new Map<string,any>(),sent=new Set<string>(),observers:Promise<unknown>[]=[],failures:unknown[]=[];
 let emitted=0,suppressed=0,finished=false,failed=0,evidenceCase:number|null=null;
 const make=(index:number|null,phase:string,state:string,reason:unknown,acq:number|null=null,op:number|null=null,count=0)=>({v:1,pin:"d8bb939408aa4d2be7df0161748edb52ebf3b1fb",lane,case:index,phase,state,
  defined:state==="rejected"||state==="threw"?reason!==undefined:null,acq,op,count});
 const send=(record:any)=>{try{validateBifrostCheckpoint(record);emit(record);}catch(error){failures.push(error);}};
 const mark=(index:number|null,phase:string,state:string,reason?:unknown,acq:number|null=null,op:number|null=null)=>{
  try{const record=make(index,phase,state,reason,acq,op);validateBifrostCheckpoint(record);
   if(finished)throw Error("checkpoint after final flush");
   const key=String(index)+":"+phase;
   // Keep the first failure even when a later cleanup of the same kind succeeds.
   if(!["rejected","threw"].includes(records.get(key)?.state))records.set(key,record);
   if(state==="rejected"||state==="threw")failed++;
  }catch(error){failures.push(error);}
 };
 const flush=(index:number|null)=>{
  const selected=[...records.values()].filter(r=>r.case===index);
  selected.sort((a,b)=>Number(["rejected","threw"].includes(b.state))-Number(["rejected","threw"].includes(a.state)));
  for(const record of selected){const key=JSON.stringify(record);if(sent.has(key))continue;sent.add(key);
   if(emitted<(withEvidence?3:7)){emitted++;send(record);}else suppressed=Math.min(65535,suppressed+1);}
 };
 return {failures,mark,flush,
  evidence(records:any[]){
   try{
    if(!withEvidence||lane!=="sdk"||finished||records.length!==4)throw Error("unsupported evidence group");
    for(const record of records)validateBifrostEvidence(record);
    if(records.map(r=>r.part).join(",")!=="identity,reasons,order,retirement"||records.some(r=>r.case!==records[0].case||r.complete!==records[0].complete))throw Error("incomplete evidence group");
    if(evidenceCase!==null){suppressed=Math.min(65535,suppressed+4);return;}
    evidenceCase=records[0].case;for(const record of records)send(record);
   }catch(error){failures.push(error);}
  },
  observe(index:number|null,phase:string,fn:Function,receiver:unknown,args:any[]){
   mark(index,phase,"enter");let original;
   try{original=Reflect.apply(fn,receiver,args);}catch(reason){mark(index,phase,"threw",reason);flush(index);throw reason;}
   try{if(original&&typeof original.then==="function"){
    const observed=original.then(()=>mark(index,phase,"fulfilled"),(reason:unknown)=>{mark(index,phase,"rejected",reason);flush(index);});
    observers.push(observed.then(()=>{},(error:unknown)=>{failures.push(error);}));
   }else mark(index,phase,"fulfilled");}catch(error){failures.push(error);}
   return original;
  },
  async drain(){let at=0;while(at<observers.length){const batch=observers.slice(at);at=observers.length;
   for(const result of await Promise.allSettled(batch))if(result.status==="rejected")failures.push(result.reason);}},
  finish(){if(finished){failures.push(Error("duplicate checkpoint final flush"));return;}finished=true;
   if(suppressed)send(make(null,"overflow","summary",undefined,null,null,suppressed));
   send(make(null,"final","summary",undefined,null,null,Math.min(65535,failed)));},
 };
}
// The enclosing case_result observer is joined by afterAll, never by its own case.
export function finishBifrostCheckpointCase(report:any,index:number,failures:unknown[]):void {
 report.mark(index,"assertions",failures.length?"rejected":"fulfilled",failures[0]);
 if(failures.length)report.flush(index);
}
export function createBifrostSetupBoundary(report:any,index:number) {
 let phase:string|null=null;
 return {
  enter(next:string){
   if(!bifrostSetupPhase(next)){phase=null;report.failures.push(Error("invalid setup boundary"));return;}
   phase=next;
  },
  reject(reason:unknown){
   if(phase===null){report.failures.push(Error("missing setup boundary"));return;}
   report.mark(index,phase,"rejected",reason);
  },
 };
}
const checkpoints=createBifrostCheckpointReporter("sdk",(record:any)=>process.stdout.write("BIFROST_CHECKPOINT "+JSON.stringify(record)+"\n"),true);
checkpoints.mark(null,"module","fulfilled");checkpoints.flush(null);
afterAll(async()=>{await checkpoints.drain();checkpoints.finish();throwFailures(checkpoints.failures);});
function checkpointCase(row:Case):number {
 const inventory=[...JSON.parse(process.env.CLAWROUTER_BIFROST_CONTROLS!),...cases,...JSON.parse(process.env.CLAWROUTER_BIFROST_PROGRESS!)];
 const matches=inventory.map((r:Case,i:number)=>r.id===row.id?i:-1).filter((i:number)=>i>=0);
 if(matches.length!==1||matches[0]>=32)throw Error("ambiguous diagnostic case");return matches[0];
}
async function command(id:string,kind:string,body:unknown={}) {
 const response=await nativeFetch(origin+"/__bifrost/"+kind+"/"+id,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 const text=await response.text();expect(response.status).toBe(200);return JSON.parse(text);
}
function throwFailures(failures:unknown[]):void{if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"Bifrost originals and cleanup failed");}

function fixture(row:Case,body:Parameters<typeof fixtureOwned>[1]){
 return checkpoints.observe(checkpointCase(row),"case_result",fixtureOwned,undefined,[row,body]);
}
async function fixtureOwned(row:Case,body:(discover:()=>Promise<any>,control:AbortController,track:<T>(kind:string,p:Promise<T>)=>Promise<T>,inferenceKey:string)=>Promise<void>){
 const caseIndex=checkpointCase(row);
 const state=await checkpoints.observe(caseIndex,"setup",createOpenClawTestState,undefined,[{label:"bifrost-worker-contract"}]),control=new AbortController();
 const w:any={owner:Object.freeze({id:row.id}),identity:nativeIdentity,provider:"bifrost",api:row.api,role:row.control,
  originals:[],observers:[],transports:[],acquisitions:[],failures:[],observerFailures:[],syncFailures:[],reportingFailures:checkpoints.failures,restored:false,sourceExpired:null,sequence:0};
 const ownership=createBifrostInvocationOwnership(new AsyncLocalStorage());
 const failures:unknown[]=w.failures,originals:Original[]=w.originals,transports:Transport[]=w.transports,restores:Array<()=>void>=[];
 const observer=(p:Promise<unknown>)=>{w.observers.push(p.then(()=>{},e=>{w.observerFailures.push(e);}));};
 const record=(kind:string,details:any={})=>{const o:Original={owner:w.owner,kind,invoke:++w.sequence,settle:0,returnAt:0,state:"pending",returned:undefined,...details};originals.push(o);
  if(["read","closed","cancel"].includes(kind))try{o.evidenceInvoke=bifrostOperationEvidence(o,originals);}catch(e){w.observerFailures.push(e);}return o;};
 const returned=(o:Original,value:any)=>{o.returned=value;o.returnAt=++w.sequence;
  const settle=(state:Original["state"],v:any)=>{o.state=state;o.settle=++w.sequence;if(state==="rejected")o.reason=v;else o.value=v;
   if(["read","closed","cancel"].includes(o.kind))try{o.evidenceSettle=bifrostOperationEvidence(o,originals);}catch(e){w.observerFailures.push(e);}
   o.callerAbortedAtSettle=o.callerSignal?.aborted??null;o.effectiveAbortedAtSettle=o.effectiveSignal?.aborted??null;
   const phase=["read","closed","cancel"].includes(o.kind)?o.kind:o.kind==="guard_release"?"release":null;
   if(phase)checkpoints.mark(caseIndex,phase,state,v,o.reader?transports.indexOf(o.reader.transport):null,originals.indexOf(o));};
  if(value&&typeof value.then==="function"){o.pending=value;observer(value.then((v:any)=>settle("fulfilled",v),(e:unknown)=>settle("rejected",e)));}else settle("fulfilled",value);return value;};
 const track=<T>(kind:string,p:Promise<T>):Promise<T>=>{if(kind==="inference_result")observer(p.then((v:any)=>{w.caller.result=v.stopReason;w.caller.emptyContent=Array.isArray(v.content)&&v.content.length===0;w.caller.completed=true;},()=>{w.caller.completed=true;}));return returned(record(kind),p);};
 const invoke=(kind:string,fn:()=>any,details:any={})=>{const o=record(kind,details);try{return returned(o,fn());}catch(e){o.state="threw";o.reason=e;o.settle=++w.sequence;w.syncFailures.push(e);throw e;}};
 const patch=(object:any,name:string,value:any)=>{const before=Object.getOwnPropertyDescriptor(object,name),ours={configurable:true,writable:true,enumerable:before?.enumerable??false,value};Object.defineProperty(object,name,ours);
  restores.push(()=>{if(!sameBifrostDescriptor(Object.getOwnPropertyDescriptor(object,name),ours))throw Error("foreign descriptor replacement");if(before)Object.defineProperty(object,name,before);else delete object[name];});};
 const signalHistory=(signal:AbortSignal|undefined)=>{const h:any={signal,initial:signal?.aborted??null,invoke:++w.sequence,abort:0};if(signal){const onAbort=()=>{h.abort=++w.sequence;h.reason=signal.reason;};if(signal.aborted)onAbort();else{signal.addEventListener("abort",onAbort,{once:true});restores.push(()=>signal.removeEventListener("abort",onAbort));}}return h;};
 const c:any={owner:w.owner,signal:control.signal,abortCalled:false,completed:false,result:null,pending:[],delivered:0};w.caller=c;
 const setupCaller=()=>{
 const aborted=()=>{c.abortObserved=++w.sequence;};control.signal.addEventListener("abort",aborted,{once:true});restores.push(()=>control.signal.removeEventListener("abort",aborted));
 const abort=control.abort;patch(control,"abort",function(this:AbortController,...args:Parameters<typeof abort>){
  if(this!==control)throw Error("foreign original caller");c.abortCalled=true;c.noEarlierFailure=!control.signal.aborted&&!originals.some(o=>o.state==="rejected"||o.state==="threw");
  c.pending=originals.filter(o=>o.kind==="read"&&o.state==="pending"&&o.reader.transport.caller===c);c.abortInvoke=++w.sequence;c.reason=args[0];c.abortArgumentCount=args.length;
  try{const value=Reflect.apply(abort,this,args);c.abortReturn=++w.sequence;c.abortedAfter=control.signal.aborted;
   try{c.evidenceAbort=bifrostSignalEvidence(control.signal);}catch(e){w.observerFailures.push(e);}return value;}catch(e){w.syncFailures.push(e);throw e;}});
 callerWitnesses.set(control.signal,{begin:()=>{c.inferenceInvoked=++w.sequence;c.completed=false;c.postsBefore=transports.filter(t=>t.method==="POST").length;},delivered:()=>{c.delivered=++w.sequence;},
  invoke:(fn:Function,receiver:unknown,args:any[])=>ownership.invoke(c,"inference",fn,receiver,args),
  progress:async()=>{const ts=transports.filter(t=>t.method==="POST"&&t.caller===c);expect(ts).toHaveLength(1);const t=ts[0];
   expect(c.abortCalled).toBe(true);expect(t.socketClosed).toBeDefined();await t.socketClosed;
   c.controlInvoke=++w.sequence;c.progress=await invoke("progress_control",()=>command(row.id,"progress"));}});
 restores.push(()=>{if(!callerWitnesses.has(control.signal))throw Error("missing caller binding");callerWitnesses.delete(control.signal);});
 };
 const observedBodies=new WeakSet<object>(),observedDispatchers=new WeakSet<object>();
 const observeBody=(response:Response,t:Transport)=>{const b=response.body;if(!b||observedBodies.has(b))return;observedBodies.add(b);t.bodies.push(b);
  const cancel=b.cancel,get=b.getReader;patch(b,"cancel",function(this:ReadableStream,...args:Parameters<typeof cancel>){return invoke("body_cancel",()=>Reflect.apply(cancel,this,args),{transport:t,receiver:this,args});});
  patch(b,"getReader",function(this:ReadableStream,...args:any[]){let reader;try{reader=Reflect.apply(get,this,args);}catch(e){w.syncFailures.push(e);throw e;}
   const r:any={owner:w.owner,original:reader,body:b,transport:t,acquired:++w.sequence,unlocks:0,unlockFailed:false};t.readers.push(r);if(this!==b)failures.push(Error("foreign body receiver"));
   try{r.closed=reader.closed;returned(record("closed",{reader:r,receiver:reader,callerSignal:t.caller?.signal,effectiveSignal:t.signal,callerAbortedAtInvoke:t.caller?.signal?.aborted??null}),r.closed);}catch(e){w.syncFailures.push(e);throw e;}
   for(const kind of ["read","cancel"]){const original=reader[kind];patch(reader,kind,function(this:unknown,...args:unknown[]){return invoke(kind,()=>Reflect.apply(original,this,args),{reader:r,receiver:this,args,callerSignal:t.caller?.signal,effectiveSignal:t.signal,callerAbortedAtInvoke:t.caller?.signal?.aborted??null});});}
   const release=reader.releaseLock;patch(reader,"releaseLock",function(this:unknown,...args:unknown[]){try{const v=invoke("unlock",()=>Reflect.apply(release,this,args),{reader:r,receiver:this,args});r.unlocks++;r.unlockReceiver=this;r.unlockAt=++w.sequence;return v;}catch(e){r.unlockFailed=true;throw e;}});return reader;});};
 const observingFetch=(fetcher:Function)=>createBifrostFetchObserver(fetcher,(receiver:unknown,args:any[])=>{
  const [input,init]=args as [RequestInfo|URL,DispatcherAwareRequestInit|undefined];
  const u=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);expect(u.origin).toBe(origin);expect(u.search).toBe("");
  expect(["/v1/native/bifrost/v1/models","/v1/native/bifrost/v1/chat/completions"]).toContain(u.pathname);
  const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
  expect(headers.get("authorization")).toBe("Bearer "+(u.pathname.endsWith("/models")?discoveryKey(row):key(row.id)));expect(headers.has("x-api-key")).toBe(false);
  const t:Transport={input,init,path:u.pathname,method:init?.method??(input instanceof Request?input.method:"GET"),credential:headers.get("authorization"),
   signal:init?.signal!==undefined?init.signal??undefined:input instanceof Request?input.signal:undefined,dispatcher:init?.dispatcher,guardObserved:false,releases:0,releaseDone:false,bodies:[],readers:[],closes:[]};
  ownership.transport(t);if(t.caller!==c)throw Error("foreign invocation caller");
  if(t.method==="POST")expect(c.inferenceInvoked>0&&!c.completed).toBe(true);
  t.signalHistory=signalHistory(t.signal);expect(t.signal).toBeInstanceOf(AbortSignal);expect(t.dispatcher).toBeDefined();transports.push(t);
  const d=t.dispatcher as {close:Function};if(!observedDispatchers.has(d)){observedDispatchers.add(d);const close=d.close;let depth=0;patch(d,"close",function(this:unknown,...args:unknown[]){const outer=depth++===0;try{return outer?invoke("dispatcher_close",()=>Reflect.apply(close,this,args),{dispatcher:d,receiver:this,args}):Reflect.apply(close,this,args);}finally{depth--;}});}
  const o=record("fetch",{transport:t,receiver,args,input,init,callerSignal:c.signal,effectiveSignal:t.signal,callerAbortedAtInvoke:c.signal.aborted});t.fetch=o;
  return {threw(reason:unknown){o.state="threw";o.reason=reason;o.settle=++w.sequence;w.syncFailures.push(reason);},
   returned(pending:Promise<Response>){returned(o,pending);observer(pending.then(response=>{ownership.response(t,response);observeBody(response,t);},()=>{}));}};
 },w.observerFailures);
 const check=async(fn:()=>unknown)=>{try{await fn();}catch(e){failures.push(e);}};
 let bodyEntered=false;
 const setupBoundary=createBifrostSetupBoundary(checkpoints,caseIndex);
 let spy:ReturnType<typeof vi.spyOn>|undefined,spyDescriptor:PropertyDescriptor|undefined,worker=false,proof:any;
 // Undici 8.12.3 publishes the original request/socket pair synchronously.
 // Subscribers never throw or print request headers; they only retain identity.
 const sent=channel("undici:client:sendHeaders");
 const onSent=(message:unknown)=>{try{const {request,socket}=message as any;
  if(row.mode!=="progress"||new URL(request.origin).origin!==origin||request.method!=="POST"||request.path!=="/v1/native/bifrost/v1/chat/completions")return;
  const hs=request.headers;if(!Array.isArray(hs))throw Error("unsupported Undici headers");const auth=[];
  for(let i=0;i<hs.length;i+=2)if(String(hs[i]).toLowerCase()==="authorization")auth.push(hs[i+1]);
  if(auth.length!==1||auth[0]!=="Bearer "+key(row.id))return;
  const ts=transports.filter(t=>t.method==="POST"&&t.credential===auth[0]&&t.path===request.path);if(ts.length!==1||ts[0].socketRequest)throw Error("ambiguous owned socket");
  const t=ts[0];t.socketRequest=request;t.socket=socket;t.socketClosed=new Promise<void>(resolve=>{const closed=()=>{t.socketClosedAt=++w.sequence;resolve();};socket.once("close",closed);restores.push(()=>socket.removeListener("close",closed));});
 }catch(e){w.observerFailures.push(e);}};
 try{
  setupBoundary.enter("caller_install");
  setupCaller();
  setupBoundary.enter("progress_subscribe");
  if(row.mode==="progress"){sent.subscribe(onSent);restores.push(()=>sent.unsubscribe(onSent));}
  setupBoundary.enter("source_env_pin");
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(pin);
  setupBoundary.enter("source_git_pin");
  expect(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()).toBe(pin);
  setupBoundary.enter("poison_env");
  for(const name of ["OPENAI_API_KEY","ANTHROPIC_API_KEY","BIFROST_API_KEY","BIFROST_VIRTUAL_KEY","LITELLM_API_KEY"])vi.stubEnv(name,"synthetic-poison-other-provider");
  setupBoundary.enter("fetch_hook");
  patch(globalThis,"fetch",observingFetch(nativeFetch));
  setupBoundary.enter("undici_hook");
  patch(globalThis,"__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__",{...undici,fetch:observingFetch(nativeUndiciFetch)});
  setupBoundary.enter("guard_hook");
  spy=vi.spyOn(guard,"fetchWithSsrFGuard").mockImplementation(function(this:unknown,...args:Parameters<typeof nativeGuard>){
   const input=args[0],a:any={guard:nativeGuard,input,inputSignal:input.signal??input.init?.signal,invoke:++w.sequence};a.signalHistory=signalHistory(a.inputSignal);w.acquisitions.push(a);
   const o=record("guard",{acquisition:a,receiver:this,args});a.operation=o;let pending:ReturnType<typeof nativeGuard>;
   try{pending=returned(o,ownership.guard(nativeGuard,this,args,a));a.pending=pending;}catch(e){o.state="threw";o.reason=e;o.settle=++w.sequence;w.syncFailures.push(e);throw e;}
   observer(pending.then(result=>{const found=transports.filter(t=>t.response===result.response&&!t.guardObserved);expect(found).toHaveLength(1);const t=found[0];
    expect(new URL(input.url).pathname).toBe(t.path);expect(input.init?.method??"GET").toBe(t.method);expect(new Headers(input.init?.headers).get("authorization")).toBe(t.credential);
    ownership.attach(a,result);
    const release=result.release;patch(result,"release",function(this:unknown,...params:unknown[]){t.releases++;const o=record("guard_release",{acquisition:a,receiver:this,args:params});t.release=o;
     let p;try{p=returned(o,Reflect.apply(release,this,params));}catch(e){o.state="threw";o.reason=e;o.settle=++w.sequence;w.syncFailures.push(e);throw e;}
     observer(p.then(()=>{t.releaseDone=true;},()=>{}));return p;});
   },()=>{}));return pending;
  } as typeof nativeGuard);
  setupBoundary.enter("guard_descriptor");
  spyDescriptor=Object.getOwnPropertyDescriptor(guard,"fetchWithSsrFGuard");
    const store:AuthProfileStore={version:1,profiles:{"bifrost:selected":{type:"api_key",provider:"bifrost",key:row.mode==='profile'?key(row.id):"synthetic-poison-unselected-profile"},"openai:poison":{type:"api_key",provider:"openai",key:"synthetic-unrelated-profile"}}};
    setupBoundary.enter("profile_write");
    await state.writeAuthProfiles(store);
    const config:OpenClawConfig={models:{providers:{bifrost:{baseUrl:origin+"/v1/native/bifrost/v1",api:"openai-completions",auth:"api-key",apiKey:row.mode==='profile'?"bifrost:selected":key(row.id),models:[]}}}};
    // This frozen discovery resolver prefers the environment key. Inference
    // retains the independently configured credential. The profile arm has
    // no discovery environment key and resolves its explicit profile reference.
    const env=row.mode==='profile'?{}:{BIFROST_VIRTUAL_KEY:discoveryKey(row)};
    setupBoundary.enter("discovery_env");
    vi.stubEnv('BIFROST_VIRTUAL_KEY',row.mode==='profile'?undefined:discoveryKey(row));
    setupBoundary.enter("api_key_resolver");
    const resolveProviderApiKey=createProviderApiKeyResolver(env,store,config);
    setupBoundary.enter("auth_resolver");
    const resolveProviderAuth=createProviderAuthResolver(env,store,config);
    setupBoundary.enter("discovery_auth_check");
    expect(resolveProviderApiKey('bifrost').discoveryApiKey).toBe(discoveryKey(row));
    setupBoundary.enter("inference_auth_check");
    expect(resolveProviderAuth('bifrost').apiKey).toBe(key(row.id));
    setupBoundary.enter("facade_load");
    const {default:entry}=await loadBundledPluginFacade<{default:Parameters<typeof registerSingleProviderPlugin>[0]}>({pluginId:"bifrost",artifactBasename:"index.js"});
    setupBoundary.enter("plugin_register");
    const plugin=await registerSingleProviderPlugin(entry);
    setupBoundary.enter("plugin_id_check");
    expect(plugin.id).toBe("bifrost");
    setupBoundary.enter("catalog_check");
    expect(plugin.catalog?.run).toBeTypeOf("function");
    const discover=()=>track("catalog_result",ownership.invoke(c,"discovery",plugin.catalog!.run,plugin.catalog,[{config,env,agentDir:state.agentDir(),workspaceDir:state.workspaceDir,signal:control.signal,
      resolveProviderApiKey,resolveProviderAuth}]));
    bodyEntered=true;await checkpoints.observe(caseIndex,"body",body,undefined,[discover,control,track,resolveProviderAuth("bifrost").apiKey!]);
 }catch(e){if(!bodyEntered){setupBoundary.reject(e);checkpoints.mark(caseIndex,"case_setup","rejected",e);}failures.push(e);}
 checkpoints.mark(caseIndex,"original_join","enter");
 let at=0,seen=0;
 while(at<originals.length||seen<w.observers.length){const batch=originals.slice(at);at=originals.length;await Promise.allSettled(batch.flatMap(o=>o.pending?[o.pending]:[]));
  const observed=w.observers.slice(seen);seen=w.observers.length;for(const r of await Promise.allSettled(observed))if(r.status==="rejected")w.observerFailures.push(r.reason);}
 checkpoints.mark(caseIndex,"original_join","fulfilled");
 w.evidenceJoined=true;
 if(w.observerFailures.length)checkpoints.mark(caseIndex,"observer","rejected",w.observerFailures[0]);
 w.preabortPostDelta=transports.filter(t=>t.method==="POST").length-(c.postsBefore??0);
 if(row.mode==="preabort")await check(()=>expect(transports.filter(t=>t.method==="POST")).toHaveLength(0));
 for(const t of transports){await check(()=>expect(t.guardObserved).toBe(true));await check(()=>expect(t.releases).toBe(1));await check(()=>expect(t.releaseDone).toBe(true));for(const r of t.readers)await check(()=>expect(r.unlocks).toBe(1));for(const b of t.bodies)await check(()=>expect(b.locked).toBe(false));}
 const workerFailures:unknown[]=[];
 checkpoints.mark(caseIndex,"worker_retirement","enter");
 try{const response=await nativeFetch(origin+"/__bifrost/join/"+row.id,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});proof=JSON.parse(await response.text());w.sourceExpired=proof.source?.expired??null;worker=response.status===200&&proof.retired===true;if(!worker)workerFailures.push(Error("independent Worker retirement failed"));}catch(e){workerFailures.push(e);}
 checkpoints.mark(caseIndex,"worker_retirement",workerFailures.length?"rejected":"fulfilled",workerFailures[0]);
 const beforeRestore=failures.length;
 for(const restore of restores.toReversed())await check(()=>checkpoints.observe(caseIndex,"restoration",restore,undefined,[]));
 if(spy)await check(()=>checkpoints.observe(caseIndex,"restoration",()=>{if(!sameBifrostDescriptor(Object.getOwnPropertyDescriptor(guard,"fetchWithSsrFGuard"),spyDescriptor))throw Error("foreign guard descriptor");spy!.mockRestore();},undefined,[]));
 for(const cleanup of [()=>ownership.restore(),()=>vi.unstubAllEnvs(),()=>state.cleanup(),()=>state.restoreEnv()])await check(()=>checkpoints.observe(caseIndex,"cleanup",cleanup,undefined,[]));
 w.restored=failures.length===beforeRestore;
 w.evidenceRestoreFailures=failures.length-beforeRestore;
 w.evidenceRestoreUndefined=failures.slice(beforeRestore).filter(e=>e===undefined).length;
 let allowed:Original[]=[];
 if(row.control){checkpoints.mark(caseIndex,"control","enter");const evaluated=evaluateBifrostNativeControl(w);checkpoints.mark(caseIndex,"control","fulfilled");if(evaluated.qualified&&row.control==="partial")allowed=bifrostStoredErrorVector(w)??[];
  const reports=controlReports.get(row.api)??new Map();try{emitControl(row,w,evaluated,worker);}catch(e){failures.push(e);evaluated.qualified=false;}
  reports.set(row.control,evaluated);controlReports.set(row.api,reports);const q=bifrostQualification([...reports.values()],nativeIdentity,"bifrost",row.api);if(q)qualifications.set(row.api,q);
  if(!evaluated.qualified)failures.push(Error("native control qualification incomplete"));
 }else if(row.mode==="partial"||row.mode==="progress")allowed=bifrostProductExpected(w,qualifications.get(row.api));
 for(const o of originals)if(o.state==="rejected"&&!allowed.includes(o))failures.push(o.reason);else if(o.state==="pending")failures.push(Error("original operation pending"));
 if(row.mode==="progress"){
  const f=bifrostProgressWitness(w,proof,allowed,worker,workerFailures);
  if(!bifrostProgressQualified(f))failures.push(Error("progress case physical or accounting proof incomplete"));
 }
 failures.push(...w.syncFailures,...w.observerFailures,...workerFailures);
 if(failures.length)try{checkpoints.evidence(bifrostCaseEvidence(caseIndex,w,proof,worker,workerFailures));}catch(e){checkpoints.failures.push(e);}
 finishBifrostCheckpointCase(checkpoints,caseIndex,failures);throwFailures(failures);
}

function inference(provider:any,row:Case,signal:AbortSignal,inferenceKey:string) {
  expect(provider.baseUrl).toBe(origin+"/v1/native/bifrost/v1");expect(provider.apiKey).toBe(row.mode==='profile'?"bifrost:selected":key(row.id));expect(inferenceKey).toBe(key(row.id));
  expect(provider.models.length).toBe(1);
  const actual=provider.models[0];expect(actual.id).toBe(row.mode==='account_b'?"tenant/opaque-b":"tenant/opaque-a");
  const model={...actual,provider:"bifrost",api:provider.api,baseUrl:provider.baseUrl} as Model<"openai-completions">;
  const context:Context={messages:[{role:"user",content:"synthetic Bifrost request",timestamp:1}]};
  callerWitnesses.get(signal)!.begin();
  return callerWitnesses.get(signal)!.invoke(row.api==='stream'?stream:streamSimple,undefined,[model,context,{apiKey:inferenceKey,signal,maxTokens:16}]);
}

describe("Bifrost native diagnostic controls before product qualification",()=>{
 const controls=JSON.parse(process.env.CLAWROUTER_BIFROST_CONTROLS!) as Case[];
 for(const row of controls)it(row.id,async()=>{
  await fixture(row,async(discover,controller,track,inferenceKey)=>{
   const catalog=await discover();expect(catalog.provider).toBeDefined();
   if(row.control==="preabort")controller.abort(new Error("synthetic diagnostic preabort"));
   const events=inference(catalog.provider,row,controller.signal,inferenceKey),result=track("inference_result",events.result());
   if(row.control==="partial"){let delivered=false;for await(const event of events)if(event.type==="text_delta"){
    delivered=true;callerWitnesses.get(controller.signal)!.delivered();controller.abort(new Error("synthetic diagnostic partial"));break;}
    expect(delivered).toBe(true);}
   const value=await result;expect(value.stopReason).toBe(row.control==="eof"?"stop":row.control==="partial"?"aborted":"error");
   if(row.control==="preabort")expect(value.content).toEqual([]);
   expect(controller.signal.aborted).toBe(row.control==="preabort"||row.control==="partial");
  });
 },120000);
});

describe("registered Bifrost private discovery and public inference",()=>{
  // The four original controls precede any future cancellation disposition.
  for(const row of cases)it(row.id,async()=>{
    await fixture(row,async(discover,controller,track,inferenceKey)=>{
      const catalog=await discover();
      if(['malformed','loose','error401','error403','redirect','missing_owner','invalid_owner'].includes(row.mode)){
        expect(catalog.provider).toBeUndefined();expect(catalog.outcomes).toContainEqual(expect.objectContaining({provider:'bifrost',status:['error401','error403'].includes(row.mode)?'auth-rejected':'unavailable'}));return;
      }
      expect(catalog.provider).toBeDefined();
      if(row.mode==='empty'){expect(catalog.provider.models).toEqual([]);return;}
      if(row.mode==='revoked'){
        await command(row.id,'mutate',{kind:'caller_revoke'});const denied=await discover();expect(denied.provider).toBeUndefined();expect(denied.outcomes).toContainEqual(expect.objectContaining({status:'auth-rejected'}));return;
      }
      if(row.mode==='rotation')await command(row.id,'mutate',{kind:'rotation'});
      if(row.mode==='preabort')controller.abort(new Error('synthetic original preabort'));
      const resultStream=inference(catalog.provider,row,controller.signal,inferenceKey),resultPromise=track("inference_result",resultStream.result());
      if(row.mode==='partial'){
        let delivered=false;for await(const event of resultStream)if(event.type==='text_delta'){delivered=true;callerWitnesses.get(controller.signal)!.delivered();controller.abort(new Error('synthetic original partial abort'));break;}
        expect(delivered).toBe(true);
      }
      const result=await resultPromise;
      if(row.mode==='preabort'){expect(controller.signal.aborted).toBe(true);expect(result.stopReason).toBe('error');expect(result.content).toEqual([]);}
      else if(row.mode==='partial'){expect(controller.signal.aborted).toBe(true);expect(result.stopReason).toBe('aborted');}
      else if(['provider_error','unpriced'].includes(row.mode)){expect(controller.signal.aborted).toBe(false);expect(result.stopReason).toBe('error');}
      else{expect(controller.signal.aborted).toBe(false);expect(result.stopReason).toBe('stop');expect(result.content).toContainEqual({type:'text',text:'synthetic-prefix'});expect(result.usage).toMatchObject({input:4,output:3,totalTokens:7});}
    });
  },120000);
});

describe("Bifrost progress after original client socket close",()=>{
 const progress=JSON.parse(process.env.CLAWROUTER_BIFROST_PROGRESS!) as Case[];
 for(const row of progress)it(row.id,async()=>{await fixture(row,async(discover,controller,track,inferenceKey)=>{
  const catalog=await discover();expect(catalog.provider).toBeDefined();
  const events=inference(catalog.provider,row,controller.signal,inferenceKey),result=track("inference_result",events.result());let delivered=false;
  for await(const event of events)if(event.type==="text_delta"){
   delivered=true;callerWitnesses.get(controller.signal)!.delivered();controller.abort(new Error("synthetic progress abort"));
   await callerWitnesses.get(controller.signal)!.progress();break;
  }
  expect(delivered).toBe(true);expect(controller.signal.aborted).toBe(true);expect((await result).stopReason).toBe("aborted");
 });},120000);
});
