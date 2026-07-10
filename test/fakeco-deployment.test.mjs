import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertDeploymentMutation,
  assertPolicyKvNamespace,
  deploymentTarget,
  verifyPolicyKvNamespaceTarget,
} from "../scripts/deployment-profile.mjs";
import { createExactKvNamespace } from "../scripts/provision-cloudflare.mjs";

const lockedEnvNames = [
  "CLAWROUTER_BASE_URL",
  "CLAWROUTER_ROUTE_HOSTNAME",
  "CLAWROUTER_WORKER_NAME",
  "CLAWROUTER_POLICY_KV_NAMESPACE",
  "CLAWROUTER_POLICY_KV_BINDING",
  "CLAWROUTER_USAGE_QUEUE",
  "CLAWROUTER_USAGE_DLQ",
  "CLAWROUTER_CONTENT_BUCKET",
  "CLAWROUTER_ACCESS_DOMAIN",
  "CLAWROUTER_ACCESS_APP_NAME",
  "CLAWROUTER_ACCESS_POLICY_NAME",
  "CLAWROUTER_ACCESS_SERVICE_POLICY_NAME",
  "CLAWROUTER_ACCESS_DEFAULT_TENANT",
  "CLAWROUTER_CONTENT_RETENTION_DEFAULT",
];

test("FakeCo profile locks every named Cloudflare resource away from production", async () => {
  const target = deploymentTarget({ CLAWROUTER_DEPLOY_ENV: "fakeco" });
  assert.deepEqual(
    {
      environment: target.environment,
      baseUrl: target.baseUrl,
      workerName: target.workerName,
      policyKvNamespace: target.policyKvNamespace,
      queueName: target.queueName,
      queueDlqName: target.queueDlqName,
      contentBucketName: target.contentBucketName,
      accessAppName: target.accessAppName,
      accessDefaultTenant: target.accessDefaultTenant,
      contentRetentionDefault: target.contentRetentionDefault,
    },
    {
      environment: "fakeco",
      baseUrl: "https://clawrouter-fakeco.openclaw.ai",
      workerName: "clawrouter-edge-fakeco",
      policyKvNamespace: "clawrouter-policy-fakeco",
      queueName: "clawrouter-usage-fakeco",
      queueDlqName: "clawrouter-usage-fakeco-dead-letter",
      contentBucketName: "clawrouter-content-fakeco",
      accessAppName: "ClawRouter FakeCo Console",
      accessDefaultTenant: "fakeco",
      contentRetentionDefault: false,
    },
  );
  assert.throws(
    () => deploymentTarget({
      CLAWROUTER_DEPLOY_ENV: "fakeco",
      CLAWROUTER_WORKER_NAME: "clawrouter-edge",
    }),
    /FakeCo isolation refused/,
  );
  assert.throws(() => assertDeploymentMutation(target, {}), /mutation refused/);
  assert.doesNotThrow(() => assertDeploymentMutation(target, {
    CLAWROUTER_DEPLOY_CONFIRM: "fakeco",
  }));
  assert.doesNotThrow(() => assertPolicyKvNamespace(target, {
    title: "clawrouter-policy-fakeco",
  }));
  assert.throws(
    () => assertPolicyKvNamespace(target, { title: "POLICY_KV" }),
    /POLICY_KV must reference namespace "clawrouter-policy-fakeco"/,
  );
  const namespace = await verifyPolicyKvNamespaceTarget(
    target,
    {
      CLOUDFLARE_API_TOKEN: "x",
      CLOUDFLARE_ACCOUNT_ID: "fixture-account",
      CLAWROUTER_POLICY_KV_ID: "fixture-kv",
    },
    async (url, init) => {
      assert.match(url, /accounts\/fixture-account\/storage\/kv\/namespaces\/fixture-kv$/);
      assert.equal(init.headers.Authorization, "Bearer x");
      return Response.json({
        success: true,
        result: { id: "fixture-kv", title: "clawrouter-policy-fakeco" },
      });
    },
  );
  assert.equal(namespace.title, "clawrouter-policy-fakeco");
  const created = await createExactKvNamespace({
    accountId: "fixture-account",
    token: "x",
    title: "clawrouter-policy-fakeco",
    fetchImpl: async (url, init) => {
      assert.match(url, /accounts\/fixture-account\/storage\/kv\/namespaces$/);
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Bearer x");
      assert.deepEqual(JSON.parse(init.body), { title: "clawrouter-policy-fakeco" });
      return Response.json({
        success: true,
        result: { id: "created-kv", title: "clawrouter-policy-fakeco" },
      });
    },
  });
  assert.deepEqual(created, {
    id: "created-kv",
    title: "clawrouter-policy-fakeco",
  });
});

test("FakeCo Wrangler render isolates Worker, KV, queues, R2, route, DO namespace, and vars", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-fakeco-render-"));
  const output = join(dir, "wrangler.toml");
  try {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/render-wrangler-config.mjs"), resolve("wrangler.toml"), output],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: cleanEnv({
          CLAWROUTER_DEPLOY_ENV: "fakeco",
          CLAWROUTER_POLICY_KV_ID: "fakeco-kv-id",
          CLAWROUTER_POLICY_KV_PREVIEW_ID: "fakeco-kv-preview-id",
          CLOUDFLARE_ACCOUNT_ID: "fakeco-cloudflare-account",
          CLAWROUTER_ACCESS_TEAM_DOMAIN: "fakeco.cloudflareaccess.com",
          CLAWROUTER_ACCESS_AUD: "fakeco-access-audience",
        }),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const config = readFileSync(output, "utf8");
    assert.match(config, /^name = "clawrouter-edge-fakeco"$/m);
    assert.match(config, /^account_id = "fakeco-cloudflare-account"$/m);
    assert.equal(config.match(/^queue = "clawrouter-usage-fakeco"$/gm)?.length, 2);
    assert.match(config, /^dead_letter_queue = "clawrouter-usage-fakeco-dead-letter"$/m);
    assert.match(config, /^bucket_name = "clawrouter-content-fakeco"$/m);
    assert.match(config, /^pattern = "clawrouter-fakeco\.openclaw\.ai"$/m);
    assert.match(config, /binding = "POLICY_KV"\nid = "fakeco-kv-id"\npreview_id = "fakeco-kv-preview-id"/);
    assert.match(config, /^CLAWROUTER_DEPLOY_ENV = "fakeco"$/m);
    assert.match(config, /^CLAWROUTER_CONTENT_RETENTION_DEFAULT = "false"$/m);
    assert.match(config, /^CLAWROUTER_ACCESS_DEFAULT_TENANT = "fakeco"$/m);
    assert.match(config, /^CLAWROUTER_ACCESS_AUD = "fakeco-access-audience"$/m);
    assert.equal(config.match(/^\[\[durable_objects\.bindings\]\]$/gm)?.length, 3);
    assert.doesNotMatch(config, /^name = "clawrouter-edge"$/m);
    assert.doesNotMatch(config, /^pattern = "clawrouter\.openclaw\.ai"$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("FakeCo Access dry-run uses its isolated hostname, app, policies, and tenant", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/provision-access.mjs"), "--dry-run"],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: cleanEnv({
        CLAWROUTER_DEPLOY_ENV: "fakeco",
        CLOUDFLARE_ACCOUNT_ID: "fakeco-cloudflare-account",
        CLAWROUTER_ACCESS_ALLOWED_DOMAINS: "example.com",
        CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS: "crabhelm-primary,crabhelm-rotation",
      }),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^environment=fakeco$/m);
  assert.match(result.stdout, /^host=clawrouter-fakeco\.openclaw\.ai$/m);
  assert.match(result.stdout, /clawrouter-fakeco\.openclaw\.ai\/v1\/admin\/\*/);
  assert.match(result.stdout, /^app=ClawRouter FakeCo Console$/m);
  assert.match(result.stdout, /^policy=ClawRouter FakeCo Console Users decision=allow$/m);
  assert.match(
    result.stdout,
    /^policy=ClawRouter FakeCo Console Service Tokens decision=non_identity$/m,
  );
  assert.match(result.stdout, /^CLAWROUTER_ACCESS_DEFAULT_TENANT=fakeco$/m);
});

test("FakeCo deploy workflow is hard-bound to its GitHub Environment and secret namespace", () => {
  const workflow = readFileSync(
    resolve(".github/workflows/deploy-cloudflare-fakeco.yml"),
    "utf8",
  );
  assert.match(workflow, /environment:\s*\n\s+name: fakeco/);
  assert.match(workflow, /CLAWROUTER_DEPLOY_ENV: fakeco/);
  assert.match(workflow, /CLAWROUTER_DEPLOY_CONFIRM: fakeco/);
  assert.match(workflow, /secrets\.CLAWROUTER_FAKECO_CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /secrets\.CLAWROUTER_FAKECO_POLICY_KV_ID/);
  assert.match(
    workflow,
    /^\s+CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS: \$\{\{ vars\.CLAWROUTER_FAKECO_ACCESS_SERVICE_TOKEN_IDS \}\}$/m,
  );
  assert.match(workflow, /https:\/\/clawrouter-fakeco\.openclaw\.ai/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /vars\.CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS/);
  assert.doesNotMatch(workflow, /https:\/\/clawrouter\.openclaw\.ai/);
  assert.doesNotMatch(workflow, /CLAWROUTER_OMIT_ROUTES/);
  assert.doesNotMatch(workflow, /provision_access/);
  assert.match(workflow, /run: pnpm cf:access -- --write-github-env/);
  assert.ok(workflow.indexOf("pnpm cf:access") < workflow.indexOf("pnpm cf:preflight"));
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.match(pkg.scripts["cf:deploy"], /cf:target -- --deploy/);
  assert.ok(pkg.scripts["cf:deploy"].indexOf("--deploy") < pkg.scripts["cf:deploy"].indexOf("wrangler deploy"));
});

function cleanEnv(values) {
  const env = { ...process.env };
  for (const name of lockedEnvNames) delete env[name];
  return { ...env, ...values };
}
