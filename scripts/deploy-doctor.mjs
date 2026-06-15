import { spawnSync } from "node:child_process";

import {
  buildProviderSmokePlan,
  compileProviderSnapshot,
  liveProviderList,
  selectLiveProviderPlans,
} from "./provider-smoke-plan.mjs";

const requiredLocalEnv = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLAWROUTER_ADMIN_TOKEN_SHA256",
  "CLAWROUTER_POLICY_KV_ID",
];

const requiredRepoSecrets = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLAWROUTER_ADMIN_TOKEN_SHA256",
  "CLAWROUTER_POLICY_KV_ID",
];

const optionalRepoSecrets = [
  "CLAWROUTER_POLICY_KV_PREVIEW_ID",
  "CLAWROUTER_SMOKE_KEY",
  "CLAWROUTER_CLOUDFLARE_AI_GATEWAY_OPENAI_API_KEY",
];

const optionalRepoVars = [
  "CLAWROUTER_USAGE_QUEUE",
  "CLAWROUTER_WORKER_NAME",
  "CLAWROUTER_ACCESS_TEAM_DOMAIN",
  "CLAWROUTER_ACCESS_AUD",
  "CLAWROUTER_ACCESS_ADMIN_EMAILS",
  "CLAWROUTER_ACCESS_ADMIN_DOMAINS",
  "CLAWROUTER_ACCESS_DEFAULT_TENANT",
];
const repo = process.env.CLAWROUTER_GITHUB_REPO ?? "openclaw/clawrouter";
const githubCli = selectGitHubCli();
const errors = [];
const warnings = [];

const snapshot = compileProviderSnapshot();
const plan = buildProviderSmokePlan(snapshot);
if (plan.targetCount !== plan.providerCount) {
  errors.push(`provider smoke plan is incomplete: ${plan.targetCount}/${plan.providerCount}`);
}

checkLocalEnv();
checkLiveProviderReadiness(plan);
checkWranglerAuth();
await checkCloudflareWorkerPermission();
await checkCloudflareKvPermission();
checkGitHubRepository(repo);
printProviderConfig(plan);

if (warnings.length > 0) {
  console.log("");
  console.log("warnings:");
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}

if (errors.length > 0) {
  console.error("");
  console.error("clawrouter deploy doctor failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("");
console.log(
  `clawrouter deploy doctor passed: providers=${plan.providerCount} smokeTargets=${plan.targetCount}`,
);

function checkLocalEnv() {
  for (const name of requiredLocalEnv) {
    if (!process.env[name]) {
      errors.push(`missing required local env: ${name}`);
    }
  }
  if (
    process.env.CLAWROUTER_ADMIN_TOKEN_SHA256 &&
    !/^[a-fA-F0-9]{64}$/.test(process.env.CLAWROUTER_ADMIN_TOKEN_SHA256)
  ) {
    errors.push("CLAWROUTER_ADMIN_TOKEN_SHA256 must be a 64-character hex string");
  }

  const baseUrl = process.env.CLAWROUTER_BASE_URL;
  if (baseUrl) {
    try {
      new URL(baseUrl);
    } catch {
      errors.push("CLAWROUTER_BASE_URL must be a valid absolute URL");
    }
  }
}

function checkLiveProviderReadiness(plan) {
  const liveProviders = liveProviderList();
  if (liveProviders.length === 0) {
    errors.push("CLAWROUTER_SMOKE_LIVE_PROVIDERS must name at least one golden provider");
    return;
  }
  if (!process.env.CLAWROUTER_BASE_URL) {
    errors.push("CLAWROUTER_BASE_URL is required when live provider smoke is enabled");
  }
  if (!process.env.CLAWROUTER_SMOKE_KEY) {
    errors.push("CLAWROUTER_SMOKE_KEY is required when live provider smoke is enabled");
  }
  try {
    const selected = selectLiveProviderPlans(plan, liveProviders);
    const missing = selected.filter((provider) => !provider.configured);
    if (missing.length > 0) {
      const details = missing.map((provider) => {
        const config = provider.missingConfig.length > 0
          ? provider.missingConfig.join(",")
          : "oauth grant";
        return `${provider.id}(${config})`;
      });
      errors.push(`live provider smoke is not configured: ${details.join(", ")}`);
    }
  } catch (error) {
    errors.push(error.message);
  }
}

function checkWranglerAuth() {
  if (process.env.CLAWROUTER_DOCTOR_SKIP_WRANGLER === "1") {
    warnings.push("skipped Wrangler auth check");
    return;
  }
  const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    errors.push(
      "Wrangler is not authenticated; run `pnpm exec wrangler login` or set a valid API token",
    );
    return;
  }
  console.log("wrangler auth: ok");
}

async function checkCloudflareWorkerPermission() {
  if (process.env.CLAWROUTER_DOCTOR_SKIP_CLOUDFLARE_API === "1") {
    warnings.push("skipped Cloudflare Worker permission check");
    return;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const workerName = process.env.CLAWROUTER_WORKER_NAME?.trim() || "clawrouter-edge";
  if (!token || !accountId) {
    return;
  }
  let response;
  let body;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/services/${workerName}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    body = await response.json().catch(() => ({}));
  } catch (error) {
    warnings.push(`could not reach Cloudflare Workers API: ${error.message}`);
    return;
  }
  if (response.ok && body.success !== false) {
    console.log(`cloudflare worker token: can read ${workerName}`);
    return;
  }
  const firstError = body.errors?.[0];
  if (response.status === 404) {
    warnings.push(`Cloudflare Worker ${workerName} does not exist yet`);
    return;
  }
  errors.push(
    `CLOUDFLARE_API_TOKEN cannot read Worker ${workerName}: ${firstError?.message ?? `HTTP ${response.status}`}`,
  );
}

async function checkCloudflareKvPermission() {
  if (
    process.env.CLAWROUTER_DOCTOR_SKIP_CLOUDFLARE_API === "1" ||
    process.env.CLAWROUTER_DOCTOR_SKIP_CLOUDFLARE_KV === "1"
  ) {
    warnings.push("skipped Cloudflare KV permission check");
    return;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const namespaceId = process.env.CLAWROUTER_POLICY_KV_ID?.trim();
  if (!token || !accountId || !namespaceId) {
    return;
  }
  const key = `__clawrouter_doctor_${Date.now()}`;
  const path = `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
  const put = await cloudflareRequest(token, path, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "ok",
  });
  if (put.status === 0) {
    return;
  }
  if (!put.ok || put.body.success === false) {
    errors.push(`CLOUDFLARE_API_TOKEN cannot write POLICY_KV: ${cloudflareError(put)}`);
    return;
  }
  const deleted = await cloudflareRequest(token, path, { method: "DELETE" });
  if (deleted.status === 0) {
    return;
  }
  if (!deleted.ok || deleted.body.success === false) {
    errors.push(
      `CLOUDFLARE_API_TOKEN wrote POLICY_KV but could not delete probe key: ${cloudflareError(deleted)}`,
    );
    return;
  }
  console.log("cloudflare kv token: can write POLICY_KV");
}

async function cloudflareRequest(token, path, init = {}) {
  let response;
  let body;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
    body = await response.json().catch(() => ({}));
  } catch (error) {
    warnings.push(`could not reach Cloudflare API: ${error.message}`);
    return { ok: false, status: 0, body: {} };
  }
  return { ok: response.ok, status: response.status, body };
}

function cloudflareError(response) {
  return response.body.errors?.[0]?.message ?? `HTTP ${response.status}`;
}

function checkGitHubRepository(repo) {
  if (process.env.CLAWROUTER_DOCTOR_SKIP_GITHUB === "1") {
    warnings.push("skipped GitHub repository secret/variable check");
    return;
  }
  if (!githubCli) {
    errors.push("GitHub CLI is not available; install `gh` or set CLAWROUTER_GITHUB_CLI");
    return;
  }

  const secretNames = listGitHubNames(["secret", "list", "--repo", repo, "--json", "name"]);
  if (!secretNames) {
    errors.push(`could not inspect GitHub Actions secrets for ${repo}`);
    return;
  }
  const missingSecrets = requiredRepoSecrets.filter((name) => !secretNames.has(name));
  if (missingSecrets.length > 0) {
    errors.push(`missing GitHub Actions secrets for ${repo}: ${missingSecrets.join(",")}`);
  }

  const missingOptionalSecrets = optionalRepoSecrets.filter((name) => !secretNames.has(name));
  if (missingOptionalSecrets.length > 0) {
    warnings.push(`optional GitHub Actions secrets not set: ${missingOptionalSecrets.join(",")}`);
  }

  const varNames = listGitHubNames(["variable", "list", "--repo", repo, "--json", "name"]);
  if (!varNames) {
    warnings.push(`could not inspect GitHub Actions variables for ${repo}`);
    return;
  }
  const missingOptionalVars = optionalRepoVars.filter((name) => !varNames.has(name));
  if (missingOptionalVars.length > 0) {
    warnings.push(`optional GitHub Actions variables not set: ${missingOptionalVars.join(",")}`);
  }
}

function listGitHubNames(args) {
  const result = spawnSync(githubCli, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const output = result.stderr || result.stdout || `${githubCli} ${args.join(" ")} failed`;
    warnings.push(stripAnsi(output).trim());
    return null;
  }
  const output = stripAnsi(result.stdout).trim() || "[]";
  try {
    const values = JSON.parse(output);
    return new Set(values.map((value) => value.name).filter(Boolean));
  } catch {
    warnings.push(`could not parse GitHub CLI output for ${args.slice(0, 2).join(" ")}`);
    return null;
  }
}

function printProviderConfig(plan) {
  const allConfig = new Set();
  const missingLocalConfig = [];
  for (const provider of plan.providers) {
    for (const name of provider.requiredConfig) {
      allConfig.add(name);
      if (!process.env[name]) {
        missingLocalConfig.push(`${provider.id}:${name}`);
      }
    }
    for (const name of provider.optionalConfig) {
      allConfig.add(name);
    }
  }
  console.log(
    `provider bindings: total=${allConfig.size} missingLocal=${missingLocalConfig.length}`,
  );
  if (missingLocalConfig.length > 0) {
    warnings.push(
      `provider env not present locally: ${missingLocalConfig.slice(0, 20).join(",")}${
        missingLocalConfig.length > 20 ? ",..." : ""
      }`,
    );
    warnings.push(
      "provider bindings must be configured as Worker secrets/vars before enabling every provider live",
    );
  }
}

function selectGitHubCli() {
  if (process.env.CLAWROUTER_GITHUB_CLI) {
    return process.env.CLAWROUTER_GITHUB_CLI;
  }
  if (commandExists("ghx")) {
    return "ghx";
  }
  if (commandExists("gh")) {
    return "gh";
  }
  return null;
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
