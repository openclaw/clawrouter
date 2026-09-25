import { spawnSync } from "node:child_process";
import { deploymentTarget } from "./deployment-profile.mjs";

const deployment = deploymentTarget();
// Recovery and smoke must use the same target that passed deploy preflight.
const env = { ...process.env, CLAWROUTER_BASE_URL: deployment.baseUrl, CLAWROUTER_PREFLIGHT_DEPLOY: "1" };
const packageManager = env.npm_execpath;
if (!packageManager) throw new Error("run this deployment with pnpm cf:deploy");
// Reuse the invoking package manager without a shell, including Windows CJS
// launchers and standalone pnpm executables.
const scriptLauncher = /\.[cm]?js$/i.test(packageManager);
const command = scriptLauncher ? process.execPath : packageManager;
const prefix = scriptLauncher ? [packageManager] : [];

for (const args of [
  ["cf:target", "--", "--deploy"],
  ["cf:preflight"],
  ["provider:compile", "--", "--output", "worker/generated/provider-snapshot.json"],
  ["--dir", "admin", "build"],
  ["cf:content:provision"],
  ["cf:config"],
  ["exec", "wrangler", "deploy", "--config", ".wrangler.generated.toml"],
  ["cf:accounts"],
  ["cf:smoke"],
]) {
  const result = spawnSync(command, [...prefix, ...args], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`clawrouter deploy stopped at pnpm ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}
