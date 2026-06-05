import { spawnSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const kid = required(args.kid, "--kid");
const binding = args.binding ?? "POLICY_KV";
const config = args.config ?? ".wrangler.generated.toml";

const existing = run("pnpm", [
  "exec",
  "wrangler",
  "kv",
  "key",
  "get",
  `keys/${kid}`,
  "--binding",
  binding,
  "--config",
  config,
]);
const policy = JSON.parse(existing.stdout);
policy.enabled = false;

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

console.log(`revoked key policy for ${kid}`);

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
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${args.join(" ")} failed`);
  }
  return result;
}
