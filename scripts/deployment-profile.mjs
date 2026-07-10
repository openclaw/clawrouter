import { readFileSync } from "node:fs";

const fakeco = JSON.parse(
  readFileSync(new URL("../config/deployments/fakeco.json", import.meta.url), "utf8"),
);

const fakecoLockedEnv = {
  CLAWROUTER_BASE_URL: fakeco.baseUrl,
  CLAWROUTER_ROUTE_HOSTNAME: fakeco.routeHostname,
  CLAWROUTER_WORKER_NAME: fakeco.workerName,
  CLAWROUTER_POLICY_KV_NAMESPACE: fakeco.policyKvNamespace,
  CLAWROUTER_POLICY_KV_BINDING: fakeco.policyKvNamespace,
  CLAWROUTER_USAGE_QUEUE: fakeco.queueName,
  CLAWROUTER_USAGE_DLQ: fakeco.queueDlqName,
  CLAWROUTER_CONTENT_BUCKET: fakeco.contentBucketName,
  CLAWROUTER_ACCESS_DOMAIN: fakeco.routeHostname,
  CLAWROUTER_ACCESS_APP_NAME: fakeco.accessAppName,
  CLAWROUTER_ACCESS_POLICY_NAME: fakeco.accessPolicyName,
  CLAWROUTER_ACCESS_SERVICE_POLICY_NAME: fakeco.accessServicePolicyName,
  CLAWROUTER_ACCESS_DEFAULT_TENANT: fakeco.accessDefaultTenant,
  CLAWROUTER_CONTENT_RETENTION_DEFAULT: "false",
};

export function deploymentTarget(env = process.env) {
  const environment = env.CLAWROUTER_DEPLOY_ENV?.trim() || "production";
  if (environment === "fakeco") {
    assertLockedEnvironment(env);
    return structuredClone(fakeco);
  }
  if (environment !== "production") {
    throw new Error(
      `unknown CLAWROUTER_DEPLOY_ENV ${JSON.stringify(environment)}; expected production or fakeco`,
    );
  }
  const routeHostname = env.CLAWROUTER_ROUTE_HOSTNAME?.trim() || "clawrouter.openclaw.ai";
  return {
    environment,
    githubEnvironment: null,
    githubPrefix: "",
    baseUrl: env.CLAWROUTER_BASE_URL?.trim() || `https://${routeHostname}`,
    routeHostname,
    workerName: env.CLAWROUTER_WORKER_NAME?.trim() || "clawrouter-edge",
    policyKvNamespace:
      env.CLAWROUTER_POLICY_KV_NAMESPACE?.trim() ||
      env.CLAWROUTER_POLICY_KV_BINDING?.trim() ||
      "POLICY_KV",
    queueName: env.CLAWROUTER_USAGE_QUEUE?.trim() || "clawrouter-usage",
    queueDlqName:
      env.CLAWROUTER_USAGE_DLQ?.trim() || "clawrouter-usage-dead-letter",
    contentBucketName:
      env.CLAWROUTER_CONTENT_BUCKET?.trim() || "clawrouter-content",
    accessAppName:
      env.CLAWROUTER_ACCESS_APP_NAME?.trim() || "ClawRouter Console",
    accessPolicyName:
      env.CLAWROUTER_ACCESS_POLICY_NAME?.trim() || "ClawRouter Console Users",
    accessServicePolicyName:
      env.CLAWROUTER_ACCESS_SERVICE_POLICY_NAME?.trim() ||
      "ClawRouter Console Service Tokens",
    accessDefaultTenant:
      env.CLAWROUTER_ACCESS_DEFAULT_TENANT?.trim() || "default",
    contentRetentionDefault: retentionDefault(
      env.CLAWROUTER_CONTENT_RETENTION_DEFAULT,
      true,
    ),
  };
}

export function assertDeploymentMutation(target, env = process.env) {
  if (
    target.environment === "fakeco" &&
    env.CLAWROUTER_DEPLOY_CONFIRM?.trim() !== target.environment
  ) {
    throw new Error(
      "FakeCo mutation refused: set CLAWROUTER_DEPLOY_CONFIRM=fakeco after verifying the locked target",
    );
  }
}

export function assertPolicyKvNamespace(target, namespace, label = "POLICY_KV") {
  if (target.environment !== "fakeco") return;
  if (namespace?.title !== target.policyKvNamespace) {
    throw new Error(
      `FakeCo isolation refused: ${label} must reference namespace ${JSON.stringify(target.policyKvNamespace)}, got ${JSON.stringify(namespace?.title ?? null)}`,
    );
  }
}

export async function verifyPolicyKvNamespaceTarget(
  target,
  env = process.env,
  fetchImpl = fetch,
) {
  if (target.environment !== "fakeco") return null;
  const namespaceId = requiredDeployValue(env, "CLAWROUTER_POLICY_KV_ID");
  return verifyPolicyKvNamespaceId(target, namespaceId, env, fetchImpl, "POLICY_KV");
}

export async function verifyPolicyKvPreviewNamespaceTarget(
  target,
  env = process.env,
  fetchImpl = fetch,
) {
  if (target.environment !== "fakeco") return null;
  const primaryId = requiredDeployValue(env, "CLAWROUTER_POLICY_KV_ID");
  const previewId = env.CLAWROUTER_POLICY_KV_PREVIEW_ID?.trim();
  if (!previewId || previewId === primaryId) return null;
  return verifyPolicyKvNamespaceId(
    target,
    previewId,
    env,
    fetchImpl,
    "POLICY_KV preview",
  );
}

export function fakecoAccessServiceTokenIds(target, env = process.env) {
  const ids = (env.CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (target.environment !== "fakeco") return ids;
  if (ids.length === 0) {
    throw new Error(
      "FakeCo Access requires CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS before any Access mutation",
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS must not contain duplicates");
  }
  const invalid = ids.find(
    (id) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id),
  );
  if (invalid) {
    throw new Error(
      "CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS must contain comma-separated Cloudflare service-token UUIDs",
    );
  }
  return ids;
}

async function verifyPolicyKvNamespaceId(
  target,
  namespaceId,
  env,
  fetchImpl,
  label,
) {
  const token = requiredDeployValue(env, "CLOUDFLARE_API_TOKEN");
  const accountId = requiredDeployValue(env, "CLOUDFLARE_ACCOUNT_ID");
  let response;
  let body;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    body = await response.json();
  } catch (error) {
    throw new Error(
      `could not verify FakeCo ${label} namespace: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok || body.success === false) {
    throw new Error(
      `could not verify FakeCo ${label} namespace: ${body.errors?.[0]?.message ?? `HTTP ${response.status}`}`,
    );
  }
  assertPolicyKvNamespace(target, body.result, label);
  return body.result;
}

export function githubScopedName(target, name) {
  if (!target.githubPrefix) return name;
  return `${target.githubPrefix}${name.replace(/^CLAWROUTER_/, "")}`;
}

export function githubScopeArgs(target) {
  return target.githubEnvironment ? ["--env", target.githubEnvironment] : [];
}

export function retentionDefault(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "on"].includes(normalized)) return true;
  if (["0", "false", "off"].includes(normalized)) return false;
  throw new Error(
    "CLAWROUTER_CONTENT_RETENTION_DEFAULT must be true/false, on/off, or 1/0",
  );
}

function assertLockedEnvironment(env) {
  for (const [name, expected] of Object.entries(fakecoLockedEnv)) {
    const configured = env[name]?.trim();
    if (configured && configured !== expected) {
      throw new Error(
        `FakeCo isolation refused: ${name} must be ${JSON.stringify(expected)}, got ${JSON.stringify(configured)}`,
      );
    }
  }
}

function requiredDeployValue(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required to verify the FakeCo deploy target`);
  return value;
}
