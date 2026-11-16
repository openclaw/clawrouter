import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { isProxy } from "node:util/types";
import { afterAll, describe, expect, it, vi } from "vitest";
import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { createProviderApiKeyResolver, createProviderAuthResolver } from "../../src/agents/models-config.providers.secrets.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { AuthProfileStore } from "../../src/agents/auth-profiles/types.js";
import type { DispatcherAwareRequestInit } from "../../src/infra/net/runtime-fetch.js";
import * as guard from "../../src/infra/net/fetch-guard.js";
import * as transportHost from "../../packages/ai/src/host.js";
import * as openAITransport from "../../packages/ai/src/transports/openai-transport-shared.js";

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

// Only these two pinned defining namespaces may use Vitest's configurable
// getter exports. Resolve once, then let spyOn read a temporary data descriptor;
// returned-host buildModelFetch admission remains own-data-only.
// V11 records callback delivery, not lexical interception or transport authority.
// Counts are closed buckets: 0 none, 1 one, 2 multiple. The first entry on
// each side of binding has an outcome: 0 absent, 1 entered, 2 returned, 3/4 threw undefined/defined.
// Guard association uses ONLY the original current() result; lookup/hook have no
// context operand and remain unbound. Before-bind entries never acquire later credit.
export function createPrivateCallbackWitness(owner:any,proxyCheck:Function,faults:unknown[]) {
 const rows=Array.from({length:3},()=>({before:0,after:0,early:null as any,first:null as any})),tickets=new WeakSet<object>();
 const defining:any[]=[null,null];let target:any,invalid=false;
 const observe=(fn:Function)=>{try{return fn();}catch(error){invalid=true;faults.push(error);return undefined;}};
 const same=(a:any,b:any)=>!!a&&!!b&&["value","get","set","writable","enumerable","configurable"].every(k=>a[k]===b[k]);
 return {
  bind(i:any){observe(()=>{if(target||!i||proxyCheck(i)||i.owner!==owner||i.kind!=="inference"||!Object.isFrozen(i))throw Error("foreign Private callback target");target=i;});},
  defining(kind:number,module:any,name:string,descriptor:any){observe(()=>{
   if(![0,1].includes(kind)||defining[kind]||proxyCheck(module)||name!==["getAiTransportHost","withOpenAIErrorResponseHook"][kind]||!descriptor||!Object.hasOwn(descriptor,"value")||typeof descriptor.value!=="function")throw Error("foreign Private callback descriptor");
   defining[kind]={module,name,descriptor:{...descriptor},state:1};
  });},
  enter(kind:number){return observe(()=>{if(![0,1,2].includes(kind))throw Error("foreign Private callback kind");
   const row=rows[kind],ticket={kind,target,state:1,binding:0};tickets.add(ticket);
   if(target){row.after=Math.min(2,row.after+1);row.first??=ticket;}else{row.before=Math.min(2,row.before+1);row.early??=ticket;}
   return ticket;
  });},
  associate(ticket:any,invocation:any){observe(()=>{if(!ticket||!tickets.has(ticket)||ticket.kind!==2||ticket.state!==1||ticket.binding!==0)throw Error("foreign Private callback association");
   ticket.binding=ticket.target&&invocation===ticket.target?1:2;
  });},
  returned(ticket:any){observe(()=>{if(!ticket||!tickets.has(ticket)||ticket.state!==1)throw Error("foreign Private callback return");ticket.state=2;});},
  threw(ticket:any,reason:unknown){observe(()=>{if(!ticket||!tickets.has(ticket)||ticket.state!==1)throw Error("foreign Private callback throw");ticket.state=reason===undefined?3:4;});},
  snapshot(invocation:any){const value=observe(()=>{
   if(!target||invocation!==target)return null;
   let custody=0;
   for(let k=0;k<2;k++){const d=defining[k];if(d){if(proxyCheck(d.module)||!same(Object.getOwnPropertyDescriptor(d.module,d.name),d.descriptor))d.state=2;custody+=d.state*3**k;}}
   let packed=0;
   for(let k=2;k>=0;k--){const r=rows[k],t=r.first,early=r.before?(r.before-1)*4+r.early.state:0;
    const late=r.after?(k===2?((r.after-1)*4+t.state-1)*3+t.binding+1:(r.after-1)*4+t.state):0;packed=packed*81+early+9*late;}
   return packed*9+custody;
  });return invalid||value===undefined?null:value;},
 };
}

export function installPrivateDefiningSpy(module:any,name:string,observe:Function,restores:Function[],callbacks?:any) {
 if(!((module===transportHost&&name==="getAiTransportHost")||(module===openAITransport&&name==="withOpenAIErrorResponseHook"))||isProxy(module))throw Error("foreign Private defining module");
 const original=Object.getOwnPropertyDescriptor(module,name);
 if(!original||!original.configurable)throw Error("missing Private defining seam");
 const data=Object.hasOwn(original,"value");
 if(!data&&(!original.enumerable||typeof original.get!=="function"||original.set!==undefined))throw Error("unsupported Private defining getter");
 const callable=data?original.value:Reflect.apply(original.get!,undefined,[]);
 if(typeof callable!=="function"||!samePrivateDescriptor(Object.getOwnPropertyDescriptor(module,name),original))throw Error("changed Private defining seam");
 const normalized=data?original:{value:callable,writable:true,enumerable:original.enumerable,configurable:true};
 let owned=original,seam:ReturnType<typeof vi.spyOn>|undefined,active=true;
 restores.push(()=>{
  if(!active)throw Error("duplicate Private defining restoration");active=false;
  if(!samePrivateDescriptor(Object.getOwnPropertyDescriptor(module,name),owned))throw Error("foreign Private defining seam");
  const failures:unknown[]=[];
  try{seam?.mockRestore();}catch(error){failures.push(error);}
  try{
   const current=Object.getOwnPropertyDescriptor(module,name);
   if(!samePrivateDescriptor(current,normalized)&&!samePrivateDescriptor(current,owned))throw Error("foreign Private defining restoration");
   Object.defineProperty(module,name,original);
   if(!samePrivateDescriptor(Object.getOwnPropertyDescriptor(module,name),original))throw Error("incomplete Private defining restoration");
  }catch(error){failures.push(error);}
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"Private defining restoration failed");
 });
 if(!data){Object.defineProperty(module,name,normalized);owned=normalized;}
 seam=vi.spyOn(module as any,name as any);owned=Object.getOwnPropertyDescriptor(module,name)!;
 if(!samePrivateDescriptor(owned,{...normalized,value:seam}))throw Error("unexpected Private defining spy");
 seam.mockImplementation(function(this:unknown,...args:unknown[]){
  const entry=callbacks?.enter(name==="getAiTransportHost"?0:1);
  try{const value=observe(callable,this,args);callbacks?.returned(entry);return value;}
  catch(reason){callbacks?.threw(entry,reason);throw reason;}
 });
 if(!samePrivateDescriptor(Object.getOwnPropertyDescriptor(module,name),owned))throw Error("changed Private defining spy");
 callbacks?.defining(name==="getAiTransportHost"?0:1,module,name,owned);
}

// Defining-module observations only. Model identity binds a single original
// invocation; the original transport context must independently match it before
// publication. No lookup, model-fetch call or async-context read is added.
export function createPrivateSelectionWitness(owner:any,proxyCheck:Function,faults:unknown[],globalObject:any) {
 let invocation:any,model:any,host:any,descriptor:any,installed:any,returned:any,selected:any;
 let active=true,invalid=false,busy=false,lookupSeen=false,buildSeen=false,hookSeen=false,code=0;
 let globalDescriptor:any;
 const fail=(error:unknown)=>{invalid=true;faults.push(error);};
 const observe=(fn:Function)=>{try{fn();}catch(error){fail(error);}};
 const deny=()=>{invalid=true;};
 const own=(object:any,key:string)=>{
  if(!object||(typeof object!=="object"&&typeof object!=="function")||proxyCheck(object))return undefined;
  const d=Object.getOwnPropertyDescriptor(object,key);return d&&Object.hasOwn(d,"value")?d:undefined;
 };
 const same=(a:any,b:any)=>!!a&&!!b&&["value","writable","enumerable","configurable"].every(k=>a[k]===b[k]);
 const originalThrow=(reason:unknown)=>{code=reason===undefined?8:9;};
 const build=function(this:unknown,...args:any[]){
  const original=descriptor.value;let eligible=false;
  observe(()=>{if(!active)throw Error("late Private model fetch");eligible=!invalid&&!busy&&!buildSeen&&this===host&&args[0]===model&&same(own(host,"buildModelFetch"),installed);
   if(!eligible){deny();return;}buildSeen=true;busy=true;code=3;});
  let value;try{value=Reflect.apply(original,this,args);}catch(reason){if(eligible)originalThrow(reason);throw reason;}finally{if(eligible)busy=false;}
  observe(()=>{if(eligible&&!invalid){returned=value;code=4;}});return value;
 };
 return {
  bind(i:any){observe(()=>{if(!active||invocation||!i||i.owner!==owner||i.kind!=="inference"||!Object.isFrozen(i)||!i.args[0]){deny();return;}
   invocation=i;model=i.args[0];});},
  globalDescriptor(d:any){observe(()=>{if(globalDescriptor||!d||!Object.hasOwn(d,"value")||typeof d.value!=="function"){deny();return;}globalDescriptor={...d};});},
  lookup(fn:Function,receiver:unknown,args:any[]){
   let eligible=false;
   observe(()=>{if(!active)throw Error("late Private host lookup");if(!invocation)return;eligible=!invalid&&!busy&&!lookupSeen;
    if(!eligible){deny();return;}lookupSeen=true;busy=true;});
   let value;try{value=Reflect.apply(fn,receiver,args);}catch(reason){if(eligible)originalThrow(reason);throw reason;}finally{if(eligible)busy=false;}
   observe(()=>{if(!eligible||invalid)return;const d=own(value,"buildModelFetch");
    if(!d||!d.writable||!d.configurable||typeof d.value!=="function"){code=10;return;}
    host=value;descriptor=d;installed={...d,value:build};Object.defineProperty(host,"buildModelFetch",installed);code=2;
   });return value;
  },
  hook(fn:Function,receiver:unknown,args:any[]){
   let eligible=false,kind=0;
   observe(()=>{if(!active)throw Error("late Private hook selection");if(!invocation)return;eligible=!invalid&&!busy&&lookupSeen&&buildSeen&&!hookSeen&&code===4&&args[2]===model&&same(own(host,"buildModelFetch"),installed);
    if(!eligible){deny();return;}hookSeen=true;busy=true;selected=args[0];if(typeof selected!=="function"){deny();return;}
    if(returned!==null&&returned!==undefined){if(selected!==returned){deny();return;}kind=6;}
    else{const current=own(globalObject,"fetch");if(!same(current,globalDescriptor)||selected!==globalDescriptor.value){deny();return;}kind=7;}
    code=5;
   });
   let value;try{value=Reflect.apply(fn,receiver,args);}catch(reason){if(eligible)originalThrow(reason);throw reason;}finally{if(eligible)busy=false;}
   observe(()=>{if(eligible&&!invalid)code=kind;});return value;
  },
  snapshot(i:any){if(!i||!invocation)return 0;if(i!==invocation){deny();return 1;}
   observe(()=>{if(installed&&!same(own(host,"buildModelFetch"),installed))deny();
    if(code===7&&!same(own(globalObject,"fetch"),globalDescriptor))deny();});return invalid?1:code;},
  restore(){const failures:unknown[]=[];if(!active)failures.push(Error("duplicate Private selection restoration"));active=false;
   if(host&&installed){try{if(!same(own(host,"buildModelFetch"),installed))throw Error("foreign Private host descriptor");Object.defineProperty(host,"buildModelFetch",descriptor);}catch(error){invalid=true;failures.push(error);}}
   if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"Private selection restoration failed");
  },
 };
}

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
export function createPrivateInvocationOwnership(storage:any,evidence?:any) {
 const invocations=new WeakSet<object>(),acquisitions=new WeakSet<object>(),transports=new WeakSet<object>(),responses=new WeakMap<object,any>();
 let active=true;
 const current=(at?:Function,retained?:any)=>{const value=at?at(0,()=>storage.getStore()):storage.getStore();
  if(at?at(1,()=>!active,true)||at(2,()=>!value,true)||at(3,()=>!invocations.has(retained?(retained.invocation=value.invocation):value.invocation),true):
   !active||!value||!invocations.has(value.invocation))throw Error("incomplete invocation context");return value;};
 // Diagnostic-only private census. No WeakSet query, context reread or native
 // operand is added. Zero records cannot identify a foreign module or a bypass.
 // Bits: 0..2 UNKNOWN/zero/one/multiple/contradictory; 3..4 context
 // unobserved/same/different; 5..6 unobserved/in-call/returned-pending/settled;
 // 7 means a different recorded invocation also exists, never the current owner.
 const acquisitionSnapshot=(retained:any,passed:number)=>{
  if(!evidence||(passed&8)===0)return 0;
  const missing={},bad={};
  const own=(o:any,k:string)=>{if(!o||typeof o!=="object"||evidence.isProxy(o))throw bad;
   const d=Object.getOwnPropertyDescriptor(o,k);if(!d)return missing;if(!Object.hasOwn(d,"value"))throw bad;return d.value;};
  const list=(a:any)=>{const n=own(a,"length");if(!Array.isArray(a)||!Number.isSafeInteger(n)||n<0||n>4096)throw bad;
   return Array.from({length:n},(_,i)=>{const v=own(a,String(i));if(v===missing)throw bad;return v;});};
  try{
   const invocation=retained.invocation,owner=evidence.owner,rows=list(evidence.acquisitions),ops=list(evidence.originals);
   if(own(evidence.ledger,"owner")!==owner||own(evidence.ledger,"acquisitions")!==evidence.acquisitions||own(evidence.ledger,"originals")!==evidence.originals||own(invocation,"owner")!==owner||new Set(rows).size!==rows.length||new Set(ops).size!==ops.length)throw bad;
   let count=0,context=0,phase=0,other=0;
   for(const a of rows){const i=own(a,"invocation"),c=own(a,"context"),o=own(a,"operation"),state=own(o,"state"),ret=own(o,"returnAt"),settle=own(o,"settle");
    if(own(i,"owner")!==owner||own(a,"owner")!==owner||own(c,"invocation")!==i||own(c,"acquisition")!==a||!Object.isFrozen(i)||!Object.isFrozen(c)||own(a,"guard")!==evidence.guard||
     !ops.includes(o)||own(o,"owner")!==owner||own(o,"kind")!=="guard"||own(o,"acquisition")!==a||list(own(o,"args"))[0]!==own(a,"input")||
     !Number.isSafeInteger(own(a,"invoke"))||own(a,"invoke")<1||!Number.isSafeInteger(own(o,"invoke"))||own(o,"invoke")<=own(a,"invoke")||
     !Number.isSafeInteger(ret)||ret<0||!Number.isSafeInteger(settle)||settle<0||!["pending","fulfilled","rejected","threw"].includes(state))throw bad;
    let at=0;
    if(state==="pending"){
     if(settle!==0)throw bad;
     if(ret===0){if(own(o,"pending")!==missing||own(a,"pending")!==missing)throw bad;at=1;}
     else{const pending=own(o,"pending");if(pending===missing||pending!==own(o,"returned")||pending!==own(a,"pending")||ret<=own(o,"invoke"))throw bad;at=2;}
    }else{if(settle<=own(o,"invoke")||ret!==0&&ret<=own(o,"invoke"))throw bad;at=3;}
    if(i===invocation){count++;context=c===retained.context?1:2;phase=at;}else other=128;
   }
   for(const o of ops)if(own(o,"kind")==="guard"){const a=own(o,"acquisition");if(!rows.includes(a)||own(a,"operation")!==o)throw bad;}
   return count===0?1+other:count===1?2+context*8+phase*32+other:3+other;
  }catch(error){if(error===bad)return 4;throw error;}
 };
 const bound=(t:any)=>{const a=t.acquisition,i=t.invocation;
  return active&&transports.has(t)&&acquisitions.has(a)&&invocations.has(i)&&a.invocation===i&&t.context===a.context&&
   t.context?.invocation===i&&t.context?.acquisition===a&&a.transport===t&&(i.kind==="inference"?t.caller===i.caller:t.caller===undefined&&t.catalogInitiator===i.caller)&&t.owner===i.owner;};
 return {
  invoke(caller:any,kind:string,fn:Function,receiver:unknown,args:any[]){
   if(!active||!["discovery","inference"].includes(kind)||caller.kind!==kind||args[kind==="discovery"?0:2]?.signal!==caller.signal)throw Error("incomplete public caller");
   const invocation=Object.freeze({caller,signal:caller.signal,owner:caller.owner,kind,fn,receiver,args:Object.freeze([...args])});invocations.add(invocation);
   if(kind==="inference"){evidence?.callbacks?.bind(invocation);evidence?.selection?.bind(invocation);}
   return storage.run(Object.freeze({invocation}),()=>Reflect.apply(fn,receiver,args));
  },
  guard(fn:Function,receiver:unknown,args:any[],a:any){
   const outer=current();if(evidence?.callbacks)evidence.callbacks.associate(a.callbackEntry,outer.invocation);if(outer.acquisition||acquisitions.has(a)||a.input!==args[0]||a.guard!==fn)throw Error("incomplete guard ownership");
   acquisitions.add(a);a.invocation=outer.invocation;a.owner=outer.invocation.owner;
   a.context=Object.freeze({invocation:outer.invocation,acquisition:a});
   return storage.run(a.context,()=>Reflect.apply(fn,receiver,args));
  },
  transport(t:any,observe?:Function,observerFailures:unknown[]=[]){
   // V8 observes only these original evaluations. False condition operands pass;
   // read sites 0/4 pass on return. No skipped predicate is evaluated for reporting.
   let site=0,evaluated=0,passed=0,operand=false;const retained:any={};
   const at=(id:number,fn:Function,condition=false)=>{site=id;evaluated|=2**id;operand=true;
    const value=fn();if(id===0)retained.context=value;operand=false;if(!condition||!value)passed|=2**id;return value;};
   try{
    const context=current(at,retained),a=at(4,()=>context.acquisition);
    if(at(5,()=>!a,true)||at(6,()=>!acquisitions.has(a),true)||at(7,()=>a.context!==context,true)||
     at(8,()=>a.transport,true)||at(9,()=>transports.has(t),true)||
     at(10,()=>(t.method==="POST"?"inference":t.method==="GET"?"discovery":"invalid")!==context.invocation.kind,true))throw Error("incomplete transport ownership");
    t.context=context;t.invocation=context.invocation;t.acquisition=a;t.caller=context.invocation.kind==="inference"?context.invocation.caller:undefined;t.catalogInitiator=context.invocation.kind==="discovery"?context.invocation.caller:undefined;t.owner=context.invocation.owner;
    a.transport=t;transports.add(t);
   }catch(reason){
    if(observe&&evaluated!==passed){try{const trace:any[]=[11,site,evaluated,passed,operand,reason!==undefined];if(evidence)trace.push(acquisitionSnapshot(retained,passed));if(evidence?.selection)trace.push((passed&8)!==0?evidence.selection.snapshot(retained.invocation):0);if(evidence?.callbacks)trace.push((passed&8)!==0?evidence.callbacks.snapshot(retained.invocation):null);observe(trace);}catch(error){observerFailures.push(error);}}
    throw reason;
   }
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
// Closed diagnostics only. They report boundaries, never classify an error.
// V2 keeps the first unexpected failure and an independently case-bound receipt.
// Stage 0 is UNKNOWN, 1 entered, 2 fulfilled, 3 failed; none identifies a runner
// or collection failure. Owner counts exist only after that private owner's join.
// Each reporter reserves entry and first-failure slots within its seven-record budget;
// incomplete delivery does not imply an uninvoked test or a successful case.
export function validatePrivateCheckpoint(record:any):void {
 if(record?.v===11){
  if(!Array.isArray(record.meta)||record.meta.length!==5)throw Error("invalid Private callback metadata");
  const packed=record.meta?.[3];
  if(!Number.isSafeInteger(packed)||packed<8712||packed>=8712*13286026)throw Error("invalid Private callback capsule");
  if(Math.floor((packed%8712)/792)<4)throw Error("unbound Private callback capsule");
  validatePrivateCheckpoint({...record,v:10,meta:[...record.meta.slice(0,3),packed%8712,record.meta[4]]});return;
 }

 const phases=["module","setup","case_setup","case_result","child","body","original_join","read","closed","cancel","release","observer","worker_retirement","restoration","cleanup","control","assertions","final","overflow","callback","selection","owner","postlude","registration"];
 const integer=(n:any,max:number)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
 const nullable=(n:any,max:number)=>n===null||integer(n,max);
 const conditionTuple=(p:any,version:number)=>{
  if(version===10){if(!integer(p,8711))return false;const code=p%11,word=Math.floor(p/11);if(Math.floor(word/72)<4&&code!==0)return false;p=[word];version=9;}
  if(!Array.isArray(p)||p.length!==(version===9?1:2))return false;
  let m=p[0],f=p[1],n=0;
  if(version===9){if(!integer(p[0],791))return false;n=[0,1,3,4,42,50,74,82,106,114,129,131,170,178,202,210,234,242][p[0]%18];f=Math.floor(p[0]/18);m=(2**(Math.floor(f/4)+1)-1)*2048+2**Math.floor(f/4)-1;
   if(![0,1,3,4,42,50,74,82,106,114,129,131,170,178,202,210,234,242].includes(n)||Math.floor(f/4)<4&&n!==0)return false;}
  return integer(m,4193279)&&integer(f,43)&&Math.floor(m/2048)===2**(Math.floor(f/4)+1)-1&&m%2048===2**Math.floor(f/4)-1&&((f&2)!==0||![0,4].includes(Math.floor(f/4)));
 };
 const fieldV6=(p:any)=>Array.isArray(p)&&p.length===2&&integer(p[0],5)&&(p[0]===5?integer(p[1],12)&&p[1]>0:p[1]===null);
 const tuple=(a:any,length:number,valid:(x:any)=>boolean)=>Array.isArray(a)&&a.length===length&&a.every(valid);
 if(record?.v===3){
  const base=record.pin==="e2a8b8d4ec290cd6c035f3568a14e4d7c6433635";
  if(record.kind==="progress"){
   if(!base||Object.keys(record).sort().join(",")!==["v","pin","lane","kind","point","decl","registration"].sort().join(",")||record.lane!=="sdk"||
    !["describe_return","callback","registration_failure"].includes(record.point)||!nullable(record.decl,65)||!Array.isArray(record.registration)||record.registration.length!==6||
    !record.registration.slice(0,2).every((n:any)=>integer(n,2))||!integer(record.registration[2],1)||!record.registration.slice(3,5).every((n:any)=>integer(n,66))||
    !nullable(record.registration[5],65)||record.registration[4]>record.registration[3]||
    (record.point==="callback"&&record.decl===null))throw Error("invalid Private registration progress");
   return;
  }
  if(record.kind==="exec"){
   if(!base||Object.keys(record).sort().join(",")!==["v","pin","lane","kind","phase","state","defined","fields"].sort().join(",")||record.lane!=="outer"||
    !["copy","exec"].includes(record.phase)||!["fulfilled","rejected","threw"].includes(record.state)||
    (record.state==="fulfilled"?record.defined!==null:typeof record.defined!=="boolean")||
    (record.phase==="copy"&&(record.state==="fulfilled"||record.fields!==null)))throw Error("invalid Private exec boundary");
   if(record.fields!==null){if(record.phase!=="exec"||record.state==="fulfilled"||!Array.isArray(record.fields)||record.fields.length!==3)throw Error("invalid Private process fields");
    record.fields.forEach((pair:any,index:number)=>{if(!Array.isArray(pair)||pair.length!==2||!integer(pair[0],4)||
     (pair[0]!==2?pair[1]!==null:index===0?!(Number.isSafeInteger(pair[1])&&pair[1]>=-2147483648&&pair[1]<=2147483647):
      index===1?!(pair[1]===null||["SIGTERM","SIGKILL","SIGABRT","SIGINT"].includes(pair[1])):typeof pair[1]!=="boolean"))throw Error("invalid Private process primitive");});}
   return;
  }
  throw Error("unknown Private boundary capsule");
 }
 if(record?.v===2||record?.v===4||record?.v===5||record?.v===6||record?.v===7||record?.v===8||record?.v===9||record?.v===10){
  const keys=["v","pin","lane","case","phase","state","defined","decl","stages","owner","receipt",...([4,5,6,7,8,9,10].includes(record.v)?["body"]:[]),...([5,6,7,8,9,10].includes(record.v)?["meta"]:[])];
  if(Object.keys(record).sort().join(",")!==keys.sort().join(",")||record.pin!=="e2a8b8d4ec290cd6c035f3568a14e4d7c6433635"||
   !["sdk","outer"].includes(record.lane)||!nullable(record.case,107)||!phases.includes(record.phase)||!["rejected","threw"].includes(record.state)||typeof record.defined!=="boolean"||
   !nullable(record.decl,65)||!tuple(record.stages,7,x=>integer(x,3))||!(record.owner===null||tuple(record.owner,6,x=>integer(x,65535))))throw Error("invalid Private primary capsule");
  if(record.v===4||record.v===5||record.v===6||record.v===7||record.v===8||record.v===9||record.v===10){const b=record.body;
   if(record.lane!=="sdk"||record.phase!=="body"||record.case===null||record.decl===null||record.decl>=24||record.decl%4!==0||record.stages[4]!==3||record.owner!==null||record.receipt!==null||
    !Array.isArray(b)||b.length!==7||!integer(b[0],22)||![5,6,7].includes(b[1])||b[2]!==record.defined||!integer(b[3],4194303)||b[3]>=2**b[0]||!integer(b[4],3)||
    (b[0]<5&&b[4]!==0)||(b[0]<18&&(b[4]&2)!==0)||!nullable(b[5],3)||!(b[6]===null||tuple(b[6],4,x=>integer(x,65535)))||
    (b[1]===6&&(![5,18].includes(b[0])||(b[4]&(b[0]===5?1:2))!==0))||(b[5]!==null&&b[0]<20))throw Error("invalid Private EOF body span");
  }
  if(record.v===5||record.v===6||record.v===7||record.v===8||record.v===9||record.v===10){const m=record.meta;
   const field=(p:any,max:number)=>Array.isArray(p)&&p.length===2&&integer(p[0],5)&&(p[0]===5?integer(p[1],max)&&p[1]>0:p[1]===null);
   if(record.case!==0||record.decl!==0||!Array.isArray(m)||m.length!==(record.v>=6?5:4)||!field(m[0],2)||!field(m[1],10)||
    !Array.isArray(m[2])||m[2].length!==2||!integer(m[2][0],3)||(m[2][0]===1?!(Number.isInteger(m[2][1])&&m[2][1]>=100&&m[2][1]<=599):m[2][1]!==null)||
    !(record.v===8||record.v===9||record.v===10?conditionTuple(m[3],record.v):
     m[3]===null||Array.isArray(m[3])&&m[3].length===3&&([1,2,3].includes(m[3][0])&&[1,2].includes(m[3][1])||record.v===7&&integer(m[3][0],20)&&m[3][0]>=4&&m[3][1]===1)&&typeof m[3][2]==="boolean")||
    (record.body[0]<14&&m[2][0]!==0)||(!(record.body[4]&2)&&(m[0][0]!==0||m[1][0]!==0)))throw Error("invalid Private result metadata span");
  }
  if((record.v===6||record.v===7||record.v===8||record.v===9||record.v===10)&&(!fieldV6(record.meta[4])||(!(record.body[4]&2)&&record.meta[4][0]!==0)))throw Error("invalid Private wording span");
  if(record.v===7&&!(record.meta[3]?.[0]>=4))throw Error("missing Private capture failure");
  if(record.owner!==null&&(record.lane!=="sdk"||record.case===null||record.stages[5]!==2))throw Error("unjoined Private owner capsule");
  if(record.receipt!==null){const r=record.receipt;
   if(record.lane!=="outer"||!Array.isArray(r)||r.length!==6||!integer(r[0],107)||!(r[1]===null||Array.isArray(r[1])&&r[1].length===4&&integer(r[1][0],33)&&nullable(r[1][1],65535)&&integer(r[1][2],1)&&typeof r[1][3]==="boolean")||
    !tuple(r[2],2,x=>integer(x,131071))||!tuple(r[3],2,x=>integer(x,131071))||r[3].some((v:number,i:number)=>(v&r[2][i])!==v)||
    !(r[4]===null||Array.isArray(r[4])&&r[4].length===14&&integer(r[4][0],3)&&r[4][1]===(r[4][0]===3)&&(r[4][1]?typeof r[4][2]==="boolean":r[4][2]===null)&&
     (r[4][3]===null||typeof r[4][3]==="boolean")&&r[4].slice(4,13).every((x:any)=>nullable(x,65535))&&typeof r[4][13]==="boolean")||
    !(r[5]===null||Array.isArray(r[5])&&r[5].length===6&&integer(r[5][0],3)&&r[5][1]===(r[5][0]===3)&&(r[5][1]?typeof r[5][2]==="boolean":r[5][2]===null)&&
     typeof r[5][3]==="boolean"&&(r[5][3]?r[5][0]===2&&integer(r[5][4],65535):r[5][4]===null)&&typeof r[5][5]==="boolean"))throw Error("invalid Private receipt capsule");
   if(r[1]===null){if(r[2].some((n:number)=>n!==0)||r[3].some((n:number)=>n!==0)||(r[4]===null&&r[5]===null))throw Error("unobserved Private receipt predicate");}
   else{const id=r[1][0],band=Math.floor(id/17),bit=2**(id%17);
    if(!(r[2][band]&bit)||(r[3][band]&bit)||!([1,2,3,...Array.from({length:14},(_,i)=>i+11)].includes(id)?nullable(r[1][1],65535):r[1][1]===null))throw Error("inconsistent Private receipt predicate");}
  }return;
 }
 const keys=["v","pin","lane","case","phase","state","defined","acq","op","count"];
 if(!record||Object.keys(record).sort().join(",")!==keys.sort().join(",")||record.v!==1||
  record.pin!=="e2a8b8d4ec290cd6c035f3568a14e4d7c6433635"||!["outer","sdk"].includes(record.lane)||!phases.includes(record.phase)||
  !["enter","fulfilled","rejected","threw","summary"].includes(record.state)||!(record.defined===null||typeof record.defined==="boolean")||
  ![record.case,record.acq,record.op].every((n:any)=>nullable(n,4095))||!(record.case===null||record.case<108)||!integer(record.count,65535)||
  (["rejected","threw"].includes(record.state)?typeof record.defined!=="boolean":record.defined!==null))throw Error("invalid Private checkpoint");
}
export function createPrivateCheckpointReporter(lane:string,emit:Function) {
 const records=new Map<string,any>(),sent=new Set<string>(),observers:Promise<unknown>[]=[],failures:unknown[]=[];
 const bodyScopes=new Map<number,any>();
 const declarations=new Map<number,number>(),scopes=new Map<string,number[]>(),owners=new Map<number,number[]>();
 let emitted=0,suppressed=0,finished=false,failed=0,first:any=null,receipt:any=null,primarySent=false,entrySent=false,registrationFailed=false;
 const registration:(number|null)[]=[0,0,0,0,0,null];
 const stageNames=["callback","selection","setup","owner","body","original_join","postlude"];
 const scope=(index:number|null,decl:number|null)=>{const key=index===null?"declaration:"+decl:"case:"+index;let value=scopes.get(key);if(!value){value=Array(7).fill(0);scopes.set(key,value);}return value;};
 const make=(index:number|null,phase:string,state:string,reason:unknown,acq:number|null=null,op:number|null=null,count=0)=>({v:1,pin:"e2a8b8d4ec290cd6c035f3568a14e4d7c6433635",lane,case:index,phase,state,
  defined:state==="rejected"||state==="threw"?reason!==undefined:null,acq,op,count});
 const send=(record:any)=>{try{validatePrivateCheckpoint(record);emit(record);}catch(error){failures.push(error);}};
 // V4 is the same reserved primary slot. It adds a source span, never a matcher
 // verdict or a joined owner. 1 entered, 2 returned, 3 awaiting, 4 await fulfilled;
 // failure snapshots use 5 sync span threw, 6 await rejected, 7 intervening UNKNOWN.
 // Tuple: site, failure kind, definedness, returned-site bits, fulfilled-await bits,
 // original stop operand enum, retained read-state counts (pending/fulfilled/rejected/threw).
 // stop: null unobserved, 0 stop, 1 error, 2 aborted, 3 other original operand.
 // Read counts do not inspect chunks/done or prove EOF, absence of I/O, or joins.
 const bodySnapshot=(index:number,reason:unknown)=>{const b=bodyScopes.get(index);if(!b||b.invalid)return null;
  b.failed=true;const counts=[0,0,0,0];
  for(const o of b.originals)if(o.kind==="read"){const at=["pending","fulfilled","rejected","threw"].indexOf(o.state);if(at<0||++counts[at]>65535)return null;}
  return [b.site,b.state===1?5:b.state===3?6:7,reason!==undefined,b.returned,b.awaited,b.stop,counts];};
 const primary=()=>{if(!first||primarySent)return;primarySent=true;const b=first.body??null;
  send({v:b===null?2:first.meta===null?4:(typeof first.meta[3]==="number"?(first.meta[3]>=8712?11:10):first.meta[3]?.length===1?9:first.meta[3]?.length===2?8:first.meta[3]?.[0]>=4?7:6),pin:first.pin,lane,case:first.case,phase:first.phase,state:first.state,defined:first.defined,decl:first.decl,
   stages:[...scope(first.case,first.decl)],owner:first.case===null?null:owners.get(first.case)??null,receipt,...(b===null?{}:{body:b}),...(first.meta===null?{}:{meta:first.meta})});};
 const progress=(point:string,decl:number|null)=>({v:3,pin:"e2a8b8d4ec290cd6c035f3568a14e4d7c6433635",lane,kind:"progress",point,decl,registration:[...registration]});
 const entry=(record:any)=>{if(entrySent)return;entrySent=true;send(record);};
 const mark=(index:number|null,phase:string,state:string,reason?:unknown,acq:number|null=null,op:number|null=null,decl:number|null=null)=>{
  try{const record=make(index,phase,state,reason,acq,op);validatePrivateCheckpoint(record);if(finished)throw Error("checkpoint after final flush");
   decl=decl??(index===null?null:declarations.get(index)??null);const at=stageNames.indexOf(phase);
   if(at>=0){const stages=scope(index,decl);if(stages[at]!==3)stages[at]=state==="enter"?1:state==="fulfilled"?2:3;}
   const key=String(index)+":"+phase;if(!["rejected","threw"].includes(records.get(key)?.state))records.set(key,record);
   if(state==="rejected"||state==="threw"){failed++;
    // Raw read/closed/cancel outcomes are not themselves the SDK case verdict.
    if(!first&&!["read","closed","cancel","release"].includes(phase)){first={...record,decl,body:lane==="sdk"&&phase==="body"&&index!==null?bodySnapshot(index,reason):null,meta:null};if(first.body!==null){const m=bodyScopes.get(index!)?.metadata;if(m)first.meta=[m.type,m.code,m.http,m.first,m.wording].map((v:any)=>v===null||typeof v==="number"?v:[...v]);}if(lane==="sdk")primary();}}
   if(lane==="sdk"&&phase==="callback"&&state==="enter")entry(progress("callback",decl));
  }catch(error){failures.push(error);}
 };
 const flush=(index:number|null)=>{
  const selected=[...records.values()].filter(r=>r.case===index);selected.sort((a,b)=>Number(["rejected","threw"].includes(b.state))-Number(["rejected","threw"].includes(a.state)));
  for(const record of selected){const key=JSON.stringify(record);if(sent.has(key))continue;sent.add(key);
   // Five ordinary slots, one original-entry/exec capsule and one primary capsule.
   if(emitted<5){emitted++;send(record);}else suppressed=Math.min(65535,suppressed+1);}
 };
 // V5 labels are exact E2 facade outputs: stream.ts, sqlite-error-diagnostics.ts,
 // postgres-sync/protocol.ts. Arbitrary transport labels (including numeric code
 // strings) stay UNKNOWN; a projected code never stands in for HTTP status.
 // Field pairs: 0 unobserved, 1 missing, 2 undefined, 3 accessor, 4 UNKNOWN,
 // 5 exact whitelist enum (one-based). HTTP: 0 absent, 1 supplied own status,
 // 2 unknown field, 3 invalid invocation. Failure: guard/fetch/read, threw/rejected,
 // definedness. These observations do not establish cause, EOF or joined ownership.
 const own=(m:any,value:any,key:string)=>{if(!value||typeof value!=="object"||m.isProxy(value))return [4,null];
  const d=Object.getOwnPropertyDescriptor(value,key);return !d?[1,null]:!Object.hasOwn(d,"value")?[3,null]:d.value===undefined?[2,null]:[5,d.value];};
 const invalidateMetadata=(index:number)=>{const b=bodyScopes.get(index),m=b?.metadata;if(m){m.invalid=true;m.type=b.awaited&2?[4,null]:[0,null];m.code=b.awaited&2?[4,null]:[0,null];m.http=m.responseSeen?[3,null]:[0,null];m.first=null;m.wording=b.awaited&2?[4,null]:[0,null];}};
 const metadata=(index:number,owner:object)=>{const b=bodyScopes.get(index);if(!b||b.owner!==owner||b.invalid||b.failed||finished||!b.metadata||b.metadata.invalid)throw Error("foreign Private metadata owner");return b;};
 const label=(p:any,values:string[])=>p[0]!==5?p:values.includes(p[1])?[5,values.indexOf(p[1])+1]:[4,null];
 // V6 reads one own-data field of the already bound ordinary result. These exact
 // E2 source forms mean WORDING MATCH only: an upstream may echo them. They do
 // not authenticate origin, HTTP status or cause. Fixed templates are scoped to
 // this Baseten/openai-completions case; no text is retained in private state.
 const wording=(p:any)=>{if(p[0]!==5)return p;if(typeof p[1]!=="string"||p[1].length>4096)return [4,null];
  const values=[
   "Scoped AI transport hosts require Node.js async context support",
   "Explicit AI transport hosts require Node.js async context support",
   "429 Shared organization token rate limit exceeded the same-model retry wait budget.",
   "Stream ended without finish_reason", "Exceeded post-tool-call delta buffer limit",
   "The embedding host requires a managed provider transport", "Request was aborted",
   "Unknown provider error", "Stream iteration failed", "Stream result failed",
   "No API provider registered for api: openai-completions", "No API key for provider: baseten",
  ];const at=values.indexOf(p[1]);return at<0?[4,null]:[5,at+1];};
 return {failures,mark,flush,
  bindBodyMetadata(index:number,owner:any,proxyCheck:Function){try{const b=bodyScopes.get(index);
   if(index!==0||declarations.get(index)!==0||!b||b.owner!==owner||b.metadata||b.failed||b.invalid||finished||owner.provider!=="baseten"||owner.api!=="stream"||owner.control!=="eof"||typeof proxyCheck!=="function")throw Error("foreign Private metadata case");
   b.metadata={isProxy:proxyCheck,type:[0,null],code:[0,null],http:[0,null],first:null,wording:[0,null],caller:null,model:null,pending:null,responseSeen:false,resultSeen:false,invalid:false};
  }catch(error){invalidateMetadata(index);failures.push(error);}},
  bodyResponseObserver(index:number,owner:object,caller:object,model:object){let b:any;try{b=metadata(index,owner);if(!caller||!model||b.metadata.caller)throw Error("duplicate Private response observer");b.metadata.caller=caller;b.metadata.model=model;
  }catch(error){invalidateMetadata(index);failures.push(error);return undefined;}
   const m=b.metadata;
   const hook=function(this:unknown,response:unknown,actualModel:unknown){try{
    const repeated=m.responseSeen;m.responseSeen=true;
    if(metadata(index,owner)!==b||repeated||arguments.length!==2||actualModel!==m.model||own(m,this,"onResponse")[1]!==hook)throw Error("foreign Private response callback");
    const p=own(m,response,"status");m.http=p[0]===5&&Number.isInteger(p[1])&&p[1]>=100&&p[1]<=599?[1,p[1]]:[2,null];
   }catch(error){invalidateMetadata(index);failures.push(error);}return undefined;};return hook;
  },
  bodyResultPending(index:number,owner:object,caller:object,pending:unknown){try{const m=metadata(index,owner).metadata;
   if(m.caller!==caller||m.pending!==null||!pending)throw Error("foreign Private result promise");m.pending=pending;
  }catch(error){invalidateMetadata(index);failures.push(error);}},
  bodyResult(index:number,owner:object,pending:unknown,value:unknown){let m:any;try{m=metadata(index,owner).metadata;
   if(m.resultSeen||m.pending===null||m.pending!==pending)throw Error("foreign Private result observation");m.resultSeen=true;
   m.type=label(own(m,value,"errorType"),["PostgresQueryCanceledError","SqliteWorkerError"]);
   m.code=label(own(m,value,"errorCode"),["SQLITE_BUSY","SQLITE_LOCKED","SQLITE_READONLY","SQLITE_IOERR","SQLITE_FULL","transcript_writer_fenced","session_actor_reconciliation","57014","storage-worker-memory","unavailable"]);
   m.wording=wording(own(m,value,"errorMessage"));
  }catch(error){invalidateMetadata(index);failures.push(error);}},
  // V7 reuses the first-failure tuple: 4..20 are capture source sites below,
  // state 1 is the original synchronous capture throw, never a fetch rejection.
  bodyCaptureFailure(index:number,owner:object,site:number,reason:unknown,condition:any=null){try{
   const b=bodyScopes.get(index);if(!b?.metadata||b.failed)return;metadata(index,owner);
   if(!Number.isSafeInteger(site)||site<4||site>20)throw Error("foreign Private capture site");
   if(condition!==null&&!(site===11&&Array.isArray(condition)&&[6,7,8,9].includes(condition.length)&&condition[0]===11&&
    Number.isSafeInteger(condition[1])&&condition[1]>=0&&condition[1]<=10&&condition[2]===2**(condition[1]+1)-1&&condition[3]===2**condition[1]-1&&
    typeof condition[4]==="boolean"&&(condition[4]||![0,4].includes(condition[1]))&&condition[5]===(reason!==undefined)&&(condition.length===6||[0,1,3,4,42,50,74,82,106,114,129,131,170,178,202,210,234,242].includes(condition[6])&&(condition[1]<4?condition[6]===0:true))&&(condition.length<8||Number.isSafeInteger(condition[7])&&condition[7]>=0&&condition[7]<=10&&(condition[1]>=4||condition[7]===0))&&(condition.length!==9||condition[8]===null||Number.isSafeInteger(condition[8])&&condition[8]>=0&&condition[8]<13286025&&(condition[1]>=4||condition[8]===null))))throw Error("foreign Private ownership condition");
   // V8 retains its two original integers. The validated original masks above
   // are exact short-circuit prefixes, so their site/flags plus the census index
   // losslessly encode all six observed fields in V9: flags*18+censusIndex.
   // Decoding a validated prefix is not reevaluating an ownership predicate.
   if(b.metadata.first===null){
    if(condition===null)b.metadata.first=[site,1,reason!==undefined];
    else{const m=condition[2]*2048+condition[3],f=condition[1]*4+(condition[4]?2:0)+(condition[5]?1:0);
     const packed=f*18+[0,1,3,4,42,50,74,82,106,114,129,131,170,178,202,210,234,242].indexOf(condition[6]);
     // V10 uses a scalar to retain both witnesses within the original byte cap.
     // 0 unobserved, 1 invalid, 2 host, 3 build entered, 4 build returned, 5 hook entered,
     // 6 host-returned fetch, 7 nullish fallback, 8/9 seam throw undefined/defined,
     // 10 unsupported host descriptor. None exposes the lexical SSRF operand.
     const legacy=packed*11+condition[7];
     // One scalar keeps V8/V9/V10 exact; V11 adds three callback rows and two
     // defining-descriptor custody trits (0 unavailable, 1 intact, 2 displaced).
     b.metadata.first=condition.length===9&&condition[8]!==null?legacy+8712*(condition[8]+1):condition.length>=8?legacy:condition.length===7?[packed]:[m,f];}
   }
  }catch(error){invalidateMetadata(index);failures.push(error);}},
  bodyOperationFailure(index:number,owner:object,operation:Original,reason:unknown){try{const b=bodyScopes.get(index);if(!b?.metadata)return;
   if(b.failed)return;metadata(index,owner);const site=["guard","fetch","read"].indexOf(operation.kind)+1;if(!site)return;
   if(!b.originals.includes(operation)||!["threw","rejected"].includes(operation.state)||!Object.hasOwn(operation,"reason")||!Object.is(operation.reason,reason))throw Error("foreign Private failure observation");
   if(b.metadata.first===null)b.metadata.first=[site,operation.state==="threw"?1:2,reason!==undefined];
  }catch(error){invalidateMetadata(index);failures.push(error);}},
  bindBody(index:number,owner:object,originals:Original[]){try{
   const decl=declarations.get(index);if(lane!=="sdk"||finished||decl===undefined||decl>=24||decl%4!==0||bodyScopes.has(index)||!owner||!Array.isArray(originals))throw Error("foreign Private body owner");
   bodyScopes.set(index,{owner,originals,site:0,state:0,returned:0,awaited:0,stop:null,failed:false,invalid:false});
  }catch(error){const b=bodyScopes.get(index);if(b)b.invalid=true;failures.push(error);}},
  bodySite(index:number,owner:object,site:number,state:number,...operand:unknown[]){const b=bodyScopes.get(index),stop=operand[0];try{
   if(!b||b.owner!==owner||b.failed||b.invalid||finished||!Number.isSafeInteger(site)||site<1||site>22||![1,2,3,4].includes(state)||operand.length>1||(operand.length===1&&!(site===20&&state===1))||
    (state===1||state===3?(site<b.site||site===b.site&&!(site===20&&b.state===1&&operand.length===1)):site!==b.site)||(state===2&&b.state!==1)||(state===3&&![5,18].includes(site))||(state===4&&b.state!==3))throw Error("foreign Private body source span");
   b.site=site;b.state=state;if(state===2)b.returned|=2**(site-1);if(state===4)b.awaited|=site===5?1:2;if(site===20&&state===1&&operand.length===1)b.stop=stop==="stop"?0:stop==="error"?1:stop==="aborted"?2:3;
  }catch(error){if(b)b.invalid=true;failures.push(error);}},
  registration(site:string,state:string,decl:number|null=null){try{
   if(lane!=="sdk"||finished||!["afterAll","describe","suite","it"].includes(site)||!["enter","returned"].includes(state))throw Error("invalid Private registration boundary");
   if(site==="afterAll"||site==="describe")registration[site==="afterAll"?0:1]=state==="enter"?1:2;
   else if(site==="suite")registration[2]=1;
   else {if(decl===null||!Number.isSafeInteger(decl)||decl<0||decl>65)throw Error("foreign Private registration");registration[state==="enter"?3:4]=Number(registration[state==="enter"?3:4])+1;registration[5]=decl;}
   if(site==="describe"&&state==="returned"){const record=progress("describe_return",null);if(emitted<5){emitted++;send(record);}else suppressed++;}
  }catch(error){failures.push(error);}},
  registrationFailure(reason:unknown){if(registrationFailed)return;registrationFailed=true;entry(progress("registration_failure",registration[5]));mark(null,"registration","threw",reason,null,null,registration[5]);},
  execOutcome(record:any){try{validatePrivateCheckpoint(record);if(lane!=="outer"||record.kind!=="exec"||entrySent)throw Error("foreign or repeated Private exec boundary");entry(record);}catch(error){failures.push(error);}},
  bindCase(index:number,decl:number){try{if(!Number.isSafeInteger(index)||index<0||index>=108||!Number.isSafeInteger(decl)||decl<0||decl>65||declarations.has(index)&&declarations.get(index)!==decl)throw Error("foreign Private declaration");
   declarations.set(index,decl);const inherited=scope(null,decl),target=scope(index,decl);target[0]=inherited[0];target[1]=inherited[1];}catch(error){failures.push(error);}},
  joinedOwner(index:number,counts:number[]){try{if(!Array.isArray(counts)||counts.length!==6||counts.some(n=>!Number.isSafeInteger(n)||n<0||n>65535)||scope(index,declarations.get(index)??null)[5]!==2)throw Error("unjoined Private diagnostic owner");owners.set(index,[...counts]);}catch(error){failures.push(error);}},
  receipt(index:number,witness:any,facts:any){try{if(receipt!==null)return;const candidate=[index,witness.first,witness.evaluated,witness.passed,facts?.producer??null,facts?.accounting??null];
   validatePrivateCheckpoint({v:2,pin:"e2a8b8d4ec290cd6c035f3568a14e4d7c6433635",lane,case:index,phase:"assertions",state:"rejected",defined:true,decl:null,stages:Array(7).fill(0),owner:null,receipt:candidate});receipt=candidate;
  }catch(error){failures.push(error);}},
  observe(index:number|null,phase:string,fn:Function,receiver:unknown,args:any[],decl:number|null=null){
   mark(index,phase,"enter",undefined,null,null,decl);let original;
   try{original=Reflect.apply(fn,receiver,args);}catch(reason){mark(index,phase,"threw",reason,null,null,decl);flush(index);throw reason;}
   try{if(original&&typeof original.then==="function"){
    const observed=original.then(()=>mark(index,phase,"fulfilled",undefined,null,null,decl),(reason:unknown)=>{mark(index,phase,"rejected",reason,null,null,decl);flush(index);});
    observers.push(observed.then(()=>{},(error:unknown)=>{failures.push(error);}));
   }else mark(index,phase,"fulfilled",undefined,null,null,decl);}catch(error){failures.push(error);}return original;
  },
  async drain(){let at=0;while(at<observers.length){const batch=observers.slice(at);at=observers.length;for(const result of await Promise.allSettled(batch))if(result.status==="rejected")failures.push(result.reason);}},
  finish(){if(finished){failures.push(Error("duplicate checkpoint final flush"));return;}finished=true;
   primary();
   if(suppressed)send(make(null,"overflow","summary",undefined,null,null,suppressed));send(make(null,"final","summary",undefined,null,null,Math.min(65535,failed)));},
 };
}
// The enclosing case_result observer is joined by afterAll, never by its own case.
export function finishPrivateCheckpointCase(report:any,index:number,failures:unknown[]):void {
 report.mark(index,"assertions",failures.length?"rejected":"fulfilled",failures[0]);
 if(failures.length)report.flush(index);
}
export function privateCheckpointCaseIndex(inventory:any[],id:string):number {
 const matches=inventory.map((r:any,i:number)=>r.id===id?i:-1).filter((i:number)=>i>=0);
 if(matches.length!==1||matches[0]>=108)throw Error("ambiguous diagnostic case");return matches[0];
}
const callbackDeclarations=new WeakMap<Case,number>();
const checkpoints=createPrivateCheckpointReporter("sdk",(record:any)=>process.stdout.write("PRIVATE_CHECKPOINT "+JSON.stringify(record)+"\n"));
checkpoints.mark(null,"module","fulfilled");checkpoints.flush(null);
checkpoints.registration("afterAll","enter");
try{afterAll(async()=>{await checkpoints.drain();checkpoints.finish();throwFailures(checkpoints.failures);});checkpoints.registration("afterAll","returned");}
catch(reason){checkpoints.registrationFailure(reason);throw reason;}
function checkpointCase(row:Case):number {
 return privateCheckpointCaseIndex([...controlRows,...rows],row.id);
}
function throwFailures(failures:unknown[]):void{if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"private client body and original cleanup failed");}
async function command(row:Case,kind:string,value:unknown={}){const r=await nativeFetch(origin+"/private-control/"+kind+"/"+row.id,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});const text=await r.text();expect(r.status).toBe(200);return JSON.parse(text);}

function fixture(row:Case,body:Parameters<typeof fixtureOwned>[1]){
 const index=checkpointCase(row),decl=callbackDeclarations.get(row);if(decl!==undefined)checkpoints.bindCase(index,decl);
 return checkpoints.observe(index,"case_result",fixtureOwned,undefined,[row,body]);
}
async function fixtureOwned(row:Case,body:(f:Awaited<ReturnType<typeof session>>)=>Promise<void>){
 const caseIndex=checkpointCase(row);
 const state=await checkpoints.observe(caseIndex,"setup",createOpenClawTestState,undefined,[{label:"private-catalog-client"}]);
 const w:any={owner:Object.freeze({id:row.id}),identity:nativeIdentity,provider:row.provider,api:row.api,role:row.control,
  originals:[],observers:[],transports:[],acquisitions:[],callers:[],failures:[],observerFailures:[],syncFailures:[],restored:false,sourceExpired:null,sequence:0};
 checkpoints.mark(caseIndex,"owner","fulfilled");
 if(row.control==="eof")checkpoints.bindBody(caseIndex,row,w.originals);
 if(caseIndex===0)checkpoints.bindBodyMetadata(caseIndex,row,isProxy);
 const callbacks=caseIndex===0?createPrivateCallbackWitness(w.owner,isProxy,w.observerFailures):undefined;
 const selection=caseIndex===0?createPrivateSelectionWitness(w.owner,isProxy,w.observerFailures,globalThis):undefined;
 const ownership=createPrivateInvocationOwnership(new AsyncLocalStorage(),caseIndex===0?{ledger:w,owner:w.owner,acquisitions:w.acquisitions,originals:w.originals,guard:originalGuard,isProxy,selection,callbacks}:undefined);
 const failures:unknown[]=w.failures,originals:Original[]=w.originals,transports:Transport[]=w.transports,restores:Array<()=>void>=[];
 const signalHistory=(signal:AbortSignal|undefined)=>{const history={signal,initial:signal?.aborted??null,invoke:++w.sequence,abort:0,reason:undefined as unknown};
  if(signal){const observed=()=>{history.abort=++w.sequence;history.reason=signal.reason;};if(signal.aborted)observed();else{signal.addEventListener("abort",observed,{once:true});restores.push(()=>signal.removeEventListener("abort",observed));}}return history;};
 const observer=(p:Promise<unknown>)=>{w.observers.push(p.then(()=>{},e=>{w.observerFailures.push(e);}));};
 const record=(kind:string,details:any={})=>{const o:Original={owner:w.owner,kind,invoke:++w.sequence,settle:0,returnAt:0,state:"pending",returned:undefined,...details};originals.push(o);return o;};
 const returned=(o:Original,value:any)=>{o.returned=value;o.returnAt=++w.sequence;
  const settle=(state:Original["state"],v:any)=>{o.state=state;o.settle=++w.sequence;if(state==="rejected"){o.reason=v;checkpoints.bodyOperationFailure(caseIndex,row,o,v);}else o.value=v;
   o.callerAbortedAtSettle=o.callerSignal?.aborted??null;o.effectiveAbortedAtSettle=o.effectiveSignal?.aborted??null;
   const phase=["read","closed","cancel"].includes(o.kind)?o.kind:o.kind==="guard_release"?"release":null;
   if(phase)checkpoints.mark(caseIndex,phase,state,v,o.reader?transports.indexOf(o.reader.transport):null,originals.indexOf(o));};
  if(value&&typeof value.then==="function"){o.pending=value;observer(value.then((v:any)=>settle("fulfilled",v),(e:unknown)=>settle("rejected",e)));}else settle("fulfilled",value);return value;};
 const track=<T>(kind:string,pending:Promise<T>):Promise<T>=>returned(record(kind),pending);
 const invoke=(kind:string,fn:()=>any,details:any={})=>{const o=record(kind,details);try{return returned(o,fn());}catch(e){o.state="threw";o.reason=e;o.settle=++w.sequence;checkpoints.bodyOperationFailure(caseIndex,row,o,e);w.syncFailures.push(e);throw e;}};
 const patch=(object:any,name:string,value:any)=>{const before=Object.getOwnPropertyDescriptor(object,name),ours={configurable:true,writable:true,enumerable:before?.enumerable??false,value};Object.defineProperty(object,name,ours);
  restores.push(()=>{if(!samePrivateDescriptor(Object.getOwnPropertyDescriptor(object,name),ours))throw Error("foreign descriptor replacement");if(before)Object.defineProperty(object,name,before);else delete object[name];});return ours;};
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
  // Each site precedes its original expression; a throw reports only that span.
  // No operand is evaluated twice and capture failure cannot be called fetch failure.
  let site=4,condition:any=null;try{
  const [input,init]=args as [RequestInfo|URL,DispatcherAwareRequestInit|undefined];
  site=5;const u=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);
  site=6;expect(u.origin).toBe(origin);site=7;expect(u.search).toBe("");
  site=8;expect([base(row)+"/models",base(row,true)+"/models",base(row)+"/chat/completions",base(row,true)+"/chat/completions"]).toContain(u.href);
  site=9;const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
  site=10;const t:Transport={input,init,path:u.pathname,method:init?.method??(input instanceof Request?input.method:"GET"),credential:headers.get("authorization"),
   signal:init?.signal!==undefined?init.signal??undefined:input instanceof Request?input.signal:undefined,dispatcher:init?.dispatcher,guardObserved:false,releases:0,releaseDone:false,bodies:[],readers:[],closes:[]};
  site=11;ownership.transport(t,(value:any)=>{condition=value;},w.observerFailures);
  site=12;t.signalHistory=signalHistory(t.signal);
  site=13;expect(headers.has("x-api-key")).toBe(false);site=14;expect(headers.has("x-upstream-url")).toBe(false);
  site=15;expect(["inference","discovery","alternate"].flatMap(kind=>["fixture-secret","rotated-secret","invalid-secret"].map(secret=>"Bearer "+key(row,kind,secret)))).toContain(t.credential);
  site=16;expect(t.signal).toBeInstanceOf(AbortSignal);site=17;expect(t.dispatcher).toBeDefined();site=18;transports.push(t);
  site=19;const d=t.dispatcher as {close:Function};if(!observedDispatchers.has(d)){observedDispatchers.add(d);const close=d.close;let depth=0;patch(d,"close",function(this:unknown,...args:unknown[]){const outer=depth++===0;try{return outer?invoke("dispatcher_close",()=>Reflect.apply(close,this,args),{dispatcher:d,receiver:this,args}):Reflect.apply(close,this,args);}finally{depth--;}});}
  site=20;const o=record("fetch",{transport:t,receiver,args,input,init,callerSignal:t.caller?.signal,effectiveSignal:t.signal,callerAbortedAtInvoke:t.caller?.signal?.aborted??null});t.fetch=o;
  return {threw(reason:unknown){o.state="threw";o.reason=reason;o.settle=++w.sequence;checkpoints.bodyOperationFailure(caseIndex,row,o,reason);w.syncFailures.push(reason);},
   returned(pending:Promise<Response>){returned(o,pending);observer(pending.then(response=>{ownership.response(t,response);observeBody(response,t);},()=>{}));}};
  }catch(reason){try{checkpoints.bodyCaptureFailure(caseIndex,row,site,reason,condition);}catch(error){w.observerFailures.push(error);}throw reason;}
 },w.observerFailures);
 const check=async(fn:()=>unknown)=>{try{await fn();}catch(e){failures.push(e);}};
 let bodyEntered=false;
 let spy:ReturnType<typeof vi.spyOn>|undefined,spyDescriptor:PropertyDescriptor|undefined,worker=false;
 try{
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(pin);expect(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()).toBe(pin);
  for(const name of [...Object.values(envNames),"OPENAI_API_KEY","OPENROUTER_API_KEY"])vi.stubEnv(name,"synthetic-poison-unselected");
  const globalFetchDescriptor=patch(globalThis,"fetch",observedFetch(nativeFetch));selection?.globalDescriptor(globalFetchDescriptor);
  patch(globalThis,"__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__",{...undici,fetch:observedFetch(originalUndiciFetch)});
  if(selection){
   for(const [module,name,observe] of [[transportHost,"getAiTransportHost",selection.lookup],[openAITransport,"withOpenAIErrorResponseHook",selection.hook]] as const){
    installPrivateDefiningSpy(module,name,observe,restores,callbacks);
   }
   restores.push(()=>selection.restore());
  }
  spy=vi.spyOn(guard,"fetchWithSsrFGuard").mockImplementation(function(this:unknown,...args:Parameters<typeof originalGuard>){
   const callbackEntry=callbacks?.enter(2);
   try{
   const input=args[0],a:any={guard:originalGuard,input,inputSignal:input.signal??input.init?.signal,invoke:++w.sequence};a.callbackEntry=callbackEntry;a.signalHistory=signalHistory(a.inputSignal);w.acquisitions.push(a);
   const o=record("guard",{acquisition:a,receiver:this,args});a.operation=o;let pending:ReturnType<typeof originalGuard>;
   try{pending=returned(o,ownership.guard(originalGuard,this,args,a));a.pending=pending;}catch(e){o.state="threw";o.reason=e;o.settle=++w.sequence;checkpoints.bodyOperationFailure(caseIndex,row,o,e);w.syncFailures.push(e);throw e;}
   observer(pending.then((result:any)=>{const found=transports.filter(t=>t.response===result.response&&!t.guardObserved);expect(found).toHaveLength(1);const t=found[0];
    expect(new URL(input.url).pathname).toBe(t.path);expect(input.init?.method??"GET").toBe(t.method);expect(new Headers(input.init?.headers).get("authorization")).toBe(t.credential);
    ownership.attach(a,result);
    const release=result.release;patch(result,"release",function(this:unknown,...params:unknown[]){t.releases++;const o=record("guard_release",{acquisition:a,receiver:this,args:params});t.release=o;
     let p;try{p=returned(o,Reflect.apply(release,this,params));}catch(e){o.state="threw";o.reason=e;o.settle=++w.sequence;checkpoints.bodyOperationFailure(caseIndex,row,o,e);w.syncFailures.push(e);throw e;}
     observer(p.then(()=>{t.releaseDone=true;},()=>{}));return p;});
   },()=>{}));callbacks?.returned(callbackEntry);return pending;
   }catch(reason){callbacks?.threw(callbackEntry,reason);throw reason;}
  } as typeof originalGuard);spyDescriptor=Object.getOwnPropertyDescriptor(guard,"fetchWithSsrFGuard");
  const f=await session(row,state,track,transports,{begin,finish,abort,partial,partialNow,caller,invoke:ownership.invoke,preabortProof:(cold:boolean,delta:number)=>{w.coldZeroDispatch=cold;w.preabortPostDelta=delta;}});bodyEntered=true;await checkpoints.observe(caseIndex,"body",body,undefined,[f]);
 }catch(e){if(!bodyEntered)checkpoints.mark(caseIndex,"case_setup","rejected",e);failures.push(e);}
 checkpoints.mark(caseIndex,"original_join","enter");
 // Originals and late observers join before restoration. No outcome is rewritten.
 let at=0,seen=0;
 while(at<originals.length||seen<w.observers.length){const batch=originals.slice(at);at=originals.length;await Promise.allSettled(batch.flatMap(o=>o.pending?[o.pending]:[]));
  const observed=w.observers.slice(seen);seen=w.observers.length;for(const r of await Promise.allSettled(observed))if(r.status==="rejected")w.observerFailures.push(r.reason);}
 checkpoints.mark(caseIndex,"original_join","fulfilled");
 checkpoints.joinedOwner(caseIndex,[originals.length,originals.filter(o=>o.state==="rejected").length,originals.filter(o=>o.state==="pending").length,transports.length,w.acquisitions.length,w.observerFailures.length]);
 checkpoints.mark(caseIndex,"postlude","enter");
 if(w.observerFailures.length)checkpoints.mark(caseIndex,"observer","rejected",w.observerFailures[0]);
 if(!row.workerOnly&&row.scenario!=="cold")await check(()=>expect(transports.some(t=>t.method==="GET")).toBe(true));
 if(["eof","provider_error","environment","rotation","caller_revoke","grant_revoke","unpriced","foreign_inference","stream_abort","simple_abort"].includes(row.scenario))await check(()=>expect(transports.some(t=>t.method==="POST")).toBe(true));
 for(const t of transports){await check(()=>expect(t.guardObserved).toBe(true));await check(()=>expect(t.releases).toBe(1));await check(()=>expect(t.releaseDone).toBe(true));for(const r of t.readers)await check(()=>expect(r.unlocks).toBe(1));for(const b of t.bodies)await check(()=>expect(b.locked).toBe(false));}
 const workerFailures:unknown[]=[];
 checkpoints.mark(caseIndex,"worker_retirement","enter");
 try{const response=await nativeFetch(origin+"/private-control/join/"+row.id,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});const text=await response.text();const proof=JSON.parse(text);w.sourceExpired=proof.source?.expired??null;worker=response.status===200&&proof.retired===true;if(!worker)workerFailures.push(Error("independent Worker retirement failed"));}catch(e){workerFailures.push(e);}
 checkpoints.mark(caseIndex,"worker_retirement",workerFailures.length?"rejected":"fulfilled",workerFailures[0]);
 const beforeRestore=failures.length;
 for(const restore of restores.toReversed())await check(()=>checkpoints.observe(caseIndex,"restoration",restore,undefined,[]));
 if(spy)await check(()=>checkpoints.observe(caseIndex,"restoration",()=>{if(!samePrivateDescriptor(Object.getOwnPropertyDescriptor(guard,"fetchWithSsrFGuard"),spyDescriptor))throw Error("foreign guard descriptor");spy!.mockRestore();},undefined,[]));
 for(const cleanup of [()=>ownership.restore(),()=>vi.unstubAllEnvs(),()=>state.cleanup(),()=>state.restoreEnv()])await check(()=>checkpoints.observe(caseIndex,"cleanup",cleanup,undefined,[]));
 w.restored=failures.length===beforeRestore;
 let allowed:Original[]=[];
 if(row.control){checkpoints.mark(caseIndex,"control","enter");const evaluated=evaluatePrivateNativeControl(w);checkpoints.mark(caseIndex,"control","fulfilled");if(evaluated.qualified&&row.control==="partial")allowed=privateStoredErrorVector(w)??[];
  const k=row.provider+":"+row.api,reports=controlReports.get(k)??new Map();
  try{emitNativeControl(row,w,evaluated,worker);}catch(e){failures.push(e);evaluated.qualified=false;}
  reports.set(row.control,evaluated);controlReports.set(k,reports);
  const qualified=privateQualification([...reports.values()],nativeIdentity,row.provider,row.api);if(qualified)qualifications.set(k,qualified);
  if(!evaluated.qualified)failures.push(Error("native control qualification incomplete"));
 }else if(row.scenario==="stream_abort"||row.scenario==="simple_abort")allowed=privateProductExpected(w,qualifications.get(row.provider+":"+row.api));
 for(const o of originals)if(o.state==="rejected"&&!allowed.includes(o))failures.push(o.reason);else if(o.state==="pending")failures.push(Error("original operation pending"));
 failures.push(...w.syncFailures,...w.observerFailures,...workerFailures);
 checkpoints.mark(caseIndex,"postlude",failures.length?"rejected":"fulfilled",failures[0]);
 finishPrivateCheckpointCase(checkpoints,caseIndex,failures);throwFailures(failures);
}

async function session(row:Case,state:Awaited<ReturnType<typeof createOpenClawTestState>>,track:<T>(kind:string,p:Promise<T>)=>Promise<T>,transports:Transport[],witness:any){
 // The row reference is the private context key; other scenarios are unchanged.
 const metadataCase=checkpointCase(row)===0;
 const bodyResult=(pending:unknown,value:unknown)=>{if(metadataCase)checkpoints.bodyResult(0,row,pending,value);};
 const bodySite=(id:number,state:number,...operand:unknown[])=>{if(row.control==="eof")checkpoints.bodySite(checkpointCase(row),row,id,state,...operand);};
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
  bodySite(3,1);expect(selected.discoveryApiKey).toBe(options.profile?key(row,"discovery"):options.credential??key(row,"discovery",options.secret));bodySite(3,2);
  bodySite(4,1);const original=track("catalog_result",witness.invoke(witness.caller(options.signal,"discovery"),"discovery",plugin.catalog!.run,plugin.catalog,[{config,env,agentDir:state.agentDir(),workspaceDir:state.workspaceDir,signal:options.signal,resolveProviderApiKey,resolveProviderAuth}]));bodySite(4,2);return original;
 };
 const infer=(provider:any,options:{signal?:AbortSignal;credential?:string;api?:"stream"|"simple"}={})=>{
  bodySite(8,1);expect([base(row),base(row,true)]).toContain(provider.baseUrl);bodySite(8,2);bodySite(9,1);expect(provider.api).toBe("openai-completions");bodySite(9,2);
  bodySite(10,1);const actual=provider.models.find((m:{id:string})=>m.id==="tenant/opaque-a");expect(actual).toBeDefined();bodySite(10,2);
  bodySite(11,1);const model={...actual,provider:row.provider,api:provider.api,baseUrl:provider.baseUrl} as Model<"openai-completions">;
  const context:Context={messages:[{role:"user",content:"synthetic private catalog request",timestamp:1}]};
  const which=options.api??row.api,plain=which==="stream"?stream:streamSimple;
  const hook=which==="stream"?plugin.wrapStreamFn:plugin.wrapSimpleCompletionStreamFn;
  bodySite(11,2);bodySite(12,1);const fn=row.provider==="baseten"?(expect(hook).toBeTypeOf("function"),hook!({streamFn:plain,sourceApi:model.api,modelId:model.id,config:{},providerId:row.provider} as Parameters<NonNullable<typeof hook>>[0])):plain;
  if(row.provider!=="baseten")expect(hook).toBeUndefined();
  bodySite(12,2);bodySite(13,1);const caller=witness.begin(options.signal);bodySite(13,2);
  const responseObserver=metadataCase?checkpoints.bodyResponseObserver(0,row,caller,model):undefined;
  bodySite(14,1);const result=witness.invoke(caller,"inference",fn!,undefined,[model,context,{apiKey:options.credential??key(row),signal:options.signal,maxTokens:16,...(responseObserver?{onResponse:responseObserver}:{})}]);bodySite(14,2);
  bodySite(15,1);const originalResult=result.result();bodySite(15,2);
  if(metadataCase)checkpoints.bodyResultPending(0,row,caller,originalResult);
  bodySite(16,1);const pending=track("inference_result",originalResult);witness.finish(caller,pending);bodySite(16,2);return {stream:result,result:pending};
 };
 return {discover,infer,transports,...witness,bodySite,bodyResult};
}
function ready(result:any,site:(id:number,state:number)=>void=()=>{}){site(6,1);expect(result.provider).toBeDefined();site(6,2);site(7,1);expect(result.provider.models.map((m:{id:string})=>m.id)).toContain("tenant/opaque-a");site(7,2);return result.provider;}
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
 const site=f.bodySite;site(1,1);const controller=new AbortController();site(1,2);
 if(row.control==="preabort"){
  const cold=new AbortController();f.abort(cold,new Error("synthetic cold preabort"));
  failedCatalog(await f.discover({signal:cold.signal}),"unavailable");expect(f.transports).toHaveLength(0);
  const coldZero=(await command(row,"state")).calls===0;expect(coldZero).toBe(true);
  const provider=ready(await f.discover()),before=f.transports.filter((t:Transport)=>t.method==="POST").length;
  f.abort(controller,new Error("synthetic inference preabort"));
  const result=await f.infer(provider,{signal:controller.signal}).result;expect(result.stopReason).toBe("error");expect(result.content).toEqual([]);
  const delta=f.transports.filter((t:Transport)=>t.method==="POST").length-before;expect(delta).toBe(0);f.preabortProof(coldZero,delta);return;
 }
 if(row.control==="eof"){
  site(2,1);const discovery=f.discover();site(5,3);const catalog=await discovery;site(5,4);
  const provider=ready(catalog,site),pending=f.infer(provider,{signal:controller.signal});
  site(17,1);const originalResult=pending.result;site(17,2);site(18,3);const result=await originalResult;site(18,4);f.bodyResult(originalResult,result);
  site(19,1);expect(controller.signal.aborted).toBe(false);site(19,2);
  site(20,1);const stopReason=result.stopReason;site(20,1,stopReason);expect(stopReason).toBe("stop");site(20,2);
  site(21,1);expect(result.content).toContainEqual({type:"text",text:"private-prefix"});site(21,2);
  site(22,1);expect(result.usage).toMatchObject({input:4,output:3,totalTokens:7});site(22,2);return;
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

checkpoints.registration("describe","enter");
try{describe("registered private catalogs with native Worker and SQLite",{concurrent:false},()=>{
 checkpoints.registration("suite","enter");
 try{
 // These are diagnostic tests, not replacements for the 42 product groups.
 // The registry cannot qualify an API until all four fresh controls restore.
 for(const provider of providers)for(const api of ["stream","simple"] as const)for(const role of ["eof","preabort","partial","provider_error"] as const){
  const ordinal=providers.indexOf(provider)*8+["stream","simple"].indexOf(api)*4+["eof","preabort","partial","provider_error"].indexOf(role);
  checkpoints.registration("it","enter",ordinal);
  it("native diagnostic "+provider+" "+api+" "+role,async()=>{
   const decl=providers.indexOf(provider)*8+["stream","simple"].indexOf(api)*4+["eof","preabort","partial","provider_error"].indexOf(role);
   checkpoints.mark(null,"callback","enter",undefined,null,null,decl);
   const selected=checkpoints.observe(null,"selection",()=>{const selected=controlRows.filter(r=>r.provider===provider&&r.api===api&&r.control===role);expect(selected).toHaveLength(1);return selected;},undefined,[],decl);
   callbackDeclarations.set(selected[0],decl);await diagnosticControl(selected[0]);
  });checkpoints.registration("it","returned",ordinal);
 }
 for(const provider of providers)for(const group of groups){
  const ordinal=24+providers.indexOf(provider)*groups.length+groups.indexOf(group);checkpoints.registration("it","enter",ordinal);
  it(provider+" "+group,async()=>{
  const decl=24+providers.indexOf(provider)*groups.length+groups.indexOf(group);checkpoints.mark(null,"callback","enter",undefined,null,null,decl);
  const selected=checkpoints.observe(null,"selection",()=>{const selected=rows.filter(r=>r.provider===provider&&r.group===group);expect(selected.length).toBeGreaterThan(0);return selected;},undefined,[],decl);
  // Forty-two registrations retain every expanded scenario. They do not replace
  // individual request assertions or enlarge native runner/child time limits.
  for(const row of selected){callbackDeclarations.set(row,decl);await exercise(row);}
 });checkpoints.registration("it","returned",ordinal);
 }
}catch(reason){checkpoints.registrationFailure(reason);throw reason;}
});checkpoints.registration("describe","returned");}
catch(reason){checkpoints.registrationFailure(reason);throw reason;}
