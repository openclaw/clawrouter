import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { types } from "node:util";
import { parse } from "yaml";
import { createRealtimeLedger, realtimeDiagnosticText, parseRealtimeDiagnostic, realtimeObservationContract, annotation, createObservationRelay, selectFailureRecords, workerFailureReport } from "../scripts/worker-test-failure-reporter.mjs";
import { createObservationLedger, observationDiagnosticText, parseObservationDiagnostic, searchObservationContract } from "../scripts/search-semantics-fixture.mjs";
import { affectsOpenClawContract } from "../scripts/openclaw-contract-changes.mjs";

const reporter = fileURLToPath(new URL("../scripts/worker-test-failure-reporter.mjs", import.meta.url));
const marker = "synthetic-private-marker-do-not-report";
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
    import { createRealtimeLedger, realtimeDiagnosticText, parseRealtimeDiagnostic, realtimeObservationContract, annotation, createObservationRelay, selectFailureRecords, workerFailureReport } from ${JSON.stringify(pathToFileURL(reporter).href)};
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

// BEGIN inert observation diagnostic tests (extract without native child fixtures).
const observationBoundary = (overrides = {}) => ({ v: 1, kind: "boundary", case: "variants", operation: "twenty_gets", stage: "begin", state: "rejected", failurePresent: true, reasonDefined: false, ...overrides });
const observationCleanup = (overrides = {}) => ({ v: 1, kind: "cleanup", case: "variants", registered: true, dispose: "fulfilled", disposeDefined: null, remove: "fulfilled", removeDefined: null, recorderFailures: 0, recorderFirstDefined: null, ...overrides });
function observationEvents() {
  const location = { entryFile: searchObservationContract.file, file: searchObservationContract.file, line: 257, column: 1, nesting: 0 };
  return { location, enqueue: { ...location, name: searchObservationContract.name, testId: 9 }, terminal: { ...location, name: searchObservationContract.name, testId: 9 },
    failure: { v: 1, kind: "failure", file: searchObservationContract.file, line: 257, failureType: "testCodeFailure", errorClass: "unknown", code: "ERR_TEST_FAILURE" } };
}
function inertObservationRelay() { return createObservationRelay(value => value === searchObservationContract.file ? value : null); }
function feedObservation(relay, events, rows = [observationBoundary(), observationCleanup()]) {
  relay.observe("test:enqueue", events.enqueue);
  relay.observe("test:fail", events.terminal, events.failure);
  for (const row of rows) relay.observe("test:diagnostic", { ...events.location, message: observationDiagnosticText(row) });
}
test("inert observation schema preserves undefined presence and canonical complete records", () => {
  for (const row of [observationBoundary(), observationBoundary({ reasonDefined: true }), observationCleanup()]) assert.deepEqual(parseObservationDiagnostic(observationDiagnosticText(row)), row);
  assert.throws(() => observationDiagnosticText(observationBoundary({ failurePresent: false })));
  assert.throws(() => observationDiagnosticText(observationCleanup({ disposeDefined: false })));
});
test("inert observation schema refuses duplicate keys, escapes, foreign fields and non-ASCII", () => {
  const text = observationDiagnosticText(observationBoundary());
  for (const bad of [text.replace('"v":1', '"v":1,"v":1'), text.replace('"variants"', '"\\u0076ariants"'), text + " ", "preamble" + text, text.replace('"variants"', '"foreign"'), text.replace('"begin"', '"é"'), text + "x".repeat(641)]) assert.throws(() => parseObservationDiagnostic(bad));
  assert.throws(() => observationDiagnosticText({ ...observationBoundary(), private: "not permitted" }));
});
test("inert observation schema and event reader never invoke getters or proxy traps", () => {
  let reads = 0;
  const getter = Object.defineProperty({}, "operation", { get() { reads++; throw undefined; } });
  const proxy = new Proxy({}, { ownKeys() { reads++; throw undefined; }, get() { reads++; throw undefined; }, getOwnPropertyDescriptor() { reads++; throw undefined; } });
  for (const value of [getter, proxy]) assert.throws(() => observationDiagnosticText(value));
  const relay = inertObservationRelay(); relay.observe("test:enqueue", proxy); relay.observe("test:diagnostic", Object.defineProperty({}, "file", { get() { reads++; } }));
  assert.equal(reads, 0); assert.equal(relay.finish().active, false);
});
test("inert observation relay binds native coordinates rather than payload case or arrival order", () => {
  const events = observationEvents(), relay = inertObservationRelay();
  for (const row of [observationCleanup(), observationBoundary()]) relay.observe("test:diagnostic", { ...events.location, message: observationDiagnosticText(row) });
  relay.observe("test:fail", events.terminal, events.failure); relay.observe("test:enqueue", events.enqueue);
  assert.deepEqual(relay.finish().records, [observationBoundary(), observationCleanup()]);
});
test("inert observation relay rejects late coordinate collisions including another name", () => {
  for (const name of [searchObservationContract.name, "unrelated native test"]) {
    const events = observationEvents(), relay = inertObservationRelay(); feedObservation(relay, events);
    relay.observe("test:enqueue", { ...events.enqueue, name, testId: 10 });
    assert.equal(relay.finish().records[0].state, "incomplete");
    assert.deepEqual(relay.finish().targetFailure, events.failure);
  }
});
test("inert observation relay rejects missing location, terminal and conflicting child identity", () => {
  for (const variant of ["file", "entryFile", "column", "nesting", "testId", "terminal", "foreignId"]) {
    const e = observationEvents(), relay = inertObservationRelay();
    if (variant !== "terminal" && variant !== "foreignId") delete e.enqueue[variant];
    relay.observe("test:enqueue", e.enqueue);
    if (variant !== "terminal") relay.observe("test:fail", variant === "foreignId" ? { ...e.terminal, testId: 77 } : e.terminal, e.failure);
    for (const row of [observationBoundary(), observationCleanup()]) relay.observe("test:diagnostic", { ...e.location, message: observationDiagnosticText(row) });
    const r = relay.finish(); assert.equal(r.active && r.records.some(row => row.kind === "boundary"), false);
  }
});
test("inert observation relay rejects foreign child diagnostics and duplicate or incomplete pairs", () => {
  for (const variant of ["foreign", "duplicate", "missing", "malformed"]) {
    const e = observationEvents(), relay = inertObservationRelay();
    feedObservation(relay, e, variant === "missing" ? [observationBoundary()] : [observationBoundary(), observationCleanup()]);
    if (variant !== "missing") relay.observe("test:diagnostic", { ...e.location, ...(variant === "foreign" ? { entryFile: "test/foreign.test.mjs" } : {}), message: variant === "malformed" ? searchObservationContract.prefix + "{" : observationDiagnosticText(observationBoundary()) });
    assert.equal(relay.finish().records[0].state, "incomplete");
  }
});
test("inert observation relay treats pending cleanup and contradictory success as incomplete", () => {
  const e = observationEvents(), pending = inertObservationRelay(); feedObservation(pending, e, [observationBoundary(), observationCleanup({ dispose: "pending" })]);
  assert.equal(pending.finish().records[0].reason, "cleanup_incomplete");
  const contradictory = inertObservationRelay(); contradictory.observe("test:enqueue", e.enqueue); contradictory.observe("test:pass", e.terminal);
  for (const row of [observationBoundary(), observationCleanup()]) contradictory.observe("test:diagnostic", { ...e.location, message: observationDiagnosticText(row) });
  assert.equal(contradictory.finish().records[0].reason, "diagnostics_conflict");
});
test("inert observation ledger distinguishes operand rejection from later assertion failure", () => {
  for (const stage of ["dispatch", "response_ok", "byte_bound", "json", "assertion"]) {
    const out = [], ledger = createObservationLedger(text => out.push(parseObservationDiagnostic(text)));
    ledger.select("initial_snapshot"); ledger.mark(stage); ledger.body(true, undefined); ledger.flush();
    assert.equal(out[0].stage, stage); assert.equal(out[0].reasonDefined, false); assert.equal(out[1].registered, false); assert.equal(out[1].dispose, "unregistered");
  }
});
test("inert observation ledger retains undefined body and both original cleanup failures", async () => {
  const out = [], order = [], second = {}, ledger = createObservationLedger(text => out.push(parseObservationDiagnostic(text)));
  ledger.registered(); ledger.body(true, undefined);
  await assert.rejects(ledger.cleanup(() => { order.push("dispose"); throw undefined; }, () => { order.push("remove"); return Promise.reject(second); }), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === undefined && error.errors[1] === second);
  assert.deepEqual(order, ["dispose", "remove"]); assert.equal(out[0].reasonDefined, false); assert.equal(out[1].disposeDefined, false); assert.equal(out[1].removeDefined, true);
  assert.deepEqual(ledger.failures().cleanup, [undefined, second]);
});
test("inert observation ledger joins held originals before subsequent cleanup and reporting", async () => {
  let releaseDispose, releaseRemove; const out = [], order = [], ledger = createObservationLedger(text => out.push(text)); ledger.registered(); ledger.body(false);
  const disposing = new Promise(resolve => { releaseDispose = resolve; }), removing = new Promise(resolve => { releaseRemove = resolve; });
  const done = ledger.cleanup(() => { order.push("dispose"); return disposing; }, () => { order.push("remove"); return removing; });
  await Promise.resolve(); assert.deepEqual(order, ["dispose"]); assert.equal(out.length, 0);
  releaseDispose(); await Promise.resolve(); assert.deepEqual(order, ["dispose", "remove"]); assert.equal(out.length, 0);
  releaseRemove(); await done; assert.equal(out.length, 2);
});
test("inert observation ledger preserves sole undefined cleanup and all recorder failures", async () => {
  const ledger = createObservationLedger(() => { throw undefined; }); ledger.registered(); ledger.body(true, undefined);
  const original = {}; let remove = 0;
  await assert.rejects(ledger.cleanup(() => { throw original; }, () => { remove++; }), error => error instanceof AggregateError && error.errors.length === 3 && error.errors[0] === original && error.errors[1] === undefined && error.errors[2] === undefined);
  assert.equal(remove, 1); assert.deepEqual(ledger.failures().reporting, [undefined, undefined]);
  const sole = createObservationLedger(() => {}); sole.registered(); sole.body(false); let caught = false;
  try { await sole.cleanup(() => { throw undefined; }, () => {}); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true);
});
test("inert observation ledgers remain invocation-owned and flush at most once", () => {
  const a = [], b = [], first = createObservationLedger(x => a.push(parseObservationDiagnostic(x))), second = createObservationLedger(x => b.push(parseObservationDiagnostic(x)));
  first.select("head"); second.select("post"); first.body(true, undefined); second.body(false); first.flush(); second.flush(); first.flush();
  assert.equal(a.length, 2); assert.equal(b.length, 2); assert.equal(a[0].operation, "head"); assert.equal(b[0].operation, "post");
});
test("inert observation quota keeps target identity inside nine essentials after earlier failures", () => {
  const e = observationEvents(), relay = inertObservationRelay(); feedObservation(relay, e); const result = relay.finish();
  const earlier = Array.from({ length: 9 }, (_, i) => ({ ...e.failure, file: "test/another.test.mjs", line: i + 1 }));
  const selected = selectFailureRecords(earlier, [], result);
  assert.deepEqual(selected[0], e.failure); assert.equal(selected.length, 7); assert.equal(selected.length + result.records.length, 9);
  assert.deepEqual(selectFailureRecords(earlier, [], { active: false }), earlier);
});
test("inert observation full-stream overflow cannot acquire complete binding", () => {
  const e = observationEvents(), relay = inertObservationRelay(); feedObservation(relay, e);
  for (let i = 0; i < 257; i++) relay.observe("test:enqueue", { ...e.enqueue, line: 1000 + i, name: "unrelated" });
  assert.equal(relay.finish().records[0].reason, "bounded_overflow");
});
test("inert observation maximum-width command and total budgets remain closed", () => {
  for (const row of [observationBoundary({ operation: "observation_create", stage: "cleanup_registration", reasonDefined: true }), observationCleanup({ recorderFailures: 1000000, recorderFirstDefined: false, dispose: "rejected", disposeDefined: false, remove: "rejected", removeDefined: true })]) {
    const admitted = parseObservationDiagnostic(observationDiagnosticText(row));
    const command = annotation(admitted, "notice");
    assert.ok(Buffer.byteLength(command) <= 768); assert.ok(Buffer.byteLength(command) * 10 <= 8192);
  }
});
test("inert observation absent-target output retains the exact original identity bytes", () => {
  const e = observationEvents(), relay = inertObservationRelay();
  relay.observe("test:enqueue", { ...e.enqueue, name: "another case" });
  relay.observe("test:diagnostic", { ...e.location, message: observationDiagnosticText(observationBoundary()) });
  const disposition = relay.finish(); assert.equal(disposition.active, false);
  const selected = selectFailureRecords([e.failure], [], disposition);
  assert.equal(selected[0], e.failure);
  assert.equal(annotation(selected[0], "error"), '::error title=Worker test identity::{"v":1,"kind":"failure","file":"test/search-semantics-observe.test.mjs","line":257,"failureType":"testCodeFailure","errorClass":"unknown","code":"ERR_TEST_FAILURE"}\n');
  const summary = { v: 1, kind: "summary", failureEvents: 1, reported: 1, omittedEvents: 0, unknownFiles: 0, countsSaturated: false };
  assert.equal(annotation(summary, "error"), '::error title=Worker test identity::{"v":1,"kind":"summary","failureEvents":1,"reported":1,"omittedEvents":0,"unknownFiles":0,"countsSaturated":false}\n');
});
test("inert observation cleanup retains original call receiver, arguments and returned promise", async () => {
  const receiver = { calls: 0 }, argument = {}, original = Promise.resolve(), out = [];
  function dispose(value) { assert.equal(this, receiver); assert.equal(value, argument); this.calls++; return original; }
  const ledger = createObservationLedger(text => out.push(text)); ledger.registered(); ledger.body(false);
  const bound = () => { const result = dispose.call(receiver, argument); assert.equal(result, original); return result; };
  await ledger.cleanup(bound, () => {}); assert.equal(receiver.calls, 1); assert.equal(out.length, 2);
});
test("inert observation relay rejects late reused child IDs and foreign terminal collisions", () => {
  for (const type of ["test:enqueue", "test:fail"]) {
    const e = observationEvents(), relay = inertObservationRelay(); feedObservation(relay, e);
    relay.observe(type, type === "test:enqueue" ? { ...e.enqueue, line: 999, name: "other" } : { ...e.terminal, name: "other" }, e.failure);
    assert.equal(relay.finish().records[0].state, "incomplete");
  }
});
test("inert terminal P2 missing or non-positive own native ID never completes binding", () => {
  for (const value of [undefined, 0, -1, 1.5, "9"]) {
    const e = observationEvents(), relay = inertObservationRelay();
    if (value === undefined) delete e.terminal.testId; else e.terminal.testId = value;
    feedObservation(relay, e);
    assert.equal(relay.finish().records[0].state, "incomplete");
  }
  const e = observationEvents(), relay = inertObservationRelay(); let getters = 0;
  Object.defineProperty(e.terminal, "testId", { get() { getters++; throw undefined; } });
  feedObservation(relay, e); assert.equal(relay.finish().records[0].state, "incomplete"); assert.equal(getters, 0);
});
test("inert terminal P2 late same-child native ID at different coordinates is conflicting", () => {
  for (const type of ["test:pass", "test:fail"]) {
    const e = observationEvents(), relay = inertObservationRelay(); feedObservation(relay, e);
    relay.observe(type, { ...e.terminal, line: e.terminal.line + 1, name: "other native case" }, e.failure);
    const result = relay.finish(); assert.equal(result.records[0].state, "incomplete"); assert.equal(result.targetFailure, e.failure);
  }
});
async function inertWorkerIdentityRows(events) {
  // Exercise the actual map/budget/summary loop with an inert tracked-file predicate.
  // No native runner, Git discovery, file fixtures, child or event serialization runs.
  const source = readFileSync(reporter, "utf8");
  const constants = source.slice(source.indexOf("const failureTypes"), source.indexOf("// Do not inspect"));
  const ownSource = source.slice(source.indexOf("function own("), source.indexOf("function trackedTestFiles("));
  const failureSource = source.slice(source.indexOf("function failureRecord("), source.indexOf("export function annotation("));
  const loop = source.slice(source.indexOf("export async function* workerFailureReport("), source.indexOf("export default workerFailureReport;"));
  const run = new Function("types", "trackedTestFiles", "annotation", "createObservationRelay", "selectFailureRecords",
    constants + ownSource + failureSource + loop.replace("export ", "") + "return workerFailureReport;")(types,
    () => file => (file === searchObservationContract.file || file === realtimeObservationContract.file) || /^test\/earlier-[0-9]+\.test\.mjs$/.test(file) ? file : null,
    annotation, createObservationRelay, selectFailureRecords);
  const commands = [];
  for await (const line of run(events)) commands.push(line);
  assert.ok(commands.length <= 10); assert.ok(Buffer.byteLength(commands.join("")) <= 8192);
  for (const line of commands) assert.ok(Buffer.byteLength(line) <= 768);
  return commands.map(line => JSON.parse(line.slice(line.indexOf("::", 2) + 2)));
}
test("inert terminal P2 both buffers full before target still retain its original identity", async () => {
  const e = observationEvents(), events = [{ type: "test:enqueue", data: e.enqueue }];
  for (let i = 0; i < 9; i++) events.push({ type: "test:fail", data: { ...e.terminal, entryFile: `test/earlier-${i}.test.mjs`, file: `test/earlier-${i}.test.mjs`, name: "earlier", testId: 100 + i } });
  for (let i = 0; i < 256; i++) events.push({ type: "test:pass", data: { ...e.terminal, line: 1000 + i, name: "other", testId: 1000 + i } });
  for (const row of [observationBoundary(), observationCleanup()]) events.push({ type: "test:diagnostic", data: { ...e.location, message: observationDiagnosticText(row) } });
  events.push({ type: "test:fail", data: { ...e.terminal, details: { error: undefined } } });
  const rows = await inertWorkerIdentityRows(events), failures = rows.filter(r => r.kind === "failure"), summary = rows.at(-1);
  assert.equal(failures[0].file, searchObservationContract.file); assert.equal(failures[0].line, e.terminal.line);
  assert.equal(failures[0].errorClass, "undefined"); assert.equal(rows.find(r => r.kind === "observation_delivery").reason, "bounded_overflow");
  assert.equal(rows.some(r => r.kind === "boundary"), false);
  assert.equal(summary.failureEvents, 10); assert.equal(summary.reported, 8); assert.equal(summary.omittedEvents, 2);
  assert.equal(summary.diagnosticsReported, 1); assert.equal(summary.diagnosticsOmitted, 2);
});
test("inert terminal P2 buffers filling after target preserve identity without complete credit", async () => {
  const e = observationEvents(), events = [{ type: "test:enqueue", data: e.enqueue }, { type: "test:fail", data: e.terminal }];
  for (const row of [observationBoundary(), observationCleanup()]) events.push({ type: "test:diagnostic", data: { ...e.location, message: observationDiagnosticText(row) } });
  for (let i = 0; i < 9; i++) events.push({ type: "test:fail", data: { ...e.terminal, entryFile: `test/earlier-${i}.test.mjs`, file: `test/earlier-${i}.test.mjs`, name: "later", testId: 100 + i } });
  for (let i = 0; i < 256; i++) events.push({ type: "test:pass", data: { ...e.terminal, line: 1000 + i, name: "other", testId: 1000 + i } });
  const rows = await inertWorkerIdentityRows(events);
  assert.equal(rows[0].file, searchObservationContract.file); assert.equal(rows[0].line, e.terminal.line);
  assert.equal(rows.find(r => r.kind === "observation_delivery").reason, "bounded_overflow");
  assert.equal(rows.some(r => r.kind === "boundary"), false); assert.equal(rows.at(-1).failureEvents, 10);
  assert.equal(rows.at(-1).reported, 8); assert.equal(rows.at(-1).omittedEvents, 2);
});
test("inert terminal P2 absent target keeps the actual reporter loop output unchanged", async () => {
  const rows = await inertWorkerIdentityRows([{ type: "test:fail", data: { file: "test/earlier-0.test.mjs", line: 1, details: { error: undefined } } }]);
  assert.deepEqual(rows, [
    { v: 1, kind: "failure", file: "test/earlier-0.test.mjs", line: 1, failureType: "unknown", errorClass: "undefined", code: "unknown" },
    { v: 1, kind: "summary", failureEvents: 1, reported: 1, omittedEvents: 0, unknownFiles: 0, countsSaturated: false },
  ]);
});
// END inert observation diagnostic tests.

// BEGIN inert realtime diagnostic tests (no native runner or fixture import).
const realtimeBoundary = (caseId = "r01", extra = {}) => ({ v: 1, kind: "realtime_boundary", case: caseId, operation: "assert_elapsed", failurePresent: true, reasonDefined: false, unreportedCases: 0, ...extra });
const realtimeCleanup = (caseId = "r01", extra = {}) => ({ v: 1, kind: "realtime_cleanup", case: caseId, registered: true, outcomes: "ffuffffff", recorderFailures: 0, recorderFirstDefined: null, unreportedCases: 0, ...extra });
function realtimeEvents(index = 0) {
  const location = { entryFile: realtimeObservationContract.file, file: realtimeObservationContract.file, line: 500 + index, column: 1, nesting: 0 };
  const native = { ...location, name: realtimeObservationContract.names[index], testId: index + 1 };
  return { location, enqueue: native, terminal: { ...native }, failure: { v: 1, kind: "failure", file: location.file, line: location.line, failureType: "testCodeFailure", errorClass: "undefined", code: "ERR_TEST_FAILURE" } };
}
function inertRealtimeRelay() { return createObservationRelay(file => [searchObservationContract.file, realtimeObservationContract.file].includes(file) ? file : null, true); }
function feedRealtime(relay, e, rows, failed = true) {
  relay.observe("test:enqueue", e.enqueue); relay.observe(failed ? "test:fail" : "test:pass", e.terminal, failed ? e.failure : undefined);
  for (const row of rows) relay.observe("test:diagnostic", { ...e.location, message: realtimeDiagnosticText(row) });
}
test("inert realtime all twelve pairs bind separately and select first native failure", () => {
  const relay = inertRealtimeRelay();
  for (let i = 0; i < 12; i++) {
    const id = `r${String(i + 1).padStart(2, "0")}`;
    feedRealtime(relay, realtimeEvents(i), [realtimeBoundary(id, { failurePresent: i >= 3, reasonDefined: i >= 3 ? false : null }), realtimeCleanup(id)], i >= 3);
  }
  const result = relay.finish(); assert.equal(result.records.length, 2);
  assert.equal(result.records[0].case, "r04"); assert.equal(result.records[0].unreportedCases, 11); assert.equal(result.omitted, 22); assert.equal(result.targetFailure.line, 503);
});
test("inert realtime missing failing pair never substitutes a later complete success", () => {
  const relay = inertRealtimeRelay(); feedRealtime(relay, realtimeEvents(), []);
  feedRealtime(relay, realtimeEvents(1), [realtimeBoundary("r02", { failurePresent: false, reasonDefined: null }), realtimeCleanup("r02")], false);
  assert.equal(relay.finish().records[0].reason, "diagnostics_incomplete"); assert.equal(relay.finish().targetFailure.line, 500);
});
test("inert realtime shared coordinates and late foreign-name or child-ID reuse deny binding", () => {
  for (const type of ["test:enqueue", "test:pass", "test:fail"]) {
    const relay = inertRealtimeRelay(), e = realtimeEvents(); feedRealtime(relay, e, [realtimeBoundary(), realtimeCleanup()]);
    relay.observe(type, { ...e.terminal, name: "unselected", file: searchObservationContract.file, line: 900 }, e.failure);
    assert.equal(relay.finish().records[0].state, "incomplete");
  }
  const relay = inertRealtimeRelay();
  for (let i = 0; i < 12; i++) { const e = realtimeEvents(i); e.enqueue.line = e.terminal.line = e.location.line = 368; feedRealtime(relay, e, [realtimeBoundary(`r${String(i + 1).padStart(2, "0")}`), realtimeCleanup(`r${String(i + 1).padStart(2, "0")}`)]); }
  assert.equal(relay.finish().records[0].reason, "ambiguous_coordinates");
});
test("inert realtime missing native fields and wrong payload labels stay incomplete", () => {
  for (const field of ["testId", "entryFile", "file", "line", "column", "nesting"]) {
    const e = realtimeEvents(), relay = inertRealtimeRelay(); delete e.terminal[field]; feedRealtime(relay, e, [realtimeBoundary(), realtimeCleanup()]);
    assert.equal(relay.finish().records[0].state, "incomplete");
  }
  const e = realtimeEvents(), relay = inertRealtimeRelay(); feedRealtime(relay, e, [realtimeBoundary("r02"), realtimeCleanup("r02")]);
  assert.equal(relay.finish().records[0].reason, "diagnostics_conflict");
});
test("inert realtime exact schema rejects unsafe values, duplicate JSON and bounds", () => {
  let touched = 0;
  for (const value of [new Proxy({}, { ownKeys() { touched++; } }), Object.defineProperty({}, "kind", { get() { touched++; } }), realtimeBoundary({ toString() { touched++; } })]) assert.throws(() => realtimeDiagnosticText(value));
  assert.equal(touched, 0);
  const text = realtimeDiagnosticText(realtimeBoundary());
  for (const bad of [text.replace('"v":1', '"v":1,"v":1'), "prefix" + text, text + " ", text.replace('"r01"', '"é"'), text + "x".repeat(641)]) assert.throws(() => parseRealtimeDiagnostic(bad));
  assert.throws(() => realtimeDiagnosticText({ ...realtimeBoundary(), unknown: true }));
});
test("inert realtime original cleanup preserves undefined primary and every independent failure", async () => {
  const source = readFileSync("test/realtime-cadence-workerd.test.mjs", "utf8");
  const cleanup = source.slice(source.indexOf("// BEGIN original cadence cleanup:"), source.indexOf("// END original cadence cleanup."));
  const run = new Function("witness", "release", "sockets", "drainProbe", "clients", "mf", "closeObservation", "server", "rm", "temporary", "serverFailures", "hasPrimary", "primary", "return (async () => {" + cleanup + "})();");
  const out = [], order = [], reasons = Array.from({ length: 8 }, () => ({}));
  const ledger = createRealtimeLedger("r01", text => out.push(parseRealtimeDiagnostic(text))); ledger.registered(); ledger.body(true, undefined);
  const fail = (label, reason) => { order.push(label); throw reason; };
  await assert.rejects(run(ledger, () => fail("release", undefined), [{ close() { fail("socket", reasons[0]); } }], () => fail("drain", reasons[1]), [Promise.resolve({ failed: true, error: reasons[2] })],
    { dispose() { fail("dispose", reasons[3]); } }, { finish() { fail("observer", reasons[4]); } }, { close(callback) { order.push("server"); callback(reasons[5]); } }, () => fail("remove", reasons[6]), "synthetic", [reasons[7]], true, undefined), error => {
      assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [undefined, undefined, ...reasons]); return true;
    });
  assert.deepEqual(order, ["release", "socket", "drain", "dispose", "observer", "server", "remove"]);
  assert.equal(out[0].reasonDefined, false); assert.equal(out[1].outcomes, "rdddddddd");
});
test("inert realtime throwing recorder cannot interrupt cleanup or erase original reasons", async () => {
  const source = readFileSync("test/realtime-cadence-workerd.test.mjs", "utf8"), cleanup = source.slice(source.indexOf("// BEGIN original cadence cleanup:"), source.indexOf("// END original cadence cleanup."));
  const run = new Function("witness", "release", "sockets", "drainProbe", "clients", "mf", "closeObservation", "server", "rm", "temporary", "serverFailures", "hasPrimary", "primary", "return (async () => {" + cleanup + "})();");
  let releases = 0, disposals = 0, removes = 0; const original = {}, ledger = createRealtimeLedger("r01", () => { throw undefined; }); ledger.registered(); ledger.body(true, original);
  await assert.rejects(run(ledger, () => { releases++; }, [], undefined, [], { dispose() { disposals++; } }, undefined, undefined, () => { removes++; }, "synthetic", [], true, original), error => error.errors.length === 3 && error.errors[0] === original && error.errors[1] === undefined && error.errors[2] === undefined);
  assert.deepEqual([releases, disposals, removes], [1, 1, 1]); assert.deepEqual(ledger.failures(), [undefined, undefined]);
});
test("inert realtime unregistered cleanup and pending originals cannot be completed evidence", () => {
  const out = [], ledger = createRealtimeLedger("r01", text => out.push(parseRealtimeDiagnostic(text))); ledger.body(true, undefined); ledger.flush(); ledger.flush();
  assert.equal(out.length, 2); assert.equal(out[1].registered, false); assert.equal(out[1].outcomes, "uuuuuuuuu");
  const relay = inertRealtimeRelay(); feedRealtime(relay, realtimeEvents(), [realtimeBoundary(), realtimeCleanup("r01", { outcomes: "fpuffffff" })]);
  assert.equal(relay.finish().records[0].reason, "cleanup_incomplete");
});
test("inert realtime both full buffers retain both original target identities", async () => {
  const search = observationEvents(), media = realtimeEvents(), events = [];
  for (let i = 0; i < 9; i++) events.push({ type: "test:fail", data: { file: `test/earlier-${i}.test.mjs`, line: 1 } });
  for (const e of [search, media]) {
    events.push({ type: "test:enqueue", data: e.enqueue });
    for (let i = 0; i < 256; i++) events.push({ type: "test:pass", data: { ...e.terminal, name: "unselected", line: 1000 + i, testId: 1000 + i } });
    events.push({ type: "test:fail", data: { ...e.terminal, details: { error: undefined } } });
  }
  const rows = await inertWorkerIdentityRows(events), failures = rows.filter(r => r.kind === "failure");
  assert.equal(failures[0].file, searchObservationContract.file); assert.equal(failures[1].file, realtimeObservationContract.file);
  assert.equal(failures[0].errorClass, "undefined"); assert.equal(failures[1].errorClass, "undefined");
  assert.equal(rows.find(r => r.kind === "realtime_delivery").reason, "bounded_overflow"); assert.equal(rows.find(r => r.kind === "realtime_delivery").unreportedCases, null);
  assert.equal(rows.length, 10); assert.equal(rows.at(-1).reported, 7);
});
test("inert realtime both pairs reserve five identities plus four diagnostics and summary", async () => {
  const search = observationEvents(), media = realtimeEvents(), events = [];
  for (const [e, pair, encode] of [[search, [observationBoundary(), observationCleanup()], observationDiagnosticText], [media, [realtimeBoundary(), realtimeCleanup()], realtimeDiagnosticText]]) {
    events.push({ type: "test:enqueue", data: e.enqueue }, { type: "test:fail", data: e.terminal });
    for (const row of pair) events.push({ type: "test:diagnostic", data: { ...e.location, message: encode(row) } });
  }
  for (let i = 0; i < 9; i++) events.unshift({ type: "test:fail", data: { file: `test/earlier-${i}.test.mjs`, line: 1 } });
  const rows = await inertWorkerIdentityRows(events); assert.equal(rows.length, 10); assert.equal(rows.at(-1).reported, 5); assert.equal(rows.at(-1).diagnosticsReported, 4);
  for (const row of [realtimeBoundary("r12", { unreportedCases: 1000000 }), realtimeCleanup("r12", { outcomes: "ddddddddd", recorderFailures: 1000000, recorderFirstDefined: false, unreportedCases: 1000000 })]) assert.ok(Buffer.byteLength(annotation(row, "notice")) <= 768);
});
test("inert realtime literal registrations preserve exact order, names, arguments and timeout", () => {
  const source = readFileSync("test/realtime-cadence-workerd.test.mjs", "utf8");
  const sites = [...source.matchAll(/^test\('bounded media authority ([^']+)', \{ timeout: 15_000 \}, t => authorityVariant\(t, (false|true), '([^']+)', '(r[0-9]{2})'\)\);$/gm)];
  assert.equal(sites.length, 12); assert.equal(new Set(sites.map(m => source.slice(0, m.index).split("\n").length)).size, 12);
  assert.deepEqual(sites.map(m => "bounded media authority " + m[1]), [...realtimeObservationContract.names]);
  for (const [i, m] of sites.entries()) { assert.equal(m[1], `${m[3]}, ASR=${m[2]}`); assert.equal(m[4], `r${String(i + 1).padStart(2, "0")}`); }
  assert.ok(source.includes("assert.ok(elapsed <= 250,")); assert.ok(source.includes("await sleep(120); const retiredAppends = (await f.stats()).appends.length;"));
});
test("inert realtime pre-registration reporting failures preserve primary including undefined", () => {
  for (const original of [undefined, {}]) {
    const ledger = createRealtimeLedger("r01", () => { throw undefined; }); ledger.body(true, original);
    assert.throws(() => ledger.finishUnregistered(true, original), error => error instanceof AggregateError && error.errors.length === 3 && error.errors[0] === original && error.errors[1] === undefined && error.errors[2] === undefined);
    assert.deepEqual(ledger.failures(), [undefined, undefined]);
  }
  const ledger = createRealtimeLedger("r01", () => {}); ledger.body(true, undefined);
  assert.equal(ledger.finishUnregistered(true, undefined), undefined);
});
// END inert realtime diagnostic tests.
