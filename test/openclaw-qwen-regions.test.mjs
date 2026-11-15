import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { types as utilTypes } from "node:util";
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
const { qwenRegionCases, createQwenLedger, createQwenOwnership, qwenClosedRecord, qwenEntryRecord, qwenObserverRecord, createQwenEntryWitness } = new Function(`${functions}; return { qwenRegionCases, createQwenLedger, createQwenOwnership, qwenClosedRecord, qwenEntryRecord, qwenObserverRecord, createQwenEntryWitness };`)();
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

const qwenRunnerFixtureSha256 = "4fef30f7ef737571a4cd71ad90e79063eab3489217a5a9eb17b36bc09c57603a";
const qwenRunnerReporterSha256 = "5cd2b7b4ebbe72f1864fd83c695c6ca521e8f382bd2a01e29af83f169f8bc4b3";

// Copy only bounded own data before validation; never invoke toJSON or getters.
function qwenRunnerData(value, depth = 0, budget = { remaining: 8192 }) {
  assert.ok(depth <= 8 && --budget.remaining >= 0, "runner data bound");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { assert.ok(Buffer.byteLength(value) <= 65536); return value; }
  if (typeof value === "number") { assert.ok(Number.isFinite(value)); return value; }
  assert.ok(value && typeof value === "object", "runner own data required");
  assert.equal(utilTypes.isProxy(value), false, "runner proxies forbidden");
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

function qwenRelayStatus(value) {
  assert.ok(value && typeof value === "object" && !utilTypes.isProxy(value));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = ["kind", "diagnosticText", "stdoutErrorField", "stderrErrorField", "errorTraversal", "parsing", "failureStage", "failurePresent", "reasonDefined"];
  assert.deepEqual(Reflect.ownKeys(descriptors).sort(), fields.sort());
  assert.ok(Object.values(descriptors).every(field => Object.hasOwn(field, "value")));
  const row = Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
  assert.equal(row.kind, "relay_status");
  assert.ok(["unobserved", "observed"].includes(row.diagnosticText));
  for (const key of ["stdoutErrorField", "stderrErrorField"]) assert.ok(["unknown", "absent", "present"].includes(row[key]));
  for (const key of ["errorTraversal", "parsing"]) assert.ok(["unobserved", "complete", "failed"].includes(row[key]));
  assert.ok(["none", "text_type", "text_bound", "line_bound", "json_decode", "canonical_json", "record_schema", "module_required", "registration_required", "entry_required", "terminal_census", "duplicate", "error_object", "capture_descriptor", "capture_type", "closure_bound", "closure_descriptor"].includes(row.failureStage));
  assert.equal(typeof row.failurePresent, "boolean"); assert.equal(typeof row.reasonDefined, "boolean");
  assert.equal(row.failureStage === "none", !row.failurePresent);
  assert.ok(row.failurePresent || !row.reasonDefined);
  if (row.errorTraversal !== "complete") {
    assert.notEqual(row.stdoutErrorField, "absent"); assert.notEqual(row.stderrErrorField, "absent");
  }
  return row;
}

function createQwenFailureRelay() {
  const records = new Map(), sdkCases = new Map(), observerFailures = new Map();
  let diagnosticText = false, traversed = false, traversalFailed = false, parsed = false, parseFailed = false;
  const captures = { stdout: false, stderr: false };
  let stage = "none", firstFailure;
  const observe = fn => {
    try { return fn(); } catch (error) { firstFailure ??= { stage, reasonDefined: error !== undefined }; throw error; }
  };
  const status = () => qwenRelayStatus({ kind: "relay_status", diagnosticText: diagnosticText ? "observed" : "unobserved",
    stdoutErrorField: captures.stdout ? "present" : traversed && !traversalFailed ? "absent" : "unknown",
    stderrErrorField: captures.stderr ? "present" : traversed && !traversalFailed ? "absent" : "unknown",
    errorTraversal: !traversed ? "unobserved" : traversalFailed ? "failed" : "complete",
    parsing: !parsed ? "unobserved" : parseFailed ? "failed" : "complete",
    failureStage: firstFailure?.stage ?? "none", failurePresent: !!firstFailure, reasonDefined: firstFailure?.reasonDefined ?? false });
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
    stage = "record_schema";
    assert.ok(value && typeof value === "object" && !utilTypes.isProxy(value));
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
  function observerFailure(value) {
    stage = "record_schema";
    assert.ok(value && typeof value === "object" && !utilTypes.isProxy(value));
    const checked = qwenObserverRecord(value);
    stage = "entry_required"; assert.ok(entered.has(checked.case), "observer lacks case entry");
    stage = "terminal_census";
    const original = sdkCases.has(checked.case) ? JSON.parse(sdkCases.get(checked.case)) : undefined;
    assert.ok(original && original.state === "failed" && original.rejected > 0 && checked.observer <= original.operations,
      "observer lacks SDK failure census");
    const encoded = JSON.stringify(checked);
    stage = "duplicate";
    if (observerFailures.has(checked.case)) assert.equal(observerFailures.get(checked.case), encoded, "conflicting observer witness");
    observerFailures.set(checked.case, encoded);
  }
  function entry(value) {
    stage = "record_schema";
    assert.ok(value && typeof value === "object" && !utilTypes.isProxy(value));
    const checked = qwenEntryRecord(value);
    if (checked.kind === "module_evaluated") {
      stage = "duplicate";
      assert.equal(moduleEvaluated, false, "duplicate module witness"); moduleEvaluated = true;
    } else {
      stage = "module_required";
      assert.equal(moduleEvaluated, true, "missing module witness");
      if (checked.kind === "registration") {
        stage = "duplicate";
        assert.equal(registration, undefined, "duplicate registration witness"); registration = checked;
      } else {
        stage = "registration_required";
        assert.ok(registration && checked.index < registration.registered, "case lacks returned registration");
        const target = checked.kind === "case_enter" ? entered : completed;
        if (checked.kind === "case_complete") {
          stage = "entry_required";
          assert.ok(entered.has(checked.case), "completion lacks entry");
          stage = "terminal_census";
          consistent(checked, sdkCases.has(checked.case) ? JSON.parse(sdkCases.get(checked.case)) : undefined);
        }
        stage = "duplicate";
        assert.equal(target.has(checked.case), false, "duplicate case witness"); target.set(checked.case, checked);
      }
    }
  }
  function parseText(value) {
    parsed = true;
    try { return observe(() => {
      stage = "text_type";
      assert.equal(typeof value, "string");
      stage = "text_bound";
      assert.ok(Buffer.byteLength(value) <= 2 * 1024 * 1024, "native output bound exceeded");
      for (const line of value.split("\n")) {
        const prefix = ["QWEN_SDK_V1 ", "QWEN_ENTRY_V1 ", "QWEN_OBSERVER_V1 "].find(prefix => line.startsWith(prefix));
        if (!prefix) continue;
        stage = "line_bound";
        assert.ok(Buffer.byteLength(line) <= 768, "native record bound exceeded");
        stage = "json_decode";
        const payload = line.slice(prefix.length), parsed = JSON.parse(payload);
        // Our source emits compact JSON. Exact re-encoding rejects duplicate keys,
        // trailing material and alternate encodings without recovering raw text.
        stage = "canonical_json";
        assert.equal(JSON.stringify(parsed), payload, "noncanonical closed JSON");
        if (prefix === "QWEN_ENTRY_V1 ") entry(parsed);
        else if (prefix === "QWEN_OBSERVER_V1 ") observerFailure(parsed);
        else record(parsed, true);
      }
    }); } catch (error) { parseFailed = true; throw error; }
  }
  function text(value) { diagnosticText = true; return parseText(value); }
  function error(original) {
    traversed = true;
    try { return observe(() => {
      const pending = [original], seen = new Set(); let bytes = 0;
      while (pending.length) {
        const value = pending.pop();
        if (!value || !["object", "function"].includes(typeof value) || seen.has(value)) continue;
        stage = "error_object";
        assert.equal(utilTypes.isProxy(value), false, "proxy error capture forbidden");
        stage = "closure_bound";
        seen.add(value); assert.ok(seen.size <= 64, "native error closure exceeded");
        for (const field of ["stdout", "stderr"]) {
          stage = "capture_descriptor";
          const descriptor = Object.getOwnPropertyDescriptor(value, field);
          if (!descriptor) continue;
          assert.ok(Object.hasOwn(descriptor, "value"), "capture accessors forbidden");
          stage = "capture_type";
          assert.equal(typeof descriptor.value, "string", "capture string required");
          captures[field] = true;
          stage = "text_bound";
          bytes += Buffer.byteLength(descriptor.value); assert.ok(bytes <= 4 * 1024 * 1024, "native error bytes exceeded");
          parseText(descriptor.value);
        }
        stage = "closure_descriptor";
        const cause = Object.getOwnPropertyDescriptor(value, "cause");
        if (cause) { assert.ok(Object.hasOwn(cause, "value"), "cause accessor forbidden"); pending.push(cause.value); }
        const errors = Object.getOwnPropertyDescriptor(value, "errors");
        if (errors) assert.ok(Object.hasOwn(errors, "value"), "errors accessor forbidden");
        if (errors && errors.value && typeof errors.value === "object") assert.equal(utilTypes.isProxy(errors.value), false, "proxy errors forbidden");
        if (errors) {
          assert.ok(Array.isArray(errors.value), "aggregate array required");
          stage = "closure_bound";
          const length = Object.getOwnPropertyDescriptor(errors.value, "length")?.value;
          assert.ok(Number.isSafeInteger(length) && length <= 64, "native aggregate exceeded");
          for (let i = 0; i < length; i++) {
            stage = "closure_descriptor";
            const item = Object.getOwnPropertyDescriptor(errors.value, String(i));
            assert.ok(item && Object.hasOwn(item, "value"), "aggregate own data required"); pending.push(item.value);
          }
        }
      }
    }); } catch (error) { traversalFailed = true; throw error; }
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
      failedCases: observed.filter(value => value.state !== "passed").length, unknownCases: rows.length - observed.length }, ...(runner ?? qwenUnobservedRunner("unobserved")), status()];
    // Reserve the witness for the same first failed case atomically with entry,
    // completion and helper/runner summaries. Absence conveys no local proof.
    if (firstFailed && observerFailures.has(firstFailed.case)) essential.push(JSON.parse(observerFailures.get(firstFailed.case)));
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
  const informational = ["entry_summary", "case_enter", "runner_binding", "runner_summary", "relay_status"].includes(record.kind);
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

// The credential selects a case; only the original ingress call establishes
// asynchronous request ancestry. Owned cleanup tails outlive public admission.
function createQwenRequestOwnership(storage) {
  const owners = new WeakMap(), retired = new WeakSet();
  function current() {
    const owner = storage.getStore();
    if (!owner || owners.get(owner.state) !== owner || retired.has(owner.state) || owner.generation !== owner.state.ledger.generation) throw new Error("unbound Qwen request ancestry");
    return owner;
  }
  function invoke(state, request, original, receiver, args) {
    if (state.retirement || owners.has(state) || retired.has(state) || args[0] !== request) throw new Error("duplicate or retired Qwen request owner");
    const owner = Object.freeze({ state, request, generation: state.ledger.generation, original, receiver, args });
    owners.set(state, owner);
    return storage.run(owner, () => state.ledger.invoke("handler", original, receiver, args, owner));
  }
  return { current, invoke, retire(state) { retired.add(state); } };
}

function routerScript() {
  return `
import handler from './worker/index.ts';
import {AsyncLocalStorage} from 'node:async_hooks';
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {ingestUsage,usageSnapshot,budgetStatus} from './worker/ledgers.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {sha256Hex} from './worker/utils.ts';
${createQwenLedger.toString()}
${createQwenRequestOwnership.toString()}
const requestOwnership=createQwenRequestOwnership(new AsyncLocalStorage());
const rows=${JSON.stringify(rows)},regions=${JSON.stringify(regions)},states=new Map(),nativeFetch=globalThis.fetch;
const credential=${credential.toString()};
globalThis.fetch=function(input,init){
 const headers=new Headers(init?.headers!==undefined?init.headers:input instanceof Request?input.headers:undefined);
 const owner=requestOwnership.current(),s=owner.state,secret=headers.get('authorization');
 if(secret!=='Bearer '+credential(s.row)&&secret!=='Bearer '+credential(s.row,true))throw Error('foreign Qwen upstream credential');
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 s.calls.push({url,method:init?.method??(input instanceof Request?input.method:'GET'),original:secret==='Bearer '+credential(s.row),rotated:secret==='Bearer '+credential(s.row,true),noCaller:!headers.has('x-api-key')&&!headers.has('api-key')});
 const receipt={owner,original:nativeFetch,receiver:this,args:[input,init],pending:undefined,response:undefined};
 const original=s.ledger.invoke('fetch',nativeFetch,this,receipt.args,receipt);receipt.pending=original;
 s.ledger.follow('fetch_observer',original,[response=>{receipt.response=response;s.ledger.response(response,receipt);}]);return original;
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
   try{s.ledger.restore();}catch(error){failures.push(error);}
   try{await s.ledger.drain();}catch(error){failures.push(error);}
   try{s.ledger.seal();}catch(error){failures.push(error);}
   requestOwnership.retire(s);
   return {retired:failures.length===0,calls:s.calls,source,usage,budget,status:s.status,requests:s.requests,charged:bodyBudgetCharged(),operations:s.ledger.operations.map(o=>({kind:o.kind,state:o.state})),readers:s.ledger.readers.map(r=>({unlocks:r.unlocks,returns:r.returns,locked:r.body.locked}))};
  })();const proof=await s.retirement;return Response.json(proof,{status:proof.retired?200:500});
 }
 const authorization=request.headers.get('authorization'),s=[...states.values()].find(s=>authorization==='Bearer clawrouter-live-'+s.row.id+'-fixture-secret'||authorization==='Bearer clawrouter-live-'+s.row.id+'-invalid');
 if(!s||s.retirement)throw Error('unbound or retired Qwen caller');s.requests++;
 const original=requestOwnership.invoke(s,request,handler.fetch,handler,[request,s.env,{waitUntil:p=>{s.ledger.observe('waitUntil',p);context.waitUntil(p);}}]);
 s.ledger.follow('handler_observer',original,[response=>{s.status=response.status;}]);return original;
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
  try { runtime = await startWorkerdFixture(directory, routerScript(), upstreamScript(), { requestContext: true }); }
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

// BEGIN Qwen observer failure witness pure tests.
function qwenWitnessFixture(fault, reason, reportFailure) {
  const ledger = createQwenLedger();
  let context, resolve, reject, subscriptions = 0, calls = 0;
  const storage = { disable() { context = undefined; }, getStore: () => context, run(value, fn) { const prior = context; context = value; try { return fn(); } finally { context = prior; } } };
  const expected = { url: "https://qwen.fixture/chat/completions", credential: "synthetic-fixture" };
  class WitnessMap extends WeakMap {
    has(key) { if (fault === "alias_throw") throw reason; return fault === "alias_true" || super.has(key); }
    set(key, value) { if (fault === "map_set") throw reason; return super.set(key, value); }
  }
  // Only the map seam is inert; execute the complete actual ownership helper.
  const factory = new Function("WeakMap", `return (${createQwenOwnership.toString()});`)(WitnessMap);
  const owner = factory(storage, ledger, expected), response = { body: null }, receiver = {};
  const options = { method: "POST", headers: { authorization: "Bearer " + expected.credential } };
  const parent = new Promise((yes, no) => { resolve = yes; reject = no; });
  const then = parent.then;
  parent.then = function (...args) { subscriptions++; return Reflect.apply(then, this, args); };
  const fetch = owner.wrapFetch(function (...args) {
    calls++; assert.equal(this, receiver); assert.equal(args.length, 3);
    assert.equal(args[0], expected.url); assert.equal(args[1], options); assert.equal(args[2], undefined);
    return parent;
  });
  let returned;
  const invokeFetch = () => { returned = fetch.call(receiver, expected.url, options, undefined); return returned; };
  const guard = () => invokeFetch().then(response => ({ response, release: () => Promise.resolve() }));
  const result = owner.invoke(() => fault === "missing_receipt" ? invokeFetch() : owner.guard(guard, receiver, [options]), receiver, [], {});
  assert.equal(returned, parent);
  const receipt = [...owner.fetches][0];
  if (fault === "response") ledger.response = () => { throw reason; };
  if (fault === "prior_get") Object.defineProperty(receipt, "response", { get() { throw reason; } });
  if (fault === "prior_true") receipt.response = response;
  if (fault === "response_set") Object.defineProperty(receipt, "response", { get: () => undefined, set() { throw reason; } });
  if (reportFailure) ledger.captureObserverFailure = () => { throw reportFailure.reason; };
  return { ledger, owner, parent, response, result, resolve, reject, calls: () => calls, subscriptions: () => subscriptions };
}

for (const [fault, site, seen, truthy] of [["response", 1, 0, 0], ["prior_get", 2, 1, 0], ["alias_throw", 3, 3, 0],
  ["missing_receipt", 4, 1, 1], ["prior_true", 4, 3, 2], ["alias_true", 4, 7, 4], ["response_set", 5, 7, 0], ["map_set", 6, 7, 0]]) {
  for (const defined of [false, true]) test(`Qwen observer witness retains ${fault} original reason defined=${defined}`, async () => {
    const reason = defined ? {} : undefined, f = qwenWitnessFixture(fault, reason);
    f.resolve(f.response); await f.result;
    await assert.rejects(f.ledger.drain());
    const row = f.ledger.observerRecord(rows[0].id), original = f.ledger.operations.find(row => row.kind === "fetch_observer");
    assert.equal(row.site, site); assert.equal(row.seen, seen); assert.equal(row.truthy, truthy);
    assert.equal(row.parentState, "fulfilled"); assert.equal(row.failurePresent, true);
    assert.equal(row.reasonDefined, ["missing_receipt", "prior_true", "alias_true"].includes(fault) || defined);
    if (!["missing_receipt", "prior_true", "alias_true"].includes(fault)) assert.equal(original.reason, reason);
    assert.equal(f.ledger.operations[row.parent - 1].pending, f.parent);
    assert.equal(f.ledger.operations[row.observer - 1], original);
    assert.equal(f.calls(), 1); assert.equal(f.subscriptions(), fault === "missing_receipt" ? 3 : 4);
    assert.equal(row.receipt, fault !== "missing_receipt"); assert.equal(row.acquisition, fault !== "missing_receipt");
    f.ledger.restore(); f.owner.restore();
  });
}

test("Qwen original fetch rejection cannot masquerade as observer callback failure", async () => {
  const reason = {}, f = qwenWitnessFixture("none", reason);
  f.reject(reason); await assert.rejects(f.result, error => error === reason);
  await assert.rejects(f.ledger.drain());
  assert.equal(f.ledger.observerRecord(rows[0].id), null);
  assert.equal(f.ledger.operations.find(row => row.kind === "fetch").reason, reason);
  assert.equal(f.ledger.operations.find(row => row.kind === "fetch_observer").state, "fulfilled");
  f.ledger.restore(); f.owner.restore();
});

for (const reason of [undefined, {}]) for (const reportReason of [undefined, {}]) {
  test("Qwen observer recording faults preserve both independent reasons", async () => {
    const f = qwenWitnessFixture("response", reason, { reason: reportReason });
    f.resolve(f.response); await f.result;
    await assert.rejects(f.ledger.drain());
    assert.equal(f.ledger.operations.find(row => row.kind === "fetch_observer").reason, reason);
    const faults = f.ledger.failures().recording; assert.equal(faults.length, 1); assert.equal(faults[0], reportReason);
    assert.equal(f.ledger.observerRecord(rows[0].id), null);
    f.ledger.restore(); f.owner.restore();
  });
}

test("Qwen observer failure still joins appended held work without another parent subscription", async () => {
  const f = qwenWitnessFixture("response", undefined); let release, done = false;
  const held = new Promise(resolve => { release = resolve; });
  f.ledger.response = () => { f.ledger.observe("late", held); throw undefined; };
  f.resolve(f.response); await f.result;
  const joined = f.ledger.drain().catch(error => { done = true; return error; });
  await Promise.resolve(); assert.equal(done, false); release(); await joined;
  assert.equal(f.subscriptions(), 4); assert.equal(f.ledger.observerRecord(rows[0].id).reasonDefined, false);
  f.ledger.restore(); f.owner.restore();
});

test("Qwen observer codec rejects impossible short-circuit and foreign records", async () => {
  const f = qwenWitnessFixture("response", undefined); f.resolve(f.response); await f.result; await assert.rejects(f.ledger.drain());
  const row = f.ledger.observerRecord(rows[0].id);
  for (const patch of [{ case: "foreign" }, { parent: true }, { parent: row.observer }, { observer: 65536 }, { v: 2 },
    { site: 0 }, { site: 7 }, { site: 4, seen: 3, truthy: 2, reasonDefined: false }, { seen: 1 }, { truthy: 1 }, { receipt: false, site: 5, seen: 7 },
    { acquisition: false }, { reasonDefined: null }, { failurePresent: false }, { parentState: "unknown" }, { raw: "forbidden" }]) {
    assert.throws(() => qwenObserverRecord({ ...row, ...patch }));
  }
  assert.throws(() => qwenObserverRecord(Object.fromEntries(Object.entries(row).reverse())));
  for (const parentState of ["pending", "fulfilled", "rejected"]) assert.equal(qwenObserverRecord({ ...row, parentState }).parentState, parentState);
  assert.throws(() => qwenClosedRecord(row.case, "observer_failure", "fetch_observer", "failed", { operations: 1, rejected: 1, pending: 0 }));
  f.ledger.restore(); f.owner.restore();
});

test("Qwen actual observer producer survives bounded relay with its first failed case", async () => {
  const f = qwenWitnessFixture("response", undefined); f.resolve(f.response); await f.result; await assert.rejects(f.ledger.drain());
  const relay = createQwenFailureRelay(), witness = createQwenEntryWitness(value => relay.text("QWEN_ENTRY_V1 " + JSON.stringify(value) + "\n"));
  witness.moduleEvaluated(); for (const row of rows) witness.registered(row.id); witness.registrationComplete();
  const active = witness.enter(rows[0].id), failures = f.ledger.operations.filter(row => row.state === "rejected");
  const counts = { operations: f.ledger.operations.length, rejected: failures.length, pending: 0 };
  active.at("owned_drain"); active.failed(new AggregateError([undefined]));
  relay.text("QWEN_SDK_V1 " + JSON.stringify(qwenClosedRecord(rows[0].id, "join", "fetch_observer", "failed", counts)) + "\n");
  const record = f.ledger.observerRecord(rows[0].id), line = "QWEN_OBSERVER_V1 " + JSON.stringify(record) + "\n";
  relay.text(line); active.complete(counts);
  for (const row of rows.slice(1)) relay.record(qwenClosedRecord(row.id, "worker", "control", "failed", counts));
  const output = relay.output("failed"), projected = output.find(row => row.kind === "observer_failure");
  assert.deepEqual(projected, record); assert.equal(projected.reasonDefined, false);
  assert.ok(output.some(row => row.kind === "case_complete" && row.reasonDefined));
  assert.ok(output.some(row => row.kind === "overflow")); assert.equal(output.length, 10);
  const commands = output.map(qwenBoundaryAnnotation); assert.ok(commands.every(line => Buffer.byteLength(line) <= 768));
  const widest = qwenObserverRecord({ ...record, case: rows.reduce((a, b) => a.id.length > b.id.length ? a : b).id, parent: 65534, observer: 65535 });
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(widest)) <= 768);
  assert.ok(Buffer.byteLength(commands.join("\n")) <= 8192);
  const foreign = createQwenFailureRelay(); assert.throws(() => foreign.text(line));
  assert.throws(() => relay.text("QWEN_OBSERVER_V1 " + JSON.stringify({ ...record, reasonDefined: true }) + "\n"));
  f.ledger.restore(); f.owner.restore();
});
// END Qwen observer failure witness pure tests.

// BEGIN Qwen observer ownership pure tests.
function qwenDeferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function qwenInertReader() {
  const closed = Promise.resolve(), read = Promise.resolve({ done: true }), cancel = Promise.resolve();
  const calls = [], reader = { closed, read(...args) { calls.push(["read", this, args]); return read; }, cancel(...args) { calls.push(["cancel", this, args]); return cancel; }, releaseLock(...args) { calls.push(["unlock", this, args]); body.locked = false; } };
  const body = { locked: false, cancel() { return Promise.resolve(); }, getReader(...args) { calls.push(["reader", this, args]); body.locked = true; return reader; } };
  return { body, reader, calls, closed, read, cancel };
}
test("Qwen drains share a fixed point and never resubscribe settled originals", async () => {
  const ledger = createQwenLedger(), held = qwenDeferred(); let subscriptions = 0, finished = false;
  const nativeThen = held.promise.then;
  held.promise.then = function (...args) { subscriptions++; return Reflect.apply(nativeThen, this, args); };
  assert.equal(ledger.observe("read", held.promise), held.promise); assert.equal(subscriptions, 1);
  const first = ledger.drain(); assert.equal(ledger.drain(), first);
  first.then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); assert.equal(subscriptions, 2);
  held.resolve(); await first; await ledger.drain(); assert.equal(subscriptions, 2);
  ledger.restore(); await ledger.drain(); const sealed = ledger.seal();
  assert.ok(Object.isFrozen(sealed)); assert.ok(Object.isFrozen(sealed.operations[0]));
  assert.throws(() => ledger.seal()); assert.throws(() => ledger.observe("late", Promise.resolve()));
});
test("Qwen joins the already attached observer derivative before retirement", async () => {
  const ledger = createQwenLedger(), held = qwenDeferred(); let subscriptions = 0, settled = false;
  const original = { then(yes) { subscriptions++; yes(); return subscriptions === 1 ? held.promise : Promise.resolve(); } };
  assert.equal(ledger.observe("read", original), original);
  const joined = ledger.drain().then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false);
  held.resolve(); await joined; assert.equal(subscriptions, 2);
  assert.equal(ledger.observers[0].state, "fulfilled");
});
test("Qwen appends original and observer tails to the same in-flight join", async () => {
  const ledger = createQwenLedger(), first = qwenDeferred(), late = qwenDeferred(); let done = false;
  ledger.observe("first", first.promise);
  ledger.follow("attachment", first.promise, [() => ledger.observe("late", late.promise)]);
  const joined = ledger.drain().then(() => { done = true; }); first.resolve();
  await Promise.resolve(); await Promise.resolve(); assert.equal(done, false);
  late.resolve(); await joined; assert.ok(ledger.operations.every(row => row.state === "fulfilled"));
});
test("Qwen cross-ledger owned tails settle without cursor resets", async () => {
  const a = createQwenLedger(), b = createQwenLedger(), first = qwenDeferred(), tail = qwenDeferred();
  a.observe("original", first.promise);
  a.follow("append", first.promise, [() => b.observe("owned-tail", tail.promise)]);
  const joined = Promise.all([a.drain(), b.drain()]); first.resolve();
  await Promise.resolve(); tail.resolve(); await joined; await Promise.all([a.drain(), b.drain()]);
  assert.equal(b.operations.length, 1); assert.equal(b.operations[0].state, "fulfilled");
});
for (const stage of ["then_getter", "species", "terminal_registration"]) {
  test(`Qwen ${stage} failure cannot skip a separately held original`, async () => {
    const ledger = createQwenLedger(), held = qwenDeferred(); ledger.observe("held", held.promise);
    let source;
    if (stage === "then_getter") source = Object.defineProperty({}, "then", { get() { throw undefined; } });
    else if (stage === "species") { class Species extends Promise { static get [Symbol.species]() { throw undefined; } } source = new Species(resolve => resolve()); }
    else source = { then(yes) { yes(); return Object.defineProperty({}, "then", { get() { throw undefined; } }); } };
    let caught = false; try { ledger.observe("fault", source); } catch (error) { caught = true; assert.equal(error, undefined); }
    assert.equal(caught, true); assert.equal(ledger.failures().registration[0], undefined);
    let done = false; const joined = ledger.drain().then(() => { throw Error("unexpected pass"); }, error => { done = true; return error; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(done, false);
    held.resolve(); const error = await joined; assert.ok(Array.isArray(error.errors)); assert.ok(error.errors.includes(undefined));
    assert.equal(ledger.failures().synchronous.length, 0);
  });
}
test("Qwen observer rejection remains fatal and cannot skip original joins", async () => {
  const ledger = createQwenLedger(), held = qwenDeferred(), reason = {};
  let subscriptions = 0;
  const original = { then(yes) { yes(); return ++subscriptions === 1 ? Promise.reject(reason) : Promise.resolve(); } };
  ledger.observe("read", original); ledger.observe("held", held.promise);
  const joined = ledger.drain(); held.resolve();
  await assert.rejects(joined, error => Array.isArray(error.errors) && error.errors.includes(reason));
  assert.equal(ledger.failures().observer[0], reason); assert.equal(ledger.operations[0].state, "fulfilled");
});
test("Qwen call, registration and restoration preserve independent undefined failures", async () => {
  const ledger = createQwenLedger(), receiver = {}, reason = {}, target = { method() {} };
  let caught = false; try { ledger.invoke("call", () => { throw undefined; }, receiver, []); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true); ledger.observe("read", Promise.reject(reason));
  ledger.replace(target, "method", () => {}); target.method = () => {};
  assert.throws(() => ledger.restore());
  await assert.rejects(ledger.drain(), error => Array.isArray(error.errors) && error.errors[0] === undefined && error.errors.includes(reason) && error.errors.includes(ledger.failures().restoration[0]));
});
test("Qwen exact descriptors restore and foreign replacements remain untouched", async () => {
  const ledger = createQwenLedger(), inherited = () => {}, prototype = { method: inherited }, target = Object.create(prototype);
  const installed = () => {}; ledger.replace(target, "method", installed); ledger.restore();
  assert.equal(Object.hasOwn(target, "method"), false); assert.equal(target.method, inherited);
  await ledger.drain(); ledger.seal();
  const other = createQwenLedger(), foreign = () => {}; other.replace(target, "method", installed); target.method = foreign;
  assert.throws(() => other.restore()); assert.equal(target.method, foreign); await assert.rejects(other.drain());
});
test("Qwen reader provenance retains C0, receiver, all arguments and original promises", async () => {
  const ledger = createQwenLedger(), source = qwenInertReader(), owner = {}, response = { body: source.body };
  const before = Object.getOwnPropertyDescriptor(source.body, "getReader"); ledger.response(response, owner);
  const reader = source.body.getReader("reader-option");
  assert.equal(reader.read(1, 2), source.read); assert.equal(reader.cancel(undefined, 3), source.cancel); reader.releaseLock("unlock-option");
  await ledger.drain(); const row = ledger.readers[0];
  assert.equal(row.owner, owner); assert.equal(row.generation, ledger.generation); assert.equal(row.response, response); assert.equal(row.closed, source.closed);
  assert.equal(source.calls[1][1], reader); assert.equal(source.calls[1][2].length, 2); assert.equal(source.calls[2][2][0], undefined);
  const readOperation = ledger.operations.find(row => row.kind === "read"); assert.equal(readOperation.binding.resource, row); assert.equal(readOperation.pending, source.read);
  ledger.restore(); assert.deepEqual(Object.getOwnPropertyDescriptor(source.body, "getReader"), before); await ledger.drain(); ledger.seal();
});
test("Qwen duplicate and foreign resources remain fatal without replacing original operands", async () => {
  const ledger = createQwenLedger(), source = qwenInertReader(), response = { body: source.body };
  ledger.response(response, {}); ledger.response(response, {});
  const reader = source.body.getReader(), foreign = {};
  assert.equal(reader.read.call(foreign, "exact"), source.read); assert.equal(source.calls.at(-1)[1], foreign);
  reader.releaseLock(); await assert.rejects(ledger.drain()); ledger.restore();
  const duplicate = createQwenLedger(), pending = Promise.resolve(); duplicate.observe("one", pending);
  assert.throws(() => duplicate.observe("two", pending)); await assert.rejects(duplicate.drain());
});
test("Qwen public closure preserves already owned asynchronous tails then seals permanently", async () => {
  const ledger = createQwenLedger(), storage = new AsyncLocalStorage(), ownership = createQwenOwnership(storage, ledger, { url: "https://qwen.fixture/", credential: "fixture" });
  const held = qwenDeferred(), receiver = {}, args = [1, undefined]; let calls = 0;
  const original = function (...actual) { calls++; assert.equal(this, receiver); assert.equal(actual.length, 2); assert.equal(actual[1], undefined); return held.promise; };
  assert.equal(ownership.invoke(original, receiver, args, {}), held.promise); ownership.closePublic();
  assert.throws(() => ownership.invoke(original, receiver, args, {})); assert.equal(calls, 1);
  ledger.observe("owned-tail", held.promise); const joined = ledger.drain(); held.resolve(); await joined;
  ledger.restore(); ownership.restore(); await ledger.drain(); ledger.seal();
  assert.throws(() => ownership.invoke(original, receiver, args, {})); assert.throws(() => ledger.invoke("late", original, receiver, args)); assert.equal(calls, 1);
});
test("Qwen Worker ancestry uses exact original ingress rather than credential or most recent case", async () => {
  const storage = new AsyncLocalStorage(), ownership = createQwenRequestOwnership(storage), first = qwenDeferred(), second = qwenDeferred();
  const a = { ledger: createQwenLedger() }, b = { ledger: createQwenLedger() }, requestA = {}, requestB = {}, receiver = {};
  const seen = [];
  function original(request, pending, extra) { assert.equal(this, receiver); assert.equal(extra, undefined); return pending.then(() => { const owner = ownership.current(); seen.push(owner); assert.equal(owner.request, request); return owner; }); }
  const one = ownership.invoke(a, requestA, original, receiver, [requestA, first.promise, undefined]);
  const two = ownership.invoke(b, requestB, original, receiver, [requestB, second.promise, undefined]);
  second.resolve(); first.resolve(); await Promise.all([one, two]); await Promise.all([a.ledger.drain(), b.ledger.drain()]);
  assert.equal(seen.length, 2); assert.notEqual(seen[0], seen[1]); assert.equal(seen[0].state, b); assert.equal(seen[1].state, a);
  assert.throws(() => ownership.current()); assert.throws(() => ownership.invoke(a, requestA, original, receiver, [requestA, first.promise, undefined]));
  assert.throws(() => storage.run({ ...seen[0] }, ownership.current));
  ownership.retire(b); assert.throws(() => storage.run(seen[0], ownership.current));
  const generation = a.ledger.generation; a.ledger = createQwenLedger(); assert.notEqual(a.ledger.generation, generation); assert.throws(() => storage.run(seen[1], ownership.current));
});
test("Qwen SDK acquisition binds exact invocation, fetch P, Response and reader generation", async () => {
  const ledger = createQwenLedger(), storage = new AsyncLocalStorage(), source = qwenInertReader(), response = { body: source.body };
  const expected = { url: "https://qwen.fixture/chat/completions", credential: "synthetic-fixture" };
  const ownership = createQwenOwnership(storage, ledger, expected), caller = {}, receiver = {}, options = { method: "POST", headers: { authorization: "Bearer " + expected.credential } };
  const fetchP = Promise.resolve(response), releaseP = Promise.resolve(); let acquisitions = 0, nativeCalls = 0, acquisitionP, publicP;
  const native = ownership.wrapFetch(function (...args) { nativeCalls++; assert.equal(this, receiver); assert.equal(args[0], expected.url); assert.equal(args[1], options); assert.equal(args[2], undefined); return fetchP; });
  function guard(input, extra) { acquisitions++; assert.equal(this, receiver); assert.equal(input, options); assert.equal(extra, undefined); acquisitionP = native.call(receiver, expected.url, options, undefined).then(response => ({ response, release() { return releaseP; } })); return acquisitionP; }
  const original = function (...args) { assert.equal(this, receiver); assert.equal(args[0], options); publicP = ownership.guard(guard, receiver, [options, undefined]); return publicP; };
  const returned = ownership.invoke(original, receiver, [options], caller); assert.equal(returned, publicP); assert.equal(returned, acquisitionP);
  const acquired = await returned, reader = acquired.response.body.getReader(); assert.equal(reader, source.reader);
  await reader.read(); await reader.cancel(undefined); reader.releaseLock(); assert.equal(acquired.release(), releaseP);
  ownership.closePublic(); await ledger.drain(); ownership.verify(1);
  const receipt = [...ownership.fetches][0], acquisition = [...ownership.acquisitions][0];
  assert.equal(receipt.pending, fetchP); assert.equal(receipt.response, response); assert.equal(receipt.acquisition, acquisition); assert.equal(acquisition.invocation.caller, caller);
  assert.equal(ledger.readers[0].owner, receipt); assert.equal(ledger.readers[0].closed, source.closed); assert.equal(receipt.generation, ledger.generation);
  assert.equal(nativeCalls, 1); assert.equal(acquisitions, 1);
  ledger.restore(); ownership.restore(); await ledger.drain(); ledger.seal();
});
test("Qwen publishes the shared drain before original assimilation can reenter", async () => {
  const ledger = createQwenLedger(), held = qwenDeferred(); let nested, subscriptions = 0, settled = false;
  const originalThen = held.promise.then;
  held.promise.then = function (...args) {
    if (++subscriptions === 2) nested = ledger.drain();
    return Reflect.apply(originalThen, this, args);
  };
  ledger.observe("held", held.promise); const joined = ledger.drain();
  // Old code returned a different, early-failing nested join while P was held.
  if (nested !== joined) nested.catch(() => {});
  assert.equal(nested, joined); joined.then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false);
  held.resolve(); await joined; assert.equal(subscriptions, 2); await ledger.drain(); assert.equal(subscriptions, 2);
});
// END Qwen observer ownership pure tests.

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
  const original = new AggregateError([cleanup, child], "private child error"); original.cause = original;
  const emitted = [];
  await assert.rejects(withQwenNativeRelay(relay => relay.runChild(() => { throw original; }), [], value => emitted.push(value)), error => retainedNativeFailures.get(error)[0] === original);
  assert.equal(getters, 0); assert.equal(emitted.find(value => value.kind === "helper").state, "failed"); assert.equal(emitted.find(value => value.kind === "helper").observedCases, 1);
  assert.ok(emitted.some(row => row.case === rows[0].id)); assert.doesNotMatch(JSON.stringify(emitted), /private child prose|private child error|never read/);
});

test("Qwen failure relay requires complete receipts, prioritizes entry groups and bounds overflow", async () => {
  const absent = [];
  await assert.rejects(withQwenNativeRelay(() => {}, [], () => {}));
  await assert.rejects(withQwenNativeRelay(relay => relay.runChild(() => {}), [], row => absent.push(row)));
  assert.equal(absent[1].state, "incomplete"); assert.equal(absent[1].unknownCases, rows.length);
  const relay = createQwenFailureRelay();
  for (const row of rows.slice(0, 12)) relay.text(closedSDKLine(closedSDKRecord(row.id, "failed")));
  const output = relay.output("failed"); assert.equal(output[0].kind, "entry_summary"); assert.equal(output[1].kind, "helper"); assert.equal(output.length, 10);
  assert.deepEqual(output[9], { kind: "overflow", omitted: 8 });
  const success = [];
  await withQwenNativeRelay(relay => relay.runChild(sink => {
    const witness = createQwenEntryWitness(value => sink.diagnostic(closedEntryLine(value)));
    witness.moduleEvaluated(); rows.forEach(row => witness.registered(row.id)); witness.registrationComplete();
    for (const row of rows) { witness.enter(row.id).complete({ operations: 4, rejected: 0, pending: 0 }); sink.diagnostic(closedSDKLine(closedSDKRecord(row.id))); }
  }), [], row => success.push(row));
  assert.equal(success.length, 5); assert.equal(success[1].state, "passed"); assert.equal(success[1].unknownCases, 0);
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
  assert.deepEqual(emitted.at(-1), { kind: "overflow", omitted: 508 });
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
  assert.deepEqual(packet[9], { kind: "overflow", omitted: 10 });
  assert.ok(packet.every(value => Buffer.byteLength(JSON.stringify(value)) <= 768));
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 8192);
  for (const [index, record] of packet.entries()) {
    const annotation = qwenBoundaryAnnotation(record), prefix = index < 2 || ["runner_binding", "runner_summary", "relay_status"].includes(record.kind) ? "::notice" : "::error";
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
  assert.deepEqual(output.at(-1), { kind: "overflow", omitted: 11 });
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

test("Qwen plain rendering admits witnesses while colored module loss stays failed", () => {
  const lines = [], witness = createQwenEntryWitness(value => lines.push(closedEntryLine(value)));
  witness.moduleEvaluated(); rows.forEach(row => witness.registered(row.id)); witness.registrationComplete();
  const colored = createQwenFailureRelay();
  assert.throws(() => colored.text("\u001b[90mstdout | fixture\n\u001b[22m\u001b[39m" + lines.join("")));
  const failed = colored.output("failed");
  assert.equal(failed[0].moduleEvaluated, false); assert.equal(failed[0].registrationObserved, false);
  assert.equal(failed.find(row => row.kind === "relay_status").failureStage, "module_required");
  const plain = createQwenFailureRelay(); plain.text("stdout | fixture\n" + lines.join(""));
  assert.equal(plain.output("failed")[0].registrationComplete, true);
  assert.equal(plain.complete(), false);
});

test("Qwen relay distinguishes diagnostics, absent captures and unvisited fields", () => {
  const status = relay => relay.output("failed").find(row => row.kind === "relay_status");
  const diagnostic = createQwenFailureRelay(); diagnostic.text("ordinary diagnostic\n");
  assert.deepEqual(status(diagnostic), { kind: "relay_status", diagnosticText: "observed", stdoutErrorField: "unknown", stderrErrorField: "unknown",
    errorTraversal: "unobserved", parsing: "complete", failureStage: "none", failurePresent: false, reasonDefined: false });
  const empty = createQwenFailureRelay(); empty.error(undefined);
  assert.equal(status(empty).errorTraversal, "complete"); assert.equal(status(empty).stdoutErrorField, "absent");
  assert.equal(status(empty).stderrErrorField, "absent"); assert.equal(status(empty).diagnosticText, "unobserved");
  const partial = createQwenFailureRelay();
  assert.throws(() => partial.error({ stdout: "QWEN_ENTRY_V1 {", stderr: closedEntryLine({ v: 1, kind: "module_evaluated", pin: sourceHead }) }));
  assert.equal(status(partial).stdoutErrorField, "present"); assert.equal(status(partial).stderrErrorField, "unknown");
  assert.equal(status(partial).errorTraversal, "failed"); assert.equal(status(partial).failureStage, "json_decode");
  partial.error({}); // A later complete traversal cannot erase the unfinished one.
  assert.equal(status(partial).stderrErrorField, "unknown"); assert.equal(status(partial).diagnosticText, "unobserved");
});

test("Qwen capture descriptors and proxies reject without invoking untrusted behavior", () => {
  for (const field of ["stdout", "stderr", "cause", "errors"]) {
    let getters = 0; const value = {};
    Object.defineProperty(value, field, { get() { getters++; throw undefined; } });
    const relay = createQwenFailureRelay(); assert.throws(() => relay.error(value)); assert.equal(getters, 0);
    const status = relay.output("failed").find(row => row.kind === "relay_status");
    assert.equal(status.errorTraversal, "failed"); assert.equal(status.stderrErrorField, "unknown");
  }
  let traps = 0;
  const proxy = new Proxy({}, { ownKeys() { traps++; throw undefined; }, getOwnPropertyDescriptor() { traps++; throw undefined; } });
  for (const value of [proxy, { errors: proxy }, { errors: [proxy] }]) {
    const relay = createQwenFailureRelay(); assert.throws(() => relay.error(value)); assert.equal(traps, 0);
  }
  const relay = createQwenFailureRelay(); assert.throws(() => relay.entry(proxy)); assert.equal(traps, 0);
  for (const packet of [proxy, { records: [proxy] }, { records: proxy }]) {
    assert.throws(() => projectQwenRunnerReport(packet)); assert.equal(traps, 0);
  }
});

test("Qwen admission stages distinguish malformed, foreign, duplicate and incomplete groups", () => {
  const module = { v: 1, kind: "module_evaluated", pin: sourceHead };
  for (const [line, stage] of [["QWEN_ENTRY_V1 {", "json_decode"], ["QWEN_ENTRY_V1 {} ", "canonical_json"],
    [closedEntryLine({ ...module, pin: "0".repeat(40) }), "record_schema"],
    [closedEntryLine(module) + closedEntryLine(module), "duplicate"],
    [closedEntryLine({ v: 1, kind: "case_enter", pin: sourceHead, case: rows[0].id, index: 0 }), "module_required"]]) {
    const relay = createQwenFailureRelay(); assert.throws(() => relay.text(line));
    assert.equal(relay.output("failed").find(row => row.kind === "relay_status").failureStage, stage);
    assert.equal(relay.complete(), false);
  }
});

test("Qwen parser undefined survives with original child, Worker, cleanup and reporting failures", async t => {
  const child = { stdout: closedEntryLine({ v: 1, kind: "module_evaluated", pin: sourceHead }) };
  const worker = {}, cleanup = {}, reporting = {}, output = [];
  const parse = JSON.parse;
  t.mock.method(JSON, "parse", function (value, ...args) {
    if (value === child.stdout.slice("QWEN_ENTRY_V1 ".length).trimEnd()) throw undefined;
    return Reflect.apply(parse, this, [value, ...args]);
  });
  await assert.rejects(withQwenNativeRelay(relay => relay.runChild(() => { throw child; }), [
    { phase: "worker", run() { throw worker; } }, { phase: "restore", run() { throw cleanup; } },
  ], row => { output.push(row); if (row.kind === "relay_status") throw reporting; }), error => {
    assert.deepEqual(retainedNativeFailures.get(error), [child, undefined, worker, cleanup, reporting]); return true;
  });
  const status = output.find(row => row.kind === "relay_status");
  assert.equal(status.failureStage, "json_decode"); assert.equal(status.failurePresent, true); assert.equal(status.reasonDefined, false);
  assert.equal(status.stderrErrorField, "unknown");
  await assert.rejects(withQwenNativeRelay(relay => relay.runChild(() => { throw undefined; }), [], () => {}),
    error => retainedNativeFailures.get(error).length === 1 && retainedNativeFailures.get(error)[0] === undefined);
});

test("Qwen relay status schema rejects forged capture absence and untrusted fields", () => {
  const relay = createQwenFailureRelay(), status = relay.output("failed").find(row => row.kind === "relay_status");
  for (const override of [{ stderrErrorField: "absent" }, { failureStage: "private reason" }, { private: true }, { reasonDefined: true }]) {
    assert.throws(() => qwenRelayStatus({ ...status, ...override }));
  }
  let getters = 0; const accessor = { ...status };
  Object.defineProperty(accessor, "failureStage", { get() { getters++; throw undefined; } });
  assert.throws(() => qwenRelayStatus(accessor)); assert.equal(getters, 0);
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation({ ...status, diagnosticText: "unobserved", stdoutErrorField: "present", stderrErrorField: "present",
    errorTraversal: "failed", parsing: "failed", failureStage: "registration_required", failurePresent: true, reasonDefined: true })) <= 768);
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
