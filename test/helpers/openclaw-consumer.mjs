import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export async function runOpenClawConsumer(t, { source, sourceHead, fixture, env }) {
  assert.equal(process.env.CI, "true", "the public client uses its own native install in ephemeral CI only");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), sourceHead);
  const clientTest = join(resolve(source), "extensions/clawrouter/worker-contract.test.ts");
  await copyFile(fixture, clientTest, constants.COPYFILE_EXCL);
  try {
    const started = performance.now();
    const result = await promisify(execFile)("pnpm", ["test", "extensions/clawrouter/worker-contract.test.ts", "--maxWorkers=1"], {
      // The native runner compiles its own SDK worker graph on a cold CI host.
      cwd: source, timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: "true", ...env },
    });
    t.diagnostic(`OpenClaw ${sourceHead}; native test wall time ${Math.round(performance.now() - started)}ms\n${result.stdout}`);
  } finally {
    await rm(clientTest);
  }
}
