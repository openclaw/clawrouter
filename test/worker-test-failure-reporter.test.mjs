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
import { workerFailureReport, workerAbortEvidence, decodeWorkerAbortDiagnostic, decodeWorkerReporterRecord, parseWorkerAbortDiagnostic, parseWorkerReporterRecord, workerAbortPrefix, workerAbortInvocation, workerAbortAdmissionSites, decodeWorkerAbortOperation, workerAbortParts, workerAbortRelationalPrefix, decodeWorkerAbortPart, parseWorkerAbortPart, validateWorkerAbortGroup } from "../scripts/worker-test-failure-reporter.mjs";
import { affectsOpenClawContract } from "../scripts/openclaw-contract-changes.mjs";

const reporter = fileURLToPath(new URL("../scripts/worker-test-failure-reporter.mjs", import.meta.url));
const marker = "synthetic-private-marker-do-not-report";
// BEGIN worker abort diagnostic pure tests.
function abortDiagnosticSource() {
  const source = readFileSync("worker/test/litellm-model-discovery.test.mjs", "utf8");
  const gateway = source.slice(source.indexOf("export async function withGateway("), source.indexOf("\nfunction registerTests()"));
  const start = source.indexOf('  test("original metadata caller abort retains strict acquisition and retirement outcomes"');
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
    const stage = retireFailed ? "fallback_state" : "final_state"; check(stage);
    return response(stage + "_body", { ...state, calls: fault === "calls_assertion" ? [] : state.calls, canceled: fault === "canceled_assertion" ? 0 : 1, active: fault === "active_assertion" ? 1 : 0, expired: fault === "expired_assertion" ? 1 : 0 });
  } };
  let retireFailed = false;
  const fetch = (url) => {
    if (url.endsWith("/__litellm/setup")) { check("router_setup"); const r = response("router_setup_body", {}); if (fault === "router_status") r.status = 500; return Promise.resolve(r); }
    if (url.includes("/__litellm/retire/")) { try { check("retire"); } catch (error) { retireFailed = true; return Promise.reject(error); } return Promise.resolve(response("retire_body", { retired: fault !== "retired_assertion" })); }
    if (url.includes("/__litellm/observation/")) { check("observation"); return Promise.resolve(response("observation_body", observation)); }
    check("caller");
    if (fault === "caller_observer") return { then() { check("caller_observer"); } };
    return fault === "caller_outcome" ? Promise.resolve({}) : Promise.reject(undefined);
  };
  const runtime = { async unsafeGetDirectURL() { check("direct_url"); return "https://fixture.test"; }, async getWorker() { check("upstream_handle"); return upstream; }, async dispose() { check("dispose"); } };
  const controlResponse = new Function("assert", control + ";return litellmControlResponse;")(assert);
  const context = { mkdtemp: async () => { check("directory"); return "inert"; }, join: (...args) => args.join("/"), tmpdir: () => "inert",
    startWorkerdFixture: async () => { check("runtime"); return runtime; }, routerFixture: () => "", upstreamFixture: () => "", selected: "inert", fetch, assert,
    litellmControlResponse: controlResponse, key: () => "inert", rm: async () => { check("remove"); } };
  const withGateway = new Function(...Object.keys(context), gateway + ";return withGateway;")(...Object.values(context));
  let callback;
  const Controller = function() { this.signal = { aborted: false }; this.abort = () => { check("authored_abort"); this.signal.aborted = fault !== "caller_signal"; }; };
  new Function("test", "withGateway", "workerAbortEvidence", "AbortController", "assert", body)((name, options, fn) => { callback = fn; }, withGateway, workerAbortEvidence, Controller, assert);
  let failed = false, error;
  try { await callback({ diagnostic(value) { if (reportingFault) throw undefined; diagnostics.push(value); } }); }
  catch (reason) { failed = true; error = reason; }
  const frames = diagnostics.filter(value => value.startsWith(workerAbortPrefix));
  return { failed, error, failure, calls, retireFailed, frames, record: frames.length ? decodeWorkerAbortDiagnostic(JSON.parse(frames.at(-1).slice(workerAbortPrefix.length))) : null };
}
test("worker abort diagnostic pure: actual fixture stages preserve first failure and both cleanup attempts", async () => {
  const stages = { directory: [1, 0], runtime: [2, 0], direct_url: [3, 0], upstream_handle: [4, 0], upstream_setup: [5, 0], upstream_status: [5, 1],
    router_setup: [6, 0], router_status: [7, 0], router_setup_body: [8, 0], caller: [9, 0], caller_observer: [9, 1], started: [10, 0],
    authored_abort: [11, 0], caller_outcome: [12, 0], caller_signal: [13, 0], retire: [14, 0], retired_assertion: [17, 0], final_state: [18, 0], calls_assertion: [19, 0], canceled_assertion: [20, 0], active_assertion: [21, 0], expired_assertion: [22, 0], dispose: [23, 0], remove: [24, 0] };
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
function workerAbortNativeEvents(frame) {
  const native = { testId: 7, parentId: undefined, name: "original metadata caller abort retains strict acquisition and retirement outcomes",
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
  return new Function((original + helpers).replace(/^export /gm, "") + ";return {observeLiteLLMOperation,litellmWorkerDrain,litellmWorkerLedger,litellmPredicateFacts};")();
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
function workerRelationFrames(observation, { reportFault = -1 } = {}) {
  const proof = workerAbortEvidence(), frames = []; proof.stage(14); proof.failed(undefined);
  proof.observation(15, { status: "fulfilled", value: observation });
  proof.observation(16, { status: "fulfilled", value: { calls: [{}], active: 0, canceled: 0, aborted: 0, expired: 1, finished: 1, producer: [1, 0, 0, 0, 0] } });
  const errors = proof.report({ diagnostic(frame) { if (frames.length === reportFault) throw undefined; frames.push(frame); } });
  return { frames, errors };
}
function workerRelationEvents(frames, reverse = false) {
  const events = workerAbortNativeEvents(frames[0]), diagnostics = frames.map(frame => ({ ...events[2], data: { ...events[2].data, message: frame } }));
  return reverse ? [events[0], ...diagnostics.reverse(), events[1]] : [...events.slice(0, 2), ...diagnostics];
}
const relationRecords = rows => rows.filter(row => row.kind === "worker_abort_relation");
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
