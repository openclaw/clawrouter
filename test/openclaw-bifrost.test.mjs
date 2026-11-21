import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { promisify, types } from "node:util";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/provider-compiler.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { startWorkerdFixture } from "./helpers/workerd.mjs";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

export const bifrostPin = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
export const bifrostModels = ["tenant/opaque-a", "tenant/opaque-b"];
export const bifrostKey = id => `clawrouter-live-${id}-fixture-secret`;
export const bifrostDiscoveryKey = id => bifrostKey(id+"_discovery");
export const bifrostCases = ["eof", "preabort", "partial", "provider_error"].flatMap(mode => ["stream", "simple"].map(api => ({ id: `bifrost_${api}_${mode}`, mode, api })))
  .concat(["account_a", "account_b", "profile", "empty", "malformed", "loose", "error401", "error403", "redirect", "rotation", "revoked", "missing_owner", "invalid_owner", "unpriced"].map(mode => ({id:`bifrost_${mode}`,mode,api:"simple"})));

export const bifrostControls=["stream","simple"].flatMap(api=>["eof","preabort","partial","provider_error"].map(control=>({id:`bifrost_control_${api}_${control}`,mode:control,api,control})));
export const bifrostProgressCases=["stream","simple"].map(api=>({id:`bifrost_${api}_progress`,mode:"progress",api}));
// A discovery receipt cannot stand in for a dispatched chat receipt. Both
// failure fixtures send output before termination, so the fixed charge survives.
export function assertBifrostFailedChatAccounting(row, proof) {
  if (!["partial", "provider_error"].includes(row.mode)) return;
  const events = proof.events.filter(event => event.capability === "llm.chat");
  assert.equal(events.length, 1, "one accounting receipt for the dispatched chat");
  const event = events[0];
  assert.equal(event.provider, "bifrost");
  assert.equal(event.policy_id, row.id);
  assert.equal(event.credential_id, row.id);
  assert.equal(event.model, "tenant/opaque-a");
  assert.equal(event.status, row.mode === "partial" ? "client_error" : "provider_error");
  assert.equal(event.status_code, 200, "retain the original successful SSE HTTP status");
  assert.equal(event.reserved_cost_micros, 7);
  assert.equal(event.actual_cost_micros, 7);
  assert.equal(event.cost_basis, "policy_fixed");
  for (const field of ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens"])
    assert.equal(event[field], null, "no terminal usage was received: " + field);
  assert.equal(proof.charged, 0, "retirement releases the body capacity reservation");
}
export function bifrostNativeEvaluator(){
 const source=readFileSync(new URL("./fixtures/openclaw-bifrost-contract.test.ts",import.meta.url),"utf8");
 const names=["createBifrostFetchObserver","createBifrostProviderErrorOrigin","createBifrostTransportWitness","createBifrostInvocationOwnership","bifrostInvocationBound","sameBifrostDescriptor","bifrostNativeContract","bifrostCancelOperand","bifrostStoredErrorVector","bifrostProviderErrorVector","evaluateBifrostNativeControl","bifrostQualification","bifrostProductExpected","bifrostProgressQualified","bifrostProgressWitness"];
 const start="export function createBifrostFetchObserver(",end="function emitControl(";
 assert.equal(source.split(start).length,2);assert.equal(source.split(end).length,2);
 const declarations=source.slice(source.indexOf(start),source.indexOf(end));
 assert.deepEqual([...declarations.matchAll(/^export function (\w+)\(/gm)].map(m=>m[1]),names);
 assert.doesNotMatch(declarations,/\bimport\b|\brequire\s*\(/);
 const signals=source.slice(source.indexOf("export function bifrostSignalEvidence("),source.indexOf("export function bifrostOperationEvidence("));
 return runInNewContext('"use strict";\n'+stripTypeScriptTypes((signals+declarations).replace(/^export /gm,""),{mode:"strip"})+"\n({"+names.join(",")+"})",{AbortSignal}, {timeout:1000});
}
// Fake public objects and already-returned bytes. No SDK, stream or native I/O.
export function bifrostProviderOriginInertHarness(f, options={}) {
 const owner={id:"owned-negative"},E={},headers={get(){return null;}},body={locked:false},response={headers},caller={owner,signal:{aborted:false},abortCalled:false,result:"error"};
 const w={owner,identity:Object.freeze({pin:bifrostPin,node:"inert",platform:"inert",arch:"inert",undici:"inert",guard(){},fetch(){}}),provider:"bifrost",api:"stream",mode:"provider_error",role:"provider_error",caller,
  originals:[],observers:[],transports:[],acquisitions:[],failures:[],observerFailures:[],syncFailures:[],reportingFailures:[],sequence:0,evidenceJoined:true,workerRetired:true,restored:false,sourceExpired:0};
 w.retirementProof={owner:owner.id,retired:true,disposition:"strict",source:{owner:owner.id,held:0,expired:0,producer:{joined:true,faults:0,failures:0,roles:[]}},observation:{owner:owner.id,usageObserved:true,phases:Array.from({length:4},()=>[2,null])},events:[]};
 const next=()=>++w.sequence,counts={request:0,response:0,factory:0,iterate:0,next:0,abort:0,parse:0},calls=[];
 const original=(kind,extra={})=>{const p=Promise.resolve();const o={owner,kind,state:"fulfilled",pending:p,returned:p,args:[],invoke:next(),returnAt:next(),settle:next(),...extra};w.originals.push(o);return o;};
 const controller={signal:{aborted:false},abort(...args){counts.abort++;calls.push(["abort",this,args]);if(!this.signal.aborted){this.signal.aborted=true;this.signal.reason=E;}}};
 const invocation=Object.freeze({owner,caller,signal:caller.signal,kind:"inference",args:Object.freeze([{}, {},{signal:caller.signal}])});
 const a={owner,guard:w.identity.guard,input:{signal:controller.signal},inputSignal:controller.signal,invocation,operation:original("guard")};a.pending=a.operation.pending;
 const rawResponse={body},t={owner,method:"POST",caller,signal:controller.signal,acquisition:a,invocation,response:rawResponse,bodies:[body],readers:[],fetch:original("fetch"),guardObserved:true,releases:1,releaseDone:true};
 a.context=Object.freeze({invocation,acquisition:a});t.context=a.context;a.transport=t;a.response=rawResponse;a.result={response:rawResponse};w.acquisitions.push(a);w.transports.push(t);
 const r={owner,original:{},body,transport:t,acquired:next(),unlocks:1,unlockFailed:false,unlockReceiver:undefined};r.unlockReceiver=r.original;t.readers.push(r);
 const closed=original("closed",{reader:r,receiver:r.original,callerSignal:caller.signal,effectiveSignal:t.signal});r.closed=closed.pending;
 const frame=v=>"data: "+JSON.stringify(v)+"\n\n",wire=frame({id:"chat_fixture",object:"chat.completion.chunk",created:1,model:"tenant/opaque-a",choices:[{index:0,delta:{role:"assistant",content:"synthetic-prefix"},finish_reason:null}]})+frame({error:{message:"synthetic-provider-error",type:"server_error"}});
 const prefix=original("read",{reader:r,receiver:r.original,value:{done:false,value:Buffer.from(wire)}});
 const read=original("read",{reader:r,receiver:r.original,state:"pending",callerSignal:caller.signal,effectiveSignal:t.signal});
 read.evidenceInvoke=Object.fromEntries(["caller","input","effective"].map(k=>[k,{observed:true,aborted:false}]));
 const release=original("guard_release",{acquisition:a,receiver:undefined});t.release=release;
 const gBody={locked:false},gResponse={body:gBody},gi=Object.freeze({owner,caller,signal:caller.signal,kind:"discovery",args:Object.freeze([{signal:caller.signal}])});
 const ga={owner,guard:w.identity.guard,input:{signal:caller.signal},inputSignal:caller.signal,invocation:gi,operation:original("guard")};ga.pending=ga.operation.pending;
 const gt={owner,method:"GET",caller,signal:caller.signal,invocation:gi,acquisition:ga,response:gResponse,bodies:[gBody],readers:[],fetch:original("fetch"),guardObserved:true,releases:1,releaseDone:true,release:original("guard_release")};
 ga.context=Object.freeze({invocation:gi,acquisition:ga});gt.context=ga.context;ga.transport=gt;ga.response=gResponse;ga.result={response:gResponse};w.acquisitions.push(ga);w.transports.push(gt);
 const gr={owner,original:{},body:gBody,transport:gt,unlocks:1,unlockFailed:false};gr.unlockReceiver=gr.original;gt.readers.push(gr);
 const gc=original("closed",{reader:gr,receiver:gr.original});gr.closed=gc.pending;gr.unlockAt=next();
 let store,origin,api,iterator,stream,A,current=invocation,lastNext,lastResponse,parseResponse;
 class APIError extends Error {constructor(data,h){super("inert");if(arguments.length===4){data=arguments[1];h=arguments[3];}Object.assign(this,{error:data,headers:h,status:undefined,code:undefined,param:undefined,type:data.type});A=this;}}
 class APIPromise {
  constructor(client,p,parseResponse){this.client=client;this.responsePromise=p??Promise.resolve({response});this.parseResponse=parseResponse;}
  _thenUnwrap(transform){return new APIPromise(this.client,this.responsePromise,async(client,props)=>transform(await this.parseResponse(client,props),props));}
  asResponse(...args){counts.response++;calls.push(["response",this,args]);return lastResponse=Promise.resolve(response);}
  then(){counts.parse++;throw Error("eager APIPromise parse");}
 }
 class OpenAI {
  request(...args){return this.responsePromise(this.makeRequest(...args));}
  makeRequest(...args){counts.request++;calls.push(["request",this,args]);origin.guard(a);return Promise.resolve({response,controller,options:{stream:true}});}
  responsePromise(p){return api=new APIPromise(this,p,parseResponse??((_client,props)=>Stream.fromSSEResponse(props.response,controller,this)));}
 }
 class Completions {constructor(client){this._client=client;}create(...args){return this._client.request(...args)._thenUnwrap(value=>value);}}
 options.sourcePublic?.({OpenAI,APIPromise});if(options.sourceError)APIError=options.sourceError();
 class Stream {
  constructor(c,controller){if(controller){this.iterator=c;this.controller=controller;}else this.controller=c;}
  static fromSSEResponse(res,c,client,...rest){counts.factory++;calls.push(["factory",this,[res,c,client,...rest]]);return stream=new Stream(c);}
  [Symbol.asyncIterator](...args){counts.iterate++;calls.push(["iterate",this,args]);if(this.iterator)return iterator=this.iterator();let at=0;
   return iterator={next(...operands){counts.next++;calls.push(["next",this,operands]);
    if(at++===0){origin.read(prefix);return lastNext=Promise.resolve({done:false,value:{choices:[]}});}
    A=new APIError({message:"synthetic-provider-error",type:"server_error"},headers);options.beforeAbort?.({w,a,t,r,controller,APIError,A,origin});
    cAbort();cAbort();settleNative();
    return lastNext=Promise.reject(options.reason?options.reason(A,E):A);
   },return(...operands){calls.push(["return",this,operands]);return Promise.resolve({done:true});},throw(...operands){calls.push(["throw",this,operands]);return Promise.reject(operands[0]);}};
  }
 }
 function cAbort(){Reflect.apply(controller.abort,controller,[]);}
 function settleNative(){read.state=closed.state="rejected";read.reason=closed.reason=E;closed.settle=next();read.settle=next();
  const cancel=original("cancel",{reader:r,receiver:r.original,args:[undefined],state:"rejected",reason:E,callerSignal:caller.signal,effectiveSignal:t.signal});
  const unlock=original("unlock",{reader:r,receiver:r.original,pending:undefined,returned:undefined});r.unlockAt=next();
  for(const o of [read,closed,cancel])o.evidenceSettle={caller:{observed:true,aborted:false},input:{observed:true,aborted:true,reason:E},effective:{observed:true,aborted:true,reason:E}};
  options.afterAbort?.({w,a,t,r,controller,APIError,A,origin,read,closed,cancel,unlock});
 }
 if(options.sourceFactory){const factory=options.sourceFactory({Stream,APIError,source(){let at=0;return {async next(){if(at++===0){origin.read(prefix);return {done:false,value:{event:null,data:'{"choices":[]}'}};}return {done:false,value:{event:null,data:options.sseData??'{"error":{"message":"synthetic-provider-error","type":"server_error"}}'}};},async return(){settleNative();return {done:true};},[Symbol.asyncIterator](){return this;}};}});
  Stream.fromSSEResponse=function(...args){counts.factory++;calls.push(["factory",this,args]);return stream=Reflect.apply(factory,this,args);};
 }
 parseResponse=options.sourceChain?.({OpenAI,APIPromise,Completions,Stream,counts});
 const d={OpenAI,APIPromise,APIError,Stream,Completions,version:"7.43.0",owner,caller:()=>caller,invocation:()=>current,
  storage:{run(value,fn){store=value;return fn();},getStore:()=>store},isProxy:types.isProxy,objectPrototype:Object.prototype,next,fault:e=>w.observerFailures.push(e),observer:p=>w.observers.push(p),
  signal:s=>({observed:true,aborted:s.aborted,reason:s.reason}),pendingRead:()=>read.state==="pending"?read:undefined,
  uint8:types.isUint8Array,length:v=>v.byteLength,copy:v=>Buffer.from(v),wire:chunks=>Buffer.concat(chunks).toString("utf8"),expectedWire:wire};
 options.dependencies?.(d);origin=f.createBifrostProviderErrorOrigin(d);w.origin=origin;
 const finish=async()=>{await Promise.allSettled(origin.records.flatMap(o=>o.pending?[o.pending]:[]));await Promise.allSettled(w.observers);origin.finish();w.restored=true;};
 const create=(...args)=>new Completions(new OpenAI()).create(...args);
 return {w,E,headers,response,a,t,r,read,closed,controller,counts,calls,d,origin,APIError,OpenAI,APIPromise,Stream,Completions,create,
  get A(){return A;},setCurrent:v=>{current=v;},get invocation(){return invocation;},
  async drive(){origin.install();const client=new OpenAI(),arg={owned:true,stream:true},p=new Completions(client).create(arg);assert.notEqual(p,api);assert.equal(p.responsePromise,api.responsePromise);assert.equal(counts.parse,0);
   const responseP=p.asResponse();assert.equal(responseP,options.sourcePublic?origin.records.at(-1).pending:lastResponse);const res=await responseP;assert.equal(res,response);
   const result=options.sourceChain?await p:Stream.fromSSEResponse(res,controller,client);assert.equal(result,stream);const iter=result[Symbol.asyncIterator]();if(!options.sourceChain)assert.equal(iter,iterator);
   const first=iter.next();if(!options.sourceChain)assert.equal(first,options.sourceFactory?origin.records.at(-1).pending:lastNext);await first;const second=iter.next();if(!options.sourceChain)assert.equal(second,options.sourceFactory?origin.records.at(-1).pending:lastNext);await assert.rejects(second,e=>{A=e;return true;});
   await finish();assert.equal(counts.parse,options.sourceChain?1:0);return this;},finish,
 };
}
export async function bifrostProviderOriginInertCases(assert) {
 const f=bifrostNativeEvaluator(),passed=[],run=async(name,fn)=>{await fn();passed.push(name);};
 await run("owned public origin admits only its raw negative vector",async()=>{const h=await bifrostProviderOriginInertHarness(f).drive();
  assert.equal(f.bifrostStoredErrorVector(h.w),undefined);const old={...h.w,origin:undefined};assert.equal(f.evaluateBifrostNativeControl(old).qualified,false);
  const value=f.evaluateBifrostNativeControl(h.w);assert.equal(value.qualified,true);assert.equal(value.negative,f.bifrostProviderErrorVector(h.w));
  assert.equal(value.negative.length,3);assert.ok(value.negative.every(o=>o.state==="rejected"&&o.reason===h.E));assert.notEqual(h.A,h.E);
  assert.equal(h.counts.abort,2);assert.equal(h.counts.request,1);assert.equal(h.counts.response,1);assert.equal(h.counts.factory,1);assert.equal(h.counts.next,2);assert.equal(h.counts.parse,0);
  assert.ok(h.calls.filter(c=>c[0]==="abort").every(c=>c[1]===h.controller&&c[2].length===0));});
 for(const [name,change] of Object.entries({
  caller_abort:h=>{h.w.caller.signal.aborted=true;},foreign_owner:h=>{h.a.owner={};},foreign_invocation:h=>{h.t.invocation={...h.t.invocation};},
  foreign_response:h=>{h.a.response={};},swapped_reader:h=>{h.t.readers[0]={...h.r};},swapped_C0:h=>{h.r.closed=Promise.resolve();},
  different_E:h=>{h.read.reason={};},undefined_E:h=>{h.read.reason=undefined;},pending:h=>{h.read.state="pending";},
  extra_error:h=>{h.w.originals[0].state="rejected";h.w.originals[0].reason=undefined;},cancel_argument:h=>{h.w.originals.find(o=>o.kind==="cancel").args=[h.E];},
  missing_hook:h=>{h.w.origin=undefined;},worker_failure:h=>{h.w.workerRetired=false;},expiry:h=>{h.w.sourceExpired=1;},
  financial_failure:h=>{h.w.failures.push(undefined);},observer_failure:h=>{h.w.observerFailures.push(undefined);},restoration_failure:h=>{h.w.restored=false;},
  role_transfer:h=>{h.w.mode="partial";},headers_replaced:h=>{h.A.headers={};},payload_changed:h=>{h.A.error.type="foreign";},
  missing_retirement:h=>{h.w.retirementProof=undefined;},foreign_retirement:h=>{h.w.retirementProof.owner="foreign";},producer_failure:h=>{h.w.retirementProof.source.producer.failures=1;},
  held_producer:h=>{h.w.retirementProof.source.held=1;},usage_missing:h=>{h.w.retirementProof.observation.usageObserved=false;},postlude_failure:h=>{h.w.retirementProof.observation.phases[3]=[3,false];},
 }))await run(name,async()=>{const h=await bifrostProviderOriginInertHarness(f).drive();change(h);assert.equal(f.bifrostProviderErrorVector(h.w),undefined);});
 for(const [name,reason] of Object.entries({syntax:()=>new SyntaxError("inert"),native:(_a,e)=>e,undefined:()=>undefined,foreign_prototype:a=>Object.assign(new Error("inert"),a)}))
  await run(name,async()=>{const h=await bifrostProviderOriginInertHarness(f,{reason}).drive();assert.equal(f.bifrostProviderErrorVector(h.w),undefined);});
 await run("late mutation permanently invalidates the seal",async()=>{const h=await bifrostProviderOriginInertHarness(f).drive();assert.ok(f.bifrostProviderErrorVector(h.w));
  const value=h.r.closed;h.r.closed=Promise.resolve();assert.equal(f.bifrostProviderErrorVector(h.w),undefined);h.r.closed=value;assert.equal(f.bifrostProviderErrorVector(h.w),undefined);});
 await run("descriptor replacement is retained as restoration failure",async()=>{const h=bifrostProviderOriginInertHarness(f,{afterAbort:({origin})=>{void origin;}});
  const original=h.origin.finish;h.origin.finish=()=>{Object.defineProperty(h.Stream,"fromSSEResponse",{value:()=>{},writable:true,configurable:true});return original();};
  await h.drive();assert.equal(f.bifrostProviderErrorVector(h.w),undefined);assert.ok(h.w.observerFailures.length);});
 await run("malformed already-returned wire cannot qualify",async()=>{const h=await bifrostProviderOriginInertHarness(f,{dependencies:d=>{d.expectedWire+="foreign";}}).drive();assert.equal(f.bifrostProviderErrorVector(h.w),undefined);});
 await run("foreign module instance never creates an owned request",async()=>{const h=await bifrostProviderOriginInertHarness(f,{dependencies:d=>{d.version="foreign";}}).drive().catch(e=>e);assert.ok(types.isNativeError(h));});
 await run("second module hooks do not qualify the actual calls",async()=>{const h=await bifrostProviderOriginInertHarness(f,{dependencies:d=>{d.OpenAI=class {request(){}};}}).drive();assert.equal(f.bifrostProviderErrorVector(h.w),undefined);});
 await run("missing invocation context remains unqualified",async()=>{const h=await bifrostProviderOriginInertHarness(f,{dependencies:d=>{d.invocation=()=>undefined;}}).drive();assert.equal(f.bifrostProviderErrorVector(h.w),undefined);});
 await run("throwing context recorder forwards the original request once",async()=>{const h=await bifrostProviderOriginInertHarness(f,{dependencies:d=>{d.invocation=()=>{throw undefined;};}}).drive();assert.equal(h.counts.request,1);assert.ok(h.w.observerFailures.includes(undefined));assert.equal(f.bifrostProviderErrorVector(h.w),undefined);});
 await run("origin accessors and proxies are never invoked",async()=>{for(const exotic of [false,true]){let touched=0;const h=await bifrostProviderOriginInertHarness(f).drive();
  if(exotic)h.A.error=new Proxy({}, {get(){touched++;throw undefined;},ownKeys(){touched++;throw undefined;}});
  else Object.defineProperty(h.A,"headers",{get(){touched++;throw undefined;},configurable:true});
  assert.equal(f.bifrostProviderErrorVector(h.w),undefined);assert.equal(touched,0);}});
 await run("restored method replacement before seal is fatal",async()=>{const h=await bifrostProviderOriginInertHarness(f).drive();h.APIPromise.prototype.asResponse=()=>{};assert.equal(f.bifrostProviderErrorVector(h.w),undefined);});
 await run("late observer does not revive a previous seal",async()=>{const h=await bifrostProviderOriginInertHarness(f).drive();assert.ok(f.bifrostProviderErrorVector(h.w));
  h.origin.read(h.w.originals.find(o=>o.kind==="read"&&o.state==="fulfilled"));assert.equal(f.bifrostProviderErrorVector(h.w),undefined);assert.ok(h.w.observerFailures.length);});
 await run("products require their own origin and matching controls",async()=>{const h=await bifrostProviderOriginInertHarness(f).drive();h.w.role=undefined;
  const q={contract:f.bifrostNativeContract(h.w.identity,"bifrost","stream"),identity:h.w.identity,provider:"bifrost",api:"stream",vector:"stored_error",roles:["eof","preabort","partial","provider_error"]};
  assert.equal(f.bifrostProductExpected(h.w,undefined).length,0);const vector=f.bifrostProductExpected(h.w,q);assert.equal(vector.length,3);assert.equal(vector,f.bifrostProviderErrorVector(h.w));
  h.w.origin=undefined;assert.equal(f.bifrostProductExpected(h.w,q).length,0);});
 await run("an unrelated invocation retains original public returns",async()=>{const h=bifrostProviderOriginInertHarness(f);h.origin.install();h.setCurrent(undefined);const client=new h.OpenAI(),p=client.request({foreign:true});
  assert.equal(Object.getPrototypeOf(p),h.APIPromise.prototype);assert.equal(h.counts.parse,0);const response=await p.asResponse();assert.equal(response,h.response);h.origin.finish();assert.equal(h.origin.records.length,0);});
 await run("original synchronous undefined response failure is unchanged",async()=>{let calls=0;const h=bifrostProviderOriginInertHarness(f,{sourcePublic:({APIPromise})=>{APIPromise.prototype.asResponse=function(){calls++;throw undefined;};}});
  h.origin.install();const p=h.create({});let caught=false;try{p.asResponse();}catch(e){caught=true;assert.equal(e,undefined);}h.origin.finish();assert.equal(caught,true);assert.equal(calls,1);assert.equal(h.origin.records[0].state,"threw");assert.equal(h.origin.records[0].reason,undefined);});
 await run("observer delivery failure cannot replace the original return",async()=>{let result;const h=bifrostProviderOriginInertHarness(f,{dependencies:d=>{d.observer=()=>{throw undefined;};d.fault=()=>{throw "inert reporter";};}});
  h.origin.install();const p=h.create({});result=p.asResponse();assert.equal(result,h.origin.records[0].pending);await result;
  let caught;try{h.origin.finish();}catch(e){caught=e;}assert.ok(types.isNativeError(caught));assert.deepEqual(Array.from(caught.errors),[undefined,"inert reporter"]);});
 return passed;
}
test("Bifrost provider-error origin and exact negative vector (inert)",async()=>{assert.equal((await bifrostProviderOriginInertCases(assert)).length,45);});
export function bifrostInertPublicCreateChain({APIPromise,Completions,Stream,counts}) {
 APIPromise.prototype.parse=function(){if(!this.parsedPromise){counts.parse++;this.parsedPromise=this.responsePromise.then(props=>this.parseResponse(this.client,props));}return this.parsedPromise;};
 APIPromise.prototype.then=function(...args){return Reflect.apply(Promise.prototype.then,this.parse(),args);};
 Completions.prototype.create=function(...args){return this._client.request(...args)._thenUnwrap(stream=>{
  // Same authored capture/assignment shape as OpenAI 7.43's normalizer.
  const iterator=stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator]=async function*(){for await(const chunk of {[Symbol.asyncIterator]:iterator})yield chunk;};return stream;
 });};
 return (client,props)=>Stream.fromSSEResponse(props.response,props.controller,client);
}
export async function bifrostPublicCreateInertCases(assert) {
 const f=bifrostNativeEvaluator(),passed=[],run=async(name,fn)=>{await fn();passed.push(name);};
 await run("public derived promise and authored normalizer retain the origin",async()=>{
  const h=await bifrostProviderOriginInertHarness(f,{sourceChain:bifrostInertPublicCreateChain}).drive();
  assert.ok(f.bifrostProviderErrorVector(h.w));assert.equal(h.counts.request,1);assert.equal(h.counts.parse,1);assert.equal(h.counts.iterate,1);assert.equal(h.counts.abort,2);
  assert.ok(Object.hasOwn(h.Stream.prototype,Symbol.asyncIterator));assert.equal(h.origin.summary()[11],0);
 });
 for(const [name,alter] of Object.entries({
  foreign_resource:d=>{d.Completions=class{create(){}};},
  foreign_return:d=>{const create=d.Completions.prototype.create;d.Completions.prototype.create=function(...args){const value=Reflect.apply(create,this,args);return Object.create(value);};},
  extra_request:d=>{const create=d.Completions.prototype.create;d.Completions.prototype.create=function(...args){const value=Reflect.apply(create,this,args);this._client.request(...args);return value;};},
 }))await run(name,async()=>{
  const h=bifrostProviderOriginInertHarness(f,{sourceChain:bifrostInertPublicCreateChain,dependencies:alter});
  try{await h.drive();}catch{await h.finish().catch(()=>{});}assert.equal(f.bifrostProviderErrorVector(h.w),undefined);
 });
 for(const reason of [{},undefined])await run("original create throw is unchanged",()=>{
  const h=bifrostProviderOriginInertHarness(f);let calls=0;h.Completions.prototype.create=function(){calls++;throw reason;};h.origin.install();
  let caught=false;try{h.create({});}catch(e){caught=true;assert.equal(e,reason);}h.origin.finish();
  assert.equal(caught,true);assert.equal(calls,1);assert.equal(h.w.observerFailures[0],reason);
 });
 await run("create receiver arguments and original return are unchanged",()=>{
  const h=bifrostProviderOriginInertHarness(f),client=new h.OpenAI(),resource=new h.Completions(client),args=[{},{}];let seen,value,calls=0;
  const original=h.Completions.prototype.create;h.Completions.prototype.create=function(...values){calls++;seen=[this,...values];return value=Reflect.apply(original,this,values);};
  h.origin.install();const returned=Reflect.apply(resource.create,resource,args);assert.equal(returned,value);assert.equal(calls,1);assert.deepEqual(seen,[resource,...args]);assert.equal(h.counts.parse,0);h.origin.finish();
 });
 for(const target of ["create","iterate"])await run("owned public descriptor replacement remains fatal",async()=>{
  const h=bifrostProviderOriginInertHarness(f,{sourceChain:bifrostInertPublicCreateChain});const finish=h.origin.finish;
  h.origin.finish=()=>{if(target==="create")h.Completions.prototype.create=()=>{};else h.Stream.prototype[Symbol.asyncIterator]=()=>{};return finish();};
  await h.drive();assert.equal(f.bifrostProviderErrorVector(h.w),undefined);assert.ok(h.w.observerFailures.length);
 });
 return passed;
}
test("Bifrost public create and authored iterator normalization (inert)",async()=>{assert.equal((await bifrostPublicCreateInertCases(assert)).length,9);});
export async function bifrostOriginJoinInertCases(assert, source) {
 const start=source.indexOf(" let at=0,seen=0,originAt=0;"),end=source.indexOf(' checkpoints.mark(caseIndex,"original_join","fulfilled");',start);
 assert.ok(start>=0&&end>start);const join=new Function("originals","w","providerOrigin","return (async()=>{"+source.slice(start,end)+"})();");
 const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
 const first=deferred(),late=deferred(),observer=deferred(),originals=[],w={observers:[],observerFailures:[]},origin={records:[{pending:first.promise}]};
 w.observers.push(first.promise.then(()=>{origin.records.push({pending:late.promise});w.observers.push(observer.promise);}));
 let done=false;const joined=join(originals,w,origin).then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);
 first.resolve();await Promise.resolve();await Promise.resolve();assert.equal(done,false);late.reject(undefined);await Promise.resolve();assert.equal(done,false);
 observer.reject(undefined);await joined;assert.equal(done,true);assert.deepEqual(w.observerFailures,[undefined]);
 return ["held original", "late original", "independently held observer", "undefined observer failure"];
}
test("Bifrost origin uses the original fixed-point join (inert)",async()=>{assert.equal((await bifrostOriginJoinInertCases(assert,readFileSync(new URL("./fixtures/openclaw-bifrost-contract.test.ts",import.meta.url),"utf8"))).length,4);});
export function bifrostProviderOriginWireInertCases(assert) {
 const {validateBifrostEvidence}=bifrostCheckpointFunctions(),passed=[];
 const record=()=>({v:1,pin:bifrostPin,lane:"sdk",case:15,evidence:true,complete:false,part:"postlude",
  control:Array.from({length:6},()=>[3,false,1000000,1000000,1000000]),validated:true,
  producer:[false,Array.from({length:4},(_,i)=>[i,3,false]),...Array(7).fill(1000000)],router:Array.from({length:4},()=>[3,false]),usage:[true,1000000,1000000],
  origin:[1,1,1,0,1000000,1000000,1000000,32,4,1000000,1000000,1000000,8]});
 for(const index of [3,7,14,15]){const r=record();r.case=index;validateBifrostEvidence(r);assert.ok(Buffer.byteLength("::notice title=Bifrost closed diagnostic::"+JSON.stringify(r)+"\n")<=759);passed.push("own case "+index);}
 for(const mutate of [r=>{r.case=2;},r=>{r.origin[1]=true;},r=>{r.origin[3]=1;},r=>{r.origin[10]=1000001;},r=>{r.origin.push(0);},r=>{r.transport=[];}]){
  const r=record();mutate(r);assert.throws(()=>validateBifrostEvidence(r));passed.push("closed schema rejection");}
 return passed;
}
test("Bifrost provider-error origin keeps the existing postlude quota (inert)",()=>{assert.equal(bifrostProviderOriginWireInertCases(assert).length,10);});
export async function bifrostOriginFirstFaultInertCases(assert) {
 const f=bifrostNativeEvaluator(),passed=[],run=async(name,fn)=>{await fn();passed.push(name);};
 const site=h=>h.origin.summary()[12];
 const denied=h=>{assert.equal(f.bifrostProviderErrorVector(h.w),undefined);assert.equal(f.evaluateBifrostNativeControl(h.w).qualified,false);};
 await run("healthy origin has no observed fault site",async()=>{const h=await bifrostProviderOriginInertHarness(f).drive();
  assert.ok(f.bifrostProviderErrorVector(h.w));assert.equal(site(h),0);assert.equal(h.origin.summary()[9],0);});
 for(const reason of [{},undefined])await run("invocation fault retains original definedness",async()=>{
  const h=await bifrostProviderOriginInertHarness(f,{dependencies:d=>{d.invocation=()=>{throw reason;};}}).drive();
  assert.equal(site(h),2);assert.equal(h.w.observerFailures[0],reason);assert.equal(h.origin.summary()[10],reason===undefined?2:0);assert.equal(h.counts.request,1);denied(h);});
 await run("client binding precedes the independent returned-promise fault",async()=>{
  const h=bifrostProviderOriginInertHarness(f);h.origin.install();const returned={};let calls=0;
  const receiver={makeRequest(){calls++;return returned;},responsePromise(value){assert.equal(value,returned);return value;}};
  assert.equal(Reflect.apply(h.OpenAI.prototype.request,receiver,[17]),returned);assert.equal(calls,1);
  assert.equal(site(h),3);assert.equal(h.origin.summary()[9],2);const first=h.w.observerFailures[0];h.origin.finish();
  assert.equal(h.w.observerFailures[0],first);assert.equal(site(h),3);denied(h);});
 await run("returned-promise binding preserves the original value",async()=>{
  const h=bifrostProviderOriginInertHarness(f);const client=new h.OpenAI(),returned={};client.responsePromise=()=>returned;
  h.Completions.prototype.create=function(...args){return client.request(...args);};h.origin.install();assert.equal(new h.Completions(client).create(17),returned);assert.equal(site(h),4);assert.equal(h.counts.request,1);h.origin.finish();denied(h);});
 await run("response lookup failure forwards the original method",async()=>{
  const h=bifrostProviderOriginInertHarness(f);h.origin.install();const p=h.create({});const reason={};
  h.d.isProxy=value=>{if(value===p)throw reason;return types.isProxy(value);};const returned=p.asResponse();
  assert.equal(await returned,h.response);assert.equal(site(h),5);assert.equal(h.w.observerFailures[0],reason);assert.equal(h.counts.response,1);h.origin.finish();denied(h);});
 await run("factory response lookup failure forwards once",async()=>{
  const h=bifrostProviderOriginInertHarness(f);h.origin.install();const client=new h.OpenAI(),p=new h.Completions(client).create({});await p.asResponse();
  h.d.isProxy=value=>{if(value===h.response)throw undefined;return types.isProxy(value);};const stream=h.Stream.fromSSEResponse(h.response,h.controller,client);
  assert.equal(Object.getPrototypeOf(stream),h.Stream.prototype);assert.equal(site(h),5);assert.equal(h.w.observerFailures[0],undefined);assert.equal(h.counts.factory,1);await h.finish();denied(h);});
 await run("guard attachment fault remains distinct from later faults",async()=>{
  const h=bifrostProviderOriginInertHarness(f);h.origin.install();h.create({});h.origin.guard(h.a);
  const first=h.w.observerFailures[0];assert.equal(site(h),6);h.origin.read({kind:"read",state:"fulfilled",reader:{transport:{method:"POST"}},value:{}});
  assert.equal(h.origin.summary()[9],2);assert.equal(h.w.observerFailures[0],first);assert.equal(site(h),6);h.origin.finish();denied(h);});
 await run("read validation keeps accessor untouched and first fault",async()=>{
  const h=bifrostProviderOriginInertHarness(f);let touched=0;const value={};Object.defineProperty(value,"done",{get(){touched++;throw undefined;}});
  h.origin.read({kind:"read",state:"fulfilled",reader:{transport:{method:"POST"}},value});assert.equal(site(h),7);assert.equal(touched,0);h.origin.finish();denied(h);});
 await run("missing hook produces seal prerequisite, not callback credit",async()=>{
  const h=await bifrostProviderOriginInertHarness(f,{dependencies:d=>{d.invocation=()=>undefined;}}).drive();
  assert.equal(site(h),0);assert.equal(h.origin.summary()[9],0);assert.deepEqual(Array.from(h.origin.summary().slice(4,9)),[0,0,0,0,0]);
  denied(h);assert.equal(site(h),8);assert.equal(h.origin.summary()[9],1);assert.equal(h.origin.summary()[10],0);});
 await run("first site is durable before reporting, including undefined",async()=>{
  let h;const hReason=undefined,reportReason={};h=bifrostProviderOriginInertHarness(f,{dependencies:d=>{
   d.invocation=()=>{throw hReason;};d.fault=e=>{assert.equal(h.origin.summary()[9],1);assert.equal(site(h),2);h.w.observerFailures.push(e);throw reportReason;};}});
  h.origin.install();const p=new h.OpenAI().request({});assert.equal(await p.asResponse(),h.response);
  let failed=false;try{h.origin.finish();}catch(e){failed=true;assert.deepEqual(Array.from(e.errors),[hReason,reportReason]);}
  assert.equal(failed,true);assert.equal(site(h),2);assert.equal(h.w.observerFailures[0],undefined);denied(h);});
 await run("descriptor conflict is unknown site and fatal restoration",async()=>{
  const h=bifrostProviderOriginInertHarness(f);h.origin.install();Object.defineProperty(h.Stream,"fromSSEResponse",{value:()=>{},writable:true,configurable:true});
  h.origin.finish();assert.equal(site(h),1);assert.equal(h.origin.summary()[11],1);denied(h);});
 await run("observer delivery fault uses unknown without losing undefined",async()=>{
  const h=bifrostProviderOriginInertHarness(f,{dependencies:d=>{d.observer=()=>{throw undefined;};}});h.origin.install();
  const p=h.create({}),returned=p.asResponse();assert.equal(returned,h.origin.records[0].pending);await returned;
  assert.equal(site(h),1);assert.equal(h.w.observerFailures[0],undefined);await h.finish();denied(h);});
 await run("late read cannot revive a seal or change the first site",async()=>{
  const h=await bifrostProviderOriginInertHarness(f).drive();assert.ok(f.bifrostProviderErrorVector(h.w));
  h.origin.read(h.w.originals.find(o=>o.kind==="read"&&o.state==="fulfilled"));assert.equal(site(h),7);denied(h);assert.equal(site(h),7);});
 const {validateBifrostEvidence}=bifrostCheckpointFunctions();
 const wire=()=>({v:1,pin:bifrostPin,lane:"sdk",case:3,evidence:true,complete:false,part:"postlude",
  control:Array(6).fill(null),validated:false,producer:null,router:null,usage:null,origin:[1,1,1,0,0,0,0,0,0,1,0,0,1]});
 for(let n=0;n<=8;n++)await run("wire admits exact site "+n,()=>{const r=wire();r.origin[12]=n;if(n===0)r.origin[9]=0;validateBifrostEvidence(r);});
 for(const mutate of [r=>r.origin.pop(),r=>{r.origin[12]=undefined;},r=>{r.origin[12]=null;},r=>{r.origin[12]=true;},r=>{r.origin[12]="2";},
  r=>{r.origin[12]=1.5;},r=>{r.origin[12]=9;},r=>{r.origin[12]=-1;},r=>{r.origin[12]=0;},r=>{r.origin[9]=0;},r=>{r.origin[3]=1;}])
  await run("wire rejects missing, contradictory or foreign site",()=>{const r=wire();mutate(r);assert.throws(()=>validateBifrostEvidence(r));});
 await run("missing origin remains unobserved, never fabricated",()=>{const r=wire();delete r.origin;validateBifrostEvidence(r);assert.equal(Object.hasOwn(r,"origin"),false);});
 return passed;
}
test("Bifrost origin first-fault sites preserve original errors (inert)",async()=>{await bifrostOriginFirstFaultInertCases(assert);});
// The control request signals one closed command. The original producer's
// already-created continuation owns enqueue. Neither path completes its pull.
export function requestBifrostProgress(s){
 if(s.mode!=="progress"||s.progressCalls!==0)throw Error("unexpected progress command");
 s.progressCalls=1;
 if(s.canceled===1)return {accepted:true,alreadyCanceled:true,enqueued:false};
 if(s.expired!==0||s.completed!==0||s.held!==1||typeof s.progressResolve!=="function"||!s.progressTask)throw Error("progress producer unavailable");
 s.progressResolve("progress");return s.progressTask;
}
export function performBifrostProgress(s,command,enqueue){
 if(command==="cancel"||s.canceled===1)return {accepted:true,alreadyCanceled:true,enqueued:false};
 if(command!=="progress"||s.mode!=="progress"||s.progressCalls!==1||s.progressEnqueued!==0||s.held!==1||s.expired!==0||s.completed!==0)throw Error("invalid progress state");
 enqueue();s.progressEnqueued=1;return {accepted:true,alreadyCanceled:false,enqueued:true};
}

function bifrostChildDiagnosticRecords(error,prefix,decode){
 const records=new Map(),seen=new Set(),pending=[error];let bytes=0,nodes=0;
 while(pending.length){const value=pending.pop();if(!value||(typeof value!=="object"&&typeof value!=="function")||seen.has(value))continue;
  seen.add(value);if(++nodes>64)throw Error("native diagnostic error closure exceeded");
  for(const field of ["stdout","stderr"]){const d=Object.getOwnPropertyDescriptor(value,field);if(!d||!("value" in d)||typeof d.value!=="string")continue;
   if(Buffer.byteLength(d.value)>2*1024*1024)throw Error("native diagnostic source exceeded");
   for(const line of d.value.split("\n")){if(!line.startsWith(prefix))continue;
    if(Buffer.byteLength(line)>768)throw Error("native diagnostic record exceeded");
    const record=JSON.parse(line.slice(prefix.length));
    const id=decode(record),encoded=JSON.stringify(record);
    if(records.has(id)){assert.equal(records.get(id),encoded);continue;}
    bytes+=Buffer.byteLength(encoded)+1;assert.ok(records.size<9&&bytes<=4096);records.set(id,encoded);
   }
  }
  const cause=Object.getOwnPropertyDescriptor(value,"cause");if(cause&&"value" in cause)pending.push(cause.value);
  const errors=Object.getOwnPropertyDescriptor(value,"errors");if(errors&&"value" in errors&&Array.isArray(errors.value)){
   const length=Object.getOwnPropertyDescriptor(errors.value,"length")?.value;assert.ok(Number.isSafeInteger(length)&&length<=64);
   for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(errors.value,String(i));if(d&&"value" in d)pending.push(d.value);}
  }
 }
 return [...records.values()].map(v=>JSON.parse(v));
}
export function bifrostNativeDiagnosticRecords(error){
 return bifrostChildDiagnosticRecords(error,"BIFROST_NATIVE_CONTROL ",record=>{
  assert.deepEqual(Object.keys(record).sort(),["v","pin","api","role","qualified","vector","worker","restored","rejected","pending"].sort());
  assert.equal(record.v,1);assert.equal(record.pin,bifrostPin);assert.ok(["stream","simple"].includes(record.api));assert.ok(["eof","preabort","partial","provider_error"].includes(record.role));
  for(const k of ["qualified","vector","worker","restored"])assert.equal(typeof record[k],"boolean");
  for(const k of ["rejected","pending"])assert.ok(Number.isSafeInteger(record[k])&&record[k]>=0&&record[k]<=1024);
  assert.ok(Buffer.byteLength(JSON.stringify(record))<400);return record.api+":"+record.role;
 });
}
export function bifrostCheckpointFunctions(){
 const source=readFileSync(new URL("./fixtures/openclaw-bifrost-contract.test.ts",import.meta.url),"utf8");
 const start="export function bifrostSetupPhase(",end="const checkpoints=createBifrostCheckpointReporter(";
 assert.equal(source.split(start).length,2);assert.equal(source.split(end).length,2);
 const text=source.slice(source.indexOf(start),source.indexOf(end));assert.doesNotMatch(text,/\bimport\b|\brequire\s*\(/);
 const native=bifrostNativeEvaluator();
 return runInNewContext('"use strict";\n'+stripTypeScriptTypes(text.replace(/^export /gm,""),{mode:"strip"})+"\n({bifrostSetupPhase,bifrostSignalEvidence,bifrostOperationEvidence,bifrostReasonMetadata,bifrostCaseEvidence,validateBifrostEvidence,validateBifrostCheckpoint,createBifrostCheckpointReporter,finishBifrostCheckpointCase,createBifrostSetupBoundary,createBifrostRetirementReader,validateBifrostWorkerResidual,bifrostObserveRetirementVerdict,validateBifrostProducerSite,validateBifrostProducerObservation,validateBifrostSourceProof,validateBifrostRetirementProof,bifrostPostludeEvidence})",{AbortSignal,Buffer,bifrostInvocationBound:native.bifrostInvocationBound,bifrostCancelOperand:native.bifrostCancelOperand},{timeout:1000});
}
export function bifrostCheckpointRecords(error){
 const {validateBifrostCheckpoint}=bifrostCheckpointFunctions();
 const records=bifrostChildDiagnosticRecords(error,"BIFROST_CHECKPOINT ",record=>{validateBifrostCheckpoint(record);assert.equal(record.lane,"sdk");return JSON.stringify(record);});
 const group=records.filter(r=>r.evidence===true);
 if(group.length){
  assert.equal(group.length,5,"incomplete diagnostic evidence group");
  assert.deepEqual(group.map(r=>r.part),["identity","reasons","order","retirement","postlude"]);
  assert.ok(group.every(r=>r.case===group[0].case&&r.complete===group[0].complete),"cross-case diagnostic evidence");
 }
 return records;
}
export function bifrostAnnotationEmitter(write){
 let bytes=0,count=0;
 return record=>{const line="::notice title=Bifrost closed diagnostic::"+JSON.stringify(record)+"\n";
  assert.ok(Buffer.byteLength(line)<=768&&bytes+Buffer.byteLength(line)<=8192&&count<32,"Bifrost annotation quota exceeded");
  bytes+=Buffer.byteLength(line);count++;write(line);};
}
// Reserve the complete child group before optional parent/native records. The
// existing wire limits still apply; joined writes are not platform atomicity.
export function createBifrostParentRelay(write){
 const evidence=[],optional=[],failures=[];let closed=false,evidenceInvalid=false;
 const {validateBifrostCheckpoint}=bifrostCheckpointFunctions();
 const snapshot=value=>{
  let nodes=0;
  const copy=(v,depth)=>{
   assert.ok(depth<=16&&++nodes<=512,"parent record exceeds bounds");
   if(v===null||typeof v==="boolean")return v;
   if(typeof v==="number"){assert.ok(Number.isFinite(v));return v;}
   if(typeof v==="string"){assert.ok(Buffer.byteLength(v)<=1024);return v;}
   assert.ok(v&&typeof v==="object"&&!types.isProxy(v),"exotic parent record");
   const descriptors=Object.getOwnPropertyDescriptors(v),array=Array.isArray(v),out=array?[]:{};
   if(array){const size=descriptors.length?.value;assert.ok(Number.isSafeInteger(size)&&size>=0&&size<=512);
    assert.deepEqual(Reflect.ownKeys(descriptors).sort(),["length",...Array.from({length:size},(_,i)=>String(i))].sort());}
   for(const key of Reflect.ownKeys(descriptors)){
    assert.equal(typeof key,"string");const d=descriptors[key];assert.ok(Object.hasOwn(d,"value"),"parent record accessor");
    if(array&&key==="length")continue;
    assert.ok(d.enumerable&&key!=="__proto__","invalid parent field");out[key]=copy(d.value,depth+1);
   }
   return out;
  };
  return copy(value,0);
 };
 return Object.freeze({
  record(value){
   if(closed)throw Error("parent record after output seal");
   let evidenceInput=true;
   try{
    const record=snapshot(value),encoded=JSON.stringify(record);
    evidenceInput=record.evidence===true;
    if(Object.hasOwn(record,"api"))bifrostNativeDiagnosticRecords({stdout:"BIFROST_NATIVE_CONTROL "+encoded});
    else validateBifrostCheckpoint(record);
    // Store immutable bytes, never a later-mutated producer record.
    const group=record.evidence===true?evidence:optional;
    assert.ok(group.length<(group===evidence?5:32),"parent record capacity exceeded");group.push(encoded);
   }catch(error){failures.push(error);if(evidenceInput)evidenceInvalid=true;}
  },
  async flush(){
   if(closed)throw Error("duplicate parent output seal");closed=true;
   let valid=!evidenceInvalid;
   try{if(evidence.length)bifrostCheckpointRecords({stdout:evidence.map(v=>"BIFROST_CHECKPOINT "+v).join("\n")});}
   catch(error){failures.push(error);valid=false;}
   if(valid){
    let pending;const emit=bifrostAnnotationEmitter(line=>{pending=write(line);assert.ok(pending instanceof Promise,"unjoined parent output");});
    for(const encoded of [...evidence,...optional]){
     try{emit(JSON.parse(encoded));await pending;}
     catch(error){failures.push(error);break;}
    }
   }
   if(failures.length===1)throw failures[0];
   if(failures.length)throw new AggregateError(failures,"parent diagnostic delivery failed");
  },
 });
}
export function bifrostJoinedOutput(output){
 const write=output.write;
 return line=>new Promise((resolve,reject)=>{
  let returned=false,called=false,callbackError;
  const settle=()=>callbackError==null?resolve():reject(callbackError);
  try{Reflect.apply(write,output,[line,error=>{called=true;callbackError=error;if(returned)settle();}]);}
  catch(error){reject(called&&callbackError!=null?new AggregateError([error,callbackError],"output invocation and callback failed"):error);return;}
  returned=true;if(called)settle();
 });
}
export async function withBifrostNativeDiagnostics(run,emit){
 try{return await run();}catch(error){const reporting=[];
  for(const collect of [bifrostCheckpointRecords,bifrostNativeDiagnosticRecords])try{for(const record of collect(error))emit(record);}catch(reportError){reporting.push(reportError);}
  if(reporting.length)throw new AggregateError([error,...reporting],"native child and diagnostic delivery failed");throw error;}
}
export async function runBifrostReported(body,cleanups,emit,flush=()=>{}){
 const reporter=bifrostCheckpointFunctions().createBifrostCheckpointReporter("outer",emit);
 reporter.mark(null,"setup","enter");reporter.flush(null);
 return finishBifrostOwned(()=>body(reporter),[...cleanups.map(cleanup=>()=>cleanup(reporter)),async()=>{
  await reporter.drain();reporter.flush(null);reporter.finish();
  if(reporter.failures.length)throw new AggregateError(reporter.failures,"Bifrost diagnostic observation failed");
 },flush]);
}

export async function finishBifrostOwned(body, cleanups, observeFailure) {
  const failures = [], reporting = []; let result;
  const observe = error => { if (observeFailure) try { observeFailure(error); } catch (error) { reporting.push(error); } };
  try { result = await body(); } catch (error) { failures.push(error); observe(error); }
  for (const cleanup of cleanups) try { await cleanup(); } catch (error) { failures.push(error); observe(error); }
  if (reporting.length) {
    const primary = failures.length === 1 ? failures[0] : new AggregateError(failures, "Bifrost body and original cleanup failed");
    throw new AggregateError([...(failures.length ? [primary] : []), ...reporting], "Bifrost original failure and observation failed");
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Bifrost body and original cleanup failed");
  return result;
}

// BEGIN Bifrost owned producer/control retirement helpers.
// Record originals and an explicitly supplied immediate observer without replacing either.
export function createBifrostProducerJoin(state, request, call) {
  if (state.producerJoin || state.calls.filter(value => value === call).length !== 1) throw Error("ambiguous producer owner");
  const id = state.id, mode = state.mode, calls = state.calls, callIndex = calls.indexOf(call);
  const roles = ["producer", "progressTask", "progressObserved", "progressCommand"];
  const records = new Map(), faults = [], seen = new Set();
  let response, body, attached = false, running, joinedSize = -1;
  const fail = () => { if (!faults.length) faults.push(Error("changed producer ownership")); };
  const check = () => {
    if (state.id !== id || state.mode !== mode || state.calls !== calls || calls[callIndex] !== call
      || calls.filter(value => value === call).length !== 1 || state.producerJoin !== owner
      || state.producerRequest !== request || (attached && (state.producerResponse !== response || state.producerBody !== body))) fail();
    for (const role of roles) if (state[role] !== records.get(role)?.promise) fail();
    const producer = records.get("producer"), observer = producer?.observer;
    if (state.producerObserver !== observer?.binding || observer &&
      (observer.binding.original !== producer.promise || observer.binding.pending !== observer.promise)) fail();
    return faults.length === 0;
  };
  const owner = Object.freeze({
    attach(value, stream) {
      if (attached || !value || !stream || value.body !== stream) { fail(); throw faults[0]; }
      response = value; body = stream; state.producerResponse = value; state.producerBody = stream; attached = true;
      if (!check()) throw faults[0];
    },
    capture(role, promise, originalRequest = request, observerBinding = undefined, witness = undefined) {
      if (!roles.includes(role) || originalRequest !== request || state[role] !== promise || !(promise instanceof Promise)) { fail(); throw faults[0]; }
      const old = records.get(role);
      if (old) { if (old.promise !== promise || old.observer?.binding !== observerBinding || old.witness !== witness) { fail(); throw faults[0]; } return promise; }
      if (observerBinding !== undefined && (role !== "producer" || !Object.isFrozen(observerBinding)
        || observerBinding.original !== promise || !(observerBinding.pending instanceof Promise)
        || observerBinding.pending === promise || state.producerObserver !== observerBinding || seen.has(observerBinding.pending))) { fail(); throw faults[0]; }
      if (witness !== undefined && (role !== "producer" || mode !== "partial" || typeof witness !== "function")) { fail(); throw faults[0]; }
      if (seen.has(promise)) { fail(); throw faults[0]; }
      const observer = observerBinding === undefined ? undefined : { binding: observerBinding, promise: observerBinding.pending, state: "pending", observer: true };
      seen.add(promise); if (observer) seen.add(observer.promise);
      records.set(role, { role, promise, state: "pending", observer, witness });
      if (!check()) throw faults[0];
      return promise;
    },
    observation() {
      check();
      const rows = roles.map(role => records.get(role)).filter(Boolean), producer = records.get("producer");
      const joined = joinedSize === records.size && rows.every(row => row.state !== "pending" && (!row.observer || row.observer.state !== "pending"));
      return { v: 1, ...(joined && faults.length === 0 && producer?.site ? { site: producer.site } : {}), joined: joinedSize === records.size && rows.every(row => row.state !== "pending" && (!row.observer || row.observer.state !== "pending")),
        roles: rows.map(row => [row.role, row.state, row.state === "rejected" ? row.error !== undefined : null]),
        faults: faults.length, failures: rows.filter(row => row.state === "rejected").length + faults.length,
        undefinedFailures: rows.filter(row => row.state === "rejected" && row.error === undefined).length + faults.filter(error => error === undefined).length };
    },
    drain() {
      if (running) return running;
      running = (async () => {
        try {
          do {
            check();
            const batch = roles.flatMap(role => { const row = records.get(role); return row ? [row, ...(row.observer ? [row.observer] : [])] : []; }).filter(row => row.state === "pending");
            const outcomes = await Promise.allSettled(batch.map(row => row.promise));
            outcomes.forEach((outcome, i) => {
              const row = batch[i]; row.state = outcome.status;
              if (outcome.status === "rejected") { row.error = outcome.reason; if (row.observer === true) faults.push(outcome.reason); }
            });
            check();
          } while ([...records.values()].some(row => row.state === "pending" || row.observer?.state === "pending"));
          if (!attached) fail();
          joinedSize = records.size;
          const producer = records.get("producer");
          if (faults.length === 0 && producer?.witness && !producer.witnessRead) {
            producer.witnessRead = true;
            try { producer.site = producer.witness(producer.state === "rejected", producer.error); }
            catch (error) { faults.push(error); }
            check();
          }
          const rejected = roles.map(role => records.get(role)).filter(row => row?.state === "rejected");
          const failures = [...rejected.map(row => row.error), ...faults];
          if (records.get("producer")?.state === "fulfilled") state.settled = 1;
          if (failures.length === 1) throw failures[0];
          if (failures.length) throw new AggregateError(failures, "original producer joins failed");
          return roles.filter(role => records.has(role)).map(role => ({ role, state: records.get(role).state }));
        } finally { running = undefined; }
      })();
      return running;
    },
  });
  state.producerRequest = request; state.producerJoin = owner;
  return owner;
}

// Demand-driven partial response only. The unchanged prefix precedes at most
// 64 KiB of nonterminal SSE comments. The budget can exhaust before disconnect
// is observed: at the cap, hold. Only genuine cancel resolves the lifetime.
export function createBifrostPartialProducer(s, request, owner, prefix, io) {
  const first = io.encode(prefix), chunk = io.encode(": " + "x".repeat(1020) + "\n\n");
  if (first.byteLength > 1024 || chunk.byteLength !== 1024) throw Error("invalid bounded producer bytes");
  let lifetime, resolve, reject, timer, timerOwned = false, ended = false, chunks = 0, bytes = 0;
  const budgetFailures = [];
  // Fixed source sites: capture, timer acquisition, enqueue, deadline, cap, cancel cleanup.
  let site = 0, timerBits = 0, primaryPresent = false, primary, cleanupPresent = false, cleanup;
  const failure = (at, reason) => { if (!site) { site = at; primaryPresent = true; primary = reason; } };
  const secondary = reason => { if (!site) site = 6; if (!cleanupPresent) { cleanupPresent = true; cleanup = reason; } };
  const witness = (rejected, reason) => {
    const mask = (present, value) => (present ? 1 : 0) | (present && value !== undefined ? 2 : 0) | (present && rejected && Object.is(value, reason) ? 4 : 0);
    return [site, chunks, bytes, timerBits, mask(primaryPresent, primary), mask(cleanupPresent, cleanup) | (primaryPresent && cleanupPresent && Object.is(primary, cleanup) ? 8 : 0)];
  };
  const finish = (failures, clear) => {
    ended = true; s.held = 0;
    if (clear && timerOwned) { timerOwned = false; timerBits |= 2; try { io.clearTimeout(timer); timerBits |= 4; } catch (error) { secondary(error); failures.push(error); } }
    if (failures.length) {
      const error = failures.length === 1 ? failures[0] : new AggregateError(failures, "partial producer and cleanup failed");
      reject(error); return { failed: true, error };
    }
    resolve(); return { failed: false };
  };
  return {
    start(controller) { s.held = 1; controller.enqueue(first); },
    pull(controller) {
      if (ended) return lifetime;
      if (!lifetime) {
        lifetime = new Promise((yes, no) => { resolve = yes; reject = no; }); s.producer = lifetime;
        const pending = lifetime.then(() => {}, () => {});
        s.producerObserver = Object.freeze({ original: lifetime, pending });
        let stage = 1;
        try {
          owner.capture("producer", lifetime, request, s.producerObserver, witness);
          stage = 2; timer = io.setTimeout(() => {
            if (ended) return;
            timerOwned = false; timerBits |= 8; s.expired++;
            const error = Error("producer expired"), failures = [...budgetFailures, error]; failure(4, error);
            try { controller.error(error); } catch (error) { secondary(error); failures.push(error); }
            finish(failures, false);
          }, 10000);
          timerOwned = true; timerBits |= 1; s.timer = timer;
        } catch (error) { failure(stage, error); const failed = finish([error], true); throw failed.error; }
      }
      if (chunks === 64 || bytes + chunk.byteLength > 65536) {
        if (!budgetFailures.length) { const error = Error("partial producer budget exhausted"); budgetFailures.push(error); failure(5, error); }
        return lifetime;
      }
      try { controller.enqueue(chunk); chunks++; bytes += chunk.byteLength; }
      catch (error) { failure(3, error); const failed = finish([error], true); throw failed.error; }
      // Return permits the next requested pull; it does not complete the source.
    },
    cancel() {
      if (ended) throw Error("duplicate partial producer cancellation");
      s.canceled++;
      // Cancellation before the first pull acquired no producer or timer.
      if (!lifetime) { ended = true; s.held = 0; return; }
      const result = finish([...budgetFailures], true); if (result.failed) throw result.error;
    },
  };
}

// Consume the actual control response first. On failure, retire its body once
// without replacing the original failure (which may be undefined).
export function createBifrostControlReader() {
  return bifrostCheckpointFunctions().createBifrostRetirementReader();
}
export async function bifrostProducerProof(s) {
  const failures = [], owner = s.producerJoin;
  try {
    if (owner) await owner.drain();
    else if (s.producer || s.progressTask || s.progressObserved || s.progressCommand) throw Error("unbound producer originals");
  } catch (error) { failures.push(error); }
  s.producerProofFailures = failures;
  const producer = owner ? owner.observation() :
    { v: 1, joined: failures.length === 0, roles: [], faults: failures.length, failures: failures.length, undefinedFailures: failures.filter(error => error === undefined).length };
  return { owner: s.id, calls: s.calls, held: s.held, canceled: s.canceled, expired: s.expired, settled: s.settled,
    completed: s.completed, progressCalls: s.progressCalls, progressEnqueued: s.progressEnqueued, progressTerminal: s.progressTerminal, producer };
}
// The original join error remains first. Financial assertions require the same
// request's validated payload and an observed original usage operation.
export async function finishBifrostRow(join, evidence, retirement, financial) {
  const failures = []; let proof;
  try { proof = await join(); } catch (error) { failures.push(error); }
  try { const retained = evidence(); if (proof && proof !== retained) throw Error("replaced retirement proof"); proof = retained; }
  catch (error) { proof = undefined; failures.push(error); }
  if (proof) {
    try { await retirement(proof); } catch (error) { failures.push(error); }
    if (proof.observation.usageObserved) try { await financial(proof); } catch (error) { failures.push(error); }
  }
  if (!proof && failures.length === 0) failures.push(Error("missing owned retirement evidence"));
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "original retirement and independent assertions failed");
}
// END Bifrost owned producer/control retirement helpers.

// BEGIN Bifrost inert retirement regressions (no native transports or timers).
export async function bifrostRetirementInertCases(assert) {
  const cases = [];
  const run = async (name, body) => { await body(); cases.push(name); };
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  const outcome = async promise => { try { return { failed: false, value: await promise }; } catch (error) { return { failed: true, error }; } };
  const fixture = () => {
    const request = {}, call = {}, state = { id: "case", mode: "progress", calls: [call], settled: 0 };
    const owner = createBifrostProducerJoin(state, request, call), body = {}, response = { body };
    owner.attach(response, body);
    const capture = (role, promise) => { state[role] = promise; assert.equal(owner.capture(role, promise, request), promise); };
    return { request, call, state, owner, body, response, capture };
  };
  await run("no acquired producer creates no release", async () => {
    const c = fixture(); assert.deepEqual(await c.owner.drain(), []); assert.equal(c.state.settled, 0);
  });
  for (const role of ["producer", "progressTask", "progressObserved", "progressCommand"]) {
    await run("held " + role, async () => {
      const c = fixture(), held = deferred(); c.capture(role, held.promise);
      const joined = c.owner.drain(); assert.equal(c.owner.drain(), joined);
      let done = false; const observed = joined.then(() => { done = true; });
      await Promise.resolve(); await Promise.resolve(); assert.equal(done, false);
      held.resolve(); await observed;
      assert.deepEqual(await c.owner.drain(), [{ role, state: "fulfilled" }]);
    });
    await run("rejected " + role, async () => {
      const c = fixture(), original = deferred(), reason = {}; c.capture(role, original.promise);
      const joined = outcome(c.owner.drain()); original.reject(reason);
      assert.deepEqual(await joined, { failed: true, error: reason });
      assert.deepEqual(await outcome(c.owner.drain()), { failed: true, error: reason });
    });
  }
  await run("undefined task remains failed when its attached observer fulfills", async () => {
    const c = fixture(), original = deferred(); c.capture("progressTask", original.promise);
    const alreadyAttached = original.promise.then(() => {}, () => {}); c.capture("progressObserved", alreadyAttached);
    const joined = outcome(c.owner.drain()); original.reject(undefined);
    assert.deepEqual(await joined, { failed: true, error: undefined }); await alreadyAttached;
    assert.deepEqual(await outcome(c.owner.drain()), { failed: true, error: undefined });
  });
  await run("independent producer and task failures retained once in role order", async () => {
    const c = fixture(), producer = deferred(), task = deferred(), first = {}, second = {};
    c.capture("progressTask", task.promise); c.capture("progressObserved", task.promise.then(() => {}, () => {})); c.capture("producer", producer.promise);
    const joined = outcome(c.owner.drain()); task.reject(second); producer.reject(first);
    const result = await joined; assert.equal(result.failed, true); assert.deepEqual(result.error.errors, [first, second]);
    assert.deepEqual((await outcome(c.owner.drain())).error.errors, [first, second]);
  });
  await run("settlement reveals late owned work and fixed point joins it", async () => {
    const c = fixture(), command = deferred(), held = deferred();
    const task = command.promise.then(() => { c.capture("producer", held.promise); }); c.capture("progressTask", task);
    let done = false; const joined = c.owner.drain().then(value => { done = true; return value; });
    command.resolve(); await task; await Promise.resolve(); assert.equal(done, false);
    held.resolve(); assert.deepEqual(await joined, [{ role: "producer", state: "fulfilled" }, { role: "progressTask", state: "fulfilled" }]);
  });
  const changes = [c => { c.state.id = "foreign"; }, c => { c.state.mode = "other"; }, c => { c.state.calls = [...c.state.calls]; },
    c => { c.state.calls[0] = {}; }, c => { c.state.calls.push(c.call); }, c => { c.state.producerRequest = {}; },
    c => { c.state.producerResponse = {}; }, c => { c.state.producerBody = {}; }, c => { c.state.producerJoin = {}; },
    c => { c.state.producer = Promise.resolve(); }];
  for (const [index, change] of changes.entries()) await run("owner mutation " + index, async () => {
    const c = fixture(), held = deferred(); c.capture("producer", held.promise); change(c);
    let done = false; const joined = outcome(c.owner.drain()).then(value => { done = true; return value; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(done, false); held.resolve(); assert.equal((await joined).failed, true);
  });
  await run("foreign request and promise alias cannot be captured", async () => {
    const c = fixture(), promise = Promise.resolve(); c.state.producer = promise;
    assert.throws(() => c.owner.capture("producer", promise, {}));
    const d = fixture(); d.capture("producer", promise); d.state.progressTask = promise;
    assert.throws(() => d.owner.capture("progressTask", promise));
    assert.equal((await outcome(d.owner.drain())).failed, true);
  });
  await run("replaced promise and response cannot replace existing ownership", async () => {
    const c = fixture(); c.capture("producer", Promise.resolve()); c.state.producer = Promise.resolve();
    assert.throws(() => c.owner.capture("producer", c.state.producer));
    assert.throws(() => c.owner.attach({ body: c.body }, c.body));
    assert.throws(() => createBifrostProducerJoin(c.state, c.request, c.call));
  });
  const control = () => {
    const read = createBifrostControlReader(), owner = { id: "case", mode: "progress" }, receiver = {}, args = ["fixture", { method: "POST" }], calls = [], pending = [];
    const body = { cancel(...values) { assert.equal(this, body); assert.deepEqual(values, []); calls.push("cancel"); return Promise.resolve(); } };
    const response = { body, text(...values) { assert.equal(this, response); assert.deepEqual(values, []); calls.push("text"); return Promise.resolve("value"); } };
    function fetch(...values) { assert.equal(this, receiver); assert.deepEqual(values, args); calls.push("fetch"); return Promise.resolve(response); }
    const observe = (kind, start) => { const original = start(); pending.push({ kind, original }); return original; };
    return { read, owner, receiver, args, calls, pending, body, response, fetch, observe, invoke: () => read(owner, fetch, receiver, args, "text", observe) };
  };
  await run("control original arguments receiver response and consumption order", async () => {
    const c = control(), result = await c.invoke(); assert.equal(result.response, c.response); assert.equal(result.value, "value");
    assert.deepEqual(c.calls, ["fetch", "text"]); assert.deepEqual(c.pending.map(x => x.kind), ["control_fetch", "control_body"]);
    await Promise.all(c.pending.map(x => x.original));
  });
  await run("control waits for original body before returning", async () => {
    const c = control(), held = deferred(); c.response.text = function () { assert.equal(this, c.response); return held.promise; };
    let done = false; const result = c.invoke().then(value => { done = true; return value; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(done, false); held.resolve("body");
    assert.equal((await result).value, "body"); assert.equal(c.pending[1].original, held.promise);
  });
  for (const primary of [undefined, {}]) await run("control consumption plus independent cancellation failure " + (primary === undefined), async () => {
    const c = control(), cleanup = primary === undefined ? {} : undefined;
    c.response.text = function () { assert.equal(this, c.response); return Promise.reject(primary); };
    c.body.cancel = function () { assert.equal(this, c.body); c.calls.push("cancel"); return Promise.reject(cleanup); };
    const result = await outcome(c.invoke()); assert.equal(result.failed, true);
    // The extracted helper owns a VM-realm array; the original reasons retain identity.
    assert.ok(Array.isArray(result.error.errors)); assert.equal(result.error.errors.length, 2);
    assert.deepEqual(Reflect.ownKeys(result.error.errors), ["0", "1", "length"]);
    assert.equal(result.error.errors[0], primary); assert.equal(result.error.errors[1], cleanup);
    assert.deepEqual(c.calls, ["fetch", "cancel"]); assert.deepEqual(c.pending.map(x => x.kind), ["control_fetch", "control_body", "control_cancel"]);
  });
  await run("synchronous undefined consumption still cancels once", async () => {
    const c = control(); c.response.text = () => { throw undefined; };
    assert.deepEqual(await outcome(c.invoke()), { failed: true, error: undefined }); assert.deepEqual(c.calls, ["fetch", "cancel"]);
  });
  await run("no acquired response means no invented cancellation", async () => {
    const c = control(); const result = await outcome(c.read(c.owner, () => Promise.reject(undefined), c.receiver, c.args, "text", c.observe));
    assert.deepEqual(result, { failed: true, error: undefined }); assert.deepEqual(c.calls, []);
  });
  await run("foreign reused response or body never cancels the other owner", async () => {
    const c = control(); await c.invoke(); assert.equal((await outcome(c.invoke())).failed, true);
    const foreign = { body: c.body, text: c.response.text };
    assert.equal((await outcome(c.read({ id: "foreign" }, () => Promise.resolve(foreign), c.receiver, c.args, "text", c.observe))).failed, true);
    assert.equal(c.calls.includes("cancel"), false);
  });
  for (const replace of [c => { c.owner.id = "foreign"; }, c => { c.args[0] = "foreign"; }]) await run("control ownership changes before acquired consumption", async () => {
    const c = control(), held = deferred(); const result = outcome(c.read(c.owner, () => held.promise, c.receiver, c.args, "text", c.observe));
    replace(c); held.resolve(c.response); assert.equal((await result).failed, true); assert.deepEqual(c.calls, ["cancel"]);
  });
  await run("unchanged progress command and expired/canceled semantics", async () => {
    const s = { mode: "progress", progressCalls: 0, progressEnqueued: 0, held: 1, canceled: 0, expired: 0, completed: 0 }, command = deferred();
    let enqueues = 0; s.progressResolve = command.resolve;
    s.progressTask = command.promise.then(value => performBifrostProgress(s, value, () => { enqueues++; }));
    assert.equal(requestBifrostProgress(s), s.progressTask); await s.progressTask;
    assert.equal(enqueues, 1); assert.equal(s.progressCalls, 1); assert.throws(() => requestBifrostProgress(s));
    const expired = { ...s, expired: 1 }; assert.throws(() => performBifrostProgress(expired, "expired", () => { enqueues++; }));
    assert.deepEqual(performBifrostProgress({ ...s, canceled: 1 }, "cancel", () => { enqueues++; }), { accepted: true, alreadyCanceled: true, enqueued: false });
    assert.equal(enqueues, 1);
  });
  return cases;
}
export async function bifrostFailureObservationInertCases(assert) {
  const names = [], run = async (name, body) => { await body(); names.push(name); };
  const outcome = async p => { try { return {failed:false,value:await p}; } catch(error) { return {failed:true,error}; } };
  const deferred = () => { let resolve, reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
  const producer = () => {
    const request={},call={},s={id:"case",mode:"partial",calls:[call],held:1,canceled:0,expired:0,settled:0,completed:0,progressCalls:0,progressEnqueued:0,progressTerminal:false};
    const owner=createBifrostProducerJoin(s,request,call),body={},response={body};owner.attach(response,body);
    const capture=(role,p)=>{s[role]=p;owner.capture(role,p,request);};return {s,owner,capture};
  };
  await run("failed producer keeps undefined and no invented partial observer",async()=>{
    const c=producer(),p=deferred();c.capture("producer",p.promise);const pending=bifrostProducerProof(c.s);p.reject(undefined);
    const proof=await pending;assert.deepEqual(c.s.producerProofFailures,[undefined]);
    assert.deepEqual(proof.producer,{v:1,joined:true,roles:[["producer","rejected",false]],faults:0,failures:1,undefinedFailures:1});
    assert.equal(proof.held,1);assert.equal(proof.settled,0);
  });
  await run("proof waits for late already attached observer",async()=>{
    const c=producer(),p=deferred(),tail=deferred();let done=false;
    c.capture("producer",p.promise);const attached=p.promise.then(()=>{c.capture("progressObserved",tail.promise);});c.capture("progressTask",attached);
    const proof=bifrostProducerProof(c.s).then(v=>{done=true;return v;});p.resolve();await attached;await Promise.resolve();assert.equal(done,false);
    tail.reject(undefined);const value=await proof;assert.deepEqual(value.producer.roles,[["producer","fulfilled",null],["progressTask","fulfilled",null],["progressObserved","rejected",false]]);
    assert.deepEqual(c.s.producerProofFailures,[undefined]);
  });
  await run("late capture invalidates prior joined observation",async()=>{
    const c=producer();c.capture("producer",Promise.resolve());await c.owner.drain();assert.equal(c.owner.observation().joined,true);
    const held=deferred();c.capture("progressObserved",held.promise);assert.equal(c.owner.observation().joined,false);held.resolve();await c.owner.drain();assert.equal(c.owner.observation().joined,true);
  });
  await run("foreign producer ownership remains failed",async()=>{
    const c=producer();c.capture("producer",Promise.resolve());c.s.producerRequest={};const value=await bifrostProducerProof(c.s);
    assert.equal(value.producer.faults,1);assert.equal(value.producer.failures,1);assert.equal(c.s.producerProofFailures.length,1);
  });
  const f=bifrostCheckpointFunctions();
  const fixture = () => {
    const read=f.createBifrostRetirementReader(),owner=Object.freeze({id:"case"}),ticket=read.capture(owner),calls=[],receiver={},args=["fixture",{}];
    const body={cancel(){calls.push("cancel");return Promise.resolve();}},response={status:500,body,text(){assert.equal(this,response);calls.push("text");return Promise.resolve('{"owner":"case"}');}};
    const pending=Promise.resolve(response);function fetch(...values){assert.equal(this,receiver);assert.deepEqual(values,args);calls.push("fetch");return pending;}
    return {read,owner,ticket,calls,body,response,pending,invoke:()=>read(owner,fetch,receiver,args,"text",(_kind,start)=>start(),ticket)};
  };
  await run("original return retained before failed strict verdict",async()=>{
    const c=fixture();await c.invoke();assert.equal(c.read.inspect(c.ticket).steps[0].returned,c.pending);
    const parsed=c.read.parse(c.ticket);assert.equal(c.read.validate(c.ticket,(v,id)=>v.owner===id),parsed);
    const primary={};assert.throws(()=>c.read.verdict(c.ticket,()=>{throw primary;}),e=>e===primary);
    const state=c.read.inspect(c.ticket);assert.equal(state.parsed,parsed);assert.equal(state.validated,true);assert.equal(state.steps[5].reason,primary);
    assert.deepEqual(c.calls,["fetch","text"]);assert.equal(state.steps[1].receiver,c.response);
  });
  await run("parse failure and undefined verdict have distinct stages",async()=>{
    const c=fixture();c.response.text=()=>Promise.resolve("{");await c.invoke();assert.throws(()=>c.read.parse(c.ticket));
    assert.equal(c.read.inspect(c.ticket).steps[3].state,4);assert.equal(c.read.inspect(c.ticket).validated,false);assert.equal(c.read.inspect(c.ticket).steps[5],undefined);
    const d=fixture();await d.invoke();d.read.parse(d.ticket);d.read.validate(d.ticket,()=>true);
    const result=await outcome(Promise.resolve().then(()=>d.read.verdict(d.ticket,()=>{throw undefined;})));
    assert.deepEqual(result,{failed:true,error:undefined});assert.equal(d.read.inspect(d.ticket).steps[5].state,4);
  });
  await run("consumption and cancellation keep separate original undefined failures",async()=>{
    const c=fixture(),primary={},cancel=deferred();c.response.text=()=>Promise.reject(primary);c.body.cancel=()=>{c.calls.push("cancel");return cancel.promise;};
    let done=false;const pending=outcome(c.invoke()).then(v=>{done=true;return v;});await Promise.resolve();await Promise.resolve();assert.equal(done,false);
    cancel.reject(undefined);const result=await pending;
    assert.ok(Array.isArray(result.error.errors));assert.equal(result.error.errors.length,2);
    assert.deepEqual(Reflect.ownKeys(result.error.errors),["0","1","length"]);
    assert.equal(result.error.errors[0],primary);assert.equal(result.error.errors[1],undefined);
    const state=c.read.inspect(c.ticket);assert.equal(state.steps[2].returned,cancel.promise);assert.equal(state.steps[1].state,3);assert.equal(state.steps[2].state,3);assert.equal(state.readJoined,true);
  });
  await run("foreign owner ticket and invalid proof rejected",async()=>{
    const c=fixture();assert.throws(()=>c.read.inspect({}));
    assert.equal((await outcome(c.read({},()=>{},undefined,[],"text",(_kind,start)=>start(),c.ticket))).failed,true);
    await c.invoke();c.read.parse(c.ticket);assert.throws(()=>c.read.validate(c.ticket,()=>false));assert.equal(c.read.inspect(c.ticket).validated,false);
  });
  await run("recorder fault cannot abandon original fetch and consumption",async()=>{
    const read=f.createBifrostRetirementReader(),owner={id:"case"},ticket=read.capture(owner),original=deferred(),order=[],reason={};
    const response={body:{cancel(){throw Error("unexpected cancellation");}},text(){order.push("text");return Promise.resolve("{}");}};
    const pending=outcome(read(owner,()=>original.promise,undefined,[],"text",(kind,start)=>{const p=start();if(kind==="control_fetch")throw reason;return p;},ticket));
    original.resolve(response);const result=await pending;assert.equal(result.error,reason);assert.deepEqual(order,["text"]);assert.equal(read.inspect(ticket).readJoined,true);
  });
  for(const available of [true,false])await run("failed join preserves primary with accounting availability "+available,async()=>{
    const primary=undefined,retirement={},financial={},proof={observation:{usageObserved:available}},order=[];
    const result=await outcome(finishBifrostRow(()=>{order.push("join");throw primary;},()=>proof,()=>{order.push("retire");throw retirement;},()=>{order.push("finance");throw financial;}));
    assert.deepEqual(result.error.errors,available?[primary,retirement,financial]:[primary,retirement]);assert.deepEqual(order,available?["join","retire","finance"]:["join","retire"]);
  });
  await run("missing or replaced evidence never runs financial assertions",async()=>{
    let calls=0;const primary={};assert.equal((await outcome(finishBifrostRow(()=>{throw primary;},()=>undefined,()=>calls++,()=>calls++))).error,primary);
    assert.equal((await outcome(finishBifrostRow(()=>({}),()=>({}),()=>calls++,()=>calls++))).failed,true);assert.equal(calls,0);
  });
  await run("successful original request and assertion order unchanged",async()=>{
    const proof={observation:{usageObserved:true}},order=[];await finishBifrostRow(()=>{order.push("join");return proof;},()=>proof,()=>order.push("retire"),()=>order.push("finance"));
    assert.deepEqual(order,["join","retire","finance"]);
  });
  await run("validated proof rejects foreign owner and missing usage observation",async()=>{
    const c=producer();c.capture("producer",Promise.resolve());const source=await bifrostProducerProof(c.s);
    assert.equal(f.validateBifrostSourceProof(source,"case"),true);assert.equal(f.validateBifrostSourceProof(source,"foreign"),false);
    const proof={owner:"case",retired:false,calls:[],operations:[],readers:[],events:[],charged:0,disposition:"strict",source:null,
      observation:{owner:"case",phases:[[2,null],[3,false],[2,null],[2,null]],producer:source,usageObserved:true}};
    assert.equal(f.validateBifrostRetirementProof(proof,"case"),true);
    for(const value of [{...proof,owner:"foreign"},{...proof,observation:{...proof.observation,owner:"foreign"}},{...proof,observation:{...proof.observation,usageObserved:undefined}}])assert.equal(f.validateBifrostRetirementProof(value,"case"),false);
  });
  await run("postlude projection retains absence and bounded maximum width",async()=>{
    const base={v:1,pin:bifrostPin,lane:"sdk",case:2,evidence:true,complete:false,part:"postlude"};
    const absent={...base,...f.bifrostPostludeEvidence(undefined,undefined)};f.validateBifrostEvidence(absent);assert.equal(absent.producer,null);assert.equal(absent.usage,null);assert.equal(absent.validated,false);
    const steps=Array.from({length:6},(_,phase)=>({phase,state:3,reason:undefined,invoke:1000000,returnAt:1000000,settle:1000000}));
    const source={held:1000000,canceled:1000000,expired:1000000,settled:1000000,producer:{joined:true,roles:["producer","progressTask","progressObserved","progressCommand"].map(r=>[r,"rejected",false]),faults:1000000,failures:1000000,undefinedFailures:1000000}};
    const wide={...base,...f.bifrostPostludeEvidence({steps,validated:true},{observation:{producer:source,phases:Array(4).fill([3,false]),usageObserved:true},events:{length:1000000},charged:1000000})};
    f.validateBifrostEvidence(wide);assert.ok(Buffer.byteLength("::notice title=Bifrost closed diagnostic::"+JSON.stringify(wide)+"\n")<=768);
    for(const delta of [{pin:"foreign"},{part:"foreign"},{extra:1},{control:[]},{usage:[false,0,0]}])assert.throws(()=>f.validateBifrostEvidence({...absent,...delta}));
  });
  return names;
}
// END Bifrost inert retirement regressions.

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
// Source-owned records only. This snapshot never classifies or removes a failure.
export function bifrostWorkerResidual(s) {
  const bounded=n=>{if(!Number.isSafeInteger(n)||n<0||n>1000000)throw Error("residual evidence bound");return n;};
  const state=o=>["pending","fulfilled","rejected","threw"].indexOf(o?.state)+1;
  const present=o=>o&&["rejected","threw"].includes(o.state)&&Object.hasOwn(o,"error");
  const bad=s.ops.filter(o=>o.state!=="fulfilled"),first=bad[0];
  const kinds=["fetch","fetch_observer","read","read_observer","closed","cancel","body_cancel","control_fetch","control_body","control_cancel","usage","waitUntil","handler"];
  const reads=bad.filter(o=>o.kind==="read"),observers=bad.filter(o=>o.kind==="read_observer");
  const read=reads.length===1?reads[0]:undefined,observer=observers.length===1?observers[0]:undefined;
  const unique=kind=>{if(!read?.reader)return 0;const rows=s.ops.filter(o=>o.reader===read.reader&&o.kind===kind);return rows.length===1?state(rows[0]):0;};
  return [1,[bounded(bad.length),bounded(s.sync.length),bounded(s.observerFailures.length)],
    first?[kinds.indexOf(first.kind)+1,state(first),bounded(s.ops.indexOf(first)),present(first)?first.error===undefined?1:2:0]:null,
    [bounded(reads.length),bounded(observers.length),read&&observer?!!read.reader&&read.reader===observer.reader:null,
      read&&observer?!!read.pending&&read.pending===observer.originalRead:null,
      present(read)&&present(observer)?Object.is(read.error,observer.error):null,unique("closed"),unique("cancel")]];
}
export async function collectBifrostOperations(s) {
  let at=0;
  while(at<s.roots.length){const batch=s.roots.slice(at);at=s.roots.length;for(const outcome of await Promise.allSettled(batch))if(outcome.status==="rejected")s.observerFailures.push(outcome.reason);}
  return s.ops.filter(r=>r.state!=="fulfilled");
}
// The shipping cancellation contract joins the original read and cancel before
// release. This admits the owned read outcome, not a native error-cause claim.
export function bifrostProgressReadDisposition(s, usage, charged, facts) {
  if(s.mode!=="progress"||s.workerDeadline||s.sync.length||s.observerFailures.length||charged!==0)return null;
  const bad=s.ops.filter(o=>o.state!=="fulfilled"),read=bad.find(o=>o.kind==="read"),observer=bad.find(o=>o.kind==="read_observer");
  if(bad.length!==2||!read||!observer||read.state!=="rejected"||observer.state!=="rejected"||
    !Object.hasOwn(read,"error")||!Object.hasOwn(observer,"error")||!Object.is(read.error,observer.error)||
    !read.pending||observer.originalRead!==read.pending||observer.reader!==read.reader)return null;
  const r=read.reader,t=r?.transport,index=s.transports.indexOf(t),call=s.calls[index];
  if(!r||!t||s.readers.filter(v=>v===r).length!==1||s.transports.filter(v=>v===t).length!==1||
    s.requests.filter(v=>v===t.request).length!==1||s.readers.filter(v=>v.transport===t).length!==1||
    call?.method!=="POST"||call.url!=="https://gateway.fixture/openai/v1/chat/completions"||
    !call.noCaller||!call.original||call.redirect!=="manual"||s.calls.filter(v=>v.method==="POST").length!==1)return null;
  const rows=kind=>s.ops.filter(o=>o.reader===r&&o.kind===kind);
  if(rows("cancel").length!==1||rows("closed").length!==1||rows("read").filter(o=>o.state==="rejected").length!==1)return null;
  if(!["prefix","receiverIdentity","fetchFulfilled","cancelFulfilled","closedFulfilled","bodyUnlocked","otherOperationsFulfilled"].every(k=>facts[k]===true)||facts.unlocks!==1)return null;
  const times=[facts.prefixSettled,facts.readInvoked,facts.cancelInvoked,facts.readSettled,facts.cancelSettled,facts.closedSettled,facts.unlockObserved];
  if(!times.every(v=>Number.isSafeInteger(v)&&v>0)||!(facts.prefixSettled<facts.readInvoked&&facts.readInvoked<facts.cancelInvoked&&facts.cancelInvoked<facts.readSettled&&
    Math.max(facts.readSettled,facts.cancelSettled,facts.closedSettled)<facts.unlockObserved))return null;
  const source=s.source,producer=source?.producer;
  if(source?.owner!==s.id||source.held!==0||source.canceled!==1||source.settled!==1||source.expired!==0||source.completed!==0||
    source.progressCalls!==1||source.progressTerminal!==false||![0,1].includes(source.progressEnqueued)||
    source.calls.filter(v=>v.chat).length!==1||producer?.joined!==true||producer.faults!==0||producer.failures!==0||producer.undefinedFailures!==0||
    producer.roles.length!==4||new Set(producer.roles.map(v=>v[0])).size!==4||
    !producer.roles.every(v=>["producer","progressTask","progressObserved","progressCommand"].includes(v[0])&&v[1]==="fulfilled"&&v[2]===null))return null;
  const events=usage?.events?.filter(e=>e.capability==="llm.chat")??[],e=events[0];
  if(events.length!==1||e.provider!=="bifrost"||e.policy_id!==s.id||e.credential_id!==s.id||e.model!=="tenant/opaque-a"||
    e.status!=="client_error"||e.status_code!==200||e.actual_cost_micros!==7||e.reserved_cost_micros!==7||e.cost_basis!=="policy_fixed"||
    !["input_tokens","output_tokens","total_tokens","cached_input_tokens"].every(k=>e[k]===null))return null;
  return [read.ordinal,observer.ordinal];
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
${bifrostWorkerResidual.toString()}
${bifrostDeadlineQualified.toString()}
${bifrostProgressReadDisposition.toString()}
${bifrostDeadlineWitness.toString()}
${bifrostCheckpointFunctions().createBifrostRetirementReader.toString()}
${bifrostCheckpointFunctions().validateBifrostProducerSite.toString()}
${bifrostCheckpointFunctions().validateBifrostProducerObservation.toString()}
${bifrostCheckpointFunctions().validateBifrostSourceProof.toString()}
import {resolveGrantCandidates,grantRoutingPolicy} from './worker/grant-selection.ts';
const nativeFetch=globalThis.fetch,states=new Map(),base='https://gateway.fixture/openai/v1',readControl=createBifrostRetirementReader();
function invoke(s,kind,run,details){return observeBifrostOperation(s,kind,run,details);}
function observe(s,p,kind,details){return invoke(s,kind,()=>p,details);}
async function drain(s){return collectBifrostOperations(s);}
function publicOperations(s){return s.ops.map(o=>({kind:o.kind,ordinal:o.ordinal,state:o.state,invoke:o.invoke,settle:o.settle??null}));}
async function control(s,path){const result=await readControl(s,nativeFetch,globalThis,['https://bifrost-control.fixture/'+path+'/'+s.id,{method:'POST',body:JSON.stringify({mode:s.mode,models:s.ids})}],'json',(kind,start)=>invoke(s,kind,start));
 if(path==='proof'){if(!validateBifrostSourceProof(result.value,s.id))throw Error('invalid original producer proof');s.producerObservation=result.value;
  if(result.response.status!==200||!result.value.producer.joined||result.value.producer.failures!==0)throw Error('original producer proof failed');}
 return result.value;}
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
 const parts=url.pathname.split('/'); const match=parts.length===4&&parts[1]==='__bifrost'&&['state','join','mutate','progress'].includes(parts[2])&&/^[a-zA-Z0-9_]+$/.test(parts[3])?[null,parts[2],parts[3]]:null;
 if(match){const s=states.get(match[2]);if(!s)return Response.json({absent:true});
  if(match[1]==='progress'){if(s.mode!=='progress')throw Error('wrong progress case');return Response.json(await control(s,'progress'));}
  if(match[1]==='mutate'){await mutate(s,(await request.json()).kind);return Response.json({mutated:true});}
  if(match[1]==='join'){
   if(!s.retirement)s.retirement=(async()=>{
    const failures=[],phases=[];try{await drain(s);phases.push([2,null]);}catch(e){failures.push(e);phases.push([3,e!==undefined]);}
    try{s.source=await control(s,'proof');phases.push([2,null]);}catch(e){failures.push(e);phases.push([3,e!==undefined]);}
    let usage,usageObserved=false;try{usage=await invoke(s,'usage',()=>usageSnapshot(bindings,'fixture',s.id,{kind:'admin'}));usageObserved=true;phases.push([2,null]);}catch(e){failures.push(e);phases.push([3,e!==undefined]);}
    try{await drain(s);phases.push([2,null]);}catch(e){failures.push(e);phases.push([3,e!==undefined]);}
    const charged=bodyBudgetCharged(),deadline=bifrostDeadlineWitness(s,InternalHttpAbort,usage,charged);
    const candidate=bifrostDeadlineQualified(deadline),progressRead=bifrostProgressReadDisposition(s,usage,charged,deadline);
    for(const o of s.ops)if(o.state!=='fulfilled'&&!(candidate&&(o.ordinal===deadline.readOrdinal||o.ordinal===deadline.observerOrdinal))&&!progressRead?.includes(o.ordinal))failures.push(o.error);
    failures.push(...s.sync,...s.observerFailures);
     let residual=null;if(s.mode==='progress')try{residual=bifrostWorkerResidual(s);}catch(error){failures.push(error);}
     const proof={owner:s.id,observation:{owner:s.id,phases,producer:s.producerObservation??null,usageObserved,...(s.mode==='progress'?{residual}: {})},calls:s.calls,operations:publicOperations(s),readers:s.readers.map(r=>({unlocks:r.unlocks,eof:r.eof,locked:r.body.locked})),source:s.source??null,events:usage?.events??[],charged,prefix:s.prefix,mutated:s.mutated,inspected:!!s.inspected,inboundChatAborted:s.inboundChatAborted===true,deadline,
      progressRead,disposition:candidate?'provisional_worker_deadline_read':progressRead?'owned_worker_progress_read':'strict',retired:failures.length===0,syncFailures:s.sync.length};
    s.retirementFailures=failures;return proof;
   })();
   const proof=await s.retirement;return Response.json(proof,{status:proof.retired?200:500});
  }return Response.json({calls:s.calls.length,prefix:s.prefix,mutated:s.mutated,inspected:!!s.inspected});
 }
 const authorization=request.headers.get('authorization')??'',s=[...states.values()].find(s=>(authorization.startsWith('Bearer clawrouter-live-'+s.id+'-')||authorization.startsWith('Bearer clawrouter-live-'+s.id+'_discovery-')));
 if(!s)throw Error('unbound original Bifrost request');
 if(s.retirement)throw Error('request after original retirement');
 s.requests.push(request);
 if(url.pathname.endsWith('/chat/completions')){const notify=()=>{s.inboundChatAborted=true;};if(request.signal.aborted)notify();else request.signal.addEventListener('abort',notify,{once:true});}
 const context={waitUntil:p=>{observe(s,p,'waitUntil');originalContext.waitUntil(p);}};
 return observe(s,worker.fetch(request,s.env,context),'handler');
},queue:worker.queue};`;

const upstream = `
${requestBifrostProgress.toString()}
${performBifrostProgress.toString()}
${createBifrostProducerJoin.toString()}
${createBifrostPartialProducer.toString()}
${bifrostProducerProof.toString()}
const states=new Map();
export default {async fetch(request){const url=new URL(request.url);
 if(url.hostname==='bifrost-control.fixture'){
  const [,kind,id]=url.pathname.split('/');
  if(kind==='setup'){const cfg=await request.json();states.set(id,{...cfg,id,calls:[],held:0,expired:0,canceled:0,settled:0,completed:0,progressCalls:0,progressEnqueued:0,progressTerminal:false});return Response.json({ready:true});}
  const s=states.get(id);if(!s)throw Error('missing upstream owner');
  if(kind==='progress')return Response.json(await requestBifrostProgress(s));
  if(kind==='complete'){if(!s.complete)throw Error('missing producer');s.complete();return Response.json({accepted:true});}
   if(kind==='proof'){const proof=await bifrostProducerProof(s);return Response.json(proof,{status:s.producerProofFailures.length?500:200});}
 }
 const secret=request.headers.get('authorization')??'',s=[...states.values()].find(s=>secret==='Bearer synthetic-owner-'+s.id||secret==='Bearer synthetic-rotated-'+s.id);
 if(!s)throw Error('foreign upstream credential');
 if(url.origin!=='https://gateway.fixture'||url.search||!['/openai/v1/models','/custom/openai/models','/openai/v1/chat/completions'].includes(url.pathname))throw Error('foreign upstream destination');
 const chat=url.pathname.endsWith('/chat/completions'),body=chat?await request.json():null;
  const call={method:request.method,path:url.pathname,query:!!url.search,chat,model:body?.model??null,stream:body?.stream??null};s.calls.push(call);
 if(s.mode==='redirect')return new Response(null,{status:302,headers:{location:'https://foreign.fixture/models'}});
 if(s.mode==='error401'||s.mode==='error403')return Response.json({error:{message:'sanitized fixture rejection'}},{status:Number(s.mode.slice(5))});
 if(!chat){
  const data=(s.mode==='empty'?[]:s.models).map(id=>({id,object:'model'}));
  const value=s.mode==='malformed'?{object:'list',data:[{}]}:s.mode==='loose'?{data}:s.mode==='wrong_object'?{object:'wrong',data}:{object:'list',data};
  if(!s.mode.startsWith('held_')&&s.mode!=='deadline')return Response.json(value);
  const bytes=JSON.stringify(value),prefix='{"object":"list","data":[';
   const owner=createBifrostProducerJoin(s,request,call),stream=new ReadableStream({start(c){s.held=1;c.enqueue(new TextEncoder().encode(prefix));},pull(c){
   if(s.producer)return s.producer;s.producer=new Promise((resolve,reject)=>{s.resolve=resolve;const timer=setTimeout(()=>{s.expired++;s.held=0;c.error(Error('producer expired'));reject(Error('producer expired'));},s.mode==='deadline'?35000:5000);s.timer=timer;
     s.complete=()=>{clearTimeout(timer);c.enqueue(new TextEncoder().encode(bytes.slice(prefix.length)));c.close();s.held=0;resolve();};});owner.capture('producer',s.producer,request);return s.producer;
   },cancel(){s.canceled++;clearTimeout(s.timer);s.held=0;s.resolve?.();}});const response=new Response(stream,{headers:{'content-type':'application/json'}});owner.attach(response,stream);return response;
 }
 const frame=v=>'data: '+JSON.stringify(v)+'\\n\\n',chunk=delta=>({id:'chat_fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]}),prefix=frame(chunk({role:'assistant',content:'synthetic-prefix'}));
 if(s.mode==='provider_error')return new Response(prefix+frame({error:{message:'synthetic-provider-error',type:'server_error'}}),{headers:{'content-type':'text/event-stream'}});
 if(s.mode!=='partial'&&s.mode!=='progress')return new Response(prefix+frame({id:'chat_fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}})+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
 if(s.mode==='partial'){
  const timerReceiver=globalThis,setTimer=timerReceiver.setTimeout,clearTimer=timerReceiver.clearTimeout;
  const owner=createBifrostProducerJoin(s,request,call),source=createBifrostPartialProducer(s,request,owner,prefix,{encode:value=>new TextEncoder().encode(value),setTimeout:(...args)=>Reflect.apply(setTimer,timerReceiver,args),clearTimeout:(...args)=>Reflect.apply(clearTimer,timerReceiver,args)});
  const stream=new ReadableStream(source),response=new Response(stream,{headers:{'content-type':'text/event-stream'}});owner.attach(response,stream);return response;
 }
  const owner=createBifrostProducerJoin(s,request,call),stream=new ReadableStream({start(c){s.held=1;c.enqueue(new TextEncoder().encode(prefix));
   if(s.mode==='progress'){s.progressCommand=new Promise(resolve=>{s.progressResolve=resolve;});owner.capture('progressCommand',s.progressCommand,request);s.progressTask=s.progressCommand.then(command=>performBifrostProgress(s,command,()=>c.enqueue(new TextEncoder().encode(': progress\\n\\n'))));owner.capture('progressTask',s.progressTask,request);s.progressObserved=s.progressTask.then(()=>{},()=>{});owner.capture('progressObserved',s.progressObserved,request);}
 },pull(c){if(s.producer)return s.producer;
   s.producer=new Promise((resolve,reject)=>{s.resolve=resolve;s.timer=setTimeout(()=>{s.expired++;s.held=0;s.progressResolve?.('expired');c.error(Error('producer expired'));reject(Error('producer expired'));},10000);});owner.capture('producer',s.producer,request);return s.producer;
  },cancel(){s.canceled++;clearTimeout(s.timer);s.held=0;s.progressResolve?.('cancel');s.resolve?.();}});const response=new Response(stream,{headers:{'content-type':'text/event-stream'}});owner.attach(response,stream);return response;
}};`;

export async function startBifrostFixture({hotCache=false}={}) {
  const directory = await mkdtemp(join(tmpdir(), "bifrost-contract-")); let runtime, origin;
  try {
    runtime = await startWorkerdFixture(directory, router, upstream, {directRouter:true,hotCache,bindings:{BIFROST_BASE_URL:'https://gateway.fixture/openai/v1',BIFROST_MODEL:'tenant/opaque-a',BIFROST_API_KEY:'synthetic-poison-env'}});
    origin = (await runtime.unsafeGetDirectURL("router")).origin;
  } catch (error) { await finishBifrostOwned(() => { throw error; }, [() => runtime?.dispose(), () => rm(directory,{recursive:true,force:true})]); }
  const readControl = createBifrostControlReader();
  const json = async (path, body) => {
    const { response, value: text } = await readControl(Object.freeze({id:path}),fetch,undefined,[origin+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body??{})}],"text",(_kind,start)=>start());
    let value;try{value=JSON.parse(text);}catch{throw Error('fixture control returned non-JSON');}assert.equal(response.status,200,JSON.stringify(value)); return value;
  };
  const joined = new Map(), {validateBifrostRetirementProof} = bifrostCheckpointFunctions();
  const joinOwned = async id => {
    if (joined.has(id)) throw Error("duplicate outer retirement request");
    const owner = Object.freeze({id}), ticket = readControl.capture(owner); joined.set(id,{owner,ticket});
    await readControl(owner,fetch,undefined,[origin+'/__bifrost/join/'+id,{method:"POST",headers:{"content-type":"application/json"},body:"{}"}],"text",(_kind,start)=>start(),ticket);
    readControl.parse(ticket);const proof=readControl.validate(ticket,validateBifrostRetirementProof);
    readControl.verdict(ticket,(response,value)=>assert.equal(response.status,200,JSON.stringify(value)));return proof;
  };
  const joinEvidence = id => {
    const entry=joined.get(id);if(!entry)return undefined;
    const c=readControl.inspect(entry.ticket);if(c.owner!==entry.owner||c.id!==id)throw Error("foreign outer retirement evidence");
    return c.validated?c.parsed:undefined;
  };
  return { origin, runtime, setup:row=>json('/__bifrost/setup',row), mutate:(id,kind)=>json('/__bifrost/mutate/'+id,{kind}),
    join:joinOwned, joinEvidence, state:id=>json('/__bifrost/state/'+id),
    close:()=>finishBifrostOwned(()=>{},[()=>runtime.dispose(),()=>rm(directory,{recursive:true,force:true})]) };
}

export function assertBifrostRetired(proof, {workerDeadline=false, application, evidence}={}) {
  assert.equal(proof.retired,true);
  if(workerDeadline){
    assert.equal(bifrostDeadlineQualified(proof.deadline),true,JSON.stringify(proof.deadline));
    assert.equal(proof.disposition,"provisional_worker_deadline_read");
    assert.equal(application?.status,502);
    assert.deepEqual(application.body,{error:{code:"provider_unavailable",message:"upstream request to provider bifrost failed"}});
    assert.deepEqual(Array.from(proof.operations.filter(r=>r.state!=="fulfilled"),r=>[r.ordinal,r.kind,r.state]),[
      [proof.deadline.readOrdinal,"read","rejected"],[proof.deadline.observerOrdinal,"read_observer","rejected"]]);
   }else if(proof.disposition==="owned_worker_progress_read"){
    assert.ok(Array.isArray(proof.progressRead)&&proof.progressRead.length===2&&proof.progressRead.every(Number.isSafeInteger)&&proof.progressRead[0]!==proof.progressRead[1]);
    assert.deepEqual(Array.from(proof.operations.filter(r=>r.state!=="fulfilled"),r=>[r.ordinal,r.kind,r.state]),[
      [proof.progressRead[0],"read","rejected"],[proof.progressRead[1],"read_observer","rejected"]]);
    assertBifrostFailedChatAccounting({id:proof.owner,mode:"partial"},proof);
    assert.equal(proof.source.owner,proof.owner);assert.equal(proof.source.canceled,1);assert.equal(proof.source.settled,1);
    assert.equal(proof.source.producer.joined,true);assert.equal(proof.source.producer.faults,0);assert.equal(proof.source.producer.failures,0);
  }else assert.ok(proof.operations.every(r=>r.state==='fulfilled'));
  assert.ok(proof.readers.every(r=>r.unlocks===1&&!r.locked));
  evidence?.stage(10);assert.equal(proof.charged,0);
  evidence?.stage(11);assert.equal(proof.source.held,0);assert.equal(proof.source.expired,0);
  evidence?.stage(12);for(const call of proof.calls){assert.equal(call.noCaller,true);assert.equal(call.redirect,'manual');assert.ok(call.original||call.rotated);}
}

export async function bifrostParentRelayInertCases(assert){
 const passed=[],run=async(name,fn)=>{await fn();passed.push(name);};
 const outcome=async p=>{try{return {failed:false,value:await p};}catch(error){return {failed:true,error};}};
 const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
 const f=bifrostCheckpointFunctions(),prefix="::notice title=Bifrost closed diagnostic::";
 const group=()=>f.bifrostCaseEvidence(2,{transports:[],acquisitions:[],originals:[],caller:{},failures:[],syncFailures:[],observerFailures:[],evidenceRestoreFailures:0,evidenceRestoreUndefined:0},undefined,false,[]);
 const coarse=i=>({v:1,pin:bifrostPin,lane:"outer",case:i,phase:"setup",state:"fulfilled",defined:null,acq:null,op:null,count:0});
 const parse=line=>{assert.ok(line.startsWith(prefix));assert.ok(Buffer.byteLength(line)<=768);return JSON.parse(line.slice(prefix.length));};
 const parts=records=>records.filter(r=>r.evidence===true).map(r=>r.part);
 const expected=["identity","reasons","order","retirement","postlude"];
 const child=()=>{const records=[],r=f.createBifrostCheckpointReporter("sdk",value=>records.push(value),true);r.mark(null,"module","fulfilled");r.flush(null);for(let i=0;i<3;i++){r.mark(i,"setup","fulfilled");r.flush(i);}r.evidence(group());r.finish();return {stdout:records.map(r=>"BIFROST_CHECKPOINT "+JSON.stringify(r)).join("\n")};};
 const pipeline=(relay,primary,cleanups=[])=>runBifrostReported(async report=>{
  await report.observe(null,"setup",()=>Promise.resolve(),undefined,[]);report.mark(null,"child","enter");report.flush(null);
  await withBifrostNativeDiagnostics(()=>report.observe(null,"child",()=>Promise.reject(primary),undefined,[]),relay.record);
 },cleanups,relay.record,relay.flush);
 await run("actual parent pipeline reserves five notices under a ten-notice sink",async()=>{
  const accepted=[],lines=[];const relay=createBifrostParentRelay(line=>{lines.push(line);if(lines.length<=10)accepted.push(parse(line));return Promise.resolve();}),primary=child();
  const result=await outcome(pipeline(relay,primary));assert.ok(result.failed);assert.equal(result.error,primary);
  assert.deepEqual(parts(accepted),expected);assert.deepEqual(lines.slice(0,5).map(line=>parse(line).part),expected);assert.ok(Buffer.byteLength(lines.join(""))<=8192);
 });
 await run("original cleanup joins before any output",async()=>{
  const held=deferred(),entered=deferred(),lines=[],primary=child(),relay=createBifrostParentRelay(line=>{lines.push(line);return Promise.resolve();});
  const work=outcome(pipeline(relay,primary,[()=>{entered.resolve();return held.promise;}]));await entered.promise;assert.equal(lines.length,0);held.resolve();assert.equal((await work).error,primary);assert.deepEqual(parts(lines.map(parse)),expected);
 });
 await run("first output completion is held and joined before later writes",async()=>{
  const held=deferred(),entered=deferred(),lines=[],relay=createBifrostParentRelay(line=>{lines.push(line);if(lines.length===1){entered.resolve();return held.promise;}return Promise.resolve();});group().forEach(relay.record);
  let complete=false;const pending=relay.flush().then(()=>{complete=true;});await entered.promise;assert.equal(lines.length,1);assert.equal(complete,false);held.resolve();await pending;assert.equal(lines.length,5);
 });
 for(const error of [undefined,{}])await run("original child cleanup and output failures independent "+(error===undefined?"undefined":"defined"),async()=>{
  const primary=child(),cleanup={},relay=createBifrostParentRelay(()=>Promise.reject(error));const result=await outcome(pipeline(relay,primary,[()=>{throw cleanup;}]));
  assert.ok(result.failed);assert.deepEqual(result.error.errors,[primary,cleanup,error]);
 });
 for(const error of [undefined,{}])await run("synchronous output failure preserved "+(error===undefined?"undefined":"defined"),async()=>{
  let writes=0;const relay=createBifrostParentRelay(()=>{writes++;throw error;});group().forEach(relay.record);const result=await outcome(relay.flush());assert.ok(result.failed);assert.equal(result.error,error);assert.equal(writes,1);
 });
 await run("joined native writer preserves receiver arguments and backpressure callback",async()=>{
  let callback,calls=0,completed=false;const output={write(line,done){assert.equal(this,output);assert.equal(line,"closed line");assert.equal(arguments.length,2);calls++;callback=done;return false;}};
  const work=bifrostJoinedOutput(output)("closed line").then(()=>{completed=true;});await Promise.resolve();assert.equal(completed,false);assert.equal(calls,1);callback();await work;
 });
 await run("output callback error is an independent rejection",async()=>{
  const error={},write=bifrostJoinedOutput({write(_line,callback){callback(error);return true;}});const result=await outcome(write("closed line"));assert.ok(result.failed);assert.equal(result.error,error);
 });
 await run("synchronous callback success cannot mask later undefined throw",async()=>{
  const result=await outcome(bifrostJoinedOutput({write(_line,callback){callback();throw undefined;}})("closed line"));assert.ok(result.failed);assert.equal(result.error,undefined);
 });
 await run("invocation and callback errors both survive",async()=>{
  const callback={},result=await outcome(bifrostJoinedOutput({write(_line,done){done(callback);throw undefined;}})("closed line"));assert.ok(result.failed);assert.deepEqual(result.error.errors,[undefined,callback]);
 });
 await run("partial writer failure remains explicit with no optional continuation",async()=>{
  const error={},lines=[],relay=createBifrostParentRelay(line=>{lines.push(line);return lines.length===3?Promise.reject(error):Promise.resolve();});relay.record(coarse(0));group().forEach(relay.record);const result=await outcome(relay.flush());assert.ok(result.failed);assert.equal(result.error,error);assert.equal(lines.length,3);assert.ok(lines.every(line=>parse(line).evidence));assert.throws(()=>bifrostCheckpointRecords({stdout:lines.map(line=>"BIFROST_CHECKPOINT "+JSON.stringify(parse(line))).join("\n")}));
 });
 for(const [name,change]of [
  ["missing part",g=>g.slice(0,4)],["duplicate part",g=>[...g,g[0]]],["foreign case",g=>g.map((r,i)=>i===1?{...r,case:3}:r)],
  ["conflicting completeness",g=>g.map((r,i)=>i===1?{...r,complete:!r.complete}:r)],["foreign version",g=>g.map((r,i)=>i===1?{...r,v:2}:r)],["foreign pin",g=>g.map((r,i)=>i===1?{...r,pin:"foreign"}:r)],
 ])await run("invalid group emits no evidence: "+name,async()=>{const lines=[],relay=createBifrostParentRelay(line=>{lines.push(line);return Promise.resolve();});change(group()).forEach(relay.record);assert.ok((await outcome(relay.flush())).failed);assert.equal(lines.length,0);});
 await run("optional saturation cannot displace the reserved group",async()=>{
  const lines=[],relay=createBifrostParentRelay(line=>{lines.push(line);return Promise.resolve();});for(let i=0;i<32;i++)relay.record(coarse(i));group().forEach(relay.record);const result=await outcome(relay.flush());assert.ok(result.failed);assert.deepEqual(lines.slice(0,5).map(line=>parse(line).part),expected);assert.ok(lines.length<=32);assert.ok(Buffer.byteLength(lines.join(""))<=8192);
 });
 await run("capture stores immutable bytes",async()=>{
  const lines=[],relay=createBifrostParentRelay(line=>{lines.push(line);return Promise.resolve();}),g=group();g.forEach(relay.record);g[0].pin="foreign";await relay.flush();assert.equal(parse(lines[0]).pin,bifrostPin);
 });
 for(const kind of ["accessor","proxy","sparse","array extra"] )await run("reject exotic record without getter: "+kind,async()=>{
  let touched=0;const g=group();if(kind==="accessor")Object.defineProperty(g[0],"pin",{get(){touched++;throw undefined;}});
  if(kind==="proxy")g[0]=new Proxy(g[0],{ownKeys(){touched++;throw undefined;}});
  if(kind==="sparse")g[1].readSignals=new Array(3);
  if(kind==="array extra")g[1].readSignals.extra=1;
  const lines=[],relay=createBifrostParentRelay(line=>{lines.push(line);return Promise.resolve();});g.forEach(relay.record);assert.ok((await outcome(relay.flush())).failed);assert.equal(touched,0);assert.equal(lines.length,0);
 });
 await run("no evidence keeps original optional bytes and order",async()=>{
  const input=Array.from({length:32},(_,i)=>coarse(i)),expected=[],actual=[];const direct=bifrostAnnotationEmitter(line=>expected.push(line));input.forEach(direct);
  const relay=createBifrostParentRelay(line=>{actual.push(line);return Promise.resolve();});input.forEach(relay.record);await relay.flush();assert.deepEqual(actual,expected);assert.ok((await outcome(relay.flush())).failed);assert.throws(()=>relay.record(coarse(2)));assert.equal(actual.length,32);
 });
 await run("synchronous boolean is not joined output completion",async()=>{
  const relay=createBifrostParentRelay(()=>false);group().forEach(relay.record);assert.ok((await outcome(relay.flush())).failed);
 });
 await run("maximum transport postlude stays inside unchanged command and total caps",async()=>{
  const g=group(),r=g[4];r.transport=[4,Array(8).fill(16),Array(8).fill(1000000),[63,16,16,16,7,7]];
  r.control=Array.from({length:6},()=>[3,false,1000000,1000000,1000000]);r.validated=true;r.producer=[false,Array.from({length:4},(_,i)=>[i,3,false]),...Array(7).fill(1000000)];r.producer.push([5,64,65536,15,7,15]);r.router=Array.from({length:4},()=>[3,false]);r.usage=[true,1000000,1000000];
  const lines=[],relay=createBifrostParentRelay(line=>{lines.push(line);return Promise.resolve();});g.forEach(relay.record);await relay.flush();assert.deepEqual(parts(lines.map(parse)),expected);assert.ok(Buffer.byteLength(lines.join(""))<=8192);
 });
 return passed;
}

export async function bifrostResidualInertCases(assert, source) {
  const names=[],groups=[],run=async(name,fn)=>{await fn();names.push(name);},f=bifrostCheckpointFunctions();
  const start=source.indexOf("if(!s.retirement)s.retirement=(async()=>{")+"if(!s.retirement)s.retirement=(async()=>{".length;
  const end=source.indexOf("})();",start);assert.ok(start>0&&end>start);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const retire=new AsyncFunction("s","drain","control","invoke","usageSnapshot","bindings","bodyBudgetCharged","bifrostDeadlineWitness","bifrostDeadlineQualified","InternalHttpAbort","publicOperations","bifrostWorkerResidual","bifrostProgressReadDisposition",source.slice(start,end));
  const group=(proof,c={})=>f.bifrostCaseEvidence(30,{transports:[],acquisitions:[],originals:[],caller:{},failures:[],syncFailures:[],observerFailures:[],evidenceRestoreFailures:0,evidenceRestoreUndefined:0},proof,false,[],c);
  for(const kind of ["healthy","same defined P/Q","undefined P/Q","sync only","observer only","mixed"]){
    await run(kind,async()=>{
      const E=kind==="undefined P/Q"?undefined:{},sync={},observer={},s={id:"owned",mode:"progress",workerDeadline:false,sequence:0,ops:[],roots:[],sync:[],observerFailures:[],readers:[],transports:[],requests:[],calls:[],inboundChatAborted:true};
      const reader={body:{locked:false},unlocks:1,eof:false},track=(kind,p,details={})=>observeBifrostOperation(s,kind,()=>p,details);
      s.readers.push(reader);track("closed",Promise.resolve(),{reader});
      if(["same defined P/Q","undefined P/Q","mixed"].includes(kind)){
        const P=track("read",Promise.reject(E),{reader}),Q=P.then(()=>undefined);track("read_observer",Q,{reader,originalRead:P});assert.notEqual(P,Q);
      }else track("read",Promise.resolve({done:false,value:{byteLength:1}}),{reader});
      track("cancel",Promise.resolve(),{reader});
      if(["sync only","mixed"].includes(kind))s.sync.push(sync);
      if(["observer only","mixed"].includes(kind))s.observerFailures.push(observer);
      const sourceProof={owner:s.id,held:0,canceled:1,expired:0,settled:1,completed:0,progressCalls:1,progressEnqueued:1,progressTerminal:false,calls:[],producer:{v:1,joined:true,roles:["producer","progressTask","progressObserved","progressCommand"].map(k=>[k,"fulfilled",null]),faults:0,failures:0,undefinedFailures:0}};
      const proof=await retire(s,collectBifrostOperations,async()=>{s.producerObservation=sourceProof;return sourceProof;},(s,k,start)=>observeBifrostOperation(s,k,start),async()=>({events:[{},{}]}),{},()=>0,bifrostDeadlineWitness,bifrostDeadlineQualified,function InternalHttpAbort(){},s=>s.ops.map(o=>({kind:o.kind,state:o.state})),bifrostWorkerResidual,bifrostProgressReadDisposition);
      assert.deepEqual(proof.observation.phases,Array.from({length:4},()=>[2,null]));assert.equal(proof.retired,kind==="healthy");
      assert.equal(f.validateBifrostWorkerResidual(proof.observation.residual),true);assert.equal(proof.deadline.workerOnly,false);
      const expected=kind.includes("P/Q")||kind==="mixed"?[E,E]:[];if(s.sync.length)expected.push(sync);if(s.observerFailures.length)expected.push(observer);
      assert.equal(s.retirementFailures.length,expected.length);s.retirementFailures.forEach((reason,i)=>assert.equal(reason,expected[i]));
      const c={},response={get status(){assert.equal(this,response);c.statusReads=(c.statusReads??0)+1;return proof.retired?200:500;}};
      assert.equal(f.bifrostObserveRetirementVerdict(c,response,proof),proof.retired);assert.equal(c.statusReads,1);
      const records=group(proof,c);records.forEach(f.validateBifrostCheckpoint);groups.push(records);
      const lines=[],relay=createBifrostParentRelay(line=>{lines.push(line);return Promise.resolve();});records.forEach(relay.record);await relay.flush();
      assert.equal(lines.length,5);assert.ok(lines.every(l=>Buffer.byteLength(l)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
    });
  }
  await run("all failure categories are distinguishable",()=>assert.equal(new Set(groups.map(g=>JSON.stringify(g[4].worker))).size,6));
  for(const [status,retired] of [[200,true],[200,false],[500,true],[500,false]])await run("separate verdict operands "+status+"/"+retired,()=>{
    const c={};assert.equal(f.bifrostObserveRetirementVerdict(c,{status},{retired,disposition:"strict"}),status===200&&retired);assert.ok(Array.isArray(c.verdict));assert.deepEqual(Array.from(c.verdict),[status===200,retired,1]);
  });
  for(const reason of [undefined,{}])await run("status getter original failure "+(reason===undefined?"undefined":"defined"),()=>{
    const c={};let threw=false;try{f.bifrostObserveRetirementVerdict(c,{get status(){throw reason;}},{retired:false,disposition:"strict"});}catch(e){threw=true;assert.equal(e,reason);}assert.equal(threw,true);assert.equal(c.verdict,undefined);
  });
  await run("unknown and missing observations stay unknown",()=>{const r=group(undefined)[4];assert.ok(Array.isArray(r.worker));assert.deepEqual(Array.from(r.worker),[1,null,null,null,null]);f.validateBifrostCheckpoint(r);});
  await run("maximum legal progress tuple and actual relay",async()=>{
    const g=group(undefined),r=g[4];r.control=Array.from({length:6},()=>[3,false,1000000,1000000,1000000]);r.validated=false;
    r.producer=[false,Array.from({length:4},(_,i)=>[i,3,false]),...Array(7).fill(1000000)];r.router=Array.from({length:4},()=>[3,false]);r.usage=[true,1000000,1000000];
    // One handler plus 499999 reads and 500000 observers: all widths retained.
    r.worker=[1,[1000000,1000000,1000000],[13,4,1000000,2],[499999,500000,null,null,null,0,0],[false,false,2]];
    f.validateBifrostCheckpoint(r);const lines=[],relay=createBifrostParentRelay(line=>{lines.push(line);return Promise.resolve();});g.forEach(relay.record);await relay.flush();groups.push(g);
    assert.ok(Math.max(...lines.map(l=>Buffer.byteLength(l)))<=768);assert.ok(Buffer.byteLength(lines.join(""))<=8192);
  });
  for(const [label,mutate]of [
    ["version",r=>r.worker[0]=2],["boolean count",r=>r.worker[1]=[true,0,0]],["overflow",r=>r.worker[1]=[1000001,0,0]],
    ["missing",r=>delete r.worker],["foreign case",r=>r.case=29],["disposition",r=>r.worker[4]=[false,false,4]],
    ["extra field",r=>r.worker.push(0)],["impossible pair",r=>r.worker=[1,[0,0,0],null,[1,1,true,true,true,2,2],null]],
  ])await run("strict residual schema "+label,()=>{const r=JSON.parse(JSON.stringify(groups[0][4]));mutate(r);assert.throws(()=>f.validateBifrostCheckpoint(r));});
  for(const [label,residual]of [
    ["read without failed read",[1,[1,0,0],[3,3,0,2],[0,0,null,null,null,0,0]]],
    ["observer without failed observer",[1,[1,0,0],[4,3,0,2],[0,0,null,null,null,0,0]]],
    ["other kind without residual operation",[1,[2,0,0],[13,3,0,2],[1,1,false,false,false,2,2]]],
    ["old maximum consumed by pair",[1,[1000000,1000000,1000000],[13,4,1000000,2],[499999,500001,null,null,null,0,0]]],
  ])for(const reverse of [false,true])await run("first-kind/count contradiction "+label+"/"+reverse,async()=>{
    assert.equal(f.validateBifrostWorkerResidual(residual),false);
    const g=JSON.parse(JSON.stringify(groups[0]));g[4].worker=[...residual,[false,false,1]];assert.throws(()=>f.validateBifrostCheckpoint(g[4]));
    const lines=[],relay=createBifrostParentRelay(line=>{lines.push(line);return Promise.resolve();});(reverse?[...g].reverse():g).forEach(relay.record);
    await assert.rejects(relay.flush());assert.equal(lines.length,0);
  });
  await run("first-kind/count positive boundaries preserve unknown kind",()=>{
    for(const residual of [
      [1,[1,0,0],[3,3,0,2],[1,0,null,null,null,0,0]],
      [1,[1,0,0],[4,3,0,2],[0,1,null,null,null,0,0]],
      [1,[3,0,0],[13,3,0,2],[1,1,false,false,false,2,2]],
      [1,[3,0,0],[0,0,0,0],[1,1,false,false,false,2,2]],
    ])assert.equal(f.validateBifrostWorkerResidual(residual),true);
  });
  await run("foreign pair links are observations not acceptance",()=>{
    const E={},P={},reader={},ops=[{kind:"read",state:"rejected",pending:P,reader,error:E},{kind:"read_observer",state:"rejected",originalRead:{},reader:{},error:{}}];
    const r=bifrostWorkerResidual({ops,sync:[],observerFailures:[]});assert.deepEqual(r[3],[1,1,false,false,false,0,0]);assert.equal(f.validateBifrostWorkerResidual(r),true);
  });
  await run("generated router captures after original failure collection",()=>{
    assert.ok(source.indexOf("residual=bifrostWorkerResidual(s)")>source.indexOf("failures.push(...s.sync,...s.observerFailures)"));
    assert.ok(source.includes("${bifrostWorkerResidual.toString()}"));
  });
  return {names,groups};
}
test("Bifrost progress residual observations preserve strict failures (inert)",async()=>{assert.ok((await bifrostResidualInertCases(assert,readFileSync(new URL("./openclaw-bifrost.test.mjs",import.meta.url),"utf8"))).names.length>=20);});

export async function bifrostDemandProducerInertCases(assert, source) {
 const names=[],run=async(name,fn)=>{await fn();names.push(name);};
 const outcome=async p=>{try{return {failed:false,value:await p};}catch(error){return {failed:true,error};}};
 const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
 const prefix='data: {"choices":[{"delta":{"content":"synthetic-prefix"},"finish_reason":null}]}\n\n';
 function harness(options={}){
  const request={},call={},s={id:"case",mode:"partial",calls:[call],held:0,canceled:0,expired:0,settled:0,completed:0};
  const owner=createBifrostProducerJoin(s,request,call),chunks=[],timers=[],cleared=[],errors=[];
  const controller={enqueue(value){if(chunks.length&&options.enqueueFailure)throw options.enqueueReason;chunks.push(Buffer.from(value));},error(error){errors.push(error);if(options.errorFailure)throw options.errorReason;},close(){assert.fail("producer must not close");}};
  const io={encode:value=>Buffer.from(value),setTimeout(callback,ms){assert.equal(ms,10000);if(options.timerFailure)throw options.timerReason;const timer={callback,ms};timers.push(timer);return timer;},clearTimeout(timer){cleared.push(timer);if(options.clearFailure)throw options.clearReason;}};
  const body={},response={body};owner.attach(response,body);
  const callbacks=createBifrostPartialProducer(s,request,owner,prefix,io);callbacks.start(controller);
  return {s,owner,request,call,chunks,timers,cleared,errors,controller,io,callbacks,pull:()=>callbacks.pull(controller),cancel:reason=>callbacks.cancel(reason),expire:()=>timers[0].callback()};
 }
 await run("unchanged prefix and one exact nonterminal comment per demanded pull",async()=>{const h=harness();assert.equal(h.chunks[0].toString(),prefix);assert.equal(h.timers.length,0);for(let i=0;i<3;i++){assert.equal(h.pull(),undefined);assert.equal(h.chunks.length,i+2);}assert.equal(h.timers.length,1);for(const b of h.chunks.slice(1)){assert.equal(b.length,1024);assert.equal(b.toString(),": "+"x".repeat(1020)+"\n\n");assert.doesNotMatch(b.toString(),/data:|DONE|usage|finish_reason/);}assert.equal(h.s.completed,0);h.cancel();await h.owner.drain();});
 await run("no pull means no progression or timer",async()=>{const h=harness();await Promise.resolve();await Promise.resolve();assert.equal(h.chunks.length,1);assert.equal(h.timers.length,0);h.cancel();await h.owner.drain();assert.equal(h.owner.observation().roles.length,0);assert.equal(h.s.settled,0);});
 await run("finite chunk byte budget holds the exact lifetime and remains fatal",async()=>{const h=harness();for(let i=0;i<64;i++)assert.equal(h.pull(),undefined);const original=h.s.producer;assert.equal(h.pull(),original);assert.equal(h.pull(),original);assert.equal(h.chunks.length,65);assert.equal(h.chunks.slice(1).reduce((n,b)=>n+b.length,0),65536);let done=false;const joined=outcome(h.owner.drain()).then(r=>{done=true;return r;});await Promise.resolve();assert.equal(done,false);let failed=false;try{h.cancel();}catch{failed=true;}assert.ok(failed);assert.equal((await joined).failed,true);assert.equal(h.s.completed,0);assert.equal(h.timers.length,1);assert.equal(h.cleared.length,1);});
 await run("cancel is the sole successful lifetime completion",async()=>{const h=harness();h.pull();const original=h.s.producer,observer=h.s.producerObserver;assert.equal(observer.original,original);assert.notEqual(observer.pending,original);assert.ok(Object.isFrozen(observer));let done=false;const joined=h.owner.drain().then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);h.cancel({});await joined;assert.equal(h.s.producer,original);assert.equal(h.s.canceled,1);assert.equal(h.s.expired,0);assert.equal(h.s.settled,1);assert.equal(h.s.held,0);assert.deepEqual(h.owner.observation().roles,[["producer","fulfilled",null]]);assert.throws(()=>h.cancel());assert.equal(h.cleared.length,1);});
 for(const reason of [undefined,{}])await run("cancel operand preserved without manufacturing a failure "+(reason===undefined?"undefined":"defined"),async()=>{const h=harness();h.pull();h.cancel(reason);await h.owner.drain();assert.equal(h.owner.observation().failures,0);});
 for(const reason of [undefined,{}])await run("cancel cleanup rejection retained "+(reason===undefined?"undefined":"defined"),async()=>{const h=harness({clearFailure:true,clearReason:reason});h.pull();let thrown=false;try{h.cancel();}catch(e){thrown=true;assert.equal(e,reason);}assert.ok(thrown);const result=await outcome(h.owner.drain());assert.ok(result.failed);assert.equal(result.error,reason);assert.equal(h.owner.observation().failures,1);assert.equal(h.cleared.length,1);});
 await run("unchanged first-pull deadline rejects original lifetime",async()=>{const h=harness();h.pull();const joined=outcome(h.owner.drain());h.expire();const r=await joined;assert.ok(r.failed);assert.equal(r.error,h.errors[0]);assert.equal(h.s.expired,1);assert.equal(h.s.canceled,0);assert.equal(h.s.settled,0);assert.equal(h.owner.observation().failures,1);assert.throws(()=>h.cancel());});
 for(const reason of [undefined,{}])await run("deadline and controller-error failures both survive "+(reason===undefined?"undefined":"defined"),async()=>{const h=harness({errorFailure:true,errorReason:reason});h.pull();const joined=outcome(h.owner.drain());h.expire();const r=await joined;assert.ok(r.failed);assert.deepEqual(r.error.errors,[h.errors[0],reason]);});
 for(const reason of [undefined,{}])await run("enqueue failure with independent cleanup rejection "+(reason===undefined?"undefined":"defined"),async()=>{const cleanup={},h=harness({enqueueFailure:true,enqueueReason:reason,clearFailure:true,clearReason:cleanup});let original;try{h.pull();}catch(e){original=e;}assert.deepEqual(original.errors,[reason,cleanup]);const r=await outcome(h.owner.drain());assert.ok(r.failed);assert.equal(r.error,original);assert.equal(h.s.canceled,0);assert.equal(h.s.settled,0);});
 for(const reason of [undefined,{}])await run("timer acquisition failure retains original reason "+(reason===undefined?"undefined":"defined"),async()=>{const h=harness({timerFailure:true,timerReason:reason});let caught=false;try{h.pull();}catch(e){caught=true;assert.equal(e,reason);}assert.ok(caught);const r=await outcome(h.owner.drain());assert.ok(r.failed);assert.equal(r.error,reason);assert.equal(h.cleared.length,0);});
 await run("foreign observer binding remains a fatal owner fault",async()=>{const h=harness();h.pull();h.s.producerObserver=Object.freeze({...h.s.producerObserver});h.cancel();assert.equal((await outcome(h.owner.drain())).failed,true);});
 await run("held immediate observer must join after original fulfillment",async()=>{const request={},call={},s={id:"case",mode:"partial",calls:[call],settled:0},owner=createBifrostProducerJoin(s,request,call),body={};owner.attach({body},body);const original=deferred(),tail=deferred();s.producer=original.promise;s.producerObserver=Object.freeze({original:original.promise,pending:original.promise.then(()=>tail.promise,()=>tail.promise)});owner.capture("producer",s.producer,request,s.producerObserver);let done=false;const joined=owner.drain().then(()=>{done=true;});original.resolve();await Promise.resolve();await Promise.resolve();assert.equal(done,false);tail.resolve();await joined;assert.equal(owner.observation().joined,true);});
 await run("observer rejection including undefined stays fatal once",async()=>{const request={},call={},s={id:"case",mode:"partial",calls:[call],settled:0},owner=createBifrostProducerJoin(s,request,call),body={};owner.attach({body},body);s.producer=Promise.resolve();s.producerObserver=Object.freeze({original:s.producer,pending:s.producer.then(()=>{throw undefined;})});owner.capture("producer",s.producer,request,s.producerObserver);for(let i=0;i<2;i++){const r=await outcome(owner.drain());assert.ok(r.failed);assert.equal(r.error,undefined);assert.equal(owner.observation().faults,1);assert.equal(owner.observation().undefinedFailures,1);}});
 await run("foreign original or request cannot acquire companion ownership",async()=>{for(const foreign of ["request","original"]){const h=harness(),p=Promise.resolve(),q=p.then(()=>{});h.s.producer=p;h.s.producerObserver=Object.freeze({original:foreign==="original"?Promise.resolve():p,pending:q});assert.throws(()=>h.owner.capture("producer",p,foreign==="request"?{}:h.request,h.s.producerObserver));await q;}});
 await run("actual registered partial branch uses the owned factory",async()=>{const marker=" if(s.mode==='partial'){",at=source.indexOf(marker,source.indexOf("const upstream =")),end=source.indexOf("\n }\n  const owner=createBifrostProducerJoin",at)+4;assert.ok(at>0);const branch=source.slice(at,end);assert.ok(branch.includes("createBifrostPartialProducer"));const h=harness();const state={id:"registered",mode:"partial",calls:[h.call],held:0,canceled:0,expired:0,settled:0,completed:0};let callbacks,constructed=0;class Stream {constructor(value){callbacks=value;constructed++;value.start(h.controller);}}class Response {constructor(body){this.body=body;}}class Encoder {encode(value){return Buffer.from(value);}}const response=new Function("s","request","call","prefix","createBifrostProducerJoin","createBifrostPartialProducer","ReadableStream","Response","TextEncoder","globalThis",branch)(state,h.request,h.call,prefix,createBifrostProducerJoin,createBifrostPartialProducer,Stream,Response,Encoder,{setTimeout:h.io.setTimeout,clearTimeout:h.io.clearTimeout});assert.equal(constructed,1);assert.equal(response.body,state.producerBody);assert.equal(state.producerRequest,h.request);assert.equal(callbacks.pull(h.controller),undefined);callbacks.cancel();await state.producerJoin.drain();assert.equal(state.settled,1);});
 return names;
}

// Exercise the actual generated module, with only inert controller/timer bindings.
// These receiver-sensitive fakes establish wiring, not workerd brand semantics.
export async function bifrostProducerSiteInertCases(assert, source) {
 const passed=[],run=async(name,body)=>{await body();passed.push(name);};
 const outcome=async operation=>{try{return {failed:false,value:await operation()};}catch(error){return {failed:true,error};}};
 const start=source.indexOf("const upstream = `"),end=source.indexOf("export async function startBifrostFixture(",start);
 assert.ok(start>=0&&end>start);
 const generated=new Function("requestBifrostProgress","performBifrostProgress","createBifrostProducerJoin","createBifrostPartialProducer","bifrostProducerProof",
  source.slice(start,end)+";return upstream;")(requestBifrostProgress,performBifrostProgress,createBifrostProducerJoin,createBifrostPartialProducer,bifrostProducerProof);
 async function harness(options={}) {
  const calls=[],chunks=[],clears=[],errors=[],handle={};let callbacks;
  const controller={enqueue(value){if(chunks.length&&options.enqueueFailure)throw options.reason;chunks.push(value);},error(value){errors.push(value);if(options.errorFailure)throw options.cleanup;},close(){assert.fail("unexpected EOF");}};
  class Stream {constructor(value){callbacks=value;value.start(controller);}}
  class Response {constructor(body,init){this.body=body;this.status=init?.status??200;}static json(value,init){return {value,status:init?.status??200};}}
  class URL {constructor(value){const m=/^https:\/\/([^/]+)(\/[^?]*)(\?.*)?$/.exec(value);assert.ok(m);this.hostname=m[1];this.origin="https://"+m[1];this.pathname=m[2];this.search=m[3]??"";}}
  class TextEncoder {encode(value){return Buffer.from(value);}}
  const fakes={set(args){calls.push(args);assert.equal(args.length,2);assert.equal(typeof args[0],"function");assert.equal(args[1],10000);if(options.timerFailure)throw options.reason;return handle;},
   clear(args){clears.push(args);assert.equal(args.length,1);assert.equal(args[0],handle);if(options.clearFailure)throw options.cleanup;}};
  const setup='globalThis.setTimeout=function(...args){assert.equal(this,globalThis,"original timer receiver");return fakes.set(args);};globalThis.clearTimeout=function(...args){assert.equal(this,globalThis,"original clear receiver");return fakes.clear(args);};';
  const worker=runInNewContext('"use strict";'+setup+generated.replace("export default ","const worker=")+";worker",
   {assert,fakes,ReadableStream:Stream,Response,URL,TextEncoder},{timeout:1000});
  await worker.fetch({url:"https://bifrost-control.fixture/setup/owned",json:async()=>({mode:"partial",models:["opaque"]})});
  const request={url:"https://gateway.fixture/openai/v1/chat/completions",method:"POST",headers:{get:()=>"Bearer synthetic-owner-owned"},json:async()=>({model:"opaque",stream:true})};
  const response=await worker.fetch(request);assert.ok(response.body instanceof Stream);
  return {calls,chunks,clears,errors,handle,callbacks,pull:()=>callbacks.pull(controller),cancel:()=>callbacks.cancel(),
   expire:()=>calls[0][0](),proof:()=>worker.fetch({url:"https://bifrost-control.fixture/proof/owned"})};
 }
 const site=proof=>Array.from(proof.value.producer.site??[]);
 await run("generated scope preserves timer receiver, exact arguments and handle",async()=>{
  const h=await harness();assert.equal(h.calls.length,0);assert.equal(h.pull(),undefined);assert.equal(h.pull(),undefined);assert.equal(h.calls.length,1);
  h.cancel();const proof=await h.proof();assert.equal(proof.status,200);assert.equal(h.clears.length,1);assert.deepEqual(site(proof),[0,2,2048,7,0,0]);
  assert.equal(proof.value.calls.length,1);assert.equal(proof.value.canceled,1);assert.equal(proof.value.expired,0);assert.equal(proof.value.settled,1);
  assert.equal(h.chunks.length,3);assert.ok(h.chunks[0].toString().startsWith("data: "));assert.equal(h.chunks[1].toString(),": "+"x".repeat(1020)+"\n\n");
 });
 for(const reason of [undefined,{}])await run("timer rejection identity and defined presence "+(reason===undefined?"undefined":"defined"),async()=>{
  const h=await harness({timerFailure:true,reason}),r=await outcome(h.pull);assert.equal(r.failed,true);assert.equal(r.error,reason);
  const proof=await h.proof();assert.equal(proof.status,500);assert.deepEqual(site(proof),[2,0,0,0,reason===undefined?5:7,0]);
  assert.equal(h.calls.length,1);assert.equal(h.clears.length,0);assert.equal(proof.value.expired,0);assert.equal(proof.value.canceled,0);
 });
 for(const reason of [undefined,{}])await run("enqueue rejection identity survives successful clear "+(reason===undefined?"undefined":"defined"),async()=>{
  const h=await harness({enqueueFailure:true,reason}),r=await outcome(h.pull);assert.equal(r.failed,true);assert.equal(r.error,reason);
  const proof=await h.proof();assert.equal(proof.status,500);assert.deepEqual(site(proof),[3,0,0,7,reason===undefined?5:7,0]);assert.equal(h.clears.length,1);
 });
 for(const same of [false,true])for(const reason of [undefined,{}])await run("separate original/cleanup identity "+same+":"+(reason===undefined?"undefined":"defined"),async()=>{
  const cleanup=same?reason:{},h=await harness({enqueueFailure:true,reason,clearFailure:true,cleanup}),r=await outcome(h.pull);
  assert.equal(r.failed,true);assert.equal(r.error.errors.length,2);assert.equal(r.error.errors[0],reason);assert.equal(r.error.errors[1],cleanup);
  const proof=await h.proof();assert.equal(proof.status,500);assert.deepEqual(site(proof),[3,0,0,3,reason===undefined?1:3,(cleanup===undefined?1:3)|(same?8:0)]);assert.equal(h.clears.length,1);
 });
 for(const cleanup of [undefined,{}])await run("sole cleanup reason remains original producer rejection "+(cleanup===undefined?"undefined":"defined"),async()=>{
  const h=await harness({clearFailure:true,cleanup});h.pull();const r=await outcome(h.cancel);assert.equal(r.failed,true);assert.equal(r.error,cleanup);
  const proof=await h.proof();assert.equal(proof.status,500);assert.deepEqual(site(proof),[6,1,1024,3,0,cleanup===undefined?5:7]);assert.equal(h.clears.length,1);
 });
 await run("unchanged deadline is fatal and has no clear retry",async()=>{
  const h=await harness();h.pull();h.expire();const proof=await h.proof();assert.equal(proof.status,500);assert.equal(proof.value.expired,1);assert.deepEqual(site(proof),[4,1,1024,9,7,0]);assert.equal(h.clears.length,0);
 });
 await run("cap holds original lifetime; later cancel cannot erase cap failure",async()=>{
  const h=await harness();for(let i=0;i<64;i++)h.pull();const original=h.pull();assert.equal(h.pull(),original);assert.equal(h.chunks.length,65);
  let done=false;const proof=h.proof().then(value=>{done=true;return value;});await Promise.resolve();assert.equal(done,false);const r=await outcome(h.cancel);assert.equal(r.failed,true);
  assert.deepEqual(site(await proof),[5,64,65536,7,7,0]);assert.equal(h.calls.length,1);assert.equal(h.clears.length,1);
 });
 await run("held original and already attached observer block site publication",async()=>{
  const request={},call={},s={id:"owned",mode:"partial",calls:[call]},owner=createBifrostProducerJoin(s,request,call),body={};owner.attach({body},body);
  let resolve,release,reads=0;const p=new Promise(yes=>{resolve=yes;}),tail=new Promise(yes=>{release=yes;});s.producer=p;s.producerObserver=Object.freeze({original:p,pending:p.then(()=>tail)});
  owner.capture("producer",p,request,s.producerObserver,()=>{reads++;return [0,0,0,0,0,0];});const joined=owner.drain();assert.equal(Object.hasOwn(owner.observation(),"site"),false);resolve();await Promise.resolve();assert.equal(reads,0);release();await joined;assert.equal(reads,1);owner.observation();await owner.drain();assert.equal(reads,1);
 });
 await run("undefined witness failure remains fatal and is not repeated",async()=>{
  const request={},call={},s={id:"owned",mode:"partial",calls:[call]},owner=createBifrostProducerJoin(s,request,call),body={};owner.attach({body},body);s.producer=Promise.resolve();let reads=0;
  owner.capture("producer",s.producer,request,undefined,()=>{reads++;throw undefined;});for(let i=0;i<2;i++){const r=await outcome(()=>owner.drain());assert.equal(r.failed,true);assert.equal(r.error,undefined);assert.equal(Object.hasOwn(owner.observation(),"site"),false);}assert.equal(reads,1);
 });
 await run("foreign ownership cannot publish a site or regain successful proof",async()=>{
  const request={},call={},s={id:"owned",mode:"partial",calls:[call]},owner=createBifrostProducerJoin(s,request,call),body={};owner.attach({body},body);s.producer=Promise.resolve();let reads=0;
  owner.capture("producer",s.producer,request,undefined,()=>{reads++;return [0,0,0,0,0,0];});s.producerRequest={};assert.equal((await outcome(()=>owner.drain())).failed,true);assert.equal(reads,0);assert.equal(Object.hasOwn(owner.observation(),"site"),false);
 });
 await run("actual generated router includes every source validator binding",async()=>{
  const from=source.indexOf("const router = `"),to=source.indexOf("const upstream = `",from);assert.ok(from>=0&&to>from);const routerSource=source.slice(from,to);
  assert.ok(routerSource.includes("${bifrostCheckpointFunctions().validateBifrostProducerSite.toString()}"));
  const {validateBifrostProducerSite,validateBifrostProducerObservation,validateBifrostSourceProof}=bifrostCheckpointFunctions();
  const validate=new Function([validateBifrostProducerSite,validateBifrostProducerObservation,validateBifrostSourceProof].map(fn=>fn.toString()).join("\n")+";return validateBifrostSourceProof;")();
  const h=await harness();h.pull();h.cancel();const proof=await h.proof();assert.equal(validate(proof.value,"owned"),true);
 });
 await run("strict site schema and partial-case membership retain legacy wire",async()=>{
  const {validateBifrostCheckpoint,validateBifrostProducerSite}=bifrostCheckpointFunctions();
  const base={v:1,pin:bifrostPin,lane:"sdk",case:2,evidence:true,complete:false,part:"postlude",control:Array(6).fill(null),validated:false,producer:[true,[[0,3,true]],0,1,0,0,0,0,0],router:null,usage:null};
  validateBifrostCheckpoint(base);base.producer.push([2,0,0,0,7,0]);validateBifrostCheckpoint(base);
  for(const value of [[7,0,0,0,7,0],[2,65,66560,0,7,0],[2,1,0,0,7,0],[2,0,0,16,7,0],[2,0,0,0,2,0],[6,0,0,0,0,8],[0,0,0,0,7,0]])assert.equal(validateBifrostProducerSite(value),false);
  for(const index of [2,6,12,13]){base.case=index;validateBifrostCheckpoint(base);}for(const index of [0,1,3,31]){base.case=index;assert.throws(()=>validateBifrostCheckpoint(base));}
 });
 return passed;
}

export function bifrostTransportWitnessInertCases(assert) {
 const {createBifrostTransportWitness,createBifrostFetchObserver}=bifrostNativeEvaluator(),passed=[];
 const run=(name,body)=>{body();passed.push(name);};
 function harness(options={}){
  const channels=new Map(),events=[],listeners=new Set(),owner={},request={},reason={},receiver={},args=[{},{}];let context,clock=0,calls=0;
  const storage={getStore:()=>context,run(token,fn){const old=context;context=token;try{return fn();}finally{context=old;}},disable(){events.push("disable");if(options.disableThrow)throw undefined;}};
  const channel=name=>{if(!channels.has(name))channels.set(name,{callbacks:new Set(),subscribe(cb){events.push("subscribe");this.callbacks.add(cb);if(options.subscribeThrow)throw undefined;},
   unsubscribe(cb){events.push("unsubscribe");this.callbacks.delete(cb);if(options.unsubscribeThrow)throw undefined;}});return channels.get(name);};
  const emit=(kind,value)=>{for(const callback of [...channel("undici:"+kind).callbacks])callback(value);};
  const socket={once(name,fn){assert.equal(name,"close");events.push("listen");listeners.add(fn);},removeListener(name,fn){assert.equal(name,"close");events.push("remove");listeners.delete(fn);if(options.removeThrow)throw undefined;}};
  const t={owner},original=options.promise??{},observerFailures=[];let fn;
  const witness=createBifrostTransportWitness({storage,channel,isProxy:types.isProxy,next(){if(options.nextThrow)throw undefined;return ++clock;},
   selected(value){if(options.selectedThrow)throw undefined;return value===t;},bound(value,f,r,a,settled){return value===t&&value.owner===owner&&f===fn&&r===receiver&&a===t.args&&(!settled||t.returned===original)&&!options.unbound;},
   reasons:()=>({callerPresent:true,caller:reason,readPresent:true,read:reason})});
  fn=function(...actual){calls++;assert.equal(this,receiver);assert.equal(actual.length,args.length);actual.forEach((v,i)=>assert.equal(v,args[i]));
   if(options.inside)options.inside({emit,request,socket,storage});else emit("request:create",{request});
   if(options.throwOriginal)throw options.originalReason;return options.returnUndefined?undefined:original;};
  const wrapped=createBifrostFetchObserver(fn,(r,a)=>{assert.equal(r,receiver);t.args=a;return {t,threw(e){t.threw=true;t.reason=e;},returned(p){t.returned=p;}};},observerFailures,
   (f,r,a,receipt)=>witness.fetch(receipt.t,f,r,a));
  witness.start();
  return {witness,t,request,socket,reason,original,events,channels,listeners,emit,storage,observerFailures,
   call:()=>Reflect.apply(wrapped,receiver,args),calls:()=>calls,
   sent:()=>emit("client:sendHeaders",{request,socket}),close:()=>{for(const callback of [...listeners]){listeners.delete(callback);Reflect.apply(callback,socket,[]);}},
   finish:()=>witness.finish()};
 }
 const bound=result=>!!(result.data[0]&1),closed=result=>!!(result.data[0]&2);
 run("original forwarding and complete ordered passive events",()=>{const h=harness();assert.equal(h.call(),h.original);h.sent();h.emit("request:headers",{request:h.request});h.emit("request:trailers",{request:h.request});h.emit("request:error",{request:h.request,error:h.reason});h.close();const r=h.finish();assert.ok(bound(r));assert.ok(closed(r));assert.equal(r.data[3][0],63);assert.deepEqual(Array.from(r.data[1]),[1,1,1,1,1,1,1,0]);assert.ok(r.data[2][3]<r.data[2][4]&&r.data[2][4]<r.data[2][6]&&r.data[2][6]<r.data[2][7]);assert.equal(h.calls(),1);assert.equal(h.events.filter(e=>e==="subscribe").length,5);assert.equal(h.events.filter(e=>e==="unsubscribe").length,5);assert.equal(h.listeners.size,0);assert.ok(Object.isFrozen(r.data)&&r.data.every(v=>typeof v==="number"||Object.isFrozen(v)));});
 run("headers error trailers and later close retain actual order",()=>{const h=harness();h.call();h.sent();h.emit("request:headers",{request:h.request});h.emit("request:error",{request:h.request,error:h.reason});h.emit("request:trailers",{request:h.request});h.close();const r=h.finish();assert.ok(bound(r));assert.ok(r.data[2][4]<r.data[2][3]&&r.data[2][3]<r.data[2][6]);});
 run("missing close is unknown without a wait",()=>{const h=harness();h.call();h.sent();const r=h.finish();assert.ok(bound(r));assert.equal(r.data[1][6],0);assert.equal(r.data[2][6],null);h.close();assert.equal(r.data[2][6],null);});
 run("duplicate errors retain count and first last order",()=>{const h=harness();h.call();h.sent();for(let i=0;i<3;i++)h.emit("request:error",{request:h.request,error:h.reason});const r=h.finish();assert.ok(bound(r));assert.equal(r.data[1][5],3);assert.ok(r.data[2][4]<r.data[2][5]);assert.equal(r.data[3][0],63);});
 run("different errors do not inherit equality",()=>{const h=harness();h.call();h.sent();h.emit("request:error",{request:h.request,error:h.reason});h.emit("request:error",{request:h.request,error:{}});assert.equal(h.finish().data[3][0],7);});
 run("explicit undefined error remains present",()=>{const h=harness();h.call();h.sent();h.emit("request:error",{request:h.request,error:undefined});const r=h.finish();assert.equal(r.data[3][0],9);assert.equal(r.data[3][1],1);});
 run("absent error field differs from undefined",()=>{const h=harness();h.call();h.sent();h.emit("request:error",{request:h.request});const r=h.finish();assert.equal(r.data[3][0],0);assert.equal(r.data[3][1],0);});
 run("error overflow invalidates attribution",()=>{const h=harness();h.call();h.sent();for(let i=0;i<17;i++)h.emit("request:error",{request:h.request,error:h.reason});const r=h.finish();assert.equal(bound(r),false);assert.ok(r.data[0]&4);assert.equal(r.data[1][5],16);assert.equal(r.data[1][7],1);assert.equal(r.failures.length,1);});
 run("foreign request and context cannot bind",()=>{const h=harness({inside:({emit,request,storage})=>storage.run({},()=>emit("request:create",{request}))});h.call();h.sent();assert.equal(bound(h.finish()),false);});
 run("concurrent foreign requests remain untouched",()=>{const h=harness();const foreign=()=>{};h.channels.get("undici:request:error").subscribe(foreign);h.call();h.sent();h.emit("request:create",{request:{}});h.emit("client:sendHeaders",{request:{},socket:{}});h.emit("request:error",{request:{},get error(){throw Error("not owned");}});const r=h.finish();assert.ok(bound(r));assert.equal(r.data[1][5],0);assert.ok(h.channels.get("undici:request:error").callbacks.has(foreign));});
 run("duplicate request creation invalidates",()=>{const h=harness({inside:({emit,request})=>{emit("request:create",{request});emit("request:create",{request});}});h.call();h.sent();assert.equal(bound(h.finish()),false);});
 run("send reassignment invalidates",()=>{const h=harness();h.call();h.sent();h.emit("client:sendHeaders",{request:h.request,socket:{}});assert.equal(bound(h.finish()),false);});
 for(const before of [true,false])run("foreign socket reuse "+(before?"before":"after"),()=>{const h=harness();if(before)h.emit("client:sendHeaders",{request:{},socket:h.socket});h.call();h.sent();if(!before)h.emit("client:sendHeaders",{request:{},socket:h.socket});assert.equal(bound(h.finish()),false);});
 run("replaced private owner invalidates at seal",()=>{const h=harness();h.call();h.sent();h.t.owner={};assert.equal(bound(h.finish()),false);});
 run("proxy message traps never run",()=>{let traps=0;const h=harness();h.call();h.sent();h.emit("request:error",new Proxy({},{get(){traps++;throw undefined;},getOwnPropertyDescriptor(){traps++;throw undefined;}}));assert.ok(bound(h.finish()));assert.equal(traps,0);});
 run("owned error accessor never runs and faults independently",()=>{let reads=0;const h=harness();h.call();h.sent();h.emit("request:error",{request:h.request,get error(){reads++;throw undefined;}});const r=h.finish();assert.equal(reads,0);assert.equal(bound(r),false);assert.equal(r.failures.length,1);});
 run("socket method accessor never runs",()=>{let reads=0;const h=harness();h.call();h.emit("client:sendHeaders",{request:h.request,socket:{get once(){reads++;throw undefined;}}});assert.equal(bound(h.finish()),false);assert.equal(reads,0);});
 run("callback throws undefined cannot escape",()=>{const h=harness({nextThrow:true});h.call();h.sent();const r=h.finish();assert.ok(r.failures.length>0);assert.ok(r.failures.every(e=>e===undefined));assert.equal(bound(r),false);});
 for(const reason of [undefined,{}])run("original synchronous throw preserved "+(reason===undefined?"undefined":"object"),()=>{const h=harness({throwOriginal:true,originalReason:reason});let threw=false;try{h.call();}catch(e){threw=true;assert.equal(e,reason);}assert.ok(threw);assert.equal(h.calls(),1);assert.equal(h.t.threw,true);assert.equal(h.t.reason,reason);h.finish();});
 run("original Promise identity and no extra observation",()=>{let thenReads=0;const original=Promise.resolve("inert");Object.defineProperty(original,"then",{get(){thenReads++;throw undefined;}});const h=harness({promise:original});assert.equal(h.call(),original);assert.equal(thenReads,0);h.sent();assert.ok(bound(h.finish()));});
 run("undefined original return unchanged",()=>{const h=harness({returnUndefined:true});assert.equal(h.call(),undefined);assert.equal(h.calls(),1);h.finish();});
 run("selected callback failure preserves original invocation",()=>{const h=harness({selectedThrow:true});assert.equal(h.call(),h.original);const r=h.finish();assert.equal(h.calls(),1);assert.equal(r.failures[0],undefined);});
 run("unbound original synchronous failure is never retried",()=>{const h=harness({unbound:true,throwOriginal:true});let thrown=false;try{h.call();}catch(e){thrown=true;assert.equal(e,undefined);}assert.ok(thrown);assert.equal(h.calls(),1);h.finish();});
 run("independent restoration undefined failures retained",()=>{const h=harness({unsubscribeThrow:true,removeThrow:true,disableThrow:true});h.call();h.sent();const r=h.finish();assert.equal(closed(r),false);assert.equal(r.restorationFailures.length,7);assert.ok(r.restorationFailures.every(e=>e===undefined));assert.equal(r.data[3][4],7);assert.equal(r.data[3][5],7);assert.equal(h.events.filter(e=>e==="unsubscribe").length,5);assert.equal(h.events.filter(e=>e==="remove").length,1);});
 run("partial registration is not a complete window",()=>{const h=harness({subscribeThrow:true});h.call();h.sent();const r=h.finish();assert.equal(bound(r),false);assert.equal(closed(r),false);assert.equal(r.failures.length,5);});
 run("late close before seal retained and repeated finish denied",()=>{const h=harness();h.call();h.sent();h.emit("request:error",{request:h.request,error:h.reason});h.close();const r=h.finish();assert.ok(r.data[2][6]>r.data[2][4]);assert.throws(()=>h.finish());});
 run("multiple fetch generations cannot become one binding",()=>{const h=harness();h.call();h.call();h.sent();assert.equal(bound(h.finish()),false);assert.equal(h.calls(),2);});
 run("five part protocol and maximum width stay within original quotas",()=>{
  const {validateBifrostEvidence,bifrostPostludeEvidence}=bifrostCheckpointFunctions();
  const base={v:1,pin:bifrostPin,lane:"sdk",case:2,evidence:true,complete:false,part:"postlude"};
  const legacy={...base,...bifrostPostludeEvidence(undefined,undefined)};validateBifrostEvidence(legacy);
  const record={...legacy,transport:[4,Array(8).fill(16),Array(8).fill(1000000),[63,16,16,16,7,7]]};
  record.control=Array.from({length:6},()=>[3,false,1000000,1000000,1000000]);record.validated=true;
  record.producer=[false,Array.from({length:4},(_,i)=>[i,3,false]),...Array(7).fill(1000000)];
  record.router=Array.from({length:4},()=>[3,false]);record.usage=[true,1000000,1000000];
  validateBifrostEvidence(record);const lines=[];bifrostAnnotationEmitter(line=>lines.push(line))(record);assert.ok(Buffer.byteLength(lines[0])<=768);
  assert.equal(JSON.stringify(legacy).includes("transport"),false);
  const f=bifrostCheckpointFunctions(),group=f.bifrostCaseEvidence(2,{transports:[],acquisitions:[],originals:[],caller:{},failures:[],syncFailures:[],observerFailures:[],evidenceRestoreFailures:0,evidenceRestoreUndefined:0},undefined,false,[]);
  group[4]=record;const wire=[],reporter=f.createBifrostCheckpointReporter("sdk",r=>wire.push(r),true);reporter.evidence(group);
  for(const phase of ["body","worker_retirement","restoration"])reporter.mark(2,phase,"rejected",undefined);
  reporter.flush(2);reporter.finish();assert.equal(reporter.failures.length,0);assert.equal(wire.length,9);
  assert.ok(wire.reduce((n,r)=>n+Buffer.byteLength("BIFROST_CHECKPOINT "+JSON.stringify(r)+"\n"),0)<=4096);
  const emitted=[];const emit=bifrostAnnotationEmitter(line=>emitted.push(line));wire.forEach(emit);assert.ok(emitted.every(line=>Buffer.byteLength(line)<=768));assert.ok(emitted.reduce((n,line)=>n+Buffer.byteLength(line),0)<=8192);
  const error={stdout:wire.map(r=>"BIFROST_CHECKPOINT "+JSON.stringify(r)).join("\n")};assert.equal(bifrostCheckpointRecords(error).filter(r=>r.evidence).length,5);
  for(const mutate of [r=>r.case=3,r=>r.transport[1][0]=true,r=>r.transport[1][0]=17,r=>r.transport[2][0]=0,r=>r.transport[3][0]=64,r=>r.transport.push(0),r=>r.transport[0]=3]){
   const bad=JSON.parse(JSON.stringify(record));mutate(bad);assert.throws(()=>validateBifrostEvidence(bad));
  }
 });
 return passed;
}

export async function bifrostDirectRouterInertCases(assert) {
  const source = readFileSync(new URL("./openclaw-bifrost.test.mjs", import.meta.url), "utf8");
  const helper = readFileSync(new URL("./helpers/workerd.mjs", import.meta.url), "utf8");
  const between = (text, start, end) => {
    const begin = "\n" + start, finish = "\n" + end;
    assert.equal(text.split(begin).length, 2); assert.equal(text.split(finish).length, 2);
    return text.slice(text.indexOf(begin) + 1, text.indexOf(finish)).replace(/^export /gm, "");
  };
  const fixture = between(source, "export async function startBifrostFixture(", "export function assertBifrostRetired(");
  const finish = between(source, "export async function finishBifrostOwned(", "export function createBifrostProducerJoin(");
  const helperBody = helper.slice(helper.indexOf("export function workerdRequestContext(")).replace(/^export /gm, "");
  const cases = [];
  for (const hotCache of [false, true]) {
    const calls = [], requests = [], tickets = new Map(); let configured, instance;
    const direct = Object.freeze({origin:"http://router.fixture:1234"});
    class Runtime {
      constructor(options) { configured = options; instance = this; calls.push("construct"); }
      get ready() { calls.push("ready"); return Promise.resolve({origin:"http://bridge.fixture:5678"}); }
      unsafeGetDirectURL(...args) { assert.equal(this, instance); assert.deepEqual(args, ["router"]); calls.push("direct"); return Promise.resolve(direct); }
      dispose() { assert.equal(this, instance); calls.push("dispose"); }
    }
    const fetch = () => { throw Error("unexpected native fetch"); };
    const control = async (owner, fn, receiver, args, method, observe, ticket) => {
      assert.equal(fn, fetch); assert.equal(receiver, undefined); assert.equal(method, "text");
      requests.push({owner, url:args[0], init:args[1]});
      const result = {response:{status:200},value:"{}"}; if (ticket) tickets.set(ticket, {...result,owner,parsed:{owner:owner.id}}); return result;
    };
    control.capture = owner => Object.freeze({owner});
    control.parse = ticket => tickets.get(ticket).parsed;
    control.validate = (ticket, validate) => { const entry=tickets.get(ticket); entry.validated=true; return validate(entry.parsed); };
    control.verdict = (ticket, check) => { const entry=tickets.get(ticket); check(entry.response,entry.parsed); };
    control.inspect = ticket => ({...tickets.get(ticket), id:ticket.owner.id});
    const context = {
      assert, router:"original-router", upstream:"original-upstream", deploymentRuntime:{compatibility_date:"fixture",compatibility_flags:[]},
      build:async options=>{calls.push("build");assert.equal(options.stdin.contents,"original-router");return {outputFiles:[{text:"bundled-router"}]};},
      convertV4MiniflareOptions:options=>options, Miniflare:Runtime, process:{cwd:()=>"/fixture-root"},
      mkdtemp:async prefix=>{assert.equal(prefix,"/fixture-root/bifrost-contract-");calls.push("directory");return "/fixture-root/owned";},
      tmpdir:()=>"/fixture-root", join:(...parts)=>parts.join("/"), rm:async(path,options)=>{assert.equal(path,"/fixture-root/owned");assert.equal(options.recursive,true);assert.equal(options.force,true);calls.push("rm");},
      createBifrostControlReader:()=>control, bifrostCheckpointFunctions:()=>({validateBifrostRetirementProof:value=>value}), fetch,
    };
    const start = runInNewContext(helperBody+"\n"+finish+"\n"+fixture+"\nstartBifrostFixture", context, {timeout:1000});
    const f = await start({hotCache});
    assert.equal(f.runtime,instance);assert.equal(f.origin,direct.origin);
    assert.deepEqual(calls,["directory","build","construct","ready","direct"]);
    assert.equal(configured.workers.length,2);const [router,upstream]=configured.workers;
    assert.equal(router.name,"router");assert.equal(router.script,"bundled-router");assert.equal(router.outboundService,"upstream");
    assert.deepEqual(JSON.parse(JSON.stringify(router.unsafeDirectSockets)),[{host:"127.0.0.1",port:0}]);
    assert.equal(upstream.name,"upstream");assert.equal(upstream.script,"original-upstream");assert.equal(upstream.unsafeDirectSockets,undefined);
    assert.equal(router.bindings.BIFROST_BASE_URL,"https://gateway.fixture/openai/v1");
    assert.equal(router.bindings.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS,hotCache?undefined:"0");
    const row={id:"owned-case"};await f.setup(row);await f.mutate(row.id,"rotation");await f.state(row.id);
    const proof=await f.join(row.id);assert.equal(f.joinEvidence(row.id),proof);
    assert.deepEqual(requests.map(r=>r.url),["/__bifrost/setup","/__bifrost/mutate/owned-case","/__bifrost/state/owned-case","/__bifrost/join/owned-case"].map(path=>direct.origin+path));
    assert.ok(requests.every(r=>r.init.method==="POST"));assert.deepEqual(requests.map(r=>r.init.body),[JSON.stringify(row),'{"kind":"rotation"}',"{}","{}"]);
    await assert.rejects(f.join(row.id));assert.equal(requests.length,4);
    await f.close();assert.deepEqual(calls.slice(-2),["dispose","rm"]);cases.push(hotCache?"hot-cache":"default-cache");
    for (const reason of [undefined, Object.freeze({failure:"direct-url"})]) {
      calls.length=0;Runtime.prototype.unsafeGetDirectURL=function(...args){assert.equal(this,instance);assert.deepEqual(args,["router"]);calls.push("direct");return Promise.reject(reason);};
      let rejected=false;try{await start({hotCache});}catch(error){rejected=true;assert.equal(error,reason);}
      assert.equal(rejected,true);assert.deepEqual(calls,["directory","build","construct","ready","direct","dispose","rm"]);cases.push("direct-failure");
    }
  }
  return cases;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  test("Bifrost SDK and controls share the owned direct router (inert)", async () => { assert.equal((await bifrostDirectRouterInertCases(assert)).length, 6); });
 test("Bifrost original producer, observer and control retirement (inert)", async () => {
  const cases = await bifrostRetirementInertCases(assert); assert.ok(cases.length >= 30);
 });
 test("Bifrost bounded partial producer keeps original cancellation ownership (inert)",async()=>{assert.equal((await bifrostDemandProducerInertCases(assert,readFileSync(new URL("./openclaw-bifrost.test.mjs",import.meta.url),"utf8"))).length,20);});
 test("Bifrost generated timer wiring and joined producer sites (inert)",async()=>{assert.equal((await bifrostProducerSiteInertCases(assert,readFileSync(new URL("./openclaw-bifrost.test.mjs",import.meta.url),"utf8"))).length,18);});
 test("Bifrost passive transport witness preserves original calls and event identity (inert)",()=>{assert.equal(bifrostTransportWitnessInertCases(assert).length,30);});
 test("Bifrost failed retirement observations preserve original failures (inert)",async()=>{assert.equal((await bifrostFailureObservationInertCases(assert)).length,15);});
 test("Bifrost checkpoint preserves original invocation, promise and undefined rejection",async()=>{
  const records=[],r=bifrostCheckpointFunctions().createBifrostCheckpointReporter("sdk",v=>records.push(v)),receiver={},args=[{},undefined];
  let calls=0,reject;const original=new Promise((_,no)=>{reject=no;});
  function operation(...got){calls++;assert.equal(this,receiver);assert.deepEqual(got,args);return original;}
  assert.equal(r.observe(0,"body",operation,receiver,args),original);reject(undefined);await r.drain();
  assert.equal(calls,1);assert.ok(records.some(v=>v.phase==="body"&&v.state==="rejected"&&v.defined===false));
  let threw=false;try{r.observe(1,"setup",()=>{throw undefined;},undefined,[]);}catch(e){threw=true;assert.equal(e,undefined);}
  assert.equal(threw,true);r.finish();assert.equal(r.failures.length,0);
 });
 test("Bifrost checkpoint startup failure still finalizes and attempts every cleanup",async()=>{
  const records=[],order=[],secondary={};
  await assert.rejects(runBifrostReported(report=>report.observe(null,"setup",()=>{throw undefined;},undefined,[]),[
   report=>report.observe(null,"cleanup",()=>{order.push(1);throw secondary;},undefined,[]),
   ()=>{order.push(2);}
  ],v=>records.push(v)),e=>e instanceof AggregateError&&e.errors[0]===undefined&&e.errors[1]===secondary);
  assert.deepEqual(order,[1,2]);assert.ok(records.some(v=>v.phase==="setup"&&v.state==="threw"&&!v.defined));
  assert.ok(records.some(v=>v.phase==="cleanup"&&v.state==="threw"&&v.defined));assert.equal(records.at(-1).phase,"final");
 });
 test("Bifrost checkpoint retains original read closed and independent cleanup faults",async()=>{
  const records=[],r=bifrostCheckpointFunctions().createBifrostCheckpointReporter("sdk",v=>records.push(v));
  const data={},cleanup={};r.mark(2,"read","rejected",data,0,1);r.mark(2,"closed","rejected",data,0,2);
  r.observe(2,"cleanup",()=>Promise.reject(cleanup),undefined,[]);await r.drain();r.mark(2,"cleanup","fulfilled");r.flush(2);r.finish();
  for(const phase of ["read","closed","cleanup"])assert.ok(records.some(v=>v.phase===phase&&v.state==="rejected"&&v.defined));
  assert.equal(records.at(-1).phase,"final");assert.equal(r.failures.length,0);
 });
 test("Bifrost checkpoint reporting faults never replace undefined primary",async()=>{
  let writes=0;
  await assert.rejects(runBifrostReported(()=>{throw undefined;},[()=>{}],()=>{writes++;throw undefined;}),e=>
   e instanceof AggregateError&&e.errors[0]===undefined&&e.errors[1] instanceof AggregateError&&e.errors[1].errors.every(v=>v===undefined));
  assert.ok(writes>0);
 });
 test("Bifrost checkpoint observer fault preserves original return and is joined separately",async()=>{
  const records=[],r=bifrostCheckpointFunctions().createBifrostCheckpointReporter("sdk",v=>records.push(v));
  const original={};Object.defineProperty(original,"then",{get(){throw undefined;}});
  assert.equal(r.observe(0,"case_result",()=>original,undefined,[]),original);await r.drain();r.finish();
  assert.equal(r.failures.length,1);assert.equal(r.failures[0],undefined);assert.equal(records.at(-1).phase,"final");
 });
 test("Bifrost checkpoint case finalization never joins its own completion observer",async()=>{
  const {createBifrostCheckpointReporter,finishBifrostCheckpointCase}=bifrostCheckpointFunctions(),records=[];
  const report=createBifrostCheckpointReporter("sdk",r=>records.push(r));let finalized=false;
  const original=Promise.resolve().then(()=>{
   assert.equal(finishBifrostCheckpointCase(report,0,[]),undefined);finalized=true;
  });
  assert.equal(report.observe(0,"case_result",()=>original,undefined,[]),original);
  await original;assert.equal(finalized,true);await report.drain();report.finish();assert.equal(report.failures.length,0);
  const second=createBifrostCheckpointReporter("sdk",r=>records.push(r));
  const rejected=Promise.resolve().then(()=>{finishBifrostCheckpointCase(second,1,[undefined]);throw undefined;});
  assert.equal(second.observe(1,"case_result",()=>rejected,undefined,[]),rejected);
  let caught=false;try{await rejected;}catch(reason){caught=true;assert.equal(reason,undefined);}assert.equal(caught,true);
  await second.drain();second.finish();assert.ok(records.some(r=>r.case===1&&r.phase==="assertions"&&r.defined===false));
  const source=readFileSync(new URL("./fixtures/openclaw-bifrost-contract.test.ts",import.meta.url),"utf8");
  assert.doesNotMatch(source.slice(source.indexOf('async function fixtureOwned('),source.indexOf('function inference(')),/checkpoints\.drain\(/);
 });
 test("Bifrost checkpoint bounded overflow reserves final summary and rejects unsafe fields",async()=>{
  const {createBifrostCheckpointReporter,validateBifrostCheckpoint}=bifrostCheckpointFunctions(),records=[];
  const r=createBifrostCheckpointReporter("sdk",v=>records.push(v));
  for(let i=0;i<32;i++){r.mark(i,"body","rejected",{});r.flush(i);}r.finish();
  assert.equal(records.length,9);assert.equal(records.at(-2).phase,"overflow");assert.equal(records.at(-2).count,25);assert.equal(records.at(-1).phase,"final");
  const commands=[],emit=bifrostAnnotationEmitter(v=>commands.push(v));for(const record of records)emit(record);
  assert.ok(commands.every(v=>Buffer.byteLength(v)<=768));assert.ok(Buffer.byteLength(commands.join(""))<8192);
  for(const change of [{pin:"foreign"},{case:32},{phase:"unknown_module_name"},{op:-1},{acq:4096},{defined:null},{message:"private"}])
   assert.throws(()=>validateBifrostCheckpoint({...records[0],...change}));
 });
 test("Bifrost checkpoint collector preserves child plus cleanup closure without getters",async()=>{
  const records=[],r=bifrostCheckpointFunctions().createBifrostCheckpointReporter("sdk",v=>records.push(v));r.mark(0,"setup","threw",undefined);r.flush(0);r.finish();
  const child=Object.assign(new Error("not forwarded"),{stdout:records.map(v=>"BIFROST_CHECKPOINT "+JSON.stringify(v)).join("\n")});
  const outer=new AggregateError([child,undefined],"not forwarded");Object.defineProperty(outer,"cause",{value:outer});let getters=0;
  Object.defineProperty(outer,"stderr",{get(){getters++;throw Error("not called");}});
  const emitted=[];await assert.rejects(withBifrostNativeDiagnostics(()=>{throw outer;},v=>emitted.push(v)),e=>e===outer);
  assert.deepEqual(emitted,JSON.parse(JSON.stringify(records)));assert.equal(getters,0);
  assert.throws(()=>bifrostCheckpointRecords({stdout:"BIFROST_CHECKPOINT "+JSON.stringify({...records[0],unknown:true})}));
  assert.deepEqual(bifrostCheckpointRecords({stdout:"untrusted text\n# BIFROST_CHECKPOINT {}"}),[]);
 });
 test("Bifrost checkpoint observes real child import rejection with column-zero protocol",async()=>{
  const {bifrostSetupPhase,createBifrostCheckpointReporter,validateBifrostCheckpoint}=bifrostCheckpointFunctions();
  const code=bifrostSetupPhase.toString()+"\n"+validateBifrostCheckpoint.toString()+"\n"+createBifrostCheckpointReporter.toString()+`
const r=createBifrostCheckpointReporter("sdk",v=>process.stdout.write("BIFROST_CHECKPOINT "+JSON.stringify(v)+"\\n"));
try{await r.observe(null,"setup",()=>import("node:missing_bifrost_diagnostic_module"),undefined,[]);}
catch{process.exitCode=1;}finally{await r.drain();r.finish();}`;
  let child;try{await promisify(execFile)(process.execPath,["--input-type=module","-e",code],{timeout:10000,maxBuffer:16384});}catch(error){child=error;}
  assert.ok(child);const records=bifrostCheckpointRecords(child);
  assert.ok(records.some(v=>v.phase==="setup"&&v.state==="rejected"&&v.defined));assert.equal(records.at(-1).phase,"final");
  assert.ok(child.stdout.split("\n").filter(Boolean).every(line=>line.startsWith("BIFROST_CHECKPOINT ")));
  const emitted=[];await assert.rejects(withBifrostNativeDiagnostics(()=>Promise.reject(child),v=>emitted.push(v)),e=>e===child);
  assert.deepEqual(emitted,records);
 });
 test("Bifrost checkpoint missing child protocol distinguishes helper boundary from SDK entry",async()=>{
  const emitted=[],reason={};
  await assert.rejects(runBifrostReported(report=>withBifrostNativeDiagnostics(()=>report.observe(null,"child",()=>Promise.reject(reason),undefined,[]),v=>emitted.push(v)),[],v=>emitted.push(v)),e=>e===reason);
  assert.ok(emitted.some(v=>v.lane==="outer"&&v.phase==="child"&&v.state==="rejected"));
  assert.equal(emitted.some(v=>v.lane==="sdk"),false);assert.equal(emitted.at(-1).phase,"final");
 });
 test("Bifrost setup boundary reports each fixed stage without inspecting the reason",()=>{
  const {createBifrostCheckpointReporter,createBifrostSetupBoundary,validateBifrostCheckpoint}=bifrostCheckpointFunctions();
  const stages=["caller_install","progress_subscribe","source_env_pin","source_git_pin","poison_env","fetch_hook","undici_hook","guard_hook","guard_descriptor","profile_write","discovery_env","api_key_resolver","auth_resolver","discovery_auth_check","inference_auth_check","facade_load","plugin_register","plugin_id_check","catalog_check"];
  let getters=0;const reason=Object.create(null);
  for(const key of ["name","message","stack","then"])Object.defineProperty(reason,key,{get(){getters++;throw undefined;}});
  for(const [index,phase] of stages.entries())for(const error of [reason,undefined]){
   const records=[],report=createBifrostCheckpointReporter("sdk",r=>records.push(r));
   const boundary=createBifrostSetupBoundary(report,index);boundary.enter(phase);assert.equal(records.length,0);
   boundary.reject(error);report.flush(index);report.finish();
   assert.equal(records[0].case,index);assert.equal(records[0].phase,phase);assert.equal(records[0].state,"rejected");
   assert.equal(records[0].defined,error!==undefined);assert.equal(report.failures.length,0);
   for(const invalid of [{lane:"outer"},{case:null},{state:"fulfilled",defined:null},{acq:0},{op:0},{count:1}])
    assert.throws(()=>validateBifrostCheckpoint({...records[0],...invalid}));
  }
  assert.equal(getters,0);
 });
 test("Bifrost setup boundary preserves case ownership and rejects absent or unknown phases",()=>{
  const {createBifrostCheckpointReporter,createBifrostSetupBoundary}=bifrostCheckpointFunctions(),records=[];
  const report=createBifrostCheckpointReporter("sdk",r=>records.push(r));
  const a=createBifrostSetupBoundary(report,0),b=createBifrostSetupBoundary(report,1);
  a.enter("profile_write");b.enter("guard_hook");b.reject(undefined);a.reject({});report.flush(0);report.flush(1);
  assert.deepEqual(records.map(r=>[r.case,r.phase,r.defined]),[[0,"profile_write",true],[1,"guard_hook",false]]);
  const c=createBifrostSetupBoundary(report,2);c.reject({});c.enter("profile_write");c.enter("untrusted_phase");c.reject({});
  report.flush(2);assert.equal(report.failures.length,3);assert.equal(records.length,2);
 });
 test("Bifrost setup boundary retains first failure phase within the existing child and step quotas",()=>{
  const {createBifrostCheckpointReporter,createBifrostSetupBoundary,finishBifrostCheckpointCase}=bifrostCheckpointFunctions(),records=[];
  const report=createBifrostCheckpointReporter("sdk",r=>records.push(r));
  report.mark(null,"module","fulfilled");report.flush(null);
  report.mark(0,"setup","fulfilled");report.mark(0,"case_result","enter");
  const boundary=createBifrostSetupBoundary(report,0);boundary.enter("facade_load");boundary.reject(undefined);
  report.mark(0,"case_setup","rejected",undefined);report.mark(0,"original_join","fulfilled");
  report.mark(0,"worker_retirement","rejected",{});report.mark(0,"restoration","rejected",undefined);report.mark(0,"cleanup","rejected",{});
  finishBifrostCheckpointCase(report,0,[undefined]);report.mark(0,"case_result","rejected",undefined);report.flush(0);report.finish();
  assert.ok(records.some(r=>r.case===0&&r.phase==="facade_load"&&r.state==="rejected"&&!r.defined));
  assert.equal(records.length,9);assert.equal(records.at(-2).phase,"overflow");assert.ok(records.at(-2).count>0);assert.equal(records.at(-1).phase,"final");
  const decoded=bifrostCheckpointRecords({stdout:records.map(r=>"BIFROST_CHECKPOINT "+JSON.stringify(r)).join("\n")});
  const lines=[],emit=bifrostAnnotationEmitter(line=>lines.push(line));for(const record of decoded)emit(record);
  assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
 });
 test("Bifrost setup boundary never replaces primary or independent cleanup and reporting failures",async()=>{
  const {createBifrostCheckpointReporter,createBifrostSetupBoundary}=bifrostCheckpointFunctions();
  const primary={},cleanup={},reporting={};let caught=false,cleanupRan=false;
  const report=createBifrostCheckpointReporter("sdk",()=>{throw reporting;});
  const boundary=createBifrostSetupBoundary(report,0);boundary.enter("profile_write");
  try{await finishBifrostOwned(()=>{try{throw primary;}catch(reason){boundary.reject(reason);throw reason;}},[
   ()=>{cleanupRan=true;throw cleanup;},
   ()=>{report.flush(0);report.finish();if(report.failures.length)throw new AggregateError(report.failures,"reporting failed");}
  ]);}catch(error){caught=true;assert.equal(error.errors[0],primary);assert.equal(error.errors[1],cleanup);assert.ok(error.errors[2].errors.every(e=>e===reporting));}
  assert.equal(caught,true);assert.equal(cleanupRan,true);
  let undefinedCaught=false;
  try{await finishBifrostOwned(()=>{boundary.reject(undefined);throw undefined;},[()=>{throw undefined;}]);}
  catch(error){undefinedCaught=true;assert.deepEqual(error.errors,[undefined,undefined]);}
  assert.equal(undefinedCaught,true);
 });
 const evaluator=bifrostNativeEvaluator();
 function unitNativeIdentity(){return Object.freeze({pin:bifrostPin,node:process.version,platform:process.platform,arch:process.arch,undici:"unit-only",guard:()=>{},fetch:()=>{}});}
 // Synthetic records exercise the actual pure predicate; they are never SDK qualification.
 function nativeEvidence(role="partial",identity=unitNativeIdentity(),abortReason=undefined){
  const f=bifrostCheckpointFunctions(),owner={},controller=new AbortController(),inputController=new AbortController(),effectiveController=new AbortController();
  const caller={owner,signal:controller.signal,reason:abortReason,abortCalled:false,abortedAfter:false,noEarlierFailure:true,delivered:7,abortInvoke:8,abortObserved:9,abortReturn:10,result:"aborted"};
  const original=(kind,details={})=>{const pending=Promise.resolve();return {kind,owner,pending,returned:pending,state:"fulfilled",invoke:1,returnAt:2,settle:3,...details};};
  const input={signal:inputController.signal},body={locked:false},response={body},acquisition={owner,guard:identity.guard,input,inputSignal:input.signal,response,result:{response},operation:original("guard"),signalHistory:{abort:9}};acquisition.pending=acquisition.operation.pending;
  const transport={owner,method:"POST",signal:effectiveController.signal,signalHistory:{abort:9},acquisition,response,bodies:[body],readers:[],guardObserved:true,releases:1,releaseDone:true,fetch:original("fetch")};acquisition.transport=transport;
  const reader={owner,original:{},body,transport,closed:Promise.resolve(),acquired:2,unlocks:1,unlockFailed:false,unlockAt:17};reader.unlockReceiver=reader.original;transport.readers.push(reader);
  const common={reader,receiver:reader.original,callerSignal:caller.signal,effectiveSignal:transport.signal};
  const read=original("read",{...common,state:"pending",invoke:6,settle:19,callerAbortedAtInvoke:false,callerAbortedAtSettle:true,effectiveAbortedAtSettle:true});
  const closed=original("closed",{...common,state:"pending",pending:reader.closed,returned:reader.closed,invoke:3,settle:18});
  const cancel=original("cancel",{...common,state:"pending",args:[undefined],invoke:12,returnAt:13,settle:20});
  const prefix=original("read",{...common,value:{done:false,value:new Uint8Array([1])},settle:5});
  const release=original("guard_release",{acquisition,receiver:undefined,args:[],invoke:21,returnAt:22,settle:23});transport.release=release;caller.pending=[read];
  const unlock=original("unlock",{...common,pending:undefined,returned:undefined,invoke:14,returnAt:15,settle:16});
  const getBody={locked:false},getResponse={body:getBody},getAcquisition={owner,guard:identity.guard,input:{signal:caller.signal},inputSignal:caller.signal,response:getResponse,result:{response:getResponse},operation:original("guard")};getAcquisition.pending=getAcquisition.operation.pending;
  const getTransport={owner,method:"GET",response:getResponse,acquisition:getAcquisition,guardObserved:true,bodies:[getBody],readers:[],releases:1,releaseDone:true,release:original("guard_release"),fetch:original("fetch")};getAcquisition.transport=getTransport;
  const getReader={owner,original:{},body:getBody,transport:getTransport,unlocks:1,unlockFailed:false,unlockAt:4,closed:Promise.resolve()};getReader.unlockReceiver=getReader.original;getTransport.readers=[getReader];
  const getClosed=original("closed",{reader:getReader,pending:getReader.closed,returned:getReader.closed,invoke:2,settle:3});
  function bind(t){const kind=t.method==="POST"?"inference":"discovery",args=kind==="inference"?[{}, {}, {signal:caller.signal}]:[{signal:caller.signal}];
   const invocation=Object.freeze({owner,caller,signal:caller.signal,kind,fn:()=>{},receiver:undefined,args:Object.freeze(args)}),a=t.acquisition;
   a.invocation=invocation;a.context=Object.freeze({invocation,acquisition:a});t.invocation=invocation;t.context=a.context;t.caller=caller;}
  bind(transport);bind(getTransport);
  const w={owner,identity,provider:"bifrost",api:"stream",role,caller,transports:[transport,getTransport],acquisitions:[acquisition,getAcquisition],originals:[prefix,read,closed,cancel,release,getClosed,unlock],failures:[],observerFailures:[],syncFailures:[],reportingFailures:[],restored:true,sourceExpired:0,evidenceJoined:true};
  for(const o of [read,closed,prefix])o.evidenceInvoke=f.bifrostOperationEvidence(o,w.originals);
  if(role==="partial"||role==="preabort"){
   controller.abort(abortReason);inputController.abort(controller.signal.reason);effectiveController.abort(controller.signal.reason);caller.abortCalled=true;caller.abortedAfter=true;
  }
  cancel.evidenceInvoke=f.bifrostOperationEvidence(cancel,w.originals);
  for(const o of [read,closed,cancel]){o.state=role==="partial"?"rejected":"fulfilled";if(role==="partial")o.reason=controller.signal.reason;o.evidenceSettle=f.bifrostOperationEvidence(o,w.originals);}
  caller.result=role==="partial"?"aborted":role==="eof"?"stop":"error";caller.emptyContent=role==="preabort";
  if(role==="preabort"){w.transports=[getTransport];w.acquisitions=[getAcquisition];w.originals=[getClosed];w.preabortPostDelta=0;}
  return w;
 }
 function reasonEvidence(){
  const f=bifrostCheckpointFunctions(),w=nativeEvidence(),controller=new AbortController();
  w.caller.signal=controller.signal;w.caller.reason={};w.caller.abortArgumentCount=1;controller.abort(w.caller.reason);w.caller.evidenceAbort=f.bifrostSignalEvidence(controller.signal);
  w.acquisitions=w.transports.map(t=>t.acquisition);w.evidenceJoined=true;w.evidenceRestoreFailures=0;w.evidenceRestoreUndefined=0;
  for(const t of w.transports){
   const input=new AbortController(),effective=new AbortController();input.abort({});effective.abort({});
   t.acquisition.input={signal:input.signal};t.acquisition.inputSignal=input.signal;t.signal=effective.signal;
   const i=t.invocation,args=i.kind==="inference"?[{}, {}, {signal:controller.signal}]:[{signal:controller.signal}];
   t.invocation=Object.freeze({...i,signal:controller.signal,args:Object.freeze(args)});t.acquisition.invocation=t.invocation;
   t.context=t.acquisition.context=Object.freeze({invocation:t.invocation,acquisition:t.acquisition});
   t.input={};t.init={signal:t.signal};const promise=Promise.resolve();t.fetch={state:"fulfilled",pending:promise,returned:promise,args:[t.input,t.init]};
  }
  for(const o of w.originals){
   o.pending??=Promise.resolve();o.returned=o.pending;
   if(o.reader){o.callerSignal=controller.signal;o.effectiveSignal=o.reader.transport.signal;
    o.evidenceInvoke=f.bifrostOperationEvidence(o,w.originals);o.evidenceSettle=f.bifrostOperationEvidence(o,w.originals);}
  }
  return {f,w,controller,proof:{source:{canceled:0,settled:0,expired:1,held:1},inboundChatAborted:false}};
 }
 test("Bifrost reason evidence observes native signal reason separately from undefined abort operand",()=>{
  const f=bifrostCheckpointFunctions(),controller=new AbortController();let getter=0;
  Object.defineProperty(controller.signal,"reason",{get(){getter++;throw undefined;}});
  const before=f.bifrostSignalEvidence(controller.signal);assert.equal(before.observed,true);assert.equal(before.aborted,false);assert.equal(before.reason,undefined);
  controller.abort(undefined);const after=f.bifrostSignalEvidence(controller.signal);
  assert.equal(after.observed,true);assert.equal(after.aborted,true);assert.notEqual(after.reason,undefined);assert.equal(typeof after.reason,"object");assert.equal(getter,0);
  const foreign={get reason(){getter++;throw undefined;},get aborted(){getter++;throw undefined;}};
  assert.equal(f.bifrostSignalEvidence(foreign).observed,false);assert.equal(getter,0);
 });
 test("Bifrost reason evidence retains rejected originals and private equality without reason getters",()=>{
  const {f,w,proof}=reasonEvidence();let getters=0;const reason={};
  for(const name of ["name","message","stack","code","toJSON"])Object.defineProperty(reason,name,{get(){getters++;throw undefined;}});
  const vector=w.originals.filter(o=>["read","closed","cancel"].includes(o.kind)&&o.state==="rejected");
  for(const o of vector)o.reason=reason;
  const records=f.bifrostCaseEvidence(2,w,proof,false,[undefined]);records.forEach(f.validateBifrostEvidence);
  const reasons=records.find(r=>r.part==="reasons"),retirement=records.find(r=>r.part==="retirement");
  assert.equal(records[0].complete,true);assert.equal(reasons.readClosed,true);assert.equal(reasons.readCancel,true);
  assert.deepEqual(JSON.parse(JSON.stringify(reasons.read)),{observed:true,defined:true,object:true});
  assert.deepEqual(Array.from(reasons.readSignals),[false,false,false]);assert.equal(getters,0);
  assert.equal(retirement.states.read,"rejected");assert.equal(retirement.states.closed,"rejected");assert.equal(retirement.states.cancel,"rejected");
  assert.equal(retirement.worker,false);assert.equal(records[0].source.expired,1);assert.equal(records[0].firstFailed,null);
  assert.ok(vector.every(o=>o.reason===reason&&o.state==="rejected"));
 });
 test("Bifrost reason evidence distinguishes undefined null foreign and unobserved outcomes",()=>{
  for(const reason of [undefined,null,{}]){
   const {f,w,proof}=reasonEvidence(),read=w.originals.find(o=>o.kind==="read"&&o.state==="rejected");
   read.reason=reason;const records=f.bifrostCaseEvidence(2,w,proof,false,[]);records.forEach(f.validateBifrostEvidence);
   const r=records[1];assert.equal(r.read.observed,true);assert.equal(r.read.defined,reason!==undefined);assert.equal(r.read.object,reason!==null&&typeof reason==="object");
   assert.equal(r.readClosed,false);assert.equal(r.readCancel,false);
  }
  const {f,w,proof}=reasonEvidence();w.originals.find(o=>o.kind==="read"&&o.state==="rejected").state="pending";
  const records=f.bifrostCaseEvidence(2,w,proof,false,[]);records.forEach(f.validateBifrostEvidence);
  assert.equal(records[0].complete,false);assert.equal(records[1].read.observed,false);assert.equal(records[1].read.defined,null);assert.equal(records[1].readClosed,null);
  assert.equal(records[3].counts.pending,1);
 });
 test("Bifrost reason evidence binds cancel operands to invocation-time signal reasons",()=>{
  const {f,w,proof}=reasonEvidence(),cancel=w.originals.find(o=>o.kind==="cancel");
  const actual=cancel.evidenceInvoke.caller.reason;
  cancel.args=[actual];let reasons=f.bifrostCaseEvidence(2,w,proof,false,[])[1];
  assert.equal(reasons.cancelArgs,1);assert.equal(reasons.cancelRead,false);assert.deepEqual(Array.from(reasons.cancelInput),[true,false,false]);
  cancel.args=[undefined];reasons=f.bifrostCaseEvidence(2,w,proof,false,[])[1];
  assert.equal(reasons.cancelArgs,1);assert.deepEqual(Array.from(reasons.cancelInput),[false,false,false]);
  cancel.args=[];reasons=f.bifrostCaseEvidence(2,w,proof,false,[])[1];
  assert.equal(reasons.cancelArgs,0);assert.equal(reasons.cancelRead,null);assert.deepEqual(Array.from(reasons.cancelInput),[null,null,null]);
  const controller=new AbortController();controller.abort(undefined);w.caller.reason=undefined;w.caller.abortArgumentCount=1;w.caller.evidenceAbort=f.bifrostSignalEvidence(controller.signal);
  reasons=f.bifrostCaseEvidence(2,w,proof,false,[])[1];
  assert.equal(reasons.abortOperand.observed,true);assert.equal(reasons.abortOperand.defined,false);assert.equal(reasons.callerReason.defined,true);assert.equal(reasons.operandSignal,false);
 });
 test("Bifrost reason evidence keeps observed cancel chronology separate from later abort",()=>{
  const {f,w}=reasonEvidence(),controller=new AbortController(),r=w.transports[0].readers[0];
  const read={kind:"read",reader:r,state:"pending",callerSignal:controller.signal,effectiveSignal:controller.signal};
  const closed={kind:"closed",reader:r,state:"pending"},cancel={kind:"cancel",reader:r,callerSignal:controller.signal,effectiveSignal:controller.signal};
  const earlier=f.bifrostOperationEvidence(cancel,[read,closed]);controller.abort({});read.state="rejected";
  const later=f.bifrostOperationEvidence(cancel,[read,closed]);closed.state="rejected";
  assert.equal(earlier.caller.aborted,false);assert.equal(earlier.readRejected,false);assert.equal(earlier.pendingReads,1);
  assert.equal(later.caller.aborted,true);assert.equal(later.readRejected,true);assert.equal(later.closedRejected,false);assert.equal(later.pendingReads,0);
 });
 test("Bifrost reason evidence marks wrong ambiguous attachment and original release failure without disposition",()=>{
  for(const mutate of [
   w=>{w.transports[0].acquisition.response={};},w=>{w.transports[0].readers.push(w.transports[0].readers[0]);},
   w=>{w.acquisitions.shift();},w=>{w.acquisitions.push(w.transports[0].acquisition);},
   w=>{w.originals.find(o=>o.kind==="read"&&o.state==="rejected").receiver={};},
   w=>{w.originals.find(o=>o.kind==="cancel").returned=Promise.resolve();}
  ]){
   const {f,w,proof}=reasonEvidence();mutate(w);const records=f.bifrostCaseEvidence(2,w,proof,false,[]);records.forEach(f.validateBifrostEvidence);assert.equal(records[0].complete,false);
  }
  const {f,w,proof}=reasonEvidence(),release=w.transports[0].release;
  release.state="rejected";release.reason=undefined;w.failures.push(undefined);w.syncFailures.push(undefined);w.observerFailures.push(undefined);w.evidenceRestoreFailures=1;w.restored=false;
  const records=f.bifrostCaseEvidence(2,w,proof,false,[undefined]);records.forEach(f.validateBifrostEvidence);
  assert.equal(records[3].states.release,"rejected");assert.equal(records[3].release.defined,false);assert.deepEqual(Array.from(records[3].undefined),[1,1,1,0]);
  assert.equal(records[3].counts.sync,1);assert.equal(records[3].counts.observer,1);assert.equal(records[3].counts.restoration,1);assert.equal(records[3].counts.worker,1);
 });
 test("Bifrost reason evidence reserves one complete failed case through parser emitter and overflow",()=>{
  const {f,w,proof}=reasonEvidence(),records=[],report=f.createBifrostCheckpointReporter("sdk",r=>records.push(r),true);
  report.mark(null,"module","fulfilled");report.flush(null);
  for(let i=0;i<20;i++){report.mark(i,"setup","fulfilled");report.flush(i);}
  const group=f.bifrostCaseEvidence(2,w,proof,false,[]);report.evidence(group);report.evidence(f.bifrostCaseEvidence(3,w,proof,false,[]));report.finish();
  assert.equal(report.failures.length,0);assert.equal(records.length,9);assert.equal(records.filter(r=>r.evidence).length,5);
  assert.ok(records.filter(r=>r.evidence).every(r=>r.case===2));assert.equal(records.at(-2).phase,"overflow");assert.ok(records.at(-2).count>0);
  const child={stdout:records.map(r=>"BIFROST_CHECKPOINT "+JSON.stringify(r)).join("\n")},decoded=bifrostCheckpointRecords(child);
  const lines=[],emit=bifrostAnnotationEmitter(line=>lines.push(line));decoded.forEach(emit);
  assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
  for(const changed of [group.slice(1),group.map((r,i)=>i===1?{...r,case:3}:r),group.map((r,i)=>i===1?{...r,complete:!r.complete}:r)]){
   assert.throws(()=>bifrostCheckpointRecords({stdout:changed.map(r=>"BIFROST_CHECKPOINT "+JSON.stringify(r)).join("\n")}));
  }
  for(const changed of [{...group[0],firstFailed:"invented"},{...group[1],message:"private"},{...group[2],abortInvoke:Infinity}]){
   assert.throws(()=>f.validateBifrostEvidence(changed));
  }
 });
 test("Bifrost reason evidence maximum closed numeric fields fit complete original quotas",()=>{
  const {f,w,proof}=reasonEvidence();
  w.originals.find(o=>o.kind==="cancel").args=[{}];
  const worst=value=>typeof value==="number"?1000000:Array.isArray(value)?value.map(worst):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,["v","case"].includes(k)?v:worst(v)])):value;
  const group=f.bifrostCaseEvidence(2,w,proof,false,[]).map(worst),records=[];
  for(const r of group)r.complete=false;
  group[0].bindings.signals=false;
  for(const key of ['readInvokeSignals','readSettleSignals','cancelInvokeSignals'])group[2][key]=[false,false,false];
  group[2].readRejectedAtCancel=false;group[2].closedRejectedAtCancel=false;group[2].cancelOperand.object=false;
  group.forEach(f.validateBifrostEvidence);
  const report=f.createBifrostCheckpointReporter("sdk",r=>records.push(r),true);
  for(let i=0;i<4;i++){report.mark(i,"worker_retirement","rejected",undefined,4095,4095);report.flush(i);}
  report.evidence(group);report.finish();assert.equal(report.failures.length,0);assert.equal(records.length,9);
  const decoded=bifrostCheckpointRecords({stdout:records.map(r=>"BIFROST_CHECKPOINT "+JSON.stringify(r)).join("\n")});
  const lines=[],emit=bifrostAnnotationEmitter(line=>lines.push(line));decoded.forEach(emit);
  assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
 });
 function controlEvidence(role,identity){return nativeEvidence(role,identity);}
 function controls(identity){return ["eof","preabort","partial","provider_error"].map(role=>evaluator.evaluateBifrostNativeControl(controlEvidence(role,identity)));}
 function invocationHarness(){const storage=new AsyncLocalStorage();return {storage,ownership:evaluator.createBifrostInvocationOwnership(storage)};}
 async function runInvocation(h,caller,wait=Promise.resolve()){
  const publicReceiver={},guardReceiver={},options={signal:caller.signal},args=[{}, {}, options],guardSignal={},input={signal:guardSignal},response={body:{}},result={response},t={method:'POST'};
  let publicContext,guardContext,transportContext,guardOriginal,guardReturned,publicOriginal,seenArgs,seenGuardArgs;
  function originalGuard(...actual){assert.equal(this,guardReceiver);seenGuardArgs=actual;guardContext=h.storage.getStore();
   guardOriginal=wait.then(()=>{transportContext=h.storage.getStore();h.ownership.transport(t);h.ownership.response(t,response);return result;});return guardOriginal;}
  const acquisition={input,inputSignal:guardSignal,guard:originalGuard},guardArgs=[input];
  function originalPublic(...actual){assert.equal(this,publicReceiver);seenArgs=actual;publicContext=h.storage.getStore();
   const completion=Promise.resolve().then(()=>{guardReturned=h.ownership.guard(originalGuard,guardReceiver,guardArgs,acquisition);assert.equal(guardReturned,guardOriginal);return guardReturned;}).then(r=>h.ownership.attach(acquisition,r));
   publicOriginal={completion};return publicOriginal;}
  const returned=h.ownership.invoke(caller,'inference',originalPublic,publicReceiver,args);assert.equal(returned,publicOriginal);await returned.completion;
  assert.deepEqual(seenArgs,args);assert.deepEqual(seenGuardArgs,guardArgs);assert.equal(publicContext.invocation.caller,caller);
  assert.equal(publicContext.invocation.fn,originalPublic);assert.equal(publicContext.invocation.receiver,publicReceiver);
  assert.equal(publicContext.invocation.args[2],options);assert.ok(Object.isFrozen(publicContext.invocation));assert.ok(Object.isFrozen(publicContext.invocation.args));
  assert.equal(guardContext.invocation,publicContext.invocation);assert.equal(transportContext,guardContext);assert.equal(acquisition.invocation,publicContext.invocation);
  assert.equal(t.caller,caller);assert.equal(t.acquisition,acquisition);assert.equal(t.response,response);assert.equal(acquisition.result,result);assert.equal(h.ownership.bound(t),true);
  assert.notEqual(input.signal,caller.signal);assert.equal(evaluator.bifrostInvocationBound({owner:caller.owner,caller},t),true);
  return {t,acquisition,result,context:guardContext};
 }
 test('Bifrost invocation wrapper preserves original identities across asynchronous guard and fetch',async()=>{
  const h=invocationHarness(),caller={owner:{},signal:new AbortController().signal};await runInvocation(h,caller);assert.equal(h.storage.getStore(),undefined);h.ownership.restore();
 });
 test('Bifrost invocation wrapper preserves discovery receiver and original rejected promise',async()=>{
  const h=invocationHarness(),caller={owner:{},signal:{}},receiver={},input={signal:caller.signal},reason={};let original,called=0;
  function run(options){assert.equal(this,receiver);assert.equal(options,input);called++;return original=Promise.reject(reason);}
  const returned=h.ownership.invoke(caller,'discovery',run,receiver,[input]);assert.equal(returned,original);await assert.rejects(returned,e=>e===reason);assert.equal(called,1);assert.equal(h.storage.getStore(),undefined);h.ownership.restore();
 });
 test('Bifrost invocation wrapper refuses ambiguous original response and foreign guard result',async()=>{
  const h=invocationHarness(),caller={owner:{},signal:{}};const one=await runInvocation(h,caller);
  assert.throws(()=>h.ownership.response(one.t,one.t.response));assert.throws(()=>h.ownership.attach(one.acquisition,{response:{}}));
  const other={method:'POST'},a={input:{signal:{}},guard:undefined};
  function guard(){h.ownership.transport(other);h.ownership.response(other,one.t.response);}
  a.guard=guard;let caught=false;
  try{h.ownership.invoke(caller,'inference',()=>h.ownership.guard(guard,undefined,[a.input],a),undefined,[{},{},{signal:caller.signal}]);}catch{caught=true;}
  assert.equal(caught,true);assert.equal(other.guardObserved,undefined);h.ownership.restore();
 });
 test('Bifrost invocation wrapper isolates concurrent callers',async()=>{
  const h=invocationHarness();let release;const held=new Promise(r=>{release=r;}),a={owner:{},signal:new AbortController().signal},b={owner:{},signal:new AbortController().signal};
  const first=runInvocation(h,a,held);const second=await runInvocation(h,b);release();const initial=await first;
  assert.notEqual(initial.context,second.context);assert.equal(initial.t.caller,a);assert.equal(second.t.caller,b);h.ownership.restore();
 });
 test('Bifrost invocation wrapper refuses missing foreign detached and substituted contexts',async()=>{
  const h=invocationHarness(),caller={owner:{},signal:new AbortController().signal};
  assert.throws(()=>h.ownership.transport({method:'POST'}));
  const good=await runInvocation(h,caller);
  h.storage.run({invocation:{...good.context.invocation},acquisition:good.acquisition},()=>assert.throws(()=>h.ownership.transport({method:'POST'})));
  h.storage.run({...good.context,acquisition:{}},()=>assert.throws(()=>h.ownership.transport({method:'POST'})));
  h.storage.run(good.context,()=>assert.throws(()=>h.ownership.transport({method:'POST'})));
  const detached=AsyncLocalStorage.snapshot();h.storage.run(good.context,()=>detached(()=>assert.throws(()=>h.ownership.transport({method:'POST'}))));
  assert.throws(()=>h.ownership.attach({},good.result));assert.throws(()=>h.ownership.attach(good.acquisition,good.result));h.ownership.restore();
 });
 test('Bifrost invocation wrapper refuses mismatched caller arguments and kind',()=>{
  const h=invocationHarness(),caller={owner:{},signal:{}},fn=()=>assert.fail('original must not be called');
  assert.throws(()=>h.ownership.invoke(caller,'inference',fn,undefined,[{},{},{signal:{}}]));
  assert.throws(()=>h.ownership.invoke(caller,'unknown',fn,undefined,[{signal:caller.signal}]));h.ownership.restore();
 });
 test('Bifrost invocation wrapper preserves original synchronous undefined and restores context',()=>{
  const h=invocationHarness(),caller={owner:{},signal:{}},args=[{},{},{signal:caller.signal}],receiver={};let calls=0,threw=false;
  function original(){calls++;assert.equal(this,receiver);throw undefined;}
  try{h.ownership.invoke(caller,'inference',original,receiver,args);}catch(e){threw=true;assert.equal(e,undefined);}
  assert.equal(threw,true);assert.equal(calls,1);assert.equal(h.storage.getStore(),undefined);
  function publicCall(){const input={signal:{}},a={input,guard:original};return h.ownership.guard(original,receiver,[input],a);}
  threw=false;try{h.ownership.invoke(caller,'inference',publicCall,undefined,args);}catch(e){threw=true;assert.equal(e,undefined);}
  assert.equal(threw,true);assert.equal(calls,2);assert.equal(h.storage.getStore(),undefined);h.ownership.restore();
 });
 test('Bifrost invocation wrapper retains an independent observer failure without replacing original result',async()=>{
  const h=invocationHarness(),caller={owner:{},signal:{}},reason={},failures=[];let original;
  function publicCall(){return original=Promise.resolve({value:1});}
  const returned=h.ownership.invoke(caller,'inference',publicCall,undefined,[{},{},{signal:caller.signal}]);assert.equal(returned,original);
  const observer=returned.then(()=>{throw reason;}).catch(e=>{failures.push(e);});assert.deepEqual(await returned,{value:1});await observer;assert.deepEqual(failures,[reason]);h.ownership.restore();
 });
 test('Bifrost invocation wrapper restoration rejects reuse without clobbering a foreign context',async()=>{
  const h=invocationHarness(),caller={owner:{},signal:{}};await runInvocation(h,caller);h.ownership.restore();assert.throws(()=>h.ownership.restore());
  let called=false;assert.throws(()=>h.ownership.invoke(caller,'inference',()=>{called=true;},undefined,[{},{},{signal:caller.signal}]));assert.equal(called,false);
  const other=new AsyncLocalStorage(),foreign={};other.run(foreign,()=>{assert.equal(other.getStore(),foreign);assert.throws(()=>h.ownership.transport({method:'POST'}));assert.equal(other.getStore(),foreign);});other.disable();
 });
 test('Bifrost invocation evaluator refuses coherent foreign tokens and permits distinct bound signals',()=>{
  const w=nativeEvidence();assert.equal(evaluator.evaluateBifrostNativeControl(w).qualified,true);
  const t=w.transports[0];assert.notEqual(t.acquisition.inputSignal,w.caller.signal);assert.equal(evaluator.evaluateBifrostNativeControl(w).qualified,true);
  const foreign=Object.freeze({...t.invocation,caller:{...w.caller},signal:{}});t.invocation=t.acquisition.invocation=foreign;t.context=t.acquisition.context=Object.freeze({invocation:foreign,acquisition:t.acquisition});t.caller=foreign.caller;
  assert.equal(evaluator.evaluateBifrostNativeControl(w).qualified,false);
 });
 test('Bifrost fetch receiver wrapper preserves unbound sentinel and exact original arguments and promise',async()=>{
  for(const receiver of [undefined,{}])for(const args of [[],[{}],[{},undefined],[{}, {}, {}]]){
   const failures=[],calls=[],pending=Promise.resolve({});let captured;
   function original(...actual){calls.push({receiver:this,args:actual});return pending;}
   const wrapped=evaluator.createBifrostFetchObserver(original,(actualReceiver,actualArgs)=>{captured={receiver:actualReceiver,args:actualArgs};return {returned:value=>assert.equal(value,pending),threw:()=>assert.fail('unexpected throw')};},failures);
   const result=Reflect.apply(wrapped,receiver,args);assert.equal(result,pending);assert.equal(calls.length,1);assert.equal(calls[0].receiver,receiver);assert.deepEqual(calls[0].args,args);
   assert.equal(captured.receiver,receiver);assert.deepEqual([...captured.args],args);assert.deepEqual(failures,[]);await result;
  }
 });
 test('Bifrost fetch receiver wrapper preserves synchronous undefined and independent observer failure',()=>{
  const failures=[],observerError={},receiver={},arg={};let called=0,threw=false;
  function original(value){assert.equal(this,receiver);assert.equal(value,arg);called++;throw undefined;}
  const wrapped=evaluator.createBifrostFetchObserver(original,()=>({threw:reason=>{assert.equal(reason,undefined);throw observerError;}}),failures);
  try{Reflect.apply(wrapped,receiver,[arg]);}catch(e){threw=true;assert.equal(e,undefined);}assert.equal(threw,true);assert.equal(called,1);assert.deepEqual(failures,[observerError]);
 });
 test('Bifrost fetch receiver wrapper keeps rejected original promise despite return observer failure',async()=>{
  const reason={},observerError={},failures=[],pending=Promise.reject(reason);
  const wrapped=evaluator.createBifrostFetchObserver(()=>pending,()=>({returned:()=>{throw observerError;}}),failures);
  const result=wrapped();assert.equal(result,pending);await assert.rejects(result,e=>e===reason);assert.deepEqual(failures,[observerError]);
 });
 test('Bifrost predispatch oracle requires exact error empty content and zero inference POST',()=>{
  const identity=unitNativeIdentity(),good=controlEvidence('preabort',identity);assert.equal(evaluator.evaluateBifrostNativeControl(good).qualified,true);
  for(const mutate of [w=>{w.caller.result='aborted';},w=>{w.caller.emptyContent=false;},w=>{w.preabortPostDelta=1;}]){const w=controlEvidence('preabort',identity);mutate(w);assert.equal(evaluator.evaluateBifrostNativeControl(w).qualified,false);}
  const partial=controlEvidence('partial',identity);assert.equal(evaluator.evaluateBifrostNativeControl(partial).qualified,true);partial.caller.result='error';assert.equal(evaluator.evaluateBifrostNativeControl(partial).qualified,false);
 });
 test('Bifrost SDK evaluator accepts the managed-response bare guard release with no arguments',()=>{
  const w=nativeEvidence(),release=w.transports[0].release;
  assert.equal(release.receiver,undefined);assert.deepEqual(release.args,[]);
  assert.equal(release.acquisition,w.transports[0].acquisition);assert.equal(release.pending,release.returned);
  const vector=evaluator.bifrostStoredErrorVector(w);assert.ok(vector);assert.equal(vector.length,3);
  assert.equal(evaluator.evaluateBifrostNativeControl(w).qualified,true);
  assert.equal(evaluator.bifrostProductExpected(w,undefined).length,0);
 });
 test('Bifrost SDK evaluator joins delayed reactions without learning a cancel operand or granting product credit',()=>{
  const w=nativeEvidence(),result=evaluator.evaluateBifrostNativeControl(w);assert.equal(result.qualified,true);assert.equal(result.vectorObserved,true);
  assert.notEqual(w.caller.reason,w.originals[1].reason);assert.equal(w.originals.filter(o=>o.state==='rejected').length,3);
  assert.equal(evaluator.bifrostProductExpected(w,undefined).length,0);
  const q=evaluator.bifrostQualification(controls(w.identity),w.identity,w.provider,w.api);assert.ok(q);
  assert.equal(evaluator.bifrostProductExpected(w,q).length,3);assert.equal(w.originals.filter(o=>o.state==='rejected').length,3);
  assert.equal(evaluator.bifrostProductExpected({...w,api:'simple'},q).length,0);
  assert.equal(evaluator.bifrostProductExpected({...w,identity:{}},q).length,0);
  assert.equal(q.contract,'stored-error-after-join-v2');assert.equal(Object.hasOwn(q,'operand'),false);
  const r=w.transports[0].readers[0];assert.ok(w.originals[1].settle>r.unlockAt&&w.originals[2].settle>r.unlockAt&&w.originals[3].settle>r.unlockAt);
  for(const args of [[],[undefined],[null],[{}],[w.originals[1].reason],['synthetic'],[42]]){
   w.originals[3].args=args;assert.equal(evaluator.evaluateBifrostNativeControl(w).qualified,true);assert.equal(evaluator.bifrostProductExpected(w,q).length,3);
  }
  for(const old of [{...q,contract:undefined},{...q,contract:'stored_error'},{...q,contract:'stored-error-after-join-v1'}])assert.equal(evaluator.bifrostProductExpected(w,old).length,0);
 });
 test('Bifrost SDK evaluator observes native reasons without inspecting hostile error properties',()=>{
  let gets=0;const reason={};
  for(const field of ['name','message','stack','code','toJSON'])Object.defineProperty(reason,field,{get(){gets++;throw undefined;}});
  const w=nativeEvidence('partial',unitNativeIdentity(),reason);
  assert.equal(evaluator.evaluateBifrostNativeControl(w).qualified,true);assert.equal(gets,0);
  const signal=w.transports[0].signal;
  Object.defineProperty(signal,'reason',{get(){gets++;throw undefined;}});
  Object.defineProperty(signal,'aborted',{get(){gets++;throw undefined;}});
  assert.equal(evaluator.evaluateBifrostNativeControl(w).qualified,true);assert.equal(gets,0);
 });
 test('Bifrost reason evidence records cancel argument kinds without serializing operands',()=>{
  const {f,w,proof}=reasonEvidence(),read=w.originals.find(o=>o.kind==='read'&&o.state==='rejected'),cancel=w.originals.find(o=>o.kind==='cancel');
  let gets=0;const foreign={get toJSON(){gets++;throw undefined;},get message(){gets++;throw undefined;}};
  for(const [args,kind,seen,defined,object] of [
   [[],'absent',false,null,null],[[undefined],'undefined',true,false,false],[[read.reason],'same-as-stored',true,true,true],
   [[foreign],'distinct-defined',true,true,true],[[null],'distinct-defined',true,true,false],[[42],'distinct-defined',true,true,false]
  ]){
   cancel.args=args;const group=f.bifrostCaseEvidence(2,w,proof,false,[]);group.forEach(f.validateBifrostEvidence);
   assert.deepEqual(JSON.parse(JSON.stringify(group[2].cancelOperand)),{observed:seen,defined,object,kind});
   const parsed=bifrostCheckpointRecords({stdout:group.map(r=>'BIFROST_CHECKPOINT '+JSON.stringify(r)).join('\n')});assert.equal(parsed.length,5);
  }
  assert.equal(gets,0);
 });
 const nativeCounterfactuals={
  'prior observed failure':w=>{w.caller.noEarlierFailure=false;},'different error with same name':w=>{w.originals[2].reason={name:'AbortError'};},
  'null rejection':w=>{for(const o of w.originals.filter(o=>o.state==='rejected'))o.reason=null;},'undefined rejection':w=>{for(const o of w.originals.filter(o=>o.state==='rejected'))o.reason=undefined;},
  'missing discovery attachment':w=>{w.transports.pop();},'wrong caller':w=>{w.caller.owner={};},'wrong acquisition':w=>{w.transports[0].acquisition.owner={};},'wrong guard result':w=>{w.transports[0].acquisition.result.response={};},'guard input promise replaced':w=>{w.transports[0].acquisition.pending=Promise.resolve();},'wrong response':w=>{w.transports[0].response={};},
  'wrong reader':w=>{w.originals[1].reader={};},'wrong receiver':w=>{w.originals[3].receiver={};},'wrong captured closed':w=>{w.originals[2].pending=Promise.resolve();},
  'ambiguous reader':w=>{w.transports[0].readers.push(w.transports[0].readers[0]);},'ambiguous request':w=>{w.transports.push(w.transports[0]);},
  'missing compiled guard':w=>{w.transports[0].guardObserved=false;},'foreign guard graph':w=>{w.transports[0].acquisition.guard=()=>{};},
  'foreign original guard signal':w=>{w.transports[0].acquisition.inputSignal={};},'foreign invocation context':w=>{w.transports[0].context={...w.transports[0].context};},'foreign original caller token':w=>{w.transports[0].invocation=Object.freeze({...w.transports[0].invocation,caller:{...w.caller}});},'foreign caller signal':w=>{w.originals[1].callerSignal={};},
  'late abort':w=>{w.caller.abortObserved=12;},'unobserved abort':w=>{w.caller.abortCalled=false;},'read began aborted':w=>{w.originals[1].callerAbortedAtInvoke=true;},
  'not aborted at rejection':w=>{w.originals[1].callerAbortedAtSettle=false;},'no effective abort':w=>{w.originals[1].effectiveAbortedAtSettle=false;},
  'no pending read':w=>{w.caller.pending=[];},'missing actual delivery':w=>{w.caller.delivered=0;},'missing nonempty read':w=>{w.originals[0].value.value=new Uint8Array();},
  'cancel before observed abort':w=>{w.originals[3].invoke=9;},'untrusted cancel argument list':w=>{w.originals[3].args={length:1};},'multiple cancel operands':w=>{w.originals[3].args=[{},{}];},
  'cancel after unlock':w=>{w.originals[3].invoke=18;w.originals[3].returnAt=19;},'closed captured after release':w=>{w.originals[2].invoke=24;},
  'read reaction before abort':w=>{w.originals[1].settle=7;},'closed reaction before abort':w=>{w.originals[2].settle=7;},
  'primitive stored reason':w=>{for(const o of w.originals.filter(o=>o.state==='rejected'))o.reason='synthetic';},
  'mixed cancellation reason':w=>{w.originals[3].reason={};},'closed fulfilled with rejected cancel':w=>{w.originals[2].state='fulfilled';},
  'read promise replaced':w=>{w.originals[1].returned=Promise.resolve();},'cancel promise replaced':w=>{w.originals[3].pending=Promise.resolve();},
  'not all originals joined':w=>{w.evidenceJoined=false;},'pending original':w=>{w.originals[1].state='pending';},
  'missing native signal':w=>{w.transports[0].signal={aborted:true,reason:w.originals[1].reason};w.originals[1].effectiveSignal=w.transports[0].signal;},
  'actual signal reason mismatch':w=>{const c=new AbortController();c.abort({});w.transports[0].signal=c.signal;w.originals[1].effectiveSignal=c.signal;},
  'input abort not observed before cancel':w=>{w.transports[0].acquisition.signalHistory.abort=13;},
  'effective abort not observed before cancel':w=>{w.transports[0].signalHistory.abort=13;},
  'missing native signal snapshot':w=>{delete w.originals[3].evidenceInvoke.input;},
  'foreign signal reason snapshot':w=>{w.originals[2].evidenceSettle.input.reason={};},
  'original effective read began aborted':w=>{w.originals[1].evidenceInvoke.effective.aborted=true;},
  'pending release':w=>{w.transports[0].release.state='pending';},'failed release undefined':w=>{w.transports[0].release.state='rejected';w.transports[0].release.reason=undefined;},
  'wrong release receiver':w=>{w.transports[0].release.receiver={};},'guard result release receiver':w=>{w.transports[0].release.receiver=w.transports[0].acquisition.result;},
  'pool lease release receiver':w=>{w.transports[0].release.receiver={release:()=>{}};},'null release receiver':w=>{w.transports[0].release.receiver=null;},
  'missing release arguments':w=>{delete w.transports[0].release.args;},'nonarray release arguments':w=>{w.transports[0].release.args={length:0};},
  'undefined release argument':w=>{w.transports[0].release.args=[undefined];},'foreign release argument':w=>{w.transports[0].release.args=[{}];},
  'wrong release acquisition':w=>{w.transports[0].release.acquisition=w.transports[1].acquisition;},'missing release promise':w=>{w.transports[0].release.pending=undefined;},
  'missing original release return':w=>{w.transports[0].release.returnAt=0;},
  'duplicate release':w=>{w.transports[0].releases=2;},'early unlock':w=>{w.transports[0].readers[0].unlockAt=10;},'duplicate unlock':w=>{w.transports[0].readers[0].unlocks=2;},
  'unlock rejected undefined':w=>{w.originals[6].state='rejected';w.originals[6].reason=undefined;},'release promise replaced':w=>{w.transports[0].release.returned=Promise.resolve();},
  'releaseLock error':w=>{w.transports[0].readers[0].unlockFailed=true;w.syncFailures.push(new TypeError('synthetic'));},'locked body':w=>{w.transports[0].response.body.locked=true;},
  'failed restoration':w=>{w.restored=false;},'observer undefined':w=>{w.observerFailures.push(undefined);},'sync undefined':w=>{w.syncFailures.push(undefined);},
  'source expiry':w=>{w.sourceExpired=1;},'unknown source':w=>{w.sourceExpired=null;},'body and cleanup failures':w=>{w.failures.push({},undefined);},'reporting undefined':w=>{w.reportingFailures.push(undefined);},
  'late independent join failure':w=>{w.originals.push({kind:'late',state:'rejected',reason:undefined});}
 };
 for(const [name,mutate] of Object.entries(nativeCounterfactuals))test('Bifrost SDK evaluator refuses '+name,()=>{const w=nativeEvidence();mutate(w);assert.equal(evaluator.evaluateBifrostNativeControl(w).qualified,false);});
 test('Bifrost SDK qualification needs four independent exact-runtime roles after restoration',()=>{
  const identity=unitNativeIdentity(),reports=controls(identity);assert.ok(reports.every(r=>r.qualified));
  const qualify=r=>evaluator.bifrostQualification(r,identity,'bifrost','stream');assert.ok(qualify(reports));assert.equal(qualify(reports.slice(1)),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,qualified:false}:r)),undefined);
  assert.equal(qualify(reports.map(r=>({...r,owner:reports[0].owner}))),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,owner:undefined}:r)),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,identity:{}}:r)),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,provider:'novita'}:r)),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,role:'eof'}:r)),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,api:'simple'}:r)),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,contract:undefined}:r)),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,contract:'stored-error-after-join-v1'}:r)),undefined);
  for(const patch of [{pin:'e2a8b8d4ec290cd6c035f3568a14e4d7c6433635'},{pin:'old'},{node:''},{guard:undefined},{fetch:undefined}]){
   const other=Object.freeze({...identity,...patch});assert.equal(evaluator.bifrostQualification(controls(other),other,'bifrost','stream'),undefined);
  }
 });
 test('Bifrost SDK nonpartial controls cannot borrow the stored-error disposition',()=>{
  const identity=unitNativeIdentity();
  for(const role of ['eof','preabort','provider_error']){const w=controlEvidence(role,identity);w.originals[0].state='rejected';assert.equal(evaluator.evaluateBifrostNativeControl(w).qualified,false);}
  const cold=controlEvidence('preabort',identity);delete cold.preabortPostDelta;assert.equal(evaluator.evaluateBifrostNativeControl(cold).qualified,false);
  cold.preabortPostDelta=0;cold.caller.abortCalled=false;assert.equal(evaluator.evaluateBifrostNativeControl(cold).qualified,false);
  const dispatched=controlEvidence('preabort',identity);dispatched.preabortPostDelta=1;assert.equal(evaluator.evaluateBifrostNativeControl(dispatched).qualified,false);
  const provider=controlEvidence('provider_error',identity);provider.caller.abortCalled=true;assert.equal(evaluator.evaluateBifrostNativeControl(provider).qualified,false);
  const eof=controlEvidence('eof',identity);eof.transports[0].readers=[];assert.equal(evaluator.evaluateBifrostNativeControl(eof).qualified,false);
 });
 test("Bifrost SDK inventories preserve original products and separate eight controls and two progress cases",()=>{
  assert.equal(bifrostCases.length,22);assert.equal(bifrostControls.length,8);assert.equal(bifrostProgressCases.length,2);
  const all=[...bifrostControls,...bifrostCases,...bifrostProgressCases];assert.equal(new Set(all.map(r=>r.id)).size,32);
  for(const api of ["stream","simple"])assert.deepEqual(bifrostControls.filter(r=>r.api===api).map(r=>r.control),["eof","preabort","partial","provider_error"]);
  assert.ok(bifrostCases.every(r=>r.control===undefined));
 });
 function actualBifrostAuthConfiguration(row){
  const source=readFileSync(new URL("./fixtures/openclaw-bifrost-contract.test.ts",import.meta.url),"utf8");
  const declarations=["const key = ","    const store:AuthProfileStore=","    const config:OpenClawConfig="].map(prefix=>{
   const lines=source.split("\n").filter(line=>line.startsWith(prefix));assert.equal(lines.length,1);return lines[0];
  }).join("\n");
  return runInNewContext(stripTypeScriptTypes(declarations,{mode:"strip"})+"\n({store,config})",{row,origin:"https://router.fixture"},{timeout:1000});
 }
 test("Bifrost SDK fixture explicitly selects inline auth despite the eligible poisoned profile",()=>{
  // D8 requires explicit api-key mode to prefer a literal config key over profiles.
  for(const row of [...bifrostControls,...bifrostCases,...bifrostProgressCases].filter(r=>r.mode!=="profile")){
   const {store,config}=actualBifrostAuthConfiguration(row),provider=config.models.providers.bifrost;
   assert.equal(provider.auth,"api-key");assert.equal(provider.apiKey,bifrostKey(row.id));
   assert.equal(store.profiles["bifrost:selected"].provider,"bifrost");
   assert.equal(store.profiles["bifrost:selected"].type,"api_key");
   assert.equal(store.profiles["bifrost:selected"].key,"synthetic-poison-unselected-profile");
   assert.notEqual(provider.apiKey,store.profiles["bifrost:selected"].key);
  }
 });
 test("Bifrost SDK fixture keeps the explicit profile reference and original selected key",()=>{
  const row=bifrostCases.find(r=>r.mode==="profile");assert.ok(row);
  const {store,config}=actualBifrostAuthConfiguration(row),provider=config.models.providers.bifrost;
  assert.equal(provider.auth,"api-key");assert.equal(provider.apiKey,"bifrost:selected");
  assert.equal(store.profiles[provider.apiKey].key,bifrostKey(row.id));
  assert.equal(store.profiles[provider.apiKey].provider,"bifrost");
  assert.equal(store.profiles[provider.apiKey].type,"api_key");
 });
 for (const mode of ["partial", "provider_error"]) {
  function failedChatEvidence() {
   const row={id:"owned_"+mode,mode};
   const discovery={capability:"models.list",provider:"bifrost",policy_id:row.id};
   const chat={capability:"llm.chat",provider:"bifrost",policy_id:row.id,credential_id:row.id,model:"tenant/opaque-a",
    status:mode==="partial"?"client_error":"provider_error",status_code:200,reserved_cost_micros:7,actual_cost_micros:7,cost_basis:"policy_fixed",
    input_tokens:null,output_tokens:null,total_tokens:null,cached_input_tokens:null};
   return {row,proof:{events:[discovery,chat],charged:0},chat};
  }
  test("Bifrost failed-chat accounting accepts owned "+mode+" after discovery in either order",()=>{
   const {row,proof}=failedChatEvidence();assertBifrostFailedChatAccounting(row,proof);
   proof.events.reverse();assertBifrostFailedChatAccounting(row,proof);
  });
  const mutations={
   "discovery only":v=>{v.proof.events.pop();},"duplicate chat":v=>{v.proof.events.push({...v.chat});},
   "foreign provider":v=>{v.chat.provider="foreign";},"foreign policy":v=>{v.chat.policy_id="foreign";},
   "foreign credential":v=>{v.chat.credential_id="foreign";},"foreign model":v=>{v.chat.model="foreign";},
   "wrong capability":v=>{v.chat.capability="models.list";},"success status":v=>{v.chat.status="success";},
   "wrong failure":v=>{v.chat.status=mode==="partial"?"provider_error":"client_error";},
   "invented wire status":v=>{v.chat.status_code=499;},"refunded charge":v=>{v.chat.actual_cost_micros=0;},
   "missing reservation":v=>{v.chat.reserved_cost_micros=0;},"wrong basis":v=>{v.chat.cost_basis="none";},
   "held capacity":v=>{v.proof.charged=1;},
   ...Object.fromEntries(["input_tokens","output_tokens","total_tokens","cached_input_tokens"].flatMap(field=>[
    [field+" invented",v=>{v.chat[field]=0;}],[field+" missing",v=>{delete v.chat[field];}]]))
  };
  for(const [name,change]of Object.entries(mutations))test("Bifrost failed-chat accounting rejects "+mode+" "+name,()=>{
   const v=failedChatEvidence();change(v);assert.throws(()=>assertBifrostFailedChatAccounting(v.row,v.proof));
  });
 }
 function progressReadEvidence(...values) {
  const reason=values.length?values[0]:{},request={signal:new AbortController().signal},signal=new AbortController().signal,t={request,signal};
  const r={body:{locked:false},transport:t,unlocks:1,eof:false,unlockReceiver:true,unlockSequence:12};
  const pending=Promise.resolve(),read={kind:"read",ordinal:1,reader:r,receiverIdentity:true,state:"rejected",error:reason,pending,invoke:4,settle:9};
  const observer={kind:"read_observer",ordinal:2,reader:r,receiverIdentity:true,state:"rejected",error:reason,originalRead:pending,invoke:5,settle:10};
  const ops=[{kind:"read",ordinal:0,reader:r,receiverIdentity:true,state:"fulfilled",value:{done:false,value:new Uint8Array([1])},invoke:1,settle:3},read,observer,
   {kind:"closed",ordinal:3,reader:r,receiverIdentity:true,state:"fulfilled",invoke:2,settle:10},
   {kind:"cancel",ordinal:4,reader:r,receiverIdentity:true,state:"fulfilled",invoke:8,settle:11},
   {kind:"fetch",ordinal:5,transport:t,state:"fulfilled"},{kind:"handler",ordinal:6,state:"fulfilled",value:{status:200}}];
  const source={owner:"owned",held:0,canceled:1,settled:1,expired:0,completed:0,progressCalls:1,progressEnqueued:1,progressTerminal:false,calls:[{chat:true}],
   producer:{v:1,joined:true,faults:0,failures:0,undefinedFailures:0,roles:["producer","progressTask","progressObserved","progressCommand"].map(k=>[k,"fulfilled",null])}};
  const event={capability:"llm.chat",provider:"bifrost",policy_id:"owned",credential_id:"owned",model:"tenant/opaque-a",status:"client_error",status_code:200,
   actual_cost_micros:7,reserved_cost_micros:7,cost_basis:"policy_fixed",input_tokens:null,output_tokens:null,total_tokens:null,cached_input_tokens:null};
  const s={id:"owned",mode:"progress",workerDeadline:false,ops,readers:[r],transports:[t],requests:[request],sync:[],observerFailures:[],source,
   calls:[{method:"POST",url:"https://gateway.fixture/openai/v1/chat/completions",noCaller:true,original:true,redirect:"manual"}]};
  return {s,read,observer,r,t,source,event,usage:{events:[event]},charged:0};
 }
 const progressReadResult=v=>bifrostProgressReadDisposition(v.s,v.usage,v.charged,bifrostDeadlineWitness(v.s,Error,v.usage,v.charged));
 for(const reason of [undefined,{},false])test("Bifrost progress read outcome preserves "+(reason===undefined?"undefined":typeof reason),()=>{
  const v=progressReadEvidence(reason),original=v.read.pending;
  assert.deepEqual(progressReadResult(v),[1,2]);assert.equal(v.read.pending,original);assert.equal(v.read.error,reason);assert.equal(v.observer.error,reason);
  assert.equal(v.read.state,"rejected");assert.equal(v.observer.state,"rejected");
  const proof={owner:v.s.id,retired:true,disposition:"owned_worker_progress_read",progressRead:[1,2],operations:v.s.ops,readers:[{unlocks:1,locked:false}],
   source:v.source,charged:0,events:v.usage.events,calls:v.s.calls};assertBifrostRetired(proof);
  for(const pair of [[2,1],[1,1],[1,99],[]])assert.throws(()=>assertBifrostRetired({...proof,progressRead:pair}));
 });
 const progressReadNegatives={
  "wrong mode":v=>{v.s.mode="provider_error";},"deadline":v=>{v.s.workerDeadline=true;},
  "foreign reader":v=>{v.observer.reader={};},"foreign promise":v=>{v.observer.originalRead={};},"independent observer reason":v=>{v.observer.error={};},
  "unowned reader":v=>{v.s.readers=[];},"foreign request":v=>{v.s.requests=[{}];},"foreign transport":v=>{v.s.transports=[{}];},
  "reacquired reader":v=>{v.s.readers.push({...v.r});},"duplicate request":v=>{v.s.requests.push(v.t.request);},
  "wrong endpoint":v=>{v.s.calls[0].url="https://gateway.fixture/other";},"foreign credential":v=>{v.s.calls[0].original=false;},
  "pre-cancel failure":v=>{v.read.settle=7;},"read after cancel":v=>{v.read.invoke=9;},"missing prefix":v=>{v.s.ops[0].value.done=true;},
  "failed cancel":v=>{v.s.ops[4].state="rejected";v.s.ops[4].error=v.read.error;},"duplicate cancel":v=>{v.s.ops.push({...v.s.ops[4]});},
  "closed rejection":v=>{v.s.ops[3].state="rejected";v.s.ops[3].error=v.read.error;},"cancel pending":v=>{v.s.ops[4].state="pending";},
  "early release":v=>{v.r.unlockSequence=10;},"duplicate release":v=>{v.r.unlocks=2;},"foreign receiver":v=>{v.read.receiverIdentity=false;},
  "locked body":v=>{v.r.body.locked=true;},"control failure":v=>{v.s.ops.push({kind:"control_body",state:"rejected",error:undefined});},
  "source owner":v=>{v.source.owner="foreign";},"source held":v=>{v.source.held=1;},"source uncanceled":v=>{v.source.canceled=0;},
  "duplicate source cancel":v=>{v.source.canceled=2;},"source unjoined":v=>{v.source.settled=0;},"source expired":v=>{v.source.expired=1;},
  "producer error":v=>{v.source.producer.failures=1;},"producer falsey failure":v=>{v.source.producer.undefinedFailures=1;},
  "producer pending":v=>{v.source.producer.roles[0][1]="pending";},"producer incomplete":v=>{v.source.producer.joined=false;},
  "progress absent":v=>{v.source.progressCalls=0;},"forced EOF":v=>{v.source.completed=1;},
  "missing accounting":v=>{v.usage.events=[];},"duplicate accounting":v=>{v.usage.events.push({...v.event});},
  "provider-first":v=>{v.event.status="provider_error";},"refunded charge":v=>{v.event.actual_cost_micros=0;},
  "foreign event":v=>{v.event.credential_id="other";},"held capacity":v=>{v.charged=1;},
  "independent sync falsey":v=>{v.s.sync.push(undefined);},"independent observer falsey":v=>{v.s.observerFailures.push(undefined);},
  "same-values foreign aggregate":v=>{v.s.sync.push(new AggregateError([v.read.error,v.observer.error]));}
 };
 for(const [name,change]of Object.entries(progressReadNegatives))test("Bifrost progress read outcome rejects "+name,()=>{
  const v=progressReadEvidence();change(v);assert.equal(progressReadResult(v),null);
 });
 test("Bifrost progress actual retirement retains independent failures",async()=>{
  const text=readFileSync(new URL("./openclaw-bifrost.test.mjs",import.meta.url),"utf8"),anchor="if(!s.retirement)s.retirement=(async()=>{";
  const start=text.indexOf(anchor)+anchor.length,end=text.indexOf("})();",start),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const retire=new AsyncFunction("s","drain","control","invoke","usageSnapshot","bindings","bodyBudgetCharged","bifrostDeadlineWitness","bifrostDeadlineQualified","InternalHttpAbort","publicOperations","bifrostWorkerResidual","bifrostProgressReadDisposition",text.slice(start,end));
  for(const original of [null,{reason:undefined},{reason:new AggregateError([undefined,undefined])}]){
   const v=progressReadEvidence(undefined);v.s.roots=[];let n=0;
   const proof=await retire(v.s,async()=>{if(n++===0&&original)throw original.reason;},async()=>v.source,(_s,_k,fn)=>fn(),async()=>v.usage,{},()=>0,
    bifrostDeadlineWitness,bifrostDeadlineQualified,Error,s=>s.ops.map(o=>({kind:o.kind,state:o.state,ordinal:o.ordinal})),bifrostWorkerResidual,bifrostProgressReadDisposition);
   assert.equal(proof.retired,original===null);assert.equal(proof.operations.filter(o=>o.state==="rejected").length,2);
   assert.deepEqual(proof.progressRead,[1,2]);assert.equal(proof.disposition,"owned_worker_progress_read");
   assert.equal(v.s.retirementFailures.length,original?1:0);if(original)assert.equal(v.s.retirementFailures[0],original.reason);
   const f=bifrostCheckpointFunctions();assert.equal(f.validateBifrostRetirementProof(proof,v.s.id),true);
   const c={};assert.equal(f.bifrostObserveRetirementVerdict(c,{status:proof.retired?200:500},proof),original===null);assert.equal(c.verdict[2],3);
  }
 });
 test("Bifrost progress real Worker joins the canceled original read and accounting",{timeout:30000},async()=>{
  const row={id:"bifrost_local_progress",mode:"progress",api:"stream"},f=await startBifrostFixture();
  await finishBifrostOwned(async()=>{
   await f.setup(row);
   const discovery=await fetch(f.origin+"/v1/native/bifrost/v1/models",{headers:{authorization:"Bearer "+bifrostDiscoveryKey(row.id)}});assert.equal(discovery.status,200);await discovery.arrayBuffer();
   const controller=new AbortController(),response=await fetch(f.origin+"/v1/native/bifrost/v1/chat/completions",{method:"POST",headers:{authorization:"Bearer "+bifrostKey(row.id),"content-type":"application/json"},
    body:JSON.stringify({model:"tenant/opaque-a",stream:true,messages:[{role:"user",content:"synthetic local progress"}]}),signal:controller.signal});
   assert.equal(response.status,200);const reader=response.body.getReader();assert.ok((await reader.read()).value.byteLength>0);
   const pending=reader.read();controller.abort(new Error("synthetic local cancellation"));await Promise.allSettled([pending]);reader.releaseLock();
   const progress=await fetch(f.origin+"/__bifrost/progress/"+row.id,{method:"POST"});assert.equal(progress.status,200);await progress.arrayBuffer();
   const proof=await f.join(row.id);assertBifrostRetired(proof);assertBifrostFailedChatAccounting({id:row.id,mode:"partial"},proof);
   assert.equal(proof.source.canceled,1);assert.equal(proof.source.settled,1);assert.equal(proof.source.expired,0);assert.equal(proof.source.producer.joined,true);
  },[()=>f.close()]);
 });
 function progressEvidence(){
  const w=nativeEvidence(),t=w.transports[0];w.owner.id="bifrost_progress";t.socketRequest={};t.socket={};t.socketClosedAt=20;w.caller.controlInvoke=21;
  w.caller.progress={accepted:true,enqueued:true,alreadyCanceled:false};
  const proof={inboundChatAborted:true,charged:0,source:{canceled:1,settled:1,expired:0,calls:[{chat:true}],progressCalls:1,progressEnqueued:1,progressTerminal:false,completed:0},
   events:[{capability:"llm.chat",provider:"bifrost",policy_id:w.owner.id,credential_id:w.owner.id,model:"tenant/opaque-a",status:"client_error",status_code:200,actual_cost_micros:7,reserved_cost_micros:7,input_tokens:null,output_tokens:null,total_tokens:null}]};
  // The live builder uses the case id retained on the caller's owner.
  return {w,proof,allowed:w.originals.filter(o=>o.state==="rejected"),worker:true,workerFailures:[]};
 }
 const progressResult=v=>evaluator.bifrostProgressQualified(evaluator.bifrostProgressWitness(v.w,v.proof,v.allowed,v.worker,v.workerFailures));
 test("Bifrost progress adjudication requires all independent boundaries",()=>{assert.equal(progressResult(progressEvidence()),true);});
 const progressCounterfactuals={
  "wrong socket":v=>{delete v.w.transports[0].socket;},"ambiguous request":v=>{v.w.transports.push(v.w.transports[0]);},
  "missing actual SDK text":v=>{v.w.caller.delivered=0;},"late abort":v=>{v.w.caller.abortInvoke=30;},"before socket close":v=>{v.w.caller.controlInvoke=19;},
  "missing close":v=>{delete v.w.transports[0].socketClosedAt;},"caller not aborted":v=>{v.w.caller.abortedAfter=false;},
  "missing qualification":v=>{v.allowed=[];},"Worker failure":v=>{v.worker=false;},"missing inbound signal":v=>{v.proof.inboundChatAborted=false;},
  "missing cancellation":v=>{v.proof.source.canceled=0;},"pending producer":v=>{v.proof.source.settled=0;},"expiry":v=>{v.proof.source.expired=1;},
  "replay":v=>{v.proof.source.calls.push({chat:true});},"duplicate progress":v=>{v.proof.source.progressCalls=2;},"terminal frame":v=>{v.proof.source.progressTerminal=true;},
  "forced completion":v=>{v.proof.source.completed=1;},"missing control receipt":v=>{delete v.w.caller.progress;},
  "pending original join":v=>{v.w.originals.push({state:"pending"});},"cleanup undefined":v=>{v.w.failures.push(undefined);},
  "observer undefined":v=>{v.w.observerFailures.push(undefined);},"Worker cleanup undefined":v=>{v.workerFailures.push(undefined);},"restoration failure":v=>{v.w.restored=false;},
  "wrong provider":v=>{v.proof.events[0].provider="other";},"wrong credential":v=>{v.proof.events[0].credential_id="other";},
  "wrong amount":v=>{v.proof.events[0].actual_cost_micros=0;},"missing reservation":v=>{v.proof.events[0].reserved_cost_micros=0;},
  "invented tokens":v=>{v.proof.events[0].input_tokens=0;},"capacity held":v=>{v.proof.charged=1;},"wrong status":v=>{v.proof.events[0].status="success";}
 };
 for(const [name,mutate] of Object.entries(progressCounterfactuals))test("Bifrost progress rejects "+name,()=>{const v=progressEvidence();mutate(v);assert.equal(progressResult(v),false);});
 function progressState(){return {mode:"progress",progressCalls:0,progressEnqueued:0,held:1,canceled:0,expired:0,completed:0};}
 test("Bifrost progress actual producer command is single-use and never settles the held producer",async()=>{
  const s=progressState();let notify,settled=false,bytes="";
  const originalProducer=new Promise(()=>{});originalProducer.then(()=>{settled=true;});s.producer=originalProducer;
  s.progressTask=new Promise(resolve=>{notify=resolve;}).then(command=>performBifrostProgress(s,command,()=>{bytes=": progress\n\n";}));s.progressResolve=notify;
  assert.equal(requestBifrostProgress(s),s.progressTask);await s.progressTask;
  assert.equal(bytes,": progress\n\n");assert.equal(s.producer,originalProducer);assert.equal(settled,false);assert.equal(s.held,1);assert.equal(s.completed,0);assert.equal(s.expired,0);assert.equal(s.progressEnqueued,1);
  assert.throws(()=>requestBifrostProgress(s));
 });
 test("Bifrost progress already canceled is recorded without enqueue or causal credit",()=>{
  const s={...progressState(),canceled:1,held:0};assert.deepEqual(requestBifrostProgress(s),{accepted:true,alreadyCanceled:true,enqueued:false});
  assert.equal(s.progressCalls,1);assert.equal(s.progressEnqueued,0);assert.throws(()=>requestBifrostProgress(s));
 });
 for(const [name,change] of Object.entries({"wrong mode":{mode:"partial"},"terminal completion":{completed:1},"expiry":{expired:1},"missing held":{held:0},"duplicate enqueue":{progressEnqueued:1}}))test("Bifrost progress actual producer rejects "+name,()=>{
  const s={...progressState(),progressCalls:1,...change};let enqueued=false;assert.throws(()=>performBifrostProgress(s,"progress",()=>{enqueued=true;}));assert.equal(enqueued,false);
 });
 test("Bifrost progress producer retains undefined enqueue rejection",()=>{
  const s={...progressState(),progressCalls:1};let threw=false;try{performBifrostProgress(s,"progress",()=>{throw undefined;});}catch(e){threw=true;assert.equal(e,undefined);}
  assert.equal(threw,true);assert.equal(s.progressEnqueued,0);assert.equal(s.completed,0);
 });
 test("Bifrost SDK original Worker bundles and fixture transforms without execution",async()=>{
  const require=createRequire(import.meta.resolve("wrangler/package.json")),build=require("esbuild").build;
  const result=await build({stdin:{contents:router,resolveDir:process.cwd(),sourcefile:"bifrost-client-fixture.ts",loader:"ts"},write:false,bundle:true,format:"esm",platform:"browser",target:"es2022",logLevel:"silent"});assert.ok(result.outputFiles[0].text.length);
  await build({stdin:{contents:upstream,sourcefile:"bifrost-upstream.js",loader:"js"},write:false,format:"esm",platform:"browser",target:"es2022",logLevel:"silent"});
  const fixture=readFileSync(new URL("./fixtures/openclaw-bifrost-contract.test.ts",import.meta.url),"utf8");assert.ok(stripTypeScriptTypes(fixture,{mode:"strip"}).length);
  await build({stdin:{contents:fixture,sourcefile:"bifrost-sdk.ts",loader:"ts"},write:false,format:"esm",platform:"node",target:"node24",logLevel:"silent"});
 });

 test("Bifrost parent reserves complete groups and joins output (inert)",async()=>{assert.equal((await bifrostParentRelayInertCases(assert)).length,27);});
 test("Bifrost SDK diagnostic relay retains only closed records and preserves original failure",async()=>{
  const r={v:1,pin:bifrostPin,api:"stream",role:"partial",qualified:true,vector:true,worker:false,restored:true,rejected:3,pending:0};
  const child=Object.assign(new Error("unused"),{stdout:"BIFROST_NATIVE_CONTROL "+JSON.stringify(r)+"\n"}),cleanup={},outer=new AggregateError([child,cleanup],"unused");let getter=0;
  Object.defineProperty(cleanup,"stdout",{get(){getter++;throw Error("getter called");}});Object.defineProperty(outer,"cause",{value:outer});
  assert.deepEqual(bifrostNativeDiagnosticRecords(outer),[r]);assert.equal(getter,0);
  const records=[];await assert.rejects(withBifrostNativeDiagnostics(()=>{throw outer;},r=>records.push(r)),e=>e===outer);assert.deepEqual(records,[r]);
  const delivery={};await assert.rejects(withBifrostNativeDiagnostics(()=>{throw outer;},()=>{throw delivery;}),e=>e instanceof AggregateError&&e.errors[0]===outer&&e.errors[1]===delivery);
  for(const change of [{pin:"wrong"},{role:"unknown"},{extra:"no"},{pending:-1}])assert.throws(()=>bifrostNativeDiagnosticRecords({stdout:"BIFROST_NATIVE_CONTROL "+JSON.stringify({...r,...change})}));
  let threw=false;try{await withBifrostNativeDiagnostics(()=>{throw undefined;},()=>{});}catch(e){threw=true;assert.equal(e,undefined);}assert.equal(threw,true);
 });
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
    const foreign=runInNewContext("JSON.parse(json)",{json:JSON.stringify(proof)});
    assert.notEqual(Object.getPrototypeOf(foreign.operations),Array.prototype);
    assertBifrostRetired(foreign,{workerDeadline:true,application});
    for(const change of [r=>{r.ordinal++;},r=>{r.kind="cancel";},r=>{r.state="pending";}]){
      const invalid=runInNewContext("JSON.parse(json)",{json:JSON.stringify(proof)});
      change(invalid.operations.find(r=>r.state==="rejected"));
      assert.throws(()=>assertBifrostRetired(invalid,{workerDeadline:true,application}));
    }
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
    let f;const created=[],executionCases=[...bifrostControls,...bifrostCases,...bifrostProgressCases];
    const relay=createBifrostParentRelay(bifrostJoinedOutput(process.stdout)),emit=relay.record;
    await runBifrostReported(async report=>{
      f=await report.observe(null,"setup",startBifrostFixture,undefined,[]);
      for(const [index,row]of executionCases.entries()){await report.observe(index,"case_setup",f.setup,f,[row]);created.push(row);}
      report.mark(null,"child","enter");report.flush(null);
      await withBifrostNativeDiagnostics(()=>report.observe(null,"child",runOpenClawConsumer,undefined,[t,{source:process.env.CLAWROUTER_OPENCLAW_CHECKOUT,sourceHead:bifrostPin,fixture:fileURLToPath(new URL('./fixtures/openclaw-bifrost-contract.test.ts',import.meta.url)),testPath:'extensions/bifrost/clawrouter-contract.test.ts',
        env:{CLAWROUTER_CONTRACT_ORIGIN:f.origin,CLAWROUTER_CONTRACT_SOURCE_HEAD:bifrostPin,CLAWROUTER_BIFROST_CASES:JSON.stringify(bifrostCases),CLAWROUTER_BIFROST_CONTROLS:JSON.stringify(bifrostControls),CLAWROUTER_BIFROST_PROGRESS:JSON.stringify(bifrostProgressCases)}}]),emit);
    },[...executionCases.map((row,index)=>async report=>{
      if(!created.includes(row))return;
      await finishBifrostRow(()=>report.observe(index,"worker_retirement",f.join,f,[row.id]),()=>f.joinEvidence(row.id),async proof=>{
      report.mark(index,"assertions","enter");
      try{assertBifrostRetired(proof);
      assert.equal(proof.source.calls.filter(c=>c.chat).length,['eof','provider_error','partial','account_a','account_b','profile','rotation','progress'].includes(row.mode)?1:0);
      assert.equal(proof.source.calls.filter(c=>!c.chat).length,['missing_owner','invalid_owner'].includes(row.mode)?0:1);
      if(row.mode==='partial'||row.mode==='progress'){assert.equal(proof.source.canceled,1);assert.equal(proof.source.settled,1);}
      if(row.mode==='progress'){assert.equal(proof.inboundChatAborted,true);assert.equal(proof.source.progressCalls,1);assert.equal(proof.source.progressTerminal,false);assert.equal(proof.source.completed,0);}
      report.mark(index,"assertions","fulfilled");
      }catch(error){report.mark(index,"assertions","rejected",error);report.flush(index);throw error;}
      },async proof=>{
      report.mark(index,"accounting","enter");
      try{assert.ok(proof.events.length>=1);assertBifrostFailedChatAccounting(row,proof);
      for(const event of proof.events){assert.equal(event.provider,'bifrost');assert.equal(event.policy_id,row.id);
        if(event.capability==='models.list'){assert.equal(event.model,null);assert.equal(event.actual_cost_micros,0);assert.equal(event.reserved_cost_micros,0);}
        else if(event.status==='success'){assert.equal(event.actual_cost_micros,7);assert.equal(event.input_tokens,4);assert.equal(event.output_tokens,3);}
      }
      report.mark(index,"accounting","fulfilled");
      }catch(error){report.mark(index,"accounting","rejected",error);report.flush(index);throw error;}
      });
    }),report=>f?report.observe(null,"cleanup",f.close,f,[]):undefined],emit,relay.flush);
  });
}
