import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { types } from "node:util";

const provider = "google-speech";
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

const gsStart = fixture.toString().indexOf("// BEGIN google diagnostic protocol."), gsEnd = fixture.toString().indexOf("// END google diagnostic protocol.");
const gs = new Function(stripTypeScriptTypes(fixture.toString().slice(gsStart, gsEnd)) + "; return googleDiagnosticProtocol;")()(types.isProxy);
function gsSession(write) {
  const source = outer.slice(outer.indexOf("function diagnosticSession("), outer.indexOf("const diagnosticContext"));
  const h = harness(); return new Function("assert", "Buffer", "protocol", "nodeTypes", "runnerStartupRecord", "runnerStartupCommand", source + "; return diagnosticSession;")(
    assert, Buffer, gs, types, h.runnerStartupRecord, h.runnerStartupCommand)(write);
}
test("Google startup supplements missing SDK only and never displaces essential records", async () => {
  const h = harness(); await h.runOpenClawConsumer({ diagnostic() {} }, h.options);
  const lines = [], session = gsSession(line => lines.push(line)); session.runner(h.packet());
  for (const phase of ["compile", "barrier", "temporary", "worker_start", "initialize"]) for (const outcome of ["entered", "fulfilled"]) session.mark(phase, null, "progress", outcome);
  session.rejected(undefined);
  for (const phase of ["barrier_close", "worker_dispose", "scratch_cleanup"]) session.mark(phase, null, "cleanup", "rejected", true, undefined);
  assert.deepEqual(session.finish(), []);
  assert.equal(lines.filter(line => line.includes("OpenClaw runner startup")).length, 1);
  assert.ok(lines.some(line => line.includes('"phase":"helper"'))); assert.ok(lines.some(line => line.includes('"role":"cleanup"')));
  assert.ok(lines.length <= 10 && lines.every(line => Buffer.byteLength(line) <= 768) && Buffer.byteLength(lines.join("")) <= 8192);
});
test("Google existing SDK capsule stays primary, closed null remains unknown, reporting failures survive", async () => {
  const h = harness(); await h.runOpenClawConsumer({ diagnostic() {} }, h.options);
  const lines = [], session = gsSession(line => lines.push(line)); session.runner(h.packet());
  const record = gs.record({ source: "sdk", caseId: "abort_body", route: "manifest", phase: "body", role: "primary", outcome: "rejected", closed: null }, true, undefined);
  session.diagnostic(gs.prefix + JSON.stringify(record) + "\n"); session.rejected(undefined); assert.deepEqual(session.finish(), []);
  assert.ok(lines.some(line => line.includes('"source":"sdk"') && line.includes('"closed":null')));
  assert.equal(lines.some(line => line.includes("OpenClaw runner startup")), false);
  let writes = 0; const failure = gsSession(() => { writes++; throw undefined; }); failure.rejected(undefined); const errors = failure.finish();
  const leaves = value => value instanceof AggregateError ? value.errors.flatMap(leaves) : [value];
  assert.ok(errors.length > 0); assert.equal(errors.flatMap(leaves).length, writes); assert.ok(errors.flatMap(leaves).every(error => error === undefined));
});
