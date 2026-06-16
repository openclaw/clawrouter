import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("oauth put writes a canonical upstream grant from non-argv secrets", () => {
  const fixture = scriptFixture();
  const refreshPath = join(fixture.dir, "refresh-token");
  writeFileSync(refreshPath, "refresh-token-placeholder\n", { mode: 0o600 });

  try {
    const result = runScript(
      "oauth-put.mjs",
      [
        "--kid",
        "svc_docs",
        "--token-ref",
        "openai-maintainer",
        "--kind",
        "subscription",
        "--provider",
        "openai",
        "--label",
        "maintainer subscription",
        "--access-token-env",
        "TEST_ACCESS_TOKEN",
        "--refresh-token-file",
        refreshPath,
        "--expires-at",
        "2026-06-16T12:00:00Z",
        "--scopes",
        "openid,profile,openid",
        "--account-id",
        "stable-account-id",
        "--subscription-plan",
        "plus",
        "--subscription-subject",
        "stable-subject-id",
        "--refresh-token-url",
        "https://provider.example/oauth/token",
        "--refresh-client-id-config",
        "PROVIDER_OAUTH_CLIENT_ID",
        "--refresh-client-secret-config",
        "PROVIDER_OAUTH_CLIENT_SECRET",
        "--refresh-extra-params-json",
        '{"audience":"provider-api"}',
        "--local",
      ],
      fixture,
      { TEST_ACCESS_TOKEN: "access-token-placeholder" },
    );

    assert.equal(result.status, 0, result.stderr);
    const [{ key, value }] = payloads(fixture.payloadLogPath);
    assert.equal(key, "oauth/svc_docs/openai-maintainer");
    assert.equal(value.version, 1);
    assert.equal(value.enabled, true);
    assert.equal(value.kind, "subscription");
    assert.equal(value.provider, "openai");
    assert.equal(value.label, "maintainer subscription");
    assert.equal(value.accessToken, "access-token-placeholder");
    assert.equal(value.refreshToken, "refresh-token-placeholder");
    assert.equal(value.credential, undefined);
    assert.equal(value.tokenType, "Bearer");
    assert.equal(value.expiresAt, "2026-06-16T12:00:00.000Z");
    assert.deepEqual(value.scopes, ["openid", "profile"]);
    assert.equal(value.accountId, "stable-account-id");
    assert.deepEqual(value.subscription, {
      plan: "plus",
      subject: "stable-subject-id",
    });
    assert.deepEqual(value.refresh, {
      tokenUrl: "https://provider.example/oauth/token",
      clientIdConfig: "PROVIDER_OAUTH_CLIENT_ID",
      clientSecretConfig: "PROVIDER_OAUTH_CLIENT_SECRET",
      extraParams: { audience: "provider-api" },
    });
    assert.match(value.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(value.updatedAt, value.createdAt);
    assert.doesNotMatch(readFileSync(fixture.commandLogPath, "utf8"), /access-token-placeholder/);
    assert.doesNotMatch(readFileSync(fixture.commandLogPath, "utf8"), /refresh-token-placeholder/);
  } finally {
    fixture.cleanup();
  }
});

test("oauth put supports api_key credentials from stdin and rejects argv secrets", () => {
  const fixture = scriptFixture();

  try {
    const result = runScript(
      "oauth-put.mjs",
      [
        "--tenant",
        "default",
        "--token-ref",
        "anthropic-primary",
        "--kind",
        "api_key",
        "--provider",
        "anthropic",
        "--label",
        "primary api key",
        "--credential-stdin",
        "--local",
      ],
      fixture,
      {},
      "api-key-placeholder\n",
    );
    assert.equal(result.status, 0, result.stderr);
    const [{ key, value }] = payloads(fixture.payloadLogPath);
    assert.equal(key, "oauth/tenants/default/anthropic-primary");
    assert.equal(value.credential, "api-key-placeholder");
    assert.equal(value.accessToken, undefined);

    for (const unsafeSecret of [
      { kind: "oauth", option: "--access-token", extraArgs: [] },
      { kind: "api_key", option: "--credential", extraArgs: [] },
      {
        kind: "oauth",
        option: "--refresh-token",
        extraArgs: ["--access-token-env", "TEST_ACCESS_TOKEN"],
      },
    ]) {
      const unsafe = runScript(
        "oauth-put.mjs",
        [
          "--kid",
          "svc_docs",
          "--kind",
          unsafeSecret.kind,
          "--provider",
          "openai",
          "--label",
          "unsafe",
          ...unsafeSecret.extraArgs,
          unsafeSecret.option,
          "argv-secret-placeholder",
          "--local",
        ],
        fixture,
        { TEST_ACCESS_TOKEN: "access-token-placeholder" },
      );
      assert.notEqual(unsafe.status, 0);
      assert.match(unsafe.stderr, /would expose the secret in process argv/);
    }
  } finally {
    fixture.cleanup();
  }
});

test("oauth put accepts a public literal refresh client id", () => {
  const fixture = scriptFixture();

  try {
    const result = runScript(
      "oauth-put.mjs",
      [
        "--kid",
        "svc_docs",
        "--provider",
        "openai",
        "--kind",
        "oauth",
        "--access-token-env",
        "TEST_ACCESS_TOKEN",
        "--refresh-token-url",
        "https://provider.example/oauth/token",
        "--refresh-client-id",
        "public-client-id",
        "--local",
      ],
      fixture,
      { TEST_ACCESS_TOKEN: "access-token-placeholder" },
    );
    assert.equal(result.status, 0, result.stderr);
    const [{ value }] = payloads(fixture.payloadLogPath);
    assert.deepEqual(value.refresh, {
      tokenUrl: "https://provider.example/oauth/token",
      clientId: "public-client-id",
      extraParams: {},
    });
  } finally {
    fixture.cleanup();
  }
});

test("oauth revoke preserves canonical metadata and removes secrets recursively", () => {
  const fixture = scriptFixture({
    getValue: JSON.stringify({
      version: 1,
      enabled: true,
      kind: "oauth",
      provider: "openai",
      label: "maintainer subscription",
      tokenType: "Bearer",
      accessToken: "access-token-placeholder",
      refreshToken: "refresh-token-placeholder",
      credential: "credential-placeholder",
      expiresAt: "2026-06-16T12:00:00Z",
      scopes: ["openid"],
      accountId: "stable-account-id",
      subscription: { plan: "plus", subject: "stable-subject-id" },
      refresh: {
        tokenUrl: "https://provider.example/oauth/token",
        clientIdConfig: "PROVIDER_OAUTH_CLIENT_ID",
        clientSecretConfig: "PROVIDER_OAUTH_CLIENT_SECRET",
        extraParams: {
          audience: "provider-api",
          client_secret: "nested-secret-placeholder",
        },
      },
      createdAt: "2026-06-16T00:00:00Z",
      updatedAt: "2026-06-16T01:00:00Z",
    }),
  });

  try {
    const result = runScript(
      "oauth-revoke.mjs",
      ["--kid", "svc_docs", "--token-ref", "openai-maintainer", "--local"],
      fixture,
    );
    assert.equal(result.status, 0, result.stderr);
    const [{ value }] = payloads(fixture.payloadLogPath);
    assert.equal(value.version, 1);
    assert.equal(value.enabled, false);
    assert.equal(value.provider, "openai");
    assert.equal(value.label, "maintainer subscription");
    assert.equal(value.accountId, "stable-account-id");
    assert.equal(value.createdAt, "2026-06-16T00:00:00Z");
    assert.equal(value.updatedAt, value.revokedAt);
    assert.equal(value.accessToken, undefined);
    assert.equal(value.refreshToken, undefined);
    assert.equal(value.credential, undefined);
    assert.deepEqual(value.refresh.extraParams, { audience: "provider-api" });
    assert.doesNotMatch(JSON.stringify(value), /placeholder/);
  } finally {
    fixture.cleanup();
  }
});

function scriptFixture({ getValue = "Value not found" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-oauth-grant-test-"));
  const commandLogPath = join(dir, "commands.log");
  const payloadLogPath = join(dir, "payloads.log");
  const fakePnpm = join(dir, "pnpm");
  writeFileSync(
    fakePnpm,
    [
      "#!/usr/bin/env node",
      'const { appendFileSync, readFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      'appendFileSync(process.env.CLAWROUTER_TEST_COMMAND_LOG, `${args.join(" ")}\\n`);',
      'if (args.includes("get")) { process.stdout.write(process.env.CLAWROUTER_TEST_GET_VALUE); process.exit(0); }',
      'const pathIndex = args.indexOf("--path");',
      'const putIndex = args.indexOf("put");',
      'if (pathIndex !== -1 && putIndex !== -1) appendFileSync(process.env.CLAWROUTER_TEST_PAYLOAD_LOG, `${JSON.stringify({ key: args[putIndex + 1], value: JSON.parse(readFileSync(args[pathIndex + 1], "utf8")) })}\\n`);',
    ].join("\n"),
  );
  chmodSync(fakePnpm, 0o755);
  return {
    dir,
    commandLogPath,
    payloadLogPath,
    env: {
      CLAWROUTER_TEST_COMMAND_LOG: commandLogPath,
      CLAWROUTER_TEST_PAYLOAD_LOG: payloadLogPath,
      CLAWROUTER_TEST_GET_VALUE: getValue,
      PATH: `${dir}:${process.env.PATH}`,
    },
    cleanup() {
      rmSync(dir, { force: true, recursive: true });
    },
  };
}

function runScript(name, args, fixture, extraEnv = {}, input) {
  return spawnSync(process.execPath, [resolve("scripts", name), ...args], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, ...fixture.env, ...extraEnv },
    input,
  });
}

function payloads(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
