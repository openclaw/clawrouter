import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { waitForChildExit } from "../scripts/smoke-process.mjs";

for (const alreadyExited of [false, true]) {
  test(`child exit wait leaves no live deadline (${alreadyExited ? "already exited" : "running"})`, () => {
    const helper = new URL("../scripts/smoke-process.mjs", import.meta.url).href;
    const source = `
      import assert from "node:assert/strict";
      import { spawn } from "node:child_process";
      import { once } from "node:events";
      import { waitForChildExit } from ${JSON.stringify(helper)};
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      ${alreadyExited ? 'await once(child, "exit");' : ""}
      assert.equal(await waitForChildExit(child, 30_000), true);
      console.log("exited");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "exited\n");
  });
}

test("exit wait remains bounded without terminating a live child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    assert.equal(await waitForChildExit(child, 20), false);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
});
