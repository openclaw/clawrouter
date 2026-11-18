import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import NativeRunnerReporter, { parseRunnerReport, projectRunnerError, readPrivateFile, reportByteLimit, runnerContract, runnerPlan, sha256, validateBinding } from "./helpers/openclaw-runner-reporter.mjs";
import { settleRunnerReport, validateRunnerRequest, withCopiedConsumerFixture, withNativeRunnerReport } from "./helpers/openclaw-consumer.mjs";
import { makeQwenValuePlan, qwenValueArgv, qwenValueSources } from "./helpers/openclaw-qwen-callsite-observer.mjs";

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
  const start = sourceText.indexOf("async (extraArgs, valueDirectory) => {");
  const end = sourceText.indexOf("\n      });", start);
  assert.ok(start > 0 && end > start);
  const execFile = {}, result = {}, env = { NO_COLOR: "0", FORCE_COLOR: "1", CLAWROUTER_CONTRACT_ORIGIN: "https://fixture.invalid" };
  const process = { execPath: "/fixture/node", env: { PATH: "fixture-bin", HOME: "fixture-home", TMPDIR: "fixture-tmp" } };
  const directory = "/fixture-source/.clawrouter-runner-report-owned";
  const reporters = ["--reporter=default", "--reporter=fixture-reporter"];
  let valueMode = false, rejected = false;
  let calls = 0;
  const launch = runInNewContext("(" + sourceText.slice(start, end) + "\n})", {
    source: "fixture-source", testPath: runnerContract.target, env, process, execFile, qwenValueArgv,
    promisify(original) {
      assert.equal(original, execFile);
      return (command, args, options) => {
        calls++; assert.equal(command, valueMode ? process.execPath : "pnpm");
        assert.deepEqual(Array.from(args), valueMode
          ? ["scripts/run-vitest.mjs", "run", "--config", join(directory, "qwen-callsite.config.ts"), runnerContract.target, "--maxWorkers=1", ...reporters]
          : ["test", runnerContract.target, "--maxWorkers=1", ...reporters]);
        assert.deepEqual(JSON.parse(JSON.stringify(options)), { cwd: "fixture-source", timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, CI: "true", ...env, NO_COLOR: "1" } });
        return rejected ? Promise.reject(undefined) : Promise.resolve(result);
      };
    },
  });
  for (valueMode of [false, true]) {
    rejected = false;
    assert.equal(await launch(reporters, valueMode ? directory : undefined), result);
    rejected = true;
    await assert.rejects(launch(reporters, valueMode ? directory : undefined), error => error === undefined);
  }
  assert.equal(calls, 4); assert.equal(env.NO_COLOR, "0");
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
  const declaredObserver = outer.match(/^const qwenValueObserverSha256 = "([a-f0-9]{64})";$/m)?.[1];
  assert.ok(declared && declaredReporter && declaredObserver);
  assert.equal(outer.split("runnerReport: { expectedInvocations: 1, fixtureSha256: qwenRunnerFixtureSha256, reporterSha256: qwenRunnerReporterSha256, valueObserverSha256: qwenValueObserverSha256, onReport: relay.runnerReport }").length, 2);
  const observerUrl = new URL("./helpers/openclaw-qwen-callsite-observer.mjs", import.meta.url);
  const observerBytes = readFileSync(observerUrl);
  assert.equal(sha256(observerBytes), declaredObserver);
  // Reuse the pinned inert source literals without importing the dependency-backed outer test.
  const originalsStart = outer.indexOf("const qwenValueOriginals = [");
  const originalsEnd = outer.indexOf("\nconst qwenValueHash =", originalsStart);
  assert.ok(originalsStart > 0 && originalsEnd > originalsStart);
  const originals = runInNewContext(outer.slice(originalsStart, originalsEnd) + "; qwenValueOriginals", { Buffer });
  for (let i = 0; i < qwenValueSources.length; i++) assert.equal(sha256(originals[i]), qwenValueSources[i].sha256);
  const helperUrl = new URL("./helpers/openclaw-consumer.mjs", import.meta.url);
  const helperSource = readFileSync(helperUrl, "utf8");
  const start = helperSource.indexOf("export async function withNativeRunnerReport(");
  const end = helperSource.indexOf("\nexport async function withCopiedConsumerFixture(", start);
  assert.ok(start >= 0 && end > start);
  const implementation = helperSource.slice(start, end).replace(/^export /, "");
  assert.equal(implementation.split("import.meta.url").length, 3);
  const reporterBytes = readFileSync(reporterPath);
  const stale = "47ef4694ff45c89cac41bcaa1168b6eb26d78cc21a095b9c1999baac2e41a3db";
  for (const mode of ["stale-fixture", "default", "values", "stale-observer", "child-undefined", "foreign-file", "child-and-cleanup"]) {
    const digest = mode === "stale-fixture" ? stale : declared;
    const valueMode = mode !== "default";
    const accepted = mode !== "stale-fixture" && mode !== "stale-observer";
    const files = new Map(), stats = new Map(), reads = [], effects = [], result = {};
    const removed = [], cleanupError = {};
    const directory = "/fixture-source/.clawrouter-runner-report-owned";
    const put = (path, bytes, mode) => {
      files.set(path, bytes);
      stats.set(path, { ino: stats.size + 1, dev: 1, uid: process.getuid(), nlink: 1, mode, isFile: () => true });
    };
    const scope = { assert, URL, helperUrl, fileURLToPath, join, resolve, sha256, runnerContract, runnerPlan, validateBinding,
      validateRunnerRequest, settleRunnerReport, parseRunnerReport, reportByteLimit, process, makeQwenValuePlan, qwenValueSources,
      randomBytes: size => Buffer.alloc(size),
      async readFile(path) {
        const key = path instanceof URL ? path.href : path;
        reads.push(key);
        assert.ok([reporterPath, fixtureUrl.href, observerUrl.href].includes(key));
        return key === reporterPath ? reporterBytes : key === fixtureUrl.href ? fixtureBytes : observerBytes;
      },
      readQwenValueInput(path, expected) {
        const index = qwenValueSources.findIndex(row => join("/fixture-source", row.path) === path);
        assert.ok(index >= 0); assert.equal(expected, qwenValueSources[index].sha256);
        assert.equal(sha256(originals[index]), expected); reads.push(path); return originals[index];
      },
      async mkdtemp(prefix) { effects.push("directory"); assert.equal(prefix, "/fixture-source/.clawrouter-runner-report-"); return directory; },
      async chmod(path, mode) { effects.push("chmod"); assert.equal(path, directory); assert.equal(mode, 0o700); },
      async writeFile(path, bytes, options) {
        effects.push("write"); assert.equal(options.flag, "wx"); assert.equal(files.has(path), false);
        assert.equal(options.mode, ["reporter.mjs", "callsite-observer.mjs"].some(name => path === join(directory, name)) ? 0o400 : 0o600);
        put(path, bytes, options.mode);
      },
      async lstat(path) { assert.ok(stats.has(path)); return stats.get(path); },
      readPrivateFile(path, limit) { effects.push("collect"); assert.equal(limit, reportByteLimit); assert.ok(files.has(path)); return files.get(path); },
      async rm(path, options) {
        effects.push("remove");
        if (!valueMode) { assert.equal(path, directory); assert.deepEqual(options, { recursive: true }); files.clear(); return; }
        assert.equal(options, undefined); assert.ok(files.has(path)); removed.push(path); files.delete(path);
        if (mode === "child-and-cleanup" && path === join(directory, "plan.json")) throw cleanupError;
      },
      async readdir(path) { effects.push("list"); assert.equal(path, directory); return [...files.keys()].map(file => file.slice(directory.length + 1)); },
      async rmdir(path) { effects.push("rmdir"); assert.equal(path, directory); assert.equal(files.size, 0); },
      execFileSync(command, args, options) {
        effects.push("clean"); assert.equal(command, "git"); assert.deepEqual(args, ["diff", "--quiet", "HEAD", "--"]);
        assert.deepEqual(options, { cwd: "/fixture-source" });
      },
    };
    // Only import.meta is supplied as data; the original validation and lifecycle body is intact.
    const run = new Function(...Object.keys(scope), `return (${implementation.replaceAll("import.meta.url", "helperUrl")});`)(...Object.values(scope));
    const pending = run({ source: "/fixture-source", sourceHead: runnerContract.pin, testPath: runnerContract.target, fixture: fixtureUrl, env: {},
      runnerReport: { expectedInvocations: 1, fixtureSha256: digest, reporterSha256: declaredReporter,
        ...(valueMode ? { valueObserverSha256: mode === "stale-observer" ? "f".repeat(64) : declaredObserver } : {}),
        onReport(packet) { effects.push("publish"); assert.equal(packet.complete, true); assert.equal(packet.records[0].binding.fixtureSha256, declared); } } }, async (args, valueDirectory) => {
      effects.push("execute");
      assert.equal(valueDirectory, valueMode ? directory : undefined);
      assert.deepEqual(args, ["--reporter=default", `--reporter=${join(directory, "reporter.mjs")}`, `--outputFile=${join(directory, "report.jsonl")}`]);
      const binding = JSON.parse(files.get(join(directory, "plan.json")));
      assert.equal(sha256(files.get(join(directory, "reporter.mjs"))), declaredReporter);
      if (valueMode) {
        assert.equal(sha256(files.get(join(directory, "callsite-observer.mjs"))), declaredObserver);
        assert.equal(sha256(files.get(join(directory, "worker-values.mjs"))), binding.callsite.virtualSHA);
        assert.equal(sha256(files.get(join(directory, "qwen-callsite.config.ts"))), binding.callsite.configSHA);
      }
      const records = [{ kind: "init", binding, seq: 0 }, { kind: "end", reason: "passed", ready: 0, results: 0, errors: 0, omitted: 0, complete: true, seq: 1 }];
      put(join(directory, "report.jsonl"), Buffer.from(records.map(row => JSON.stringify(row)).join("\n") + "\n"), 0o600);
      if (mode === "foreign-file") {
        const path = join(directory, "reporter.mjs"); stats.set(path, { ...stats.get(path), ino: 999 });
      }
      if (mode === "child-undefined" || mode === "child-and-cleanup") throw undefined;
      return result;
    });
    if (accepted) {
      if (mode === "child-undefined") await assert.rejects(pending, error => error === undefined);
      else if (mode === "child-and-cleanup") await assert.rejects(pending, error => {
        assert.deepEqual(error.errors, [undefined, cleanupError]); return true;
      });
      else if (mode === "foreign-file") await assert.rejects(pending, error => {
        assert.equal(error.errors.length, 2); assert.equal(error.errors[0].code, "ERR_ASSERTION");
        assert.equal(error.errors[1].code, "ERR_ASSERTION"); return true;
      });
      else assert.equal(await pending, result);
      assert.equal(declared, sha256(fixtureBytes));
      if (valueMode) {
        const names = ["plan.json", "reporter.mjs", "callsite-observer.mjs", "worker-values.mjs", "qwen-callsite.config.ts", "report.jsonl"];
        assert.deepEqual(removed, names.filter(name => mode !== "foreign-file" || name !== "reporter.mjs").map(name => join(directory, name)));
        assert.deepEqual([...files.keys()], mode === "foreign-file" ? [join(directory, "reporter.mjs")] : []);
        assert.deepEqual(effects, ["directory", "chmod", ...Array(5).fill("write"), "execute", "collect",
          ...Array(mode === "foreign-file" ? 5 : 6).fill("remove"), "list", ...(mode === "foreign-file" ? [] : ["rmdir"]), "clean", "publish"]);
      } else assert.deepEqual(effects, ["directory", "chmod", "write", "write", "execute", "collect", "remove", "publish"]);
    } else {
      await assert.rejects(pending, error => error.code === "ERR_ASSERTION" &&
        error.actual === (mode === "stale-fixture" ? sha256(fixtureBytes) : declaredObserver) &&
        error.expected === (mode === "stale-fixture" ? stale : "f".repeat(64)));
      assert.deepEqual(effects, []);
    }
    assert.deepEqual(reads, [reporterPath, fixtureUrl.href,
      ...(valueMode && mode !== "stale-fixture" ? [observerUrl.href] : []),
      ...(valueMode && accepted ? qwenValueSources.map(row => join("/fixture-source", row.path)) : [])]);
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

// BEGIN pinned runner inert coverage. All acquired files and commands below are fakes.
const inertRunnerMeasurements = [];
function inertPinnedRunner() {
  const reporterSource = readFileSync(new URL("./helpers/openclaw-runner-reporter.mjs", import.meta.url), "utf8");
  const consumerSource = readFileSync(new URL("./helpers/openclaw-consumer.mjs", import.meta.url), "utf8");
  const outerSource = readFileSync(new URL("./openclaw-xiaomi.test.mjs", import.meta.url), "utf8");
  const sdk = readFileSync(new URL("./fixtures/openclaw-xiaomi-contract.test.ts", import.meta.url), "utf8");
  const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb", target = "extensions/xiaomi/worker-contract.test.ts";
  const proof = stripTypeScriptTypes(sdk.slice(sdk.indexOf("// BEGIN Xiaomi proof functions."), sdk.indexOf("// END Xiaomi proof functions.")));
  const diagnostic = new Function(proof + ";return xiaomiDiagnostic();")();
  const factory = outerSource.slice(outerSource.indexOf("function xiaomiRunnerReport()"), outerSource.indexOf("\nconst cards ="));
  assert.ok(factory.startsWith("function xiaomiRunnerReport()") && factory.endsWith("\n}"));
  const runner = new Function("assert", "sourceHead", "diagnostic", factory + ";return xiaomiRunnerReport();")(assert, sourceHead, diagnostic);
  const files = new Map(), descriptors = new Map(), events = [], commands = [], packets = [];
  let inode = 0, nextFd = 0;
  const h = { runner, diagnostic, files, events, commands, packets, sourceHead, target, reporterSource, consumerSource, sdk,
    fault() {}, native: null, options: null, projects: [{ name: "extension-media" }] };
  const observe = (op, ...args) => { events.push(op); h.fault(op, ...args); };
  const put = (path, bytes, mode) => files.set(path, { bytes: Buffer.from(bytes), mode, ino: ++inode });
  const get = path => { const value = files.get(String(path)); if (!value) { const error = new Error("fake missing file"); error.code = "ENOENT"; throw error; } return value; };
  const constants = { O_RDONLY: 1, O_NOFOLLOW: 2, O_NONBLOCK: 4, O_WRONLY: 8, O_CREAT: 16, O_EXCL: 32, O_APPEND: 64, COPYFILE_EXCL: 128 };
  const reporterFile = "/repo/test/helpers/openclaw-runner-reporter.mjs", fixtureFile = "/repo/fixture.ts";
  put(reporterFile, reporterSource, 0o644); put(fixtureFile, sdk, 0o644);
  const fs = {
    constants,
    openSync(path, flags, mode) {
      observe("open", path, flags);
      if (flags & constants.O_CREAT) { assert.ok(!files.has(path)); put(path, "", mode); }
      get(path); const fd = ++nextFd; descriptors.set(fd, path); return fd;
    },
    closeSync(fd) { observe("close", fd); assert.equal(descriptors.delete(fd), true); },
    fstatSync(fd) { const f = get(descriptors.get(fd)); return { isFile: () => true, mode: f.mode, size: f.bytes.length, ino: f.ino }; },
    readFileSync(path) { observe("readSyncFile", path); return get(path).bytes; },
    readSync(fd, buffer, offset, length, position) { observe("read", fd); const bytes = get(descriptors.get(fd)).bytes; const n = Math.min(length, bytes.length - position); bytes.copy(buffer, offset, position, position + n); return n; },
    writeSync(fd, buffer, offset) { const f = get(descriptors.get(fd)), bytes = buffer.subarray(offset); f.bytes = Buffer.concat([f.bytes, bytes]); return bytes.length; },
    readFile: async path => { observe("readFile", path); return get(path).bytes; },
    lstat: async path => { observe("lstat", path); const f = get(path); return { isFile: () => true, ino: f.ino, dev: 1, uid: 1000, nlink: 1, mode: f.mode, size: f.bytes.length }; },
    copyFile: async (from, to, flags) => { observe("copy", from, to, flags); assert.equal(flags, constants.COPYFILE_EXCL); assert.ok(!files.has(to)); put(to, get(from).bytes, 0o600); },
    mkdtemp: async prefix => { observe("directory", prefix); return prefix + "1"; },
    chmod: async (...args) => { observe("chmod", ...args); },
    writeFile: async (path, bytes, opts) => { observe("writeFile", path, bytes, opts); assert.equal(opts.flag, "wx"); assert.ok(!files.has(path)); put(path, bytes, opts.mode); },
    rm: async (path, opts) => { observe(opts?.recursive ? "removeReport" : "removeFixture", path); for (const name of files.keys()) if (name === path || opts?.recursive && name.startsWith(path + "/")) files.delete(name); },
  };
  const pure = { assert, createHash: crypto.createHash, dirname, join, resolve, fileURLToPath };
  const evaluate = (source, dependencies, exports) => {
    const body = source.replace(/^import .*;\n/gm, "").replaceAll("import.meta.url", "moduleUrl").replace(/export default class /g, "class ").replace(/export /g, "");
    return new Function(...Object.keys(dependencies), body + `;return {${exports}};`)(...Object.values(dependencies));
  };
  const report = evaluate(reporterSource, { ...pure, ...fs, moduleUrl: "file:///native/.clawrouter-runner-report-1/reporter.mjs" },
    "runnerContract,runnerPlan,validateBinding,parseRunnerReport,projectRunnerError,readPrivateFile,reportByteLimit,sha256,NativeRunnerReporter");
  const execFile = async (command, args, opts) => {
    observe("command", command, args, opts); commands.push({ command, args, opts });
    return h.native(command, args, opts);
  };
  const helper = evaluate(consumerSource, { ...pure, ...fs, ...report, moduleUrl: "file:///repo/test/helpers/openclaw-consumer.mjs",
    process: { version: "v24.22.1", getuid: () => 1000, env: { CI: "true", PATH: "inert-path", HOME: "inert-home", TMPDIR: "inert-temp" } },
    performance: { now: () => 0 }, randomBytes: size => Buffer.alloc(size, 7), execFile,
    promisify: fn => { assert.equal(fn, execFile); return fn; },
    execFileSync: (command, args, opts) => { observe("git", command, args, opts); assert.equal(command, "git"); return args[0] === "rev-parse" ? sourceHead : ""; },
  }, "runOpenClawConsumer,validateRunnerRequest,withNativeRunnerReport,settleRunnerReport,withCopiedConsumerFixture");
  Object.assign(h, { report, helper });
  h.options = { source: "/native", sourceHead, fixture: fixtureFile, testPath: target, env: { CLAWROUTER_CONTRACT_ORIGIN: "synthetic" },
    runnerReport: { ...runner.options, onReport(packet) { observe("publish"); packets.push(packet); runner.options.onReport(packet); } } };
  h.produce = (args, change = () => {}) => {
    const reporter = new report.NativeRunnerReporter(), outputFile = args.find(a => a.startsWith("--outputFile=")).slice(13);
    const module = { moduleId: "/native/" + h.options.testPath, errors: () => [] };
    reporter.onInit({ version: "5.0.5", projects: h.projects, config: { root: "/native", outputFile } });
    reporter.onTestRunStart([module]); reporter.onTestModuleQueued(module);
    change(reporter, module, outputFile);
    reporter.onTestRunEnd([module], [], "failed");
    return outputFile;
  };
  h.native = (_command, args) => { h.produce(args); return { stdout: "private native output" }; };
  h.run = () => helper.runOpenClawConsumer({ diagnostic() { observe("discardStdout"); } }, h.options);
  h.emit = (rows = [diagnostic.record("outer", "none", "helper", 2, true, undefined, 0)], sdkCount = 0, failed = true) => {
    const writes = []; runner.emit(rows, failed, sdkCount, text => writes.push(text));
    for (const text of writes) {
      const lines = text.trimEnd().split("\n");
      inertRunnerMeasurements.push({ packet: Buffer.byteLength(text), annotations: lines.length,
        command: Math.max(...lines.map(line => Buffer.byteLength(line + "\n"))),
        record: Math.max(...lines.map(line => Buffer.byteLength(line.split("::")[2]))) });
    }
    return writes;
  };
  return h;
}

test("pinned Xiaomi runner uses actual helper and reporter with inert I/O", async () => {
  const h = inertPinnedRunner(); await h.run();
  assert.equal(h.commands.length, 1); const [{ command, args, opts }] = h.commands;
  assert.equal(command, "pnpm"); assert.deepEqual(args, ["test", h.target, "--maxWorkers=1", "--reporter=default",
    "--reporter=/native/.clawrouter-runner-report-1/reporter.mjs", "--outputFile=/native/.clawrouter-runner-report-1/report.jsonl"]);
  assert.deepEqual(opts, { cwd: "/native", timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: "inert-path", HOME: "inert-home", TMPDIR: "inert-temp", CI: "true", CLAWROUTER_CONTRACT_ORIGIN: "synthetic", NO_COLOR: "1" } });
  assert.equal(h.packets.length, 1); assert.equal(h.packets[0].complete, true);
  assert.ok(h.events.indexOf("removeReport") < h.events.indexOf("publish"));
  assert.ok(h.events.indexOf("publish") < h.events.indexOf("removeFixture"));
  const [text] = h.emit(); assert.equal(text.split("\n").length - 1, 2); assert.ok(!text.includes("private native output"));
  const row = JSON.parse(text.split("\n")[1].split("::")[2]);
  assert.deepEqual(row.phases, [1, 1, null, null, null]); assert.deepEqual(row.counts, [0, 0, 0, 0]);
  assert.equal(row.reason, "failed"); assert.equal(row.state, "complete"); assert.equal(row.sha256, h.packets[0].sha256);
});

test("pinned reporter preserves Qwen and rejects foreign plans and stale digests before native effects", async () => {
  const q = inertPinnedRunner(); q.options.testPath = q.report.runnerContract.target;
  q.projects = [{ name: "extension-providers" }];
  q.options.runnerReport.onReport = packet => { q.packets.push(packet); }; await q.run(); assert.equal(q.packets[0].complete, true);
  for (const change of [h => h.options.sourceHead = "0".repeat(40), h => h.options.testPath = "extensions/foreign/test.ts",
    h => h.options.runnerReport.fixtureSha256 = "f".repeat(64), h => h.options.runnerReport.reporterSha256 = "f".repeat(64),
    h => h.options.env.NODE_OPTIONS = "foreign", h => h.options.runnerReport.expectedInvocations = 2]) {
    const h = inertPinnedRunner(); change(h); await assert.rejects(h.run());
    assert.equal(h.commands.length, 0); assert.equal(h.events.includes("directory"), false); assert.equal(h.packets.length, 0);
  }
  const h = inertPinnedRunner();
  for (const [version, projects] of [["other", [{ name: "extension-providers" }]], ["5.0.5", [{ name: "foreign" }]], ["5.0.5", []]]) {
    const reporter = new h.report.NativeRunnerReporter();
    assert.throws(() => reporter.onInit({ version, projects, config: { root: "/native", outputFile: "/native/report" } }));
  }
});

test("pinned reporter binds one D8 project to the exact validated target before creating its report", async () => {
  for (const [target, expected] of [["extensions/xiaomi/worker-contract.test.ts", "extension-media"],
    ["extensions/qwen/worker-regions-contract.test.ts", "extension-providers"]]) {
    for (const projects of [[{ name: "extension-media" }], [{ name: "extension-providers" }], [{ name: "foreign" }], [],
      [{ name: expected }, { name: expected }]]) {
      const h = inertPinnedRunner(); h.options.testPath = target; h.projects = projects;
      h.options.runnerReport.onReport = packet => h.packets.push(packet);
      let creates = 0;
      h.fault = (op, path, flags) => { if (op === "open" && path.endsWith("/report.jsonl") && (flags & 16)) creates++; };
      if (projects.length === 1 && projects[0].name === expected) {
        await h.run(); assert.equal(h.packets[0].complete, true); assert.equal(creates, 1);
      } else {
        await assert.rejects(h.run(), error => {
          assert.equal(error.errors[0].message, "unqualified native project plan"); return true;
        });
        assert.equal(creates, 0);
        assert.equal(h.packets[0].reporter, "absent");
      }
      assert.ok(h.events.includes("removeReport") && h.events.includes("removeFixture"));
    }
  }
});

test("project access and private plan read failures preserve original undefined and independent close errors", async () => {
  for (const original of [new Error("project"), undefined]) for (const kind of ["getter", "proxy"]) {
    const h = inertPinnedRunner(); let reads = 0; let outputCreated = false;
    if (kind === "getter") h.projects = [{ get name() { reads++; throw original; } }];
    else h.projects = new Proxy([], { get() { reads++; throw original; } });
    h.fault = (op, path, flags) => { if (op === "open" && path.endsWith("/report.jsonl") && (flags & 16)) outputCreated = true; };
    await assert.rejects(h.run(), error => { assert.equal(error.errors[0], original); return true; });
    assert.equal(reads, 1); assert.equal(outputCreated, false); assert.equal(h.packets[0].reporter, "absent");
    assert.ok(h.events.includes("removeReport") && h.events.includes("removeFixture"));
  }
  for (const original of [new Error("plan read"), undefined]) for (const close of [new Error("plan close"), undefined]) {
    const h = inertPinnedRunner(); let readingPlan = false; let projectReads = 0;
    h.projects = [{ get name() { projectReads++; return "extension-media"; } }];
    h.fault = (op, path) => {
      if (op === "open") readingPlan = path.endsWith("/plan.json");
      if (op === "read" && readingPlan) throw original;
      if (op === "close" && readingPlan) throw close;
    };
    await assert.rejects(h.run(), error => { assert.deepEqual(error.errors[0].errors, [original, close]); return true; });
    assert.equal(projectReads, 0); assert.equal(h.packets[0].reporter, "absent");
    assert.ok(h.events.includes("removeReport") && h.events.includes("removeFixture"));
  }
});

test("complete canonical reporter packets alone supply Xiaomi startup facts", async () => {
  for (const variant of ["absent", "incomplete", "truncated", "duplicate", "foreign", "preamble"]) {
    const h = inertPinnedRunner(), original = new Error("original child");
    h.native = (_command, args) => {
      if (variant !== "absent") {
        const path = h.produce(args), file = h.files.get(path); const text = file.bytes.toString();
        if (variant === "incomplete") file.bytes = Buffer.from(text.split("\n").slice(0, -2).join("\n") + "\n");
        if (variant === "truncated") file.bytes = file.bytes.subarray(0, -1);
        if (variant === "duplicate") file.bytes = Buffer.from(text.replace('"kind":"init"', '"kind":"init","kind":"init"'));
        if (variant === "foreign") file.bytes = Buffer.from(text.replace(h.target, h.report.runnerContract.target));
        if (variant === "preamble") file.bytes = Buffer.from("private preamble" + text);
      }
      throw original;
    };
    await assert.rejects(h.run(), error => { assert.equal(error.errors[0], original); return true; });
    assert.ok(h.events.includes("removeReport") && h.events.includes("removeFixture"));
    const [text] = h.emit();
    if (["absent", "incomplete"].includes(variant)) {
      const row = JSON.parse(text.split("\n")[1].split("::")[2]); assert.equal(row.state, variant);
      for (const key of ["phases", "counts", "reason", "first", "bytes", "sha256"]) assert.equal(row[key], null);
    } else { assert.equal(h.packets.length, 0); assert.equal(text.includes("Xiaomi native runner"), false); }
  }
});

test("original child errors including undefined survive independent runner cleanup and report failures", async () => {
  for (const original of [new Error("child"), undefined]) for (const secondary of [new Error("secondary"), undefined]) {
    const h = inertPinnedRunner(); h.native = (_command, args) => { h.produce(args); throw original; };
    h.fault = op => { if (["removeReport", "publish"].includes(op)) throw secondary; };
    let caught = false;
    try { await h.run(); } catch (error) { caught = true; assert.deepEqual(error.errors, [original, secondary, secondary]); }
    assert.equal(caught, true); assert.ok(h.events.includes("removeFixture")); assert.equal(h.commands.length, 1);
  }
  for (const original of [new Error("child"), undefined]) {
    const h = inertPinnedRunner(); h.native = (_command, args) => { h.produce(args); throw original; };
    let caught = false; try { await h.run(); } catch (error) { caught = true; assert.equal(error, original); }
    assert.equal(caught, true); assert.equal(h.packets[0].complete, true);
  }
});

test("Xiaomi SDK annotations keep their exact priority and quota without runner displacement", async () => {
  const h = inertPinnedRunner(); await h.run(); const rows = [h.diagnostic.record("sdk", "c_cancel", "join", 0, true, undefined)];
  const old = []; h.diagnostic.emit(rows, true, text => old.push(text)); assert.deepEqual(h.emit(rows, 1), old);
  assert.deepEqual(h.emit(rows, null), old); assert.deepEqual(h.emit(rows, 0, false), []);
  for (const size of [8, 9, 10, 30]) {
    const records = Array.from({ length: size }, (_, i) => h.diagnostic.record("outer", "none", "assert", i, true, undefined));
    const baseline = []; h.diagnostic.emit(records, true, text => baseline.push(text));
    const [text] = h.emit(records), lines = text.trimEnd().split("\n");
    assert.ok(lines.length <= 10); assert.ok(Buffer.byteLength(text) <= 8192);
    assert.equal(text.includes("Xiaomi native runner"), size === 8);
    if (size > 8) assert.equal(text, baseline[0]); else assert.ok(text.startsWith(baseline[0]));
  }
  assert.throws(() => h.runner.options.onReport(h.packets[0]));
  assert.equal(h.emit()[0].includes("Xiaomi native runner"), false);
});

test("Xiaomi startup projection excludes raw fields and bounds the complete error supplement", async () => {
  const h = inertPinnedRunner(); let getterReads = 0;
  h.native = (_command, args) => {
    h.produce(args, (_reporter, module) => {
      const error = { name: "ReferenceError", code: "ERR_PACKAGE_PATH_NOT_EXPORTED", message: "private-message", stack: "private-stack" };
      Object.defineProperty(error, "cause", { get() { getterReads++; throw undefined; } });
      module.errors = () => [error];
    }); return { stdout: "private-stdout" };
  }; await h.run(); const text = h.emit()[0], line = text.split("\n")[1];
  const row = JSON.parse(line.split("::")[2]);
  assert.deepEqual(row.first, ["collection", "object", "defined", "ReferenceError", "defined", "ERR_PACKAGE_PATH_NOT_EXPORTED"]);
  assert.equal(getterReads, 0); assert.doesNotMatch(text, /private-|\/native|nonce|fixtureSha256|reporterSha256/);
  assert.ok(Buffer.byteLength(line) <= 768); assert.ok(Buffer.byteLength(text) <= 8192);
  const wide = inertPinnedRunner();
  wide.native = (_command, args) => {
    wide.produce(args, (reporter, module) => {
      reporter.onTestModuleCollected(module); reporter.onTestModuleStart(module);
      for (let i = 0; i < 200; i++) { const value = { module }; reporter.onTestCaseReady(value); reporter.onTestCaseResult(value); }
      module.errors = () => Array.from({ length: 32 }, () => ({ name: "ReferenceError", code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }));
      reporter.onTestModuleEnd(module);
    }); return { stdout: "private" };
  }; await wide.run(); assert.equal(wide.packets[0].complete, true);
  assert.ok(Buffer.byteLength(wide.emit()[0].split("\n")[1]) <= 768);
});

test("Xiaomi opt-in digests and default-off launch fingerprint match actual source bytes", () => {
  const h = inertPinnedRunner();
  assert.equal(h.runner.options.fixtureSha256, sha256(h.sdk)); assert.equal(h.runner.options.reporterSha256, sha256(h.reporterSource));
  const start = h.consumerSource.lastIndexOf("    const started = performance.now();"), end = h.consumerSource.indexOf("\n  }, () => rm(clientTest));", start);
  assert.ok(start > 0 && end > start);
  assert.equal(sha256(h.consumerSource.slice(start, end)), "ebdbbf3622f59fc0423ee500e227607316f9309b4e60d4cea7896f43c15fc3b6");
  const match = h.consumerSource.match(/import \{ ([^\n]+) \} from "\.\/openclaw-runner-reporter.mjs";/); assert.ok(match);
  for (const name of match[1].split(", ")) assert.ok(Object.hasOwn(h.report, name), `actual reporter export ${name}`);
});

test("held original child prevents collection, cleanup and publication until it settles", async () => {
  const h = inertPinnedRunner(); let release; let entered;
  const began = new Promise(resolve => { entered = resolve; });
  h.native = async (_command, args) => { entered(); await new Promise(resolve => { release = resolve; }); h.produce(args); return { stdout: "private" }; };
  let settled = false; const run = h.run(); run.then(() => { settled = true; }); await began;
  assert.equal(h.commands.length, 1); assert.equal(settled, false);
  for (const event of ["removeReport", "publish", "removeFixture"]) assert.equal(h.events.includes(event), false);
  release(); await run; assert.equal(settled, true); assert.equal(h.packets.length, 1);
});

test("foreign callback packets and duplicate delivery cannot leave a credible startup summary", async () => {
  const q = inertPinnedRunner(); q.options.testPath = q.report.runnerContract.target;
  q.projects = [{ name: "extension-providers" }];
  q.options.runnerReport.onReport = packet => q.packets.push(packet); await q.run();
  const h = inertPinnedRunner(); assert.throws(() => h.runner.options.onReport(q.packets[0]));
  assert.equal(h.emit()[0].includes("Xiaomi native runner"), false);
  for (const key of ["fixtureSha256", "reporterSha256", "pin"]) {
    const valid = inertPinnedRunner(); await valid.run();
    valid.packets[0].records[0].binding[key] = "f".repeat(key === "pin" ? 40 : 64);
    const copy = inertPinnedRunner(); assert.throws(() => copy.runner.options.onReport(valid.packets[0]));
    assert.equal(copy.emit()[0].includes("Xiaomi native runner"), false);
  }
});

test("native launch failure plus invalid report and fixture cleanup preserves original nested identities", async () => {
  for (const original of [new Error("child"), undefined]) for (const cleanup of [new Error("cleanup"), undefined]) {
    const h = inertPinnedRunner(); h.native = () => { throw original; };
    h.fault = op => { if (op === "removeFixture") throw cleanup; };
    await assert.rejects(h.run(), error => {
      assert.equal(error.errors[0].errors[0], original); assert.equal(error.errors[0].errors.length, 2);
      assert.equal(error.errors[1], cleanup); return true;
    });
    assert.equal(h.packets[0].reporter, "absent"); assert.equal(h.commands.length, 1);
  }
});
// END pinned runner inert coverage.
