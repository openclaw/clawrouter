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
  assert.doesNotMatch(result.stdout, /clawrouter\.example\.com\/v1\/entitlements/);
  const destinations = result.stdout.match(/^destinations=(.+)$/m)?.[1].split(",") ?? [];
  assert.equal(destinations.length, 5);
});

test("Access provisioning supports an exact GitHub organization rule", () => {
  const result = spawnSync("node", ["scripts/provision-access.mjs", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: "account-placeholder",
      CLAWROUTER_ACCESS_ALLOWED_EMAILS: "",
      CLAWROUTER_ACCESS_ALLOWED_DOMAINS: "",
      CLAWROUTER_ACCESS_ADMIN_EMAILS: "break-glass@example.com",
      CLAWROUTER_ACCESS_ADMIN_DOMAINS: "example.com",
      CLAWROUTER_ACCESS_GITHUB_ORGS: "openclaw,openclaw/maintainers",
      CLAWROUTER_ACCESS_DOMAIN: "clawrouter.example.com",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^githubOrganizations=openclaw,openclaw\/maintainers$/m);
  assert.match(result.stdout, /^policy=ClawRouter Console Users decision=allow$/m);
  assert.match(result.stdout, /^humanIncludeKinds=github-organization$/m);
});

test("Access provisioning rejects malformed GitHub organization selectors", () => {
  const result = spawnSync("node", ["scripts/provision-access.mjs", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: "account-placeholder",
      CLAWROUTER_ACCESS_ALLOWED_EMAILS: "",
      CLAWROUTER_ACCESS_ALLOWED_DOMAINS: "",
      CLAWROUTER_ACCESS_ADMIN_EMAILS: "",
      CLAWROUTER_ACCESS_ADMIN_DOMAINS: "",
      CLAWROUTER_ACCESS_GITHUB_ORGS: "openclaw/team/extra",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid GitHub organization rule/);
});
