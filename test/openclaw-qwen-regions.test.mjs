import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { startWorkerdFixture } from "./helpers/workerd.mjs";
import { runOpenClawConsumer, settleRunnerReport } from "./helpers/openclaw-consumer.mjs";
import { parseRunnerReport, runnerContract, validateBinding } from "./helpers/openclaw-runner-reporter.mjs";

const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const fixture = new URL("./fixtures/openclaw-qwen-regions-contract.test.ts", import.meta.url);
const fixtureText = readFileSync(fixture, "utf8");
const transformed = stripTypeScriptTypes(fixtureText);
const shared = transformed.split("// BEGIN shared fixture functions.")[1]?.split("// END shared fixture functions.")[0];
assert.ok(shared, "original fixture functions are present");
// The marker's prose ends before the first function declaration.
const functions = shared.slice(shared.indexOf("function qwenRegionCases"));
const { qwenRegionCases, createQwenLedger, createQwenOwnership, qwenClosedRecord, qwenEntryRecord, createQwenEntryWitness } = new Function(`${functions}; return { qwenRegionCases, createQwenLedger, createQwenOwnership, qwenClosedRecord, qwenEntryRecord, createQwenEntryWitness };`)();
const rows = qwenRegionCases();
const regions = ["qwen-cn", "qwen-coding-global", "qwen-coding-cn"];
const bases = ["https://dashscope.aliyuncs.com/compatible-mode/v1", "https://coding-intl.dashscope.aliyuncs.com/v1", "https://coding.dashscope.aliyuncs.com/v1"];
const key = id => `clawrouter-live-${id}-fixture-secret`;
const credential = (row, rotated = false) => `${row.provider === "qwen-cn" ? "sk-" : "sk-sp-"}synthetic-${rotated ? "rotated-" : ""}${row.id}`;
const paid = row => ["eof", "rotation", "no_usage", "effort_off", "effort_low", "effort_medium", "partial", "provider_error"].includes(row.mode);

async function finish(body, cleanups) {
  const failures = []; let result;
  try { result = await body(); } catch (error) { failures.push(error); }
  for (const cleanup of cleanups) try { await cleanup(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Qwen body and cleanup failed");
  return result;
}

// Raw child failures remain available to this owner, never serialized by the
// test reporter. Only closed fixture records leave this boundary.
const retainedNativeFailures = new WeakMap();

const qwenRunnerFixtureSha256 = "47ef4694ff45c89cac41bcaa1168b6eb26d78cc21a095b9c1999baac2e41a3db";
const qwenRunnerReporterSha256 = "5cd2b7b4ebbe72f1864fd83c695c6ca521e8f382bd2a01e29af83f169f8bc4b3";

// Copy only bounded own data before validation; never invoke toJSON or getters.
function qwenRunnerData(value, depth = 0, budget = { remaining: 8192 }) {
  assert.ok(depth <= 8 && --budget.remaining >= 0, "runner data bound");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { assert.ok(Buffer.byteLength(value) <= 65536); return value; }
  if (typeof value === "number") { assert.ok(Number.isFinite(value)); return value; }
  assert.ok(value && typeof value === "object", "runner own data required");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  assert.ok(keys.every(key => typeof key === "string" && Object.hasOwn(descriptors[key], "value")), "runner accessors forbidden");
  if (Array.isArray(value)) {
    const length = descriptors.length.value;
    assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= 512 && keys.length === length + 1);
    return Array.from({ length }, (_, index) => {
      assert.ok(Object.hasOwn(descriptors, String(index)));
      return qwenRunnerData(descriptors[index].value, depth + 1, budget);
    });
  }
  assert.ok(keys.length <= 16 && !keys.includes("toJSON"));
  return Object.fromEntries(keys.map(key => [key, qwenRunnerData(descriptors[key].value, depth + 1, budget)]));
}

function qwenUnobservedRunner(status) {
  return [
    { kind: "runner_binding", observed: false, pin: sourceHead, target: runnerContract.target,
      fixtureSha256: qwenRunnerFixtureSha256, reporterSha256: qwenRunnerReporterSha256, reportBytes: 0, reportSha256: null },
    { kind: "runner_summary", status, complete: false, phases: [], readyCallbacks: null, resultCallbacks: null,
      reason: "unknown", capturedErrors: 0, serializedErrors: null, reportOmitted: null, errorRecordsOmitted: 0 },
  ];
}

function projectQwenRunnerReport(original) {
  const packet = qwenRunnerData(original);
  if (packet.reporter === "absent") {
    assert.deepEqual(Object.keys(packet).sort(), ["bytes", "complete", "records", "reporter", "sha256"]);
    assert.equal(packet.complete, false); assert.equal(packet.bytes, 0); assert.equal(packet.sha256, null);
    assert.deepEqual(packet.records, []);
    return qwenUnobservedRunner("absent");
  }
  assert.deepEqual(Object.keys(packet).sort(), ["bytes", "complete", "records", "sha256"]);
  assert.ok(Array.isArray(packet.records) && packet.records[0]?.kind === "init");
  const binding = validateBinding(packet.records[0].binding);
  assert.equal(binding.fixtureSha256, qwenRunnerFixtureSha256); assert.equal(binding.reporterSha256, qwenRunnerReporterSha256);
  // The helper already matched the private invocation nonce. Reuse its parser;
  // public records disclose neither that nonce nor any private report location.
  const bytes = Buffer.from(packet.records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const checked = parseRunnerReport(bytes, binding);
  assert.equal(checked.complete, packet.complete); assert.equal(checked.bytes, packet.bytes); assert.equal(checked.sha256, packet.sha256);
  const end = checked.records.find(record => record.kind === "end");
  const callbacks = checked.records.filter(record => record.kind === "case").at(-1);
  const errors = checked.records.filter(record => record.kind === "error");
  const result = [
    { kind: "runner_binding", observed: true, pin: sourceHead, target: runnerContract.target,
      fixtureSha256: qwenRunnerFixtureSha256, reporterSha256: qwenRunnerReporterSha256,
      reportBytes: checked.bytes, reportSha256: checked.sha256 },
    { kind: "runner_summary", status: checked.complete ? "complete" : "partial", complete: checked.complete,
      phases: checked.records.filter(record => record.kind === "phase").map(record => ({ phase: record.phase, count: record.count })),
      readyCallbacks: end?.ready ?? callbacks?.ready ?? 0, resultCallbacks: end?.results ?? callbacks?.results ?? 0,
      reason: end?.reason ?? "unknown", capturedErrors: errors.length, serializedErrors: end?.errors ?? null,
      reportOmitted: end?.omitted ?? null, errorRecordsOmitted: Math.max(0, errors.length - 1) },
  ];
  if (errors.length) {
    const first = errors[0];
    result.push({ kind: "runner_error", surface: first.surface, received: first.error.received, originalPresence: "unknown",
      namePresence: first.error.name.presence, name: first.error.name.value, codePresence: first.error.code.presence, code: first.error.code.value });
  }
  return result;
}

function createQwenFailureRelay() {
  const records = new Map(), sdkCases = new Map();
  let moduleEvaluated = false, registration, runner;
  let runnerReceived = false;
  function runnerReport(packet) {
    assert.equal(runnerReceived, false, "duplicate native runner report"); runnerReceived = true;
    runner = projectQwenRunnerReport(packet);
  }
  const entered = new Map(), completed = new Map();
  const consistent = (terminal, original) => {
    if (terminal && original) for (const key of ["state", "operations", "rejected", "pending"]) {
      assert.equal(terminal[key], original[key], "conflicting terminal census");
    }
  };
  function record(value, sdk = false) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    assert.ok(Reflect.ownKeys(descriptors).every(key => typeof key === "string" && Object.hasOwn(descriptors[key], "value")), "closed data fields required");
    value = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
    assert.deepEqual(Object.keys(value).sort(), ["v", "case", "phase", "op", "state", "operations", "rejected", "pending"].sort());
    assert.equal(value.v, 1);
    if (sdk) assert.notEqual(value.case, "none", "SDK receipt requires an actual case");
    const checked = qwenClosedRecord(value.case, value.phase, value.op, value.state, { operations: value.operations, rejected: value.rejected, pending: value.pending });
    const key = value.case + ":" + value.phase + ":" + value.op;
    const encoded = JSON.stringify(checked);
    if (records.has(key)) assert.equal(records.get(key), encoded, "conflicting closed diagnostic");
    assert.ok(records.has(key) || records.size < 512, "closed diagnostic capacity exceeded");
    records.set(key, encoded);
    if (sdk) {
      if (sdkCases.has(value.case)) assert.equal(sdkCases.get(value.case), encoded, "ambiguous SDK case receipt");
      consistent(completed.get(value.case), checked);
      sdkCases.set(value.case, encoded);
    }
  }
  function entry(value) {
    const checked = qwenEntryRecord(value);
    if (checked.kind === "module_evaluated") {
      assert.equal(moduleEvaluated, false, "duplicate module witness"); moduleEvaluated = true;
    } else {
      assert.equal(moduleEvaluated, true, "missing module witness");
      if (checked.kind === "registration") {
        assert.equal(registration, undefined, "duplicate registration witness"); registration = checked;
      } else {
        assert.ok(registration && checked.index < registration.registered, "case lacks returned registration");
        const target = checked.kind === "case_enter" ? entered : completed;
        if (checked.kind === "case_complete") {
          assert.ok(entered.has(checked.case), "completion lacks entry");
          consistent(checked, sdkCases.has(checked.case) ? JSON.parse(sdkCases.get(checked.case)) : undefined);
        }
        assert.equal(target.has(checked.case), false, "duplicate case witness"); target.set(checked.case, checked);
      }
    }
  }
  function text(value) {
    assert.equal(typeof value, "string");
    assert.ok(Buffer.byteLength(value) <= 2 * 1024 * 1024, "native output bound exceeded");
    for (const line of value.split("\n")) {
      const prefix = ["QWEN_SDK_V1 ", "QWEN_ENTRY_V1 "].find(prefix => line.startsWith(prefix));
      if (!prefix) continue;
      assert.ok(Buffer.byteLength(line) <= 768, "native record bound exceeded");
      const payload = line.slice(prefix.length), parsed = JSON.parse(payload);
      // Our source emits compact JSON. Exact re-encoding rejects duplicate keys,
      // trailing material and alternate encodings without recovering raw text.
      assert.equal(JSON.stringify(parsed), payload, "noncanonical closed JSON");
      if (prefix === "QWEN_ENTRY_V1 ") entry(parsed); else record(parsed, true);
    }
  }
  function error(original) {
    const pending = [original], seen = new Set(); let bytes = 0;
    while (pending.length) {
      const value = pending.pop();
      if (!value || !["object", "function"].includes(typeof value) || seen.has(value)) continue;
      seen.add(value); assert.ok(seen.size <= 64, "native error closure exceeded");
      for (const field of ["stdout", "stderr"]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") continue;
        bytes += Buffer.byteLength(descriptor.value); assert.ok(bytes <= 4 * 1024 * 1024, "native error bytes exceeded");
        text(descriptor.value);
      }
      const cause = Object.getOwnPropertyDescriptor(value, "cause");
      if (cause && "value" in cause) pending.push(cause.value);
      const errors = Object.getOwnPropertyDescriptor(value, "errors");
      if (errors && "value" in errors && Array.isArray(errors.value)) {
        const length = Object.getOwnPropertyDescriptor(errors.value, "length")?.value;
        assert.ok(Number.isSafeInteger(length) && length <= 64, "native aggregate exceeded");
        for (let i = 0; i < length; i++) {
          const item = Object.getOwnPropertyDescriptor(errors.value, String(i));
          if (item && "value" in item) pending.push(item.value);
        }
      }
    }
  }
  function output(helper) {
    const failures = [...records.values()].map(value => JSON.parse(value)).filter(value => value.state !== "passed");
    const observed = [...sdkCases.values()].map(value => JSON.parse(value));
    const firstFailed = [...completed.values()].find(value => value.state === "failed");
    const unfinished = [...entered.values()].find(value => !completed.has(value.case));
    const group = firstFailed ? [entered.get(firstFailed.case), firstFailed] : unfinished ? [unfinished] : [];
    const essential = [{ kind: "entry_summary", pin: sourceHead, moduleEvaluated,
      registrationObserved: !!registration, registered: registration?.registered ?? null,
      registrationComplete: registration?.complete ?? false, registrationFailurePresent: registration?.failurePresent ?? null,
      registrationReasonDefined: registration?.reasonDefined ?? null, enteredCases: entered.size, completedCases: completed.size }, ...group,
    { kind: "helper", pin: sourceHead, state: helper, expectedCases: rows.length, observedCases: observed.length,
      failedCases: observed.filter(value => value.state !== "passed").length, unknownCases: rows.length - observed.length }, ...(runner ?? qwenUnobservedRunner("unobserved"))];
    const room = 9 - essential.length, result = [...essential, ...failures.slice(0, room)];
    if (failures.length > room) result.push({ kind: "overflow", omitted: failures.length - room });
    const commands = result.map(qwenBoundaryAnnotation);
    assert.ok(commands.every(value => Buffer.byteLength(value) <= 768), "escaped annotation bound exceeded");
    assert.ok(Buffer.byteLength(commands.join("\n")) <= 8192, "escaped packet bound exceeded");
    return result;
  }
  const complete = () => moduleEvaluated && registration?.complete === true && entered.size === rows.length && completed.size === rows.length
    && [...completed.values()].every(value => value.state === "passed" && value.rejected === 0 && value.pending === 0)
    && sdkCases.size === rows.length && [...sdkCases.values()].every(value => {
    const row = JSON.parse(value); return row.state === "passed" && row.rejected === 0 && row.pending === 0;
  });
  return { record, entry, text, error, runnerReport, output, complete };
}

function qwenBoundaryAnnotation(record) {
  const informational = ["entry_summary", "case_enter", "runner_binding", "runner_summary"].includes(record.kind);
  const severity = informational || record.state === "passed" ? "notice" : "error";
  const message = JSON.stringify(record).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return `::${severity} title=Qwen native boundary::${message}`;
}

async function withQwenNativeRelay(body, cleanups, emit) {
  const relay = createQwenFailureRelay(), failures = []; let helper = "unrun", phase = "setup";
  const capture = (error, currentPhase) => {
    failures.push(error);
    try { relay.error(error); } catch (reportError) { failures.push(reportError); }
    try { relay.record(qwenClosedRecord("none", currentPhase, "cleanup", "failed", { operations: 0, rejected: 0, pending: 0 })); }
    catch (reportError) { failures.push(reportError); }
  };
  try {
    await body({ record: relay.record, runnerReport: relay.runnerReport, async runChild(run) {
      phase = "helper";
      try { await run({ diagnostic: relay.text }); helper = "passed"; }
      catch (error) { helper = "failed"; throw error; }
    } });
  } catch (error) { capture(error, phase); }
  for (const cleanup of cleanups) {
    try { await cleanup.run(relay.record); } catch (error) { capture(error, cleanup.phase); }
  }
  if (helper === "unrun" && !failures.length || helper === "passed" && !relay.complete()) {
    helper = "incomplete";
    capture(new Error("missing or failed native SDK receipts"), "relay");
  }
  // Original child work, Worker retirement and runtime cleanup have all joined
  // before this bounded relay. Missing records remain unknown, never PASS.
  let output = [];
  try { output = relay.output(helper); } catch (error) { failures.push(error); }
  for (const record of output) {
    try { emit(record); } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    const closed = new AggregateError(failures.map(() => new Error("Qwen owned proof phase failed")), "Qwen native proof failed; inspect closed boundary records");
    retainedNativeFailures.set(closed, failures);
    throw closed;
  }
}

function routerScript() {
  return `
import handler from './worker/index.ts';
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {ingestUsage,usageSnapshot,budgetStatus} from './worker/ledgers.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {sha256Hex} from './worker/utils.ts';
${createQwenLedger.toString()}
const rows=${JSON.stringify(rows)},regions=${JSON.stringify(regions)},states=new Map(),nativeFetch=globalThis.fetch;
const credential=${credential.toString()};
globalThis.fetch=function(input,init){
 const headers=new Headers(init?.headers!==undefined?init.headers:input instanceof Request?input.headers:undefined);
 const secret=headers.get('authorization'),matches=[...states.values()].filter(s=>secret==='Bearer '+credential(s.row)||secret==='Bearer '+credential(s.row,true));
 if(matches.length!==1)throw Error('unbound Qwen upstream request');const s=matches[0];
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 s.calls.push({url,method:init?.method??(input instanceof Request?input.method:'GET'),original:secret==='Bearer '+credential(s.row),rotated:secret==='Bearer '+credential(s.row,true),noCaller:!headers.has('x-api-key')&&!headers.has('api-key')});
 const original=s.ledger.invoke('fetch',nativeFetch,this,[input,init]);
 s.ledger.observe('fetch_observer',original.then(response=>s.ledger.body(response.body)));return original;
};
async function control(s,path){const response=await s.ledger.invoke('control_fetch',nativeFetch,globalThis,['https://control.fixture/'+path+'/'+s.row.id]);return s.ledger.observe('control_body',response.json());}
export default {async fetch(request,env,context){
 const path=new URL(request.url).pathname;
 if(path==='/fixture/setup'){
  if(states.size)throw Error('duplicate Qwen setup');
  const configured={...env,QWEN_API_KEY:'synthetic-poison-global',QWEN_CN_API_KEY:'synthetic-poison-cn',QWEN_CODING_GLOBAL_API_KEY:'synthetic-poison-coding',QWEN_CODING_CN_API_KEY:'synthetic-poison-coding-cn',DASHSCOPE_API_KEY:'synthetic-poison-legacy',QWEN_TOKEN_PLAN_API_KEY:'synthetic-poison-token',QWEN_TOKEN_PLAN_CN_API_KEY:'synthetic-poison-token-cn'};
  await authorityCall(env,'/policies/initialize-all',[]);await authorityCall(env,'/credentials/initialize-all',[]);
  await authorityCall(env,'/connections/initialize-all',regions.map(providerId=>({providerId,enabled:true,monthlyBudgetMicros:10000})));
  for(const row of rows){
   const ledger=createQwenLedger(),s={row,ledger,calls:[],requests:0,status:null,retirement:undefined};
   s.env={...configured,USAGE_QUEUE:{send:event=>ledger.invoke('usage_ingest',ingestUsage,undefined,[env,event])}};
   // The real credential owner rejects empty stored grants. Exercise an empty
   // selected environment binding explicitly, without poisoning another owner.
   const environmentCase=['missing','empty'].includes(row.mode),binding=['QWEN_CN_API_KEY','QWEN_CODING_GLOBAL_API_KEY','QWEN_CODING_CN_API_KEY'][regions.indexOf(row.provider)];
   if(row.mode==='empty')s.env[binding]='';if(row.mode==='missing')delete s.env[binding];
   const policy={enabled:true,generation:'fixture',tenantId:'fixture',providers:[row.mode==='foreign'?'qwen':row.provider],models:[row.provider+'/'+row.model],monthlyBudgetMicros:100,requestCostMicros:row.mode==='unpriced'?null:7,budgetMode:'reserve',retainRequestContent:false,grantRouting:{eligibleGrants:environmentCase?{}:{[row.provider]:[row.provider]},environmentFallback:environmentCase,failover:false}};
   await authorityCall(env,'/policies/put',{policyId:row.id,policy});
   const created=await authorityCall(env,'/credentials/mutate',{credentialId:row.id,scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'},operation:'put',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:row.id,policyGeneration:'fixture'}});
   if(created.outcome!=='updated')throw Error('Qwen credential setup failed');
   for(const foreign of ['qwen','qwen-cn','qwen-coding-global','qwen-coding-cn','qwen-token-plan','qwen-token-plan-cn'].filter(id=>id!==row.provider))await putGrantCredentials(env,'oauth/'+row.id+'/'+foreign,{provider:foreign,kind:'api_key',enabled:true,credential:'sk-sp-synthetic-foreign'});
   let secret=credential(row);
   if(row.mode==='invalid')secret='sk-synthetic-wrong-product';if(row.mode==='raw_c0')secret='\\n'+secret;if(row.mode==='raw_del')secret+='\\x7f';if(row.mode==='whitespace')secret='   ';
   const grant='oauth/'+row.id+'/'+row.provider;
   if(!['missing','empty','missing_grant'].includes(row.mode))await putGrantCredentials(env,grant,{provider:row.provider,kind:'api_key',enabled:true,credential:secret});
   if(row.mode==='rotation')await putGrantCredentials(env,grant,{provider:row.provider,kind:'api_key',enabled:true,credential:credential(row,true)});
   if(row.mode==='revoked')await revokeGrantCredentials(env,grant);
   states.set(row.id,s);
  }
  return Response.json({ready:true});
 }
 if(path.startsWith('/fixture/join/')){
  const s=states.get(path.slice('/fixture/join/'.length));if(!s)throw Error('unknown Qwen fixture');
  if(!s.retirement)s.retirement=(async()=>{
   const failures=[];try{await s.ledger.drain();}catch(error){failures.push(error);}
   let source,usage,budget;try{source=await control(s,'proof');}catch(error){failures.push(error);}
   try{usage=await s.ledger.invoke('usage',usageSnapshot,undefined,[env,'fixture',s.row.id,{kind:'admin'}]);}catch(error){failures.push(error);}
   try{budget=await s.ledger.invoke('budget',budgetStatus,undefined,[env,s.row.id,{tenantId:'fixture',monthlyBudgetMicros:100}]);}catch(error){failures.push(error);}
   try{await s.ledger.drain();}catch(error){failures.push(error);}
   return {retired:failures.length===0,calls:s.calls,source,usage,budget,status:s.status,requests:s.requests,charged:bodyBudgetCharged(),operations:s.ledger.operations.map(o=>({kind:o.kind,state:o.state})),readers:s.ledger.readers.map(r=>({unlocks:r.unlocks,returns:r.returns,locked:r.body.locked}))};
  })();const proof=await s.retirement;return Response.json(proof,{status:proof.retired?200:500});
 }
 const authorization=request.headers.get('authorization'),s=[...states.values()].find(s=>authorization==='Bearer clawrouter-live-'+s.row.id+'-fixture-secret'||authorization==='Bearer clawrouter-live-'+s.row.id+'-invalid');
 if(!s||s.retirement)throw Error('unbound or retired Qwen caller');s.requests++;
 const original=s.ledger.invoke('handler',handler.fetch,handler,[request,s.env,{waitUntil:p=>{s.ledger.observe('waitUntil',p);context.waitUntil(p);}}]);
 s.ledger.observe('handler_observer',original.then(response=>{s.status=response.status;}));return original;
},queue:handler.queue};`;
}

function upstreamScript() {
  return `const rows=${JSON.stringify(rows)},states=new Map(rows.map(row=>[row.id,{row,calls:[],held:0,canceled:0,expired:0,settled:0}]));const credential=${credential.toString()};
export default {async fetch(request){
 const url=new URL(request.url);
 if(url.origin==='https://control.fixture'){
  const s=states.get(url.pathname.split('/')[2]);if(!s)throw Error('unknown source');
  if(s.producer){await s.producer;s.settled=1;}
  return Response.json({calls:s.calls,held:s.held,canceled:s.canceled,expired:s.expired,settled:s.settled});
 }
 const matches=[...states.values()].filter(s=>request.headers.get('authorization')==='Bearer '+credential(s.row)||request.headers.get('authorization')==='Bearer '+credential(s.row,true));
 if(matches.length!==1)throw Error('unbound upstream secret');const s=matches[0],body=await request.json();
 s.calls.push({url:request.url,method:request.method,body,authorization:request.headers.get('authorization'),apiKey:request.headers.get('api-key'),xApiKey:request.headers.get('x-api-key')});
 const frame=value=>'data: '+JSON.stringify(value)+'\\n\\n';
 const chunk=delta=>({id:'chat_fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:null}]});
 if(s.row.mode==='provider_error')return new Response(frame({error:{message:'synthetic provider error',code:'synthetic_error'}}),{headers:{'content-type':'text/event-stream'}});
 const first=frame(chunk({role:'assistant',content:'synthetic-answer'}));
 if(s.row.mode==='partial')return new Response(new ReadableStream({start(c){s.held=1;c.enqueue(new TextEncoder().encode(first));},pull(c){
  if(!s.producer)s.producer=new Promise((resolve,reject)=>{s.resolve=resolve;s.timer=setTimeout(()=>{s.expired++;s.held=0;c.error(Error('source expired'));reject(Error('source expired'));},10000);});return s.producer;
 },cancel(){s.canceled++;clearTimeout(s.timer);s.held=0;s.resolve?.();}}),{headers:{'content-type':'text/event-stream'}});
 const usage=s.row.mode==='no_usage'?{}:{usage:{prompt_tokens:300,completion_tokens:20,total_tokens:320,prompt_tokens_details:{cached_tokens:256}}};
 const wire=first+frame({id:'chat_fixture',model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],...usage})+'data: [DONE]\\n\\n';
 const bytes=new TextEncoder().encode(wire);let at=0;
 return new Response(new ReadableStream({pull(c){if(at===bytes.length)c.close();else{const next=Math.min(at+7,bytes.length);c.enqueue(bytes.slice(at,next));at=next;}}}),{headers:{'content-type':'text/event-stream'}});
}};`;
}

async function startFixture() {
  const directory = await mkdtemp(join(tmpdir(), "qwen-regions-")); let runtime;
  try { runtime = await startWorkerdFixture(directory, routerScript(), upstreamScript()); }
  catch (error) { return finish(() => { throw error; }, [() => rm(directory, { recursive: true, force: true })]); }
  const origin = String(await runtime.ready).replace(/\/$/, "");
  return { runtime, origin, close: () => finish(() => {}, [() => runtime.dispose(), () => rm(directory, { recursive: true, force: true })]) };
}

async function readControl(f, path, report) {
  const response = await fetch(f.origin + path);
  const text = await response.text();
  const proof = JSON.parse(text);
  if (report) {
    const id = path.startsWith("/fixture/join/") ? path.slice("/fixture/join/".length) : "none";
    const operations = Array.isArray(proof.operations) ? proof.operations : [];
    report(qwenClosedRecord(id, id === "none" ? "setup" : "worker", "control", response.status === 200 ? "passed" : "failed", {
      operations: operations.length, rejected: operations.filter(op => op.state === "rejected").length, pending: operations.filter(op => op.state === "pending").length,
    }));
  }
  assert.equal(response.status, 200, path === "/fixture/setup" ? "Worker setup failed" : "original Worker retirement failed");
  return proof;
}

function assertProof(row, proof) {
  assert.equal(proof.retired, true); assert.equal(proof.charged, 0);
  assert.equal(proof.budget.ledger, "durable_object"); assert.equal(proof.budget.limitMicros, 100);
  if (!paid(row)) assert.equal(proof.budget.spentMicros, 0);
  assert.ok(proof.operations.every(o => o.state === "fulfilled"));
  assert.ok(proof.readers.every(r => r.unlocks === 1 && r.returns === 1 && !r.locked));
  assert.equal(proof.source.held, 0); assert.equal(proof.source.expired, 0);
  const calls = proof.source.calls; assert.equal(calls.length, paid(row) ? 1 : 0); assert.equal(proof.calls.length, calls.length);
  if (calls.length) {
    const call = calls[0]; assert.equal(call.method, "POST"); assert.equal(call.url, bases[regions.indexOf(row.provider)] + "/chat/completions");
    assert.equal(call.authorization, "Bearer " + credential(row, row.mode === "rotation"));
    assert.equal(call.apiKey, null); assert.equal(call.xApiKey, null); assert.equal(call.body.model, row.model); assert.equal(call.body.stream, true);
    assert.ok(call.body.messages.some(m => m.role === "tool" && m.tool_call_id === "callfixture"));
    assert.ok(call.body.messages.some(m => m.tool_calls?.[0]?.function?.name === "lookup"));
    if (["qwen3.5-plus", "glm-5"].includes(row.model)) assert.ok(call.body.messages.every(m => m.reasoning_content === undefined));
    else assert.ok(call.body.messages.some(m => m.reasoning_content === "synthetic-prior-thinking"));
    if (row.model.startsWith("qwen3.8-")) assert.equal(call.body.reasoning_effort, row.mode === "effort_off" ? undefined : row.mode === "effort_low" ? "low" : row.mode === "effort_medium" ? "medium" : "xhigh");
    assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|synthetic-poison/);
  }
  if (row.mode === "partial") { assert.equal(proof.source.canceled, 1); assert.equal(proof.source.settled, 1); }
  const events = proof.usage.events;
  if (row.mode === "preabort") { assert.equal(proof.requests, 0); assert.equal(events.length, 0); return; }
  if (row.mode === "invalid_caller") { assert.equal(proof.status, 401); assert.equal(events.length, 0); return; }
  // prepareNativeRequest rejects an unsupported model before selection creates
  // accounting. The closed native row cannot reserve or emit a usage event.
  if (row.mode === "bad_model") { assert.equal(proof.status, 400); assert.equal(events.length, 0); return; }
  assert.equal(events.length, 1, row.id); const event = events[0];
  assert.equal(event.provider, row.provider); assert.equal(event.credential_id, row.id); assert.equal(event.model, row.provider + "/" + row.model);
  if (paid(row)) {
    const rejected = row.mode === "provider_error";
    assert.equal(event.status, row.mode === "partial" ? "client_error" : rejected ? "provider_error" : "success");
    assert.equal(event.actual_cost_micros, rejected ? 0 : 7); assert.equal(event.cost_basis, rejected ? "none" : "policy_fixed");
    assert.equal(proof.budget.spentMicros, rejected ? 0 : 7);
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens],
      ["partial", "provider_error", "no_usage"].includes(row.mode) ? [null, null, null, null] : [300, 20, 320, 256]);
  } else {
    assert.equal(event.actual_cost_micros, 0); assert.equal(event.reserved_cost_micros, 0);
    assert.equal(proof.budget.spentMicros, 0);
    if (["missing", "empty", "missing_grant", "revoked", "invalid", "raw_c0", "raw_del", "whitespace"].includes(row.mode)) assert.equal(proof.status, 503);
  }
}

test("Qwen shipping snapshot covers complete source inventory and exact consumer", () => {
  const manifests = readdirSync("providers").filter(f => f.endsWith(".provider.yaml")).sort().map(f => parse(readFileSync("providers/" + f, "utf8")));
  assert.ok(manifests.length > 0); assert.equal(new Set(manifests.map(m => m.id)).size, manifests.length);
  assert.deepEqual(manifests.map(m => m.id).sort(), snapshot.providers.map(p => p.id).sort());
  assert.deepEqual(compileProviderSnapshot(manifests), snapshot);
  for (const provider of regions) {
    const actual = snapshot.providers.find(p => p.id === provider);
    assert.deepEqual(actual.models.map(m => m.upstream), rows.filter(r => r.provider === provider && r.mode === "eof" && !r.simple).map(r => r.model));
    assert.ok(actual.models.every(m => m.pricing === null));
    assert.deepEqual(actual.endpoints.map(e => e.path), ["/chat/completions"]);
  }
  const matrix = parse(readFileSync(".github/workflows/openclaw-contract.yml", "utf8")).jobs.consumer.strategy.matrix.include;
  assert.equal(new Set(matrix.map(r => r.consumer)).size, matrix.length);
  assert.deepEqual(matrix.filter(r => r.consumer === "qwen-regions"), [{ consumer: "qwen-regions", ref: sourceHead, test: "test/openclaw-qwen-regions.test.mjs" }]);
  assert.ok(fixtureText.includes(sourceHead)); assert.equal(rows.filter(r => r.mode === "eof").length, 44);
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
});

test("actual shared ledger joins work registered during original settlement", async () => {
  const ledger = createQwenLedger(); let release, canceled, finished = false;
  const original = new Promise(resolve => { release = resolve; });
  assert.equal(ledger.observe("closed", original), original);
  const late = new Promise(resolve => { canceled = resolve; });
  ledger.observe("attachment", original.then(() => { ledger.observe("cancel", late); }));
  const joined = ledger.drain().then(() => { finished = true; });
  release(); await original; await Promise.resolve(); assert.equal(finished, false);
  canceled(); await joined; assert.equal(finished, true);
});
test("actual shared ledger preserves original receiver, promise, undefined and independent failures", async () => {
  const ledger = createQwenLedger(), receiver = {}, secondary = {};
  const original = Promise.reject(undefined);
  assert.equal(ledger.invoke("read", function (value) { assert.equal(this, receiver); assert.equal(value, 7); return original; }, receiver, [7]), original);
  ledger.observe("cancel", Promise.reject(secondary));
  let threw = false; try { ledger.invoke("release", () => { throw undefined; }, null, []); } catch (error) { threw = true; assert.equal(error, undefined); }
  assert.equal(threw, true);
  await assert.rejects(ledger.drain(), error => error instanceof AggregateError && error.errors.length === 3 && error.errors.includes(secondary) && error.errors.filter(e => e === undefined).length === 2);
});
test("actual shared ledger requires original reader unlock and restores observers", async () => {
  const ledger = createQwenLedger(), body = new ReadableStream({ start(c) { c.close(); } }), original = body.getReader;
  ledger.body(body); const reader = body.getReader(); await reader.read();
  await assert.rejects(ledger.drain()); reader.releaseLock(); await ledger.drain(); ledger.restore(); assert.equal(body.getReader, original);
});
test("cleanup retains body failure and attempts both independent finalizers", async () => {
  const order = [], second = {};
  await assert.rejects(finish(() => { throw undefined; }, [() => { order.push(1); throw second; }, () => { order.push(2); }]), error => error instanceof AggregateError && error.errors[0] === undefined && error.errors[1] === second);
  assert.deepEqual(order, [1, 2]);
});

function ownershipFixture() {
  const ledger = createQwenLedger(), storage = new AsyncLocalStorage();
  const expected = { url: "https://qwen.fixture/chat/completions", credential: "synthetic-fixture" };
  const owner = createQwenOwnership(storage, ledger, expected);
  const consume = async result => {
    const reader = result.response.body.getReader();
    while (!(await reader.read()).done) {}
    reader.releaseLock(); await result.release();
  };
  const close = () => { ledger.restore(); owner.restore(); };
  return { ledger, storage, expected, owner, consume, close };
}

test("Qwen invocation ownership preserves concurrent async ancestry, arguments and original promises with reused signals", async () => {
  const f = ownershipFixture(), receiver = {}, fetchReceiver = {}, caller = Object.freeze({}), signal = new AbortController().signal;
  const options = { method: "POST", headers: { authorization: "Bearer " + f.expected.credential }, signal: new AbortController().signal };
  const invocations = [], nativePromises = [], guardPromises = [];
  const native = f.owner.wrapFetch(function (...args) {
    assert.equal(this, fetchReceiver); assert.deepEqual(args, [f.expected.url, options, "extra"]);
    const pending = Promise.resolve(new Response("original-body")); nativePromises.push(pending); return pending;
  });
  function guard(input, extra) {
    assert.equal(this, receiver); assert.equal(input, options); assert.equal(extra, "guard-extra");
    const pending = native.call(fetchReceiver, f.expected.url, options, "extra");
    assert.equal(pending, nativePromises.at(-1));
    const result = pending.then(response => ({ response, release: () => Promise.resolve() })); guardPromises.push(result); return result;
  }
  function publicCall(model, context, args) {
    assert.equal(this, receiver); assert.equal(model, "model"); assert.equal(context, "context"); assert.equal(args.signal, signal);
    const pending = Promise.resolve().then(() => {
      const guarded = f.owner.guard(guard, receiver, [options, "guard-extra"]);
      assert.equal(guarded, guardPromises.at(-1)); return guarded;
    });
    invocations.push(pending); return pending;
  }
  try {
    const a = f.owner.invoke(publicCall, receiver, ["model", "context", { signal }], caller);
    const b = f.owner.invoke(publicCall, receiver, ["model", "context", { signal }], caller);
    assert.equal(a, invocations[0]); assert.equal(b, invocations[1]);
    await Promise.all((await Promise.all([a, b])).map(f.consume));
    await f.ledger.drain(); f.owner.verify(2, 2);
    const acquired = [...f.owner.acquisitions];
    assert.notEqual(acquired[0].invocation, acquired[1].invocation);
    assert.ok(acquired.every(a => Object.isFrozen(a.invocation) && Object.isFrozen(a.invocation.args)));
    assert.notEqual([...f.owner.fetches][0].response, [...f.owner.fetches][1].response);
  } finally { f.close(); }
});

for (const fault of ["missing", "detached", "foreign_url", "foreign_key", "foreign_method", "second_fetch"]) {
  test(`Qwen invocation ownership fails closed for ${fault} without replacing original work`, async () => {
    const f = ownershipFixture(); let calls = 0, original;
    const options = { method: fault === "foreign_method" ? "GET" : "POST", headers: { authorization: "Bearer " + (fault === "foreign_key" ? "foreign" : f.expected.credential) } };
    const native = f.owner.wrapFetch(function (...args) {
      calls++; assert.equal(args[1], options);
      original = Promise.resolve(new Response("original")); return original;
    });
    const fetchOnce = () => {
      const pending = native(fault === "foreign_url" ? "https://foreign.fixture/chat/completions" : f.expected.url, options);
      assert.equal(pending, original); return pending;
    };
    const guard = async () => {
      if (fault === "second_fetch") { const extra = await fetchOnce(); await f.consume({ response: extra, release: () => Promise.resolve() }); }
      return { response: await fetchOnce(), release: () => Promise.resolve() };
    };
    try {
      const call = () => fault === "missing" ? guard() : f.owner.guard(guard, undefined, [options]);
      const result = await (fault === "missing" ? call() : f.owner.invoke(() => fault === "detached" ? f.storage.exit(call) : call(), undefined, [], {}));
      await f.consume(result);
      await assert.rejects(f.ledger.drain()); assert.throws(() => f.owner.verify(1));
      assert.equal(calls, fault === "second_fetch" ? 2 : 1);
    } finally { f.close(); }
  });
}

test("Qwen invocation ownership rejects ambiguous Response attachment and preserves synchronous undefined", async () => {
  const f = ownershipFixture(), response = new Response("one"), options = { method: "POST", headers: { authorization: "Bearer " + f.expected.credential } };
  const native = f.owner.wrapFetch(() => Promise.resolve(response));
  const guard = () => native(f.expected.url, options).then(response => ({ response, release: () => Promise.resolve() }));
  try {
    const first = await f.owner.invoke(() => f.owner.guard(guard, undefined, [options]), undefined, [], {});
    await f.consume(first);
    const second = await f.owner.invoke(() => f.owner.guard(guard, undefined, [options]), undefined, [], {});
    await second.release();
    await assert.rejects(f.ledger.drain()); assert.throws(() => f.owner.verify(2, 2));
  } finally { f.close(); }
  for (const boundary of ["public", "guard", "fetch"]) {
    const g = ownershipFixture(); let caught = false;
    const original = () => { throw undefined; };
    try {
      if (boundary === "public") g.owner.invoke(original, undefined, [], {});
      else if (boundary === "guard") g.owner.invoke(() => g.owner.guard(original, undefined, [{}]), undefined, [], {});
      else g.owner.invoke(() => g.owner.guard(() => g.owner.wrapFetch(original)(g.expected.url, options), undefined, [{}]), undefined, [], {});
    } catch (error) { caught = true; assert.equal(error, undefined); }
    assert.equal(caught, true);
    if (boundary !== "public") await assert.rejects(g.ledger.drain(), error => error.errors.includes(undefined));
    g.close();
  }
});

const closedSDKLine = row => "QWEN_SDK_V1 " + JSON.stringify(row) + "\n";
const closedSDKRecord = (id, state = "passed") => qwenClosedRecord(id, "join", "read", state, { operations: 4, rejected: state === "failed" ? 1 : 0, pending: 0 });

test("Qwen failure relay retains setup undefined and joins every cleanup before emission", async () => {
  const events = [], cleanupFailure = {}, output = []; let release;
  const held = new Promise(resolve => { release = resolve; });
  const pending = withQwenNativeRelay(() => { throw undefined; }, [
    { phase: "worker", run: async () => { events.push("worker"); await held; throw cleanupFailure; } },
    { phase: "restore", run: () => { events.push("restore"); } },
  ], record => { events.push("emit"); output.push(record); });
  await Promise.resolve(); assert.deepEqual(events, ["worker"]); assert.deepEqual(output, []);
  release();
  await assert.rejects(pending, error => {
    assert.deepEqual(retainedNativeFailures.get(error), [undefined, cleanupFailure]);
    assert.ok(!Object.hasOwn(error, "cause") && !Object.hasOwn(error, "stdout")); return true;
  });
  assert.equal(events[1], "restore"); assert.equal(output.find(value => value.kind === "helper").state, "unrun");
  assert.ok(output.some(row => row.phase === "setup") && output.some(row => row.phase === "worker"));
});

test("Qwen failure relay captures child failure and cleanup aggregates without getters or raw text", async () => {
  let getters = 0;
  const child = { stdout: "private child prose\n" + closedSDKLine(closedSDKRecord(rows[0].id, "failed")) }, cleanup = {};
  Object.defineProperty(cleanup, "stderr", { get() { getters++; throw Error("never read"); } });
  const original = new AggregateError([child, cleanup], "private child error"); original.cause = original;
  const emitted = [];
  await assert.rejects(withQwenNativeRelay(relay => relay.runChild(() => { throw original; }), [], value => emitted.push(value)), error => retainedNativeFailures.get(error)[0] === original);
  assert.equal(getters, 0); assert.equal(emitted.find(value => value.kind === "helper").state, "failed"); assert.equal(emitted.find(value => value.kind === "helper").observedCases, 1);
  assert.ok(emitted.some(row => row.case === rows[0].id)); assert.doesNotMatch(JSON.stringify(emitted), /private child|stdout|stderr/);
});

test("Qwen failure relay requires complete receipts, prioritizes entry groups and bounds overflow", async () => {
  const absent = [];
  await assert.rejects(withQwenNativeRelay(() => {}, [], () => {}));
  await assert.rejects(withQwenNativeRelay(relay => relay.runChild(() => {}), [], row => absent.push(row)));
  assert.equal(absent[1].state, "incomplete"); assert.equal(absent[1].unknownCases, rows.length);
  const relay = createQwenFailureRelay();
  for (const row of rows.slice(0, 12)) relay.text(closedSDKLine(closedSDKRecord(row.id, "failed")));
  const output = relay.output("failed"); assert.equal(output[0].kind, "entry_summary"); assert.equal(output[1].kind, "helper"); assert.equal(output.length, 10);
  assert.deepEqual(output[9], { kind: "overflow", omitted: 7 });
  const success = [];
  await withQwenNativeRelay(relay => relay.runChild(sink => {
    const witness = createQwenEntryWitness(value => sink.diagnostic(closedEntryLine(value)));
    witness.moduleEvaluated(); rows.forEach(row => witness.registered(row.id)); witness.registrationComplete();
    for (const row of rows) { witness.enter(row.id).complete({ operations: 4, rejected: 0, pending: 0 }); sink.diagnostic(closedSDKLine(closedSDKRecord(row.id))); }
  }), [], row => success.push(row));
  assert.equal(success.length, 4); assert.equal(success[1].state, "passed"); assert.equal(success[1].unknownCases, 0);
  assert.equal(success[0].enteredCases, 103); assert.equal(success[0].completedCases, 103);
  assert.ok(success.every(value => qwenBoundaryAnnotation(value).startsWith("::notice title=Qwen native boundary::")));
});

test("Qwen failure relay rejects malformed, foreign, conflicting and oversized records", () => {
  const sample = closedSDKRecord(rows[0].id);
  for (const patch of [{ case: "foreign" }, { case: "none" }, { phase: "private prose" }, { op: "unknown" }, { state: "maybe" }, { pending: -1 }, { extra: "private" }]) {
    assert.throws(() => createQwenFailureRelay().text(closedSDKLine({ ...sample, ...patch })));
  }
  assert.throws(() => createQwenFailureRelay().text("QWEN_SDK_V1 {"));
  assert.throws(() => createQwenFailureRelay().text("x".repeat(2 * 1024 * 1024 + 1)));
  const relay = createQwenFailureRelay(); relay.text(closedSDKLine(sample));
  assert.throws(() => relay.text(closedSDKLine({ ...sample, rejected: 1 })));
  assert.throws(() => createQwenFailureRelay().error(new AggregateError(Array.from({ length: 65 }, () => ({})), "bounded")));
});

test("Qwen failure relay capacity errors cannot prevent independent cleanup", async () => {
  const cleaned = [], emitted = [];
  await assert.rejects(withQwenNativeRelay(relay => {
    for (const row of rows) for (const phase of ["setup", "caller", "join", "restore", "worker", "helper"]) {
      relay.record({ ...closedSDKRecord(row.id, "failed"), phase });
    }
  }, [{ phase: "worker", run: () => { cleaned.push("worker"); throw undefined; } },
    { phase: "restore", run: () => { cleaned.push("restore"); } }], row => emitted.push(row)), error => retainedNativeFailures.get(error).includes(undefined));
  assert.deepEqual(cleaned, ["worker", "restore"]); assert.equal(emitted.length, 10);
  assert.deepEqual(emitted.at(-1), { kind: "overflow", omitted: 507 });
});

test("Qwen failure relay parses real failed control response before its strict status assertion", async t => {
  const row = rows[0], records = [];
  t.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({ retired: false, operations: [{ kind: "read", state: "rejected" }] }, { status: 500 })));
  await assert.rejects(readControl({ origin: "https://qwen.fixture" }, "/fixture/join/" + row.id, value => records.push(value)));
  assert.equal(records.length, 1); assert.equal(records[0].case, row.id); assert.equal(records[0].rejected, 1); assert.equal(records[0].state, "failed");
});

const closedEntryLine = value => "QWEN_ENTRY_V1 " + JSON.stringify(value) + "\n";
const emptyCensus = { operations: 0, rejected: 0, pending: 0 };
function entryHarness() {
  const relay = createQwenFailureRelay(), emitted = [];
  const witness = createQwenEntryWitness(value => { emitted.push(value); relay.text(closedEntryLine(value)); });
  return { relay, witness, emitted, register() { rows.forEach(row => witness.registered(row.id)); witness.registrationComplete(); } };
}

test("Qwen entry witnesses distinguish no marker, module only, partial registration and entered without completion", () => {
  const absent = createQwenFailureRelay().output("failed")[0];
  assert.equal(absent.moduleEvaluated, false); assert.equal(absent.registered, null); assert.equal(absent.completedCases, 0);
  const partial = entryHarness(); partial.witness.moduleEvaluated();
  let summary = partial.relay.output("failed")[0];
  assert.equal(summary.moduleEvaluated, true); assert.equal(summary.registrationObserved, false);
  partial.witness.registered(rows[0].id);
  assert.throws(() => partial.witness.registrationComplete({ reason: undefined }), error => error === undefined);
  summary = partial.relay.output("failed")[0];
  assert.equal(summary.registered, 1); assert.equal(summary.registrationComplete, false);
  assert.equal(summary.registrationFailurePresent, true); assert.equal(summary.registrationReasonDefined, false);
  const entered = entryHarness(); entered.witness.moduleEvaluated(); entered.register(); entered.witness.enter(rows[0].id);
  const output = entered.relay.output("failed");
  assert.equal(output[0].enteredCases, 1); assert.equal(output[0].completedCases, 0);
  assert.equal(output[1].kind, "case_enter"); assert.equal(entered.relay.complete(), false);
});

test("Qwen entry witnesses preserve first undefined setup failure and original promise identity through held cleanup", async () => {
  const h = entryHarness(); h.witness.moduleEvaluated(); h.register();
  const current = h.witness.enter(rows[0].id), ledger = createQwenLedger();
  current.at("normalize"); current.failed(undefined); current.at("owned_drain");
  let release; const held = new Promise(resolve => { release = resolve; });
  ledger.observe("release", held);
  const originalDrain = ledger.drain(); assert.equal(current.observe("owned_drain", originalDrain), originalDrain);
  let settled = false; const final = originalDrain.then(() => { settled = true; current.complete({ operations: 1, rejected: 0, pending: 0 }); });
  await Promise.resolve(); assert.equal(settled, false); assert.equal(h.relay.output("failed")[0].completedCases, 0);
  release(); await final;
  const packet = h.relay.output("failed"), complete = packet.find(value => value.kind === "case_complete");
  assert.equal(complete.stage, "normalize"); assert.equal(complete.failurePresent, true); assert.equal(complete.reasonDefined, false);
  assert.equal(packet[1].kind, "case_enter"); assert.equal(packet[2], complete); assert.equal(packet[3].kind, "helper");
});

test("Qwen entry witnesses distinguish original history rejection from state cleanup rejection without replacing promises", async () => {
  for (const innerFails of [false, true]) {
    const h = entryHarness(); h.witness.moduleEvaluated(); h.register(); const current = h.witness.enter(rows[0].id);
    const failure = {}, inner = innerFails ? Promise.reject(failure) : Promise.resolve([]);
    assert.equal(current.observe("history_sanitize", inner), inner);
    const outer = inner.then(() => { throw undefined; });
    assert.equal(current.observe("history_state", outer), outer);
    await assert.rejects(outer, reason => innerFails ? reason === failure : reason === undefined);
    current.at("restore_mocks"); current.failed(new Error("later synthetic failure")); current.complete(emptyCensus);
    const complete = h.relay.output("failed").find(value => value.kind === "case_complete");
    assert.equal(complete.stage, innerFails ? "history_sanitize" : "history_state");
    assert.equal(complete.reasonDefined, innerFails);
  }
});

test("Qwen entry reporting failure preserves primary and undefined observer errors", () => {
  const primary = {}, witness = createQwenEntryWitness(() => { throw undefined; }); witness.moduleEvaluated();
  assert.throws(() => witness.registrationComplete({ reason: primary }), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [primary, undefined, undefined]); return true;
  });
  const h = entryHarness(); h.witness.moduleEvaluated(); h.register();
  const current = h.witness.enter(rows[0].id); current.at("caller"); current.failed(primary); current.complete(emptyCensus);
  const original = {}, emitted = [];
  // Actual outer relay must retain an emitting failure after its original child failure.
  return assert.rejects(withQwenNativeRelay(relay => relay.runChild(() => { throw original; }), [], value => {
    emitted.push(value); throw undefined;
  }), error => retainedNativeFailures.get(error)[0] === original && retainedNativeFailures.get(error).slice(1).every(value => value === undefined));
});

test("Qwen entry relay rejects missing groups, duplicate or foreign identities, wrong pin and accessors without getters", () => {
  const h = entryHarness(); h.witness.moduleEvaluated(); h.register(); h.witness.enter(rows[0].id).complete(emptyCensus);
  const [module, registration, enter, complete] = h.emitted;
  for (const item of [registration, enter, complete]) assert.throws(() => createQwenFailureRelay().entry(item));
  assert.throws(() => h.relay.entry(module)); assert.throws(() => h.relay.entry(enter)); assert.throws(() => h.relay.entry(complete));
  for (const patch of [{ pin: "foreign" }, { case: rows[1].id }, { index: -1 }, { extra: true }, { stage: "unknown" }, { failurePresent: true }]) {
    assert.throws(() => qwenEntryRecord({ ...complete, ...patch }));
  }
  let getters = 0; const hostile = { ...complete }; Object.defineProperty(hostile, "stage", { get() { getters++; throw undefined; } });
  assert.throws(() => qwenEntryRecord(hostile)); assert.equal(getters, 0);
  const dup = JSON.stringify(module).replace('"v":1', '"v":1,"v":1');
  assert.throws(() => createQwenFailureRelay().text("QWEN_ENTRY_V1 " + dup));
  assert.throws(() => createQwenFailureRelay().text('QWEN_ENTRY_V1 {"kind":"module_evaluated"}'));
  assert.throws(() => createQwenFailureRelay().text("QWEN_ENTRY_V1 " + " ".repeat(769)));
  const prefixed = createQwenFailureRelay(); prefixed.text("not a boundary " + closedEntryLine(module));
  assert.equal(prefixed.output("failed")[0].moduleEvaluated, false);
});

test("Qwen entry relay keeps the complete first observed failure group before bounded overflow", () => {
  const h = entryHarness(); h.witness.moduleEvaluated(); h.register();
  for (const row of rows.slice(0, 12)) {
    const current = h.witness.enter(row.id); current.at("loader"); current.failed(undefined); current.complete({ operations: 4, rejected: 1, pending: 0 });
    h.relay.text(closedSDKLine(closedSDKRecord(row.id, "failed")));
  }
  const packet = h.relay.output("failed");
  assert.equal(packet.length, 10); assert.equal(packet[1].case, rows[0].id); assert.equal(packet[2].case, rows[0].id);
  assert.equal(packet[2].kind, "case_complete"); assert.equal(packet[3].kind, "helper");
  assert.deepEqual(packet[9], { kind: "overflow", omitted: 9 });
  assert.ok(packet.every(value => Buffer.byteLength(JSON.stringify(value)) <= 768));
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 8192);
  for (const [index, record] of packet.entries()) {
    const annotation = qwenBoundaryAnnotation(record), prefix = index < 2 || ["runner_binding", "runner_summary"].includes(record.kind) ? "::notice" : "::error";
    assert.ok(annotation.startsWith(prefix + " title=Qwen native boundary::"));
    assert.deepEqual(JSON.parse(annotation.slice(annotation.indexOf("::", 2) + 2)), record);
  }
});

// Pure projection inputs go through the actual landed parser, never a native run.
function qwenRunnerPacket(mode = "complete", mutate = () => {}) {
  const binding = { ...runnerContract, fixtureSha256: qwenRunnerFixtureSha256, reporterSha256: qwenRunnerReporterSha256, nonce: "a".repeat(64) };
  const records = [{ kind: "init", seq: 0, binding }];
  const add = record => records.push({ ...record, seq: records.length });
  if (mode !== "partial") {
    for (const phase of ["run_start", "module_queued", "module_collected", "module_start", "module_end"]) add({ kind: "phase", phase, count: 1 });
    add({ kind: "error", surface: "collection", error: { received: "undefined", originalPresence: "unknown",
      name: { presence: "absent", value: "unknown" }, code: { presence: "defined", value: "ERR_MODULE_NOT_FOUND" } } });
    add({ kind: "end", reason: "failed", ready: 0, results: 0, errors: 1, omitted: 0, complete: true });
  }
  mutate(records);
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
  return parseRunnerReport(bytes, binding);
}

test("Qwen runner projection distinguishes absent, bound partial and complete failed reports", () => {
  const absent = projectQwenRunnerReport({ complete: false, records: [], bytes: 0, sha256: null, reporter: "absent" });
  assert.equal(absent[0].observed, false); assert.equal(absent[1].readyCallbacks, null); assert.equal(absent[1].status, "absent");
  const partial = projectQwenRunnerReport(qwenRunnerPacket("partial"));
  assert.equal(partial[0].observed, true); assert.equal(partial[1].complete, false); assert.equal(partial[1].reason, "unknown");
  const complete = projectQwenRunnerReport(qwenRunnerPacket());
  assert.equal(complete[1].complete, true); assert.equal(complete[1].reason, "failed");
  assert.equal(complete[2].received, "undefined"); assert.equal(complete[2].originalPresence, "unknown");
  assert.equal(complete[2].code, "ERR_MODULE_NOT_FOUND");
  const encoded = JSON.stringify(complete);
  assert.doesNotMatch(encoded, /nonce|aaaaaaaaaaaaaaaa|plan.json|report.jsonl|stdout|stack/);
  const relay = createQwenFailureRelay(); relay.runnerReport(qwenRunnerPacket());
  assert.equal(relay.complete(), false); assert.equal(relay.output("failed").find(row => row.kind === "helper").unknownCases, 103);
});

test("Qwen runner projection rejects foreign provenance, duplicate calls, malformed data and getters", () => {
  for (const mutate of [packet => { packet.extra = true; }, packet => { packet.sha256 = "0".repeat(64); },
    packet => { packet.bytes++; }, packet => { packet.complete = false; },
    packet => { packet.records[0].binding.pin = "0".repeat(40); },
    packet => { packet.records[0].binding.target = "extensions/other/worker-contract.test.ts"; },
    packet => { packet.records[0].binding.fixtureSha256 = "0".repeat(64); },
    packet => { packet.records[0].binding.reporterSha256 = "0".repeat(64); },
    packet => { packet.records[0].binding.nonce = "bad"; }, packet => { packet.records[1].phase = "private"; },
    packet => { packet.records[6].error.originalPresence = "defined"; },
    packet => { packet.records[6].error.message = "synthetic-private-marker"; }]) {
    const packet = qwenRunnerPacket(); mutate(packet); assert.throws(() => projectQwenRunnerReport(packet));
  }
  assert.throws(() => projectQwenRunnerReport(undefined));
  assert.throws(() => projectQwenRunnerReport({ complete: false, records: [{}], bytes: 0, sha256: null, reporter: "absent" }));
  let getters = 0;
  for (const key of ["records", "sha256", "toJSON"]) {
    const packet = qwenRunnerPacket(); Object.defineProperty(packet, key, { get() { getters++; throw undefined; } });
    assert.throws(() => projectQwenRunnerReport(packet));
  }
  const nested = qwenRunnerPacket(); Object.defineProperty(nested.records[0].binding, "nonce", { get() { getters++; throw undefined; } });
  assert.throws(() => projectQwenRunnerReport(nested)); assert.equal(getters, 0);
  const relay = createQwenFailureRelay(); relay.runnerReport(qwenRunnerPacket());
  assert.throws(() => relay.runnerReport(qwenRunnerPacket()), /duplicate/);
});

test("Qwen runner quota preserves first case pair, helper and complete runner group before optional failures", () => {
  const packet = qwenRunnerPacket("complete", records => {
    const error = records[6];
    records.splice(7, 0, { ...error, error: { ...error.error, received: "object", code: { presence: "defined", value: "ERR_PACKAGE_PATH_NOT_EXPORTED" } } });
    records.forEach((record, seq) => { record.seq = seq; });
    Object.assign(records.at(-1), { ready: 1_000_000, results: 1_000_000, errors: 1_000_000, omitted: 1_000_000, complete: false });
  });
  const h = entryHarness(); h.witness.moduleEvaluated(); h.register(); h.relay.runnerReport(packet);
  for (const row of rows.slice(0, 12)) {
    const current = h.witness.enter(row.id); current.at("loader"); current.failed(undefined); current.complete({ operations: 4, rejected: 1, pending: 0 });
    h.relay.text(closedSDKLine(closedSDKRecord(row.id, "failed")));
  }
  const output = h.relay.output("failed");
  assert.deepEqual(output.slice(0, 7).map(row => row.kind), ["entry_summary", "case_enter", "case_complete", "helper", "runner_binding", "runner_summary", "runner_error"]);
  assert.equal(output[1].case, output[2].case); assert.equal(output[5].errorRecordsOmitted, 1);
  assert.equal(output[5].reportOmitted, 1_000_000); assert.equal(output[5].complete, false);
  assert.deepEqual(output.at(-1), { kind: "overflow", omitted: 10 });
  const commands = output.map(qwenBoundaryAnnotation);
  assert.ok(commands.every(command => Buffer.byteLength(command) <= 768));
  assert.ok(Buffer.byteLength(commands.join("\n")) <= 8192);
  assert.match(qwenBoundaryAnnotation({ kind: "probe", value: "%\r\n" }), /%25\\r\\n/);
  // The command prefix and escaped percent bytes count, not just the JSON body.
  const wide = { kind: "probe", value: "%".repeat(250) };
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) < 768);
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(wide)) > 768);
});

test("Qwen runner report wiring preserves undefined child, report, Worker and restore failures after original joins", async () => {
  const events = [], emitted = [], cleanupError = {}, workerError = {}, restoreError = {};
  let release; const original = new Promise((_, reject) => { release = () => reject(undefined); });
  const pending = withQwenNativeRelay(relay => relay.runChild(sink => {
    assert.equal(typeof sink.diagnostic, "function"); assert.equal(typeof relay.runnerReport, "function");
    return settleRunnerReport(() => original, () => { events.push("collect"); return qwenRunnerPacket(); },
      () => { events.push("report_cleanup"); throw cleanupError; }, packet => {
        relay.runnerReport(packet); events.push("report"); throw undefined;
      });
  }), [{ phase: "worker", run: () => { events.push("worker"); throw workerError; } },
    { phase: "restore", run: () => { events.push("restore"); throw restoreError; } }], record => emitted.push(record));
  await Promise.resolve(); assert.deepEqual(events, []); assert.deepEqual(emitted, []);
  release();
  await assert.rejects(pending, error => {
    const failures = retainedNativeFailures.get(error);
    assert.deepEqual(failures[0].errors, [undefined, cleanupError, undefined]);
    assert.equal(failures[1], workerError); assert.equal(failures[2], restoreError); return true;
  });
  assert.deepEqual(events, ["collect", "report_cleanup", "report", "worker", "restore"]);
  assert.ok(emitted.some(record => record.kind === "runner_error"));
  assert.equal(emitted.find(record => record.kind === "helper").state, "failed");
  assert.equal(emitted.find(record => record.kind === "helper").unknownCases, 103);
});

test("Qwen runner envelope construction failure cannot replace the original child outcome", async t => {
  const originalLength = Buffer.byteLength, primary = {}, events = [];
  t.mock.method(Buffer, "byteLength", function (value, ...args) {
    if (typeof value === "string" && value.startsWith("::")) throw undefined;
    return Reflect.apply(originalLength, this, [value, ...args]);
  });
  await assert.rejects(withQwenNativeRelay(relay => relay.runChild(() => { throw primary; }),
    [{ phase: "restore", run: () => { events.push("restored"); } }], () => { events.push("emitted"); }), error => {
    assert.deepEqual(retainedNativeFailures.get(error), [primary, undefined]); return true;
  });
  assert.deepEqual(events, ["restored"]);
});

test("Qwen fixture syntax bundles SDK and Worker observer routes without executing them", async () => {
  const require = createRequire(import.meta.url), tooling = createRequire(require.resolve("wrangler/package.json"));
  const { build } = tooling("esbuild");
  const sdk = await build({ stdin: { contents: fixtureText, sourcefile: "qwen-contract.ts", loader: "ts" }, bundle: true, external: ["*"], platform: "node", format: "esm", write: false, logLevel: "silent" });
  assert.equal(sdk.errors.length, 0); assert.ok(sdk.outputFiles[0].contents.length > 0);
  for (const contents of [routerScript(), upstreamScript()]) {
    const result = await build({ stdin: { contents, resolveDir: new URL("..", import.meta.url).pathname, sourcefile: "qwen-worker.mjs", loader: "js" }, bundle: true, external: ["cloudflare:*", "node:*"], platform: "browser", format: "esm", write: false, logLevel: "silent" });
    assert.equal(result.errors.length, 0); assert.ok(result.outputFiles[0].contents.length > 0);
  }
});

test("registered Qwen regional SDK through shipping Worker and SQLite", { skip: !process.env.CLAWROUTER_OPENCLAW_CHECKOUT, timeout: 300_000 }, async t => {
  let f;
  await withQwenNativeRelay(async relay => {
    f = await startFixture();
    await readControl(f, "/fixture/setup", relay.record);
    await relay.runChild(sink => runOpenClawConsumer(sink, { source: process.env.CLAWROUTER_OPENCLAW_CHECKOUT, sourceHead, fixture, testPath: "extensions/qwen/worker-regions-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: f.origin, CLAWROUTER_SDK_SOURCE_HEAD: sourceHead, QWEN_API_KEY: "synthetic-poison-client" },
      runnerReport: { expectedInvocations: 1, fixtureSha256: qwenRunnerFixtureSha256, reporterSha256: qwenRunnerReporterSha256, onReport: relay.runnerReport } }));
  }, [{ phase: "worker", run: async report => {
    if (!f) return;
    const failures = [];
    for (const row of rows) try { assertProof(row, await readControl(f, "/fixture/join/" + row.id, report)); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Qwen Worker cases and retirement failed");
  } }, { phase: "restore", run: () => f?.close() }], record => console.log(qwenBoundaryAnnotation(record)));
});

test("shipping regional Worker reaches each original origin and joins positive metadata-free streams", { timeout: 60_000 }, async () => {
  const f = await startFixture(); const selected = regions.map(provider => rows.find(r => r.provider === provider && r.mode === "eof" && !r.simple));
  await finish(async () => {
    await readControl(f, "/fixture/setup");
    for (const row of selected) {
      const response = await fetch(f.origin + "/v1/native/" + row.provider + "/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key(row.id), "content-type": "application/json" },
        body: JSON.stringify({ model: row.model, stream: true, max_tokens: 128, messages: [
          { role: "assistant", content: "", ...(row.model === "qwen3.5-plus" ? {} : { reasoning_content: "synthetic-prior-thinking" }), tool_calls: [{ id: "callfixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "callfixture", content: "synthetic-tool-result" }, { role: "user", content: "synthetic request" },
        ] }),
      });
      assert.equal(response.status, 200); assert.match(await response.text(), /synthetic-answer/);
    }
  }, [async () => {
    const failures = [];
    for (const row of selected) try { assertProof(row, await readControl(f, "/fixture/join/" + row.id)); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "positive Worker retirement failed");
  }, () => f.close()]);
});

test("shipping regional Worker rejects missing, empty, foreign and invalid selected credentials before egress", { timeout: 60_000 }, async () => {
  const modes = ["missing", "empty", "missing_grant", "foreign", "revoked", "unpriced", "invalid_caller", "bad_model", "invalid", "raw_c0", "raw_del", "whitespace"];
  const selected = rows.filter(row => modes.includes(row.mode)), f = await startFixture();
  await finish(async () => {
    await readControl(f, "/fixture/setup");
    for (const row of selected) {
      const response = await fetch(f.origin + "/v1/native/" + row.provider + "/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + (row.mode === "invalid_caller" ? `clawrouter-live-${row.id}-invalid` : key(row.id)), "content-type": "application/json" },
        body: JSON.stringify({ model: row.model, stream: true, messages: [{ role: "user", content: "synthetic denial" }] }),
      });
      const body = await response.json(); assert.equal(response.ok, false, row.id);
      if (["missing", "empty"].includes(row.mode)) {
        assert.equal(response.status, 503); assert.equal(body.error.code, "provider_not_configured");
      }
      if (["invalid", "raw_c0", "raw_del", "whitespace"].includes(row.mode)) {
        assert.equal(response.status, 503); assert.equal(body.error.code, "provider_credentials_invalid");
      }
      if (row.mode === "missing_grant") { assert.equal(response.status, 503); assert.equal(body.error.code, "upstream_grant_pool_unavailable"); }
      assert.doesNotMatch(JSON.stringify(body), /synthetic-poison|sk-sp-synthetic|fixture-secret/);
    }
  }, [async () => {
    const failures = [];
    for (const row of selected) try { assertProof(row, await readControl(f, "/fixture/join/" + row.id)); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "denial Worker retirement failed");
  }, () => f.close()]);
});

export { routerScript, upstreamScript, qwenRegionCases, createQwenLedger, startFixture, readControl, assertProof };
