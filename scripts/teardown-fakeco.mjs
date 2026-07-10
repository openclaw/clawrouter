import { pathToFileURL } from "node:url";
import {
  assertDeploymentMutation,
  deploymentTarget,
  verifyPolicyKvNamespaceTarget,
} from "./deployment-profile.mjs";

const TEARDOWN_CONFIRMATION =
  "delete-clawrouter-edge-fakeco-and-durable-object-storage";
const TEARDOWN_DATA_CONFIRMATION =
  "durable-object-storage-loss-is-irreversible";
const ACCESS_PATHS = [
  "/dashboard/*",
  "/v1/session*",
  "/v1/playground/*",
  "/v1/admin/*",
  "/v1/oauth/callback",
];

export async function teardownFakeco({
  env = process.env,
  execute = false,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const target = deploymentTarget(env);
  if (target.environment !== "fakeco") {
    throw new Error("FakeCo teardown refused: CLAWROUTER_DEPLOY_ENV must be fakeco");
  }

  printPlan(target, log);
  if (!execute) return { executed: false, target };

  assertDeploymentMutation(target, env);
  if (env.CLAWROUTER_TEARDOWN_CONFIRM?.trim() !== TEARDOWN_CONFIRMATION) {
    throw new Error(
      `FakeCo teardown refused: set CLAWROUTER_TEARDOWN_CONFIRM=${TEARDOWN_CONFIRMATION} after reviewing the dry-run plan`,
    );
  }
  if (
    env.CLAWROUTER_TEARDOWN_DATA_CONFIRM?.trim() !==
    TEARDOWN_DATA_CONFIRMATION
  ) {
    throw new Error(
      `FakeCo teardown refused: set CLAWROUTER_TEARDOWN_DATA_CONFIRM=${TEARDOWN_DATA_CONFIRMATION} after reviewing the Durable Object storage loss`,
    );
  }
  const accountId = requiredValue(env, "CLOUDFLARE_ACCOUNT_ID");
  const token = requiredValue(env, "CLOUDFLARE_API_TOKEN");
  await verifyPolicyKvNamespaceTarget(target, env, fetchImpl);

  const apps = await listAccessApplications({
    accountId,
    token,
    fetchImpl,
  });
  const namedApps = apps.filter((app) => app.name === target.accessAppName);
  if (namedApps.length > 1) {
    throw new Error(
      `FakeCo teardown refused: found ${namedApps.length} Access apps named ${JSON.stringify(target.accessAppName)}`,
    );
  }
  const accessApp = namedApps[0];
  if (accessApp) {
    assertExactAccessApp(target, accessApp);
  } else {
    log(`FakeCo Access app already absent: ${target.accessAppName}`);
  }
  const queues = await listQueues({ accountId, token, fetchImpl });
  const managedQueues = [target.queueName, target.queueDlqName].map((name) => ({
    name,
    queue: exactQueue(queues, name),
  }));

  const workerDelete = await cloudflareEnvelopeRequest({
    accountId,
    token,
    method: "DELETE",
    path: `/workers/services/${encodeURIComponent(target.workerName)}?force=true`,
    fetchImpl,
    allowNotFound: true,
  });
  log(
    workerDelete
      ? `deleted Worker ${target.workerName}`
      : `Worker ${target.workerName} already absent`,
  );
  for (const { name, queue } of managedQueues) {
    if (!queue) {
      log(`queue ${name} already absent`);
      continue;
    }
    const deleted = await cloudflareEnvelopeRequest({
      accountId,
      token,
      method: "DELETE",
      path: `/queues/${encodeURIComponent(queue.queue_id)}`,
      fetchImpl,
      allowNotFound: true,
    });
    log(deleted ? `deleted queue ${name}` : `queue ${name} already absent`);
  }
  if (accessApp) {
    await cloudflareRequest({
      accountId,
      token,
      method: "DELETE",
      path: `/access/apps/${encodeURIComponent(accessApp.id)}`,
      fetchImpl,
      allowNotFound: true,
    });
    log(`deleted FakeCo Access app ${target.accessAppName}`);
  }
  log("FakeCo teardown execution completed; retained resources were not touched");
  return { executed: true, target };
}

export function assertExactAccessApp(target, app) {
  if (!app?.id || app.name !== target.accessAppName) {
    throw new Error("FakeCo teardown refused: Access app identity did not match");
  }
  const expected = expectedAccessDestinations(target).sort();
  const actual = destinationUris(app).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `FakeCo teardown refused: Access app destinations did not exactly match ${target.routeHostname}`,
    );
  }
}

export function expectedAccessDestinations(target) {
  return ACCESS_PATHS.map((path) => `${target.routeHostname}${path}`);
}

function printPlan(target, log) {
  log("FakeCo teardown dry-run plan (no Cloudflare mutations):");
  log(
    `delete Worker and its associated Durable Object storage: ${target.workerName}`,
  );
  log(`delete queues: ${target.queueName}, ${target.queueDlqName}`);
  log(`delete Access app last: ${target.accessAppName}`);
  log(
    `retain KV namespace: ${target.policyKvNamespace}; retain R2 bucket: ${target.contentBucketName}`,
  );
  log(
    "retain Access service-token resources, GitHub Environment secrets/variables, and the Cloudflare zone",
  );
  log(
    `target lock: CLAWROUTER_DEPLOY_CONFIRM=fakeco; destructive confirmation: CLAWROUTER_TEARDOWN_CONFIRM=${TEARDOWN_CONFIRMATION}`,
  );
  log(
    `data-loss confirmation: CLAWROUTER_TEARDOWN_DATA_CONFIRM=${TEARDOWN_DATA_CONFIRMATION}`,
  );
}

async function cloudflareRequest({
  accountId,
  token,
  path,
  method = "GET",
  fetchImpl,
  allowNotFound = false,
}) {
  const body = await cloudflareEnvelopeRequest({
    accountId,
    token,
    path,
    method,
    fetchImpl,
    allowNotFound,
  });
  return body?.result ?? null;
}

async function cloudflareEnvelopeRequest({
  accountId,
  token,
  path,
  method = "GET",
  fetchImpl,
  allowNotFound = false,
}) {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (allowNotFound && response.status === 404) return null;
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok || body.success === false) {
    throw new Error(
      `Cloudflare ${method} ${path} failed: ${body.errors?.[0]?.message ?? `HTTP ${response.status}`}`,
    );
  }
  return body;
}

async function listAccessApplications({ accountId, token, fetchImpl }) {
  const apps = [];
  for (let page = 1; page <= 100; page += 1) {
    const body = await cloudflareEnvelopeRequest({
      accountId,
      token,
      path: `/access/apps?per_page=100&page=${page}`,
      fetchImpl,
    });
    const pageApps = asArray(body.result);
    apps.push(...pageApps);
    const totalPages = Number(body.result_info?.total_pages);
    if (Number.isInteger(totalPages) && totalPages > 0) {
      if (page >= totalPages) return apps;
    } else if (pageApps.length < 100) {
      return apps;
    }
  }
  throw new Error("FakeCo teardown refused: Access app pagination exceeded 100 pages");
}

async function listQueues({ accountId, token, fetchImpl }) {
  const queues = [];
  for (let page = 1; page <= 100; page += 1) {
    const body = await cloudflareEnvelopeRequest({
      accountId,
      token,
      path: `/queues?per_page=100&page=${page}`,
      fetchImpl,
    });
    const pageQueues = asArray(body.result);
    queues.push(...pageQueues);
    const totalPages = Number(body.result_info?.total_pages);
    if (Number.isInteger(totalPages) && totalPages > 0) {
      if (page >= totalPages) return queues;
    } else if (pageQueues.length < 100) {
      return queues;
    }
  }
  throw new Error("FakeCo teardown refused: queue pagination exceeded 100 pages");
}

function exactQueue(queues, name) {
  const matches = queues.filter((queue) => queue?.queue_name === name);
  if (matches.length > 1 || (matches[0] && !matches[0].queue_id)) {
    throw new Error(`FakeCo teardown refused: queue identity was ambiguous for ${name}`);
  }
  return matches[0] ?? null;
}

function destinationUris(app) {
  const values = Array.isArray(app?.destinations)
    ? app.destinations.map((destination) => destination?.uri).filter(Boolean)
    : [];
  return values.length > 0
    ? values
    : Array.isArray(app?.self_hosted_domains)
      ? app.self_hosted_domains.filter(Boolean)
      : [];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function requiredValue(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for FakeCo teardown`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => arg !== "--execute");
  if (unknown.length > 0) {
    throw new Error(`unknown FakeCo teardown arguments: ${unknown.join(" ")}`);
  }
  await teardownFakeco({ execute: args.includes("--execute") });
}
