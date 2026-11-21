import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdtemp, open, readFile, rm, rmdir, readdir, lstat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify, types } from "node:util";
import { fileURLToPath } from "node:url";
import { makeQwenValuePlan, qwenValueArgv, qwenValueSources, readQwenValueInput } from "./openclaw-qwen-callsite-observer.mjs";
import { withPrivateExecutionOverlay } from "./openclaw-private-execution-observer.mjs";
import { parseRunnerReport, readPrivateFile, reportByteLimit, runnerContract, runnerPlan, sha256, validateBinding } from "./openclaw-runner-reporter.mjs";

export async function runOpenClawConsumer(t, { source, sourceHead, fixture, env, testPath = "extensions/clawrouter/worker-contract.test.ts", runnerReport, privateExec, typecheck = false }) {
  assert.equal(process.env.CI, "true", "the public client uses its own native install in ephemeral CI only");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), sourceHead);
  assert.equal(typeof typecheck, "boolean");
  const typePlan = typecheck ? consumerTypecheckPlan(sourceHead, testPath) : undefined;
  if (privateExec !== undefined) {
    assert.equal(runnerReport, undefined, "independent runner contracts cannot mix");
    validatePrivateExecRequest({ sourceHead, testPath, privateExec });
  }
  if (runnerReport !== undefined) {
    validateRunnerRequest({ sourceHead, testPath, env, runnerReport });
    assert.equal(process.version, "v24.22.1", "unqualified native diagnostic runtime");
    // The source-qualified plan cannot borrow dirty native runner or configuration inputs.
    execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: source });
  }
  const clientTest = join(resolve(source), testPath);
  await withCopiedConsumerFixture(() => copyFile(fixture, clientTest, constants.COPYFILE_EXCL), async () => {
    if (typePlan) {
      assert.equal(sha256(await readFile(join(source, typePlan.project))), typePlan.sha256, "owning client test graph changed");
      const started = performance.now();
      let result;
      try { result = await promisify(execFile)(process.execPath, typePlan.args, {
        cwd: source, timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: "true", ...env },
      }); } catch (error) {
        t.diagnostic(`OpenClaw ${sourceHead}; owning test type graph failed\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
        throw error;
      }
      t.diagnostic(`OpenClaw ${sourceHead}; owning test type graph PASS; ${Math.round(performance.now() - started)}ms; stdout ${Buffer.byteLength(result.stdout)}B/${sha256(result.stdout)}; stderr ${Buffer.byteLength(result.stderr)}B/${sha256(result.stderr)}\n${result.stdout}\n${result.stderr}`);
    }
    if (runnerReport !== undefined) {
      const started = performance.now();
      const result = await withNativeRunnerReport({ source, sourceHead, fixture, testPath, env, runnerReport }, async (extraArgs, valueDirectory) => {
        const executable = valueDirectory ? process.execPath : "pnpm";
        const args = valueDirectory ? qwenValueArgv(valueDirectory, testPath, extraArgs)
          : ["test", testPath, "--maxWorkers=1", ...extraArgs];
        return promisify(execFile)(executable, args, {
          cwd: source, timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: "true", ...env, NO_COLOR: "1" },
        });
      });
      t.diagnostic(`OpenClaw ${sourceHead}; native test wall time ${Math.round(performance.now() - started)}ms\n${result.stdout}`);
      return;
    }
    if (privateExec !== undefined) {
      const started = performance.now();
      const result = await withPrivateExecutionOverlay(source, privateExec.fixtureSha256, executionContract => observePrivateExec({ sourceHead, testPath, privateExec, executionContract },
        () => readCopiedPrivateFixture(clientTest, privateExec.fixtureBytes),
        () => promisify(execFile)("pnpm", ["test", testPath, "--maxWorkers=1"], {
          cwd: source, timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: "true", ...env, CLAWROUTER_PRIVATE_EXECUTION_CONTRACT: executionContract },
        })));
      t.diagnostic(`OpenClaw ${sourceHead}; native test wall time ${Math.round(performance.now() - started)}ms\n${result.stdout}`);
      return;
    }
    const started = performance.now();
    const result = await promisify(execFile)("pnpm", ["test", testPath, "--maxWorkers=1"], {
      // The native runner compiles its own SDK worker graph on a cold CI host.
      cwd: source, timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: "true", ...env },
    });
    t.diagnostic(`OpenClaw ${sourceHead}; native test wall time ${Math.round(performance.now() - started)}ms\n${result.stdout}`);
  }, () => rm(clientTest));
}

export function consumerTypecheckPlan(sourceHead, testPath) {
  // The copied .test.ts is included by the pinned extension test graph. Run
  // that original graph inside the same exclusive-copy and cleanup lifetime.
  assert.equal(sourceHead, "b6072e63fdf09422ea70ef4bbdc818536d871047");
  assert.equal(testPath, "extensions/clawrouter/worker-google-continuation-contract.test.ts");
  const project = "test/tsconfig/tsconfig.extensions.test.json";
  return { project, sha256: "b032aa889d4ab5512e57f26871a5839a38ae326b18e765dce2dcec3b4fd80d49",
    args: ["scripts/run-tsgo.mjs", "-p", project, "--noEmit", "--incremental", "false"] };
}

// Private/E2 only. Parent exec settlement is not Vitest collection or case proof.
export function validatePrivateExecRequest({ sourceHead, testPath, privateExec }) {
  assert.equal(sourceHead, "e2a8b8d4ec290cd6c035f3568a14e4d7c6433635");
  assert.equal(testPath, "extensions/baseten/clawrouter-private-catalogs-contract.test.ts");
  assert.deepEqual(Object.keys(privateExec).sort(), ["fixtureBytes", "fixtureSha256", "onOutcome", "token"]);
  assert.match(privateExec.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(privateExec.fixtureBytes) && privateExec.fixtureBytes > 0 && privateExec.fixtureBytes <= 2 * 1024 * 1024);
  assert.equal(typeof privateExec.onOutcome, "function");
  assert.ok(privateExec.token && !types.isProxy(privateExec.token) && Object.isFrozen(privateExec.token));
}

export async function readCopiedPrivateFixture(target, expectedBytes, openFile = open) {
  const failures = []; let file; let bytes;
  try {
    file = await openFile(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    assert.ok(stat.isFile() && stat.size === expectedBytes, "copied Private fixture size changed");
    const buffer = Buffer.alloc(expectedBytes + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assert.equal(offset, expectedBytes, "copied Private fixture read changed");
    bytes = buffer.subarray(0, offset);
  } catch (error) { failures.push(error); }
  if (file !== undefined) try { await file.close(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Private fixture snapshot and close failed");
  return bytes;
}

export function privateExecProcessFields(error) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return null;
  if (types.isProxy(error)) throw new Error("uninspectable Private exec outcome");
  // Presence: 0 absent, 1 own undefined, 2 admitted primitive, 3 accessor,
  // 4 unsupported value. Never inspect messages, causes, stacks or child pipes.
  return ["code", "signal", "killed"].map((key, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (!descriptor) return [0, null];
    if (!Object.hasOwn(descriptor, "value")) return [3, null];
    const value = descriptor.value;
    if (value === undefined) return [1, null];
    const valid = index === 0 ? Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647
      : index === 1 ? value === null || ["SIGTERM", "SIGKILL", "SIGABRT", "SIGINT"].includes(value) : typeof value === "boolean";
    return valid ? [2, value] : [4, null];
  });
}

export async function observePrivateExec(options, readCopied, run) {
  validatePrivateExecRequest(options);
  if (options.executionContract !== undefined) assert.match(options.executionContract, /^[a-f0-9]{64}$/);
  const { sourceHead, testPath, privateExec } = options;
  const binding = Object.freeze({ token: privateExec.token, sourceHead, testPath,
    fixtureSha256: privateExec.fixtureSha256, fixtureBytes: privateExec.fixtureBytes,
    command: "pnpm", args: Object.freeze(["test", testPath, "--maxWorkers=1"]),
    ...(options.executionContract === undefined ? {} : { executionContract: options.executionContract }) });
  const publish = privateExec.onOutcome, failures = []; let original, value, reason, state = "threw", phase = "copy", fields = null;
  try {
    const snapshot = readCopied();
    state = "rejected";
    const bytes = await snapshot;
    assert.equal(bytes.length, binding.fixtureBytes);
    assert.equal(sha256(bytes), binding.fixtureSha256, "copied Private fixture digest changed");
    phase = "exec"; state = "threw";
    original = run(); // Retain the one original promise before its existing await.
    state = "rejected";
    value = await original;
    state = "fulfilled";
  } catch (error) { reason = error; failures.push(error); }
  if (phase === "exec" && state !== "fulfilled") {
    try { fields = privateExecProcessFields(reason); } catch (error) { failures.push(error); }
  }
  try { await publish(Object.freeze({ binding, original, phase, state,
    errorPresent: state !== "fulfilled", errorDefined: state === "fulfilled" ? null : reason !== undefined, fields })); }
  catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Private exec and observation failed");
  return value;
}

export function validateRunnerRequest({ sourceHead, testPath, env, runnerReport }) {
  runnerPlan(sourceHead, testPath);
  const keys = ["expectedInvocations", "fixtureSha256", "onReport", "reporterSha256"];
  if (Object.hasOwn(runnerReport, "valueObserverSha256")) {
    assert.equal(testPath, runnerContract.target, "value observer requires its Qwen target");
    keys.push("valueObserverSha256");
    assert.match(runnerReport.valueObserverSha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(Object.keys(runnerReport).sort(), keys.sort());
  assert.equal(runnerReport.expectedInvocations, 1, "unsupported native diagnostic cardinality");
  assert.equal(typeof runnerReport.onReport, "function");
  for (const key of ["fixtureSha256", "reporterSha256"]) assert.match(runnerReport[key], /^[a-f0-9]{64}$/);
  for (const key of Object.keys(env ?? {})) {
    assert.ok(!/^(?:OPENCLAW_(?:VITEST|TEST|GATEWAY)|VITEST|VITE|NODE_|BUN|PNPM)/.test(key) &&
      !["CI", "PATH", "HOME", "TMPDIR"].includes(key), "unsupported native diagnostic environment override");
  }
}

// All phases are joined independently. A rejected value of undefined is still a failure.
export async function settleRunnerReport(run, collect, remove, publish) {
  const failures = []; let value; let packet;
  try { value = await run(); } catch (error) { failures.push(error); }
  try { packet = await collect(); } catch (error) { failures.push(error); }
  try { await remove(); } catch (error) { failures.push(error); }
  if (packet !== undefined) {
    try { await publish(packet); } catch (error) { failures.push(error); }
    if (!packet.complete) failures.push(new Error("native runner report incomplete; startup and execution remain unknown"));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "native runner, report or cleanup failed");
  return value;
}

export async function withNativeRunnerReport(options, run) {
  validateRunnerRequest(options);
  const { source, fixture, runnerReport } = options;
  const reporterSource = fileURLToPath(new URL("./openclaw-runner-reporter.mjs", import.meta.url));
  const reporterBytes = await readFile(reporterSource);
  assert.equal(sha256(reporterBytes), runnerReport.reporterSha256, "reporter bytes changed");
  assert.equal(sha256(await readFile(fixture)), runnerReport.fixtureSha256, "fixture bytes changed");
  const binding = { ...runnerPlan(options.sourceHead, options.testPath), fixtureSha256: runnerReport.fixtureSha256,
    reporterSha256: runnerReport.reporterSha256, nonce: randomBytes(32).toString("hex") };
  let valueBundle, valueHelper;
  if (runnerReport.valueObserverSha256 !== undefined) {
    valueHelper = await readFile(new URL("./openclaw-qwen-callsite-observer.mjs", import.meta.url));
    assert.equal(sha256(valueHelper), runnerReport.valueObserverSha256, "value observer bytes changed");
    valueBundle = makeQwenValuePlan({ nonce: binding.nonce, helperSHA: runnerReport.valueObserverSha256,
      fixtureSHA: binding.fixtureSha256,
      originals: qwenValueSources.map(row => readQwenValueInput(join(source, row.path), row.sha256)) });
    binding.callsite = { ...valueBundle.plan, configSHA: valueBundle.configSHA };
  }
  validateBinding(binding);
  const publish = runnerReport.onReport;
  const directory = await mkdtemp(join(resolve(source), ".clawrouter-runner-report-"));
  const owned = new Map();
  async function ownedWrite(name, bytes, mode) {
    await writeFile(join(directory, name), bytes, { flag: "wx", mode });
    owned.set(name, await lstat(join(directory, name)));
  }
  async function removeOwnedOverlay() {
    const failures = [];
    // Unknown entries are retained. Never recursively erase a foreign file.
    for (const [name, before] of owned) {
      try {
        const after = await lstat(join(directory, name));
        assert.ok(after.isFile() && after.ino === before.ino && after.dev === before.dev &&
          after.uid === process.getuid() && after.nlink === 1, "overlay cleanup identity changed");
        await rm(join(directory, name));
      } catch (error) { failures.push(error); }
    }
    try { assert.deepEqual(await readdir(directory), []); await rmdir(directory); }
    catch (error) { failures.push(error); }
    try { execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: source }); }
    catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "overlay cleanup and pinned SDK cleanliness failed");
  }
  // Required temporary input/report artifacts are owned only by this invocation.
  return settleRunnerReport(async () => {
    await chmod(directory, 0o700);
    await ownedWrite("plan.json", JSON.stringify(binding), 0o600);
    const reporter = join(directory, "reporter.mjs");
    await ownedWrite("reporter.mjs", reporterBytes, 0o400);
    if (valueBundle) {
      await ownedWrite("callsite-observer.mjs", valueHelper, 0o400);
      await ownedWrite("worker-values.mjs", valueBundle.virtualSource, 0o600);
      await ownedWrite("qwen-callsite.config.ts", valueBundle.config, 0o600);
    }
    return run(["--reporter=default", `--reporter=${reporter}`, `--outputFile=${join(directory, "report.jsonl")}`],
      valueBundle ? directory : undefined);
  }, async () => {
    try {
      const file = join(directory, "report.jsonl");
      const bytes = readPrivateFile(file, reportByteLimit);
      const stat = await lstat(file);
      assert.ok(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600);
      owned.set("report.jsonl", stat);
      return parseRunnerReport(bytes, binding);
    }
    catch (error) {
      // Only a real missing file is an absent reporter. Other read/validation errors remain failures.
      const code = error !== null && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
      if (code && Object.hasOwn(code, "value") && code.value === "ENOENT") {
        return { complete: false, records: [], bytes: 0, sha256: null, reporter: "absent" };
      }
      throw error;
    }
  }, valueBundle ? removeOwnedOverlay : () => rm(directory, { recursive: true }), publish);
}

export async function withCopiedConsumerFixture(copy, run, remove) {
  // A failed exclusive copy never owns the target, including a competing fixture.
  await copy();
  let result;
  try {
    result = await run();
  } catch (error) {
    try {
      await remove();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "OpenClaw consumer and fixture removal failed");
    }
    throw error;
  }
  await remove();
  return result;
}
