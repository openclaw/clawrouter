import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { execFileSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { createRequire } from "node:module";
import OpenAI from "openai";
import { APIPromise } from "openai/core/api-promise";
import { APIError } from "openai/core/error";
import { Stream as OpenAIStream } from "openai/core/streaming";
import { Completions as OpenAICompletions } from "openai/resources/chat/completions";
import { VERSION as openAIVersion } from "openai/version";
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
export function createBifrostFetchObserver(fetcher:Function,capture:Function,observerFailures:unknown[],callOriginal?:Function) {
 return function(this:unknown,...args:any[]) {
  const receipt=capture(this,args);let original;
  try{original=callOriginal?callOriginal(fetcher,this,args,receipt):Reflect.apply(fetcher,this,args);}catch(reason){
   try{receipt.threw(reason);}catch(error){observerFailures.push(error);}throw reason;
  }
  try{receipt.returned(original);}catch(error){observerFailures.push(error);}return original;
 };
}
// These hooks observe public calls already made by D8. In particular, never
// observe APIPromise with .then: that would start parsing before D8 requests it.
export function createBifrostProviderErrorOrigin(d:any) {
 const requests=new WeakMap<object,any>(),responses=new WeakMap<object,any>(),patches:any[]=[],records:any[]=[];
 const faults:unknown[]=[],restoration:unknown[]=[],undelivered:unknown[]=[],chunks:any[]=[];
 let creation:any,request:any,stream:any,iterator:any,controller:any,response:any,originError:any,originPayload:any,finished=false,invalid=false,seal:any;
 let responseCalls=0,factoryCalls=0,iteratorCalls=0,bytes=0,firstFaultSite=0;
 const aborts:any[]=[];
 const object=(v:any)=>v!==null&&(typeof v==="object"||typeof v==="function")&&!d.isProxy(v);
 // First fault only: 0 unobserved, 1 unknown, 2 invocation, 3 client binding,
 // 4 returned promise, 5 response lookup, 6 guard attachment, 7 read validation,
 // 8 seal prerequisite. Record the original reason before latching its site.
 const fail=(e:unknown,site=1)=>{invalid=true;faults.push(e);if(faults.length===1)firstFaultSite=site;try{d.fault(e);}catch(report){undelivered.push(e,report);}};
 const guard=(fn:Function,site=1)=>{try{return fn();}catch(e){fail(e,site);}};
 const need=(v:any)=>{if(v!==true)throw Error("incomplete provider-error origin");};
 const own=(v:any,k:PropertyKey)=>{need(object(v));const x=Object.getOwnPropertyDescriptor(v,k);need(!!x&&"value" in x);return x!.value;};
 const method=(v:any,k:PropertyKey)=>{need(object(v));for(let i=0;i<8&&v;i++,v=Object.getPrototypeOf(v)){
  need(object(v));const x=Object.getOwnPropertyDescriptor(v,k);if(x){need("value" in x&&typeof x.value==="function"&&!d.isProxy(x.value));return x.value;}}
  throw Error("missing origin method");};
 const patch=(v:any,k:PropertyKey,fn:Function)=>{need(object(v));const before=Object.getOwnPropertyDescriptor(v,k);
  need(!before||before.configurable===true&&"value" in before&&before.writable===true);
  const ours={value:fn,configurable:true,writable:true,enumerable:before?.enumerable??false};Object.defineProperty(v,k,ours);patches.push({v,k,before,ours});};
 const current=()=>{const i=d.invocation();return i?.owner===d.owner&&i.kind==="inference"&&i.caller===d.caller()?i:undefined;};
 const active=()=>{need(!finished&&!seal);};
 const restoredDescriptors=()=>patches.every(p=>{const now=Object.getOwnPropertyDescriptor(p.v,p.k);return p.before?sameBifrostDescriptor(now,p.before):now===undefined;});
 const observe=(p:any,o:any)=>{o.pending=p;o.returned=p;
  // Native promise brand validation also avoids reading a hostile then getter.
  const observed=Reflect.apply(Promise.prototype.then,p,[(v:any)=>{guard(()=>{active();o.state="fulfilled";o.value=v;o.settle=d.next();if(o.kind==="response"){need(!response&&object(v));response=v;responses.set(v,request);}});},
   (e:unknown)=>{guard(()=>{active();o.state="rejected";o.reason=e;o.settle=d.next();});}]);d.observer(observed);};
 const operation=(kind:string,fn:Function,receiver:any,args:any[])=>{
  let o:any;guard(()=>{active();need(records.length<32);o={kind,fn,receiver,args:[...args],state:"pending",invoke:d.next(),returned:undefined,pending:undefined};records.push(o);});
  let value;try{value=d.storage.run({request,operation:o},()=>Reflect.apply(fn,receiver,args));}
  catch(e){guard(()=>{if(o){o.state="threw";o.reason=e;o.settle=d.next();}});throw e;}
  guard(()=>{if(o){o.returnAt=d.next();observe(value,o);}});return value;
 };
 const bindIterator=(value:any)=>{active();need(++iteratorCalls===1&&object(value));iterator=value;
  for(const kind of ["next","return","throw"]){const fn=method(value,kind);patch(value,kind,function(this:any,...args:any[]){
   if(this!==iterator){guard(()=>{need(false);});return Reflect.apply(fn,this,args);}
   return operation(kind,fn,this,args);
  });}
 };
 return {
  records,
  deny(){invalid=true;},
  install(){
   need(d.version==="7.43.0");
    const create=method(d.Completions.prototype,"create"),requestMethod=method(d.OpenAI.prototype,"request"),asResponse=method(d.APIPromise.prototype,"asResponse"),factory=method(d.Stream,"fromSSEResponse"),iterate=method(d.Stream.prototype,Symbol.asyncIterator);
    patch(d.Completions.prototype,"create",function(this:any,...args:any[]){
     let invocation:any;guard(()=>{invocation=current();},2);if(!invocation)return Reflect.apply(create,this,args);
     let owned:any;guard(()=>{active();need(!creation&&object(this)&&Object.getPrototypeOf(this)===d.Completions.prototype);
      owned=creation={invocation,resource:this,args:[...args],request:undefined,returned:undefined};},3);
     let value;try{value=d.storage.run({creation:owned},()=>Reflect.apply(create,this,args));}catch(e){guard(()=>{fail(e);});throw e;}
     guard(()=>{need(!!owned&&owned===creation&&owned.request===request&&request?.creation===owned&&request.originalReturned&&
      object(value)&&Object.getPrototypeOf(value)===d.APIPromise.prototype&&value!==request.originalReturned);
      owned.returned=request.returned=value;requests.set(value,request);},4);return value;
    });
   patch(d.OpenAI.prototype,"request",function(this:any,...args:any[]){
    let invocation:any;guard(()=>{invocation=current();},2);if(!invocation)return Reflect.apply(requestMethod,this,args);
     let owned:any;guard(()=>{active();need(!request&&creation&&d.storage.getStore()?.creation===creation&&creation.invocation===invocation&&object(this)&&Object.getPrototypeOf(this)===d.OpenAI.prototype);
      owned=request={creation,invocation,client:this,args:[...args],guards:[],originalReturned:undefined,returned:undefined};creation.request=owned;},3);
    let value;try{value=d.storage.run({request:owned},()=>Reflect.apply(requestMethod,this,args));}catch(e){guard(()=>{fail(e);});throw e;}
     guard(()=>{need(!!owned&&object(value)&&Object.getPrototypeOf(value)===d.APIPromise.prototype);owned.originalReturned=value;},4);return value;
   });
   patch(d.APIPromise.prototype,"asResponse",function(this:any,...args:any[]){
    let owned:any;guard(()=>{owned=object(this)?requests.get(this):undefined;},5);if(!owned)return Reflect.apply(asResponse,this,args);
    guard(()=>{active();need(owned===request&&current()===owned.invocation&&++responseCalls===1);});
    return operation("response",asResponse,this,args);
   });
   patch(d.Stream,"fromSSEResponse",function(this:any,...args:any[]){
    let owned:any;guard(()=>{owned=object(args[0])?responses.get(args[0]):undefined;},5);
    if(!owned)return Reflect.apply(factory,this,args);
    guard(()=>{active();need(this===d.Stream&&owned===request&&current()===owned.invocation&&++factoryCalls===1&&args[2]===request.client&&args[3]!==true);
     controller=args[1];need(object(controller));const abort=method(controller,"abort");
     patch(controller,"abort",function(this:any,...operands:any[]){
      let entry:any;guard(()=>{active();need(aborts.length<4);const context=d.storage.getStore();
       need(this===controller&&context?.request===request&&records.includes(context.operation));
       entry={operation:context.operation,receiver:this,args:[...operands],before:d.signal(controller.signal),invoke:d.next(),pending:d.pendingRead()};aborts.push(entry);});
      let result;try{result=Reflect.apply(abort,this,operands);}catch(e){guard(()=>{if(entry){entry.threw=true;entry.reason=e;}fail(e);});throw e;}
      guard(()=>{if(entry){entry.returned=result;entry.after=d.signal(controller.signal);entry.returnAt=d.next();}});return result;
     });
    });
    let value;try{value=Reflect.apply(factory,this,args);}catch(e){guard(()=>{fail(e);});throw e;}
     guard(()=>{need(!stream&&object(value)&&Object.getPrototypeOf(value)===d.Stream.prototype&&own(value,"controller")===controller);stream=value;});return value;
   });
    // The SDK normalizer captures this public prototype method before assigning
    // its own iterator wrapper. We never patch or restore that SDK-owned property.
    patch(d.Stream.prototype,Symbol.asyncIterator,function(this:any,...args:any[]){
     if(this!==stream)return Reflect.apply(iterate,this,args);
     let result;try{result=Reflect.apply(iterate,this,args);}catch(e){guard(()=>{fail(e);});throw e;}
     guard(()=>{need(current()===request.invocation);bindIterator(result);});return result;
    });
  },
  guard(a:any){guard(()=>{const context=d.storage.getStore();if(!context?.request)return;active();need(context.request===request&&request.guards.length===0);request.guards.push(a);},6);},
  read(o:any){guard(()=>{if(o.kind!=="read"||o.state!=="fulfilled"||o.reader?.transport?.method!=="POST")return;active();
   const done=own(o.value,"done");need(typeof done==="boolean");if(done)return;const value=own(o.value,"value");
   need(!d.isProxy(value)&&d.uint8(value)&&chunks.length<8&&bytes+d.length(value)<=1024);const copy=d.copy(value);bytes+=copy.length;chunks.push({o,copy});
  },7);},
  finish(){need(!finished);finished=true;
   for(const p of patches.toReversed())try{need(sameBifrostDescriptor(Object.getOwnPropertyDescriptor(p.v,p.k),p.ours));if(p.before)Object.defineProperty(p.v,p.k,p.before);else delete p.v[p.k];}
   catch(e){restoration.push(e);fail(e);}
   if(undelivered.length===1)throw undelivered[0];if(undelivered.length)throw new AggregateError(undelivered,"origin observation delivery failed");
  },
  seal(w:any){
   if(seal){guard(()=>need(seal.same()&&restoredDescriptors()));return invalid?undefined:seal.value;}
   const graph=()=>[w.sequence,w.originals,w.observers,w.failures,w.syncFailures,w.observerFailures,w.reportingFailures,w.transports,w.acquisitions,
    w.originals.length,w.observers.length,w.failures.length,w.syncFailures.length,w.observerFailures.length,w.reportingFailures.length,w.restored,w.sourceExpired,
    ...w.originals.flatMap((o:any)=>[o,o.state,o.reason,o.value,o.pending,o.returned,o.reader,o.receiver,o.invoke,o.settle,o.returnAt,o.args,...(o.args??[])]),
    ...records.flatMap(o=>[o,o.state,o.reason,o.value,o.pending,o.returned,o.receiver,o.fn,o.args,...o.args,o.invoke,o.returnAt,o.settle]),...chunks.flatMap(x=>[x.o,...x.copy]),
    ...aborts.flatMap(x=>[x,x.operation,x.receiver,x.args,...x.args,x.invoke,x.returnAt,x.pending,x.returned,x.threw,x.reason,x.before.observed,x.before.aborted,x.before.reason,x.after?.observed,x.after?.aborted,x.after?.reason]),
    ...(originError?[originError,originPayload,own(originError,"error"),own(originError,"headers"),own(originError,"status"),own(originError,"code"),own(originError,"param"),own(originError,"type"),own(originPayload,"message"),own(originPayload,"type")]:[]),
    ...w.transports.flatMap((t:any)=>[t,t.acquisition,t.invocation,t.context,t.owner,t.response,t.signal,t.guardObserved,t.releases,t.releaseDone,t.release,
     t.bodies,...t.bodies,t.readers,...t.readers.flatMap((r:any)=>[r,r.owner,r.original,r.body,r.transport,r.closed,r.unlocks,r.unlockFailed,r.unlockAt,r.unlockReceiver,r.body.locked])]),
    ...w.acquisitions.flatMap((a:any)=>[a,a.owner,a.guard,a.input,a.inputSignal,a.input?.signal,a.input?.init?.signal,a.invocation,a.context,a.transport,a.response,a.operation,a.pending,a.result,a.result?.response]),
    w.caller,w.caller.owner,w.caller.signal,w.caller.signal.aborted,w.caller.abortCalled,w.caller.result,w.evidenceJoined,w.workerRetired,
    w.retirementProof,w.retirementProof?.source,w.retirementProof?.observation,w.retirementProof?.events,
    w.retirementProof?.owner,w.retirementProof?.retired,w.retirementProof?.disposition,w.retirementProof?.source?.owner,
    w.retirementProof?.source?.held,w.retirementProof?.source?.expired,w.retirementProof?.source?.producer,
    w.retirementProof?.source?.producer?.joined,w.retirementProof?.source?.producer?.failures,w.retirementProof?.source?.producer?.faults,
    w.retirementProof?.observation?.owner,w.retirementProof?.observation?.usageObserved,
    ...(w.retirementProof?.observation?.phases??[]).flat(),...(w.retirementProof?.source?.producer?.roles??[]).flat(),
     creation,creation?.resource,creation?.args,...(creation?.args??[]),creation?.invocation,creation?.request,creation?.returned,
     request,request?.creation,request?.originalReturned,request?.returned,request?.invocation,request?.guards[0],response,stream,iterator,controller,aborts.length,faults.length,restoration.length];
   let value:any;guard(()=>{
    need(finished&&!invalid&&restoredDescriptors()&&creation&&request&&creation.request===request&&request.creation===creation&&creation.returned===request.returned&&request.originalReturned!==request.returned&&request.guards.length===1&&responseCalls===1&&factoryCalls===1&&iteratorCalls===1);
    const a=request.guards[0],t=a.transport,r=t?.readers[0];need(t&&r&&a.invocation===request.invocation&&bifrostInvocationBound(w,t)&&a.inputSignal===controller.signal);
    const rejected=records.filter(o=>o.state==="rejected"),o=rejected[0];need(rejected.length===1&&o.kind==="next"&&records.every(x=>x===o||x.state==="fulfilled")&&object(o.reason)&&Object.getPrototypeOf(o.reason)===d.APIError.prototype);
    need(records.filter(x=>x.kind==="response").length===1&&records.find(x=>x.kind==="response").value===response&&records.every(x=>x.kind!=="throw"));
    need(records.filter(x=>x.kind==="return").every(x=>x.invoke>o.settle));
    const error=own(o.reason,"error");need(object(error)&&Object.getPrototypeOf(error)===d.objectPrototype&&Object.keys(error).sort().join(",")==="message,type"&&
     own(error,"message")==="synthetic-provider-error"&&own(error,"type")==="server_error"&&own(o.reason,"headers")===response.headers&&
     own(o.reason,"status")===undefined&&own(o.reason,"code")===undefined&&own(o.reason,"param")===undefined&&own(o.reason,"type")==="server_error");
    originError=o.reason;originPayload=error;
    need(chunks.length>0&&chunks.every(x=>x.o.reader===r)&&d.wire(chunks.map(x=>x.copy))===d.expectedWire);
    need(aborts.length===2&&aborts.every(x=>x.operation===o&&x.receiver===controller&&x.args.length===0&&x.returned===undefined&&!x.threw&&x.before.observed&&x.after.observed&&x.after.aborted===true));
    const first=aborts[0],second=aborts[1],e=first.after.reason;
    need(first.before.aborted===false&&second.before.aborted===true&&e!==undefined&&e!==null&&typeof e==="object"&&e!==o.reason&&
     second.before.reason===e&&second.after.reason===e&&first.returnAt<second.invoke&&second.returnAt<o.settle&&first.invoke>o.invoke);
    need(!!first.pending&&(!second.pending||first.pending===second.pending)&&!w.originals.some((x:any)=>x.reason===o.reason&&["rejected","threw"].includes(x.state)));
    value=Object.freeze({owner:w.owner,invocation:request.invocation,transport:t,reader:r,response,controller,error:o.reason,reason:e,read:first.pending,abort:first.invoke,iteratorOperation:o});
   },8);
   let frozen:any[]=[];guard(()=>{frozen=graph();});seal={value,same:()=>{const live=graph();return live.length===frozen.length&&live.every((x,i)=>Object.is(x,frozen[i]));}};return invalid?undefined:value;
  },
  summary(){return [1,finished?1:0,invalid?1:0,seal?.value&&!invalid?1:0,responseCalls,factoryCalls,iteratorCalls,records.length,aborts.length,faults.length,faults.filter(e=>e===undefined).length,restoration.length,firstFaultSite];},
 };
}
// Passive diagnostics for one private fetch generation. No transport flag is read.
// Counts saturate at 16; overflow invalidates attribution. Missing close stays unknown.
// Wire: [binding/restored/overflow bits, fetch/create/send/headers/trailers/error/close/omitted counts,
// create/send/headers/trailers/first-error/last-error/close/seal orders,
// [reason presence/defined/object/same/caller/read bits, undefined errors, faults,
// undefined faults, restoration failures, undefined restoration failures]].
export function createBifrostTransportWitness(deps:any) {
 const generations=new WeakSet<object>(),requests=new WeakMap<object,any>(),foreignSockets=new WeakSet<object>();
 const subscriptions:any[]=[],errors:any[]=[],faults:unknown[]=[],restoration:unknown[]=[];
 const counts=Array(8).fill(0),order:any[]=Array(8).fill(null);
 let active=true,started=false,finished=false,overflow=false,registrationFailed=false;
 let generation:any,request:any,socket:any,closeListener:any,removeClose:any;
 const object=(v:any)=>v!==null&&(typeof v==="object"||typeof v==="function")&&!deps.isProxy(v);
 const fault=(e:unknown)=>{if(faults.length<16)faults.push(e);else overflow=true;};
 const invalid=()=>fault(Error("incomplete passive transport identity"));
 const own=(v:any,k:string)=>{if(!object(v))throw Error("unsupported diagnostic object");const d=Object.getOwnPropertyDescriptor(v,k);
  if(d&&!("value" in d))throw Error("unsupported diagnostic accessor");return d;};
 const method=(v:any,k:string)=>{for(let n=0;n<8&&v!==null;n++,v=Object.getPrototypeOf(v)){
  const d=own(v,k);if(d){if(typeof d.value!=="function")throw Error("unsupported socket method");return d.value;}}
  throw Error("missing socket method");};
 const increment=(i:number)=>{if(counts[i]<16)counts[i]++;else overflow=true;};
 const sequence=()=>{const n=deps.next();if(!Number.isSafeInteger(n)||n<=0||n>1000000)throw Error("transport order exceeded");return n;};
 const handle=(kind:number,message:any)=>{if(!active)return;try{
  // A foreign diagnostic never supplies ownership. Inspect only own data descriptors.
  if(!object(message))return;const rd=own(message,"request"),r=rd?.value;if(!object(r))return;
  if(kind===0){const token=deps.storage.getStore();if(!token||!generations.has(token))return;
   increment(1);if(request||requests.has(r)||token!==generation){invalid();return;}
   request=r;requests.set(r,token);order[0]=sequence();return;
  }
  const token=requests.get(r);
  if(kind===1&&(!token||token!==generation)){const other=own(message,"socket")?.value;
   if(object(other)){foreignSockets.add(other);if(other===socket)invalid();}return;}
  if(!token||token!==generation||r!==request)return;
  if(kind===1){increment(2);const candidate=own(message,"socket")?.value;
   if(!object(candidate)||socket||foreignSockets.has(candidate)){invalid();return;}
   socket=candidate;order[1]=sequence();const once=method(socket,"once");removeClose=method(socket,"removeListener");
   closeListener=function(this:unknown){if(!active)return;try{if(this!==socket){invalid();return;}increment(6);if(counts[6]!==1)invalid();order[6]=sequence();}catch(e){fault(e);}};
   Reflect.apply(once,socket,["close",closeListener]);return;
  }
  if(kind===2||kind===3){const index=kind+1;increment(index);if(kind===3&&counts[index]!==1)invalid();if(order[kind]===null)order[kind]=sequence();return;}
  increment(5);const at=sequence();if(order[4]===null)order[4]=at;order[5]=at;
  const d=own(message,"error");if(errors.length<16)errors.push({present:!!d,reason:d?.value});else{increment(7);overflow=true;}
 }catch(e){fault(e);}};
 return {
  start(){if(started||finished)throw Error("duplicate transport start");started=true;
   for(const [kind,name] of ["undici:request:create","undici:client:sendHeaders","undici:request:headers","undici:request:trailers","undici:request:error"].entries()){
    try{const c=deps.channel(name),callback=(m:unknown)=>handle(kind,m);subscriptions.push({c,callback});c.subscribe(callback);}
    catch(e){registrationFailed=true;fault(e);}
   }
  },
  fetch(t:any,fn:Function,receiver:unknown,args:any[]){
   let token:any;
   // All passive setup completes before the one original invocation. Never retry a throw.
   try{if(active&&started&&deps.selected(t)){
    increment(0);if(!deps.bound(t,fn,receiver,args,false))invalid();else{
     token=Object.freeze({t,fn,receiver,args});generations.add(token);if(generation)invalid();else generation=token;
    }
   }}catch(e){fault(e);}
   return token?deps.storage.run(token,()=>Reflect.apply(fn,receiver,args)):Reflect.apply(fn,receiver,args);
  },
  finish(){if(finished)throw Error("duplicate transport finish");finished=true;
   let bound=false,reasonMask=0;
   try{bound=!!generation&&counts[0]===1&&counts[1]===1&&counts[2]===1&&!!socket&&
     deps.bound(generation.t,generation.fn,generation.receiver,generation.args,true)===true;
    if(errors.length){const reference=deps.reasons(generation?.t),all=(fn:Function)=>errors.every(fn as any);
     reasonMask=(all((e:any)=>e.present)?1:0)|(all((e:any)=>e.present&&e.reason!==undefined)?2:0)|
      (all((e:any)=>e.present&&e.reason!==null&&typeof e.reason==="object")?4:0)|
      (all((e:any)=>e.present&&errors[0].present&&Object.is(e.reason,errors[0].reason))?8:0)|
      (all((e:any)=>e.present&&reference.callerPresent&&Object.is(e.reason,reference.caller))?16:0)|
      (all((e:any)=>e.present&&reference.readPresent&&Object.is(e.reason,reference.read))?32:0);
    }
    order[7]=sequence();
   }catch(e){fault(e);}finally{active=false;}
   for(const {c,callback} of subscriptions.toReversed())try{c.unsubscribe(callback);}catch(e){restoration.push(e);}
   if(closeListener)try{Reflect.apply(removeClose,socket,["close",closeListener]);}catch(e){restoration.push(e);}
   try{deps.storage.disable();}catch(e){restoration.push(e);}
   const closed=started&&subscriptions.length===5&&!registrationFailed&&restoration.length===0;
   const data=[(bound&&!faults.length&&!overflow&&closed?1:0)|(closed?2:0)|(overflow?4:0),counts,order,
    [reasonMask,errors.filter(e=>e.present&&e.reason===undefined).length,faults.length,faults.filter(e=>e===undefined).length,restoration.length,restoration.filter(e=>e===undefined).length]];
   Object.freeze(counts);Object.freeze(order);Object.freeze(data[3]);Object.freeze(data);
   return {data,failures:overflow?[...faults,Error("passive transport evidence overflow")]:faults,restorationFailures:restoration};
  },
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
// The explicit negative SSE case has its own public SDK origin proof. Raw
// native outcomes remain rejected; this vector is never shared with partials.
export function bifrostProviderErrorVector(w:any):any[]|undefined {
 const deny=()=>{w.origin?.deny();return undefined;};
 if(w.mode!=="provider_error"||!w.origin||!w.evidenceJoined||!w.restored||w.workerRetired!==true||w.sourceExpired!==0||
  [w.failures,w.observerFailures,w.syncFailures,w.reportingFailures].some((v:any)=>!Array.isArray(v)||v.length))return deny();
 const proof=w.retirementProof,source=proof?.source,observation=proof?.observation;
 if(!proof||proof.owner!==w.owner.id||proof.retired!==true||proof.disposition!=="strict"||source?.owner!==w.owner.id||source.held!==0||source.expired!==0||
  source.producer?.joined!==true||source.producer.faults!==0||source.producer.failures!==0||source.producer.roles.some((r:any)=>r[1]!=="fulfilled")||
  observation?.owner!==w.owner.id||observation.usageObserved!==true||observation.phases.some((p:any)=>p[0]!==2))return deny();
 // These are the existing owned join/usage results, not financial acceptance.
 // The unchanged outer row still executes its actual SQLite assertions.
 const token=w.origin.seal(w);if(!token||token.owner!==w.owner)return deny();
 const t=token.transport,a=t.acquisition,r=token.reader,c=w.caller;
 if(w.transports.filter((x:any)=>x.method==="POST").length!==1||w.transports.filter((x:any)=>x.method==="GET").length!==1||
  !bifrostInvocationBound(w,t)||t.invocation!==token.invocation||!t.guardObserved||t.owner!==w.owner||a.owner!==w.owner||a.guard!==w.identity.guard||
  a.transport!==t||a.response!==t.response||a.result?.response!==t.response||a.operation?.state!=="fulfilled"||a.pending!==a.operation.pending||a.pending!==a.operation.returned||
  t.fetch.state!=="fulfilled"||!t.fetch.pending||t.fetch.pending!==t.fetch.returned||t.readers.length!==1||t.readers[0]!==r||t.bodies.length!==1||
  r.owner!==w.owner||r.transport!==t||r.body!==t.response.body||r.body!==t.bodies[0]||c.owner!==w.owner||c.abortCalled!==false||c.signal.aborted||c.result!=="error")return deny();
 const ops=(kind:string)=>w.originals.filter((o:any)=>o.reader===r&&o.kind===kind);
 const badReads=ops("read").filter((o:any)=>o.state==="rejected"),closes=ops("closed"),cancels=ops("cancel"),unlocks=ops("unlock");
 const read=badReads[0],closed=closes[0],cancel=cancels[0],unlock=unlocks[0],vector=[read,closed,cancel];
 if(badReads.length!==1||closes.length!==1||cancels.length!==1||unlocks.length!==1||read!==token.read||read.reason!==token.reason||
  vector.some(o=>!o||o.owner!==w.owner||o.state!=="rejected"||o.reason!==token.reason||o.receiver!==r.original||!o.pending||o.pending!==o.returned)||
  new Set(vector.map(o=>o.pending)).size!==3||closed.pending!==r.closed||!Array.isArray(cancel.args)||cancel.args.length!==1||cancel.args[0]!==undefined||
  !Array.isArray(read.args)||read.args.length!==0||w.originals.some((o:any)=>o.state!=="fulfilled"&&!vector.includes(o)))return deny();
 if(![read,closed,cancel].every(o=>o.callerSignal===c.signal&&o.effectiveSignal===t.signal&&o.evidenceSettle?.caller?.observed===true&&o.evidenceSettle.caller.aborted===false&&
  ["input","effective"].every(k=>o.evidenceSettle?.[k]?.observed===true&&o.evidenceSettle[k].aborted===true&&o.evidenceSettle[k].reason===token.reason))||
  !["caller","input","effective"].every(k=>read.evidenceInvoke?.[k]?.observed===true&&read.evidenceInvoke[k].aborted===false)||
  !(read.invoke<token.abort&&token.abort<Math.min(read.settle,closed.settle,cancel.invoke))||
  unlock.state!=="fulfilled"||unlock.owner!==w.owner||unlock.receiver!==r.original||unlock.args?.length!==0||r.unlocks!==1||r.unlockFailed||r.unlockReceiver!==r.original||r.body.locked||
  !(cancel.invoke<cancel.returnAt&&cancel.returnAt<unlock.invoke&&unlock.invoke<unlock.returnAt&&unlock.returnAt<r.unlockAt)||
  t.releases!==1||!t.releaseDone||t.release?.state!=="fulfilled"||t.release.acquisition!==a||t.release.receiver!==undefined||t.release.args?.length!==0||
  !t.release.pending||t.release.pending!==t.release.returned)return deny();
 if(w.providerErrorVector){if(w.providerErrorVector.some((o:any,i:number)=>o!==vector[i]))return deny();return w.providerErrorVector;}
 w.providerErrorVector=Object.freeze(vector);return w.providerErrorVector;
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
 const role=w.role??(w.mode==="provider_error"?"provider_error":undefined);
 const strict=w.originals.every((o:any)=>o.state==="fulfilled"),negative=!strict&&role==="provider_error"?bifrostProviderErrorVector(w):undefined;
 const posts=w.transports.filter((t:any)=>t.method==="POST").length,gets=w.transports.filter((t:any)=>t.method==="GET").length;
 const matched=role==="partial"?!!vector:role==="preabort"?strict&&w.preabortPostDelta===0&&w.caller?.abortCalled===true&&w.caller?.signal.aborted===true&&w.caller?.result==="error"&&w.caller?.emptyContent===true&&posts===0:
  (role==="eof"||role==="provider_error")&&(strict||role==="provider_error"&&!!negative)&&posts===1&&w.caller?.abortCalled===false&&w.caller?.signal.aborted===false&&
   w.caller?.result===(role==="eof"?"stop":"error");
 return {qualified:!hard&&gets===1&&matched===true,contract,vector:vector?"stored_error":"strict",operand:vector?bifrostCancelOperand(vector[0],vector[2]):null,
  vectorObserved:!!vector,negative,owner:w.owner,identity:w.identity,provider:w.provider,api:w.api,role};
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
 if(w.mode==="provider_error"){const raw=evaluateBifrostNativeControl(w);return raw.qualified?raw.negative??[]:[];}
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
// Version 1: counts; first kind/state/index/reason presence; private pair links.
// States: 0 unknown, 1 pending, 2 fulfilled, 3 rejected, 4 threw.
export function validateBifrostWorkerResidual(v:any):boolean {
 const n=(x:any)=>Number.isSafeInteger(x)&&x>=0&&x<=1000000;
 const bit=(x:any)=>x===null||typeof x==="boolean";
 if(!Array.isArray(v)||v.length!==4||v[0]!==1||!Array.isArray(v[1])||v[1].length!==3||!v[1].every(n))return false;
 const f=v[2],p=v[3];
 if(v[1][0]===0?f!==null:!Array.isArray(f)||f.length!==4||!f.every(n)||f[0]>13||![0,1,3,4].includes(f[1])||f[3]>2||([0,1].includes(f[1])&&f[3]!==0))return false;
 if(!Array.isArray(p)||p.length!==7||!p.slice(0,2).every(n)||p[0]+p[1]>v[1][0]||!p.slice(2,5).every(bit)||!p.slice(5).every((x:any)=>Number.isInteger(x)&&x>=0&&x<=4))return false;
 if(f&&(f[0]===3?p[0]<1:f[0]===4?p[1]<1:v[1][0]-p[0]-p[1]<1))return false;
 if((p[0]!==1||p[1]!==1)&&p.slice(2,5).some((x:any)=>x!==null)||p[0]!==1&&p.slice(5).some((x:any)=>x!==0))return false;
 return true;
}
export function bifrostObserveRetirementVerdict(c:any,response:any,value:any):boolean {
 const status200=response.status===200,retired=value.retired;
 c.verdict=[status200,retired,value.disposition==="strict"?1:value.disposition==="provisional_worker_deadline_read"?2:0];
 return status200&&retired===true;
}
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
export function bifrostCaseEvidence(index:number,w:any,proof:any,worker:boolean,workerFailures:unknown[],retirement?:any):any[] {
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
   bodyUnlocked:r?flag(r.body.locked===false):null,restored:flag(w.restored),joins:flag(w.evidenceJoined),worker},
  {...base,part:"postlude",...bifrostPostludeEvidence(retirement,proof,index),...(w.transportWitnessEvidence?{transport:w.transportWitnessEvidence}:{}),...(w.origin?{origin:w.origin.summary()}:{})}
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
 fields.postlude={
  control:(v:any)=>Array.isArray(v)&&v.length===6&&v.every((r:any)=>r===null||Array.isArray(r)&&r.length===5&&[1,2,3,4].includes(r[0])&&
   ([3,4].includes(r[0])?typeof r[1]==="boolean":r[1]===null)&&r.slice(2).every(number)),
  validated:(v:any)=>typeof v==="boolean",
  producer:(v:any)=>v===null||Array.isArray(v)&&[9,10].includes(v.length)&&(v.length===9||[2,6,12,13].includes(record.case)&&validateBifrostProducerSite(v[9]))&&typeof v[0]==="boolean"&&Array.isArray(v[1])&&v[1].length<=4&&v[1].every((r:any,i:number)=>
   Array.isArray(r)&&r.length===3&&Number.isInteger(r[0])&&r[0]>=0&&r[0]<4&&(i===0||r[0]>v[1][i-1][0])&&[1,2,3].includes(r[1])&&
   (r[1]===3?typeof r[2]==="boolean":r[2]===null)&&(!v[0]||r[1]!==1))&&v.slice(2,9).every((n:any)=>n!==null&&number(n)),
  router:(v:any)=>v===null||Array.isArray(v)&&v.length===4&&v.every((r:any)=>Array.isArray(r)&&r.length===2&&[2,3].includes(r[0])&&(r[0]===3?typeof r[1]==="boolean":r[1]===null)),
  usage:(v:any)=>v===null||Array.isArray(v)&&v.length===3&&typeof v[0]==="boolean"&&(v[0]?v.slice(1).every((n:any)=>n!==null&&number(n)):v[1]===null&&v[2]===null),
 };
  // Mandatory only in the two progress cases under this source-bound schema.
  if(record?.part==="postlude"&&[30,31].includes(record.case))fields.postlude.worker=(v:any)=>Array.isArray(v)&&v.length===5&&v[0]===1&&
    (v[1]===null?v[2]===null&&v[3]===null:validateBifrostWorkerResidual(v.slice(0,4)))&&
    (v[4]===null||Array.isArray(v[4])&&v[4].length===3&&typeof v[4][0]==="boolean"&&typeof v[4][1]==="boolean"&&[1,2].includes(v[4][2]));
  // Optional only for the source-owned stream-partial control; not a success predicate.
 if(record?.part==="postlude"&&Object.hasOwn(record,"transport")){
  if(record.case!==2)throw Error("foreign transport witness");
  fields.postlude.transport=(v:any)=>Array.isArray(v)&&v.length===4&&Number.isInteger(v[0])&&v[0]>=0&&v[0]<=7&&
   Array.isArray(v[1])&&v[1].length===8&&v[1].every((n:any)=>Number.isInteger(n)&&n>=0&&n<=16)&&
   Array.isArray(v[2])&&v[2].length===8&&v[2].every((n:any)=>n===null||Number.isSafeInteger(n)&&n>0&&n<=1000000)&&
   Array.isArray(v[3])&&v[3].length===6&&Number.isInteger(v[3][0])&&v[3][0]>=0&&v[3][0]<=63&&
   v[3].slice(1).every((n:any)=>Number.isInteger(n)&&n>=0&&n<=16)&&
   (!(v[0]&1)||(v[0]===3&&v[1].slice(0,3).every((n:any)=>n===1)&&v[1][7]===0&&v[3][2]===0&&v[3][4]===0&&v[2][0]!==null&&v[2][1]!==null&&v[2][7]!==null))&&
   (!(v[0]&2)||v[3][4]===0)&&v[3][1]<=v[1][5]&&v[3][3]<=v[3][2]&&v[3][5]<=v[3][4];
 }
 if(record?.part==="postlude"&&Object.hasOwn(record,"origin")){
  if(![3,7,14,15].includes(record.case)||Object.hasOwn(record,"transport"))throw Error("foreign provider-error origin");
  fields.postlude.origin=(v:any)=>Array.isArray(v)&&v.length===13&&v.every((n:any)=>Number.isSafeInteger(n)&&n>=0&&n<=1000000)&&v[0]===1&&
   v.slice(1,4).every((n:any)=>n<=1)&&v[7]<=32&&v[8]<=4&&v[10]<=v[9]&&v[11]<=v[9]&&v[12]<=8&&(v[9]===0?v[12]===0:v[12]>0)&&
   (!v[3]||(v[1]===1&&v[2]===0&&v.slice(4,7).every((n:any)=>n===1)&&v[8]===2&&v[9]===0&&v[11]===0));
 }
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
  (!["module","setup","case_setup","case_result","child","body","original_join","read","closed","cancel","release","observer","worker_retirement","restoration","cleanup","control","assertions","accounting","final","overflow"].includes(record.phase)&&!bifrostSetupPhase(record.phase))||
  !["enter","fulfilled","rejected","threw","summary"].includes(record.state)||
  !(record.defined===null||typeof record.defined==="boolean")||
  ![record.case,record.acq,record.op].every((n:any)=>n===null||Number.isSafeInteger(n)&&n>=0&&n<4096)||
  !(record.case===null||record.case<32)||!Number.isSafeInteger(record.count)||record.count<0||record.count>65535||
  (bifrostSetupPhase(record.phase)&&(record.lane!=="sdk"||record.case===null||record.state!=="rejected"||record.acq!==null||record.op!==null||record.count!==0))||
  (["rejected","threw"].includes(record.state)?typeof record.defined!=="boolean":record.defined!==null))throw Error("invalid Bifrost checkpoint");
}
export function validateBifrostProducerSite(v:any):boolean {
 return Array.isArray(v)&&v.length===6&&v.every((n:any)=>Number.isSafeInteger(n)&&n>=0)&&
  v[0]<=6&&v[1]<=64&&v[2]===v[1]*1024&&v[3]<=15&&v[4]<=7&&v[5]<=15&&
  [v[4],v[5]].every((mask:number)=>(mask&6)===0||(mask&1)===1)&&
  (!(v[5]&8)||!!(v[4]&v[5]&1))&&
  (v[0]===0?v[4]===0&&v[5]===0:v[0]===6?v[4]===0&&!!(v[5]&1):!!(v[4]&1));
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
   if(emitted<(withEvidence?2:7)){emitted++;send(record);}else suppressed=Math.min(65535,suppressed+1);}
 };
 return {failures,mark,flush,
  evidence(records:any[]){
   try{
    if(!withEvidence||lane!=="sdk"||finished||records.length!==5)throw Error("unsupported evidence group");
    for(const record of records)validateBifrostEvidence(record);
    if(records.map(r=>r.part).join(",")!=="identity,reasons,order,retirement,postlude"||records.some(r=>r.case!==records[0].case||r.complete!==records[0].complete))throw Error("incomplete evidence group");
    if(evidenceCase!==null){suppressed=Math.min(65535,suppressed+5);return;}
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
// The ticket is private to one original control request. Await the original
// returns; these observations are not SDK data outcomes or a disposition.
export function createBifrostRetirementReader() {
 const tickets=new WeakMap<object,any>(),responses=new WeakSet<object>(),bodies=new WeakSet<object>();
 const get=(token:object,owner?:any)=>{
  const c=tickets.get(token);
  if(!c||owner&&c.owner!==owner||c.owner.id!==c.id||c.owner.mode!==c.mode)throw Error("foreign retirement observation");
  return c;
 };
 const begin=(c:any,phase:number,fn:Function,receiver:unknown,args:any[])=>{
  if(c.steps[phase])throw Error("duplicate retirement operation");
  const o:any={phase,fn,receiver,args:[...args],state:1,invoke:++c.sequence,returned:undefined};c.steps[phase]=o;
  try{o.returned=Reflect.apply(fn,receiver,args);o.returnAt=++c.sequence;return o;}
  catch(error){o.state=4;o.reason=error;o.settle=++c.sequence;throw error;}
 };
 const settle=async(c:any,o:any)=>{
  try{const value=await o.returned;o.state=2;o.settle=++c.sequence;return value;}
  catch(error){o.state=3;o.reason=error;o.settle=++c.sequence;throw error;}
 };
 const sync=(c:any,phase:number,fn:Function)=>{const o=begin(c,phase,fn,undefined,[]);o.state=2;o.settle=++c.sequence;return o.returned;};
 const read=async(owner:any,original:Function,receiver:unknown,args:any[],method:string,observe:Function,token?:object)=>{
  const c=token?get(token,owner):{owner,id:owner.id,mode:owner.mode,steps:[],sequence:0};
  if(c.started)throw Error("duplicate retirement request");c.started=true;
  const members=[...args],failures:unknown[]=[];let response:any,body:any,claimed=false,consumed=false,value:any;
  const check=()=>{if(owner.id!==c.id||owner.mode!==c.mode||args.length!==members.length||args.some((v,i)=>v!==members[i]))throw Error("changed control ownership");};
  const call=(phase:number,kind:string,fn:Function,that:unknown,values:any[])=>{
   let o:any;
   let pending:any,reported=false;
   try{pending=observe(kind,()=>{o=begin(c,phase,fn,that,values);return o.returned;});}
   catch(error){if(!o||o.state===4)throw error;failures.push(error);reported=true;}
   if(!o)throw Error("missing original control invocation");
   if(!reported&&pending!==o.returned)failures.push(Error("replaced original control return"));
   return settle(c,o);
  };
  try{
   check();response=await call(0,"control_fetch",original,receiver,args);
   if(!response||responses.has(response))throw Error("ambiguous control response");responses.add(response);
   body=response.body;if(body&&bodies.has(body))throw Error("foreign control body");if(body)bodies.add(body);
   claimed=true;c.response=response;c.body=body;check();
   if(method!=="text"&&method!=="json")throw Error("invalid control consumption");
   const consume=response[method];value=await call(1,"control_body",consume,response,[]);consumed=true;c.value=value;check();
  }catch(error){failures.push(error);}
  if(failures.length&&claimed&&body&&!consumed)try{const cancel=body.cancel;await call(2,"control_cancel",cancel,body,[]);}catch(error){failures.push(error);}
  c.readFailures=failures;c.readJoined=true;
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"control consumption and original cleanup failed");
  return {response,value};
 };
 read.capture=(owner:any)=>{const token=Object.freeze({});tickets.set(token,{owner,id:owner.id,mode:owner.mode,steps:[],sequence:0,started:false,validated:false});return token;};
 read.parse=(token:object)=>{const c=get(token);if(!c.readJoined||c.readFailures.length||typeof c.value!=="string")throw Error("unconsumed retirement response");return c.parsed=sync(c,3,()=>JSON.parse(c.value));};
 read.validate=(token:object,validate:Function)=>{const c=get(token);if(c.steps[3]?.state!==2)throw Error("unparsed retirement response");
  sync(c,4,()=>{if(validate(c.parsed,c.id)!==true)throw Error("invalid owned retirement proof");});c.validated=true;return c.parsed;};
 read.verdict=(token:object,verdict:Function)=>{const c=get(token);if(!c.validated)throw Error("unvalidated retirement verdict");return sync(c,5,()=>verdict(c.response,c.parsed));};
 read.inspect=(token:object)=>get(token);
 return read;
}

export function validateBifrostProducerObservation(value:any):boolean {
 if(!value||value.v!==1||(Object.hasOwn(value,"site")&&!validateBifrostProducerSite(value.site))||typeof value.joined!=="boolean"||!Array.isArray(value.roles)||value.roles.length>4||
  ![value.faults,value.failures,value.undefinedFailures].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=1000000)||value.undefinedFailures>value.failures)return false;
 const roles=["producer","progressTask","progressObserved","progressCommand"];
 let prior=-1;
 for(const row of value.roles){const at=Array.isArray(row)?roles.indexOf(row[0]):-1;
  if(at<=prior||row.length!==3||!["pending","fulfilled","rejected"].includes(row[1])||
   (row[1]==="rejected"?typeof row[2]!=="boolean":row[2]!==null))return false;prior=at;}
 return (!value.joined||value.roles.every(r=>r[1]!=="pending"))&&value.failures===value.roles.filter(r=>r[1]==="rejected").length+value.faults;
}
export function validateBifrostSourceProof(value:any,id:string):boolean {
 return !!value&&value.owner===id&&Array.isArray(value.calls)&&["held","canceled","expired","settled","completed","progressCalls","progressEnqueued"].every(k=>Number.isSafeInteger(value[k])&&value[k]>=0&&value[k]<=1000000)&&
  typeof value.progressTerminal==="boolean"&&validateBifrostProducerObservation(value.producer);
}
export function validateBifrostRetirementProof(value:any,id:string):boolean {
 return !!value&&value.owner===id&&typeof value.retired==="boolean"&&Array.isArray(value.calls)&&Array.isArray(value.operations)&&Array.isArray(value.readers)&&Array.isArray(value.events)&&
  Number.isSafeInteger(value.charged)&&value.charged>=0&&["strict","provisional_worker_deadline_read"].includes(value.disposition)&&
  (value.source===null||validateBifrostSourceProof(value.source,id))&&!!value.observation&&value.observation.owner===id&&
  Array.isArray(value.observation.phases)&&value.observation.phases.length===4&&value.observation.phases.every(r=>Array.isArray(r)&&r.length===2&&[2,3].includes(r[0])&&(r[0]===3?typeof r[1]==="boolean":r[1]===null))&&
   (value.observation.producer===null||validateBifrostSourceProof(value.observation.producer,id))&&typeof value.observation.usageObserved==="boolean"&&
   (!Object.hasOwn(value.observation,"residual")||value.observation.residual===null||validateBifrostWorkerResidual(value.observation.residual));
}
export function bifrostPostludeEvidence(c:any,proof:any,index?:number):any {
 const step=(i:number)=>{const o=c?.steps?.[i];return o?[o.state,o.state===3||o.state===4?o.reason!==undefined:null,o.invoke,o.returnAt??null,o.settle??null]:null;};
 const observation=proof?.observation,source=observation?.producer,p=source?.producer;
 return {control:[0,1,2,3,4,5].map(step),validated:c?.validated===true,
  producer:p?[p.joined,p.roles.map((r:any)=>[["producer","progressTask","progressObserved","progressCommand"].indexOf(r[0]),["pending","fulfilled","rejected"].indexOf(r[1])+1,r[2]]),p.faults,p.failures,p.undefinedFailures,
   source.held,source.canceled,source.expired,source.settled,...(Object.hasOwn(p,"site")?[p.site]:[])]:null,
   router:observation?.phases??null,usage:observation?[observation.usageObserved,observation.usageObserved?proof.events.length:null,observation.usageObserved?proof.charged:null]:null,
   ...([30,31].includes(index as number)?{worker:[...(observation?.residual??[1,null,null,null]),c?.verdict??null]}:{})};
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
 const w:any={owner:Object.freeze({id:row.id}),identity:nativeIdentity,provider:"bifrost",api:row.api,role:row.control,mode:row.mode,
  originals:[],observers:[],transports:[],acquisitions:[],failures:[],observerFailures:[],syncFailures:[],reportingFailures:checkpoints.failures,restored:false,sourceExpired:null,sequence:0};
 const invocationStorage=new AsyncLocalStorage<any>(),ownership=createBifrostInvocationOwnership(invocationStorage);
 let providerOrigin:ReturnType<typeof createBifrostProviderErrorOrigin>|undefined;
 const transportWitness=row.control==="partial"&&row.api==="stream"?createBifrostTransportWitness({
  storage:new AsyncLocalStorage(),channel,isProxy:types.isProxy,next:()=>++w.sequence,
  selected:(t:any)=>t.method==="POST"&&t.owner===w.owner,
  bound:(t:any,fn:Function,receiver:unknown,args:any[],settled:boolean)=>ownership.bound(t)&&bifrostInvocationBound(w,t)&&
   (fn===nativeFetch||fn===nativeUndiciFetch)&&t.fetch.receiver===receiver&&t.fetch.args===args&&args[0]===t.input&&args[1]===t.init&&
   (!settled||!!t.fetch.pending&&t.fetch.pending===t.fetch.returned),
  reasons:(t:any)=>{const reads=w.originals.filter((o:any)=>o.kind==="read"&&o.reader?.transport===t&&o.state==="rejected");
   return {callerPresent:w.caller?.evidenceAbort?.observed===true,caller:w.caller?.evidenceAbort?.reason,readPresent:reads.length===1,read:reads[0]?.reason};},
 }):undefined;
 const failures:unknown[]=w.failures,originals:Original[]=w.originals,transports:Transport[]=w.transports,restores:Array<()=>void>=[];
 const observer=(p:Promise<unknown>)=>{w.observers.push(p.then(()=>{},e=>{w.observerFailures.push(e);}));};
 const record=(kind:string,details:any={})=>{const o:Original={owner:w.owner,kind,invoke:++w.sequence,settle:0,returnAt:0,state:"pending",returned:undefined,...details};originals.push(o);
  if(["read","closed","cancel"].includes(kind))try{o.evidenceInvoke=bifrostOperationEvidence(o,originals);}catch(e){w.observerFailures.push(e);}return o;};
 const returned=(o:Original,value:any)=>{o.returned=value;o.returnAt=++w.sequence;
  const settle=(state:Original["state"],v:any)=>{o.state=state;o.settle=++w.sequence;if(state==="rejected")o.reason=v;else o.value=v;
   providerOrigin?.read(o);
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
 if(row.mode==="provider_error"){
  const frame=(v:any)=>"data: "+JSON.stringify(v)+"\n\n";
  const expectedWire=frame({id:"chat_fixture",object:"chat.completion.chunk",created:1,model:"tenant/opaque-a",choices:[{index:0,delta:{role:"assistant",content:"synthetic-prefix"},finish_reason:null}]})+
   frame({error:{message:"synthetic-provider-error",type:"server_error"}});
   providerOrigin=createBifrostProviderErrorOrigin({OpenAI,APIPromise,APIError,Stream:OpenAIStream,Completions:OpenAICompletions,version:openAIVersion,
   storage:new AsyncLocalStorage(),owner:w.owner,caller:()=>c,invocation:()=>invocationStorage.getStore()?.invocation,
   isProxy:types.isProxy,objectPrototype:Object.prototype,next:()=>++w.sequence,fault:(e:unknown)=>w.observerFailures.push(e),observer,
   signal:bifrostSignalEvidence,pendingRead:()=>{const pending=originals.filter(o=>o.kind==="read"&&o.reader?.transport?.method==="POST"&&o.state==="pending");return pending.length===1?pending[0]:undefined;},
   uint8:types.isUint8Array,length:(v:Uint8Array)=>Reflect.apply(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),"byteLength")!.get!,v,[]),copy:(v:Uint8Array)=>{const n=Reflect.apply(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),"byteLength")!.get!,v,[]);
    const out=new Uint8Array(n);for(let i=0;i<n;i++)out[i]=v[i];return out;},wire:(chunks:Uint8Array[])=>Buffer.concat(chunks).toString("utf8"),expectedWire});
  w.origin=providerOrigin;
 }
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
  return {transport:t,threw(reason:unknown){o.state="threw";o.reason=reason;o.settle=++w.sequence;w.syncFailures.push(reason);},
   returned(pending:Promise<Response>){returned(o,pending);observer(pending.then(response=>{ownership.response(t,response);observeBody(response,t);},()=>{}));}};
 },w.observerFailures,(fn:Function,receiver:unknown,args:any[],receipt:any)=>transportWitness?transportWitness.fetch(receipt.transport,fn,receiver,args):Reflect.apply(fn,receiver,args));
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
  if(providerOrigin){restores.push(()=>providerOrigin!.finish());providerOrigin.install();}
  setupBoundary.enter("progress_subscribe");
  if(transportWitness){restores.push(()=>{const result=transportWitness.finish();w.transportWitnessEvidence=result.data;
   w.observerFailures.push(...result.failures);throwFailures(result.restorationFailures);});transportWitness.start();}
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
   const input=args[0],a:any={guard:nativeGuard,input,inputSignal:input.signal??input.init?.signal,invoke:++w.sequence};providerOrigin?.guard(a);a.signalHistory=signalHistory(a.inputSignal);w.acquisitions.push(a);
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
 let at=0,seen=0,originAt=0;
 while(at<originals.length||seen<w.observers.length||originAt<(providerOrigin?.records.length??0)){
  const batch=originals.slice(at),originBatch=providerOrigin?.records.slice(originAt)??[];at=originals.length;originAt=providerOrigin?.records.length??0;
  await Promise.allSettled([...batch,...originBatch].flatMap(o=>o.pending?[o.pending]:[]));
  const observed=w.observers.slice(seen);seen=w.observers.length;for(const r of await Promise.allSettled(observed))if(r.status==="rejected")w.observerFailures.push(r.reason);}
 checkpoints.mark(caseIndex,"original_join","fulfilled");
 w.evidenceJoined=true;
 if(w.observerFailures.length)checkpoints.mark(caseIndex,"observer","rejected",w.observerFailures[0]);
 w.preabortPostDelta=transports.filter(t=>t.method==="POST").length-(c.postsBefore??0);
 if(row.mode==="preabort")await check(()=>expect(transports.filter(t=>t.method==="POST")).toHaveLength(0));
 for(const t of transports){await check(()=>expect(t.guardObserved).toBe(true));await check(()=>expect(t.releases).toBe(1));await check(()=>expect(t.releaseDone).toBe(true));for(const r of t.readers)await check(()=>expect(r.unlocks).toBe(1));for(const b of t.bodies)await check(()=>expect(b.locked).toBe(false));}
 const workerFailures:unknown[]=[];
 const retirementReader=createBifrostRetirementReader(),retirementOwner=Object.freeze({id:row.id}),retirementTicket=retirementReader.capture(retirementOwner);
 checkpoints.mark(caseIndex,"worker_retirement","enter");
 try{
  await retirementReader(retirementOwner,nativeFetch,undefined,[origin+"/__bifrost/join/"+row.id,{method:"POST",headers:{"content-type":"application/json"},body:"{}"}],"text",(_kind:string,start:Function)=>start(),retirementTicket);
  retirementReader.parse(retirementTicket);proof=retirementReader.validate(retirementTicket,validateBifrostRetirementProof);
  w.sourceExpired=proof.source?.expired??null;w.retirementProof=proof;
  retirementReader.verdict(retirementTicket,(response:any,value:any)=>{worker=row.mode==="progress"?bifrostObserveRetirementVerdict(retirementReader.inspect(retirementTicket),response,value):response.status===200&&value.retired===true;if(!worker)throw Error("independent Worker retirement failed");});
 }catch(e){workerFailures.push(e);}
 w.workerRetired=worker&&workerFailures.length===0;
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
  if(evaluated.qualified&&row.control==="provider_error")allowed=evaluated.negative??[];
  const reports=controlReports.get(row.api)??new Map();try{emitControl(row,w,evaluated,worker);}catch(e){failures.push(e);evaluated.qualified=false;}
  reports.set(row.control,evaluated);controlReports.set(row.api,reports);const q=bifrostQualification([...reports.values()],nativeIdentity,"bifrost",row.api);if(q)qualifications.set(row.api,q);
  if(!evaluated.qualified)failures.push(Error("native control qualification incomplete"));
 }else if(row.mode==="partial"||row.mode==="progress"||row.mode==="provider_error")allowed=bifrostProductExpected(w,qualifications.get(row.api));
 if(row.mode==="provider_error"&&allowed.length&&bifrostProviderErrorVector(w)!==allowed)allowed=[];
 for(const o of originals)if(o.state==="rejected"&&!allowed.includes(o))failures.push(o.reason);else if(o.state==="pending")failures.push(Error("original operation pending"));
 if(row.mode==="progress"){
  const f=bifrostProgressWitness(w,proof,allowed,worker,workerFailures);
  if(!bifrostProgressQualified(f))failures.push(Error("progress case physical or accounting proof incomplete"));
 }
 failures.push(...w.syncFailures,...w.observerFailures,...workerFailures);
 if(failures.length)try{checkpoints.evidence(bifrostCaseEvidence(caseIndex,w,proof,worker,workerFailures,retirementReader.inspect(retirementTicket)));}catch(e){checkpoints.failures.push(e);}
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
