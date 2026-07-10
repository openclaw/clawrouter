import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("remote key provisioning requires the authoritative admin API", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-key-put-remote-test-"));
  const logPath = join(dir, "commands.log");
  const fakePnpm = join(dir, "pnpm");
  writeFileSync(
    fakePnpm,
    [
      "#!/usr/bin/env node",
      'require("node:fs").appendFileSync(process.env.CLAWROUTER_TEST_LOG, "called\\n");',
    ].join("\n"),
  );
  chmodSync(fakePnpm, 0o755);
  const env = {
    ...process.env,
    CLAWROUTER_TEST_LOG: logPath,
    PATH: `${dir}:${process.env.PATH}`,
  };
  delete env.CLAWROUTER_BASE_URL;
  delete env.CLAWROUTER_ADMIN_TOKEN;

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
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        input: "test-secret\n",
        env,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLAWROUTER_BASE_URL is required for remote key mutations/);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("key provisioning activates the policy only after dependent records", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-key-put-test-"));
  const logPath = join(dir, "commands.log");
  const payloadLogPath = join(dir, "payloads.log");
  const fakePnpm = join(dir, "pnpm");
  writeFileSync(
    fakePnpm,
    [
      "#!/usr/bin/env node",
      'const { appendFileSync, readFileSync } = require("node:fs");',
      'const args = process.argv.slice(2);',
      'appendFileSync(process.env.CLAWROUTER_TEST_LOG, `${args.join(" ")}\\n`);',
      'if (args.indexOf("get") !== -1) { console.log("Value not found"); process.exit(0); }',
      'const pathIndex = args.indexOf("--path");',
      'const putIndex = args.indexOf("put");',
      'if (pathIndex !== -1 && putIndex !== -1) appendFileSync(process.env.CLAWROUTER_TEST_PAYLOAD_LOG, `${JSON.stringify({ key: args[putIndex + 1], value: JSON.parse(readFileSync(args[pathIndex + 1], "utf8")) })}\\n`);',
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
          CLAWROUTER_DEPLOY_ENV: "fakeco",
          CLAWROUTER_TEST_LOG: logPath,
          CLAWROUTER_TEST_PAYLOAD_LOG: payloadLogPath,
          PATH: `${dir}:${process.env.PATH}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const keys = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" put ")[1]?.split(" ")[0])
      .filter(Boolean);
    assert.deepEqual(keys, [
      "credentials/smoke",
      "keys/smoke",
      "policies/smoke",
      "credentials/smoke",
      "policies/smoke",
    ]);
    const payloads = readFileSync(payloadLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const policy = payloads.findLast(({ key }) => key === "policies/smoke").value;
    const credential = payloads.findLast(({ key }) => key === "credentials/smoke").value;
    const policyWrites = payloads.filter(({ key }) => key === "policies/smoke");
    const legacyWrites = payloads.filter(({ key }) => key === "keys/smoke");
    assert.deepEqual(policyWrites.map(({ value }) => value.enabled), [false, true]);
    assert.deepEqual(legacyWrites.map(({ value }) => value.enabled), [false]);
    assert.match(policy.generation, /^policy_/);
    assert.equal(policy.tenantId, "fakeco");
    assert.equal(policy.retainRequestContent, false);
    assert.equal(credential.policyGeneration, policy.generation);
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

test("key provisioning preserves an existing policy generation", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-key-put-existing-test-"));
  const payloadLogPath = join(dir, "payloads.log");
  const fakePnpm = join(dir, "pnpm");
  const secretSha256 = createHash("sha256").update("test-secret").digest("hex");
  writeFileSync(
    fakePnpm,
    [
      "#!/usr/bin/env node",
      'const { appendFileSync, readFileSync } = require("node:fs");',
      'const args = process.argv.slice(2);',
      'const getIndex = args.indexOf("get");',
      'const putIndex = args.indexOf("put");',
      'if (getIndex !== -1 && args[getIndex + 1] === "policies/smoke") console.log(JSON.stringify({ enabled: true, generation: "policy_existing", providers: ["openai"], tenantId: "default", retainRequestContent: true }));',
      `if (getIndex !== -1 && args[getIndex + 1] === "keys/smoke") console.log(JSON.stringify({ enabled: true, secretSha256: "${secretSha256}", generation: "legacy", providers: ["openai"], tenantId: "default" }));`,
      'if (getIndex !== -1 && !["policies/smoke", "keys/smoke"].includes(args[getIndex + 1])) console.log("Value not found");',
      'const pathIndex = args.indexOf("--path");',
      'if (pathIndex !== -1 && putIndex !== -1) appendFileSync(process.env.CLAWROUTER_TEST_PAYLOAD_LOG, `${JSON.stringify({ key: args[putIndex + 1], value: JSON.parse(readFileSync(args[pathIndex + 1], "utf8")) })}\\n`);',
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
        "openai,tavily",
        "--local",
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        input: "test-secret\n",
        env: {
          ...process.env,
          CLAWROUTER_DEPLOY_ENV: "fakeco",
          CLAWROUTER_TEST_PAYLOAD_LOG: payloadLogPath,
          PATH: `${dir}:${process.env.PATH}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const payloads = readFileSync(payloadLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const policy = payloads.findLast(({ key }) => key === "policies/smoke").value;
    const credential = payloads.findLast(({ key }) => key === "credentials/smoke").value;
    assert.equal(policy.generation, "policy_existing");
    assert.equal(policy.retainRequestContent, true);
    assert.equal(credential.policyGeneration, "policy_existing");

    const unsafe = spawnSync(
      process.execPath,
      [
        resolve("scripts/key-put.mjs"),
        "--kid",
        "smoke",
        "--secret-stdin",
        "--providers",
        "openai,tavily",
        "--local",
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        input: "new-secret\n",
        env: {
          ...process.env,
          CLAWROUTER_DEPLOY_ENV: "fakeco",
          CLAWROUTER_TEST_PAYLOAD_LOG: payloadLogPath,
          PATH: `${dir}:${process.env.PATH}`,
        },
      },
    );
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /cannot change policy scope and secret together/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
