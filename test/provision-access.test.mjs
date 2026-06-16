import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Access provisioning protects the browser OAuth callback by default", () => {
  const result = spawnSync("node", ["scripts/provision-access.mjs", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: "account-placeholder",
      CLAWROUTER_ACCESS_ALLOWED_DOMAINS: "example.com",
      CLAWROUTER_ACCESS_DOMAIN: "clawrouter.example.com",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /clawrouter\.example\.com\/dashboard\/\*/);
  assert.match(result.stdout, /clawrouter\.example\.com\/v1\/admin\/\*/);
  assert.match(result.stdout, /clawrouter\.example\.com\/v1\/oauth\/callback/);
});
