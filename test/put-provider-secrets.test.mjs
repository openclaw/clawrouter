import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  configuredProviderSecrets,
  providerSecretNames,
} from "../scripts/provider-secret-inputs.mjs";

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
});

test("provider transport selection includes Lanseq only when configured", () => {
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


test("legacy provider secret exports retain their owner identities", async () => {
  const legacy = await import("../scripts/put-provider-secrets.mjs");
  assert.equal(legacy.configuredProviderSecrets, configuredProviderSecrets);
  assert.equal(legacy.providerSecretNames, providerSecretNames);
});

test("provider secret selection preserves string and source boundaries", () => {
  for (const value of [undefined, null, false, 0, "", " ", "synthetic-value"]) {
    const selected = typeof value === "string" && value.length > 0;
    assert.deepEqual(configuredProviderSecrets({ OPENAI_API_KEY: value }),
      selected ? { OPENAI_API_KEY: value } : {});
    assert.deepEqual(configuredProviderSecrets({
      CLOUDFLARE_ACCOUNT_ID: "deployment-account",
      CLOUDFLARE_API_TOKEN: "deployment-token",
      CLOUDFLARE_AI_GATEWAY_ID: "deployment-gateway",
      CLAWROUTER_PROVIDER_CLOUDFLARE_ACCOUNT_ID: value,
      CLAWROUTER_PROVIDER_CLOUDFLARE_API_TOKEN: value,
      CLAWROUTER_PROVIDER_CLOUDFLARE_AI_GATEWAY_ID: value,
      OPENROUTER_API_KEY: value,
      OPENROUTER_SITE_URL: "https://example.com",
    }), selected ? {
      CLOUDFLARE_ACCOUNT_ID: value,
      CLOUDFLARE_AI_GATEWAY_ID: value,
      CLOUDFLARE_API_TOKEN: value,
      OPENROUTER_API_KEY: value,
      OPENROUTER_SITE_URL: "https://example.com",
    } : {});
  }
});

test("provider secret selection reads its default environment at call time", () => {
  const original = process.env;
  try {
    process.env = { OPENAI_API_KEY: "first-synthetic-value" };
    assert.deepEqual(configuredProviderSecrets(), { OPENAI_API_KEY: "first-synthetic-value" });
    process.env = { XAI_API_KEY: "second-synthetic-value" };
    assert.deepEqual(configuredProviderSecrets(), { XAI_API_KEY: "second-synthetic-value" });
  } finally {
    process.env = original;
  }
});
