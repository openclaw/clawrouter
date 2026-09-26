import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

import {
  configuredProviderSecrets,
  providerSecretNames,
} from "../scripts/put-provider-secrets.mjs";

test("provider secret selection keeps only the declared non-empty bindings", () => {
  assert.deepEqual(
    configuredProviderSecrets({
      CLOUDFLARE_API_TOKEN: "deploy-token-must-not-be-uploaded",
      AWS_REGION: "us-west-2",
      OPENAI_API_KEY: "secret",
      OPENROUTER_SITE_URL: "https://example.com",
      XAI_API_KEY: "",
    }),
    { OPENAI_API_KEY: "secret" },
  );
  assert.deepEqual(
    configuredProviderSecrets({
      CLAWROUTER_PROVIDER_CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLAWROUTER_PROVIDER_CLOUDFLARE_API_TOKEN: "gateway-token",
    }),
    {
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_API_TOKEN: "gateway-token",
    },
  );
  assert.equal(providerSecretNames.includes("COHERE_API_KEY"), true);
  assert.equal(providerSecretNames.includes("REPLICATE_API_TOKEN"), true);
  assert.equal(providerSecretNames.includes("TAVILY_API_KEY"), true);
  assert.equal(providerSecretNames.includes("AWS_REGION"), false);
});

test("production deploy uploads Lanseq only when its transport secret is configured", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy-cloudflare.yml", "utf8"));
  const upload = workflow.jobs.deploy.steps.find((step) => step.run === "pnpm cf:secrets");
  assert.equal(upload.env.LANSEQ_API_KEY, "${{ secrets.CLAWROUTER_PROVIDER_LANSEQ_API_KEY }}");
  for (const value of [undefined, "", "fixture-lanseq-secret"]) {
    assert.deepEqual(
      configuredProviderSecrets({ OPENAI_API_KEY: "fixture-openai-secret", LANSEQ_API_KEY: value }),
      { OPENAI_API_KEY: "fixture-openai-secret", ...(value ? { LANSEQ_API_KEY: value } : {}) },
    );
  }
});

test("provider secret dry-run reports names without values", () => {
  const result = spawnSync("node", ["scripts/put-provider-secrets.mjs", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, OPENAI_API_KEY: "must-not-be-printed", LANSEQ_API_KEY: "lanseq-must-not-be-printed" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OPENAI_API_KEY/);
  assert.match(result.stdout, /LANSEQ_API_KEY/);
  assert.doesNotMatch(result.stdout, /must-not-be-printed/);
});
