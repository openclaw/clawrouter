import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import NativeRunnerReporter, { parseRunnerReport, projectRunnerError, readPrivateFile, reportByteLimit, runnerContract, sha256, validateBinding } from "./helpers/openclaw-runner-reporter.mjs";
import { settleRunnerReport, validateRunnerRequest, withCopiedConsumerFixture, withNativeRunnerReport } from "./helpers/openclaw-consumer.mjs";

const reporterPath = fileURLToPath(new URL("./helpers/openclaw-runner-reporter.mjs", import.meta.url));
const reporterSha256 = sha256(readFileSync(reporterPath));
const fixture = "// synthetic fixture: never executed\n";
const fixtureSha256 = sha256(fixture);
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function harness(t) {
  const root = mkdtempSync(join(tmpdir(), "native-runner-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, runnerContract.target);
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, fixture);
  const output = join(root, "report.jsonl");
  const binding = { ...runnerContract, fixtureSha256, reporterSha256, nonce: "0".repeat(64) };
  writeFileSync(join(root, "plan.json"), JSON.stringify(binding), { mode: 0o600 });
  const reporter = new NativeRunnerReporter();
  const context = { version: "5.0.5", projects: [{ name: "extension-providers" }], config: { root, outputFile: output } };
  const module = { moduleId: target, errors() { return []; } };
  return { root, output, binding, reporter, context, module,
    init() { reporter.onInit(context); },
    packet() { return parseRunnerReport(readPrivateFile(output, reportByteLimit), binding); },
  };
}
const request = (overrides = {}) => ({ sourceHead: runnerContract.pin, testPath: runnerContract.target, env: {},
  runnerReport: { expectedInvocations: 1, fixtureSha256, reporterSha256, onReport() {} }, ...overrides });

test("collection and unhandled errors retain closed own fields, never messages", t => {
  const h = harness(t); h.init();
  h.reporter.onTestRunStart([h.module]); h.reporter.onTestModuleQueued(h.module);
  h.module.errors = () => [{ name: "SyntaxError", code: "ERR_MODULE_NOT_FOUND", message: "private-content", stack: "private-content" }];
  h.reporter.onTestModuleEnd(h.module);
  h.reporter.onTestRunEnd([h.module], [undefined], "failed");
  const p = h.packet(); assert.equal(p.complete, true);
  const errors = p.records.filter(row => row.kind === "error");
  assert.deepEqual(errors.map(row => row.surface), ["collection", "unhandled"]);
  assert.deepEqual(errors[0].error.code, { presence: "defined", value: "ERR_MODULE_NOT_FOUND" });
  assert.equal(errors[1].error.received, "undefined");
  assert.equal(errors[1].error.originalPresence, "unknown");
  assert.ok(!readFileSync(h.output, "utf8").includes("private-content"));
  assert.equal(statSync(h.output).mode & 0o777, 0o600);
  assert.equal(p.sha256, sha256(readFileSync(h.output)));
});

test("error getters and prototypes are never evaluated; undefined differs from absent", () => {
  let reads = 0;
  const e = Object.create({ name: "Error", code: "MODULE_NOT_FOUND" });
  for (const key of ["name", "message", "stack", "cause"]) Object.defineProperty(e, key, { get() { reads++; throw undefined; } });
  Object.defineProperty(e, "code", { value: undefined });
  assert.deepEqual(projectRunnerError(e), { received: "object", originalPresence: "unknown",
    name: { presence: "accessor", value: "unknown" }, code: { presence: "undefined", value: "unknown" } });
  assert.equal(reads, 0);
  assert.equal(projectRunnerError(Object.create({ code: "MODULE_NOT_FOUND" })).code.presence, "absent");
  assert.equal(projectRunnerError({ name: "private-value", code: "private-value" }).code.value, "unknown");
  assert.equal(projectRunnerError(null).received, "null");
});

test("reporter observation fault including undefined stays a failure", t => {
  const h = harness(t); h.init();
  const reason = new Proxy({}, { getOwnPropertyDescriptor() { throw undefined; } });
  let caught = false;
  try { h.reporter.onTestRunEnd([], [reason], "failed"); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true); assert.equal(h.packet().complete, false);
});

test("actual hooks count ready and result separately, including never-completed cases", t => {
  const h = harness(t); h.init(); h.reporter.onTestRunStart([h.module]);
  h.reporter.onTestModuleQueued(h.module); h.reporter.onTestModuleCollected(h.module); h.reporter.onTestModuleStart(h.module);
  const one = { module: h.module }; const two = { module: h.module };
  h.reporter.onTestCaseReady(one); h.reporter.onTestCaseResult(one); h.reporter.onTestCaseReady(two);
  h.reporter.onTestModuleEnd(h.module); h.reporter.onTestRunEnd([h.module], [], "interrupted");
  assert.deepEqual(h.packet().records.at(-1), { kind: "end", reason: "interrupted", ready: 2, results: 1, errors: 0, omitted: 0, complete: true, seq: 9 });
});

test("partial initialization is incomplete, not an import verdict", t => {
  const h = harness(t); h.init(); const p = h.packet();
  assert.equal(p.complete, false); assert.equal(p.records.length, 1);
  assert.equal(Object.hasOwn(p, "executedCases"), false);
});

test("foreign modules, repeated runs and duplicate case events fail closed", t => {
  const h = harness(t); h.init();
  assert.throws(() => h.reporter.onTestModuleQueued({ moduleId: join(h.root, "foreign.test.ts") }));
  assert.throws(() => h.reporter.onTestRunStart([h.module, h.module]));
  h.reporter.onTestRunStart([h.module]); assert.throws(() => h.reporter.onTestRunStart([h.module]));
  const one = { module: h.module }; h.reporter.onTestCaseReady(one);
  assert.throws(() => h.reporter.onTestCaseReady(one));
});

test("exclusive output refuses a second native reporter invocation", t => {
  const h = harness(t); h.init();
  assert.throws(() => new NativeRunnerReporter().onInit(h.context));
  assert.throws(() => h.reporter.onInit(h.context));
});

test("API version, fixture identity and reporter identity are admitted before reporting", t => {
  const h = harness(t);
  assert.throws(() => h.reporter.onInit({ ...h.context, version: "other" }));
  assert.throws(() => new NativeRunnerReporter().onInit({ ...h.context, projects: [{ name: "foreign" }] }));
  assert.throws(() => new NativeRunnerReporter().onInit({ ...h.context, projects: [h.context.projects[0], h.context.projects[0]] }));
  writeFileSync(h.module.moduleId, "different fixture");
  assert.throws(() => new NativeRunnerReporter().onInit(h.context));
  writeFileSync(h.module.moduleId, fixture);
  writeFileSync(join(h.root, "plan.json"), JSON.stringify({ ...h.binding, reporterSha256: "1".repeat(64) }));
  assert.throws(() => new NativeRunnerReporter().onInit(h.context));
  assert.equal(existsSync(h.output), false);
});

test("error overflow retains a terminal incomplete receipt within the byte bound", t => {
  const h = harness(t); h.init();
  h.reporter.onTestRunEnd([], Array.from({ length: 80 }, () => ({ name: "Error", code: "MODULE_NOT_FOUND" })), "failed");
  const p = h.packet(); assert.equal(p.complete, false); assert.ok(p.bytes <= reportByteLimit);
  assert.equal(p.records.at(-1).errors, 80); assert.equal(p.records.at(-1).omitted, 48);
  assert.equal(p.records.filter(row => row.kind === "error").length, 32);
});

test("record quota reserves the terminal summary without false completeness", t => {
  const h = harness(t); h.init();
  for (let i = 0; i < 600; i++) h.reporter.onTestCaseReady({ module: h.module });
  h.reporter.onTestRunEnd([], [], "interrupted");
  const p = h.packet(); assert.equal(p.complete, false); assert.equal(p.records.at(-1).ready, 600);
  assert.ok(p.records.length <= 512); assert.ok(p.records.at(-1).omitted > 0);
});

test("parser rejects extra fields, duplicate keys, preambles, trailing data and false provenance", t => {
  const h = harness(t); h.init(); h.reporter.onTestRunEnd([], [], "failed");
  const bytes = readFileSync(h.output); const text = bytes.toString();
  const variants = ["prefix" + text, text.replace('"kind":"init"', '"kind":"init","kind":"init"'),
    text.replace('"kind":"init"', '"extra":true,"kind":"init"'), text + "{}\n", text.slice(0, -1)];
  for (const value of variants) assert.throws(() => parseRunnerReport(Buffer.from(value), h.binding));
  assert.throws(() => parseRunnerReport(bytes, { ...h.binding, nonce: "1".repeat(64) }));
  assert.throws(() => parseRunnerReport(Buffer.alloc(reportByteLimit + 1), h.binding));
});

test("private report reader rejects symlinks, public mode, replacement and oversized files", t => {
  const h = harness(t); h.init();
  const alias = join(h.root, "alias"); symlinkSync(h.output, alias);
  assert.throws(() => readPrivateFile(alias, reportByteLimit));
  chmodSync(h.output, 0o644); assert.throws(() => readPrivateFile(h.output, reportByteLimit));
  assert.throws(() => h.reporter.onTestRunEnd([], [], "failed"));
  chmodSync(h.output, 0o600); writeFileSync(h.output, Buffer.alloc(reportByteLimit + 1));
  assert.throws(() => readPrivateFile(h.output, reportByteLimit));
});

test("opt-in admission rejects foreign pin, path, cardinality and native planning overrides", () => {
  validateRunnerRequest(request());
  for (const override of [{ sourceHead: "0".repeat(40) }, { testPath: "extensions/qwen-portal/worker-contract.test.ts" },
    { runnerReport: { ...request().runnerReport, expectedInvocations: 2 } }, { runnerReport: { ...request().runnerReport, extra: true } }]) {
    assert.throws(() => validateRunnerRequest(request(override)));
  }
  for (const key of ["CI", "PATH", "HOME", "TMPDIR", "NODE_OPTIONS", "VITEST_POOL_ID", "OPENCLAW_TEST_PROJECTS_PARALLEL", "OPENCLAW_VITEST_INCLUDE_FILE", "OPENCLAW_GATEWAY_PROJECT_SHARDS"]) {
    assert.throws(() => validateRunnerRequest(request({ env: { [key]: "override" } })));
  }
  validateRunnerRequest(request({ env: { CLAWROUTER_CONTRACT_ORIGIN: "synthetic", QWEN_API_KEY: "synthetic" } }));
});

test("original child, report, cleanup and publication failures all survive, including undefined", async () => {
  const reportError = {}; const cleanupError = {}; const publishError = {}; const order = [];
  await assert.rejects(settleRunnerReport(() => { order.push("run"); throw undefined; }, () => { order.push("report"); throw reportError; },
    () => { order.push("cleanup"); throw cleanupError; }, () => { order.push("publish"); }), error => {
    assert.deepEqual(error.errors, [undefined, reportError, cleanupError]); return true;
  });
  assert.deepEqual(order, ["run", "report", "cleanup"]);
  await assert.rejects(settleRunnerReport(() => { throw undefined; }, () => ({ complete: true }), () => { throw cleanupError; },
    () => { throw publishError; }), error => { assert.deepEqual(error.errors, [undefined, cleanupError, publishError]); return true; });
});

test("held original child and cleanup keep completion pending and each phase runs once", async () => {
  const child = deferred(); const cleanup = deferred(); const order = []; let settled = false;
  const pending = settleRunnerReport(() => { order.push("run"); return child.promise; }, () => { order.push("report"); return { complete: true }; },
    () => { order.push("cleanup"); return cleanup.promise; }, () => { order.push("publish"); });
  pending.then(() => { settled = true; });
  await Promise.resolve(); assert.deepEqual(order, ["run"]); assert.equal(settled, false);
  child.resolve(9); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["run", "report", "cleanup"]); assert.equal(settled, false);
  cleanup.resolve(); assert.equal(await pending, 9); assert.deepEqual(order, ["run", "report", "cleanup", "publish"]);
});

test("missing report is delivered as unknown while original child rejection remains present", async t => {
  const h = harness(t); const original = {}; let packet; let calls = 0;
  await assert.rejects(withNativeRunnerReport(request({ source: h.root, fixture: h.module.moduleId,
    runnerReport: { ...request().runnerReport, onReport(value) { packet = value; } } }), () => { calls++; throw original; }), error => {
    assert.equal(error.errors[0], original); return true;
  });
  assert.equal(calls, 1); assert.equal(packet.reporter, "absent"); assert.equal(packet.complete, false);
  assert.equal(Object.hasOwn(packet, "executedCases"), false);
  assert.deepEqual(readdirSync(h.root).filter(name => name.startsWith(".clawrouter-runner-report-")), []);
});

test("actual copied reporter, native hook contract and helper report lifecycle round trip", async t => {
  const h = harness(t); let packet; let directory; let calls = 0;
  const result = await withNativeRunnerReport(request({ source: h.root, fixture: h.module.moduleId,
    runnerReport: { ...request().runnerReport, onReport(value) { assert.equal(existsSync(directory), false); packet = value; } } }), async args => {
    calls++; assert.equal(args.length, 3); assert.equal(args[0], "--reporter=default");
    const path = args[1].slice("--reporter=".length); const output = args[2].slice("--outputFile=".length);
    directory = dirname(path); assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o400); assert.equal(sha256(readFileSync(path)), reporterSha256);
    const Reporter = (await import(pathToFileURL(path).href)).default;
    const reporter = new Reporter(); reporter.onInit({ ...h.context, config: { root: h.root, outputFile: output } });
    reporter.onTestRunStart([h.module]); reporter.onTestModuleQueued(h.module);
    reporter.onTestRunEnd([h.module], [], "failed");
    return "original-value";
  });
  assert.equal(result, "original-value"); assert.equal(calls, 1); assert.equal(packet.complete, true);
  assert.equal(packet.records.at(-1).reason, "failed"); // Reporting completeness is not a test PASS.
});

test("failed exclusive fixture copy never removes a competing fixture", async () => {
  const reason = {}; let removed = false; let ran = false;
  await assert.rejects(withCopiedConsumerFixture(() => { throw reason; }, () => { ran = true; }, () => { removed = true; }), e => e === reason);
  assert.equal(ran, false); assert.equal(removed, false);
});

test("default-off original fixture lifecycle preserves result and cleanup failure identities", async () => {
  const value = {}; const reason = {}; const order = [];
  assert.equal(await withCopiedConsumerFixture(() => order.push("copy"), () => { order.push("run"); return value; }, () => order.push("remove")), value);
  assert.deepEqual(order, ["copy", "run", "remove"]);
  await assert.rejects(withCopiedConsumerFixture(() => {}, () => { throw undefined; }, () => { throw reason; }), e => {
    assert.deepEqual(e.errors, [undefined, reason]); return true;
  });
});

test("default-off launch retains the exact S9 command, options and diagnostic bytes", () => {
  const source = readFileSync(new URL("./helpers/openclaw-consumer.mjs", import.meta.url), "utf8");
  const start = source.lastIndexOf("    const started = performance.now();");
  const end = source.indexOf("\n  }, () => rm(clientTest));", start);
  assert.ok(start > 0 && end > start);
  assert.equal(sha256(source.slice(start, end)), "ebdbbf3622f59fc0423ee500e227607316f9309b4e60d4cea7896f43c15fc3b6");
});

test("opt-in launch forces plain rendering after caller env without changing the child contract", async () => {
  const sourceText = readFileSync(new URL("./helpers/openclaw-consumer.mjs", import.meta.url), "utf8");
  const start = sourceText.indexOf("async extraArgs => {");
  const end = sourceText.indexOf("\n      });", start);
  assert.ok(start > 0 && end > start);
  const execFile = {}, result = {}, env = { NO_COLOR: "0", FORCE_COLOR: "1", CLAWROUTER_CONTRACT_ORIGIN: "https://fixture.invalid" };
  const process = { env: { PATH: "fixture-bin", HOME: "fixture-home", TMPDIR: "fixture-tmp" } };
  let calls = 0;
  const launch = runInNewContext("(" + sourceText.slice(start, end) + "\n})", {
    source: "fixture-source", testPath: runnerContract.target, env, process, execFile,
    promisify(original) {
      assert.equal(original, execFile);
      return (command, args, options) => {
        calls++; assert.equal(command, "pnpm");
        assert.deepEqual(Array.from(args), ["test", runnerContract.target, "--maxWorkers=1", "--reporter=default", "--reporter=fixture-reporter"]);
        assert.deepEqual(JSON.parse(JSON.stringify(options)), { cwd: "fixture-source", timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, CI: "true", ...env, NO_COLOR: "1" } });
        return Promise.resolve(result);
      };
    },
  });
  assert.equal(await launch(["--reporter=default", "--reporter=fixture-reporter"]), result);
  assert.equal(calls, 1); assert.equal(env.NO_COLOR, "0");
});

test("unqualified fixture bytes reject before child or report-directory acquisition", async t => {
  const h = harness(t); let called = false;
  await assert.rejects(withNativeRunnerReport(request({ source: h.root, fixture: h.module.moduleId,
    runnerReport: { ...request().runnerReport, fixtureSha256: "f".repeat(64) } }), () => { called = true; }));
  assert.equal(called, false);
  assert.deepEqual(readdirSync(h.root).filter(name => name.startsWith(".clawrouter-runner-report-")), []);
});

test("Qwen runner digest matches the current fixture through the original pre-execution check", async () => {
  const fixtureUrl = new URL("./fixtures/openclaw-qwen-regions-contract.test.ts", import.meta.url);
  const fixtureBytes = readFileSync(fixtureUrl);
  const outer = readFileSync(new URL("./openclaw-qwen-regions.test.mjs", import.meta.url), "utf8");
  const declared = outer.match(/^const qwenRunnerFixtureSha256 = "([a-f0-9]{64})";$/m)?.[1];
  const declaredReporter = outer.match(/^const qwenRunnerReporterSha256 = "([a-f0-9]{64})";$/m)?.[1];
  assert.ok(declared && declaredReporter);
  assert.equal(outer.split("runnerReport: { expectedInvocations: 1, fixtureSha256: qwenRunnerFixtureSha256, reporterSha256: qwenRunnerReporterSha256, onReport: relay.runnerReport }").length, 2);
  const helperUrl = new URL("./helpers/openclaw-consumer.mjs", import.meta.url);
  const helperSource = readFileSync(helperUrl, "utf8");
  const start = helperSource.indexOf("export async function withNativeRunnerReport(");
  const end = helperSource.indexOf("\nexport async function withCopiedConsumerFixture(", start);
  assert.ok(start >= 0 && end > start);
  const implementation = helperSource.slice(start, end).replace(/^export /, "");
  assert.equal(implementation.split("import.meta.url").length, 2);
  const reporterBytes = readFileSync(reporterPath);
  const stale = "47ef4694ff45c89cac41bcaa1168b6eb26d78cc21a095b9c1999baac2e41a3db";
  for (const [digest, accepted] of [[stale, false], [declared, true]]) {
    const files = new Map(), reads = [], effects = [], result = {};
    const directory = "/fixture-source/.clawrouter-runner-report-owned";
    const scope = { assert, URL, helperUrl, fileURLToPath, join, resolve, sha256, runnerContract, validateBinding,
      validateRunnerRequest, settleRunnerReport, parseRunnerReport, reportByteLimit,
      randomBytes: size => Buffer.alloc(size),
      async readFile(path) { reads.push(path); assert.ok(path === reporterPath || path === fixtureUrl); return path === reporterPath ? reporterBytes : fixtureBytes; },
      async mkdtemp(prefix) { effects.push("directory"); assert.equal(prefix, "/fixture-source/.clawrouter-runner-report-"); return directory; },
      async chmod(path, mode) { effects.push("chmod"); assert.equal(path, directory); assert.equal(mode, 0o700); },
      async writeFile(path, bytes, options) { effects.push("write"); assert.equal(options.flag, "wx"); files.set(path, bytes); },
      readPrivateFile(path, limit) { effects.push("collect"); assert.equal(limit, reportByteLimit); assert.ok(files.has(path)); return files.get(path); },
      async rm(path, options) { effects.push("remove"); assert.equal(path, directory); assert.equal(options.recursive, true); },
    };
    // Only import.meta is supplied as data; the original validation and lifecycle body is intact.
    const run = new Function(...Object.keys(scope), `return (${implementation.replace("import.meta.url", "helperUrl")});`)(...Object.values(scope));
    const pending = run({ source: "/fixture-source", sourceHead: runnerContract.pin, testPath: runnerContract.target, fixture: fixtureUrl, env: {},
      runnerReport: { expectedInvocations: 1, fixtureSha256: digest, reporterSha256: declaredReporter,
        onReport(packet) { effects.push("publish"); assert.equal(packet.complete, true); assert.equal(packet.records[0].binding.fixtureSha256, declared); } } }, async args => {
      effects.push("execute");
      assert.deepEqual(args, ["--reporter=default", `--reporter=${join(directory, "reporter.mjs")}`, `--outputFile=${join(directory, "report.jsonl")}`]);
      const binding = JSON.parse(files.get(join(directory, "plan.json")));
      assert.equal(sha256(files.get(join(directory, "reporter.mjs"))), declaredReporter);
      const records = [{ kind: "init", binding, seq: 0 }, { kind: "end", reason: "passed", ready: 0, results: 0, errors: 0, omitted: 0, complete: true, seq: 1 }];
      files.set(join(directory, "report.jsonl"), Buffer.from(records.map(row => JSON.stringify(row)).join("\n") + "\n"));
      return result;
    });
    if (accepted) {
      assert.equal(await pending, result); assert.equal(declared, sha256(fixtureBytes));
      assert.deepEqual(effects, ["directory", "chmod", "write", "write", "execute", "collect", "remove", "publish"]);
    } else {
      await assert.rejects(pending, error => error.code === "ERR_ASSERTION" && error.actual === sha256(fixtureBytes) && error.expected === stale);
      assert.deepEqual(effects, []);
    }
    assert.deepEqual(reads, [reporterPath, fixtureUrl]);
  }
});

// Patch the built-in operations, not a duplicate cleanup implementation. The
// injected close error follows a real close so these tests retain no descriptors.
test("descriptor paths preserve primary and close failures independently", async t => {
  const paths = [
    ["read", ["fstat", "read", "validation"]],
    ["initialize", ["fstat"]],
    ["write", ["fstat", "write", "validation"]],
  ];
  const faults = [
    { name: "both objects", primary: {}, close: {}, primaryFailed: true, closeFailed: true },
    { name: "undefined primary", primary: undefined, close: {}, primaryFailed: true, closeFailed: true },
    { name: "undefined close", primary: {}, close: undefined, primaryFailed: true, closeFailed: true },
    { name: "both undefined", primary: undefined, close: undefined, primaryFailed: true, closeFailed: true },
    { name: "sole primary", primary: {}, primaryFailed: true, closeFailed: false },
    { name: "sole undefined primary", primary: undefined, primaryFailed: true, closeFailed: false },
  ];
  for (const [path, stages] of paths) {
    const cases = stages.flatMap(stage => faults.map(fault => ({ ...fault, stage })));
    cases.push({ name: "sole close", close: {}, primaryFailed: false, closeFailed: true });
    cases.push({ name: "sole undefined close", close: undefined, primaryFailed: false, closeFailed: true });
    for (const fault of cases) await t.test(`${path} ${fault.stage ?? "success"} ${fault.name}`, child => {
      const h = harness(child);
      if (path === "write") h.init();
      const file = path === "read" ? join(h.root, "plan.json") : h.output;
      const originals = { openSync: fs.openSync, closeSync: fs.closeSync, fstatSync: fs.fstatSync,
        readSync: fs.readSync, writeSync: fs.writeSync, ok: assert.ok };
      let descriptor; let opens = 0; let closes = 0; let operationFaults = 0;
      const failOperation = () => { operationFaults++; throw fault.primary; };
      let failed = false; let reason;
      try {
        child.mock.method(fs, "openSync", function (...args) {
          const fd = Reflect.apply(originals.openSync, this, args);
          if (args[0] === file) { descriptor = fd; opens++; }
          return fd;
        });
        child.mock.method(fs, "fstatSync", function (...args) {
          if (args[0] === descriptor && fault.stage === "fstat") return failOperation();
          return Reflect.apply(originals.fstatSync, this, args);
        });
        for (const [name, stage] of [["readSync", "read"], ["writeSync", "write"]]) {
          child.mock.method(fs, name, function (...args) {
            if (args[0] === descriptor && fault.stage === stage) return failOperation();
            return Reflect.apply(originals[name], this, args);
          });
        }
        child.mock.method(assert, "ok", function (...args) {
          const message = path === "read" ? "private bounded runner file" : "runner report replaced";
          if (fault.stage === "validation" && args[1] === message) return failOperation();
          return Reflect.apply(originals.ok, this, args);
        });
        child.mock.method(fs, "closeSync", function (...args) {
          const result = Reflect.apply(originals.closeSync, this, args);
          if (args[0] === descriptor) { closes++; if (fault.closeFailed) throw fault.close; }
          return result;
        });
        syncBuiltinESMExports();
        try {
          if (path === "read") readPrivateFile(file, 4096);
          else if (path === "initialize") h.init();
          else h.reporter.onTestRunEnd([], [], "failed");
        } catch (error) { failed = true; reason = error; }
      } finally { child.mock.restoreAll(); syncBuiltinESMExports(); }
      assert.equal(opens, 1); assert.equal(closes, 1);
      assert.equal(operationFaults, fault.primaryFailed ? 1 : 0); assert.equal(failed, true);
      if (fault.primaryFailed && fault.closeFailed) {
        assert.ok(reason instanceof AggregateError);
        assert.equal(reason.errors.length, 2);
        assert.equal(reason.errors[0], fault.primary); assert.equal(reason.errors[1], fault.close);
      } else assert.equal(reason, fault.primaryFailed ? fault.primary : fault.close);
    });
  }
});

test("report setup acquires custody only after nonce and binding validation", async t => {
  for (const mode of ["nonce-undefined", "invalid-nonce", "acquire-undefined", "setup-and-cleanup-undefined"]) {
    await t.test(mode, async child => {
      const h = harness(child); const events = []; let failure; let failed = false; let childCalls = 0;
      const original = { randomBytes: crypto.randomBytes, mkdtemp: fsPromises.mkdtemp, chmod: fsPromises.chmod, rm: fsPromises.rm };
      const setupError = {}; let removed = 0;
      try {
        child.mock.method(crypto, "randomBytes", function (...args) {
          events.push("nonce");
          if (mode === "nonce-undefined") throw undefined;
          if (mode === "invalid-nonce") return Buffer.alloc(1);
          return Reflect.apply(original.randomBytes, this, args);
        });
        child.mock.method(fsPromises, "mkdtemp", function (...args) {
          events.push("acquire");
          if (mode === "acquire-undefined") throw undefined;
          return Reflect.apply(original.mkdtemp, this, args);
        });
        child.mock.method(fsPromises, "chmod", function (...args) {
          events.push("setup");
          if (mode === "setup-and-cleanup-undefined") throw setupError;
          return Reflect.apply(original.chmod, this, args);
        });
        child.mock.method(fsPromises, "rm", async function (...args) {
          events.push("cleanup"); removed++;
          await Reflect.apply(original.rm, this, args);
          if (mode === "setup-and-cleanup-undefined") throw undefined;
        });
        syncBuiltinESMExports();
        try {
          await withNativeRunnerReport(request({ source: h.root, fixture: h.module.moduleId,
            runnerReport: { ...request().runnerReport, onReport() { events.push("report"); } } }), () => { childCalls++; });
        } catch (error) { failed = true; failure = error; }
      } finally { child.mock.restoreAll(); syncBuiltinESMExports(); }
      assert.equal(failed, true); assert.equal(childCalls, 0);
      if (mode === "nonce-undefined" || mode === "invalid-nonce") {
        assert.deepEqual(events, ["nonce"]); assert.equal(removed, 0);
        if (mode === "nonce-undefined") assert.equal(failure, undefined);
      } else if (mode === "acquire-undefined") {
        assert.deepEqual(events, ["nonce", "acquire"]); assert.equal(removed, 0); assert.equal(failure, undefined);
      } else {
        assert.deepEqual(events, ["nonce", "acquire", "setup", "cleanup", "report"]);
        assert.equal(removed, 1); assert.ok(failure instanceof AggregateError);
        assert.equal(failure.errors[0], setupError); assert.equal(failure.errors[1], undefined);
        assert.equal(failure.errors.length, 3); // Original setup, cleanup, then incomplete report.
      }
      assert.deepEqual(readdirSync(h.root).filter(name => name.startsWith(".clawrouter-runner-report-")), []);
    });
  }
});
