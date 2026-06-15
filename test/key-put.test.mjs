import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("key provisioning activates the canonical credential last", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-key-put-test-"));
  const logPath = join(dir, "commands.log");
  const fakePnpm = join(dir, "pnpm");
  writeFileSync(
    fakePnpm,
    [
      "#!/usr/bin/env node",
      'const { appendFileSync } = require("node:fs");',
      'appendFileSync(process.env.CLAWROUTER_TEST_LOG, `${process.argv.slice(2).join(" ")}\\n`);',
    ].join("\n"),
  );
  chmodSync(fakePnpm, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/key-put.mjs"),
        "--kid",
        "smoke",
        "--secret-stdin",
        "--providers",
        "openai",
        "--local",
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        input: "test-secret\n",
        env: {
          ...process.env,
          CLAWROUTER_TEST_LOG: logPath,
          PATH: `${dir}:${process.env.PATH}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const keys = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" put ")[1]?.split(" ")[0]);
    assert.deepEqual(keys, [
      "credentials/smoke",
      "keys/smoke",
      "policies/smoke",
      "keys/smoke",
      "credentials/smoke",
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("key provisioning requires explicit wildcard intent", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/key-put.mjs"), "--kid", "smoke", "--secret-stdin", "--local"],
    {
      cwd: resolve("."),
      encoding: "utf8",
      input: "test-secret\n",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--providers or --all-providers is required/);
});
