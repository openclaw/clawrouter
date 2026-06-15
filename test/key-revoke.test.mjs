import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("key revocation leaves the referenced policy enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-key-revoke-test-"));
  const logPath = join(dir, "commands.log");
  const fakePnpm = join(dir, "pnpm");
  writeFileSync(
    fakePnpm,
    [
      "#!/usr/bin/env node",
      'const { appendFileSync } = require("node:fs");',
      'const args = process.argv.slice(2);',
      'appendFileSync(process.env.CLAWROUTER_TEST_LOG, `${args.join(" ")}\\n`);',
      'const getIndex = args.indexOf("get");',
      'if (getIndex !== -1) {',
      '  const key = args[getIndex + 1];',
      '  if (key === "credentials/issued") {',
      '    process.stdout.write(JSON.stringify({ enabled: true, secretSha256: "a".repeat(64), policyId: "shared_policy" }));',
      '    process.exit(0);',
      '  }',
      '  process.stdout.write("Value not found");',
      '  process.exit(0);',
      '}',
    ].join("\n"),
  );
  chmodSync(fakePnpm, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/key-revoke.mjs"), "--kid", "issued", "--local"],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWROUTER_TEST_LOG: logPath,
          PATH: `${dir}:${process.env.PATH}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const putKeys = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.includes(" put "))
      .map((line) => line.split(" put ")[1]?.split(" ")[0]);
    assert.deepEqual(putKeys, ["credentials/issued"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
