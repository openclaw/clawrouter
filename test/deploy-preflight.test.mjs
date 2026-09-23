import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

const env = {
  CLOUDFLARE_API_TOKEN: "fixture-token", CLOUDFLARE_ACCOUNT_ID: "fixture-account",
  CLAWROUTER_POLICY_KV_ID: "fixture-kv", CLAWROUTER_ADMIN_TOKEN: "fixture-admin",
  CLAWROUTER_ADMIN_TOKEN_SHA256: createHash("sha256").update("fixture-admin").digest("hex"),
};

function preflight(overrides = {}) {
  const source = `
    globalThis.fetch = async (url, init = {}) => {
      if (new URL(url).origin !== "https://api.cloudflare.com") throw new Error("unexpected fixture target");
      console.log("fixture fetch " + (init.method ?? "GET"));
      return Response.json({ success: true, result: {} });
    };
    await import(${JSON.stringify(new URL("../scripts/deploy-preflight.mjs", import.meta.url).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...env, ...overrides }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

for (const [label, overrides, error] of [
  ["missing raw token", { CLAWROUTER_ADMIN_TOKEN: "" }, /missing required deploy env: CLAWROUTER_ADMIN_TOKEN/],
  ["blank raw token", { CLAWROUTER_ADMIN_TOKEN: "   " }, /missing required deploy env: CLAWROUTER_ADMIN_TOKEN/],
  ["mismatched raw token", { CLAWROUTER_ADMIN_TOKEN: "different-fixture" }, /must match CLAWROUTER_ADMIN_TOKEN_SHA256/],
  ["invalid digest", { CLAWROUTER_ADMIN_TOKEN_SHA256: "invalid" }, /64-character hex/],
  ["partial Access pair", { CF_ACCESS_CLIENT_ID: "fixture-client" }, /must be configured together/],
  ["blank Cloudflare account", { CLOUDFLARE_ACCOUNT_ID: "   " }, /missing required deploy env: CLOUDFLARE_ACCOUNT_ID/],
  ["invalid base URL", { CLAWROUTER_BASE_URL: "invalid" }, /valid absolute URL/],
]) test(`deploy preflight rejects ${label} before any remote probe`, () => {
  const result = preflight(overrides);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, error);
  assert.doesNotMatch(result.stdout, /fixture fetch/);
});

test("valid trimmed inputs retain the Worker read and KV permission probe", () => {
  const result = preflight({ CLAWROUTER_ADMIN_TOKEN: " fixture-admin ", CF_ACCESS_CLIENT_ID: "fixture-client", CF_ACCESS_CLIENT_SECRET: "fixture-secret" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.match(/fixture fetch \w+/g), ["fixture fetch GET", "fixture fetch PUT", "fixture fetch DELETE"]);
  assert.match(result.stdout, /deploy preflight passed/);
});
