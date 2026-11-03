import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Independent runs of the original real-TCP fixture, never retries of failures.
// Keep every result and fail if any run fails. No production/provider changes.
const run = promisify(execFile);
const deadline = AbortSignal.timeout(90_000);
let failures = 0;
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  trials: 24, concurrency: 4, deadlineMs: 90_000 }));
for (let wave = 0; wave < 6; wave++) {
  deadline.throwIfAborted();
  await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const trial = wave * 4 + index + 1;
    try {
      await run(process.execPath, ["--test", "test/transcription-workerd.test.mjs"], {
        timeout: 35_000, maxBuffer: 2 * 1024 * 1024, signal: deadline,
      });
      console.log(JSON.stringify({ trial, result: "passed" }));
    } catch (error) {
      failures++;
      const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
      const phase = output.match(/transcription fixture failed during ([^\r\n]+)/)?.[1] ?? "unavailable";
      const transport = output.includes("EPIPE") ? "EPIPE" : output.includes("ECONNRESET") ? "ECONNRESET" : "unavailable";
      console.log(JSON.stringify({ trial, result: "failed", phase, transport, killed: !!error.killed,
        exitCode: error.code, signal: error.signal ?? null }));
    }
  }));
}
console.log(JSON.stringify({ trials: 24, failures }));
process.exitCode = failures ? 1 : 0;
