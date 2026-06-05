import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const kid = required(args.kid, "--kid");
const secret = required(args.secret, "--secret");
const providers = args.providers ? args.providers.split(",").filter(Boolean) : [];
const binding = args.binding ?? "POLICY_KV";
const config = args.config ?? ".wrangler.generated.toml";
const enabled = args.disabled ? false : true;
const tenantId = args.tenant ?? "default";
const monthlyBudgetMicros = args["monthly-budget-micros"]
  ? Number(args["monthly-budget-micros"])
  : undefined;

const policy = {
  enabled,
  secretSha256: createHash("sha256").update(secret).digest("hex"),
  providers,
  tenantId,
};
if (monthlyBudgetMicros !== undefined) {
  policy.monthlyBudgetMicros = monthlyBudgetMicros;
}

run("pnpm", [
  "exec",
  "wrangler",
  "kv",
  "key",
  "put",
  `keys/${kid}`,
  JSON.stringify(policy),
  "--binding",
  binding,
  "--config",
  config,
]);

console.log(`stored key policy for ${kid}; secret was not printed`);

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) {
      continue;
    }
    const name = value.slice(2);
    if (values[i + 1] && !values[i + 1].startsWith("--")) {
      out[name] = values[i + 1];
      i += 1;
    } else {
      out[name] = true;
    }
  }
  return out;
}

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}
