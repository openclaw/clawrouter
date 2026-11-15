import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
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
export function bifrostCancelOperand(read:any,cancel:any,caller:any):string {
 if(!Array.isArray(cancel?.args)||cancel.args.length>1)return "invalid";
 if(cancel.args.length===0)return "absent";
 if(cancel.args[0]===undefined)return "undefined";
 if(cancel.args[0]===caller.reason)return "caller";
 if(cancel.args[0]===read.reason)return "read";
 return "invalid";
}
// Pure, predefined vector over the original graph. It does not consult a
// product verdict, learn an allowlist, compare error names or infer C1's cause.
export function bifrostStoredErrorVector(w:any):any[]|undefined {
 const ts=w.transports.filter((t:any)=>t.method==="POST");if(ts.length!==1)return;
 const t=ts[0],a=t.acquisition,c=w.caller;
 if(!c||!bifrostInvocationBound(w,t)||c.owner!==w.owner||t.owner!==w.owner||!a||a.owner!==w.owner||a.transport!==t||a.response!==t.response||
   a.guard!==w.identity.guard||a.operation?.state!=="fulfilled"||a.pending!==a.operation.pending||a.result?.response!==t.response||!a.input||a.inputSignal!==a.input.signal&&a.inputSignal!==a.input.init?.signal||
   !t.guardObserved||!t.response||t.bodies.length!==1||t.readers.length!==1||t.fetch.state!=="fulfilled")return;
 const r=t.readers[0];if(r.transport!==t||r.body!==t.response.body||r.body!==t.bodies[0]||r.owner!==w.owner)return;
 const reads=w.originals.filter((o:any)=>o.kind==="read"&&o.reader===r&&o.state==="rejected"),read=reads[0];
 const closes=w.originals.filter((o:any)=>o.kind==="closed"&&o.reader===r),closed=closes[0];
 const cancels=w.originals.filter((o:any)=>o.kind==="cancel"&&o.reader===r),cancel=cancels[0];
 const prefix=w.originals.find((o:any)=>o.kind==="read"&&o.reader===r&&o.state==="fulfilled"&&o.value?.done===false&&o.value.value?.byteLength>0);
 if(reads.length!==1||closes.length!==1||cancels.length!==1||!prefix||!read||!closed||!cancel||
   (read.reason===undefined||read.reason===null||typeof read.reason!=="object")||closed.state!=="rejected"||cancel.state!=="rejected"||closed.reason!==read.reason||cancel.reason!==read.reason||
   ![read,closed,cancel,prefix].every(o=>o.owner===w.owner&&o.receiver===r.original)||
   closed.pending!==r.closed||bifrostCancelOperand(read,cancel,c)==="invalid"||
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
export function evaluateBifrostNativeControl(w:any):any {
 const vector=bifrostStoredErrorVector(w),hard=w.failures.length||w.observerFailures.length||w.syncFailures.length||
  !w.restored||w.sourceExpired!==0||w.originals.some((o:any)=>o.state==="pending"||o.state==="threw")||
  w.transports.some((t:any)=>!bifrostInvocationBound(w,t)||!t.guardObserved||t.owner!==w.owner||t.acquisition?.owner!==w.owner||t.acquisition?.response!==t.response||
   t.acquisition?.transport!==t||t.acquisition?.guard!==w.identity.guard||t.acquisition?.operation?.state!=="fulfilled"||t.acquisition?.pending!==t.acquisition?.operation?.pending||t.acquisition?.result?.response!==t.response||t.readers.length!==1||t.bodies.length!==1||
   t.releases!==1||!t.releaseDone||t.release?.state!=="fulfilled"||t.readers.some((r:any)=>r.owner!==w.owner||r.transport!==t||r.body!==t.response?.body||
    r.body!==t.bodies[0]||r.unlocks!==1||r.unlockFailed||r.body.locked||r.unlockReceiver!==r.original||
    w.originals.filter((o:any)=>o.kind==="closed"&&o.reader===r&&o.pending===r.closed&&o.invoke<r.unlockAt).length!==1));
 const strict=w.originals.every((o:any)=>o.state==="fulfilled");
 const posts=w.transports.filter((t:any)=>t.method==="POST").length,gets=w.transports.filter((t:any)=>t.method==="GET").length;
 const role=w.role;
 const matched=role==="partial"?!!vector:role==="preabort"?strict&&w.preabortPostDelta===0&&w.caller?.abortCalled===true&&w.caller?.signal.aborted===true&&w.caller?.result==="aborted":
  (role==="eof"||role==="provider_error")&&strict&&posts===1&&w.caller?.abortCalled===false&&w.caller?.signal.aborted===false&&
   w.caller?.result===(role==="eof"?"stop":"error");
 return {qualified:!hard&&gets===1&&matched===true,vector:vector?"stored_error":"strict",operand:vector?bifrostCancelOperand(vector[0],vector[2],w.caller):null,
  vectorObserved:!!vector,owner:w.owner,identity:w.identity,provider:w.provider,api:w.api,role};
}
export function bifrostQualification(reports:any[],identity:any,provider:string,api:string):any {
 const roles=["eof","preabort","partial","provider_error"];
 if(reports.length!==4||new Set(reports.map(r=>r.owner)).size!==4||!roles.every(role=>reports.filter(r=>r.role===role).length===1)||
  reports.some(r=>!r.qualified||r.identity!==identity||r.provider!==provider||r.api!==api))return;
 const partial=reports.find(r=>r.role==="partial");if(partial.vector!=="stored_error")return;
 return Object.freeze({identity,provider,api,roles:Object.freeze(roles),vector:partial.vector,operand:partial.operand});
}
export function bifrostProductExpected(w:any,q:any):any[] {
 if(!q||q.identity!==w.identity||q.provider!==w.provider||q.api!==w.api||q.vector!=="stored_error"||
   q.roles?.join(",")!=="eof,preabort,partial,provider_error")return [];
 const raw=evaluateBifrostNativeControl({...w,role:"partial"});
 return raw.qualified&&raw.operand===q.operand?bifrostStoredErrorVector(w)??[]:[];
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
async function command(id:string,kind:string,body:unknown={}) {
 const response=await nativeFetch(origin+"/__bifrost/"+kind+"/"+id,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 const text=await response.text();expect(response.status).toBe(200);return JSON.parse(text);
}
function throwFailures(failures:unknown[]):void{if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"Bifrost originals and cleanup failed");}

async function fixture(row:Case,body:(discover:()=>Promise<any>,control:AbortController,track:<T>(kind:string,p:Promise<T>)=>Promise<T>,inferenceKey:string)=>Promise<void>){
 const state=await createOpenClawTestState({label:"bifrost-worker-contract"}),control=new AbortController();
 const w:any={owner:Object.freeze({id:row.id}),identity:nativeIdentity,provider:"bifrost",api:row.api,role:row.control,
  originals:[],observers:[],transports:[],acquisitions:[],failures:[],observerFailures:[],syncFailures:[],restored:false,sourceExpired:null,sequence:0};
 const ownership=createBifrostInvocationOwnership(new AsyncLocalStorage());
 const failures:unknown[]=w.failures,originals:Original[]=w.originals,transports:Transport[]=w.transports,restores:Array<()=>void>=[];
 const observer=(p:Promise<unknown>)=>{w.observers.push(p.then(()=>{},e=>{w.observerFailures.push(e);}));};
 const record=(kind:string,details:any={})=>{const o:Original={owner:w.owner,kind,invoke:++w.sequence,settle:0,returnAt:0,state:"pending",returned:undefined,...details};originals.push(o);return o;};
 const returned=(o:Original,value:any)=>{o.returned=value;o.returnAt=++w.sequence;
  const settle=(state:Original["state"],v:any)=>{o.state=state;o.settle=++w.sequence;if(state==="rejected")o.reason=v;else o.value=v;
   o.callerAbortedAtSettle=o.callerSignal?.aborted??null;o.effectiveAbortedAtSettle=o.effectiveSignal?.aborted??null;};
  if(value&&typeof value.then==="function"){o.pending=value;observer(value.then((v:any)=>settle("fulfilled",v),(e:unknown)=>settle("rejected",e)));}else settle("fulfilled",value);return value;};
 const track=<T>(kind:string,p:Promise<T>):Promise<T>=>{if(kind==="inference_result")observer(p.then((v:any)=>{w.caller.result=v.stopReason;w.caller.completed=true;},()=>{w.caller.completed=true;}));return returned(record(kind),p);};
 const invoke=(kind:string,fn:()=>any,details:any={})=>{const o=record(kind,details);try{return returned(o,fn());}catch(e){o.state="threw";o.reason=e;o.settle=++w.sequence;w.syncFailures.push(e);throw e;}};
 const patch=(object:any,name:string,value:any)=>{const before=Object.getOwnPropertyDescriptor(object,name),ours={configurable:true,writable:true,enumerable:before?.enumerable??false,value};Object.defineProperty(object,name,ours);
  restores.push(()=>{if(!sameBifrostDescriptor(Object.getOwnPropertyDescriptor(object,name),ours))throw Error("foreign descriptor replacement");if(before)Object.defineProperty(object,name,before);else delete object[name];});};
 const signalHistory=(signal:AbortSignal|undefined)=>{const h:any={signal,initial:signal?.aborted??null,invoke:++w.sequence,abort:0};if(signal){const onAbort=()=>{h.abort=++w.sequence;h.reason=signal.reason;};if(signal.aborted)onAbort();else{signal.addEventListener("abort",onAbort,{once:true});restores.push(()=>signal.removeEventListener("abort",onAbort));}}return h;};
 const c:any={owner:w.owner,signal:control.signal,abortCalled:false,completed:false,result:null,pending:[],delivered:0};w.caller=c;
 const setupCaller=()=>{
 const aborted=()=>{c.abortObserved=++w.sequence;};control.signal.addEventListener("abort",aborted,{once:true});restores.push(()=>control.signal.removeEventListener("abort",aborted));
 const abort=control.abort;patch(control,"abort",function(this:AbortController,...args:Parameters<typeof abort>){
  if(this!==control)throw Error("foreign original caller");c.abortCalled=true;c.noEarlierFailure=!control.signal.aborted&&!originals.some(o=>o.state==="rejected"||o.state==="threw");
  c.pending=originals.filter(o=>o.kind==="read"&&o.state==="pending"&&o.reader.transport.caller===c);c.abortInvoke=++w.sequence;c.reason=args[0];
  try{const value=Reflect.apply(abort,this,args);c.abortReturn=++w.sequence;c.abortedAfter=control.signal.aborted;return value;}catch(e){w.syncFailures.push(e);throw e;}});
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
 const observingFetch=(fetcher:Function,receiver:unknown)=>(input:RequestInfo|URL,init?:DispatcherAwareRequestInit):Promise<Response>=>{
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
  const o=record("fetch",{transport:t,receiver,input,init,callerSignal:c.signal,effectiveSignal:t.signal,callerAbortedAtInvoke:c.signal.aborted});t.fetch=o;let pending:Promise<Response>;
  try{pending=returned(o,Reflect.apply(fetcher,receiver,[input,init]));}catch(e){o.state="threw";o.reason=e;o.settle=++w.sequence;w.syncFailures.push(e);throw e;}
  observer(pending.then(response=>{ownership.response(t,response);observeBody(response,t);},()=>{}));return pending;};
 const check=async(fn:()=>unknown)=>{try{await fn();}catch(e){failures.push(e);}};
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
  setupCaller();
  if(row.mode==="progress"){sent.subscribe(onSent);restores.push(()=>sent.unsubscribe(onSent));}
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(pin);expect(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()).toBe(pin);
  for(const name of ["OPENAI_API_KEY","ANTHROPIC_API_KEY","BIFROST_API_KEY","BIFROST_VIRTUAL_KEY","LITELLM_API_KEY"])vi.stubEnv(name,"synthetic-poison-other-provider");
  patch(globalThis,"fetch",observingFetch(nativeFetch,globalThis));patch(globalThis,"__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__",{...undici,fetch:observingFetch(nativeUndiciFetch,undici)});
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
  } as typeof nativeGuard);spyDescriptor=Object.getOwnPropertyDescriptor(guard,"fetchWithSsrFGuard");
    const store:AuthProfileStore={version:1,profiles:{"bifrost:selected":{type:"api_key",provider:"bifrost",key:row.mode==='profile'?key(row.id):"synthetic-poison-unselected-profile"},"openai:poison":{type:"api_key",provider:"openai",key:"synthetic-unrelated-profile"}}};
    await state.writeAuthProfiles(store);
    const config:OpenClawConfig={models:{providers:{bifrost:{baseUrl:origin+"/v1/native/bifrost/v1",api:"openai-completions",apiKey:row.mode==='profile'?"bifrost:selected":key(row.id),models:[]}}}};
    // This frozen discovery resolver prefers the environment key. Inference
    // retains the independently configured credential. The profile arm has
    // no discovery environment key and resolves its explicit profile reference.
    const env=row.mode==='profile'?{}:{BIFROST_VIRTUAL_KEY:discoveryKey(row)};
    vi.stubEnv('BIFROST_VIRTUAL_KEY',row.mode==='profile'?undefined:discoveryKey(row));
    const resolveProviderApiKey=createProviderApiKeyResolver(env,store,config),resolveProviderAuth=createProviderAuthResolver(env,store,config);
    expect(resolveProviderApiKey('bifrost').discoveryApiKey).toBe(discoveryKey(row));
    expect(resolveProviderAuth('bifrost').apiKey).toBe(key(row.id));
    const {default:entry}=await loadBundledPluginFacade<{default:Parameters<typeof registerSingleProviderPlugin>[0]}>({pluginId:"bifrost",artifactBasename:"index.js"});
    const plugin=await registerSingleProviderPlugin(entry);expect(plugin.id).toBe("bifrost");expect(plugin.catalog?.run).toBeTypeOf("function");
    const discover=()=>track("catalog_result",ownership.invoke(c,"discovery",plugin.catalog!.run,plugin.catalog,[{config,env,agentDir:state.agentDir(),workspaceDir:state.workspaceDir,signal:control.signal,
      resolveProviderApiKey,resolveProviderAuth}]));
    await body(discover,control,track,resolveProviderAuth("bifrost").apiKey!);
 }catch(e){failures.push(e);}
 let at=0,seen=0;
 while(at<originals.length||seen<w.observers.length){const batch=originals.slice(at);at=originals.length;await Promise.allSettled(batch.flatMap(o=>o.pending?[o.pending]:[]));
  const observed=w.observers.slice(seen);seen=w.observers.length;for(const r of await Promise.allSettled(observed))if(r.status==="rejected")w.observerFailures.push(r.reason);}
 w.preabortPostDelta=transports.filter(t=>t.method==="POST").length-(c.postsBefore??0);
 for(const t of transports){await check(()=>expect(t.guardObserved).toBe(true));await check(()=>expect(t.releases).toBe(1));await check(()=>expect(t.releaseDone).toBe(true));for(const r of t.readers)await check(()=>expect(r.unlocks).toBe(1));for(const b of t.bodies)await check(()=>expect(b.locked).toBe(false));}
 const workerFailures:unknown[]=[];
 try{const response=await nativeFetch(origin+"/__bifrost/join/"+row.id,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});proof=JSON.parse(await response.text());w.sourceExpired=proof.source?.expired??null;worker=response.status===200&&proof.retired===true;if(!worker)workerFailures.push(Error("independent Worker retirement failed"));}catch(e){workerFailures.push(e);}
 const beforeRestore=failures.length;
 for(const restore of restores.toReversed())await check(restore);
 if(spy)await check(()=>{if(!sameBifrostDescriptor(Object.getOwnPropertyDescriptor(guard,"fetchWithSsrFGuard"),spyDescriptor))throw Error("foreign guard descriptor");spy!.mockRestore();});
 for(const cleanup of [()=>ownership.restore(),()=>vi.unstubAllEnvs(),()=>state.cleanup(),()=>state.restoreEnv()])await check(cleanup);
 w.restored=failures.length===beforeRestore;
 let allowed:Original[]=[];
 if(row.control){const evaluated=evaluateBifrostNativeControl(w);if(evaluated.qualified&&row.control==="partial")allowed=bifrostStoredErrorVector(w)??[];
  const reports=controlReports.get(row.api)??new Map();try{emitControl(row,w,evaluated,worker);}catch(e){failures.push(e);evaluated.qualified=false;}
  reports.set(row.control,evaluated);controlReports.set(row.api,reports);const q=bifrostQualification([...reports.values()],nativeIdentity,"bifrost",row.api);if(q)qualifications.set(row.api,q);
  if(!evaluated.qualified)failures.push(Error("native control qualification incomplete"));
 }else if(row.mode==="partial"||row.mode==="progress")allowed=bifrostProductExpected(w,qualifications.get(row.api));
 for(const o of originals)if(o.state==="rejected"&&!allowed.includes(o))failures.push(o.reason);else if(o.state==="pending")failures.push(Error("original operation pending"));
 if(row.mode==="progress"){
  const f=bifrostProgressWitness(w,proof,allowed,worker,workerFailures);
  if(!bifrostProgressQualified(f))failures.push(Error("progress case physical or accounting proof incomplete"));
 }
 failures.push(...w.syncFailures,...w.observerFailures,...workerFailures);throwFailures(failures);
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
   const value=await result;expect(value.stopReason).toBe(row.control==="eof"?"stop":row.control==="provider_error"?"error":"aborted");
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
      if(['preabort','partial'].includes(row.mode)){expect(controller.signal.aborted).toBe(true);expect(result.stopReason).toBe('aborted');}
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
