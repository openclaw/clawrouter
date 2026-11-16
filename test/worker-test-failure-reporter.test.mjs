import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types as nodeTypes } from "node:util";
import { after, before, test } from "node:test";
import { parse } from "yaml";
import { workerFailureReport, workerAbortEvidence, decodeWorkerAbortDiagnostic, decodeWorkerReporterRecord, parseWorkerAbortDiagnostic, parseWorkerReporterRecord, workerAbortPrefix, workerAbortInvocation, workerAbortAdmissionSites, decodeWorkerAbortOperation, workerAbortParts, workerAbortRelationalPrefix, workerAbortRelationalPrefixV3, decodeWorkerAbortPart, parseWorkerAbortPart, validateWorkerAbortGroup, decodeWorkerPostludeRouter, decodeWorkerPostludeNode, workerAbortPostludeCoverage } from "../scripts/worker-test-failure-reporter.mjs";
import { affectsOpenClawContract } from "../scripts/openclaw-contract-changes.mjs";
import { deepSeekHeldFailure, deepSeekHeldPrefix, decodeDeepSeekHeldDiagnostic } from "../scripts/worker-test-failure-reporter.mjs";

const reporter = fileURLToPath(new URL("../scripts/worker-test-failure-reporter.mjs", import.meta.url));
const marker = "synthetic-private-marker-do-not-report";
// BEGIN worker abort diagnostic pure tests.
function abortDiagnosticSource() {
  const source = readFileSync("worker/test/litellm-model-discovery.test.mjs", "utf8");
  const gateway = source.slice(source.indexOf("export async function withGateway("), source.indexOf("\nfunction registerTests()"));
  const start = source.indexOf('  test("owned HTTP/1 reset propagates real metadata ingress cancellation and strict retirement"');
  const body = source.slice(start, source.indexOf('  test("shipping 30000ms', start));
  const control = source.slice(source.indexOf("export async function litellmControlResponse("), source.indexOf("// END request-owned fixture functions."));
  return { gateway: gateway.replace("export async function", "async function"), body, control: control.replace("export async function", "async function") };
}
async function abortDiagnosticCase({ fault, undefinedFault = false, secondary = [], reportingFault = false } = {}) {
  const { gateway, body, control } = abortDiagnosticSource(), calls = [], diagnostics = [], failure = {};
  const check = name => { calls.push(name); if (name === fault || secondary.includes(name)) throw undefinedFault ? undefined : failure; };
  const response = (name, value) => ({ status: 200, bodyUsed: false, async json() { check(name); this.bodyUsed = true; return value; }, body: { async cancel() {} } });
  const state = { calls: [{}], canceled: 1, active: 0, expired: 0, aborted: 0, finished: 1 };
  const observation = { operations: 4, syncFailures: 0, checks: [4, 127, 111, 16, null] };
  const upstream = { async fetch(url) {
    if (url.endsWith("/setup")) { check("upstream_setup"); return { status: fault === "upstream_status" ? 500 : 200 }; }
    if (url.includes("/started/")) { check("started"); return response("started_body", {}); }
    if (url.includes("/proof/")) { check("proof"); return response("proof_body", diagnosticSource()); }
    const stage = retireFailed ? "fallback_state" : "final_state"; check(stage);
    return response(stage + "_body", { ...state, calls: fault === "calls_assertion" ? [] : state.calls, canceled: fault === "canceled_assertion" ? 0 : 1, active: fault === "active_assertion" ? 1 : 0, expired: fault === "expired_assertion" ? 1 : 0 });
  } };
  let retireFailed = false;
  const fetch = (url) => {
    if (url.endsWith("/__litellm/setup")) { check("router_setup"); const r = response("router_setup_body", {}); if (fault === "router_status") r.status = 500; return Promise.resolve(r); }
    if (url.includes("/__litellm/retire/")) { try { check("retire"); } catch (error) { retireFailed = true; return Promise.reject(error); } return Promise.resolve(response("retire_body", { retired: fault !== "retired_assertion" })); }
    if (url.includes("/__litellm/observation/")) { check("observation"); return Promise.resolve(response("observation_body", observation)); }
    if (url.includes("/__litellm/started/")) { check("owner_ready"); return Promise.resolve(response("owner_ready_body", { started: true })); }
    if (url.includes("/__litellm/usage/")) { check("usage"); return Promise.resolve(response("usage_body", {})); }
    throw new Error("unexpected inert control");
  };
  const runtime = { async unsafeGetDirectURL() { check("direct_url"); return "https://fixture.test"; }, async getWorker() { check("upstream_handle"); return upstream; }, async dispose() { check("dispose"); } };
  const controlResponse = new Function("assert", control + ";return litellmControlResponse;")(assert);
  const context = { mkdtemp: async () => { check("directory"); return "inert"; }, join: (...args) => args.join("/"), tmpdir: () => "inert",
    startWorkerdFixture: async () => { check("runtime"); return runtime; }, routerFixture: () => "", upstreamFixture: () => "", selected: "inert", fetch, assert,
    litellmControlResponse: controlResponse, key: () => "inert", rm: async () => { check("remove"); } };
  const withGateway = new Function(...Object.keys(context), gateway + ";return withGateway;")(...Object.values(context));
  let callback;
  const owner = () => ({ start() { check("caller"); }, async ready() { check("caller_observer"); }, reset() { check("authored_abort"); }, async join() { check("caller_outcome"); }, async close() { try { check("caller_cleanup"); return []; } catch (error) { return [error]; } } });
  new Function("test", "withGateway", "workerAbortEvidence", "litellmOwnedH1Reset", "httpRequest", "Socket", "key", "assertLiteLLMResetRetirement", "litellmFailurePostlude", "assert", body)((name, options, fn) => { callback = fn; }, withGateway, workerAbortEvidence, owner, {}, class {}, () => "inert", () => check("remote_assertions"), purePostludeFunctions().litellmFailurePostlude, assert);
  let failed = false, error;
  try { await callback({ diagnostic(value) { if (reportingFault) throw undefined; diagnostics.push(value); } }); }
  catch (reason) { failed = true; error = reason; }
  const frames = diagnostics.filter(value => value.startsWith(workerAbortPrefix));
  return { failed, error, failure, calls, retireFailed, frames, record: frames.length ? decodeWorkerAbortDiagnostic(JSON.parse(frames.at(-1).slice(workerAbortPrefix.length))) : null };
}
test("worker abort diagnostic pure: actual fixture stages preserve first failure and both cleanup attempts", async () => {
  const stages = { directory: [1, 0], runtime: [2, 0], direct_url: [3, 0], upstream_handle: [4, 0], upstream_setup: [5, 0], upstream_status: [5, 1],
    router_setup: [6, 0], router_status: [7, 0], router_setup_body: [8, 0], caller: [9, 0], caller_observer: [9, 1], started: [10, 0],
    owner_ready: [13, 0], authored_abort: [11, 0], caller_outcome: [12, 0], retire: [14, 0], retired_assertion: [17, 0], final_state: [18, 0], calls_assertion: [19, 0], canceled_assertion: [20, 0], active_assertion: [21, 0], expired_assertion: [22, 0], dispose: [23, 0], remove: [24, 0] };
  for (const [fault, expected] of Object.entries(stages)) {
    const result = await abortDiagnosticCase({ fault });
    assert.equal(result.failed, true, fault); assert.deepEqual(result.record.first.slice(0, 2), expected, fault);
    if (fault !== "directory") assert.equal(result.calls.includes("remove"), true, fault);
  }
});
test("worker abort diagnostic pure: original undefined and independent cleanup and reporting remain failures", async () => {
  const result = await abortDiagnosticCase({ fault: "retire", undefinedFault: true, secondary: ["dispose", "remove"] });
  assert.deepEqual(result.record.first, [14, 0, false]); assert.equal(result.record.undefinedFailures, 3);
  assert.equal(result.failed, true); assert.deepEqual(result.error.errors, [undefined, undefined, undefined]);
  const reported = await abortDiagnosticCase({ fault: "retire", undefinedFault: true, secondary: ["dispose", "remove"], reportingFault: true });
  assert.equal(reported.failed, true); assert.equal(reported.error.errors.at(-1), undefined);
  const original = reported.error.errors[0].errors;
  assert.deepEqual(original[0].errors, [undefined, undefined]);
  assert.deepEqual(original.slice(1), [undefined, undefined]);
});
test("worker abort diagnostic pure: one unavailable observation preserves the other without retirement credit", async () => {
  for (const secondary of [["observation"], ["fallback_state"]]) {
    const result = await abortDiagnosticCase({ fault: "retire", undefinedFault: true, secondary });
    assert.equal(result.failed, true); assert.deepEqual(result.record.first, [14, 0, false]);
    assert.equal(result.record.worker !== null, secondary[0] !== "observation");
    assert.equal(result.record.upstream !== null, secondary[0] !== "fallback_state");
    assert.deepEqual(result.error.errors, [undefined, undefined]);
  }
});
test("worker abort diagnostic pure: schema preserves nulls and rejects hostile fields without invocation", () => {
  let reads = 0;
  const evidence = workerAbortEvidence(); evidence.stage(14); evidence.failed(undefined); let frame;
  evidence.report({ diagnostic(value) { frame = value; } }); const record = JSON.parse(frame.slice(workerAbortPrefix.length));
  assert.ok(decodeWorkerAbortDiagnostic(record));
  for (const key of Object.keys(record)) {
    const hostile = { ...record }; Object.defineProperty(hostile, key, { get() { reads++; throw undefined; } });
    assert.equal(decodeWorkerAbortDiagnostic(hostile), null);
  }
  const nested = { ...record, first: [14, 0, false] }; Object.defineProperty(nested.first, "0", { get() { reads++; throw undefined; } });
  assert.equal(decodeWorkerAbortDiagnostic(nested), null); assert.equal(reads, 0);
  const foreign = new Proxy([], { get() { reads++; throw undefined; } });
  evidence.observation(16, { status: "fulfilled", value: { calls: foreign } });
  evidence.report({ diagnostic(value) { frame = value; } });
  assert.equal(JSON.parse(frame.slice(workerAbortPrefix.length)).upstream[0], null); assert.equal(reads, 0);
  for (const change of [{ first: null }, { undefinedFailures: 2 }, { extra: true }, { first: [14, 1, false] }]) assert.equal(decodeWorkerAbortDiagnostic({ ...record, ...change }), null);
});
function workerAbortRuntime() {
  return { versions: { node: "24.22.1" }, env: {}, execPath: "/fixture/node",
    argv: ["/fixture/node", "worker/test/litellm-model-discovery.test.mjs", "worker/test/other.test.mjs"],
    execArgv: ["--test", "--test-reporter=./scripts/worker-test-failure-reporter.mjs", "--test-reporter-destination=stdout"], cwd: () => "/fixture" };
}
function pureWorkerReporter(runtime = workerAbortRuntime()) {
  const source = readFileSync("scripts/worker-test-failure-reporter.mjs", "utf8");
  const definitions = source.slice(source.indexOf("const failureTypes"), source.indexOf("function trackedTestFiles"))
    + source.slice(source.indexOf("function failureRecord"), source.indexOf("export default workerFailureReport"));
  // Only the unchanged filesystem resolver is inert here; the producer, native
  // event admission, selection and escaped serializer are the actual source.
  const tracked = file => typeof file === "string" && /^(?:worker\/)?test\/[A-Za-z0-9._-]+\.test\.mjs$/.test(file) ? file : null;
  return new Function("types", "trackedTestFiles", "process", "relative", "resolve", "sep", definitions.replace(/^export /gm, "") + ";return workerFailureReport;")(nodeTypes, () => tracked, runtime, relative, resolve, sep);
}
// BEGIN standalone DeepSeek Script delivery tests.
function heldScriptRuntime() {
  return { ...workerAbortRuntime(), argv: ["/fixture/node", "test/openclaw-deepseek-search.test.mjs", "test/other.test.mjs"] };
}
function heldScriptEvents(frame) {
  const native = { testId: 7, parentId: undefined, name: "DeepSeek held upstream joins original cancellation before teardown",
    file: "test/openclaw-deepseek-search.test.mjs", entryFile: "test/openclaw-deepseek-search.test.mjs", line: 148, column: 1, nesting: 0 };
  return [{ type: "test:enqueue", data: { ...native } },
    { type: "test:fail", data: { ...native, details: { error: { failureType: "testCodeFailure", code: "ERR_TEST_FAILURE" } } } },
    { type: "test:diagnostic", data: { entryFile: native.entryFile, file: native.file, line: native.line, column: native.column, nesting: 0, message: frame } }];
}
async function heldScriptPipeline(events, { runtime = heldScriptRuntime(), complete = true, wrappers } = {}) {
  wrappers ??= runtime.argv.slice(1).map((file, i) => ({ testId: i + 1, parentId: 0, name: file, file, line: 1, column: 1, nesting: 0 }));
  return workerAbortPipeline(events, { runtime, wrappers, complete });
}
test("DeepSeek Script delivery binds the actual accounting producer in both native event orders", async () => {
  for (const phase of ["setup", "upstream", "cleanup"]) for (const reason of [undefined, {}]) {
    const frame = deepSeekHeldFailure(phase, [reason], [undefined]);
    for (const order of [[0, 1, 2], [0, 2, 1]]) {
      const events = heldScriptEvents(frame), out = await heldScriptPipeline(order.map(i => events[i]));
      const row = out.rows.find(row => row.kind === "deepseek_held"); assert.ok(row);
      assert.equal(row.phase, phase); assert.equal(row.failurePresent, true); assert.equal(row.reasonDefined, reason !== undefined);
      assert.deepEqual(row.counts, [1, reason === undefined ? 1 : 0, 1, 1]);
      assert.equal(out.rows[0].kind, "failure"); assert.equal(out.rows.at(-1).failureEvents, 1);
      for (const rows of [out.rows, [...out.rows].reverse()]) for (const value of rows) assert.deepEqual(parseWorkerReporterRecord(JSON.stringify(value)), value);
    }
  }
  const out = await heldScriptPipeline(heldScriptEvents(deepSeekHeldFailure("cleanup", [], [undefined])));
  assert.deepEqual(out.rows[1], { v: 1, kind: "deepseek_held", at: ["test/openclaw-deepseek-search.test.mjs", 148, 1, 0], phase: null, failurePresent: false, reasonDefined: null, counts: [0, 0, 1, 1] });
});
test("DeepSeek Script delivery rejects missing, duplicate, foreign and contradictory native association", async () => {
  const frame = deepSeekHeldFailure("upstream", [undefined], []);
  const mutations = [
    e => e.splice(0, 1), e => e.splice(1, 1), e => e.splice(2, 1), e => { e[1].data.testId = 8; },
    e => { delete e[0].data.parentId; }, e => { e[1].data.parentId = null; }, e => { e[0].data.testId = 7.5; },
    e => { e[0].data.name = "unrelated"; e[1].data.name = "unrelated"; },
    e => { e[2].data.entryFile = "test/other.test.mjs"; }, e => { delete e[2].data.entryFile; },
    e => { e[2].data.line++; }, e => { e[2].data.nesting = 1; }, e => { e[2].data.file = "test/other.test.mjs"; },
    e => e.push(e[0]), e => e.push(e[1]), e => e.push(e[2]),
    e => e.push({ type: "test:enqueue", data: { ...e[0].data, testId: 8, name: "unrelated" } }),
    e => e.push({ type: "test:enqueue", data: { ...e[0].data, testId: 8, line: 149 } }),
    e => e.push({ type: "test:pass", data: { ...e[1].data } }), e => e.push({ type: "test:watch:drained", data: {} }),
    e => { e[2].type = "test:stdout"; }, e => { e[2].data.message += "\u001b"; },
    e => { e[2].data.message = e[2].data.message.slice(0, -1); }, e => { e[2].data.message = deepSeekHeldPrefix + "x".repeat(513); },
    e => { e[2].data.message = e[2].data.message.replace('{"v":1,', '{"v":1,"v":1,'); },
  ];
  for (const mutate of mutations) {
    const events = heldScriptEvents(frame); mutate(events);
    const out = await heldScriptPipeline(events); assert.equal(out.rows.some(row => row.kind === "deepseek_held"), false);
  }
  assert.equal((await heldScriptPipeline(heldScriptEvents(frame), { complete: false })).rows.some(row => row.kind === "deepseek_held"), false);
  for (const mutate of [r => { r.versions.node = "26.0.0"; }, r => { r.env.NODE_OPTIONS = "--test"; }, r => { r.env.NODE_TEST_CONTEXT = "child-v8"; }, r => r.argv.push(r.argv[1]), r => { r.execArgv.pop(); }]) {
    const runtime = heldScriptRuntime(); mutate(runtime);
    assert.equal((await heldScriptPipeline(heldScriptEvents(frame), { runtime })).rows.some(row => row.kind === "deepseek_held"), false);
  }
});
test("DeepSeek Script accounting schema is closed and does not inspect reason or record accessors", async () => {
  let reads = 0;
  const reason = new Proxy({}, { get() { reads++; throw undefined; }, getOwnPropertyDescriptor() { reads++; throw undefined; } });
  const good = JSON.parse(deepSeekHeldFailure("setup", [reason], []).slice(deepSeekHeldPrefix.length)); assert.equal(reads, 0);
  const bad = [{ ...good, extra: null }, { ...good, phase: "native_fetch" }, { ...good, failurePresent: false }, { ...good, reasonDefined: null },
    ...[[0, 0, 0, 0], [1, 2, 0, 0], [1, 0, 1, 2], [1, 0, 0, 0, {}], [1, 0, 0], [1, 0, 0, 0.5], [1, 0, 0, -1], [1, 0, 0, 1000001]].map(counts => ({ ...good, counts })),
    { ...good, reasonDefined: false }, { ...good, reasonDefined: true, counts: [1, 1, 0, 0] }];
  for (const record of bad) {
    assert.equal(decodeDeepSeekHeldDiagnostic(record), null);
    const out = await heldScriptPipeline(heldScriptEvents(deepSeekHeldPrefix + JSON.stringify(record)));
    assert.equal(out.rows.some(row => row.kind === "deepseek_held"), false);
    const projected = { ...record, kind: "deepseek_held", at: ["test/openclaw-deepseek-search.test.mjs", 148, 1, 0] };
    assert.equal(decodeWorkerReporterRecord(projected), null);
  }
  for (const key of Object.keys(good)) {
    const value = { ...good }; Object.defineProperty(value, key, { get() { reads++; throw undefined; } });
    assert.equal(decodeDeepSeekHeldDiagnostic(value), null);
  }
  const sparse = { ...good, counts: [1, 0, 0, 0] }; delete sparse.counts[2]; assert.equal(decodeDeepSeekHeldDiagnostic(sparse), null);
  const extra = { ...good, counts: [1, 0, 0, 0] }; extra.counts.extra = {}; assert.equal(decodeDeepSeekHeldDiagnostic(extra), null);
  const projected = { ...good, kind: "deepseek_held", at: ["test/openclaw-deepseek-search.test.mjs", 148, 1, 0] };
  projected.at.extra = {}; assert.equal(decodeWorkerReporterRecord(projected), null);
  for (const at of [[...projected.at, null], ["test/other.test.mjs", 148, 1, 0], ["test/openclaw-deepseek-search.test.mjs", 148, 1, 1]]) assert.equal(decodeWorkerReporterRecord({ ...projected, at }), null);
  assert.equal(decodeDeepSeekHeldDiagnostic(reason), null); assert.equal(reads, 0);
});
test("DeepSeek Script delivery keeps the failure and detail together within the existing quota", async () => {
  const frame = deepSeekHeldFailure("upstream", [undefined], []), events = heldScriptEvents(frame);
  const extra = Array.from({ length: 20 }, (_, i) => [{ type: "test:enqueue", data: { ...events[0].data, testId: 100 + i, line: 300 + i, name: "unrelated" } },
    { type: "test:fail", data: { ...events[1].data, testId: 100 + i, line: 300 + i, name: "unrelated" } }]).flat();
  const out = await heldScriptPipeline([...extra, ...events]);
  assert.equal(out.lines.length, 10); assert.equal(out.rows[0].kind, "failure"); assert.equal(out.rows[1].kind, "deepseek_held");
  assert.equal(out.rows.at(-1).reported, 8); assert.equal(out.rows.at(-1).omittedEvents, 13);
  const maximal = deepSeekHeldPrefix + JSON.stringify({ v: 1, kind: "deepseek_held_stage", phase: "upstream", failurePresent: true, reasonDefined: false, counts: [1000000, 1000000, 1000000, 1000000] });
  const maxEvents = heldScriptEvents(maximal); for (const event of maxEvents) { event.data.line = 1000000; event.data.column = 1000000; }
  const max = await heldScriptPipeline(maxEvents); assert.equal(max.rows[1].kind, "deepseek_held");
  assert.ok(Buffer.byteLength(JSON.stringify(max.rows[1])) <= 512);
});
// END standalone DeepSeek Script delivery tests.
function workerAbortNativeEvents(frame) {
  const native = { testId: 7, parentId: undefined, name: "owned HTTP/1 reset propagates real metadata ingress cancellation and strict retirement",
    file: "worker/test/litellm-model-discovery.test.mjs", entryFile: "worker/test/litellm-model-discovery.test.mjs", line: 704, column: 3, nesting: 0 };
  return [
    { type: "test:enqueue", data: { ...native, type: "test" } },
    { type: "test:fail", data: { ...native, testNumber: 9, details: { error: { failureType: "testCodeFailure", code: "ERR_TEST_FAILURE" } } } },
    { type: "test:diagnostic", data: { entryFile: native.entryFile, file: native.file, line: native.line, column: native.column, nesting: native.nesting, message: frame, level: "info" } },
  ];
}
function workerAbortWrappers() {
  return workerAbortRuntime().argv.slice(1).map((file, i) => ({ testId: i + 1, parentId: 0, name: file, file, line: 1, column: 1, nesting: 0 }));
}
async function workerAbortPipeline(events, { runtime = workerAbortRuntime(), wrappers = workerAbortWrappers(), complete = true } = {}) {
  async function* scoped() {
    for (const data of wrappers) yield { type: "test:enqueue", data };
    yield* events;
    if (complete) for (const data of wrappers) yield { type: "test:complete", data: { ...data, testNumber: 1 } };
  }
  const lines = [];
  for await (const line of pureWorkerReporter(runtime)(scoped())) lines.push(line);
  assert.ok(lines.length <= 10); assert.ok(lines.reduce((n, line) => n + Buffer.byteLength(line), 0) <= 8192);
  const rows = lines.map(line => {
    assert.ok(Buffer.byteLength(line) <= 768);
    const json = line.slice(line.indexOf("::", 2) + 2).trimEnd().replaceAll("%0A", "\n").replaceAll("%0D", "\r").replaceAll("%25", "%");
    assert.ok(Buffer.byteLength(json) <= 512); const record = JSON.parse(json);
    assert.deepEqual(decodeWorkerReporterRecord(record), record); return record;
  });
  return { rows, lines };
}
test("worker abort diagnostic pure: actual producer binds native coordinates in either diagnostic order", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire", undefinedFault: true });
  for (const order of [[0, 1, 2], [0, 2, 1]]) {
    const events = workerAbortNativeEvents(fixture.frames[0]), result = await workerAbortPipeline(order.map(i => events[i]));
    assert.equal(result.rows[0].kind, "failure"); assert.equal(result.rows[1].kind, "worker_abort");
    assert.deepEqual(result.rows[1].stage, [14, 0, false]); assert.deepEqual(result.rows.at(-1).diagnostics, [1, 1, 0, 0, false]);
  }
});
test("worker abort diagnostic pure: native identities reject late collisions and missing or foreign fields", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire" });
  const mutations = [
    e => { delete e[0].data.testId; }, e => { e[0].data.testId = 0; e[1].data.testId = 0; },
    e => { e[1].data.testId = 8; }, e => { delete e[1].data.parentId; }, e => { e[1].data.parentId = null; },
    e => { e[0].data.name = "x".repeat(513); }, e => { e[0].data.testId = Number.MAX_SAFE_INTEGER + 1; },
    e => { delete e[2].data.file; }, e => { delete e[2].data.column; }, e => { e[2].data.nesting = 1; },
    e => { e[2].data.entryFile = "worker/test/foreign.test.mjs"; }, e => { e[2].data.file = "worker/test/foreign.test.mjs"; },
    e => e.push({ type: "test:enqueue", data: { ...e[0].data, name: "foreign", line: 900 } }),
    e => e.push({ type: "test:enqueue", data: { ...e[0].data, testId: 8, name: "foreign" } }),
    e => e.push({ type: "test:enqueue", data: { ...e[0].data, testId: undefined, name: "foreign", line: 900 } }),
    e => e.push(...[900, 901].map(line => ({ type: "test:enqueue", data: { ...e[0].data, testId: 20, name: "foreign", line } }))),
    e => e.push(e[0]), e => e.push(e[1]), e => e.push(e[2]),
    e => { e[2].data.message = workerAbortPrefix + '{"v":1}'; },
    e => { e[2].data.message = workerAbortPrefix + "x".repeat(513); },
    e => { e[2].data.message += "\x1b"; }, e => { e[2].data.message = e[2].data.message.slice(0, -1); },
    e => e.push(...Array.from({ length: 4097 }, (_, i) => ({ type: "test:enqueue", data: { ...e[0].data, name: "other", testId: i + 100, line: i + 1000 } }))),
  ];
  for (const mutate of mutations) {
    const events = workerAbortNativeEvents(fixture.frames[0]); mutate(events);
    const result = await workerAbortPipeline(events); assert.equal(result.rows.some(row => row.kind === "worker_abort"), false);
    assert.ok(result.rows.some(row => row.kind === "failure"));
  }
});
test("worker abort diagnostic pure: unrelated parameterized coordinates preserve unique target and scoped IDs", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire" });
  const events = workerAbortNativeEvents(fixture.frames[0]);
  const parameterized = [20, 21].map(testId => ({ type: "test:enqueue", data: { ...events[0].data, testId, name: "parameterized", line: 900 } }));
  const result = await workerAbortPipeline([...events, ...parameterized]);
  assert.equal(result.rows.some(row => row.kind === "worker_abort"), true);
  for (const conflict of [
    { ...parameterized[0], data: { ...parameterized[0].data, testId: 22, line: events[0].data.line } },
    { ...parameterized[0], data: { ...parameterized[0].data, line: 901 } },
  ]) {
    const denied = await workerAbortPipeline([...events, ...parameterized, conflict]);
    assert.equal(denied.rows.some(row => row.kind === "worker_abort"), false);
    assert.ok(denied.rows.some(row => row.kind === "worker_abort_unbound"));
  }
});
test("worker abort diagnostic pure: wrapper and child IDs are separate but wrapper failures stay visible", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire" });
  const events = workerAbortNativeEvents(fixture.frames[0]), wrappers = workerAbortWrappers(); wrappers[0].testId = 7;
  const wrapperFailure = { type: "test:fail", data: { ...wrappers[0], testNumber: 2, details: { error: { failureType: "subtestsFailed", code: "ERR_TEST_FAILURE" } } } };
  const otherChild = { type: "test:enqueue", data: { ...events[0].data, entryFile: wrappers[1].file, file: wrappers[1].file } };
  const result = await workerAbortPipeline([...events, otherChild, wrapperFailure], { wrappers });
  assert.equal(result.rows.some(row => row.kind === "worker_abort"), true);
  assert.equal(result.rows.filter(row => row.kind === "failure").length, 2);
  assert.ok(result.rows.some(row => row.kind === "failure" && row.failureType === "subtestsFailed"));
  for (const late of [
    { type: "test:enqueue", data: { ...wrappers[0], testId: 30 } },
    { type: "test:enqueue", data: { ...wrappers[1], testId: 7 } },
    { type: "test:pass", data: { ...wrapperFailure.data } },
  ]) assert.equal((await workerAbortPipeline([...events, wrapperFailure, late], { wrappers })).rows.some(row => row.kind === "worker_abort"), false);
});
test("worker abort diagnostic pure: exact multi file invocation and complete wrapper census are required", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire" }), events = workerAbortNativeEvents(fixture.frames[0]);
  const runtime = workerAbortRuntime(); assert.equal(workerAbortInvocation(runtime, "/fixture").files.length, 2);
  for (const mutate of [
    r => r.versions.node = "26.13.0", r => r.env.NODE_TEST_CONTEXT = "child-v8", r => r.env.NODE_OPTIONS = "--watch",
    r => r.execArgv.push("--watch"), r => r.execArgv.push("--test-isolation=none"), r => r.argv.push(r.argv[1]),
    r => r.argv.push("worker/test/../foreign.test.mjs"), r => r.argv = [r.argv[0], r.argv[2]], r => r.argv[0] = "/foreign/node",
  ]) {
    const changed = workerAbortRuntime(); mutate(changed);
    assert.equal(workerAbortInvocation(changed, "/fixture"), null);
    const result = await workerAbortPipeline(events, { runtime: changed });
    assert.deepEqual(result.rows.find(row => row.kind === "worker_abort_unbound").reason, [1, 0]);
    assert.ok(result.rows.some(row => row.kind === "failure"));
  }
  for (const options of [{ wrappers: [] }, { wrappers: workerAbortWrappers().slice(0, 1) }, { complete: false }]) {
    const result = await workerAbortPipeline(events, options);
    assert.equal(result.rows.some(row => row.kind === "worker_abort"), false);
    assert.deepEqual(result.rows.find(row => row.kind === "worker_abort_unbound").reason, [21, 7]);
  }
  const result = await workerAbortPipeline([...events, { type: "test:watch:restarted", data: {} }]);
  assert.deepEqual(result.rows.find(row => row.kind === "worker_abort_unbound").reason, [2, 6]);
});
test("worker abort diagnostic pure: first admission gate and field masks survive later failures and quotas", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire" });
  const faults = [
    ["scope_field", e => Object.defineProperty(e[0].data, "entryFile", { get() { throw undefined; } })],
    ["scope_entry", e => e[0].data.entryFile = "worker/test/foreign.test.mjs"],
    ["location", e => delete e[0].data.column], ["name", e => delete e[0].data.name],
    ["parent", e => delete e[0].data.parentId], ["id", e => e[0].data.testId = 0],
    ["child_match", e => e[1].data.parentId = 9], ["frame", e => e[2].data.message += " "],
    ["diagnostic_scope", e => delete e[2].data.entryFile],
    ["target_unique", e => { e[0].data.name = "other"; e[1].data.name = "other"; }],
    ["diagnostic_match", e => e[2].data.line++],
  ];
  for (const [site, mutate] of faults) {
    const events = workerAbortNativeEvents(fixture.frames[0]); mutate(events);
    const result = await workerAbortPipeline(events), row = result.rows.find(row => row.kind === "worker_abort_unbound");
    const bit = 2 ** workerAbortAdmissionSites.indexOf(site);
    assert.equal(row.reason[0], workerAbortAdmissionSites.indexOf(site) + 1, site);
    assert.equal(row.gates[0] & bit, bit, site); assert.equal(row.gates[1] & bit, 0, site);
    if (site === "parent") assert.equal(row.fields[0] & 64, 0);
    if (site === "child_match") assert.equal(row.fields[2] & 2, 2);
    assert.ok(result.rows.some(row => row.kind === "failure"));
  }
  const events = workerAbortNativeEvents(fixture.frames[0]); delete events[0].data.parentId;
  const unrelated = Array.from({ length: 15 }, (_, i) => ({ type: "test:fail", data: { entryFile: "worker/test/other.test.mjs", file: "worker/test/other.test.mjs", line: i + 1, details: {} } }));
  const result = await workerAbortPipeline([...unrelated, ...events]);
  assert.deepEqual(result.rows.slice(0, 2).map(row => row.kind), ["failure", "worker_abort_unbound"]);
  assert.equal(result.rows.length, 10); assert.equal(result.rows.at(-1).reported, 8);
  assert.deepEqual(result.rows[1].reason, [8, 1]);
});
test("worker abort diagnostic pure: unbound schema remains closed bounded and never promotes fixture stage", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire", undefinedFault: true });
  const events = workerAbortNativeEvents(fixture.frames[0]); delete events[2].data.entryFile;
  const result = await workerAbortPipeline(events), row = result.rows.find(value => value.kind === "worker_abort_unbound");
  assert.equal(Object.hasOwn(row, "stage"), false); assert.equal(result.rows.some(value => value.kind === "worker_abort"), false);
  const maximal = { ...row, reason: [27, 7], gates: [2 ** 27 - 1, 0], fields: [255, 255, 255], census: Array(6).fill(1000000), scope: Array(5).fill(false) };
  assert.ok(Buffer.byteLength(JSON.stringify(maximal)) <= 512); assert.deepEqual(decodeWorkerReporterRecord(maximal), maximal);
  for (const change of [{ reason: null }, { reason: [28, 0] }, { gates: [0, 1] }, { gates: [0, 0] }, { gates: [2 ** 27 - 1, 2 ** 27 - 1] }, { fields: [256, 0, 0] }, { census: [-1, 0, 0, 0, 0, 0] }, { scope: [false] }, { stage: [14, 0, false] }]) assert.equal(decodeWorkerReporterRecord({ ...row, ...change }), null);
  for (const payload of [JSON.stringify(row).replace('{"v":1,', '{"v":1,"v":1,'), JSON.stringify(row) + " "]) assert.equal(parseWorkerReporterRecord(payload), null);
  const overflowing = Array.from({ length: 34 }, () => events[2]);
  const bounded = await workerAbortPipeline([...events.slice(0, 2), ...overflowing]);
  assert.equal(bounded.rows.at(-1).diagnostics[4], true);
  assert.equal(bounded.rows.some(value => value.kind === "worker_abort"), false);
});
test("worker abort diagnostic pure: wrapper and terminal admission failures retain exact first sites", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire" });
  for (const [site, mutate] of [
    ["wrapper_shape", w => w[0].column = 2],
    ["wrapper_generation", w => w.push({ ...w[0], testId: 40 })],
    ["wrapper_id", w => w[1].testId = w[0].testId],
  ]) {
    const wrappers = workerAbortWrappers(); mutate(wrappers);
    const result = await workerAbortPipeline(workerAbortNativeEvents(fixture.frames[0]), { wrappers });
    assert.equal(result.rows.find(row => row.kind === "worker_abort_unbound").reason[0], workerAbortAdmissionSites.indexOf(site) + 1);
  }
  for (const [site, append] of [
    ["wrapper_match", () => ({ type: "test:pass", data: { ...workerAbortWrappers()[0], testId: 404 } })],
    ["wrapper_terminal", () => ({ type: "test:complete", data: { ...workerAbortWrappers()[0] } })],
    ["contradictory_terminal", e => ({ type: "test:pass", data: { ...e[1].data } })],
    ["child_terminal", e => e[1]],
  ]) {
    const events = workerAbortNativeEvents(fixture.frames[0]); events.push(append(events));
    const result = await workerAbortPipeline(events);
    assert.equal(result.rows.find(row => row.kind === "worker_abort_unbound").reason[0], workerAbortAdmissionSites.indexOf(site) + 1);
  }
  const missing = workerAbortNativeEvents(fixture.frames[0]); missing.splice(1, 1);
  const result = await workerAbortPipeline(missing);
  assert.equal(result.rows.find(row => row.kind === "worker_abort_unbound").reason[0], workerAbortAdmissionSites.indexOf("target_failure") + 1);
  assert.equal(result.rows.some(row => row.kind === "failure"), false);
});
test("worker abort diagnostic pure: valid frame cannot hide foreign missing or conflicting diagnostic scope", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire" });
  for (const mutate of [d => delete d.entryFile, d => d.entryFile = "worker/test/foreign.test.mjs", d => d.line++]) {
    for (const early of [false, true]) {
      const events = workerAbortNativeEvents(fixture.frames[0]), extra = { type: "test:diagnostic", data: { ...events[2].data } };
      mutate(extra.data); if (early) events.unshift(extra); else events.push(extra);
      const result = await workerAbortPipeline(events);
      assert.equal(result.rows.some(row => row.kind === "worker_abort"), false);
      assert.equal(result.rows.some(row => row.kind === "worker_abort_unbound"), true);
      assert.equal(result.rows.some(row => row.kind === "failure"), true);
      assert.deepEqual(result.rows.at(-1).diagnostics, [2, 0, 0, 2, false]);
    }
  }
});
test("worker abort diagnostic pure: file scoped IDs and parent presence stay distinct", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire" });
  for (const parent of [undefined, null, 0, 5, Number.MAX_SAFE_INTEGER]) for (const order of [[0, 1, 2], [0, 2, 1]]) {
    const events = workerAbortNativeEvents(fixture.frames[0]); events[0].data.parentId = parent; events[1].data.parentId = parent;
    const ordered = order.map(index => events[index]);
    ordered.push({ type: "test:enqueue", data: { ...events[0].data, file: "worker/test/other.test.mjs", entryFile: "worker/test/other.test.mjs" } });
    assert.equal((await workerAbortPipeline(ordered)).rows.filter(row => row.kind === "worker_abort").length, 1);
  }
  for (const parent of [-1, NaN, "0", Number.MAX_SAFE_INTEGER + 1]) {
    const events = workerAbortNativeEvents(fixture.frames[0]); events[0].data.parentId = parent; events[1].data.parentId = parent;
    assert.equal((await workerAbortPipeline(events)).rows.some(row => row.kind === "worker_abort"), false);
  }
  for (const missing of [[0], [1], [0, 1]]) {
    const absent = workerAbortNativeEvents(fixture.frames[0]);
    for (const index of missing) delete absent[index].data.parentId;
    const result = await workerAbortPipeline(absent);
    assert.equal(result.rows.some(row => row.kind === "worker_abort"), false);
    assert.equal(result.rows.some(row => row.kind === "failure"), true);
  }
  let reads = 0;
  for (const index of [0, 1]) {
    const events = workerAbortNativeEvents(fixture.frames[0]);
    Object.defineProperty(events[index].data, "parentId", { get() { reads++; throw undefined; } });
    assert.equal((await workerAbortPipeline(events)).rows.some(row => row.kind === "worker_abort"), false);
    events[index].data = new Proxy(events[index].data, { get() { reads++; throw undefined; } });
    assert.equal((await workerAbortPipeline(events)).rows.some(row => row.kind === "worker_abort"), false);
  }
  assert.equal(reads, 0);
});
test("worker abort diagnostic pure: only canonical ASCII producer frames admit without normalization", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire", undefinedFault: true });
  const payload = fixture.frames[0].slice(workerAbortPrefix.length);
  assert.deepEqual(parseWorkerAbortDiagnostic(payload), fixture.record);
  const invalid = [
    payload.replace('{"v":1,', '{"v":0,"v":1,'), payload.replace('{"v":1,', '{"v":1,"v":1,'),
    payload.replace('"v":1', '"\\u0076":1'), payload.replace('worker_abort_stage', '\\u0077orker_abort_stage'),
    ' ' + payload, payload + ' ', payload.replace(',', ', '),
    JSON.stringify({ kind: fixture.record.kind, v: 1, ...Object.fromEntries(Object.entries(fixture.record).slice(2)) }),
    payload + 'x', payload + '\n', payload + '\x00', payload + '\x1b', payload + 'é',
    payload.replace('"first":[', '"first":[{"x":0,"x":1},'),
    payload.replace('"first":[', '"first":[{"x":1,"x":1},'),
    JSON.stringify({ ...fixture.record, extra: true }), '[' + payload + ']', 'x'.repeat(513),
  ];
  for (const value of invalid) {
    assert.equal(parseWorkerAbortDiagnostic(value), null);
    for (const order of [[0, 1, 2], [0, 2, 1]]) {
      const events = workerAbortNativeEvents(workerAbortPrefix + value);
      const result = await workerAbortPipeline(order.map(index => events[index]));
      assert.equal(result.rows.some(row => row.kind === "worker_abort"), false);
      assert.equal(result.rows.some(row => row.kind === "failure"), true);
      assert.deepEqual(result.rows.at(-1).diagnostics, [1, 0, 1, 0, false]);
    }
  }
  const result = await workerAbortPipeline(workerAbortNativeEvents(fixture.frames[0]));
  for (const record of result.rows) {
    const wire = JSON.stringify(record);
    assert.deepEqual(parseWorkerReporterRecord(wire), record);
    for (const text of [wire.replace('{"v":1,', '{"v":0,"v":1,'), wire.replace('{"v":1,', '{"v":1,"v":1,'), ' ' + wire, wire + '\n']) {
      assert.equal(parseWorkerReporterRecord(text), null);
    }
  }
  let reads = 0;
  const hostile = { toString() { reads++; throw undefined; } };
  assert.equal(parseWorkerAbortDiagnostic(hostile), null);
  assert.equal(parseWorkerReporterRecord(new Proxy(hostile, { get() { reads++; throw undefined; } })), null);
  assert.equal(reads, 0);
});
test("worker abort diagnostic pure: combined quota reserves identity and stage before unrelated leaves", async () => {
  const evidence = workerAbortEvidence(); evidence.stage(24); evidence.failed(undefined); let frame;
  evidence.observation(15, { status: "fulfilled", value: { operations: 1000000, syncFailures: 1000000, checks: [1000000, 1000000, 1000000, 1000000, false] } });
  evidence.observation(16, { status: "fulfilled", value: { calls: [], active: 1000000, canceled: 1000000, aborted: 1000000, expired: 1000000, finished: 1000000 } });
  evidence.report({ diagnostic(value) { frame = value; } });
  const events = workerAbortNativeEvents(frame), unrelated = Array.from({ length: 12 }, (_, i) => ({ type: "test:fail", data: { entryFile: "worker/test/other.test.mjs", file: "worker/test/other.test.mjs", line: i + 1, details: {} } }));
  const result = await workerAbortPipeline([...unrelated, ...events]);
  assert.equal(result.rows.length, 10); assert.deepEqual(result.rows.slice(0, 2).map(row => row.kind), ["failure", "worker_abort"]);
  assert.equal(result.rows.at(-1).reported, 8); assert.equal(result.rows.at(-1).omittedEvents, 5);
});
test("worker abort diagnostic pure: missing completion and reporter failure cannot manufacture evidence", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire" }), events = workerAbortNativeEvents(fixture.frames[0]);
  let release, returned = false;
  const pending = new Promise(resolve => { release = resolve; });
  async function* held() { yield* events; await pending; }
  const result = workerAbortPipeline(held()).then(value => { returned = true; return value; });
  await Promise.resolve(); assert.equal(returned, false); release(); assert.ok((await result).rows.some(row => row.kind === "worker_abort"));
  async function* failed() { yield* events; throw undefined; }
  let caught = false; try { await workerAbortPipeline(failed()); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true);
  const iterator = pureWorkerReporter()(events); await iterator.next(); caught = false;
  try { await iterator.throw(undefined); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true);
});
test("worker abort diagnostic pure: default coarse output is byte exact and hostile event getters never run", async () => {
  let reads = 0; const hostile = Object.defineProperty({}, "type", { get() { reads++; throw undefined; } });
  const events = [hostile, { type: "test:diagnostic", data: Object.defineProperty({}, "message", { get() { reads++; throw undefined; } }) },
    { type: "test:fail", data: { file: "worker/test/other.test.mjs", line: 4, details: {} } }];
  const result = await workerAbortPipeline(events); assert.equal(reads, 0);
  const target = workerAbortNativeEvents("").slice(0, 2);
  const disabled = await workerAbortPipeline(target);
  assert.equal(Object.hasOwn(disabled.rows.at(-1), "diagnostics"), false);
  assert.equal(disabled.rows.length, 2);
  assert.equal(result.lines.join(""), '::error title=Worker test identity::{"v":1,"kind":"failure","file":"worker/test/other.test.mjs","line":4,"failureType":"unknown","errorClass":"missing","code":"unknown"}\n'
    + '::error title=Worker test identity::{"v":1,"kind":"summary","failureEvents":1,"reported":1,"omittedEvents":0,"unknownFiles":0,"countsSaturated":false}\n');
});
function pureWorkerRetirement() {
  const source = readFileSync("worker/test/litellm-model-discovery.test.mjs", "utf8");
  const original = source.slice(source.indexOf("export function observeLiteLLMOperation("), source.indexOf("// BEGIN request-owned fixture functions."));
  const helpers = source.slice(source.indexOf("export function litellmPredicateFacts("), source.indexOf("// END request-owned fixture functions."));
  return new Function((original + helpers).replace(/^export /gm, "") + ";return {observeLiteLLMOperation,collectLiteLLMOperations,litellmWorkerDrain,litellmWorkerLedger,litellmPredicateFacts};")();
}
function workerOperationCase() {
  const r = { id: "native_abort", mode: "held", operations: [], roots: [], inputs: [], readers: [], bodies: [], requests: [], failures: [], observerFailures: [], calls: [], sequence: 0 };
  const request = {}, token = { id: 2, generation: 1, request, scenario: r }, response = {}, body = { locked: false };
  const input = { token, request, id: 3, response }, reader = { id: 4, transport: input, response, body, reader: {}, unlocks: 1, eof: false, bound: true };
  r.requests.push({ token, request }); r.inputs.push(input); r.readers.push(reader); r.bodies.push(body);
  return { r, token, input, reader, scope: { matchesResponse: () => true, retains: () => true } };
}
async function captureWorkerOperation(kind, reason, errorPresent = true) {
  const helper = pureWorkerRetirement(), fixture = workerOperationCase(), { r, input, reader, token, scope } = fixture;
  const pending = errorPresent ? Promise.reject(reason) : new Promise(() => {});
  const details = kind === "handler" ? { token } : { input, reader, signal: undefined, receiverIdentity: true };
  if (errorPresent) helper.observeLiteLLMOperation(r, kind, () => pending, details);
  else r.operations.push({ ...details, kind, ordinal: 0, invoke: ++r.sequence, state: "pending", pending });
  let failed = false, failure;
  try { await helper.litellmWorkerDrain(r, scope, () => { throw new Error("unexpected source proof"); }); }
  catch (error) { failed = true; failure = error; }
  const ledger = helper.litellmWorkerLedger(r, scope);
  return { ...fixture, helper, pending, failed, failure, ledger, tuple: ledger[10] };
}
test("worker abort original pure: first evaluated operation retains kind state bindings and undefined", async () => {
  for (const kind of ["handler", "fetch", "acquisition_observer", "read", "read_observer", "closed", "cancel", "body_cancel", "wait_until", "usage_ingest"]) {
    for (const reason of [undefined, {}]) {
      const result = await captureWorkerOperation(kind, reason);
      assert.equal(result.failed, true); assert.equal(result.failure.errors[0], reason);
      assert.equal(result.r.operations[0].pending, result.pending);
      assert.equal(result.tuple[1], true); assert.equal(result.tuple[2], 2);
      assert.equal(result.tuple[3][1], ["handler", "fetch", "acquisition_observer", "read", "read_observer", "closed", "cancel", "body_cancel", "wait_until", "usage_ingest"].indexOf(kind) + 1);
      assert.deepEqual(result.tuple[3].slice(6, 8), [true, reason !== undefined]);
      assert.deepEqual(decodeWorkerAbortOperation(result.tuple), result.tuple);
      assert.equal(result.r.workerDataDisposition[0], 1);
    }
  }
  const pending = await captureWorkerOperation("read", undefined, false);
  assert.equal(pending.failed, true); assert.deepEqual(pending.tuple[3].slice(6, 8), [false, null]);
  assert.equal(pending.tuple[2], 0); assert.equal(pending.tuple[4], 1);
  assert.deepEqual(decodeWorkerAbortOperation(pending.tuple), pending.tuple);
});
test("worker abort original pure: original comparison captures first identity once across repeated retirement", async () => {
  const c = await captureWorkerOperation("read", undefined);
  const first = c.r.retireChecks.operation(c.r), op = c.r.operations[0];
  c.helper.observeLiteLLMOperation(c.r, "cancel", () => Promise.reject({ later: true }), { input: c.input, reader: c.reader });
  await assert.rejects(c.helper.litellmWorkerDrain(c.r, c.scope, () => assert.fail()));
  assert.equal(c.r.retireChecks.operation(c.r), first); assert.equal(first.operation, op); assert.equal(first.state, "rejected");
  assert.deepEqual(c.helper.litellmWorkerLedger(c.r, c.scope)[10].slice(0, 4), c.tuple.slice(0, 4));
  assert.equal(c.r.retireChecks.operation({}), null);
  assert.equal(c.r.retireChecks.snapshot()[0], 4);
  op.state = "fulfilled";
  const stale = c.helper.litellmWorkerLedger(c.r, c.scope)[10];
  assert.equal(stale[1], false); assert.equal(stale[2], 2); assert.equal(stale[3], null);
});
test("worker abort original pure: original drain waits held work and captures evaluation order not rejection chronology", async () => {
  const h = pureWorkerRetirement(), c = workerOperationCase(); let rejectHeld, getters = 0, done = false;
  const reason = Object.defineProperty({}, "message", { get() { getters++; throw undefined; } });
  const held = new Promise((resolve, reject) => { rejectHeld = reject; });
  h.observeLiteLLMOperation(c.r, "handler", () => Promise.resolve({}), { token: c.token });
  assert.equal(h.observeLiteLLMOperation(c.r, "read", () => held, { input: c.input, reader: c.reader }), held);
  h.observeLiteLLMOperation(c.r, "cancel", () => Promise.reject(undefined), { input: c.input, reader: c.reader });
  const joined = h.litellmWorkerDrain(c.r, c.scope, () => assert.fail()).then(() => { done = true; return null; }, error => { done = true; return error; });
  await Promise.resolve(); assert.equal(done, false); rejectHeld(reason);
  const failure = await joined; assert.deepEqual(failure.errors, [reason, undefined]);
  const first = c.r.retireChecks.operation(c.r); assert.equal(first.operation, c.r.operations[1]);
  assert.ok(c.r.operations[2].settle < c.r.operations[1].settle);
  const ledger = h.litellmWorkerLedger(c.r, c.scope); assert.equal(ledger[10][3][0], 1); assert.equal(ledger[10][3][1], 4);
  const evidence = workerAbortEvidence(); evidence.stage(14); evidence.failed(failure);
  evidence.observation(15, { status: "fulfilled", value: { operations: ledger[0], syncFailures: ledger[2], checks: c.r.retireChecks.snapshot(), ledger } });
  assert.deepEqual(evidence.report({ diagnostic() {} }), []); assert.equal(getters, 0);
  const foreign = workerOperationCase(); foreign.r.retireChecks = c.r.retireChecks;
  assert.equal(h.litellmWorkerLedger(foreign.r, foreign.scope)[10][1], null);
});
test("worker abort original pure: foreign missing stale and synchronous outcomes never invent ownership", async () => {
  for (const mutate of [c => c.r.inputs.splice(0), c => c.r.readers.splice(0), c => c.r.requests.splice(0),
    c => c.token.scenario = {}, c => c.token.request = {}, c => c.token.generation = undefined,
    c => c.r.operations[0].ordinal = 7, c => c.r.requests.push(c.r.requests[0]),
    c => c.input.request = {}, c => c.reader.transport = {}, c => c.r.operations[0].transport = {},
    c => c.r.retireChecks = c.helper.litellmPredicateFacts()]) {
    const c = await captureWorkerOperation("read", undefined); mutate(c);
    const tuple = c.helper.litellmWorkerLedger(c.r, c.scope)[10];
    assert.notEqual(tuple[1], true); assert.equal(tuple[3], null); assert.deepEqual(decodeWorkerAbortOperation(tuple), tuple);
  }
  const c = workerOperationCase(), h = pureWorkerRetirement(); let caught = false;
  try { h.observeLiteLLMOperation(c.r, "read", () => { throw undefined; }, { input: c.input, reader: c.reader }); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true); await assert.rejects(h.litellmWorkerDrain(c.r, c.scope, () => assert.fail()));
  const tuple = h.litellmWorkerLedger(c.r, c.scope)[10]; assert.equal(tuple[2], 3); assert.deepEqual(tuple[3].slice(6, 8), [true, false]);
  assert.deepEqual(c.r.failures, [undefined]); assert.equal(c.r.retireChecks.snapshot()[0], 2);
});
test("worker abort original pure: actual ledger relay preserves old schema and all original evidence", async () => {
  const c = await captureWorkerOperation("cancel", undefined), proof = workerAbortEvidence(); proof.stage(14); proof.failed({});
  proof.observation(15, { status: "fulfilled", value: { operations: c.ledger[0], syncFailures: c.ledger[2], checks: c.r.retireChecks.snapshot(), ledger: c.ledger.slice(0, 11) } });
  proof.observation(16, { status: "fulfilled", value: { calls: [{}], active: 0, canceled: 0, aborted: 0, expired: 1, finished: 1 } });
  let frame; assert.deepEqual(proof.report({ diagnostic(value) { frame = value; } }), []);
  const record = parseWorkerAbortDiagnostic(frame.slice(workerAbortPrefix.length)); assert.deepEqual(record.worker[3], c.tuple);
  for (const order of [[0, 1, 2], [0, 2, 1]]) {
    const events = workerAbortNativeEvents(frame), result = await workerAbortPipeline(order.map(i => events[i]));
    assert.deepEqual(result.rows.find(row => row.kind === "worker_abort").worker[3], c.tuple);
  }
  const broken = workerAbortEvidence(); broken.stage(14); broken.failed(undefined);
  broken.observation(15, { status: "fulfilled", value: { operations: 1, syncFailures: 0, checks: [4,127,111,16,null], ledger: { 10: [1] } } });
  let invalid; broken.report({ diagnostic(value) { invalid = value; } });
  const projected = parseWorkerAbortDiagnostic(invalid.slice(workerAbortPrefix.length));
  assert.deepEqual(projected.first, [14,0,false]); assert.equal(projected.reportingFailures, 1);
  const reporting = proof.report({ diagnostic() { throw undefined; } }); assert.deepEqual(reporting, [undefined]);
});
test("worker abort original pure: max width canonical envelope remains closed and bounded", async () => {
  const tuple = [1,true,2,[1000000,10,2,1000000,1000000,1000000,true,false,1000000,1000000],1000000,1000000,1000000];
  assert.deepEqual(decodeWorkerAbortOperation(tuple), tuple);
  const record = { v:1,kind:"worker_abort_stage",first:[14,0,false],failures:1000000,undefinedFailures:1000000,
    worker:[1000000,1000000,[4,127,111,16,null],tuple],upstream:Array(6).fill(1000000),reportingFailures:1000000 };
  const wire = JSON.stringify(record); assert.ok(Buffer.byteLength(wire) <= 512); assert.deepEqual(parseWorkerAbortDiagnostic(wire), record);
  const events = workerAbortNativeEvents(workerAbortPrefix + wire), result = await workerAbortPipeline(events);
  assert.equal(result.rows[1].kind, "worker_abort");
  for (const change of [[1,true,null,tuple[3],0,0,1],[1,true,2,null,0,0,1],[1,false,2,tuple[3],0,0,null],
    [1,true,2,[0,4,2,2,3,4,false,false,1,2],0,0,1], [1,true,2,[0,4,2,2,3,4,true,null,1,2],0,0,1]]) assert.equal(decodeWorkerAbortOperation(change), null);
  for (const text of [wire.replace('{"v":1,','{"v":0,"v":1,'), wire+' ', wire+'é']) assert.equal(parseWorkerAbortDiagnostic(text), null);
});

async function workerRelationCase({ reason = {}, undefinedReason = false, nonreader = false } = {}) {
  const c = workerOperationCase(), h = pureWorkerRetirement(), calls = [];
  const error = undefinedReason ? undefined : reason;
  for (const kind of ["handler", "fetch", "acquisition_observer"]) h.observeLiteLLMOperation(c.r, kind, () => Promise.resolve({}), { token: c.token });
  const details = { input: c.input, reader: c.reader, receiverIdentity: true, signalAborted: false };
  const closed = Promise.reject(error), read = Promise.reject(error), cancel = nonreader ? Promise.resolve(null) : Promise.reject(error);
  c.reader.closed = closed;
  const call = (kind, promise, extra = {}) => h.observeLiteLLMOperation(c.r, kind, () => { calls.push(kind); return promise; }, { ...details, ...extra });
  assert.equal(call("closed", closed), closed); assert.equal(call("read", read), read);
  const derivative = read.then(value => value);
  assert.equal(call("read_observer", derivative, { originalRead: read }), derivative);
  assert.equal(call("cancel", cancel, { argc: 1, operandPresent: true, reason: error }), cancel);
  if(nonreader)h.observeLiteLLMOperation(c.r,"wait_until",()=>Promise.reject(error),{token:c.token});
  c.input.abortSequence = ++c.r.sequence; c.input.callerAbortedAtAbort = false;
  c.input.noEarlierFailure = true; c.input.pendingAtAbort = [c.r.operations[4]];
  c.reader.unlockInvoke = ++c.r.sequence; c.reader.unlockSequence = ++c.r.sequence;
  let failure;
  try { await h.litellmWorkerDrain(c.r, c.scope, () => assert.fail()); } catch (value) { failure = value; }
  assert.deepEqual(failure.errors, [error, error, error, error]);
  const project = () => {
    const ledger = h.litellmWorkerLedger(c.r, c.scope);
    return JSON.parse(JSON.stringify({ operations: ledger[0], syncFailures: ledger[2], checks: c.r.retireChecks.snapshot(), ledger,
      ingress: [true], inputs: [{ signalAborted: true }], readers: [{ unlocks: 1, locked: false }] }));
  };
  return { ...c, h, calls, error, failure, closed, read, derivative, cancel, project };
}
function workerRelationFrames(observation, { reportFault = -1, reportReason, primary } = {}) {
  const proof = workerAbortEvidence(), frames = []; proof.stage(14); proof.failed(primary);
  proof.observation(15, { status: "fulfilled", value: observation });
  proof.observation(16, { status: "fulfilled", value: { calls: [{}], active: 0, canceled: 0, aborted: 0, expired: 1, finished: 1, producer: [1, 0, 0, 0, 0] } });
  const errors = proof.report({ diagnostic(frame) { if (frames.length === reportFault) throw reportReason; frames.push(frame); } });
  return { frames, errors };
}
function workerRelationEvents(frames, reverse = false) {
  const events = workerAbortNativeEvents(frames[0]), diagnostics = frames.map(frame => ({ ...events[2], data: { ...events[2].data, message: frame } }));
  return reverse ? [events[0], ...diagnostics.reverse(), events[1]] : [...events.slice(0, 2), ...diagnostics];
}
const relationRecords = rows => rows.filter(row => row.kind === "worker_abort_relation");
async function workerFallbackObservation({ closedFulfilled = false, cancelFulfilled = false, handlerRejected = false, reason } = {}) {
  const c = workerOperationCase(), h = pureWorkerRetirement();
  for (const kind of ["handler", "fetch", "acquisition_observer"]) {
    h.observeLiteLLMOperation(c.r, kind, () => kind === "handler" && handlerRejected ? Promise.reject(reason) : Promise.resolve({}), { token: c.token });
  }
  const details = { input: c.input, reader: c.reader, receiverIdentity: true, signalAborted: false };
  const closed = closedFulfilled ? Promise.resolve() : Promise.reject(reason), read = Promise.reject(reason);
  const cancel = cancelFulfilled ? Promise.resolve() : Promise.reject(reason); c.reader.closed = closed;
  h.observeLiteLLMOperation(c.r, "closed", () => closed, details);
  h.observeLiteLLMOperation(c.r, "read", () => read, details);
  const derivative = read.then(value => value);
  h.observeLiteLLMOperation(c.r, "read_observer", () => derivative, { ...details, originalRead: read });
  h.observeLiteLLMOperation(c.r, "cancel", () => cancel, { ...details, argc: 1, operandPresent: true, reason });
  c.input.abortSequence = ++c.r.sequence; c.input.callerAbortedAtAbort = false;
  c.input.noEarlierFailure = true; c.input.pendingAtAbort = [c.r.operations[4]];
  c.reader.unlockInvoke = ++c.r.sequence; c.reader.unlockSequence = ++c.r.sequence;
  let failed = false, failure;
  try { await h.litellmWorkerDrain(c.r, c.scope, () => assert.fail()); } catch (error) { failed = true; failure = error; }
  assert.equal(failed, true);
  const rejected = c.r.operations.filter(op => op.state === "rejected");
  assert.deepEqual(failure.errors, rejected.map(() => reason));
  const ledger = h.litellmWorkerLedger(c.r, c.scope);
  return JSON.parse(JSON.stringify({ operations: ledger[0], syncFailures: ledger[2], checks: c.r.retireChecks.snapshot(), ledger,
    ingress: [true], inputs: [{ signalAborted: true }], readers: [{ unlocks: 1, locked: false }] }));
}
test("worker abort fallback pure: actual original outcomes select exactly one validated family", async () => {
  for (const reason of [undefined, {}]) for (const shape of [{}, { cancelFulfilled: true }, { closedFulfilled: true, cancelFulfilled: true }, { closedFulfilled: true, cancelFulfilled: true, handlerRejected: true }]) {
    const observation = await workerFallbackObservation({ ...shape, reason }), complete = !shape.handlerRejected;
    const { frames, errors } = workerRelationFrames(observation, { primary: reason });
    assert.deepEqual(errors, []); assert.equal(frames.length, complete ? 8 : 1);
    assert.equal(frames.every(frame => frame.startsWith(complete ? (Object.keys(shape).length ? workerAbortRelationalPrefixV3 : workerAbortRelationalPrefix) : workerAbortPrefix)), true);
    for (const reverse of [false, true]) {
      const result = await workerAbortPipeline(workerRelationEvents(frames, reverse));
      assert.equal(result.rows[0].kind, "failure"); assert.equal(relationRecords(result.rows).length, complete ? 8 : 0);
      if (!complete) {
        const stage = result.rows.find(row => row.kind === "worker_abort"); assert.ok(stage);
        assert.deepEqual(stage.stage, [14, 0, reason !== undefined]);
        assert.deepEqual(stage.worker[2], observation.checks); assert.deepEqual(stage.worker[3], observation.ledger[10]);
        assert.deepEqual(stage.counts, [1, reason === undefined ? 1 : 0, 0]);
        assert.equal(result.rows.at(-1).relational, undefined);
      }
    }
  }
});
test("worker abort fallback pure: unsupported foreign and inconsistent groups retain only coarse evidence", async () => {
  const cases = await workerRelationRepairCases();
  const missing = (await workerRelationCase()).project(); delete missing.ledger[11].rows;
  cases.push({ name: "missing relational rows", observation: missing, accepted: false });
  for (const entry of cases) {
    const { frames, errors } = workerRelationFrames(entry.observation);
    assert.equal(frames.length, entry.accepted ? 8 : 1, entry.name);
    if (errors.length) assert.equal(entry.accepted, false);
    for (const reverse of [false, true]) {
      const result = await workerAbortPipeline(workerRelationEvents(frames, reverse));
      assert.equal(relationRecords(result.rows).length, entry.accepted ? 8 : 0, entry.name);
      assert.equal(result.rows[0].kind, "failure");
      if (!entry.accepted) assert.equal(result.rows.find(row => row.kind === "worker_abort").counts[2], errors.length);
    }
  }
});
test("worker abort fallback pure: coarse fallback cannot bypass native ownership", async () => {
  const { frames } = workerRelationFrames(await workerFallbackObservation({ cancelFulfilled: true, handlerRejected: true }));
  for (const reverse of [false, true]) for (const mutate of [
    events => { delete events.find(e => e.type === "test:enqueue").data.parentId; },
    events => { delete events.find(e => e.type === "test:diagnostic").data.entryFile; },
    events => { events.find(e => e.type === "test:diagnostic").data.line++; },
    events => { events.push({ ...events[0], data: { ...events[0].data, name: "foreign" } }); },
  ]) {
    const events = workerRelationEvents(frames, reverse); mutate(events);
    const result = await workerAbortPipeline(events);
    assert.equal(result.rows[0].kind, "failure"); assert.equal(result.rows.some(row => row.kind === "worker_abort"), false);
    assert.equal(relationRecords(result.rows).length, 0); assert.equal(result.rows.some(row => row.kind === "worker_abort_unbound"), true);
  }
});
test("worker abort fallback pure: writer failures never emit a second family or replace primary undefined", async () => {
  for (const complete of [false, true]) for (const reportReason of [undefined, {}]) {
    const observation = await workerFallbackObservation({ cancelFulfilled: !complete, handlerRejected: !complete });
    for (let reportFault = 0; reportFault < (complete ? 8 : 1); reportFault++) {
      const { frames, errors } = workerRelationFrames(observation, { reportFault, reportReason });
      assert.equal(errors.length, 1); assert.equal(errors[0], reportReason); assert.equal(frames.length, reportFault);
      assert.equal(frames.every(frame => frame.startsWith(complete ? workerAbortRelationalPrefix : workerAbortPrefix)), true);
      const result = await workerAbortPipeline(workerRelationEvents(frames));
      assert.equal(result.rows[0].kind, "failure"); assert.equal(relationRecords(result.rows).length, 0);
      assert.equal(result.rows.some(row => row.kind === "worker_abort"), false);
    }
  }
  const invalid = await workerFallbackObservation({ cancelFulfilled: true });
  const proof = workerAbortEvidence(), frames = []; proof.stage(99); proof.failed(undefined);
  proof.observation(15, { status: "fulfilled", value: invalid });
  // Neither an invalid component nor an invalid legacy stage is invented evidence.
  const errors = proof.report({ diagnostic(frame) { frames.push(frame); } });
  assert.equal(frames.length, 0); assert.equal(errors.length, 2);
});
test("worker abort relational pure: actual ledger preserves four originals private identities and all eight parts", async () => {
  for (const undefinedReason of [false, true]) {
    const c = await workerRelationCase({ undefinedReason }), observation = c.project(), projected = observation.ledger[11];
    assert.deepEqual(c.calls, ["closed", "read", "read_observer", "cancel"]);
    assert.equal(c.r.operations[3].pending, c.closed); assert.equal(c.r.operations[4].pending, c.read);
    assert.equal(c.r.operations[5].pending, c.derivative); assert.equal(c.r.operations[5].originalRead, c.read);
    assert.equal(c.r.operations[6].pending, c.cancel); assert.deepEqual(projected.coverage.slice(0,4), [4,4,0,false]);
    assert.deepEqual(projected.rows.map(row=>row.slice(7,9)), Array(4).fill([true,!undefinedReason]));
    assert.deepEqual(projected.resource.slice(5), [true,true]); assert.deepEqual(projected.relations.slice(0,2),[63,0]);
    assert.deepEqual(projected.relations.slice(2,7),Array(5).fill(true));
    const { frames, errors } = workerRelationFrames(observation); assert.deepEqual(errors, []); assert.equal(frames.length,8);
    const parts = frames.map(frame=>parseWorkerAbortPart(frame.slice(workerAbortRelationalPrefix.length)));
    assert.deepEqual(validateWorkerAbortGroup(parts),parts);
    for (const reverse of [false,true]) {
      const result = await workerAbortPipeline(workerRelationEvents(frames,reverse));
      assert.equal(relationRecords(result.rows).length,8); assert.equal(result.rows.length,10);
      assert.deepEqual(result.rows.at(-1).relational,[8,8,0,0,false,255,0,0,false]);
      assert.equal(result.rows[0].kind,"failure"); assert.equal(relationRecords(result.rows).find(row=>row.part==="coverage").data[17],null);
    }
  }
});
test("worker abort relational pure: missing duplicate conflicting mixed and foreign parts invalidate the entire group", async () => {
  const c=await workerRelationCase(), {frames}=workerRelationFrames(c.project());
  const mutate=(index,fn)=>frames.map((frame,i)=>{if(i!==index)return frame;const part=JSON.parse(frame.slice(workerAbortRelationalPrefix.length));fn(part);return workerAbortRelationalPrefix+JSON.stringify(part);});
  const bad=[];
  for(let i=0;i<8;i++){bad.push(frames.filter((_,j)=>j!==i));bad.push([...frames,frames[i]]);bad.push(mutate(i,part=>part.ref[0]++));}
  bad.push(mutate(2,part=>part.data[0][0]=part.data[1][0]));
  for(let i=1;i<=4;i++)bad.push(mutate(3,part=>part.data[i][0]=99));
  bad.push(mutate(6,part=>{part.data[7]=2;part.data[8].push([...part.data[8][0]]);}));
  bad.push(mutate(3,part=>part.data[3][0]++)); bad.push(mutate(3,part=>part.data[5]=false));
  bad.push(mutate(3,part=>part.data[6]=false)); bad.push(mutate(4,part=>part.data[0]=0));
  bad.push(mutate(5,part=>part.data[0][0]++)); bad.push(mutate(6,part=>part.data[8][0][1]++));
  bad.push(mutate(7,part=>part.data[0]++)); bad.push(mutate(7,part=>part.data[3]=true));
  bad.push([...frames,(await abortDiagnosticCase({fault:"retire"})).frames[0]]);
  for(const input of bad) {
    const result=await workerAbortPipeline(workerRelationEvents(input));
    assert.equal(relationRecords(result.rows).length,0); assert.equal(result.rows[0].kind,"failure");
    assert.equal(result.rows.at(-1).relational[1],0); assert.equal(result.rows.some(row=>row.kind==="worker_abort_unbound"),true);
  }
});
test("worker abort relational pure: every component needs native ownership through the complete census", async () => {
  const {frames}=workerRelationFrames((await workerRelationCase()).project());
  for(let i=0;i<8;i++)for(const key of ["entryFile","file","line","column","nesting"]){
    const events=workerRelationEvents(frames); delete events[i+2].data[key];
    const result=await workerAbortPipeline(events); assert.equal(relationRecords(result.rows).length,0);assert.equal(result.rows[0].kind,"failure");
  }
  for(const change of [events=>delete events[0].data.parentId,events=>delete events[1].data.parentId,
    events=>events.push({...events[0],data:{...events[0].data,testId:88,name:"foreign"}}),
    events=>events.push({...events[0],data:{...events[0].data,line:900,name:"id reuse"}})]){
    const events=workerRelationEvents(frames);change(events);assert.equal(relationRecords((await workerAbortPipeline(events)).rows).length,0);
  }
  assert.equal(relationRecords((await workerAbortPipeline(workerRelationEvents(frames),{complete:false})).rows).length,0);
  const unrelated=[8,9].map(testId=>({type:"test:enqueue",data:{...workerRelationEvents(frames)[0].data,testId,name:"parameterized",line:999}}));
  assert.equal(relationRecords((await workerAbortPipeline([...workerRelationEvents(frames),...unrelated])).rows).length,8);
});
test("worker abort relational pure: stale foreign missing and overflow retained data never manufactures completeness", async () => {
  const mutations=[c=>c.reader.closed={},c=>c.r.operations[5].originalRead={},c=>c.input.response={},c=>c.reader.transport={},
    c=>c.token.generation=undefined,c=>c.r.requests.push(c.r.requests[0]),c=>c.input.pendingAtAbort=[{}],
    c=>c.r.operations[3].state="fulfilled",c=>c.r.operations[3].invoke=1000001,c=>c.r.operations[3].settle=1000001,
    c=>c.token.id=1000001,c=>c.r.operations.push({...c.r.operations[6],ordinal:7}),c=>delete c.r.operations[3].pending];
  for(const mutate of mutations){const c=await workerRelationCase();mutate(c);const {frames}=workerRelationFrames(c.project());
    if(frames.length)assert.equal(relationRecords((await workerAbortPipeline(workerRelationEvents(frames))).rows).length,0);
  }
  const c=await workerRelationCase();const first=c.r.retireChecks.operation(c.r);await assert.rejects(c.h.litellmWorkerDrain(c.r,c.scope,()=>assert.fail()));
  assert.equal(c.r.retireChecks.operation(c.r),first);assert.equal(c.project().ledger[11].ref[4],first.operation.ordinal);
});
test("worker abort relational pure: absent pending undefined and false have distinct closed meanings", async () => {
  const c=await workerRelationCase({undefinedReason:true}); delete c.input.abortSequence;delete c.input.callerAbortedAtAbort;
  delete c.input.noEarlierFailure;delete c.input.pendingAtAbort; delete c.r.operations[3].signalAborted;
  const source=c.project().ledger[11]; assert.deepEqual(source.abort,[false,null,false,null,false,null,false,null,[],null,null]);
  assert.deepEqual(source.signals[0].slice(1,3),[false,null]);assert.deepEqual(source.signals[0].slice(3),[true,false,true,false]);
  const {frames}=workerRelationFrames(c.project());assert.equal(validateWorkerAbortGroup(frames.map(f=>parseWorkerAbortPart(f.slice(workerAbortRelationalPrefix.length))))!==null,true);
  const part=JSON.parse(frames[1].slice(workerAbortRelationalPrefix.length));part.data[0][2]=0;part.data[0][7]=false;part.data[0][8]=null;part.data[0][10]=null;
  assert.ok(decodeWorkerAbortPart(part));part.data[0][8]=false;assert.equal(decodeWorkerAbortPart(part),null);
  const sync=await captureWorkerOperation("read",undefined);assert.equal(sync.r.retireChecks.snapshot()[0],4);
});
test("worker abort relational pure: canonical schema rejects getters ambiguous JSON and hostile nested fields", async () => {
  const {frames}=workerRelationFrames((await workerRelationCase()).project());let getters=0;
  for(const frame of frames){const wire=frame.slice(workerAbortRelationalPrefix.length),part=JSON.parse(wire);
    for(const key of Object.keys(part)){const hostile={...part};Object.defineProperty(hostile,key,{get(){getters++;throw undefined;}});assert.equal(decodeWorkerAbortPart(hostile),null);}
    for(const text of [' '+wire,wire+' ',wire+'é',wire+'\n',wire.replace('{"v":2,','{"v":2,"v":2,'),wire.replace('"v":2','"\\u0076":2'),JSON.stringify({...part,extra:true})])assert.equal(parseWorkerAbortPart(text),null);
    const hostile=structuredClone(part);Object.defineProperty(hostile.ref,"0",{get(){getters++;throw undefined;}});assert.equal(decodeWorkerAbortPart(hostile),null);
  }assert.equal(getters,0);
});
test("worker abort relational pure: failed reporting and saturation preserve coarse failure without partial evidence", async () => {
  const observation=(await workerRelationCase()).project();
  for(let i=0;i<8;i++){const {frames,errors}=workerRelationFrames(observation,{reportFault:i});assert.deepEqual(errors,[undefined]);
    const events=workerRelationEvents(frames);const result=await workerAbortPipeline(events);assert.equal(relationRecords(result.rows).length,0);assert.equal(result.rows[0].kind,"failure");
  }
  const {frames}=workerRelationFrames(observation),events=workerRelationEvents(frames);
  const result=await workerAbortPipeline([...events,...Array(33).fill(events[2])]);assert.equal(relationRecords(result.rows).length,0);assert.equal(result.rows.at(-1).relational[4],true);
  const more=Array.from({length:12},(_,i)=>({type:"test:fail",data:{file:"worker/test/other.test.mjs",entryFile:"worker/test/other.test.mjs",line:i+1,details:{error:{failureType:"testCodeFailure"}}}}));
  const full=await workerAbortPipeline([...more,...events]);assert.equal(relationRecords(full.rows).length,8);assert.equal(full.rows.at(-1).omittedEvents,12);assert.equal(full.rows.length,10);
});
async function workerRelationMaximum() {
  const c=await workerRelationCase(),observation=c.project(),source=observation.ledger[11],max=1000000;
  const remap=x=>max-7+x;
  source.ref=[max,max,max,max,remap(3)]; source.rows.forEach(row=>{row[0]=remap(row[0]);row.splice(3,4,max,max,max,max);row[9]=max-100+row[0]-(max-7);row[10]=row[9]+90;});
  source.signals.forEach(row=>row[0]=remap(row[0]));source.resource.slice(1,5).forEach(row=>{row[0]=remap(row[0]);row[3]=max-100+row[0]-(max-7);row[4]=row[3]+90;});
  source.relations[13]=max;source.relations[14]=max;source.relations[15]=max;source.relations[16]=max;
  source.abort=[true,max-50,true,false,true,false,true,4,[remap(4),max-8,max-9,max-10].map(id=>[id,max]),0,true];
  source.coverage.splice(4,5,0,max,max,max,max);observation.operations=max;observation.syncFailures=max;
  const {frames,errors}=workerRelationFrames(observation);assert.deepEqual(errors,[]);
  const maximal=frames.map(frame=>{const p=JSON.parse(frame.slice(workerAbortRelationalPrefix.length));
    if(p.part==="retire"){p.data[1]=Array(3).fill(max);p.data[2]=[29,max,max,max,false];}
    if(p.part==="coverage"){p.data.splice(9,3,max,max,max);for(let i=13;i<=15;i++)p.data[i]=[true,false];p.data[16]=Array(5).fill(max);p.data[18]=Array(6).fill(max);}
    if(p.part==="relations"){p.data[1]=63;for(let i=2;i<13;i++)p.data[i]=false;}
    return workerAbortRelationalPrefix+JSON.stringify(p);});
  const events=workerRelationEvents(maximal);for(const e of events){e.data.line=max;e.data.column=max;e.data.nesting=max;}
  const result=await workerAbortPipeline(events);assert.equal(relationRecords(result.rows).length,8);assert.equal(result.lines.length,10);
  const sizes={records:result.rows.map(row=>Buffer.byteLength(JSON.stringify(row))),commands:result.lines.map(line=>Buffer.byteLength(line)),packet:Buffer.byteLength(result.lines.join(""))};
  assert.ok(Math.max(...sizes.records)<=512);assert.ok(Math.max(...sizes.commands)<=768);assert.ok(sizes.packet<=8192);
  assert.deepEqual(result.rows.map(row=>parseWorkerReporterRecord(JSON.stringify(row))),result.rows);
  return { ...result, sizes };
}
test("worker abort relational pure: maximum actual canonical eight part envelope fits all unchanged caps", workerRelationMaximum);


test("worker abort relational pure: comparison state is not overwritten by later observation", async () => {
  const c=await workerRelationCase();
  c.r.retireChecks=c.h.litellmPredicateFacts();c.r.retireChecks.note(4,false,c.r,c.r.operations[3],"pending");
  const observation=c.project();assert.equal(observation.ledger[10][1],false);
  const {frames}=workerRelationFrames(observation),result=await workerAbortPipeline(workerRelationEvents(frames));
  assert.equal(relationRecords(result.rows).length,8);
  assert.equal(relationRecords(result.rows).find(r=>r.part==="retire").data[4],0);
  assert.equal(relationRecords(result.rows).find(r=>r.part==="bad_a").data[0][2],2);
});

test("worker abort relational pure: nonfulfilled resource roles must belong to the complete bad census", async () => {
  const c=await workerRelationCase(),{frames}=workerRelationFrames(c.project());
  const parts=frames.map(f=>parseWorkerAbortPart(f.slice(workerAbortRelationalPrefix.length)));
  for(let i=1;i<=4;i++){
    const changed=structuredClone(parts);changed[3].data[i][0]=999;
    assert.equal(validateWorkerAbortGroup(changed),null);
  }
  // Fulfilled cancellation can be absent from the bad census, but its
  // ordinal must still name one of the eight actual ledger operations.
  const valid=workerRelationFrames((await workerRelationCase({nonreader:true})).project()).frames
    .map(f=>parseWorkerAbortPart(f.slice(workerAbortRelationalPrefix.length)));
  assert.ok(validateWorkerAbortGroup(valid));
  valid[3].data[4][0]=999;assert.equal(validateWorkerAbortGroup(valid),null);
});

async function workerRelationRepairCases() {
  const cases=[];
  async function add(name, mutate, accepted=false, nonreader=true){
    const c=await workerRelationCase({nonreader});let observation;
    if(mutate)observation=mutate(c);observation??=c.project();cases.push({name,observation,accepted});
  }
  await add("foreign fourth waiter with equal numeric IDs",c=>{c.r.operations[7].token={...c.token,request:{},scenario:{}};});
  await add("fulfilled cancel ordinal999 with total8",c=>{const o=c.project();o.ledger[11].resource[4][0]=999;return o;});
  await add("complete rejected census with pending1",c=>{const o=c.project();o.ledger[11].coverage[4]=1;return o;});
  await add("first state cannot regress to pending",c=>{const op=c.r.operations[3];op.state="pending";delete op.error;delete op.settle;});
  await add("synchronous comparison cannot become rejected",c=>{const o=c.project();o.ledger[10][2]=3;return o;});
  await add("legitimate absent nonreader references",null,true);
  await add("legitimate explicit undefined nonreader references",c=>{Object.assign(c.r.operations[7],{input:undefined,transport:undefined,reader:undefined});},true);
  for(const index of [3,4,5,7])for(const field of ["token","request","scenario","transport","reader","ordinal"]){
    await add(`foreign operation ${index} ${field}`,c=>{
      const op=c.r.operations[index];
      if(field==="token")op.token={...c.token};
      if(field==="request")op.request={};
      if(field==="scenario")op.token={...c.token,scenario:{}};
      if(field==="transport")op.transport={...c.input};
      if(field==="reader")op.reader={...c.reader};
      if(field==="ordinal")op.ordinal=0;
    });
  }
  await add("duplicate operation object",c=>{c.r.operations.push(c.r.operations[7]);});
  await add("foreign request registration",c=>{c.r.requests[0].request={};});
  await add("ambiguous request object",c=>{c.r.requests.push({token:{...c.token},request:c.token.request});});
  await add("ambiguous transport object",c=>{c.r.inputs.push(c.input);});
  await add("ambiguous reader object",c=>{c.r.readers.push(c.reader);});
  for(let role=1;role<=4;role++)for(const field of ["range","state","error","invoke","settle"]){
    await add(`resource ${role} ${field}`,c=>{const o=c.project(),r=o.ledger[11].resource[role];
      if(field==="range")r[0]=o.operations;
      if(field==="state")r[1]=r[1]===1?2:1;
      if(field==="error")r[2]=r[2]===0?1:0;
      if(field==="invoke")r[3]=0;
      if(field==="settle")r[4]=r[3];return o;});
  }
  for(const field of ["zero total","null total","small total","bad range","bad kind","bad missing reader","bad missing input","bad absent error","bad missing settle","bad zero invoke","bad sequence","duplicate invoke","duplicate settle","pending range","pending wrong role","pending count","pending late invocation","pending early settlement"]){
    await add(field,c=>{const o=c.project(),x=o.ledger[11],row=x.rows[1];
      if(field==="zero total")o.operations=0;if(field==="null total")o.operations=null;if(field==="small total")o.operations=4;
      if(field==="bad range")row[0]=o.operations;if(field==="bad kind")row[1]=0;
      if(field==="bad missing reader")row[6]=null;if(field==="bad missing input")row[5]=null;
      if(field==="bad absent error"){row[7]=false;row[8]=null;}if(field==="bad missing settle")row[10]=null;
      if(field==="bad zero invoke")row[9]=0;if(field==="bad sequence")row[10]=row[9];
      if(field==="duplicate invoke"){x.resource[4][3]=x.resource[1][3];}
      if(field==="duplicate settle"){x.resource[4][4]=x.resource[1][4];}
      if(field==="pending range")x.abort[8][0][0]=o.operations;
      if(field==="pending wrong role")x.abort[8][0][0]=x.resource[3][0];
      if(field==="pending count")x.abort[7]=2;
      if(field==="pending late invocation")x.abort[1]=x.resource[1][3];
      if(field==="pending early settlement")x.abort[1]=x.resource[1][4];return o;});
  }
  return cases;
}
test("worker abort relational repair pure: exact operation owners and complete census reject all three reviewed counterexamples", async()=>{
  for(const c of await workerRelationRepairCases()){
    const {frames,errors}=workerRelationFrames(c.observation);
    if(c.accepted||["foreign fourth waiter with equal numeric IDs","fulfilled cancel ordinal999 with total8","complete rejected census with pending1"].includes(c.name))assert.deepEqual(errors,[],c.name);
    if(errors.length)assert.equal(c.accepted,false,c.name);
    for(const reverse of [false,true]){
      const result=await workerAbortPipeline(workerRelationEvents(frames,reverse));
      assert.equal(relationRecords(result.rows).length,c.accepted?8:0,c.name);
      assert.equal(result.rows[0].kind,"failure",c.name);
    }
  }
});

// These inert originals exercise the actual projection and retirement helper.
// They establish diagnostic protocol behavior, never native cancellation credit.
async function workerBoundedCase(options={}) {
  const {closedRejected=false,readRejected=true,cancelState="fulfilled",extra=false,prefix=false}=options;
  const reason=Object.hasOwn(options,"reason")?options.reason:{},closedReason=Object.hasOwn(options,"closedReason")?options.closedReason:reason,cancelReason=Object.hasOwn(options,"cancelReason")?options.cancelReason:reason;
  const c=workerOperationCase(),h=pureWorkerRetirement(),details={input:c.input,reader:c.reader,receiverIdentity:true,signalAborted:false};
  for(const kind of ["handler","fetch","acquisition_observer"])h.observeLiteLLMOperation(c.r,kind,()=>Promise.resolve({}),{token:c.token});
  const closed=closedRejected?Promise.reject(closedReason):Promise.resolve(),read=readRejected?Promise.reject(reason):Promise.resolve({done:false,value:{byteLength:1}});
  c.reader.closed=closed;
  const call=(kind,pending,extra={})=>h.observeLiteLLMOperation(c.r,kind,()=>pending,{...details,...extra});
  call("closed",closed);
  if(prefix){const prefixRead=Promise.resolve({done:false,value:{byteLength:1}});call("read",prefixRead);call("read_observer",prefixRead.then(value=>value),{originalRead:prefixRead});await h.collectLiteLLMOperations(c.r);}
  call("read",read);const derivative=read.then(value=>value);call("read_observer",derivative,{originalRead:read});
  if(prefix){c.input.abortSequence=++c.r.sequence;c.input.callerAbortedAtAbort=true;c.input.noEarlierFailure=true;c.input.pendingAtAbort=[c.r.operations.find(op=>op.pending===read)];}
  if(cancelState!==null)call("cancel",cancelState==="rejected"?Promise.reject(cancelReason):Promise.resolve(),{argc:1,operandPresent:true,reason:cancelReason});
  if(extra)h.observeLiteLLMOperation(c.r,"wait_until",()=>Promise.reject(reason),{token:c.token});
  await h.collectLiteLLMOperations(c.r);
  c.reader.unlockInvoke=++c.r.sequence;c.reader.unlockSequence=++c.r.sequence;
  let failure;try{await h.litellmWorkerDrain(c.r,c.scope,()=>assert.fail());}catch(error){failure=error;}
  assert.ok(failure);assert.equal(failure.errors.length,c.r.operations.filter(op=>op.state!=="fulfilled").length);
  const project=()=>{const ledger=h.litellmWorkerLedger(c.r,c.scope);return JSON.parse(JSON.stringify({operations:ledger[0],syncFailures:ledger[2],checks:c.r.retireChecks.snapshot(),ledger,
    ingress:[true],inputs:[{signalAborted:true}],readers:[{unlocks:1,locked:false}]}));};
  return {...c,h,closed,read,derivative,project};
}
test("worker abort bounded pure: one through four exact originals preserve resource and reason distinctions",async()=>{
  const shapes=[{closedRejected:true,readRejected:false,cancelState:null},{closedRejected:true,readRejected:false},
    {readRejected:false,cancelState:"rejected"},{cancelState:null},{},{closedRejected:true,cancelState:null},
    {cancelState:"rejected"},{closedRejected:true,cancelState:"rejected"}];
  for(const reason of [undefined,null,{},0])for(const shape of shapes){
    const c=await workerBoundedCase({...shape,reason}),o=c.project(),n=o.ledger[11].rows.length;
    const {frames,errors}=workerRelationFrames(o,{primary:reason});assert.deepEqual(errors,[]);assert.equal(frames.length,8);
    const version=n===4?2:3,prefix=version===2?workerAbortRelationalPrefix:workerAbortRelationalPrefixV3;
    const parts=frames.map(frame=>{assert.ok(frame.startsWith(prefix));return parseWorkerAbortPart(frame.slice(prefix.length));});
    assert.ok(validateWorkerAbortGroup(parts));assert.ok(parts.every(p=>p.v===version));
    const bad=[...parts[1].data,...parts[2].data];assert.equal(bad.filter(Boolean).length,n);assert.ok(bad.slice(n).every(x=>x===null));assert.ok(bad.filter(Boolean).every(row=>row[7]===true&&row[8]===(reason!==undefined)));
    assert.deepEqual(parts[7].data.slice(0,4),[n,n,0,false]);assert.deepEqual(parts[3].data.slice(5),[true,true]);
    assert.equal(parts[3].data[3][0],3);assert.equal(parts[3].data[1][0],4);assert.equal(parts[3].data[2][0],5);
    assert.equal(parts[3].data[4]===null,shape.cancelState===null);assert.equal(parts[7].data[17],null);
    for(const reverse of [false,true]){const result=await workerAbortPipeline(workerRelationEvents(frames,reverse));assert.equal(relationRecords(result.rows).length,8);assert.equal(result.rows[0].kind,"failure");}
  }
  const c=await workerBoundedCase({closedRejected:true,cancelState:"rejected",closedReason:{},cancelReason:{}});
  const resource=c.project().ledger[8];assert.deepEqual(resource[3].slice(0,4),[true,false,false,false]);
});
test("worker abort bounded pure: every owner alias and optional original is independently required",async()=>{
  for(const mutate of [
    c=>{c.r.operations[4].input={...c.input};},c=>{c.r.operations[5].originalRead=Promise.resolve();},
    c=>{c.reader.closed=Promise.resolve();},c=>{c.r.operations[5].pending=c.read;},
    c=>{c.r.operations.push({...c.r.operations[4],ordinal:c.r.operations.length,state:"fulfilled"});},
    c=>{c.r.operations[4].token={...c.token};},c=>{c.input.token={...c.token};},
    c=>{c.r.operations[3].reader={...c.reader};},c=>{c.r.operations[6].reader={...c.reader};},
    c=>{c.r.operations[4].ordinal=0;},c=>{c.r.operations[5].token={...c.token,generation:2};},
    c=>{c.r.operations.push({...c.r.operations[6],ordinal:c.r.operations.length,pending:Promise.resolve()});},
  ]){
    const c=await workerBoundedCase();mutate(c);const {frames}=workerRelationFrames(c.project());assert.equal(frames.length,1);
    for(const reverse of [false,true]){const out=await workerAbortPipeline(workerRelationEvents(frames,reverse));assert.equal(relationRecords(out.rows).length,0);assert.equal(out.rows.some(x=>x.kind==="worker_abort"),true);}
  }
  const c=await workerBoundedCase({closedRejected:true,cancelState:"rejected",extra:true});
  assert.equal(c.project().ledger[11].coverage[0],5);assert.equal(workerRelationFrames(c.project()).frames.length,1);
});
test("worker abort bounded pure: complete census padding cross references and versions fail closed",async()=>{
  const c=await workerBoundedCase(),{frames}=workerRelationFrames(c.project());
  const parts=frames.map(f=>parseWorkerAbortPart(f.slice(workerAbortRelationalPrefixV3.length)));
  for(const mutate of [
    x=>{x[1].data[0]=null;},x=>{x[2].data[0]=x[1].data[0];},x=>{x[7].data[0]++;},x=>{x[7].data[1]--;},
    x=>{x[7].data[2]=1;},x=>{x[7].data[3]=true;},x=>{x[7].data[4]=1;},x=>{x[7].data[12]=false;},
    x=>{x[1].data[0][3]++;},x=>{x[1].data[1][4]++;},x=>{x[1].data[1][5]++;},x=>{x[1].data[1][6]++;},
    x=>{x[1].data.reverse();},x=>{x[1].data[0][0]=x[0].data[3];},x=>{x[3].data[3][0]=x[0].data[3];},
    x=>{x[3].data[1][1]=1;},x=>{x[3].data[2][4]=x[3].data[1][4];},x=>{x[3].data[5]=false;},x=>{x[3].data[6]=false;},
    x=>{x[4].data[1]=1;},x=>{x[5].data[2]=x[5].data[0];},x=>{x[0].data[4]=3;},
    x=>{x[1].data[0][7]=false;x[1].data[0][8]=null;},x=>{x[1].data[0][10]=null;},x=>{x[1].data[0][9]=0;},
    x=>{x[0].v=2;},x=>{x[6].ref[2]++;},x=>{x[3].data[4]=null;},x=>{x[5].data[1]=null;},
  ]){
    const changed=structuredClone(parts);mutate(changed);assert.equal(validateWorkerAbortGroup(changed),null);
    for(const reverse of [false,true]){const input=changed.map(p=>(p.v===2?workerAbortRelationalPrefix:workerAbortRelationalPrefixV3)+JSON.stringify(p));const out=await workerAbortPipeline(workerRelationEvents(input,reverse));assert.equal(relationRecords(out.rows).length,0);assert.equal(out.rows[0].kind,"failure");}
  }
  for(const altered of [frames.slice(1),[...frames,frames[0]],frames.map((f,i)=>i===1?f.replace('"v":3,','"v":3,"v":3,'):f)]){
    const out=await workerAbortPipeline(workerRelationEvents(altered));assert.equal(relationRecords(out.rows).length,0);assert.equal(out.rows[0].kind,"failure");
  }
});
test("worker abort bounded pure: output faults retain primary and never emit a fallback after a fragment",async()=>{
  const c=await workerBoundedCase({reason:undefined});
  for(const reportReason of [undefined,{}])for(let reportFault=0;reportFault<8;reportFault++){
    const {frames,errors}=workerRelationFrames(c.project(),{primary:undefined,reportFault,reportReason});
    assert.deepEqual(errors,[reportReason]);assert.equal(frames.length,reportFault);assert.ok(frames.every(x=>x.startsWith(workerAbortRelationalPrefixV3)));
    const out=await workerAbortPipeline(workerRelationEvents(frames));assert.equal(relationRecords(out.rows).length,0);assert.equal(out.rows[0].kind,"failure");
  }
});

test("worker abort bounded pure: native ownership canonical framing and saturated census retain only coarse failure",async()=>{
  const c=await workerBoundedCase(),{frames}=workerRelationFrames(c.project());
  const mutations=[
    e=>{delete e[0].data.parentId;},e=>{delete e[2].data.entryFile;},e=>{e[2].data.line++;},
    e=>{e[0].data.testId=0;},e=>{e.push({...e[0],data:{...e[0].data,testId:9}});},
    e=>{e[2].data.message=e[2].data.message.replace('V3 ','V2 ');},
    e=>{e[2].data.message+=' ';},e=>{e[2].data.message+='\u001b';},
    e=>{e[2].data.message=e[2].data.message.replace('"v":3,','"v":3,"v":3,');},
    e=>{e[2].data.message=workerAbortRelationalPrefixV3+'x'.repeat(513);},
    e=>{e.push(...Array.from({length:4097},(_,i)=>({...e[0],data:{...e[0].data,testId:i+100,name:"unrelated",line:i+1000}})));},
  ];
  for(const mutate of mutations){const e=workerRelationEvents(frames);mutate(e);const out=await workerAbortPipeline(e);assert.equal(relationRecords(out.rows).length,0);assert.equal(out.rows[0].kind,"failure");}
  const e=workerRelationEvents(frames);for(let i=0;i<10;i++)e.push({...e[0],data:{...e[0].data,testId:i+20,name:"unrelated",line:900}});
  assert.equal(relationRecords((await workerAbortPipeline(e)).rows).length,8);
});
test("worker abort bounded pure: maximum v3 canonical serialization keeps every existing quota",async()=>{
  const historical=await workerRelationMaximum();
  for(const count of [1,2,3,4]){
    const parts=historical.rows.filter(x=>x.kind==="worker_abort_relation").map(x=>({v:3,kind:"worker_abort_part",part:x.part,ref:x.ref,data:structuredClone(x.data)}));
    parts[0].data.push(null);
    const all=[...parts[1].data,...parts[2].data],keep=all.slice(0,count),first=keep[0];
    for(let i=0;i<4;i++){parts[i<2?1:2].data[i%2]=keep[i]??null;parts[5].data[i]=i<count?parts[5].data[i]:null;}
    parts[7].data.splice(0,3,count,count,0);parts[4].data[1]=0;
    for(const role of parts[3].data.slice(1,5))if(!keep.some(row=>row[0]===role[0])){role[1]=1;role[2]=0;}
    // Equality comparisons involving fulfilled records have no rejected reason.
    for(let i=2;i<=6;i++)parts[4].data[i]=null;
    for(const part of parts)part.ref[4]=first[0];parts[0].data[4]=first[2];
    assert.ok(validateWorkerAbortGroup(parts));
    const frames=parts.map(p=>workerAbortRelationalPrefixV3+JSON.stringify(p)),events=workerRelationEvents(frames);
    for(const event of events){event.data.line=1000000;event.data.column=1000000;event.data.nesting=1000000;}
    const out=await workerAbortPipeline(events);assert.equal(relationRecords(out.rows).length,8);
    assert.ok(out.rows.every(row=>Buffer.byteLength(JSON.stringify(row))<=512));assert.ok(out.lines.every(line=>Buffer.byteLength(line)<=768));
    assert.ok(Buffer.byteLength(out.lines.join(""))<=8192);assert.equal(out.lines.length,10);
  }
});

test("worker abort bounded repair pure: foreign cancel cannot disappear and absent cancel rejects a wire row",async()=>{
  const c=await workerBoundedCase();c.r.operations[6].input={...c.input};c.r.operations[6].reader={...c.reader};
  const {frames}=workerRelationFrames(c.project());assert.equal(frames.length,1);
  const missing=await workerBoundedCase({cancelState:null});const parts=workerRelationFrames(missing.project()).frames.map(f=>parseWorkerAbortPart(f.slice(workerAbortRelationalPrefixV3.length)));
  parts[2].data[0]=[6,7,2,1,1,1,1,true,true,20,21];parts[0].data[3]=7;parts[5].data[2]=[6,false,null,false,null,false,null];parts[7].data[0]=3;parts[7].data[1]=3;
  assert.equal(validateWorkerAbortGroup(parts),null);
  for(const reverse of [false,true]){const out=await workerAbortPipeline(workerRelationEvents(parts.map(p=>workerAbortRelationalPrefixV3+JSON.stringify(p)),reverse));assert.equal(relationRecords(out.rows).length,0);assert.equal(out.rows[0].kind,"failure");}
});
test("worker abort bounded repair pure: actual prefix plus pending read retains unique original lineage",async()=>{
  for(const shape of [{closedRejected:true,readRejected:false,cancelState:null},{readRejected:false,cancelState:"rejected"},{cancelState:null}]){
    const c=await workerBoundedCase({...shape,prefix:true}),o=c.project();
    const {frames,errors}=workerRelationFrames(o);assert.deepEqual(errors,[]);assert.equal(frames.length,8);
    const parts=frames.map(f=>parseWorkerAbortPart(f.slice(workerAbortRelationalPrefixV3.length)));
    assert.equal(parts[3].data[1][0],6);assert.equal(parts[3].data[2][0],7);assert.equal(parts[3].data[3][0],3);
    assert.equal(parts[3].data[5],true);assert.equal(parts[3].data[6],true);
    for(const reverse of [false,true])assert.equal(relationRecords((await workerAbortPipeline(workerRelationEvents(frames,reverse))).rows).length,8);
  }
  for(const mutate of [c=>{delete c.input.pendingAtAbort;},c=>{c.input.pendingAtAbort=[{...c.r.operations[6]}];},
    c=>{c.input.pendingAtAbort=[c.r.operations[4],c.r.operations[6]];},c=>{c.input.pendingAtAbort=[c.r.operations[5]];}]){
    const c=await workerBoundedCase({closedRejected:true,readRejected:false,prefix:true,cancelState:null});mutate(c);
    assert.equal(workerRelationFrames(c.project()).frames.length,1);
  }
});

function purePostludeFunctions() {
  const source=readFileSync("worker/test/litellm-model-discovery.test.mjs","utf8");
  const code=source.slice(source.indexOf("export function observeLiteLLMOperation("),source.indexOf("// END request-owned fixture functions."));
  const producer=source.slice(source.indexOf("export function litellmObserveProducer("),source.indexOf("export function upstreamFixture("));
  return new Function("assert",(code+producer).replace(/^export /gm,"")+";return {litellmRetirementSeal,litellmPostRetirement,litellmFinishRetirement,litellmPostludeUsage,litellmFailurePostlude,litellmProducerBoundary,litellmProducerOwners,litellmObserveProducer,joinLiteLLMProducer};")(assert);
}
async function postludeCase(primary=undefined) {
  const c=await workerBoundedCase(),h=purePostludeFunctions();c.r.basePath="/team/v1";c.r.ingresses=[{}];
  c.r.calls=[{method:"GET",url:"https://gateway.example/team/v1/models",authorization:"Bearer fixture-upstream-native_abort",query:"",redirect:"manual",body:false,extra:false}];
  c.reader.methods={};c.reader.wrappers={};for(const name of ["read","cancel","releaseLock"]){const fn=()=>{};c.reader.reader[name]=fn;c.reader.wrappers[name==="releaseLock"?"unlock":name]=fn;}
  c.r.requests[0].retired=false;c.scope.retire=token=>{assert.equal(token,c.token);};
  c.r.retireChecks.note(0,true);
  let thrown=false;try{h.litellmFinishRetirement(c.r,c.scope,true,primary);}catch(error){thrown=true;assert.equal(error,primary);}assert.equal(thrown,true);
  assert.equal(c.r.requests[0].retired,true);assert.equal(c.r.failurePostlude.state.valid,true);
  return {...c,post:h,primary};
}
const diagnosticUsage=()=>({events:[{provider:"litellm",policy_id:"native_abort",credential_id:"native_abort",capability:"models.list",actual_cost_micros:0,reserved_cost_micros:0,model:null,input_tokens:null,output_tokens:null,total_tokens:null}]});
const diagnosticSource=()=>({joined:[1,2,4,0],owners:[{call:0,held:true,chat:false,finished:true,eof:false,cancels:1,fulfilledCancels:1,operations:2,observers:4}],
  calls:[{method:"GET",url:"https://gateway.example/team/v1/models",authorization:"Bearer fixture-upstream-native_abort",body:null}],released:false,active:0,expired:0,canceled:1,finished:1,operations:[{kind:"pull",state:"fulfilled"},{kind:"cancel",state:"fulfilled"}]});
async function rejectedValue(fn){try{await fn();assert.fail("expected original failure");}catch(error){return error;}}
test("worker abort postlude pure: actual registered failure callback binds helper and preserves success control order",async()=>{
  const success=await abortDiagnosticCase();assert.equal(success.failed,false);
  assert.deepEqual(success.calls.filter(x=>["retire","observation","proof","usage"].includes(x)),["retire","observation","proof","usage"]);
  for(const secondary of [[],["proof"],["usage"],["proof","usage","observation","fallback_state","dispose","remove"]]){
    const result=await abortDiagnosticCase({fault:"retire",undefinedFault:true,secondary});assert.equal(result.failed,true);assert.deepEqual(result.record.first,[14,0,false]);
    assert.deepEqual(result.calls.filter(x=>["retire","proof","usage","observation","fallback_state"].includes(x)),["retire","proof","usage","observation","fallback_state"]);
    assert.ok(result.calls.includes("dispose")&&result.calls.includes("remove"));
  }
});
test("worker abort postlude pure: same retired seal guards accounting and always retains original failure",async()=>{
  for(const primary of [undefined,{}])for(const accounting of ["fulfilled","undefined","defined"]){
    const c=await postludeCase(primary),drainError={},snapshotError=accounting==="undefined"?undefined:{},calls=[];
    const error=await rejectedValue(()=>c.post.litellmPostludeUsage(c.r,async()=>{calls.push("drain");throw drainError;},async()=>{calls.push("usage");if(accounting!=="fulfilled")throw snapshotError;return diagnosticUsage();}));
    assert.deepEqual(calls,["drain","usage"]);assert.deepEqual(error.errors,[primary,drainError,...(accounting==="fulfilled"?[]:[snapshotError])]);
    const row=c.r.failurePostlude.project(true);assert.ok(decodeWorkerPostludeRouter(row));assert.equal(row[7],true);assert.equal(row[13],accounting==="fulfilled");assert.equal(row[15],accounting!=="fulfilled");
    const repeated=await rejectedValue(()=>c.post.litellmPostludeUsage(c.r,()=>assert.fail(),()=>assert.fail()));assert.equal(repeated.errors[0],primary);assert.deepEqual(calls,["drain","usage"]);
    assert.equal(c.r.retireChecks.snapshot()[0],4);assert.equal(c.r.workerDataDisposition[0],1);
  }
  const c=await postludeCase(undefined);assert.equal(await rejectedValue(()=>c.post.litellmPostludeUsage(c.r,async()=>{},async()=>diagnosticUsage())),undefined);
});
test("worker abort postlude pure: private seal rejects every original mutation permanently without native reads",async()=>{
  const mutations=[c=>c.r.sequence++,c=>{c.input.abortSequence=++c.r.sequence;},c=>c.r.operations.push({...c.r.operations[0]}),
    c=>{c.r.roots=[...c.r.roots];},c=>c.r.ingresses.push({}),c=>c.r.requests[0].retired=false,c=>{c.r.requests[0].token={...c.token};},
    c=>c.r.observerFailures.push(undefined),c=>c.r.failures.push(undefined),c=>c.r.inputs[0]={...c.input},c=>c.reader.unlocks++,
    c=>{c.r.sequence++;c.r.operations.push({});c.r.operations.pop();},c=>c.r.operations[0].state="pending",c=>c.r.basePath="/foreign",c=>Object.defineProperty(c.r.operations[0],"state",{writable:false})];
  for(const mutate of mutations){const c=await postludeCase();const before=c.r.sequence;mutate(c);let snapshots=0;
    const error=await rejectedValue(()=>c.post.litellmPostludeUsage(c.r,async()=>{},async()=>{snapshots++;}));assert.ok(error instanceof AggregateError);assert.equal(snapshots,0);assert.equal(c.r.failurePostlude.state.valid,false);
    c.r.sequence=before;assert.equal(c.r.failurePostlude.check(1),false);assert.equal(c.r.failurePostlude.project(true)[7],false);
  }
  const c=await postludeCase();let getters=0;Object.defineProperty(c.reader.body,"locked",{get(){getters++;throw undefined;}});
  assert.equal(c.r.failurePostlude.check(1),true);assert.equal(getters,0);
  const early=await workerBoundedCase();early.r.ingresses=[];early.r.basePath="/team/v1";early.reader.wrappers={};
  const owner=purePostludeFunctions().litellmPostRetirement(early.r,early.scope,undefined);assert.equal(owner.state.valid,false);
  early.r.requests[0].retired=true;assert.equal(owner.check(1),false);
});
test("worker abort postlude pure: mutations during each await deny the same cohort including rejected accounting",async()=>{
  for(const at of ["drain","snapshot","after"]){const c=await postludeCase(),calls=[];
    await rejectedValue(()=>c.post.litellmPostludeUsage(c.r,async()=>{calls.push("drain");if(at==="drain")c.r.sequence++;throw undefined;},async()=>{calls.push("snapshot");if(at==="snapshot")c.r.sequence++;throw undefined;}));
    if(at==="after")c.r.sequence++;
    assert.equal(c.r.failurePostlude.project(true)[7],false);assert.deepEqual(calls,at==="drain"?["drain"]:["drain","snapshot"]);
  }
  const c=await postludeCase();c.scope.retains=()=>{throw undefined;};
  const error=await rejectedValue(()=>c.post.litellmPostludeUsage(c.r,async()=>{throw undefined;},()=>assert.fail()));assert.equal(error.errors[0],undefined);assert.ok(error.errors.slice(1).includes(undefined));
});
test("worker abort postlude pure: original cleanup failures and undefined seal errors remain independent",async()=>{
  const c=await workerBoundedCase(),h=purePostludeFunctions();c.r.ingresses=[];c.r.requests.push({token:{},retired:false});let count=0;
  c.scope.retire=()=>{count++;throw undefined;};
  const failure=await rejectedValue(()=>h.litellmFinishRetirement(c.r,c.scope,true,undefined));assert.equal(count,2);assert.deepEqual(failure.errors,[undefined,undefined,undefined]);
  assert.equal(c.r.failurePostlude.state.valid,false);
});
test("worker abort postlude pure: failure path attempts proof usage and both observations exactly once",async()=>{
  for(const primary of [undefined,{}])for(const failed of ["none","proof","usage","observation","state","report","all"]){
    const h=purePostludeFunctions(),calls=[],evidence=workerAbortEvidence();let node; evidence.stage(14);evidence.failed(primary);
    const bad=name=>failed==="all"||failed===name;
    const f={proof(){calls.push("proof");if(bad("proof"))throw undefined;return Promise.resolve(diagnosticSource());},
      control(name){calls.push(name);if(bad(name))throw undefined;return Promise.resolve(name==="usage"?{}:{});},state(){calls.push("state");if(bad("state"))throw undefined;return Promise.resolve({});}};
    const recorder={observation(...args){if(bad("report"))throw undefined;evidence.observation(...args);},postlude(value){node=value;evidence.postlude(value);}};
    const error=await rejectedValue(()=>h.litellmFailurePostlude(primary,f,recorder));assert.deepEqual(calls,["proof","usage","observation","state"]);
    assert.equal(error instanceof AggregateError?error.errors[0]:error,primary);assert.ok(decodeWorkerPostludeNode(node));
    if(failed==="all")assert.deepEqual(error.errors,[primary,undefined,undefined,undefined,undefined,undefined,undefined]);
    if(failed==="none")assert.equal(error,primary);
  }
});
test("worker abort postlude pure: pending producer original and observer tails block postlude without forced release",async()=>{
  const h=purePostludeFunctions();for(const heldKind of ["original","observer"]){
    let resolve,done=false;const held=new Promise(r=>{resolve=r;}),calls=[];
    const r={calls:[{}],producers:[],operations:[],observers:[],observerFailures:[]},p={call:r.calls[0],request:{},held:true,chat:false};r.producers.push(p);
    h.litellmObserveProducer(r,p,"pull",()=>heldKind==="original"?held:Promise.resolve(),p,[]);
    if(heldKind==="observer"){await Promise.resolve();r.observers[1]=held;r.operations[0].guard=held;}
    const boundary=h.litellmProducerBoundary(r),proof=h.joinLiteLLMProducer(r).then(joined=>{boundary();return {joined};});
    const task=h.litellmFailurePostlude(undefined,{proof:()=>proof,control(name){calls.push(name);return {};},state:()=>({})},{observation(){},postlude(){}}).then(()=>{done=true;},()=>{done=true;});
    await Promise.resolve();await Promise.resolve();assert.equal(done,false);assert.deepEqual(calls,[]);resolve();await task;assert.equal(done,true);assert.deepEqual(calls,["usage","observation"]);
  }
  const r={calls:[{}],producers:[],operations:[],observers:[],observerFailures:[]};r.producers.push({call:r.calls[0],request:{},held:true,chat:false});
  const boundary=h.litellmProducerBoundary(r);r.calls=[...r.calls];assert.throws(boundary);
});
test("worker abort postlude pure: complete cohort traverses native admission and shared decoder in both orders",async()=>{
  for(const primary of [undefined,{}])for(const accounting of ["fulfilled","rejected"]){
    const c=await postludeCase(primary);await rejectedValue(()=>c.post.litellmPostludeUsage(c.r,async()=>{throw undefined;},async()=>{if(accounting==="rejected")throw undefined;return diagnosticUsage();}));
    const o=c.project();o.postlude=c.r.failurePostlude.project(true);
    const evidence=workerAbortEvidence();evidence.stage(14);evidence.failed(primary);evidence.observation(15,{status:"fulfilled",value:o});
    const node=[1,true,primary!==undefined,2,null,3,true,2,4,0,true,0,0];evidence.postlude(node);
    const frames=[];assert.deepEqual(evidence.report({diagnostic:f=>frames.push(f)}),[]);assert.equal(frames.length,8);
    const parts=frames.map(f=>parseWorkerAbortPart(f.slice(workerAbortRelationalPrefixV3.length)));assert.equal(workerAbortPostludeCoverage(parts),true);
    for(const reverse of [false,true])assert.equal(relationRecords((await workerAbortPipeline(workerRelationEvents(frames,reverse))).rows).length,8);
    for(const missing of [0,7]){const copy=structuredClone(parts);if(missing===0)copy[0].data[5]=null;else copy[7].data[17]=null;assert.ok(validateWorkerAbortGroup(copy));assert.equal(workerAbortPostludeCoverage(copy),false);}
    for(const change of [p=>p[0].data[5][7]=false,p=>p[0].data[5][16]=false,p=>p[7].data[17][2]=!primary,p=>p[0].data[5][3]=1,p=>p[7].data[17][8]=3]){
      const copy=structuredClone(parts);change(copy);assert.equal(workerAbortPostludeCoverage(copy),false);
      for(const reverse of [false,true])await workerAbortPipeline(workerRelationEvents(copy.map(p=>workerAbortRelationalPrefixV3+JSON.stringify(p)),reverse));
    }
  }
});
test("worker abort postlude pure: postlude schema denies malformed and hostile cohorts without getters",async()=>{
  const router=[1,63,63,100,100,true,false,true,true,3,false,3,false,false,null,true,true,0,0],node=[1,true,false,2,null,3,false,2,4,0,true,0,0];
  assert.ok(decodeWorkerPostludeRouter(router));assert.ok(decodeWorkerPostludeNode(node));let getters=0;
  for(const [decode,value]of [[decodeWorkerPostludeRouter,router],[decodeWorkerPostludeNode,node]])for(let i=0;i<value.length;i++){
    const copy=[...value];Object.defineProperty(copy,String(i),{get(){getters++;throw undefined;}});assert.equal(decode(copy),null);
    assert.equal(decode(new Proxy(copy,{get(){getters++;throw undefined;}})),null);
  }
  assert.equal(getters,0);
  for(const mutate of [r=>r[2]=64,r=>r[4]++,r=>r[10]=null,r=>r[13]=true,r=>r[14]=15,r=>r[18]=1]){const copy=[...router];mutate(copy);assert.equal(decodeWorkerPostludeRouter(copy),null);}
  for(const mutate of [n=>n[4]=false,n=>n[6]=null,n=>n[8]=3,n=>n[9]=1,n=>n[12]=1]){const copy=[...node];mutate(copy);assert.equal(decodeWorkerPostludeNode(copy),null);}
});
test("worker abort postlude pure: maximum extended cohort remains atomic within unchanged command budgets",async()=>{
  const max=1000000,historical=await workerRelationMaximum(),parts=historical.rows.filter(x=>x.kind==="worker_abort_relation").map(x=>({v:3,kind:"worker_abort_part",part:x.part,ref:x.ref,data:structuredClone(x.data)}));
  parts[4].data[1]=0;parts[0].data.push([1,63,63,max,max,true,true,true,true,3,true,2,null,true,15,false,true,0,0]);
  parts[7].data[17]=[1,true,false,2,null,3,true,max/2,max,0,true,0,0];assert.ok(validateWorkerAbortGroup(parts));
  for(const invalid of [false,true]){
    if(invalid){parts[0].data[5]=[1,63,1,max,max,true,true,false,true,3,false,3,false,false,null,true,true,max,max];parts[7].data[17]=[1,true,false,2,null,3,false,max,max,max,false,max,max];}
    assert.ok(validateWorkerAbortGroup(parts));
    const frames=parts.map(p=>workerAbortRelationalPrefixV3+JSON.stringify(p));
    for(const reverse of [false,true]){const events=workerRelationEvents(frames,reverse);for(const e of events){e.data.line=max;e.data.column=max;e.data.nesting=max;}
      const out=await workerAbortPipeline(events);assert.equal(relationRecords(out.rows).length,8);assert.equal(out.lines.length,10);
      assert.ok(out.rows.every(r=>Buffer.byteLength(JSON.stringify(r))<=512));assert.ok(out.lines.every(l=>Buffer.byteLength(l)<=768));assert.ok(Buffer.byteLength(out.lines.join(""))<=8192);
    }
  }
});

function resetSourceFunctions() {
  const source = readFileSync("worker/test/litellm-model-discovery.test.mjs", "utf8");
  const code = source.slice(source.indexOf("export function litellmOwnedH1Reset("), source.indexOf("export async function withGateway("));
  return new Function("assert", code.replace(/^export /gm, "") + ";return {litellmOwnedH1Reset,assertLiteLLMResetRetirement};")(assert);
}
function inertResetCaller(options = {}) {
  const calls = [], faults = [], responseRows = [], reason = {}, callbackReason = {};
  let endCallback, lateClose, installedFault = false;
  const emitter = label => {
    const listeners = new Map();
    return {
      on(name, fn) { if (!installedFault && options.install === label + ":" + name) { installedFault = true; throw undefined; } const rows = listeners.get(name) ?? []; rows.push(fn); listeners.set(name, rows); return this; },
      removeListener(name, fn) { const rows = listeners.get(name) ?? []; listeners.set(name, rows.filter(row => row !== fn)); if (options.removeFault && !faults.includes("remove")) { faults.push("remove"); throw undefined; } },
      emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args); },
      listenerCount() { return [...listeners.values()].reduce((n, rows) => n + rows.length, 0); },
    };
  };
  const socket = Object.assign(emitter("socket"), { connecting: true, destroyed: false });
  const request = Object.assign(emitter("request"), { socket, reusedSocket: options.reused === true });
  const response = () => {
    const value = emitter("response"); responseRows.push(value);
    value.resume = function() { calls.push(["resume", this, arguments.length]); if (options.bodyFault) throw undefined; if (!options.holdBody) { value.emit("end"); value.emit("close"); } return value; };
    value.destroy = function() { calls.push(["body_destroy", this, arguments.length]); value.emit("close"); return value; };
    return value;
  };
  const close = () => {
    if (options.socketError) socket.emit("error", undefined);
    if (!options.noRequestError) request.emit("error", reason);
    if (options.responseAtReset) request.emit("response", response());
    socket.destroyed = true;
    if (options.reverseClose) { socket.emit("close"); request.emit("close"); } else { request.emit("close"); socket.emit("close"); }
  };
  socket.resetAndDestroy = function(...args) {
    calls.push(["reset", this, args]);
    options.onReset?.({ request, socket });
    if (options.resetThrow) throw options.resetReason;
    if (options.holdClose) lateClose = close; else close();
    return options.wrongReturn ? {} : socket;
  };
  request.destroy = function(...args) {
    calls.push(["destroy", this, args]); socket.destroyed = true;
    if (Object.hasOwn(options, "cleanupError")) request.emit("error", options.cleanupError);
    request.emit("close"); socket.emit("close");
    if (options.destroyThrow) throw undefined;
    return request;
  };
  request.end = function(callback) {
    calls.push(["end", this, arguments.length]); endCallback = callback;
    request.emit("socket", socket);
    if (options.foreignSocket) request.socket = {};
    socket.connecting = false; socket.emit("connect");
    request.emit("finish");
    if (!options.holdEnd) callback(options.callbackError ? callbackReason : undefined);
    if (options.earlyError) request.emit("error", undefined);
    if (options.earlyResponse) request.emit("response", response());
    return request;
  };
  const requestOriginal = function(url, init) { "use strict"; calls.push(["request", this, url, init]); if (options.createThrow) throw undefined; return request; };
  const { litellmOwnedH1Reset } = resetSourceFunctions();
  const caller = litellmOwnedH1Reset(requestOriginal, value => value === socket, "http://fixture.example/v1/native/litellm/models", "Bearer synthetic-key");
  return { caller, socket, request, calls, reason, callbackReason, responses: responseRows, end: () => endCallback(), close: () => lateClose(), response };
}
async function captureReset(fn) { try { return { fulfilled: true, value: await fn() }; } catch (error) { return { fulfilled: false, error }; } }

test("owned HTTP/1 reset pure: exact original identities and close order", async () => {
  for (const reverseClose of [false, true]) {
    const c = inertResetCaller({ reverseClose }); assert.equal(c.caller.start(), c.request); await c.caller.ready();
    assert.equal(c.caller.reset(), c.socket); await c.caller.join(); assert.deepEqual(await c.caller.close(), []);
    assert.deepEqual(c.calls.map(row => row[0]), ["request", "end", "reset"]);
    assert.equal(c.calls[0][1], undefined); assert.deepEqual(c.calls[0][3], { method: "GET", agent: false, headers: { authorization: "Bearer synthetic-key" } });
    assert.equal(c.calls[1][1], c.request); assert.equal(c.calls[1][2], 1);
    assert.equal(c.calls[2][1], c.socket); assert.deepEqual(c.calls[2][2], []);
    assert.equal(c.request.listenerCount(), 0); assert.equal(c.socket.listenerCount(), 0);
  }
});
test("owned HTTP/1 reset pure: held callbacks and original close remain joined", async () => {
  const c = inertResetCaller({ holdEnd: true, holdClose: true }); c.caller.start();
  let ready = false, joined = false; const before = c.caller.ready().then(() => { ready = true; });
  await Promise.resolve(); assert.equal(ready, false); c.end(); await before;
  c.caller.reset(); const after = c.caller.join().then(() => { joined = true; });
  await Promise.resolve(); assert.equal(joined, false); c.close(); await after;
  assert.deepEqual(await c.caller.close(), []);
});
test("owned HTTP/1 reset pure: original undefined failures never retry reset", async () => {
  for (const options of [{ createThrow: true }, { resetThrow: true }, { resetThrow: true, destroyThrow: true }, { earlyError: true }, { callbackError: true }, { socketError: true }, { reused: true }, { foreignSocket: true }, { wrongReturn: true }, { install: "request:finish" }, { removeFault: true }]) {
    const c = inertResetCaller(options);
    const result = await captureReset(async () => { c.caller.start(); await c.caller.ready(); c.caller.reset(); await c.caller.join(); });
    const cleanup = await c.caller.close();
    assert.ok(!result.fulfilled || cleanup.length > 0, JSON.stringify(options));
    assert.ok(c.calls.filter(row => row[0] === "reset").length <= 1);
    assert.ok(c.calls.filter(row => row[0] === "destroy").length <= 1);
    if (options.resetThrow || options.createThrow || options.earlyError) assert.equal(result.error, undefined);
    if (options.callbackError) assert.equal(result.error, c.callbackReason);
    if (options.destroyThrow || options.removeFault) assert.ok(cleanup.includes(undefined));
  }
});
test("owned HTTP/1 reset pure: duplicate methods and premature or late responses fail with body cleanup", async () => {
  for (const options of [{ earlyResponse: true }, { responseAtReset: true }, { responseAtReset: true, bodyFault: true }, { earlyResponse: true, holdBody: true }]) {
    const c = inertResetCaller(options);
    const result = await captureReset(async () => { c.caller.start(); await c.caller.ready(); c.caller.reset(); await c.caller.join(); });
    await c.caller.close(); assert.equal(result.fulfilled, false);
    assert.equal(c.responses.length, 1); assert.equal(c.responses[0].listenerCount(), 0);
    assert.equal(c.calls.filter(row => row[0] === "resume").length, 1);
    assert.ok(c.calls.filter(row => row[0] === "body_destroy").length <= 1);
  }
  const c = inertResetCaller(); c.caller.start(); await c.caller.ready(); c.caller.reset();
  assert.equal((await captureReset(() => c.caller.reset())).fulfilled, false);
  assert.equal(c.calls.filter(row => row[0] === "reset").length, 1); await c.caller.close();
});
function resetReadiness() {
  const source = readFileSync("worker/test/litellm-model-discovery.test.mjs", "utf8");
  const code = source.slice(source.indexOf("export function litellmRequestScope("), source.indexOf("export function litellmWorkerResource("));
  const { litellmRequestScope, litellmHeldReady } = new Function(code.replace(/^export /gm, "") + ";return {litellmRequestScope,litellmHeldReady};")();
  let current; const scope = litellmRequestScope({ getStore: () => current, run(token, fn) { const before = current; current = token; try { return fn(); } finally { current = before; } } }, 1);
  const r = { mode: "held", failures: [], observerFailures: [], operations: [], requests: [], inputs: [], readers: [] }, request = { signal: { aborted: false } };
  const token = scope.register(request, r), body = { locked: true }, response = { body }, handle = {};
  const input = scope.invoke(token, () => scope.transport(r, { aborted: false }), undefined, [request]);
  scope.response(input, response); scope.reader(input, body, handle);
  const reader = { transport: input, body, reader: handle, eof: false, unlocks: 0 }, pending = {};
  r.requests.push({ request, token }); r.inputs.push(input); r.readers.push(reader);
  r.operations.push({ kind: "handler", token, state: "pending" }, { kind: "fetch", transport: input, state: "fulfilled", pending, value: response },
    { kind: "acquisition_observer", input, state: "fulfilled", originalFetch: pending },
    { kind: "read", reader, input, receiverIdentity: true, state: "fulfilled", value: { done: false, value: { byteLength: 1 } }, settle: 4 },
    { kind: "read", reader, input, receiverIdentity: true, state: "pending", invoke: 5 });
  return { r, request, input, reader, ready: () => litellmHeldReady(r, scope) };
}
test("owned HTTP/1 reset pure: arrival alone cannot satisfy original Worker readiness", () => {
  assert.equal(resetReadiness().ready(), true);
  const mutations = [c => { c.r.operations[4].state = "fulfilled"; }, c => { c.r.operations[0].state = "fulfilled"; }, c => { c.request.signal.aborted = true; }, c => { c.input.signal.aborted = true; },
    c => { c.r.requests.push({ ...c.r.requests[0] }); }, c => { c.r.operations[2].originalFetch = {}; }, c => { c.r.operations[3].value.value.byteLength = 0; },
    c => { c.r.operations[3].settle = 6; }, c => { c.reader.eof = true; }, c => { c.reader.unlocks = 1; }, c => { c.r.failures.push(undefined); },
    c => { c.r.observerFailures.push(undefined); }, c => { c.r.requests[0].retired = true; }, c => { c.reader.reader = {}; }, c => { c.r.inputs.push(c.input); }];
  for (const mutate of mutations) { const c = resetReadiness(); mutate(c); assert.equal(c.ready(), false); }
});
function resetRemoteFacts() {
  const call = { method: "GET", url: "https://gateway.example/team/v1/models", authorization: "Bearer fixture-upstream-native_abort", body: null };
  const proof = { retired: true, unlocked: true, operations: [{ state: "fulfilled" }], calls: [{ ...call, body: false, query: "", extra: false, redirect: "manual" }] };
  const observed = { syncFailures: 0, ingress: [true], inputs: [{ signalAborted: true }], readers: [{ unlocks: 1, locked: false }] };
  const source = { released: false, active: 0, expired: 0, canceled: 1, finished: 1, calls: [call], operations: [{ kind: "pull", state: "fulfilled" }, { kind: "cancel", state: "fulfilled" }],
    owners: [{ call: 0, held: true, chat: false, finished: true, eof: false, cancels: 1, fulfilledCancels: 1, operations: 2, observers: 4 }], joined: [1, 2, 4, 0] };
  const usage = { events: [{ provider: "litellm", policy_id: "native_abort", credential_id: "native_abort", capability: "models.list", model: null, actual_cost_micros: 0, reserved_cost_micros: 0, input_tokens: null, output_tokens: null, total_tokens: null }] };
  return { proof, observed, source, usage };
}
test("owned HTTP/1 reset pure: local close cannot replace remote signal producer joins or accounting", () => {
  const { assertLiteLLMResetRetirement: check } = resetSourceFunctions(); const invoke = c => check(c.proof, c.observed, c.source, c.usage);
  invoke(resetRemoteFacts());
  const mutations = [c => { c.observed.ingress[0] = false; }, c => { c.observed.inputs[0].signalAborted = false; }, c => { c.observed.ingress.push(true); },
    c => { c.proof.operations[0].state = "rejected"; }, c => { c.proof.unlocked = false; }, c => { c.observed.readers[0].unlocks = 2; }, c => { c.observed.readers[0].locked = true; },
    c => { c.source.expired = 1; }, c => { c.source.active = 1; }, c => { c.source.released = true; }, c => { c.source.owners[0].call = 1; }, c => { c.source.owners[0].eof = true; },
    c => { c.source.owners[0].fulfilledCancels = 0; }, c => { c.source.joined[2] = 3; }, c => { c.source.joined[3] = 1; }, c => { c.source.operations[1].state = "pending"; },
    c => { c.source.operations[1].state = "rejected"; }, c => { c.source.calls.push({ ...c.source.calls[0] }); }, c => { c.proof.calls[0].authorization = "foreign"; },
    c => { c.usage.events[0].actual_cost_micros = 7; }, c => { c.usage.events[0].policy_id = "foreign"; }, c => { c.usage.events[0].total_tokens = undefined; }];
  for (const mutate of mutations) { const c = resetRemoteFacts(); mutate(c); assert.throws(() => invoke(c)); }
});

test("owned HTTP/1 reset pure: producer proof joins original and attached observer tails with exact owners", async () => {
  const source = readFileSync("worker/test/litellm-model-discovery.test.mjs", "utf8");
  const code = source.slice(source.indexOf("export function litellmObserveProducer("), source.indexOf("export function upstreamFixture("));
  const { litellmObserveProducer, litellmProducerOwners, joinLiteLLMProducer } = new Function(code.replace(/^export /gm, "") + ";return {litellmObserveProducer,litellmProducerOwners,joinLiteLLMProducer};")();
  const call = {}, producer = { call, held: true, chat: false, finished: true, eof: false };
  const r = { calls: [call], producers: [producer], operations: [], observers: [], observerFailures: [] };
  let finish; const held = new Promise(resolve => { finish = resolve; }), receiver = {};
  assert.equal(litellmObserveProducer(r, producer, "pull", function() { assert.equal(this, receiver); return held; }, receiver, []), held);
  const cancel = Promise.resolve(); assert.equal(litellmObserveProducer(r, producer, "cancel", () => cancel, receiver, []), cancel);
  let completed = false; const joined = joinLiteLLMProducer(r).then(value => { completed = true; return value; });
  await Promise.resolve(); assert.equal(completed, false); finish(); assert.deepEqual(await joined, [1, 2, 4, 0]);
  assert.deepEqual(litellmProducerOwners(r), [{ call: 0, held: true, chat: false, finished: true, eof: false, cancels: 1, fulfilledCancels: 1, operations: 2, observers: 4 }]);
  r.operations[1].producer = { ...producer }; assert.throws(() => litellmProducerOwners(r));
});
test("owned HTTP/1 reset pure: restoration late failures and primary undefined stay independent", async () => {
  const c = inertResetCaller({ holdClose: true, removeFault: true }); c.caller.start(); await c.caller.ready(); c.caller.reset();
  const original = {}; c.socket.emit("error", original); c.close();
  const failed = await captureReset(() => c.caller.join()); assert.ok(failed.error instanceof AggregateError);
  assert.deepEqual(failed.error.errors, [original, c.reason]);
  assert.deepEqual(await c.caller.close(), [undefined]);
  const r = await abortDiagnosticCase({ fault: "retire", undefinedFault: true, secondary: ["caller_cleanup", "dispose", "remove"], reportingFault: true });
  assert.equal(r.failed, true);
  const leaves = value => { const own = Object.getOwnPropertyDescriptor(value ?? {}, "errors"); return own && Array.isArray(own.value) ? own.value.flatMap(leaves) : [value]; };
  assert.ok(leaves(r.error).filter(value => value === undefined).length >= 5);
  assert.ok(r.calls.includes("caller_cleanup") && r.calls.includes("dispose") && r.calls.includes("remove"));
});
test("owned HTTP/1 reset pure: actual module bindings target name and unchanged shared caller are present", () => {
  const source = readFileSync("worker/test/litellm-model-discovery.test.mjs", "utf8"), reporter = readFileSync("scripts/worker-test-failure-reporter.mjs", "utf8");
  assert.ok(source.includes('import { request as httpRequest } from "node:http";'));
  assert.ok(source.includes('import { Socket } from "node:net";'));
  const name = "owned HTTP/1 reset propagates real metadata ingress cancellation and strict retirement";
  assert.equal(source.split('test("' + name + '"').length - 1, 1); assert.ok(reporter.includes('const targetName = "' + name + '"'));
  for (const binding of ["litellmOwnedH1Reset", "assertLiteLLMResetRetirement"]) assert.ok(source.includes("export function " + binding + "("));
  assert.ok(source.includes('call: (id, path = "/v1/native/litellm/models", init = {}) => fetch(origin + path, { ...init, headers: { authorization: "Bearer " + key(id), ...init.headers } })'));
  const target = source.slice(source.indexOf('test("' + name), source.indexOf('test("shipping 30000ms'));
  assert.ok(target.indexOf('await f.started("native_abort")') < target.indexOf('f.control("started", "native_abort")'));
  assert.ok(target.indexOf('f.control("started", "native_abort")') < target.indexOf('caller.reset()'));
  assert.ok(target.indexOf('f.proof("native_abort")') < target.indexOf('f.control("usage", "native_abort")'));
  assert.ok(!target.includes("controller.abort") && !target.includes("f.release("));
});

test("owned HTTP/1 reset repair pure: every pre-reset failure permanently denies the native call", async () => {
  for (const reason of [undefined, {}]) for (const phase of ["before-ready", "during-readiness", "after-ready", "delivered-history"]) for (const channel of ["request", "socket"]) {
    const c = inertResetCaller({ holdEnd: phase === "during-readiness" }); c.caller.start();
    let observed;
    if (phase === "during-readiness") {
      const waiting = captureReset(() => c.caller.ready()); c[channel].emit("error", reason); observed = await waiting; c.end();
    } else if (phase === "before-ready") {
      c[channel].emit("error", reason); observed = await captureReset(() => c.caller.ready());
    } else {
      await c.caller.ready(); c[channel].emit("error", reason);
      if (phase === "delivered-history") observed = await captureReset(() => c.caller.ready());
    }
    const denied = await captureReset(() => c.caller.reset());
    assert.equal(denied.fulfilled, false, phase); assert.equal(c.calls.filter(row => row[0] === "reset").length, 0, phase);
    assert.equal(observed ? observed.error : denied.error, reason);
    assert.equal((await captureReset(() => c.caller.reset())).fulfilled, false);
    assert.equal(c.calls.filter(row => row[0] === "reset").length, 0);
    await c.caller.close();
  }
});
test("owned HTTP/1 reset repair pure: original reset throw retains reentrant late and cleanup errors independently", async () => {
  for (const resetReason of [undefined, {}]) for (const requestReason of [undefined, {}]) for (const late of [undefined, {}]) for (const cleanup of [undefined, {}]) {
    const c = inertResetCaller({ resetThrow: true, resetReason, cleanupError: cleanup, onReset({ request }) { request.emit("error", requestReason); } });
    c.caller.start(); await c.caller.ready();
    const result = await captureReset(() => c.caller.reset()); assert.equal(result.fulfilled, false);
    assert.ok(result.error instanceof AggregateError);
    assert.deepEqual(result.error.errors, [resetReason, requestReason]);
    c.request.emit("error", late); const rest = await c.caller.close(); assert.deepEqual(rest, [late, cleanup]);
    assert.equal(c.calls.filter(row => row[0] === "reset").length, 1);
  }
  const same = {}, c = inertResetCaller({ resetThrow: true, onReset({ request }) { request.emit("error", same); request.emit("error", same); } });
  c.caller.start(); await c.caller.ready(); const result = await captureReset(() => c.caller.reset());
  assert.deepEqual(result.error.errors, [undefined, same, same]); await c.caller.close();
});
test("owned HTTP/1 reset repair pure: successful return admits only the first bound pre-close termination", async () => {
  for (const phase of ["during", "after-return"]) for (const reason of [undefined, {}]) {
    const c = inertResetCaller({ noRequestError: true, holdClose: phase === "after-return", onReset: phase === "during" ? ({ request }) => request.emit("error", reason) : undefined });
    c.caller.start(); await c.caller.ready(); assert.equal(c.caller.reset(), c.socket);
    if (phase === "after-return") { c.request.emit("error", reason); c.close(); }
    await c.caller.join(); assert.deepEqual(await c.caller.close(), []);
  }
  for (const failure of ["wrong-return", "foreign-socket", "duplicate", "after-close", "after-socket-close", "cleanup"]) for (const reason of [undefined, {}]) {
    const options = { noRequestError: true, wrongReturn: failure === "wrong-return", holdClose: failure === "cleanup" || failure === "after-socket-close" };
    if (["wrong-return", "foreign-socket", "duplicate"].includes(failure)) options.onReset = ({ request }) => {
      if (failure === "foreign-socket") request.socket = {};
      request.emit("error", reason); if (failure === "duplicate") request.emit("error", reason);
    };
    if (failure === "cleanup") options.cleanupError = reason;
    const c = inertResetCaller(options); c.caller.start(); await c.caller.ready();
    const result = await captureReset(() => c.caller.reset());
    if (failure === "after-close") c.request.emit("error", reason);
    if (failure === "after-socket-close") { c.socket.emit("close"); c.request.emit("error", reason); c.request.emit("close"); }
    let joined;
    if (result.fulfilled && failure !== "cleanup") joined = await captureReset(() => c.caller.join());
    const rest = await c.caller.close();
    const leaves = value => { const descriptor = Object.getOwnPropertyDescriptor(value ?? {}, "errors"); return Array.isArray(descriptor?.value) ? descriptor.value.flatMap(leaves) : [value]; };
    const original = [...(!result.fulfilled ? leaves(result.error) : []), ...(joined && !joined.fulfilled ? leaves(joined.error) : []), ...rest];
    assert.ok(original.some(value => Object.is(value, reason)), failure);
    assert.ok(!result.fulfilled || joined?.fulfilled === false || rest.length > 0, failure);
    assert.equal(c.calls.filter(row => row[0] === "reset").length, 1);
  }
});
// Inert promises and plain resource objects exercise the actual private owners.
function nativeTypedFunctions(source = readFileSync("worker/test/litellm-model-discovery.test.mjs", "utf8")) {
  const functions = source.slice(source.indexOf("export function observeLiteLLMOperation("), source.indexOf("// END request-owned fixture functions."));
  const outer = source.slice(source.indexOf("export function assertLiteLLMResetRetirement("), source.indexOf("export async function withGateway("));
  return new Function("assert", (functions + outer).replace(/^export /gm, "") + ";return {observeLiteLLMOperation,collectLiteLLMOperations,litellmRequestScope,litellmPredicateFacts,litellmWorkerDrain,litellmFinishRetirement,assertLiteLLMResetRetirement,nativeUsage:typeof litellmNativeUsage==='function'?litellmNativeUsage:null};")(assert);
}
async function nativeTypedCase({ healthy = false, helpers = nativeTypedFunctions() } = {}) {
  const h = helpers, r = { id: "native_abort", mode: "held", basePath: "/team/v1", sequence: 0, operations: [], roots: [], inputs: [], readers: [], bodies: [], requests: [], ingresses: [], failures: [], observerFailures: [], calls: [] };
  let current;
  const scope = h.litellmRequestScope({ getStore: () => current, run(token, fn) { const prior = current; current = token; try { return fn(); } finally { current = prior; } } }, 17);
  const signal = { aborted: false, reason: {} }, request = { signal: { aborted: false } }, token = scope.register(request, r);
  r.ingresses.push(request.signal);
  let input; const handler = scope.invoke(token, () => { input = scope.transport(r, signal); return Promise.resolve(); }, {}, [request]);
  r.requests.push({ token, request, ingress: request.signal, promise: handler, retired: false }); r.inputs.push(input);
  h.observeLiteLLMOperation(r, "handler", () => handler, { token });
  const body = { locked: true }, response = { body }, originalReader = {};
  const fetch = h.observeLiteLLMOperation(r, "fetch", () => Promise.resolve(response), { transport: input });
  const acquisition = fetch.then(value => { assert.equal(scope.response(input, value), body); input.response = value; });
  h.observeLiteLLMOperation(r, "acquisition_observer", () => acquisition, { input, originalFetch: fetch });
  await h.collectLiteLLMOperations(r);
  scope.body(input, body); const reader = { id: scope.reader(input, body, originalReader), reader: originalReader, body, response, transport: input, bound: true, unlocks: 0, eof: false, methods: {}, wrappers: {} };
  for (const [name, key] of [["read", "read"], ["cancel", "cancel"], ["releaseLock", "unlock"]]) { reader.methods[key] = () => {}; reader.wrappers[key] = () => {}; originalReader[name] = reader.wrappers[key]; }
  Object.freeze(reader.methods); Object.freeze(reader.wrappers);
  r.readers.push(reader); r.bodies.push(body);
  let close, reject, fulfill;
  reader.closed = new Promise(resolve => { close = resolve; });
  const details = { input, reader, signal, receiver: originalReader, receiverIdentity: true, originalMethod: reader.methods.read, signalAborted: false };
  const invoke = (kind, promise, more = {}) => h.observeLiteLLMOperation(r, kind, () => promise, { ...details, ...more });
  invoke("closed", reader.closed);
  const prefix = Promise.resolve({ done: false, value: { byteLength: 1 } });
  invoke("read", prefix); const prefixQ = prefix.then(value => value); invoke("read_observer", prefixQ, { originalRead: prefix });
  await prefixQ; await Promise.resolve();
  const p = new Promise((yes, no) => { fulfill = yes; reject = no; }); invoke("read", p);
  const read = r.operations.at(-1), q = p.then(value => value); invoke("read_observer", q, { originalRead: p }); const observer = r.operations.at(-1);
  signal.aborted = true; request.signal.aborted = true;
  input.abortSequence = ++r.sequence; input.callerAbortedAtAbort = true; input.noEarlierFailure = true; input.pendingAtAbort = [read];
  scope.operation(input, originalReader, originalReader, "cancel");
  const operand = signal.reason; close();
  invoke("cancel", Promise.resolve(), { originalMethod: reader.methods.cancel, signalAborted: true, argc: 1, operandPresent: true, reason: operand });
  const cancel = r.operations.at(-1), error = {};
  if (healthy) fulfill({ done: false, value: { byteLength: 1 } }); else reject(error);
  await h.collectLiteLLMOperations(r);
  reader.unlockInvoke = ++r.sequence; scope.operation(input, originalReader, originalReader, "unlock"); body.locked = false;
  reader.unlocks = 1; reader.unlockSequence = ++r.sequence; reader.unlockReceiver = true;
  r.calls.push({ method: "GET", url: "https://gateway.example/team/v1/models", authorization: "Bearer fixture-upstream-native_abort", query: "", redirect: "manual", body: false, extra: false });
  r.retireChecks = h.litellmPredicateFacts(); r.retireChecks.note(0, true);
  const drain = () => h.litellmWorkerDrain(r, scope, () => assert.fail("native drain must not request producer proof"));
  return { h, r, scope, token, request, input, reader, read, observer, cancel, error, operand, p, q, drain };
}
async function nativeTypedRetired(c) {
  const result = await c.drain(); c.h.litellmFinishRetirement(c.r, c.scope, false);
  const remote = resetRemoteFacts();
  remote.proof.operations = c.r.operations.map(op => ({ kind: op.kind, state: op.state }));
  remote.proof.dataDisposition = c.r.workerDataDisposition; remote.proof.readOutcome = result.readOutcome;
  remote.observed.readOutcome = result.readOutcome;
  return { result, remote };
}
test("native typed read pure: owned pair remains rejected while healthy fulfillment is unchanged", async () => {
  for (const healthy of [false, true]) {
    const c = await nativeTypedCase({ healthy }), { result, remote } = await nativeTypedRetired(c);
    c.h.assertLiteLLMResetRetirement(remote.proof, remote.observed, remote.source, remote.usage);
    assert.deepEqual(c.r.workerDataDisposition, healthy ? [0, 0, 0] : [2, 2, 0]);
    if (!healthy) {
      assert.deepEqual(c.r.retireChecks.snapshot().slice(0, 4), [4, 127, 111, 16]);
      assert.equal(c.read.error, c.error); assert.equal(c.observer.error, c.error); assert.notEqual(c.error, c.operand);
      assert.equal(c.read.pending, c.p); assert.equal(c.observer.pending, c.q); assert.equal(c.cancel.reason, c.operand);
      assert.deepEqual([c.read.state, c.observer.state], ["rejected", "rejected"]); assert.equal(result.valid(), true);
      assert.equal(await c.drain(), result); assert.equal(await c.drain(), result);
      assert.equal(await c.h.nativeUsage(c.r, async () => remote.usage), remote.usage);
    }
  }
});
test("native typed read pure: incomplete foreign aliased or faulty originals remain fatal", async () => {
  const changes = {
    third: c => { c.r.operations[0].state = "rejected"; c.r.operations[0].error = c.error; },
    undefined: c => { c.read.error = c.observer.error = undefined; }, null: c => { c.read.error = c.observer.error = null; }, different: c => { c.observer.error = {}; },
    missingError: c => { delete c.read.error; }, missingP: c => { delete c.read.pending; }, foreignQ: c => { c.observer.originalRead = {}; },
    samePromise: c => { c.observer.pending = c.p; }, foreignC0: c => { c.reader.closed = {}; },
    rejectedC0: c => { c.r.operations.find(op => op.kind === "closed").state = "rejected"; },
    rejectedCancel: c => { c.cancel.state = "rejected"; }, cancelArgs: c => { c.cancel.argc = 0; }, missingOperand: c => { delete c.cancel.reason; },
    duplicateCancel: c => { c.r.operations.push({ ...c.cancel, ordinal: c.r.operations.length }); },
    foreignIngress: c => { c.r.ingresses[0] = {}; }, foreignInput: c => { c.read.input = { ...c.input }; }, foreignReader: c => { c.observer.reader = { ...c.reader }; },
    foreignResponse: c => { c.reader.response = {}; }, foreignBody: c => { c.reader.body = { locked: false }; },
    foreignToken: c => { c.r.inputs[0] = { ...c.input, token: { ...c.token } }; }, wrongGeneration: c => { c.r.requests[0].token = { ...c.token, generation: 18 }; },
    foreignMethod: c => { c.cancel.originalMethod = () => {}; }, foreignReceiver: c => { c.read.receiver = {}; }, foreignSignal: c => { c.read.signal = {}; },
    lateAlias: c => { c.r.operations.push({ kind: "fetch", state: "fulfilled", pending: c.p, ordinal: c.r.operations.length }); },
    originalAlias: c => { c.r.operations[0].originalRead = c.p; }, excludedAlias: c => { c.r.operations[0].originalFetch = c.q; },
    pending: c => { c.r.operations[0].state = "pending"; }, sync: c => { c.r.failures.push(undefined); }, observer: c => { c.r.observerFailures.push(undefined); },
    caller: c => { c.input.callerAbortedAtAbort = false; }, notPendingAtAbort: c => { c.input.pendingAtAbort = []; }, earlier: c => { c.input.noEarlierFailure = false; },
    noAbort: c => { delete c.input.abortSequence; }, wrongAbortOrder: c => { c.input.abortSequence = c.read.settle; }, noEffectiveAbort: c => { c.read.abortedAtSettle = false; },
    alreadyAborted: c => { c.read.signalAborted = true; }, prefix: c => { c.r.operations.find(op => op.kind === "read" && op.state === "fulfilled").value.value.byteLength = 0; },
    earlyUnlock: c => { c.reader.unlockInvoke = c.read.settle; }, doubleUnlock: c => { c.reader.unlocks = 2; }, locked: c => { c.reader.body.locked = true; }, eof: c => { c.reader.eof = true; },
    foreignCall: c => { c.r.calls[0].authorization = "foreign"; }, wrongRole: c => { c.r.id = "other"; }, retired: c => { c.scope.retire(c.token); c.r.requests[0].retired = true; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const c = await nativeTypedCase(); change(c);
    try { await assert.rejects(c.drain, name); assert.equal(c.r.localRetirement, undefined, name); } catch (error) { error.caseName = name; throw error; }
  }
});
test("native typed read pure: held original and attached tails block initial admission", async () => {
  for (const kind of ["original", "observer"]) {
    const c = await nativeTypedCase(); let release; const held = new Promise(resolve => { release = resolve; });
    if (kind === "original") c.h.observeLiteLLMOperation(c.r, "wait_until", () => held, { token: c.token }); else c.r.roots.push(held);
    let done = false; const pending = c.drain().then(value => { done = true; return value; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(done, false); release();
    const result = await pending; c.h.litellmFinishRetirement(c.r, c.scope, false); assert.equal(result.valid(), true);
  }
});
test("native typed read pure: token retirement permits one transition and permanently denies later mutations", async () => {
  const changes = [c => { c.r.sequence++; }, c => { c.r.operations.push({ state: "fulfilled" }); }, c => { c.r.roots = [...c.r.roots]; },
    c => { c.r.ingresses = [...c.r.ingresses]; }, c => { c.r.requests[0].retired = false; }, c => { c.input.pendingAtAbort.push(c.read); },
    c => { c.r.failures.push(undefined); }, c => { c.r.observerFailures.push(undefined); }, c => { c.r.operations[0].originalRead = c.p; },
    c => { c.reader.reader.cancel = () => {}; }, c => { c.r.requests[0].token = { ...c.token }; }];
  for (const change of changes) {
    const c = await nativeTypedCase(), { result } = await nativeTypedRetired(c); change(c);
    assert.equal(result.valid(), false); await assert.rejects(c.drain); assert.equal(result.valid(), false);
  }
  const before = await nativeTypedCase(); await before.drain(); before.r.requests[0].retired = true;
  assert.throws(() => before.h.litellmFinishRetirement(before.r, before.scope, false));
  const c = await nativeTypedCase(), { result } = await nativeTypedRetired(c);
  assert.throws(() => c.h.litellmFinishRetirement(c.r, c.scope, false)); assert.equal(result.valid(), false);
});
test("native typed read pure: accounting await cannot hide undefined failure or seal mutation", async () => {
  const c = await nativeTypedCase(); await nativeTypedRetired(c);
  const original = await rejectedValue(() => c.h.nativeUsage(c.r, async () => { throw undefined; })); assert.equal(original, undefined);
  const both = await rejectedValue(() => c.h.nativeUsage(c.r, async () => { c.r.sequence++; throw undefined; }));
  assert.equal(both.errors.length, 2); assert.equal(both.errors[0], undefined);
  let calls = 0; await assert.rejects(() => c.h.nativeUsage(c.r, async () => { calls++; })); assert.equal(calls, 0);
});
test("native typed read pure: actual outer producer and accounting gates stay independent", async () => {
  const changes = [c => { c.source.joined = null; }, c => { c.source.joined[2]--; }, c => { c.source.joined[3]++; },
    c => { c.source.operations[1].state = "pending"; }, c => { c.source.operations[1].state = "rejected"; }, c => { c.source.owners[0].call = 7; },
    c => { c.source.owners[0].fulfilledCancels = 0; }, c => { c.source.owners[0].cancels = 2; }, c => { c.source.expired = 1; },
    c => { c.source.active = 1; }, c => { c.source.released = true; }, c => { c.source.calls.push(c.source.calls[0]); },
    c => { c.usage = null; }, c => { c.usage.events = []; }, c => { c.usage.events[0].actual_cost_micros = 7; },
    c => { c.usage.events[0].policy_id = "foreign"; }, c => { c.usage.events[0].reserved_cost_micros = 7; }, c => { c.observed.ingress[0] = false; },
    c => { c.observed.inputs[0].signalAborted = false; }, c => { c.proof.readOutcome.operations[0]++; }, c => { c.observed.readOutcome = null; }];
  for (const change of changes) {
    const c = await nativeTypedCase(), { remote } = await nativeTypedRetired(c), projected = structuredClone(remote); change(projected);
    assert.throws(() => c.h.assertLiteLLMResetRetirement(projected.proof, projected.observed, projected.source, projected.usage));
  }
  for (const fault of ["proof", "usage", "remote_assertions"]) { const c = await abortDiagnosticCase({ fault, undefinedFault: true }); assert.equal(c.failed, true); }
  const healthy = await abortDiagnosticCase(); assert.equal(healthy.failed, false);
  assert.deepEqual(healthy.calls.filter(name => ["retire", "observation", "proof", "usage"].includes(name)), ["retire", "observation", "proof", "usage"]);
});
// END worker abort diagnostic pure tests.
// These children start independent native runners, not nested IPC test workers.
const { NODE_TEST_CONTEXT: _context, ...childEnv } = process.env;
let scratch;
before(async () => { scratch = await mkdtemp(join(tmpdir(), "worker-reporter-controls-")); });
after(async () => { await rm(scratch, { recursive: true, force: true }); });

async function fixture(source, tracked = true, file = "worker/test/control.test.mjs") {
  const cwd = await mkdtemp(join(scratch, "case-"));
  await mkdir(dirname(join(cwd, file)), { recursive: true });
  await writeFile(join(cwd, file), source);
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "--quiet");
  if (tracked) git("add", "--", file);
  return { cwd, file, args: ["--test", `--test-reporter=${reporter}`, "--test-reporter-destination=stdout", file] };
}

function records(text) {
  assert.equal(text.includes(marker), false, "reporter leaked the synthetic private marker");
  assert.ok(Buffer.byteLength(text) <= 8192, "execution output exceeded the quota");
  const lines = text.trimEnd().split("\n");
  assert.ok(lines.length <= 10);
  return lines.map(line => {
    assert.ok(Buffer.byteLength(line + "\n") <= 768);
    assert.match(line, /^::(?:error|notice) title=Worker test identity::/);
    const json = line.slice(line.indexOf("::", 2) + 2).replaceAll("%0A", "\n").replaceAll("%0D", "\r").replaceAll("%25", "%");
    const row = JSON.parse(json);
    assert.equal(row.v, 1);
    assert.deepEqual(Object.keys(row).sort(), (row.kind === "failure"
      ? ["v", "kind", "file", "line", "failureType", "errorClass", "code"]
      : ["v", "kind", "failureEvents", "reported", "omittedEvents", "unknownFiles", "countsSaturated"]).sort());
    return row;
  });
}

function run(f) {
  const result = spawnSync(process.execPath, f.args, { cwd: f.cwd, env: childEnv, encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
  assert.equal(result.error === undefined, true, "native child did not complete normally");
  assert.equal(result.signal, null);
  return { status: result.status, rows: records(result.stdout) };
}

const prelude = "import test from 'node:test'; import assert from 'node:assert/strict';\n";
test("native success emits no error annotation and leaves the actual exit successful", async () => {
  const f = await fixture(prelude + `test('${marker}',()=>{console.log('${marker}');console.error('${marker}');assert.equal(1,1);});`);
  const result = run(f);
  assert.equal(result.status, 0);
  assert.deepEqual(result.rows, [{ v: 1, kind: "summary", failureEvents: 0, reported: 0, omittedEvents: 0, unknownFiles: 0, countsSaturated: false }]);
});

for (const [name, body] of [
  ["assertion", `assert.equal(1,2,'${marker}')`],
  ["undefined", "throw undefined"],
  ["aggregate", `throw new AggregateError([undefined,new Error('${marker}')],'${marker}')`],
]) test(`native ${name} failure retains nonzero exit without exposing the thrown payload`, async () => {
  const f = await fixture(prelude + `test('${marker}',()=>{${body};});`);
  const result = run(f), failures = result.rows.filter(row => row.kind === "failure");
  assert.notEqual(result.status, 0);
  assert.ok(failures.length > 0);
  assert.ok(failures.every(row => row.file === f.file && row.line > 0));
  assert.ok(failures.every(row => row.code === "ERR_TEST_FAILURE"));
  // Node wraps/serializes these failures; their cause is deliberately uninspected.
  assert.ok(failures.every(row => ["native_error", "unknown"].includes(row.errorClass)));
});

test("a native child exercises the actual reporter without invoking hostile getters", async () => {
  const f = await fixture(prelude + `
    import { workerFailureReport } from ${JSON.stringify(pathToFileURL(reporter).href)};
    test('getter isolation', async () => {
      let reads = 0;
      const error = Object.defineProperties({}, Object.fromEntries(
        ['name', 'message', 'stack', 'cause', 'errors', 'code', 'failureType'].map(key =>
          [key, { get() { reads++; throw new Error('${marker}'); } }])));
      const events = [{ type: 'test:fail', data: { file: import.meta.url, line: 1, details: { error } } }];
      const lines = [];
      for await (const line of workerFailureReport(events)) lines.push(line);
      assert.equal(reads, 0);
      assert.equal(lines.length, 2);
      assert.equal(lines.join('').includes('${marker}'), false);
      assert.match(lines[0], /"code":"unknown"/);
    });
  `);
  assert.equal(run(f).status, 0);
});

test("native module import failure identifies the tracked child without copying stderr", async () => {
  const f = await fixture(`import './${marker}.mjs';`), result = run(f);
  assert.notEqual(result.status, 0);
  assert.ok(result.rows.some(row => row.kind === "failure" && row.file === f.file));
});

test("untracked native input remains unknown rather than acquiring a repository identity", async () => {
  const f = await fixture(prelude + "test('failure',()=>{throw undefined});", false), result = run(f);
  assert.notEqual(result.status, 0);
  assert.ok(result.rows.filter(row => row.kind === "failure").every(row => row.file === null && row.line === null));
  assert.ok(result.rows.at(-1).unknownFiles > 0);
});

for (const [name, source, status] of [
  ["success", prelude + "test('success',()=>assert.equal(1,1));", 0],
  ["undefined", prelude + "test('failure',()=>{throw undefined});", 1],
  ["import", `import './${marker}.mjs';`, 1],
]) test(`native root script ${name} retains its real exit and tracked identity`, async () => {
  const f = await fixture(source, true, "test/control.test.mjs"), result = run(f);
  assert.equal(result.status, status);
  const failures = result.rows.filter(row => row.kind === "failure");
  assert.equal(failures.length > 0, status !== 0);
  assert.ok(failures.every(row => row.file === f.file && row.line > 0));
});

test("root script allowlist accepts only exact tracked regular paths and local file URLs", async () => {
  const f = await fixture("", true, "test/control.test.mjs"), file = resolve(f.cwd, f.file);
  const outside = await fixture("", true, "test/control.test.mjs");
  await mkdir(join(f.cwd, "test/nested"));
  await writeFile(join(f.cwd, "test/nested/hidden.test.mjs"), "");
  await writeFile(join(f.cwd, "test/untracked.test.mjs"), "");
  await symlink(file, join(f.cwd, "test/link.test.mjs"));
  await symlink(join(f.cwd, "test"), join(f.cwd, "alias"));
  execFileSync("git", ["add", "--", "test/nested/hidden.test.mjs", "test/link.test.mjs", "alias"], { cwd: f.cwd, stdio: "ignore" });
  const valid = await collect([f.file, file, pathToFileURL(file).href].map((value, i) => fail(value, i + 1, undefined)), f.cwd);
  assert.equal(valid.filter(row => row.kind === "failure" && row.file === f.file).length, 3);
  const bad = [
    "test/untracked.test.mjs", "test/nested/hidden.test.mjs", "test/link.test.mjs", "alias/control.test.mjs",
    "test/nested/../control.test.mjs", file.replace("/test/", "/test/nested/../"),
    pathToFileURL(file).href.replace("/test/", "/test/%2e%2e/test/"),
    pathToFileURL(file).href + "?private=value", pathToFileURL(file).href + "#private",
    "file://foreign.invalid" + file, "C:\\private\\test\\control.test.mjs", "C:/private/test/control.test.mjs",
    "\\\\foreign\\test\\control.test.mjs", resolve(outside.cwd, outside.file), "/private/" + marker,
  ];
  for (const value of bad) {
    const rows = await collect([fail(value, 1, undefined)], f.cwd);
    assert.equal(rows[0].file, null); assert.equal(rows[0].line, null); assert.equal(rows.at(-1).unknownFiles, 1);
  }
  // A regular working copy must not promote an index entry that is a symlink.
  await rm(join(f.cwd, "test/link.test.mjs"));
  await writeFile(join(f.cwd, "test/link.test.mjs"), "");
  const replaced = await collect([fail("test/link.test.mjs", 1, undefined)], f.cwd);
  assert.equal(replaced[0].file, null); assert.equal(replaced.at(-1).unknownFiles, 1);
});

test("more than nine native failures emit nine identities and one bounded count record", async () => {
  const f = await fixture(prelude + Array.from({ length: 14 }, (_, i) => `test('failure ${i}',()=>assert.fail('${marker}'));`).join("\n"));
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.equal(result.rows.length, 10);
  assert.equal(result.rows.at(-1).reported, 9);
  assert.ok(result.rows.at(-1).failureEvents >= 14);
  assert.ok(result.rows.at(-1).omittedEvents >= 5);
});

test("native failures at the same safe coordinate deduplicate presentation only", async () => {
  const f = await fixture(prelude + "for(const id of [1,2]) test(String(id),()=>assert.fail());"), result = run(f);
  assert.notEqual(result.status, 0);
  assert.equal(result.rows.filter(row => row.kind === "failure").length, 1);
  assert.equal(result.rows.at(-1).failureEvents, 2);
  assert.equal(result.rows.at(-1).omittedEvents, 1);
});

function fail(file, line, error) {
  return { type: "test:fail", data: { file, line, details: { error } } };
}
async function collect(events, cwd) {
  let text = "";
  for await (const line of workerFailureReport(events, { cwd })) text += line;
  return records(text);
}

test("the actual reporter deduplicates identities and preserves late leaves ahead of parent aggregates", async () => {
  const f = await fixture(""), file = resolve(f.cwd, f.file);
  const parent = Object.assign(new Error(marker), { failureType: "subtestsFailed", code: "ERR_TEST_FAILURE" });
  const leaf = Object.assign(new Error(marker), { failureType: "testCodeFailure", code: "ERR_TEST_FAILURE" });
  const duplicate = fail(file, 50, leaf);
  const rows = await collect([...Array.from({ length: 12 }, (_, i) => fail(file, i + 1, parent)), duplicate, duplicate], f.cwd);
  assert.equal(rows[0].line, 50);
  assert.equal(rows.filter(row => row.line === 50).length, 1);
  assert.equal(rows.length, 10);
  assert.equal(rows.at(-1).failureEvents, 14);
  assert.equal(rows.at(-1).reported, 9);
});

test("own data only: undefined, missing, proxies and hostile getters remain closed unknowns", async () => {
  const f = await fixture(""), file = resolve(f.cwd, f.file); let reads = 0;
  const hostile = Object.defineProperties({}, Object.fromEntries(["name", "message", "stack", "cause", "errors", "code", "failureType"].map(key => [key, { get() { reads++; throw new Error(marker); } }])));
  const proxy = new Proxy({}, { ownKeys() { reads++; throw new Error(marker); }, getOwnPropertyDescriptor() { reads++; throw new Error(marker); } });
  const event = fail(file, 5, hostile); Object.defineProperty(event.data, "file", { get() { reads++; throw new Error(marker); } });
  const rows = await collect([fail(file, 1, undefined), { type: "test:fail", data: { file, line: 2, details: {} } }, fail(file, 3, hostile), fail(file, 4, proxy), event], f.cwd);
  assert.equal(reads, 0);
  assert.ok(rows.some(row => row.errorClass === "undefined"));
  assert.ok(rows.some(row => row.errorClass === "missing"));
  assert.ok(rows.some(row => row.file === null));
  assert.ok(rows.filter(row => row.kind === "failure").every(row => row.code === "unknown"));
});

test("unsafe paths, coordinates and strings cannot escape the fixed annotation schema", async () => {
  const f = await fixture(""), file = resolve(f.cwd, f.file);
  const error = { failureType: marker + "\n::error::", code: marker };
  const rows = await collect([fail(file, NaN, error), fail("/private/" + marker, 1, error), fail(file + "%0A", 1, error)], f.cwd);
  assert.ok(rows.filter(row => row.kind === "failure").every(row => row.line === null && row.code === "unknown" && row.failureType === "unknown"));
});

test("original source failure is propagated unchanged instead of manufacturing a summary", async () => {
  const f = await fixture(""); let finalized = false, caught = false;
  async function* events() { try { throw undefined; } finally { finalized = true; } }
  try { for await (const _ of workerFailureReport(events(), { cwd: f.cwd })) assert.fail("unexpected output"); }
  catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true); assert.equal(finalized, true);
});

test("a broken actual output pipe cannot turn the failing native child into success", async () => {
  const f = await fixture(prelude + "test('failure',()=>assert.fail());");
  const child = spawn(process.execPath, f.args, { cwd: f.cwd, env: childEnv, stdio: ["ignore", "pipe", "ignore"] });
  child.stdout.destroy();
  const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
  try {
    const result = await new Promise((resolveResult, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolveResult({ code, signal })); });
    assert.equal(result.signal, null);
    assert.notEqual(result.code, 0);
  } finally { clearTimeout(timer); }
});

test("workflow preserves typecheck order, the full default-concurrency glob and downstream gates", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")), job = workflow.jobs["worker-package"];
  const index = job.steps.findIndex(step => step.name === "Worker typecheck");
  assert.ok(index >= 0); assert.equal(job["timeout-minutes"], 20);
  assert.equal(job.steps[index].run, "pnpm exec tsc -p worker/tsconfig.json --noEmit");
  assert.equal(job.steps[index + 1].run, "node --test --test-reporter=./scripts/worker-test-failure-reporter.mjs --test-reporter-destination=stdout worker/test/*.test.mjs");
  assert.equal(job.steps[index + 2].run, "pnpm worker:e2e");
  assert.equal(job.steps[index + 3].run, "pnpm provider:smoke-plan");
  for (const step of job.steps.slice(index, index + 4)) assert.equal(step.if, undefined);
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).scripts["worker:check"], "tsc -p worker/tsconfig.json --noEmit && node --test worker/test/*.test.mjs");
  const scripts = workflow.jobs["script-tests"], step = scripts.steps.find(step => step.name === "Script tests with bounded failure identities");
  assert.equal(scripts["timeout-minutes"], 10);
  assert.equal(step.run, "node --test --test-reporter=./scripts/worker-test-failure-reporter.mjs --test-reporter-destination=stdout test/*.test.mjs");
  assert.equal(step.if, undefined);
  assert.equal(scripts.steps.at(-1), step);
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).scripts["test:scripts"], "node --test test/*.test.mjs");
  for (const file of ["scripts/worker-test-failure-reporter.mjs", "test/worker-test-failure-reporter.test.mjs", ".github/workflows/ci.yml"]) assert.equal(affectsOpenClawContract(file), false);
});
