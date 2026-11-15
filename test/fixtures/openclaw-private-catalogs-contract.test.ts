import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { createProviderApiKeyResolver, createProviderAuthResolver } from "../../src/agents/models-config.providers.secrets.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { AuthProfileStore } from "../../src/agents/auth-profiles/types.js";
import type { DispatcherAwareRequestInit } from "../../src/infra/net/runtime-fetch.js";
import * as guard from "../../src/infra/net/fetch-guard.js";

const pin="e2a8b8d4ec290cd6c035f3568a14e4d7c6433635";
const origin=process.env.CLAWROUTER_CONTRACT_ORIGIN!;
type Provider="baseten"|"arcee"|"novita";
type Control="eof"|"preabort"|"partial"|"provider_error";
type Case={id:string;provider:Provider;group:string;scenario:string;api:"stream"|"simple";workerOnly:boolean;control?:Control};
const rows=JSON.parse(process.env.CLAWROUTER_PRIVATE_CATALOG_CASES!) as Case[];
const controlRows=JSON.parse(process.env.CLAWROUTER_PRIVATE_NATIVE_CONTROLS!) as Case[];
const providers:Provider[]=["baseten","arcee","novita"];
const groups=["stream","simple","empty","opaque","foreign","environment","rotation","revocation","warm","held","request","invalid","preabort","partial"];
const envNames={baseten:"BASETEN_API_KEY",arcee:"ARCEEAI_API_KEY",novita:"NOVITA_API_KEY"};
const nativeFetch=globalThis.fetch,undici=createRequire(import.meta.url)("undici/index.js") as typeof import("undici"),originalUndiciFetch=undici.fetch;
const originalGuard=guard.fetchWithSsrFGuard;
const key=(row:Case,kind="inference",secret="fixture-secret")=>`clawrouter-live-${row.id}_${kind}-${secret}`;
const base=(row:Case,alias=false)=>origin+"/v1/native/"+(alias?"clawrouter-":"")+row.provider;
type Original={kind:string;pending?:Promise<unknown>;returned:unknown;state:"pending"|"fulfilled"|"rejected"|"threw";reason?:unknown;value?:unknown;invoke:number;settle:number;returnAt:number;[key:string]:any};
type Transport={method:string;path:string;credential:string|null;signal:AbortSignal|undefined;dispatcher:any;response?:Response;guardObserved:boolean;releases:number;releaseDone:boolean;[key:string]:any};
// This identity is local to this exact child/module graph. It is never loaded
// from an environment approval flag or carried between SDK/runtime revisions.
const nativeIdentity=Object.freeze({pin,node:process.version,platform:process.platform,arch:process.arch,
 undici:createRequire(import.meta.url)("undici/package.json").version,guard:originalGuard,fetch:originalUndiciFetch});
const controlReports=new Map<string,Map<Control,any>>(),qualifications=new Map<string,any>();
let diagnosticCount=0,diagnosticBytes=0;

// Invocation ownership, not signal equality or a claim about C1's cause.
// Every context is captured at the original call boundary; absent attachment fails closed.
export function createPrivateFetchObserver(fetcher:Function,capture:Function,observerFailures:unknown[]) {
 return function(this:unknown,...args:any[]) {
  const receipt=capture(this,args);let original;
  try{original=Reflect.apply(fetcher,this,args);}catch(reason){
   try{receipt.threw(reason);}catch(error){observerFailures.push(error);}throw reason;
  }
  try{receipt.returned(original);}catch(error){observerFailures.push(error);}return original;
 };
}
export function createPrivateInvocationOwnership(storage:any) {
 const invocations=new WeakSet<object>(),acquisitions=new WeakSet<object>(),transports=new WeakSet<object>(),responses=new WeakMap<object,any>();
 let active=true;
 const current=()=>{const value=storage.getStore();if(!active||!value||!invocations.has(value.invocation))throw Error("incomplete invocation context");return value;};
 const bound=(t:any)=>{const a=t.acquisition,i=t.invocation;
  return active&&transports.has(t)&&acquisitions.has(a)&&invocations.has(i)&&a.invocation===i&&t.context===a.context&&
   t.context?.invocation===i&&t.context?.acquisition===a&&a.transport===t&&(i.kind==="inference"?t.caller===i.caller:t.caller===undefined&&t.catalogInitiator===i.caller)&&t.owner===i.owner;};
 return {
  invoke(caller:any,kind:string,fn:Function,receiver:unknown,args:any[]){
   if(!active||!["discovery","inference"].includes(kind)||caller.kind!==kind||args[kind==="discovery"?0:2]?.signal!==caller.signal)throw Error("incomplete public caller");
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
   t.context=context;t.invocation=context.invocation;t.acquisition=a;t.caller=context.invocation.kind==="inference"?context.invocation.caller:undefined;t.catalogInitiator=context.invocation.kind==="discovery"?context.invocation.caller:undefined;t.owner=context.invocation.owner;
   a.transport=t;transports.add(t);
  },
  response(t:any,response:any){if(!bound(t)||t.response||responses.has(response))throw Error("ambiguous original response");t.response=response;responses.set(response,t);},
  attach(a:any,result:any){const t=a.transport;if(!t||!bound(t)||a.result||responses.get(result.response)!==t||t.response!==result.response)throw Error("incomplete original guard attachment");
   a.result=result;a.response=result.response;t.guardObserved=true;},
  bound,
  restore(){if(!active)throw Error("duplicate invocation restoration");active=false;storage.disable();},
 };
}
export function newPrivateInvocationCaller(owner:any,signal:any,kind:string):any {
 if(!["inference","discovery"].includes(kind))throw Error("invalid invocation kind");
 return {owner,signal,kind,abortCalled:false,completed:false,result:null,pending:[],delivered:0};
}
export function privateControlCaller(w:any):any {
 const callers=w.callers.filter((c:any)=>c.kind==="inference");return callers.length===1?callers[0]:undefined;
}
export function privateInvocationBound(w:any,t:any):boolean {
 const a=t.acquisition,i=t.invocation;
 return !!a&&!!i&&Object.isFrozen(i)&&i.owner===w.owner&&w.callers.includes(i.caller)&&i.signal===i.caller.signal&&
  i.args?.[i.kind==="discovery"?0:2]?.signal===i.signal&&i.kind===(t.method==="POST"?"inference":t.method==="GET"?"discovery":"invalid")&&
  a.invocation===i&&a.context===t.context&&t.context?.invocation===i&&t.context?.acquisition===a&&a.transport===t&&
  (i.kind==="inference"?t.caller===i.caller:t.caller===undefined&&t.catalogInitiator===i.caller)&&
  a.inputSignal===(a.input?.signal??a.input?.init?.signal)&&a.operation?.state==="fulfilled"&&a.pending===a.operation.pending&&a.result?.response===t.response;
}
export function samePrivateDescriptor(a:any,b:any):boolean {
 return !!a&&!!b&&["value","get","set","writable","enumerable","configurable"].every(k=>a[k]===b[k]);
}
export function privateCancelOperand(read:any,cancel:any,caller:any):string {
 if(!Array.isArray(cancel?.args)||cancel.args.length>1)return "invalid";
 if(cancel.args.length===0)return "absent";
 if(cancel.args[0]===undefined)return "undefined";
 if(cancel.args[0]===caller.reason)return "caller";
 if(cancel.args[0]===read.reason)return "read";
 return "invalid";
}
// Pure, predefined vector over the original graph. It does not consult a
// product verdict, learn an allowlist, compare error names or infer C1's cause.
export function privateStoredErrorVector(w:any):any[]|undefined {
 const ts=w.transports.filter((t:any)=>t.method==="POST");if(ts.length!==1)return;
 const t=ts[0],a=t.acquisition,c=t.caller;
 if(!c||c!==privateControlCaller(w)||!privateInvocationBound(w,t)||c.owner!==w.owner||t.owner!==w.owner||!a||a.owner!==w.owner||a.transport!==t||a.response!==t.response||
   a.guard!==w.identity.guard||!a.input||a.inputSignal!==a.input.signal&&a.inputSignal!==a.input.init?.signal||
   !t.guardObserved||!t.response||t.bodies.length!==1||t.readers.length!==1||t.fetch.state!=="fulfilled")return;
 const r=t.readers[0];if(r.transport!==t||r.body!==t.response.body||r.body!==t.bodies[0]||r.owner!==w.owner)return;
 const reads=w.originals.filter((o:any)=>o.kind==="read"&&o.reader===r&&o.state==="rejected"),read=reads[0];
 const closes=w.originals.filter((o:any)=>o.kind==="closed"&&o.reader===r),closed=closes[0];
 const cancels=w.originals.filter((o:any)=>o.kind==="cancel"&&o.reader===r),cancel=cancels[0];
 const prefix=w.originals.find((o:any)=>o.kind==="read"&&o.reader===r&&o.state==="fulfilled"&&o.value?.done===false&&o.value.value?.byteLength>0);
 if(reads.length!==1||closes.length!==1||cancels.length!==1||!prefix||!read||!closed||!cancel||
   read.reason===undefined||closed.state!=="rejected"||cancel.state!=="rejected"||closed.reason!==read.reason||cancel.reason!==read.reason||
   ![read,closed,cancel,prefix].every(o=>o.owner===w.owner&&o.receiver===r.original)||
   closed.pending!==r.closed||privateCancelOperand(read,cancel,c)==="invalid"||
   !c.abortCalled||!c.abortedAfter||!c.noEarlierFailure||c.pending.length!==1||c.pending[0]!==read||
   read.callerAbortedAtInvoke!==false||read.callerAbortedAtSettle!==true||read.effectiveAbortedAtSettle!==true||
   c.signal!==read.callerSignal||t.signal!==read.effectiveSignal||!c.delivered||c.result!=="aborted")return;
 const order=[r.acquired,closed.invoke,prefix.settle,read.invoke,c.delivered,c.abortInvoke,c.abortObserved,read.settle,closed.settle,cancel.invoke,cancel.settle,r.unlockAt];
 if(!order.every(n=>Number.isSafeInteger(n)&&n>0)||!(r.acquired<closed.invoke&&closed.invoke<prefix.settle&&
   prefix.settle<read.invoke&&read.invoke<c.abortInvoke&&c.delivered<c.abortInvoke&&c.abortInvoke<=c.abortObserved&&
   c.abortObserved<read.settle&&c.abortObserved<closed.settle&&Math.max(read.settle,closed.settle)<cancel.invoke&&cancel.invoke<cancel.settle&&
   Math.max(read.settle,closed.settle,cancel.settle)<r.unlockAt))return;
 if(r.unlocks!==1||r.unlockReceiver!==r.original||r.body.locked||r.unlockFailed||t.releases!==1||!t.releaseDone||
   t.release?.state!=="fulfilled"||t.release.acquisition!==a||t.release.receiver!==a.result||
   !(t.release.returnAt>t.release.invoke&&t.release.settle>t.release.returnAt))return;
 const vector=[read,closed,cancel];
 if(w.originals.some((o:any)=>o.state!=="fulfilled"&&!vector.includes(o)))return;
 return vector;
}
export function evaluatePrivateNativeControl(w:any):any {
 const c=privateControlCaller(w),vector=privateStoredErrorVector(w),hard=w.failures.length||w.observerFailures.length||w.syncFailures.length||
  !w.restored||w.sourceExpired!==0||w.originals.some((o:any)=>o.state==="pending"||o.state==="threw")||
  w.transports.some((t:any)=>!privateInvocationBound(w,t)||!t.guardObserved||t.owner!==w.owner||t.acquisition?.owner!==w.owner||t.acquisition?.response!==t.response||
   t.acquisition?.transport!==t||t.acquisition?.guard!==w.identity.guard||t.readers.length!==1||t.bodies.length!==1||
   t.releases!==1||!t.releaseDone||t.release?.state!=="fulfilled"||t.readers.some((r:any)=>r.owner!==w.owner||r.transport!==t||r.body!==t.response?.body||
    r.body!==t.bodies[0]||r.unlocks!==1||r.unlockFailed||r.body.locked||r.unlockReceiver!==r.original||
    w.originals.filter((o:any)=>o.kind==="closed"&&o.reader===r&&o.pending===r.closed&&o.invoke<r.unlockAt).length!==1));
 const strict=w.originals.every((o:any)=>o.state==="fulfilled");
 const posts=w.transports.filter((t:any)=>t.method==="POST").length;
 const role=w.role;
 const matched=role==="partial"?!!vector:role==="preabort"?strict&&w.coldZeroDispatch&&w.preabortPostDelta===0&&c?.abortCalled===true&&c?.signal.aborted===true&&c?.result==="error"&&c?.emptyContent===true&&posts===0:
  (role==="eof"||role==="provider_error")&&strict&&posts===1&&c?.abortCalled===false&&c?.signal.aborted===false&&
   c?.result===(role==="eof"?"stop":"error");
 return {qualified:!hard&&matched===true,vector:vector?"stored_error":"strict",operand:vector?privateCancelOperand(vector[0],vector[2],c):null,
  vectorObserved:!!vector,owner:w.owner,identity:w.identity,provider:w.provider,api:w.api,role};
}
export function privateQualification(reports:any[],identity:any,provider:string,api:string):any {
 const roles=["eof","preabort","partial","provider_error"];
 if(reports.length!==4||new Set(reports.map(r=>r.owner)).size!==4||!roles.every(role=>reports.filter(r=>r.role===role).length===1)||
  reports.some(r=>!r.qualified||r.identity!==identity||r.provider!==provider||r.api!==api))return;
 const partial=reports.find(r=>r.role==="partial");if(partial.vector!=="stored_error")return;
 return Object.freeze({identity,provider,api,roles:Object.freeze(roles),vector:partial.vector,operand:partial.operand});
}
export function privateProductExpected(w:any,q:any):any[] {
 if(!q||q.identity!==w.identity||q.provider!==w.provider||q.api!==w.api||q.vector!=="stored_error"||
   q.roles?.join(",")!=="eof,preabort,partial,provider_error")return [];
 const raw=evaluatePrivateNativeControl({...w,role:"partial"});
 return raw.qualified&&raw.operand===q.operand?privateStoredErrorVector(w)??[]:[];
}
function emitNativeControl(row:Case,w:any,result:any,worker:boolean):void {
 const record={v:1,pin,p:row.provider,a:row.api,r:row.control,q:result.qualified,vect:result.vectorObserved,worker,restore:w.restored,
  rejects:w.originals.filter((o:Original)=>o.state==="rejected").length,pending:w.originals.filter((o:Original)=>o.state==="pending").length};
 const line="PRIVATE_NATIVE_CONTROL "+JSON.stringify(record);
 if(diagnosticCount>=24||Buffer.byteLength(line)>300||diagnosticBytes+Buffer.byteLength(line)+1>8000)throw Error("native diagnostic quota exceeded");
 diagnosticCount++;diagnosticBytes+=Buffer.byteLength(line)+1;console.log(line);
}
function throwFailures(failures:unknown[]):void{if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"private client body and original cleanup failed");}
async function command(row:Case,kind:string,value:unknown={}){const r=await nativeFetch(origin+"/private-control/"+kind+"/"+row.id,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});const text=await r.text();expect(r.status).toBe(200);return JSON.parse(text);}

async function fixture(row:Case,body:(f:Awaited<ReturnType<typeof session>>)=>Promise<void>){
 const state=await createOpenClawTestState({label:"private-catalog-client"});
 const w:any={owner:Object.freeze({id:row.id}),identity:nativeIdentity,provider:row.provider,api:row.api,role:row.control,
  originals:[],observers:[],transports:[],acquisitions:[],callers:[],failures:[],observerFailures:[],syncFailures:[],restored:false,sourceExpired:null,sequence:0};
 const ownership=createPrivateInvocationOwnership(new AsyncLocalStorage());
 const failures:unknown[]=w.failures,originals:Original[]=w.originals,transports:Transport[]=w.transports,restores:Array<()=>void>=[];
 const signalHistory=(signal:AbortSignal|undefined)=>{const history={signal,initial:signal?.aborted??null,invoke:++w.sequence,abort:0,reason:undefined as unknown};
  if(signal){const observed=()=>{history.abort=++w.sequence;history.reason=signal.reason;};if(signal.aborted)observed();else{signal.addEventListener("abort",observed,{once:true});restores.push(()=>signal.removeEventListener("abort",observed));}}return history;};
 const observer=(p:Promise<unknown>)=>{w.observers.push(p.then(()=>{},e=>{w.observerFailures.push(e);}));};
 const record=(kind:string,details:any={})=>{const o:Original={owner:w.owner,kind,invoke:++w.sequence,settle:0,returnAt:0,state:"pending",returned:undefined,...details};originals.push(o);return o;};
 const returned=(o:Original,value:any)=>{o.returned=value;o.returnAt=++w.sequence;
  const settle=(state:Original["state"],v:any)=>{o.state=state;o.settle=++w.sequence;if(state==="rejected")o.reason=v;else o.value=v;
   o.callerAbortedAtSettle=o.callerSignal?.aborted??null;o.effectiveAbortedAtSettle=o.effectiveSignal?.aborted??null;};
  if(value&&typeof value.then==="function"){o.pending=value;observer(value.then((v:any)=>settle("fulfilled",v),(e:unknown)=>settle("rejected",e)));}else settle("fulfilled",value);return value;};
 const track=<T>(kind:string,pending:Promise<T>):Promise<T>=>returned(record(kind),pending);
 const invoke=(kind:string,fn:()=>any,details:any={})=>{const o=record(kind,details);try{return returned(o,fn());}catch(e){o.state="threw";o.reason=e;o.settle=++w.sequence;w.syncFailures.push(e);throw e;}};
 const patch=(object:any,name:string,value:any)=>{const before=Object.getOwnPropertyDescriptor(object,name),ours={configurable:true,writable:true,enumerable:before?.enumerable??false,value};Object.defineProperty(object,name,ours);
  restores.push(()=>{if(!samePrivateDescriptor(Object.getOwnPropertyDescriptor(object,name),ours))throw Error("foreign descriptor replacement");if(before)Object.defineProperty(object,name,before);else delete object[name];});};
 const authoredAborts=new WeakMap<AbortSignal,any[]>();
 const caller=(signal:AbortSignal|undefined,kind:string)=>{const c=newPrivateInvocationCaller(w.owner,signal,kind);w.callers.push(c);
  const history=signal?authoredAborts.get(signal):undefined,prior=history?.at(-1);
  if(signal?.aborted&&prior?.abortedAfter)Object.assign(c,prior,{pending:[]});
  if(signal&&!signal.aborted){const onAbort=()=>{c.abortObserved=++w.sequence;};signal.addEventListener("abort",onAbort,{once:true});restores.push(()=>signal.removeEventListener("abort",onAbort));}return c;};
 const begin=(signal:AbortSignal|undefined)=>{const c=caller(signal,"inference");c.inferenceInvoked=++w.sequence;return c;};
 const finish=(c:any,p:Promise<any>)=>observer(p.then(v=>{c.result=v.stopReason;c.emptyContent=Array.isArray(v.content)&&v.content.length===0;c.completed=true;},()=>{c.completed=true;}));
 const abort=(controller:AbortController,reason:unknown)=>{
  const active=w.callers.filter((c:any)=>c.kind==="inference"&&c.signal===controller.signal&&!c.completed);
  const entry:any={abortCalled:true,noEarlierFailure:!controller.signal.aborted&&!originals.some(o=>o.state==="rejected"||o.state==="threw"),abortInvoke:++w.sequence,reason};
  const history=authoredAborts.get(controller.signal)??[];history.push(entry);authoredAborts.set(controller.signal,history);
  for(const c of active){Object.assign(c,entry);c.pending=originals.filter(o=>o.kind==="read"&&o.state==="pending"&&o.reader.transport.caller===c);}
  const observed=()=>{entry.abortObserved=++w.sequence;};controller.signal.addEventListener("abort",observed,{once:true});
  try{const result=Reflect.apply(controller.abort,controller,[reason]);entry.abortReturn=++w.sequence;entry.abortedAfter=controller.signal.aborted;
   for(const c of active){c.abortReturn=entry.abortReturn;c.abortedAfter=entry.abortedAfter;}return result;
  }catch(e){w.syncFailures.push(e);throw e;}finally{controller.signal.removeEventListener("abort",observed);}};
 const partialCaller=(controller:AbortController)=>{const active=w.callers.filter((c:any)=>c.kind==="inference"&&c.signal===controller.signal&&!c.completed);
  if(active.length!==1)throw Error("ambiguous authored partial invocation");return active[0];};
 const partial=async(controller:AbortController,reason:unknown)=>{const c=partialCaller(controller);c.delivered=++w.sequence;
  if(!originals.some(o=>o.kind==="read"&&o.state==="pending"&&o.reader.transport.caller===c))await new Promise<void>(resolve=>{c.pendingReady=resolve;});abort(controller,reason);};
 // Product calls retain their original immediate abort timing. Only a
 // diagnostic control may wait for a native pending read before authoring it.
 const partialNow=(controller:AbortController,reason:unknown)=>{partialCaller(controller).delivered=++w.sequence;return abort(controller,reason);};
 const observedBodies=new WeakSet<object>(),observedDispatchers=new WeakSet<object>();
 const observeBody=(response:Response,t:Transport)=>{const b=response.body;if(!b||observedBodies.has(b))return;observedBodies.add(b);t.bodies.push(b);
  const cancel=b.cancel,get=b.getReader;patch(b,"cancel",function(this:ReadableStream,...args:Parameters<typeof cancel>){return invoke("body_cancel",()=>Reflect.apply(cancel,this,args),{transport:t,receiver:this,args});});
  patch(b,"getReader",function(this:ReadableStream,...args:any[]){let reader;try{reader=Reflect.apply(get,this,args);}catch(e){w.syncFailures.push(e);throw e;}
   const r:any={owner:w.owner,original:reader,body:b,transport:t,acquired:++w.sequence,unlocks:0,unlockFailed:false};t.readers.push(r);if(this!==b)failures.push(Error("foreign body receiver"));
   try{r.closed=reader.closed;returned(record("closed",{reader:r,receiver:reader,callerSignal:t.caller?.signal,effectiveSignal:t.signal,callerAbortedAtInvoke:t.caller?.signal?.aborted??null}),r.closed);}catch(e){w.syncFailures.push(e);throw e;}
   for(const kind of ["read","cancel"]){const original=reader[kind];patch(reader,kind,function(this:unknown,...args:unknown[]){const c=t.caller;
    const value=invoke(kind,()=>Reflect.apply(original,this,args),{reader:r,receiver:this,args,callerSignal:c?.signal,effectiveSignal:t.signal,callerAbortedAtInvoke:c?.signal?.aborted??null});
    if(kind==="read"&&c?.delivered&&c.pendingReady){const notify=c.pendingReady;c.pendingReady=undefined;notify();}return value;});}
   const release=reader.releaseLock;patch(reader,"releaseLock",function(this:unknown,...args:unknown[]){try{const v=invoke("unlock",()=>Reflect.apply(release,this,args),{reader:r,receiver:this,args});r.unlocks++;r.unlockReceiver=this;r.unlockAt=++w.sequence;return v;}catch(e){r.unlockFailed=true;throw e;}});return reader;});};
 const observedFetch=(fetcher:Function)=>createPrivateFetchObserver(fetcher,(receiver:unknown,args:any[])=>{
  const [input,init]=args as [RequestInfo|URL,DispatcherAwareRequestInit|undefined];
  const u=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);expect(u.origin).toBe(origin);expect(u.search).toBe("");
  expect([base(row)+"/models",base(row,true)+"/models",base(row)+"/chat/completions",base(row,true)+"/chat/completions"]).toContain(u.href);
  const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
  const t:Transport={input,init,path:u.pathname,method:init?.method??(input instanceof Request?input.method:"GET"),credential:headers.get("authorization"),
   signal:init?.signal!==undefined?init.signal??undefined:input instanceof Request?input.signal:undefined,dispatcher:init?.dispatcher,guardObserved:false,releases:0,releaseDone:false,bodies:[],readers:[],closes:[]};
  ownership.transport(t);
  t.signalHistory=signalHistory(t.signal);
  expect(headers.has("x-api-key")).toBe(false);expect(headers.has("x-upstream-url")).toBe(false);expect(["inference","discovery","alternate"].flatMap(kind=>["fixture-secret","rotated-secret","invalid-secret"].map(secret=>"Bearer "+key(row,kind,secret)))).toContain(t.credential);expect(t.signal).toBeInstanceOf(AbortSignal);expect(t.dispatcher).toBeDefined();transports.push(t);
  const d=t.dispatcher as {close:Function};if(!observedDispatchers.has(d)){observedDispatchers.add(d);const close=d.close;let depth=0;patch(d,"close",function(this:unknown,...args:unknown[]){const outer=depth++===0;try{return outer?invoke("dispatcher_close",()=>Reflect.apply(close,this,args),{dispatcher:d,receiver:this,args}):Reflect.apply(close,this,args);}finally{depth--;}});}
  const o=record("fetch",{transport:t,receiver,args,input,init,callerSignal:t.caller?.signal,effectiveSignal:t.signal,callerAbortedAtInvoke:t.caller?.signal?.aborted??null});t.fetch=o;
  return {threw(reason:unknown){o.state="threw";o.reason=reason;o.settle=++w.sequence;w.syncFailures.push(reason);},
   returned(pending:Promise<Response>){returned(o,pending);observer(pending.then(response=>{ownership.response(t,response);observeBody(response,t);},()=>{}));}};
 },w.observerFailures);
 const check=async(fn:()=>unknown)=>{try{await fn();}catch(e){failures.push(e);}};
 let spy:ReturnType<typeof vi.spyOn>|undefined,spyDescriptor:PropertyDescriptor|undefined,worker=false;
 try{
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(pin);expect(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()).toBe(pin);
  for(const name of [...Object.values(envNames),"OPENAI_API_KEY","OPENROUTER_API_KEY"])vi.stubEnv(name,"synthetic-poison-unselected");
  patch(globalThis,"fetch",observedFetch(nativeFetch));patch(globalThis,"__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__",{...undici,fetch:observedFetch(originalUndiciFetch)});
  spy=vi.spyOn(guard,"fetchWithSsrFGuard").mockImplementation(function(this:unknown,...args:Parameters<typeof originalGuard>){
   const input=args[0],a:any={guard:originalGuard,input,inputSignal:input.signal??input.init?.signal,invoke:++w.sequence};a.signalHistory=signalHistory(a.inputSignal);w.acquisitions.push(a);
   const o=record("guard",{acquisition:a,receiver:this,args});a.operation=o;let pending:ReturnType<typeof originalGuard>;
   try{pending=returned(o,ownership.guard(originalGuard,this,args,a));a.pending=pending;}catch(e){o.state="threw";o.reason=e;o.settle=++w.sequence;w.syncFailures.push(e);throw e;}
   observer(pending.then((result:any)=>{const found=transports.filter(t=>t.response===result.response&&!t.guardObserved);expect(found).toHaveLength(1);const t=found[0];
    expect(new URL(input.url).pathname).toBe(t.path);expect(input.init?.method??"GET").toBe(t.method);expect(new Headers(input.init?.headers).get("authorization")).toBe(t.credential);
    ownership.attach(a,result);
    const release=result.release;patch(result,"release",function(this:unknown,...params:unknown[]){t.releases++;const o=record("guard_release",{acquisition:a,receiver:this,args:params});t.release=o;
     let p;try{p=returned(o,Reflect.apply(release,this,params));}catch(e){o.state="threw";o.reason=e;o.settle=++w.sequence;w.syncFailures.push(e);throw e;}
     observer(p.then(()=>{t.releaseDone=true;},()=>{}));return p;});
   },()=>{}));return pending;
  } as typeof originalGuard);spyDescriptor=Object.getOwnPropertyDescriptor(guard,"fetchWithSsrFGuard");
  const f=await session(row,state,track,transports,{begin,finish,abort,partial,partialNow,caller,invoke:ownership.invoke,preabortProof:(cold:boolean,delta:number)=>{w.coldZeroDispatch=cold;w.preabortPostDelta=delta;}});await body(f);
 }catch(e){failures.push(e);}
 // Originals and late observers join before restoration. No outcome is rewritten.
 let at=0,seen=0;
 while(at<originals.length||seen<w.observers.length){const batch=originals.slice(at);at=originals.length;await Promise.allSettled(batch.flatMap(o=>o.pending?[o.pending]:[]));
  const observed=w.observers.slice(seen);seen=w.observers.length;for(const r of await Promise.allSettled(observed))if(r.status==="rejected")w.observerFailures.push(r.reason);}
 if(!row.workerOnly&&row.scenario!=="cold")await check(()=>expect(transports.some(t=>t.method==="GET")).toBe(true));
 if(["eof","provider_error","environment","rotation","caller_revoke","grant_revoke","unpriced","foreign_inference","stream_abort","simple_abort"].includes(row.scenario))await check(()=>expect(transports.some(t=>t.method==="POST")).toBe(true));
 for(const t of transports){await check(()=>expect(t.guardObserved).toBe(true));await check(()=>expect(t.releases).toBe(1));await check(()=>expect(t.releaseDone).toBe(true));for(const r of t.readers)await check(()=>expect(r.unlocks).toBe(1));for(const b of t.bodies)await check(()=>expect(b.locked).toBe(false));}
 const workerFailures:unknown[]=[];
 try{const response=await nativeFetch(origin+"/private-control/join/"+row.id,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});const text=await response.text();const proof=JSON.parse(text);w.sourceExpired=proof.source?.expired??null;worker=response.status===200&&proof.retired===true;if(!worker)workerFailures.push(Error("independent Worker retirement failed"));}catch(e){workerFailures.push(e);}
 const beforeRestore=failures.length;
 for(const restore of restores.toReversed())await check(restore);
 if(spy)await check(()=>{if(!samePrivateDescriptor(Object.getOwnPropertyDescriptor(guard,"fetchWithSsrFGuard"),spyDescriptor))throw Error("foreign guard descriptor");spy!.mockRestore();});
 for(const cleanup of [()=>ownership.restore(),()=>vi.unstubAllEnvs(),()=>state.cleanup(),()=>state.restoreEnv()])await check(cleanup);
 w.restored=failures.length===beforeRestore;
 let allowed:Original[]=[];
 if(row.control){const evaluated=evaluatePrivateNativeControl(w);if(evaluated.qualified&&row.control==="partial")allowed=privateStoredErrorVector(w)??[];
  const k=row.provider+":"+row.api,reports=controlReports.get(k)??new Map();
  try{emitNativeControl(row,w,evaluated,worker);}catch(e){failures.push(e);evaluated.qualified=false;}
  reports.set(row.control,evaluated);controlReports.set(k,reports);
  const qualified=privateQualification([...reports.values()],nativeIdentity,row.provider,row.api);if(qualified)qualifications.set(k,qualified);
  if(!evaluated.qualified)failures.push(Error("native control qualification incomplete"));
 }else if(row.scenario==="stream_abort"||row.scenario==="simple_abort")allowed=privateProductExpected(w,qualifications.get(row.provider+":"+row.api));
 for(const o of originals)if(o.state==="rejected"&&!allowed.includes(o))failures.push(o.reason);else if(o.state==="pending")failures.push(Error("original operation pending"));
 failures.push(...w.syncFailures,...w.observerFailures,...workerFailures);throwFailures(failures);
}

async function session(row:Case,state:Awaited<ReturnType<typeof createOpenClawTestState>>,track:<T>(kind:string,p:Promise<T>)=>Promise<T>,transports:Transport[],witness:any){
 const {default:entry}=await loadBundledPluginFacade<{default:Parameters<typeof registerSingleProviderPlugin>[0]}>({pluginId:row.provider,artifactBasename:"index.js"});
 const plugin=await registerSingleProviderPlugin(entry);expect(plugin.id).toBe(row.provider);expect(plugin.catalog?.run).toBeTypeOf("function");
 const store:AuthProfileStore={version:1,profiles:{[row.provider+":selected"]:{type:"api_key",provider:row.provider,key:key(row,"discovery")},[row.provider+":other-label"]:{type:"api_key",provider:row.provider,key:key(row,"discovery")},"openai:poison":{type:"api_key",provider:"openai",key:"synthetic-foreign-profile"}}};await state.writeAuthProfiles(store);
 // Baseten selects configured auth first. Its env marker resolves the selected
 // discovery bytes; inference still receives a separate explicit proxy key.
 const discover=(options:{secret?:string;credential?:string;alias?:boolean;signal?:AbortSignal;profile?:string}={})=>{
  const config:OpenClawConfig={models:{providers:{[row.provider]:{baseUrl:base(row,options.alias),api:"openai-completions",apiKey:options.profile??(row.provider==="baseten"?envNames.baseten:key(row,"inference",options.secret)),models:[]}}}};
  const env=options.profile?{}:{[envNames[row.provider]]:options.credential??key(row,"discovery",options.secret)};
  const resolveProviderApiKey=createProviderApiKeyResolver(env,store,config),resolveProviderAuth=createProviderAuthResolver(env,store,config);
  const selected=row.provider==="baseten"?resolveProviderAuth(row.provider):resolveProviderApiKey(row.provider);
  expect(selected.discoveryApiKey).toBe(options.profile?key(row,"discovery"):options.credential??key(row,"discovery",options.secret));
  return track("catalog_result",witness.invoke(witness.caller(options.signal,"discovery"),"discovery",plugin.catalog!.run,plugin.catalog,[{config,env,agentDir:state.agentDir(),workspaceDir:state.workspaceDir,signal:options.signal,resolveProviderApiKey,resolveProviderAuth}]));
 };
 const infer=(provider:any,options:{signal?:AbortSignal;credential?:string;api?:"stream"|"simple"}={})=>{
  expect([base(row),base(row,true)]).toContain(provider.baseUrl);expect(provider.api).toBe("openai-completions");
  const actual=provider.models.find((m:{id:string})=>m.id==="tenant/opaque-a");expect(actual).toBeDefined();
  const model={...actual,provider:row.provider,api:provider.api,baseUrl:provider.baseUrl} as Model<"openai-completions">;
  const context:Context={messages:[{role:"user",content:"synthetic private catalog request",timestamp:1}]};
  const which=options.api??row.api,plain=which==="stream"?stream:streamSimple;
  const hook=which==="stream"?plugin.wrapStreamFn:plugin.wrapSimpleCompletionStreamFn;
  const fn=row.provider==="baseten"?(expect(hook).toBeTypeOf("function"),hook!({streamFn:plain,sourceApi:model.api,modelId:model.id,config:{},providerId:row.provider} as Parameters<NonNullable<typeof hook>>[0])):plain;
  if(row.provider!=="baseten")expect(hook).toBeUndefined();
  const caller=witness.begin(options.signal);const result=witness.invoke(caller,"inference",fn!,undefined,[model,context,{apiKey:options.credential??key(row),signal:options.signal,maxTokens:16}]);const pending=track("inference_result",result.result());witness.finish(caller,pending);return {stream:result,result:pending};
 };
 return {discover,infer,transports,...witness};
}
function ready(result:any){expect(result.provider).toBeDefined();expect(result.provider.models.map((m:{id:string})=>m.id)).toContain("tenant/opaque-a");return result.provider;}
function failedCatalog(result:any,status:"auth-rejected"|"unavailable"){expect(result.provider).toBeUndefined();expect(Object.keys(result.providers??{})).toEqual([]);expect(result.outcomes).toContainEqual(expect.objectContaining({status}));}
async function completeInference(f:Awaited<ReturnType<typeof session>>,provider:any,options:Parameters<typeof f.infer>[1]={}){const result=f.infer(provider,options),value=await result.result;expect(value.stopReason).toBe("stop");expect(value.content).toContainEqual({type:"text",text:"private-prefix"});expect(value.usage).toMatchObject({input:4,output:3,totalTokens:7});return value;}
async function waitPrefix(row:Case){const end=Date.now()+5000;while(Date.now()<end){if((await command(row,"state")).prefix)return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error("owned prefix not observed");}

async function exercise(row:Case){await fixture(row,async f=>{
 const {scenario:s}=row;
 if(row.workerOnly){const path=base(row)+"/models"+(s==="query"?"?page=2":""),r=await nativeFetch(path,{method:s==="query"?"GET":"POST",headers:{authorization:"Bearer "+key(row),"content-type":"application/json"},...(s==="query"?{}:{body:JSON.stringify(s==="body"?{account:"foreign"}:{})})});await r.arrayBuffer();expect([400,405]).toContain(r.status);expect((await command(row,"state")).calls).toBe(0);expect(f.transports).toHaveLength(0);return;}
 if(s==="foreign_discovery"){failedCatalog(await f.discover({credential:key(row,"discovery","invalid-secret")}),"auth-rejected");expect((await command(row,"state")).calls).toBe(0);return;}
 if(s==="cold"){const c=new AbortController();c.abort(new Error("synthetic preabort"));failedCatalog(await f.discover({signal:c.signal}),"unavailable");expect(f.transports).toHaveLength(0);expect((await command(row,"state")).calls).toBe(0);return;}
 if(s==="shared_abort"){
  const c=new AbortController(),original=f.discover({signal:c.signal}),survivor=f.discover();let bodyError=false,error:unknown;
  try{await waitPrefix(row);c.abort(new Error("synthetic shared waiter abort"));failedCatalog(await original,"unavailable");expect(c.signal.aborted).toBe(true);}catch(e){bodyError=true;error=e;}
  const failures:unknown[]=[];if(bodyError)failures.push(error);try{await command(row,"complete");}catch(e){failures.push(e);}try{ready(await survivor);}catch(e){failures.push(e);}throwFailures(failures);return;
 }
 if(["redirect","malformed","truncated","oversize"].includes(s)){failedCatalog(await f.discover(),"unavailable");expect((await command(row,"state")).calls).toBe(1);return;}
 const catalog=await f.discover();
 if(s==="empty"){expect(catalog.provider.models).toEqual([]);expect((await f.discover()).provider.models).toEqual([]);expect((await command(row,"state")).calls).toBe(1);return;}
 if(s==="narrow"){expect(catalog.provider.models).toEqual([]);return;}
 const provider=ready(catalog);
 if(s==="broaden"){expect(provider.models.map((m:{id:string})=>m.id)).toEqual(["tenant/opaque-a"]);return;}
 if(s==="unpriced"){expect(provider.models[0].cost).toMatchObject({input:0,output:0});const value=await f.infer(provider).result;expect(value.stopReason).toBe("error");expect((await command(row,"state")).calls).toBe(1);return;}
 if(s==="warm"){await f.discover();expect((await command(row,"state")).calls).toBe(1);await f.discover({profile:row.provider+":selected"});await f.discover({profile:row.provider+":other-label"});expect((await command(row,"state")).calls).toBe(1);await f.discover({alias:true});expect((await command(row,"state")).calls).toBe(2);await f.discover({credential:key(row,"alternate")});expect((await command(row,"state")).calls).toBe(3);return;}
 if(s==="warm_abort"){const c=new AbortController();c.abort(new Error("synthetic warm preabort"));failedCatalog(await f.discover({signal:c.signal}),"unavailable");expect((await command(row,"state")).calls).toBe(1);return;}
 if(s==="caller_revoke"||s==="grant_revoke"){await command(row,"mutate",{kind:s});const value=await f.infer(provider).result;expect(value.stopReason).toBe("error");expect((await command(row,"state")).calls).toBe(1);const denied=await f.discover({alias:true});failedCatalog(denied,s==="caller_revoke"?"auth-rejected":"unavailable");return;}
 if(s==="rotation"){await command(row,"mutate",{kind:"rotation"});const before=(await command(row,"state")).calls;expect((await f.infer(provider).result).stopReason).toBe("error");expect((await command(row,"state")).calls).toBe(before);const current=ready(await f.discover({secret:"rotated-secret"}));await completeInference(f,current,{credential:key(row,"inference","rotated-secret")});return;}
 if(s==="foreign_inference"){expect((await f.infer(provider,{credential:key(row,"inference","invalid-secret")}).result).stopReason).toBe("error");expect((await command(row,"state")).calls).toBe(1);return;}
 if(s==="inference_abort"){const c=new AbortController();c.abort(new Error("synthetic inference preabort"));const result=await f.infer(provider,{signal:c.signal}).result;expect(result.stopReason).toBe("error");expect(result.content).toEqual([]);expect(f.transports.filter(t=>t.method==="POST")).toHaveLength(0);expect((await command(row,"state")).calls).toBe(1);return;}
 if(s==="stream_abort"||s==="simple_abort"){const c=new AbortController(),pending=f.infer(provider,{signal:c.signal});let partial=false;for await(const event of pending.stream){if(event.type==="text_delta"){partial=true;f.partialNow(c,new Error("synthetic original caller abort"));break;}}expect(partial).toBe(true);expect((await pending.result).stopReason).toBe("aborted");return;}
 if(s==="provider_error"){const c=new AbortController();expect((await f.infer(provider,{signal:c.signal}).result).stopReason).toBe("error");expect(c.signal.aborted).toBe(false);return;}
 await completeInference(f,provider);
});}

async function diagnosticControl(row:Case){await fixture(row,async f=>{
 const controller=new AbortController();
 if(row.control==="preabort"){
  const cold=new AbortController();f.abort(cold,new Error("synthetic cold preabort"));
  failedCatalog(await f.discover({signal:cold.signal}),"unavailable");expect(f.transports).toHaveLength(0);
  const coldZero=(await command(row,"state")).calls===0;expect(coldZero).toBe(true);
  const provider=ready(await f.discover()),before=f.transports.filter((t:Transport)=>t.method==="POST").length;
  f.abort(controller,new Error("synthetic inference preabort"));
  const result=await f.infer(provider,{signal:controller.signal}).result;expect(result.stopReason).toBe("error");expect(result.content).toEqual([]);
  const delta=f.transports.filter((t:Transport)=>t.method==="POST").length-before;expect(delta).toBe(0);f.preabortProof(coldZero,delta);return;
 }
 const provider=ready(await f.discover()),pending=f.infer(provider,{signal:controller.signal});
 if(row.control==="partial"){
  let delivered=false;for await(const event of pending.stream)if(event.type==="text_delta"){delivered=true;await f.partial(controller,new Error("synthetic diagnostic caller abort"));break;}
  expect(delivered).toBe(true);expect((await pending.result).stopReason).toBe("aborted");return;
 }
 const result=await pending.result;expect(controller.signal.aborted).toBe(false);
 expect(result.stopReason).toBe(row.control==="provider_error"?"error":"stop");
 if(row.control==="eof"){expect(result.content).toContainEqual({type:"text",text:"private-prefix"});expect(result.usage).toMatchObject({input:4,output:3,totalTokens:7});}
});}

describe.sequential("registered private catalogs with native Worker and SQLite",()=>{
 // These are diagnostic tests, not replacements for the 42 product groups.
 // The registry cannot qualify an API until all four fresh controls restore.
 for(const provider of providers)for(const api of ["stream","simple"] as const)for(const role of ["eof","preabort","partial","provider_error"] as const)
  it("native diagnostic "+provider+" "+api+" "+role,async()=>{
   const selected=controlRows.filter(r=>r.provider===provider&&r.api===api&&r.control===role);expect(selected).toHaveLength(1);await diagnosticControl(selected[0]);
  });
 for(const provider of providers)for(const group of groups)it(provider+" "+group,async()=>{
  const selected=rows.filter(r=>r.provider===provider&&r.group===group);expect(selected.length).toBeGreaterThan(0);
  // Forty-two registrations retain every expanded scenario. They do not replace
  // individual request assertions or enlarge native runner/child time limits.
  for(const row of selected)await exercise(row);
 });
});
