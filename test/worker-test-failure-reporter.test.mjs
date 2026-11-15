import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types as nodeTypes } from "node:util";
import { after, before, test } from "node:test";
import { parse } from "yaml";
import { workerFailureReport, workerAbortEvidence, decodeWorkerAbortDiagnostic, decodeWorkerReporterRecord, parseWorkerAbortDiagnostic, parseWorkerReporterRecord, workerAbortPrefix } from "../scripts/worker-test-failure-reporter.mjs";
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
function pureWorkerReporter() {
  const source = readFileSync("scripts/worker-test-failure-reporter.mjs", "utf8");
  const definitions = source.slice(source.indexOf("const failureTypes"), source.indexOf("function trackedTestFiles"))
    + source.slice(source.indexOf("function failureRecord"), source.indexOf("export default workerFailureReport"));
  // Only the unchanged filesystem resolver is inert here; the producer, native
  // event admission, selection and escaped serializer are the actual source.
  const tracked = file => typeof file === "string" && /^(?:worker\/)?test\/[A-Za-z0-9._-]+\.test\.mjs$/.test(file) ? file : null;
  return new Function("types", "trackedTestFiles", definitions.replace(/^export /gm, "") + ";return workerFailureReport;")(nodeTypes, () => tracked);
}
function workerAbortNativeEvents(frame) {
  const native = { testId: 7, parentId: undefined, name: "original metadata caller abort retains strict acquisition and retirement outcomes",
    file: "worker/test/litellm-model-discovery.test.mjs", line: 704, column: 3, nesting: 0 };
  return [
    { type: "test:enqueue", data: { ...native, type: "test" } },
    { type: "test:fail", data: { ...native, testNumber: 9, details: { error: { failureType: "testCodeFailure", code: "ERR_TEST_FAILURE" } } } },
    { type: "test:diagnostic", data: { file: native.file, line: native.line, column: native.column, nesting: native.nesting, message: frame, level: "info" } },
  ];
}
async function workerAbortPipeline(events) {
  const lines = [];
  for await (const line of pureWorkerReporter()(events)) lines.push(line);
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
    e => e.push(...[20, 21].map(testId => ({ type: "test:enqueue", data: { ...e[0].data, testId, name: "foreign", line: 900 } }))),
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
test("worker abort diagnostic pure: file scoped IDs and parent presence stay distinct", async () => {
  const fixture = await abortDiagnosticCase({ fault: "retire" });
  for (const parent of [undefined, null, 0, 5, Number.MAX_SAFE_INTEGER]) for (const order of [[0, 1, 2], [0, 2, 1]]) {
    const events = workerAbortNativeEvents(fixture.frames[0]); events[0].data.parentId = parent; events[1].data.parentId = parent;
    const ordered = order.map(index => events[index]);
    ordered.push({ type: "test:enqueue", data: { ...events[0].data, file: "worker/test/other.test.mjs" } });
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
  const events = workerAbortNativeEvents(frame), unrelated = Array.from({ length: 12 }, (_, i) => ({ type: "test:fail", data: { file: "worker/test/other.test.mjs", line: i + 1, details: {} } }));
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
