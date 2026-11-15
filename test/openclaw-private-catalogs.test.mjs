import { execFile } from "node:child_process";
import { promisify, types as privateNodeTypes } from "node:util";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
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
 const names=["createPrivateFetchObserver","createPrivateInvocationOwnership","newPrivateInvocationCaller","privateControlCaller","privateInvocationBound","samePrivateDescriptor","privateCancelOperand","privateStoredErrorVector","evaluatePrivateNativeControl","privateQualification","privateProductExpected"];
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
export function privateCheckpointRecords(error){
 const {validatePrivateCheckpoint}=privateCheckpointFunctions();
 return privateChildDiagnosticRecords(error,"PRIVATE_CHECKPOINT ",record=>{validatePrivateCheckpoint(record);assert.equal(record.lane,"sdk");return JSON.stringify(record);});
}
export function privateAnnotationEmitter(write){
 let bytes=0,count=0;
 return record=>{const line="::notice title=Private closed diagnostic::"+JSON.stringify(record)+"\n";
  assert.ok(Buffer.byteLength(line)<=768&&bytes+Buffer.byteLength(line)<=16384&&count<48,"Private annotation quota exceeded");
  bytes+=Buffer.byteLength(line);count++;write(line);};
}
export async function withPrivateNativeDiagnostics(run,emit){
 try{return await run();}catch(error){const reporting=[];
  for(const collect of [privateCheckpointRecords,privateNativeDiagnosticRecords])try{for(const record of collect(error))emit(record);}catch(reportError){reporting.push(reportError);}
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
  const entry={id:requests.length,token,request,credential,retired:false};tokens.set(token,entry);requests.push(entry);owner.ledger.touch();return token;};
 const owns=token=>{const r=tokens.get(token);return !retired&&!!r&&requests.includes(r)&&!r.retired&&r.request===token.request&&token.owner===owner&&token.generation===owner.generation;};
 const current=()=>{const token=context.getStore();if(!owns(token))throw Error('foreign or absent private request context');return token;};
 const transport=(token,secret,method,url)=>{if(!owns(token)||secret!=='Bearer synthetic-private-'+owner.id)throw Error('foreign private transport');
  const t={token,request:token.request,credential:token.credential,secret,method,url,id:transports.length,pending:null,response:null,body:null};transports.push(t);owner.ledger.touch();return t;};
 const response=(t,value,body)=>{if(!transports.includes(t)||!owns(t.token)||t.response!==null||transports.some(x=>x!==t&&(x.response===value||body!==null&&x.body===body)))throw Error('ambiguous private response');
  t.response=value;t.body=body;owner.ledger.touch();};
 const reader=(t,value,body,originals)=>{if(!transports.includes(t)||!owns(t.token)||context.getStore()!==t.token||t.body!==body||t.response===null||readers.some(r=>r.reader===value||r.body===body))throw Error('foreign private reader');
  const r={token:t.token,request:t.request,transport:t,response:t.response,body,reader:value,originals,id:readers.length,unlocks:0,unlockEntry:null,unlockReturn:null,pendingAtUnlock:null,cancels:0,eof:false,closed:null,closedRecord:null};
  readers.push(r);owner.ledger.touch();return r;};
 const bound=(r,method,receiver,fn)=>owns(r.token)&&(context.getStore()===r.token||context.getStore()===undefined&&['cancel','releaseLock'].includes(method))&&readers.includes(r)&&transports.includes(r.transport)&&r.request===r.token.request&&
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
 s.calls.push({method,path:url.pathname,query:!!url.search,bodyAbsent:(init?.body??input.body??null)===null,
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
    return {id:s.id,observation:outcome.observation,diagnostic:privateWorkerOperationFacts(s),retired:outcome.retired,operations:s.ledger.operations.map(o=>({kind:o.kind,state:o.state})),calls:s.calls,source:outcome.source??null,events:outcome.usage?.events??[],charged:bodyBudgetCharged(),timeline:s.timeline,authority:s.authority,inspections:s.inspections,readers:s.readers.map(r=>({unlocks:r.unlocks,eof:r.eof,locked:r.locked}))};})();
   const proof=await s.retirement;if(!s.ownership.validate())throw Error('changed private retirement lifetime');return Response.json(proof,{status:proof.retired?200:500});
  }throw Error('unknown private control');
 }
 const auth=request.headers.get('authorization')??'',matches=[...states.values()].filter(s=>['inference','discovery','alternate'].some(k=>auth.startsWith('Bearer clawrouter-live-'+s.id+'_'+k+'-')));
 if(matches.length!==1)throw Error('unbound caller');const s=matches[0];if(s.retirement)throw Error('late request');
 const credential=['inference','discovery','alternate'].find(k=>auth.startsWith('Bearer clawrouter-live-'+s.id+'_'+k+'-')),token=s.ownership.register(request,credential);
 const context={waitUntil:p=>{observe(s,p,'waitUntil',token);originalContext.waitUntil(p);}};
 const pending=s.ownership.run(token,()=>s.ledger.invoke('handler',worker.fetch,worker,[request,s.env,context],token));
 try{observe(s,pending.then(()=>s.timeline.push({phase:'publication',sequence:++s.sequence})),'publication_observer',token,{originalRead:pending});}catch(error){s.ledger.fault(error);}return pending;
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

export async function startPrivateCatalogFixture(){const directory=await mkdtemp(join(tmpdir(),'private-catalog-client-'));let runtime;
 try{runtime=await startWorkerdFixture(directory,router,upstream,{requestContext:true});}catch(error){await finishPrivateOwned(()=>{throw error;},[()=>rm(directory,{recursive:true,force:true})]);}
 const origin=(await runtime.ready).origin,evidence=new Map();
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
 test('Private actual registration reports synchronous undefined and never confuses return with invocation',()=>{
  const source=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
  const pre=source.slice(source.indexOf('checkpoints.registration("afterAll","enter")'),source.indexOf('function checkpointCase('));
  const suite=source.slice(source.indexOf('checkpoints.registration("describe","enter")'));
  const code=stripTypeScriptTypes(pre+suite,{mode:'strip'});
  for(const fail of ['afterAll','describe','it','none']){const out=[],checkpoints=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',x=>out.push(x));let registrations=0;
   const run=()=>new Function('checkpoints','afterAll','describe','it','providers','groups','throwFailures',code)(checkpoints,()=>{if(fail==='afterAll')throw undefined;}, {sequential(_name,fn){if(fail==='describe')throw undefined;fn();}},()=>{if(fail==='it'&&registrations===9)throw undefined;registrations++;},privateProviders,Object.keys(privateGroups),()=>{});
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
   new Function('checkpoints','describe','it','providers','groups',suite)(r,{sequential(_name,fn){deferred=fn;return Object.freeze({});}},()=>{if(attempts++===3)throw reason;},privateProviders,Object.keys(privateGroups));
   assert.equal(attempts,0);const returned=out.find(x=>x.point==='describe_return');assert.deepEqual([...returned.registration],[0,2,0,0,0,null]);assert.equal(out.some(x=>x.v===2),false);
   assert.throws(()=>deferred(),e=>e===reason);assert.equal(attempts,4);const cap=out.find(x=>x.v===2),entry=out.find(x=>x.point==='registration_failure');
   assert.equal(cap.phase,'registration');assert.equal(cap.defined,reason!==undefined);assert.equal(cap.decl,3);assert.deepEqual([...entry.registration],[0,2,1,4,3,3]);assert.equal(out.some(x=>x.point==='callback'),false);assert.equal(out.some(x=>x.phase==='final'),false);
  }
 });
 // END Private early runner inert regressions
 // BEGIN Private primary and receipt inert regressions
 function receiptFixture(){const row={id:'inert',provider:'baseten',scenario:'stream_abort'},p={id:'inert',retired:true,operations:[{state:'fulfilled'}],readers:[{unlocks:1,locked:false}],charged:0,
  source:{held:0,expired:0,joined:true,pending:0,faults:0,requests:1,canceled:1,settled:1,census:[{producer:true,cancels:1,finished:true,explicitRelease:false}]},
  calls:[{originalKey:true,noCaller:true,redirect:'manual',query:false,method:'GET',bodyAbsent:true}],events:[{provider:'baseten',policy_id:'inert',capability:'models.list',model:null,reserved_cost_micros:0,actual_cost_micros:0}],
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
  new Function('describe','it','providers','groups','controlRows','rows','expect','diagnosticControl','exercise','checkpoints','checkpointCase','callbackDeclarations',code)({sequential(_name,fn){fn();}},(name,fn)=>callbacks.push({name,fn}),providers,groups,[],privateCases,expect,()=>{invoked++;},()=>{invoked++;},checkpoints,()=>0,new WeakMap());
  assert.equal(callbacks.length,66);assert.equal(callbacks.filter(r=>!r.name.startsWith('native diagnostic ')).length,42);await assert.rejects(callbacks[0].fn());await checkpoints.drain();checkpoints.finish();assert.equal(invoked,0);
  const cap=records.find(r=>r.v===2);assert.equal(cap.phase,'selection');assert.equal(cap.decl,0);assert.equal(cap.owner,null);
  const success=[],bindings=new WeakMap(),report=privateCheckpointFunctions().createPrivateCheckpointReporter('sdk',()=>{});
  new Function('describe','it','providers','groups','controlRows','rows','expect','diagnosticControl','exercise','checkpoints','checkpointCase','callbackDeclarations',code)({sequential(_name,fn){fn();}},(name,fn)=>success.push({name,fn}),providers,groups,privateNativeControls,privateCases,expect,row=>{assert.equal(row,privateNativeControls[0]);invoked++;},()=>{invoked++;},report,()=>0,bindings);
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
  assert.equal(f.s.ownership.bound(r,'read',f.reader,r.originals.read),false);
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
 test('Private Worker held original survives observer registration failure until its actual settlement',async()=>{
  const {s}=privateInertOwner();let resolve,attempts=0,finished=false;const p=new Promise(yes=>{resolve=yes;}),then=p.then;
  Object.defineProperty(p,'then',{value:function(...args){if(++attempts===1)throw undefined;return Reflect.apply(then,this,args);}});
  assert.equal(s.ledger.retain('closed',p).pending,p);const joined=s.ledger.drain().then(()=>{finished=true;});
  for(let i=0;i<4;i++)await Promise.resolve();assert.equal(finished,false);resolve();await joined;assert.equal(s.ledger.faults.length,1);assert.equal(s.ledger.faults[0],undefined);
  await assert.rejects(joinPrivateOriginals(s),e=>e===undefined);
 });
 test('Private Worker accounting, public receipt and cleanup gates remain independently strict',async()=>{
  const row={id:'inert',provider:'baseten',scenario:'eof'},receipt={retired:true,operations:[{state:'fulfilled'}],readers:[{unlocks:1,locked:false}],charged:0,
   source:{held:0,expired:0,joined:true,pending:0,faults:0,requests:0},calls:[],events:[{provider:'baseten',policy_id:'inert',capability:'models.list',model:null,reserved_cost_micros:0,actual_cost_micros:0}]};
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
   await withPrivateNativeDiagnostics(()=>report.observe(null,"child",runOpenClawConsumer,undefined,[t,{source:process.env.CLAWROUTER_OPENCLAW_CHECKOUT,sourceHead:privateCatalogPin,fixture:fileURLToPath(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url)),testPath:'extensions/baseten/clawrouter-private-catalogs-contract.test.ts',privateExec:report.privateExec,env:{CLAWROUTER_CONTRACT_ORIGIN:f.origin,CLAWROUTER_CONTRACT_SOURCE_HEAD:privateCatalogPin,CLAWROUTER_PRIVATE_CATALOG_CASES:JSON.stringify(privateCases),CLAWROUTER_PRIVATE_NATIVE_CONTROLS:JSON.stringify(privateNativeControls)}}]),emit);
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
