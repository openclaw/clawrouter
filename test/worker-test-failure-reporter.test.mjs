import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { parse } from "yaml";
import { workerFailureReport } from "../scripts/worker-test-failure-reporter.mjs";
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
