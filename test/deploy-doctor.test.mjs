import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("deploy doctor does not require deployed provider secrets locally", () => {
  const result = spawnSync(process.execPath, [resolve("scripts/deploy-doctor.mjs")], {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLAWROUTER_ADMIN_TOKEN_SHA256: "a".repeat(64),
      CLAWROUTER_POLICY_KV_ID: "test-kv",
      CLAWROUTER_BASE_URL: "https://clawrouter.example",
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
