import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("the standard deploy path provisions required content storage", () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.match(pkg.scripts["cf:deploy"], /pnpm cf:content:provision/);
  assert.ok(
    pkg.scripts["cf:deploy"].indexOf("cf:content:provision") <
      pkg.scripts["cf:deploy"].indexOf("wrangler deploy"),
  );
  const provisioner = readFileSync(
    resolve("scripts/provision-content-storage.mjs"),
    "utf8",
  );
  assert.match(provisioner, /"request-content-v1-30-days",\s*"v1\/"/);
});

test("rendered config keeps the usage queue and dead-letter queue distinct", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-wrangler-test-"));
  const target = join(dir, "wrangler.toml");

  try {
    const env = {
      ...process.env,
      CLAWROUTER_STRICT_CONFIG: "0",
      CLAWROUTER_USAGE_QUEUE: "test-usage",
      CLAWROUTER_USAGE_DLQ: "test-usage-dead-letter",
      CLAWROUTER_CONTENT_BUCKET: "test-content",
      CLAWROUTER_POLICY_KV_ID: "test-kv",
      CLAWROUTER_POLICY_KV_PREVIEW_ID: "",
      CLAWROUTER_SMOKE_MODEL_AZURE_OPENAI: "azure-openai/prod-chat",
      AWS_REGION: "us-west-2",
    };
    delete env.AZURE_OPENAI_DEPLOYMENT;
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/render-wrangler-config.mjs"), resolve("wrangler.toml"), target],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const config = readFileSync(target, "utf8");
    assert.equal(config.match(/^queue = "test-usage"$/gm)?.length, 2);
    assert.match(config, /^dead_letter_queue = "test-usage-dead-letter"$/m);
    assert.match(config, /^AZURE_OPENAI_DEPLOYMENT = "prod-chat"$/m);
    assert.match(config, /^AWS_REGION = "us-west-2"$/m);
    assert.match(config, /^bucket_name = "test-content"$/m);
    assert.match(config, /binding = "POLICY_KV"\nid = "test-kv"\npreview_id = "test-kv"/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
