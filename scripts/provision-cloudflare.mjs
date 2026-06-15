import { spawnSync } from "node:child_process";

const queueName = process.env.CLAWROUTER_USAGE_QUEUE ?? "clawrouter-usage";
const queueDlqName =
  process.env.CLAWROUTER_USAGE_DLQ ?? "clawrouter-usage-dead-letter";
const kvBinding = process.env.CLAWROUTER_POLICY_KV_BINDING ?? "POLICY_KV";

run("pnpm", ["exec", "wrangler", "whoami"], { stdio: "inherit" });
runAllowExists("pnpm", ["exec", "wrangler", "queues", "create", queueName]);
runAllowExists("pnpm", ["exec", "wrangler", "queues", "create", queueDlqName]);

const kv = run("pnpm", [
  "exec",
  "wrangler",
  "kv",
  "namespace",
  "create",
  kvBinding,
  "--json",
]);
const parsed = JSON.parse(kv.stdout);

console.log("");
console.log("Cloudflare resources ready:");
console.log(`CLAWROUTER_USAGE_QUEUE=${queueName}`);
console.log(`CLAWROUTER_USAGE_DLQ=${queueDlqName}`);
console.log(`CLAWROUTER_POLICY_KV_ID=${parsed.id}`);
console.log("");
console.log("Set these as GitHub Actions secrets before workflow deploy:");
console.log("CLOUDFLARE_API_TOKEN=<redacted>");
console.log("CLOUDFLARE_ACCOUNT_ID=<account id>");
console.log(`CLAWROUTER_POLICY_KV_ID=${parsed.id}`);
console.log("");
console.log("Then provision the Cloudflare Access gate for the browser console:");
console.log("pnpm cf:access");

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
