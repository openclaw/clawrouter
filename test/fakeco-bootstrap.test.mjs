import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import {
  bootstrapFakeco,
  parseFakecoSmokeCredential,
  probeFakecoAdminAccessGate,
  validateFakecoBootstrapInputs,
} from "../scripts/bootstrap-fakeco.mjs";
import { deploymentTarget } from "../scripts/deployment-profile.mjs";

const adminToken = "admin123";
const adminTokenSha256 = createHash("sha256").update(adminToken).digest("hex");
const smokeSecret = "smoke123";
const smokeKey = `clawrouter-live-smokeid-${smokeSecret}`;
const accessClientSecret = "access123";
const serviceTokenId = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");
const plan = {
  providers: [
    {
      id: "openai",
      target: { kind: "openai_chat", route: "/v1/chat/completions" },
    },
  ],
};

function validEnv(overrides = {}) {
  return {
    CLAWROUTER_DEPLOY_ENV: "fakeco",
    CLAWROUTER_DEPLOY_CONFIRM: "fakeco",
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "fixture-account",
    CLAWROUTER_POLICY_KV_ID: "fixture-kv",
    CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS: serviceTokenId,
    CLAWROUTER_ADMIN_TOKEN: adminToken,
    CLAWROUTER_ADMIN_TOKEN_SHA256: adminTokenSha256,
    CF_ACCESS_CLIENT_ID: "fixture-access-client-id",
    CF_ACCESS_CLIENT_SECRET: accessClientSecret,
    CLAWROUTER_SMOKE_KEY: smokeKey,
    CLAWROUTER_SMOKE_LIVE_PROVIDERS: "openai",
    ...overrides,
  };
}

test("FakeCo bootstrap validation binds the admin hash, service policy, and smoke key", () => {
  const env = validEnv();
  const target = deploymentTarget(env);
  const inputs = validateFakecoBootstrapInputs(target, env, { plan });
  assert.equal(inputs.adminTokenSha256, adminTokenSha256);
  assert.equal(inputs.baseUrl, "https://clawrouter-fakeco.openclaw.ai");
  assert.deepEqual(inputs.providerIds, ["openai"]);
  assert.deepEqual(inputs.smokeCredential, {
    kid: "smokeid",
    secret: smokeSecret,
  });
  assert.deepEqual(parseFakecoSmokeCredential(smokeKey), inputs.smokeCredential);

  assert.throws(
    () =>
      validateFakecoBootstrapInputs(
        target,
        validEnv({ CLAWROUTER_ADMIN_TOKEN_SHA256: "a".repeat(64) }),
        { plan },
      ),
    /does not match/,
  );
  const lockedOrigin = validateFakecoBootstrapInputs(
    target,
    validEnv({ CLAWROUTER_BASE_URL: "https://untrusted.example" }),
    { plan },
  );
  assert.equal(lockedOrigin.baseUrl, "https://clawrouter-fakeco.openclaw.ai");
  assert.throws(
    () =>
      validateFakecoBootstrapInputs(
        target,
        validEnv({ CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS: "" }),
        { plan },
      ),
    /Access requires CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS/,
  );
  assert.throws(
    () => parseFakecoSmokeCredential("clawrouter-live-short-bad"),
    /CLAWROUTER_SMOKE_KEY/,
  );
});

test("FakeCo bootstrap dry-run performs no network or child-process action", async () => {
  const logs = [];
  const result = await bootstrapFakeco({
    env: validEnv(),
    dryRun: true,
    plan,
    fetchImpl: async () => {
      throw new Error("unexpected fetch");
    },
    spawnImpl: () => {
      throw new Error("unexpected spawn");
    },
    adminRequestImpl: async () => {
      throw new Error("unexpected admin request");
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.executed, undefined);
  assert.equal(result.workerName, "clawrouter-edge-fakeco");
  const output = logs.join("\n");
  for (const secret of [adminToken, adminTokenSha256, smokeKey, smokeSecret, accessClientSecret]) {
    assert.doesNotMatch(output, new RegExp(secret));
  }
});

test("FakeCo bootstrap CLI accepts pnpm's argument separator for dry-run", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/bootstrap-fakeco.mjs"), "--", "--dry-run"],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: validEnv(),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FakeCo bootstrap plan/);
  assert.doesNotMatch(result.stdout, new RegExp(smokeSecret));
});

test("FakeCo bootstrap verifies KV, installs the admin secret from stdin, probes admin through Access, then registers the key from stdin", async () => {
  const env = validEnv();
  const events = [];
  const spawns = [];
  const logs = [];
  await bootstrapFakeco({
    env,
    plan,
    fetchImpl: async (url, init) => {
      events.push("kv-verify");
      assert.match(url, /accounts\/fixture-account\/storage\/kv\/namespaces\/fixture-kv$/);
      assert.equal(init.headers.Authorization, "Bearer cf-token");
      return Response.json({
        success: true,
        result: { id: "fixture-kv", title: "clawrouter-policy-fakeco" },
      });
    },
    spawnImpl: (command, args, options) => {
      const kind = args.includes("CLAWROUTER_ADMIN_TOKEN_SHA256")
        ? "admin-secret"
        : "key-registration";
      events.push(kind);
      spawns.push({ command, args, options, kind });
      return { status: 0 };
    },
    adminRequestImpl: async (path, options) => {
      events.push("admin-probe");
      assert.equal(path, "/v1/admin/overview");
      assert.equal(options.method, "GET");
      assert.equal(options.env.CLAWROUTER_ADMIN_TOKEN, adminToken);
      assert.equal(options.env.CF_ACCESS_CLIENT_SECRET, accessClientSecret);
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true };
    },
    waitForHealthImpl: async (options) => {
      events.push("readiness");
      assert.equal(options.expectedEnvironment, "fakeco");
      assert.equal(options.timeoutMs, 180_000);
      await options.probeImpl(
        { ok: true, environment: "fakeco" },
        { signal: new AbortController().signal },
      );
      return { ok: true, environment: "fakeco" };
    },
    accessGateProbeImpl: async (baseUrl, options) => {
      events.push("access-gate");
      assert.equal(baseUrl, "https://clawrouter-fakeco.openclaw.ai");
      assert.ok(options.signal instanceof AbortSignal);
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(events, [
    "kv-verify",
    "admin-secret",
    "readiness",
    "access-gate",
    "admin-probe",
    "key-registration",
  ]);
  assert.equal(spawns.length, 2);
  const secretInstall = spawns[0];
  assert.equal(secretInstall.command, "pnpm");
  assert.deepEqual(secretInstall.args, [
    "exec",
    "wrangler",
    "secret",
    "put",
    "CLAWROUTER_ADMIN_TOKEN_SHA256",
    "--name",
    "clawrouter-edge-fakeco",
    "--config",
    ".wrangler.generated.toml",
  ]);
  assert.equal(secretInstall.options.input, `${adminTokenSha256}\n`);
  assert.equal(secretInstall.options.env.CLAWROUTER_ADMIN_TOKEN, undefined);
  assert.equal(secretInstall.options.env.CF_ACCESS_CLIENT_SECRET, undefined);

  const keyRegistration = spawns[1];
  assert.equal(keyRegistration.command, process.execPath);
  assert.match(keyRegistration.args[0], /scripts\/key-put\.mjs$/);
  assert.deepEqual(keyRegistration.args.slice(1), [
    "--kid",
    "smokeid",
    "--secret-stdin",
    "--providers",
    "openai",
  ]);
  assert.equal(keyRegistration.options.input, `${smokeSecret}\n`);
  assert.equal(keyRegistration.options.env.CLAWROUTER_SMOKE_KEY, undefined);
  assert.equal(keyRegistration.options.env.CLAWROUTER_ADMIN_TOKEN_SHA256, undefined);

  const argvAndLogs = [
    ...spawns.flatMap((spawn) => [spawn.command, ...spawn.args]),
    ...logs,
  ].join("\n");
  for (const secret of [adminToken, adminTokenSha256, smokeKey, smokeSecret, accessClientSecret]) {
    assert.doesNotMatch(argvAndLogs, new RegExp(secret));
  }
});

test("FakeCo admin Access probe rejects a direct Worker JSON fallback", async () => {
  await probeFakecoAdminAccessGate("https://clawrouter-fakeco.openclaw.ai", {
    fetchImpl: async () =>
      Response.json(
        { error: { code: "admin_auth_required" } },
        { status: 401 },
      ),
  }).then(
    () => assert.fail("expected direct Worker fallback to fail"),
    (error) => assert.match(error.message, /Cloudflare Access is not protecting/),
  );
  await assert.doesNotReject(
    probeFakecoAdminAccessGate("https://clawrouter-fakeco.openclaw.ai", {
      fetchImpl: async () =>
        new Response("", {
          status: 302,
          headers: { location: "https://example.cloudflareaccess.com/login" },
        }),
    }),
  );
});
