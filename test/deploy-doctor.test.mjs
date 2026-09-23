import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("deploy doctor does not require deployed provider secrets locally", async t => {
  const baseUrl = await readinessServer(t);
  const result = await runDoctor({
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLAWROUTER_ADMIN_TOKEN_SHA256: createHash("sha256").update("doctor-admin").digest("hex"),
      CLAWROUTER_ADMIN_TOKEN: "doctor-admin",
      CLAWROUTER_POLICY_KV_ID: "test-kv",
      CLAWROUTER_BASE_URL: baseUrl,
      CLAWROUTER_SMOKE_KEY: "clawrouter-live-smoke-secret",
      CLAWROUTER_SMOKE_LIVE_PROVIDERS: "openai",
      CLAWROUTER_DOCTOR_SKIP_WRANGLER: "1",
      CLAWROUTER_DOCTOR_SKIP_CLOUDFLARE_API: "1",
      CLAWROUTER_DOCTOR_SKIP_GITHUB: "1",
      OPENAI_API_KEY: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /live provider config is not present locally; deployed smoke will verify Worker bindings: openai\(OPENAI_API_KEY\)/,
  );
  assert.match(result.stdout, /clawrouter deploy doctor passed/);
});

test("deploy doctor requires the repository smoke key secret", async t => {
  const baseUrl = await readinessServer(t);
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-doctor-"));
  const fakeGitHub = join(dir, "ghx");
  writeFileSync(
    fakeGitHub,
    [
      "#!/usr/bin/env node",
      'const kind = process.argv[2];',
      'if (kind === "secret") console.log(JSON.stringify(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLAWROUTER_ADMIN_TOKEN_SHA256", "CLAWROUTER_ADMIN_TOKEN", "CLAWROUTER_POLICY_KV_ID"].map((name) => ({ name }))));',
      'else console.log("[]");',
    ].join("\n"),
  );
  chmodSync(fakeGitHub, 0o755);

  try {
    const result = await runDoctor({
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "test-token",
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLAWROUTER_ADMIN_TOKEN_SHA256: createHash("sha256").update("doctor-admin").digest("hex"),
        CLAWROUTER_ADMIN_TOKEN: "doctor-admin",
        CLAWROUTER_POLICY_KV_ID: "test-kv",
        CLAWROUTER_BASE_URL: baseUrl,
        CLAWROUTER_SMOKE_KEY: "clawrouter-live-smoke-secret",
        CLAWROUTER_SMOKE_LIVE_PROVIDERS: "openai",
        CLAWROUTER_DOCTOR_SKIP_WRANGLER: "1",
        CLAWROUTER_DOCTOR_SKIP_CLOUDFLARE_API: "1",
        CLAWROUTER_GITHUB_CLI: fakeGitHub,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /missing GitHub Actions secrets for openclaw\/clawrouter: CLAWROUTER_SMOKE_KEY/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

async function readinessServer(t) {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/admin/grant-pools/readiness");
    assert.equal(request.headers.authorization, "Bearer doctor-admin");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ activatedAt: "2026-09-23T00:00:00Z", revision: 3 }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function runDoctor(options) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve("scripts/deploy-doctor.mjs")], { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", status => resolveResult({ status, stdout, stderr }));
  });
}
