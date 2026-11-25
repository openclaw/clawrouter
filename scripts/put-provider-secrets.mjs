import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  assertDeploymentMutation,
  deploymentTarget,
} from "./deployment-profile.mjs";

import {
  configuredProviderSecrets,
  providerSecretNames,
} from "./provider-secret-inputs.mjs";
export { providerSecretNames, configuredProviderSecrets };

export function putProviderSecrets({ env = process.env, dryRun = false } = {}) {
  const deployment = deploymentTarget(env);
  if (!dryRun) assertDeploymentMutation(deployment, env);
  const secrets = configuredProviderSecrets(env);
  const names = Object.keys(secrets);
  if (names.length === 0) {
    throw new Error("no provider secrets are configured");
  }
  if (dryRun) {
    console.log(`provider secrets ready: count=${names.length} names=${names.join(",")}`);
    return;
  }

  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "secret", "bulk", "--config", ".wrangler.generated.toml"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      input: JSON.stringify(secrets),
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`wrangler secret bulk failed with status ${result.status}`);
  }
  console.log(`provider secrets uploaded: count=${names.length} names=${names.join(",")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  putProviderSecrets({ dryRun: process.argv.includes("--dry-run") });
}
