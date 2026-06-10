import {
  buildProviderSmokePlan,
  compileProviderSnapshot,
  liveProviderList,
  selectLiveProviderPlans,
} from "./provider-smoke-plan.mjs";

const requiredDeployEnv = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLAWROUTER_ADMIN_TOKEN_SHA256",
  "CLAWROUTER_POLICY_KV_ID",
];

const errors = [];
for (const name of requiredDeployEnv) {
  if (!process.env[name]) {
    errors.push(`missing required deploy env: ${name}`);
  }
}
if (
  process.env.CLAWROUTER_ADMIN_TOKEN_SHA256 &&
  !/^[a-fA-F0-9]{64}$/.test(process.env.CLAWROUTER_ADMIN_TOKEN_SHA256)
) {
  errors.push("CLAWROUTER_ADMIN_TOKEN_SHA256 must be a 64-character hex string");
}

const plan = buildProviderSmokePlan(compileProviderSnapshot());
if (plan.targetCount !== plan.providerCount) {
  errors.push(`provider smoke plan is incomplete: ${plan.targetCount}/${plan.providerCount}`);
}

const baseUrl = process.env.CLAWROUTER_BASE_URL;
if (baseUrl) {
  try {
    new URL(baseUrl);
  } catch {
    errors.push("CLAWROUTER_BASE_URL must be a valid absolute URL");
  }
}

const liveProviders = liveProviderList();
let selectedProviders = [];
if (liveProviders.length > 0) {
  if (!baseUrl) {
    errors.push("CLAWROUTER_BASE_URL is required when live provider smoke is enabled");
  }
  if (!process.env.CLAWROUTER_SMOKE_KEY) {
    errors.push("CLAWROUTER_SMOKE_KEY is required when live provider smoke is enabled");
  }
  try {
    selectedProviders = selectLiveProviderPlans(plan, liveProviders);
  } catch (error) {
    errors.push(error.message);
  }
}

await checkCloudflarePermissions();

if (errors.length > 0) {
  console.error("clawrouter deploy preflight failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `clawrouter deploy preflight passed: providers=${plan.providerCount} smokeTargets=${plan.targetCount}`,
);
if (selectedProviders.length > 0) {
  console.log(`live provider smoke enabled: ${selectedProviders.map((p) => p.id).join(",")}`);
}

async function checkCloudflarePermissions() {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const namespaceId = process.env.CLAWROUTER_POLICY_KV_ID?.trim();
  const workerName = process.env.CLAWROUTER_WORKER_NAME?.trim() || "clawrouter-edge";
  if (!token || !accountId || !namespaceId) {
    return;
  }

  await checkCloudflareWorkerRead({ token, accountId, workerName });
  if (process.env.CLAWROUTER_PREFLIGHT_SKIP_KV_WRITE === "1") {
    if (process.env.CLAWROUTER_PREFLIGHT_DEPLOY === "1") {
      errors.push(
        "CLAWROUTER_PREFLIGHT_SKIP_KV_WRITE cannot be used for deploy: Wrangler requires KV write permission for Workers with KV bindings",
      );
    }
    console.log("cloudflare kv token: skipped write probe");
    return;
  }
  await checkCloudflareKvWrite({ token, accountId, namespaceId });
}

async function checkCloudflareWorkerRead({ token, accountId, workerName }) {
  const response = await cloudflareFetch(
    token,
    `/accounts/${accountId}/workers/services/${workerName}`,
  );
  if (response.ok && response.body.success !== false) {
    console.log(`cloudflare worker token: can read ${workerName}`);
    return;
  }
  if (response.status === 404) {
    console.log(`cloudflare worker token: ${workerName} does not exist yet`);
    return;
  }
  errors.push(
    `CLOUDFLARE_API_TOKEN cannot read Worker ${workerName}: ${firstCloudflareError(response)}`,
  );
}

async function checkCloudflareKvWrite({ token, accountId, namespaceId }) {
  const key = `__clawrouter_preflight_${Date.now()}`;
  const encodedKey = encodeURIComponent(key);
  const path = `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodedKey}`;
  const put = await cloudflareFetch(token, path, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "ok",
  });
  if (!put.ok || put.body.success === false) {
    errors.push(`CLOUDFLARE_API_TOKEN cannot write POLICY_KV: ${firstCloudflareError(put)}`);
    return;
  }
  const deleted = await cloudflareFetch(token, path, { method: "DELETE" });
  if (!deleted.ok || deleted.body.success === false) {
    errors.push(
      `CLOUDFLARE_API_TOKEN wrote POLICY_KV but could not delete probe key: ${firstCloudflareError(deleted)}`,
    );
    return;
  }
  console.log("cloudflare kv token: can write POLICY_KV");
}

async function cloudflareFetch(token, path, init = {}) {
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
    errors.push(`could not reach Cloudflare API: ${error.message}`);
    return { ok: false, status: 0, body: {} };
  }
  return { ok: response.ok, status: response.status, body };
}

function firstCloudflareError(response) {
  return response.body.errors?.[0]?.message ?? `HTTP ${response.status}`;
}
