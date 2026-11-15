import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { types } from "node:util";

const provider = "deepseek-search";
const outer = readFileSync(new URL(`./openclaw-${provider}.test.mjs`, import.meta.url), "utf8");
const fixture = readFileSync(new URL(`./fixtures/openclaw-${provider}-contract.test.ts`, import.meta.url));
const reporterSource = readFileSync(new URL("./helpers/openclaw-runner-reporter.mjs", import.meta.url), "utf8");
const helperSource = readFileSync(new URL("./helpers/openclaw-consumer.mjs", import.meta.url), "utf8");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const pin = outer.match(/const sourceHead = "([a-f0-9]{40})"/)[1];
const target = outer.match(/testPath: "([^"]+)"/)[1];
const declaredFixture = outer.match(/fixtureSha256 = "([a-f0-9]{64})"/)[1];
const declaredReporter = outer.match(/reporterSha256 = "([a-f0-9]{64})"/)[1];
const reporterPath = "/helpers/openclaw-runner-reporter.mjs";
function extract(source, names, scope) {
  const code = source.replace(/^import .*;$/gm, "").replaceAll("export default class ", "class ").replaceAll("export ", "").replaceAll("import.meta.url", JSON.stringify("file:///helpers/openclaw-consumer.mjs"));
  return new Function(...Object.keys(scope), code + `\nreturn { ${names.join(",")} };`)(...Object.values(scope));
}
function harness(overrides = {}) {
  const files = new Map([[reporterPath, { bytes: Buffer.from(reporterSource), mode: 0o600, ino: 1 }], ["/fixture", { bytes: fixture, mode: 0o600, ino: 2 }]]);
  const fds = new Map(), events = [], calls = []; let next = 10, reporter, packet;
  const constants = { O_WRONLY: 1, O_CREAT: 2, O_EXCL: 4, O_NOFOLLOW: 8, O_APPEND: 16, O_NONBLOCK: 32, O_RDONLY: 64, COPYFILE_EXCL: 1 };
  const scope = { assert, Buffer, createHash, dirname, join, resolve, constants, fileURLToPath: () => reporterPath,
    openSync(path, flags, mode) { let file = files.get(path); if (flags & constants.O_EXCL) { assert.equal(file, undefined); files.set(path, file = { bytes: Buffer.alloc(0), mode, ino: next++ }); } if (!file) throw Object.assign(new Error("inert missing file"), { code: "ENOENT" }); const fd = next++; fds.set(fd, file); return fd; },
    closeSync(fd) { assert.ok(fds.delete(fd)); },
    fstatSync(fd) { const f = fds.get(fd); return { isFile: () => true, mode: f.mode, ino: f.ino, size: f.bytes.length }; },
    readFileSync(path) { return files.get(path).bytes; },
    readSync(fd, buffer, offset, length, position) { return fds.get(fd).bytes.copy(buffer, offset, position, position + length); },
    writeSync(fd, bytes, offset) { const f = fds.get(fd), chunk = bytes.subarray(offset); f.bytes = Buffer.concat([f.bytes, chunk]); return chunk.length; },
  };
  const api = extract(reporterSource, ["NativeRunnerReporter", "runnerProfile", "runnerContract", "parseRunnerReport", "readPrivateFile", "reportByteLimit", "sha256", "validateBinding", "runnerStartupRecord", "runnerStartupCommand"], scope);
  const helper = extract(helperSource, ["runOpenClawConsumer", "withNativeRunnerReport", "validateRunnerRequest", "settleRunnerReport"], { ...scope, ...api,
    process: { version: "v24.22.1", env: { CI: "true", PATH: "/inert", HOME: "/inert", TMPDIR: "/inert" } }, performance: { now: () => 0 }, promisify: fn => fn,
    execFileSync(command, args) { events.push(args.join(" ")); return args[0] === "rev-parse" ? pin : ""; },
    async execFile(command, args, options) {
      calls.push({ command, args, options }); events.push("child");
      if (overrides.execute) return overrides.execute({ api, files, args, events });
      if (args.some(arg => arg.startsWith("--reporter="))) {
        reporter = new api.NativeRunnerReporter();
        const output = args.find(arg => arg.startsWith("--outputFile=")).slice(13);
        const context = { version: "5.0.5", projects: [{ name: overrides.project ?? "agents-tools" }], config: { root: "/source", outputFile: output } };
        reporter.onInit(context);
        const module = { moduleId: "/source/" + target, errors: () => [] };
        reporter.onTestRunStart([module]); reporter.onTestModuleQueued(module); reporter.onTestModuleCollected(module); reporter.onTestModuleStart(module);
        const one = { module }; reporter.onTestCaseReady(one); reporter.onTestCaseResult(one);
        if (overrides.duplicate) reporter.onTestCaseResult(one);
        reporter.onTestModuleEnd(module); reporter.onTestRunEnd([module], overrides.errors ?? [], overrides.reason ?? "passed");
      }
      return { stdout: "native output stays private", stderr: "" };
    },
    randomBytes: n => Buffer.alloc(n, 7),
    async readFile(path) { return files.get(path).bytes; },
    async copyFile(from, to) { assert.equal(files.has(to), false); files.set(to, { ...files.get(from) }); },
    async mkdtemp(prefix) { events.push("acquire"); return prefix + "inert"; }, async chmod() {},
    async writeFile(path, bytes, options) { assert.equal(files.has(path), false); files.set(path, { bytes: Buffer.from(bytes), mode: options.mode, ino: next++ }); },
    async rm(path) { events.push("remove"); for (const key of files.keys()) if (key === path || key.startsWith(path + "/")) files.delete(key); },
  });
  const options = { source: "/source", sourceHead: pin, fixture: "/fixture", testPath: target, env: {},
    runnerReport: { expectedInvocations: 1, fixtureSha256: declaredFixture, reporterSha256: declaredReporter,
      onReport(value) { events.push("publish"); packet = value; } } };
  return { ...api, ...helper, files, calls, events, options, packet: () => packet, reporter: () => reporter };
}

test("committed fixture and reporter digests bind before any child", async () => {
  assert.equal(declaredFixture, sha256(fixture)); assert.equal(declaredReporter, sha256(reporterSource));
  const h = harness(); h.options.runnerReport.fixtureSha256 = "f".repeat(64);
  await assert.rejects(h.runOpenClawConsumer({ diagnostic() {} }, h.options)); assert.equal(h.calls.length, 0);
  assert.equal(h.events.includes("acquire"), false);
});
test("own exact profile and historical D8 are allowed; cross tuples and planning overrides are not", () => {
  const h = harness(); assert.equal(h.runnerProfile(pin, target).project, "agents-tools");
  assert.equal(h.runnerProfile(h.runnerContract.pin, h.runnerContract.target).project, "extension-providers");
  for (const [p, t] of [[pin, h.runnerContract.target], [h.runnerContract.pin, target], ["0".repeat(40), target]]) assert.throws(() => h.runnerProfile(p, t));
  for (const key of ["NODE_OPTIONS", "VITEST_POOL_ID", "OPENCLAW_VITEST_INCLUDE_FILE", "CI"]) assert.throws(() => h.validateRunnerRequest({ ...h.options, env: { [key]: "inert" } }));
});
test("actual opt-in command and hooks produce one bound invocation; default fingerprint unchanged", async () => {
  const h = harness(); await h.runOpenClawConsumer({ diagnostic() {} }, h.options);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].command, "pnpm");
  assert.deepEqual(h.calls[0].args.slice(0, 4), ["test", target, "--maxWorkers=1", "--reporter=default"]);
  assert.equal(h.calls[0].args.length, 6); assert.equal(h.calls[0].options.timeout, 240000); assert.equal(h.calls[0].options.maxBuffer, 2097152);
  assert.equal(h.packet().complete, true); assert.ok(h.events.indexOf("publish") > h.events.indexOf("remove"));
  const row = h.runnerStartupRecord(h.packet()); assert.equal(row.results, 1); assert.equal(Object.hasOwn(row, "passedCases"), false);
  assert.ok(Buffer.byteLength(h.runnerStartupCommand(row)) <= 768);
  const d = harness(); await d.runOpenClawConsumer({ diagnostic() {} }, { ...d.options, runnerReport: undefined });
  assert.deepEqual(d.calls[0].args, ["test", target, "--maxWorkers=1"]); assert.equal(d.events.includes("acquire"), false);
});
test("wrong project and duplicate actual callbacks remain fatal, never complete", async () => {
  for (const overrides of [{ project: "extension-providers" }, { duplicate: true }]) {
    const h = harness(overrides); await assert.rejects(h.runOpenClawConsumer({ diagnostic() {} }, h.options)); assert.equal(h.packet().complete, false);
  }
});
test("absent and partial reporter states stay unknown; original undefined survives", async () => {
  const h = harness({ execute() { throw undefined; } });
  await assert.rejects(h.runOpenClawConsumer({ diagnostic() {} }, h.options), error => {
    assert.ok(Array.isArray(error.errors)); assert.equal(error.errors[0], undefined); return true;
  });
  assert.equal(h.runnerStartupRecord(h.packet()).present, false);
  const p = harness(); await p.runOpenClawConsumer({ diagnostic() {} }, p.options);
  const original = p.packet(), records = original.records.slice(0, 1), bytes = Buffer.from(records.map(JSON.stringify).join("\n") + "\n");
  assert.equal(p.runnerStartupRecord({ records, complete: false, bytes: bytes.length, sha256: sha256(bytes) }).reason, null);
  assert.throws(() => p.runnerStartupRecord({ ...original, records: [...original.records, original.records[0]] }));
});
test("held original child stays held; cleanup and reporting preserve ordered undefined failures", async () => {
  const h = harness(); let release, done = false; const held = new Promise(resolve => { release = resolve; }); const order = [];
  const pending = h.settleRunnerReport(async () => { await held; throw undefined; }, () => { order.push("collect"); return { complete: true }; },
    () => { order.push("remove"); throw undefined; }, () => { order.push("publish"); throw "report"; }).catch(error => { done = true; return error; });
  await Promise.resolve(); assert.equal(done, false); assert.deepEqual(order, []); release();
  const error = await pending; assert.equal(error.errors.length, 3); assert.equal(error.errors[0], undefined); assert.equal(error.errors[1], undefined); assert.equal(error.errors[2], "report");
  assert.deepEqual(order, ["collect", "remove", "publish"]);
});

const dsStart = fixture.toString().indexOf("// BEGIN DeepSeek failure capsule."), dsEnd = fixture.toString().indexOf("// END DeepSeek failure capsule.");
const ds = new Function(stripTypeScriptTypes(fixture.toString().slice(dsStart, dsEnd)) + "; return deepSeekFailureProtocol;")()();
function dsSession(write) {
  const text = outer.slice(outer.indexOf("function deepSeekDiagnostics("), outer.indexOf("function deferred("));
  const h = harness();
  return new Function("assert", "Buffer", "nodeTypes", "failureProtocol", "runnerStartupRecord", "runnerStartupCommand", text + "; return deepSeekDiagnostics;")(
    assert, Buffer, types, ds, h.runnerStartupRecord, h.runnerStartupCommand)(write);
}
test("DS capsule distinguishes unavailable joins, actual empty joins, and original failed settlements", () => {
  const outputs = [], owner = ds.owner("abort", line => outputs.push(line));
  owner.at("body"); owner.failed(undefined); owner.at("registry_retirement"); owner.failed({});
  assert.deepEqual(owner.finish(), []); const row = ds.parse(outputs[0])[0];
  assert.equal(row.phase, "body"); assert.equal(row.failurePresent, true); assert.equal(row.reasonDefined, false); assert.equal(row.failures, 2);
  assert.equal(row.close, null); assert.equal(row.selectedRows, null); assert.equal(row.workerCommand, "unknown");
  const empty = ds.owner("key", line => outputs.push(line)); empty.select([]); empty.worker("fulfilled"); empty.finish();
  assert.deepEqual(ds.parse(outputs[1])[0].close, [0, 0]); assert.equal(ds.parse(outputs[1])[0].selectedRows, 0);
  const actual = ds.owner("default", line => outputs.push(line)), resource = {}; actual.select([resource]);
  actual.transport(resource, [{ status: "rejected", reason: undefined }], [{ status: "fulfilled", value: null }]); actual.worker("fulfilled");
  actual.at("worker_receipt"); actual.failed(undefined); actual.finish();
  assert.deepEqual(ds.parse(outputs[2])[0].close, [0, 1]); assert.equal(ds.parse(outputs[2])[0].phase, "worker_receipt");
});
test("DS foreign or duplicate private rows cannot manufacture joined emptiness; report error is independent", () => {
  const owner = ds.owner("abort", () => { throw undefined; }); const actual = {};
  owner.select([actual]); owner.transport({}, [], []); const faults = owner.finish();
  assert.equal(faults.length, 2); assert.equal(faults[1], undefined);
  const duplicate = ds.owner("abort", () => {}); duplicate.select([actual]); duplicate.transport(actual, [], []); duplicate.transport(actual, [], []);
  assert.equal(duplicate.finish().length, 1);
});
test("DS actual fixture catches retain original undefined plus cleanup and reporting after the join", async () => {
  const text = fixture.toString(); const start = text.indexOf("async function fixture("), end = text.indexOf("\ndescribe(", start);
  const body = stripTypeScriptTypes(text.slice(start, end)).replaceAll("import.meta.url", '"file:///fixture.ts"');
  const order = [], cleanup = {}, report = {}; let release; const held = new Promise(resolve => { release = resolve; }); let joined = false;
  const expect = () => ({ toEqual() {} });
  const scope = { failureProtocol: ds, process: { stdout: { write() { order.push("report"); throw report; } } },
    withOpenClawTestState: async (_, run) => run({ agentDir: () => "inert" }), fileURLToPath: () => "inert", URL, origin: "inert", key: () => "inert", manifest: { contracts: {} },
    loadBundledPluginFacade: async () => ({ default: { register() {} } }), createPluginRegistry: () => ({ registry: { diagnostics: [], webSearchProviders: [] } }),
    createPluginRuntime: () => ({}), resolvePluginCapabilityCatalogContext() {}, createPluginRecord: () => ({}), registerTestPlugin() {}, expect,
    withPluginRuntimeGenerationRegistryScope: async (_, run) => run(), createWebSearchTool: () => ({}),
    join: async () => { order.push("join"); await held; joined = true; }, disposePluginRegistryInstances: async () => { assert.equal(joined, true); order.push("retire"); throw cleanup; }, query: "inert" };
  const run = new Function(...Object.keys(scope), body + "; return fixture;")(...Object.values(scope));
  let done = false;
  const pending = run("abort", async () => { throw undefined; }).catch(error => { done = true; return error; });
  for (let i = 0; i < 12; i++) await Promise.resolve(); assert.equal(done, false); assert.deepEqual(order, ["join"]);
  release(); const error = await pending;
  assert.equal(error.errors.length, 3); assert.equal(error.errors[0], undefined); assert.equal(error.errors[1], cleanup); assert.equal(error.errors[2], report);
  assert.deepEqual(order, ["join", "retire", "report"]);
});
test("DS missing fixture entry uses startup evidence; SDK capsule outranks cleanup noise within quota", async () => {
  const h = harness(); await h.runOpenClawConsumer({ diagnostic() {} }, h.options);
  let lines = []; const startup = dsSession(line => lines.push(line)); startup.runner(h.packet()); startup.failed(undefined, "helper"); startup.finish();
  assert.ok(lines.some(line => line.includes("OpenClaw runner startup"))); assert.ok(lines.every(line => Buffer.byteLength(line) <= 768));
  lines = []; const session = dsSession(line => lines.push(line)), raw = [];
  const owner = ds.owner("abort", line => raw.push(line)); owner.at("body"); owner.failed(undefined); owner.finish();
  const original = Object.assign(new Error("not projected"), { stdout: raw.join(""), stderr: "" });
  session.runner(h.packet()); session.failed(original, "helper"); for (let i = 0; i < 40; i++) session.cleanup(undefined);
  assert.deepEqual(session.finish(), []); assert.ok(lines[0].includes('"source":"sdk"')); assert.ok(!lines.some(line => line.includes("OpenClaw runner startup")));
  assert.ok(lines.length <= 10 && Buffer.byteLength(lines.join("")) <= 8192); assert.ok(!lines.join("").includes("not projected"));
});

test("DS original join retains its command and subscriptions and does not credit a fulfilled receipt assertion", async () => {
  const text = fixture.toString(), start = text.indexOf("async function join("), end = text.indexOf("async function fixture(", start);
  const body = stripTypeScriptTypes(text.slice(start, end));
  const thenCalls = { close: 0, cancel: 0 }; const close = Promise.resolve(null), cancel = Promise.resolve(null);
  for (const [name, promise] of [["close", close], ["cancel", cancel]]) {
    const then = promise.then; promise.then = function (...args) { thenCalls[name]++; return Reflect.apply(then, this, args); };
  }
  const dispatcher = { closed: true }, row = { credential: "Bearer clawrouter-live-ds_abort-fixture-secret", path: "/inert", done: Promise.resolve(),
    dispatcher, closes: [{ receiver: dispatcher, argumentCount: 0, result: close }], cancels: [cancel], readers: [], body: { locked: false }, releaseReturned: true };
  const receiptFailure = {}; let calls = 0;
  const expect = value => ({ toBeDefined() { assert.notEqual(value, undefined); }, toHaveLength(n) { assert.equal(value.length, n); }, toBe(v) { assert.equal(value, v); },
    toBeInstanceOf(C) { assert.ok(value instanceof C); }, toEqual(v) { assert.deepEqual(value, v); }, toBeUndefined() { assert.equal(value, undefined); },
    toMatchObject() { throw receiptFailure; }, toHaveBeenCalledOnce() { throw new Error("no reader expected"); } });
  const joinOriginal = new Function("observations", "expect", "command", body + "; return join;")([row], expect,
    async path => { calls++; assert.equal(path, "/__deepseek/join/ds_abort"); return JSON.stringify({ paths: ["/inert"], retired: false }); });
  const lines = [], evidence = ds.owner("abort", line => lines.push(line)); evidence.at("join");
  await assert.rejects(joinOriginal("abort", evidence), error => { assert.equal(error, receiptFailure); evidence.failed(error); return true; });
  evidence.finish(); const record = ds.parse(lines[0])[0];
  assert.equal(calls, 1); assert.deepEqual(thenCalls, { close: 1, cancel: 1 }); assert.equal(record.workerCommand, "fulfilled");
  assert.equal(record.phase, "worker_receipt"); assert.equal(record.failurePresent, true); assert.deepEqual(record.close, [1, 0]);
});
