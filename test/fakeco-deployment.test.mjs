import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  assertDeploymentMutation,
  assertPolicyKvNamespace,
  deploymentTarget,
  fakecoAccessServiceTokenIds,
  verifyPolicyKvPreviewNamespaceTarget,
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
const serviceTokenIdA = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");
const serviceTokenIdB = ["22222222", "2222", "4222", "8222", "222222222222"].join("-");
const validServiceTokenIds = [serviceTokenIdA, serviceTokenIdB].join(",");

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
  assert.deepEqual(
    fakecoAccessServiceTokenIds(target, {
      CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS: validServiceTokenIds,
    }),
    [serviceTokenIdA, serviceTokenIdB],
  );
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

test("FakeCo distinct preview KV requires independent exact-title verification", async () => {
  const target = deploymentTarget({ CLAWROUTER_DEPLOY_ENV: "fakeco" });
  const env = {
    CLOUDFLARE_API_TOKEN: "x",
    CLOUDFLARE_ACCOUNT_ID: "fixture-account",
    CLAWROUTER_POLICY_KV_ID: "primary-kv",
    CLAWROUTER_POLICY_KV_PREVIEW_ID: "preview-kv",
  };
  const preview = await verifyPolicyKvPreviewNamespaceTarget(
    target,
    env,
    async (url) => {
      assert.match(url, /namespaces\/preview-kv$/);
      return Response.json({
        success: true,
        result: { id: "preview-kv", title: "clawrouter-policy-fakeco" },
      });
    },
  );
  assert.equal(preview.id, "preview-kv");
  await assert.rejects(
    verifyPolicyKvPreviewNamespaceTarget(target, env, async () =>
      Response.json({
        success: true,
        result: { id: "preview-kv", title: "clawrouter-policy" },
      })),
    /POLICY_KV preview must reference namespace "clawrouter-policy-fakeco"/,
  );
  assert.equal(
    await verifyPolicyKvPreviewNamespaceTarget(target, {
      ...env,
      CLAWROUTER_POLICY_KV_PREVIEW_ID: "primary-kv",
    }),
    null,
  );
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
    assert.match(config, /binding = "POLICY_KV"\nid = "fakeco-kv-id"\npreview_id = "fakeco-kv-id"/);
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

test("FakeCo Wrangler render refuses a distinct preview KV with the wrong title", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-fakeco-preview-render-"));
  const output = join(dir, "wrangler.toml");
  const loader = join(dir, "fetch-loader.mjs");
  writeFileSync(
    loader,
    "globalThis.fetch = async () => Response.json({ success: true, result: { id: 'preview-kv', title: 'clawrouter-policy' } });\n",
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(loader).href,
        resolve("scripts/render-wrangler-config.mjs"),
        resolve("wrangler.toml"),
        output,
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: cleanEnv({
          CLAWROUTER_DEPLOY_ENV: "fakeco",
          CLAWROUTER_POLICY_KV_ID: "primary-kv",
          CLAWROUTER_POLICY_KV_PREVIEW_ID: "preview-kv",
          CLOUDFLARE_API_TOKEN: "cf-token",
          CLOUDFLARE_ACCOUNT_ID: "fixture-account",
        }),
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /POLICY_KV preview must reference namespace "clawrouter-policy-fakeco"/,
    );
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
        CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS: validServiceTokenIds,
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

test("FakeCo Access refuses missing or malformed service-token ids before mutation", () => {
  for (const serviceTokenIds of ["", "not-a-cloudflare-service-token-id"]) {
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
          CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS: serviceTokenIds,
        }),
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS/);
  }
});

test("FakeCo before-Access preflight uses only locked Cloudflare reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-fakeco-preflight-"));
  const loader = join(dir, "fetch-loader.mjs");
  writeFileSync(
    loader,
    [
      "globalThis.fetch = async (url, init = {}) => {",
      '  const method = init.method ?? "GET";',
      '  if (method !== "GET") throw new Error(`mutation attempted: ${method}`);',
      '  console.log(`mock Cloudflare fetch: ${method} ${url}`);',
      "  if (url.includes('/workers/scripts/clawrouter-edge-fakeco/secrets')) return Response.json({ success: true, result: [{ name: 'OPENAI_API_KEY', type: 'secret_text' }] });",
      "  return Response.json({ success: true, result: { id: 'fixture-kv', title: 'clawrouter-policy-fakeco' } });",
      "};",
    ].join("\n"),
  );
  const adminToken = "admin123";
  const baseEnv = cleanEnv({
    CLAWROUTER_DEPLOY_ENV: "fakeco",
    CLAWROUTER_DEPLOY_CONFIRM: "fakeco",
    CLAWROUTER_PREFLIGHT_DEPLOY: "1",
    CLAWROUTER_PREFLIGHT_REQUIRE_ACCESS: "1",
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "fixture-account",
    CLAWROUTER_POLICY_KV_ID: "fixture-kv",
    CLAWROUTER_ADMIN_TOKEN: adminToken,
    CLAWROUTER_ADMIN_TOKEN_SHA256: createHash("sha256")
      .update(adminToken)
      .digest("hex"),
    CF_ACCESS_CLIENT_ID: "fixture-client-id",
    CF_ACCESS_CLIENT_SECRET: "access123",
    CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS: serviceTokenIdA,
    CLAWROUTER_SMOKE_KEY: "clawrouter-live-smokeid-fixture_smoke_secret",
    CLAWROUTER_SMOKE_LIVE_PROVIDERS: "openai",
  });
  const runPreflight = (overrides) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(loader).href,
        resolve("scripts/deploy-preflight.mjs"),
        "--before-access",
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: { ...baseEnv, ...overrides },
      },
    );
  try {
    const result = runPreflight({
      CLAWROUTER_PROVIDER_CREDENTIAL_MODE: "upload",
      OPENAI_API_KEY: "openai123",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.match(/mock Cloudflare fetch:/g)?.length, 1);
    assert.match(result.stdout, /mock Cloudflare fetch: GET .*namespaces\/fixture-kv/);
    assert.match(result.stdout, /mode=before-access-read-only/);
    assert.match(result.stdout, /no KV or Access writes/);
    assert.doesNotMatch(result.stdout, /mutation attempted/);

    const freshRefusal = runPreflight({
      CLAWROUTER_PROVIDER_CREDENTIAL_MODE: "upload",
      OPENAI_API_KEY: "",
    });
    assert.notEqual(freshRefusal.status, 0);
    assert.match(
      freshRefusal.stderr,
      /provider credential upload requires runner values.*OPENAI_API_KEY/,
    );

    const established = runPreflight({
      CLAWROUTER_PROVIDER_CREDENTIAL_MODE: "existing",
      OPENAI_API_KEY: "",
    });
    assert.equal(established.status, 0, established.stderr);
    assert.equal(established.stdout.match(/mock Cloudflare fetch:/g)?.length, 2);
    assert.match(
      established.stdout,
      /provider credential proof: existing locked Worker bindings ready for openai/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
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
  assert.match(workflow, /secrets\.CLAWROUTER_FAKECO_ADMIN_TOKEN/);
  assert.match(workflow, /secrets\.CLAWROUTER_FAKECO_ACCESS_CLIENT_ID/);
  assert.match(workflow, /secrets\.CLAWROUTER_FAKECO_ACCESS_CLIENT_SECRET/);
  assert.match(
    workflow,
    /provider_credentials:\s*[\s\S]*?default: "upload"[\s\S]*?- upload\s*[\s\S]*?- existing/,
  );
  assert.match(
    workflow,
    /CLAWROUTER_PROVIDER_CREDENTIAL_MODE: \$\{\{ inputs\.provider_credentials \}\}/,
  );
  assert.match(
    workflow,
    /if: \$\{\{ inputs\.provider_credentials == 'upload' \}\}[\s\S]*?OPENAI_API_KEY: \$\{\{ secrets\.CLAWROUTER_FAKECO_PROVIDER_OPENAI_API_KEY \}\}[\s\S]*?pnpm cf:preflight -- --before-access/,
  );
  assert.match(
    workflow,
    /if: \$\{\{ inputs\.provider_credentials == 'existing' \}\}[\s\S]*?pnpm cf:preflight -- --before-access/,
  );
  assert.match(
    workflow,
    /^\s+CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS: \$\{\{ vars\.CLAWROUTER_FAKECO_ACCESS_SERVICE_TOKEN_IDS \}\}$/m,
  );
  assert.match(workflow, /https:\/\/clawrouter-fakeco\.openclaw\.ai/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /CLAWROUTER_FAKECO_POLICY_KV_PREVIEW_ID/);
  assert.doesNotMatch(workflow, /vars\.CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS/);
  assert.doesNotMatch(workflow, /configure_provider_secrets/);
  assert.doesNotMatch(workflow, /https:\/\/clawrouter\.openclaw\.ai/);
  assert.doesNotMatch(workflow, /CLAWROUTER_OMIT_ROUTES/);
  assert.doesNotMatch(workflow, /provision_access/);
  assert.match(workflow, /run: pnpm cf:access -- --write-github-env/);
  const beforeAccessPreflight = workflow.indexOf(
    "pnpm cf:preflight -- --before-access",
  );
  const access = workflow.indexOf("pnpm cf:access");
  const deployPreflight = workflow.indexOf("run: pnpm cf:preflight\n", access);
  const deploy = workflow.indexOf("pnpm exec wrangler deploy");
  const providerSecrets = workflow.indexOf("run: pnpm cf:secrets");
  const bootstrap = workflow.indexOf("run: pnpm cf:bootstrap");
  const smoke = workflow.indexOf("run: pnpm cf:smoke");
  assert.ok(beforeAccessPreflight >= 0 && beforeAccessPreflight < access);
  assert.equal(
    workflow.slice(0, access).match(/pnpm cf:preflight -- --before-access/g)?.length,
    2,
  );
  assert.ok(access < deployPreflight && deployPreflight < deploy);
  assert.ok(deploy < providerSecrets && providerSecrets < bootstrap);
  assert.ok(bootstrap < smoke);
  assert.match(workflow, /CLAWROUTER_SMOKE_READINESS_TIMEOUT_MS: "180000"/);
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.match(pkg.scripts["cf:deploy"], /cf:target -- --deploy/);
  assert.ok(pkg.scripts["cf:deploy"].indexOf("--deploy") < pkg.scripts["cf:deploy"].indexOf("wrangler deploy"));
});

function cleanEnv(values) {
  const env = { ...process.env };
  for (const name of lockedEnvNames) delete env[name];
  return { ...env, ...values };
}
