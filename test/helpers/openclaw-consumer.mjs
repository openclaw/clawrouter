import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, rm, rmdir, readdir, lstat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { makeQwenValuePlan, qwenValueArgv, qwenValueSources, readQwenValueInput } from "./openclaw-qwen-callsite-observer.mjs";
import { parseRunnerReport, readPrivateFile, reportByteLimit, runnerContract, sha256, validateBinding } from "./openclaw-runner-reporter.mjs";

export async function runOpenClawConsumer(t, { source, sourceHead, fixture, env, testPath = "extensions/clawrouter/worker-contract.test.ts", runnerReport }) {
  assert.equal(process.env.CI, "true", "the public client uses its own native install in ephemeral CI only");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), sourceHead);
  if (runnerReport !== undefined) {
    validateRunnerRequest({ sourceHead, testPath, env, runnerReport });
    assert.equal(process.version, "v24.22.1", "unqualified native diagnostic runtime");
    // The source-qualified plan cannot borrow dirty native runner or configuration inputs.
    execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: source });
  }
  const clientTest = join(resolve(source), testPath);
  await withCopiedConsumerFixture(() => copyFile(fixture, clientTest, constants.COPYFILE_EXCL), async () => {
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
    const started = performance.now();
    const result = await promisify(execFile)("pnpm", ["test", testPath, "--maxWorkers=1"], {
      // The native runner compiles its own SDK worker graph on a cold CI host.
      cwd: source, timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: "true", ...env },
    });
    t.diagnostic(`OpenClaw ${sourceHead}; native test wall time ${Math.round(performance.now() - started)}ms\n${result.stdout}`);
  }, () => rm(clientTest));
}

export function validateRunnerRequest({ sourceHead, testPath, env, runnerReport }) {
  assert.equal(sourceHead, runnerContract.pin, "unsupported native diagnostic pin");
  assert.equal(testPath, runnerContract.target, "unsupported native diagnostic target");
  const keys = ["expectedInvocations", "fixtureSha256", "onReport", "reporterSha256"];
  if (Object.hasOwn(runnerReport, "valueObserverSha256")) {
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
  const binding = { ...runnerContract, fixtureSha256: runnerReport.fixtureSha256,
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
