import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("rendered config keeps the usage queue and dead-letter queue distinct", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-wrangler-test-"));
  const target = join(dir, "wrangler.toml");

  try {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/render-wrangler-config.mjs"), resolve("wrangler.toml"), target],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWROUTER_STRICT_CONFIG: "0",
          CLAWROUTER_USAGE_QUEUE: "test-usage",
          CLAWROUTER_USAGE_DLQ: "test-usage-dead-letter",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const config = readFileSync(target, "utf8");
    assert.equal(config.match(/^queue = "test-usage"$/gm)?.length, 2);
    assert.match(config, /^dead_letter_queue = "test-usage-dead-letter"$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
