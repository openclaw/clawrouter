import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import NativeRunnerReporter, { parseRunnerReport, projectRunnerError, readPrivateFile, reportByteLimit, runnerContract, sha256 } from "./helpers/openclaw-runner-reporter.mjs";
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

test("unqualified fixture bytes reject before child or report-directory acquisition", async t => {
  const h = harness(t); let called = false;
  await assert.rejects(withNativeRunnerReport(request({ source: h.root, fixture: h.module.moduleId,
    runnerReport: { ...request().runnerReport, fixtureSha256: "f".repeat(64) } }), () => { called = true; }));
  assert.equal(called, false);
  assert.deepEqual(readdirSync(h.root).filter(name => name.startsWith(".clawrouter-runner-report-")), []);
});
