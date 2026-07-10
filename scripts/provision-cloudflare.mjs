import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDeploymentMutation,
  deploymentTarget,
  githubScopedName,
} from "./deployment-profile.mjs";

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await provisionCloudflare();
}

async function provisionCloudflare() {
  const deployment = deploymentTarget();
  assertDeploymentMutation(deployment);

  run("pnpm", ["exec", "wrangler", "whoami"], { stdio: "inherit" });
  runAllowExists("pnpm", ["exec", "wrangler", "queues", "create", deployment.queueName]);
  runAllowExists("pnpm", ["exec", "wrangler", "queues", "create", deployment.queueDlqName]);

  const kv = deployment.environment === "fakeco"
    ? await createExactKvNamespace({
        accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
        token: requiredEnv("CLOUDFLARE_API_TOKEN"),
        title: deployment.policyKvNamespace,
      })
    : JSON.parse(run("pnpm", [
        "exec",
        "wrangler",
        "kv",
        "namespace",
        "create",
        deployment.policyKvNamespace,
        "--json",
      ]).stdout);

  console.log("");
  console.log("Cloudflare resources ready:");
  console.log(`CLAWROUTER_DEPLOY_ENV=${deployment.environment}`);
  console.log(`CLAWROUTER_USAGE_QUEUE=${deployment.queueName}`);
  console.log(`CLAWROUTER_USAGE_DLQ=${deployment.queueDlqName}`);
  console.log(`CLAWROUTER_POLICY_KV_ID=${kv.id}`);
  console.log("");
  console.log(
    deployment.githubEnvironment
      ? `Set these as secrets in the ${deployment.githubEnvironment} GitHub Environment:`
      : "Set these as GitHub Actions secrets before workflow deploy:",
  );
  console.log(`${githubSecretName(deployment, "CLOUDFLARE_API_TOKEN")}=<redacted>`);
  console.log(`${githubSecretName(deployment, "CLOUDFLARE_ACCOUNT_ID")}=<account id>`);
  console.log(`${githubScopedName(deployment, "CLAWROUTER_POLICY_KV_ID")}=${kv.id}`);
  console.log("");
  console.log("Then provision the Cloudflare Access gate for the browser console:");
  console.log("pnpm cf:access");
}

export async function createExactKvNamespace({
  accountId,
  token,
  title,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title }),
    },
  );
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Cloudflare KV namespace create returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok || body.success === false || !body.result?.id) {
    throw new Error(
      `Cloudflare KV namespace create failed: ${body.errors?.[0]?.message ?? `HTTP ${response.status}`}`,
    );
  }
  if (body.result.title && body.result.title !== title) {
    throw new Error(
      `Cloudflare created KV namespace ${JSON.stringify(body.result.title)} instead of ${JSON.stringify(title)}`,
    );
  }
  return { id: body.result.id, title };
}

function githubSecretName(deployment, name) {
  return deployment.githubPrefix ? `${deployment.githubPrefix}${name}` : name;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${args.join(" ")} failed`);
  }
  return result;
}

function runAllowExists(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    process.stdout.write(result.stdout);
    return;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (/already exists/i.test(output)) {
    console.log(`${args.join(" ")} already exists`);
    return;
  }
  throw new Error(output);
}
