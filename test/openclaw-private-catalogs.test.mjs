import { execFile } from "node:child_process";
import { promisify, types as privateNodeTypes } from "node:util";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { privateExecutionSources, overlayPrivateExecutionSource, withPrivateExecutionOverlay } from "./helpers/openclaw-private-execution-observer.mjs";

import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { startWorkerdFixture } from "./helpers/workerd.mjs";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

export const privateCatalogPin="e2a8b8d4ec290cd6c035f3568a14e4d7c6433635";
export const privateProviders=["baseten","arcee","novita"];
export const privateGroups={stream:["eof","provider_error"],simple:["eof","provider_error"],empty:["empty"],opaque:["unpriced"],
  foreign:["foreign_discovery","foreign_inference"],environment:["environment"],rotation:["rotation"],revocation:["caller_revoke","grant_revoke"],
  warm:["warm"],held:["narrow","broaden","shared_abort"],request:["method","body","query","redirect"],
  invalid:["malformed","truncated","oversize"],preabort:["cold","warm_abort","inference_abort"],partial:["stream_abort","simple_abort"]};
export const privateCases=privateProviders.flatMap(provider=>Object.entries(privateGroups).flatMap(([group,scenarios])=>scenarios.map(scenario=>({
  id:provider+"_"+group+"_"+scenario,provider,group,scenario,api:group==="stream"||scenario==="stream_abort"?"stream":"simple",
  workerOnly:["method","body","query"].includes(scenario)
}))));
export const privateNativeControls=privateProviders.flatMap(provider=>["stream","simple"].flatMap(api=>["eof","preabort","partial","provider_error"].map(control=>({
 id:provider+"_native_"+api+"_"+control,provider,api,control,group:"native_control",workerOnly:false,
 scenario:control==="partial"?(api==="stream"?"stream_abort":"simple_abort"):control==="preabort"?"control_preabort":control
}))));

// Extract the actual pure declarations, not a mirror of their implementation.
// No SDK imports, module initialization, plugin loading or native client runs.
export function privateNativeEvaluator(){
 const source=readFileSync(new URL("./fixtures/openclaw-private-catalogs-contract.test.ts",import.meta.url),"utf8");
 const names=["createPrivateFetchObserver","createPrivateInvocationOwnership","newPrivateInvocationCaller","privateControlCaller","privateInvocationBound","samePrivateDescriptor","privateCancelOperand","privateGuardIdentity","privateStoredErrorVector","evaluatePrivateNativeControl","privateQualification","privateProductExpected"];
 const start="export function createPrivateFetchObserver(",end="function emitNativeControl(";
 assert.equal(source.split(start).length,2);assert.equal(source.split(end).length,2);
 const declarations=source.slice(source.indexOf(start),source.indexOf(end));
 assert.deepEqual([...declarations.matchAll(/^export function (\w+)\(/gm)].map(m=>m[1]),names);
 assert.doesNotMatch(declarations,/\bimport\b|\brequire\s*\(/);
 const code=stripTypeScriptTypes(declarations.replace(/^export /gm,""),{mode:"strip"});
 return runInNewContext('"use strict";\n'+code+"\n({"+names.join(",")+"})",{}, {timeout:1000});
}
function privateChildDiagnosticRecords(error,prefix,decode,{maxRecords=9,maxBytes=4096,maxLine=768}={}){
 const records=new Map(),seen=new Set(),pending=[error];let bytes=0,nodes=0;
 while(pending.length){const value=pending.pop();if(!value||(typeof value!=="object"&&typeof value!=="function")||seen.has(value))continue;
  seen.add(value);if(++nodes>64)throw Error("native diagnostic error closure exceeded");
  for(const field of ["stdout","stderr"]){const d=Object.getOwnPropertyDescriptor(value,field);if(!d||!("value" in d)||typeof d.value!=="string")continue;
   if(Buffer.byteLength(d.value)>2*1024*1024)throw Error("native diagnostic source exceeded");
   for(const line of d.value.split("\n")){if(!line.startsWith(prefix))continue;
    if(Buffer.byteLength(line)>maxLine)throw Error("native diagnostic record exceeded");
    const record=JSON.parse(line.slice(prefix.length));
    const id=decode(record),encoded=JSON.stringify(record);
    if(records.has(id)){assert.equal(records.get(id),encoded);continue;}
    bytes+=Buffer.byteLength(encoded)+1;assert.ok(records.size<maxRecords&&bytes<=maxBytes);records.set(id,encoded);
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
export function privateNativeDiagnosticRecords(error){
 return privateChildDiagnosticRecords(error,"PRIVATE_NATIVE_CONTROL ",record=>{
  assert.deepEqual(Object.keys(record).sort(),["v","pin","p","a","r","q","vect","worker","restore","rejects","pending"].sort());
  assert.equal(record.v,1);assert.equal(record.pin,privateCatalogPin);assert.ok(privateProviders.includes(record.p));assert.ok(["stream","simple"].includes(record.a));assert.ok(["eof","preabort","partial","provider_error"].includes(record.r));
  for(const k of ["q","vect","worker","restore"])assert.equal(typeof record[k],"boolean");
  for(const k of ["rejects","pending"])assert.ok(Number.isSafeInteger(record[k])&&record[k]>=0&&record[k]<=1024);
  return record.p+":"+record.a+":"+record.r;
 },{maxRecords:24,maxBytes:8000,maxLine:300});
}
export function privateCheckpointFunctions(){
 const source=readFileSync(new URL("./fixtures/openclaw-private-catalogs-contract.test.ts",import.meta.url),"utf8");
 const start="export function validatePrivateCheckpoint(",end="const checkpoints=createPrivateCheckpointReporter(";
 assert.equal(source.split(start).length,2);assert.equal(source.split(end).length,2);
 const text=source.slice(source.indexOf(start),source.indexOf(end));assert.doesNotMatch(text,/\bimport\b|\brequire\s*\(/);
 const functions=runInNewContext('"use strict";\n'+stripTypeScriptTypes(text.replace(/^export /gm,""),{mode:"strip"})+"\n({validatePrivateCheckpoint,createPrivateCheckpointReporter,finishPrivateCheckpointCase,privateCheckpointCaseIndex})",{},{timeout:1000});
 return {...functions,fixtureSha256:createHash("sha256").update(source).digest("hex"),fixtureBytes:Buffer.byteLength(source)};
}
export function privateCheckpointRecords(error,executionContract){
 const {validatePrivateCheckpoint}=privateCheckpointFunctions();
 return privateChildDiagnosticRecords(error,"PRIVATE_CHECKPOINT ",record=>{validatePrivateCheckpoint(record);assert.equal(record.lane,"sdk");if(record.v===13){assert.match(executionContract??"",/^[a-f0-9]{64}$/);assert.equal(record.execution[1],executionContract);}return JSON.stringify(record);});
}
export function privateAnnotationEmitter(write){
 let bytes=0,count=0;
 return record=>{const line="::notice title=Private closed diagnostic::"+JSON.stringify(record)+"\n";
  assert.ok(Buffer.byteLength(line)<=768&&bytes+Buffer.byteLength(line)<=16384&&count<48,"Private annotation quota exceeded");
  bytes+=Buffer.byteLength(line);count++;write(line);};
}
export async function withPrivateNativeDiagnostics(run,emit,executionContract=()=>undefined){
 try{return await run();}catch(error){const reporting=[];
  for(const collect of [privateCheckpointRecords,privateNativeDiagnosticRecords])try{for(const record of collect(error,executionContract()))emit(record);}catch(reportError){reporting.push(reportError);}
  if(reporting.length)throw new AggregateError([error,...reporting],"native child and diagnostic delivery failed");throw error;}
}
// The expected digest uses the existing source extraction. The helper independently
// verifies the exclusively copied target before invoking the original command.
export function privateExecObservation(source,reporter){
 let seen=false;const token=Object.freeze({});
 return {token,fixtureSha256:source.fixtureSha256,fixtureBytes:source.fixtureBytes,onOutcome(outcome){
  assert.equal(seen,false);seen=true;const b=outcome.binding;
  assert.ok(Object.isFrozen(b));assert.equal(b.token,token);assert.equal(b.sourceHead,privateCatalogPin);
  assert.equal(b.testPath,'extensions/baseten/clawrouter-private-catalogs-contract.test.ts');
  assert.equal(b.fixtureSha256,source.fixtureSha256);assert.equal(b.fixtureBytes,source.fixtureBytes);assert.equal(b.command,'pnpm');
  assert.deepEqual([...b.args],['test',b.testPath,'--maxWorkers=1']);
  if(b.executionContract!==undefined){assert.match(b.executionContract,/^[a-f0-9]{64}$/);reporter.executionContract=b.executionContract;}
  assert.equal(outcome.errorPresent,outcome.state!=='fulfilled');
  reporter.execOutcome({v:3,pin:privateCatalogPin,lane:'outer',kind:'exec',phase:outcome.phase,state:outcome.state,defined:outcome.errorDefined,fields:outcome.fields});
 }};
}
export async function runPrivateReported(body,cleanups,emit){
 const functions=privateCheckpointFunctions(),reporter=functions.createPrivateCheckpointReporter("outer",emit);
 reporter.privateExec=privateExecObservation(functions,reporter);
 reporter.mark(null,"setup","enter");reporter.flush(null);
 return finishPrivateOwned(()=>body(reporter),[...cleanups.map(cleanup=>()=>cleanup(reporter)),async()=>{
  await reporter.drain();reporter.flush(null);reporter.finish();
  if(reporter.failures.length)throw new AggregateError(reporter.failures,"Private diagnostic observation failed");
 }]);
}

export const privateKey=(id,kind="inference",secret="fixture-secret")=>`clawrouter-live-${id}_${kind}-${secret}`;
export async function finishPrivateOwned(body,cleanups){const failures=[];let value;try{value=await body();}catch(e){failures.push(e);}for(const f of cleanups)try{await f();}catch(e){failures.push(e);}if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"private catalog body and owned cleanup failed");return value;}
// Fixture-owned identities and observations. Rejected data remains a strict failure.
export function createPrivateOperationLedger(owner){
 const operations=[],observers=[],faults=[];let sequence=0,originalAt=0,observerAt=0,joining=null,seal=null,invalid=false;
 const touch=()=>{sequence++;if(seal)invalid=true;return sequence;};
 const fault=error=>{touch();faults.push(error);};
 const settle=(o,state,value)=>{if(o.state!=='pending')return;o.state=state;o.settlement=touch();
  if(state==='rejected'){o.errorPresent=true;o.error=value;}else o.value=value;};
 const attach=o=>{const p=o.pending;
  if(p===null||p===undefined||(typeof p!=='object'&&typeof p!=='function')){settle(o,'fulfilled',p);return;}
  try{const then=p.then;if(typeof then!=='function'){settle(o,'fulfilled',p);return;}
   const monitor=Reflect.apply(then,p,[value=>settle(o,'fulfilled',value),error=>settle(o,'rejected',error)]);
   observers.push(monitor);
   // Keep both the derivative and its immediate, nonthrowing rejection guard.
   observers.push(monitor.then(()=>{},error=>{fault(error);}));
  }catch(error){fault(error);}
 };
 const begin=(kind,binding,fn,receiver,args)=>{touch();const o={id:operations.length,owner,kind,binding,fn,receiver,args:Object.freeze([...args]),
  pending:null,state:'pending',invocation:sequence,settlement:null,errorPresent:false,error:undefined,callbackEntered:false,originalRead:null};operations.push(o);return o;};
 const retain=(kind,p,binding=null,extra={})=>{const o=begin(kind,binding,null,undefined,[]);Object.assign(o,extra);o.pending=p;attach(o);return o;};
 const invoke=(kind,fn,receiver,args,binding=null)=>{const o=begin(kind,binding,fn,receiver,args);let value;
  try{value=Reflect.apply(fn,receiver,args);}catch(error){o.state='threw';o.errorPresent=true;o.error=error;o.settlement=touch();throw error;}
  o.pending=value;attach(o);return value;};
 const values=()=>[...operations.filter(o=>o.errorPresent).map(o=>o.error),...faults];
 const assert=()=>{const failures=values();if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'private original operations and observation failures');};
 const drain=async()=>{if(joining)return joining;
  const current=(async()=>{while(originalAt<operations.length||observerAt<observers.length){
    const os=operations.slice(originalAt),qs=observers.slice(observerAt);originalAt=operations.length;observerAt=observers.length;
    const results=await Promise.allSettled([...os.map(o=>o.pending),...qs]);
    for(let i=0;i<os.length;i++){const o=os[i],r=results[i];if(o.state==='pending')settle(o,r.status,r.status==='fulfilled'?r.value:r.reason);}
    // Observer failures are recorded by their already-attached guard, never flattened or duplicated here.
   }})();joining=current;try{await current;}finally{joining=null;}};
 const descriptors=o=>Reflect.ownKeys(o).map(k=>[k,Object.getOwnPropertyDescriptor(o,k)]);
 const equal=(o,saved)=>{const now=descriptors(o);return now.length===saved.length&&now.every(([k,d],i)=>{const [key,v]=saved[i];return k===key&&['value','get','set','writable','enumerable','configurable'].every(f=>Object.is(d[f],v[f]));});};
 const validate=()=>{if(!seal||invalid)return false;
  if(sequence!==seal.sequence||originalAt!==operations.length||observerAt!==observers.length||faults.length!==seal.faultCount||
   api.operations!==operations||api.observers!==observers||api.faults!==faults||
   seal.arrays.some(([array,entries])=>array.length!==entries.length||entries.some(([item,ds],i)=>array[i]!==item||!equal(item,ds))))invalid=true;
  return !invalid;};
 const freeze=(resources=[])=>{if(seal)return validate();if(joining||originalAt!==operations.length||observerAt!==observers.length||operations.some(o=>o.state==='pending'))throw Error('unjoined private lifetime');
  seal={sequence,faultCount:faults.length,arrays:[operations,[owner],...(owner.ownership?[[owner.ownership]]:[]),...resources].map(array=>[array,array.map(item=>[item,descriptors(item)])])};return validate();};
 const api={operations,observers,faults,touch,fault,retain,invoke,drain,assert,values,freeze,validate,
  get sequence(){return sequence;},get sealed(){return seal!==null;},get invalid(){return invalid;},
  facts(){return {originals:operations.length,observers:observers.length,pending:operations.filter(o=>o.state==='pending').length,
   rejected:operations.filter(o=>o.errorPresent).length,faults:faults.length,sequence,sealed:seal!==null,valid:validate()};}};return api;
}
export async function joinPrivateOriginals(s){await s.ledger.drain();s.ledger.assert();}
export function createPrivateRequestOwnership(owner,context){
 const requests=[],transports=[],readers=[],tokens=new WeakMap();let retired=false;
 const register=(request,credential)=>{if(retired)throw Error('retired private request owner');const token=Object.freeze({owner,request,credential,generation:owner.generation});
  const entry={id:requests.length,token,request,credential,requestId:null,status:null,retired:false};tokens.set(token,entry);requests.push(entry);owner.ledger.touch();return token;};
 const owns=token=>{const r=tokens.get(token);return !retired&&!!r&&requests.includes(r)&&!r.retired&&r.request===token.request&&token.owner===owner&&token.generation===owner.generation;};
 const current=()=>{const token=context.getStore();if(!owns(token))throw Error('foreign or absent private request context');return token;};
 const transport=(token,secret,method,url)=>{if(!owns(token)||secret!=='Bearer synthetic-private-'+owner.id)throw Error('foreign private transport');
  const t={token,request:token.request,credential:token.credential,secret,method,url,id:transports.length,pending:null,response:null,body:null};transports.push(t);owner.ledger.touch();return t;};
 const response=(t,value,body)=>{if(!transports.includes(t)||!owns(t.token)||t.response!==null||transports.some(x=>x!==t&&(x.response===value||body!==null&&x.body===body)))throw Error('ambiguous private response');
  t.response=value;t.body=body;owner.ledger.touch();};
 const reader=(t,value,body,originals)=>{if(!transports.includes(t)||!owns(t.token)||context.getStore()!==t.token||t.body!==body||t.response===null||readers.some(r=>r.reader===value||r.body===body))throw Error('foreign private reader');
  const r={token:t.token,request:t.request,transport:t,response:t.response,body,reader:value,originals,id:readers.length,unlocks:0,unlockEntry:null,unlockReturn:null,pendingAtUnlock:null,cancels:0,eof:false,closed:null,closedRecord:null};
  readers.push(r);owner.ledger.touch();return r;};
 // Stream pull callbacks can outlive ingress ALS. An absent context is allowed
 // only with the full private resource graph below; a present foreign token is not.
 const bound=(r,method,receiver,fn)=>owns(r.token)&&(context.getStore()===r.token||context.getStore()===undefined&&['read','cancel','releaseLock'].includes(method))&&readers.includes(r)&&transports.includes(r.transport)&&r.request===r.token.request&&
  r.transport.token===r.token&&r.response===r.transport.response&&r.body===r.transport.body&&receiver===r.reader&&r.originals[method]===fn;
 const retire=()=>{if(retired)return;retired=true;for(const r of requests)r.retired=true;owner.ledger.touch();};
 const intact=()=>requests.every(r=>owns(r.token)&&r.request===r.token.request)&&transports.every(t=>owns(t.token)&&t.request===t.token.request&&t.credential===t.token.credential&&t.response!==null&&
  owner.ledger.operations.some(o=>o.kind==='fetch'&&o.binding===t&&o.pending===t.pending))&&
  readers.every(r=>transports.includes(r.transport)&&r.token===r.transport.token&&r.request===r.token.request&&r.response===r.transport.response&&r.body===r.transport.body&&
   owner.ledger.operations.includes(r.closedRecord)&&r.closedRecord.kind==='closed'&&r.closedRecord.binding===r&&r.closedRecord.pending===r.closed&&r.unlocks===1&&r.unlockReturn!==null)&&
  owner.ledger.operations.every(o=>!['read','closed','cancel','read_observer'].includes(o.kind)||readers.includes(o.binding)&&
   (o.kind==='closed'||o.kind==='read_observer'?o.kind==='closed'||owner.ledger.operations.includes(o.originalRecord)&&o.originalRecord.kind==='read'&&o.originalRecord.binding===o.binding&&o.originalRead===o.originalRecord.pending&&o.pending!==o.originalRead:
    o.fn===o.binding.originals[o.kind]&&o.receiver===o.binding.reader));
 return {requests,transports,readers,register,current,owns,transport,response,reader,bound,retire,
  intact,
  run(token,fn){if(!owns(token))throw Error('foreign private invocation');return context.run(token,fn);},
  seal(){return owner.ledger.freeze([requests,transports,readers,owner.calls,owner.timeline,owner.authority,owner.inspections].filter(Array.isArray));},validate(){return owner.ledger.validate();}};
}
export async function privateControlResponse(response,consume,decode,record=(_kind,fn,receiver,args)=>Reflect.apply(fn,receiver,args)){
 const failures=[];let value,consumed=false;
 try{const original=record('control_body',consume,response,[]);value=await original;consumed=true;value=decode(value);}catch(error){failures.push(error);
  if(!consumed)try{const body=response.body;if(body)await record('control_cancel',body.cancel,body,[]);}catch(cleanup){failures.push(cleanup);}}
 if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'private control response and cleanup');return value;
}
export async function retirePrivateWorkerOwner(s,proof,accounting,locked){
 const stageFailures=[];let source,usage;
 const producerStatus=[0,false,null],accountingStatus=[0,false,null];
 const attempt=async(fn,status)=>{if(status)status[0]=1;try{const value=await fn();if(status)status[0]=2;return {ok:true,value};}catch(error){stageFailures.push(error);if(status){status[0]=3;status[1]=true;status[2]=error!==undefined;}return {ok:false};}};
 await attempt(()=>s.ledger.drain());
 const result=await attempt(proof,producerStatus);if(result.ok)source=result.value;
 const controlJoin=await attempt(()=>s.ledger.drain());
 const census=source&&source.joined===true&&source.pending===0&&source.faults===0&&source.expired===0&&source.held===0&&
  source.requests===source.calls?.length&&source.requests===s.calls.length&&Array.isArray(source.census)&&source.census.length===source.requests&&
  source.census.every((r,i)=>r.index===i&&r.originals>0&&r.cancels<=1&&(!r.producer||r.finished))&&
  s.calls.every(c=>s.calls.filter(x=>x.method===c.method&&x.path===c.path).length===source.calls.filter(x=>x.method===c.method&&x.path===c.path&&x.originalKey===true).length);
 if(!census)stageFailures.push(Error('private producer ownership or retirement incomplete'));
 // Accounting is independent of the strict data-rejection verdict, but never precedes physical joins.
 const physical=controlJoin.ok&&s.ledger.facts().pending===0&&s.ledger.faults.length===0&&s.ownership.intact();
 if(!physical)stageFailures.push(Error('private resource ownership or joins incomplete'));
 if(census&&physical){const a=await attempt(accounting,accountingStatus);if(a.ok)usage=a.value;}
 await attempt(()=>s.ledger.drain());
 for(const r of s.readers)await attempt(()=>{r.locked=locked(r);if(r.unlocks!==1||r.locked)throw Error('private reader not retired');});
 for(const restore of s.restores.toReversed())await attempt(restore);
 await attempt(()=>s.ledger.drain());
 let observation=null;try{
 const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=65535?value:null;
 const available=accountingStatus[0]===2&&Array.isArray(usage?.events);
 observation={producer:[...producerStatus,source?.joined??null,...['pending','faults','expired','held','requests','originals','observers','canceled','settled'].map(k=>count(source?.[k])),!!census],
  accounting:[...accountingStatus,available,available?count(usage.events.length):null,physical]};
 }catch(error){stageFailures.push(error);}
 s.retirementFailures=[...s.ledger.values(),...stageFailures];
 await attempt(()=>s.ownership.retire());
 // The baseline is after the intended lifetime transition, never after a later mutation.
 if(stageFailures.length+s.ledger.values().length!==s.retirementFailures.length)s.retirementFailures=[...s.ledger.values(),...stageFailures];
 try{if(!s.ownership.seal())throw Error('invalid private retirement seal');}catch(error){s.retirementFailures.push(error);}
 return {source,usage,observation,retired:s.retirementFailures.length===0};
}
export function privateWorkerOperationFacts(s){
 const bad=s.ledger.operations.filter(o=>o.errorPresent),selected=bad.slice(0,4);
 const rows=selected.map(o=>{const r=s.readers.find(r=>r===o.binding),t=r?.transport??s.ownership.transports.find(t=>t===o.binding);
  const token=r?.token??t?.token??s.ownership.requests.find(r=>r.token===o.binding)?.token;
  const request=s.ownership.requests.find(r=>r.token===token);
  const bound=o.owner===s&&s.ledger.operations[o.id]===o&&(o.binding===null||!!r||!!t||!!request)&&(!['read','closed','cancel','read_observer'].includes(o.kind)||!!r)&&(!token||!!request&&token.owner===s&&token.request===request.request&&token.generation===s.generation)&&
   (!r||r.request===request?.request&&r.transport===t&&r.response===t.response&&r.body===t.body&&r.token===t.token);
  const p=o.kind==='read'?o:s.ledger.operations.find(p=>p===o.originalRecord&&p.kind==='read'&&p.pending===o.originalRead&&p.binding===o.binding);
  return {op:o.id,kind:o.kind,state:o.state,present:o.errorPresent,defined:o.error!==undefined,bound,request:request?.id??null,acq:t?.id??null,reader:r?.id??null,
   invocation:o.invocation,settlement:o.settlement,callbackEntered:p?.callbackEntered??null,read:p?.id??null,closed:r?.closedRecord?.id??null,
   originalClosed:r? r.closedRecord?.pending===r.closed:null,originalRead:o.kind==='read_observer'?!!p:null,
   sameReadReason:p?.errorPresent?Object.is(p.error,o.error):null,cancelArgc:o.kind==='cancel'?o.args.length:null};});
 return {rows,omitted:bad.length-selected.length,originals:s.ledger.operations.length,pending:s.ledger.facts().pending,faults:s.ledger.faults.length};
}
export function privateWorkerCheckpointRecords(proof,row,index){
 if(!proof||proof.id!==row.id||!proof.diagnostic)return [];
 const d=proof.diagnostic;if(!Array.isArray(d.rows)||d.rows.length>4||!Number.isSafeInteger(d.omitted)||d.omitted<0||d.omitted>65535)throw Error('invalid private operation coverage');
 const phases={read:'read',closed:'closed',cancel:'cancel',read_observer:'observer'};
 if(d.rows.some(o=>o.bound!==true))return [];
 return d.rows.map(o=>{if(!Number.isSafeInteger(o.op)||o.op<0||o.op>=4096||o.present!==true||typeof o.defined!=='boolean'||!['rejected','threw'].includes(o.state)||
  !(o.acq===null||Number.isSafeInteger(o.acq)&&o.acq>=0&&o.acq<4096))throw Error('invalid private operation checkpoint');
  return {v:1,pin:privateCatalogPin,lane:'outer',case:index,phase:phases[o.kind]??'original_join',state:o.state,defined:o.defined,acq:o.acq,op:o.op,count:d.omitted};});
}

const router=`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {AsyncLocalStorage} from 'node:async_hooks';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {ingestUsage,usageSnapshot} from './worker/ledgers.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {sha256Hex} from './worker/utils.ts';
${createPrivateOperationLedger.toString()}
${createPrivateRequestOwnership.toString()}
${privateControlResponse.toString()}
${retirePrivateWorkerOwner.toString()}
${privateWorkerOperationFacts.toString()}
${joinPrivateOriginals.toString()}
const states=new Map(),nativeFetch=globalThis.fetch,requestContext=new AsyncLocalStorage();
const bases={baseten:'https://inference.baseten.co/v1',arcee:'https://api.arcee.ai/api/v1',novita:'https://api.novita.ai/openai/v1'};
function observe(s,p,kind,binding=null,extra={}){s.ledger.retain(kind,p,binding,extra);return p;}
function invoke(s,kind,run,binding=null){return s.ledger.invoke(kind,run,undefined,[],binding);}
async function control(s,kind){const response=await invoke(s,'control_fetch',()=>Reflect.apply(nativeFetch,globalThis,['https://private-control.fixture/'+kind+'/'+s.id,{method:'POST',body:JSON.stringify(s.row)}]));
 return privateControlResponse(response,response.json,value=>{if(response.status!==200)throw Error('private producer control failed');return value;},(kind,fn,receiver,args)=>s.ledger.invoke(kind,fn,receiver,args));}
function patch(s,object,name,value){const descriptor=Object.getOwnPropertyDescriptor(object,name),inherited=object[name];Object.defineProperty(object,name,{configurable:true,writable:true,value});s.restores.push(()=>{
 const current=Object.getOwnPropertyDescriptor(object,name);if(!current||current.value!==value)throw Error('foreign original descriptor');
 if(descriptor)Object.defineProperty(object,name,descriptor);else delete object[name];
 const restored=Object.getOwnPropertyDescriptor(object,name);if(descriptor?!restored||Reflect.ownKeys(descriptor).some(k=>!Object.is(descriptor[k],restored[k])):restored!==undefined||object[name]!==inherited)throw Error('private descriptor restoration failed');});}
async function mutate(s,kind){
 const admin={scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'}};
 if(kind==='caller_revoke')for(const suffix of ['inference','discovery','alternate'])await authorityCall(s.env,'/credentials/mutate',{...admin,credentialId:s.id+'_'+suffix,operation:'revoke'});
 else if(kind==='rotation')for(const suffix of ['inference','discovery','alternate'])await authorityCall(s.env,'/credentials/mutate',{...admin,credentialId:s.id+'_'+suffix,operation:'put',credential:{...s.credential,secretSha256:await sha256Hex('rotated-secret')}});
 else if(kind==='grant_revoke')await revokeGrantCredentials(s.env,s.grantKey);
 else if(kind==='narrow'||kind==='broaden'){const next={...s.policy,models:kind==='narrow'?[]:null};await authorityCall(s.env,'/policies/put',{policyId:s.id,policy:next});}
 else throw Error('unknown policy operation');
 s.mutated=true;s.timeline.push({phase:'mutation',sequence:++s.sequence});
}
globalThis.fetch=function(input,init){
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),headers=new Headers(init?.headers??input.headers),secret=headers.get('authorization');
 const matches=[...states.values()].filter(s=>secret==='Bearer synthetic-private-'+s.id);
 if(matches.length!==1)throw Error('unbound selected original private credential');const s=matches[0],token=s.ownership.current();
 if(url.href!==bases[s.row.provider]+'/models'&&url.href!==bases[s.row.provider]+'/chat/completions')throw Error('foreign private destination');
 const method=init?.method??input.method??'GET',transport=s.ownership.transport(token,secret,method,url.href);
 s.calls.push({request:s.ownership.requests.find(r=>r.token===token).id,method,path:url.pathname,query:!!url.search,bodyAbsent:(init?.body??input.body??null)===null,
  originalKey:secret==='Bearer synthetic-private-'+s.id,noCaller:!headers.has('x-api-key')&&!headers.has('x-upstream-url'),redirect:init?.redirect??input.redirect});
 const p=s.ledger.invoke('fetch',nativeFetch,this,arguments,transport);transport.pending=p;
 try{const q=p.then(response=>{const body=response.body;s.ownership.response(transport,response,body);if(!body)return;
  const get=body.getReader,cancel=body.cancel;
  patch(s,body,'cancel',function(){if(this!==body||!s.ownership.owns(token))s.ledger.fault(Error('foreign private body cancellation'));return s.ledger.invoke('body_cancel',cancel,this,arguments,transport);});
  patch(s,body,'getReader',function(){let reader;
   try{reader=Reflect.apply(get,this,arguments);}catch(error){s.ledger.fault(error);throw error;}
   try{const closed=reader.closed,originals=Object.freeze({read:reader.read,cancel:reader.cancel,releaseLock:reader.releaseLock});
    if(this!==body)throw Error('foreign private reader acquisition');
    const r=s.ownership.reader(transport,reader,body,originals);r.closed=closed;r.closedRecord=s.ledger.retain('closed',closed,r);
    for(const kind of ['read','cancel']){const original=originals[kind];patch(s,reader,kind,function(){
     if(!s.ownership.bound(r,kind,this,original))s.ledger.fault(Error('foreign private reader operation'));
     if(kind==='cancel'){r.cancels++;s.ledger.touch();if(r.cancels!==1)s.ledger.fault(Error('replayed private reader cancellation'));}
     const recordIndex=s.ledger.operations.length,originalP=s.ledger.invoke(kind,original,this,arguments,r),record=s.ledger.operations[recordIndex];
     if(kind==='read')try{const q=originalP.then(async chunk=>{record.callbackEntered=true;record.callbackEntry=s.ledger.touch();
       if(chunk.done){r.eof=true;s.timeline.push({phase:'eof',sequence:++s.sequence});return;}
       if(chunk.value.byteLength&&!s.prefix){s.prefix=true;s.timeline.push({phase:'prefix',sequence:++s.sequence});if(['narrow','broaden'].includes(s.row.scenario)){await mutate(s,s.row.scenario);await control(s,'complete');}}
      });
      s.ledger.retain('read_observer',q,r,{originalRead:originalP,originalRecord:record});
     }catch(error){s.ledger.fault(error);}return originalP;
    });}
    const release=originals.releaseLock;patch(s,reader,'releaseLock',function(){
     if(!s.ownership.bound(r,'releaseLock',this,release)||r.unlockEntry!==null)s.ledger.fault(Error('foreign or repeated private unlock'));
     r.unlockEntry=s.ledger.touch();r.pendingAtUnlock=s.ledger.operations.filter(o=>o.binding===r&&o.state==='pending').length;
     let value;try{value=Reflect.apply(release,this,arguments);}catch(error){s.ledger.fault(error);throw error;}
     r.unlocks++;r.unlockReturn=s.ledger.touch();s.timeline.push({phase:'unlock',sequence:++s.sequence});return value;});
   }catch(error){s.ledger.fault(error);}return reader;
  });
 });observe(s,q,'fetch_observer',transport,{originalRead:p});}catch(error){s.ledger.fault(error);}return p;
};
export default {async fetch(request,bindings,originalContext){const u=new URL(request.url),parts=u.pathname.split('/');
 if(parts[1]==='private-control'){
  const kind=parts[2],id=parts[3];
  if(kind==='setup'){
   const row=await request.json();if(states.has(id)||row.id!==id||!Object.hasOwn(bases,row.provider))throw Error('invalid private owner');
   const s={id,row,generation:Object.freeze({}),restores:[],calls:[],timeline:[],sequence:0,prefix:false,mutated:false,authority:[],inspections:[]};
   s.ledger=createPrivateOperationLedger(s);s.ownership=createPrivateRequestOwnership(s,requestContext);s.readers=s.ownership.readers;
   const models=['tenant/opaque-a','tenant/opaque-b'].flatMap(m=>[m,row.provider+'/'+m]);
   s.policy={enabled:true,generation:'g1',providers:[row.provider],models:row.scenario==='broaden'?models.slice(0,2):models,tenantId:'fixture',monthlyBudgetMicros:10000,
     ...(row.scenario==='unpriced'?{}:{requestCostMicros:7}),retainRequestContent:false,grantRouting:{eligibleGrants:{[row.provider]:[row.provider]},environmentFallback:true,failover:true}};
   s.credential={enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:id,policyGeneration:'g1'};
   const access=bindings.ACCESS_CONTROL,grants=bindings.GRANT_CREDENTIALS;
   s.env={...bindings,BASETEN_API_KEY:'synthetic-poison-env',ARCEE_API_KEY:'synthetic-poison-env',NOVITA_API_KEY:'synthetic-poison-env',USAGE_QUEUE:{send:e=>ingestUsage(bindings,e)},
    ACCESS_CONTROL:{idFromName:n=>access.idFromName(n),get:n=>{const stub=access.get(n);return {fetch(input,init){s.authority.push({path:new URL(typeof input==='string'?input:input.url).pathname,mutation:s.mutated,unlocked:s.readers.length>0&&s.readers.every(r=>r.eof&&r.unlocks===1&&!r.body.locked),sequence:++s.sequence});return invoke(s,'authority_fetch',()=>Reflect.apply(stub.fetch,stub,arguments));}};}},
    GRANT_CREDENTIALS:{idFromName:n=>grants.idFromName(n),get:n=>{const stub=grants.get(n);return {fetch(input,init){s.inspections.push({path:new URL(typeof input==='string'?input:input.url).pathname,mutation:s.mutated,sequence:++s.sequence});return invoke(s,'grant_fetch',()=>Reflect.apply(stub.fetch,stub,arguments));}};}}};
   await authorityCall(s.env,'/policies/put',{policyId:id,policy:s.policy});
   for(const suffix of ['inference','discovery','alternate']){const r=await authorityCall(s.env,'/credentials/mutate',{credentialId:id+'_'+suffix,scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'},operation:'put',credential:s.credential});if(r.outcome!=='updated')throw Error('credential setup refused');}
   await authorityCall(s.env,'/connections/initialize-all',Object.keys(bases).map(providerId=>({providerId,enabled:true,monthlyBudgetMicros:10000})));
   s.grantKey='oauth/'+id+'/'+row.provider;await putGrantCredentials(s.env,s.grantKey,{provider:row.provider,kind:'api_key',enabled:true,credential:'synthetic-private-'+id});
   states.set(id,s);await control(s,'setup');return Response.json({ready:true});
  }
  const s=states.get(id);if(!s)throw Error('missing private owner');
  if(kind==='mutate'){await mutate(s,(await request.json()).kind);return Response.json({mutated:true});}
  if(kind==='state')return Response.json({calls:s.calls.length,prefix:s.prefix});
  if(kind==='complete')return Response.json(await control(s,'complete'));
  if(kind==='join'){
   if(!s.retirement)s.retirement=(async()=>{const outcome=await retirePrivateWorkerOwner(s,()=>control(s,'proof'),()=>usageSnapshot(bindings,'fixture',s.id,{kind:'admin'}),r=>r.body.locked);
    return {id:s.id,observation:outcome.observation,diagnostic:privateWorkerOperationFacts(s),retired:outcome.retired,operations:s.ledger.operations.map(o=>({kind:o.kind,state:o.state})),calls:s.calls,requests:s.ownership.requests.map(r=>({id:r.id,requestId:r.requestId,status:r.status,credential:r.credential})),source:outcome.source??null,events:outcome.usage?.events??[],charged:bodyBudgetCharged(),timeline:s.timeline,authority:s.authority,inspections:s.inspections,readers:s.readers.map(r=>({unlocks:r.unlocks,eof:r.eof,locked:r.locked}))};})();
   const proof=await s.retirement;if(!s.ownership.validate())throw Error('changed private retirement lifetime');return Response.json(proof,{status:proof.retired?200:500});
  }throw Error('unknown private control');
 }
 const auth=request.headers.get('authorization')??'',matches=[...states.values()].filter(s=>['inference','discovery','alternate'].some(k=>auth.startsWith('Bearer clawrouter-live-'+s.id+'_'+k+'-')));
 if(matches.length!==1)throw Error('unbound caller');const s=matches[0];if(s.retirement)throw Error('late request');
 const credential=['inference','discovery','alternate'].find(k=>auth.startsWith('Bearer clawrouter-live-'+s.id+'_'+k+'-')),token=s.ownership.register(request,credential);
 const context={waitUntil:p=>{observe(s,p,'waitUntil',token);originalContext.waitUntil(p);}};
 const pending=s.ownership.run(token,()=>s.ledger.invoke('handler',worker.fetch,worker,[request,s.env,context],token));
 try{observe(s,pending.then(response=>{const r=s.ownership.requests.find(r=>r.token===token);if(!r||r.request!==request||r.requestId!==null)throw Error('foreign private publication');r.requestId=response.headers.get('x-clawrouter-request-id');r.status=response.status;s.timeline.push({phase:'publication',sequence:++s.sequence});}),'publication_observer',token,{originalRead:pending});}catch(error){s.ledger.fault(error);}return pending;
},queue:worker.queue};`;

const upstream=`
${createPrivateOperationLedger.toString()}
const states=new Map(),bases={baseten:'https://inference.baseten.co/v1',arcee:'https://api.arcee.ai/api/v1',novita:'https://api.novita.ai/openai/v1'};
function row(provider,id){return provider==='arcee'?{id,name:id,context_length:1024,max_output_length:512,input_modalities:['text'],output_modalities:['text']}:provider==='novita'?{id,object:'model',created:1,context_size:1024}:{id};}
async function upstreamControl(request,u){const [,kind,id]=u.pathname.split('/');if(kind==='setup'){const cfg=await request.json();
 const s={...cfg,requests:[],calls:[],held:0,canceled:0,expired:0,settled:0};s.ledger=createPrivateOperationLedger(s);states.set(id,s);return Response.json({ready:true});}
 const s=states.get(id);if(!s)throw Error('missing upstream owner');
 if(kind==='complete'){if(s.sealed)throw Error('retired private producer');const active=s.requests.filter(r=>r.complete&&!r.finished);if(active.length!==1)throw Error('no unique pending source');active[0].complete();return Response.json({accepted:true});}
 if(kind==='proof'){await s.ledger.drain();s.ledger.assert();
  if(s.requests.some(r=>r.owner!==s||!r.request||r.call!==s.calls[r.index]||!r.finished&&r.producer))throw Error('foreign or unfinished source request');
  if(!s.sealed){s.settled=s.requests.filter(r=>r.producer&&r.finished).length;s.sealed=true;s.ledger.freeze([s.requests,s.calls]);}
  if(!s.ledger.validate())throw Error('changed private producer lifetime');
  return Response.json({calls:s.calls,held:s.held,canceled:s.canceled,expired:s.expired,settled:s.settled,joined:true,pending:s.ledger.facts().pending,
   originals:s.ledger.operations.length,observers:s.ledger.observers.length,faults:s.ledger.values().length,requests:s.requests.length,
   census:s.requests.map(r=>({index:r.index,originals:s.ledger.operations.filter(o=>o.binding===r).length,cancels:r.cancels,producer:r.producer!==null,finished:r.finished,explicitRelease:r.explicitRelease}))});}
 throw Error('unknown source control');}
async function upstreamProduct(request,s,u,r){const base=bases[s.provider];
 if(u.search||![base+'/models',base+'/chat/completions'].includes(u.href))throw Error('foreign original destination');const chat=u.pathname.endsWith('/chat/completions');
 const body=chat?await s.ledger.invoke('request_body',request.json,request,[],r):null;
 const call={method:request.method,path:u.pathname,query:!!u.search,chat,model:body?.model??null,stream:body?.stream??null,originalKey:true};r.call=call;s.calls[r.index]=call;s.ledger.touch();
 if(!chat){if(s.scenario==='redirect')return new Response(null,{status:302,headers:{location:'https://foreign.fixture/models'}});
  if(s.scenario==='malformed')return Response.json({data:[{}]});if(s.scenario==='truncated')return new Response('{"data":[',{headers:{'content-type':'application/json'}});
  if(s.scenario==='oversize')return new Response(' '.repeat(2*1024*1024+1),{headers:{'content-type':'application/json'}});
  const payload={data:(s.scenario==='empty'?[]:['tenant/opaque-a','tenant/opaque-b']).map(id=>row(s.provider,id))};
  if(!['narrow','broaden','shared_abort'].includes(s.scenario))return Response.json(payload);
  const text=JSON.stringify(payload),prefix='{"data":[';
  const pull=function(c){if(r.producer)return r.producer;
   let notify;const notification=new Promise(resolve=>{notify=resolve;});s.ledger.retain('source_notification',notification,r);
   let timer;r.complete=()=>{r.explicitRelease=true;s.ledger.touch();notify('complete');};
   timer=setTimeout(()=>{s.expired++;s.ledger.touch();notify('expired');},10000);
   r.cancel=()=>{clearTimeout(timer);notify('cancel');};
   r.producer=notification.then(command=>{clearTimeout(timer);if(command==='expired'){c.error(Error('fixture expired'));throw Error('fixture expired');}
    if(command==='complete'){c.enqueue(new TextEncoder().encode(text.slice(prefix.length)));c.close();}r.finished=true;s.held--;s.ledger.touch();});
   s.ledger.retain('source_continuation',r.producer,r,{originalRead:notification});return r.producer;
  };
  const cancel=function(){r.cancels++;s.canceled++;s.ledger.touch();r.cancel?.();};
  return new Response(new ReadableStream({start(c){s.held++;c.enqueue(new TextEncoder().encode(prefix));},pull(c){return s.ledger.invoke('source_pull',pull,this,arguments,r);},cancel(){return s.ledger.invoke('source_cancel',cancel,this,arguments,r);}}),{headers:{'content-type':'application/json'}});
 }
 const frame=v=>'data: '+JSON.stringify(v)+'\\n\\n',prefix=frame({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:'private-prefix'},finish_reason:null}]});
 if(s.scenario==='provider_error')return new Response(prefix+frame({error:{message:'fixture provider rejected',type:'server_error'}}),{headers:{'content-type':'text/event-stream'}});
 if(['stream_abort','simple_abort'].includes(s.scenario)){
  const pull=function(c){if(r.producer)return r.producer;r.producer=new Promise((resolve,reject)=>{r.resolve=resolve;r.timer=setTimeout(()=>{s.expired++;s.held--;r.finished=true;s.ledger.touch();c.error(Error('fixture expired'));reject(Error('fixture expired'));},10000);});
   s.ledger.retain('source_producer',r.producer,r);return r.producer;};
  const cancel=function(){r.cancels++;s.canceled++;clearTimeout(r.timer);s.held--;r.finished=true;s.ledger.touch();r.resolve?.();};
  return new Response(new ReadableStream({start(c){s.held++;c.enqueue(new TextEncoder().encode(prefix));},pull(c){return s.ledger.invoke('source_pull',pull,this,arguments,r);},cancel(){return s.ledger.invoke('source_cancel',cancel,this,arguments,r);}}),{headers:{'content-type':'text/event-stream'}});
 }
 return new Response(prefix+frame({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}})+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
}
export default {fetch(request){const u=new URL(request.url);if(u.hostname==='private-control.fixture')return upstreamControl(request,u);
 const auth=request.headers.get('authorization'),matches=[...states.values()].filter(s=>auth==='Bearer synthetic-private-'+s.id);if(matches.length!==1)throw Error('foreign source credential');const s=matches[0];if(s.sealed){s.ledger.fault(Error('late private producer request'));throw Error('late private producer request');}
 const r={owner:s,request,index:s.requests.length,call:null,producer:null,finished:false,cancels:0,explicitRelease:false};s.requests.push(r);s.ledger.touch();
 return s.ledger.invoke('source_handler',upstreamProduct,undefined,[request,s,u,r],r);
}};`;

export async function startPrivateCatalogFixture(){const directory=await mkdtemp(join(tmpdir(),'private-catalog-client-'));let runtime,origin;
 try{runtime=await startWorkerdFixture(directory,router,upstream,{requestContext:true,directRouter:true});origin=(await runtime.unsafeGetDirectURL('router')).origin;}catch(error){await finishPrivateOwned(()=>{throw error;},[...(runtime===undefined?[]:[()=>runtime.dispose()]),()=>rm(directory,{recursive:true,force:true})]);}
 const evidence=new Map();
 const command=async(row,kind,body={})=>{const response=await fetch(origin+'/private-control/'+kind+'/'+row.id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return privateControlResponse(response,response.text,text=>{const value=JSON.parse(text);if(kind==='join'&&value.id===row.id)evidence.set(row,value);assert.equal(response.status,200,'private fixture control failed');return value;});};
 return {origin,setup:row=>command(row,'setup',row),join:row=>command(row,'join'),evidence:row=>evidence.get(row),close:()=>finishPrivateOwned(()=>{},[()=>runtime.dispose(),()=>rm(directory,{recursive:true,force:true})])};
}
// Predicate IDs are fixture source coordinates, not native case/operation identity.
export const privateReceiptPredicates=Object.freeze([
 'retired','original_fulfilled','reader_unlock_once','reader_unlocked','charged_zero','producer_held_zero','producer_expired_zero','producer_joined','producer_pending_zero','producer_faults_zero','request_census',
 'original_key','no_caller_credentials','manual_redirect','no_query','get_body_absent','event_provider','event_policy','discovery_model_null','discovery_reserved_zero','discovery_actual_zero','inference_actual_seven','inference_fixed_basis','reporting_cost_unknown','inference_tokens_seven',
 'mutation_publication_present','refresh_inspect_present','authority_order','held_settled_once','partial_canceled_once','partial_settled_once','partial_one_unreleased_producer','shared_settled_once','shared_not_canceled',
]);
export function createPrivateReceiptWitness(){
 const evaluated=[0,0],passed=[0,0],failed=[0,0];let first=null,candidate=null;
 const bit=id=>[Math.floor(id/17),2**(id%17)];
 const enter=id=>{const [i,b]=bit(id);evaluated[i]|=b;};
 const pass=id=>{const [i,b]=bit(id);if(!(failed[i]&b))passed[i]|=b;};
 const reject=id=>{const [i,b]=bit(id);failed[i]|=b;passed[i]&=~b;};
 const fail=(id,ordinal,kind,error)=>{reject(id);first??=[id,ordinal,kind,error!==undefined];};
 return {test(id,ordinal,fn){enter(id);try{const value=fn();if(value)pass(id);else{reject(id);candidate??=[id,ordinal];}return value;}catch(error){fail(id,ordinal,1,error);throw error;}},
  check(id,ordinal,operand,assertion){candidate=null;enter(id);let value;
   try{value=operand();}catch(error){fail(id,ordinal,1,error);throw error;}
   try{const result=assertion(value);pass(id);return result;}catch(error){fail(...(candidate??[id,ordinal]),0,error);throw error;}},
  snapshot(){return {first:first&&[...first],evaluated:[...evaluated],passed:[...passed]};}};
}
export function assertPrivateReceipt(row,p,w=createPrivateReceiptWitness()){
 const equal=(id,n,read,expected)=>w.check(id,n,read,value=>assert.equal(value,expected));
 const ok=(id,read)=>w.check(id,null,read,value=>assert.ok(value));
 equal(0,null,()=>p.retired,true);
 ok(1,()=>p.operations.every((o,i)=>w.test(1,i,()=>o.state==='fulfilled')));
 ok(2,()=>p.readers.every((r,i)=>w.test(2,i,()=>r.unlocks===1)&&w.test(3,i,()=>!r.locked)));
 equal(4,null,()=>p.charged,0);equal(5,null,()=>p.source.held,0);equal(6,null,()=>p.source.expired,0);equal(7,null,()=>p.source.joined,true);
 equal(8,null,()=>p.source.pending,0);equal(9,null,()=>p.source.faults,0);w.check(10,null,()=>[p.source.requests,p.calls.length],([a,b])=>assert.equal(a,b));
 let callAt=0;for(const c of p.calls){const i=callAt++;equal(11,i,()=>c.originalKey,true);equal(12,i,()=>c.noCaller,true);equal(13,i,()=>c.redirect,'manual');equal(14,i,()=>c.query,false);if(c.method==='GET')equal(15,i,()=>c.bodyAbsent,true);}
 let eventAt=0;for(const e of p.events){const i=eventAt++;equal(16,i,()=>e.provider,row.provider);equal(17,i,()=>e.policy_id,row.id);
  if(e.capability==='models.list'){equal(18,i,()=>e.model,null);equal(19,i,()=>e.reserved_cost_micros,0);equal(20,i,()=>e.actual_cost_micros,0);}
  else if(e.status==='success'){equal(21,i,()=>e.actual_cost_micros,7);equal(22,i,()=>e.cost_basis,'policy_fixed');equal(23,i,()=>e.reporting_known_cost_micros,null);equal(24,i,()=>e.total_tokens,7);}}
 if(['narrow','broaden'].includes(row.scenario)){const mutation=p.timeline.find(t=>t.phase==='mutation'),publication=p.timeline.find(t=>t.phase==='publication');ok(25,()=>mutation&&publication);
  const refresh=p.authority.find(r=>r.path==='/authorization/snapshot'&&r.mutation&&r.unlocked),inspect=p.inspections.find(r=>r.path==='/inspect'&&r.mutation);ok(26,()=>refresh&&inspect);
  ok(27,()=>mutation.sequence<refresh.sequence&&refresh.sequence<inspect.sequence&&inspect.sequence<publication.sequence);equal(28,null,()=>p.source.settled,1);}
 if(['stream_abort','simple_abort'].includes(row.scenario)){equal(29,null,()=>p.source.canceled,1);equal(30,null,()=>p.source.settled,1);equal(31,null,()=>p.source.census.filter(r=>r.producer&&r.cancels===1&&r.finished&&!r.explicitRelease).length,1);}
 if(row.scenario==='shared_abort'){equal(32,null,()=>p.source.settled,1);equal(33,null,()=>p.source.canceled,0);}// Explicit completion, not disconnect proof.
 assertPrivateUsage(row,p);
}
export function assertPrivateUsage(row,p){
 // Bind events to the actual ingress response and dispatch, not the number of
 // upstream calls alone: denied attempts can legitimately emit extra events.
 assert.ok(Array.isArray(p.requests));
 assert.equal(new Set(p.requests.map(r=>r.requestId)).size,p.requests.length);
 const byId=new Map(p.requests.map((r,i)=>{assert.equal(r.id,i);assert.equal(typeof r.requestId,'string');assert.ok(r.requestId.length>0);
  assert.ok(Number.isInteger(r.status)&&r.status>=100&&r.status<=599);return [r.requestId,r];}));
 const seen=new Set();
 for(const e of p.events){
  const r=byId.get(e.request_id);assert.ok(r,'usage event must belong to an original ingress response');
  assert.ok(!seen.has(e.request_id),'duplicate usage event');seen.add(e.request_id);
  assert.equal(e.provider,row.provider);assert.equal(e.policy_id,row.id);assert.equal(e.key_id,row.id+'_'+r.credential);
  assert.equal(e.status_code,r.status);
  const calls=p.calls.filter(c=>c.request===r.id);assert.ok(calls.length<=1,'unexpected repeat dispatch');
  if(calls.length===0){assert.ok(r.status>=400);assert.notEqual(e.status,'success');assert.equal(e.reserved_cost_micros,0);assert.equal(e.actual_cost_micros,0);continue;}
  const discovery=calls[0].method==='GET';assert.equal(e.capability,discovery?'models.list':'llm.chat');
  if(discovery){assert.equal(e.model,null);assert.equal(e.reserved_cost_micros,0);assert.equal(e.actual_cost_micros,0);}
  else {
   assert.equal(r.status,200);assert.equal(e.reserved_cost_micros,7);assert.equal(e.actual_cost_micros,7);assert.equal(e.cost_basis,'policy_fixed');
   assert.equal(e.status,['stream_abort','simple_abort'].includes(row.scenario)?'client_error':row.scenario==='provider_error'?'provider_error':'success');
  }
 }
 for(const c of p.calls){const r=p.requests[c.request];assert.ok(r&&r.id===c.request,'dispatch must retain its original ingress');
  assert.ok(seen.has(r.requestId),'dispatched request must have its exact usage event');}
}
export function reportPrivateJoinFailure(report,row,index,evidence,recordOriginals,primary){
 const failures=[primary];let proof;
 try{proof=evidence();if(proof!==undefined){if(!proof||proof.id!==row.id)throw Error('foreign Private retirement evidence');
  if(proof.observation!==null&&proof.observation!==undefined)report.receipt(index,{first:null,evaluated:[0,0],passed:[0,0]},proof.observation);}}
 catch(error){failures.push(error);}
 try{recordOriginals(proof);}catch(error){failures.push(error);}
 if(failures.length===1)throw primary;throw new AggregateError(failures,'private retirement and bounded reporting');
}
export function reportPrivateReceiptFailure(report,row,index,proof,evidence,witness,error){
 const failures=[error];
 try{if(evidence()!==proof||!proof||proof.id!==row.id)throw Error('foreign Private receipt evidence');report.receipt(index,witness.snapshot(),proof.observation);}catch(reporting){failures.push(reporting);}
 for(const run of [()=>report.mark(index,'assertions','rejected',error),()=>report.flush(index)])try{run();}catch(reporting){failures.push(reporting);}
 if(failures.length===1)throw error;throw new AggregateError(failures,'Private receipt and diagnostic failures');
}
// Inert dependencies for exact extracted fixture callbacks; no Worker or stream runtime.
export function privateExecFunctions(){
 const source=readFileSync(new URL('./helpers/openclaw-consumer.mjs',import.meta.url),'utf8');
 const start=source.indexOf('export function validatePrivateExecRequest('),end=source.indexOf('export function validateRunnerRequest(');
 const code=source.slice(start,end)+source.slice(source.indexOf('export async function withCopiedConsumerFixture('));
 return new Function('assert','Buffer','constants','types','sha256',code.replace(/^export /gm,'')+';return {validatePrivateExecRequest,readCopiedPrivateFixture,privateExecProcessFields,observePrivateExec,withCopiedConsumerFixture};')(
  assert,Buffer,{O_RDONLY:0,O_NOFOLLOW:1},privateNodeTypes,bytes=>createHash('sha256').update(bytes).digest('hex'));
}
export function privateInertOwner(){
 const s={id:'inert',row:{provider:'baseten',scenario:'eof'},generation:Object.freeze({}),restores:[],calls:[],timeline:[],sequence:0,prefix:false,mutated:false,authority:[],inspections:[]};
 const context={value:undefined,getStore(){return this.value;},run(token,fn){const previous=this.value;this.value=token;try{return fn();}finally{this.value=previous;}}};
 s.ledger=createPrivateOperationLedger(s);s.ownership=createPrivateRequestOwnership(s,context);s.readers=s.ownership.readers;return {s,context};
}
export async function privateInertReader(read,closed=Promise.resolve()){
 const {s,context}=privateInertOwner(),request={},token=s.ownership.register(request,'discovery'),calls=[];
 const body={locked:true,cancel(){calls.push(['body_cancel',this,[...arguments]]);return Promise.resolve();},getReader(){calls.push(['getReader',this,[...arguments]]);return reader;}};
 const reader={closed,read(){calls.push(['read',this,[...arguments]]);return Reflect.apply(read,this,arguments);},cancel(){calls.push(['cancel',this,[...arguments]]);return Promise.resolve();},releaseLock(){calls.push(['release',this,[...arguments]]);body.locked=false;}};
 const nativeFetch=function(){calls.push(['fetch',this,[...arguments]]);return Promise.resolve({body});};
 const helpers=router.slice(router.indexOf('function observe(s,p,kind,'),router.indexOf('async function mutate'));
 const wrapper=router.slice(router.indexOf('globalThis.fetch=function(input,init){'),router.indexOf('export default {async fetch(request,bindings,originalContext)'));
 class FakeURL{constructor(value){this.href=value;this.pathname='/v1/models';this.search='';}}
 class FakeHeaders{constructor(value){this.value=value;}get(key){return this.value[key]??null;}has(key){return Object.hasOwn(this.value,key);}}
 const sandbox={states:new Map([[s.id,s]]),nativeFetch,bases:{baseten:'https://inference.baseten.co/v1'},URL:FakeURL,Headers:FakeHeaders,privateControlResponse,mutate(){throw Error('unexpected inert mutation');}};
 const fetch=runInNewContext(helpers+wrapper+';globalThis.fetch',sandbox);
 const response=await s.ownership.run(token,()=>Reflect.apply(fetch,sandbox,['https://inference.baseten.co/v1/models',{headers:{authorization:'Bearer synthetic-private-inert'}}]));
 const actual=s.ownership.run(token,()=>response.body.getReader());return {s,context,token,request,body,reader:actual,calls};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
// Frozen E2 source vectors exercise the actual overlays without SDK imports.
const privateExecutionOriginals = [
  "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",
].map(value => inflateSync(Buffer.from(value, "base64")));

function privateExecutionWitness() {
 const text=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
 const start=text.indexOf('export function createPrivateExecutionWitness('),end=text.indexOf('// Only these two pinned defining namespaces');
 assert.ok(start>0&&end>start);
 return new Function(stripTypeScriptTypes(text.slice(start,end).replace(/^export /gm,''),{mode:'strip'})+';return createPrivateExecutionWitness;')();
}

test('Private execution observations bind the actual selection and original host/guard references',()=>{
 for(const mode of [1,2]){
  const faults=[],model={},invocation={args:[model]},context={invocation},host=()=>{},guard=()=>{},normal=()=>{},simple=()=>{};let reads=0;
  const w=privateExecutionWitness()('a'.repeat(64),()=>{reads++;return context;},{guard},faults);w.host(host);
  const record={stream:normal,streamSimple:simple},input={};
  w.channel.observe(1,{},3,[record]);w.bind(invocation);
  w.channel.observe(0,{},mode,[record,mode===1?normal:simple,model]);
  w.channel.observe(2,{},4,[host,{}]);w.channel.observe(4,{},6,[guard,input]);w.channel.observe(3,{},5,[guard,input]);
  assert.deepEqual(w.snapshot(invocation),['a'.repeat(64),1,mode,1,1,1,1,1,1,0,0]);assert.equal(reads,4);assert.deepEqual(faults,[]);
 }
});
test('Private execution observations keep preexisting, foreign, mixed and absent generations unknown',()=>{
 const faults=[],model={},invocation={args:[model]},host=()=>{},guard=()=>{};let context;
 const w=privateExecutionWitness()('b'.repeat(64),()=>context,{guard},faults);w.host(host);w.bind(invocation);
 const record={stream(){}};context={invocation:{args:[model]}};w.channel.observe(0,{},1,[record,record.stream,model]);
 assert.deepEqual(w.snapshot(invocation).slice(1,9),Array(8).fill(0));context=undefined;w.channel.observe(2,{},4,[host,{}]);
 context={invocation};w.channel.observe(0,{},1,[record,record.stream,model]);
 w.channel.observe(2,{},4,[()=>{},{}]);assert.equal(w.snapshot(invocation)[4],2);
 w.channel.observe(2,{},4,[host,{}]);assert.equal(w.snapshot(invocation)[4],3);
 assert.equal(w.snapshot(invocation)[3],0);assert.equal(w.snapshot(invocation)[9],2);
 assert.equal(w.snapshot({}),null);w.close();assert.equal(w.snapshot(invocation),null);
});
test('Private execution host binding uses only the installer resolved callable and owns undefined getter failure',()=>{
 const source=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
 assert.equal(source.includes('const originalHostLookup='),false);
 assert.ok(source.includes('name==="getAiTransportHost"?execution?.host:undefined'));
 for(const failure of [false,true]){
  const module={},restores=[],faults=[],model={},invocation={args:[model]},result={},calls=[];let reads=0,caught=false;
  const a=function(...args){calls.push([this,args]);return result;},b=()=>{throw Error('second getter is forbidden');};
  Object.defineProperty(module,'getAiTransportHost',{configurable:true,enumerable:true,get(){reads++;if(failure)throw undefined;return reads===1?a:b;}});
  const original=Object.getOwnPropertyDescriptor(module,'getAiTransportHost');
  const w=privateExecutionWitness()('c'.repeat(64),()=>({invocation}),{guard(){}},faults);w.bind(invocation);
  const install=privateDefiningFactory(module,{},privateDefiningFakeVi());
  try{install(module,'getAiTransportHost',(fn,self,args)=>{w.channel.observe(2,{},4,[fn,result]);return Reflect.apply(fn,self,args);},restores,undefined,w.host);}
  catch(error){caught=true;assert.equal(error,undefined);}
  assert.equal(reads,1);assert.equal(caught,failure);
  if(failure){assert.equal(restores.length,0);assert.equal(w.snapshot(invocation)[4],0);}
  else{assert.equal(module.getAiTransportHost(1,undefined),result);assert.deepEqual(calls,[[module,[1,undefined]]]);assert.equal(reads,1);assert.equal(w.snapshot(invocation)[4],1);}
  for(const restore of restores.toReversed())restore();assert.deepEqual(Object.getOwnPropertyDescriptor(module,'getAiTransportHost'),original);assert.deepEqual(faults,[]);
 }
});
test('Private execution faults retain undefined independently and reject foreign selected models',()=>{
 const faults=[],invocation={args:[{}]};let fail=true;
 const w=privateExecutionWitness()('c'.repeat(64),()=>{if(fail)throw undefined;return {invocation};},{host(){},guard(){}},faults);w.bind(invocation);
 w.channel.observe(2,{},4,[()=>{},{}]);assert.deepEqual(faults,[undefined]);fail=false;
 w.channel.observe(0,{},1,[{},()=>{},{}]);assert.equal(faults.length,2);assert.equal(w.snapshot(invocation)[10],2);
 assert.equal(w.snapshot(invocation)[1],0);
});

function privateOverlayFunction(text,begin,end,names,values){
 const at=text.indexOf(begin);assert.ok(at>=0);const stop=end?text.indexOf(end,at+begin.length):text.length;assert.ok(stop>at);
 const code=stripTypeScriptTypes(text.slice(at,stop).replace(/^export /gm,''),{mode:'strip'});
 return new Function(...names,code+';return '+begin.match(/function (\w+)/)[1]+';')(...values);
}
test('Private execution overlays preserve actual E2 call operands, receiver, order, return and falsey throws',async()=>{
 const contract='d'.repeat(64),out=privateExecutionOriginals.map((b,i)=>overlayPrivateExecutionSource(i,b,contract).toString());
 for(let i=0;i<out.length;i++){
  assert.equal(createHash('sha256').update(privateExecutionOriginals[i]).digest('hex'),privateExecutionSources[i].sha256);
  assert.doesNotThrow(()=>stripTypeScriptTypes(out[i],{mode:'strip'}));
  assert.throws(()=>overlayPrivateExecutionSource(i,Buffer.concat([privateExecutionOriginals[i],Buffer.from(' ')]),contract));
 }
 for(const simple of [false,true])for(const failure of [false,true]){
  const traces=[];
  for(const source of [privateExecutionOriginals[0].toString(),out[0]]){
   const trace=[],result={},context={},options={},record={};const callable=function(...args){trace.push(['call',this===record,args[0]===model,args[1]===context,args[2]===options]);if(failure)throw undefined;return result;};
   const model={get api(){trace.push('api');return 'openai-completions';}};
   Object.defineProperty(record,simple?'streamSimple':'stream',{get(){trace.push('callee');return callable;}});
   const name=simple?'streamSimple':'stream',fn=privateOverlayFunction(source,'  function '+name+'<',simple?'  async function completeSimple':'  async function complete<',['startStream','resolveApiProvider','__privateE2Observe'],[f=>f(),()=>{trace.push('resolve');return record;},()=>{trace.push('observe');}]);
   if(failure)assert.throws(()=>fn(model,context,options),e=>e===undefined);else assert.equal(fn(model,context,options),result);
   traces.push(trace.filter(x=>x!=='observe'));
  }assert.deepEqual(traces[1],traces[0]);
 }
 for(const failure of [false,true]){
  const traces=[];
  for(const source of [privateExecutionOriginals[4].toString(),out[4]]){
   const trace=[],pool={},promise=Promise.resolve(),options={get url(){trace.push('url');return 'synthetic';}};
   const fn=privateOverlayFunction(source,'export function fetchWithProviderHttpGuard(', '/** Returns the current process-lifecycle', ['fetchWithSsrFGuard','getProviderTransportDispatcherPool','__privateE2Observe','__privateE2InvokeGuard'],[function(value){trace.push(['guard',this===undefined,value.url,value.dispatcherPool===pool]);if(failure)throw undefined;return promise;},()=>{trace.push('pool');return pool;},()=>{},(fn,input)=>Reflect.apply(fn,undefined,[input])]);
   if(failure)assert.throws(()=>fn(options),e=>e===undefined);else assert.equal(fn(options),promise);traces.push(trace);
  }assert.deepEqual(traces[1],traces[0]);
 }
 const traces=[];
 for(const source of [privateExecutionOriginals[1].toString(),out[1]]){
  const trace=[],factory=privateOverlayFunction(source,'function wrapStream<',null,['__privateE2Observe'],[()=>trace.push('observe')]);
  assert.equal(typeof factory,'function');
  const code=stripTypeScriptTypes(source.slice(source.indexOf('function wrapStream<')).replace(/^export /gm,''),{mode:'strip'});
  const registry=new Function('__privateE2Observe',code+';return createApiRegistry();')(()=>trace.push('observe'));
  const provider={get api(){trace.push('api');return 'openai-completions';},get stream(){trace.push('stream');return ()=>1;},get streamSimple(){trace.push('simple');return ()=>2;}};
  assert.equal(registry.registerApiProvider(provider,'synthetic'),undefined);traces.push(trace.filter(x=>x!=='observe'));
 }assert.deepEqual(traces[1],traces[0]);
});

test('Private E2 host and observer hooks preserve original undefined failures and scoped selection',()=>{
 const contract='a'.repeat(64),source=overlayPrivateExecutionSource(2,privateExecutionOriginals[2],contract).toString();
 const prefix=source.slice(0,source.indexOf('import '));
 for(const mode of ['absent','accessor','observer','reporter','descriptor']){
  const faults=[],scope={},global={};let observed=0;
  if(mode==='accessor')Object.defineProperty(global,Symbol.for('clawrouter.private.execution.'+contract),{get(){throw Error('must not read accessor');}});
  if(mode==='observer'||mode==='reporter')Object.defineProperty(global,Symbol.for('clawrouter.private.execution.'+contract),{value:{observe(){observed++;throw undefined;},fault(e){faults.push(e);if(mode==='reporter')throw undefined;}}});
  const intrinsics=mode==='descriptor'?{getOwnPropertyDescriptor(){throw undefined;}}:Object;
  const observer=new Function('Object','globalThis',stripTypeScriptTypes(prefix,{mode:'strip'})+';return __privateE2Observe;')(intrinsics,global);
  for(const result of [scope,null,undefined]){
   let reads=0;const fallback={},storage={getStore(){reads++;return result;}};
   const fn=privateOverlayFunction(source,'export function getAiTransportHost(', '/** Resolves sentinel', ['scopedAiTransportHost','activeAiTransportHost','__privateE2Observe'],[storage,fallback,observer]);
   assert.equal(fn(),result??fallback);assert.equal(reads,1);
  }
  const fn=privateOverlayFunction(source,'export function getAiTransportHost(', '/** Resolves sentinel', ['scopedAiTransportHost','activeAiTransportHost','__privateE2Observe'],[{getStore(){throw undefined;}},{},observer]);
  assert.throws(()=>fn(),e=>e===undefined);
  assert.equal(observed,mode==='observer'||mode==='reporter'?3:0);assert.deepEqual(faults,Array(observed).fill(undefined));
 }
});

function privateOverlayFS(root="/sdk"){
 const files=new Map(privateExecutionSources.map((r,i)=>[join(root,r.path),{bytes:Buffer.from(privateExecutionOriginals[i]),ino:i+1,clock:1,closes:0}]));
 const stat=r=>({dev:1,ino:r.ino,uid:process.getuid(),nlink:1,mode:0o100644,size:r.bytes.length,mtimeMs:r.clock,ctimeMs:r.clock,isFile:()=>true});
 let writes=0,closeFault=false,writeFault=false,syncFault=false,readbackFault=false;
 return {files,get writes(){return writes;},set closeFault(v){closeFault=v;},set writeFault(v){writeFault=v;},set syncFault(v){syncFault=v;},set readbackFault(v){readbackFault=v;},io:{realpath:async p=>resolve(p),lstat:async p=>stat(files.get(p)),open:async p=>{const r=files.get(p);return {
  stat:async()=>stat(r),read:async(b,o,n,pos)=>{if(readbackFault&&writes>0){readbackFault=false;throw undefined;}const size=Math.min(n,r.bytes.length-pos,257);if(size>0)r.bytes.copy(b,o,pos,pos+size);return {bytesRead:Math.max(0,size)};},
  write:async(b,o,n,pos)=>{if(writeFault){writeFault=false;throw undefined;}writes++;const size=Math.min(n,193),next=Buffer.alloc(Math.max(r.bytes.length,pos+size));r.bytes.copy(next);b.copy(next,pos,o,o+size);r.bytes=next;r.clock++;return {bytesWritten:size};},
  truncate:async n=>{r.bytes=r.bytes.subarray(0,n);r.clock++;},sync:async()=>{if(syncFault){syncFault=false;throw undefined;}},close:async()=>{r.closes++;if(closeFault){closeFault=false;throw undefined;}}
 };}}};
}
test('Private E2 overlay restores exact originals after success, falsey child failure and partial writes',async()=>{
 for(const mode of ['success','child','write','sync','readback','close','both']){
  const fs=privateOverlayFS();let calls=0,observed;
  if(mode==='write')fs.writeFault=true;if(mode==='sync')fs.syncFault=true;if(mode==='readback')fs.readbackFault=true;if(mode==='close'||mode==='both')fs.closeFault=true;
  try{observed=await withPrivateExecutionOverlay('/sdk','a'.repeat(64),async contract=>{calls++;assert.match(contract,/^[a-f0-9]{64}$/);for(const r of fs.files.values())assert.ok(r.bytes.includes(Buffer.from(contract)));if(mode==='child'||mode==='both')throw undefined;return 17;},fs.io);}
  catch(e){observed=e;}
  if(mode==='success')assert.equal(observed,17);else if(mode==='both'){assert.ok(observed instanceof AggregateError);assert.deepEqual(observed.errors,[undefined,undefined]);}else assert.equal(observed,undefined);
  assert.equal(calls,['write','sync','readback'].includes(mode)?0:1);for(const [i,r]of [...fs.files.values()].entries()){assert.ok(r.bytes.equals(privateExecutionOriginals[i]));assert.equal(r.closes,1);}
 }
});
test('Private E2 overlay accepts the workflow relative checkout only after canonical custody',async()=>{
 const root=resolve('.openclaw-contract'),fs=privateOverlayFS(root);let calls=0;
 const originalOpen=fs.io.open;fs.io.open=async path=>{assert.ok(path.startsWith(root+'/'));return originalOpen(path);};
 assert.equal(await withPrivateExecutionOverlay('.openclaw-contract','a'.repeat(64),()=>{calls++;return 19;},fs.io),19);
 assert.equal(calls,1);for(const [i,r]of [...fs.files.values()].entries()){assert.ok(r.bytes.equals(privateExecutionOriginals[i]));assert.equal(r.closes,1);}
 const foreign=privateOverlayFS(root);foreign.io.realpath=async()=>root+'-foreign';
 await assert.rejects(withPrivateExecutionOverlay('.openclaw-contract','a'.repeat(64),()=>{calls++;},foreign.io));assert.equal(calls,1);assert.equal(foreign.writes,0);
});
test('Private E2 overlay rejects bad pins before writes and preserves foreign modifications',async()=>{
 const fs=privateOverlayFS();fs.files.get('/sdk/'+privateExecutionSources[4].path).bytes=Buffer.from('foreign');let calls=0;
 await assert.rejects(withPrivateExecutionOverlay('/sdk','a'.repeat(64),()=>{calls++;},fs.io));assert.equal(fs.writes,0);assert.equal(calls,0);
 const changed=privateOverlayFS(),path='/sdk/'+privateExecutionSources[0].path;
 await assert.rejects(withPrivateExecutionOverlay('/sdk','a'.repeat(64),()=>{changed.files.get(path).bytes=Buffer.from('foreign');},changed.io),/overlay changed/);
 assert.equal(changed.files.get(path).bytes.toString(),'foreign');for(const r of changed.files.values())assert.equal(r.closes,1);
});
function privateExecutedGuardFactory(){
 const source=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
 const start=source.indexOf('export function createPrivateExecutedGuard('),end=source.indexOf('// Only these two pinned defining namespaces',start);assert.ok(start>0&&end>start);
 return new Function(stripTypeScriptTypes(source.slice(start,end).replace(/^export /gm,''),{mode:'strip'})+';return createPrivateExecutedGuard;')();
}
test('Private source-bound guard call preserves exact promise, receiver, arguments and undefined failures',()=>{
 for(const fail of [false,true]){
  const faults=[],invocation={owner:{}},input={},promise=Promise.resolve({}),dispatcher={},module={};let context,a,calls=0,binding;
  const fn=function(...args){assert.equal(this,undefined);assert.deepEqual(args,[input]);calls++;binding.entry(module,fn,input);if(fail)throw undefined;return promise;};
  binding=privateExecutedGuardFactory()(()=>context,()=>undefined,(original,receiver,args,proof)=>{
   a={guard:original,input:args[0],guardSource:proof,invocation};a.context=context={invocation,acquisition:a};return Reflect.apply(original,receiver,args);
  },faults);
  if(fail)assert.throws(()=>binding.call(dispatcher,fn,input),e=>e===undefined);else assert.equal(binding.call(dispatcher,fn,input),promise);
  assert.equal(calls,1);assert.equal(binding.bound(a),true);assert.equal(a.result,undefined);assert.equal(a.guardObserved,undefined);assert.deepEqual(faults,[]);
  binding.close();assert.equal(binding.bound(a),true);assert.throws(()=>binding.call(dispatcher,fn,input));
 }
});
test('Private source-bound guard rejects foreign entry context, callee, input, duplicate and absent entry',()=>{
 for(const mode of ['absent','context','callee','input','duplicate','observer']){
  const faults=[],invocation={owner:{}},input={},promise=Promise.resolve({});let a,context,binding;
  const fn=()=>{if(mode!=='absent')binding.entry({},mode==='callee'?()=>{}:fn,mode==='input'?{}:input);if(mode==='duplicate')binding.entry({},fn,input);return promise;};
  binding=privateExecutedGuardFactory()(()=>{if(mode==='observer')throw undefined;return mode==='context'?{invocation,acquisition:a}:context;},()=>undefined,(original,receiver,args,proof)=>{
   a={guard:original,input:args[0],guardSource:proof,invocation};a.context=context={invocation,acquisition:a};return Reflect.apply(original,receiver,args);
  },faults);
  assert.equal(binding.call({},fn,input),promise);assert.equal(binding.bound(a),mode==='duplicate');assert.equal(faults.length,mode==='absent'?0:1);if(mode==='observer')assert.equal(faults[0],undefined);
  for(const key of ['guard','input','guardSource','context','invocation']){const original=a[key];a[key]={};assert.equal(binding.bound(a),false);a[key]=original;}
 }
 let calls=0,observed=0;const result={},spy=function(input){calls++;assert.equal(this,undefined);return result;};
 const bound=privateExecutedGuardFactory()(()=>{throw Error('no context read');},()=>spy,()=>{observed++;},[]);
 assert.equal(bound.call({},spy,{}),result);assert.equal(calls,1);assert.equal(observed,0);
});
test('Private actual dispatcher overlay invokes the installed call observer once and preserves fallback',()=>{
 const contract='b'.repeat(64),source=overlayPrivateExecutionSource(4,privateExecutionOriginals[4],contract).toString(),prefix=source.slice(0,source.indexOf('import '));
 for(const installed of [false,true])for(const fail of [false,true]){
  const global={},input={},promise=Promise.resolve({});let calls=0,observations=0;
  const fn=function(value){calls++;assert.equal(this,undefined);assert.equal(value,input);if(fail)throw undefined;return promise;};
  if(installed)Object.defineProperty(global,Symbol.for('clawrouter.private.execution.'+contract),{value:Object.freeze({guardCall(module,original,value){assert.ok(module);assert.equal(original,fn);assert.equal(value,input);observations++;return Reflect.apply(original,undefined,[value]);}})});
  const invoke=new Function('globalThis',stripTypeScriptTypes(prefix,{mode:'strip'})+';return __privateE2InvokeGuard;')(global);
  if(fail)assert.throws(()=>invoke(fn,input),e=>e===undefined);else assert.equal(invoke(fn,input),promise);
  assert.equal(calls,1);assert.equal(observations,installed?1:0);
 }
});
test('Private execution V13 preserves the original capsule, binds delivery and rejects malformed tuples',async()=>{
 const contract='e'.repeat(64),h=privateCaptureHarness(),tuple=[contract,1,1,0,2,2,2,1,1,0,0];
 h.r.bodyExecution(0,h.row,tuple);h.r.bodyCaptureFailure(0,h.row,11,undefined,[11,5,63,31,false,false,129,0,0],2);
 const cap=h.capsule(),validate=privateCheckpointFunctions().validatePrivateCheckpoint;
 assert.equal(cap.v,13);validate(cap);assert.deepEqual([...cap.execution],[12,...tuple]);
 const legacy=privateCaptureHarness();legacy.r.bodyCaptureFailure(0,legacy.row,11,undefined,[11,5,63,31,false,false,129,0,0],2);
 const {execution,...rest}=cap;assert.equal(JSON.stringify({...rest,v:12}),JSON.stringify(legacy.capsule()));
 const raw={stdout:'PRIVATE_CHECKPOINT '+JSON.stringify(cap)+'\n'};
 assert.equal(privateCheckpointRecords(raw,contract).length,1);
 for(const expected of [undefined,'f'.repeat(64)])assert.throws(()=>privateCheckpointRecords(raw,expected));
 const variants=[execution.slice(0,-1),[...execution,0],Object.assign([...execution],{extra:0})];
 const sparse=[...execution];delete sparse[4];variants.push(sparse);
 for(let i=0;i<execution.length;i++)for(const value of [null,undefined,true,{},[],NaN,Infinity,-1,4]){const changed=[...execution];changed[i]=value;variants.push(changed);}
 for(const changed of variants)assert.throws(()=>validate({...cap,execution:changed}));
 const lines=[];privateAnnotationEmitter(line=>lines.push(line))(cap);assert.ok(Buffer.byteLength(lines[0])<=768);
 let caught;try{await withPrivateNativeDiagnostics(()=>{throw raw;},()=>{throw undefined;},()=>contract);}catch(e){caught=e;}
 assert.equal(caught.errors[0],raw);assert.equal(caught.errors[1],undefined);
});

 // BEGIN Private capture entry inert regressions
 function privateCaptureHarness({failAt=0,reason,source,reportThrow=false,fetchThrow=false,ownershipOverride,captureObserver=0}={}){
  source??=readFileSync(new URL("./fixtures/openclaw-private-catalogs-contract.test.ts",import.meta.url),"utf8");
  const section=(a,b)=>{assert.equal(source.split(a).length,2);return source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));};
  const wrapper=section("export function createPrivateFetchObserver(","export function createPrivateInvocationOwnership(").replace(/^export /gm,"");
  const capture=section(" const observedFetch=(fetcher:Function,captureObserver=0)=>", "\n const check=");
  const records=[],originals=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter("sdk",v=>records.push(v));
  const row={provider:"baseten",api:"stream",control:"eof"};r.bindCase(0,0);r.bindBody(0,row,originals);r.bindBodyMetadata(0,row,privateNodeTypes.isProxy);
  const w={sequence:0,syncFailures:[],observerFailures:[]},calls=[],receiver={},pending=Promise.resolve({}),signalClass=class {};
  const hit=n=>{calls.push(n);if(failAt===n)throw reason;};
  let assertion=0;
  const expect=value=>({toBe(expected){hit([6,7,13,14][assertion++]);assert.equal(value,expected);},
   toContain(expected){hit(assertion===2?8:15);assert.ok(value.includes(expected));},
   toBeInstanceOf(expected){hit(16);assert.ok(value instanceof expected);},toBeDefined(){hit(17);assert.notEqual(value,undefined);}});
  const input="https://fixture.invalid/chat/completions",init={signal:new signalClass(),dispatcher:{close(){}}};
  if(failAt===19)Object.defineProperty(init.dispatcher,"close",{get(){hit(19);}});
  const fakeURL=class {constructor(value){hit(5);assert.equal(value,input);this.origin="https://fixture.invalid";this.search="";this.href=value;this.pathname="/chat/completions";}};
  const fakeHeaders=class {constructor(){hit(9);}get(){hit(10);return "Bearer key";}has(){return false;}};
  const transportRows=[];transportRows.push=function(value){hit(18);return Array.prototype.push.call(this,value);};
  const ownership=ownershipOverride??{transport(){hit(11);},response(){}};
  const checkpoints={bodyCaptureFailure(...args){if(reportThrow)throw undefined;r.bodyCaptureFailure(...args);},bodyOperationFailure(...args){r.bodyOperationFailure(...args);}};
  const record=(kind,details)=>{hit(20);const o={kind,...details,state:"pending"};originals.push(o);return o;};
  const returned=(o,p)=>{o.pending=p;o.state="fulfilled";};const observer=()=>{};
  const dependencies={execution:undefined,URL:fakeURL,Headers:fakeHeaders,Request:class {},AbortSignal:signalClass,expect,origin:"https://fixture.invalid",base:()=>"https://fixture.invalid",row,key:()=>"key",ownership,
   signalHistory:()=>{hit(12);return [];},transports:transportRows,observedDispatchers:new Set(),patch:(o,k,v)=>{o[k]=v;},invoke:(_k,fn)=>fn(),record,w,checkpoints,caseIndex:0,returned,observer,observeBody:()=>{}};
  const factory=new Function(...Object.keys(dependencies),'"use strict";'+stripTypeScriptTypes(wrapper+capture,{mode:"strip"})+';return observedFetch;')(...Object.values(dependencies));
  let fetchCalls=0,actualReceiver,actualArgs;
  const wrapped=factory(function(...args){fetchCalls++;actualReceiver=this;actualArgs=args;if(fetchThrow)throw reason;return pending;},captureObserver);
  return {wrapped,receiver,input,init,pending,row,r,w,records,calls,originals,get fetchCalls(){return fetchCalls;},get actualReceiver(){return actualReceiver;},get actualArgs(){return actualArgs;},
   capsule(){r.bodySite(0,row,20,1);r.mark(0,"body","rejected",reason);return records.find(v=>v.v===13||v.v===12||v.v===7||v.v===6);}};
 }
 test("Private capture entry identifies original URL ownership and header failures before fetch",()=>{
  for(const failAt of Array.from({length:16},(_,i)=>i+5))for(const reason of [undefined,{}]){
   const h=privateCaptureHarness({failAt,reason});let present=false,caught;
   try{Reflect.apply(h.wrapped,h.receiver,[h.input,h.init]);}catch(e){present=true;caught=e;}
   assert.equal(present,true);assert.equal(caught,reason);assert.equal(h.fetchCalls,0);
   assert.deepEqual(JSON.parse(JSON.stringify(h.capsule().meta[3])),[failAt,1,reason!==undefined]);assert.equal(h.r.failures.length,0);
  }
 });
 test("Private capture entry preserves successful call and separates native fetch failure",async()=>{
  for(const fetchThrow of [false,true])for(const reason of [undefined,{}]){
   const h=privateCaptureHarness({fetchThrow,reason});let caught,present=false,result;
   try{result=Reflect.apply(h.wrapped,h.receiver,[h.input,h.init]);}catch(e){present=true;caught=e;}
   assert.equal(h.fetchCalls,1);assert.equal(h.actualReceiver,h.receiver);assert.equal(h.actualArgs[0],h.input);assert.equal(h.actualArgs[1],h.init);
   assert.equal(present,fetchThrow);if(fetchThrow){assert.equal(caught,reason);assert.deepEqual(JSON.parse(JSON.stringify(h.capsule().meta[3])),[2,1,reason!==undefined]);}
   else {assert.equal(result,h.pending);await result;assert.equal(h.capsule().meta[3],null);}
  }
 });
 test("Private capture entry missing foreign late invalid and reporting failures never gain evidence",async()=>{
  const empty=privateCaptureHarness();assert.equal(empty.capsule().meta[3],null);assert.equal(empty.fetchCalls,0);
  for(const fault of [h=>h.r.bodyCaptureFailure(0,{},6,undefined),h=>h.r.bodyCaptureFailure(0,h.row,21,undefined)]){
   const h=privateCaptureHarness();fault(h);assert.equal(h.r.failures.length,1);assert.equal(h.capsule().meta[3],null);
  }
  const h=privateCaptureHarness({failAt:11,reason:undefined,reportThrow:true});const cleanup={};let aggregate;
  try{await finishPrivateOwned(()=>Reflect.apply(h.wrapped,h.receiver,[h.input,h.init]),[()=>{throw h.w.observerFailures[0];},()=>{throw cleanup;}]);}catch(e){aggregate=e;}
  assert.deepEqual(aggregate.errors,[undefined,undefined,cleanup]);assert.equal(h.fetchCalls,0);assert.equal(h.w.observerFailures.length,1);assert.equal(h.capsule().meta[3],null);
  const first=privateCaptureHarness();first.r.bodyCaptureFailure(0,first.row,6,undefined);first.r.bodyCaptureFailure(0,first.row,11,{});
  assert.deepEqual(JSON.parse(JSON.stringify(first.capsule().meta[3])),[6,1,false]);first.r.bodyCaptureFailure(0,first.row,12,{});assert.equal(first.records.filter(v=>v.v===7).length,1);
 });
 test("Private capture V7 reserved capsule relays atomically without widening historical versions",()=>{
  const h=privateCaptureHarness();h.r.bodyCaptureFailure(0,h.row,20,undefined);const cap=h.capsule(),commands=[],emit=privateAnnotationEmitter(v=>commands.push(v));
  emit(cap);assert.ok(Buffer.byteLength(JSON.stringify(cap))<=512);assert.ok(Buffer.byteLength(commands[0])<=768);
  const {validatePrivateCheckpoint}=privateCheckpointFunctions();validatePrivateCheckpoint(cap);
  for(const patch of [{v:6},{v:7,meta:[...cap.meta.slice(0,3),[20,2,false],cap.meta[4]]},{case:4},{decl:4}])assert.throws(()=>validatePrivateCheckpoint({...cap,...patch}));
  const error={stdout:"PRIVATE_CHECKPOINT "+JSON.stringify(cap)};assert.equal(JSON.stringify(privateCheckpointRecords(error)),JSON.stringify([cap]));
 });

 // V8 source sites: 0 getStore, 1 inactive, 2 absent context, 3 invocation member,
 // 4 acquisition operand, 5 absent acquisition, 6 acquisition member, 7 context,
 // 8 previous transport, 9 transport member, 10 original method/invocation kind.
 function privateOwnershipSource(source){
  source??=readFileSync(new URL("./fixtures/openclaw-private-catalogs-contract.test.ts",import.meta.url),"utf8");
  const start="export function createPrivateInvocationOwnership(",end="export function newPrivateInvocationCaller(";
  assert.equal(source.split(start).length,2);return source.slice(source.indexOf(start),source.indexOf(end));
 }
 function privateOwnershipVector(source,{bits=0,throwAt=-1,reason,method="POST",reportThrow=false,reenter=false}={}){
  const calls=[],out=[],observerFailures=[],guardErrors=[{},{}];let sets=0,nested=false;
  const hit=(site,label)=>{calls.push(label);if(site===throwAt)throw reason;};
  const read=(obj,key,site,value)=>Object.defineProperty(obj,key,{configurable:true,get(){hit(site,key);return typeof value==="function"?value():value;}});
  const invocation={owner:{},caller:{}},context={},a={},t={};
  read(context,"invocation",3,invocation);read(context,"acquisition",4,()=>bits&8?undefined:a);
  read(a,"context",7,()=>bits&32?{}:context);Object.defineProperty(a,"transport",{get(){hit(8,"previous");return bits&64?{}:undefined;},set(v){calls.push("set.transport");}});
  read(t,"method",10,method);read(invocation,"kind",10,()=>bits&256?"discovery":"inference");
  const weak=class {constructor(){this.id=sets++;}add(){calls.push("add."+this.id);return this;}has(){const id=[3,6,9][this.id];hit(id,"has."+this.id);return this.id===0?!(bits&4):this.id===1?!(bits&16):!!(bits&128);}};
  let owner;const storage={getStore(){hit(0,"getStore");if(reenter&&!nested){nested=true;owner.transport({method:"POST"});}return bits&2?null:context;},disable(){calls.push("disable");}};
  const factory=new Function("WeakSet","WeakMap","Error",'"use strict";'+stripTypeScriptTypes(source.replace(/^export /gm,""),{mode:"strip"})+';return createPrivateInvocationOwnership;')(weak,class {},text=>guardErrors[text==="incomplete invocation context"?0:1]);
  owner=factory(storage);if(bits&1)owner.restore();let value,present=false,caught;
  try{value=owner.transport(t,w=>{out.push(w);if(reportThrow)throw undefined;},observerFailures);}catch(e){present=true;caught=e;}
  return {calls,out,observerFailures,present,caught,value,guardErrors,table:{context,a,t,invocation}};
 }
 test("Private ownership V8 preserves every original short-circuit truth vector",()=>{
  const actual=privateOwnershipSource();
  // The frozen pre-V8 expressions are the comparison oracle, not a new checker.
  const original=actual.slice(0,actual.indexOf(" const current="))+` const current=()=>{const value=storage.getStore();if(!active||!value||!invocations.has(value.invocation))throw Error("incomplete invocation context");return value;};
 return {transport(t){const context=current(),a=context.acquisition;
 if(!a||!acquisitions.has(a)||a.context!==context||a.transport||transports.has(t)||(t.method==="POST"?"inference":t.method==="GET"?"discovery":"invalid")!==context.invocation.kind)throw Error("incomplete transport ownership");
 t.context=context;t.invocation=context.invocation;t.acquisition=a;t.caller=context.invocation.kind==="inference"?context.invocation.caller:undefined;t.catalogInitiator=context.invocation.kind==="discovery"?context.invocation.caller:undefined;t.owner=context.invocation.owner;
 a.transport=t;transports.add(t);},restore(){if(!active)throw Error("duplicate invocation restoration");active=false;storage.disable();}};}`;
  for(let bits=0;bits<512;bits++)for(const method of ["POST","GET","post"]){
   const old=privateOwnershipVector(original,{bits,method}),now=privateOwnershipVector(actual,{bits,method});
   assert.deepEqual(now.calls,old.calls);assert.equal(now.present,old.present);assert.equal(now.value,old.value);
   if(old.present){assert.equal(now.guardErrors.indexOf(now.caught),old.guardErrors.indexOf(old.caught));const tuple=now.out[0];assert.equal(tuple[0],11);assert.equal(tuple[2],2**(tuple[1]+1)-1);assert.equal(tuple[3],2**tuple[1]-1);assert.deepEqual(tuple.slice(4),[false,true]);}
   else assert.equal(now.out.length,0);
  }
 });
 test("Private ownership V8 retains operand throws and independent reporting failures",()=>{
  const source=privateOwnershipSource();
  for(const site of [0,3,4,6,7,8,9,10])for(const reason of [undefined,{}])for(const reportThrow of [false,true]){
   const h=privateOwnershipVector(source,{throwAt:site,reason,reportThrow});assert.equal(h.present,true);assert.equal(h.caught,reason);
   assert.deepEqual(h.out,[[11,site,2**(site+1)-1,2**site-1,true,reason!==undefined]]);assert.deepEqual(h.observerFailures,reportThrow?[undefined]:[]);
  }
 });
 test("Private ownership V8 reentrant evaluations keep invocation-local traces",()=>{
  const source=privateOwnershipSource(),h=privateOwnershipVector(source,{reenter:true});assert.equal(h.present,false);assert.equal(h.out.length,0);assert.equal(h.calls.filter(x=>x==="getStore").length,2);
  for(const bits of [1,2,4,8,16,32,64,128,256]){const r=privateOwnershipVector(source,{bits});assert.equal(r.present,true);assert.equal(r.out.length,1);}
 });
 test("Private ownership V8 actual capture associates the same rejected transport",()=>{
  const factory=new Function('"use strict";'+stripTypeScriptTypes(privateOwnershipSource().replace(/^export /gm,""),{mode:"strip"})+';return createPrivateInvocationOwnership;')();
  for(const mode of ["healthy","missing","kind","foreign","late"]){
   let store,saved;const storage={getStore(){return store;},run(value,fn){const old=store;store=value;try{return fn();}finally{store=old;}},disable(){store=undefined;}};
   const owner=factory(storage),h=privateCaptureHarness({ownershipOverride:owner}),signal={},caller={kind:mode==="kind"?"discovery":"inference",owner:{},signal};let pending,present=false;h.init.method="POST";
   const fetch=()=>Reflect.apply(h.wrapped,h.receiver,[h.input,h.init]);
   const guarded=()=>{const input={},fn=()=>{saved=store;if(mode==="late"){owner.restore();return storage.run(saved,fetch);}return fetch();};return owner.guard(fn,undefined,[input],{input,guard:fn});};
   try{pending=mode==="missing"?fetch():mode==="foreign"?storage.run({invocation:{}},fetch):owner.invoke(caller,caller.kind,guarded,undefined,caller.kind==="inference"?[{}, {}, {signal}]:[{signal}]);}catch(error){present=true;}
   assert.equal(present,mode!=="healthy");assert.equal(h.fetchCalls,mode==="healthy"?1:0);
   if(mode==="healthy"){assert.equal(pending,h.pending);assert.equal(h.capsule().meta[3],null);}
   else {h.r.bodySite(0,h.row,20,1);h.r.mark(0,"body","rejected",{});const cap=h.records.find(v=>v.v===8);assert.ok(cap);assert.equal(Math.floor(cap.meta[3][1]/4),{missing:2,kind:10,foreign:3,late:1}[mode]);}
  }
 });
 test("Private ownership V8 reserved capsule has strict masks and legacy relay",()=>{
  const {validatePrivateCheckpoint}=privateCheckpointFunctions();
  for(let id=0;id<=10;id++)for(const operand of [false,true])for(const reason of [undefined,{}]){
   if(!operand&&[0,4].includes(id))continue;
   const h=privateCaptureHarness(),tuple=[11,id,2**(id+1)-1,2**id-1,operand,reason!==undefined];h.r.bodyCaptureFailure(0,h.row,11,reason,tuple);
   h.r.bodySite(0,h.row,20,1);h.r.mark(0,"body","rejected",reason);const cap=h.records.find(v=>v.v===8);assert.ok(cap);validatePrivateCheckpoint(cap);assert.deepEqual(JSON.parse(JSON.stringify(cap.meta[3])),[tuple[2]*2048+tuple[3],id*4+(operand?2:0)+(reason!==undefined?1:0)]);
   const commands=[],emit=privateAnnotationEmitter(v=>commands.push(v));emit(cap);assert.ok(Buffer.byteLength(JSON.stringify(cap))<=375);assert.ok(Buffer.byteLength(commands[0])<=418);
   assert.equal(JSON.stringify(privateCheckpointRecords({stdout:"PRIVATE_CHECKPOINT "+JSON.stringify(cap)})),JSON.stringify([cap]));
   for(const wrong of [[(tuple[2]+1)*2048+tuple[3],id*4], [tuple[2]*2048+tuple[3]+1,id*4], [4193280,43], [4193279,44], [2048,0], [1,2,3], null])assert.throws(()=>validatePrivateCheckpoint({...cap,meta:[...cap.meta.slice(0,3),wrong,cap.meta[4]]}));
   for(const v of [2,4,5,6,7])assert.throws(()=>validatePrivateCheckpoint({...cap,v}));
  }
 });
 test("Private ownership V8 foreign absent late and reporting evidence stays unknown",async()=>{
  for(const mutate of [h=>h.r.bodyCaptureFailure(0,{},11,undefined,[11,0,1,0,true,false]),h=>h.r.bodyCaptureFailure(0,h.row,11,undefined,[11,0,1,0,true,true])]){
   const h=privateCaptureHarness();mutate(h);assert.equal(h.r.failures.length,1);assert.equal(h.capsule().meta[3],null);
  }
  const h=privateCaptureHarness();h.r.bodyCaptureFailure(0,h.row,6,undefined);h.r.bodyCaptureFailure(0,h.row,11,{},[11,5,63,31,false,true]);assert.deepEqual(JSON.parse(JSON.stringify(h.capsule().meta[3])),[6,1,false]);
  const r=privateOwnershipVector(privateOwnershipSource(),{throwAt:0,reason:undefined,reportThrow:true});let all;
  try{await finishPrivateOwned(()=>{throw r.caught;},[()=>{throw r.observerFailures[0];},()=>{throw undefined;}]);}catch(e){all=e;}
  assert.deepEqual(all.errors,[undefined,undefined,undefined]);
 });
 // V9 uses the existing private ledger, never another storage/native read.
 function privateAcquisitionHarness({mode="restore",reason={},phase="in-call",foreign=false,recordThrow=false,reportThrow=false,source,mutate}={}){
  const factory=new Function('"use strict";'+stripTypeScriptTypes(privateOwnershipSource(source).replace(/^export /gm,""),{mode:"strip"})+';return createPrivateInvocationOwnership;')();
  const acquisitions=[],originals=[],faults=[],traces=[],row={},signal={},caller={owner:row,kind:"inference",signal};let store,reads=0,guardCalls=0,nativeCalls=0,sequence=0,caught,present=false;
  const storage={getStore(){reads++;return store;},run(value,fn){const old=store;store=value;try{return fn();}finally{store=old;}},disable(){store=undefined;}};
  const input={},args=[input],guard=function(){guardCalls++;return guardedBody();};let guardedBody;
  const evidence={ledger:{owner:row,acquisitions,originals},owner:row,acquisitions,originals,guard,isProxy(value){if(recordThrow&&value===originals[0])throw undefined;return privateNodeTypes.isProxy(value);}};
  const ownership=factory(storage,evidence),transport=()=>{ownership.transport({method:mode==="proper"?"GET":"POST"},v=>{traces.push(v);if(reportThrow)throw undefined;},faults);nativeCalls++;return reason;};
  const invoke=fn=>ownership.invoke(caller,"inference",fn,undefined,[null,null,{signal}]);
  const acquire=fn=>{const a={guard,input,invoke:++sequence},o={kind:"guard",owner:row,acquisition:a,receiver:undefined,args,invoke:++sequence,state:"pending",returnAt:0,settle:0,returned:undefined};a.operation=o;acquisitions.push(a);originals.push(o);guardedBody=()=>{
    if(phase!=="in-call"){const pending={};o.pending=pending;o.returned=pending;a.pending=pending;o.returnAt=++sequence;if(phase==="settled"){o.state="fulfilled";o.settle=++sequence;}}
    if(foreign)a.owner={};if(mutate)mutate({a,o,acquisitions,originals,store,evidence});return fn();};return ownership.guard(guard,undefined,args,a);};
  try{
   if(mode==="other"||mode==="other-one")invoke(()=>acquire(()=>reason));
   invoke(()=>{const outer=store;
    if(mode==="bypass"||mode==="other")return transport();
    if(mode==="multi")acquire(()=>reason);
    return acquire(()=>mode==="proper"||mode==="healthy"?transport():storage.run(outer,transport));});
  }catch(error){present=true;caught=error;}
  return {traces,faults,present,caught,reads,guardCalls,nativeCalls,acquisitions,originals,ownership,storage};
 }
 test("Private acquisition V9 separates the same V8 failure from bypass and context restoration",()=>{
  const bypass=privateAcquisitionHarness({mode:"bypass"}),restore=privateAcquisitionHarness();
  assert.deepEqual(bypass.traces[0].slice(0,6),restore.traces[0].slice(0,6));assert.equal(bypass.traces[0][6],1);assert.equal(restore.traces[0][6],50);
  assert.deepEqual([bypass.reads,bypass.guardCalls,bypass.nativeCalls],[1,0,0]);assert.deepEqual([restore.reads,restore.guardCalls,restore.nativeCalls],[2,1,0]);
  const proper=privateAcquisitionHarness({mode:"proper"}),healthy=privateAcquisitionHarness({mode:"healthy"});assert.equal(proper.traces[0][6],42);assert.equal(healthy.present,false);assert.equal(healthy.nativeCalls,1);assert.equal(healthy.traces.length,0);
 });
 test("Private acquisition V9 keeps invocation census and pending original-call phases distinct",()=>{
  for(const [mode,code]of [["other",129],["other-one",178],["multi",3]]){const h=privateAcquisitionHarness({mode});assert.equal(h.traces[0][6],code);assert.equal(h.nativeCalls,0);}
  for(const [phase,code]of [["in-call",50],["returned",82],["settled",114]])assert.equal(privateAcquisitionHarness({phase}).traces[0][6],code);
  const h=privateAcquisitionHarness();h.acquisitions[0].context={};h.originals.push({});assert.equal(h.traces[0][6],50);
 });
 test("Private acquisition V9 denies foreign contradictory and duplicate private ledger references",()=>{
  const mutations=[({a})=>a.context={},({a})=>a.invocation={},({a})=>a.guard=()=>{},({o})=>o.owner={},({o})=>o.acquisition={},({o})=>o.args=[{}],({o})=>o.state="other",({o})=>o.settle=1,
   ({a,acquisitions})=>acquisitions.push(a),({o,originals})=>originals.push(o),({originals})=>originals.push({kind:"guard",acquisition:{}}),({a})=>a.pending={},({o,originals})=>originals.push({...o}),({evidence})=>evidence.ledger.originals=[],({evidence})=>evidence.ledger.acquisitions=[],({a})=>Object.defineProperty(a,"context",{get(){throw Error("getter must not run");}}),({a})=>a.context=new Proxy({}, {get(){throw Error("proxy must not run");}})];
  for(const mutate of mutations){const h=privateAcquisitionHarness({mutate});assert.equal(h.traces[0][6],4);assert.equal(h.nativeCalls,0);assert.deepEqual(h.faults,[]);}
  assert.equal(privateAcquisitionHarness({foreign:true}).traces[0][6],4);
  let traps=0;const h=privateAcquisitionHarness({mutate({a}){a.context=new Proxy({}, {isExtensible(){traps++;throw undefined;},ownKeys(){traps++;throw undefined;}});}});assert.equal(h.traces[0][6],4);assert.equal(traps,0);assert.deepEqual(h.faults,[]);
 });
 test("Private acquisition V9 bookkeeping and writer failures remain independent of original failure",async()=>{
  for(const options of [{recordThrow:true},{reportThrow:true}]){const h=privateAcquisitionHarness(options);assert.equal(h.present,true);assert.deepEqual(h.faults,[undefined]);assert.equal(h.nativeCalls,0);let result;
   try{await finishPrivateOwned(()=>{throw h.caught;},[()=>{throw h.faults[0];},()=>{throw undefined;}]);}catch(e){result=e;}
   assert.deepEqual(result.errors,[h.caught,undefined,undefined]);}
 });
 test("Private acquisition V9 original emitter relay and closed schema retain unknowns",()=>{
  const {validatePrivateCheckpoint}=privateCheckpointFunctions();
  for(const mode of ["bypass","restore","proper","other","other-one","multi"])for(const phase of ["in-call","returned","settled"]){const h=privateAcquisitionHarness({mode,phase}),r=privateCaptureHarness();
   r.r.bodyCaptureFailure(0,r.row,11,h.caught,h.traces[0]);r.r.bodySite(0,r.row,20,1);r.r.mark(0,"body","rejected",h.caught);const cap=r.records.find(x=>x.v===9);assert.ok(cap);validatePrivateCheckpoint(cap);
   const commands=[],emit=privateAnnotationEmitter(x=>commands.push(x));emit(cap);assert.ok(Buffer.byteLength(JSON.stringify(cap))<=375);assert.ok(Buffer.byteLength(commands[0])<=418);
   const rows=privateCheckpointRecords({stdout:"PRIVATE_CHECKPOINT "+JSON.stringify(cap)});assert.equal(JSON.stringify(rows),JSON.stringify([cap]));
   for(const word of [-1,792,null,"50",false,Infinity])assert.throws(()=>validatePrivateCheckpoint({...cap,meta:[...cap.meta.slice(0,3),[word],cap.meta[4]]}));
   assert.throws(()=>validatePrivateCheckpoint({...cap,case:4}));assert.throws(()=>validatePrivateCheckpoint({...cap,v:8}));
  }
 });
 test("Private acquisition V9 actual operand throws retain undefined and do not reread context",()=>{
  const factory=new Function('"use strict";'+stripTypeScriptTypes(privateOwnershipSource().replace(/^export /gm,""),{mode:"strip"})+';return createPrivateInvocationOwnership;')();
  for(const site of [0,3,4])for(const reason of [undefined,{}]){let store,gets=0,operandGets=0,caught,present=false;const traces=[],faults=[],row={},acquisitions=[],originals=[];
   const storage={getStore(){gets++;if(site===0)throw reason;return store;},run(v,fn){store=v;return fn();},disable(){}},evidence={ledger:{owner:row,acquisitions,originals},owner:row,acquisitions,originals,guard:()=>{},isProxy:privateNodeTypes.isProxy},owner=factory(storage,evidence);
   try{if(site!==0)owner.invoke({owner:row,kind:"inference",signal:null},"inference",()=>{const original=store;store={};Object.defineProperty(store,site===3?"invocation":"acquisition",{get(){operandGets++;throw reason;}});if(site===4)store.invocation=original.invocation;owner.transport({},v=>traces.push(v),faults);},undefined,[null,null,{signal:null}]);else owner.transport({},v=>traces.push(v),faults);}catch(e){present=true;caught=e;}
   assert.equal(present,true);assert.equal(caught,reason);assert.equal(gets,1);assert.equal(operandGets,site===0?0:1);assert.equal(traces[0][4],true);assert.equal(traces[0][5],reason!==undefined);assert.equal(traces[0][6],site===4?1:0);assert.deepEqual(faults,[]);
  }
 });
 test("Private acquisition V9 operand throws and absent invocation cannot invent a census",()=>{
  const h=privateCaptureHarness();h.r.bodyCaptureFailure(0,h.row,11,undefined,[11,0,1,0,true,false,0]);h.r.bodySite(0,h.row,20,1);h.r.mark(0,"body","rejected",undefined);const cap=h.records.find(x=>x.v===9);assert.ok(cap);assert.equal(cap.meta[3][0]%18,0);
  const {validatePrivateCheckpoint}=privateCheckpointFunctions();for(const code of [1,4,50])assert.throws(()=>validatePrivateCheckpoint({...cap,meta:[...cap.meta.slice(0,3),[2*18+[0,1,3,4,42,50,74,82,106,114,129,131,170,178,202,210,234,242].indexOf(code)],cap.meta[4]]}));
 });

 // BEGIN Private defining module spy inert regressions
 function privateDefiningFactory(transportHost,openAITransport,vi,object=Object){
  const source=readFileSync(new URL("./fixtures/openclaw-private-catalogs-contract.test.ts",import.meta.url),"utf8");
  const helper=source.slice(source.indexOf("export function installPrivateDefiningSpy("),source.indexOf("// Defining-module observations only."));
  const same=source.slice(source.indexOf("export function samePrivateDescriptor("),source.indexOf("export function privateCancelOperand("));
  return new Function("transportHost","openAITransport","vi","isProxy","Object",stripTypeScriptTypes((helper+same).replace(/^export /gm,""),{mode:"strip"})+";return installPrivateDefiningSpy;")(transportHost,openAITransport,vi,privateNodeTypes.isProxy,object);
 }
 function privateDefiningFakeVi(options={}){
  return {spyOn(module,name){
   const original=Object.getOwnPropertyDescriptor(module,name);assert.equal(typeof original.value,"function");let implementation=original.value;
   const mock=function(...args){return Reflect.apply(implementation,this,args);};
   mock.mockImplementation=fn=>{implementation=fn;if(options.installThrows)throw options.reason;return mock;};
   mock.mockRestore=()=>{if(options.restoreThrows)throw options.reason;Object.defineProperty(module,name,original);};
   Object.defineProperty(module,name,{...original,value:mock});return mock;
  }};
 }
 test("Private defining spies resolve only the two supported exports once and restore exactly",()=>{
  for(const name of ["getAiTransportHost","withOpenAIErrorResponseHook"])for(const getter of [false,true]){
   const module={},other={},restores=[],calls=[],receiver={},args=[{},undefined],returned={};let reads=0;
   const original=function(...actual){calls.push([this,actual]);return returned;};
   Object.defineProperty(module,name,getter?{configurable:true,enumerable:true,get(){reads++;return original;}}:{value:original,configurable:true,enumerable:true,writable:false});
   const before=Object.getOwnPropertyDescriptor(module,name),install=privateDefiningFactory(name==="getAiTransportHost"?module:other,name==="withOpenAIErrorResponseHook"?module:other,privateDefiningFakeVi());
   install(module,name,(fn,self,a)=>Reflect.apply(fn,self,a),restores);
   assert.equal(Reflect.apply(module[name],receiver,args),returned);assert.deepEqual(calls,[[receiver,args]]);assert.equal(reads,getter?1:0);
   restores[0]();assert.deepEqual(Object.getOwnPropertyDescriptor(module,name),before);assert.equal(reads,getter?1:0);assert.throws(()=>restores[0]());
  }
 });
 test("Private defining spies reject foreign proxy inherited setter and mutated descriptors",()=>{
  for(const mode of ["foreign","proxy","inherited","setter","nonconfigurable","nonfunction","mutation"]){
   let reads=0,traps=0;const module={},other={},restores=[],fn=()=>{};
   Object.defineProperty(module,"getAiTransportHost",{configurable:mode!=="nonconfigurable",enumerable:true,get(){reads++;if(mode==="mutation")Object.defineProperty(module,"getAiTransportHost",{value:fn,configurable:true});return mode==="nonfunction"?1:fn;},...(mode==="setter"?{set(){}}:{})});
   const selected=mode==="proxy"?new Proxy(module,{getOwnPropertyDescriptor(){traps++;throw undefined;}}):mode==="inherited"?Object.create(module):module;
   const install=privateDefiningFactory(mode==="foreign"?other:selected,other,privateDefiningFakeVi());
   assert.throws(()=>install(selected,"getAiTransportHost",()=>{},restores));assert.equal(traps,0);assert.equal(reads,["nonfunction","mutation"].includes(mode)?1:0);assert.equal(restores.length,0);
  }
 });
 test("Private defining spies preserve undefined original getter call and independent restoration failures",async()=>{
  for(const at of ["getter","call","install"])for(const reason of [undefined,{}]){
   const module={},restores=[];let calls=0,present=false,caught;
   Object.defineProperty(module,"getAiTransportHost",{configurable:true,enumerable:true,get(){if(at==="getter")throw reason;return function(){calls++;if(at==="call")throw reason;};}});
   const before=Object.getOwnPropertyDescriptor(module,"getAiTransportHost"),install=privateDefiningFactory(module,{},privateDefiningFakeVi({installThrows:at==="install",reason}));
   try{install(module,"getAiTransportHost",(fn,self,args)=>Reflect.apply(fn,self,args),restores);module.getAiTransportHost();}catch(error){present=true;caught=error;}
   assert.equal(present,true);assert.equal(caught,reason);assert.equal(calls,at==="call"?1:0);for(const restore of restores)restore();assert.deepEqual(Object.getOwnPropertyDescriptor(module,"getAiTransportHost"),before);
  }
  const module={getAiTransportHost(){}},restores=[],before=Object.getOwnPropertyDescriptor(module,"getAiTransportHost");
  privateDefiningFactory(module,{},privateDefiningFakeVi({restoreThrows:true,reason:undefined}))(module,"getAiTransportHost",()=>{},restores);
  let failure;try{await finishPrivateOwned(async()=>{throw undefined;},[restores[0],()=>{throw undefined;}]);}catch(error){failure=error;}
  assert.deepEqual(failure.errors,[undefined,undefined,undefined]);assert.deepEqual(Object.getOwnPropertyDescriptor(module,"getAiTransportHost"),before);
 });
 test("Private defining spies preserve foreign replacement and both restoration failures",()=>{
  const module={getAiTransportHost(){}},restores=[],foreign=()=>{},install=privateDefiningFactory(module,{},privateDefiningFakeVi());
  install(module,"getAiTransportHost",()=>{},restores);module.getAiTransportHost=foreign;assert.throws(()=>restores[0]());assert.equal(module.getAiTransportHost,foreign);
  const second={getAiTransportHost(){}},pending=[];let deny=false;
  const object=Object.create(Object);object.defineProperty=(...args)=>{if(deny)throw undefined;return Object.defineProperty(...args);};
  privateDefiningFactory(second,{},privateDefiningFakeVi({restoreThrows:true,reason:undefined}),object)(second,"getAiTransportHost",()=>{},pending);deny=true;
  let failure;try{pending[0]();}catch(error){failure=error;}assert.deepEqual(failure.errors,[undefined,undefined]);
 });
 // END Private defining module spy inert regressions

 function privateSelectionFactory(){
  const source=readFileSync(new URL("./fixtures/openclaw-private-catalogs-contract.test.ts",import.meta.url),"utf8");
  const a="export function createPrivateSelectionWitness(",b="// Invocation ownership,";assert.equal(source.split(a).length,2);
  return new Function(stripTypeScriptTypes(source.slice(source.indexOf(a),source.indexOf(b)).replace(/^export /gm,""),{mode:"strip"})+";return createPrivateSelectionWitness;")();
 }
 function privateSelectionHarness(options={}){
  const owner={},model={},receiver={},faults=[],calls=[],fetcher=function(){},globalObject={fetch:function(){}},closure=function(){};
  let h,thrown=false;
  const original=function(...args){calls.push(["build",this,args]);if(options.buildReentrant)h.lookup();if(options.buildThrows){thrown=true;throw options.reason;}return options.nullish?options.nullValue:options.globalReturn?globalObject.fetch:fetcher;};
  let host={buildModelFetch:original};if(Object.hasOwn(options,"host"))host=options.host;
  const before=host&&!privateNodeTypes.isProxy(host)?Object.getOwnPropertyDescriptor(host,"buildModelFetch"):undefined,invocation=Object.freeze({owner,kind:"inference",args:Object.freeze([model])});
  const w=privateSelectionFactory()(owner,options.proxyCheck??privateNodeTypes.isProxy,faults,globalObject);
  w.globalDescriptor(Object.getOwnPropertyDescriptor(globalObject,"fetch"));if(!options.deferBind)w.bind(invocation);
  h={owner,model,receiver,host,before,invocation,w,faults,calls,fetcher,globalObject,closure,
   lookup(){return w.lookup(function(...args){calls.push(["lookup",this,args]);if(options.lookupThrows)throw options.reason;return host;},receiver,[1,2]);},
   build(){return Reflect.apply(host.buildModelFetch,host,[model,undefined,{sanitizeSse:true}]);},
   hook(value){return w.hook(function(...args){calls.push(["hook",this,args]);if(options.hookThrows)throw options.reason;return closure;},receiver,[value,undefined,model]);},
   run(){assert.equal(h.lookup(),host);const value=h.build();assert.equal(h.hook(value??globalObject.fetch),closure);return w.snapshot(invocation);},
  };return h;
 }
 test("Private selection V10 preserves original host fetch closure receiver and arguments",()=>{
  for(const options of [{},{nullish:true,nullValue:null},{nullish:true,nullValue:undefined},{globalReturn:true}]){
   const h=privateSelectionHarness(options);assert.equal(h.run(),options.nullish?7:6);assert.equal(h.calls.length,3);
   assert.equal(h.calls[0][1],h.receiver);assert.deepEqual(h.calls[0][2],[1,2]);assert.equal(h.calls[1][1],h.host);assert.equal(h.calls[1][2][0],h.model);
   assert.equal(h.calls[2][1],h.receiver);assert.equal(h.calls[2][2][0],options.nullish||options.globalReturn?h.globalObject.fetch:h.fetcher);
   h.w.restore();assert.deepEqual(Object.getOwnPropertyDescriptor(h.host,"buildModelFetch"),h.before);assert.deepEqual(h.faults,[]);
  }
 });
 test("Private selection V10 missing callbacks remain unobserved and incomplete chains stay incomplete",()=>{
  const h=privateSelectionHarness();assert.equal(h.w.snapshot(h.invocation),0);h.lookup();assert.equal(h.w.snapshot(h.invocation),2);h.build();assert.equal(h.w.snapshot(h.invocation),4);h.w.restore();
 });
 test("Private selection V10 rejects duplicate interleaved foreign and wrong selected identities",()=>{
  for(const kind of ["lookup","build","hook","invocation","foreign-context","model","receiver","fetch","global-custody","nonfunction"]){
   const h=privateSelectionHarness({nullish:kind==="global-custody"});h.lookup();const value=h.build();
   if(kind==="lookup")h.lookup();if(kind==="build")h.build();if(kind==="hook")h.hook(value);
   if(kind==="invocation")h.w.bind(Object.freeze({owner:h.owner,kind:"inference",args:[h.model]}));
   if(kind==="foreign-context")assert.equal(h.w.snapshot({}),1);
   if(kind==="model"||kind==="receiver")Reflect.apply(h.host.buildModelFetch,kind==="receiver"?{}:h.host,[kind==="model"?{}:h.model]);
   if(kind==="global-custody")h.globalObject.fetch=function(){};
   h.hook(kind==="fetch"?function(){}:kind==="nonfunction"?undefined:value??h.globalObject.fetch);
   assert.equal(h.w.snapshot(h.invocation),1,kind);h.w.restore();
  }
 });
 test("Private selection V10 unsupported hosts never invoke getters or Proxy traps",()=>{
  let getters=0,traps=0;const inherited=Object.create({buildModelFetch(){}}),accessor={get buildModelFetch(){getters++;throw undefined;}},locked={};Object.defineProperty(locked,"buildModelFetch",{value(){},writable:false,configurable:false});
  const proxy=new Proxy({},{getOwnPropertyDescriptor(){traps++;throw undefined;}});
  for(const host of [null,undefined,inherited,accessor,locked,proxy]){const h=privateSelectionHarness({host,proxyCheck:privateNodeTypes.isProxy});
   h.lookup();assert.equal(h.w.snapshot(h.invocation),10);h.w.restore();assert.equal(h.calls.length,1);}
  assert.equal(getters,0);assert.equal(traps,0);
 });
 test("Private selection V10 original throws including undefined keep exact identity",()=>{
  for(const at of ["lookup","build","hook"])for(const reason of [undefined,{}]){
   const h=privateSelectionHarness({[at+"Throws"]:true,reason});let present=false,caught;
   try{h.run();}catch(error){present=true;caught=error;}assert.equal(present,true);assert.equal(caught,reason);assert.equal(h.w.snapshot(h.invocation),reason===undefined?8:9);
   assert.deepEqual(h.calls.map(x=>x[0]),["lookup","build","hook"].slice(0,["lookup","build","hook"].indexOf(at)+1));h.w.restore();
  }
 });
 test("Private selection V10 reentrant and late original calls cannot revive a chain",()=>{
  const h=privateSelectionHarness({buildReentrant:true});assert.equal(h.run(),1);h.w.restore();assert.equal(h.calls.filter(x=>x[0]==="lookup").length,2);
  const late=privateSelectionHarness();late.run();const retained=late.host.buildModelFetch;late.w.restore();Reflect.apply(retained,late.host,[late.model]);assert.equal(late.w.snapshot(late.invocation),1);assert.equal(late.faults.length,1);
  late.w.lookup(()=>late.host,undefined,[]);assert.equal(late.faults.length,2);
 });
 test("Private selection V10 restoration conflicts preserve independent original and undefined faults",async()=>{
  const h=privateSelectionHarness();h.run();const foreign=function(){};h.host.buildModelFetch=foreign;let conflict;
  try{h.w.restore();}catch(error){conflict=error;}assert.ok(conflict);assert.equal(h.host.buildModelFetch,foreign);assert.equal(h.w.snapshot(h.invocation),1);
  const record=privateSelectionHarness({proxyCheck(){throw undefined;}});record.lookup();assert.deepEqual(record.faults,[undefined]);assert.equal(record.w.snapshot(record.invocation),1);
  let aggregate;try{await finishPrivateOwned(async()=>{throw undefined;},[()=>{throw record.faults[0];},()=>{throw conflict;}]);}catch(error){aggregate=error;}assert.deepEqual(aggregate.errors,[undefined,undefined,conflict]);
 });

 test("Private selection V10 actual transport binds only the same original invocation",()=>{
  for(const foreign of [false,true]){
   const selection=privateSelectionHarness({deferBind:!foreign}),signal={},caller={owner:selection.owner,kind:"inference",signal};
   let context,reads=0;const storage={getStore(){reads++;return context;},run(v,fn){const old=context;context=v;try{return fn();}finally{context=old;}},disable(){}};
   const factory=new Function(stripTypeScriptTypes(privateOwnershipSource().replace(/^export /gm,""),{mode:"strip"})+";return createPrivateInvocationOwnership;")();
   const faults=[],ops=[],acs=[],w={owner:selection.owner,acquisitions:acs,originals:ops};
   const o=factory(storage,{ledger:w,owner:w.owner,acquisitions:acs,originals:ops,isProxy:privateNodeTypes.isProxy,selection:selection.w}),trace=[];
   let caught;try{o.invoke(caller,"inference",()=>{selection.lookup();const returned=selection.build();selection.hook(returned);o.transport({method:"POST"},x=>trace.push(x),faults);},undefined,[selection.model,null,{signal}]);}catch(e){caught=e;}
   assert.ok(caught);assert.equal(reads,1);assert.equal(trace[0][7],foreign?1:6);assert.deepEqual(faults,[]);
   const r=privateCaptureHarness();r.r.bodyCaptureFailure(0,r.row,11,caught,trace[0]);r.r.bodySite(0,r.row,20,1);r.r.mark(0,"body","rejected",caught);
   assert.equal(r.records.find(v=>v.v===10).meta[3]%11,foreign?1:6);selection.w.restore();
  }
 });

 test("Private selection V10 foreign invocation membership retains the original condition without observer faults",()=>{
  const h=privateSelectionHarness(),faults=[],traces=[],owner=h.owner,acquisitions=[],originals=[];let snapshots=0;
  const storage={getStore(){return {invocation:Object.freeze({owner,kind:"inference",args:[h.model]})};}};
  const factory=new Function(stripTypeScriptTypes(privateOwnershipSource().replace(/^export /gm,""),{mode:"strip"})+";return createPrivateInvocationOwnership;")();
  const selection={snapshot(...args){snapshots++;return h.w.snapshot(...args);}};
  const o=factory(storage,{ledger:{owner,acquisitions,originals},owner,acquisitions,originals,isProxy:privateNodeTypes.isProxy,selection});let caught;
  try{o.transport({method:"POST"},t=>traces.push(t),faults);}catch(e){caught=e;}
  assert.ok(caught);assert.deepEqual(traces,[[11,3,15,7,false,true,0,0]]);assert.equal(snapshots,0);assert.deepEqual(faults,[]);
  const r=privateCaptureHarness();r.r.bodyCaptureFailure(0,r.row,11,caught,traces[0]);r.r.bodySite(0,r.row,20,1);r.r.mark(0,"body","rejected",caught);
  assert.equal(r.r.failures.length,0);assert.ok(r.records.find(x=>x.v===10));h.w.restore();
 });
 test("Private selection V10 defining spy installation forwards originals and restores partial installation",()=>{
  const source=readFileSync(new URL("./fixtures/openclaw-private-catalogs-contract.test.ts",import.meta.url),"utf8");
  const a=source.indexOf('  if(selection){\n   for(const [module,name,observe]'),b=source.indexOf('  spy=vi.spyOn(guard',a);assert.ok(a>=0&&b>a);
  const code=stripTypeScriptTypes(source.slice(a,b),{mode:"strip"});
  for(const failSecond of [false,true]){
   const h=privateSelectionHarness(),restores=[],calls=[];let spies=0;
   const transportHost={getAiTransportHost(...args){calls.push([this,args]);return h.host;}},openAITransport={withOpenAIErrorResponseHook(...args){calls.push([this,args]);return h.closure;}};
   const before=[Object.getOwnPropertyDescriptor(transportHost,"getAiTransportHost"),Object.getOwnPropertyDescriptor(openAITransport,"withOpenAIErrorResponseHook")];
   const fakeVi=privateDefiningFakeVi(),vi={spyOn(...args){if(++spies===2&&failSecond)throw undefined;return fakeVi.spyOn(...args);}};
   const installPrivateDefiningSpy=privateDefiningFactory(transportHost,openAITransport,vi);
   const execution=privateExecutionWitness()("a".repeat(64),()=>({invocation:h.invocation}),{guard(){}},h.faults);execution.bind(h.invocation);
   let present=false;try{new Function("selection","transportHost","openAITransport","restores","installPrivateDefiningSpy","callbacks","execution",code)(h.w,transportHost,openAITransport,restores,installPrivateDefiningSpy,undefined,execution);}catch(e){present=true;assert.equal(e,undefined);}
   assert.equal(present,failSecond);assert.equal(spies,2);assert.equal(restores.length,failSecond?2:3);
   execution.channel.observe(2,{},4,[before[0].value,h.host]);assert.equal(execution.snapshot(h.invocation)[4],1);
   if(!failSecond){assert.equal(Reflect.apply(transportHost.getAiTransportHost,h.receiver,[1,2]),h.host);const value=h.build();assert.equal(Reflect.apply(openAITransport.withOpenAIErrorResponseHook,h.receiver,[value,undefined,h.model]),h.closure);assert.equal(h.w.snapshot(h.invocation),6);assert.equal(calls.length,2);assert.equal(calls[0][0],h.receiver);}
   for(const restore of restores.toReversed())restore();
   assert.deepEqual(Object.getOwnPropertyDescriptor(transportHost,"getAiTransportHost"),before[0]);assert.deepEqual(Object.getOwnPropertyDescriptor(openAITransport,"withOpenAIErrorResponseHook"),before[1]);
  }
 });
 test("Private selection V10 reserved producer and relay preserve V8 V9 and uncertainty",()=>{
  const {validatePrivateCheckpoint}=privateCheckpointFunctions();
  for(let code=0;code<=10;code++){
   const h=privateCaptureHarness();h.r.bodyCaptureFailure(0,h.row,11,undefined,[11,5,63,31,false,false,129,code]);h.r.bodySite(0,h.row,20,1);h.r.mark(0,"body","rejected",undefined);
   const cap=h.records.find(x=>x.v===10);assert.ok(cap);validatePrivateCheckpoint(cap);assert.equal(cap.meta[3]%11,code);
   const lines=[],emit=privateAnnotationEmitter(line=>lines.push(line));emit(cap);assert.ok(Buffer.byteLength(lines[0])<=418);assert.ok(Buffer.byteLength(JSON.stringify(cap))<=375);
   assert.equal(JSON.stringify(privateCheckpointRecords({stdout:"PRIVATE_CHECKPOINT "+JSON.stringify(cap)+"\n"})),JSON.stringify([cap]));
   for(const change of [{v:9},{case:4},{decl:4},{lane:"outer"},...[-1,8712,Number.NaN,Infinity,null,[],[1],"1",true].map(n=>({meta:[...cap.meta.slice(0,3),n,cap.meta[4]]}))])assert.throws(()=>validatePrivateCheckpoint({...cap,...change}));
  }
 });


 // BEGIN Private callback V11 inert regressions
 function privateCallbackFactory(object=Object){
  const source=readFileSync(new URL("./fixtures/openclaw-private-catalogs-contract.test.ts",import.meta.url),"utf8");
  const code=source.slice(source.indexOf("export function createPrivateCallbackWitness("),source.indexOf("export function installPrivateDefiningSpy("));
  return new Function("Object",stripTypeScriptTypes(code.replace(/^export /gm,""),{mode:"strip"})+";return createPrivateCallbackWitness;")(object);
 }
 function privateCallbackDecoded(word){
  if(word===null)return null;const custody=[word%3,Math.floor(word/3)%3];word=Math.floor(word/9);const rows=[];
  for(let k=0;k<3;k++){const n=k===2?word:word%81;word=Math.floor(word/81);const early=n%9,late=Math.floor(n/9),at=k===2&&late?Math.floor((late-1)/3)+1:late;rows.push([early?Math.floor((early-1)/4)+1:0,at?Math.floor((at-1)/4)+1:0,early?(early-1)%4+1:0,at?(at-1)%4+1:0,k===2&&late?(late-1)%3:0]);}
  return {custody,rows};
 }
 function privateCallbackHarness(options={}){
  const owner={},faults=[],model={},invocation=Object.freeze({owner,kind:"inference",args:Object.freeze([model])});
  const w=privateCallbackFactory(options.object)(owner,options.proxyCheck??privateNodeTypes.isProxy,faults);
  return {owner,faults,model,invocation,w,bind(){w.bind(invocation);},snapshot(){return privateCallbackDecoded(w.snapshot(invocation));}};
 }
 test("Private callback V11 distinguishes before binding and original entry outcomes without authority",()=>{
  for(const reason of [undefined,{}]){
   const h=privateCallbackHarness();const before=h.w.enter(2);h.w.threw(before,reason);h.bind();
   assert.deepEqual(h.snapshot().rows[2],[1,0,reason===undefined?3:4,0,0]);
   const first=h.w.enter(2);assert.deepEqual(h.snapshot().rows[2],[1,1,reason===undefined?3:4,1,0]);h.w.threw(first,reason);
   assert.deepEqual(h.snapshot().rows[2],[1,1,reason===undefined?3:4,reason===undefined?3:4,0]);
   const other=h.w.enter(2);h.w.returned(other);assert.deepEqual(h.snapshot().rows[2],[1,2,reason===undefined?3:4,reason===undefined?3:4,0]);
   assert.equal(h.w.snapshot({}),null);assert.deepEqual(h.faults,[]);
  }
 });
 test("Private callback V11 defining spies keep captured outside originals unobserved and restore getters",()=>{
  for(const getter of [false,true]){
   const h=privateCallbackHarness(),module={},restores=[],receiver={},args=[{},undefined],result={},calls=[];let reads=0;
   const original=function(...a){calls.push([this,a]);return result;};
   Object.defineProperty(module,"getAiTransportHost",getter?{configurable:true,enumerable:true,get(){reads++;return original;}}:{configurable:true,writable:true,value:original});
   const before=Object.getOwnPropertyDescriptor(module,"getAiTransportHost");
   privateDefiningFactory(module,{},privateDefiningFakeVi())(module,"getAiTransportHost",(fn,self,a)=>Reflect.apply(fn,self,a),restores,h.w);
   h.bind();assert.equal(Reflect.apply(original,receiver,args),result);assert.deepEqual(h.snapshot(),{custody:[1,0],rows:[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]]});
   assert.equal(Reflect.apply(module.getAiTransportHost,receiver,args),result);assert.deepEqual(h.snapshot().rows[0],[0,1,0,2,0]);assert.deepEqual(calls,[[receiver,args],[receiver,args]]);
   restores[0]();assert.deepEqual(Object.getOwnPropertyDescriptor(module,"getAiTransportHost"),before);assert.equal(reads,getter?1:0);
  }
 });
 test("Private callback V11 descriptor replacement is permanent and never reads an export getter",()=>{
  const h=privateCallbackHarness(),module={getAiTransportHost(){}},restores=[];let reads=0;
  privateDefiningFactory(module,{},privateDefiningFakeVi())(module,"getAiTransportHost",(fn,self,args)=>Reflect.apply(fn,self,args),restores,h.w);h.bind();
  const installed=Object.getOwnPropertyDescriptor(module,"getAiTransportHost");Object.defineProperty(module,"getAiTransportHost",{configurable:true,get(){reads++;throw undefined;}});
  assert.equal(h.snapshot().custody[0],2);assert.equal(reads,0);assert.throws(()=>restores[0]());
  Object.defineProperty(module,"getAiTransportHost",installed);assert.equal(h.snapshot().custody[0],2);
 });
 test("Private callback V11 original guard entry precedes all input reads and preserves undefined",()=>{
  const source=readFileSync(new URL("./fixtures/openclaw-private-catalogs-contract.test.ts",import.meta.url),"utf8");
  const a=source.indexOf(' const observeGuard='),b=source.indexOf(' w.executedGuard=',a);assert.ok(a>0&&b>a);
  const code=stripTypeScriptTypes(source.slice(a,b)+';const callback=function(...args){return observeGuard(originalGuard,this,args);};',{mode:"strip"});
  for(const reason of [undefined,{}]){
   const h=privateCallbackHarness();h.bind();let reads=0,originalCalls=0;const w={sequence:0,acquisitions:[]};
   const deps={callbacks:h.w,originalGuard(){originalCalls++;},w,signalHistory(){throw Error("unreached history");},record(){throw Error("unreached record");},returned(){},ownership:{},checkpoints:{},caseIndex:0,row:{},observer(){},transports:[],expect(){},patch(){}};
   const callback=new Function(...Object.keys(deps),code+';return callback;')(...Object.values(deps));
   const input={get signal(){reads++;throw reason;}};let present=false,caught;try{callback.call({},input);}catch(error){present=true;caught=error;}
   assert.equal(present,true);assert.equal(caught,reason);assert.equal(reads,1);assert.equal(originalCalls,0);assert.equal(w.acquisitions.length,0);
   assert.deepEqual(h.snapshot().rows[2],[0,1,0,reason===undefined?3:4,0]);assert.deepEqual(h.faults,[]);
  }
 });
 test("Private callback V11 actual current binds only its existing invocation without extra context reads",()=>{
  for(const mode of ["proper","restored","foreign"]){
   const h=privateCallbackHarness(),acquisitions=[],originals=[],ledger={owner:h.owner,acquisitions,originals};let store,reads=0,dispatch=0;
   const storage={getStore(){reads++;return store;},run(value,fn){const old=store;store=value;try{return fn();}finally{store=old;}},disable(){}};
   const factory=new Function(stripTypeScriptTypes(privateOwnershipSource().replace(/^export /gm,""),{mode:"strip"})+';return createPrivateInvocationOwnership;')();
   const owner=factory(storage,{owner:h.owner,ledger,acquisitions,originals,isProxy:privateNodeTypes.isProxy,callbacks:h.w});
   const caller={owner:h.owner,kind:"inference",signal:undefined},traces=[];let capture;
   owner.invoke(caller,"inference",()=>{capture=store.invocation;const outer=store,entry=h.w.enter(2),input={},guard=()=>{
    const run=()=>{owner.transport({method:"POST"},t=>traces.push(t),h.faults);dispatch++;};
    if(mode==="restored")return storage.run(outer,run);return run();
   },a={input,guard,callbackEntry:entry};
   if(mode==="foreign")h.w.associate(entry,{});
   try{owner.guard(guard,undefined,[input],a);h.w.returned(entry);}catch(error){h.w.threw(entry,error);}
   },undefined,[h.model,{},{}]);
   const snap=privateCallbackDecoded(h.w.snapshot(capture));assert.equal(reads,2);assert.equal(dispatch,mode==="restored"?0:1);
   if(mode==="foreign"){assert.equal(snap,null);assert.equal(h.faults.length,1);}else{assert.equal(snap.rows[2][4],1);assert.equal(snap.rows[2][3],mode==="restored"?4:2);}
   if(mode==="restored")assert.deepEqual(traces[0].slice(0,6),[11,5,63,31,false,true]);
  }
 });
 test("Private callback V11 nested foreign invocation never borrows the target binding",()=>{
  const h=privateCallbackHarness(),acquisitions=[],originals=[],ledger={owner:h.owner,acquisitions,originals};let store,reads=0,calls=0,target;
  const storage={getStore(){reads++;return store;},run(value,fn){const old=store;store=value;try{return fn();}finally{store=old;}},disable(){}};
  const factory=new Function(stripTypeScriptTypes(privateOwnershipSource().replace(/^export /gm,""),{mode:"strip"})+';return createPrivateInvocationOwnership;')();
  const own=factory(storage,{owner:h.owner,ledger,acquisitions,originals,isProxy:privateNodeTypes.isProxy,callbacks:h.w});
  const caller={owner:h.owner,kind:"inference",signal:undefined},foreign={owner:h.owner,kind:"discovery",signal:undefined};
  own.invoke(caller,"inference",()=>{target=store.invocation;
   own.invoke(foreign,"discovery",()=>{const entry=h.w.enter(2),input={},guard=function(){calls++;return undefined;};
    assert.equal(own.guard(guard,undefined,[input],{input,guard,callbackEntry:entry}),undefined);h.w.returned(entry);
   },undefined,[{}]);
  },undefined,[h.model,{},{}]);
  assert.equal(reads,1);assert.equal(calls,1);assert.deepEqual(privateCallbackDecoded(h.w.snapshot(target)).rows[2],[0,1,0,2,2]);assert.deepEqual(h.faults,[]);
 });
 test("Private callback V11 independent observation and restoration faults preserve original undefined failures",async()=>{
  for(const reason of [undefined,{}]){
   const h=privateCallbackHarness({proxyCheck(){throw reason;}}),module={getAiTransportHost(){throw undefined;}},restores=[];
   privateDefiningFactory(module,{},privateDefiningFakeVi({restoreThrows:true,reason:undefined}))(module,"getAiTransportHost",(fn,self,args)=>Reflect.apply(fn,self,args),restores,h.w);
   let present=false,caught;try{module.getAiTransportHost();}catch(error){present=true;caught=error;}assert.equal(present,true);assert.equal(caught,undefined);assert.equal(h.faults[0],reason);
   let all;try{await finishPrivateOwned(async()=>{throw caught;},[()=>{if(h.faults.length)throw new AggregateError(h.faults);},restores[0],()=>{throw undefined;}]);}catch(error){all=error;}
   assert.equal(all.errors[0],undefined);assert.equal(all.errors[1].errors[0],reason);assert.equal(all.errors[2],undefined);assert.equal(all.errors[3],undefined);
  }
  let fail=false;const object=Object.create(Object);object.getOwnPropertyDescriptor=(...args)=>{if(fail)throw undefined;return Object.getOwnPropertyDescriptor(...args);};
  const h=privateCallbackHarness({object}),module={getAiTransportHost(){}},restores=[];privateDefiningFactory(module,{},privateDefiningFakeVi())(module,"getAiTransportHost",(fn,self,a)=>Reflect.apply(fn,self,a),restores,h.w);h.bind();fail=true;
  assert.equal(h.snapshot(),null);assert.deepEqual(h.faults,[undefined]);fail=false;assert.equal(h.snapshot(),null);restores[0]();
 });
 test("Private callback V11 reserved capsule preserves legacy condition and rejects contradictory encodings",()=>{
  const validate=privateCheckpointFunctions().validatePrivateCheckpoint;
  for(const reason of [undefined,{}])for(const before of [false,true]){
   const w=privateCallbackHarness();if(before)w.w.returned(w.w.enter(0));w.bind();w.w.threw(w.w.enter(2),reason);
   const word=w.w.snapshot(w.invocation),h=privateCaptureHarness();h.r.bodyCaptureFailure(0,h.row,11,reason,[11,5,63,31,false,reason!==undefined,129,0,word]);h.r.bodySite(0,h.row,20,1);h.r.mark(0,"body","rejected",reason);
   const cap=h.records.find(v=>v.v===11);assert.ok(cap);validate(cap);assert.equal(Math.floor(cap.meta[3]/8712)-1,word);
   const legacy={...cap,v:10,meta:[...cap.meta.slice(0,3),cap.meta[3]%8712,cap.meta[4]]};validate(legacy);
   assert.equal(JSON.stringify(privateCheckpointRecords({stdout:"PRIVATE_CHECKPOINT "+JSON.stringify(cap)})),JSON.stringify([cap]));
   for(const records of [[cap,legacy],[legacy,cap]]){const lines=[],emit=privateAnnotationEmitter(x=>lines.push(x));records.forEach(emit);assert.ok(lines.every(x=>Buffer.byteLength(x)<=418));}
   for(const value of [-1,8711,8712*13286026,NaN,Infinity,null,[],{},"1",true,8712+11])assert.throws(()=>validate({...cap,meta:[...cap.meta.slice(0,3),value,cap.meta[4]]}));
   assert.ok(Buffer.byteLength(JSON.stringify(cap))<=375);
  }
 });
 test("Private callback V11 closes original metadata shape before reconstruction and parent output",async()=>{
  const h=privateCaptureHarness();h.r.bodyCaptureFailure(0,h.row,11,undefined,[11,5,63,31,false,false,129,0,0]);h.r.bodySite(0,h.row,20,1);h.r.mark(0,"body","rejected",undefined);
  const cap=h.records.find(x=>x.v===11),validate=privateCheckpointFunctions().validatePrivateCheckpoint;assert.ok(cap);validate(cap);
  const invalid=[...[{extra:true},null,7,[]].map(extra=>[...cap.meta,extra]),undefined,null,{},"metadata",
   Object.assign({},cap.meta,{length:5}),...Array.from({length:5},(_,n)=>cap.meta.slice(0,n)),
   ...Array.from({length:5},(_,n)=>{const sparse=[...cap.meta];delete sparse[n];return sparse;})];
  for(const meta of invalid){const record={...cap,meta};assert.throws(()=>validate(record));
   const child={stdout:"PRIVATE_CHECKPOINT "+JSON.stringify(record)+"\n"};assert.throws(()=>privateCheckpointRecords(child));
   const lines=[];let failure;try{await withPrivateNativeDiagnostics(()=>{throw child;},privateAnnotationEmitter(line=>lines.push(line)));}catch(error){failure=error;}
   assert.ok(failure instanceof AggregateError);assert.equal(failure.errors[0],child);assert.equal(failure.errors.length,2);assert.deepEqual(lines,[]);
  }
  for(const extra of [{extra:true},null,7,[]])assert.throws(()=>validate({...cap,v:10,meta:[...cap.meta.slice(0,3),cap.meta[3]%8712,cap.meta[4],extra]}));
 });
 // END Private callback V11 inert regressions

  test("Private capture V12 construction literals preserve the original capture and fetch trace",async()=>{
   for(const captureObserver of [1,2])for(const reason of [undefined,{}]){
    for(let failAt=5;failAt<=20;failAt++){
     const old=privateCaptureHarness({failAt,reason}),now=privateCaptureHarness({failAt,reason,captureObserver});
     for(const h of [old,now])assert.throws(()=>Reflect.apply(h.wrapped,h.receiver,[h.input,h.init]),e=>e===reason);
     assert.deepEqual(now.calls,old.calls);assert.equal(now.fetchCalls,0);
     const prior=old.capsule(),cap=now.capsule();assert.equal(cap.v,12);assert.equal(cap.meta[3][0]%3,captureObserver);
     assert.equal(JSON.stringify({...cap,v:prior.v,meta:[...cap.meta.slice(0,3),[Math.floor(cap.meta[3][0]/3),...cap.meta[3].slice(1)],cap.meta[4]]}),JSON.stringify(prior));
    }
    for(const fetchThrow of [false,true]){
     const old=privateCaptureHarness({fetchThrow,reason}),now=privateCaptureHarness({fetchThrow,reason,captureObserver});
     for(const h of [old,now]){if(fetchThrow)assert.throws(()=>Reflect.apply(h.wrapped,h.receiver,[h.input,h.init]),e=>e===reason);
      else {const result=Reflect.apply(h.wrapped,h.receiver,[h.input,h.init]);assert.equal(result,h.pending);await result;}
      assert.equal(h.fetchCalls,1);assert.equal(h.actualReceiver,h.receiver);assert.deepEqual(h.actualArgs,[h.input,h.init]);}
     assert.deepEqual(now.calls,old.calls);assert.equal(JSON.stringify(now.capsule()),JSON.stringify(old.capsule()));
    }
   }
   const source=readFileSync(new URL("./fixtures/openclaw-private-catalogs-contract.test.ts",import.meta.url),"utf8");
   assert.equal(source.split("observedFetch(nativeFetch,1)").length,2);assert.equal(source.split("observedFetch(originalUndiciFetch,2)").length,2);
  });
  test("Private capture V12 keeps the first construction tag and leaves absent or unreached observations unknown",()=>{
   for(const tag of [0,1,2]){
    const h=privateCaptureHarness({captureObserver:tag});assert.equal(h.capsule().meta.length,5);assert.equal(h.fetchCalls,0);
    const first=privateCaptureHarness();first.r.bodyCaptureFailure(0,first.row,6,undefined,null,tag);
    first.r.bodyCaptureFailure(0,first.row,11,{},null,tag===1?2:1);const cap=first.capsule();
    assert.equal(cap.meta.length,5);if(tag)assert.equal(cap.meta[3][0]%3,tag);
    assert.deepEqual(JSON.parse(JSON.stringify(tag?[Math.floor(cap.meta[3][0]/3),...cap.meta[3].slice(1)]:cap.meta[3])),[6,1,false]);
   }
   for(const tag of [-1,3,true,"1",null,{},[]]){
    const h=privateCaptureHarness();h.r.bodyCaptureFailure(0,h.row,6,undefined,null,tag);
    assert.equal(h.r.failures.length,1);assert.equal(h.capsule().meta[3],null);
   }
   const foreign=privateCaptureHarness();foreign.r.bodyCaptureFailure(0,{},6,undefined,null,1);
   assert.equal(foreign.r.failures.length,1);assert.equal(foreign.capsule().meta.length,5);
  });
  test("Private capture V12 closes the whole tagged shape before parent emission",()=>{
   const validate=privateCheckpointFunctions().validatePrivateCheckpoint;
   for(const tag of [1,2])for(const condition of [null,[11,5,63,31,false,false,129,0],[11,5,63,31,false,false,129,0,0]]){
    const h=privateCaptureHarness();h.r.bodyCaptureFailure(0,h.row,11,undefined,condition,tag);const cap=h.capsule();validate(cap);
    assert.equal(cap.v,12);assert.equal(JSON.stringify(privateCheckpointRecords({stdout:"PRIVATE_CHECKPOINT "+JSON.stringify(cap)})),JSON.stringify([cap]));
    const packed=cap.meta[3],badTags=typeof packed==="number"?[Math.floor(packed/3)*3,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER]:[-1,0,null,true,"1",{},[],Math.floor(packed[0]/3)*3].map(x=>[x,...packed.slice(1)]);
    for(const meta of [cap.meta.slice(0,4),[...cap.meta,null],[...cap.meta,{}],null,{},...badTags.map(x=>[...cap.meta.slice(0,3),x,cap.meta[4]])]){
     const invalid={...cap,meta};assert.throws(()=>validate(invalid));let writes=0;
     assert.throws(()=>privateCheckpointRecords({stdout:"PRIVATE_CHECKPOINT "+JSON.stringify(invalid)}).forEach(privateAnnotationEmitter(()=>writes++)));assert.equal(writes,0);
    }
    for(const patch of [{case:1},{decl:4},{lane:"outer"},{meta:[...cap.meta.slice(0,3),[2*3+tag,1,false],cap.meta[4]]}])assert.throws(()=>validate({...cap,...patch}));
   }
  });
  test("Private capture V12 retains undefined primary reporting and restoration failures independently",async()=>{
   for(const captureObserver of [1,2])for(const reason of [undefined,{}])for(const restoreReason of [undefined,{}]){
    const h=privateCaptureHarness({captureObserver,failAt:11,reason,reportThrow:true});let caught;
    try{await finishPrivateOwned(()=>Reflect.apply(h.wrapped,h.receiver,[h.input,h.init]),[()=>{throw h.w.observerFailures[0];},()=>{throw restoreReason;}]);}catch(error){caught=error;}
    assert.deepEqual(caught.errors,[reason,undefined,restoreReason]);assert.equal(h.fetchCalls,0);assert.equal(h.capsule().meta.length,5);
   }
  });
  test("Private capture V12 primary writer failures keep the captured tag and independent raw failures",async()=>{
   for(const tag of [1,2])for(const reason of [undefined,{}])for(const reportReason of [undefined,{}]){
    const records=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter("sdk",record=>{records.push(record);if(record.v===12)throw reportReason;});
    const row={provider:"baseten",api:"stream",control:"eof"};r.bindCase(0,0);r.bindBody(0,row,[]);r.bindBodyMetadata(0,row,privateNodeTypes.isProxy);
    r.bodyCaptureFailure(0,row,11,reason,[11,5,63,31,false,reason!==undefined,129,0,0],tag);r.bodySite(0,row,20,1);r.mark(0,"body","rejected",reason);
    const cap=records.find(x=>x.v===12);assert.equal(cap.meta[3]%3,tag);assert.equal(cap.defined,reason!==undefined);assert.deepEqual([...r.failures],[reportReason]);
    let caught;try{await finishPrivateOwned(()=>{throw reason;},[()=>{throw r.failures[0];},()=>{throw undefined;}]);}catch(error){caught=error;}
    assert.deepEqual(caught.errors,[reason,reportReason,undefined]);assert.equal(records.filter(x=>x.v===12).length,1);
   }
  });

// END Private capture entry inert regressions
 // BEGIN Private EOF body witness inert regressions
 function privateEOFSource(deps){
  const source=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function session('),source.indexOf('function failedCatalog('))+
   source.slice(source.indexOf('async function diagnosticControl('),source.indexOf('checkpoints.registration("describe","enter")'));
  return new Function(...Object.keys(deps),'"use strict";'+stripTypeScriptTypes(code,{mode:'strip'})+';return {session,diagnosticControl};')(...Object.values(deps));
 }
 async function privateEOFRun({fail=0,reason=undefined,reject=false,stop='stop',reportFail=false,saturate=false,operand=false,fields={},http=null,hookFault=null,proxyCheck=privateNodeTypes.isProxy}={}){
  const out=[],calls=[],reads=[],row={id:'inert',provider:'baseten',api:'stream',scenario:'eof',control:'eof'},report=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',r=>{out.push(r);if(reportFail&&[4,5,6].includes(r.v))throw undefined;});
  if(saturate)for(let i=0;i<20;i++){report.mark(i,'module','fulfilled');report.flush(i);}
  report.mark(null,'callback','enter',undefined,null,null,0);report.mark(null,'selection','fulfilled',undefined,null,null,0);report.bindCase(0,0);report.mark(0,'setup','fulfilled');report.mark(0,'owner','fulfilled');report.bindBody(0,row,reads);report.bindBodyMetadata(0,row,proxyCheck);
  let site=0,discoveryP,resultP,stopGets=0,resultCalls=0,bodyPending;
  const at=report.bodySite;report.bodySite=function(...args){site=args[2];return Reflect.apply(at,report,args);};
  const check=id=>{if(id>0&&fail===id)throw reason;};
  const model={id:'tenant/opaque-a'};if(operand&&fail===11)Object.defineProperty(model,'opaque',{enumerable:true,get(){throw reason;}});
  const provider={baseUrl:'https://fixture.invalid/v1/native/baseten',api:'openai-completions',models:[model]};
  const value={...fields,get stopReason(){stopGets++;if(operand&&fail===20)throw reason;return stop;},content:[{type:'text',text:'private-prefix'}],usage:{input:4,output:3,totalTokens:7}};
  const key=()=> 'synthetic-key',base=()=>provider.baseUrl;
  const catalog={run(...args){calls.push('catalog');assert.equal(this,catalog);assert.equal(args.length,1);check(4);discoveryP=fail===5?Promise.reject(reason):Promise.resolve({provider});return discoveryP;}};
  function stream(...args){calls.push('stream');assert.equal(this,undefined);assert.equal(args.length,3);assert.equal(args[2].maxTokens,16);assert.equal(args[2].apiKey,key());check(14);if(http!==null){const response=typeof http==='number'?{status:http}:http;const options=args[2];if(hookFault==='foreign')options.onResponse.call({},response,args[0]);else{options.onResponse(response,args[0]);if(hookFault==='duplicate')options.onResponse(response,args[0]);}}
   return {result(){resultCalls++;calls.push('result');check(15);resultP=fail===18?Promise.reject(reason):Promise.resolve(value);return resultP;}};}
  const plugin={id:'baseten',catalog,wrapStreamFn({streamFn}){check(12);assert.equal(streamFn,stream);return streamFn;}};
  const expect=value=>({toBe(expected){if(site===20&&stop!=='stop')throw reason;if(!operand)check(site);assert.equal(value,expected);},
   toBeDefined(){check(site);assert.notEqual(value,undefined);},toBeTypeOf(type){check(site);assert.equal(typeof value,type);},
   toContain(expected){check(site);assert.ok(value.includes(expected));},toContainEqual(expected){check(site);assert.deepEqual(value,[expected]);},toMatchObject(expected){check(site);assert.deepEqual(value,expected);}});
  const witness={begin(signal){check(13);return {signal};},invoke(c,kind,fn,receiver,args){return Reflect.apply(fn,receiver,args);},caller(){return {};},finish(c,p){calls.push('finish');check(16);assert.equal(p,resultP);}};
  let api;const deps={loadBundledPluginFacade:async()=>({default:{}}),registerSingleProviderPlugin:async()=>plugin,expect,key,base,envNames:{baseten:'BASETEN_API_KEY'},
   createProviderApiKeyResolver:()=>()=>({}),createProviderAuthResolver:()=>()=>{check(2);return {get discoveryApiKey(){if(operand&&fail===3)throw reason;return key();}};},
   stream,streamSimple:()=>{throw Error('foreign API');},checkpoints:report,checkpointCase:()=>0,
   AbortController:class{constructor(){check(1);this.signal={aborted:false};}},
   fixture:async(actual,body)=>{assert.equal(actual,row);const f=await api.session(row,{writeAuthProfiles:async()=>{},agentDir:()=>'',workspaceDir:''},(kind,p)=>{calls.push(kind);if(kind==='catalog_result')assert.equal(p,discoveryP);else{check(16);assert.equal(p,resultP);}return p;},[],witness);
    if(fail===17){const infer=f.infer;f.infer=function(...args){const original=Reflect.apply(infer,this,args);return {get result(){throw reason;},stream:original.stream};};}
    bodyPending=report.observe(0,'body',body,undefined,[f]);return await bodyPending;}};
  api=privateEOFSource(deps);let failure=false,error;
  try{await api.diagnosticControl(row);}catch(e){failure=true;error=e;}
  await report.drain();return {out,report,row,calls,failure,error,stopGets,resultCalls,bodyPending,reads};
 }
 test('Private EOF source spans preserve every original failure including undefined',async()=>{
  for(let site=1;site<=22;site++)for(const reason of [undefined,{}]){
   const r=await privateEOFRun({fail:site,reason,operand:site===11});assert.equal(r.failure,true,'site '+site);assert.equal(r.error,reason);
   const cap=r.out.find(x=>[4,5,6].includes(x.v));assert.ok(cap,'capsule '+site);assert.equal(cap.body[0],site);assert.equal(cap.body[1],[5,18].includes(site)?6:5);assert.equal(cap.defined,reason!==undefined);assert.equal(cap.owner,null);assert.equal(cap.receipt,null);
   assert.equal(r.report.failures.length,0);assert.ok(r.resultCalls<=1);assert.equal(r.out.filter(x=>[4,5,6].includes(x.v)).length,1);
  }
 });
 test('Private EOF original error result and direct rejection stay distinct with single getters',async()=>{
  const success=await privateEOFRun();assert.equal(success.failure,false);assert.equal(success.stopGets,1);assert.equal(success.resultCalls,1);assert.equal(success.report.failures.length,0);
  assert.deepEqual(success.calls,['catalog','catalog_result','stream','result','inference_result','finish']);
  const error=await privateEOFRun({stop:'error'}),rejected=await privateEOFRun({fail:18});
  assert.deepEqual([...error.out.find(x=>[4,5,6].includes(x.v)).body].filter((_,i)=>[0,1,2,5].includes(i)),[20,5,false,1]);assert.equal(error.stopGets,1);assert.equal(error.out.find(x=>[4,5,6].includes(x.v)).body[4],3);
  assert.deepEqual([...rejected.out.find(x=>[4,5,6].includes(x.v)).body].filter((_,i)=>[0,1,2,5].includes(i)),[18,6,false,null]);assert.equal(rejected.stopGets,0);assert.equal(rejected.out.find(x=>[4,5,6].includes(x.v)).body[4],1);
  for(const site of [3,20]){const r=await privateEOFRun({fail:site,operand:true});assert.equal(r.error,undefined);assert.equal(r.out.find(x=>[4,5,6].includes(x.v)).body[0],site);assert.equal(r.report.failures.length,0);}
 });
 test('Private EOF source observation does not subscribe to or substitute original promises',async()=>{
  // The actual callback and session contain no additional then/iterator/read calls.
  const source=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
  const session=source.slice(source.indexOf('async function session('),source.indexOf('function failedCatalog('));
  const eof=source.slice(source.indexOf(' if(row.control==="eof"){\n  site(2,1)'),source.indexOf(' const provider=ready(await f.discover()),pending=f.infer(provider'));
  assert.doesNotMatch(session,/\.then\(|\.read\(|getReader\(/);assert.doesNotMatch(eof,/\.then\(|for await|\.read\(/);
  const r=await privateEOFRun();assert.equal(r.failure,false);assert.equal(r.resultCalls,1);assert.equal(r.calls.filter(x=>x==='stream').length,1);
 });
 test('Private EOF first span survives saturation reporting faults and held late joins',async()=>{
  const reason={},r=await privateEOFRun({fail:21,reason,reportFail:true,saturate:true});assert.equal(r.error,reason);assert.deepEqual([...r.report.failures],[undefined]);
  const cap=r.out.find(x=>[4,5,6].includes(x.v)),before=JSON.stringify(cap);let release;const held=new Promise(resolve=>{release=resolve;});
  r.report.observe(0,'original_join',()=>held,undefined,[]);assert.equal(cap.stages[5],0);assert.equal(cap.owner,null);
  release();await r.report.drain();r.report.observe(0,'postlude',()=>Promise.reject(undefined),undefined,[]);await r.report.drain();r.report.finish();
  assert.equal(JSON.stringify(cap),before);assert.equal(r.out.filter(x=>[4,5,6].includes(x.v)).length,1);assert.ok(r.out.length<=9);
 });
 test('Private EOF foreign contexts invalidate source coverage without replacing raw failure',()=>{
  for(const mutate of [(r,row)=>r.bodySite(0,{},2,1),(r,row)=>r.bindBody(0,{},[]),(r,row)=>r.bodySite(0,row,1,2),(r,row)=>r.bodySite(0,row,23,1)]){
   const out=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',x=>out.push(x)),row={};r.bindCase(0,0);r.bindBody(0,row,[]);mutate(r,row);r.mark(0,'body','rejected',undefined);
   assert.ok(r.failures.length);assert.equal(out.some(x=>[4,5,6].includes(x.v)),false);assert.equal(out.find(x=>x.v===2).defined,false);
  }
 });
 test('Private EOF V4 source tuple is bounded and relays within the existing shared quota',async()=>{
  const {validatePrivateCheckpoint,createPrivateCheckpointReporter}=privateCheckpointFunctions(),r=await privateEOFRun({fail:22,reason:{}}),cap=r.out.find(x=>[4,5,6].includes(x.v));
  const {meta:ignored,...legacy}=cap;const maximum={...legacy,v:4,case:107,decl:20,body:[22,5,true,2097151,3,3,Array(4).fill(65535)]};validatePrivateCheckpoint(maximum);
  for(const body of [[23,5,true,0,0,null,[0,0,0,0]],[5,6,false,0,0,null,[0,0,0,0]],[4,6,true,0,0,null,[0,0,0,0]],[1,5,true,0,0,1,[0,0,0,0]],[1,5,true,0,0,null,[0,0,0,65536]],[5,6,true,0,1,null,[0,0,0,0]],[5,5,true,65535,0,null,[0,0,0,0]],[]])assert.throws(()=>validatePrivateCheckpoint({...maximum,body}));
  for(const change of [{lane:'outer'},{decl:1},{phase:'postlude'},{owner:[1,0,0,0,0,0]},{unexpected:1}])assert.throws(()=>validatePrivateCheckpoint({...maximum,...change}));
  const records=privateCheckpointRecords({stdout:'PRIVATE_CHECKPOINT '+JSON.stringify(cap)+'\n'});assert.equal(records.length,1);assert.equal(records[0].v,6);
  const commands=[],emit=privateAnnotationEmitter(x=>commands.push(x));
  for(const row of privateNativeControls)emit({v:1,pin:privateCatalogPin,p:row.provider,a:row.api,r:row.control,q:false,vect:false,worker:false,restore:false,rejects:1024,pending:1024});
  emit(maximum);const outer=createPrivateCheckpointReporter('outer',emit);for(let i=0;i<108;i++){outer.mark(i,'body','rejected',undefined);outer.flush(i);}outer.execOutcome({v:3,pin:privateCatalogPin,lane:'outer',kind:'exec',phase:'exec',state:'rejected',defined:true,fields:[[2,-2147483648],[2,'SIGTERM'],[2,false]]});outer.finish();
  for(const x of r.out.filter(x=>![4,5,6].includes(x.v)))emit(x);
  for(let i=0;i<4;i++)emit({v:1,pin:privateCatalogPin,lane:'outer',case:107,phase:'observer',state:'rejected',defined:false,acq:4095,op:4095,count:65535});
  assert.ok(commands.length<=48);assert.ok(commands.every(x=>Buffer.byteLength(x)<=768));assert.ok(Buffer.byteLength(commands.join(''))<=16384);
 });
 test('Private V5 result labels and original HTTP status remain independent',async()=>{
  const r=await privateEOFRun({stop:'error',fields:{errorType:'SqliteWorkerError',errorCode:'unavailable'},http:200});
  assert.equal(r.failure,true);const cap=r.out.find(x=>x.v===6);assert.deepEqual([...cap.meta].map(x=>x===null?null:[...x]),[[5,2],[5,10],[1,200],null,[1,null]]);
  assert.equal(r.resultCalls,1);assert.equal(r.calls.filter(x=>x==='stream').length,1);assert.equal(r.stopGets,1);assert.equal(r.report.failures.length,0);
  const projected=await privateEOFRun({stop:'error',fields:{errorCode:'503'},http:401});
  assert.deepEqual([...projected.out.find(x=>x.v===6).meta[1]],[4,null]);assert.deepEqual([...projected.out.find(x=>x.v===6).meta[2]],[1,401]);
  for(const options of [{fail:2},{fail:14},{fail:18}]){const x=await privateEOFRun(options),m=x.out.find(x=>x.v===6).meta;assert.deepEqual([...m[0]],[0,null]);assert.deepEqual([...m[2]],[0,null]);}
 });
 function privateMetadataOwner(proxyCheck=privateNodeTypes.isProxy){const out=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',x=>out.push(x)),row={provider:'baseten',api:'stream',control:'eof'},originals=[];
  r.bindCase(0,0);r.bindBody(0,row,originals);r.bindBodyMetadata(0,row,proxyCheck);const caller={},model={},hook=r.bodyResponseObserver(0,row,caller,model),pending={};r.bodyResultPending(0,row,caller,pending);
  const snapshot=()=>{r.bodySite(0,row,18,3);r.bodySite(0,row,18,4);r.bodySite(0,row,20,1);r.mark(0,'body','rejected',undefined);return out.find(x=>x.v===6);};return {r,row,originals,caller,model,hook,pending,out,snapshot};
 }
 test('Private V5 own-data projection never calls getters or traverses proxies',()=>{
  let gets=0;const value={get errorType(){gets++;throw undefined;},errorCode:undefined},h=privateMetadataOwner();h.r.bodyResult(0,h.row,h.pending,value);
  h.hook.call({onResponse:h.hook},{get status(){gets++;throw undefined;}},h.model);const m=h.snapshot().meta;
  assert.deepEqual([...m[0]],[3,null]);assert.deepEqual([...m[1]],[2,null]);assert.deepEqual([...m[2]],[2,null]);assert.equal(gets,0);assert.equal(h.r.failures.length,0);
  const proxy=new Proxy({}, {getOwnPropertyDescriptor(){gets++;throw undefined;}}),p=privateMetadataOwner();p.r.bodyResult(0,p.row,p.pending,proxy);p.hook.call({onResponse:p.hook},proxy,p.model);
  assert.deepEqual([...p.snapshot().meta[0]],[4,null]);assert.equal(gets,0);
  for(const value of [null,undefined,{},Object.create({errorCode:'unavailable'}),{errorType:'private arbitrary prose',errorCode:'503'}]){const a=privateMetadataOwner();a.r.bodyResult(0,a.row,a.pending,value);assert.ok(a.snapshot().meta[0][0]!==5);}
 });
 test('Private V5 observer faults preserve original errors and cannot bind aliases',async()=>{
  for(const hookFault of ['foreign','duplicate']){const r=await privateEOFRun({stop:'error',reason:undefined,http:200,hookFault});assert.equal(r.failure,true);assert.equal(r.error,undefined);assert.equal(r.report.failures.length,3);assert.deepEqual([...r.out.find(x=>x.v===6).meta[2]],[3,null]);}
  const h=privateMetadataOwner(()=>{throw undefined;});h.hook.call({onResponse:h.hook},{status:200},h.model);h.r.bodyResult(0,h.row,h.pending,{});assert.equal(h.r.failures.length,2);assert.equal(h.r.failures[0],undefined);assert.ok(h.r.failures[1]);assert.deepEqual([...h.snapshot().meta[2]],[3,null]);
  for(const change of [h=>h.r.bodyResult(0,{},h.pending,{}),h=>h.r.bodyResult(0,h.row,{},{}),h=>h.hook.call({onResponse:h.hook},{status:200},{})]){const h=privateMetadataOwner();change(h);assert.equal(h.r.failures.length,1);assert.notEqual(h.snapshot().meta[2][0],1);}
  const primary={},r=await privateEOFRun({stop:'error',reason:primary,reportFail:true,saturate:true,http:200});assert.equal(r.error,primary);assert.deepEqual([...r.report.failures],[undefined]);assert.equal(r.out.filter(x=>x.v===6).length,1);
 });
 test('Private V5 captures first actual original failure in observation order',async()=>{
  const source=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
  const code=source.slice(source.indexOf(' const observer=(p:Promise<unknown>)'),source.indexOf(' const patch=(object:any'));
  for(const kind of ['guard','fetch','read'])for(const reason of [undefined,{}])for(const synchronous of [false,true]){
   const h=privateMetadataOwner(),w={owner:{},originals:h.originals,observers:[],observerFailures:[],syncFailures:[],sequence:0};
   const api=new Function('w','originals','transports','checkpoints','caseIndex','row','"use strict";'+stripTypeScriptTypes(code,{mode:'strip'})+';return {invoke};')(w,h.originals,[],h.r,0,h.row);
   const pending=synchronous?null:Promise.reject(reason);let thrown=false,error;
   try{const original=api.invoke(kind,()=>{if(synchronous)throw reason;return pending;});assert.equal(original,pending);await original;}catch(e){thrown=true;error=e;}
   await Promise.all(w.observers);assert.equal(thrown,true);assert.equal(error,reason);assert.equal(h.originals.length,1);
   const second={kind:'read',state:'rejected',reason:{}};h.originals.push(second);h.r.bodyOperationFailure(0,h.row,second,second.reason);
   assert.deepEqual([...h.snapshot().meta[3]],[['guard','fetch','read'].indexOf(kind)+1,synchronous?1:2,reason!==undefined]);
  }
  const h=privateMetadataOwner(),foreign={kind:'read',state:'rejected',reason:undefined};h.r.bodyOperationFailure(0,h.row,foreign,undefined);assert.equal(h.r.failures.length,1);assert.equal(h.snapshot().meta[3],null);
 });
 test('Private V5 binding faults permanently invalidate metadata before any later valid call',()=>{
  for(const breakBinding of [h=>h.r.bodyResultPending(0,h.row,h.caller,h.pending),h=>h.r.bodyResultPending(0,h.row,{},{}),h=>h.r.bodyResult(0,h.row,{},{}),h=>h.r.bodyResult(0,{},h.pending,{}),h=>h.r.bodyResponseObserver(0,h.row,h.caller,h.model),h=>h.r.bindBodyMetadata(0,h.row,privateNodeTypes.isProxy)]){
   const h=privateMetadataOwner();breakBinding(h);h.r.bodySite(0,h.row,18,3);h.r.bodySite(0,h.row,18,4);
   h.r.bodyResult(0,h.row,h.pending,{errorType:'SqliteWorkerError',errorCode:'unavailable'});h.hook.call({onResponse:h.hook},{status:200},h.model);
   h.r.bodySite(0,h.row,20,1);h.r.mark(0,'body','rejected',undefined);const m=h.out.find(x=>x.v===6).meta;
   assert.ok(h.r.failures.length>=3);assert.deepEqual([...m[0]],[4,null]);assert.deepEqual([...m[1]],[4,null]);assert.deepEqual([...m[2]],[3,null]);assert.equal(m[3],null);
  }
  const h=privateMetadataOwner();h.r.bodySite(0,h.row,18,3);h.r.bodySite(0,h.row,18,4);h.r.bodyResult(0,h.row,h.pending,{errorType:'SqliteWorkerError',errorCode:'unavailable'});
  h.hook.call({onResponse:h.hook},{status:200},h.model);h.r.bodyResult(0,h.row,h.pending,{});h.r.bodySite(0,h.row,20,1);h.r.mark(0,'body','rejected',undefined);
  const m=h.out.find(x=>x.v===6).meta;assert.deepEqual([...m[0]],[4,null]);assert.deepEqual([...m[2]],[3,null]);
 });
 test('Private V5 schema denies foreign cases malformed metadata and completion claims',async()=>{
  const r=await privateEOFRun({stop:'error',http:200}),cap=r.out.find(x=>x.v===6),validate=privateCheckpointFunctions().validatePrivateCheckpoint;
  for(const meta of [[],[[5,3],[0,null],[0,null],null],[[0,1],[0,null],[0,null],null],[[0,null],[5,11],[0,null],null],[[0,null],[0,null],[1,99],null],[[0,null],[0,null],[0,200],null],[[0,null],[0,null],[0,null],[4,2,true]]])assert.throws(()=>validate({...cap,meta}));
  for(const change of [{case:4},{decl:4},{owner:[0,0,0,0,0,0]},{receipt:[]},{extra:true},{body:[18,6,true,0,1,null,[0,0,0,0]]}])assert.throws(()=>validate({...cap,...change}));
  const command='::notice title=Private closed diagnostic::'+JSON.stringify(cap)+'\n';assert.ok(Buffer.byteLength(command)<=768);assert.equal(privateCheckpointRecords({stdout:'PRIVATE_CHECKPOINT '+JSON.stringify(cap)+'\n'})[0].v,6);
 });
 test('Private V6 wording matches exact fixed source forms without authenticating their origin',()=>{
  const forms=["Scoped AI transport hosts require Node.js async context support","Explicit AI transport hosts require Node.js async context support","429 Shared organization token rate limit exceeded the same-model retry wait budget.","Stream ended without finish_reason","Exceeded post-tool-call delta buffer limit","The embedding host requires a managed provider transport","Request was aborted","Unknown provider error","Stream iteration failed","Stream result failed","No API provider registered for api: openai-completions","No API key for provider: baseten"];
  for(const [i,wording]of forms.entries())for(const value of [wording,' '+wording,wording+' ',wording+'\n',wording.toLowerCase()]){
   const h=privateMetadataOwner();h.r.bodyResult(0,h.row,h.pending,{errorMessage:value});const cap=h.snapshot();
   assert.deepEqual([...cap.meta[4]],value===wording?[5,i+1]:[4,null]);assert.equal(h.r.failures.length,0);
   assert.equal(JSON.stringify(cap).includes(value),false);assert.equal(cap.owner,null);assert.equal(cap.receipt,null);
   assert.equal(privateCheckpointRecords({stdout:'PRIVATE_CHECKPOINT '+JSON.stringify(cap)+'\n'})[0].v,6);
  }
 });
 test('Private V6 missing undefined accessors proxies and wrong provider wording stay unknown',()=>{
  let getters=0;const values=[[{},[1,null]],[{errorMessage:undefined},[2,null]],[Object.create({errorMessage:'Request was aborted'}),[1,null]],
   [{get errorMessage(){getters++;throw undefined;}},[3,null]],[new Proxy({}, {getOwnPropertyDescriptor(){getters++;throw undefined;}}),[4,null]]];
  for(const errorMessage of [null,{},1,false,'x'.repeat(4097),'No API key for provider: arcee','No API provider registered for api: openai-responses','upstream arbitrary text'])values.push([{errorMessage},[4,null]]);
  for(const [value,expected]of values){const h=privateMetadataOwner();h.r.bodyResult(0,h.row,h.pending,value);assert.deepEqual([...h.snapshot().meta[4]],expected);assert.equal(h.r.failures.length,0);}assert.equal(getters,0);
 });
 test('Private V6 observer failure and foreign result permanently deny wording confidence',()=>{
  for(const invalid of ['owner','pending','inspection']){let visits=0;const h=privateMetadataOwner(value=>{if(invalid==='inspection'&&++visits===3)throw undefined;return privateNodeTypes.isProxy(value);});
   h.r.bodySite(0,h.row,18,3);h.r.bodySite(0,h.row,18,4);
   h.r.bodyResult(0,invalid==='owner'?{}:h.row,invalid==='pending'?{}:h.pending,{errorMessage:'Request was aborted'});
   assert.equal(h.r.failures.length,1);if(invalid==='inspection')assert.equal(h.r.failures[0],undefined);
   h.r.bodyResult(0,h.row,h.pending,{errorMessage:'Request was aborted'});h.r.bodySite(0,h.row,20,1);h.r.mark(0,'body','rejected',undefined);
   const cap=h.out.find(x=>x.v===6);assert.deepEqual([...cap.meta[4]],[4,null]);assert.equal(cap.defined,false);assert.equal(h.r.failures.length,2);
  }
 });
 test('Private V6 original callback keeps raw assertion and independent report failures',async()=>{
  const primary={},r=await privateEOFRun({stop:'error',fields:{errorMessage:'Request was aborted'},reason:primary,reportFail:true,saturate:true});
  assert.equal(r.error,primary);assert.deepEqual([...r.report.failures],[undefined]);assert.equal(r.resultCalls,1);assert.equal(r.stopGets,1);
  const cap=r.out.find(x=>x.v===6);assert.deepEqual([...cap.meta[4]],[5,7]);assert.equal(r.out.filter(x=>x.v===6).length,1);
  assert.equal(cap.stages[5],0);assert.equal(cap.owner,null);assert.equal(cap.receipt,null);
 });
 test('Private V6 validates its own wording shape while preserving historical V5 bytes',()=>{
  const h=privateMetadataOwner();h.r.bodyResult(0,h.row,h.pending,{errorMessage:'Stream result failed'});const cap=h.snapshot(),validate=privateCheckpointFunctions().validatePrivateCheckpoint;
  const legacy={...cap,v:5,meta:cap.meta.slice(0,4)},bytes=JSON.stringify(legacy);validate(legacy);assert.equal(JSON.stringify(legacy),bytes);
  for(const word of [[],[5,0],[5,13],[5,'1'],[4,1],[1,undefined],[6,null],[5,7,1]])assert.throws(()=>validate({...cap,meta:[...cap.meta.slice(0,4),word]}));
  for(const change of [{v:5},{case:4},{decl:4},{meta:cap.meta.slice(0,4)},{body:[18,6,false,0,1,null,[0,0,0,0]]}])assert.throws(()=>validate({...cap,...change}));
  const command='::notice title=Private closed diagnostic::'+JSON.stringify(cap)+'\n';assert.ok(Buffer.byteLength(command)<=768);
 });
 // END Private EOF body witness inert regressions
 // BEGIN Private early runner inert regressions
 test('Private copied target verification precedes the one original exec and removal',async()=>{
  const h=privateExecFunctions(),bytes=Buffer.from('fixture'),order=[],records=[],report=privateCheckpointFunctions().createPrivateCheckpointReporter('outer',r=>records.push(r));
  const opts=privateExecObservation({fixtureSha256:createHash('sha256').update(bytes).digest('hex'),fixtureBytes:bytes.length},report);
  let original=Promise.resolve({stdout:'closed'}),actual;const publish=opts.onOutcome;opts.onOutcome=o=>{actual=o;order.push('observe');publish(o);};
  const value=await h.withCopiedConsumerFixture(()=>order.push('copy'),()=>h.observePrivateExec({sourceHead:privateCatalogPin,testPath:'extensions/baseten/clawrouter-private-catalogs-contract.test.ts',privateExec:opts},()=>{order.push('read');return bytes;},()=>{order.push('exec');return original;}),()=>order.push('remove'));
  assert.equal(value.stdout,'closed');assert.equal(actual.original,original);assert.equal(actual.binding.token,opts.token);assert.deepEqual(order,['copy','read','exec','observe','remove']);assert.equal(records[0].kind,'exec');assert.equal(records[0].defined,null);
 });
 test('Private read failure mismatch and foreign pin never execute but always remove owned copy',async()=>{
  const h=privateExecFunctions();for(const mode of ['read','mismatch','size','pin']){let calls=0,removes=0;const facts=[],bytes=Buffer.from('fixture'),options={sourceHead:privateCatalogPin,testPath:'extensions/baseten/clawrouter-private-catalogs-contract.test.ts',privateExec:{token:Object.freeze({}),fixtureBytes:bytes.length,fixtureSha256:createHash('sha256').update(bytes).digest('hex'),onOutcome:o=>facts.push(o)}};
   if(mode==='pin')options.sourceHead='foreign';
   await assert.rejects(h.withCopiedConsumerFixture(()=>{},()=>h.observePrivateExec(options,()=>{if(mode==='read')throw undefined;return mode==='mismatch'?Buffer.from('changed'):Buffer.alloc(0);},()=>{calls++;}),()=>{removes++;}));
   assert.equal(calls,0);assert.equal(removes,1);assert.equal(facts.length,mode==='pin'?0:1);if(mode==='read')assert.equal(facts[0].errorDefined,false);
  }
 });
 test('Private bounded snapshot closes after short reads and preserves read plus close undefined',async()=>{
  const h=privateExecFunctions(),bytes=Buffer.from('fixture');for(const mode of ['ok','read','close','both','oversize']){let reads=0,closed=0,offset=0;
   const file={stat:async()=>({isFile:()=>true,size:mode==='oversize'?999:bytes.length}),read:async(buffer,at,count)=>{reads++;if(['read','both'].includes(mode))throw undefined;const n=Math.min(2,bytes.length-offset,count);bytes.copy(buffer,at,offset,offset+n);offset+=n;return {bytesRead:n};},close:async()=>{closed++;if(['close','both'].includes(mode))throw undefined;}};
   const pending=h.readCopiedPrivateFixture('owned',bytes.length,async()=>file);
   if(mode==='ok')assert.deepEqual(await pending,bytes);else await assert.rejects(pending,e=>mode==='both'?e.errors.length===2&&e.errors.every(x=>x===undefined):mode==='oversize'||e===undefined);
   assert.equal(closed,1);if(mode==='oversize')assert.equal(reads,0);
  }
 });
 test('Private original exec undefined observation and removal failures remain independent',async()=>{
  const h=privateExecFunctions(),bytes=Buffer.from('fixture'),order=[];let calls=0;
  const options={sourceHead:privateCatalogPin,testPath:'extensions/baseten/clawrouter-private-catalogs-contract.test.ts',privateExec:{token:Object.freeze({}),fixtureBytes:bytes.length,fixtureSha256:createHash('sha256').update(bytes).digest('hex'),onOutcome:o=>{order.push('observe');assert.equal(o.errorDefined,false);throw undefined;}}};
  await assert.rejects(h.withCopiedConsumerFixture(()=>{},()=>h.observePrivateExec(options,()=>bytes,()=>{calls++;return Promise.reject(undefined);}),()=>{order.push('remove');throw undefined;}),e=>e.errors[0].errors.length===2&&e.errors[0].errors.every(x=>x===undefined)&&e.errors[1]===undefined);
  assert.equal(calls,1);assert.deepEqual(order,['observe','remove']);
  options.privateExec.onOutcome=o=>{assert.equal(o.state,'threw');assert.equal(o.original,undefined);};await assert.rejects(h.observePrivateExec(options,()=>bytes,()=>{throw undefined;}),e=>e===undefined);
 });
 test('Private parent process projection never calls getters or proxy traps',()=>{
  const h=privateExecFunctions();let getters=0,traps=0;const error={};for(const key of ['code','signal','killed','message','stack','stdout','stderr'])Object.defineProperty(error,key,{get(){getters++;throw undefined;}});
  assert.deepEqual(h.privateExecProcessFields(error),[[3,null],[3,null],[3,null]]);assert.equal(getters,0);
  assert.throws(()=>h.privateExecProcessFields(new Proxy({}, {getOwnPropertyDescriptor(){traps++;throw undefined;}})));assert.equal(traps,0);
  assert.deepEqual(h.privateExecProcessFields({code:1,signal:null,killed:false}),[[2,1],[2,null],[2,false]]);
  assert.deepEqual(h.privateExecProcessFields({code:undefined,signal:'private',killed:9}),[[1,null],[4,null],[4,null]]);assert.equal(h.privateExecProcessFields(undefined),null);
 });
 test('Private observer rejects foreign token digest and duplicate outcome',async()=>{
  const h=privateExecFunctions(),bytes=Buffer.from('fixture'),source={fixtureSha256:createHash('sha256').update(bytes).digest('hex'),fixtureBytes:bytes.length};let captured;
  const report={execOutcome:o=>{captured=o;}},opt=privateExecObservation(source,report);let raw;
  await h.observePrivateExec({sourceHead:privateCatalogPin,testPath:'extensions/baseten/clawrouter-private-catalogs-contract.test.ts',privateExec:{...opt,onOutcome:o=>{raw=o;}}},()=>bytes,()=>Promise.resolve());
  for(const change of [{token:Object.freeze({})},{fixtureSha256:'0'.repeat(64)},{sourceHead:'foreign'}]){const owned=privateExecObservation(source,report);assert.throws(()=>owned.onOutcome({...raw,binding:Object.freeze({...raw.binding,...change})}));}
  opt.onOutcome(raw);assert.equal(captured.state,'fulfilled');assert.throws(()=>opt.onOutcome(raw));
 });
 test('Private E2 suite registration uses explicit serial options without a removed chain method',()=>{
  const source=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
  const suite=source.slice(source.indexOf('checkpoints.registration("describe","enter")'));
  const call='describe("registered private catalogs with native Worker and SQLite",{concurrent:false},()=>{';
  assert.equal(suite.split(call).length,2);
  const code=stripTypeScriptTypes(suite,{mode:'strip'}),old=code.replace(call,'describe.sequential("registered private catalogs with native Worker and SQLite",()=>{');
  const run=body=>{const out=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',x=>out.push(x)),callbacks=[];let factory;
   const describe=(_name,options,fn)=>{assert.deepEqual(options,{concurrent:false});factory=fn;return Object.freeze({});};
   const invoke=()=>new Function('checkpoints','describe','it','providers','groups',body)(r,describe,(name,fn)=>callbacks.push({name,fn}),privateProviders,Object.keys(privateGroups));
   return {out,callbacks,invoke,collect:()=>factory()};};
  const before=run(old);assert.throws(before.invoke,TypeError);assert.equal(before.callbacks.length,0);
  assert.equal(before.out.find(r=>r.v===2).phase,'registration');
  const after=run(code);after.invoke();assert.equal(after.callbacks.length,0);after.collect();
  assert.equal(after.callbacks.length,66);assert.equal(after.callbacks.filter(x=>!x.name.startsWith('native diagnostic ')).length,42);
  assert.equal(after.out.some(r=>r.point==='callback'||r.v===2),false);
 });
 test('Private actual registration reports synchronous undefined and never confuses return with invocation',()=>{
  const source=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
  const pre=source.slice(source.indexOf('checkpoints.registration("afterAll","enter")'),source.indexOf('function checkpointCase('));
  const suite=source.slice(source.indexOf('checkpoints.registration("describe","enter")'));
  const code=stripTypeScriptTypes(pre+suite,{mode:'strip'});
  for(const fail of ['afterAll','describe','it','none']){const out=[],checkpoints=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',x=>out.push(x));let registrations=0;
   const run=()=>new Function('checkpoints','afterAll','describe','it','providers','groups','throwFailures',code)(checkpoints,()=>{if(fail==='afterAll')throw undefined;}, (_name,options,fn)=>{assert.deepEqual(options,{concurrent:false});if(fail==='describe')throw undefined;fn();},()=>{if(fail==='it'&&registrations===9)throw undefined;registrations++;},privateProviders,Object.keys(privateGroups),()=>{});
   if(fail==='none')run();else assert.throws(run,e=>e===undefined);
   assert.equal(out.some(r=>r.point==='callback'),false);
   if(fail==='none'){assert.equal(registrations,66);assert.deepEqual([...out.find(r=>r.point==='describe_return').registration],[2,2,1,66,66,65]);assert.equal(out.some(r=>r.v===2),false);}
   else {const primary=out.find(r=>r.v===2),entry=out.find(r=>r.point==='registration_failure');assert.equal(primary.phase,'registration');assert.equal(primary.defined,false);assert.equal(entry.registration[3],fail==='it'?10:0);assert.equal(entry.registration[4],fail==='it'?9:0);}
  }
 });
 test('Private callback entry and first primary are delivered while original postlude stays pending',async()=>{
  const records=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',x=>records.push(x));
  for(let i=0;i<20;i++){r.mark(i,'module','fulfilled');r.flush(i);}r.mark(null,'callback','enter',undefined,null,null,24);r.bindCase(24,24);
  let release;const held=new Promise(resolve=>{release=resolve;});r.observe(24,'original_join',()=>held,undefined,[]);
  const reason={};const p=Promise.reject(reason);assert.equal(r.observe(24,'body',()=>p,undefined,[]),p);await assert.rejects(p,e=>e===reason);await Promise.resolve();
  const cap=records.find(x=>x.v===2);assert.equal(cap.phase,'body');assert.equal(cap.owner,null);assert.equal(cap.stages[5],1);assert.equal(records.filter(x=>x.point==='callback').length,1);assert.equal(records.some(x=>x.phase==='final'),false);
  release();await r.drain();r.finish();assert.equal(records.filter(x=>x.v===2).length,1);assert.equal(records.length,9);
 });
 test('Private early emitter failures are retained without retry or replacing original',()=>{
  let attempts=0;const r=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',()=>{attempts++;throw undefined;});
  r.mark(null,'callback','enter',undefined,null,null,0);assert.throws(()=>r.observe(null,'selection',()=>{throw undefined;},undefined,[],0),e=>e===undefined);
  const before=attempts;r.finish();assert.equal(attempts,before+1);assert.ok(r.failures.length>=3);assert.ok(r.failures.every(x=>x===undefined));
 });
 test('Private proxy inspection failure keeps original exec reason and still observes before cleanup',async()=>{
  const h=privateExecFunctions(),bytes=Buffer.from('fixture'),reason=new Proxy({},{}),order=[],options={sourceHead:privateCatalogPin,testPath:'extensions/baseten/clawrouter-private-catalogs-contract.test.ts',privateExec:{token:Object.freeze({}),fixtureBytes:bytes.length,fixtureSha256:createHash('sha256').update(bytes).digest('hex'),onOutcome:o=>{order.push('observe');assert.equal(o.fields,null);throw undefined;}}};
  await assert.rejects(h.withCopiedConsumerFixture(()=>{},()=>h.observePrivateExec(options,()=>bytes,()=>Promise.reject(reason)),()=>order.push('remove')),e=>e.errors[0]===reason&&e.errors.length===3&&e.errors[2]===undefined);
  assert.deepEqual(order,['observe','remove']);let removed=0;await assert.rejects(h.withCopiedConsumerFixture(()=>{throw undefined;},()=>{throw Error('must not run');},()=>{removed++;}),e=>e===undefined);assert.equal(removed,0);
 });
 test('Private actual command and callback source keeps the original E2 runner bounds',()=>{
  const helper=readFileSync(new URL('./helpers/openclaw-consumer.mjs',import.meta.url),'utf8');
  const branch=helper.slice(helper.indexOf('    if (privateExec !== undefined) {'),helper.indexOf('    const result = await promisify(execFile)'));
  assert.equal((branch.match(/promisify\(execFile\)/g)||[]).length,1);assert.ok(branch.includes('["test", testPath, "--maxWorkers=1"]'));
  assert.ok(branch.includes('timeout: 240_000, maxBuffer: 2 * 1024 * 1024'));assert.ok(branch.indexOf('readCopiedPrivateFixture')<branch.indexOf('promisify(execFile)'));
  assert.doesNotMatch(branch,/withNativeRunnerReport|extraArgs|runnerReport/);
 });
 test('Private complete early SDK and parent outcome fit saturated shared annotation budget',()=>{
  const commands=[],emit=privateAnnotationEmitter(x=>commands.push(x)),create=privateCheckpointFunctions().createPrivateCheckpointReporter;
  for(const row of privateNativeControls)emit({v:1,pin:privateCatalogPin,p:row.provider,a:row.api,r:row.control,q:false,vect:false,worker:false,restore:false,rejects:1024,pending:1024});
  for(const lane of ['sdk','outer']){const r=create(lane,emit);for(let i=0;i<108;i++){r.mark(i,'body','rejected',undefined);r.flush(i);}
   if(lane==='sdk')r.mark(null,'callback','enter',undefined,null,null,65);
   else r.execOutcome({v:3,pin:privateCatalogPin,lane,kind:'exec',phase:'exec',state:'rejected',defined:true,fields:[[2,-2147483648],[2,'SIGTERM'],[2,false]]});r.finish();}
  for(let i=0;i<4;i++)emit({v:1,pin:privateCatalogPin,lane:'outer',case:107,phase:'observer',state:'rejected',defined:false,acq:4095,op:4095,count:65535});
  assert.equal(commands.length,46);assert.ok(commands.every(x=>Buffer.byteLength(x)<=768));assert.ok(Buffer.byteLength(commands.join(''))<=16384);
 });
 test('Private deferred suite registration failure delivers before any test callback or afterAll',()=>{
  const source=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
  const suite=stripTypeScriptTypes(source.slice(source.indexOf('checkpoints.registration("describe","enter")')),{mode:'strip'});
  for(const reason of [undefined,{}]){const out=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',x=>out.push(x));let deferred,attempts=0;
   new Function('checkpoints','describe','it','providers','groups',suite)(r,(_name,options,fn)=>{assert.deepEqual(options,{concurrent:false});deferred=fn;return Object.freeze({});},()=>{if(attempts++===3)throw reason;},privateProviders,Object.keys(privateGroups));
   assert.equal(attempts,0);const returned=out.find(x=>x.point==='describe_return');assert.deepEqual([...returned.registration],[0,2,0,0,0,null]);assert.equal(out.some(x=>x.v===2),false);
   assert.throws(()=>deferred(),e=>e===reason);assert.equal(attempts,4);const cap=out.find(x=>x.v===2),entry=out.find(x=>x.point==='registration_failure');
   assert.equal(cap.phase,'registration');assert.equal(cap.defined,reason!==undefined);assert.equal(cap.decl,3);assert.deepEqual([...entry.registration],[0,2,1,4,3,3]);assert.equal(out.some(x=>x.point==='callback'),false);assert.equal(out.some(x=>x.phase==='final'),false);
  }
 });
 // END Private early runner inert regressions
 // BEGIN Private primary and receipt inert regressions
 function receiptFixture(){const row={id:'inert',provider:'baseten',scenario:'stream_abort'},p={id:'inert',retired:true,operations:[{state:'fulfilled'}],readers:[{unlocks:1,locked:false}],charged:0,
  source:{held:0,expired:0,joined:true,pending:0,faults:0,requests:1,canceled:1,settled:1,census:[{producer:true,cancels:1,finished:true,explicitRelease:false}]},
  requests:[{id:0,requestId:'receipt-0',status:200,credential:'discovery'}],calls:[{request:0,originalKey:true,noCaller:true,redirect:'manual',query:false,method:'GET',bodyAbsent:true}],events:[{request_id:'receipt-0',key_id:'inert_discovery',status_code:200,status:'success',provider:'baseten',policy_id:'inert',capability:'models.list',model:null,reserved_cost_micros:0,actual_cost_micros:0}],
  observation:{producer:[2,false,null,true,0,0,0,0,1,3,6,1,1,true],accounting:[2,false,null,true,1,true]}};return {row,p};}
 test('Private primary selection failure precedes fixture and never invents collection identity',async()=>{
  const records=[],report=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',r=>records.push(r));let entered=0;
  report.mark(null,'module','fulfilled');report.flush(null);report.mark(null,'callback','enter',undefined,null,null,17);
  assert.throws(()=>report.observe(null,'selection',function(){entered++;throw undefined;},{},[],17),e=>e===undefined);
  await report.drain();report.finish();const primary=records.find(r=>r.v===2);assert.equal(entered,1);assert.equal(primary.case,null);assert.equal(primary.decl,17);assert.equal(primary.phase,'selection');assert.equal(primary.defined,false);assert.deepEqual([...primary.stages],[1,3,0,0,0,0,0]);assert.equal(primary.owner,null);
  const incomplete=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',x=>incomplete.push(x));r.mark(null,'module','fulfilled');r.flush(null);assert.equal(incomplete.some(x=>x.v===2),false);
 });
 test('Private primary setup owner body and joined boundaries retain exact originals',async()=>{
  for(const phase of ['setup','body']){const records=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',x=>records.push(x)),receiver={},args=[{},undefined],reason={};
   r.mark(null,'callback','enter',undefined,null,null,24);r.mark(null,'selection','fulfilled',undefined,null,null,24);r.bindCase(24,24);
   if(phase==='body'){r.mark(24,'setup','fulfilled');r.mark(24,'owner','fulfilled');}
   const p=Promise.reject(reason);function original(...got){assert.equal(this,receiver);assert.deepEqual(got,args);return p;}
   assert.equal(r.observe(24,phase,original,receiver,args),p);await p.catch(()=>{});await r.drain();
   r.mark(24,phase,'fulfilled');
   if(phase==='body'){r.mark(24,'original_join','fulfilled');r.joinedOwner(24,[2,1,0,1,1,0]);r.mark(24,'postlude','rejected',reason);}
   r.finish();const cap=records.find(x=>x.v===2);assert.equal(cap.phase,phase);assert.equal(cap.stages[phase==='setup'?2:4],3);assert.equal(cap.case,24);assert.equal(cap.decl,24);assert.equal(cap.stages[3],phase==='body'?2:0);assert.equal(cap.owner,null);assert.equal(cap.stages[5],0);}
 });
 test('Private first primary survives saturation with an independent later receipt',async()=>{
  const out=[],report=privateCheckpointFunctions().createPrivateCheckpointReporter('outer',r=>out.push(r));
  for(let i=0;i<8;i++){report.mark(i,'case_setup','fulfilled');report.flush(i);}
  report.mark(null,'child','rejected',undefined);report.flush(null);
  const {row,p}=receiptFixture(),w=createPrivateReceiptWitness();p.source.canceled=0;
  let primary;try{assertPrivateReceipt(row,p,w);}catch(e){primary=e;}
  assert.throws(()=>reportPrivateReceiptFailure(report,row,2,p,()=>p,w,primary),e=>e===primary);await report.drain();report.finish();
  assert.equal(out.length,8);const cap=out.find(r=>r.v===2);assert.equal(cap.phase,'child');assert.equal(cap.defined,false);assert.equal(cap.case,null);assert.equal(cap.receipt[0],2);assert.deepEqual([...cap.receipt[1]],[29,null,0,true]);
  const commands=[],emit=privateAnnotationEmitter(x=>commands.push(x));out.forEach(emit);assert.ok(commands.every(x=>Buffer.byteLength(x)<=768));
 });
 test('Private exact receipt checks preserve first leaf, ordinal and short circuit',()=>{
  for(const [field,id]of [['retired',0],['charged',4]]){const {row,p}=receiptFixture(),w=createPrivateReceiptWitness();p[field]=field==='retired'?false:1;let calls=0;Object.defineProperty(p,'source',{get(){calls++;throw undefined;}});
   assert.throws(()=>assertPrivateReceipt(row,p,w));assert.equal(w.snapshot().first[0],id);assert.equal(calls,0);}
  const {row,p}=receiptFixture(),w=createPrivateReceiptWitness();let untouched=0;p.readers=[{unlocks:0,get locked(){untouched++;throw undefined;}}];
  assert.throws(()=>assertPrivateReceipt(row,p,w));assert.deepEqual(w.snapshot().first,[2,0,0,true]);assert.equal(untouched,0);assert.equal(w.snapshot().evaluated[0]&(2**3),0);
  const f=receiptFixture(),v=createPrivateReceiptWitness();f.p.operations=[{state:'fulfilled'},{state:'rejected'},{get state(){throw Error('short circuit lost');}}];assert.throws(()=>assertPrivateReceipt(f.row,f.p,v));assert.deepEqual(v.snapshot().first,[1,1,0,true]);assert.equal(v.snapshot().passed[0]&(2**1),0);
 });
 test('Private receipt operand throws retain undefined without evaluating later leaves',()=>{
  const {row,p}=receiptFixture(),w=createPrivateReceiptWitness();let later=0;Object.defineProperty(p,'charged',{get(){throw undefined;}});Object.defineProperty(p,'source',{get(){later++;throw Error('late');}});
  assert.throws(()=>assertPrivateReceipt(row,p,w),e=>e===undefined);assert.deepEqual(w.snapshot().first,[4,null,1,false]);assert.equal(later,0);
 });
 test('Private actual receipt predicate IDs cover call event producer and financial failures',()=>{
  const cases=[[11,p=>p.calls[0].originalKey=false],[12,p=>p.calls[0].noCaller=false],[13,p=>p.calls[0].redirect='follow'],[14,p=>p.calls[0].query=true],[15,p=>p.calls[0].bodyAbsent=false],
   [16,p=>p.events[0].provider='foreign'],[17,p=>p.events[0].policy_id='foreign'],[18,p=>p.events[0].model='foreign'],[19,p=>p.events[0].reserved_cost_micros=1],[20,p=>p.events[0].actual_cost_micros=1],
   [29,p=>p.source.canceled=0],[30,p=>p.source.settled=0],[31,p=>p.source.census[0].explicitRelease=true]];
  for(const [id,change]of cases){const {row,p}=receiptFixture(),w=createPrivateReceiptWitness();change(p);assert.throws(()=>assertPrivateReceipt(row,p,w));assert.equal(w.snapshot().first[0],id);}
  for(const [key,id]of [['actual_cost_micros',21],['cost_basis',22],['reporting_known_cost_micros',23],['total_tokens',24]]){const {row,p}=receiptFixture(),w=createPrivateReceiptWitness();p.events=[{provider:row.provider,policy_id:row.id,capability:'llm.chat',status:'success',actual_cost_micros:7,cost_basis:'policy_fixed',reporting_known_cost_micros:null,total_tokens:7}];p.events[0][key]='wrong';assert.throws(()=>assertPrivateReceipt(row,p,w));assert.equal(w.snapshot().first[0],id);}
  const {row,p}=receiptFixture(),w=createPrivateReceiptWitness();assertPrivateReceipt(row,p,w);assert.equal(w.snapshot().first,null);
 });
 test('Private actual receipt requires request-bound accounting without dropping denied attempts',()=>{
  const make=()=>{const {row,p}=receiptFixture();row.scenario='eof';p.calls.push({...p.calls[0],request:1,method:'POST'});p.source.requests=2;
   p.requests.push({id:1,requestId:'receipt-1',status:200,credential:'inference'});
   p.events.push({provider:row.provider,policy_id:row.id,key_id:'inert_inference',request_id:'receipt-1',status_code:200,capability:'llm.chat',status:'success',reserved_cost_micros:7,actual_cost_micros:7,cost_basis:'policy_fixed',reporting_known_cost_micros:null,total_tokens:7});return {row,p};};
  {const {row,p}=make();assertPrivateReceipt(row,p);}
  for(const change of [p=>p.events=[],p=>p.events.pop(),p=>p.events.shift(),p=>p.events.push({...p.events[0]}),p=>p.events[1].request_id='foreign',p=>p.events[1].key_id='foreign',p=>p.calls[1].request=99,p=>p.events[1].reserved_cost_micros=0,p=>p.events[1].actual_cost_micros=0,p=>p.events[1].status='client_error',p=>p.events[1].status_code=499,p=>p.events[1].capability='models.list']){
   const {row,p}=make();change(p);assert.throws(()=>assertPrivateReceipt(row,p));}
  {const {row,p}=make();p.requests.push({id:2,requestId:'denied',status:401,credential:'inference'});p.events.push({provider:row.provider,policy_id:row.id,key_id:'inert_inference',request_id:'denied',status_code:401,capability:'llm.chat',status:'client_error',reserved_cost_micros:0,actual_cost_micros:0});assertPrivateReceipt(row,p);
   for(const key of ['reserved_cost_micros','actual_cost_micros']){const copy=structuredClone(p);copy.events[2][key]=7;assert.throws(()=>assertPrivateReceipt(row,copy));}}
  for(const scenario of ['stream_abort','simple_abort','provider_error']){const {row,p}=make();row.scenario=scenario;p.source.requests=2;p.events[1].status=scenario==='provider_error'?'provider_error':'client_error';p.events[1].total_tokens=null;assertPrivateReceipt(row,p);}
  assertPrivateUsage({id:'cold',provider:'baseten'},{requests:[],calls:[],events:[]});
 });
 test('Private producer and accounting outcomes distinguish unavailable and valid empty',async()=>{
  const source={joined:true,pending:0,faults:0,expired:0,held:0,requests:0,calls:[],census:[],originals:0,observers:0,canceled:0,settled:0};
  for(const mode of ['empty','producer','accounting']){const {s}=privateInertOwner(),order=[];
   const out=await retirePrivateWorkerOwner(s,()=>{order.push('proof');if(mode==='producer')throw undefined;return source;},()=>{order.push('accounting');if(mode==='accounting')throw undefined;return {events:[]};},()=>false);
   assert.deepEqual(order,mode==='producer'?['proof']:['proof','accounting']);assert.equal(out.retired,mode==='empty');
   assert.deepEqual(out.observation.accounting,mode==='empty'?[2,false,null,true,0,true]:mode==='producer'?[0,false,null,false,null,true]:[3,true,false,false,null,true]);
   if(mode==='producer')assert.deepEqual(out.observation.producer.slice(0,3),[3,true,false]);if(mode!=='empty')assert.ok(s.retirementFailures.some(x=>x===undefined));}
 });
 test('Private failed join emits retained producer accounting facts with receipt predicates unobserved',async()=>{
  for(const mode of ['producer','accounting']){const {s}=privateInertOwner(),source={joined:true,pending:0,faults:0,expired:0,held:0,requests:0,calls:[],census:[],originals:0,observers:0,canceled:0,settled:0};
   const result=await retirePrivateWorkerOwner(s,()=>{if(mode==='producer')throw undefined;return source;},()=>{throw undefined;},()=>false);
   const {row}=receiptFixture(),proof={id:row.id,observation:result.observation},out=[],report=privateCheckpointFunctions().createPrivateCheckpointReporter('outer',x=>out.push(x));let read=0,originals=0;
   report.mark(null,'child','rejected',undefined);report.mark(2,'worker_retirement','rejected',undefined);
   assert.throws(()=>reportPrivateJoinFailure(report,row,2,()=>{read++;return proof;},saved=>{originals++;assert.equal(saved,proof);},undefined),e=>e===undefined);report.finish();
   const cap=out.find(x=>x.v===2);assert.equal(read,1);assert.equal(originals,1);assert.equal(cap.receipt[1],null);assert.deepEqual([...cap.receipt[2]],[0,0]);assert.deepEqual([...cap.receipt[3]],[0,0]);assert.equal(cap.receipt[mode==='producer'?4:5][2],false);assert.equal(cap.receipt[5][3],false);assert.equal(result.retired,false);
  }
  const {row,p}=receiptFixture(),order=[];assert.throws(()=>reportPrivateJoinFailure({receipt(){order.push('capsule');throw undefined;}},row,2,()=>p,()=>{order.push('originals');throw undefined;},undefined),e=>e.errors.length===3&&e.errors.every(x=>x===undefined));assert.deepEqual(order,['capsule','originals']);
  assert.throws(()=>reportPrivateJoinFailure({receipt(){throw Error('foreign must not report');}},row,2,()=>({...p,id:'foreign'}),()=>{},undefined),e=>e.errors[0]===undefined&&e.errors.length===2);
 });
 test('Private empty owner retirement remains distinct from partial producer assertions',async()=>{
  const {s}=privateInertOwner(),source={joined:true,pending:0,faults:0,expired:0,held:0,requests:0,calls:[],census:[],originals:0,observers:0,canceled:0,settled:0};
  const out=await retirePrivateWorkerOwner(s,()=>source,()=>({events:[]}),()=>false);assert.equal(out.retired,true);
  const {row,p}=receiptFixture();Object.assign(p,{source,calls:[],operations:[],readers:[],events:[],observation:out.observation});const w=createPrivateReceiptWitness();assert.throws(()=>assertPrivateReceipt(row,p,w));assert.equal(w.snapshot().first[0],29);
 });
 test('Private receipt reporting never replaces original undefined or independent cleanup',async()=>{
  const {row,p}=receiptFixture(),w=createPrivateReceiptWitness();Object.defineProperty(p,'charged',{get(){throw undefined;}});assert.throws(()=>assertPrivateReceipt(row,p,w),e=>e===undefined);
  const order=[],report={receipt(){order.push('receipt');throw undefined;},mark(){order.push('mark');throw undefined;},flush(){order.push('flush');throw undefined;}};
  await assert.rejects(finishPrivateOwned(()=>reportPrivateReceiptFailure(report,row,2,p,()=>p,w,undefined),[()=>{order.push('cleanup');throw undefined;}]),e=>e.errors[0].errors.length===4&&e.errors[0].errors.every(x=>x===undefined)&&e.errors[1]===undefined);
  assert.deepEqual(order,['receipt','mark','flush','cleanup']);
  const records=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter('outer',x=>records.push(x));assert.throws(()=>reportPrivateReceiptFailure(r,{...row,id:'foreign'},2,p,()=>p,w,undefined),e=>e.errors[0]===undefined);r.finish();assert.equal(records.find(x=>x.v===2).receipt,null);
 });
 test('Private maximum primary capsules share the original two-lane and control quota',()=>{
  const {validatePrivateCheckpoint,createPrivateCheckpointReporter}=privateCheckpointFunctions(),commands=[],emit=privateAnnotationEmitter(x=>commands.push(x));
  const producer=[3,true,false,null,...Array(9).fill(65535),false],accounting=[3,true,false,false,null,false];
  const cap={v:2,pin:privateCatalogPin,lane:'outer',case:107,phase:'worker_retirement',state:'rejected',defined:false,decl:65,stages:Array(7).fill(3),owner:null,receipt:[107,[24,65535,1,false],[131071,131071],[131071,130943],producer,accounting]};
  validatePrivateCheckpoint(cap);emit(cap);const width=Buffer.byteLength(commands[0]);assert.ok(width<=768);
  for(const change of [{decl:66},{stages:[]},{owner:[-1]},{receipt:[...cap.receipt.slice(0,3),[262143,0],producer,accounting]}])assert.throws(()=>validatePrivateCheckpoint({...cap,...change}));
  commands.length=0;const whole=privateAnnotationEmitter(x=>commands.push(x));
  for(const row of privateNativeControls)whole({v:1,pin:privateCatalogPin,p:row.provider,a:row.api,r:row.control,q:false,vect:false,worker:false,restore:false,rejects:1024,pending:1024});
  for(const lane of ['outer','sdk']){const r=createPrivateCheckpointReporter(lane,whole);for(let i=0;i<108;i++){r.mark(i,'body','rejected',undefined);r.flush(i);}r.finish();}
  for(let i=0;i<4;i++)whole({v:1,pin:privateCatalogPin,lane:'outer',case:107,phase:'read',state:'rejected',defined:false,acq:4095,op:4095,count:65535});
  assert.equal(commands.length,44);assert.ok(commands.every(x=>Buffer.byteLength(x)<=768));assert.ok(Buffer.byteLength(commands.join(''))<=16384);
 });
 test('Private actual registered callback selection is observed before any fixture call',async()=>{
  const source=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8'),start=source.indexOf('checkpoints.registration("describe","enter")');
  assert.ok(start>0);const callbacks=[],records=[],checkpoints=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',r=>records.push(r));let invoked=0;
  const providers=['baseten','arcee','novita'],groups=Object.keys(privateGroups),expect=value=>({toHaveLength:n=>assert.equal(value.length,n),toBeGreaterThan:n=>assert.ok(value>n)});
  const code=stripTypeScriptTypes(source.slice(start),{mode:'strip'});
  new Function('describe','it','providers','groups','controlRows','rows','expect','diagnosticControl','exercise','checkpoints','checkpointCase','callbackDeclarations',code)((_name,options,fn)=>{assert.deepEqual(options,{concurrent:false});fn();},(name,fn)=>callbacks.push({name,fn}),providers,groups,[],privateCases,expect,()=>{invoked++;},()=>{invoked++;},checkpoints,()=>0,new WeakMap());
  assert.equal(callbacks.length,66);assert.equal(callbacks.filter(r=>!r.name.startsWith('native diagnostic ')).length,42);await assert.rejects(callbacks[0].fn());await checkpoints.drain();checkpoints.finish();assert.equal(invoked,0);
  const cap=records.find(r=>r.v===2);assert.equal(cap.phase,'selection');assert.equal(cap.decl,0);assert.equal(cap.owner,null);
  const success=[],bindings=new WeakMap(),report=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',()=>{});
  new Function('describe','it','providers','groups','controlRows','rows','expect','diagnosticControl','exercise','checkpoints','checkpointCase','callbackDeclarations',code)((_name,options,fn)=>{assert.deepEqual(options,{concurrent:false});fn();},(name,fn)=>success.push({name,fn}),providers,groups,privateNativeControls,privateCases,expect,row=>{assert.equal(row,privateNativeControls[0]);invoked++;},()=>{invoked++;},report,()=>0,bindings);
  assert.deepEqual(success.map(x=>x.name),callbacks.map(x=>x.name));await success[0].fn();assert.equal(invoked,1);assert.equal(bindings.get(privateNativeControls[0]),0);
 });
 // END Private primary and receipt inert regressions
 // BEGIN Private Worker ownership inert regressions
 test('Private Worker exact original P, receiver, arguments and independent same-error outcomes',async()=>{
  const {s}=privateInertOwner(),receiver={},args=[{},undefined],reason={};let calls=0;
  const p=Promise.reject(reason);function original(...actual){calls++;assert.equal(this,receiver);assert.deepEqual(actual,args);return p;}
  assert.equal(s.ledger.invoke('read',original,receiver,args),p);s.ledger.retain('independent',Promise.reject(reason));s.ledger.retain('undefined',Promise.reject(undefined));
  await s.ledger.drain();assert.equal(calls,1);assert.deepEqual(s.ledger.values(),[reason,reason,undefined]);
  for(let i=0;i<3;i++){await assert.rejects(joinPrivateOriginals(s),e=>e.errors.length===3&&e.errors[2]===undefined);assert.equal(s.ledger.values().length,3);}
  assert.throws(()=>s.ledger.invoke('sync',()=>{throw undefined;},receiver,args),e=>e===undefined);
  await s.ledger.drain();assert.equal(s.ledger.values().length,4);
 });
 test('Private Worker actual read wrapper separates P rejection from Q callback failure',async()=>{
  for(const mode of ['read','callback','null','undefined']){
   const error=mode==='null'?null:mode==='undefined'?undefined:{},p=mode==='callback'?Promise.resolve({done:false,get value(){throw error;}}):Promise.reject(error);
   const f=await privateInertReader(()=>p),got=f.s.ownership.run(f.token,()=>f.reader.read('unchanged'));
   assert.equal(got,p);await f.s.ledger.drain();
   const read=f.s.ledger.operations.find(o=>o.kind==='read'),q=f.s.ledger.operations.find(o=>o.kind==='read_observer');
   assert.equal(q.originalRead,p);assert.equal(q.originalRecord,read);assert.notEqual(q.pending,p);assert.equal(q.state,'rejected');assert.equal(q.error,error);
   assert.equal(read.callbackEntered,mode==='callback');assert.equal(read.state,mode==='callback'?'fulfilled':'rejected');assert.equal(read.errorPresent,mode!=='callback');
   assert.equal(f.s.readers[0].closedRecord.pending,f.reader.closed);
   await assert.rejects(joinPrivateOriginals(f.s),mode==='callback'?e=>e===error:e=>e.errors[0]===error&&e.errors[1]===error);
   const facts=privateWorkerOperationFacts(f.s);assert.ok(facts.rows.every(o=>o.bound));
   assert.equal(facts.rows.at(-1).originalRead,true);assert.equal(facts.rows.at(-1).callbackEntered,mode==='callback');
  }
 });
 test('Private Worker request, Response, reader and cancel binding rejects foreign ownership',async()=>{
  const f=await privateInertReader(()=>Promise.resolve({done:true})),r=f.s.readers[0],other=f.s.ownership.register({},'alternate');
  assert.equal(f.s.ownership.run(f.token,()=>f.s.ownership.bound(r,'read',f.reader,r.originals.read)),true);
  assert.equal(f.s.ownership.run(other,()=>f.s.ownership.bound(r,'read',f.reader,r.originals.read)),false);
  assert.equal(f.s.ownership.bound(r,'read',f.reader,r.originals.read),true); // Retained stream pull outside ingress ALS.
  assert.equal(f.s.ownership.bound(r,'cancel',f.reader,r.originals.cancel),true);
  for(const [key,value]of [['response',{}],['body',{}],['request',{}],['transport',{}],['token',{}]]){const saved=r[key];r[key]=value;assert.equal(f.s.ownership.run(f.token,()=>f.s.ownership.bound(r,'cancel',f.reader,r.originals.cancel)),false);r[key]=saved;}
  assert.equal(f.s.ownership.bound(r,'cancel',{},r.originals.cancel),false);assert.equal(f.s.ownership.bound(r,'cancel',f.reader,()=>{}),false);
  const operand={};await f.reader.cancel(operand,undefined);const cancel=f.s.ledger.operations.find(o=>o.kind==='cancel');assert.equal(cancel.receiver,f.reader);assert.deepEqual(cancel.args,[operand,undefined]);
  await f.reader.cancel();await f.s.ledger.drain();assert.ok(f.s.ledger.faults.length);assert.equal(r.cancels,2);
 });
 test('Private Worker joins held originals and already-attached cross-ledger tails once',async()=>{
  const {s}=privateInertOwner();await s.ledger.drain();let close,tail,done=false;
  const c0=new Promise(resolve=>{close=resolve;}),producer=new Promise(resolve=>{tail=resolve;});s.ledger.retain('closed',c0);
  const q=c0.then(()=>{s.ledger.retain('producer',producer);});s.ledger.retain('continuation',q);
  const joined=s.ledger.drain().then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);close();
  for(let i=0;i<4;i++)await Promise.resolve();assert.equal(done,false);tail();await joined;
  assert.equal(s.ledger.facts().pending,0);const count=s.ledger.operations.length;await s.ledger.drain();assert.equal(s.ledger.operations.length,count);
  s.ledger.retain('late',Promise.resolve());await s.ledger.drain();assert.equal(s.ledger.operations.at(-1).state,'fulfilled');
 });
 test('Private Worker seal permanently rejects late work, membership replacement and owner changes',async()=>{
  const edits=[s=>s.ledger.retain('late',Promise.resolve()),s=>s.ledger.fault(undefined),s=>{s.generation={};},s=>{s.ownership.requests=[];},s=>{s.readers=[];},s=>s.calls.push({}),s=>s.ledger.touch()];
  for(const edit of edits){const {s}=privateInertOwner();s.ownership.register({},'discovery');await s.ledger.drain();s.ownership.retire();assert.equal(s.ownership.seal(),true);edit(s);
   assert.equal(s.ownership.validate(),false);assert.equal(s.ownership.seal(),false);assert.throws(()=>s.ownership.register({},'discovery'));}
 });
 test('Private Worker captures unlock ordering without rewriting observation into native time',async()=>{
  let resolve;const pending=new Promise(yes=>{resolve=yes;});const f=await privateInertReader(()=>pending);
  f.s.ownership.run(f.token,()=>f.reader.read());f.reader.releaseLock();const r=f.s.readers[0];assert.ok(r.pendingAtUnlock>0);
  resolve({done:true});await f.s.ledger.drain();const read=f.s.ledger.operations.find(o=>o.kind==='read');assert.ok(r.unlockReturn<read.settlement);
  f.reader.releaseLock();assert.equal(r.unlocks,2);assert.ok(f.s.ledger.faults.length);
 });
 test('Private Worker consumes or cancels the same control response and preserves undefined cleanup',async()=>{
  for(const primary of [{},undefined])for(const cleanup of [{},undefined]){const calls=[],body={cancel(){calls.push(['cancel',this,arguments.length]);return Promise.reject(cleanup);}},response={body,consume(){calls.push(['consume',this,arguments.length]);return Promise.reject(primary);}};
   await assert.rejects(privateControlResponse(response,response.consume,v=>v),e=>e.errors.length===2&&e.errors[0]===primary&&e.errors[1]===cleanup);
   assert.equal(calls.length,2);assert.equal(calls[0][1],response);assert.equal(calls[1][1],body);assert.equal(calls[0][2],0);assert.equal(calls[1][2],0);}
  const response={body:{cancel(){throw Error('unexpected cancellation');}},consume(){return Promise.resolve('ok');}};assert.equal(await privateControlResponse(response,response.consume,v=>v),'ok');
 });
 test('Private Worker producer proof and control joins precede independent accounting and restoration',async()=>{
  const {s}=privateInertOwner(),order=[],raw={},accounting={},restore={};s.ledger.retain('handler',Promise.reject(raw));s.restores.push(()=>{order.push('restore');throw restore;});
  const source={joined:true,pending:0,faults:0,expired:0,held:0,requests:0,calls:[],census:[]};let release;
  const pending=new Promise(resolve=>{release=resolve;});let finished=false;
  const retirement=retirePrivateWorkerOwner(s,async()=>{order.push('proof');s.ledger.retain('control_tail',pending);return source;},()=>{order.push('accounting');throw accounting;},()=>false).then(v=>{finished=true;return v;});
  for(let i=0;i<8;i++)await Promise.resolve();assert.equal(finished,false);assert.deepEqual(order,['proof']);release();const result=await retirement;
  assert.equal(result.retired,false);assert.deepEqual(order,['proof','accounting','restore']);assert.deepEqual(s.retirementFailures,[raw,accounting,restore]);assert.equal(s.ownership.validate(),true);
  for(const patch of [{joined:false},{pending:1},{faults:1},{expired:1},{held:1},{requests:1},{calls:[{}]},{census:[{}]}]){const {s}=privateInertOwner();let accounting=0;const result=await retirePrivateWorkerOwner(s,()=>({...source,...patch}),()=>{accounting++;},()=>false);assert.equal(result.retired,false);assert.equal(accounting,0);}
 });
 test('Private Worker same-error foreign P and omitted bindings never gain diagnostic ownership',async()=>{
  const error={},f=await privateInertReader(()=>Promise.reject(error));f.s.ownership.run(f.token,()=>f.reader.read());await f.s.ledger.drain();
  const q=f.s.ledger.operations.find(o=>o.kind==='read_observer'),p=f.s.ledger.operations.find(o=>o.kind==='read');q.originalRead=Promise.reject(error);q.originalRead.catch(()=>{});
  assert.equal(privateWorkerOperationFacts(f.s).rows.find(o=>o.kind==='read_observer').originalRead,false);
  p.binding={};const d=privateWorkerOperationFacts(f.s);assert.equal(d.rows[0].bound,false);assert.deepEqual(privateWorkerCheckpointRecords({id:f.s.id,diagnostic:d},f.s,0),[]);
 });
 test('Private Worker bounded original diagnostics preserve undefined and existing annotation schema',async()=>{
  const {s}=privateInertOwner();for(let i=0;i<6;i++)s.ledger.retain('closed',Promise.reject(i?{}:undefined));await s.ledger.drain();
  const d=privateWorkerOperationFacts(s);assert.equal(d.rows.length,4);assert.equal(d.omitted,2);assert.equal(d.rows[0].defined,false);
  // Missing resource binding is deliberately not promoted to a correlated closed-reader fact.
  assert.equal(d.rows[0].bound,false);
  const records=[],commands=[],f=await privateInertReader(()=>Promise.reject(undefined));f.s.ownership.run(f.token,()=>f.reader.read());await f.s.ledger.drain();
  records.push(...privateWorkerCheckpointRecords({id:f.s.id,diagnostic:privateWorkerOperationFacts(f.s)},f.s,0));assert.equal(records.length,2);
  const {validatePrivateCheckpoint}=privateCheckpointFunctions(),emit=privateAnnotationEmitter(line=>commands.push(line));for(const record of records){validatePrivateCheckpoint(record);emit(record);}
  assert.ok(commands.every(line=>Buffer.byteLength(line)<=768));assert.ok(records.every(r=>r.defined===false));
  assert.deepEqual(privateWorkerCheckpointRecords({id:'foreign',diagnostic:d},f.s,0),[]);
 });
 test('Private Worker actual upstream callbacks join notification, producer and attached observers',async()=>{
  const states=new Map(),timers=[];
  class FakeURL{constructor(value){this.href=value;const slash=value.indexOf('/',value.indexOf('://')+3);this.hostname=value.slice(value.indexOf('://')+3,slash);this.pathname=value.slice(slash);this.search='';}}
  class FakeResponse{constructor(body,options){this.body=body;this.options=options;}static json(value){return {value};}}
  class InertStream{constructor(callbacks){this.callbacks=callbacks;this.chunks=[];this.controller={enqueue:value=>this.chunks.push(value),close:()=>{this.closed=true;},error:value=>{this.error=value;}};callbacks.start?.(this.controller);}}
  class FakeEncoder{encode(value){return {byteLength:value.length,text:value};}}
  const declarations=upstream.slice(upstream.indexOf('function row('),upstream.indexOf('export default'));
  const entry=upstream.slice(upstream.indexOf('export default')+'export default'.length).replace(/;\s*$/,'');
  const actual=runInNewContext(declarations+';('+entry+')',{states,bases:{baseten:'https://inference.baseten.co/v1'},createPrivateOperationLedger,URL:FakeURL,Response:FakeResponse,ReadableStream:InertStream,TextEncoder:FakeEncoder,
   setTimeout:fn=>{const timer={fn,cleared:false};timers.push(timer);return timer;},clearTimeout:timer=>{timer.cleared=true;}});
  const request=(url,body)=>({url,method:'GET',headers:{get:()=> 'Bearer synthetic-private-inert'},json:()=>Promise.resolve(body)});
  await actual.fetch(request('https://private-control.fixture/setup/inert',{id:'inert',provider:'baseten',scenario:'narrow'}));
  const response=await actual.fetch(request('https://inference.baseten.co/v1/models'));
  const stream=response.body,p=stream.callbacks.pull(stream.controller),owner=states.get('inert');assert.equal(owner.requests[0].producer,p);
  let done=false;const proof=actual.fetch(request('https://private-control.fixture/proof/inert')).then(v=>{done=true;return v;});
  for(let i=0;i<5;i++)await Promise.resolve();assert.equal(done,false);
  const receiver={},value=Reflect.apply(stream.callbacks.cancel,receiver,[undefined]);assert.equal(value,undefined);
  const result=(await proof).value;assert.equal(result.joined,true);assert.equal(result.pending,0);assert.equal(result.faults,0);assert.equal(result.canceled,1);assert.equal(result.expired,0);assert.equal(result.settled,1);
  assert.ok(result.originals>=4);assert.equal(result.observers,owner.ledger.operations.filter(o=>o.pending&&typeof o.pending.then==='function').length*2);assert.equal(result.census[0].explicitRelease,false);
  const cancel=owner.ledger.operations.find(o=>o.kind==='source_cancel');assert.equal(cancel.receiver,receiver);assert.equal(cancel.args.length,1);assert.equal(cancel.args[0],undefined);
  const again=(await actual.fetch(request('https://private-control.fixture/proof/inert'))).value;assert.equal(again.originals,result.originals);assert.equal(again.observers,result.observers);
  assert.throws(()=>actual.fetch(request('https://inference.baseten.co/v1/models')));await assert.rejects(actual.fetch(request('https://private-control.fixture/proof/inert')));
 });
 test('Private retained reader may pull without ingress ALS but rejects foreign ownership',async()=>{
  const f=await privateInertReader(()=>Promise.resolve({done:true}));
  await f.reader.read();assert.equal(f.s.ledger.faults.length,0);
  const r=f.s.readers[0],fn=r.originals.read;
  assert.equal(f.s.ownership.bound(r,'read',f.reader,fn),true);
  assert.equal(f.s.ownership.bound(r,'read',{},fn),false);
  assert.equal(f.s.ownership.bound(r,'read',f.reader,()=>{}),false);
  for(const field of ['token','request','transport','response','body']){const old=r[field];r[field]={};assert.equal(f.s.ownership.bound(r,'read',f.reader,fn),false);r[field]=old;}
  f.context.value={};assert.equal(f.s.ownership.bound(r,'read',f.reader,fn),false);f.context.value=undefined;
  f.s.ownership.retire();assert.equal(f.s.ownership.bound(r,'read',f.reader,fn),false);
 });
 test('Private Worker held original survives observer registration failure until its actual settlement',async()=>{
  const {s}=privateInertOwner();let resolve,attempts=0,finished=false;const p=new Promise(yes=>{resolve=yes;}),then=p.then;
  Object.defineProperty(p,'then',{value:function(...args){if(++attempts===1)throw undefined;return Reflect.apply(then,this,args);}});
  assert.equal(s.ledger.retain('closed',p).pending,p);const joined=s.ledger.drain().then(()=>{finished=true;});
  for(let i=0;i<4;i++)await Promise.resolve();assert.equal(finished,false);resolve();await joined;assert.equal(s.ledger.faults.length,1);assert.equal(s.ledger.faults[0],undefined);
  await assert.rejects(joinPrivateOriginals(s),e=>e===undefined);
 });
 test('Private Worker accounting, public receipt and cleanup gates remain independently strict',async()=>{
  const row={id:'inert',provider:'baseten',scenario:'eof'},receipt={retired:true,operations:[{state:'fulfilled'}],readers:[{unlocks:1,locked:false}],charged:0,
   source:{held:0,expired:0,joined:true,pending:0,faults:0,requests:1},requests:[{id:0,requestId:'receipt-0',status:200,credential:'discovery'}],calls:[{request:0,originalKey:true,noCaller:true,redirect:'manual',query:false,method:'GET',bodyAbsent:true}],events:[{request_id:'receipt-0',key_id:'inert_discovery',status_code:200,status:'success',provider:'baseten',policy_id:'inert',capability:'models.list',model:null,reserved_cost_micros:0,actual_cost_micros:0}]};
  assertPrivateReceipt(row,receipt);
  const changes=[p=>{p.retired=false;},p=>{p.operations[0].state='rejected';},p=>{p.readers[0].locked=true;},p=>{p.readers[0].unlocks=2;},p=>{p.charged=1;},p=>{p.source.expired=1;},p=>{p.source.joined=false;},p=>{p.source.pending=1;},p=>{p.source.faults=1;},p=>{p.events[0].actual_cost_micros=1;},p=>{p.events[0].reserved_cost_micros=1;},p=>{p.events[0].policy_id='foreign';}];
  for(const change of changes){const p=structuredClone(receipt);change(p);assert.throws(()=>assertPrivateReceipt(row,p));}
  const {s}=privateInertOwner();s.restores.push(()=>{throw undefined;});const source={joined:true,pending:0,faults:0,expired:0,held:0,requests:0,calls:[],census:[]};
  const result=await retirePrivateWorkerOwner(s,()=>source,()=>{throw undefined;},()=>false);assert.equal(result.retired,false);assert.equal(s.retirementFailures.length,2);assert.ok(s.retirementFailures.every(e=>e===undefined));
  let canceled=0;const response={consume:()=>Promise.resolve('invalid'),get body(){canceled++;throw Error('unneeded native body access');}};
  await assert.rejects(privateControlResponse(response,response.consume,()=>{throw undefined;}),e=>e===undefined);assert.equal(canceled,0);
 });
 test('Private Worker private graph gates accounting for foreign C0, Q, request and reader aliases',async()=>{
  const changes=[(s,r)=>{r.closedRecord=null;},(s,r)=>{r.closed={};},(s,r)=>{r.response={};},(s,r)=>{r.body={};},(s,r)=>{r.request={};},(s,r)=>{r.token={};},(s,r)=>{r.reader={};},
   (s,r)=>{r.originals={...r.originals,cancel(){}};},s=>{s.ledger.operations.find(o=>o.kind==='read_observer').originalRead=Promise.resolve();},s=>{s.ledger.fault(undefined);}];
  for(const change of changes){const f=await privateInertReader(()=>Promise.resolve({done:true}));await f.s.ownership.run(f.token,()=>f.reader.read());await f.reader.cancel();f.reader.releaseLock();await f.s.ledger.drain();assert.equal(f.s.ownership.intact(),true);
   change(f.s,f.s.readers[0]);let accounting=0;const source={joined:true,pending:0,faults:0,expired:0,held:0,requests:1,calls:[{method:'GET',path:'/v1/models',originalKey:true}],census:[{index:0,originals:1,cancels:0,producer:false,finished:false}]};
   const result=await retirePrivateWorkerOwner(f.s,()=>source,()=>{accounting++;},()=>false);assert.equal(accounting,0);assert.equal(result.retired,false);}
 });
 test('Private Worker complete diagnostic budget retains legacy lanes and four original failures',()=>{
  const commands=[],emit=privateAnnotationEmitter(v=>commands.push(v));
  for(let i=0;i<24;i++)emit({v:1,pin:privateCatalogPin,p:'baseten',a:'stream',r:'provider_error',q:false,vect:false,worker:false,restore:false,rejects:1024,pending:1024});
  for(const lane of ['outer','sdk'])for(let i=0;i<9;i++)emit({v:1,pin:privateCatalogPin,lane,case:107,phase:'worker_retirement',state:'rejected',defined:false,acq:4095,op:4095,count:65535});
  for(let i=0;i<4;i++)emit({v:1,pin:privateCatalogPin,lane:'outer',case:107,phase:'observer',state:'rejected',defined:false,acq:4095,op:4095,count:65535});
  assert.equal(commands.length,46);assert.ok(Buffer.byteLength(commands.join(''))<=16384);assert.ok(commands.every(c=>Buffer.byteLength(c)<=768));
 });
 // END Private Worker ownership inert regressions

 test("Private checkpoint preserves original invocation, promise and undefined rejection",async()=>{
  const records=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter("sdk",v=>records.push(v)),receiver={},args=[{},undefined];
  let calls=0,reject;const original=new Promise((_,no)=>{reject=no;});
  function operation(...got){calls++;assert.equal(this,receiver);assert.deepEqual(got,args);return original;}
  assert.equal(r.observe(0,"body",operation,receiver,args),original);reject(undefined);await r.drain();
  assert.equal(calls,1);assert.ok(records.some(v=>v.phase==="body"&&v.state==="rejected"&&v.defined===false));
  let threw=false;try{r.observe(1,"setup",()=>{throw undefined;},undefined,[]);}catch(e){threw=true;assert.equal(e,undefined);}
  assert.equal(threw,true);r.finish();assert.equal(r.failures.length,0);
 });
 test("Private checkpoint startup failure still finalizes and attempts every cleanup",async()=>{
  const records=[],order=[],secondary={};
  await assert.rejects(runPrivateReported(report=>report.observe(null,"setup",()=>{throw undefined;},undefined,[]),[
   report=>report.observe(null,"cleanup",()=>{order.push(1);throw secondary;},undefined,[]),
   ()=>{order.push(2);}
  ],v=>records.push(v)),e=>e instanceof AggregateError&&e.errors[0]===undefined&&e.errors[1]===secondary);
  assert.deepEqual(order,[1,2]);assert.ok(records.some(v=>v.phase==="setup"&&v.state==="threw"&&!v.defined));
  assert.ok(records.some(v=>v.phase==="cleanup"&&v.state==="threw"&&v.defined));assert.equal(records.at(-1).phase,"final");
 });
 test("Private checkpoint retains original read closed and independent cleanup faults",async()=>{
  const records=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter("sdk",v=>records.push(v));
  const data={},cleanup={};r.mark(2,"read","rejected",data,0,1);r.mark(2,"closed","rejected",data,0,2);
  r.observe(2,"cleanup",()=>Promise.reject(cleanup),undefined,[]);await r.drain();r.mark(2,"cleanup","fulfilled");r.flush(2);r.finish();
  for(const phase of ["read","closed","cleanup"])assert.ok(records.some(v=>v.phase===phase&&v.state==="rejected"&&v.defined));
  assert.equal(records.at(-1).phase,"final");assert.equal(r.failures.length,0);
 });
 test("Private checkpoint reporting faults never replace undefined primary",async()=>{
  let writes=0;
  await assert.rejects(runPrivateReported(()=>{throw undefined;},[()=>{}],()=>{writes++;throw undefined;}),e=>
   e instanceof AggregateError&&e.errors[0]===undefined&&e.errors[1] instanceof AggregateError&&e.errors[1].errors.every(v=>v===undefined));
  assert.ok(writes>0);
 });
 test("Private checkpoint observer fault preserves original return and is joined separately",async()=>{
  const records=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter("sdk",v=>records.push(v));
  const original={};Object.defineProperty(original,"then",{get(){throw undefined;}});
  assert.equal(r.observe(0,"case_result",()=>original,undefined,[]),original);await r.drain();r.finish();
  assert.equal(r.failures.length,1);assert.equal(r.failures[0],undefined);assert.equal(records.at(-1).phase,"final");
 });
 test("Private checkpoint case finalization never joins its own completion observer",async()=>{
  const {createPrivateCheckpointReporter,finishPrivateCheckpointCase}=privateCheckpointFunctions(),records=[];
  const report=createPrivateCheckpointReporter("sdk",r=>records.push(r));let finalized=false;
  const original=Promise.resolve().then(()=>{
   assert.equal(finishPrivateCheckpointCase(report,0,[]),undefined);finalized=true;
  });
  assert.equal(report.observe(0,"case_result",()=>original,undefined,[]),original);
  await original;assert.equal(finalized,true);await report.drain();report.finish();assert.equal(report.failures.length,0);
  const second=createPrivateCheckpointReporter("sdk",r=>records.push(r));
  const rejected=Promise.resolve().then(()=>{finishPrivateCheckpointCase(second,1,[undefined]);throw undefined;});
  assert.equal(second.observe(1,"case_result",()=>rejected,undefined,[]),rejected);
  let caught=false;try{await rejected;}catch(reason){caught=true;assert.equal(reason,undefined);}assert.equal(caught,true);
  await second.drain();second.finish();assert.ok(records.some(r=>r.case===1&&r.phase==="assertions"&&r.defined===false));
  const source=readFileSync(new URL("./fixtures/openclaw-private-catalogs-contract.test.ts",import.meta.url),"utf8");
  assert.doesNotMatch(source.slice(source.indexOf('async function fixtureOwned('),source.indexOf('function inference(')),/checkpoints\.drain\(/);
 });
 test("Private checkpoint bounded overflow reserves final summary and rejects unsafe fields",async()=>{
  const {createPrivateCheckpointReporter,validatePrivateCheckpoint}=privateCheckpointFunctions(),records=[];
  const r=createPrivateCheckpointReporter("sdk",v=>records.push(v));
  for(let i=0;i<108;i++){r.mark(i,"body","rejected",{});r.flush(i);}r.finish();
  assert.equal(records.length,8);assert.equal(records.at(-2).phase,"overflow");assert.equal(records.at(-2).count,103);assert.equal(records.at(-1).phase,"final");
  const commands=[],emit=privateAnnotationEmitter(v=>commands.push(v));for(const record of records)emit(record);
  assert.ok(commands.every(v=>Buffer.byteLength(v)<=768));assert.ok(Buffer.byteLength(commands.join(""))<16384);
  for(const change of [{pin:"foreign"},{case:108},{phase:"unknown_module_name"},{op:-1},{acq:4096},{defined:null},{message:"private"}])
   assert.throws(()=>validatePrivateCheckpoint({...records[0],...change}));
 });
 test("Private checkpoint collector preserves child plus cleanup closure without getters",async()=>{
  const records=[],r=privateCheckpointFunctions().createPrivateCheckpointReporter("sdk",v=>records.push(v));r.mark(0,"setup","threw",undefined);r.flush(0);r.finish();
  const child=Object.assign(new Error("not forwarded"),{stdout:records.map(v=>"PRIVATE_CHECKPOINT "+JSON.stringify(v)).join("\n")});
  const outer=new AggregateError([child,undefined],"not forwarded");Object.defineProperty(outer,"cause",{value:outer});let getters=0;
  Object.defineProperty(outer,"stderr",{get(){getters++;throw Error("not called");}});
  const emitted=[];await assert.rejects(withPrivateNativeDiagnostics(()=>{throw outer;},v=>emitted.push(v)),e=>e===outer);
  assert.deepEqual(emitted,JSON.parse(JSON.stringify(records)));assert.equal(getters,0);
  assert.throws(()=>privateCheckpointRecords({stdout:"PRIVATE_CHECKPOINT "+JSON.stringify({...records[0],unknown:true})}));
  assert.deepEqual(privateCheckpointRecords({stdout:"untrusted text\n# PRIVATE_CHECKPOINT {}"}),[]);
 });
 test("Private checkpoint observes real child import rejection with column-zero protocol",async()=>{
  const {createPrivateCheckpointReporter,validatePrivateCheckpoint}=privateCheckpointFunctions();
  const code=validatePrivateCheckpoint.toString()+"\n"+createPrivateCheckpointReporter.toString()+`
const r=createPrivateCheckpointReporter("sdk",v=>process.stdout.write("PRIVATE_CHECKPOINT "+JSON.stringify(v)+"\\n"));
try{await r.observe(null,"setup",()=>import("node:missing_private_diagnostic_module"),undefined,[]);}
catch{process.exitCode=1;}finally{await r.drain();r.finish();}`;
  let child;try{await promisify(execFile)(process.execPath,["--input-type=module","-e",code],{timeout:10000,maxBuffer:16384});}catch(error){child=error;}
  assert.ok(child);const records=privateCheckpointRecords(child);
  assert.ok(records.some(v=>v.phase==="setup"&&v.state==="rejected"&&v.defined));assert.equal(records.at(-1).phase,"final");
  assert.ok(child.stdout.split("\n").filter(Boolean).every(line=>line.startsWith("PRIVATE_CHECKPOINT ")));
  const emitted=[];await assert.rejects(withPrivateNativeDiagnostics(()=>Promise.reject(child),v=>emitted.push(v)),e=>e===child);
  assert.deepEqual(emitted,records);
 });
 test("Private checkpoint missing child protocol distinguishes helper boundary from SDK entry",async()=>{
  const emitted=[],reason={};
  await assert.rejects(runPrivateReported(report=>withPrivateNativeDiagnostics(()=>report.observe(null,"child",()=>Promise.reject(reason),undefined,[]),v=>emitted.push(v)),[],v=>emitted.push(v)),e=>e===reason);
  assert.ok(emitted.some(v=>v.lane==="outer"&&v.phase==="child"&&v.state==="rejected"));
  assert.equal(emitted.some(v=>v.lane==="sdk"),false);assert.equal(emitted.at(-1).phase,"final");
 });
 test("Private checkpoint correlates actual authored rows without borrowed case identity",()=>{
  const {privateCheckpointCaseIndex}=privateCheckpointFunctions(),all=[...privateNativeControls,...privateCases];
  assert.equal(all.length,108);assert.equal(privateCases.filter(r=>!r.workerOnly).length,75);assert.equal(privateNativeControls.length,24);
  for(const [index,row]of all.entries())assert.equal(privateCheckpointCaseIndex(all,row.id),index);
  assert.throws(()=>privateCheckpointCaseIndex(all,"unknown"));assert.throws(()=>privateCheckpointCaseIndex([...all,all[0]],all[0].id));
  assert.throws(()=>privateCheckpointCaseIndex([...all,{id:"late"}],"late"));
 });
 test("Private checkpoint joins late observation and bounds controls plus both reporting lanes",async()=>{
  const {createPrivateCheckpointReporter}=privateCheckpointFunctions(),commands=[],emit=privateAnnotationEmitter(line=>commands.push(line));
  for(const row of privateNativeControls)emit({v:1,pin:privateCatalogPin,p:row.provider,a:row.api,r:row.control,q:false,vect:false,worker:false,restore:false,rejects:1024,pending:1024});
  for(const lane of ["outer","sdk"]){const report=createPrivateCheckpointReporter(lane,emit);
   const first=Promise.resolve().then(()=>{report.observe(1,"cleanup",()=>Promise.reject(undefined),undefined,[]);});
   report.observe(0,"body",()=>first,undefined,[]);await report.drain();
   for(let i=2;i<108;i++){report.mark(i,"worker_retirement","rejected",{});report.flush(i);}report.finish();
   assert.equal(report.failures.length,0);
  }
  assert.equal(commands.length,40);assert.ok(Buffer.byteLength(commands.join(""))<=16384);assert.ok(commands.every(line=>Buffer.byteLength(line)<=768));
  assert.equal(commands.filter(line=>line.includes('"phase":"final"')).length,2);
 });

 const evaluator=privateNativeEvaluator();
 function nativeEvidence(){
  const owner={},identity={guard:()=>{}},reason={name:"AbortError"},stored={name:"AbortError"};
  const caller={kind:"inference",owner,signal:{aborted:true},reason,abortCalled:true,abortedAfter:true,noEarlierFailure:true,delivered:7,abortInvoke:8,abortObserved:9,result:"aborted"};
  const input={signal:caller.signal},body={locked:false},response={body},acquisition={owner,guard:identity.guard,input,inputSignal:input.signal,response,result:{response},operation:{state:"fulfilled",pending:Promise.resolve()}};acquisition.pending=acquisition.operation.pending;
  const transport={owner,method:"POST",signal:{aborted:true},acquisition,response,bodies:[body],readers:[],guardObserved:true,releases:1,releaseDone:true,fetch:{state:"fulfilled"}};acquisition.transport=transport;
  const reader={owner,original:{},body,transport,closed:Promise.resolve(),acquired:2,unlocks:1,unlockFailed:false,unlockAt:14};reader.unlockReceiver=reader.original;transport.readers.push(reader);
  const common={owner,reader,receiver:reader.original};
  const read={...common,kind:"read",state:"rejected",reason:stored,invoke:6,settle:10,callerSignal:caller.signal,effectiveSignal:transport.signal,callerAbortedAtInvoke:false,callerAbortedAtSettle:true,effectiveAbortedAtSettle:true};
  const closed={...common,kind:"closed",state:"rejected",reason:stored,pending:reader.closed,invoke:3,settle:11};
  const cancel={...common,kind:"cancel",state:"rejected",reason:stored,args:[stored],invoke:12,settle:13};
  const prefix={...common,kind:"read",state:"fulfilled",value:{done:false,value:new Uint8Array([1])},settle:5};
  const release={owner,kind:"guard_release",state:"fulfilled",acquisition,receiver:acquisition.result,invoke:15,returnAt:16,settle:17};transport.release=release;caller.pending=[read];
  const invocation=Object.freeze({owner,caller,signal:caller.signal,kind:"inference",fn:()=>{},receiver:undefined,args:Object.freeze([{}, {}, {signal:caller.signal}])});
  acquisition.invocation=invocation;acquisition.context=Object.freeze({invocation,acquisition});transport.invocation=invocation;transport.context=acquisition.context;transport.caller=caller;
  return {owner,identity,provider:"baseten",api:"stream",role:"partial",caller,callers:[caller],transports:[transport],originals:[prefix,read,closed,cancel,release],failures:[],observerFailures:[],syncFailures:[],restored:true,sourceExpired:0};
 }
 function controlEvidence(role,identity){
  const w=nativeEvidence();w.identity=identity;w.transports[0].acquisition.guard=identity.guard;w.role=role;
  if(role!=="partial"){for(const o of w.originals)o.state="fulfilled";w.caller.abortCalled=role==="preabort";w.caller.signal.aborted=role==="preabort";w.caller.result=role==="eof"?"stop":"error";w.caller.emptyContent=role==="preabort";}
  if(role==="preabort"){const t=w.transports[0],a=t.acquisition,c=evaluator.newPrivateInvocationCaller(w.owner,undefined,"discovery");w.callers.push(c);t.method="GET";
   const invocation=Object.freeze({owner:w.owner,caller:c,signal:c.signal,kind:"discovery",fn:()=>{},receiver:undefined,args:Object.freeze([{signal:c.signal}])});
   a.invocation=t.invocation=invocation;a.context=t.context=Object.freeze({invocation,acquisition:a});t.caller=undefined;t.catalogInitiator=c;w.coldZeroDispatch=true;w.preabortPostDelta=0;}
  return w;
 }
 test('Private executed guard identity still requires exact result, lease release and complete retirement',()=>{
  const changes={pending:w=>{w.transports[0].acquisition.operation.state='pending';},foreignPromise:w=>{w.transports[0].acquisition.pending=Promise.resolve();},missingResult:w=>{delete w.transports[0].acquisition.result;},foreignResult:w=>{w.transports[0].acquisition.result={response:{}};},unattached:w=>{w.transports[0].guardObserved=false;},release:w=>{w.transports[0].releaseDone=false;},count:w=>{w.transports[0].releases=0;},unlock:w=>{w.transports[0].readers[0].unlocks=0;},observer:w=>{w.observerFailures.push(undefined);},restore:w=>{w.restored=false;},expiry:w=>{w.sourceExpired=1;}};
  for(const change of [undefined,...Object.values(changes)]){
   const w=controlEvidence('eof',{guard(){}}),a=w.transports[0].acquisition,fn=()=>{binding.entry({},fn,a.input);return a.pending;};a.guard=fn;
   const binding=privateExecutedGuardFactory()(()=>a.context,()=>undefined,(original,receiver,args,proof)=>{a.guardSource=proof;return Reflect.apply(original,receiver,args);},w.observerFailures);w.executedGuard=binding;
   assert.equal(evaluator.evaluatePrivateNativeControl(w).qualified,false);
   assert.equal(binding.call({},fn,a.input),a.pending);assert.equal(binding.bound(a),true);assert.equal(evaluator.evaluatePrivateNativeControl(w).qualified,true);
   if(change){change(w);assert.equal(evaluator.evaluatePrivateNativeControl(w).qualified,false);}
  }
 });
 function controls(identity){return ["eof","preabort","partial","provider_error"].map(role=>evaluator.evaluatePrivateNativeControl(controlEvidence(role,identity)));}
 function invocationHarness(){const storage=new AsyncLocalStorage();return {storage,ownership:evaluator.createPrivateInvocationOwnership(storage)};}
 async function runInvocation(h,caller,wait=Promise.resolve()){
  const publicReceiver={},guardReceiver={},options={signal:caller.signal},args=[{}, {}, options],guardSignal={},input={signal:guardSignal},response={body:{}},result={response},t={method:'POST'};
  let publicContext,guardContext,transportContext,guardOriginal,guardReturned,publicOriginal,seenArgs,seenGuardArgs;
  function originalGuard(...actual){assert.equal(this,guardReceiver);seenGuardArgs=actual;guardContext=h.storage.getStore();
   guardOriginal=wait.then(()=>{transportContext=h.storage.getStore();h.ownership.transport(t);h.ownership.response(t,response);return result;});return guardOriginal;}
  const acquisition={input,inputSignal:guardSignal,guard:originalGuard,operation:{state:"fulfilled"}},guardArgs=[input];
  function originalPublic(...actual){assert.equal(this,publicReceiver);seenArgs=actual;publicContext=h.storage.getStore();
   const completion=Promise.resolve().then(()=>{guardReturned=h.ownership.guard(originalGuard,guardReceiver,guardArgs,acquisition);assert.equal(guardReturned,guardOriginal);acquisition.pending=acquisition.operation.pending=guardOriginal;return guardReturned;}).then(r=>h.ownership.attach(acquisition,r));
   publicOriginal={completion};return publicOriginal;}
  const returned=h.ownership.invoke(caller,'inference',originalPublic,publicReceiver,args);assert.equal(returned,publicOriginal);await returned.completion;
  assert.deepEqual(seenArgs,args);assert.deepEqual(seenGuardArgs,guardArgs);assert.equal(publicContext.invocation.caller,caller);
  assert.equal(publicContext.invocation.fn,originalPublic);assert.equal(publicContext.invocation.receiver,publicReceiver);
  assert.equal(publicContext.invocation.args[2],options);assert.ok(Object.isFrozen(publicContext.invocation));assert.ok(Object.isFrozen(publicContext.invocation.args));
  assert.equal(guardContext.invocation,publicContext.invocation);assert.equal(transportContext,guardContext);assert.equal(acquisition.invocation,publicContext.invocation);
  assert.equal(t.caller,caller);assert.equal(t.acquisition,acquisition);assert.equal(t.response,response);assert.equal(acquisition.result,result);assert.equal(h.ownership.bound(t),true);
  assert.notEqual(input.signal,caller.signal);assert.equal(evaluator.privateInvocationBound({owner:caller.owner,callers:[caller]},t),true);
  return {t,acquisition,result,context:guardContext};
 }
 test('private invocation wrapper preserves original identities across asynchronous guard and fetch',async()=>{
  const h=invocationHarness(),caller={kind:"inference",owner:{},signal:new AbortController().signal};await runInvocation(h,caller);assert.equal(h.storage.getStore(),undefined);h.ownership.restore();
 });
 test('private invocation wrapper preserves discovery receiver and original rejected promise',async()=>{
  const h=invocationHarness(),caller={kind:"discovery",owner:{},signal:{}},receiver={},input={signal:caller.signal},reason={};let original,called=0;
  function run(options){assert.equal(this,receiver);assert.equal(options,input);called++;return original=Promise.reject(reason);}
  const returned=h.ownership.invoke(caller,'discovery',run,receiver,[input]);assert.equal(returned,original);await assert.rejects(returned,e=>e===reason);assert.equal(called,1);assert.equal(h.storage.getStore(),undefined);h.ownership.restore();
 });
 test('private invocation wrapper refuses ambiguous original response and foreign guard result',async()=>{
  const h=invocationHarness(),caller={kind:"inference",owner:{},signal:{}};const one=await runInvocation(h,caller);
  assert.throws(()=>h.ownership.response(one.t,one.t.response));assert.throws(()=>h.ownership.attach(one.acquisition,{response:{}}));
  const other={method:'POST'},a={input:{signal:{}},guard:undefined};
  function guard(){h.ownership.transport(other);h.ownership.response(other,one.t.response);}
  a.guard=guard;let caught=false;
  try{h.ownership.invoke(caller,'inference',()=>h.ownership.guard(guard,undefined,[a.input],a),undefined,[{},{},{signal:caller.signal}]);}catch{caught=true;}
  assert.equal(caught,true);assert.equal(other.guardObserved,undefined);h.ownership.restore();
 });
 test('private invocation wrapper isolates concurrent callers',async()=>{
  const h=invocationHarness();let release;const held=new Promise(r=>{release=r;}),a={kind:"inference",owner:{},signal:new AbortController().signal},b={kind:"inference",owner:{},signal:new AbortController().signal};
  const first=runInvocation(h,a,held);const second=await runInvocation(h,b);release();const initial=await first;
  assert.notEqual(initial.context,second.context);assert.equal(initial.t.caller,a);assert.equal(second.t.caller,b);h.ownership.restore();
 });
 test('private invocation wrapper refuses missing foreign detached and substituted contexts',async()=>{
  const h=invocationHarness(),caller={kind:"inference",owner:{},signal:new AbortController().signal};
  assert.throws(()=>h.ownership.transport({method:'POST'}));
  const good=await runInvocation(h,caller);
  h.storage.run({invocation:{...good.context.invocation},acquisition:good.acquisition},()=>assert.throws(()=>h.ownership.transport({method:'POST'})));
  h.storage.run({...good.context,acquisition:{}},()=>assert.throws(()=>h.ownership.transport({method:'POST'})));
  h.storage.run(good.context,()=>assert.throws(()=>h.ownership.transport({method:'POST'})));
  const detached=AsyncLocalStorage.snapshot();h.storage.run(good.context,()=>detached(()=>assert.throws(()=>h.ownership.transport({method:'POST'}))));
  assert.throws(()=>h.ownership.attach({},good.result));assert.throws(()=>h.ownership.attach(good.acquisition,good.result));h.ownership.restore();
 });
 test('private invocation wrapper refuses mismatched caller arguments and kind',()=>{
  const h=invocationHarness(),caller={kind:"inference",owner:{},signal:{}},fn=()=>assert.fail('original must not be called');
  assert.throws(()=>h.ownership.invoke(caller,'inference',fn,undefined,[{},{},{signal:{}}]));
  assert.throws(()=>h.ownership.invoke(caller,'unknown',fn,undefined,[{signal:caller.signal}]));h.ownership.restore();
 });
 test('private invocation wrapper preserves original synchronous undefined and restores context',()=>{
  const h=invocationHarness(),caller={kind:"inference",owner:{},signal:{}},args=[{},{},{signal:caller.signal}],receiver={};let calls=0,threw=false;
  function original(){calls++;assert.equal(this,receiver);throw undefined;}
  try{h.ownership.invoke(caller,'inference',original,receiver,args);}catch(e){threw=true;assert.equal(e,undefined);}
  assert.equal(threw,true);assert.equal(calls,1);assert.equal(h.storage.getStore(),undefined);
  function publicCall(){const input={signal:{}},a={input,guard:original};return h.ownership.guard(original,receiver,[input],a);}
  threw=false;try{h.ownership.invoke(caller,'inference',publicCall,undefined,args);}catch(e){threw=true;assert.equal(e,undefined);}
  assert.equal(threw,true);assert.equal(calls,2);assert.equal(h.storage.getStore(),undefined);h.ownership.restore();
 });
 test('private invocation wrapper retains an independent observer failure without replacing original result',async()=>{
  const h=invocationHarness(),caller={kind:"inference",owner:{},signal:{}},reason={},failures=[];let original;
  function publicCall(){return original=Promise.resolve({value:1});}
  const returned=h.ownership.invoke(caller,'inference',publicCall,undefined,[{},{},{signal:caller.signal}]);assert.equal(returned,original);
  const observer=returned.then(()=>{throw reason;}).catch(e=>{failures.push(e);});assert.deepEqual(await returned,{value:1});await observer;assert.deepEqual(failures,[reason]);h.ownership.restore();
 });
 test('private invocation wrapper restoration rejects reuse without clobbering a foreign context',async()=>{
  const h=invocationHarness(),caller={kind:"inference",owner:{},signal:{}};await runInvocation(h,caller);h.ownership.restore();assert.throws(()=>h.ownership.restore());
  let called=false;assert.throws(()=>h.ownership.invoke(caller,'inference',()=>{called=true;},undefined,[{},{},{signal:caller.signal}]));assert.equal(called,false);
  const other=new AsyncLocalStorage(),foreign={};other.run(foreign,()=>{assert.equal(other.getStore(),foreign);assert.throws(()=>h.ownership.transport({method:'POST'}));assert.equal(other.getStore(),foreign);});other.disable();
 });
 test('private invocation evaluator refuses coherent foreign tokens and permits distinct bound signals',()=>{
  const w=nativeEvidence();assert.equal(evaluator.evaluatePrivateNativeControl(w).qualified,true);
  const t=w.transports[0];t.acquisition.inputSignal=t.acquisition.input.signal={};assert.equal(evaluator.evaluatePrivateNativeControl(w).qualified,true);
  const foreign=Object.freeze({...t.invocation,caller:{...w.caller},signal:{}});t.invocation=t.acquisition.invocation=foreign;t.context=t.acquisition.context=Object.freeze({invocation:foreign,acquisition:t.acquisition});t.caller=foreign.caller;
  assert.equal(evaluator.evaluatePrivateNativeControl(w).qualified,false);
 });
 test('private invocation wrapper creates distinct owners for reused and undefined signals',async()=>{
  for(const signal of [undefined,new AbortController().signal]){
   const h=invocationHarness(),owner={},first=evaluator.newPrivateInvocationCaller(owner,signal,"inference"),second=evaluator.newPrivateInvocationCaller(owner,signal,"inference");
   assert.notEqual(first,second);assert.equal(first.signal,second.signal);const [a,b]=await Promise.all([runInvocation(h,first),runInvocation(h,second)]);
   assert.notEqual(a.context.invocation,b.context.invocation);assert.equal(a.t.caller,first);assert.equal(b.t.caller,second);h.ownership.restore();
  }
 });
 test('private invocation wrapper refuses an unrelated POST under discovery ownership',()=>{
  const h=invocationHarness(),caller=evaluator.newPrivateInvocationCaller({},undefined,"discovery"),input={signal:undefined},a={input};
  function guard(){h.ownership.transport({method:"POST"});}a.guard=guard;
  assert.throws(()=>h.ownership.invoke(caller,"discovery",()=>h.ownership.guard(guard,undefined,[input],a),undefined,[{signal:undefined}]));h.ownership.restore();
 });
 test('private invocation shared catalog retains initiator context without assigning waiter cancellation ownership',async()=>{
  const h=invocationHarness(),owner={},control=new AbortController(),first=evaluator.newPrivateInvocationCaller(owner,control.signal,"discovery"),second=evaluator.newPrivateInvocationCaller(owner,undefined,"discovery");
  let release,shared,secondContext;const held=new Promise(r=>{release=r;}),response={body:{}},result={response},t={method:"GET"},input={signal:{}},a={input,inputSignal:input.signal};
  function guard(){return held.then(()=>{h.ownership.transport(t);h.ownership.response(t,response);return result;});}a.guard=guard;
  function catalog(){if(shared){secondContext=h.storage.getStore();return shared;}return shared=h.ownership.guard(guard,undefined,[input],a);}
  const one=h.ownership.invoke(first,"discovery",catalog,undefined,[{signal:control.signal}]),two=h.ownership.invoke(second,"discovery",catalog,undefined,[{signal:undefined}]);
  assert.equal(one,two);assert.notEqual(a.invocation,secondContext.invocation);control.abort();release();h.ownership.attach(a,await one);
  assert.equal(t.catalogInitiator,first);assert.equal(t.caller,undefined);assert.notEqual(a.inputSignal,first.signal);assert.equal(h.ownership.bound(t),true);h.ownership.restore();
 });
 test('private invocation evaluator requires one inference invocation for a control vector',()=>{
  const w=nativeEvidence();w.callers.push(evaluator.newPrivateInvocationCaller(w.owner,w.caller.signal,"inference"));assert.equal(evaluator.evaluatePrivateNativeControl(w).qualified,false);
 });
 test('private fetch receiver wrapper preserves unbound sentinel and exact original arguments and promise',async()=>{
  for(const receiver of [undefined,{}])for(const args of [[],[{}],[{},undefined],[{}, {}, {}]]){
   const failures=[],calls=[],pending=Promise.resolve({});let captured;
   function original(...actual){calls.push({receiver:this,args:actual});return pending;}
   const wrapped=evaluator.createPrivateFetchObserver(original,(actualReceiver,actualArgs)=>{captured={receiver:actualReceiver,args:actualArgs};return {returned:value=>assert.equal(value,pending),threw:()=>assert.fail('unexpected throw')};},failures);
   const result=Reflect.apply(wrapped,receiver,args);assert.equal(result,pending);assert.equal(calls.length,1);assert.equal(calls[0].receiver,receiver);assert.deepEqual(calls[0].args,args);
   assert.equal(captured.receiver,receiver);assert.deepEqual([...captured.args],args);assert.deepEqual(failures,[]);await result;
  }
 });
 test('private fetch receiver wrapper preserves synchronous undefined and independent observer failure',()=>{
  const failures=[],observerError={},receiver={},arg={};let called=0,threw=false;
  function original(value){assert.equal(this,receiver);assert.equal(value,arg);called++;throw undefined;}
  const wrapped=evaluator.createPrivateFetchObserver(original,()=>({threw:reason=>{assert.equal(reason,undefined);throw observerError;}}),failures);
  try{Reflect.apply(wrapped,receiver,[arg]);}catch(e){threw=true;assert.equal(e,undefined);}assert.equal(threw,true);assert.equal(called,1);assert.deepEqual(failures,[observerError]);
 });
 test('private fetch receiver wrapper keeps rejected original promise despite return observer failure',async()=>{
  const reason={},observerError={},failures=[],pending=Promise.reject(reason);
  const wrapped=evaluator.createPrivateFetchObserver(()=>pending,()=>({returned:()=>{throw observerError;}}),failures);
  const result=wrapped();assert.equal(result,pending);await assert.rejects(result,e=>e===reason);assert.deepEqual(failures,[observerError]);
 });
 test('private predispatch oracle requires exact error empty content and zero inference POST',()=>{
  const identity={guard:()=>{}},good=controlEvidence('preabort',identity);assert.equal(evaluator.evaluatePrivateNativeControl(good).qualified,true);
  for(const mutate of [w=>{w.caller.result='aborted';},w=>{w.caller.emptyContent=false;},w=>{w.preabortPostDelta=1;}]){const w=controlEvidence('preabort',identity);mutate(w);assert.equal(evaluator.evaluatePrivateNativeControl(w).qualified,false);}
  const partial=controlEvidence('partial',identity);assert.equal(evaluator.evaluatePrivateNativeControl(partial).qualified,true);partial.caller.result='error';assert.equal(evaluator.evaluatePrivateNativeControl(partial).qualified,false);
 });
 test('private native evaluator records the predefined rejection vector without C0 identity or product credit',()=>{
  const w=nativeEvidence(),result=evaluator.evaluatePrivateNativeControl(w);assert.equal(result.qualified,true);assert.equal(result.vectorObserved,true);
  assert.notEqual(w.caller.reason,w.originals[1].reason);assert.equal(w.originals.filter(o=>o.state==='rejected').length,3);
  assert.equal(evaluator.privateProductExpected(w,undefined).length,0);
  const q=evaluator.privateQualification(controls(w.identity),w.identity,w.provider,w.api);assert.ok(q);
  assert.equal(evaluator.privateProductExpected(w,q).length,3);assert.equal(w.originals.filter(o=>o.state==='rejected').length,3);
  assert.equal(evaluator.privateProductExpected({...w,api:'simple'},q).length,0);
  assert.equal(evaluator.privateProductExpected({...w,identity:{}},q).length,0);
  w.originals[3].args=[];assert.equal(evaluator.evaluatePrivateNativeControl(w).qualified,true);assert.equal(evaluator.privateProductExpected(w,q).length,0);
 });
 const nativeCounterfactuals={
  'prior observed failure':w=>{w.caller.noEarlierFailure=false;},'different error with same name':w=>{w.originals[2].reason={name:'AbortError'};},
  'undefined rejection':w=>{for(const o of w.originals.filter(o=>o.state==='rejected'))o.reason=undefined;},
  'wrong caller':w=>{w.caller.owner={};},'wrong acquisition':w=>{w.transports[0].acquisition.owner={};},'wrong response':w=>{w.transports[0].response={};},
  'wrong reader':w=>{w.originals[1].reader={};},'wrong receiver':w=>{w.originals[3].receiver={};},'wrong captured closed':w=>{w.originals[2].pending=Promise.resolve();},
  'ambiguous reader':w=>{w.transports[0].readers.push(w.transports[0].readers[0]);},'ambiguous request':w=>{w.transports.push(w.transports[0]);},
  'missing compiled guard':w=>{w.transports[0].guardObserved=false;},'foreign guard graph':w=>{w.transports[0].acquisition.guard=()=>{};},
  'foreign original guard signal':w=>{w.transports[0].acquisition.inputSignal={};},'foreign caller signal':w=>{w.originals[1].callerSignal={};},
  'late abort':w=>{w.caller.abortObserved=12;},'unobserved abort':w=>{w.caller.abortCalled=false;},'read began aborted':w=>{w.originals[1].callerAbortedAtInvoke=true;},
  'not aborted at rejection':w=>{w.originals[1].callerAbortedAtSettle=false;},'no effective abort':w=>{w.originals[1].effectiveAbortedAtSettle=false;},
  'no pending read':w=>{w.caller.pending=[];},'missing actual delivery':w=>{w.caller.delivered=0;},'missing nonempty read':w=>{w.originals[0].value.value=new Uint8Array();},
  'cancel before stored error':w=>{w.originals[3].invoke=9;},'foreign cancel argument':w=>{w.originals[3].args=[{}];},
  'pending release':w=>{w.transports[0].release.state='pending';},'failed release undefined':w=>{w.transports[0].release.state='rejected';w.transports[0].release.reason=undefined;},
  'wrong release receiver':w=>{w.transports[0].release.receiver={};},'missing original release return':w=>{w.transports[0].release.returnAt=0;},
  'duplicate release':w=>{w.transports[0].releases=2;},'early unlock':w=>{w.transports[0].readers[0].unlockAt=10;},'duplicate unlock':w=>{w.transports[0].readers[0].unlocks=2;},
  'releaseLock error':w=>{w.transports[0].readers[0].unlockFailed=true;w.syncFailures.push(new TypeError('synthetic'));},'locked body':w=>{w.transports[0].response.body.locked=true;},
  'failed restoration':w=>{w.restored=false;},'observer undefined':w=>{w.observerFailures.push(undefined);},'sync undefined':w=>{w.syncFailures.push(undefined);},
  'source expiry':w=>{w.sourceExpired=1;},'unknown source':w=>{w.sourceExpired=null;},'body and cleanup failures':w=>{w.failures.push({},undefined);},
  'late independent join failure':w=>{w.originals.push({kind:'late',state:'rejected',reason:undefined});}
 };
 for(const [name,mutate] of Object.entries(nativeCounterfactuals))test('private native evaluator refuses '+name,()=>{const w=nativeEvidence();mutate(w);assert.equal(evaluator.evaluatePrivateNativeControl(w).qualified,false);});
 test('private native qualification needs four independent exact-runtime roles after restoration',()=>{
  const identity={guard:()=>{}},reports=controls(identity);assert.ok(reports.every(r=>r.qualified));
  const qualify=r=>evaluator.privateQualification(r,identity,'baseten','stream');assert.ok(qualify(reports));assert.equal(qualify(reports.slice(1)),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,qualified:false}:r)),undefined);
  assert.equal(qualify(reports.map(r=>({...r,owner:reports[0].owner}))),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,identity:{}}:r)),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,provider:'novita'}:r)),undefined);
  assert.equal(qualify(reports.map((r,i)=>i===2?{...r,role:'eof'}:r)),undefined);
 });
 test('private native nonpartial controls cannot borrow the stored-error disposition',()=>{
  const identity={guard:()=>{}};
  for(const role of ['eof','preabort','provider_error']){const w=controlEvidence(role,identity);w.originals[1].state='rejected';assert.equal(evaluator.evaluatePrivateNativeControl(w).qualified,false);}
  const cold=controlEvidence('preabort',identity);cold.coldZeroDispatch=false;assert.equal(evaluator.evaluatePrivateNativeControl(cold).qualified,false);
  delete cold.coldZeroDispatch;assert.equal(evaluator.evaluatePrivateNativeControl(cold).qualified,false);
  const dispatched=controlEvidence('preabort',identity);dispatched.preabortPostDelta=1;assert.equal(evaluator.evaluatePrivateNativeControl(dispatched).qualified,false);
  const provider=controlEvidence('provider_error',identity);provider.caller.signal.aborted=true;assert.equal(evaluator.evaluatePrivateNativeControl(provider).qualified,false);
  const eof=controlEvidence('eof',identity);eof.transports[0].readers=[];assert.equal(evaluator.evaluatePrivateNativeControl(eof).qualified,false);
 });
 test('private native descriptor restoration retains identity and every flag',()=>{
  const d={value:()=>{},writable:true,enumerable:false,configurable:true};assert.equal(evaluator.samePrivateDescriptor(d,{...d}),true);
  for(const k of ['value','writable','enumerable','configurable'])assert.equal(evaluator.samePrivateDescriptor(d,{...d,[k]:k==='value'?()=>{}:!d[k]}),false);
 });
 test('private native diagnostics preserve closed records through original aggregate errors without getters',async()=>{
  const record={v:1,pin:privateCatalogPin,p:'baseten',a:'stream',r:'partial',q:false,vect:true,worker:false,restore:true,rejects:3,pending:0};
  const child={stdout:'PRIVATE_NATIVE_CONTROL '+JSON.stringify(record)+'\n'},root=new AggregateError([child,undefined],'synthetic');root.cause=root;
  Object.defineProperty(root,'stderr',{get(){throw Error('getter called');}});assert.deepEqual(privateNativeDiagnosticRecords(root),[record]);
  const emitted=[];await assert.rejects(withPrivateNativeDiagnostics(async()=>{throw root;},r=>emitted.push(r)),e=>e===root);assert.deepEqual(emitted,[record]);
  await assert.rejects(withPrivateNativeDiagnostics(async()=>{throw root;},()=>{throw undefined;}),e=>e instanceof AggregateError&&e.errors[0]===root&&e.errors[1]===undefined);
  await assert.rejects(withPrivateNativeDiagnostics(async()=>{throw undefined;},()=>{}),e=>e===undefined);
  for(const changed of [{...record,p:'other'},{...record,pin:'wrong'},{...record,extra:'secret'},{...record,rejects:-1},{...record,pending:1.5},{...record,r:'other'}])assert.throws(()=>privateNativeDiagnosticRecords({stdout:'PRIVATE_NATIVE_CONTROL '+JSON.stringify(changed)}));
  assert.deepEqual(privateNativeDiagnosticRecords({stdout:' prefix PRIVATE_NATIVE_CONTROL '+JSON.stringify(record)}),[]);
  assert.throws(()=>privateNativeDiagnosticRecords({stdout:'PRIVATE_NATIVE_CONTROL '+JSON.stringify(record)+' '.repeat(301)}));
  const childProcess=createRequire(import.meta.url)('node:child_process').spawnSync(process.execPath,['-e','process.stdout.write('+JSON.stringify('PRIVATE_NATIVE_CONTROL '+JSON.stringify(record)+'\n')+')'],{encoding:'utf8'});
  assert.equal(childProcess.status,0);assert.deepEqual(privateNativeDiagnosticRecords(childProcess),[record]);
 });
 test('private native controls are separate from the preserved product inventory',()=>{
  assert.equal(privateNativeControls.length,24);assert.equal(privateCases.length,84);assert.equal(privateCases.filter(r=>!r.workerOnly).length,75);
  assert.equal(new Set([...privateCases,...privateNativeControls].map(r=>r.id)).size,108);
  for(const p of privateProviders)for(const api of ['stream','simple'])assert.deepEqual(privateNativeControls.filter(r=>r.provider===p&&r.api===api).map(r=>r.control),['eof','preabort','partial','provider_error']);
 });
 test('private client inventory, real shipping compilation and additive row',()=>{const manifests=readdirSync('providers').filter(p=>p.endsWith('.provider.yaml')).sort().map(p=>parse(readFileSync('providers/'+p,'utf8')));assert.ok(manifests.length);assert.deepEqual(manifests.map(p=>p.id).sort(),snapshot.providers.map(p=>p.id).sort());assert.deepEqual(compileProviderSnapshot(manifests),snapshot);
  const rows=parse(readFileSync('.github/workflows/openclaw-contract.yml','utf8')).jobs.consumer.strategy.matrix.include;assert.equal(new Set(rows.map(r=>r.consumer)).size,rows.length);assert.deepEqual(rows.filter(r=>r.consumer==='private-catalogs'),[{consumer:'private-catalogs',ref:privateCatalogPin,test:'test/openclaw-private-catalogs.test.mjs'}]);assert.equal(Object.keys(privateGroups).length,14);assert.equal(new Set(privateCases.map(r=>r.id)).size,privateCases.length);
 });
 test('Private actual Worker binds catalog and inference accounting to original response IDs',{timeout:60000},async()=>{
  const f=await startPrivateCatalogFixture();
  try{for(const provider of privateProviders)for(const scenario of ['eof','provider_error']){
   const row={id:provider+'_accounting_'+scenario,provider,scenario};await f.setup(row);
   const base=f.origin+'/v1/native/'+provider;
   const catalog=await fetch(base+'/models',{headers:{authorization:'Bearer '+privateKey(row.id,'discovery')}});assert.equal(catalog.status,200);await catalog.arrayBuffer();
   const chat=await fetch(base+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+privateKey(row.id),'content-type':'application/json'},body:JSON.stringify({model:'tenant/opaque-a',stream:true,messages:[{role:'user',content:'fixture'}]})});assert.equal(chat.status,200);await chat.arrayBuffer();
   const denied=await fetch(base+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+privateKey(row.id,'inference','invalid-secret'),'content-type':'application/json'},body:JSON.stringify({model:'tenant/opaque-a',stream:true,messages:[]})});assert.equal(denied.status,401);await denied.arrayBuffer();
   const proof=await f.join(row);assert.equal(proof.calls.length,2);assert.equal(proof.requests.length,3);assertPrivateReceipt(row,proof);
   assert.ok(proof.events.some(e=>e.request_id===catalog.headers.get('x-clawrouter-request-id')));
   assert.ok(proof.events.some(e=>e.request_id===chat.headers.get('x-clawrouter-request-id')));
  }}finally{await f.close();}
 });
 test('private original Worker bundles and SDK fixture transforms without execution',async()=>{
  const require=createRequire(import.meta.resolve('wrangler/package.json')),build=require('esbuild').build;
  const bundled=await build({stdin:{contents:router,resolveDir:process.cwd(),sourcefile:'private-client-fixture.ts',loader:'ts'},write:false,bundle:true,external:['node:async_hooks'],format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});assert.ok(bundled.outputFiles[0].text.length);
  await build({stdin:{contents:upstream,sourcefile:'private-upstream.js',loader:'js'},write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  const fixture=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
  assert.ok(stripTypeScriptTypes(fixture,{mode:'strip'}).length);
  await build({stdin:{contents:fixture,sourcefile:'private-sdk.ts',loader:'ts'},write:false,format:'esm',platform:'node',target:'node24',logLevel:'silent'});
 });
 test('private cleanup preserves body, undefined and every original cleanup failure',async()=>{const first={},last={},order=[];await assert.rejects(finishPrivateOwned(()=>{throw first;},[()=>{order.push(1);throw undefined;},()=>{order.push(2);throw last;}]),e=>e instanceof AggregateError&&e.errors[0]===first&&e.errors[1]===undefined&&e.errors[2]===last);assert.deepEqual(order,[1,2]);});
 test('private dynamic original join never treats settled rejection as success',async()=>{const reason={},s={};s.ledger=createPrivateOperationLedger(s);s.ledger.retain('parent',Promise.resolve().then(()=>{s.ledger.retain('undefined',Promise.reject(undefined));s.ledger.retain('other',Promise.reject(reason));}));await assert.rejects(joinPrivateOriginals(s),e=>e instanceof AggregateError&&e.errors[0]===undefined&&e.errors[1]===reason);});
 test('registered private discovery and public inference through Worker SQLite',{skip:!process.env.CLAWROUTER_OPENCLAW_CHECKOUT,timeout:300000},async t=>{let f,workerDiagnosticCount=0;const created=[];
  const all=[...privateNativeControls,...privateCases],emit=privateAnnotationEmitter(line=>process.stdout.write(line));
  await runPrivateReported(async report=>{
   f=await report.observe(null,"setup",startPrivateCatalogFixture,undefined,[]);
   for(const [index,row]of all.entries()){await report.observe(index,"case_setup",f.setup,f,[row]);created.push(row);}
   report.mark(null,"child","enter");report.flush(null);
   await withPrivateNativeDiagnostics(()=>report.observe(null,"child",runOpenClawConsumer,undefined,[t,{source:process.env.CLAWROUTER_OPENCLAW_CHECKOUT,sourceHead:privateCatalogPin,fixture:fileURLToPath(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url)),testPath:'extensions/baseten/clawrouter-private-catalogs-contract.test.ts',privateExec:report.privateExec,env:{CLAWROUTER_CONTRACT_ORIGIN:f.origin,CLAWROUTER_CONTRACT_SOURCE_HEAD:privateCatalogPin,CLAWROUTER_PRIVATE_CATALOG_CASES:JSON.stringify(privateCases),CLAWROUTER_PRIVATE_NATIVE_CONTROLS:JSON.stringify(privateNativeControls)}}]),emit,()=>report.executionContract);
  },[...all.map((row,index)=>async report=>{if(!created.includes(row))return;
   let proof;try{proof=await report.observe(index,"worker_retirement",f.join,f,[row]);}catch(primary){
    reportPrivateJoinFailure(report,row,index,()=>f.evidence(row),saved=>{for(const record of privateWorkerCheckpointRecords(saved,row,index)){if(workerDiagnosticCount>=4)break;workerDiagnosticCount++;emit(record);}},primary);}
   report.mark(index,"assertions","enter");
   const witness=createPrivateReceiptWitness();
   try{assertPrivateReceipt(row,proof,witness);report.mark(index,"assertions","fulfilled");}
   catch(error){reportPrivateReceiptFailure(report,row,index,proof,()=>f.evidence(row),witness,error);}
  }),report=>f?report.observe(null,"cleanup",f.close,f,[]):undefined],emit);
 });
}
