import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createRequire, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { types as utilTypes } from "node:util";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/provider-compiler.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { startWorkerdFixture } from "./helpers/workerd.mjs";
import { runOpenClawConsumer, settleRunnerReport } from "./helpers/openclaw-consumer.mjs";
import { createQwenValueSink, clientValueAnchor, guardValueAnchor, clientValueExpression, guardValueExpression,
  qwenValueSources, qwenValueModule, qwenValueConfigText, qwenValueArgv, makeQwenValuePlan,
  overlayQwenValueSource, createQwenValuePlugin, readQwenValueInput, qwenValuePin, qwenValueTarget } from "./helpers/openclaw-qwen-callsite-observer.mjs";
import { parseRunnerReport, runnerContract, validateBinding } from "./helpers/openclaw-runner-reporter.mjs";

const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const fixture = new URL("./fixtures/openclaw-qwen-regions-contract.test.ts", import.meta.url);
const fixtureText = readFileSync(fixture, "utf8");
const transformed = stripTypeScriptTypes(fixtureText);
const shared = transformed.split("// BEGIN shared fixture functions.")[1]?.split("// END shared fixture functions.")[0];
assert.ok(shared, "original fixture functions are present");
// The marker's prose ends before the first function declaration.
const functions = shared.slice(shared.indexOf("function qwenRegionCases"));
const { qwenRegionCases, createQwenLedger, createQwenOwnership, createQwenCallableWitness, qwenClosedRecord, qwenJoinRecord, qwenRejectionRecord, createQwenSdkErrorWitness, qwenSdkSignalRecord, qwenEntryRecord, qwenObserverRecord, createQwenEntryWitness } = new Function("utilTypes", `"use strict"; ${functions}; return { qwenRegionCases, createQwenLedger, createQwenOwnership, createQwenCallableWitness, qwenClosedRecord, qwenJoinRecord, qwenRejectionRecord, createQwenSdkErrorWitness, qwenSdkSignalRecord, qwenEntryRecord, qwenObserverRecord, createQwenEntryWitness };`)(utilTypes);
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

const qwenRunnerFixtureSha256 = "1fdbdb298e31847302782b7a008c621f7bcd3b1c12c553a5495a666a325c7645";
const qwenRunnerReporterSha256 = "9c39bb702834528918c1e2f69509cea9de1e557d20ecf8205a9c36cb53f2a478";
const qwenValueObserverSha256 = "57160367213719c4faebc32fafd0b3c44192819caf469b4d5332188fbc0c3d60";

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
  if (binding.callsite) assert.equal(binding.callsite.helperSHA, qwenValueObserverSha256);
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
      reportBytes: checked.bytes, reportSha256: checked.sha256,
      ...(binding.callsite ? { valueContract: binding.callsite.contract, overlayConfigSHA: binding.callsite.configSHA } : {}) },
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
    assert.ok([1, 2, 3, 4, 5].includes(value.v));
    assert.deepEqual(Object.keys(value).sort(), ["v", "case", "phase", "op", "state", "operations", "rejected", "pending", ...(value.v >= 2 ? ["join"] : []), ...([3,4].includes(value.v) ? ["rejections"] : []), ...(value.v === 4 ? ["sdk"] : []), ...(value.v === 5 ? ["worker"] : [])].sort());
    if (sdk) assert.notEqual(value.case, "none", "SDK receipt requires an actual case");
    const checked = qwenClosedRecord(value.case, value.phase, value.op, value.state, { operations: value.operations, rejected: value.rejected, pending: value.pending });
    if (value.v >= 2) {
      assert.equal(checked.state, "failed"); checked.v = value.v; checked.join = qwenJoinRecord(value.join);
      if (value.v === 5) { assert.equal(sdk, false); assert.equal(value.phase, "worker"); checked.worker = qwenWorkerFailureRecord(value.worker, checked.join); }
      if ([3,4].includes(value.v)) {
        checked.rejections = qwenRejectionRecord(value.rejections);
        if (checked.rejections.originals !== null) assert.equal(checked.rejections.originals.length, checked.join[7]);
        if (value.v === 4) checked.sdk = qwenSdkSignalRecord(value.sdk, checked.rejections);
      }
    }
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
    assert.ok(![5, 6, 7, 8, 9].includes(checked.v) || checked.valueState[2] <= 9, "relay disposition cannot originate in worker");
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
    if (firstFailed && observerFailures.has(firstFailed.case)) {
      const observer = JSON.parse(observerFailures.get(firstFailed.case));
      if ([4, 5, 6, 7, 8, 9].includes(observer.v) && observer.values !== null) {
        const binding = runner?.find(record => record.kind === "runner_binding");
        // Missing/foreign actual reporter binding never admits a worker claim.
        if (!binding?.observed || binding.valueContract !== observer.values[1]) {
          observer.values = null;
          if ([5, 6, 7, 8, 9].includes(observer.v)) observer.valueState[2] = binding?.observed ? 11 : 10;
        }
      }
      if ([7, 8, 9].includes(observer.v) && observer.valueSelection !== null) {
        const binding = runner?.find(record => record.kind === "runner_binding");
        const key = observer.valueSelection[0] ?? observer.values?.[1];
        if (!binding?.observed || binding.valueContract !== key) {
          observer.valueSelection = null;
          observer.valueState[2] = binding?.observed ? 11 : 10;
        }
      }
      essential.push(observer);
    }
    const room = 9 - essential.length, result = [...essential, ...failures.slice(0, room)];
    if (failures.length > room) result.push({ kind: "overflow", omitted: failures.length - room });
    const commands = result.map(qwenBoundaryAnnotation);
    assert.ok(commands.every(value => Buffer.byteLength(value) <= 768), "escaped annotation bound exceeded");
    assert.ok(Buffer.byteLength(commands.join("\n")) <= 8192, "escaped packet bound exceeded");
    return result;
  }
  const complete = () => moduleEvaluated && registration?.complete === true && entered.size === rows.length && completed.size === rows.length
    && [...completed.values()].every(value => value.state === "passed" && value.pending === 0)
    && sdkCases.size === rows.length && [...sdkCases.entries()].every(([id, encoded]) => {
      const row = JSON.parse(encoded), completion = completed.get(id);
      // Entry validation already restricts nonzero rejection counts to the
      // exact partial/provider-error dispositions. Require both original
      // records to agree; a passed SDK row alone cannot qualify a rejection.
      return row.state === "passed" && row.pending === 0 && !!completion
        && ["state", "operations", "rejected", "pending"].every(key => row[key] === completion[key]);
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

// Worker-local evidence only: no SDK disposition or reason crosses HTTP.
function captureQwenWorkerFailure(state) {
  const ledger = state.ledger, first = ledger.joinOriginals();
  if (!first) return null;
  const signalSamples = new Map();
  const sample = signal => {
    if (!signal || typeof signal !== "object") return { state: 0 };
    if (signalSamples.has(signal)) return signalSamples.get(signal);
    let result;
    try {
      const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
      const reason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")?.get;
      if (!aborted || !reason) throw new Error("Worker signal accessors unavailable");
      const value = Reflect.apply(aborted, signal, []);
      if (value !== true && value !== false) throw new Error("Worker signal state invalid");
      result = { state: value ? 2 : 1, reason: value ? Reflect.apply(reason, signal, []) : undefined };
    } catch (error) { ledger.recordingFailure(error); result = { state: error === undefined ? 3 : 4 }; }
    signalSamples.set(signal, result); return result;
  };
  const request = sample(state.requestSignal), kinds = ["handler", "handler_observer", "fetch", "fetch_observer", "closed", "read", "cancel", "body_cancel", "waitUntil", "usage_ingest", "control_fetch", "control_body", "usage", "budget"];
  const originals = first.originals.length > 4 ? null : first.originals.map(operation => {
    const binding = operation.binding, reader = operation.kind === "closed" ? binding : binding?.resource;
    const index = ledger.readers.indexOf(reader), receipt = index >= 0 ? reader.owner : undefined;
    let mask = 0;
    if (index >= 0 && reader.generation === ledger.generation) mask |= 1;
    if (receipt && state.receipts.has(receipt) && reader.response === receipt.response) mask |= 2;
    if (receipt?.owner?.state === state && receipt.owner.generation === ledger.generation && receipt.owner === state.requestOwner) mask |= 4;
    if (index >= 0 && (operation.kind === "closed" ? operation.pending === reader.closed : binding.receiver === reader.reader)) mask |= 8;
    const upstream = mask === 15 ? sample(receipt.signal) : { state: 0 };
    const cancels = ledger.operations.filter(row => row.kind === "cancel" && row.binding?.resource === reader && row.binding.receiver === reader?.reader);
    const args = cancels.length === 1 ? cancels[0].binding.args : undefined;
    const argument = args && Object.getOwnPropertyDescriptor(args, "0");
    const rejected = operation.state === "rejected";
    const relation = value => rejected ? Object.is(operation.reason, value) ? 1 : 2 : 0;
    return [operation.ordinal, kinds.indexOf(operation.kind) + 1, operation.entered, operation.settled,
      index + 1, mask, rejected ? 2 : 1, rejected ? operation.reason === undefined ? 0 : 1 : -1,
      argument && Object.hasOwn(argument, "value") ? relation(argument.value) : 0,
      upstream.state, upstream.state === 2 ? relation(upstream.reason) : 0,
      request.state === 2 ? relation(request.reason) : 0, index >= 0 ? reader.unlocks : -1, index >= 0 ? reader.returns : -1];
  });
  state.workerSignalSamples = signalSamples;
  return { requestState: request.state, source: null, originals };
}

// Assess only after the unchanged ledger has joined, restored and sealed.
// HttpOperation preserves its first cause: an upstream failure cannot become
// caller cancellation merely because a later cancel uses the same reason.
function qwenWorkerCancellation(state, source, usage, sealed, budget) {
  const ledger = state.ledger, first = ledger.joinOriginals(), join = ledger.joinRecord();
  if (!sealed || sealed.generation !== ledger.generation || state.row.mode !== "partial"
    || state.requests !== 1 || state.status !== 200 || state.receipts.size !== 1
    || !source || source.held !== 0 || source.canceled !== 1 || source.cancelReturns !== 1 || source.active !== 0 || source.expired !== 0 || source.settled !== 1
    || source.calls?.length !== 1 || usage?.events?.length !== 1) return [];
  const event = usage.events[0];
  if (event.status !== "client_error" || event.credential_id !== state.row.id || event.provider !== state.row.provider
    || event.model !== state.row.provider + "/" + state.row.model) return [];
  if (!first || ![1, 3].includes(first.originals.length) || !join || join.slice(0, 7).some(Boolean)
    || join[7] !== first.originals.length || join[8] !== 0 || join[9] !== 0
    || sealed.observers.some(row => row.state !== "fulfilled") || ledger.readers.length !== 1) return [];
  const reader = ledger.readers[0], receipt = reader.owner, owner = state.requestOwner;
  if (reader.generation !== ledger.generation || reader.unlocks !== 1 || reader.returns !== 1
    || !receipt || !state.receipts.has(receipt) || reader.response !== receipt.response
    || receipt.owner !== owner || owner?.state !== state || owner.generation !== ledger.generation) return [];
  const fetches = ledger.operations.filter(operation => operation.kind === "fetch");
  if (fetches.length !== 1 || fetches[0].state !== "fulfilled" || fetches[0].pending !== receipt.pending
    || fetches[0].binding.resource !== receipt || fetches[0].binding.original !== receipt.original
    || fetches[0].binding.receiver !== receipt.receiver || fetches[0].binding.args !== receipt.args) return [];
  const rejected = ledger.operations.filter(operation => operation.state !== "fulfilled");
  if (first.originals.length === 1) {
    // Retirement joins read and cancel before release. Qualify the caller's
    // closed outcome, not the native read error's message or causal identity.
    if (rejected.length !== 1 || event.actual_cost_micros !== 7 || event.cost_basis !== "policy_fixed"
      || [event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens].some(value => value !== null)
      || budget?.ledger !== "durable_object" || budget.limitMicros !== 100 || budget.spentMicros !== 7) return [];
    const read = rejected[0], original = first.originals[0];
    const closes = ledger.operations.filter(operation => operation.kind === "closed");
    const cancels = ledger.operations.filter(operation => operation.kind === "cancel");
    if (closes.length !== 1 || cancels.length !== 1) return [];
    const closed = closes[0], cancel = cancels[0];
    if (read.kind !== "read" || read.state !== "rejected" || read.generation !== ledger.generation
      || read.binding?.resource !== reader || read.binding.receiver !== reader.reader
      || original.pending !== read.pending || original.binding !== read.binding || original.kind !== "read"
      || original.state !== "rejected" || original.generation !== ledger.generation
      || original.entered !== read.entered || original.settled !== read.settled || !Object.is(original.reason, read.reason)
      || closed.state !== "fulfilled" || closed.generation !== ledger.generation
      || closed.binding !== reader || closed.pending !== reader.closed || closed.settled === 0
      || cancel.state !== "fulfilled" || cancel.generation !== ledger.generation || cancel.settled === 0
      || cancel.binding?.resource !== reader || cancel.binding.receiver !== reader.reader
      || read.entered >= cancel.entered || read.settled <= cancel.entered) return [];
    return rejected;
  }
  const signal = state.workerSignalSamples?.get(receipt.signal);
  if (signal?.state !== 2 || !signal.reason || typeof signal.reason !== "object") return [];
  if (rejected.length !== 3 || rejected.map(operation => operation.kind).sort().join() !== "cancel,closed,read"
    || rejected.some(operation => operation.state !== "rejected" || operation.generation !== ledger.generation
      || operation.settled === 0 || !Object.is(operation.reason, signal.reason))) return [];
  for (const operation of rejected) {
    const original = first.originals.find(row => row.pending === operation.pending);
    if (!original || original.kind !== operation.kind || original.state !== "rejected"
      || original.binding !== operation.binding || !Object.is(original.reason, operation.reason)) return [];
    if (operation.kind === "closed") {
      if (operation.binding !== reader || operation.pending !== reader.closed) return [];
    } else if (operation.binding.resource !== reader || operation.binding.receiver !== reader.reader) return [];
  }
  const cancels = ledger.operations.filter(operation => operation.kind === "cancel");
  const argument = cancels.length === 1 && Object.getOwnPropertyDescriptor(cancels[0].binding.args, "0");
  if (!argument || !Object.hasOwn(argument, "value") || !Object.is(argument.value, signal.reason)) return [];
  return rejected;
}
function qwenWorkerCancellationFailure(error, originals, drainFailures) {
  if (!drainFailures?.has(error) || ![1, 3].includes(originals.length) || !(error instanceof AggregateError)) return false;
  const errors = Object.getOwnPropertyDescriptor(error, "errors")?.value;
  return Array.isArray(errors) && errors.length === originals.length && originals.every((operation, index) => Object.is(errors[index], operation.reason));
}
function qwenWorkerFailureRecord(input, join) {
  const invalid = () => { throw new Error("invalid closed Qwen Worker witness"); };
  if (!input || typeof input !== "object" || utilTypes.isProxy(input)) invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).join() !== "requestState,source,originals"
    || Object.values(fields).some(field => !Object.hasOwn(field, "value"))) invalid();
  const state = fields.requestState.value, source = fields.source.value, raw = fields.originals.value;
  if (!Number.isSafeInteger(state) || state < 0 || state > 4) invalid();
  const tuple = (raw, length) => {
    if (utilTypes.isProxy(raw) || !Array.isArray(raw)) invalid();
    const slots = Object.getOwnPropertyDescriptors(raw);
    if (slots.length.value !== length || Reflect.ownKeys(slots).join() !== Array.from({length}, (_,i)=>String(i)).concat("length").join()
      || Object.values(slots).some(field => !Object.hasOwn(field,"value"))) invalid();
    const values = Array.from({length}, (_,i)=>slots[String(i)].value);
    if (!values.every(Number.isSafeInteger) || values.some(value=>value < -1 || value > 65535)) invalid();
    return values;
  };
  const producer = source === null ? null : tuple(source,4);
  if (producer && (![0,1].includes(producer[0]) || producer[1]<0 || producer[2]<0 || ![0,1].includes(producer[3]))) invalid();
  if (raw === null) return { requestState:state,source:producer,originals:null };
  if (utilTypes.isProxy(raw) || !Array.isArray(raw)) invalid();
  const rows = Object.getOwnPropertyDescriptors(raw), length = rows.length.value;
  if (!Number.isSafeInteger(length) || length<0 || length>4 || length!==join[7]
    || Reflect.ownKeys(rows).join()!==Array.from({length},(_,i)=>String(i)).concat("length").join()
    || Object.values(rows).some(field=>!Object.hasOwn(field,"value"))) invalid();
  let ordinal=0;
  const originals=Array.from({length},(_,i)=>{
    const r=tuple(rows[String(i)].value,14);
    if(r[0]<=ordinal || r[1]<0 || r[1]>14 || r[2]<1 || r[3]<0 || r[3]!==0&&r[3]<=r[2]
      || r[4]<0 || r[5]<0 || r[5]>15 || ![1,2].includes(r[6]) || r[9]<0 || r[9]>4
      || ![0,1,2].includes(r[8]) || ![0,1,2].includes(r[10]) || ![0,1,2].includes(r[11])
      || (r[6]===1 ? r[3]!==0||r[7]!==-1||r[8]!==0||r[10]!==0||r[11]!==0 : r[3]===0||![0,1].includes(r[7]))
      || r[9]!==2&&r[10]!==0 || state!==2&&r[11]!==0 || r[5]!==15&&r[9]!==0
      || (r[4]===0 ? r[5]!==0||r[12]!==-1||r[13]!==-1 : r[12]<0||r[13]<0)) invalid();
    ordinal=r[0];return r;
  });
  return { requestState:state,source:producer,originals };
}

// The credential selects a case; only the original ingress call establishes
// asynchronous request ancestry. Owned cleanup tails outlive public admission.
function createQwenRequestOwnership(storage, signalGetter) {
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
    // One diagnostic native getter at ingress; failure stays independent.
    state.requestOwner = owner;
    try {
      if (signalGetter) state.requestSignal = Reflect.apply(signalGetter, request, []);
    } catch (error) { state.ledger.recordingFailure(error); }
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
import { ingestUsage, budgetStatus } from './worker/ledgers.ts';
import { usageSnapshot } from './worker/usage-ledger-client.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {sha256Hex} from './worker/utils.ts';
${createQwenLedger.toString()}
${createQwenRequestOwnership.toString()}
${captureQwenWorkerFailure.toString()}
${qwenWorkerCancellation.toString()}
${qwenWorkerCancellationFailure.toString()}
const requestOwnership=createQwenRequestOwnership(new AsyncLocalStorage(),Object.getOwnPropertyDescriptor(Request.prototype,"signal")?.get);
const rows=${JSON.stringify(rows)},regions=${JSON.stringify(regions)},states=new Map(),nativeFetch=globalThis.fetch;
const credential=${credential.toString()};
globalThis.fetch=function(input,init){
 const headers=new Headers(init?.headers!==undefined?init.headers:input instanceof Request?input.headers:undefined);
 const owner=requestOwnership.current(),s=owner.state,secret=headers.get('authorization');
 if(secret!=='Bearer '+credential(s.row)&&secret!=='Bearer '+credential(s.row,true))throw Error('foreign Qwen upstream credential');
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 s.calls.push({url,method:init?.method??(input instanceof Request?input.method:'GET'),original:secret==='Bearer '+credential(s.row),rotated:secret==='Bearer '+credential(s.row,true),noCaller:!headers.has('x-api-key')&&!headers.has('api-key')});
 const receipt={owner,original:nativeFetch,receiver:this,args:[input,init],pending:undefined,response:undefined};
 try{const signal=Object.getOwnPropertyDescriptor(init??{},'signal');if(signal&&Object.hasOwn(signal,'value'))receipt.signal=signal.value;s.receipts.add(receipt);}catch(error){s.ledger.recordingFailure(error);}
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
   const ledger=createQwenLedger(),s={row,ledger,calls:[],receipts:new Set(),requests:0,status:null,retirement:undefined};
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
   const failures=[],drainFailures=new Set();let firstWorker=null;try{await s.ledger.drain();}catch(error){failures.push(error);drainFailures.add(error);try{firstWorker=captureQwenWorkerFailure(s);}catch(reportError){failures.push(reportError);}}
   let source,usage,budget;try{source=await control(s,'proof');}catch(error){failures.push(error);}
   try{usage=await s.ledger.invoke('usage',usageSnapshot,undefined,[env,'fixture',s.row.id,{kind:'admin'}]);}catch(error){failures.push(error);}
   try{budget=await s.ledger.invoke('budget',budgetStatus,undefined,[env,s.row.id,{tenantId:'fixture',monthlyBudgetMicros:100}]);}catch(error){failures.push(error);}
   try{await s.ledger.drain();}catch(error){failures.push(error);drainFailures.add(error);}
   try{s.ledger.restore();}catch(error){failures.push(error);}
   try{await s.ledger.drain();}catch(error){failures.push(error);drainFailures.add(error);}
   let sealed;try{sealed=s.ledger.seal();}catch(error){failures.push(error);}
   let cancellation=[];try{cancellation=qwenWorkerCancellation(s,source,usage,sealed,budget);}catch(error){failures.push(error);}
   const unqualified=failures.filter(error=>!qwenWorkerCancellationFailure(error,cancellation,drainFailures));
   requestOwnership.retire(s);
   return {retired:unqualified.length===0,join:s.ledger.joinRecord(),worker:firstWorker,workerCancelled:cancellation.map(o=>s.ledger.operations.indexOf(o)),calls:s.calls,source,usage,budget,status:s.status,requests:s.requests,charged:bodyBudgetCharged(),operations:s.ledger.operations.map(o=>({kind:o.kind,state:o.state})),readers:s.ledger.readers.map(r=>({unlocks:r.unlocks,returns:r.returns,locked:r.body.locked}))};
  })();const proof=await s.retirement;return Response.json(proof,{status:proof.retired?200:500});
 }
 const authorization=request.headers.get('authorization'),s=[...states.values()].find(s=>authorization==='Bearer clawrouter-live-'+s.row.id+'-fixture-secret'||authorization==='Bearer clawrouter-live-'+s.row.id+'-invalid');
 if(!s||s.retirement)throw Error('unbound or retired Qwen caller');s.requests++;
 const original=requestOwnership.invoke(s,request,handler.fetch,handler,[request,s.env,{waitUntil:p=>{s.ledger.observe('waitUntil',p);context.waitUntil(p);}}]);
 s.ledger.follow('handler_observer',original,[response=>{s.status=response.status;}]);return original;
},queue:handler.queue};`;
}

function upstreamScript() {
  return `const rows=${JSON.stringify(rows)},states=new Map(rows.map(row=>[row.id,{row,calls:[],held:0,canceled:0,cancelReturns:0,active:0,expired:0,settled:0}]));const credential=${credential.toString()};
export default {async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.origin==='https://control.fixture'){
  const s=states.get(url.pathname.split('/')[2]);if(!s)throw Error('unknown source');
  if(s.producer){await s.producer;s.settled=1;}
  return Response.json({calls:s.calls,held:s.held,canceled:s.canceled,cancelReturns:s.cancelReturns,active:s.active,expired:s.expired,settled:s.settled});
 }
 const matches=[...states.values()].filter(s=>request.headers.get('authorization')==='Bearer '+credential(s.row)||request.headers.get('authorization')==='Bearer '+credential(s.row,true));
 if(matches.length!==1)throw Error('unbound upstream secret');const s=matches[0],body=await request.json();
 s.calls.push({url:request.url,method:request.method,body,authorization:request.headers.get('authorization'),apiKey:request.headers.get('api-key'),xApiKey:request.headers.get('x-api-key')});
 const frame=value=>'data: '+JSON.stringify(value)+'\\n\\n';
 const chunk=delta=>({id:'chat_fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:null}]});
 if(s.row.mode==='provider_error')return new Response(frame({error:{message:'synthetic provider error',code:'synthetic_error'}}),{headers:{'content-type':'text/event-stream'}});
 const first=frame(chunk({role:'assistant',content:'synthetic-answer'}));
 // Bounded native I/O lets the cross-Worker pump observe disconnection. Keep
 // its original producer in this request's lifetime; control still joins it.
 if(s.row.mode==='partial')return new Response(new ReadableStream({start(c){s.held=1;c.enqueue(new TextEncoder().encode(first));
  s.producer=new Promise((resolve,reject)=>{s.resolve=resolve;s.reject=reject;s.timer=setTimeout(()=>{s.expired++;s.held=0;c.error(Error('source expired'));reject(Error('source expired'));},10000);});
  ctx.waitUntil(s.producer);
 },pull(c){const pending=(async()=>{s.active++;try{await scheduler.wait(20);if(s.held)c.enqueue(new TextEncoder().encode(': fixture heartbeat\\n\\n'));}catch(error){clearTimeout(s.timer);s.held=0;s.reject(error);throw error;}finally{s.active--;}})();s.waiting=pending;return pending.finally(()=>{if(s.waiting===pending)s.waiting=undefined;});
 },async cancel(){s.canceled++;clearTimeout(s.timer);s.held=0;try{if(s.waiting)await s.waiting;s.cancelReturns++;s.resolve?.();}catch(error){s.reject(error);throw error;}}}),{headers:{'content-type':'text/event-stream'}});
 const usage=s.row.mode==='no_usage'?{}:{usage:{prompt_tokens:300,completion_tokens:20,total_tokens:320,prompt_tokens_details:{cached_tokens:256}}};
 const wire=first+frame({id:'chat_fixture',model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],...usage})+'data: [DONE]\\n\\n';
 const bytes=new TextEncoder().encode(wire);let at=0;
 return new Response(new ReadableStream({pull(c){if(at===bytes.length)c.close();else{const next=Math.min(at+7,bytes.length);c.enqueue(bytes.slice(at,next));at=next;}}}),{headers:{'content-type':'text/event-stream'}});
}};`;
}

test("Qwen held producer joins bounded native work, cancellation and expiry", async t => {
  function fixture() {
    const timers = new Map(), sources = [], waits = [], lifetimes = []; let next = 0;
    class CapturedStream extends ReadableStream {
      constructor(source) { super(source); sources.push(source); }
    }
    const { handler, states } = new Function("ReadableStream", "setTimeout", "clearTimeout", "scheduler",
      upstreamScript().replace("export default", "const handler =") + ";return {handler,states};")(
      CapturedStream,
      (callback, delay) => { const id = ++next; timers.set(id, { callback, delay }); return id; },
      id => timers.delete(id), { wait(delay) { assert.equal(delay,20);return new Promise((resolve,reject)=>waits.push({resolve,reject})); } });
    const context = {waitUntil(pending){lifetimes.push(pending);void pending.catch(()=>undefined);}};
    const row = rows.find(row => row.mode === "partial"), state = states.get(row.id);
    const response = () => handler.fetch(new Request("https://upstream.fixture/chat/completions", {
      method: "POST", headers: { authorization: "Bearer " + credential(row) },
      body: JSON.stringify({ model: row.model, messages: [], stream: true }),
    }), {}, context);
    const proof = () => handler.fetch(new Request("https://control.fixture/proof/" + row.id));
    const foreignProof = () => handler.fetch(new Request("https://control.fixture/proof/" + rows.find(row => row.mode === "eof").id));
    return { timers, sources, state, response, proof, foreignProof, waits, lifetimes,
      advance() { for(const wait of waits.splice(0))wait.resolve(); }, fail(error) { for(const wait of waits.splice(0))wait.reject(error); } };
  }
  for (const phase of ["before first read", "after first read", "with a pending read"]) {
    await t.test(phase, async () => {
      const f = fixture(), response = await f.response(), reader = response.body.getReader();
      assert.equal(typeof f.sources[0].pull, "function");
      assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].delay, 10000);
      assert.equal(f.state.held, 1); assert.equal(f.state.settled, 0);
      assert.ok(f.state.producer instanceof Promise);
      assert.deepEqual(f.lifetimes,[f.state.producer]);
      let controlSettled = false;
      const control = f.proof().then(value => { controlSettled = true; return value; });
      await Promise.resolve(); assert.equal(controlSettled, false);
      if (phase !== "before first read") assert.equal((await reader.read()).done, false);
      const pending = phase === "with a pending read" ? reader.read() : null;
      const reason = new Error("owned fixture cancellation");
      let canceled=false;const cancel=reader.cancel(reason).then(()=>{canceled=true;});
      await Promise.resolve();if(f.waits.length)assert.equal(canceled,false);f.advance();await cancel;
      if (pending) assert.deepEqual(await pending, { value: undefined, done: true });
      await reader.closed; reader.releaseLock();
      await f.state.producer;
      const proof = await (await control).json();
      assert.deepEqual([proof.held, proof.canceled, proof.expired, proof.settled], [0, 1, 0, 1]);
      assert.equal(proof.active,0);assert.equal(proof.cancelReturns,1);
      assert.equal(f.timers.size, 0); assert.equal(response.body.locked, false);
      assert.deepEqual(await (await f.proof()).json(), proof);
    });
  }
  await t.test("uncanceled expiry remains the original rejected producer and control", async () => {
    const f = fixture(), response = await f.response(), reader = response.body.getReader();
    const closed = reader.closed.catch(error => error);
    await reader.read(); const pending = reader.read().catch(error => error);
    const control = f.proof().catch(error => error), producer = f.state.producer.catch(error => error);
    const [{ callback }] = f.timers.values(); f.timers.clear(); callback();
    f.advance();
    const original = await producer;
    assert.equal(original.message, "source expired"); assert.equal(await control, original);
    assert.equal((await pending).message, "source expired"); assert.equal((await closed).message, "source expired");
    assert.deepEqual([f.state.held, f.state.canceled, f.state.expired, f.state.settled], [0, 0, 1, 0]);
    await assert.rejects(reader.cancel(), error => error.message === "source expired");
    reader.releaseLock(); assert.equal(f.state.canceled, 0);
    assert.equal(f.state.active,0);assert.equal(f.state.cancelReturns,0);
    await assert.rejects(f.proof(), error => error === original);
  });
  await t.test("foreign control cannot settle or cancel the source", async () => {
    const f = fixture(), response = await f.response();
    const foreign = await (await f.foreignProof()).json();
    assert.deepEqual([foreign.held, foreign.canceled, foreign.expired, foreign.settled], [0, 0, 0, 0]);
    assert.deepEqual([f.state.held, f.state.canceled, f.state.settled], [1, 0, 0]);
    assert.equal(f.timers.size, 1);
    await response.body.cancel();
    const proof = await (await f.proof()).json();
    assert.deepEqual([proof.held, proof.canceled, proof.expired, proof.settled], [0, 1, 0, 1]);
  });
  await t.test("native producer failure preserves falsey originals and never becomes cancellation", async () => {
    for(const reason of [undefined,false,{}]){
      const f=fixture(),response=await f.response(),reader=response.body.getReader();
      const closed=reader.closed.catch(error=>({present:true,error}));await reader.read();
      const read=reader.read().catch(error=>({present:true,error}));
      const control=f.proof().catch(error=>({present:true,error}));
      const producer=f.state.producer.catch(error=>({present:true,error}));f.fail(reason);
      for(const pending of [closed,read,control,producer]){const actual=await pending;assert.equal(actual.present,true);assert.equal(actual.error,reason);}
      assert.deepEqual([f.state.held,f.state.active,f.state.canceled,f.state.cancelReturns,f.state.expired,f.state.settled],[0,0,0,0,0,0]);
      assert.equal(f.timers.size,0);reader.releaseLock();
    }
  });
});

async function startFixture() {
  const directory = await mkdtemp(join(tmpdir(), "qwen-regions-")); let runtime, origin;
  try {
    runtime = await startWorkerdFixture(directory, routerScript(), upstreamScript(), { directRouter: true, requestContext: true });
    origin = (await runtime.unsafeGetDirectURL("router")).origin;
  } catch (error) {
    return finish(() => { throw error; }, [...(runtime ? [() => runtime.dispose()] : []), () => rm(directory, { recursive: true, force: true })]);
  }
  return { runtime, origin, close: () => finish(() => {}, [() => runtime.dispose(), () => rm(directory, { recursive: true, force: true })]) };
}

async function readControl(f, path, report) {
  const response = await fetch(f.origin + path);
  const text = await response.text();
  const proof = JSON.parse(text);
  if (report) {
    const id = path.startsWith("/fixture/join/") ? path.slice("/fixture/join/".length) : "none";
    const operations = Array.isArray(proof.operations) ? proof.operations : [];
    const record = qwenClosedRecord(id, id === "none" ? "setup" : "worker", "control", response.status === 200 ? "passed" : "failed", {
      operations: operations.length, rejected: operations.filter(op => op.state === "rejected").length, pending: operations.filter(op => op.state === "pending").length,
    });
    if (response.status !== 200 && proof.worker && proof.join) {
      const join = qwenJoinRecord(proof.join), source = proof.source;
      const worker = qwenWorkerFailureRecord({ ...proof.worker,
        source: source ? [source.held,source.canceled,source.expired,source.settled] : null }, join);
      report({ ...record, v: 5, join, worker });
    } else report(record);
  }
  assert.equal(response.status, 200, path === "/fixture/setup" ? "Worker setup failed" : "original Worker retirement failed");
  return proof;
}

function assertProof(row, proof) {
  assert.equal(proof.retired, true); assert.equal(proof.charged, 0);
  assert.equal(proof.budget.ledger, "durable_object"); assert.equal(proof.budget.limitMicros, 100);
  if (!paid(row)) assert.equal(proof.budget.spentMicros, 0);
  const canceled = proof.workerCancelled;
  assert.ok(Array.isArray(canceled)); assert.equal(new Set(canceled).size, canceled.length);
  assert.ok(canceled.every(index => Number.isSafeInteger(index) && index >= 0 && index < proof.operations.length));
  if (canceled.length) {
    assert.equal(row.mode, "partial"); assert.ok([1, 3].includes(canceled.length));
    assert.deepEqual(canceled.map(index => proof.operations[index].kind).sort(), canceled.length === 1 ? ["read"] : ["cancel", "closed", "read"]);
    if (canceled.length === 1) for (const kind of ["closed", "cancel"]) {
      const originals = proof.operations.filter(operation => operation.kind === kind);
      assert.equal(originals.length, 1); assert.equal(originals[0].state, "fulfilled");
    }
  }
  assert.ok(proof.operations.every((o, index) => o.state === (canceled.includes(index) ? "rejected" : "fulfilled")));
  assert.ok(proof.readers.every(r => r.unlocks === 1 && r.returns === 1 && !r.locked));
  assert.equal(proof.source.held, 0); assert.equal(proof.source.expired, 0); assert.equal(proof.source.active,0);
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
  if (row.mode === "partial") { assert.equal(proof.source.canceled, 1); assert.equal(proof.source.cancelReturns,1); assert.equal(proof.source.settled, 1); }
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
  const strategy = parse(readFileSync(".github/workflows/openclaw-contract.yml", "utf8")).jobs.consumer.strategy;
  const matrix = strategy.matrix.include;
  assert.equal(strategy["max-parallel"], 4);
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
  for (const patch of [{ case: "foreign" }, { parent: true }, { parent: row.observer }, { observer: 65536 }, { v: 3 },
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

function qwenRouteFixture(mode, reason) {
  const ledger = createQwenLedger(), receiver = {}, response = { body: null }, contexts = [];
  let context, reads = 0, calls = 0, subscriptions = 0, resolve, argsReads = 0;
  const storage = { disable() { context = undefined; }, getStore() { reads++; return context; },
    run(value, fn) { contexts.push(value); const prior = context; context = value; try { return fn(); } finally { context = prior; } } };
  const expected = { url: "https://qwen.fixture/chat/completions", credential: "synthetic-fixture" };
  const owner = createQwenOwnership(storage, ledger, expected), options = { method: "POST", headers: { authorization: "Bearer " + expected.credential } };
  const parent = new Promise(yes => { resolve = yes; }), then = parent.then;
  parent.then = function (...args) { subscriptions++; return Reflect.apply(then, this, args); };
  const native = owner.wrapFetch(function (...args) {
    calls++; assert.equal(this, receiver); assert.equal(args.length, 3);
    assert.equal(args[0], expected.url); assert.equal(args[1], options); assert.equal(args[2], undefined); return parent;
  });
  const call = () => native.call(receiver, expected.url, options, undefined);
  function guard() {
    const fetch = mode === "restored_context" ? storage.run(contexts[0], call) : call();
    return fetch.then(() => ({ response, release: () => Promise.resolve() }));
  }
  if (mode === "guarded") ledger.response = () => { throw reason; };
  const result = owner.invoke(() => {
    if (!["no_entry", "foreign_context", "late_entry"].includes(mode)) owner.providerEntry();
    if (mode === "foreign_context") return storage.run(Object.freeze({ invocation: contexts[0].invocation }), call);
    if (mode === "late_entry") { const original = call(); owner.providerEntry(); return original; }
    if (mode === "setup_throw") {
      const args = []; Object.defineProperty(args, "0", { get() { if (++argsReads === 1) throw reason; return options; } }); args.length = 1;
      return owner.guard(guard, receiver, args);
    }
    return ["guarded", "restored_context"].includes(mode) ? owner.guard(guard, receiver, [options]) : call();
  }, receiver, [], {});
  return { ledger, owner, parent, result, response, resolve, calls: () => calls, reads: () => reads,
    subscriptions: () => subscriptions, argsReads: () => argsReads };
}

for (const [mode, route, reads, subscriptions] of [
  ["no_entry", [1,0,0,0,0,0,0,0,0], 1, 3],
  ["provider_only", [1,1,0,0,0,0,1,0,0], 2, 3],
  ["guarded", [1,1,1,1,0,0,2,2,1], 3, 4],
  ["restored_context", [1,1,1,1,0,0,1,1,2], 3, 4],
  ["foreign_context", null, 1, 3],
  ["late_entry", [1,0,0,0,0,0,0,0,0], 2, 3],
]) test(`Qwen invocation route observes ${mode} without changing original calls`, async () => {
  const reason = {}, f = qwenRouteFixture(mode, reason); f.resolve(f.response); await f.result; await assert.rejects(f.ledger.drain());
  const row = f.ledger.observerRecord(rows[0].id); assert.equal(row.v, 2); assert.deepEqual(row.route, route);
  assert.equal(f.calls(), 1); assert.equal(f.reads(), reads); assert.equal(f.subscriptions(), subscriptions);
  assert.equal(f.ledger.operations[row.parent - 1].pending, f.parent);
  if (mode === "guarded") assert.equal(f.ledger.operations[row.observer - 1].reason, reason);
  const { route: ignored, ...legacy } = row; legacy.v = 1; assert.deepEqual(qwenObserverRecord(legacy), legacy);
  f.ledger.restore(); f.owner.restore();
});

for (const reason of [undefined, {}]) test("Qwen guard setup failure records original definedness without another argument read", async () => {
  const f = qwenRouteFixture("setup_throw", reason); f.resolve(f.response); await f.result; await assert.rejects(f.ledger.drain());
  assert.deepEqual(f.ledger.observerRecord(rows[0].id).route, [1,1,1,0,1,Number(reason === undefined),1,1,0]);
  assert.equal(f.ledger.failures().ownership[0], reason); assert.equal(f.argsReads(), 2); assert.equal(f.calls(), 1);
  assert.equal(f.reads(), 3); assert.equal(f.subscriptions(), 4); f.ledger.restore(); f.owner.restore();
});

test("Qwen foreign invocation entries cannot supply the failing invocation route", async () => {
  const ledger = createQwenLedger(); let context;
  const storage = { disable() {}, getStore: () => context, run(value, fn) { const prior = context; context = value; try { return fn(); } finally { context = prior; } } };
  const owner = createQwenOwnership(storage, ledger, { url: "https://qwen.fixture/", credential: "synthetic-fixture" });
  owner.invoke(() => { owner.providerEntry(); }, undefined, [], {});
  const response = { body: null }, pending = Promise.resolve(response);
  const native = owner.wrapFetch(() => pending);
  assert.equal(owner.invoke(() => native("https://qwen.fixture/", { method: "POST", headers: { authorization: "Bearer synthetic-fixture" } }), undefined, [], {}), pending);
  await pending; await assert.rejects(ledger.drain());
  assert.deepEqual(ledger.observerRecord(rows[0].id).route, [1,0,0,0,0,0,0,0,0]); ledger.restore(); owner.restore();
});

test("Qwen route recorder failure leaves original fetch and restoration failures independent", async () => {
  const reason = {}, reportReason = {}, restoreReason = {}, f = qwenRouteFixture("guarded", reason);
  f.ledger.captureObserverFailure = () => { throw reportReason; };
  const target = { value: 1 }; f.ledger.replace(target, "value", 2);
  Object.defineProperty(target, "value", { get() { throw restoreReason; }, configurable: true });
  f.resolve(f.response); await f.result; await assert.rejects(f.ledger.drain()); assert.throws(() => f.ledger.restore());
  assert.equal(f.ledger.operations.find(row => row.kind === "fetch_observer").reason, reason);
  assert.equal(f.ledger.failures().recording[0], reportReason); assert.equal(f.ledger.failures().restoration.length, 1);
  assert.equal(f.ledger.observerRecord(rows[0].id), null); assert.equal(f.calls(), 1); f.owner.restore();
});

for (const reason of [undefined, {}]) test("Qwen provider entry observation failure cannot skip original fetch or its joins", async () => {
  const ledger = createQwenLedger(); let context, fault = true, reads = 0, calls = 0, subscriptions = 0;
  const storage = { disable() {}, getStore() { reads++; if (fault) { fault = false; throw reason; } return context; },
    run(value, fn) { const prior = context; context = value; try { return fn(); } finally { context = prior; } } };
  const owner = createQwenOwnership(storage, ledger, { url: "https://qwen.fixture/", credential: "synthetic-fixture" });
  let resolve; const response = { body: null }, original = new Promise(yes => { resolve = yes; }), then = original.then;
  original.then = function (...args) { subscriptions++; return Reflect.apply(then, this, args); };
  const fetch = owner.wrapFetch(() => { calls++; return original; });
  assert.equal(owner.invoke(() => { owner.providerEntry(); return fetch("https://qwen.fixture/", { method: "POST", headers: { authorization: "Bearer synthetic-fixture" } }); }, undefined, [], {}), original);
  let joined = false; const drain = ledger.drain().then(() => assert.fail("unexpected pass"), error => { joined = true; return error; });
  await Promise.resolve(); assert.equal(joined, false); resolve(response); const failure = await drain;
  assert.ok(Array.isArray(failure.errors)); assert.ok(failure.errors.some(value => Object.is(value, reason)));
  assert.equal(ledger.failures().recording.length, 1); assert.equal(ledger.failures().recording[0], reason);
  assert.equal(ledger.operations.find(row => row.kind === "fetch").pending, original);
  assert.equal(ledger.operations.find(row => row.kind === "fetch_observer").state, "rejected");
  assert.equal(ledger.observerRecord(rows[0].id), null); assert.equal(calls, 1); assert.equal(reads, 2); assert.equal(subscriptions, 3);
  ledger.restore(); owner.restore();
});

test("Qwen invocation route codec rejects impossible counts and context relations", async () => {
  const f = qwenRouteFixture("guarded", undefined); f.resolve(f.response); await f.result; await assert.rejects(f.ledger.drain());
  const record = f.ledger.observerRecord(rows[0].id);
  for (const route of [[1,0,1,1,0,0,2,2,1], [1,1,0,1,0,0,2,2,1], [1,1,1,1,1,0,2,2,1],
    [1,1,1,1,0,1,2,2,1], [1,1,1,1,0,0,3,2,1], [1,1,1,1,0,0,2,2,2], [1,65536,1,1,0,0,2,2,1]]) {
    assert.throws(() => qwenObserverRecord({ ...record, route }));
  }
  const route = [...record.route]; Object.defineProperty(route, "2", { get() { throw undefined; } });
  assert.throws(() => qwenObserverRecord({ ...record, route }));
  assert.equal(qwenObserverRecord({ ...record, route: null }).route, null);
  const widest = qwenObserverRecord({ ...record, parent: 65534, observer: 65535, route: [1,65535,65535,65535,0,0,3,3,3] });
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(widest)) <= 768);
  f.ledger.restore(); f.owner.restore();
});
// END Qwen observer failure witness pure tests.

// BEGIN Qwen defining callable pure tests.
function qwenCallableFixture(options = {}) {
  const ledger = createQwenLedger(), model = {}, receiver = {}, hookResult = {}, calls = [];
  const invocation = Object.freeze({ generation: ledger.generation, args: Object.freeze([model]) });
  let context, getters = 0, activeHost;
  const selected = function () { throw new Error("inert selected fetch must not run"); };
  const host = {};
  const build = function (...args) {
    calls.push(["build", this, args]);
    if (options.at === "build") throw options.reason;
    return Object.hasOwn(options, "buildReturn") ? options.buildReturn : selected;
  };
  Object.defineProperty(host, "buildModelFetch", options.accessor
    ? { configurable: true, enumerable: false, get() { getters++; return build; } }
    : { value: build, configurable: true, enumerable: false, writable: false });
  activeHost = options.host ?? host;
  const lookup = function (...args) {
    calls.push(["lookup", this, args]);
    if (options.at === "lookup") throw options.reason;
    return activeHost;
  };
  const hook = function (...args) {
    calls.push(["hook", this, args]);
    if (options.at === "hook") throw options.reason;
    return hookResult;
  };
  const hostModule = {}, hookModule = { withOpenAIErrorResponseHook: hook };
  Object.defineProperty(hostModule, "getAiTransportHost", options.exportGetter
    ? { configurable: true, enumerable: true, get() { getters++; return lookup; } }
    : { configurable: true, enumerable: true, writable: true, value: lookup });
  const oldHost = Object.getOwnPropertyDescriptor(host, "buildModelFetch"), oldLookup = Object.getOwnPropertyDescriptor(hostModule, "getAiTransportHost");
  const witness = createQwenCallableWitness(ledger, () => context, utilTypes.isProxy);
  witness.bind(invocation); witness.install(hostModule, hookModule);
  const run = fn => { const prior = context; context = invocation; try { return fn(); } finally { context = prior; } };
  const client = () => run(() => {
    const returned = Reflect.apply(hostModule.getAiTransportHost, receiver, [undefined]);
    const value = Reflect.apply(returned.buildModelFetch, returned, [model, undefined, 7]);
    return Reflect.apply(hookModule.withOpenAIErrorResponseHook, receiver, [value ?? selected, undefined, model]);
  });
  return { ledger, witness, invocation, model, receiver, hookResult, selected, host, hostModule, hookModule, calls, run, client,
    getters: () => getters, oldHost, oldLookup, setHost(value) { activeHost = value; } };
}

test("Qwen defining callables preserve actual returns, receivers, arguments and descriptor flags", () => {
  const f = qwenCallableFixture({ exportGetter: true });
  assert.equal(f.getters(), 0);
  assert.equal(f.client(), f.hookResult); assert.equal(f.getters(), 1);
  assert.deepEqual(f.calls.map(row => row[0]), ["lookup", "build", "hook"]);
  assert.equal(f.calls[0][1], f.receiver); assert.deepEqual(f.calls[0][2], [undefined]);
  assert.equal(f.calls[1][1], f.host); assert.deepEqual(f.calls[1][2], [f.model, undefined, 7]);
  assert.equal(f.calls[2][1], f.receiver); assert.deepEqual(f.calls[2][2], [f.selected, undefined, f.model]);
  assert.deepEqual(f.witness.snapshot(f.invocation), [1,1,1,1,1,1,3]);
  const descriptor = Object.getOwnPropertyDescriptor(f.host, "buildModelFetch");
  for (const key of ["enumerable", "writable", "configurable"]) assert.equal(descriptor[key], f.oldHost[key]);
  f.ledger.restore();
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.host, "buildModelFetch"), f.oldHost);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.hostModule, "getAiTransportHost"), f.oldLookup);
});

for (const at of ["lookup", "build", "hook"]) for (const reason of [undefined, {}]) test(`Qwen ${at} preserves original thrown presence and identity`, () => {
  const f = qwenCallableFixture({ at, reason }); let threw = false;
  try { f.client(); } catch (error) { threw = true; assert.equal(error, reason); }
  assert.equal(threw, true);
  const outcome = reason === undefined ? 2 : 3;
  assert.deepEqual(f.witness.snapshot(f.invocation), at === "lookup" ? [1,outcome,0,0,0,0,1]
    : at === "build" ? [1,1,outcome,0,0,0,3] : [1,1,1,1,outcome,1,3]);
  assert.equal(f.calls.length, ["lookup", "build", "hook"].indexOf(at) + 1); f.ledger.restore();
});

for (const buildReturn of [null, undefined]) test("Qwen nullish build identifies only the associated source selection branch", () => {
  const f = qwenCallableFixture({ buildReturn }); assert.equal(f.client(), f.hookResult);
  assert.deepEqual(f.witness.snapshot(f.invocation), [1,1,1,buildReturn === null ? 2 : 3,1,2,3]);
  assert.equal(f.calls[2][2][0], f.selected); f.ledger.restore();
});

test("Qwen installs on the actual returned host, never a prior active host", () => {
  const f = qwenCallableFixture(), second = { buildModelFetch: () => f.selected };
  f.setHost(second); assert.equal(f.client(), f.hookResult);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.host, "buildModelFetch"), f.oldHost);
  const installed = second.buildModelFetch;
  // Reuse the same host for another exact invocation without stacking wrappers.
  const other = Object.freeze({ generation: f.ledger.generation, args: [f.model] }); f.witness.bind(other);
  f.run(() => f.hostModule.getAiTransportHost()); assert.equal(second.buildModelFetch, installed);
  assert.equal(f.witness.snapshot(f.invocation), null); f.ledger.restore();
});

test("Qwen host accessors and proxies stay unsupported without extra getter or trap evaluation", () => {
  const f = qwenCallableFixture({ accessor: true }); assert.equal(f.getters(), 0);
  assert.equal(f.client(), f.hookResult); assert.equal(f.getters(), 1);
  assert.deepEqual(f.witness.snapshot(f.invocation), [1,1,0,0,1,0,1]); f.ledger.restore();
  let traps = 0;
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { traps++; throw undefined; } });
  const p = qwenCallableFixture({ host: proxy }); p.run(() => p.hostModule.getAiTransportHost());
  assert.deepEqual(p.witness.snapshot(p.invocation), [1,1,0,0,0,0,1]); assert.equal(traps, 0); p.ledger.restore();
});

test("Qwen immutable ESM namespaces remain unknown without recording or restoration work", async () => {
  const namespace = await import("data:text/javascript," + encodeURIComponent(`
    export const calls = [], lookupResult = {}, hookResult = {};
    export function getAiTransportHost(...args) { calls.push(["lookup", this, args]); return lookupResult; }
    export function withOpenAIErrorResponseHook(...args) { calls.push(["hook", this, args]); return hookResult; }
  `));
  assert.equal(utilTypes.isModuleNamespaceObject(namespace), true);
  const names = ["getAiTransportHost", "withOpenAIErrorResponseHook"];
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(namespace, name));
  for (const descriptor of descriptors) {
    assert.equal(descriptor.configurable, false); assert.equal(descriptor.writable, true);
    assert.equal(Object.hasOwn(descriptor, "value"), true);
  }
  const ledger = createQwenLedger(), invocation = { generation: ledger.generation, args: [{}] };
  let registrations = 0; const deferRestore = ledger.deferRestore;
  ledger.deferRestore = function (...args) { registrations++; return Reflect.apply(deferRestore, this, args); };
  const witness = createQwenCallableWitness(ledger, () => invocation, utilTypes.isProxy);
  witness.bind(invocation); witness.install(namespace, namespace);
  assert.equal(registrations, 0); assert.equal(namespace.calls.length, 0);
  assert.deepEqual(ledger.failures().recording, []);
  const receiver = {}, lookupArgs = [undefined], hookArgs = [() => {}, undefined, invocation.args[0]];
  assert.equal(Reflect.apply(namespace.getAiTransportHost, receiver, lookupArgs), namespace.lookupResult);
  assert.equal(Reflect.apply(namespace.withOpenAIErrorResponseHook, receiver, hookArgs), namespace.hookResult);
  assert.equal(namespace.calls.length, 2);
  for (let index = 0; index < names.length; index++) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(namespace, names[index]), descriptors[index]);
    assert.equal(namespace[names[index]], descriptors[index].value);
    assert.equal(namespace.calls[index][1], receiver);
    assert.deepEqual(namespace.calls[index][2], index === 0 ? lookupArgs : hookArgs);
  }
  assert.deepEqual(witness.snapshot(invocation), [1,0,0,0,0,0,0]);
  const original = Promise.resolve(namespace.hookResult);
  assert.equal(ledger.observe("caller", original), original);
  await ledger.drain(); assert.equal(ledger.operations[0].pending, original);
  assert.equal(ledger.operations[0].state, "fulfilled"); ledger.restore(); await ledger.drain(); ledger.seal();
  assert.deepEqual(ledger.failures().recording, []); assert.deepEqual(ledger.failures().restoration, []);
});

for (const mode of ["foreign_model", "foreign_receiver", "foreign_invocation", "duplicate", "reentrant", "wrong_hook"]) test(`Qwen ${mode} cannot supply a callable association`, () => {
  const f = qwenCallableFixture();
  if (mode === "reentrant") {
    const host = { buildModelFetch() { f.hostModule.getAiTransportHost(); return f.selected; } }; f.setHost(host); f.client();
  } else {
    f.run(() => {
      const host = f.hostModule.getAiTransportHost();
      if (mode === "duplicate") f.hostModule.getAiTransportHost();
      Reflect.apply(host.buildModelFetch, mode === "foreign_receiver" ? {} : host, [mode === "foreign_model" ? {} : f.model]);
      f.hookModule.withOpenAIErrorResponseHook(mode === "wrong_hook" ? () => {} : f.selected, undefined, f.model);
    });
    if (mode === "foreign_invocation") f.host.buildModelFetch(f.model);
  }
  assert.equal(f.witness.snapshot(f.invocation), null); f.ledger.restore();
});

test("Qwen recording and restoration failures remain independent of an original undefined throw", () => {
  const f = qwenCallableFixture({ at: "build", reason: undefined }), recording = {}, restored = f.ledger.deferRestore;
  f.ledger.deferRestore = () => { throw recording; };
  let threw = false; try { f.client(); } catch (error) { threw = true; assert.equal(error, undefined); }
  assert.equal(threw, true); assert.deepEqual(f.ledger.failures().recording, [recording]);
  f.ledger.deferRestore = restored;
  Object.defineProperty(f.hostModule, "getAiTransportHost", { value: () => undefined });
  assert.throws(() => f.ledger.restore(), error => Array.isArray(error.errors) && error.errors.length === 1);
  assert.equal(f.ledger.failures().restoration.length, 1);
});

for (const reason of [undefined, {}]) test("Qwen original export getter throws once without being pre-read", () => {
  const ledger = createQwenLedger(), invocation = { generation: ledger.generation, args: [{}] };
  let reads = 0;
  const target = {}; Object.defineProperty(target, "getAiTransportHost", { configurable: true, get() { reads++; throw reason; } });
  const witness = createQwenCallableWitness(ledger, () => invocation, utilTypes.isProxy);
  witness.bind(invocation); witness.install(target, { withOpenAIErrorResponseHook() {} }); assert.equal(reads, 0);
  let threw = false; try { target.getAiTransportHost; } catch (error) { threw = true; assert.equal(error, reason); }
  assert.equal(threw, true); assert.equal(reads, 1); assert.deepEqual(witness.snapshot(invocation), [1,0,0,0,0,0,1]); ledger.restore();
});

for (const reason of [undefined, {}]) test("Qwen passive descriptor recording failure never substitutes an original lookup return", async () => {
  const ledger = createQwenLedger(), host = {}, model = {}, invocation = { generation: ledger.generation, args: [model] };
  const module = { getAiTransportHost() { return host; } };
  const witness = createQwenCallableWitness(ledger, () => invocation, value => { if (value === host) throw reason; return false; });
  witness.bind(invocation); witness.install(module, { withOpenAIErrorResponseHook() {} });
  assert.equal(module.getAiTransportHost(), host); assert.equal(ledger.failures().recording.length, 1);
  assert.equal(ledger.failures().recording[0], reason);
  await assert.rejects(ledger.drain(), error => error.errors.length === 1 && error.errors[0] === reason);
  ledger.deferRestore(() => { throw undefined; });
  assert.throws(() => ledger.restore(), error => error.errors.length === 1 && error.errors[0] === undefined);
  await assert.rejects(ledger.drain(), error => error.errors.length === 2 && error.errors[0] === undefined && error.errors[1] === reason);
});

test("Qwen absent module interception, foreign invocations and repeated bindings remain unknown", () => {
  const ledger = createQwenLedger(), invocation = { generation: ledger.generation, args: [{}] }, module = {};
  Object.defineProperty(module, "getAiTransportHost", { value() { return {}; }, writable: false, configurable: false });
  const witness = createQwenCallableWitness(ledger, () => invocation, utilTypes.isProxy);
  witness.bind(invocation); witness.install(module, {});
  assert.deepEqual(witness.snapshot(invocation), [1,0,0,0,0,0,0]); assert.equal(witness.snapshot({}), null);
  witness.bind(invocation); assert.equal(witness.snapshot(invocation), null); ledger.restore();
});

test("Qwen host wrapper is installed once across two exact invocation identities", () => {
  const ledger = createQwenLedger(), model = {}, host = { buildModelFetch() { return fetch; } }, fetch = () => {};
  const a = { generation: ledger.generation, args: [model] }, b = { generation: ledger.generation, args: [model] };
  let current = a; const witness = createQwenCallableWitness(ledger, () => current, utilTypes.isProxy);
  const module = { getAiTransportHost: () => host }, hooks = { withOpenAIErrorResponseHook: fn => fn };
  witness.bind(a); witness.bind(b); witness.install(module, hooks);
  assert.equal(hooks.withOpenAIErrorResponseHook(module.getAiTransportHost().buildModelFetch(model), undefined, model), fetch);
  const installed = host.buildModelFetch; current = b;
  assert.equal(hooks.withOpenAIErrorResponseHook(module.getAiTransportHost().buildModelFetch(model), undefined, model), fetch);
  assert.equal(host.buildModelFetch, installed);
  assert.deepEqual(witness.snapshot(a), [1,1,1,1,1,1,3]); assert.deepEqual(witness.snapshot(b), [1,1,1,1,1,1,3]); ledger.restore();
});

function qwenCallableObserverFixture(mode = "host", reason) {
  const ledger = createQwenLedger(), model = {}, calls = [];
  let context, resolve, subscriptions = 0;
  const storage = { disable() {}, getStore: () => context, run(value, fn) { const prior = context; context = value; try { return fn(); } finally { context = prior; } } };
  const expected = { url: "https://qwen.fixture/chat/completions", credential: "synthetic-fixture" };
  const owner = createQwenOwnership(storage, ledger, expected), response = { body: null };
  const parent = new Promise(yes => { resolve = yes; }), then = parent.then;
  parent.then = function (...args) { subscriptions++; return Reflect.apply(then, this, args); };
  const fetch = owner.wrapFetch(function (...args) { calls.push([this, args]); return parent; });
  const host = { buildModelFetch: () => mode === "fallback" ? undefined : fetch };
  const hostModule = { getAiTransportHost: () => host }, hookModule = { withOpenAIErrorResponseHook: fn => fn };
  owner.installCallables(hostModule, hookModule, utilTypes.isProxy);
  if (mode === "guarded") ledger.response = () => { throw reason; };
  const result = owner.invoke(() => {
    const selected = mode === "unobserved" ? fetch : hookModule.withOpenAIErrorResponseHook(hostModule.getAiTransportHost().buildModelFetch(model) ?? fetch, undefined, model);
    const call = () => Reflect.apply(selected, host, [expected.url, { method: "POST", headers: { authorization: "Bearer " + expected.credential } }, undefined]);
    return mode === "guarded" ? owner.guard(() => call().then(() => ({ response, release: () => Promise.resolve() })), host, []) : call();
  }, undefined, [model], {});
  return { ledger, owner, response, parent, result, resolve, calls, subscriptions: () => subscriptions };
}

for (const mode of ["host", "fallback", "unobserved", "guarded"]) for (const reason of [undefined, {}]) test(`Qwen actual ${mode} callable snapshot survives first observer failure and bounded relay`, async () => {
  const f = qwenCallableObserverFixture(mode, reason); f.resolve(f.response); await f.result; await assert.rejects(f.ledger.drain());
  const record = f.ledger.observerRecord(rows[0].id);
  assert.equal(record.v, 3);
  assert.deepEqual(record.callable, mode === "unobserved" ? [1,0,0,0,0,0,1] : [1,1,1,mode === "fallback" ? 3 : 1,1,mode === "fallback" ? 2 : 1,3]);
  assert.equal(f.calls.length, 1); assert.equal(f.subscriptions(), mode === "guarded" ? 4 : 3);
  assert.equal(f.ledger.operations.find(row => row.kind === "fetch").pending, f.parent);
  if (mode === "guarded") assert.equal(record.reasonDefined, reason !== undefined);
  const first = JSON.stringify(record);
  f.ledger.captureObserverFailure(f.parent, { raw: "must not replace first" }, {});
  assert.equal(JSON.stringify(f.ledger.observerRecord(rows[0].id)), first);
  const relay = createQwenFailureRelay(), witness = createQwenEntryWitness(value => relay.text("QWEN_ENTRY_V1 " + JSON.stringify(value)));
  witness.moduleEvaluated(); rows.forEach(row => witness.registered(row.id)); witness.registrationComplete();
  const active = witness.enter(rows[0].id), counts = { operations: f.ledger.operations.length, rejected: f.ledger.operations.filter(row => row.state === "rejected").length, pending: 0 };
  active.at("owned_drain"); active.failed(undefined);
  relay.text("QWEN_SDK_V1 " + JSON.stringify(qwenClosedRecord(rows[0].id, "join", "fetch_observer", "failed", counts)));
  relay.text("QWEN_OBSERVER_V1 " + JSON.stringify(record)); active.complete(counts);
  rows.slice(1).forEach(row => relay.record(qwenClosedRecord(row.id, "worker", "control", "failed", counts)));
  const output = relay.output("failed"); assert.deepEqual(output.find(row => row.kind === "observer_failure"), record);
  assert.equal(output.length, 10); assert.ok(output.map(qwenBoundaryAnnotation).every(line => Buffer.byteLength(line) <= 768));
  assert.ok(Buffer.byteLength(output.map(qwenBoundaryAnnotation).join("\n")) <= 8192);
  f.ledger.restore(); f.owner.restore();
});

test("Qwen callable codec rejects contradictions and preserves historical schemas", async () => {
  const f = qwenCallableObserverFixture(); f.resolve(f.response); await f.result; await assert.rejects(f.ledger.drain());
  const record = f.ledger.observerRecord(rows[0].id), valid = record.callable;
  for (const callable of [[1,0,1,1,1,1,3], [1,1,1,0,1,1,3], [1,1,1,1,1,2,3], [1,1,2,0,1,0,3],
    [1,1,1,1,0,1,3], [1,1,1,1,1,1,1], [1,1,0,1,0,0,3], [1,1,1,1,1,0,3], [true,1,1,1,1,1,3], [...valid,0]]) {
    assert.throws(() => qwenObserverRecord({ ...record, callable }));
  }
  let reads = 0; const accessor = [...valid]; Object.defineProperty(accessor, "2", { get() { reads++; throw undefined; } });
  assert.throws(() => qwenObserverRecord({ ...record, callable: accessor })); assert.equal(reads, 0);
  const proxy = new Proxy(valid, { ownKeys() { reads++; throw undefined; } });
  assert.throws(() => qwenObserverRecord({ ...record, callable: proxy })); assert.equal(reads, 0);
  assert.equal(qwenObserverRecord({ ...record, callable: null }).callable, null);
  const { callable, ...v2 } = record; v2.v = 2; assert.deepEqual(qwenObserverRecord(v2), v2);
  const { route, ...v1 } = v2; v1.v = 1; assert.deepEqual(qwenObserverRecord(v1), v1);
  const wide = qwenObserverRecord({ ...record, case: rows.reduce((a, b) => a.id.length > b.id.length ? a : b).id,
    parent: 65534, observer: 65535, acquisition: false, route: [1,65535,65535,65535,0,0,3,3,2] });
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(wide)) <= 768);
  f.ledger.restore(); f.owner.restore();
});
// END Qwen defining callable pure tests.

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
  for (const [path, sha] of [
    ["src/agents/provider-transport-fetch.ts", "2c1cdb87182771ea906ed791fb35dc81f6dcf12198baa51b82a05275bb956e06"],
    ["packages/ai/src/transports/transport-stream-shared.ts", "d987e6ccdfb3aa106e0c81f1fa67eb52ec22fab45eb783d6904b0adfabdf2cf7"],
  ]) readQwenValueInput(resolve(process.env.CLAWROUTER_OPENCLAW_CHECKOUT, path), sha);
  let f;
  await withQwenNativeRelay(async relay => {
    f = await startFixture();
    await readControl(f, "/fixture/setup", relay.record);
    await relay.runChild(sink => runOpenClawConsumer(sink, { source: process.env.CLAWROUTER_OPENCLAW_CHECKOUT, sourceHead, fixture, testPath: "extensions/qwen/worker-regions-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: f.origin, CLAWROUTER_SDK_SOURCE_HEAD: sourceHead, QWEN_API_KEY: "synthetic-poison-client" },
      runnerReport: { expectedInvocations: 1, fixtureSha256: qwenRunnerFixtureSha256, reporterSha256: qwenRunnerReporterSha256, valueObserverSha256: qwenValueObserverSha256, onReport: relay.runnerReport } }));
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

test("shipping regional Worker joins its partial producer and owned read outcome", { timeout: 60_000 }, async () => {
  const f = await startFixture(), row = rows.find(row => row.mode === "partial" && !row.simple);
  await finish(async () => {
    await readControl(f, "/fixture/setup");
    const response = await fetch(f.origin + "/v1/native/" + row.provider + "/chat/completions", {
      method: "POST", headers: { authorization: "Bearer " + key(row.id), "content-type": "application/json" },
      body: JSON.stringify({ model: row.model, stream: true, max_tokens: 128, messages: [
        { role: "assistant", content: "", ...(row.model === "qwen3.5-plus" ? {} : { reasoning_content: "synthetic-prior-thinking" }), tool_calls: [{ id: "callfixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "callfixture", content: "synthetic-tool-result" }, { role: "user", content: "synthetic request" },
      ] }),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); assert.equal((await reader.read()).done, false);
    await reader.cancel(new Error("owned partial fixture cancellation")); reader.releaseLock();
    const control = await fetch(f.origin + "/fixture/join/" + row.id), proof = await control.json();
    assert.ok(proof.source,"source must return its original producer proof");
    assert.deepEqual([proof.source.held,proof.source.canceled,proof.source.cancelReturns,proof.source.active,proof.source.expired,proof.source.settled],[0,1,1,0,0,1]);
    assert.ok(proof.readers.every(reader=>reader.unlocks===1&&reader.returns===1&&!reader.locked));
    assert.equal(control.status,200);assertProof(row,proof);
    if(proof.workerCancelled.length===1)for(const kind of ["closed","cancel"]){
      for(const mode of ["missing","duplicate","rejected"]){
        const invalid=structuredClone(proof),index=invalid.operations.findIndex(operation=>operation.kind===kind);
        if(mode==="missing")invalid.operations[index].kind="foreign";
        if(mode==="duplicate")invalid.operations.push({...invalid.operations[index]});
        if(mode==="rejected")invalid.operations[index].state="rejected";
        assert.throws(()=>assertProof(row,invalid));
      }
    }
    assert.equal(proof.requests,1);assert.equal(proof.status,200);assert.equal(proof.charged,0);
    assert.equal(proof.budget.ledger,"durable_object");assert.equal(proof.budget.limitMicros,100);assert.equal(proof.budget.spentMicros,7);
    assert.equal(proof.usage.events.length,1);const event=proof.usage.events[0];
    assert.equal(event.status,"client_error");assert.equal(event.credential_id,row.id);assert.equal(event.provider,row.provider);
    assert.equal(event.actual_cost_micros,7);assert.equal(event.cost_basis,"policy_fixed");
    assert.deepEqual([event.input_tokens,event.output_tokens,event.total_tokens,event.cached_input_tokens],[null,null,null,null]);
  }, [() => f.close()]);
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

// Execute the emitted expressions, not a second implementation. Native remains
// separately gated; these controls need only built-in modules and fixture code.
function qwenValueHarness(currentOverride) {
  const contract = "a".repeat(64), invocation = Object.freeze({});
  const sink = createQwenValueSink(contract);
  sink.activate(1, contract); sink.activate(2, contract);
  const claim = sink.claim(contract, 1, currentOverride ?? (() => invocation));
  claim.bind(invocation);
  return { contract, invocation, sink, claim };
}
const qwenClientExpression = expression => new Function("__qwenValues", "env", `
  with (env) {
    return new OpenAI({
      apiKey: apiKey, baseURL: baseURL, defaultHeaders: defaultHeaders,
      fetch: hook(${expression}, onResponse, model),
    });
  }
`);
const qwenGuardExpression = expression => new Function("__qwenValues", "env", `with (env) { return ${expression}; }`);
function qwenCaught(run) {
  try { return { failed: false, value: run() }; }
  catch (reason) { return { failed: true, reason }; }
}

test("Qwen value expressions preserve constructor, hook, getter, receiver and nullish order", () => {
  for (const value of [undefined, null, false, true, 0, -0, NaN, 1, "", "x", 0n, Symbol("value"), {}, () => {}]) {
    const fallback = Object.freeze({});
    const exercise = observed => {
      const h = qwenValueHarness(), trace = [], model = {};
      const host = { get buildModelFetch() {
        trace.push("build_get");
        return function (received) { trace.push("build_call"); assert.equal(this, host); assert.equal(received, model); return value; };
      } };
      const env = {
        get OpenAI() { trace.push("constructor_get"); return function (options) { trace.push("constructor_call"); return options; }; },
        get apiKey() { trace.push("apiKey"); return "synthetic"; },
        get baseURL() { trace.push("baseURL"); return undefined; },
        get defaultHeaders() { trace.push("headers"); return undefined; },
        get hook() { trace.push("hook_get"); return function (selected, response, received) {
          trace.push("hook_call"); assert.equal(this, env); assert.equal(received, model); return selected;
        }; },
        getAiTransportHost() { trace.push("lookup"); return host; }, model,
        globalThis: { get fetch() { trace.push("fallback_get"); return fallback; } },
        get onResponse() { trace.push("onResponse"); return undefined; },
      };
      const result = qwenClientExpression(observed ? clientValueExpression : clientValueAnchor)(h.sink, env);
      assert.ok(Object.is(result.fetch, value == null ? fallback : value));
      const record = h.claim.snapshot(h.invocation);
      assert.deepEqual(h.claim.close(), []);
      return { trace, record };
    };
    const original = exercise(false), observed = exercise(true);
    assert.deepEqual(observed.trace, original.trace);
    assert.deepEqual(observed.trace.slice(0, 5), ["constructor_get", "apiKey", "baseURL", "headers", "hook_get"]);
    assert.equal(observed.trace.filter(v => v === "fallback_get").length, value == null ? 1 : 0);
    assert.equal(observed.record[4], value == null ? 15 : 11);
    assert.equal(observed.record[5], value == null ? 2 : 1);
    assert.equal(observed.record[10], 0);
  }
});

test("Qwen original noncallables, throws and promises survive value observation", () => {
  const reasons = [undefined, null, false, 0, -0, NaN, "", Symbol("failure"), new Error("synthetic")];
  for (const reason of reasons) for (const where of ["lookup", "build_get", "build_call", "fallback", "guard"]) {
    const run = observed => {
      const h = qwenValueHarness(); let called = 0;
      const host = { get buildModelFetch() {
        if (where === "build_get") throw reason;
        return () => { called++; if (where === "build_call") throw reason; return undefined; };
      } };
      const env = { OpenAI: function (v) { return v; }, apiKey: "", baseURL: "", defaultHeaders: {},
        hook: v => v, onResponse: undefined, model: {},
        getAiTransportHost() { if (where === "lookup") throw reason; return host; },
        globalThis: { get fetch() { if (where === "fallback") throw reason; return undefined; } },
        options: {}, getProviderTransportDispatcherPool: () => ({}),
        fetchWithSsrFGuard() { throw reason; } };
      const result = qwenCaught(() => where === "guard"
        ? qwenGuardExpression(observed ? guardValueExpression : guardValueAnchor)(h.sink, env)
        : qwenClientExpression(observed ? clientValueExpression : clientValueAnchor)(h.sink, env));
      assert.equal(result.failed, true); assert.ok(Object.is(result.reason, reason));
      assert.deepEqual(h.claim.close(), []);
      return called;
    };
    assert.equal(run(true), run(false));
  }
  for (const noncallable of [undefined, null, false, 0, {}, "x"]) {
    const h = qwenValueHarness(), model = {};
    const env = { OpenAI: function (v) { return v; }, apiKey: "", baseURL: "", defaultHeaders: {},
      hook: v => v, onResponse: undefined, model, globalThis: {},
      getAiTransportHost: () => ({ buildModelFetch: noncallable }) };
    for (const expression of [clientValueAnchor, clientValueExpression]) {
      const result = qwenCaught(() => qwenClientExpression(expression)(h.sink, env));
      assert.equal(result.failed, true); assert.ok(result.reason instanceof TypeError);
    }
  }
  let subscriptions = 0;
  const original = { get then() { subscriptions++; throw new Error("must not subscribe"); } };
  const h = qwenValueHarness(), env = { options: {}, getProviderTransportDispatcherPool: () => ({}),
    fetchWithSsrFGuard: () => original };
  assert.equal(qwenGuardExpression(guardValueExpression)(h.sink, env), original);
  assert.equal(subscriptions, 0); assert.equal(h.claim.snapshot(h.invocation)[8], 3);
  assert.deepEqual(h.claim.close(), []);
});

test("Qwen dispatcher callee, spread, pool and receiver order remains original", () => {
  const run = observed => {
    const h = qwenValueHarness(), trace = [], pool = {}, promise = Promise.resolve("synthetic");
    const env = {
      get fetchWithSsrFGuard() { trace.push("callee_get"); return function (options) {
        trace.push("guard_call"); assert.equal(this, env); assert.equal(options.dispatcherPool, pool); return promise;
      }; },
      get options() { trace.push("options_get"); return { get url() { trace.push("spread_url"); return "synthetic"; },
        get dispatcherPool() { trace.push("spread_old_pool"); return null; } }; },
      get getProviderTransportDispatcherPool() { trace.push("pool_get"); return () => { trace.push("pool_call"); return pool; }; },
    };
    const result = qwenGuardExpression(observed ? guardValueExpression : guardValueAnchor)(h.sink, env);
    assert.equal(result, promise); assert.deepEqual(h.claim.close(), []);
    return trace;
  };
  assert.deepEqual(run(true), run(false));
  assert.deepEqual(run(true), ["callee_get", "options_get", "spread_url", "spread_old_pool", "pool_get", "pool_call", "guard_call"]);
});

test("Qwen evaluation entry catches hidden reentry before the first outer tap", () => {
  const h = qwenValueHarness(), returned = Promise.resolve("inner");
  const run = qwenGuardExpression(guardValueExpression);
  const inner = { options: {}, getProviderTransportDispatcherPool: () => ({}), fetchWithSsrFGuard: () => returned };
  let innerResult, outerCalls = 0;
  const outer = { get options() {
    return { get url() { innerResult = run(h.sink, inner); throw undefined; } };
  }, getProviderTransportDispatcherPool: () => ({}), fetchWithSsrFGuard() { outerCalls++; } };
  const failure = qwenCaught(() => run(h.sink, outer));
  assert.equal(failure.failed, true); assert.equal(failure.reason, undefined);
  assert.equal(innerResult, returned); assert.equal(outerCalls, 0);
  assert.equal(h.claim.snapshot(h.invocation), null); assert.deepEqual(h.claim.close(), []);
  // Both finally blocks retired: a distinct next case records normally.
  const next = {}, claim = h.sink.claim(h.contract, 2, () => next); claim.bind(next);
  assert.equal(run(h.sink, inner), returned); assert.equal(claim.snapshot(next)[8], 3);
  assert.deepEqual(claim.close(), []);
  for (const site of ["lookup", "build"]) {
    const x = qwenValueHarness(); let nested = false;
    const runClient = qwenClientExpression(clientValueExpression);
    const env = { OpenAI: function (v) { return v; }, apiKey: "", baseURL: "", defaultHeaders: {},
      hook: v => v, onResponse: undefined, model: {}, globalThis: {},
      getAiTransportHost() {
        if (!nested && site === "lookup") { nested = true; runClient(x.sink, env); throw undefined; }
        return { buildModelFetch() {
          if (!nested && site === "build") { nested = true; runClient(x.sink, env); throw undefined; }
          return false;
        } };
      } };
    const result = qwenCaught(() => runClient(x.sink, env));
    assert.equal(result.failed, true); assert.equal(result.reason, undefined);
    assert.equal(x.claim.snapshot(x.invocation), null); assert.deepEqual(x.claim.close(), []);
  }
});

test("Qwen sink faults are nonthrowing and retained after original falsey failures", async () => {
  for (const failingRead of [1, 4]) {
    let reads = 0, calls = 0;
    const invocation = {}, h = qwenValueHarness(() => { if (++reads === failingRead) throw undefined; return invocation; });
    h.claim.bind(invocation);
    const returned = Object.freeze({});
    const env = { options: {}, getProviderTransportDispatcherPool: () => ({}), fetchWithSsrFGuard() { calls++; return returned; } };
    assert.equal(qwenGuardExpression(guardValueExpression)(h.sink, env), returned);
    assert.equal(calls, 1); assert.equal(h.claim.snapshot(invocation), null);
    const errors = h.claim.close(); assert.deepEqual(errors, [undefined]);
    const failure = await finish(() => { throw false; }, [() => { throw new AggregateError(errors, "synthetic reporting"); }])
      .then(() => assert.fail("must reject"), error => error);
    assert.equal(failure.errors[0], false); assert.deepEqual(failure.errors[1].errors, [undefined]);
  }
  const missing = createQwenValueSink("a".repeat(64)), result = {};
  assert.equal(missing.result(missing.begin(2), result), result); missing.finish(null);
  const foreign = qwenValueHarness(), token = foreign.sink.begin(2);
  assert.equal(foreign.sink.argument({}, result), result); foreign.sink.finish(token);
  assert.equal(foreign.claim.snapshot(foreign.invocation), null); foreign.claim.close();
});

test("Qwen nonce activation, duplicate, late and interleaved evaluations stay UNKNOWN", () => {
  for (const corrupt of ["activation", "foreign", "duplicate", "late", "interleaved", "partial"]) {
    const h = qwenValueHarness(), value = {};
    if (corrupt === "activation") h.sink.activate(1, h.contract);
    if (corrupt === "foreign") h.sink.activate(2, "b".repeat(64));
    const token = h.sink.begin(2);
    h.sink.argument(token, value);
    if (corrupt !== "partial") h.sink.result(token, value);
    if (corrupt === "interleaved") { const inner = h.sink.begin(1); h.sink.finish(inner); }
    h.sink.finish(token);
    if (corrupt === "duplicate") { const extra = h.sink.begin(2); h.sink.finish(extra); }
    if (corrupt === "late") h.sink.result(token, value);
    assert.equal(h.claim.snapshot(h.invocation), null); h.claim.close();
  }
});

test("Qwen value taps do not inspect objects or add ledger operations, ticks or drains", async () => {
  const run = async observed => {
    const h = qwenValueHarness(), ledger = createQwenLedger(), trace = [];
    let propertyReads = 0, subscriptions = 0;
    const value = new Proxy({}, { get() { propertyReads++; throw undefined; }, getPrototypeOf() { throw undefined; } });
    // Construct the promise without assimilating the hostile value.
    const pending = Promise.resolve("synthetic");
    const then = pending.then;
    Object.defineProperty(pending, "then", { value: function (...args) { subscriptions++; return Reflect.apply(then, this, args); } });
    const env = { options: {}, getProviderTransportDispatcherPool: () => value,
      fetchWithSsrFGuard() { trace.push("guard"); return pending; } };
    const result = qwenGuardExpression(observed ? guardValueExpression : guardValueAnchor)(h.sink, env);
    assert.equal(result, pending);
    const original = ledger.observe("caller", result);
    ledger.follow("caller_observer", original, [() => { trace.push("observer"); }]);
    queueMicrotask(() => trace.push("tick"));
    await ledger.drain(); ledger.restore(); await ledger.drain(); ledger.seal();
    assert.deepEqual(h.claim.close(), []);
    return { trace, propertyReads, subscriptions, operations: ledger.operations.map(row => [row.kind, row.state]),
      observers: ledger.observers.length, readers: ledger.readers.length };
  };
  assert.deepEqual(await run(true), await run(false));
});

test("Qwen v4 value grammar stays bounded and rejects forged associations", () => {
  const base = { v: 3, kind: "observer_failure", case: rows[0].id, parent: 1, observer: 2,
    site: 4, seen: 1, truthy: 1, receipt: false, acquisition: false, parentState: "fulfilled",
    failurePresent: true, reasonDefined: true, route: [1,0,0,0,0,0,0,0,0], callable: [1,0,0,0,0,0,1] };
  for (const branch of [1, 2]) for (const type of [1,2,3,4,5,6,7,8,9]) {
    if (branch === 1 && type <= 2) continue;
    const row = { ...base, v: 4, values: [1, "a".repeat(64), 206, 7, branch === 1 ? 11 : 15, branch, type, 8, 3, 3, 0] };
    assert.deepEqual(qwenObserverRecord(row), row);
    assert.ok(Buffer.byteLength("QWEN_OBSERVER_V1 " + JSON.stringify(row)) <= 768);
    assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(row)) <= 768);
  }
  for (const change of [v => v[10] = 1, v => v[9] = 1, v => v[4] = 3, v => v[7] = v[3],
    v => v[2] = 207, v => v[1] = "foreign", v => v.push(0), v => v.length = 12, v => v.length = 0xffffffff]) {
    const values = [1, "a".repeat(64), 1, 1, 11, 1, 9, 2, 3, 3, 0]; change(values);
    const malformed = { ...base, v: 4, values };
    assert.throws(() => qwenObserverRecord(malformed));
    assert.throws(() => qwenBoundaryAnnotation(qwenObserverRecord(malformed)));
  }
  let reads = 0;
  const values = new Proxy([], { ownKeys() { reads++; throw undefined; } });
  assert.throws(() => qwenObserverRecord({ ...base, v: 4, values })); assert.equal(reads, 0);
});

const qwenValueOriginals = [
  "import OpenAI from \"openai\";\nimport { getAiTransportHost } from \"../host.js\";\nimport {\n  resolveOpenAIClientBaseUrl,\n  withOpenAIErrorResponseHook,\n} from \"../transports/openai-transport-shared.js\";\nimport type { Model, ModelRequestHeaders, StreamOptions } from \"../types.js\";\nimport { isCloudflareProvider, resolveCloudflareBaseUrl } from \"./cloudflare.js\";\n\nexport function createOpenAIProviderClient(\n  model: Model<\"openai-completions\" | \"openai-responses\">,\n  apiKey: string,\n  headers: ModelRequestHeaders,\n  optionsHeaders?: ModelRequestHeaders,\n  onResponse?: StreamOptions[\"onResponse\"],\n): OpenAI {\n  // Merge options headers last so they can override defaults\n  if (optionsHeaders) {\n    Object.assign(headers, optionsHeaders);\n  }\n\n  const defaultHeaders =\n    model.provider === \"cloudflare-ai-gateway\"\n      ? {\n          ...headers,\n          Authorization: headers.Authorization ?? null,\n          \"cf-aig-authorization\": `Bearer ${apiKey}`,\n        }\n      : headers;\n\n  const baseUrl = isCloudflareProvider(model.provider)\n    ? resolveCloudflareBaseUrl(model)\n    : model.baseUrl;\n  return new OpenAI({\n    apiKey,\n    baseURL: resolveOpenAIClientBaseUrl(model, baseUrl),\n    dangerouslyAllowBrowser: true,\n    defaultHeaders,\n    maxRetries: 0,\n    // OpenAI supports custom fetch, so sentinels stay opaque until guarded egress.\n    fetch: withOpenAIErrorResponseHook(\n      getAiTransportHost().buildModelFetch(model) ?? globalThis.fetch,\n      onResponse,\n      model,\n    ),\n  });\n}\n",
  "import {\n  fetchWithSsrFGuard,\n  type GuardedFetchOptions,\n  type GuardedFetchResult,\n} from \"../infra/net/fetch-guard.js\";\nimport { PinnedDispatcherPool } from \"../infra/net/pinned-dispatcher-pool.js\";\nimport { setProviderTransportDispatcherPoolActive } from \"./provider-runtime-lifecycle.js\";\n\nlet activePool: PinnedDispatcherPool | undefined;\n\n/** Reuse provider connections without exposing their lifecycle-owned pool to callers. */\nexport function fetchWithProviderHttpGuard(\n  options: Omit<GuardedFetchOptions, \"dispatcherPool\">,\n): Promise<GuardedFetchResult> {\n  return fetchWithSsrFGuard({\n    ...options,\n    dispatcherPool: getProviderTransportDispatcherPool(),\n  });\n}\n\n/** Returns the current process-lifecycle provider dispatcher pool generation. */\nfunction getProviderTransportDispatcherPool(): PinnedDispatcherPool {\n  if (!activePool) {\n    activePool = new PinnedDispatcherPool();\n    setProviderTransportDispatcherPoolActive(true);\n  }\n  return activePool;\n}\n\n/** Closes the current generation while allowing an in-process Gateway restart to create another. */\nexport async function closeProviderTransportDispatcherPool(): Promise<void> {\n  const pool = activePool;\n  if (pool) {\n    await pool.closeAll();\n    if (activePool === pool) {\n      activePool = undefined;\n      setProviderTransportDispatcherPoolActive(false);\n    }\n  }\n}\n",
  "// This facade owns the process-default AI runtime wiring: it installs the\n// OpenClaw host policy ports and registers built-in providers exactly once,\n// before any caller imports the stream API.\nimport { defaultApiRegistry, defaultLlmRuntime } from \"@openclaw/ai/internal/runtime\";\nimport { registerBuiltInApiProviders } from \"@openclaw/ai/providers\";\nimport { makeZeroUsageSnapshot } from \"../agents/usage.js\";\nimport { POSTGRES_QUERY_CANCELED_ERROR_NAME } from \"../infra/postgres-sync/protocol.js\";\nimport { classifyGatewayStorageFailure } from \"../infra/sqlite-error-diagnostics.js\";\nimport { hasSqliteWorkerOutcomeUnknown } from \"../infra/sqlite-worker-error.js\";\nimport { assertProviderAuthAuthority } from \"../plugins/provider-auth-authority.js\";\nimport { runInDetachedAsyncContext } from \"../shared/detached-async-context.js\";\nimport { createLazyPromise } from \"../shared/lazy-promise.js\";\nimport { getModelLlmRuntime } from \"./model-runtime-binding.js\";\nimport { getModelTransportContext } from \"./model-transport-context.js\";\nimport { createProviderRateLimitRequest } from \"./provider-rate-limit.js\";\nimport \"./ai-transport-host.js\";\nimport type {\n  Api,\n  AssistantMessage,\n  AssistantMessageEventStreamContract,\n  Context,\n  Model,\n  ProviderStreamOptions,\n  SimpleStreamOptions,\n} from \"./types.js\";\nimport { createAssistantMessageEventStream } from \"./utils/event-stream.js\";\n\nregisterBuiltInApiProviders(defaultApiRegistry);\n\n// The process host outlives requests; only provider invocation carries caller authority.\nconst ensureTransportRuntimeHost = createLazyPromise(\n  () => runInDetachedAsyncContext(() => import(\"../agents/ai-transport-runtime-host.js\")),\n  { cacheRejections: true },\n);\n\nfunction createRuntimeHostErrorMessage(model: Model, error: unknown): AssistantMessage {\n  // A message cannot retain the error graph, so preserve its strongest continuation fence.\n  const storageFailure = hasSqliteWorkerOutcomeUnknown(error)\n    ? \"session_actor_reconciliation\"\n    : classifyGatewayStorageFailure(error);\n  return {\n    role: \"assistant\",\n    content: [],\n    api: model.api,\n    provider: model.provider,\n    model: model.id,\n    usage: makeZeroUsageSnapshot(),\n    stopReason: \"error\",\n    errorMessage: error instanceof Error ? error.message : String(error),\n    errorCode: storageFailure,\n    errorType:\n      storageFailure === \"57014\"\n        ? POSTGRES_QUERY_CANCELED_ERROR_NAME\n        : storageFailure === \"unavailable\"\n          ? \"SqliteWorkerError\"\n          : undefined,\n    timestamp: Date.now(),\n  };\n}\n\nfunction deferUntilTransportRuntimeHost<T extends SimpleStreamOptions>(\n  model: Model,\n  start: (options: T) => AssistantMessageEventStreamContract,\n  options: T,\n): AssistantMessageEventStreamContract {\n  const output = createAssistantMessageEventStream();\n  const admission = createProviderRateLimitRequest(model, options);\n  const transportContext = getModelTransportContext();\n  void (async () => {\n    try {\n      await ensureTransportRuntimeHost();\n      await admission.wait(transportContext?.onRateLimitWait, transportContext?.priority);\n      assertProviderAuthAuthority(model);\n      options?.signal?.throwIfAborted();\n      for await (const event of start(admission.options)) {\n        if (event.type === \"error\") {\n          admission.observe?.(event.error);\n        }\n        output.push(event);\n      }\n    } catch (error) {\n      const message = createRuntimeHostErrorMessage(model, error);\n      output.push({ type: \"error\", reason: \"error\", error: message });\n    } finally {\n      output.end();\n    }\n  })();\n  return output;\n}\n\nfunction resolveRuntime(model: Model) {\n  return getModelLlmRuntime(model) ?? defaultLlmRuntime;\n}\n\nexport function stream<TApi extends Api>(\n  model: Model<TApi>,\n  context: Context,\n  options?: ProviderStreamOptions,\n): AssistantMessageEventStreamContract {\n  return deferUntilTransportRuntimeHost(\n    model,\n    (admittedOptions) => resolveRuntime(model).stream(model, context, admittedOptions),\n    options ?? {},\n  );\n}\n\nexport async function complete<TApi extends Api>(\n  model: Model<TApi>,\n  context: Context,\n  options?: ProviderStreamOptions,\n  assertCurrent?: () => void,\n): Promise<AssistantMessage> {\n  await ensureTransportRuntimeHost();\n  const admission = createProviderRateLimitRequest(model, options ?? {});\n  const transportContext = getModelTransportContext();\n  await admission.wait(transportContext?.onRateLimitWait, transportContext?.priority);\n  assertCurrent?.();\n  assertProviderAuthAuthority(model);\n  options?.signal?.throwIfAborted();\n  const result = await resolveRuntime(model).complete(model, context, admission.options);\n  admission.observe?.(result);\n  return result;\n}\n\nexport function streamSimple<TApi extends Api>(\n  model: Model<TApi>,\n  context: Context,\n  options?: SimpleStreamOptions,\n): AssistantMessageEventStreamContract {\n  return deferUntilTransportRuntimeHost(\n    model,\n    (admittedOptions) => resolveRuntime(model).streamSimple(model, context, admittedOptions),\n    options ?? {},\n  );\n}\n\nexport async function completeSimple<TApi extends Api>(\n  model: Model<TApi>,\n  context: Context,\n  options?: SimpleStreamOptions,\n  assertCurrent?: () => void,\n): Promise<AssistantMessage> {\n  await ensureTransportRuntimeHost();\n  const admission = createProviderRateLimitRequest(model, options ?? {});\n  const transportContext = getModelTransportContext();\n  await admission.wait(transportContext?.onRateLimitWait, transportContext?.priority);\n  // Runtime setup can outlive its caller. Admit only a current request to the provider.\n  assertCurrent?.();\n  assertProviderAuthAuthority(model);\n  options?.signal?.throwIfAborted();\n  const result = await resolveRuntime(model).completeSimple(model, context, admission.options);\n  admission.observe?.(result);\n  return result;\n}\n",
  "import type {\n  Api,\n  AssistantMessage,\n  AssistantMessageEvent,\n  AssistantMessageEventStreamContract,\n  Context,\n  Model,\n  ProviderStreamOptions,\n  SimpleStreamOptions,\n  StreamOptions,\n} from \"@openclaw/llm-core\";\nimport {\n  bindAssistantMessageEventStream,\n  getEventStreamCompletion,\n} from \"@openclaw/llm-core/event-stream\";\nimport { createApiRegistry, type ApiRegistry } from \"./api-registry.js\";\nimport {\n  createAiTransportHost,\n  getDefaultAiTransportHost,\n  runWithAiTransportHost,\n  supportsScopedAiTransportHosts,\n  type AiTransportHost,\n} from \"./host.js\";\nimport { cleanupSessionResources as cleanupRegisteredSessionResources } from \"./session-resources.js\";\n\nfunction retainUnscopedStreamLifetime(\n  stream: AssistantMessageEventStreamContract,\n  runWithHost: <T>(operation: () => T) => T,\n): AssistantMessageEventStreamContract {\n  let releaseLifetime!: () => void;\n  const lifetime = new Promise<void>((resolve) => {\n    releaseLifetime = resolve;\n  });\n  void runWithHost(() => lifetime);\n  let resultSettled = false;\n  let bufferSettled = false;\n  const releaseIfSettled = () => {\n    if (resultSettled && bufferSettled) {\n      releaseLifetime();\n    }\n  };\n  const push = stream.push.bind(stream);\n  const end = stream.end.bind(stream);\n  const result = stream.result.bind(stream);\n  const iterate = stream[Symbol.asyncIterator].bind(stream);\n  const bufferedEvents: AssistantMessageEvent[] = [];\n  const bufferWaiters = new Set<() => void>();\n  let bufferError: Error | undefined;\n  let resultPromise: ReturnType<typeof result> | undefined;\n  const notifyBufferWaiters = () => {\n    for (const resolve of bufferWaiters) {\n      resolve();\n    }\n    bufferWaiters.clear();\n  };\n  const observeResult = () => {\n    if (!resultPromise) {\n      let providerResult: ReturnType<typeof result>;\n      try {\n        providerResult = runWithHost(result);\n      } catch (error) {\n        providerResult = Promise.reject(new Error(\"Stream result failed\", { cause: error }));\n      }\n      const settleResult = () => {\n        resultSettled = true;\n        releaseIfSettled();\n      };\n      void providerResult.then(settleResult, settleResult);\n      resultPromise = providerResult;\n    }\n    return resultPromise;\n  };\n  void (async () => {\n    try {\n      const iterator = runWithHost(iterate);\n      while (true) {\n        const next = await runWithHost(() => iterator.next());\n        if (next.done) {\n          return;\n        }\n        bufferedEvents.push(next.value);\n        notifyBufferWaiters();\n      }\n    } catch (error) {\n      bufferError = new Error(\"Stream iteration failed\", { cause: error });\n    } finally {\n      bufferSettled = true;\n      notifyBufferWaiters();\n      void observeResult().catch(() => {});\n      releaseIfSettled();\n    }\n  })();\n  return {\n    push: (event) => runWithHost(() => push(event)),\n    end: (message) => runWithHost(() => end(message)),\n    result: observeResult,\n    [Symbol.asyncIterator]() {\n      let index = 0;\n      let done = false;\n      const next = async (): Promise<IteratorResult<AssistantMessageEvent>> => {\n        if (done) {\n          return { done: true, value: undefined };\n        }\n        if (index < bufferedEvents.length) {\n          const value = bufferedEvents[index];\n          if (value === undefined) {\n            throw new Error(\"Buffered stream event is missing\");\n          }\n          index += 1;\n          return { done: false, value };\n        }\n        if (bufferSettled) {\n          if (bufferError) {\n            throw bufferError;\n          }\n          done = true;\n          return { done: true, value: undefined };\n        }\n        await new Promise<void>((resolve) => {\n          bufferWaiters.add(resolve);\n        });\n        return next();\n      };\n      return {\n        [Symbol.asyncIterator]() {\n          return this;\n        },\n        next,\n        async return(value?: unknown) {\n          done = true;\n          notifyBufferWaiters();\n          return { done: true as const, value };\n        },\n      };\n    },\n  };\n}\n\nfunction createRuntime(registry: ApiRegistry, transportHost?: Partial<AiTransportHost>) {\n  const explicitHost =\n    transportHost === undefined ? undefined : createAiTransportHost(transportHost);\n  const resolveRuntimeHost = () => explicitHost ?? getDefaultAiTransportHost();\n  const startStream = (start: () => AssistantMessageEventStreamContract) => {\n    const host = resolveRuntimeHost();\n    const runWithStreamHost = <T>(operation: () => T): T => runWithAiTransportHost(host, operation);\n    const started = runWithStreamHost(start);\n    const completion = getEventStreamCompletion(started);\n    const bound = bindAssistantMessageEventStream(started, runWithStreamHost);\n    if (completion) {\n      if (!supportsScopedAiTransportHosts()) {\n        let producerSettled = false;\n        const observedCompletion = completion.finally(() => {\n          producerSettled = true;\n        });\n        void runWithStreamHost(() => observedCompletion);\n        const result = runWithStreamHost(() => started.result());\n        return bindAssistantMessageEventStream(\n          started,\n          (operation) => (producerSettled ? operation() : runWithStreamHost(operation)),\n          {\n            result: () => result,\n          },\n        );\n      }\n      void runWithStreamHost(() => completion);\n    }\n    return !completion && !supportsScopedAiTransportHosts()\n      ? retainUnscopedStreamLifetime(started, runWithStreamHost)\n      : bound;\n  };\n  function resolveApiProvider(api: Api) {\n    const provider = registry.getApiProvider(api);\n    if (!provider) {\n      throw new Error(`No API provider registered for api: ${api}`);\n    }\n    return provider;\n  }\n\n  function stream<TApi extends Api>(\n    model: Model<TApi>,\n    context: Context,\n    options?: ProviderStreamOptions,\n  ): AssistantMessageEventStreamContract {\n    return startStream(() =>\n      resolveApiProvider(model.api).stream(model, context, options as StreamOptions),\n    );\n  }\n\n  async function complete<TApi extends Api>(\n    model: Model<TApi>,\n    context: Context,\n    options?: ProviderStreamOptions,\n  ): Promise<AssistantMessage> {\n    return stream(model, context, options).result();\n  }\n\n  function streamSimple<TApi extends Api>(\n    model: Model<TApi>,\n    context: Context,\n    options?: SimpleStreamOptions,\n  ): AssistantMessageEventStreamContract {\n    return startStream(() => resolveApiProvider(model.api).streamSimple(model, context, options));\n  }\n\n  async function completeSimple<TApi extends Api>(\n    model: Model<TApi>,\n    context: Context,\n    options?: SimpleStreamOptions,\n  ): Promise<AssistantMessage> {\n    return streamSimple(model, context, options).result();\n  }\n\n  function cleanupSessionResources(sessionId?: string): void {\n    if (!supportsScopedAiTransportHosts()) {\n      cleanupRegisteredSessionResources(sessionId);\n      return;\n    }\n    const host = resolveRuntimeHost();\n    try {\n      runWithAiTransportHost(host, () => cleanupRegisteredSessionResources(sessionId, host));\n    } catch (error) {\n      throw new AggregateError([error], \"Failed to cleanup runtime session resources\", {\n        cause: error,\n      });\n    }\n  }\n\n  return {\n    registry,\n    stream,\n    complete,\n    streamSimple,\n    completeSimple,\n    cleanupSessionResources,\n  };\n}\n\n/** Creates an isolated LLM runtime backed by the supplied provider registry. */\nexport function createLlmRuntime(registry: ApiRegistry = createApiRegistry()) {\n  return createRuntime(registry);\n}\n\n/** Creates a Node runtime whose provider work retains an explicit transport host. */\nexport function createNodeLlmRuntime(\n  registry: ApiRegistry = createApiRegistry(),\n  transportHost: Partial<AiTransportHost> = {},\n) {\n  if (!supportsScopedAiTransportHosts()) {\n    throw new Error(\"Explicit AI transport hosts require Node.js async context support\");\n  }\n  return createRuntime(registry, transportHost);\n}\n\nexport type LlmRuntime = ReturnType<typeof createLlmRuntime>;\n",
  "import type {\n  Api,\n  Model,\n  SimpleStreamOptions,\n  StreamFunction,\n  StreamOptions,\n} from \"@openclaw/llm-core\";\n\n/** Runtime stream adapter signature stored in the API provider registry. */\nexport type ApiStreamFunction = StreamFunction;\n\n/** Runtime simple-stream adapter signature stored in the API provider registry. */\nexport type ApiStreamSimpleFunction = StreamFunction<Api, SimpleStreamOptions>;\n\n/** Provider implementation registered by core or plugins for a specific model API. */\nexport interface ApiProvider<\n  TApi extends Api = Api,\n  TOptions extends StreamOptions = StreamOptions,\n> {\n  /** Model API id this provider handles. */\n  api: TApi;\n  /** Full streaming adapter for callers that already own structured options. */\n  stream: StreamFunction<TApi, TOptions>;\n  /** Simple streaming adapter used by agent and plugin runtime defaults. */\n  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;\n}\n\n/** Type-erased provider returned by a registry after API guards are installed. */\nexport interface RegisteredApiProvider {\n  api: Api;\n  stream: ApiStreamFunction;\n  streamSimple: ApiStreamSimpleFunction;\n}\n\nfunction wrapStream<TApi extends Api, TOptions extends StreamOptions>(\n  api: TApi,\n  stream: StreamFunction<TApi, TOptions>,\n): ApiStreamFunction {\n  return (model, context, options) => {\n    if (model.api !== api) {\n      throw new Error(`Mismatched api: ${model.api} expected ${api}`);\n    }\n    return stream(model as Model<TApi>, context, options as TOptions);\n  };\n}\n\n/** Creates an isolated provider registry for one runtime or tenant. */\nexport function createApiRegistry() {\n  const providers = new Map<string, { provider: RegisteredApiProvider; sourceId?: string }>();\n\n  function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(\n    provider: ApiProvider<TApi, TOptions>,\n    /** Optional source id used to unregister all providers owned by one plugin/runtime. */\n    sourceId?: string,\n  ): void {\n    providers.set(provider.api, {\n      provider: {\n        api: provider.api,\n        stream: wrapStream(provider.api, provider.stream),\n        streamSimple: wrapStream(provider.api, provider.streamSimple),\n      },\n      sourceId,\n    });\n  }\n\n  function getApiProvider(api: Api): RegisteredApiProvider | undefined {\n    return providers.get(api)?.provider;\n  }\n\n  function getApiProviders(): RegisteredApiProvider[] {\n    return Array.from(providers.values(), (entry) => entry.provider);\n  }\n\n  function unregisterApiProviders(sourceId: string): void {\n    for (const [api, entry] of providers.entries()) {\n      if (entry.sourceId === sourceId) {\n        providers.delete(api);\n      }\n    }\n  }\n\n  return {\n    registerApiProvider,\n    getApiProvider,\n    getApiProviders,\n    unregisterApiProviders,\n    clearApiProviders: () => providers.clear(),\n  };\n}\n\nexport type ApiRegistry = ReturnType<typeof createApiRegistry>;\n",
  "// Built-in provider registration installs lazy protocol adapters.\nimport type { ApiProvider, ApiRegistry } from \"../api-registry.js\";\nimport type {\n  Api,\n  AssistantMessage,\n  SimpleStreamOptions,\n  StreamFunction,\n  StreamOptions,\n} from \"../types.js\";\nimport { AssistantMessageEventStream } from \"../utils/event-stream.js\";\nimport { projectProviderError, type ProviderErrorProjection } from \"../utils/provider-error.js\";\nimport { createZeroUsage } from \"../utils/usage.js\";\n\ntype ProviderStreams<TApi extends Api, TOptions extends StreamOptions> = Omit<\n  ApiProvider<TApi, TOptions>,\n  \"api\"\n>;\n\ntype RegisterBuiltIn = (registry: ApiRegistry) => void;\n\n/** Source id used for built-in API provider registrations. */\nexport const BUILT_IN_API_PROVIDER_SOURCE_ID = \"core:built-in\";\n\n// Provider modules load on first use, while callers still receive a stream synchronously.\nfunction createLazyStream<TApi extends Api, TOptions extends StreamOptions, TStreams>(\n  load: () => Promise<TStreams>,\n  select: (streams: TStreams) => StreamFunction<TApi, TOptions>,\n): StreamFunction<TApi, TOptions> {\n  return (model, context, options) => {\n    const outer = new AssistantMessageEventStream();\n    load()\n      .then(async (streams) => {\n        for await (const event of select(streams)(model, context, options)) {\n          outer.push(event);\n        }\n        outer.end();\n      })\n      .catch((error: unknown) => {\n        const lazyLoadSignal = options?.signal;\n        const message: AssistantMessage & ProviderErrorProjection = {\n          role: \"assistant\",\n          content: [],\n          api: model.api,\n          provider: model.provider,\n          model: model.id,\n          usage: createZeroUsage(),\n          ...projectProviderError(error, lazyLoadSignal),\n          timestamp: Date.now(),\n        };\n        outer.push({ type: \"error\", reason: message.stopReason, error: message });\n        outer.end(message);\n      });\n    return outer;\n  };\n}\n\nfunction createLazyRegistration<TApi extends Api, TOptions extends StreamOptions, TModule>(\n  api: TApi,\n  importModule: () => Promise<TModule>,\n  select: (module: TModule) => ProviderStreams<TApi, TOptions>,\n): RegisterBuiltIn {\n  let streamsPromise: Promise<ProviderStreams<TApi, TOptions>> | undefined;\n  const load = () => (streamsPromise ??= importModule().then(select));\n  const stream = createLazyStream(load, (streams) => streams.stream);\n  const streamSimple = createLazyStream<TApi, SimpleStreamOptions, ProviderStreams<TApi, TOptions>>(\n    load,\n    (streams) => streams.streamSimple,\n  );\n  return (registry) => {\n    registry.registerApiProvider({ api, stream, streamSimple }, BUILT_IN_API_PROVIDER_SOURCE_ID);\n  };\n}\n\nconst registerBuiltIns: RegisterBuiltIn[] = [\n  // Registration is transport-free; each lazy adapter owns its fetch or construction unwrap.\n  createLazyRegistration(\n    \"anthropic-messages\",\n    () => import(\"./anthropic.js\"),\n    (module) => ({ stream: module.streamAnthropic, streamSimple: module.streamSimpleAnthropic }),\n  ),\n  createLazyRegistration(\n    \"openai-completions\",\n    () => import(\"./openai-completions.js\"),\n    (module) => ({\n      stream: module.streamOpenAICompletions,\n      streamSimple: module.streamSimpleOpenAICompletions,\n    }),\n  ),\n  createLazyRegistration(\n    \"mistral-conversations\",\n    () => import(\"./mistral.js\"),\n    (module) => ({ stream: module.streamMistral, streamSimple: module.streamSimpleMistral }),\n  ),\n  createLazyRegistration(\n    \"openai-responses\",\n    () => import(\"./openai-responses.js\"),\n    (module) => ({\n      stream: module.streamOpenAIResponses,\n      streamSimple: module.streamSimpleOpenAIResponses,\n    }),\n  ),\n  createLazyRegistration(\n    \"azure-openai-responses\",\n    () => import(\"./azure-openai-responses.js\"),\n    (module) => ({\n      stream: module.streamAzureOpenAIResponses,\n      streamSimple: module.streamSimpleAzureOpenAIResponses,\n    }),\n  ),\n  createLazyRegistration(\n    \"openai-chatgpt-responses\",\n    () => import(\"./openai-chatgpt-responses.js\"),\n    (module) => ({\n      stream: module.streamOpenAICodexResponses,\n      streamSimple: module.streamSimpleOpenAICodexResponses,\n    }),\n  ),\n  createLazyRegistration(\n    \"google-generative-ai\",\n    () => import(\"./google.js\"),\n    (module) => ({ stream: module.streamGoogle, streamSimple: module.streamSimpleGoogle }),\n  ),\n  createLazyRegistration(\n    \"google-interactions\",\n    () => import(\"./google-interactions.js\"),\n    (module) => ({\n      stream: module.streamGoogleInteractions,\n      streamSimple: module.streamSimpleGoogleInteractions,\n    }),\n  ),\n  createLazyRegistration(\n    \"google-vertex\",\n    () => import(\"./google-vertex.js\"),\n    (module) => ({\n      stream: module.streamGoogleVertex,\n      streamSimple: module.streamSimpleGoogleVertex,\n    }),\n  ),\n];\n\n/** Registers every built-in API provider in one runtime registry. */\nexport function registerBuiltInApiProviders(registry: ApiRegistry): void {\n  for (const register of registerBuiltIns) {\n    register(registry);\n  }\n}\n\n/** Restores the built-in provider registry state for tests. */\nexport function resetApiProviders(registry: ApiRegistry): void {\n  registry.unregisterApiProviders(BUILT_IN_API_PROVIDER_SOURCE_ID);\n  registerBuiltInApiProviders(registry);\n}\n",
  "import { clampThinkingLevel } from \"../model-utils.js\";\nimport type { OpenAICompletionsOptions } from \"../provider-options.js\";\nimport { streamOpenAICompletionsRequest } from \"../transports/openai-completions-transport.js\";\nimport type { SimpleStreamOptions, StreamFunction } from \"../types.js\";\nimport { requireApiKey } from \"../utils/required-api-key.js\";\nimport { buildBaseOptions } from \"./simple-options.js\";\n\nexport type { OpenAICompletionsOptions } from \"../provider-options.js\";\nexport { convertMessages } from \"../openai-completions-messages.js\";\n\ntype OpenAIThinkingProvenanceOptions = OpenAICompletionsOptions & {\n  openclawThinkingExplicit?: boolean;\n};\n\nexport const streamOpenAICompletions: StreamFunction<\n  \"openai-completions\",\n  OpenAICompletionsOptions\n> = (model, context, options) => streamOpenAICompletionsRequest(model, context, options, \"direct\");\n\nexport const streamSimpleOpenAICompletions: StreamFunction<\n  \"openai-completions\",\n  SimpleStreamOptions\n> = (model, context, options) => {\n  const apiKey = requireApiKey(model.provider, options?.apiKey);\n\n  const base = buildBaseOptions(model, options, apiKey);\n  const clampedReasoning = options?.reasoning\n    ? clampThinkingLevel(model, options.reasoning)\n    : undefined;\n  // Host session streams attach selection intent without changing the public provider options.\n  const completionsOptions = options as OpenAIThinkingProvenanceOptions | undefined;\n\n  const providerOptions = {\n    ...base,\n    reasoningEffort: clampedReasoning,\n    toolChoice: completionsOptions?.toolChoice,\n    streaming: completionsOptions?.streaming,\n    openclawThinkingExplicit:\n      completionsOptions?.openclawThinkingExplicit ?? options?.reasoning !== undefined,\n  } satisfies OpenAIThinkingProvenanceOptions;\n  return streamOpenAICompletions(model, context, providerOptions);\n};\n",
  "import type { AgentMessage } from \"../../packages/agent-core/src/types.js\";\nimport { warnSessionPersistenceDeprecation } from \"../agents/sessions/session-persistence-deprecation.js\";\nimport {\n  ensureProviderRuntimePluginHandle,\n  resolveProviderRuntimePlugin,\n  type ProviderRuntimePluginHandle,\n} from \"./provider-hook-runtime.js\";\nimport type {\n  ProviderReasoningOutputMode,\n  ProviderReasoningOutputModeContext,\n  ProviderSanitizeReplayHistoryContextV2,\n  ProviderValidateReplayTurnsContext,\n} from \"./provider-replay.types.js\";\n\ntype ProviderReplayRuntimeLookup = Pick<\n  Parameters<typeof resolveProviderRuntimePlugin>[0],\n  \"provider\" | \"config\" | \"workspaceDir\" | \"env\"\n>;\n\n/** Prefer worker-backed hooks; retain the legacy hook solely for third-party providers. */\nexport async function sanitizeProviderReplayHistoryWithPluginAsync(\n  params: ProviderReplayRuntimeLookup & { context: ProviderSanitizeReplayHistoryContextV2 },\n) {\n  const plugin = resolveProviderRuntimePlugin(params);\n  if (plugin?.sanitizeReplayHistoryAsync) {\n    return await plugin.sanitizeReplayHistoryAsync(params.context);\n  }\n  if (plugin?.sanitizeReplayHistory) {\n    warnSessionPersistenceDeprecation(\n      \"ProviderPlugin.sanitizeReplayHistory\",\n      \"sanitizeReplayHistoryAsync\",\n      plugin.pluginId ? { pluginId: plugin.pluginId } : undefined,\n    );\n    return await plugin.sanitizeReplayHistory(params.context);\n  }\n  return undefined;\n}\n\nexport async function validateProviderReplayTurnsWithPlugin(\n  params: ProviderReplayRuntimeLookup & { context: ProviderValidateReplayTurnsContext },\n): Promise<AgentMessage[] | null | undefined> {\n  const plugin = resolveProviderRuntimePlugin(params);\n  return await plugin?.validateReplayTurns?.(params.context);\n}\n\nexport function resolveProviderReasoningOutputModeWithPlugin(\n  params: ProviderReplayRuntimeLookup & {\n    runtimeHandle?: ProviderRuntimePluginHandle;\n    context: ProviderReasoningOutputModeContext;\n  },\n): ProviderReasoningOutputMode | undefined {\n  const mode = ensureProviderRuntimePluginHandle({\n    ...params,\n    modelId: params.context.modelId,\n  }).plugin?.resolveReasoningOutputMode?.(params.context);\n  return mode === \"native\" || mode === \"tagged\" ? mode : undefined;\n}\n",
].map(text => Buffer.from(text));
const qwenValueHash = bytes => createHash("sha256").update(bytes).digest("hex");

test("Qwen config preserves provider isolation, setup, aliases, pool and reporter plugin", () => {
  const plugin = { name: "bound-value-observer" };
  const setupFiles = ["test/setup.extensions.ts", "test/setup-openclaw-runtime.ts"];
  const alias = { "@openclaw/ai": "/fixture/sdk/packages/ai/src/index.ts" };
  const base = { resolve: { alias }, test: { isolate: false, runner: "/fixture/non-isolated-runner.ts",
    setupFiles, pool: "forks", maxWorkers: 4, include: ["extensions/qwen/*.test.ts"],
    env: { existing: "retained" } }, plugins: [{ name: "existing" }] };
  const before = structuredClone(base);
  const text = qwenValueConfigText({ nonce: "a".repeat(64) });
  const expression = text.split("export default ")[1];
  assert.ok(expression, "actual emitted config export is present");
  const evaluate = new Function("base", "plugin", "return " + expression);
  for (const input of [base, { ...base, test: { ...base.test, isolate: true, runner: undefined }, plugins: undefined }]) {
    const actual = evaluate(input, plugin);
    assert.equal(actual.test, input.test, "inherit the pinned provider runner without an isolation override");
    assert.equal(actual.test.setupFiles, setupFiles);
    assert.equal(actual.resolve, base.resolve);
    assert.deepEqual(actual.plugins, [...(input.plugins ?? []), plugin]);
    assert.equal(actual.plugins.at(-1), plugin);
  }
  assert.deepEqual(base, before, "shared provider config remains unchanged");
});

test("Qwen loader binds exact originals, overlay inputs, cache nonce and native argv", () => {
  const helperBytes = readFileSync(new URL("./helpers/openclaw-qwen-callsite-observer.mjs", import.meta.url));
  const fixtureSHA = qwenRunnerFixtureSha256, helperSHA = qwenValueHash(helperBytes);
  const bundle = makeQwenValuePlan({ nonce: "a".repeat(64), helperSHA, fixtureSHA, originals: qwenValueOriginals });
  assert.equal(bundle.plan.pin, sourceHead); assert.equal(bundle.plan.target, runnerContract.target);
  for (let i = 0; i < 2; i++) {
    assert.equal(qwenValueHash(qwenValueOriginals[i]), qwenValueSources[i].sha256);
    assert.equal(qwenValueHash(bundle.outputs[i]), bundle.plan.sources[i].outputSHA);
    assert.equal(bundle.outputs[i].split(i ? guardValueExpression : clientValueExpression).length, 2);
    assert.throws(() => overlayQwenValueSource(i + 1, Buffer.concat([qwenValueOriginals[i], Buffer.from(" ")]), bundle.plan.contract));
  }
  const second = makeQwenValuePlan({ nonce: "b".repeat(64), helperSHA, fixtureSHA, originals: qwenValueOriginals });
  assert.notEqual(second.plan.contract, bundle.plan.contract); assert.notEqual(second.configSHA, bundle.configSHA);
  assert.notEqual(second.plan.virtualSHA, bundle.plan.virtualSHA);
  assert.ok(bundle.config.includes('import base from "../test/vitest/vitest.extension-providers.config.ts"'));
  assert.ok(bundle.config.includes('export default { ...base, plugins: [...(base.plugins ?? []), plugin] }'));
  assert.equal(bundle.config, qwenValueConfigText(bundle.plan));
  const directory = "/fixture/sdk/.clawrouter-runner-report-control";
  const reporters = ["--reporter=default", "--reporter=" + directory + "/reporter.mjs", "--outputFile=" + directory + "/report.jsonl"];
  assert.deepEqual(qwenValueArgv(directory, runnerContract.target, reporters), [
    "scripts/run-vitest.mjs", "run", "--config", directory + "/qwen-callsite.config.ts",
    runnerContract.target, "--maxWorkers=1", ...reporters]);
  assert.throws(() => qwenValueArgv(directory, "extensions/foreign/test.ts", reporters));
  assert.throws(() => qwenValueArgv("/fixture/foreign", runnerContract.target, reporters));
  const binding = { ...runnerContract, fixtureSha256: fixtureSHA, reporterSha256: qwenRunnerReporterSha256,
    nonce: "a".repeat(64), callsite: { ...bundle.plan, configSHA: bundle.configSHA } };
  assert.equal(validateBinding(binding), binding);
  assert.ok(Buffer.byteLength(JSON.stringify(binding)) < 4096);
  for (const mutate of [c => c.nonce = "b".repeat(64), c => c.sources.reverse(),
    c => c.sources[0].outputSHA = "bad", c => c.extra = true, c => c.target = "foreign"]) {
    const changed = structuredClone(binding); mutate(changed.callsite); assert.throws(() => validateBinding(changed));
  }

  // Exercise the actual plugin function with private input reads replaced by a
  // closed fake filesystem. No native imports, loaders or filesystem effects.
  const files = new Map([
    [directory + "/callsite-observer.mjs", helperBytes],
    [directory + "/worker-values.mjs", Buffer.from(bundle.virtualSource)],
    [directory + "/qwen-callsite.config.ts", Buffer.from(bundle.config)],
    ...qwenValueSources.map((row, i) => ["/fixture/sdk/" + row.path, qwenValueOriginals[i]]),
  ]);
  const fakeRead = (path, expected, mode) => {
    assert.ok(files.has(path)); const bytes = files.get(path);
    assert.equal(qwenValueHash(bytes), expected);
    if (path.startsWith(directory)) assert.ok(mode === 0o400 || mode === 0o600);
    return bytes;
  };
  const pluginFactory = new Function("assert", "fileURLToPath", "realpathSync", "resolve", "dirname", "join",
    "readQwenValueInput", "qwenValueSources", "hash", "qwenValuePin", "qwenValueTarget", "validHash",
    "overlayQwenValueSource", "qwenValueConfigText", "qwenValueModule",
    "return (" + createQwenValuePlugin.toString() + ");")(
      assert, url => new URL(url).pathname, value => value.replace(/\/$/, ""), resolve, dirname, join,
      fakeRead, qwenValueSources, qwenValueHash, qwenValuePin, qwenValueTarget,
      value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
      overlayQwenValueSource, qwenValueConfigText, qwenValueModule);
  const plugin = pluginFactory(new URL("file:///fixture/sdk/"), new URL("file://" + directory + "/"), bundle.plan);
  let cacheKey; plugin.configureVitest({ defineCacheKeyGenerator(fn) { cacheKey = fn({ id: "any-dependency" }); } });
  assert.match(cacheKey, /^[a-f0-9]{64}$/);
  const first = "/fixture/sdk/" + qwenValueSources[0].path;
  const virtual = plugin.resolveId(qwenValueModule, first);
  assert.equal(plugin.load(virtual).code, bundle.virtualSource);
  assert.equal(plugin.load(first).code, bundle.outputs[0]);
  assert.throws(() => plugin.resolveId(qwenValueModule, "/fixture/sdk/foreign.ts"));
  assert.throws(() => plugin.load(first + "?foreign"));
  assert.throws(() => plugin.load("\0clawrouter:qwen-values:" + "b".repeat(64)));
  files.set(directory + "/worker-values.mjs", Buffer.from("foreign"));
  assert.throws(() => pluginFactory(new URL("file:///fixture/sdk/"), new URL("file://" + directory + "/"), bundle.plan));
});

test("Qwen private input custody and falsey read/close faults are independent", () => {
  const bytes = Buffer.from("synthetic"), digest = qwenValueHash(bytes);
  for (const fault of ["none", "read", "close", "both", "mode", "link", "owner", "changed", "oversize", "hash"]) {
    const events = [], original = undefined, retained = false;
    let statCount = 0;
    const stat = () => {
      statCount++;
      return { isFile: () => true, mode: fault === "mode" ? 0o644 : 0o600,
        uid: fault === "owner" ? 2 : 1, nlink: fault === "link" ? 2 : 1, dev: 1, ino: 1,
        size: fault === "oversize" ? 65537 : bytes.length, mtimeMs: fault === "changed" ? statCount : 1, ctimeMs: 1 };
    };
    const reader = new Function("openSync", "constants", "fstatSync", "assert", "Buffer", "readSync",
      "closeSync", "hash", "process", "return (" + readQwenValueInput.toString() + ");")(
        () => { events.push("open"); return 1; }, { O_RDONLY: 1, O_NOFOLLOW: 2, O_NONBLOCK: 4 }, stat, assert, Buffer,
        (_fd, output, offset) => {
          events.push("read"); if (fault === "read" || fault === "both") throw original;
          if (offset === bytes.length) return 0; bytes.copy(output, offset); return bytes.length;
        },
        () => { events.push("close"); if (fault === "close" || fault === "both") throw retained; },
        qwenValueHash, { getuid: () => 1 });
    const result = qwenCaught(() => reader("owned", fault === "hash" ? "0".repeat(64) : digest, 0o600));
    assert.equal(events.filter(v => v === "close").length, 1);
    if (fault === "none") assert.deepEqual(result.value, bytes);
    else assert.equal(result.failed, true);
    if (fault === "both") assert.deepEqual(result.reason.errors, [original, retained]);
    if (fault === "read") assert.equal(result.reason, original);
    if (fault === "close") assert.equal(result.reason, retained);
  }
});

test("Qwen value claims travel only with the original first failed observer and matching runner", async () => {
  const bundle = makeQwenValuePlan({ nonce: "a".repeat(64), helperSHA: qwenValueObserverSha256,
    fixtureSHA: qwenRunnerFixtureSha256, originals: qwenValueOriginals });
  for (const version of [4, 5, 6, 7, 8, 9]) for (const match of [true, false, null]) {
    const h = entryHarness(); h.witness.moduleEvaluated(); h.register();
    if (match !== null) h.relay.runnerReport(qwenRunnerPacket("complete", records => {
      records[0].binding.callsite = { ...bundle.plan, configSHA: bundle.configSHA };
    }));
    const witness = h.witness.enter(rows[0].id), counts = { operations: 2, rejected: 1, pending: 0 };
    witness.at("owned_drain"); witness.failed(undefined);
    h.relay.text("QWEN_SDK_V1 " + JSON.stringify(qwenClosedRecord(rows[0].id, "join", "fetch_observer", "failed", counts)) + "\n");
    const record = { v: version, kind: "observer_failure", case: rows[0].id, parent: 1, observer: 2,
      site: 4, seen: 1, truthy: 1, receipt: false, acquisition: false, parentState: "fulfilled",
      failurePresent: true, reasonDefined: true, route: [1,0,0,0,0,0,0,0,0], callable: [1,0,0,0,0,0,1],
      values: [1, match ? bundle.plan.contract : "b".repeat(64), 1, 1, 11, 1, 9, 2, 3, 3, 0],
      ...(version >= 5 ? { valueState: [1, 1, 0] } : {}),
      ...(version >= 6 ? { valueSites: [1, 11, 1, 1, 3, 1] } : {}),
      ...(version >= 7 ? { valueSelection: version === 7 ? [null,7,1,1,1] : [null,63,1,1,1,1,1,1,...(version === 9 ? [0,0,0,0] : [])] } : {}) };
    h.relay.text("QWEN_OBSERVER_V1 " + JSON.stringify(record) + "\n"); witness.complete(counts);
    for (const row of rows.slice(1)) h.relay.record(qwenClosedRecord(row.id, "worker", "control", "failed", counts));
    const packet = h.relay.output("failed"), projected = packet.find(row => row.kind === "observer_failure");
    assert.deepEqual(projected.values, match ? record.values : null);
    if (version >= 5) assert.deepEqual(projected.valueState, [1, 1, match ? 0 : match === null ? 10 : 11]);
    if (version >= 6) assert.deepEqual(projected.valueSites, record.valueSites);
    if (version >= 7) assert.deepEqual(projected.valueSelection, match ? record.valueSelection : null);
    assert.equal(packet.length, 10); assert.equal(h.relay.complete(), false);
    const commands = packet.map(qwenBoundaryAnnotation);
    assert.ok(commands.every(line => Buffer.byteLength(line) <= 768));
    assert.ok(Buffer.byteLength(commands.join("\n")) <= 8192);
  }
  const successful = entryHarness(); successful.witness.moduleEvaluated(); successful.register();
  const witness = successful.witness.enter(rows[0].id), counts = { operations: 2, rejected: 0, pending: 0 };
  successful.relay.text("QWEN_SDK_V1 " + JSON.stringify(qwenClosedRecord(rows[0].id, "join", "caller", "passed", counts)) + "\n");
  witness.complete(counts);
  assert.equal(successful.relay.output("failed").some(row => row.kind === "observer_failure"), false);
});

// BEGIN Qwen value disposition controls.
test("Qwen value disposition reads retained state once without current-context calls", () => {
  const contract = "a".repeat(64);
  for (const [sites, expected] of [[[], [0,0,5]], [[1], [1,0,6]], [[2], [0,1,5]], [[1,2], [1,1,8]], [[1,1,2], [2,1,1]]]) {
    let reads = 0; const invocation = {}, sink = createQwenValueSink(contract);
    for (const site of sites) sink.activate(site, contract);
    const claim = sink.claim(contract, 1, () => { reads++; return invocation; }); claim.bind(invocation);
    const before = reads, result = claim.snapshot(invocation, true);
    assert.deepEqual(result, { values: null, valueState: expected,
      valueSites: expected[2] === 8 ? [0,0,0,0,0,0] : null,
      valueSelection: expected[2] === 8 ? [contract,0,0,0,0,0,0,0,0,0,0,0] : null });
    assert.equal(reads, before); assert.deepEqual(claim.close(), []);
    assert.deepEqual(claim.snapshot(invocation, true), result);
  }
  const h = qwenValueHarness();
  assert.deepEqual(h.claim.snapshot({}, true).valueState, [1,1,4]);
  const token = h.sink.begin(2);
  assert.deepEqual(h.claim.snapshot(h.invocation, true).valueState, [1,1,7]);
  h.sink.argument(token, {}); const original = Promise.resolve();
  assert.equal(h.sink.result(token, original), original); h.sink.finish(token);
  const beforeClose = h.claim.snapshot(h.invocation, true);
  assert.equal(beforeClose.values[8], 3); assert.deepEqual(beforeClose.valueState, [1,1,0]);
  assert.deepEqual(h.claim.close(), []); assert.deepEqual(h.claim.snapshot(h.invocation, true), beforeClose);
  const fault = qwenValueHarness(() => { throw undefined; });
  assert.equal(fault.sink.begin(2), null);
  assert.deepEqual(fault.claim.snapshot(fault.invocation, true).valueState, [1,1,2]);
  assert.deepEqual(fault.claim.close(), [undefined]);
  assert.deepEqual(fault.claim.snapshot(fault.invocation, true).valueState, [1,1,2]);
});

test("Qwen v5 value disposition is closed, opaque and within existing annotation quotas", () => {
  const base = { v: 5, kind: "observer_failure", case: rows[0].id, parent: 1, observer: 2,
    site: 4, seen: 1, truthy: 1, receipt: false, acquisition: false, parentState: "fulfilled",
    failurePresent: true, reasonDefined: true, route: [1,0,0,0,0,0,0,0,0], callable: [1,0,0,0,0,0,1],
    values: null, valueState: [0,0,5] };
  for (const state of [[0,0,1],[1,1,2],[1,1,3],[1,1,4],[0,0,5],[1,0,6],[1,1,7],[1,1,8],[1,1,9],[1,1,10],[1,1,11],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1]]) {
    const row = { ...base, valueState: state };
    assert.deepEqual(qwenObserverRecord(row), row);
    assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(row)) <= 768);
  }
  const value = { ...base, values: [1,"a".repeat(64),206,7,15,2,9,8,3,3,0], valueState: [1,1,0] };
  assert.deepEqual(qwenObserverRecord(value), value);
  const wide = { ...value, case: rows.reduce((a,b) => a.id.length > b.id.length ? a : b).id,
    parent: 65534, observer: 65535, route: [1,65535,65535,65535,0,0,3,3,2] };
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(wide)) <= 768);
  for (const state of [[0,0,0], [1,1,5], [0,1,6], [0,0,8], [-1,0,5], [0,0,12], [true,0,5],
    [0,0,5,0], Object.assign(new Array(4), {0:0,1:0,2:5})]) {
    assert.throws(() => qwenObserverRecord({ ...base, valueState: state }));
  }
  assert.throws(() => qwenObserverRecord({ ...value, valueState: [1,1,8] }));
  let reads = 0;
  const accessor = [0,0,5]; Object.defineProperty(accessor, "0", { get() { reads++; throw undefined; } });
  const proxy = new Proxy([0,0,5], { ownKeys() { reads++; throw undefined; } });
  for (const state of [accessor, proxy]) assert.throws(() => qwenObserverRecord({ ...base, valueState: state }));
  assert.equal(reads, 0);
  const { valueState, ...old } = value;
  old.v = 4; assert.deepEqual(qwenObserverRecord(old), old);
});

test("Qwen retained site state distinguishes absent, partial, open and complete evaluations", () => {
  const base = { v: 9, kind: "observer_failure", case: rows[0].id, parent: 1, observer: 2,
    site: 4, seen: 1, truthy: 1, receipt: false, acquisition: false, parentState: "fulfilled",
    failurePresent: true, reasonDefined: true, route: [1,0,0,0,0,0,0,0,0], callable: [1,0,0,0,0,0,1] };
  for (const site of [1, 2]) for (const bits of site === 1 ? [0,1,3,7,11,15] : [0,1,3]) {
    let reads = 0; const invocation = {}, sink = createQwenValueSink("a".repeat(64));
    sink.activate(1, "a".repeat(64)); sink.activate(2, "a".repeat(64));
    const claim = sink.claim("a".repeat(64), 1, () => { reads++; return invocation; }); claim.bind(invocation);
    const absent = claim.snapshot(invocation, true);
    assert.deepEqual(absent.valueSites, [0,0,0,0,0,0]);
    assert.deepEqual(qwenObserverRecord({ ...base, ...absent }).valueSites, absent.valueSites);
    const token = sink.begin(site), value = () => {};
    if (site === 1) {
      if (bits >= 1) sink.host(token, {});
      if (bits >= 3) sink.build(token, bits === 7 || bits === 15 ? null : value);
      if (bits === 7 || bits === 15) sink.fallback(token, value);
      if (bits === 11 || bits === 15) sink.selected(token, value);
    } else {
      if (bits >= 1) sink.argument(token, {});
      if (bits === 3) sink.result(token, value);
    }
    const before = reads, open = claim.snapshot(invocation, true);
    const expected = site === 1 ? [1,bits,0,0,0,0] : [0,0,0,1,bits,0];
    assert.deepEqual(open.valueSites, expected); assert.equal(open.valueState[2], 7);
    assert.deepEqual(qwenObserverRecord({ ...base, ...open }).valueSites, expected);
    assert.equal(reads, before, "snapshot never reads the current invocation");
    sink.finish(token); expected[site === 1 ? 2 : 5] = 1;
    const closed = claim.snapshot(invocation, true), complete = site === 1 ? [11,15].includes(bits) : bits === 3;
    assert.deepEqual(closed.valueSites, expected); assert.equal(closed.valueState[2], complete ? 0 : 8);
    assert.equal(closed.values !== null, complete);
    const checked = qwenObserverRecord({ ...base, ...closed });
    assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(checked)) <= 768);
    assert.deepEqual(claim.close(), []); assert.deepEqual(claim.snapshot(invocation, true), closed);
    assert.equal(open.valueSites[site === 1 ? 2 : 5], 0, "earlier observation is not rewritten by closure");
  }
});

test("Qwen v6 site tuples reject malformed, contradictory and reflective inputs within quotas", () => {
  const base = { v: 6, kind: "observer_failure", case: rows[0].id, parent: 1, observer: 2,
    site: 4, seen: 1, truthy: 1, receipt: false, acquisition: false, parentState: "fulfilled",
    failurePresent: true, reasonDefined: true, route: [1,0,0,0,0,0,0,0,0], callable: [1,0,0,0,0,0,1],
    values: null, valueState: [1,1,8], valueSites: [0,0,0,0,0,0] };
  for (const valueSites of [null, [0,0,0], [0,0,0,0,0,0,0], Object.assign(new Array(7), base.valueSites),
    [true,0,0,0,0,0], [2,0,0,0,0,0], [0,1,0,0,0,0], [0,0,1,0,0,0], [1,2,1,0,0,0],
    [1,1,0,0,0,0], [0,0,0,1,7,1], [0,0,0,0,1,0], [0,0,0,0,0,1], [1,11,1,0,0,0]]) {
    assert.throws(() => qwenObserverRecord({ ...base, valueSites }));
  }
  let reads = 0;
  const accessor = [...base.valueSites]; Object.defineProperty(accessor, "0", { get() { reads++; throw undefined; } });
  const proxy = new Proxy([...base.valueSites], { ownKeys() { reads++; throw undefined; } });
  for (const valueSites of [accessor, proxy]) assert.throws(() => qwenObserverRecord({ ...base, valueSites }));
  assert.equal(reads, 0);
  const unobserved = { ...base, valueState: [1,1,2], valueSites: null };
  assert.deepEqual(qwenObserverRecord(unobserved), unobserved);
  assert.throws(() => qwenObserverRecord({ ...unobserved, valueSites: base.valueSites }));
  const complete = { ...base, values: [1,"a".repeat(64),206,7,15,2,9,8,3,3,0],
    valueState: [1,1,0], valueSites: [1,15,1,1,3,1] };
  assert.deepEqual(qwenObserverRecord(complete), complete);
  assert.throws(() => qwenObserverRecord({ ...complete, valueSites: [1,11,1,1,3,1] }));
  assert.throws(() => qwenObserverRecord({ ...complete, valueSites: [1,15,1,0,0,0] }));
  const wide = { ...complete, case: rows.reduce((a,b) => a.id.length > b.id.length ? a : b).id,
    parent: 65534, observer: 65535, route: [1,65535,65535,65535,0,0,3,3,2] };
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(qwenObserverRecord(wide))) <= 768);
  const { valueSites, ...legacy } = complete; legacy.v = 5;
  assert.deepEqual(qwenObserverRecord(legacy), legacy);
});
// END Qwen value disposition controls.


// The new source literals are inert hash-bound D8 inputs, never an SDK fallback.
function qwenSelectionSources() {
  return qwenValueOriginals.map((bytes, i) => overlayQwenValueSource(i + 1, bytes, "a".repeat(64)));
}
function qwenRegistryFactory(text, sink, MapClass = Map) {
  const code = stripTypeScriptTypes(text).replace(/^import .*;\n/gm, "").replaceAll("export ", "");
  return new Function("__qwenValues", "Map", code + "; return createApiRegistry;")(sink, MapClass);
}

test("Qwen selection overlays preserve actual facade nullish evaluation and falsey throws", () => {
  const outputs = qwenSelectionSources();
  for (let i = 2; i < outputs.length; i++) {
    assert.equal(qwenValueHash(qwenValueOriginals[i]), qwenValueSources[i].sha256);
    assert.throws(() => overlayQwenValueSource(i + 1, Buffer.concat([qwenValueOriginals[i], Buffer.from(" ")]), "a".repeat(64)));
    assert.doesNotThrow(() => stripTypeScriptTypes(outputs[i]));
  }
  const expression = text => text.match(/function resolveRuntime\(model: Model\) \{\n  (return .*;)\n\}/)?.[1];
  const original = expression(qwenValueOriginals[2].toString()), observed = expression(outputs[2]);
  assert.ok(original && observed);
  for (const selected of [null, undefined, {}, false, 0]) for (const throws of [false, true]) {
    const error = undefined, fallback = {};
    const run = body => {
      const h = qwenValueHarness(), generation = {}, trace = [];
      h.sink.defaultRegistry({}, generation);
      const env = { getModelLlmRuntime(model) { trace.push(model); if (throws) throw error; return selected; },
        get defaultLlmRuntime() { trace.push("default"); return fallback; } };
      const value = qwenCaught(() => new Function("__qwenValues", "__qwenGeneration", "model", "env",
        `with (env) { ${body} }`)(h.sink, generation, "model", env));
      assert.deepEqual(h.claim.close(), []);
      return { value, trace };
    };
    const a = run(original), b = run(observed);
    assert.deepEqual(b.trace, a.trace); assert.deepEqual(b.value, a.value);
    assert.equal(b.trace.filter(v => v === "model").length, 1);
  }
});

test("Qwen normalized registration observes only completed insertion and preserves getter order", () => {
  const outputs = qwenSelectionSources();
  for (const fail of [null, "key", "api", "stream", "simple", "set"]) for (const reason of [undefined, {}]) {
    const run = observed => {
      const trace = [], inserted = [], streamResult = {}, h = qwenValueHarness(); let apiReads = 0;
      class TracedMap extends Map {
        get set() { trace.push("set_get"); return function (key, entry) {
          trace.push("set_call"); if (fail === "set") throw reason;
          inserted.push(entry.provider); return Map.prototype.set.call(this, key, entry);
        }; }
      }
      const sink = { ...h.sink, registered(...args) { trace.push("record"); h.sink.registered(...args); } };
      const factory = qwenRegistryFactory(observed ? outputs[4] : qwenValueOriginals[4].toString(), sink, TracedMap);
      const registry = factory();
      const source = { get api() {
        trace.push("api"); apiReads++;
        if (fail === "key" && apiReads === 1 || fail === "api" && apiReads === 2) throw reason;
        return "openai-completions";
      }, get stream() { trace.push("stream"); if (fail === "stream") throw reason;
        return function (...args) { trace.push(["call", this, ...args]); return streamResult; };
      }, get streamSimple() { trace.push("simple"); if (fail === "simple") throw reason; return () => streamResult; } };
      const result = qwenCaught(() => registry.registerApiProvider(source));
      if (!result.failed) {
        assert.equal(result.value, undefined);
        const normalized = registry.getApiProvider("openai-completions");
        assert.equal(normalized, inserted[0]); assert.notEqual(normalized, source);
        assert.equal(normalized.stream({ api: "openai-completions" }, "context", "options"), streamResult);
      } else assert.equal(result.reason, reason);
      assert.deepEqual(h.claim.close(), []);
      return { trace, failed: result.failed };
    };
    const a = run(false), b = run(true);
    assert.deepEqual(b.trace.filter(v => v !== "record"), a.trace);
    assert.equal(b.trace.filter(v => v === "record").length, a.failed ? 0 : 1);
    if (!a.failed) assert.ok(b.trace.indexOf("record") > b.trace.indexOf("set_call"));
  }
});

test("Qwen actual runtime return associates only its existing registry without property reads", () => {
  const text = stripTypeScriptTypes(qwenSelectionSources()[3]);
  const start = text.indexOf("function createRuntime("), end = text.indexOf("/** Creates an isolated LLM runtime", start);
  assert.ok(start >= 0 && end > start);
  let propertyReads = 0, produced;
  const h = qwenValueHarness(), generation = {}, normalized = {}, result = {};
  const registry = { getApiProvider() { return normalized; } };
  const sink = { ...h.sink, createdRuntime(value, held) { produced = value; assert.equal(held, registry); return h.sink.createdRuntime(value, held); } };
  const create = new Function("__qwenValues", text.slice(start, end) + "; return createRuntime;")(sink);
  const runtime = create(registry);
  assert.equal(runtime, produced); assert.equal(runtime.registry, registry);
  Object.defineProperty(runtime, "registry", { get() { propertyReads++; throw undefined; } });
  h.sink.defaultRegistry(registry, generation); h.sink.defaultRuntime(runtime, generation); h.sink.runtime(runtime, generation);
  const resolve = text.match(/function resolveApiProvider\(api\s*\) \{([\s\S]*?)\n  \}/)?.[0];
  assert.ok(resolve);
  assert.equal(new Function("__qwenValues", "registry", resolve + '; return resolveApiProvider("openai-completions");')(h.sink, registry), normalized);
  assert.deepEqual(h.claim.snapshot(h.invocation, true).valueSelection, [h.contract,3,1,1,0,0,0,0,0,0,0,0]);
  assert.equal(propertyReads, 0); assert.deepEqual(h.claim.close(), []);
});

test("Qwen selection identities require owned context, generation and normalized-record provenance", () => {
  for (const mode of ["matched", "preregistered", "unconstructed", "different", "replaced", "old-record", "foreign", "absent", "other-generation"]) {
    let current, reads = 0;
    const h = qwenValueHarness(() => { reads++; return current; }); current = h.invocation;
    const generation = {}, registry = {}, defaultRegistry = mode === "different" ? {} : registry;
    const runtime = {}, defaultRuntime = mode === "different" ? {} : runtime, map = {}, old = {}, latest = {};
    h.sink.defaultRegistry(defaultRegistry, generation); h.sink.defaultRuntime(defaultRuntime, generation);
    if (mode !== "unconstructed") h.sink.createdRuntime(runtime, registry);
    if (mode !== "preregistered") h.sink.registered(map, "openai-completions", old);
    if (["replaced", "old-record"].includes(mode)) h.sink.registered(map, "openai-completions", latest);
    if (mode === "other-generation") {
      const other = {}; h.sink.defaultRegistry({}, other); h.sink.defaultRuntime({}, other);
    }
    if (mode === "foreign") current = {};
    if (mode === "absent") current = undefined;
    const selected = mode === "replaced" ? latest : old;
    assert.equal(h.sink.runtime(runtime, generation), runtime);
    assert.equal(h.sink.lookup(selected, map, "openai-completions"), selected);
    assert.equal(h.sink.provider(selected, registry), selected);
    assert.equal(reads, 3, "one explicit owned-context read per hook");
    const row = h.claim.snapshot(h.invocation, true).valueSelection;
    const expected = ["foreign", "absent"].includes(mode) ? [0,0,0,0]
      : mode === "different" ? [7,2,2,1] : mode === "unconstructed" ? [7,1,0,0]
      : [7,1,1,mode === "preregistered" ? 0 : mode === "old-record" ? 2 : 1];
    assert.deepEqual(row, [h.contract,...expected,0,0,0,0,0,0,0]); assert.equal(reads, 3);
    assert.deepEqual(h.claim.close(), []); assert.deepEqual(h.claim.snapshot(h.invocation, true).valueSelection, row);
  }
});

test("Qwen selection observer faults preserve falsey reasons and original return identities", () => {
  for (const reason of [undefined, null, false, {}]) {
    const h = qwenValueHarness(() => { throw reason; }), value = {}, generation = {};
    assert.equal(h.sink.runtime(value, generation), value);
    assert.equal(h.sink.lookup(value, {}, "openai-completions"), value);
    assert.equal(h.sink.provider(value, {}), value);
    assert.equal(h.claim.snapshot(h.invocation, true).valueSelection, null);
    const faults = h.claim.close(); assert.equal(faults.length, 3); assert.ok(faults.every(x => Object.is(x, reason)));
  }
  const h = qwenValueHarness(), generation = {}, runtime = {};
  h.sink.runtime(runtime, generation); h.sink.runtime(runtime, generation);
  assert.equal(h.claim.snapshot(h.invocation, true).valueSelection, null);
  assert.deepEqual(h.claim.close(), []);
});

test("Qwen v7 selection tuples are closed, nonreflective and retain legacy quotas", () => {
  const base = { v: 7, kind: "observer_failure", case: rows[0].id, parent: 1, observer: 2,
    site: 4, seen: 1, truthy: 1, receipt: false, acquisition: false, parentState: "fulfilled",
    failurePresent: true, reasonDefined: true, route: [1,0,0,0,0,0,0,0,0], callable: [1,0,0,0,0,0,1],
    values: null, valueState: [1,1,8], valueSites: [0,0,0,0,0,0], valueSelection: ["a".repeat(64),7,1,1,1] };
  for (const valueSelection of [null, ["a".repeat(64),0,0,0,0], ["a".repeat(64),1,2,0,0], base.valueSelection]) {
    const row = { ...base, valueSelection }; assert.deepEqual(qwenObserverRecord(row), row);
    assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(row)) <= 768);
  }
  for (const valueSelection of [[], ["a".repeat(64),7,1,1], Object.assign(new Array(6), base.valueSelection),
    [null,7,1,1,1], ["x",7,1,1,1], ["a".repeat(64),2,0,0,0], ["a".repeat(64),0,1,0,0],
    ["a".repeat(64),1,1,1,1], ["a".repeat(64),7,3,1,1]]) assert.throws(() => qwenObserverRecord({ ...base, valueSelection }));
  let reads = 0;
  for (const key of ["valueState", "valueSites", "valueSelection"]) {
    const accessor = [...base[key]]; Object.defineProperty(accessor, "0", { get() { reads++; throw undefined; } });
    const proxy = new Proxy([...base[key]], { ownKeys() { reads++; throw undefined; } });
    for (const value of [accessor, proxy]) assert.throws(() => qwenObserverRecord({ ...base, [key]: value }));
  }
  assert.equal(reads, 0);
  const complete = { ...base, values: [1,"a".repeat(64),206,7,15,2,9,8,3,3,0], valueState: [1,1,0],
    valueSites: [1,15,1,1,3,1], valueSelection: [null,7,1,1,1] };
  const wide = { ...complete, case: rows.reduce((a,b) => a.id.length > b.id.length ? a : b).id,
    parent: 65534, observer: 65535, route: [1,65535,65535,65535,0,0,3,3,2] };
  assert.deepEqual(qwenObserverRecord(wide), wide);
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(wide)) <= 768);
  const { valueSelection, ...old } = complete; old.v = 6; assert.deepEqual(qwenObserverRecord(old), old);
});


test("Qwen selection-only projection requires the actual matching invocation contract", () => {
  const bundle = makeQwenValuePlan({ nonce: "a".repeat(64), helperSHA: qwenValueObserverSha256,
    fixtureSHA: qwenRunnerFixtureSha256, originals: qwenValueOriginals });
  for (const version of [7, 8, 9]) for (const match of [true, false, null]) {
    const h = entryHarness(); h.witness.moduleEvaluated(); h.register();
    if (match !== null) h.relay.runnerReport(qwenRunnerPacket("complete", records => {
      records[0].binding.callsite = { ...bundle.plan, configSHA: bundle.configSHA };
    }));
    const witness = h.witness.enter(rows[0].id), counts = { operations: 2, rejected: 1, pending: 0 };
    witness.at("owned_drain"); witness.failed(undefined);
    h.relay.text("QWEN_SDK_V1 " + JSON.stringify(qwenClosedRecord(rows[0].id, "join", "fetch_observer", "failed", counts)) + "\n");
    const record = { v: version, kind: "observer_failure", case: rows[0].id, parent: 1, observer: 2,
      site: 4, seen: 1, truthy: 1, receipt: false, acquisition: false, parentState: "fulfilled",
      failurePresent: true, reasonDefined: true, route: [1,0,0,0,0,0,0,0,0], callable: [1,0,0,0,0,0,1],
      values: null, valueState: [1,1,8], valueSites: [0,0,0,0,0,0],
      valueSelection: [match ? bundle.plan.contract : "b".repeat(64),7,1,1,1,...(version >= 8 ? [0,0,0] : []),...(version === 9 ? [0,0,0,0] : [])] };
    h.relay.text("QWEN_OBSERVER_V1 " + JSON.stringify(record) + "\n"); witness.complete(counts);
    for (const row of rows.slice(1)) h.relay.record(qwenClosedRecord(row.id, "worker", "control", "failed", counts));
    const packet = h.relay.output("failed"), actual = packet.find(row => row.kind === "observer_failure");
    assert.deepEqual(actual.valueSelection, match ? record.valueSelection : null);
    assert.equal(actual.valueState[2], match ? 8 : match === null ? 10 : 11);
    assert.deepEqual(qwenObserverRecord(actual), actual);
    assert.ok(packet.every(row => Buffer.byteLength(qwenBoundaryAnnotation(row)) <= 768));
    assert.ok(Buffer.byteLength(packet.map(qwenBoundaryAnnotation).join("\n")) <= 8192);
  }
});


test("Qwen actual builtin lazy path proves wrapper input and selected adapter entry", async () => {
  const outputs = qwenSelectionSources();
  const builtinText = stripTypeScriptTypes(outputs[5]);
  const start = builtinText.indexOf("export const BUILT_IN_API_PROVIDER_SOURCE_ID"), end = builtinText.indexOf("const registerBuiltIns", start);
  assert.ok(start >= 0 && end > start);
  const adapterText = stripTypeScriptTypes(outputs[6]);
  const adapterStart = adapterText.indexOf("export const streamOpenAICompletions"), adapterEnd = adapterText.indexOf("export const streamSimpleOpenAICompletions", adapterStart);
  assert.ok(adapterStart >= 0 && adapterEnd > adapterStart);
  for (const mode of ["matched", "simple", "unobserved-builtin", "mutated-wrapper", "mutated-direct", "foreign-lazy"]) {
    const h = qwenValueHarness(), generation = {}, runtime = {}, trace = [];
    const registry = qwenRegistryFactory(outputs[4], h.sink)();
    h.sink.createdRuntime(runtime, registry); h.sink.defaultRegistry(registry, generation); h.sink.defaultRuntime(runtime, generation);
    class EventStream {
      constructor() { this.done = new Promise(resolve => { this.resolve = resolve; }); this.events = []; }
      push(event) { this.events.push(event); }
      end() { this.resolve(); }
    }
    const transport = (...args) => { trace.push(args); return (async function* () { yield "event"; })(); };
    const adapters = new Function("__qwenValues", "streamOpenAICompletionsRequest", "requireApiKey", "buildBaseOptions", "clampThinkingLevel",
      adapterText.slice(adapterStart).replaceAll("export const", "const") + "; return { streamOpenAICompletions, streamSimpleOpenAICompletions };"
    )(h.sink, transport, (_provider, key) => key, (_model, options) => options, (_model, level) => level);
    const adapter = adapters.streamOpenAICompletions, simpleAdapter = adapters.streamSimpleOpenAICompletions;
    const sink = mode === "unobserved-builtin" ? { ...h.sink, builtin: value => value } : h.sink;
    const factory = new Function("__qwenValues", "AssistantMessageEventStream", "projectProviderError", "createZeroUsage",
      builtinText.slice(start, end).replace("export const", "const") + "; return createLazyRegistration;")(sink, EventStream, () => ({}), () => ({}));
    let imports = 0, selections = 0;
    const register = factory("openai-completions", () => { imports++; return Promise.resolve({ adapter }); }, module => {
      selections++; return { stream: module.adapter, streamSimple: simpleAdapter };
    });
    register(registry);
    const normalized = registry.getApiProvider("openai-completions");
    if (mode === "mutated-wrapper") {
      const other = qwenRegistryFactory(outputs[4], h.sink)();
      factory("openai-completions", () => Promise.resolve({ adapter }), m => ({ stream: m.adapter, streamSimple: m.adapter }))(other);
      normalized.stream = other.getApiProvider("openai-completions").stream;
    }
    if (mode === "mutated-direct") normalized.stream = adapter;
    h.sink.runtime(runtime, generation);
    const selected = h.sink.provider(registry.getApiProvider("openai-completions"), registry);
    assert.equal(selected, normalized);
    const model = { api: "openai-completions" }, context = {}, options = { apiKey: "synthetic" };
    if (mode === "foreign-lazy") h.sink.lazy(adapter, () => {});
    const result = mode === "simple" ? selected.streamSimple(model, context, options) : selected.stream(model, context, options);
    if (result.done) await result.done; else for await (const _ of result) {}
    assert.equal(trace.length, 1);
    if (mode === "simple") { assert.equal(trace[0][0], model); assert.equal(trace[0][1], context); assert.equal(trace[0][2].apiKey, options.apiKey); assert.equal(trace[0][3], "direct"); }
    else assert.deepEqual(trace[0], [model, context, options, "direct"]);
    const expected = mode === "unobserved-builtin" ? [15,1,1,1,1,0,0]
      : mode === "mutated-wrapper" ? [15,1,1,1,2,0,0]
      : ["mutated-direct", "simple"].includes(mode) ? [7,1,1,1,0,0,0] : [63,1,1,1,1,1,1];
    assert.deepEqual(h.claim.snapshot(h.invocation, true).valueSelection, [h.contract,...expected,0,0,0,0]);
    if (["matched", "foreign-lazy", "unobserved-builtin"].includes(mode)) {
      assert.equal(imports, 1); assert.equal(selections, 1);
    }
    assert.deepEqual(h.claim.close(), []);
  }
});

test("Qwen actual wrapper entry preserves receiver operands and falsey original throws", () => {
  const outputs = qwenSelectionSources();
  for (const reason of [undefined, null, false, {}]) {
    const h = qwenValueHarness(() => { throw reason; }), registry = qwenRegistryFactory(outputs[4], h.sink)();
    const original = {}, model = { api: "openai-completions" }, context = {}, options = {};
    let calls = 0;
    registry.registerApiProvider({ api: "openai-completions", stream(...args) {
      calls++; assert.equal(this, undefined); assert.deepEqual(args, [model,context,options]); throw original;
    }, streamSimple() {} });
    // Lookup itself reads the owned context. Its fault and wrapper-entry fault
    // remain independent of the exact original handler throw.
    const held = registry.getApiProvider("openai-completions");
    const result = qwenCaught(() => held.stream(model,context,options));
    assert.equal(result.failed,true); assert.equal(result.reason,original); assert.equal(calls,1);
    const errors = h.claim.close(); assert.equal(errors.length,2); assert.ok(errors.every(e=>Object.is(e,reason)));
  }
});

test("Qwen v8 handler provenance tuples reject false origin and preserve fixed packet caps", () => {
  const base = { v: 8, kind: "observer_failure", case: rows[0].id, parent: 1, observer: 2,
    site: 4, seen: 1, truthy: 1, receipt: false, acquisition: false, parentState: "fulfilled",
    failurePresent: true, reasonDefined: true, route: [1,0,0,0,0,0,0,0,0], callable: [1,0,0,0,0,0,1],
    values: null, valueState: [1,1,8], valueSites: [0,0,0,0,0,0], valueSelection: ["a".repeat(64),63,1,1,1,1,1,1] };
  for (const selection of [null, base.valueSelection, ["a".repeat(64),15,1,1,1,2,0,0], ["a".repeat(64),7,1,1,1,0,0,0]]) {
    const row = { ...base, valueSelection: selection }; assert.deepEqual(qwenObserverRecord(row),row);
    assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(row))<=768);
  }
  for (const valueSelection of [base.valueSelection.slice(0,7), Object.assign(new Array(9),base.valueSelection),
    ["a".repeat(64),7,1,1,1,1,0,0], ["a".repeat(64),15,1,1,1,2,1,0], ["a".repeat(64),47,1,1,1,1,1,1],
    ["a".repeat(64),31,1,1,1,1,1,1], ["a".repeat(64),63,1,1,1,1,0,1], ["a".repeat(64),63,1,1,1,1,1,3]]) {
    assert.throws(()=>qwenObserverRecord({...base,valueSelection}));
  }
  const complete={...base,values:[1,"a".repeat(64),206,7,15,2,9,8,3,3,0],valueState:[1,1,0],valueSites:[1,15,1,1,3,1],valueSelection:[null,63,1,1,1,1,1,1],
    case:rows.reduce((a,b)=>a.id.length>b.id.length?a:b).id,parent:65534,observer:65535,route:[1,65535,65535,65535,0,0,3,3,2]};
  assert.deepEqual(qwenObserverRecord(complete),complete);
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(complete))<=768);
});

function qwenReplayResolver(source, sink, resolve, warn = () => {}) {
  const text = stripTypeScriptTypes(source);
  const start = text.indexOf("export async function sanitizeProviderReplayHistoryWithPluginAsync"),
    end = text.indexOf("export async function validateProviderReplayTurnsWithPlugin", start);
  assert.ok(start >= 0 && end > start);
  return new Function("__qwenValues", "resolveProviderRuntimePlugin", "warnSessionPersistenceDeprecation",
    text.slice(start, end).replace("export ", "") + "; return sanitizeProviderReplayHistoryWithPluginAsync;")(sink, resolve, warn);
}

test("Qwen replay bracket binds only synchronous replacement of the later selected registration", async () => {
  const outputs = qwenSelectionSources();
  for (const mode of ["replace", "none", "before", "after", "foreign-map", "late", "duplicate", "nested", "unknown-prior"]) {
    const h = qwenValueHarness(), generation = {}, runtime = {};
    const registry = qwenRegistryFactory(outputs[4], h.sink)();
    const other = qwenRegistryFactory(outputs[4], h.sink)();
    const original = () => {}, next = () => {}, simple = () => {};
    h.sink.createdRuntime(runtime, registry); h.sink.defaultRegistry(registry, generation); h.sink.defaultRuntime(runtime, generation);
    if (mode !== "unknown-prior") h.sink.builtin(original, "openai-completions");
    registry.registerApiProvider({ api: "openai-completions", stream: original, streamSimple: simple });
    const register = (target = registry) => target.registerApiProvider({ api: "openai-completions", stream: next, streamSimple: simple });
    if (mode === "before") register();
    const context = {}, result = {}, params = { context }; let calls = 0, hookCalls = 0;
    const replay = qwenReplayResolver(outputs[7], h.sink, actual => {
      assert.equal(actual, params); calls++;
      if (["replace", "duplicate", "unknown-prior"].includes(mode)) register();
      if (mode === "foreign-map") register(other);
      if (mode === "duplicate") register();
      if (mode === "nested") h.sink.replayEnd(h.sink.replayBegin());
      return { sanitizeReplayHistoryAsync(value) {
        assert.equal(value, context); hookCalls++;
        if (mode === "late") register();
        return Promise.resolve(result);
      } };
    });
    assert.equal(await replay(params), result); assert.equal(calls, 1); assert.equal(hookCalls, 1);
    if (mode === "after") register();
    h.sink.runtime(runtime, generation);
    h.sink.provider(registry.getApiProvider("openai-completions"), registry);
    const snapshot = h.claim.snapshot(h.invocation, true);
    if (["duplicate", "nested"].includes(mode)) assert.equal(snapshot.valueSelection, null);
    else assert.deepEqual(snapshot.valueSelection.slice(8), mode === "replace" ? [1,1,1,2]
      : mode === "unknown-prior" ? [1,1,0,2] : [1,0,0,0]);
    assert.deepEqual(h.claim.close(), []);
  }
});

test("Qwen actual replay resolver retains original hook ordering and falsey failures", async () => {
  const observed = qwenSelectionSources()[7], original = qwenValueOriginals[7].toString();
  for (const kind of ["none", "async", "legacy", "resolver-throw", "hook-throw", "hook-reject"])
    for (const reason of [undefined, null, false, new Error("synthetic")]) {
      const run = async source => {
        const h = qwenValueHarness(), trace = [], context = {}, result = {}, params = { context };
        const resolve = value => {
          trace.push(["resolve", value]); if (kind === "resolver-throw") throw reason;
          if (kind === "none") return undefined;
          return {
            get sanitizeReplayHistoryAsync() {
              trace.push("async-get");
              if (kind === "legacy") return undefined;
              return function (value) { trace.push(["async-call", this, value]);
                if (kind === "hook-throw") throw reason;
                return kind === "hook-reject" ? Promise.reject(reason) : Promise.resolve(result); };
            },
            get sanitizeReplayHistory() { trace.push("legacy-get"); return function (value) { trace.push(["legacy-call", this, value]); return result; }; },
          };
        };
        let failed = false, value;
        try { value = await qwenReplayResolver(source, h.sink, resolve, () => trace.push("warn"))(params); }
        catch (error) { failed = true; value = error; }
        assert.equal(failed, ["resolver-throw", "hook-throw", "hook-reject"].includes(kind));
        assert.equal(value, failed ? reason : kind === "none" ? undefined : result);
        for (const entry of trace.filter(Array.isArray)) {
          if (entry[0] === "resolve") assert.equal(entry[1], params);
          else { assert.equal(entry[2], context); assert.equal(typeof entry[1], "object"); }
        }
        assert.deepEqual(h.claim.close(), []);
        return trace.map(entry => Array.isArray(entry) ? entry[0] : entry);
      };
      assert.deepEqual(await run(observed), await run(original));
    }
});

test("Qwen v9 replay relations are closed, nonreflective and keep existing annotation limits", () => {
  const base = { v: 9, kind: "observer_failure", case: rows[0].id, parent: 1, observer: 2,
    site: 4, seen: 1, truthy: 1, receipt: false, acquisition: false, parentState: "fulfilled",
    failurePresent: true, reasonDefined: true, route: [1,0,0,0,0,0,0,0,0], callable: [1,0,0,0,0,0,1],
    values: null, valueState: [1,1,8], valueSites: [0,0,0,0,0,0], valueSelection: ["a".repeat(64),15,1,1,1,1,0,0,1,1,1,2] };
  for (const replay of [[0,0,0,0], [1,0,0,0], [1,1,0,0], [1,1,0,1], [1,1,1,2]]) {
    const row = { ...base, valueSelection: [...base.valueSelection.slice(0,8),...replay] };
    assert.deepEqual(qwenObserverRecord(row), row); assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(row)) <= 768);
  }
  for (const replay of [[0,1,0,0], [1,0,1,2], [1,1,1,0], [1,2,0,0], [1,1,0,3], [true,0,0,0]])
    assert.throws(() => qwenObserverRecord({ ...base, valueSelection: [...base.valueSelection.slice(0,8),...replay] }));
  for (const valueSelection of [base.valueSelection.slice(0,11), Object.assign(new Array(13),base.valueSelection),
    [...base.valueSelection.slice(0,8),1,1,1,2,0]]) assert.throws(() => qwenObserverRecord({ ...base, valueSelection }));
  let reads = 0; const accessor = [...base.valueSelection]; Object.defineProperty(accessor,"8",{ get() { reads++; throw undefined; } });
  const proxy = new Proxy([...base.valueSelection], { ownKeys() { reads++; throw undefined; } });
  for (const valueSelection of [accessor,proxy]) assert.throws(() => qwenObserverRecord({ ...base,valueSelection }));
  assert.equal(reads,0);
  const wide = { ...base, case:rows.reduce((a,b)=>a.id.length>b.id.length?a:b).id,parent:65534,observer:65535,
    route:[1,65535,65535,65535,0,0,3,3,2], values:[1,"a".repeat(64),206,7,15,2,9,8,3,3,0],
    valueState:[1,1,0],valueSites:[1,15,1,1,3,1],valueSelection:[null,63,1,1,1,1,1,1,1,1,1,2] };
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(qwenObserverRecord(wide)))<=768);
});

test("Qwen replay recording faults remain separate from falsey resolver failures", async () => {
  const outputs = qwenSelectionSources();
  for (const original of [undefined, null, false, {}]) for (const fault of [undefined, false]) {
    class FailingWeakMap extends WeakMap {
      set(key, value) {
        if (Object.hasOwn(value, "previousBuiltin")) throw fault;
        return super.set(key, value);
      }
    }
    const create = new Function("WeakMap", `return (${createQwenValueSink.toString()});`)(FailingWeakMap);
    const contract = "a".repeat(64), invocation = {}, sink = create(contract);
    sink.activate(1,contract); sink.activate(2,contract);
    const claim = sink.claim(contract,1,()=>invocation); claim.bind(invocation);
    const registry = qwenRegistryFactory(outputs[4],sink)();
    const replay = qwenReplayResolver(outputs[7],sink,()=>{
      registry.registerApiProvider({api:"openai-completions",stream(){},streamSimple(){}});
      throw original;
    });
    let present = false, reason;
    try { await replay({context:{}}); } catch(error) { present = true; reason = error; }
    assert.equal(present,true); assert.equal(reason,original);
    assert.equal(claim.snapshot(invocation,true).valueSelection,null);
    const errors = claim.close(); assert.equal(errors.length,1); assert.equal(errors[0],fault);
  }
});

// Exact D8 generation scope, exercised with an inert frame and the native ALS.
const qwenGenerationScopeSource = "// Keep retained registry reads independent of metadata discovery and plugin loading.\nimport {\n  getPluginExecutionFrame,\n  runWithPluginExecutionFrame,\n} from \"../plugin-instance-invocation.js\";\nimport type { PluginRegistry } from \"../registry-types.js\";\nimport { getPluginRuntimeExecutionFrame, PluginRuntimeExecutionFrame } from \"./execution-frame.js\";\n\nexport function withPluginRuntimeGenerationRegistryScope<T>(\n  registry: PluginRegistry,\n  run: () => T,\n): T {\n  const current = getPluginExecutionFrame();\n  return runWithPluginExecutionFrame(\n    new PluginRuntimeExecutionFrame(\n      current ?? {},\n      getPluginRuntimeExecutionFrame(current)?.gatewayScope,\n      registry,\n    ),\n    run,\n  );\n}\n\n/** Exact registry owned by the prepared generation, including empty selections. */\nexport function getPluginRuntimeGenerationRegistry(): PluginRegistry | undefined {\n  return getPluginRuntimeExecutionFrame()?.generationRegistry;\n}\n\nexport function runOutsidePluginRuntimeGenerationRegistryScope<T>(run: () => T): T {\n  const current = getPluginExecutionFrame();\n  return runWithPluginExecutionFrame(\n    new PluginRuntimeExecutionFrame(\n      current ?? {},\n      getPluginRuntimeExecutionFrame(current)?.gatewayScope,\n      undefined,\n    ),\n    run,\n  );\n}\n";

test("Qwen actual sanitization callback retains the captured provider in a case-owned generation", async () => {
  assert.equal(qwenValueHash(qwenGenerationScopeSource), "dd545702892c9c350b6717ebcf3e6df3596b96ff37e0014f01838ecd4442a2a4");
  const storage = new AsyncLocalStorage();
  class Frame {
    constructor(scopes, gatewayScope, generationRegistry) { Object.assign(this, scopes); this.gatewayScope = gatewayScope; this.generationRegistry = generationRegistry; }
  }
  const code = stripTypeScriptTypes(qwenGenerationScopeSource);
  const start = code.indexOf("export function withPluginRuntimeGenerationRegistryScope");
  assert.ok(start >= 0);
  const scope = new Function("getPluginExecutionFrame", "runWithPluginExecutionFrame", "getPluginRuntimeExecutionFrame", "PluginRuntimeExecutionFrame",
    code.slice(start).replaceAll("export ", "") + "; return { withPluginRuntimeGenerationRegistryScope, getPluginRuntimeGenerationRegistry };")(
      () => storage.getStore(), (frame, run) => storage.run(frame, run), (frame = storage.getStore()) => frame instanceof Frame ? frame : undefined, Frame);
  const anchor = 'withOpenClawTestState({ label: "qwen-regions" }, async state => {';
  const begin = transformed.indexOf(anchor), end = transformed.indexOf('    }));\n    witness.at("convert");', begin);
  assert.ok(begin >= 0 && end > begin);
  const callback = transformed.slice(begin + anchor.length, end);
  const factory = new Function("witness", "resolveTranscriptPolicy", "createEmptyPluginRegistry", "withPluginRuntimeGenerationRegistryScope",
    "sanitizeSessionHistory", "makeInMemorySessionManager", "makeModelSnapshotEntry", "model", "row", "provider", "history",
    "return async state => {" + callback + "};");
  const owned = [];
  const rootFrame = new Frame({}, { pluginId: "caller" }, { outer: true });
  for (const failed of [false, true]) for (const reason of [undefined, false, new Error("synthetic")]) {
    await storage.run(rootFrame, async () => {
      const run = async id => {
        const provider = { id: "qwen", sanitizeReplayHistoryAsync() {} }, model = { provider: "qwen", api: "openai-completions", id };
        const row = { id, model: id }, history = [], state = { workspaceDir: "/fixture/workspace" }, policy = {}, result = [];
        const trace = [], originalErrors = []; let pending, ownRegistry, observations = 0;
        const invoke = factory({
          at(stage) { trace.push(stage); },
          failed(error) { originalErrors.push(error); },
          observe(stage, value) { observations++; assert.equal(stage, "history_sanitize"); assert.equal(value, pending); return value; },
        }, params => { assert.equal(params.runtimeHandle.plugin, provider); return policy; },
        () => { ownRegistry = { providers: [] }; owned.push(ownRegistry); return ownRegistry; },
        scope.withPluginRuntimeGenerationRegistryScope,
        params => {
          assert.equal(scope.getPluginRuntimeGenerationRegistry(), ownRegistry);
          assert.deepEqual(ownRegistry.providers, [{ pluginId: "qwen", provider, source: "test" }]);
          assert.equal(params.messages, history); assert.equal(params.model, model); assert.equal(params.policy, policy);
          assert.equal(params.sessionId, id); assert.equal(params.workspaceDir, state.workspaceDir);
          pending = Promise.resolve().then(() => {
            assert.equal(scope.getPluginRuntimeGenerationRegistry(), ownRegistry, "generation follows the original asynchronous sanitizer");
            if (failed) throw reason;
            return result;
          });
          return pending;
        }, entries => ({ entries }), value => value, model, row, provider, history);
        let caught = false, value;
        try { value = await invoke(state); } catch (error) { caught = true; value = error; }
        assert.equal(caught, failed); assert.equal(value, failed ? reason : result);
        assert.equal(observations, 1); assert.deepEqual(trace, ["history_policy", "history_sanitize"]);
        assert.equal(storage.getStore(), rootFrame, "caller scope restored");
        // Existing callback returns the original promise; rejection is not rewritten by this correction.
        assert.deepEqual(originalErrors, []);
      };
      await Promise.all([run("case-one"), run("case-two")]);
      assert.equal(storage.getStore(), rootFrame);
    });
  }
  assert.equal(new Set(owned).size, owned.length, "concurrent cases never share registries");
  assert.equal(storage.getStore(), undefined);
});

// Closed first-join evidence never grants retirement or changes original errors.
for (const reason of [undefined, false, {}]) test("Qwen first join preserves fault order and survives repeated drains", async () => {
  const ledger = createQwenLedger(), rejection = {};
  let caught = false;
  try { ledger.invoke("read", () => { throw reason; }, undefined, []); }
  catch (error) { caught = true; assert.equal(error, reason); }
  assert.equal(caught, true); ledger.fail(reason); ledger.recordingFailure(reason);
  ledger.observe("read", Promise.reject(rejection));
  const first = ledger.drain(); assert.equal(ledger.drain(), first);
  await assert.rejects(first, error => {
    assert.deepEqual(error.errors, [reason, reason, reason, rejection]); return true;
  });
  const tuple = ledger.joinRecord();
  assert.deepEqual(qwenJoinRecord(tuple), [1,0,0,1,0,0,1,1,0,0,-1,-1,-1,-1,-1]);
  ledger.fail({}); await assert.rejects(ledger.drain()); assert.equal(ledger.joinRecord(), tuple);
  ledger.restore(); await assert.rejects(ledger.drain()); ledger.seal(); assert.equal(ledger.joinRecord(), tuple);
});
for (const mode of ["no_unlock", "throw_unlock", "locked", "released", "getter_throw"]) test(`Qwen first join reader operands preserve ${mode} short circuits`, async () => {
  const ledger = createQwenLedger(), source = qwenInertReader(), reason = {};
  if (mode === "throw_unlock") source.reader.releaseLock = () => { throw reason; };
  ledger.body(source.body); const reader = source.body.getReader();
  if (mode !== "no_unlock") {
    try { reader.releaseLock(); } catch (error) { assert.equal(mode, "throw_unlock"); assert.equal(error, reason); }
  }
  let reads = 0;
  Object.defineProperty(source.body, "locked", { configurable: true, get() {
    reads++; if (mode === "getter_throw") throw reason; return mode === "locked";
  } });
  if (mode === "released") { await ledger.drain(); assert.equal(ledger.joinRecord(), null); }
  else if (mode === "getter_throw") { await assert.rejects(ledger.drain(), error => error === reason); assert.deepEqual(qwenJoinRecord(ledger.joinRecord()).slice(10), [0,1,1,3,2]); }
  else {
    await assert.rejects(ledger.drain());
    const tuple = qwenJoinRecord(ledger.joinRecord());
    assert.equal(tuple[9], 1); assert.deepEqual(tuple.slice(10), mode === "no_unlock" ? [0,0,-1,-1,2] : mode === "throw_unlock" ? [0,1,0,-1,2] : [0,1,1,1,2]);
    assert.equal(tuple[0], mode === "throw_unlock" ? 1 : 0);
  }
  assert.equal(reads, ["no_unlock", "throw_unlock"].includes(mode) ? 0 : 1); ledger.restore();
});
test("Qwen first join preserves independent snapshot failure after original falsey reason", async () => {
  const primary = undefined, reporting = {}, nativeFreeze = Object.freeze;
  let armed = false;
  const faults = Object.create(Object); faults.freeze = value => { if (armed) throw reporting; return nativeFreeze(value); };
  const factory = new Function("utilTypes", "Object", `"use strict"; ${functions}; return createQwenLedger;`)(utilTypes, faults);
  const ledger = factory(); ledger.fail(primary); armed = true;
  await assert.rejects(ledger.drain(), error => error.errors.length === 2 && error.errors[0] === primary && error.errors[1] === reporting);
  assert.equal(ledger.joinRecord(), null); assert.equal(ledger.failures().recording[0], reporting);
  assert.equal(Object.freeze, nativeFreeze);
});
test("Qwen join codec and actual relay reject malformed tuples without growing output", async () => {
  const ledger = createQwenLedger(); ledger.fail(undefined); await assert.rejects(ledger.drain());
  const tuple = qwenJoinRecord(ledger.joinRecord());
  const malformed = [[], [...tuple, 0], Array(15), tuple.map(() => 0), [...tuple.slice(0,10),0,1,1,0,2]];
  for (const [index, value] of [[0,-1],[1,true],[2,65536],[3,1.1],[10,0]]) {
    const changed = [...tuple]; changed[index] = value; malformed.push(changed);
  }
  const hole = [...tuple]; hole.length = 16; malformed.push(hole);
  let reads = 0; const getter = [...tuple]; Object.defineProperty(getter, 0, { get() { reads++; return 0; } }); malformed.push(getter);
  malformed.push(new Proxy(tuple, { ownKeys() { reads++; return []; } }));
  for (const value of malformed) assert.throws(() => qwenJoinRecord(value)); assert.equal(reads, 0);
  const relay = createQwenFailureRelay(), witness = createQwenEntryWitness(value => relay.text("QWEN_ENTRY_V1 " + JSON.stringify(value)));
  witness.moduleEvaluated(); rows.forEach(row => witness.registered(row.id)); witness.registrationComplete();
  const current = witness.enter(rows[0].id), counts = { operations: 0, rejected: 0, pending: 0 };
  current.at("owned_drain"); current.failed(undefined);
  const record = { ...qwenClosedRecord(rows[0].id, "join", "case", "failed", counts), v: 2, join: tuple };
  relay.text("QWEN_SDK_V1 " + JSON.stringify(record)); current.complete(counts);
  const packet = relay.output("failed"); assert.deepEqual(packet.find(row => row.join), record);
  assert.ok(packet.map(qwenBoundaryAnnotation).every(line => Buffer.byteLength(line) <= 768));
  assert.ok(Buffer.byteLength(packet.map(qwenBoundaryAnnotation).join("\n")) <= 8192);
  const max = [65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,-1,-1,2];
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation({ ...record, join: qwenJoinRecord(max) })) <= 768);
  for (const value of malformed.slice(0,10)) assert.throws(() => createQwenFailureRelay().record({ ...record, join: value }));
  assert.throws(() => createQwenFailureRelay().record({ ...record, state: "passed" }));
  assert.equal(relay.complete(), false);
});

test("Qwen first join keeps held observer and reader closed identities distinct", async () => {
  const ledger = createQwenLedger(), source = qwenInertReader(), closedReason = {}, tail = qwenDeferred();
  source.reader.closed = Promise.reject(closedReason); ledger.body(source.body); source.body.getReader();
  let subscriptions = 0;
  ledger.observe("held", { then(yes) { yes(); return ++subscriptions === 1 ? tail.promise : Promise.resolve(); } });
  let finished = false; const joined = ledger.drain().catch(error => { finished = true; return error; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false); assert.equal(ledger.joinRecord(), null);
  tail.resolve(); const error = await joined; assert.equal(error.errors[0], closedReason);
  const tuple = qwenJoinRecord(ledger.joinRecord()); assert.equal(tuple[7], 1); assert.equal(tuple[9], 1);
  assert.deepEqual(tuple.slice(10), [0,0,-1,-1,3]); ledger.restore();
});
test("Qwen locked-operand undefined throw preserves original identity and independent reporting error", async () => {
  const reporting = {}, nativeFreeze = Object.freeze; let armed = false;
  const faults = Object.create(Object); faults.freeze = value => { if (armed) throw reporting; return nativeFreeze(value); };
  const factory = new Function("utilTypes", "Object", `"use strict"; ${functions}; return createQwenLedger;`)(utilTypes, faults);
  for (const reportFails of [false, true]) {
    armed = false; const ledger = factory(), source = qwenInertReader(); ledger.body(source.body);
    const reader = source.body.getReader(); reader.releaseLock(); let reads = 0;
    Object.defineProperty(source.body, "locked", { get() { reads++; throw undefined; } }); armed = reportFails;
    let caught = false; try { await ledger.drain(); } catch (error) {
      caught = true; if (reportFails) assert.deepEqual(error.errors, [undefined, reporting]); else assert.equal(error, undefined);
    }
    assert.equal(caught, true); assert.equal(reads, 1);
    if (reportFails) assert.equal(ledger.joinRecord(), null);
    else assert.deepEqual(qwenJoinRecord(ledger.joinRecord()).slice(10), [0,1,1,2,2]);
    armed = false; ledger.restore();
  }
});

for (const receiver of [undefined, null, {}]) test("Qwen receiver-free release preserves actual receiver, operands and original promise", async () => {
  const ledger = createQwenLedger(), storage = new AsyncLocalStorage(), model = {}, expected = { url: "https://qwen.fixture/chat/completions", credential: "fixture" };
  const owner = createQwenOwnership(storage, ledger, expected), response = { body: null }, releaseP = Promise.resolve(), calls = [];
  const fetchP = Promise.resolve(response), options = { method: "POST", headers: { authorization: "Bearer fixture" } };
  const native = owner.wrapFetch(() => fetchP);
  const originalRelease = function (...args) { calls.push([this, args]); return releaseP; };
  const publicCall = () => owner.guard(() => native(expected.url, options).then(response => ({ response, release: originalRelease })), undefined, []);
  const result = await owner.invoke(publicCall, undefined, [model], {}), detached = result.release;
  const args = [undefined, {}]; assert.equal(Reflect.apply(detached, receiver, args), releaseP);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], receiver); assert.deepEqual(calls[0][1], args);
  owner.closePublic(); await ledger.drain(); owner.verify(1);
  const operation = ledger.operations.find(row => row.kind === "release");
  assert.equal(operation.pending, releaseP); assert.equal(operation.binding.original, originalRelease);
  assert.equal(operation.binding.receiver, receiver); assert.equal(operation.binding.resource, result);
  assert.equal([...owner.acquisitions][0].result, result); assert.deepEqual(ledger.failures().ownership, []);
  assert.equal(ledger.operations.filter(row => row.kind === "release").length, owner.acquisitions.size);
  ledger.restore(); owner.restore(); await ledger.drain(); ledger.seal();
});
for (const mode of ["foreign_response", "foreign_acquisition", "missing_release"]) test(`Qwen detached release does not qualify ${mode}`, async () => {
  const ledger = createQwenLedger(), storage = new AsyncLocalStorage(), expected = { url: "https://qwen.fixture/chat/completions", credential: "fixture" };
  const owner = createQwenOwnership(storage, ledger, expected), response = { body: null }, releaseP = Promise.resolve();
  const native = owner.wrapFetch(() => Promise.resolve(response)); let calls = 0;
  const result = await owner.invoke(() => owner.guard(() => native(expected.url, { method: "POST", headers: { authorization: "Bearer fixture" } }).then(() => ({
    response: mode === "foreign_response" ? { body: null } : response, release() { calls++; return releaseP; }
  })), undefined, []), undefined, [{}], {});
  if (mode === "foreign_acquisition") [...owner.acquisitions][0].result = {};
  if (mode !== "missing_release") { const detached = result.release; assert.equal(detached(), releaseP); }
  owner.closePublic();
  if (mode === "missing_release") {
    await ledger.drain(); owner.verify(1);
    assert.notEqual(ledger.operations.filter(row => row.kind === "release").length, owner.acquisitions.size);
    assert.equal(calls, 0);
  } else {
    await assert.rejects(ledger.drain()); assert.equal(calls, 1);
    assert.ok(ledger.failures().ownership.length > 0);
    if (mode === "foreign_response") assert.throws(() => owner.verify(1));
  }
  ledger.restore(); owner.restore();
});
for (const reason of [undefined, false, {}]) test("Qwen detached release preserves original thrown identity", async () => {
  const ledger = createQwenLedger(), owner = createQwenOwnership(new AsyncLocalStorage(), ledger, { url: "https://qwen.fixture/chat/completions", credential: "fixture" });
  const response = { body: null }, native = owner.wrapFetch(() => Promise.resolve(response)); let calls = 0;
  const result = await owner.invoke(() => owner.guard(() => native("https://qwen.fixture/chat/completions", { method: "POST", headers: { authorization: "Bearer fixture" } }).then(response => ({ response, release() { calls++; throw reason; } })), undefined, []), undefined, [{}], {});
  let caught = false; try { const release = result.release; release(); } catch (error) { caught = true; assert.equal(error, reason); }
  assert.equal(caught, true); assert.equal(calls, 1); assert.deepEqual(ledger.failures().ownership, []);
  await assert.rejects(ledger.drain(), error => error.errors.length === 1 && error.errors[0] === reason);
  ledger.restore(); owner.restore();
});

async function qwenRejectionFixture(mode = "owned", reason, admit = false) {
  if (arguments.length < 2) reason = {};
  let owner;
  const ledger = createQwenLedger((operation, cancellation) => admit && owner.cancelledOriginal(operation, cancellation)), expected = { url: "https://qwen.fixture/chat/completions", credential: "fixture" };
  owner = createQwenOwnership(new AsyncLocalStorage(), ledger, expected);
  const caller = {}, closed = qwenDeferred(), read = qwenDeferred(), cancel = qwenDeferred();
  const releaseReason = {}, releaseP = mode === "release_failure" ? qwenDeferred() : null;
  const reader = { closed: closed.promise, read() { return read.promise; }, cancel() { return cancel.promise; }, releaseLock() { body.locked = false; } };
  const body = { locked: false, cancel() { return Promise.resolve(); }, getReader() { body.locked = true; return reader; } }, response = { body };
  const native = owner.wrapFetch(() => Promise.resolve(response));
  const result = await owner.invoke(() => owner.guard(() => native(expected.url, { method: "POST", headers: { authorization: "Bearer fixture" } }).then(response => ({ response, release: () => releaseP?.promise ?? Promise.resolve() })), undefined, []), undefined, [{}], caller);
  const actual = result.response.body.getReader();
  assert.equal(Reflect.apply(actual.read, mode === "foreign_reader" ? {} : actual, []), read.promise);
  if (mode === "before_cancel") { read.reject(reason); closed.reject(reason); await Promise.resolve(); await Promise.resolve(); }
  if (mode !== "eof") {
    assert.equal(ledger.cancellationArgument(mode === "foreign_invocation" ? {} : caller, reason), reason);
    if (mode !== "before_cancel") closed.reject(reason);
    if (mode === "reused_reason") ledger.cancellationArgument(caller, reason);
    ledger.cancellationReturned();
    assert.equal(actual.cancel(), cancel.promise); cancel.reject(mode === "cancel_failure" ? releaseReason : reason);
    if (!["before_cancel", "held"].includes(mode)) read.reject(reason);
  } else { closed.resolve(); read.resolve({ done: true }); }
  actual.releaseLock(); const detached = result.release; const released = detached();
  if (releaseP) { assert.equal(released, releaseP.promise); releaseP.reject(releaseReason); }
  owner.closePublic();
  return { ledger, owner, caller, closed, read, cancel, reason, releaseReason, close() { ledger.restore(); owner.restore(); } };
}
for (const mode of ["owned", "before_cancel", "foreign_invocation", "foreign_reader", "release_failure", "held"]) test(`Qwen original rejection provenance distinguishes ${mode} without admitting it`, async () => {
  const f = await qwenRejectionFixture(mode); let finished = false;
  const joined = f.ledger.drain().catch(error => { finished = true; return error; });
  if (mode === "held") {
    await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false); assert.equal(f.owner.rejectionRecord(), null); f.read.reject(f.reason);
  }
  const error = await joined; assert.ok(error instanceof AggregateError);
  const record = qwenRejectionRecord(f.owner.rejectionRecord()), originals = record.originals;
  assert.equal(originals.length, mode === "release_failure" ? 4 : 3);
  assert.deepEqual(originals.map(row => row[1]).sort((a,b) => a-b), mode === "release_failure" ? [5,6,8,9] : [5,6,8]);
  assert.ok(originals.every(row => row[6] === 2 && row[7] === 1));
  const resourceRows = originals.filter(row => row[1] !== 9);
  assert.ok(resourceRows.every(row => row[4] === 1 && row[8] === 1 && row[9] === 1));
  if (mode === "foreign_invocation") assert.ok(resourceRows.every(row => row[5] === 1));
  else if (mode === "foreign_reader") assert.equal(resourceRows.find(row => row[1] === 5)[5], 0);
  else assert.ok(resourceRows.every(row => row[5] === 3));
  if (mode === "before_cancel") assert.ok(resourceRows.filter(row => row[1] !== 6).every(row => row[3] < record.cancellation[0]));
  else assert.ok(resourceRows.every(row => row[3] > record.cancellation[1]));
  if (mode === "release_failure") {
    const release = originals.find(row => row[1] === 9); assert.equal(release[4], 0); assert.equal(release[5], 3); assert.equal(release[8], 2);
    assert.ok(error.errors.includes(f.releaseReason));
  }
  const frozen = JSON.stringify(record); await assert.rejects(f.ledger.drain()); assert.equal(JSON.stringify(f.owner.rejectionRecord()), frozen);
  f.close();
});
for (const reason of [undefined, false]) test("Qwen original rejection definedness never promotes equal falsey values to causality", async () => {
  const f = await qwenRejectionFixture("owned", reason); await assert.rejects(f.ledger.drain());
  const record = f.owner.rejectionRecord(); assert.equal(record.cancellation[2], reason === undefined ? 0 : 1);
  assert.ok(record.originals.every(row => row[7] === record.cancellation[2] && row[8] === 1));
  assert.equal(f.ledger.failures().ownership.length, 0); f.close();
});
test("Qwen EOF has no fabricated cancellation or rejection witness", async () => {
  const f = await qwenRejectionFixture("eof"); await f.ledger.drain(); f.owner.verify(1);
  assert.equal(f.owner.rejectionRecord(), null); f.close(); await f.ledger.drain(); f.ledger.seal();
});
test("Qwen rejection records retain bounds, exact tuple keys and original relay admission", async () => {
  const f = await qwenRejectionFixture(); await assert.rejects(f.ledger.drain());
  const record = f.owner.rejectionRecord();
  const malformed = [{ ...record, extra: 0 }, { ...record, cancellation: [0,1,1] }, { ...record, cancellation: [3,2,1] }, { ...record, originals: [...record.originals, ...record.originals] }];
  for (const [index, value] of [[0,0],[1,11],[2,0],[3,0],[4,-1],[5,2],[6,0],[7,-1],[8,3],[9,0]]) {
    const rows = record.originals.map(row => [...row]); rows[0][index] = value; malformed.push({ ...record, originals: rows });
  }
  const sparse = [...record.originals[0]]; sparse.length = 11; malformed.push({ ...record, originals: [sparse] });
  let reads = 0; const accessor = [...record.originals[0]]; Object.defineProperty(accessor, 0, { get() { reads++; return 1; } });
  malformed.push({ ...record, originals: [accessor] }, new Proxy(record, { ownKeys() { reads++; return []; } }));
  for (const value of malformed) assert.throws(() => qwenRejectionRecord(value)); assert.equal(reads, 0);
  const relay = createQwenFailureRelay(), witness = createQwenEntryWitness(value => relay.text("QWEN_ENTRY_V1 " + JSON.stringify(value)));
  witness.moduleEvaluated(); rows.forEach(row => witness.registered(row.id)); witness.registrationComplete();
  const current = witness.enter(rows[0].id), counts = { operations: f.ledger.operations.length, rejected: 3, pending: 0 };
  current.at("owned_drain"); current.failed(undefined);
  const diagnostic = { ...qwenClosedRecord(rows[0].id, "join", "closed", "failed", counts), v: 3, join: f.ledger.joinRecord(), rejections: record };
  relay.text("QWEN_SDK_V1 " + JSON.stringify(diagnostic)); current.complete(counts);
  const packet = relay.output("failed"); assert.deepEqual(packet.find(row => row.v === 3), diagnostic);
  const maximum = { cancellation: [65533,65534,1], originals: Array.from({ length: 4 }, (_, i) => [65531+i,5,65530,65535,65535,3,2,1,1,1]) };
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation({ ...diagnostic, rejections: qwenRejectionRecord(maximum) })) <= 768);
  assert.ok(Buffer.byteLength(packet.map(qwenBoundaryAnnotation).join("\n")) <= 8192);
  assert.throws(() => createQwenFailureRelay().record({ ...diagnostic, rejections: { ...record, originals: [] } }));
  f.close();
  const ledger = createQwenLedger(), owner = createQwenOwnership(new AsyncLocalStorage(), ledger, { url: "https://qwen.fixture", credential: "fixture" });
  for (let i = 0; i < 5; i++) ledger.observe("read", Promise.reject(undefined));
  await assert.rejects(ledger.drain()); assert.deepEqual(owner.rejectionRecord(), { cancellation: [0,0,-1], originals: null });
});

test("Qwen actual cancellation expression preserves callee, argument, receiver and throw order", () => {
  const expression = fixtureText.split("\n").find(line => line.includes('partial = true; controller.abort(ledger.cancellationArgument'));
  assert.ok(expression);
  const invoke = new Function("controller", "ledger", "callerToken", "Error", `"use strict"; let partial = false; ${expression}; return partial;`);
  for (const fail of [false, true]) for (const reason of [undefined, {}]) {
    const trace = [], caller = {}, marker = {}, ledger = {
      cancellationArgument(token, value) { trace.push("argument"); assert.equal(token, caller); assert.equal(value, marker); return value; },
      cancellationReturned() { trace.push("returned"); },
    };
    const controller = Object.defineProperty({}, "abort", { get() {
      trace.push("callee"); return function (...args) { trace.push("call"); assert.equal(this, controller); assert.deepEqual(args, [marker]); if (fail) throw reason; };
    } });
    const Error = function () { trace.push("construct"); return marker; };
    let caught = false; try { assert.equal(invoke(controller, ledger, caller, Error), true); }
    catch (error) { caught = true; assert.equal(error, reason); }
    assert.equal(caught, fail); assert.deepEqual(trace, ["callee", "construct", "argument", "call", ...(!fail ? ["returned"] : [])]);
  }
});

for (const mode of ["owned", "before_cancel", "foreign_invocation", "foreign_reader", "release_failure", "cancel_failure", "reused_reason", "held"]) test(`Qwen partial-abort disposition keeps ${mode} source-bound`, async () => {
  const reason = new Error("fixture cancellation"), f = await qwenRejectionFixture(mode, reason, true);
  let finished = false; const joined = f.ledger.drain().then(() => { finished = true; }, error => { finished = true; return error; });
  if (mode === "held") { await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false); f.read.reject(reason); }
  const error = await joined;
  if (["owned", "held"].includes(mode)) {
    assert.equal(error, undefined); f.owner.verify(1); assert.equal(f.ledger.joinRecord(), null);
    assert.equal(f.ledger.operations.filter(row => row.state === "rejected").length, 3);
    assert.ok(f.ledger.operations.filter(row => row.state === "rejected").every(row => row.reason === reason));
    f.close(); await f.ledger.drain(); f.ledger.seal();
  } else {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.includes(mode === "release_failure" || mode === "cancel_failure" ? f.releaseReason : reason)); f.close();
  }
});
for (const reason of [undefined, false, null, "fixture cancellation"]) test("Qwen abort disposition never admits equal primitive or undefined reasons", async () => {
  const f = await qwenRejectionFixture("owned", reason, true);
  await assert.rejects(f.ledger.drain(), error => error.errors.length === 3 && error.errors.every(value => Object.is(value, reason))); f.close();
});
test("Qwen real reader abort rejections retain original identity and retire independently", async () => {
  let owner, controller;
  const ledger = createQwenLedger((operation, cancellation) => owner.cancelledOriginal(operation, cancellation));
  const expected = { url: "https://qwen.fixture/chat/completions", credential: "fixture" }, caller = {}, abort = new AbortController();
  owner = createQwenOwnership(new AsyncLocalStorage(), ledger, expected);
  const body = new ReadableStream({ start(value) { controller = value; } });
  abort.signal.addEventListener("abort", () => controller.error(abort.signal.reason), { once: true });
  const native = owner.wrapFetch(() => Promise.resolve(new Response(body)));
  const result = await owner.invoke(() => owner.guard(() => native(expected.url, { method: "POST", headers: { authorization: "Bearer fixture" } }).then(response => ({ response, release: () => Promise.resolve() })), undefined, []), undefined, [{}], caller);
  const reader = result.response.body.getReader(), original = reader.read();
  const reason = new Error("fixture cancellation"); abort.abort(ledger.cancellationArgument(caller, reason)); ledger.cancellationReturned();
  const cancelled = reader.cancel(); reader.releaseLock(); const detached = result.release; await detached(); owner.closePublic();
  await ledger.drain(); owner.verify(1);
  assert.equal(ledger.operations.find(row => row.kind === "read").pending, original);
  assert.equal(ledger.operations.find(row => row.kind === "cancel").pending, cancelled);
  assert.deepEqual(ledger.operations.filter(row => row.state === "rejected").map(row => row.kind), ["closed", "read", "cancel"]);
  assert.ok(ledger.operations.filter(row => row.state === "rejected").every(row => row.reason === reason));
  assert.equal(body.locked, false); ledger.restore(); owner.restore(); await ledger.drain(); ledger.seal();
});
test("Qwen successful reader release alone does not fabricate caller-abort admission", async () => {
  let owner;
  const ledger = createQwenLedger((operation, cancellation) => owner.cancelledOriginal(operation, cancellation));
  owner = createQwenOwnership(new AsyncLocalStorage(), ledger, { url: "https://qwen.fixture", credential: "fixture" });
  const body = new ReadableStream(); ledger.body(body); const reader = body.getReader(); reader.read(); reader.releaseLock();
  await assert.rejects(ledger.drain(), error => error.errors.length === 2 && error.errors.every(reason => reason instanceof TypeError));
  assert.equal(body.locked, false); assert.equal(ledger.readers[0].returns, 1); ledger.restore(); owner.restore();
});
for (const fault of [undefined, false, {}]) test("Qwen disposition failure preserves original then independent falsey fault", async () => {
  const reason = {}, ledger = createQwenLedger(() => { throw fault; });
  ledger.observe("read", Promise.reject(reason)); ledger.cancellationArgument({}, {}); ledger.cancellationReturned();
  await assert.rejects(ledger.drain(), error => error.errors.length === 2 && error.errors[0] === reason && error.errors[1] === fault);
});

test("Qwen partial-abort completion preserves rejected counts through the actual witness and relay", async () => {
  const f = await qwenRejectionFixture("owned", new Error("fixture cancellation"), true); await f.ledger.drain();
  const relay = createQwenFailureRelay(), emitted = [];
  const witness = createQwenEntryWitness(value => { emitted.push(value); relay.text("QWEN_ENTRY_V1 " + JSON.stringify(value)); });
  witness.moduleEvaluated(); for (const row of rows) witness.registered(row.id); witness.registrationComplete();
  for (const row of rows) {
    const entry = witness.enter(row.id), partial = row.mode === "partial";
    const counts = partial ? { operations: f.ledger.operations.length, rejected: 3, pending: 0 } : { operations: 0, rejected: 0, pending: 0 };
    entry.complete(counts, partial ? f.ledger.cancelledCount() : 0);
  }
  assert.deepEqual(witness.takeErrors(), []);
  assert.equal(emitted.filter(row => row.v === 2).length, 6);
  for (const row of emitted.filter(row => row.v === 2)) { assert.equal(row.cancelled, 3); assert.equal(row.rejected, 3); assert.equal(row.state, "passed"); }
  assert.doesNotThrow(() => relay.output("passed"));
  const valid = emitted.find(row => row.v === 2);
  for (const change of [{v:1}, {cancelled:0}, {cancelled:2}, {cancelled:3.5}, {pending:1}, {kind:"case_enter"}, {state:"failed",failurePresent:true,reasonDefined:true,stage:"owned_drain"}, {case:rows[0].id,index:0}, {extra:true}]) assert.throws(() => qwenEntryRecord({...valid,...change}));
  const { cancelled, ...old } = valid; old.v = 1; assert.throws(() => qwenEntryRecord(old));
  assert.deepEqual(qwenEntryRecord({...old,rejected:0}), {...old,rejected:0});
  f.close(); await f.ledger.drain(); f.ledger.seal();
});
test("Qwen accepted cancellation cannot erase unrelated original or observer failure diagnostics", async () => {
  const f = await qwenRejectionFixture("owned", new Error("fixture cancellation"), true), unrelated = {};
  f.ledger.observe("caller", Promise.reject(unrelated)); f.ledger.recordingFailure(undefined);
  await assert.rejects(f.ledger.drain(), error => error.errors.includes(unrelated) && error.errors.includes(undefined));
  assert.equal(f.ledger.cancelledCount(), 3); assert.equal(f.ledger.joinRecord()[7], 4);
  assert.equal(f.owner.rejectionRecord().originals.length, 4); assert.equal(f.ledger.operations.filter(row=>row.state === "rejected").length, 4); f.close();
});

async function qwenSdkSignalFixture(mode = "owned", admit = false, mutate) {
  class ControlledAPIError extends Error {
    constructor() { super("synthetic provider error"); this.status = undefined; this.code = "synthetic_error"; this.error = { code: "synthetic_error", message: "synthetic provider error" }; }
  }
  const ledger = createQwenLedger(undefined, operation => admit && owner.providerErrorOriginal(operation)), storage = new AsyncLocalStorage(), caller = {}, callerAbort = new AbortController(), sdkAbort = new AbortController();
  const expected = { url: "https://qwen.fixture/chat/completions", credential: "fixture" }, owner = createQwenOwnership(storage, ledger, expected);
  owner.installSdkErrors(ControlledAPIError.prototype);
  const closed = qwenDeferred(), read = qwenDeferred(), cancel = qwenDeferred(), reason = {}, output = { stopReason: "error", errorMessage: "synthetic provider error" };
  const reader = { closed: closed.promise, read() { return read.promise; }, cancel() { return cancel.promise; }, releaseLock() { body.locked = false; } };
  const body = { locked: false, getReader() { body.locked = true; return reader; }, cancel() { return Promise.resolve(); } }, response = { body };
  let getterCalls = 0;
  const input = mode === "input_proxy" ? new Proxy({}, { getOwnPropertyDescriptor() { getterCalls++; throw undefined; } }) : { signal: sdkAbort.signal };
  if (mode === "accessor") Object.defineProperty(input, "signal", { get() { getterCalls++; throw undefined; }, configurable: true });
  if (mode === "unbranded") input.signal = {};
  if (mode === "signal_proxy") input.signal = new Proxy(sdkAbort.signal, { get() { getterCalls++; throw undefined; } });
  const fetch = owner.wrapFetch(() => Promise.resolve(response));
  let originalError, originalResult;
  const returned = await owner.invoke(async () => {
    const result = await owner.guard(() => fetch(expected.url, { method: "POST", headers: { authorization: "Bearer fixture" } }).then(response => ({ response, release: () => Promise.resolve() })), undefined, [input]);
    const actual = result.response.body.getReader(); actual.read();
    sdkAbort.abort(reason); closed.reject(reason); read.reject(reason); actual.cancel(); cancel.reject(reason);
    actual.releaseLock(); const release = result.release; await release();
    if (mode === "changed_input") input.signal = new AbortController().signal;
    originalError = new ControlledAPIError();
    if (mode === "wrong_message") originalError.message = "unrelated";
    if (mode === "wrong_code") originalError.code = "unrelated";
    if (mode === "foreign_error") Object.setPrototypeOf(originalError, Error.prototype);
    if (mode === "error_accessor") Object.defineProperty(originalError, "code", { get() { getterCalls++; throw undefined; } });
    if (mode === "different_reason") originalError = reason;
    const params = { error: originalError, output, signal: mode === "foreign_caller" ? new AbortController().signal : callerAbort.signal };
    const observe = () => owner.observeSdkFailure(params);
    if (mode === "absent_context") storage.run(undefined, observe); else observe();
    if (mode === "duplicate") observe();
    originalResult = result; return output;
  }, undefined, [{}, {}, { signal: callerAbort.signal }], caller);
  owner.observeCallerResult(mode === "foreign_output" ? {} : returned, caller); owner.closePublic();
  mutate?.({ owner, ledger, output, originalResult, originalError, reason, reader, response, sdkAbort, callerAbort });
  let failure;
  try { await ledger.drain(); } catch (error) { failure = { error }; }
  if (!admit) assert.ok(failure);
  return { owner, ledger, getterCalls, originalError, originalResult, output, failure, rows: owner.sdkSignalRecord(),
    admit() { admit = true; }, close() { ledger.restore(); owner.restore(); } };
}
for (const mode of ["owned", "accessor", "input_proxy", "signal_proxy", "unbranded", "changed_input", "wrong_message", "wrong_code", "foreign_error", "error_accessor", "different_reason", "foreign_caller", "foreign_output", "absent_context", "duplicate"]) test(`Qwen SDK signal witness keeps ${mode} qualified or unknown`, async () => {
  const f = await qwenSdkSignalFixture(mode), row = f.rows[0];
  assert.equal(f.getterCalls, 0); assert.equal(f.rows.length, 3);
  assert.ok(f.ledger.operations.filter(row=>row.state === "rejected").length >= 3);
  if (["foreign_caller", "absent_context", "duplicate"].includes(mode)) assert.deepEqual(row.slice(1), [0,0,0,0,0,0]);
  else {
    assert.equal(row[1], 1); assert.equal(row[2], ["wrong_message","wrong_code","foreign_error","error_accessor","different_reason"].includes(mode) ? 0 : 1);
    assert.equal(row[3], mode === "foreign_output" ? 0 : 1);
    if (["accessor","input_proxy","signal_proxy","unbranded","changed_input"].includes(mode)) assert.deepEqual(row.slice(4), [0,0,0]);
    else assert.deepEqual(row.slice(4), [2,1,mode === "different_reason" ? 1 : 2]);
  }
  assert.equal(f.ledger.failures().recording.length, mode === "unbranded" ? 1 : 0);
  assert.deepEqual(qwenSdkSignalRecord(f.rows, f.owner.rejectionRecord()), f.rows); f.close();
});
for (const fault of [undefined, false, {}]) test("Qwen native signal observer faults remain independent and falsey", () => {
  const ledger = createQwenLedger(), signal = new AbortController().signal, callerSignal = new AbortController().signal;
  const invocation = { args: [{}, {}, { signal: callerSignal }], caller: {} }, acquisition = { invocation, input: { signal } };
  class ErrorType extends Error {}
  const observer = createQwenSdkErrorWitness(ledger, () => invocation, new Set([acquisition]), ErrorType.prototype, () => { throw fault; }, () => undefined);
  observer.input(acquisition); const error = new ErrorType(), output = {};
  observer.failure({ error, output, signal: callerSignal }); observer.result(output, invocation.caller);
  assert.deepEqual(ledger.failures().recording, [fault]);
  assert.deepEqual(observer.row({ ordinal: 1, state: "rejected", reason: error }, acquisition), [1,1,0,1,0,0,0]);
});
test("Qwen actual SDK-failure wrapper preserves original receiver, arguments, return and falsey throws", () => {
  const marker = 'vi.spyOn(transportStream, "failTransportStream").mockImplementation(';
  const start = fixtureText.indexOf(marker) + marker.length, end = fixtureText.indexOf('\n    });', start) + 6;
  assert.ok(start > marker.length && end > start);
  const fn = stripTypeScriptTypes('const wrapper = ' + fixtureText.slice(start, end) + ';');
  for (const thrown of [false,true]) for (const result of [undefined,false,{}]) {
    const trace = [], receiver = {}, args = [{ error: {} }, {}];
    const original = function (...actual) { trace.push("original"); assert.equal(this,receiver); assert.deepEqual(actual,args); if(thrown)throw result;return result; };
    const observe = { observeSdkFailure(value) { trace.push("observe"); assert.equal(value,args[0]); } };
    const wrapper = new Function("ownership","originalSdkFailure",`"use strict"; ${fn};return wrapper;`)(observe,original);
    let caught = false;try{assert.equal(Reflect.apply(wrapper,receiver,args),result);}catch(error){caught=true;assert.equal(error,result);}
    assert.equal(caught,thrown);assert.deepEqual(trace,["observe","original"]);
  }
});
test("Qwen v4 SDK signal tuple preserves old grammars and existing bounds", async () => {
  const f = await qwenSdkSignalFixture(), rejections = f.owner.rejectionRecord(), sdk = f.rows;
  const counts = { operations: f.ledger.operations.length, rejected: 3, pending: 0 };
  const record = { ...qwenClosedRecord("qr0_provider_error_stream", "join", "closed", "failed", counts), v: 4, join: f.ledger.joinRecord(), rejections, sdk };
  const relay=createQwenFailureRelay();relay.record(record);assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(record))<=768);
  const invalid = [[...sdk, sdk[0]], sdk.slice(1)];
  for(const [slot,value] of [[0,0],[1,2],[2,-1],[3,2],[4,3],[5,3],[6,-1]]){const copy=sdk.map(row=>[...row]);copy[0][slot]=value;invalid.push(copy);}
  const sparse=[...sdk[0]];sparse.length=8;invalid.push([sparse,...sdk.slice(1)]);
  let touches=0;const accessor=[...sdk[0]];Object.defineProperty(accessor,2,{get(){touches++;return 1;}});invalid.push([accessor,...sdk.slice(1)]);
  invalid.push(new Proxy(sdk,{ownKeys(){touches++;return [];}}));for(const value of invalid)assert.throws(()=>qwenSdkSignalRecord(value,rejections));assert.equal(touches,0);
  const maxRejections={cancellation:[65533,65534,1],originals:Array.from({length:4},(_,i)=>[65531+i,5,65530,65535,65535,3,2,1,1,1])};
  const maxSdk=maxRejections.originals.map(row=>[row[0],1,1,1,2,1,2]);
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation({...record,rejections:maxRejections,sdk:qwenSdkSignalRecord(maxSdk,maxRejections)}))<=768);
  const {sdk:omitted,...v3}=record;v3.v=3;assert.doesNotThrow(()=>createQwenFailureRelay().record(v3));assert.throws(()=>createQwenFailureRelay().record({...record,sdk:[]}));f.close();
});

test("Qwen controlled provider error admits only its complete owned SDK-abort group", async () => {
  const f = await qwenSdkSignalFixture("owned", true);
  assert.equal(f.failure, undefined); assert.equal(f.ledger.providerCancelledCount(), 3); assert.equal(f.ledger.cancelledCount(), 0);
  const rejected = f.ledger.operations.filter(row => row.state === "rejected");
  assert.deepEqual(rejected.map(row => row.kind), ["closed", "read", "cancel"]);
  assert.equal(new Set(rejected.map(row => row.reason)).size, 1);
  assert.notEqual(rejected[0].reason, f.originalError);
  f.owner.verify(1); f.close(); await f.ledger.drain(); f.ledger.seal();
  assert.equal(f.ledger.providerCancelledCount(), 3);
});
for (const mode of ["accessor", "input_proxy", "signal_proxy", "unbranded", "changed_input", "wrong_message", "wrong_code", "foreign_error", "error_accessor", "different_reason", "foreign_caller", "foreign_output", "absent_context", "duplicate"])
  test(`Qwen provider disposition rejects ${mode} evidence`, async () => {
    const f = await qwenSdkSignalFixture(mode, true);
    assert.ok(f.failure); assert.equal(f.ledger.providerCancelledCount(), 0);
    assert.equal(f.getterCalls, 0); assert.ok(f.ledger.operations.filter(row => row.state === "rejected").length >= 3); f.close();
  });
for (const [name, mutate] of [
  ["wrong outcome", ({ output }) => { output.stopReason = "stop"; }],
  ["wrong output error", ({ output }) => { output.errorMessage = "another error"; }],
  ["foreign reader", ({ ledger }) => { ledger.readers[0].owner = {}; }],
  ["foreign generation", ({ ledger }) => { ledger.readers[0].generation = {}; }],
  ["foreign response", ({ ledger }) => { ledger.readers[0].response = {}; }],
  ["missing release", ({ ledger }) => { ledger.operations.find(row => row.kind === "release").binding = {}; }],
  ["foreign original", ({ ledger }) => { ledger.operations.find(row => row.kind === "read").binding = {}; }],
  ["foreign original reason", ({ ledger }) => { ledger.operations.find(row => row.kind === "read").reason = {}; }],
  ["undefined original reason", ({ ledger }) => { ledger.operations.find(row => row.kind === "read").reason = undefined; }],
  ["missing original", ({ ledger }) => { ledger.operations.find(row => row.kind === "cancel").kind = "body_cancel"; }],
  ["wrong receiver", ({ ledger }) => { const row = ledger.operations.find(row => row.kind === "read"); row.binding = { ...row.binding, receiver: {} }; }],
  ["unlock missing", ({ ledger }) => { ledger.readers[0].unlocks = 0; }],
  ["unlock duplicated", ({ ledger }) => { ledger.readers[0].unlocks = 2; }],
  ["release did not return", ({ ledger }) => { ledger.readers[0].returns = 0; }],
]) test(`Qwen provider disposition keeps ${name} fatal`, async () => {
  const f = await qwenSdkSignalFixture("owned", true, mutate);
  assert.ok(f.failure); assert.equal(f.ledger.providerCancelledCount(), 0); f.close();
});
for (const [name, mutate] of [
  ["synchronous", ({ ledger }, reason) => ledger.invoke("release", () => { throw reason; }, undefined, [])],
  ["ownership", ({ ledger }, reason) => ledger.fail(reason)],
  ["recording", ({ ledger }, reason) => ledger.recordingFailure(reason)],
  ["unrelated original", ({ ledger }, reason) => ledger.observe("caller", Promise.reject(reason))],
  ["release rejection", ({ ledger, originalResult }, reason) => ledger.invoke("release", () => Promise.reject(reason), undefined, [], originalResult)],
  ["observer", ({ ledger }, reason) => ledger.follow("observer", Promise.resolve(), [() => { throw reason; }])],
]) for (const reason of [undefined, false, {}]) test(`Qwen provider disposition preserves independent ${name} identity`, async () => {
  const f = await qwenSdkSignalFixture("owned", true, args => { try { mutate(args, reason); } catch (error) { assert.equal(error, reason); } });
  assert.ok(f.failure); assert.ok(f.failure.error.errors.some(error => Object.is(error, reason))); f.close();
});
test("Qwen provider disposition still joins a held independent original", async () => {
  const f = await qwenSdkSignalFixture(), held = qwenDeferred(); f.admit();
  f.ledger.observe("caller", held.promise); let completed = false;
  const joining = f.ledger.drain().finally(() => { completed = true; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(completed, false);
  held.resolve(); await joining; assert.equal(f.ledger.providerCancelledCount(), 3); f.close();
});
test("Qwen provider disposition cannot hide restoration failure", async () => {
  const f = await qwenSdkSignalFixture("owned", true);
  f.ledger.readers[0].reader.read = () => Promise.resolve();
  assert.throws(() => f.ledger.restore()); f.owner.restore();
  await assert.rejects(f.ledger.drain(), error => error.errors.length > 0);
});
test("Qwen v3 completion retains controlled provider rejections without extending v1 or v2", async () => {
  const f = await qwenSdkSignalFixture("owned", true), relay = createQwenFailureRelay(), emitted = [];
  const witness = createQwenEntryWitness(value => { emitted.push(value); relay.text("QWEN_ENTRY_V1 " + JSON.stringify(value)); });
  witness.moduleEvaluated(); for (const row of rows) witness.registered(row.id); witness.registrationComplete();
  for (const row of rows) {
    const entry = witness.enter(row.id), provider = row.mode === "provider_error";
    entry.complete(provider ? { operations: f.ledger.operations.length, rejected: 3, pending: 0 } : { operations: 0, rejected: 0, pending: 0 }, 0, provider ? f.ledger.providerCancelledCount() : 0);
  }
  assert.deepEqual(witness.takeErrors(), []); assert.doesNotThrow(() => relay.output("passed"));
  const accepted = emitted.filter(row => row.v === 3); assert.equal(accepted.length, 6);
  for (const row of accepted) { assert.equal(row.providerCancelled, 3); assert.equal(row.rejected, 3); }
  const valid = accepted[0];
  for (const patch of [{v:1}, {v:2}, {providerCancelled:0}, {providerCancelled:2}, {providerCancelled:4}, {providerCancelled:3.5}, {rejected:0}, {pending:1}, {case:rows[0].id,index:0}, {state:"failed",failurePresent:true,reasonDefined:true,stage:"owned_drain"}, {cancelled:3}, {extra:true}]) assert.throws(() => qwenEntryRecord({...valid,...patch}));
  const { providerCancelled, ...old } = valid; old.v = 1;
  assert.throws(() => qwenEntryRecord(old)); assert.doesNotThrow(() => qwenEntryRecord({...old,rejected:0}));
  f.close();
});

test("Qwen relay completeness reconciles qualified original rejections in either record order", () => {
  for (const sdkFirst of [false, true]) {
    const relay = createQwenFailureRelay(), witness = createQwenEntryWitness(value => relay.text("QWEN_ENTRY_V1 " + JSON.stringify(value)));
    witness.moduleEvaluated(); for (const row of rows) witness.registered(row.id); witness.registrationComplete();
    for (const row of rows) {
      const entry = witness.enter(row.id), partial = row.mode === "partial", provider = row.mode === "provider_error";
      const counts = { operations: 10, rejected: partial || provider ? 3 : 0, pending: 0 };
      const original = qwenClosedRecord(row.id, "join", "closed", "passed", counts);
      if (sdkFirst) relay.text(closedSDKLine(original));
      entry.complete(counts, partial ? 3 : 0, provider ? 3 : 0);
      if (!sdkFirst) relay.text(closedSDKLine(original));
    }
    assert.deepEqual(witness.takeErrors(), []); assert.equal(relay.complete(), true);
  }
});
test("Qwen relay cannot qualify mismatched, missing or unclassified rejected originals", () => {
  for (const sdkFirst of [false, true]) for (const mode of ["counts", "failure", "missing", "unclassified"]) {
    const relay = createQwenFailureRelay(), emitted = [];
    const witness = createQwenEntryWitness(value => { emitted.push(value); relay.text("QWEN_ENTRY_V1 " + JSON.stringify(value)); });
    witness.moduleEvaluated(); for (const row of rows) witness.registered(row.id); witness.registrationComplete();
    const row = rows.find(row => row.mode === "provider_error"), entry = witness.enter(row.id);
    const counts = { operations: 10, rejected: 3, pending: 0 };
    const original = qwenClosedRecord(row.id, "join", "closed", mode === "failure" ? "failed" : "passed",
      {...counts,rejected:mode === "counts" ? 2 : 3});
    if (sdkFirst && mode !== "missing") relay.text(closedSDKLine(original));
    entry.complete(counts, 0, mode === "unclassified" ? 0 : 3);
    if (!sdkFirst && mode !== "missing") {
      if (["counts", "failure"].includes(mode)) assert.throws(() => relay.text(closedSDKLine(original)));
      else relay.text(closedSDKLine(original));
    }
    if (mode === "unclassified" || sdkFirst && ["counts", "failure"].includes(mode)) assert.ok(witness.takeErrors().length);
    assert.equal(relay.complete(), false);
  }
});

async function qwenWorkerWitnessFixture(mode = "owned", outcome) {
  const ledger=createQwenLedger(), state={ledger,receipts:new Set()}, storage=new AsyncLocalStorage();
  const incoming=new AbortController(), upstream=new AbortController(), reason={}, unrelated={};
  const request=new Request("https://worker.fixture/",{signal:incoming.signal});
  const ownership=createQwenRequestOwnership(storage,Object.getOwnPropertyDescriptor(Request.prototype,"signal").get);
  const closed=qwenDeferred(), read=qwenDeferred(), cancellation=qwenDeferred(), repeated=qwenDeferred();
  let calls=0;
  const reader={closed:closed.promise,read(){return read.promise;},cancel(){return ++calls===1?cancellation.promise:repeated.promise;},releaseLock(){if(mode==="release")throw undefined;body.locked=false;}};
  const body={locked:false,getReader(){body.locked=true;return reader;},cancel(){return Promise.resolve();}}, response={body};
  let receipt;
  await ownership.invoke(state,request,async()=>{
    const owner=ownership.current(), original=async()=>response, receiver={}, args=[];
    receipt={owner,response,signal:upstream.signal,original,receiver,args};state.receipts.add(receipt);
    receipt.pending=ledger.invoke("fetch",original,receiver,args,receipt);
    await ledger.follow("fetch_observer",receipt.pending,[value=>ledger.response(value,receipt)]);
    const actual=body.getReader();
    if(outcome && mode==="read_after_cancel"){actual.cancel(undefined);cancellation.resolve();}
    actual.read();
    if(outcome){
      if(mode==="pre_cancel"){read.reject(outcome.reason);await Promise.resolve();}
      incoming.abort(reason);upstream.abort(reason);
      if(mode!=="read_after_cancel")actual.cancel(undefined);
      if(mode==="failed_cancel")cancellation.reject(outcome.reason);else cancellation.resolve();
      if(mode==="failed_closed")closed.reject(outcome.reason);else closed.resolve();
      if(mode!=="pre_cancel")read.reject(outcome.reason);
      if(mode==="repeated"){actual.cancel(undefined);repeated.resolve();}
      // Match the shipping owner's allSettled(read,cancel) before release.
      await Promise.allSettled([read.promise,cancellation.promise,closed.promise]);
    }
    else if(mode==="eof"){closed.resolve();read.resolve();}
    else {
      if(mode==="pre_cancel"){read.reject(unrelated);await Promise.resolve();}
      incoming.abort(reason);upstream.abort(reason);closed.reject(reason);
      if(mode!=="pre_cancel")read.reject(reason);
      actual.cancel(reason);cancellation.reject(reason);
      if(mode==="repeated"){actual.cancel(reason);repeated.reject(reason);}
    }
    try{actual.releaseLock();}catch(error){assert.equal(error,undefined);}
  },undefined,[request]);
  if(mode==="foreign")receipt.owner={...receipt.owner};
  if(mode==="unknown_signal")receipt.signal=undefined;
  if(mode==="accounting")ledger.observe("usage_ingest",Promise.reject(unrelated));
  if(outcome && ["control","source_tail","same_accounting"].includes(mode))
    ledger.observe(mode==="same_accounting"?"usage_ingest":mode==="control"?"control_body":"waitUntil",Promise.reject(outcome.reason));
  if(outcome && mode==="observer")ledger.follow("independent_observer",read.promise,[undefined,()=>{throw outcome.reason;}]);
  if(outcome && mode==="recording")ledger.recordingFailure(outcome.reason);
  let error;try{await ledger.drain();}catch(value){error=value;}
  const record=captureQwenWorkerFailure(state);
  return {ledger,state,record,error,reason,unrelated,receipt,close(restored=false){if(!restored)ledger.restore();ownership.retire(state);}};
}

async function qwenWorkerAssessmentFixture(mode = "owned", outcome) {
  const f = await qwenWorkerWitnessFixture(mode, outcome);
  f.state.row = rows.find(row => row.mode === "partial"); f.state.requests = 1; f.state.status = 200;
  f.source = { held: 0, canceled: 1, cancelReturns: 1, active: 0, expired: 0, settled: 1, calls: [{}] };
  f.usage = { events: [{ status: "client_error", credential_id: f.state.row.id,
    provider: f.state.row.provider, model: f.state.row.provider + "/" + f.state.row.model }] };
  if(outcome)Object.assign(f.usage.events[0],{actual_cost_micros:7,cost_basis:"policy_fixed",input_tokens:null,output_tokens:null,total_tokens:null,cached_input_tokens:null});
  f.budget={ledger:"durable_object",limitMicros:100,spentMicros:7};
  f.ledger.restore();
  try { await f.ledger.drain(); } catch (error) { f.finalError = error; }
  f.sealed = f.ledger.seal();
  f.assess = () => qwenWorkerCancellation(f.state, f.source, f.usage, f.sealed, f.budget);
  return f;
}
test("Qwen Worker one-read outcome retains distinct and undefined original reasons", async () => {
  for(const reason of [{},undefined]){
    const f=await qwenWorkerAssessmentFixture("owned",{reason}),before=f.ledger.operations.map(row=>({...row}));
    const group=f.assess();assert.equal(group.length,1);assert.equal(group[0].kind,"read");
    assert.equal(group[0].state,"rejected");assert.equal(group[0].reason,reason);
    assert.equal(f.ledger.joinRecord()[7],1);assert.equal(f.record.originals.length,1);
    assert.ok(["closed","cancel"].every(kind=>f.ledger.operations.find(row=>row.kind===kind).state==="fulfilled"));
    const origins=new Set([f.error,f.finalError]);
    assert.equal(qwenWorkerCancellationFailure(f.error,group,origins),true);
    assert.equal(qwenWorkerCancellationFailure(f.finalError,group,origins),true);
    const foreign=new AggregateError([reason]);
    assert.equal(qwenWorkerCancellationFailure(foreign,group,origins),false);
    assert.equal(qwenWorkerCancellationFailure(f.error,group,new Set()),false);
    for(const extra of [reason,undefined,false]){
      const independent=new AggregateError([reason,extra]);origins.add(independent);
      assert.equal(qwenWorkerCancellationFailure(independent,group,origins),false);
    }
    assert.deepEqual(f.ledger.operations,before);f.close(true);
  }
});
for(const mode of ["pre_cancel","read_after_cancel","foreign","repeated","failed_cancel","failed_closed","release","control","source_tail","same_accounting","observer","recording"])
  test("Qwen Worker one-read outcome refuses "+mode,async()=>{
    for(const reason of [{},undefined]){
      const f=await qwenWorkerAssessmentFixture(mode,{reason});assert.deepEqual(f.assess(),[]);f.close(true);
    }
  });
test("Qwen Worker one-read outcome requires source, budget, caller accounting and exact private bindings",async()=>{
  const mutations=[
    f=>{f.source=undefined;},...[["held",1],["canceled",0],["canceled",2],["cancelReturns",0],["cancelReturns",2],["active",1],["expired",1],["settled",0]].map(([key,value])=>f=>{f.source[key]=value;}),
    f=>{f.source.calls=[];},f=>{f.source.calls.push({});},f=>{f.budget=undefined;},
    ...[["ledger","foreign"],["limitMicros",101],["spentMicros",0]].map(([key,value])=>f=>{f.budget[key]=value;}),
    ...[["status","provider_error"],["status","timeout"],["status","success"],["credential_id","foreign"],["provider","foreign"],["model","foreign"],["actual_cost_micros",0],["cost_basis","none"],["input_tokens",1],["output_tokens",1],["total_tokens",1],["cached_input_tokens",1]].map(([key,value])=>f=>{f.usage.events[0][key]=value;}),
    f=>{f.usage.events.push({...f.usage.events[0]});},f=>{f.state.requestOwner={...f.state.requestOwner};},
    f=>{f.receipt.pending=Promise.resolve();},f=>{f.receipt.args=[];},f=>{f.receipt.response={};},
    f=>{f.state.requests=2;},f=>{f.state.status=503;},f=>{f.state.row={...f.state.row,mode:"provider_error"};},
    f=>{f.ledger.readers[0].generation={};},f=>{f.ledger.readers[0].unlocks=2;},f=>{f.ledger.readers[0].returns=0;},
    f=>{f.ledger.operations.find(row=>row.kind==="read").pending=Promise.resolve();},
    f=>{f.ledger.operations.find(row=>row.kind==="read").reason={};},
    f=>{f.ledger.operations.find(row=>row.kind==="read").generation={};},
    f=>{f.ledger.operations.find(row=>row.kind==="read").binding={...f.ledger.operations.find(row=>row.kind==="read").binding,receiver:{}};},
    f=>{f.ledger.operations.find(row=>row.kind==="cancel").binding={...f.ledger.operations.find(row=>row.kind==="cancel").binding,resource:{}};},
    f=>{f.ledger.operations.find(row=>row.kind==="closed").pending=Promise.resolve();},f=>{f.sealed=undefined;},
  ];
  for(const change of mutations){const f=await qwenWorkerAssessmentFixture("owned",{reason:{}});change(f);assert.deepEqual(f.assess(),[]);f.close(true);}
});
test("Qwen Worker one-read outcome keeps later falsey faults and held work fatal",async()=>{
  for(const kind of ["recording","restoration","observer","held"])for(const reason of [{},undefined]){
    const f=await qwenWorkerWitnessFixture("owned",{reason});
    f.state.row=rows.find(row=>row.mode==="partial");f.state.requests=1;f.state.status=200;
    const source={held:0,canceled:1,cancelReturns:1,active:0,expired:0,settled:1,calls:[{}]};
    const usage={events:[{status:"client_error",credential_id:f.state.row.id,provider:f.state.row.provider,model:f.state.row.provider+"/"+f.state.row.model,actual_cost_micros:7,cost_basis:"policy_fixed",input_tokens:null,output_tokens:null,total_tokens:null,cached_input_tokens:null}]};
    const budget={ledger:"durable_object",limitMicros:100,spentMicros:7},origins=new Set([f.error]);
    if(kind==="recording")f.ledger.recordingFailure(reason);
    if(kind==="restoration")Object.defineProperty(f.ledger.readers[0].reader,"read",{get(){throw reason;},configurable:true});
    if(kind==="observer")f.ledger.follow("late_observer",Promise.reject(reason),[undefined,()=>{throw reason;}]);
    if(kind==="held"){
      const held=qwenDeferred();f.ledger.observe("waitUntil",held.promise);let joined=false;
      const pending=f.ledger.drain().catch(error=>{origins.add(error);joined=true;});
      await Promise.resolve();await Promise.resolve();assert.equal(joined,false);
      assert.deepEqual(qwenWorkerCancellation(f.state,source,usage,undefined,budget),[]);
      held.reject(reason);await pending;
    }
    const independent=[];try{f.ledger.restore();}catch(error){independent.push(error);}
    let final;try{await f.ledger.drain();}catch(error){final=error;origins.add(error);}
    const group=qwenWorkerCancellation(f.state,source,usage,f.ledger.seal(),budget);
    assert.equal(qwenWorkerCancellationFailure(final,group,origins),false);
    if(kind==="restoration")assert.equal(independent.length,1);
    f.close(true);
  }
});
test("Qwen Worker cancellation assessment preserves strict joins and original rejected states", async () => {
  const f = await qwenWorkerAssessmentFixture(), before = f.ledger.operations.map(row => ({...row}));
  const classified = f.assess(); assert.equal(classified.length, 3);
  const origins = new Set([f.error, f.finalError]);
  assert.equal(qwenWorkerCancellationFailure(f.error, classified, origins), true);
  assert.equal(qwenWorkerCancellationFailure(f.finalError, classified, origins), true);
  const foreign = new AggregateError(f.error.errors);
  assert.deepEqual(foreign.errors, f.error.errors); assert.notEqual(foreign, f.error);
  assert.equal(qwenWorkerCancellationFailure(foreign, classified, origins), false);
  assert.equal(qwenWorkerCancellationFailure(f.error, classified, new Set()), false);
  assert.deepEqual(f.ledger.operations, before);
  assert.deepEqual(classified.map(row => row.kind).sort(), ["cancel", "closed", "read"]);
  assert.ok(classified.every(row => row.state === "rejected" && row.reason === f.reason));
  assert.equal(f.ledger.joinRecord()[7], 3); assert.equal(f.record.originals.length, 3);
  for (const independent of [undefined, false, f.reason, f.unrelated]) {
    assert.equal(qwenWorkerCancellationFailure(independent, classified, origins), false);
    const extra = new AggregateError([...f.error.errors, independent]); origins.add(extra);
    assert.equal(qwenWorkerCancellationFailure(extra, classified, origins), false);
  }
  f.close(true);
});
for (const mode of ["eof", "pre_cancel", "foreign", "unknown_signal", "repeated", "release", "accounting"])
  test("Qwen Worker cancellation refuses " + mode + " evidence", async () => {
    const f = await qwenWorkerAssessmentFixture(mode); assert.deepEqual(f.assess(), []); f.close(true);
  });
test("Qwen Worker cancellation requires actual source settlement and matching accounting", async () => {
  const f = await qwenWorkerAssessmentFixture(), goodSource = f.source, goodUsage = f.usage;
  for (const source of [undefined, {...goodSource,held:1}, {...goodSource,canceled:0}, {...goodSource,canceled:2},
    {...goodSource,cancelReturns:0}, {...goodSource,cancelReturns:2}, {...goodSource,active:1},
    {...goodSource,expired:1}, {...goodSource,settled:0}, {...goodSource,calls:[]}, {...goodSource,calls:[{},{}]}]) {
    f.source=source; assert.deepEqual(f.assess(), []);
  }
  f.source=goodSource;
  for (const patch of [{status:"provider_error"},{status:"timeout"},{status:"success"},{credential_id:"foreign"},{provider:"foreign"},{model:"foreign"}]) {
    f.usage={events:[{...goodUsage.events[0],...patch}]};assert.deepEqual(f.assess(), []);
  }
  f.usage=goodUsage; f.sealed=undefined; assert.deepEqual(f.assess(), []); f.close(true);
});
test("Qwen Worker cancellation requires the exact fetch, reader, signal and first originals", async () => {
  for (const change of [f=>{f.receipt.pending=Promise.resolve();},f=>{f.receipt.args=[];},f=>{f.receipt.response={};},
    f=>{f.state.requestOwner={...f.state.requestOwner};},f=>{f.state.requests=2;},f=>{f.state.status=503;},
    f=>{f.state.row={...f.state.row,mode:"provider_error"};},f=>{f.state.workerSignalSamples.clear();},
    f=>{f.state.workerSignalSamples.set(f.receipt.signal,{state:2,reason:undefined});},
    f=>{f.ledger.operations.find(row=>row.kind==="cancel").binding.args[0]={};},
    f=>{f.ledger.operations.find(row=>row.kind==="read").reason={};}]) {
    const f=await qwenWorkerAssessmentFixture();change(f);assert.deepEqual(f.assess(), []);f.close(true);
  }
});
test("Qwen Worker first-cause contract distinguishes upstream failure from later same-reason cancellation", () => {
  const code=stripTypeScriptTypes(readFileSync(new URL("../worker/http-operation.ts",import.meta.url),"utf8")).replaceAll("export ","");
  const {HttpOperation}=new Function(code+";return {HttpOperation};")(), reason={};
  const failed=new HttpOperation();failed.stop("upstream",reason);failed.cancel(reason);
  assert.equal(failed.signal.reason,reason);assert.equal(failed.status,"provider_error");assert.equal(failed.delivery,"failed");
  const canceled=new HttpOperation();canceled.cancel(reason);canceled.stop("upstream",reason);
  assert.equal(canceled.signal.reason,reason);assert.equal(canceled.status,"client_error");assert.equal(canceled.delivery,"canceled");
});
test("Qwen Worker held source tail and falsey control failure remain independent", async () => {
  const f=await qwenWorkerWitnessFixture(), held=qwenDeferred();
  f.ledger.observe("control_body",held.promise);let joined=false;
  const draining=f.ledger.drain().catch(error=>{joined=true;return error;});
  await Promise.resolve();await Promise.resolve();assert.equal(joined,false);
  assert.deepEqual(qwenWorkerCancellation(f.state,undefined,undefined,undefined),[]);
  held.reject(undefined);const error=await draining;
  assert.ok(error.errors.some(reason=>reason===undefined));assert.equal(error.errors.length,4);f.close();
});
test("Qwen Worker later independent faults cannot be hidden by the first cancellation group", async () => {
  for (const sameReason of [false,true]) {
    const f=await qwenWorkerWitnessFixture(), first=f.ledger.joinRecord();
    f.state.row=rows.find(row=>row.mode==="partial");f.state.requests=1;f.state.status=200;
    const fault=sameReason?f.reason:undefined;f.ledger.recordingFailure(fault);
    f.ledger.restore();let final;
    try{await f.ledger.drain();}catch(error){final=error;}
    const sealed=f.ledger.seal(), source={held:0,canceled:1,cancelReturns:1,active:0,expired:0,settled:1,calls:[{}]};
    const usage={events:[{status:"client_error",credential_id:f.state.row.id,provider:f.state.row.provider,
      model:f.state.row.provider+"/"+f.state.row.model}]};
    const group=qwenWorkerCancellation(f.state,source,usage,sealed);
    assert.equal(group.length,3);assert.equal(qwenWorkerCancellationFailure(final,group,new Set([final])),false);
    assert.equal(final.errors.length,4);assert.equal(final.errors[0],fault);
    assert.deepEqual(f.ledger.joinRecord(),first);f.close(true);
  }
});
for(const mode of ["owned","pre_cancel","foreign","unknown_signal","repeated","release","accounting"])
  test("Qwen Worker-local witness retains "+mode+" without admitting rejections",async()=>{
    const f=await qwenWorkerWitnessFixture(mode);assert.ok(f.error);
    const checked=qwenWorkerFailureRecord({...f.record,source:[0,1,0,1]},qwenJoinRecord(f.ledger.joinRecord()));
    assert.equal(checked.requestState,2);assert.ok(checked.originals.every(row=>row[6]===2));
    const read=checked.originals.find(row=>row[1]===6);
    if(mode==="pre_cancel"){assert.equal(read[8],2);assert.equal(read[10],2);assert.equal(read[11],2);}
    else if(mode==="foreign"||mode==="unknown_signal"){assert.equal(read[9],0);assert.equal(read[10],0);}
    else {assert.equal(read[9],2);assert.equal(read[10],1);assert.equal(read[11],1);}
    if(mode==="owned")assert.ok(checked.originals.every(row=>row[5]===15&&row[8]===1&&row[12]===1&&row[13]===1));
    if(mode==="repeated")assert.ok(checked.originals.every(row=>row[8]===0));
    if(mode==="release")assert.ok(f.error.errors.includes(undefined));
    if(mode==="accounting")assert.ok(f.error.errors.includes(f.unrelated));
    await assert.rejects(f.ledger.drain());f.close();
  });
test("Qwen Worker EOF remains distinct and held source work remains joined",async()=>{
  const f=await qwenWorkerWitnessFixture("eof");assert.equal(f.error,undefined);assert.equal(f.record,null);
  const held=qwenDeferred();f.ledger.observe("control_body",held.promise);let finished=false;
  const joining=f.ledger.drain().then(()=>{finished=true;});
  await Promise.resolve();await Promise.resolve();assert.equal(finished,false);held.resolve();await joining;f.close();
});
test("Qwen diagnostic request getter preserves original invocation and falsey faults",async()=>{
  for(const reason of [undefined,false,{}]){
    const ledger=createQwenLedger(),storage=new AsyncLocalStorage(),request={},state={ledger},receiver={},original=Promise.resolve({});
    let getters=0,calls=0;const owner=createQwenRequestOwnership(storage,()=>{getters++;throw reason;});
    const returned=owner.invoke(state,request,function(...args){calls++;assert.equal(this,receiver);assert.deepEqual(args,[request]);return original;},receiver,[request]);
    assert.equal(returned,original);await returned;assert.equal(getters,1);assert.equal(calls,1);
    await assert.rejects(ledger.drain(),error=>error.errors.some(value=>Object.is(value,reason)));
  }
});
test("Qwen Worker tuple rejects malformed data and stays within real annotation bounds",async()=>{
  const f=await qwenWorkerWitnessFixture(),join=qwenJoinRecord(f.ledger.joinRecord()),worker=qwenWorkerFailureRecord({...f.record,source:[0,1,0,1]},join);
  const record={...qwenClosedRecord("qr0_partial_stream","worker","control","failed",{operations:f.ledger.operations.length,rejected:3,pending:0}),v:5,join,worker};
  const relay=createQwenFailureRelay();relay.record(record);assert.equal(relay.complete(),false);
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(record))<=768);
  assert.throws(()=>relay.text(closedSDKLine(record)));
  for(const patch of [{requestState:5},{source:[0,1,0]},{source:[0,1,-1,1]},{originals:[]},{extra:true}])assert.throws(()=>qwenWorkerFailureRecord({...worker,...patch},join));
  for(const [slot,value]of[[0,0],[1,15],[3,0],[5,16],[6,3],[7,2],[9,5],[10,3],[11,3],[12,-2]]){
    const copy=worker.originals.map(row=>[...row]);copy[0][slot]=value;assert.throws(()=>qwenWorkerFailureRecord({...worker,originals:copy},join));
  }
  let getters=0;const accessor=[...worker.originals[0]];Object.defineProperty(accessor,8,{get(){getters++;return 1;}});
  assert.throws(()=>qwenWorkerFailureRecord({...worker,originals:[accessor,...worker.originals.slice(1)]},join));assert.equal(getters,0);
  const sparse=[...worker.originals[0]];sparse.length=15;assert.throws(()=>qwenWorkerFailureRecord({...worker,originals:[sparse,...worker.originals.slice(1)]},join));
  const maximum={requestState:2,source:[1,65535,65535,1],originals:Array.from({length:4},(_,i)=>[65531+i,14,65530,65535,65535,15,2,1,2,2,2,2,65535,65535])};
  const maxJoin=[0,0,0,0,0,0,0,4,0,0,-1,-1,-1,-1,-1];
  const maxRecord={...record,join:maxJoin,worker:qwenWorkerFailureRecord(maximum,maxJoin),operations:65535,rejected:65535};
  assert.ok(Buffer.byteLength(qwenBoundaryAnnotation(maxRecord))<=768);f.close();
});
