import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adminRequest } from "./admin-api.mjs";
import { assertAccessGateResponse } from "./smoke-access-gate.mjs";
import {
  assertDeploymentMutation,
  deploymentTarget,
  fakecoAccessServiceTokenIds,
  verifyPolicyKvNamespaceTarget,
} from "./deployment-profile.mjs";
import {
  buildProviderSmokePlan,
  compileProviderSnapshot,
  liveProviderList,
  selectLiveProviderPlans,
} from "./provider-smoke-plan.mjs";
import {
  smokeReadinessTimeoutMs,
  waitForHealth,
} from "./smoke-readiness.mjs";

export function validateFakecoBootstrapInputs(
  target,
  env = process.env,
  { plan } = {},
) {
  if (target.environment !== "fakeco") {
    throw new Error("FakeCo bootstrap refused: CLAWROUTER_DEPLOY_ENV must be fakeco");
  }
  assertDeploymentMutation(target, env);
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLAWROUTER_POLICY_KV_ID",
  ]) {
    requiredValue(env, name);
  }
  fakecoAccessServiceTokenIds(target, env);

  const adminToken = requiredValue(env, "CLAWROUTER_ADMIN_TOKEN");
  const adminTokenSha256 = requiredValue(
    env,
    "CLAWROUTER_ADMIN_TOKEN_SHA256",
  ).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(adminTokenSha256)) {
    throw new Error("CLAWROUTER_ADMIN_TOKEN_SHA256 must be a 64-character hex string");
  }
  const actualAdminHash = createHash("sha256").update(adminToken).digest("hex");
  if (actualAdminHash !== adminTokenSha256) {
    throw new Error(
      "CLAWROUTER_ADMIN_TOKEN does not match CLAWROUTER_ADMIN_TOKEN_SHA256",
    );
  }

  const accessClientId = requiredValue(env, "CF_ACCESS_CLIENT_ID");
  const accessClientSecret = requiredValue(env, "CF_ACCESS_CLIENT_SECRET");
  const smokeCredential = parseFakecoSmokeCredential(
    requiredValue(env, "CLAWROUTER_SMOKE_KEY"),
  );
  const smokePlan =
    plan ?? buildProviderSmokePlan(compileProviderSnapshot(), env);
  const requestedProviders = liveProviderList(env);
  if (requestedProviders.length === 0) {
    throw new Error(
      "CLAWROUTER_SMOKE_LIVE_PROVIDERS must name at least one golden provider",
    );
  }
  const providerIds = selectLiveProviderPlans(
    smokePlan,
    requestedProviders,
  ).map((provider) => provider.id);

  return {
    adminToken,
    adminTokenSha256,
    accessClientId,
    accessClientSecret,
    baseUrl: target.baseUrl,
    providerIds,
    smokeCredential,
  };
}

export function parseFakecoSmokeCredential(value) {
  const match = value.match(
    /^clawrouter-live-([A-Za-z0-9_]{4,})-([A-Za-z0-9_-]{8,})$/,
  );
  if (!match) {
    throw new Error(
      "CLAWROUTER_SMOKE_KEY must use clawrouter-live-<credential-id>-<secret> with a valid credential id and secret",
    );
  }
  return { kid: match[1], secret: match[2] };
}

export async function bootstrapFakeco({
  env = process.env,
  dryRun = false,
  fetchImpl = fetch,
  spawnImpl = spawnSync,
  adminRequestImpl = adminRequest,
  waitForHealthImpl = waitForHealth,
  accessGateProbeImpl = probeFakecoAdminAccessGate,
  log = console.log,
  plan,
} = {}) {
  const target = deploymentTarget(env);
  const inputs = validateFakecoBootstrapInputs(target, env, { plan });
  const summary = {
    environment: target.environment,
    workerName: target.workerName,
    providerIds: inputs.providerIds,
  };
  if (dryRun) {
    log(
      `FakeCo bootstrap plan: worker=${target.workerName} providers=${inputs.providerIds.join(",")}`,
    );
    log("secrets are accepted only from environment-scoped inputs and stdin");
    return summary;
  }

  await verifyPolicyKvNamespaceTarget(target, env, fetchImpl);

  runChecked(
    spawnImpl,
    "pnpm",
    [
      "exec",
      "wrangler",
      "secret",
      "put",
      "CLAWROUTER_ADMIN_TOKEN_SHA256",
      "--name",
      target.workerName,
      "--config",
      ".wrangler.generated.toml",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: wranglerEnvironment(env),
      input: `${inputs.adminTokenSha256}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    },
    "FakeCo admin Worker secret installation",
  );
  log("FakeCo admin Worker secret installed from stdin");

  const adminEnv = {
    ...env,
    CLAWROUTER_BASE_URL: inputs.baseUrl,
    CLAWROUTER_ADMIN_TOKEN: inputs.adminToken,
    CF_ACCESS_CLIENT_ID: inputs.accessClientId,
    ["CF_ACCESS_CLIENT_SECRET"]: inputs.accessClientSecret,
  };
  await waitForHealthImpl({
    baseUrl: inputs.baseUrl,
    expectedEnvironment: target.environment,
    timeoutMs: smokeReadinessTimeoutMs(env),
    probeImpl: async (_health, { signal } = {}) => {
      try {
        await accessGateProbeImpl(inputs.baseUrl, { signal });
      } catch {
        throw new Error("Cloudflare Access gate is not ready");
      }
      try {
        await adminRequestImpl("/v1/admin/overview", {
          method: "GET",
          env: adminEnv,
          signal,
        });
      } catch {
        throw new Error("authenticated admin path is not ready");
      }
    },
    log,
  });
  log("unauthenticated FakeCo admin path is protected by Cloudflare Access");
  log("authenticated Access service-token and admin-path probe passed");

  runChecked(
    spawnImpl,
    process.execPath,
    [
      fileURLToPath(new URL("./key-put.mjs", import.meta.url)),
      "--kid",
      inputs.smokeCredential.kid,
      "--secret-stdin",
      "--providers",
      inputs.providerIds.join(","),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: keyRegistrationEnvironment(env, inputs),
      input: `${inputs.smokeCredential.secret}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    },
    "FakeCo smoke credential registration",
  );
  log("FakeCo smoke credential registration passed; credential secret was not printed");
  return summary;
}

export async function probeFakecoAdminAccessGate(
  baseUrl,
  { fetchImpl = fetch, signal } = {},
) {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/admin/overview`;
  const response = await fetchImpl(url, {
    headers: { accept: "text/html,application/json" },
    redirect: "manual",
    signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  assertAccessGateResponse(response, contentType, body, "FakeCo admin access gate");
}

function requiredValue(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for FakeCo bootstrap`);
  return value;
}

function wranglerEnvironment(env) {
  const childEnv = { ...env };
  for (const name of [
    "CLAWROUTER_ADMIN_TOKEN",
    "CLAWROUTER_ADMIN_TOKEN_SHA256",
    "CLAWROUTER_SMOKE_KEY",
    "CF_ACCESS_CLIENT_ID",
    "CF_ACCESS_CLIENT_SECRET",
  ]) {
    delete childEnv[name];
  }
  return childEnv;
}

function keyRegistrationEnvironment(env, inputs) {
  const childEnv = { ...env };
  delete childEnv.CLAWROUTER_ADMIN_TOKEN_SHA256;
  delete childEnv.CLAWROUTER_SMOKE_KEY;
  childEnv.CLAWROUTER_BASE_URL = inputs.baseUrl;
  childEnv.CLAWROUTER_ADMIN_TOKEN = inputs.adminToken;
  childEnv.CF_ACCESS_CLIENT_ID = inputs.accessClientId;
  childEnv["CF_ACCESS_CLIENT_SECRET"] = inputs.accessClientSecret;
  return childEnv;
}

function runChecked(spawnImpl, command, args, options, label) {
  const result = spawnImpl(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    throw new Error(`unknown FakeCo bootstrap arguments: ${unknown.join(" ")}`);
  }
  await bootstrapFakeco({ dryRun: args.includes("--dry-run") });
}
